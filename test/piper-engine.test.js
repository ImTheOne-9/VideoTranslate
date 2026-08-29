'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_VOICE_ENGINE_ID, voiceEngineRegistry } = require('../lib/voice-engines');
const { PiperEngine, resolvePiperVoice } = require('../lib/voice-engines/piper-engine');

test('Piper is the default adaptive narration engine and is registered', () => {
  assert.equal(DEFAULT_VOICE_ENGINE_ID, 'piper');
  assert.equal(voiceEngineRegistry.get('piper').id, 'piper');
});

test('Piper reports a missing isolated runtime without pretending to be ready', async () => {
  const engine = new PiperEngine({
    paths: {
      python: 'Z:\\missing\\python.exe',
      appRoot: 'Z:\\missing',
      runtimeRoot: 'Z:\\missing',
      ffmpegPath: 'Z:\\missing\\ffmpeg.exe',
      nodePath: 'Z:\\missing\\node.exe',
      userRoot: 'Z:\\missing',
      browserDataDir: 'Z:\\missing',
      dataDir: 'Z:\\missing',
      loginStatusPath: 'Z:\\missing\\login.json',
      playwrightBrowsersDir: 'Z:\\missing'
    },
    bridgePath: 'Z:\\missing\\bridge.py'
  });
  const status = await engine.checkStatus();
  assert.equal(status.ready, false);
  assert.equal(status.state, 'missing_dependency');
});

test('Piper exposes real offline voices and an auto-selecting persistent runtime', () => {
  const capabilities = voiceEngineRegistry.get('piper').getCapabilities();
  assert.equal(capabilities.persistentRuntime, true);
  assert.deepEqual(capabilities.devices, ['auto', 'cpu', 'cuda']);
  assert.ok(capabilities.voices.some((voice) => voice.id === 'ngochuyen'));
  assert.ok(capabilities.voices.some((voice) => voice.id === 'banmai'));
  assert.ok(capabilities.voices.some((voice) => voice.id === 'vi_VN-vais1000-medium'));
  assert.ok(capabilities.voices.some((voice) => voice.gender === 'male'));
  assert.ok(capabilities.voices.some((voice) => voice.id === 'en_US-ryan-high'));
  assert.ok(capabilities.languages.includes('de'));
  assert.equal(capabilities.batchSynthesis, true);
  assert.ok(capabilities.batchConcurrency >= 1);
});

test('Piper selects an official high-quality model for supported foreign targets', () => {
  assert.equal(resolvePiperVoice('en-US', 'ngochuyen'), 'en_US-ryan-high');
  assert.equal(resolvePiperVoice('de', ''), 'de_DE-thorsten-high');
  assert.equal(resolvePiperVoice('vi', 'maiphuong'), 'maiphuong');
  assert.equal(resolvePiperVoice('ja', ''), '');
});

test('Piper rejects an unsupported target before loading the runtime so Edge can rescue it', async () => {
  const engine = new PiperEngine();
  await assert.rejects(
    () => engine.synthesize({ text: 'こんにちは', outputPath: 'D:\\work\\ja.wav', language: 'ja' }),
    (error) => error.code === 'VOICE_ENGINE_UNSUPPORTED_LANGUAGE'
  );
});

test('Piper sends the target language to its persistent normalization bridge', async () => {
  const engine = new PiperEngine();
  const writes = [];
  engine.ensureSession = async () => {};
  engine.session = {
    stdin: {
      write(line) {
        writes.push(JSON.parse(line));
        const request = writes.at(-1);
        const pending = engine.pending.get(request.id);
        engine.pending.delete(request.id);
        clearTimeout(pending.timer);
        pending.resolve({ outputPath: request.outputPath, usedDevice: 'cpu', voice: request.voice });
      }
    }
  };
  await engine.synthesize({
    text: 'iPhone 15', outputPath: path.join(os.tmpdir(), 'piper-normalize-vi.wav'),
    language: 'vi', voice: 'ngochuyen', device: 'cpu'
  });
  assert.equal(writes[0].language, 'vi');
});

test('Piper large batches warm once and distribute remaining cues across a worker pool', async () => {
  const calls = [];
  const worker = { synthesize: async ({ text }) => { calls.push(`worker:${text}`); return { text }; }, cancel: async () => true };
  const engine = new PiperEngine({
    poolThreshold: 2,
    cpuCount: () => 8,
    environment: {},
    workerFactory: () => worker
  });
  engine.synthesize = async ({ text }) => { calls.push(`primary:${text}`); return { text }; };
  const results = await engine.synthesizeBatch({ items: [
    { key: 0, text: 'một', device: 'cpu' },
    { key: 1, text: 'hai', device: 'cpu' },
    { key: 2, text: 'ba', device: 'cpu' }
  ] });
  assert.deepEqual(results.map((item) => item.ok), [true, true, true]);
  assert.equal(calls[0], 'primary:một');
  assert.ok(calls.some((value) => value.startsWith('worker:')));
});

test('Piper batch contract preserves order and isolates failed cues', async () => {
  const engine = new PiperEngine();
  engine.synthesize = async ({ text }) => {
    if (text === 'lỗi') throw new Error('failed cue');
    return { text };
  };
  const results = await engine.synthesizeBatch({
    items: [
      { key: 'a', text: 'một' },
      { key: 'b', text: 'lỗi' },
      { key: 'c', text: 'ba' }
    ]
  });
  assert.deepEqual(results.map((item) => item.key), ['a', 'b', 'c']);
  assert.deepEqual(results.map((item) => item.ok), [true, false, true]);
});

test('Piper mirrors Viral GPU eligibility and scales workers from VRAM', () => {
  const engine = new PiperEngine({
    cpuCount: () => 24,
    environment: {},
    spawnSync: () => ({ stdout: 'NVIDIA GeForce RTX 3050, 4096\n' })
  });
  engine.cudaAvailable = true;
  engine.cudaEligible = engine.isGpuEligible();
  assert.equal(engine.cudaEligible, true);
  assert.equal(engine.resolveWorkerCount('auto'), 10);

  const oldGpu = new PiperEngine({
    environment: {},
    spawnSync: () => ({ stdout: 'NVIDIA GeForce GTX 960, 4096\n' })
  });
  assert.equal(oldGpu.isGpuEligible(), false);
});
