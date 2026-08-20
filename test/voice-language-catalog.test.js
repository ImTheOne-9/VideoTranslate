'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  EDGE_LANGUAGE_VOICES,
  OUTPUT_LANGUAGES,
  OUTPUT_LANGUAGE_BY_CODE
} = require('../lib/voice-language-catalog');
const { buildPrompt } = require('../lib/gemini-web-service');

test('output dropdown catalog exposes all 74 Edge languages exactly once', () => {
  assert.equal(OUTPUT_LANGUAGES.length, 74);
  assert.equal(new Set(OUTPUT_LANGUAGES.map((language) => language.code)).size, 74);
  assert.deepEqual(
    OUTPUT_LANGUAGES.map((language) => language.code),
    Object.keys(EDGE_LANGUAGE_VOICES)
  );
  assert.ok(OUTPUT_LANGUAGES.every(
    (language) => language.label && language.promptName && language.google
  ));
});

test('Gemini prompt resolves a newly exposed target to its real language name', () => {
  const prompt = buildPrompt([{ id: 1, text: 'Xin chào', duration: 2 }], '', 'nl');
  assert.match(prompt, /Dutch/);
  assert.doesNotMatch(prompt, /dịch sang VIETNAMESE/i);
  assert.equal(OUTPUT_LANGUAGE_BY_CODE.ne.promptName, 'Nepali');
});

test('studio assets and browser UI share the output-language catalog', () => {
  const root = path.resolve(__dirname, '..');
  const controller = fs.readFileSync(path.join(root, 'controllers', 'studioController.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(controller, /outputLanguages:\s*OUTPUT_LANGUAGES/);
  assert.match(app, /populateOutputLanguageOptions\(assets\.outputLanguages/);
  assert.match(app, /refreshTtsVoiceCatalogs\(assets\.voiceEngines/);
});
