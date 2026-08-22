'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  chooseAdaptiveThreshold,
  estimateFramePitch
} = require('../lib/voice-speaker-classifier');

function sine(frequency, sampleRate = 16000, durationMs = 50) {
  const values = new Int16Array(Math.round(sampleRate * durationMs / 1000));
  for (let index = 0; index < values.length; index++) {
    values[index] = Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 12000);
  }
  return values;
}

test('pitch estimator separates typical low and high speaking voices', () => {
  assert.ok(Math.abs(estimateFramePitch(sine(130), 16000) - 130) < 5);
  assert.ok(Math.abs(estimateFramePitch(sine(220), 16000) - 220) < 5);
});

test('adaptive gender threshold follows the largest credible pitch gap', () => {
  const threshold = chooseAdaptiveThreshold([120, 128, 135, 205, 218, 225]);
  assert.ok(threshold > 160 && threshold < 190);
});
