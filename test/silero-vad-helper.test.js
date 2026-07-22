const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const vad = require('../lib/silero-vad-helper');
const whisper = require('../lib/whisper-onnx-helper');

test('pads, merges, and clips nearby speech regions', () => {
  const regions = vad.mergeSpeechRegions([
    { startSample: 1000, endSample: 3000 },
    { startSample: 5000, endSample: 7000 },
    { startSample: 15000, endSample: 17000 }
  ], 18000, {
    speechPadMs: 100,
    mergeGapMs: 50,
    maxSegmentSeconds: Number.POSITIVE_INFINITY
  });

  assert.deepEqual(regions, [
    { startSample: 0, endSample: 8600 },
    { startSample: 13400, endSample: 18000 }
  ]);
});

test('splits an unusually long continuous region only when a maximum is configured', () => {
  const regions = vad.mergeSpeechRegions([
    { startSample: 0, endSample: 48000 }
  ], 48000, {
    speechPadMs: 0,
    mergeGapMs: 0,
    maxSegmentSeconds: 1
  });

  assert.deepEqual(regions, [
    { startSample: 0, endSample: 16000 },
    { startSample: 16000, endSample: 32000 },
    { startSample: 32000, endSample: 48000 }
  ]);
});

test('returns no Whisper chunks when VAD confirms that audio contains no speech', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-vad-empty-'));
  const required = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    path.join('onnx', 'encoder_model_quantized.onnx'),
    path.join('onnx', 'decoder_model_merged_quantized.onnx')
  ];
  for (const file of required) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }

  const original = vad.detectSpeechRegions;
  vad.detectSpeechRegions = async () => ({
    durationSeconds: 12,
    speechSeconds: 0,
    regions: []
  });
  try {
    const stages = [];
    const result = await whisper.transcribeAudio({
      audioPath: path.join(directory, 'audio.wav'),
      modelPath: directory,
      variant: 'q8',
      onStage: (event) => stages.push(event.stage)
    });
    assert.deepEqual(result.chunks, []);
    assert.deepEqual(result.vad, {
      enabled: true,
      durationSeconds: 12,
      speechSeconds: 0,
      regionCount: 0
    });
    assert.deepEqual(stages, ['vad_analyzing', 'vad_complete']);
  } finally {
    vad.detectSpeechRegions = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('packaging includes the Silero ONNX model as an external resource', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const toolResource = packageJson.build.extraResources.find((entry) => entry.from === 'tools/');
  assert.ok(toolResource.filter.includes('silero-vad/silero_vad.onnx'));
});
