const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  chunksToSrt,
  formatSrtTime,
  normalizeLanguage,
  transcribeAudio
} = require('../lib/whisper-onnx-helper');
const { getWhisperOnnxConfig } = require('../lib/model-downloader');

test('production runtime no longer references the legacy Whisper CLI', () => {
  const root = path.join(__dirname, '..');
  const files = [
    'package.json',
    'lib/whisper-helper.js',
    'lib/model-downloader.js',
    'lib/shared-state.js',
    'controllers/systemController.js'
  ];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

  assert.doesNotMatch(source, /whisper\.cpp|whisper-cli|WHISPER_ENGINE|ensureWhisperModelExist/i);
});

test('defines separate Q8 and FP32 model files', () => {
  const q8 = getWhisperOnnxConfig('q8');
  const fp32 = getWhisperOnnxConfig('fp32');

  assert.equal(q8.folder, 'onnx-small-timestamped');
  assert.equal(q8.dtype, 'q8');
  assert.ok(q8.files.some((file) => file.name === 'onnx/encoder_model_quantized.onnx'));
  assert.ok(q8.files.some((file) => file.name === 'onnx/decoder_model_merged_quantized.onnx'));
  assert.equal(fp32.folder, 'onnx-small-timestamped-fp32');
  assert.equal(fp32.dtype, 'fp32');
  assert.ok(fp32.files.some((file) => file.name === 'onnx/encoder_model.onnx'));
  assert.ok(fp32.files.some((file) => file.name === 'onnx/decoder_model_merged.onnx'));
  assert.ok(fp32.files.reduce((sum, file) => sum + file.size, 0) > 900 * 1024 * 1024);
});

test('rejects unsupported ONNX variants before starting a worker', async () => {
  await assert.rejects(
    transcribeAudio({ variant: 'invalid', modelPath: '.', audioPath: 'audio.wav' }),
    /không hợp lệ/i
  );
});

test('maps application language identifiers to Whisper language names', () => {
  assert.equal(normalizeLanguage('ch'), 'chinese');
  assert.equal(normalizeLanguage('vi'), 'vietnamese');
  assert.equal(normalizeLanguage('en'), 'english');
  assert.equal(normalizeLanguage('japan'), 'japanese');
  assert.equal(normalizeLanguage('korean'), 'korean');
  assert.equal(normalizeLanguage(), 'vietnamese');
});

test('formats timestamped Whisper chunks as non-overlapping SRT cues', () => {
  const srt = chunksToSrt([
    { timestamp: [0, 1.48], text: ' Câu đầu ' },
    { timestamp: [1.48, 3.44], text: 'Câu sau' }
  ], 3.44);

  assert.equal(srt, [
    '1',
    '00:00:00,000 --> 00:00:01,480',
    'Câu đầu',
    '',
    '2',
    '00:00:01,480 --> 00:00:03,440',
    'Câu sau',
    ''
  ].join('\n'));
});

test('fills a missing chunk end without passing the next cue start', () => {
  const srt = chunksToSrt([
    { timestamp: [2, null], text: 'Một câu khá dài' },
    { timestamp: [3, 4], text: 'Tiếp theo' }
  ]);
  assert.match(srt, /00:00:02,000 --> 00:00:03,000/);
  assert.equal(formatSrtTime(3661.005), '01:01:01,005');
});
