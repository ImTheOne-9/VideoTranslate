'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { VoiceEngineError } = require('../lib/voice-engines/voice-engine');
const { VoiceEngineRegistry } = require('../lib/voice-engines/voice-engine-registry');
const {
  EdgeTTSEngine,
  DEFAULT_VOICES,
  mapEdgeBoundaryRanges
} = require('../lib/voice-engines/edge-tts-engine');
const { voiceEngineRegistry } = require('../lib/voice-engines/index');

test('EdgeTTSEngine implements VoiceEngine contract and reports capabilities', async () => {
  const engine = new EdgeTTSEngine();
  assert.equal(engine.id, 'edge-tts');
  assert.equal(typeof engine.synthesize, 'function');
  assert.equal(typeof engine.cloneVoice, 'function');

  const capabilities = engine.getCapabilities();
  assert.equal(capabilities.cloneVoice, false);
  assert.equal(capabilities.durationControl, false);
  assert.ok(capabilities.languages.includes('vi'));
  assert.ok(!capabilities.languages.includes('vi-female'));
  assert.equal(capabilities.modelSizeBytes, 0);
  assert.ok(Array.isArray(capabilities.voices));
  assert.ok(capabilities.voices.length >= 10);
  assert.equal(typeof engine.listVoices, 'function');
  assert.ok(engine.listVoices().some(v => v.id === 'vi-VN-HoaiMyNeural'));

  const status = await engine.checkStatus();
  assert.equal(status.ready, true);
  assert.equal(status.state, 'ready');
});

test('EdgeTTSEngine is registered in default voiceEngineRegistry', () => {
  const registered = voiceEngineRegistry.get('edge-tts');
  assert.ok(registered instanceof EdgeTTSEngine);
  assert.equal(registered.id, 'edge-tts');
});

test('EdgeTTSEngine maps languages and genders to default voices correctly', () => {
  const engine = new EdgeTTSEngine();
  assert.equal(engine.resolveVoice({ language: 'vi' }), DEFAULT_VOICES['vi']);
  assert.equal(engine.resolveVoice({ language: 'vi', gender: 'male' }), DEFAULT_VOICES['vi-male']);
  assert.equal(engine.resolveVoice({ language: 'en' }), DEFAULT_VOICES['en']);
  assert.equal(engine.resolveVoice({ voice: 'vi-VN-NamMinhNeural' }), 'vi-VN-NamMinhNeural');
  assert.equal(
    engine.resolveVoice({ language: 'ja', voice: 'vi-VN-HoaiMyNeural' }),
    DEFAULT_VOICES.ja
  );
});

test('Edge word boundaries map a combined request back to every original cue', () => {
  const boundaries = [
    { Type: 'WordBoundary', Data: { Offset: 0, Duration: 3000000, text: { Text: 'Xin' } } },
    { Type: 'WordBoundary', Data: { Offset: 3200000, Duration: 3000000, text: { Text: 'chào' } } },
    { Type: 'WordBoundary', Data: { Offset: 7000000, Duration: 3000000, text: { Text: 'Việt' } } },
    { Type: 'WordBoundary', Data: { Offset: 10200000, Duration: 3000000, text: { Text: 'Nam' } } }
  ];
  assert.deepEqual(mapEdgeBoundaryRanges(['Xin chào', 'Việt Nam'], boundaries), [
    { startMs: 0, endMs: 700 },
    { startMs: 700, endMs: 1320 }
  ]);
});

test('Edge grouped batch falls back to individual cues when boundary splitting fails', async () => {
  const engine = new EdgeTTSEngine({ groupSize: 4, groupConcurrency: 1 });
  engine.synthesizeGroupedItems = async () => { throw new Error('bad metadata'); };
  engine.synthesize = async ({ text }) => ({ text });
  const results = await engine.synthesizeBatch({ items: [
    { key: 'a', text: 'Một', voice: 'vi-VN-HoaiMyNeural' },
    { key: 'b', text: 'Hai', voice: 'vi-VN-HoaiMyNeural' }
  ] });
  assert.deepEqual(results.map((item) => item.ok), [true, true]);
  assert.ok(results.every((item) => item.groupedFallback === true));
});

