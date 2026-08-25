const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  PiperRuntimeManager,
  parseLastJson,
  validModelFile
} = require('../lib/piper-runtime-manager');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piper-runtime-manager-'));
  const runtimeRoot = path.join(root, 'user', 'runtime');
  const python = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
  const appRoot = path.join(root, 'tools', 'crawler', 'app');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(python, 'python');
  fs.writeFileSync(path.join(appRoot, 'piper_tts_bridge.py'), '# bridge');
  fs.writeFileSync(path.join(root, 'tools', 'crawler', 'setup-piper-runtime.ps1'), '# setup');
  fs.writeFileSync(path.join(root, 'tools', 'uv.exe'), 'uv');
  return { root, runtimeRoot, python, appRoot };
}

test('Piper readiness comes from the real bridge check, not a marker file', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.runtimeRoot, 'piper-runtime-v1.json'), '{}');
    const manager = new PiperRuntimeManager({
      bundledRoot: fixture.root,
      runtimeRoot: fixture.runtimeRoot,
      python: fixture.python,
      appRoot: fixture.appRoot,
      spawnSyncImpl: () => ({ status: 1, stdout: '{"ok":false,"error":"No module named piper"}\n', stderr: '' })
    });
    const status = manager.status();
    assert.equal(status.markerExists, true);
    assert.equal(status.ready, false);
    assert.match(status.error, /No module named piper/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Piper status exposes providers and keeps model readiness separate', () => {
  const fixture = createFixture();
  try {
    const modelDir = path.join(fixture.runtimeRoot, 'piper_models');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'ngochuyen.onnx'), Buffer.alloc(1_000_001, 1));
    fs.writeFileSync(path.join(modelDir, 'ngochuyen.onnx.json'), '{}');
    const manager = new PiperRuntimeManager({
      bundledRoot: fixture.root,
      runtimeRoot: fixture.runtimeRoot,
      python: fixture.python,
      appRoot: fixture.appRoot,
      spawnSyncImpl: () => ({
        status: 0,
        stdout: '{"ok":true,"providers":["CPUExecutionProvider"],"dependencies":{"piper":true}}\n',
        stderr: ''
      })
    });
    const status = manager.status();
    assert.equal(status.ready, true);
    assert.deepEqual(status.providers, ['CPUExecutionProvider']);
    assert.equal(status.defaultModel.ready, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Piper repair launches only the dedicated installer with the shared runtime root', () => {
  const fixture = createFixture();
  try {
    let call;
    const proc = new EventEmitter();
    proc.pid = 456;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    const manager = new PiperRuntimeManager({
      bundledRoot: fixture.root,
      runtimeRoot: fixture.runtimeRoot,
      python: fixture.python,
      appRoot: fixture.appRoot,
      spawnSyncImpl: () => ({ status: 1, stdout: '{"ok":false,"error":"broken"}\n', stderr: '' }),
      spawnImpl: (command, args, options) => {
        call = { command, args, options };
        return proc;
      }
    });
    const result = manager.install({ force: true });
    assert.equal(result.started, true);
    assert.equal(result.repairing, true);
    assert.ok(call.args.includes(path.join(fixture.root, 'tools', 'crawler', 'setup-piper-runtime.ps1')));
    assert.ok(call.args.includes(fixture.runtimeRoot));
    assert.ok(call.args.includes('-ForceRepair'));
    assert.equal(call.args.some(value => String(value).includes('setup-runtime.ps1') && !String(value).includes('setup-piper-runtime.ps1')), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Piper helpers reject HTML masquerading as a model and parse the last JSON line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piper-model-check-'));
  try {
    const invalid = path.join(root, 'voice.onnx');
    fs.writeFileSync(invalid, `<html>${'x'.repeat(1_100_000)}</html>`);
    assert.equal(validModelFile(invalid), false);
    assert.deepEqual(parseLastJson('progress\n{"ok":true}\n'), { ok: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
