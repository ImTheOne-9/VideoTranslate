const fs = require('node:fs');
const { detectHardware } = require('./hardware-detector');

const MDX_PROVIDERS = Object.freeze(['auto', 'cpu', 'cuda']);
const CUDA_FALLBACK_PATTERNS = [
  /CUDA(?:ExecutionProvider| error| failure| initialization| provider| runtime)/i,
  /cudnn/i,
  /cublas/i,
  /nvcuda/i,
  /execution provider/i,
  /provider.*(?:not|unavailable|failed)/i,
  /out of memory/i,
  /failed to allocate/i,
  /no kernel image/i,
  /driver version/i,
  /dynamic link library/i,
  /failed to load.*\.dll/i,
  /module could not be found/i
];

class MdxSeparatorError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MdxSeparatorError';
    this.code = code;
    this.details = details;
  }
}

function normalizeMdxProvider(value) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  return MDX_PROVIDERS.includes(normalized) ? normalized : 'auto';
}

function isCancellationError(error, isCancelled) {
  if (typeof isCancelled === 'function' && isCancelled()) return true;
  const text = `${error?.code || ''}\n${error?.message || ''}`;
  return /cancel|cancelled|canceled|hủy|terminated|sigterm|sigkill/i.test(text);
}

function isCudaRuntimeError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.stderr,
    error?.stdout
  ].filter(Boolean).join('\n');
  return CUDA_FALLBACK_PATTERNS.some((pattern) => pattern.test(text));
}

function detectsCliCpuFallback(result) {
  const text = [result?.stdout, result?.stderr].filter(Boolean).join('\n');
  return /fallback to cpu|available providers:\s*CPUExecutionProvider/i.test(text);
}

function buildMdxArguments({
  provider,
  modelPath,
  inputPath,
  vocalsPath,
  accompanimentPath,
  numThreads = 4
}) {
  const threads = Math.max(1, Math.min(32, Number.parseInt(numThreads, 10) || 4));
  return [
    `--provider=${provider}`,
    `--num-threads=${threads}`,
    `--uvr-model=${modelPath}`,
    `--input-wav=${inputPath}`,
    `--output-vocals-wav=${vocalsPath}`,
    `--output-accompaniment-wav=${accompanimentPath}`
  ];
}

