const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getSubtitleAnalysisPrompt,
  getTranslationPrompt
} = require('../lib/translate-sub');

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

test('whole-SRT analysis prompt contains every cue before translation batches', () => {
  const cues = Array.from({ length: 115 }, (_, index) => ({
    id: String(index + 1),
    startTime: `00:00:${String(index % 60).padStart(2, '0')},000`,
    endTime: `00:00:${String(index % 60).padStart(2, '0')},900`,
    text: `Nội dung nguồn ${index + 1}`
  }));
  const prompt = getSubtitleAnalysisPrompt(cues, 'Tiếng Việt');

  assert.match(prompt, /đọc TOÀN BỘ file SRT/i);
  assert.match(prompt, /"id": "1"/);
  assert.match(prompt, /Nội dung nguồn 1/);
  assert.match(prompt, /"id": "115"/);
  assert.match(prompt, /Nội dung nguồn 115/);
  assert.match(prompt, /characters/);
  assert.match(prompt, /terminology/);
});

test('translation prompt receives the same whole-SRT context for every batch', () => {
  const globalContext = {
    summary: 'Mine chiến đấu cùng Night Raid.',
    characters: [{ name: 'Mine', gender: 'nữ', role: 'thành viên Night Raid' }],
    terminology: [{ source: '帝具', target: 'Đế Cụ' }],
    tone: 'Bi tráng',
    translationRules: ['Giữ tên Mine']
  };
  const prompt = getTranslationPrompt({
    81: { text: '下一句', durationSec: 1.5 }
  }, 'Tiếng Việt', [], globalContext);

  assert.match(prompt, /PHÂN TÍCH TOÀN BỘ SRT/);
  assert.match(prompt, /Mine chiến đấu cùng Night Raid/);
  assert.match(prompt, /Đế Cụ/);
});

test('translation backend contains no configurable profile pipeline', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'translate-sub.js'), 'utf8');

  assert.doesNotMatch(
    source,
    /normalizeTranslationProfile|buildTranslationProfileInstructions|applyTranslationProfileToText|translationProfile/
  );
});
