const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const shared = require('../lib/shared-state');
const { OcrTechnicalError, detectOcrDevice, runVse } = require('../lib/vse-helper');

function createFakeSpawn({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const calls = [];

  return {
    child,
    calls,
    spawn(...args) {
      calls.push(args);
      return child;
    }
  };
}

function closeChild(child, code) {
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code, null);
}

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vse-helper-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function baseOptions(directory, spawnImpl) {
  return {
    executablePath: 'C:\\OCR Tools\\vse-cli.exe',
    videoPath: 'D:\\Video co dau\\nguoi dep.mp4',
    outputPath: path.join(directory, 'phu de', 'ket qua.srt'),
    language: 'vi',
    region: '0.70,0.98,0.05,0.95',
    device: 'gpu',
    cwd: directory,
    spawnImpl
  };
}

test('runs the exact executable with unchanged video and output arguments', async () => {
  await withTempDirectory(async (directory) => {
    const fake = createFakeSpawn();
    const options = baseOptions(directory, fake.spawn);
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, '1\n00:00:00,000 --> 00:00:01,000\nXin chao\n');

    const pending = runVse(options);

    assert.equal(shared.state.activeProcesses.has(fake.child), true);
    assert.deepEqual(fake.calls, [[
      options.executablePath,
      [
        '--video', options.videoPath,
        '--language', options.language,
        '--mode', 'fast',
        '--region', options.region,
        '--device', options.device,
        '--output', options.outputPath
      ],
      {
        cwd: directory,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    ]]);

    closeChild(fake.child, 0);
    assert.deepEqual(await pending, { kind: 'success', result: null });
  });
});

test('forwards JSON-lines progress and ignores non-JSON stdout and stderr diagnostics', async () => {
  await withTempDirectory(async (directory) => {
    const fake = createFakeSpawn();
    const progress = [];
    const options = baseOptions(directory, fake.spawn);
    options.onProgress = (event) => progress.push(event);
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, 'subtitle');

    const pending = runVse(options);
    fake.child.stdout.write('loading model\n');
    fake.child.stdout.write('{"kind":"progress","percent":45}\n');
    fake.child.stdout.write('{"kind":"result","cueCount":8}\n');
    fake.child.stderr.write('diagnostic: model cache warm\n');
    closeChild(fake.child, 0);

    assert.deepEqual(await pending, {
      kind: 'success',
      result: { kind: 'result', cueCount: 8 }
    });
    assert.deepEqual(progress, [{ kind: 'progress', percent: 45 }]);
  });
});

test('returns no_subtitles when VSE exits with code 2', async () => {
  await withTempDirectory(async (directory) => {
    const fake = createFakeSpawn();
    const pending = runVse(baseOptions(directory, fake.spawn));

    closeChild(fake.child, 2);

    assert.deepEqual(await pending, { kind: 'no_subtitles' });
  });
});

test('throws a typed error when VSE exits unsuccessfully or omits its requested output', async () => {
  await withTempDirectory(async (directory) => {
    const failed = createFakeSpawn();
    const failedRun = runVse(baseOptions(directory, failed.spawn));
    failed.child.stderr.write('failed to read frame\n');
    closeChild(failed.child, 1);

    await assert.rejects(failedRun, (error) => {
      assert.equal(error instanceof OcrTechnicalError, true);
      assert.equal(error.code, 'OCR_TECHNICAL_ERROR');
      assert.match(error.message, /failed to read frame/);
      return true;
    });

    const missing = createFakeSpawn();
    const missingRun = runVse(baseOptions(directory, missing.spawn));
    closeChild(missing.child, 0);

    await assert.rejects(missingRun, (error) => {
      assert.equal(error instanceof OcrTechnicalError, true);
      assert.equal(error.code, 'OCR_TECHNICAL_ERROR');
      assert.match(error.message, /output/i);
      return true;
    });
  });
});

test('throws a typed error when spawning VSE emits an error', async () => {
  await withTempDirectory(async (directory) => {
    const fake = createFakeSpawn();
    const pending = runVse(baseOptions(directory, fake.spawn));
    fake.child.emit('error', new Error('executable is unavailable'));

    await assert.rejects(pending, (error) => {
      assert.equal(error instanceof OcrTechnicalError, true);
      assert.equal(error.code, 'OCR_TECHNICAL_ERROR');
      assert.match(error.message, /executable is unavailable/);
      return true;
    });
  });
});

test('terminates the registered process tree and rejects when VSE times out', async () => {
  await withTempDirectory(async (directory) => {
    const fake = createFakeSpawn();
    const killed = [];
    const originalKillProcessTree = shared.killProcessTree;
    shared.killProcessTree = (child) => killed.push(child);
    try {
      await assert.rejects(
        runVse({ ...baseOptions(directory, fake.spawn), timeoutMs: 1 }),
        (error) => {
          assert.equal(error instanceof OcrTechnicalError, true);
          assert.equal(error.code, 'OCR_TECHNICAL_ERROR');
          assert.match(error.message, /timed out/i);
          return true;
        }
      );
      assert.deepEqual(killed, [fake.child]);
    } finally {
      shared.killProcessTree = originalKillProcessTree;
    }
  });
});

test('detects a GPU only for Windows installations with nvcuda.dll', () => {
  const calls = [];
  assert.equal(detectOcrDevice({
    platform: 'win32',
    windir: 'C:\\Windows',
    existsSync: (filePath) => {
      calls.push(filePath);
      return true;
    }
  }), 'gpu');
  assert.deepEqual(calls, [path.join('C:\\Windows', 'System32', 'nvcuda.dll')]);

  assert.equal(detectOcrDevice({
    platform: 'linux',
    windir: 'C:\\Windows',
    existsSync: () => true
  }), 'cpu');
  assert.equal(detectOcrDevice({
    platform: 'win32',
    windir: 'C:\\Windows',
    existsSync: () => false
  }), 'cpu');
});

test('marks only known CUDA diagnostics as retryable on CPU', async () => {
  const retryableDiagnostics = [
    'CUDA initialization failed',
    'CUDA driver version is insufficient',
    'Could not load nvcuda.dll',
    'cuDNN allocation failed',
    'CUDA out of memory'
  ];

  await withTempDirectory(async (directory) => {
    for (const diagnostic of retryableDiagnostics) {
      const fake = createFakeSpawn();
      const pending = runVse(baseOptions(directory, fake.spawn));
      fake.child.stderr.write(`${diagnostic}\n`);
      closeChild(fake.child, 1);

      await assert.rejects(pending, (error) => {
        assert.equal(error.retryableOnCpu, true, diagnostic);
        return true;
      });
    }

    const arbitraryFailure = createFakeSpawn();
    const pending = runVse(baseOptions(directory, arbitraryFailure.spawn));
    arbitraryFailure.child.stderr.write('input stream ended unexpectedly\n');
    closeChild(arbitraryFailure.child, 1);

    await assert.rejects(pending, (error) => {
      assert.equal(error.retryableOnCpu, undefined);
      return true;
    });
  });
});
