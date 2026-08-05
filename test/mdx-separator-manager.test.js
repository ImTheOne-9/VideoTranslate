const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MdxSeparatorError,
  buildMdxArguments,
  createMdxSeparatorManager,
  detectsCliCpuFallback,
  isCudaRuntimeError,
  normalizeMdxProvider
} = require('../lib/mdx-separator-manager');

const PATHS = {
  cpu: 'C:\\mdx\\cpu.exe',
  cuda: 'C:\\mdx\\cuda.exe',
  model: 'C:\\mdx\\model.onnx',
  input: 'C:\\work\\input.wav',
  vocals: 'C:\\work\\vocals.wav',
  accompaniment: 'C:\\work\\accompaniment.wav'
};

function createHarness(options = {}) {
  const existing = new Set(options.existing || [
    PATHS.cpu,
    PATHS.cuda,
    PATHS.model
  ]);
  const calls = [];
  const warnings = [];
  const fileSystem = {
    existsSync: (filePath) => existing.has(filePath)
  };
  const runExecFile = options.runExecFile || (async (executable, args) => {
    existing.add(PATHS.vocals);
    existing.add(PATHS.accompaniment);
  });
  const manager = createMdxSeparatorManager({
    fs: fileSystem,
    runExecFile: async (executable, args) => {
      calls.push({ executable, args });
      return runExecFile(executable, args, existing);
    },
    detectHardware: () => ({
      platform: 'win32',
      nvidia: {
        available: options.nvidia !== false,
        name: options.nvidia === false ? null : 'NVIDIA Test GPU',
        driverVersion: '1.0',
        memoryMb: 8192
      }
    }),
    cpuExecutablePath: PATHS.cpu,
    cudaExecutablePath: PATHS.cuda,
    modelPath: PATHS.model,
    isCudaRuntimeReady: options.cudaVerified === false ? () => false : undefined,
    logger: { warn: (message) => warnings.push(message) }
  });
  return { manager, calls, existing, warnings };
}

function separate(manager, overrides = {}) {
  return manager.separate({
    requestedProvider: 'auto',
    inputPath: PATHS.input,
    vocalsPath: PATHS.vocals,
    accompanimentPath: PATHS.accompaniment,
    numThreads: 4,
    ...overrides
  });
}

test('normalizes unsupported MDX providers to auto', () => {
  assert.equal(normalizeMdxProvider('CUDA'), 'cuda');
  assert.equal(normalizeMdxProvider('directml'), 'auto');
  assert.equal(normalizeMdxProvider(''), 'auto');
});

test('builds explicit provider and bounded CPU thread arguments', () => {
  const args = buildMdxArguments({
    provider: 'cuda',
    modelPath: PATHS.model,
    inputPath: PATHS.input,
    vocalsPath: PATHS.vocals,
    accompanimentPath: PATHS.accompaniment,
    numThreads: 999
  });

  assert.ok(args.includes('--provider=cuda'));
  assert.ok(args.includes('--num-threads=32'));
  assert.ok(args.includes(`--uvr-model=${PATHS.model}`));
});

test('auto selects CUDA only when NVIDIA hardware and CUDA runtime are ready', async () => {
  const { manager, calls } = createHarness();
  const result = await separate(manager);

  assert.equal(result.requestedProvider, 'auto');
  assert.equal(result.usedProvider, 'cuda');
  assert.equal(result.fallback, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, PATHS.cuda);
  assert.ok(calls[0].args.includes('--provider=cuda'));
});

test('auto selects CPU when NVIDIA hardware is unavailable', async () => {
  const { manager, calls } = createHarness({ nvidia: false });
  const result = await separate(manager);

  assert.equal(result.usedProvider, 'cpu');
  assert.equal(calls[0].executable, PATHS.cpu);
  assert.ok(calls[0].args.includes('--provider=cpu'));
});

test('auto selects CPU when NVIDIA exists but CUDA component is missing', async () => {
  const { manager, calls } = createHarness({
    existing: [PATHS.cpu, PATHS.model]
  });
  const result = await separate(manager);

  assert.equal(result.usedProvider, 'cpu');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, PATHS.cpu);
});

test('an executable without verified component metadata is not CUDA-ready', () => {
  const { manager } = createHarness({ cudaVerified: false });

  const runtime = manager.inspectRuntime();
  assert.equal(runtime.cuda.hardwareAvailable, true);
  assert.equal(runtime.cuda.ready, false);
  assert.equal(manager.selectProvider('auto', runtime).provider, 'cpu');
});

