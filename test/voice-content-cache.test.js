'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createVoiceCacheKey,
  restoreVoiceCache,
  saveVoiceCache
} = require('../lib/voice-content-cache');

test('content cache is opt-in and restores identical voice content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cache-'));
  const source = path.join(root, 'source.wav');
  const output = path.join(root, 'output.wav');
  fs.writeFileSync(source, Buffer.alloc(80));
  const key = createVoiceCacheKey({ text: 'xin chào', engineId: 'piper', voice: 'ngochuyen', language: 'vi' });
  assert.equal(saveVoiceCache(key, source, { root, environment: {} }), false);
  assert.equal(saveVoiceCache(key, source, { root, environment: { VC_RESUME: '1' } }), true);
  assert.equal(restoreVoiceCache(key, output, { root, environment: { VC_RESUME: '1' } }), true);
  assert.equal(fs.statSync(output).size, 80);
});
