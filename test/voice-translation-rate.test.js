const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MEASURED_VOICE_WPS,
  measuredVoiceWordsPerSecond
} = require('../lib/voice-translation-rate');

test('translation timing uses ViralCrawl measured CapCut voice rates', () => {
  assert.equal(measuredVoiceWordsPerSecond('BV074_streaming'), 4.8);
  assert.equal(measuredVoiceWordsPerSecond('BV059_streaming'), 1.5);
  assert.equal(measuredVoiceWordsPerSecond('unknown-voice'), null);
  assert.ok(Object.keys(MEASURED_VOICE_WPS).length >= 50);
});
