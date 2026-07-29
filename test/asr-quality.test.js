const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateAsrQuality,
  assessAsrCue,
  getModelConfidence
} = require('../lib/asr-quality');

test('ASR quality keeps model confidence separate from heuristic quality', () => {
  const quality = assessAsrCue({
    text: 'Một câu nhận dạng bình thường.',
    start: 1,
    end: 3,
    confidence: 0.42
  });

  assert.equal(quality.modelConfidence, 0.42);
  assert.equal(quality.qualitySource, 'model');
  assert.equal(quality.qualityScore, 42);
  assert.ok(quality.warnings.includes('asr_low_confidence'));
});

test('ASR quality flags dense, repeated, and invalid timing without inventing confidence', () => {
  const quality = assessAsrCue({
    text: 'lặp lại lặp lại lặp lại một câu rất dài bị dồn vào thời gian ngắn',
    start: 5,
    end: 5.1
  });

  assert.equal(quality.modelConfidence, null);
  assert.equal(quality.qualitySource, 'heuristic');
  assert.ok(quality.warnings.includes('asr_cue_too_short'));
  assert.ok(quality.warnings.includes('asr_dense_text'));
  assert.ok(quality.warnings.includes('asr_repeated_text'));
});

test('ASR quality reads average log probability and aggregates the weakest cue', () => {
  assert.ok(Math.abs(getModelConfidence({ avg_logprob: Math.log(0.8) }) - 0.8) < 0.0001);
  const summary = aggregateAsrQuality([
    { modelConfidence: 0.9, qualityScore: 90, warnings: [] },
    { modelConfidence: 0.6, qualityScore: 60, warnings: ['asr_low_confidence'] },
    { modelConfidence: null, qualityScore: 75, warnings: [] }
  ]);
  assert.equal(summary.modelConfidence, 0.6);
  assert.equal(summary.qualityScore, 60);
  assert.deepEqual(summary.warnings, ['asr_low_confidence']);
});
