'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CAPCUT_VOICES,
  CapCutTTSEngine,
  loadCapCutVoiceCatalog
} = require('../lib/voice-engines/capcut-tts-engine');

test('CapCut TTS exposes Vietnamese voices and native batch capability', () => {
  const engine = new CapCutTTSEngine({
    paths: { python: 'python', appRoot: '.', ffmpegPath: 'ffmpeg' },
    workerPath: 'worker.py'
  });
  const capabilities = engine.getCapabilities();
  assert.equal(capabilities.batchSynthesis, true);
  assert.equal(capabilities.batchSize, 40);
  assert.equal(capabilities.requiresInternet, true);
  assert.ok(capabilities.voices.some((voice) => voice.id === 'BV421_vivn_streaming'));
  assert.ok(CAPCUT_VOICES.some((voice) => voice.gender === 'male' && voice.lang === 'vi'));
});

test('CapCut TTS loads the complete curated ViralCrawl catalog and ElevenLabs routing', () => {
  const appRoot = path.join(__dirname, '..', 'tools', 'crawler', 'app');
  const voices = loadCapCutVoiceCatalog({ appRoot });
  assert.equal(voices.length, 459);
  assert.equal(new Set(voices.map((voice) => voice.id)).size, voices.length);
  assert.equal(voices.filter((voice) => voice.lang === 'vi').length, 22);
  assert.equal(voices.find((voice) => voice.lang === 'vi').id, 'BV074_streaming');
  assert.equal(voices.find((voice) => voice.id === 'pNInz6obpgDQGcFmaJgB').provider, '11labs');
});

test('CapCut worker keeps the ViralCrawl retry, split and provider contracts', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'tools', 'crawler', 'app', 'capcut_tts_worker.py'
  ), 'utf8');
  assert.match(source, /CAPCUT_LO"\) or "40"/);
  assert.match(source, /BATCH_BUDGET_SECONDS/);
  assert.match(source, /MIN_SPLIT_BATCH_SIZE/);
  assert.match(source, /reason == "blocked"/);
  assert.match(source, /provider \+ "_text_to_speech"/);
  assert.match(source, /splitting %d into %d\+%d/);
});

test('CapCut TTS maps worker batch results back to original cue order', async () => {
  const engine = new CapCutTTSEngine({
    paths: { python: 'python', appRoot: '.', ffmpegPath: 'ffmpeg' },
    workerPath: 'worker.py'
  });
  engine.loadModel = async () => ({ ready: true });
  engine.runWorker = async (items) => ({
    ok: true,
    results: items.slice().reverse().map((item) => ({ key: item.key, ok: true, outputPath: item.outputPath }))
  });
  const results = await engine.synthesizeBatch({ items: [
    { key: 'a', text: 'Một', outputPath: 'a.wav', language: 'vi' },
    { key: 'b', text: 'Hai', outputPath: 'b.wav', language: 'vi' }
  ] });
  assert.deepEqual(results.map((item) => item.key), ['a', 'b']);
  assert.deepEqual(results.map((item) => item.ok), [true, true]);
});

test('CapCut TTS forwards the selected ElevenLabs provider to the worker', async () => {
  const appRoot = path.join(__dirname, '..', 'tools', 'crawler', 'app');
  const engine = new CapCutTTSEngine({
    paths: { python: 'python', appRoot, ffmpegPath: 'ffmpeg' },
    workerPath: 'worker.py'
  });
  engine.loadModel = async () => ({ ready: true });
  let workerItems;
  engine.runWorker = async (items) => {
    workerItems = items;
    return { ok: true, results: items.map((item) => ({
      key: item.key, ok: true, outputPath: item.outputPath
    })) };
  };
  const results = await engine.synthesizeBatch({ items: [{
    key: 'adam', text: 'Hello world.', outputPath: 'adam.wav',
    language: 'en', voice: 'pNInz6obpgDQGcFmaJgB'
  }] });
  assert.equal(results[0].ok, true);
  assert.equal(workerItems[0].provider, '11labs');
});

test('CapCut TTS merges connected continuation cues and keeps per-cue outputs', async () => {
  const engine = new CapCutTTSEngine({
    paths: { python: 'python', appRoot: '.', ffmpegPath: 'ffmpeg' },
    workerPath: 'worker.py'
  });
  engine.loadModel = async () => ({ ready: true });
  let workerItems;
  engine.runWorker = async (items) => {
    workerItems = items;
    return {
      ok: true,
      results: items.flatMap((item) => (item.children || [item]).map((child) => ({
        key: child.key, ok: true, outputPath: child.outputPath
      })))
    };
  };
  const results = await engine.synthesizeBatch({ items: [
    { key: 'a', text: 'Một câu chưa hết', outputPath: 'a.wav', language: 'vi', startMs: 0, endMs: 500 },
    { key: 'b', text: 'và đây là phần tiếp theo.', outputPath: 'b.wav', language: 'vi', startMs: 700, endMs: 1400 }
  ] });
  assert.equal(workerItems.length, 1);
  assert.equal(workerItems[0].children.length, 2);
  assert.deepEqual(results.map((item) => item.ok), [true, true]);
});

test('CapCut TTS preserves merged-timestamp batch fallback metadata', async () => {
  const engine = new CapCutTTSEngine({
    paths: { python: 'python', appRoot: '.', ffmpegPath: 'ffmpeg' },
    workerPath: 'worker.py'
  });
  engine.loadModel = async () => ({ ready: true });
  engine.runWorker = async (items) => ({
    ok: true,
    results: items.flatMap((item) => (item.children || [item]).map((child) => ({
      key: child.key,
      ok: true,
      outputPath: child.outputPath,
      fallbackFromMerged: true
    })))
  });
  const results = await engine.synthesizeBatch({ items: [
    { key: 'a', text: 'Nồng độ LDL', outputPath: 'a.wav', language: 'vi', startMs: 0, endMs: 500 },
    { key: 'b', text: 'tiếp tục tăng.', outputPath: 'b.wav', language: 'vi', startMs: 600, endMs: 1200 }
  ] });
  assert.equal(results.every((item) => item.ok), true);
  assert.equal(results.every((item) => item.result.fallbackFromMerged === true), true);
});
