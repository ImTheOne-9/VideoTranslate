const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('server exposes dedicated Piper status and repair routes', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /new PiperRuntimeManager\(\)/u);
  assert.match(server, /app\.get\('\/api\/piper-runtime\/status'/u);
  assert.match(server, /app\.post\('\/api\/piper-runtime\/install'/u);
});

test('Piper install button no longer delegates to the crawler or RapidOCR installer', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /async function installPiperRuntime\(\)/u);
  assert.match(app, /\$\('voice-runtime-install-btn'\)\?\.addEventListener\('click',[\s\S]*?installPiperRuntime\(\)/u);
  assert.doesNotMatch(app, /installRapidOcrRuntime\('Piper'\)/u);
  assert.match(app, /\/api\/piper-runtime\/status/u);
  assert.match(app, /\/api\/piper-runtime\/install/u);
});

test('dedicated Piper setup verifies every runtime dependency and never installs Playwright', () => {
  const setup = fs.readFileSync(path.join(root, 'tools', 'crawler', 'setup-piper-runtime.ps1'), 'utf8');
  for (const dependency of ['piper-tts==1.3.0', 'audiostretchy', 'vietnormalizer==0.2.3', 'onnxruntime']) {
    assert.ok(setup.includes(dependency), `missing ${dependency}`);
  }
  assert.match(setup, /piper_tts_bridge\.py/u);
  assert.doesNotMatch(setup, /playwright install/u);
  assert.doesNotMatch(setup, /requirements-crawler\.txt/u);
});

test('Piper bridge has bundled, Banmai, vais1000, timeout and API compatibility recovery', () => {
  const bridge = fs.readFileSync(path.join(root, 'tools', 'crawler', 'app', 'piper_tts_bridge.py'), 'utf8');
  assert.match(bridge, /VIDEO_STUDIO_PIPER_BUNDLED/u);
  assert.match(bridge, /VIDEO_STUDIO_PIPER_BANMAI_BASE/u);
  assert.match(bridge, /vi_VN-vais1000-medium/u);
  assert.match(bridge, /VIDEO_STUDIO_PIPER_DOWNLOAD_TIMEOUT/u);
  assert.match(bridge, /_synthesize_compatible/u);
  assert.match(bridge, /hasattr\(voice, "synthesize_wav"\)/u);
});
