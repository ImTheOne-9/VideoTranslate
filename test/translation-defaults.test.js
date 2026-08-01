const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getTranslationPrompt } = require('../lib/translate-sub');

test('studio no longer exposes, sends, or restores a translation profile', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'controllers', 'studioController.js'), 'utf8');

  assert.doesNotMatch(html, /translationProfile|translation-profile|Hồ sơ dịch/i);
  assert.doesNotMatch(app, /translationProfile|translation-profile/i);
  assert.doesNotMatch(controller, /translationProfile|translation-profile/i);
});

test('translation uses the standard prompt without project profile instructions', () => {
  const prompt = getTranslationPrompt({ 1: 'Hello' }, 'Tiếng Việt', []);

  assert.match(prompt, /dịch nội dung phụ đề sang Tiếng Việt/i);
  assert.match(prompt, /Dữ liệu đầu vào/i);
  assert.doesNotMatch(prompt, /HỒ SƠ DỊCH|VST_TERM|translationProfile/i);
});

test('translation backend contains no configurable profile pipeline', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'translate-sub.js'), 'utf8');

  assert.doesNotMatch(
    source,
    /normalizeTranslationProfile|buildTranslationProfileInstructions|applyTranslationProfileToText|translationProfile/
  );
});
