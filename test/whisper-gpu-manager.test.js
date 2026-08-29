const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { WhisperGpuManager, parseWhisperGpuJson } = require('../lib/whisper-gpu-manager');

function fakeProcess(pid = 123) {
  const process = new EventEmitter();
  process.pid = pid;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  return process;
}

test('parses only the dedicated Whisper GPU JSON protocol', () => {
  assert.equal(parseWhisperGpuJson('noise\nWHISPER_GPU_JSON {"gpuReady":true}').gpuReady, true);
  assert.equal(parseWhisperGpuJson('OCR_GPU_JSON {"gpuReady":true}'), null);
});

test('status accepts CUDA only after a real Large V3 Turbo inference', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-gpu-status-'));
  try {
    const runtimeRoot = path.join(root, 'runtime');
    const python = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, 'python');
    let args;
    const proc = fakeProcess();
    const manager = new WhisperGpuManager({
      bundledRoot: root, runtimeRoot, python, modelsDir: path.join(root, 'models'),
      runtimeReady: () => true, modelReady: () => true,
      spawnImpl: (_command, childArgs) => { args = childArgs; return proc; }
    });
    const pending = manager.refresh();
    proc.stdout.write('WHISPER_GPU_JSON {"gpuReady":true,"actualInference":true,"gpuName":"RTX"}\n');
    proc.emit('close', 0);
    const status = await pending;
    assert.equal(status.gpuReady, true);
    assert.equal(status.device, 'cuda');
    assert.ok(args.includes('--status'));
    assert.ok(args.includes('--model-root'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer launches repair flow without an unsupported --install flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-gpu-install-'));
  try {
    const runtimeRoot = path.join(root, 'runtime');
    const python = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools', 'crawler'), { recursive: true });
    fs.writeFileSync(python, 'python');
    fs.writeFileSync(path.join(root, 'tools', 'uv.exe'), 'uv');
    fs.writeFileSync(path.join(root, 'tools', 'crawler', 'install-whisper-gpu.py'), '# test');
    let args;
    const proc = fakeProcess(456);
    const manager = new WhisperGpuManager({
      bundledRoot: root, runtimeRoot, python, modelsDir: path.join(root, 'models'),
      runtimeReady: () => true, modelReady: () => true,
      spawnImpl: (_command, childArgs) => { args = childArgs; return proc; }
    });
    assert.equal(manager.install().started, true);
    assert.equal(args.includes('--install'), false);
    assert.ok(args.includes('--uv'));
    assert.equal(manager.status().installing, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