function createMdxSeparatorManager(options = {}) {
  const fileSystem = options.fs || fs;
  const runExecFile = options.runExecFile;
  const hardwareDetector = options.detectHardware || detectHardware;
  const cpuExecutablePath = options.cpuExecutablePath;
  const cudaExecutablePath = options.cudaExecutablePath;
  const isCudaRuntimeReady = options.isCudaRuntimeReady;
  const modelPath = options.modelPath;
  const logger = options.logger || console;

  if (typeof runExecFile !== 'function') {
    throw new TypeError('MDX separator manager cần hàm runExecFile');
  }

  function inspectRuntime() {
    const hardware = hardwareDetector();
    return {
      providers: [...MDX_PROVIDERS],
      hardware,
      model: {
        ready: Boolean(modelPath && fileSystem.existsSync(modelPath)),
        path: modelPath || null
      },
      cpu: {
        ready: Boolean(cpuExecutablePath && fileSystem.existsSync(cpuExecutablePath)),
        executablePath: cpuExecutablePath || null
      },
      cuda: {
        ready: Boolean(
          cudaExecutablePath &&
          fileSystem.existsSync(cudaExecutablePath) &&
          (typeof isCudaRuntimeReady !== 'function' || isCudaRuntimeReady())
        ),
        executablePath: cudaExecutablePath || null,
        hardwareAvailable: hardware?.nvidia?.available === true
      }
    };
  }

  function selectProvider(requestedProvider, runtime = inspectRuntime()) {
    const requested = normalizeMdxProvider(requestedProvider);

    if (!runtime.model.ready) {
      throw new MdxSeparatorError(
        'Chưa cài model MDX ONNX tách nhạc nền',
        'MDX_MODEL_MISSING'
      );
    }
    if (!runtime.cpu.ready) {
      throw new MdxSeparatorError(
        'Chưa cài MDX ONNX CPU để tách nhạc nền',
        'MDX_CPU_RUNTIME_MISSING'
      );
    }

    if (requested === 'cpu') {
      return { requestedProvider: requested, provider: 'cpu', fallbackReason: null };
    }

    if (requested === 'cuda') {
      if (!runtime.cuda.hardwareAvailable) {
        throw new MdxSeparatorError(
          'CUDA yêu cầu GPU NVIDIA và driver hoạt động',
          'MDX_CUDA_HARDWARE_MISSING'
        );
      }
      if (!runtime.cuda.ready) {
        throw new MdxSeparatorError(
          'MDX CUDA chưa được cài đặt trên máy',
          'MDX_CUDA_RUNTIME_MISSING'
        );
      }
      return { requestedProvider: requested, provider: 'cuda', fallbackReason: null };
    }

    if (runtime.cuda.hardwareAvailable && runtime.cuda.ready) {
      return { requestedProvider: requested, provider: 'cuda', fallbackReason: null };
    }

    let fallbackReason = 'Không phát hiện GPU NVIDIA phù hợp';
    if (runtime.cuda.hardwareAvailable && !runtime.cuda.ready) {
      fallbackReason = 'Máy có NVIDIA nhưng chưa cài MDX CUDA';
    }
    return { requestedProvider: requested, provider: 'cpu', fallbackReason };
  }

  async function executeProvider(provider, paths, numThreads) {
    const executablePath = provider === 'cuda' ? cudaExecutablePath : cpuExecutablePath;
    const args = buildMdxArguments({
      provider,
      modelPath,
      inputPath: paths.inputPath,
      vocalsPath: paths.vocalsPath,
      accompanimentPath: paths.accompanimentPath,
      numThreads
    });
    const result = await runExecFile(executablePath, args);
    return {
      executablePath,
      args,
      result,
      actualProvider: provider === 'cuda' && detectsCliCpuFallback(result) ? 'cpu' : provider
    };
  }

  async function separate(options = {}) {
    const startedAt = Date.now();
    const runtime = inspectRuntime();
    const selection = selectProvider(options.requestedProvider, runtime);
    const paths = {
      inputPath: options.inputPath,
      vocalsPath: options.vocalsPath,
      accompanimentPath: options.accompanimentPath
    };

    for (const [name, value] of Object.entries(paths)) {
      if (!value || typeof value !== 'string') {
        throw new MdxSeparatorError(`Thiếu đường dẫn MDX: ${name}`, 'MDX_INVALID_PATHS');
      }
    }

    options.onProviderSelected?.({
      requestedProvider: selection.requestedProvider,
      provider: selection.provider,
      reason: selection.fallbackReason
    });

    let usedProvider = selection.provider;
    let fallback = selection.provider !== selection.requestedProvider
      && selection.requestedProvider !== 'auto';
    let fallbackReason = selection.fallbackReason;

    try {
      const providerExecution = await executeProvider(usedProvider, paths, options.numThreads);
      if (usedProvider === 'cuda' && providerExecution.actualProvider === 'cpu') {
        const reason = 'MDX CUDA binary không có CUDAExecutionProvider và đã tự chuyển sang CPU';
        if (selection.requestedProvider === 'cuda') {
          throw new MdxSeparatorError(
            reason,
            'MDX_CUDA_PROVIDER_UNAVAILABLE',
            { stderr: providerExecution.result?.stderr || null }
          );
        }
        usedProvider = 'cpu';
        fallback = true;
        fallbackReason = reason;
        logger.warn(`[MDX] ${reason}`);
        options.onFallback?.({ from: 'cuda', to: 'cpu', reason });
      }
    } catch (error) {
      const canFallback = selection.requestedProvider === 'auto'
        && usedProvider === 'cuda'
        && !isCancellationError(error, options.isCancelled)
        && isCudaRuntimeError(error);

      if (!canFallback) throw error;

      fallback = true;
      fallbackReason = error.message || 'CUDA không thể khởi tạo';
      usedProvider = 'cpu';
      logger.warn(`[MDX] CUDA thất bại, chuyển sang CPU: ${fallbackReason}`);
      options.onFallback?.({
        from: 'cuda',
        to: 'cpu',
        reason: fallbackReason
      });
      await executeProvider('cpu', paths, options.numThreads);
    }

    for (const [name, outputPath] of Object.entries({
      vocalsPath: paths.vocalsPath,
      accompanimentPath: paths.accompanimentPath
    })) {
      if (!fileSystem.existsSync(outputPath)) {
        throw new MdxSeparatorError(
          `MDX ONNX không tạo được ${name}`,
          'MDX_OUTPUT_MISSING',
          { outputPath, usedProvider }
        );
      }
    }

    return {
      requestedProvider: selection.requestedProvider,
      usedProvider,
      fallback,
      selectionReason: selection.fallbackReason || null,
      fallbackReason: fallback ? fallbackReason : null,
      durationMs: Date.now() - startedAt,
      model: 'UVR_MDXNET_KARA_2'
    };
  }

  return {
    inspectRuntime,
    selectProvider,
    separate
  };
}

module.exports = {
  MDX_PROVIDERS,
  MdxSeparatorError,
  buildMdxArguments,
  createMdxSeparatorManager,
  isCancellationError,
  detectsCliCpuFallback,
  isCudaRuntimeError,
  normalizeMdxProvider
};
