'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  engineUsesNativeVoiceSpeed,
  resolveVoiceSpeed,
  voiceSpeedToEdgeRate,
  voiceSpeedToPiperLengthScale
} = require('../lib/voice-speed-policy');

test('unified voice speed is capped at the Viral-safe native maximum', () => {
  assert.equal(resolveVoiceSpeed('1.5', { maxSpeed: 1.15 }), 1.15);
  assert.equal(resolveVoiceSpeed('0.85', { maxSpeed: 1.15 }), 0.85);
  assert.equal(resolveVoiceSpeed('', { legacyEdgeRate: '+10%', maxSpeed: 1.15 }), 1.1);
});

test('unified voice speed maps to native Edge and Piper controls', () => {
  assert.equal(voiceSpeedToEdgeRate(1.15), '+15%');
  assert.equal(voiceSpeedToEdgeRate(0.9), '-10%');
  assert.equal(voiceSpeedToPiperLengthScale(1), 0.8);
  assert.equal(voiceSpeedToPiperLengthScale(1.15), 0.6957);
  assert.equal(voiceSpeedToPiperLengthScale(2), 0.68);
});

test('CapCut and OmniVoice use post synthesis speed while Edge and Piper are native', () => {
  assert.equal(engineUsesNativeVoiceSpeed('edge-tts'), true);
  assert.equal(engineUsesNativeVoiceSpeed('piper'), true);
  assert.equal(engineUsesNativeVoiceSpeed('capcut-tts'), false);
  assert.equal(engineUsesNativeVoiceSpeed('current-omnivoice'), false);
});
