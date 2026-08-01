const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_OMNIVOICE_SEED,
  resolveOmnivoiceSeed
} = require('../lib/voice-defaults');

test('OmniVoice uses one deterministic default seed', () => {
  assert.equal(DEFAULT_OMNIVOICE_SEED, 42);
  assert.equal(resolveOmnivoiceSeed(), '42');
  assert.equal(resolveOmnivoiceSeed(''), '42');
  assert.equal(resolveOmnivoiceSeed('invalid'), '42');
});

test('OmniVoice preserves an explicit valid seed including zero', () => {
  assert.equal(resolveOmnivoiceSeed('20260731'), '20260731');
  assert.equal(resolveOmnivoiceSeed(0), '0');
});
