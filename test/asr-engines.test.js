const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AsrEngineRegistry,
  WhisperOnnxAsrEngine,
  createDefaultAsrEngineRegistry
} = require('../lib/asr-engines/index');

test('default ASR registry includes Faster Whisper and ONNX fallback', () => {
  const ids = createDefaultAsrEngineRegistry().list().map((engine) => engine.id);
  assert.deepEqual(ids, ['faster-whisper', 'whisper-onnx']);
});

test('ASR registry resolves adapters and rejects unknown engines', () => {
  const registry = new AsrEngineRegistry();
  const engine = new WhisperOnnxAsrEngine({
    helper: {
      transcribeAudio: async () => ({}),
      loadAudioRegions: () => [],
      cancelWhisperWorker: () => false
    }
  });
  registry.register(engine);
  assert.equal(registry.resolve('whisper-onnx'), engine);
  assert.throws(() => registry.resolve('missing'), /not supported/i);
});

test('Whisper ONNX adapter retranscribes only the requested range with word timestamps', async () => {
  let received;
  const engine = new WhisperOnnxAsrEngine({
    helper: {
      loadAudioRegions(audioPath, regions) {
        assert.equal(audioPath, 'audio.wav');
        assert.deepEqual(regions, [{ start: 1.5, end: 3.25 }]);
        return [{ start: 1.5, end: 3.25, samples: new Float32Array([0.1]) }];
      },
      async transcribeAudio(options) {
        received = options;
        return {
          text: ' xin chào',
          chunks: [
            { text: ' xin', timestamp: [1.5, 2] },
            { text: ' chào', timestamp: [2, 2.5] }
          ]
        };
      },
      cancelWhisperWorker: () => true
    }
  });

  const result = await engine.transcribeSegment({
    audioPath: 'audio.wav',
    modelPath: 'model',
    variant: 'medium-q8',
    language: 'auto',
    startMs: 1500,
    endMs: 3250,
    owner: 'task:segment'
  });

  assert.equal(received.useVad, false);
  assert.equal(received.timestampLevel, 'word');
  assert.equal(received.owner, 'task:segment');
  assert.equal(result.text, 'xin chào');
  assert.deepEqual(result.words, [
    { text: 'xin', startMs: 1500, endMs: 2000 },
    { text: 'chào', startMs: 2000, endMs: 2500 }
  ]);
});

test('Whisper ONNX adapter delegates owner-scoped cancellation', async () => {
  let cancelledOwner;
  const engine = new WhisperOnnxAsrEngine({
    helper: {
      cancelWhisperWorker(owner) {
        cancelledOwner = owner;
        return true;
      }
    }
  });
  assert.equal(await engine.cancel('asr:one'), true);
  assert.equal(cancelledOwner, 'asr:one');
});
