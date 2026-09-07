const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BOUNDARY_SILENCE_FILTER,
  CACHE_VERSION,
  MAX_CHARACTERS,
  MAX_LINES,
  splitLines
} = require('../lib/standalone-tts');

test('standalone TTS keeps one sentence per non-empty line', () => {
  assert.deepEqual(splitLines(' Câu một.\n\n Câu hai. \n'), ['Câu một.', 'Câu hai.']);
});

test('standalone TTS enforces the Viral-style line and character limits', () => {
  assert.throws(() => splitLines(Array.from({ length: MAX_LINES + 1 }, () => 'a').join('\n')), /500 dòng/);
  assert.throws(() => splitLines('a'.repeat(MAX_CHARACTERS + 1)), /20.000 ký tự/);
});

test('standalone TTS trims only boundary silence and invalidates truncated cache entries', () => {
  assert.equal(CACHE_VERSION, 2);
  assert.match(BOUNDARY_SILENCE_FILTER, /areverse/);
  assert.doesNotMatch(BOUNDARY_SILENCE_FILTER, /stop_periods/);
});

test('standalone TTS routes and packaged UI are registered', () => {
  const root = path.resolve(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(server, /\/api\/standalone-tts\/generate/);
  assert.match(server, /\/tts-output/);
  assert.match(html, /id="view-tts"/);
  assert.match(html, /js\/tts-standalone-module\.js/);
});
