const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { OcrGpuManager, parseJsonLine } = require('../lib/ocr-gpu-manager');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-gpu-manager-'));
  const runtimeRoot = path.join(root, 'runtime');
  const python = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools', 'crawler'), { recursive: true });
  fs.writeFileSync(python, 'python');
  fs.writeFileSync(path.join(root, 'tools', 'uv.exe'), 'uv');
  fs.writeFileSync(path.join(root, 'tools', 'crawler', 'install-ocr-gpu.py'), '# gpu');
  return { root, runtimeRoot, python };
}

test('GPU status parser accepts structured installer output', () => {
  assert.deepEqual(parseJsonLine('OCR_GPU_JSON {"gpuReady":true,"provider":"CUDAExecutionProvider"}'), {
    gpuReady: true,
    provider: 'CUDAExecutionProvider'
  });
});

test('GPU manager keeps RapidOCR on CPU by default even when CUDA is ready', async () => {
  const item = fixture();
  const previousGpu = process.env.OCR_DUNG_GPU;
  const previousNoCuda = process.env.OCR_NO_CUDA;
  try {
    delete process.env.OCR_DUNG_GPU;
    delete process.env.OCR_NO_CUDA;
    const manager = new OcrGpuManager({
      bundledRoot: item.root,
      runtimeRoot: item.runtimeRoot,
      python: item.python,
      runtimeReady: () => true,
      probeImpl: async () => ({
        nvidia: true, supported: true, gpuReady: true,
        gpuName: 'RTX Test', provider: 'CUDAExecutionProvider'
      })
    });
    const status = await manager.refresh();
    assert.equal(status.gpuReady, true);
    assert.equal(status.provider, 'CUDAExecutionProvider');
    assert.equal(status.requestedDevice, 'cpu');
    assert.equal(status.activeProvider, 'CPUExecutionProvider');
    assert.equal(status.enabled, false);
    assert.equal(process.env.OCR_DUNG_GPU, '0');
    assert.match(status.message, /mặc định chạy CPU/);
  } finally {
    if (previousGpu === undefined) delete process.env.OCR_DUNG_GPU;
    else process.env.OCR_DUNG_GPU = previousGpu;
    if (previousNoCuda === undefined) delete process.env.OCR_NO_CUDA;
    else process.env.OCR_NO_CUDA = previousNoCuda;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('GPU manager honors explicit OCR_DUNG_GPU opt-in after CUDA is proven', async () => {
  const item = fixture();
  const previousGpu = process.env.OCR_DUNG_GPU;
  const previousNoCuda = process.env.OCR_NO_CUDA;
  try {
    process.env.OCR_DUNG_GPU = '1';
    delete process.env.OCR_NO_CUDA;
    const manager = new OcrGpuManager({
      bundledRoot: item.root,
      runtimeRoot: item.runtimeRoot,
      python: item.python,
      runtimeReady: () => true,
      probeImpl: async () => ({
        nvidia: true, supported: true, gpuReady: true,
        gpuName: 'RTX Test', provider: 'CUDAExecutionProvider'
      })
    });
    const status = await manager.refresh();
    assert.equal(status.requestedDevice, 'gpu');
    assert.equal(status.activeProvider, 'CUDAExecutionProvider');
    assert.equal(status.enabled, true);
    assert.match(status.message, /đang dùng GPU/);
  } finally {
    if (previousGpu === undefined) delete process.env.OCR_DUNG_GPU;
    else process.env.OCR_DUNG_GPU = previousGpu;
    if (previousNoCuda === undefined) delete process.env.OCR_NO_CUDA;
    else process.env.OCR_NO_CUDA = previousNoCuda;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('GPU manager blocks package replacement while render is active', () => {
  const item = fixture();
  try {
    const manager = new OcrGpuManager({
      bundledRoot: item.root,
      runtimeRoot: item.runtimeRoot,
      python: item.python,
      runtimeReady: () => true,
      isBusy: () => true
    });
    assert.throws(() => manager.install(), /đang render/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('GPU installer progress and final CUDA provider update manager state', () => {
  const item = fixture();
  const previousGpu = process.env.OCR_DUNG_GPU;
  const previousNoCuda = process.env.OCR_NO_CUDA;
  try {
    delete process.env.OCR_DUNG_GPU;
    delete process.env.OCR_NO_CUDA;
    const proc = new EventEmitter();
    proc.pid = 77;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    const manager = new OcrGpuManager({
      bundledRoot: item.root,
      runtimeRoot: item.runtimeRoot,
      python: item.python,
      runtimeReady: () => true,
      spawnImpl: () => proc
    });
    assert.equal(manager.install().started, true);
    proc.stdout.write('OCR_GPU_PROGRESS 35 Đang cài CUDA Runtime…\n');
    assert.equal(manager.status().percent, 35);
    proc.stdout.write('OCR_GPU_JSON {"nvidia":true,"supported":true,"gpuReady":true,"gpuName":"RTX Test"}\n');
    proc.emit('close', 0);
    assert.equal(manager.status().gpuReady, true);
    assert.equal(manager.status().provider, 'CUDAExecutionProvider');
    assert.equal(manager.status().activeProvider, 'CPUExecutionProvider');
    assert.equal(manager.status().enabled, false);
  } finally {
    if (previousGpu === undefined) delete process.env.OCR_DUNG_GPU;
    else process.env.OCR_DUNG_GPU = previousGpu;
    if (previousNoCuda === undefined) delete process.env.OCR_NO_CUDA;
    else process.env.OCR_NO_CUDA = previousNoCuda;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
