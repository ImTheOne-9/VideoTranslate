'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const shared = require('../lib/shared-state');
const { resolveVoiceReference } = require('../lib/voice-reference-helper');

test('missing per-segment voice reports a useful error before path processing', async () => {
  const originalResolveAssetPath = shared.resolveAssetPath;
  shared.resolveAssetPath = () => null;
  try {
    await assert.rejects(
      () => resolveVoiceReference({
        voiceFile: 'voice-that-was-deleted.wav',
        workDir: 'C:\\work'
      }),
      (error) => error.code === 'VOICE_REFERENCE_NOT_FOUND'
        && error.message.includes('voice-that-was-deleted.wav')
    );
  } finally {
    shared.resolveAssetPath = originalResolveAssetPath;
  }
});
