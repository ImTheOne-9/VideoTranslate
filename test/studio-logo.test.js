const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildStudioLogoOverlay, renameVideoOutput } = require('../controllers/studioController');
const { isSupportedLogoFile } = require('../controllers/voiceController');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Studio logo overlay builds bounded custom position, opacity and timing', () => {
  const result = buildStudioLogoOverlay({
    logoEnabled: 'true', savedLogoFile: 'brand.png', logoPosition: 'custom',
    logoXPercent: '25', logoYPercent: '40', logoWidthPercent: '20',
    logoOpacity: '0.5', logoStart: '1.5', logoEnd: '8.25'
  }, { inputIndex: 3, videoWidth: 1080, baseLabel: 'v_logo_base' });
  assert.equal(result.enabled, true);
  assert.match(result.segments[0], /^\[3:v\].*aa=0\.500,scale=216:-1\[studio_logo\]$/);
  assert.match(result.segments[1], /^\[v_logo_base\]\[studio_logo\]overlay=/);
  assert.match(result.segments[1], /main_w\*0\.250000/);
  assert.match(result.segments[1], /main_h\*0\.400000/);
  assert.match(result.segments[1], /between\(t,1\.500,8\.250\)/);
});

test('Studio logo overlay is disabled without an enabled saved logo', () => {
  assert.deepEqual(buildStudioLogoOverlay({}, { inputIndex: 1 }), { enabled: false, segments: [] });
});

test('Studio logo retargets only the final video output', () => {
  const filters = ['[0:v]hflip[vout]', '[0:a]volume=1[aout]'];
  assert.equal(renameVideoOutput(filters, 'v_logo_base'), true);
  assert.equal(filters[0], '[0:v]hflip[v_logo_base]');
  assert.equal(filters[1], '[0:a]volume=1[aout]');
});

test('Studio logo UI, reusable library and render wiring are present', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const canvas = read('public/js/canvas-module.js');
  const server = read('server.js');
  const controller = read('controllers/studioController.js');
  for (const id of ['panel-logo', 'logo-mode', 'logo-enabled', 'logo-saved-wrapper', 'logo-upload-wrapper', 'saved-logo-select', 'logo-library-upload', 'logo-settings', 'logo-position', 'logo-width-percent', 'logo-opacity', 'logo-start', 'logo-end']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const mode of ['none', 'saved', 'upload']) {
    assert.match(html, new RegExp(`data-logo-mode="${mode}"`));
  }
  assert.match(server, /\/api\/save-logo/);
  assert.match(server, /\/logos/);
  assert.match(controller, /buildStudioLogoOverlay/);
  assert.match(app, /function uploadStudioLogo/);
  assert.match(app, /\.logo-tab-btn\[data-logo-mode="saved"\]/);
  assert.match(app, /obj\._logoMode/);
  assert.match(app, /button\.dataset\.target/);
  assert.doesNotMatch(app, /const panels = \['panel-source-video', 'panel-reaction', 'panel-subtitle', 'panel-voice', 'panel-music'\]/);
  assert.match(canvas, /name: 'logo'/);
  assert.match(canvas, /logo-x-percent/);
});

test('Studio logo upload validates real PNG, JPEG and WebP signatures', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-logo-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const fixtures = {
    'brand.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    'brand.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
    'brand.webp': Buffer.from('RIFF0000WEBP', 'ascii'),
    'fake.png': Buffer.from('not an image', 'ascii')
  };
  for (const [filename, content] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(tempDir, filename), content);
  }
  assert.equal(isSupportedLogoFile(path.join(tempDir, 'brand.png')), true);
  assert.equal(isSupportedLogoFile(path.join(tempDir, 'brand.jpg')), true);
  assert.equal(isSupportedLogoFile(path.join(tempDir, 'brand.webp')), true);
  assert.equal(isSupportedLogoFile(path.join(tempDir, 'fake.png')), false);
});
