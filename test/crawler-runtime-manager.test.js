const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CrawlerRuntimeManager } = require('../lib/crawler-runtime-manager');

test('runtime manager launches project setup with bundled uv and AppData runtime root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-runtime-manager-'));
  try {
    fs.mkdirSync(path.join(root, 'tools', 'crawler'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'crawler', 'setup-runtime.ps1'), '# test');
    fs.writeFileSync(path.join(root, 'tools', 'uv.exe'), 'test');
    let call;
    const proc = new EventEmitter();
    proc.pid = 123;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    const manager = new CrawlerRuntimeManager({
      bundledRoot: root,
      userRoot: path.join(root, 'user'),
      spawnImpl: (command, args, options) => { call = { command, args, options }; return proc; }
    });
    const result = manager.install();
    assert.equal(result.started, true);
    assert.ok(call.args.includes(path.join(root, 'tools', 'uv.exe')));
    assert.ok(call.args.includes(path.join(root, 'user', 'runtime')));
    assert.deepEqual(call.args.slice(-2), ['-Capability', 'crawler']);
    proc.stdout.write('Downloading 42%');
    assert.equal(manager.status().percent, 42);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ASR capability can be ready without installing crawler, OCR, voice, or Chromium', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-runtime-asr-ready-'));
  try {
    const runtimeRoot = path.join(root, 'user', 'runtime');
    const python = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, 'python');
    fs.writeFileSync(path.join(runtimeRoot, 'asr-runtime-v1.json'), '{}');
    const manager = new CrawlerRuntimeManager({
      bundledRoot: root,
      userRoot: path.join(root, 'user'),
      runtimeRoot,
      python
    });

    assert.equal(manager.ready('asr'), true);
    assert.equal(manager.ready('crawler'), false);
    assert.equal(manager.status('asr').capabilities.asr, true);
    assert.equal(manager.status('asr').capabilities.ocr, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ASR install passes the capability to the shared runtime setup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-runtime-asr-install-'));
  try {
    fs.mkdirSync(path.join(root, 'tools', 'crawler'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'crawler', 'setup-runtime.ps1'), '# test');
    fs.writeFileSync(path.join(root, 'tools', 'uv.exe'), 'test');
    let call;
    const proc = new EventEmitter();
    proc.pid = 456;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    const manager = new CrawlerRuntimeManager({
      bundledRoot: root,
      userRoot: path.join(root, 'user'),
      spawnImpl: (command, args, options) => { call = { command, args, options }; return proc; }
    });

    const result = manager.install('asr');
    assert.equal(result.started, true);
    assert.deepEqual(call.args.slice(-2), ['-Capability', 'asr']);
    assert.equal(manager.status('asr').installingCapability, 'asr');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OCR install passes the lightweight capability instead of the complete crawler bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-runtime-ocr-install-'));
  try {
    fs.mkdirSync(path.join(root, 'tools', 'crawler'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'crawler', 'setup-runtime.ps1'), '# test');
    fs.writeFileSync(path.join(root, 'tools', 'uv.exe'), 'test');
    let args;
    const proc = new EventEmitter();
    proc.pid = 789;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    const manager = new CrawlerRuntimeManager({
      bundledRoot: root,
      userRoot: path.join(root, 'user'),
      spawnImpl: (_command, childArgs) => { args = childArgs; return proc; }
    });

    assert.equal(manager.install('ocr').started, true);
    assert.deepEqual(args.slice(-2), ['-Capability', 'ocr']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime readiness requires OCR, voice, and ASR dependency markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-runtime-ready-'));
  try {
    const runtimeRoot = path.join(root, 'user', 'runtime');
    const python = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
    const browser = path.join(runtimeRoot, 'ms-playwright-python', 'chromium-123');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.mkdirSync(browser, { recursive: true });
    fs.writeFileSync(python, 'python');
    const manager = new CrawlerRuntimeManager({
      bundledRoot: root,
      userRoot: path.join(root, 'user'),
      runtimeRoot,
      python,
      playwrightBrowsersDir: path.dirname(browser)
    });
    assert.equal(manager.ready(), false);
    fs.writeFileSync(path.join(runtimeRoot, 'ocr-runtime-v3.json'), '{}');
    fs.writeFileSync(path.join(runtimeRoot, 'voice-runtime-v3.json'), '{}');
    assert.equal(manager.ready(), false);
    fs.writeFileSync(path.join(runtimeRoot, 'asr-runtime-v1.json'), '{}');
    assert.equal(manager.ready(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