test('explicit CUDA reports missing NVIDIA hardware without running CPU', async () => {
  const { manager, calls } = createHarness({ nvidia: false });

  await assert.rejects(
    separate(manager, { requestedProvider: 'cuda' }),
    (error) => error instanceof MdxSeparatorError
      && error.code === 'MDX_CUDA_HARDWARE_MISSING'
  );
  assert.equal(calls.length, 0);
});

test('explicit CUDA reports a missing CUDA component without silent fallback', async () => {
  const { manager, calls } = createHarness({
    existing: [PATHS.cpu, PATHS.model]
  });

  await assert.rejects(
    separate(manager, { requestedProvider: 'cuda' }),
    (error) => error.code === 'MDX_CUDA_RUNTIME_MISSING'
  );
  assert.equal(calls.length, 0);
});

test('auto falls back from a CUDA runtime error to CPU and records the reason', async () => {
  let invocation = 0;
  const { manager, calls, warnings } = createHarness({
    runExecFile: async (executable, args, existing) => {
      invocation += 1;
      if (invocation === 1) {
        const error = new Error('CUDA execution provider failed to initialize');
        error.stderr = 'LoadLibrary cudnn64 failed';
        throw error;
      }
      existing.add(PATHS.vocals);
      existing.add(PATHS.accompaniment);
    }
  });
  const fallbackEvents = [];
  const result = await separate(manager, {
    onFallback: (event) => fallbackEvents.push(event)
  });

  assert.equal(result.usedProvider, 'cpu');
  assert.equal(result.fallback, true);
  assert.match(result.fallbackReason, /CUDA execution provider/i);
  assert.deepEqual(calls.map((call) => call.executable), [PATHS.cuda, PATHS.cpu]);
  assert.equal(fallbackEvents.length, 1);
  assert.equal(warnings.length, 1);
});

test('detects a CPU-only binary that silently accepts the CUDA option', async () => {
  const { manager, calls, existing } = createHarness({
    runExecFile: async () => {
      existing.add(PATHS.vocals);
      existing.add(PATHS.accompaniment);
      return {
        stderr: 'Available providers: CPUExecutionProvider, . Fallback to cpu!'
      };
    }
  });

  const result = await separate(manager);

  assert.equal(result.usedProvider, 'cpu');
  assert.equal(result.fallback, true);
  assert.match(result.fallbackReason, /không có CUDAExecutionProvider/);
  assert.equal(calls.length, 1, 'CLI already produced CPU outputs, so do not run CPU twice');
});

test('explicit CUDA rejects a binary that silently ran on CPU', async () => {
  const { manager, existing } = createHarness({
    runExecFile: async () => {
      existing.add(PATHS.vocals);
      existing.add(PATHS.accompaniment);
      return { stderr: 'Fallback to cpu!' };
    }
  });

  await assert.rejects(
    separate(manager, { requestedProvider: 'cuda' }),
    (error) => error.code === 'MDX_CUDA_PROVIDER_UNAVAILABLE'
  );
});

test('cancellation never starts a CPU fallback after CUDA is terminated', async () => {
  const { manager, calls } = createHarness({
    runExecFile: async () => {
      throw new Error('Process terminated by SIGTERM');
    }
  });

  await assert.rejects(
    separate(manager, { isCancelled: () => true }),
    /SIGTERM/
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, PATHS.cuda);
});

test('invalid input or model errors are not disguised as CUDA fallback', async () => {
  const { manager, calls } = createHarness({
    runExecFile: async () => {
      throw new Error('Invalid ONNX model graph');
    }
  });

  await assert.rejects(separate(manager), /Invalid ONNX model graph/);
  assert.equal(calls.length, 1);
});

test('requires both MDX output files after a successful process exit', async () => {
  const { manager } = createHarness({
    runExecFile: async (executable, args, existing) => {
      existing.add(PATHS.vocals);
    }
  });

  await assert.rejects(
    separate(manager),
    (error) => error.code === 'MDX_OUTPUT_MISSING'
      && error.details.outputPath === PATHS.accompaniment
  );
});

test('recognizes common CUDA provider and VRAM failures', () => {
  assert.equal(isCudaRuntimeError(new Error('CUDA out of memory')), true);
  assert.equal(isCudaRuntimeError(new Error('Invalid input wav')), false);
  assert.equal(detectsCliCpuFallback({ stderr: 'Fallback to cpu!' }), true);
});