test('EdgeTTSEngine synthesizes audio using stream and converts to destination path', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-test-'));
  const outMp3 = path.join(tmpDir, 'test.mp3');

  let mockSynthesizeCalled = false;
  const mockStream = async ({ text, voice }) => {
    mockSynthesizeCalled = true;
    assert.equal(text, 'Xin chao Viet Nam');
    assert.equal(voice, 'vi-VN-HoaiMyNeural');
    return Buffer.from('MOCK_AUDIO_DATA');
  };

  const engine = new EdgeTTSEngine({
    synthesizeStream: mockStream
  });

  const result = await engine.synthesize({
    text: 'Xin chao Viet Nam',
    outputPath: outMp3,
    language: 'vi'
  });

  assert.equal(mockSynthesizeCalled, true);
  assert.equal(result.engineId, 'edge-tts');
  assert.equal(result.outputPath, outMp3);
  assert.ok(fs.existsSync(outMp3));
  assert.equal(fs.readFileSync(outMp3, 'utf8'), 'MOCK_AUDIO_DATA');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('EdgeTTSEngine gracefully handles cloneVoice by falling back to standard synthesis', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-clone-test-'));
  const outMp3 = path.join(tmpDir, 'clone.mp3');

  let fallbackNotified = false;
  const engine = new EdgeTTSEngine({
    synthesizeStream: async () => Buffer.from('CLONE_FALLBACK_AUDIO')
  });

  const result = await engine.cloneVoice({
    text: 'Thuyet minh kịch bản',
    outputPath: outMp3,
    language: 'vi',
    referenceAudioPath: 'dummy_ref.wav',
    onFallback: (detail) => {
      fallbackNotified = true;
      assert.equal(detail.engineId, 'edge-tts');
    }
  });

  assert.equal(fallbackNotified, true);
  assert.equal(result.fallback, true);
  assert.equal(result.engineId, 'edge-tts');
  assert.ok(fs.existsSync(outMp3));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('EdgeTTSEngine validates empty text and output paths', async () => {
  const engine = new EdgeTTSEngine();
  await assert.rejects(
    () => engine.synthesize({ text: '', outputPath: 'out.mp3' }),
    (err) => err.code === 'VOICE_ENGINE_INVALID_TEXT'
  );
  await assert.rejects(
    () => engine.synthesize({ text: 'Valid text', outputPath: '' }),
    (err) => err.code === 'VOICE_ENGINE_INVALID_OUTPUT'
  );
});

test('EdgeTTSEngine reports missing FFmpeg instead of a false ready status', async () => {
  const engine = new EdgeTTSEngine({
    ffmpegPath: 'missing-ffmpeg.exe',
    existsSync: () => false
  });
  const status = await engine.checkStatus();
  assert.equal(status.ready, false);
  assert.equal(status.state, 'missing_dependency');
  assert.equal(status.ffmpegExists, false);
  assert.match(status.error, /FFmpeg/);
});

test('EdgeTTSEngine retries transient network failures and preserves voice controls', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-retry-test-'));
  const outMp3 = path.join(tmpDir, 'retry.mp3');
  let attempts = 0;
  const engine = new EdgeTTSEngine({
    maxRetries: 2,
    synthesizeStream: async (options) => {
      attempts++;
      assert.equal(options.rate, '+25%');
      assert.equal(options.pitch, '-10Hz');
      if (attempts < 3) {
        const error = new Error('temporary network error');
        error.code = 'EDGE_TTS_NETWORK_ERROR';
        throw error;
      }
      return Buffer.from('RETRIED_AUDIO');
    }
  });
  const result = await engine.synthesize({
    text: 'Retry me',
    outputPath: outMp3,
    rate: '+25%',
    pitch: '-10Hz'
  });
  assert.equal(attempts, 3);
  assert.equal(result.rate, '+25%');
  assert.equal(result.pitch, '-10Hz');
  assert.equal(fs.readFileSync(outMp3, 'utf8'), 'RETRIED_AUDIO');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('EdgeTTSEngine converts WAV through a unique temporary file and cleans scratch files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-wav-test-'));
  const outWav = path.join(tmpDir, 'voice.wav');
  const engine = new EdgeTTSEngine({
    ffmpegPath: 'mock-ffmpeg.exe',
    existsSync: () => true,
    synthesizeStream: async () => Buffer.from('MOCK_MP3'),
    execFile: (file, args, callback) => {
      assert.equal(file, 'mock-ffmpeg.exe');
      const tempOutput = args.at(-1);
      const wav = Buffer.alloc(64);
      wav.write('RIFF', 0, 'ascii');
      fs.writeFileSync(tempOutput, wav);
      callback(null, '', '');
      return { kill() {} };
    }
  });
  await engine.synthesize({ text: 'WAV test', outputPath: outWav });
  assert.equal(fs.readFileSync(outWav).subarray(0, 4).toString('ascii'), 'RIFF');
  assert.deepEqual(fs.readdirSync(tmpDir), ['voice.wav']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('EdgeTTSEngine cancellation aborts active synthesis', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-cancel-test-'));
  const outMp3 = path.join(tmpDir, 'cancel.mp3');
  const engine = new EdgeTTSEngine({
    synthesizeStream: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.code = 'EDGE_TTS_CANCELLED';
        reject(error);
      }, { once: true });
    })
  });
  const pending = engine.synthesize({ text: 'Cancel me', outputPath: outMp3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await engine.cancel(), true);
  await assert.rejects(pending, (error) => error.code === 'EDGE_TTS_CANCELLED');
  assert.equal(fs.existsSync(outMp3), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
