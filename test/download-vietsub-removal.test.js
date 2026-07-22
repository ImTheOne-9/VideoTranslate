const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('download UI no longer exposes the Vietsub download flow', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(source, /Tải\s*\+\s*dịch Vietsub/i);
  assert.doesNotMatch(source, /openDownloadTranslateModal/);
  assert.doesNotMatch(source, /selectedFormat\s*===\s*['"]vietsub['"]/);
});

test('dedicated Vietsub download routes are removed', () => {
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /\/api\/download-vi/);
  assert.doesNotMatch(serverSource, /\/api\/download-raw-preview/);
});

test('download endpoint rejects legacy Vietsub requests', () => {
  const source = fs.readFileSync(path.join(root, 'controllers', 'downloadController.js'), 'utf8');
  assert.match(source, /format_id\s*===\s*['"]vietsub['"]/);
  assert.match(source, /res\.status\(410\)/);
});
