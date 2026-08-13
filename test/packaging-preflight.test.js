const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('packaging excludes crawler profiles, cache, docs and test fixtures', () => {
  const crawler = packageJson.build.extraResources.find((entry) => entry.from === 'tools/crawler/');
  assert.ok(crawler);
  for (const pattern of [
    '!app/**/browser_data/**/*',
    '!app/**/__pycache__/**/*',
    '!app/**/*.pyc',
    '!app/**/test/**/*',
    '!app/**/tests/**/*',
    '!app/**/test_data/**/*',
    '!app/**/docs/**/*',
    '!app/**/data/**/*',
    '!app/**/media_data/**/*'
  ]) {
    assert.ok(crawler.filter.includes(pattern), `missing exclusion ${pattern}`);
  }
});

test('packaging includes a matched FFmpeg and FFprobe pair', () => {
  const tools = packageJson.build.extraResources.find((entry) => entry.from === 'tools/');
  assert.ok(tools.filter.includes('ffmpeg.exe'));
  assert.ok(tools.filter.includes('ffprobe.exe'));
  assert.equal(fs.existsSync(path.join(root, 'tools', 'ffmpeg.exe')), true);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'ffprobe.exe')), true);
});

test('release scripts always use the guarded obfuscation build', () => {
  assert.match(packageJson.scripts['electron-dist'], /obfuscate\.js --build/);
  assert.match(packageJson.scripts['pack-unpacked'], /obfuscate\.js --build --dir/);
  assert.doesNotMatch(packageJson.scripts['electron-dist'], /^electron-builder/);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'package-preflight.js')), true);
});

test('crawler keeps Python Playwright browsers isolated from Node Playwright', () => {
  const pathsSource = fs.readFileSync(path.join(root, 'lib', 'crawler-paths.js'), 'utf8');
  const setupSource = fs.readFileSync(path.join(root, 'tools', 'crawler', 'setup-runtime.ps1'), 'utf8');
  assert.match(pathsSource, /ms-playwright-python/);
  assert.match(setupSource, /ms-playwright-python/);
});
