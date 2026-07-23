const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  applyTranslationProfileToText,
  createTranslationQualityReport,
  getTranslationPrompt,
  normalizeTranslationProfile,
  prepareTextForTranslation
} = require('../lib/translate-sub');

const PROFILE = {
  style: 'casual',
  speakerPronoun: 'mình',
  audiencePronoun: 'các bạn',
  context: 'Người dẫn đang nói trực tiếp với khán giả.',
  entries: [
    { mode: 'required', source: '玛茵', target: 'Mine' },
    { mode: 'keep', source: 'Teigu', target: '' },
    { mode: 'output', source: 'tớ', target: 'mình' }
  ]
};

test('normalizes a project translation profile and keep rules', () => {
  const profile = normalizeTranslationProfile(JSON.stringify(PROFILE));
  assert.equal(profile.style, 'casual');
  assert.equal(profile.speakerPronoun, 'mình');
  assert.equal(profile.entries.length, 3);
  assert.deepEqual(profile.entries[1], { mode: 'keep', source: 'Teigu', target: 'Teigu' });
});

test('protects required terms and restores them after translation', () => {
  const prepared = prepareTextForTranslation('玛茵 sử dụng Teigu', PROFILE);
  assert.doesNotMatch(prepared, /玛茵/);
  assert.match(prepared, /\[\[VST_TERM_1\]\]/);
  assert.match(prepared, /\[\[VST_TERM_2\]\]/);

  const translated = applyTranslationProfileToText(
    '[[VST_TERM_1]] nói: tớ sử dụng [[VST_TERM_2]].',
    PROFILE
  );
  assert.equal(translated, 'Mine nói: mình sử dụng Teigu.');
});

test('project glossary takes priority over the built-in translation dictionary', () => {
  const prepared = prepareTextForTranslation('Đây là một 短剧.', {
    entries: [{ mode: 'required', source: '短剧', target: 'short drama' }]
  });
  assert.equal(prepared, 'Đây là một [[VST_TERM_1]].');
});

test('translation prompt carries style, pronouns, context, and glossary through every batch', () => {
  const prompt = getTranslationPrompt({ 1: '[[VST_TERM_1]]' }, 'Tiếng Việt', [], PROFILE);
  assert.match(prompt, /Gần gũi, đời thường/);
  assert.match(prompt, /tự xưng: mình/);
  assert.match(prompt, /khán giả là: các bạn/);
  assert.match(prompt, /Người dẫn đang nói trực tiếp/);
  assert.match(prompt, /VST_TERM_1/);
  assert.match(prompt, /Không dùng "tớ"/);
});

test('quality report flags missing required and forbidden output terms', () => {
  const report = createTranslationQualityReport(
    '玛茵 sử dụng Teigu',
    'Mã Anh nói rằng tớ sử dụng vũ khí.',
    PROFILE
  );
  assert.equal(report.checked, true);
  assert.equal(report.issueCount, 3);
  assert.deepEqual(report.issues.map((issue) => issue.type), [
    'missing_term',
    'missing_term',
    'forbidden_term'
  ]);
});

test('quality report detects pronouns that conflict with the project profile', () => {
  const report = createTranslationQualityReport('', 'Tớ chào bạn, cảm ơn cậu đã xem.', {
    speakerPronoun: 'tôi',
    audiencePronoun: 'bạn'
  });
  assert.equal(report.checked, true);
  assert.equal(report.ruleCount, 2);
  assert.deepEqual(report.issues, [
    { type: 'inconsistent_pronoun', source: 'tớ', expected: 'tôi' },
    { type: 'inconsistent_pronoun', source: 'cậu', expected: 'bạn' }
  ]);
});

test('studio UI persists and sends the project translation profile', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'controllers', 'studioController.js'), 'utf8');

  assert.match(html, /name="translationProfile"/);
  assert.match(html, /id="translation-rules-list"/);
  assert.match(app, /syncTranslationProfileValue\(false\)/);
  assert.match(app, /loadTranslationProfileFromHidden\(\)/);
  assert.match(controller, /translationProfile:\s*body\.translationProfile/);
  assert.match(controller, /translationReport/);
});
