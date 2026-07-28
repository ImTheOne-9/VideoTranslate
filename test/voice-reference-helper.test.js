'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const shared = require('../lib/shared-state');
const {
  createLegacyVoiceAudioSignature,
  createVoiceAudioSignature,
  resolveVoiceReference
} = require('../lib/voice-reference-helper');

test('voice audio signatures ignore converted WAV locations when the source voice is identical', () => {
  const referenceIdentity = {
    path: 'C:\\VideoStudioData\\voices\\hhhh.wav',
    size: 204800,
    mtimeMs: 1785210000000
  };
  const common = {
    text: '  Xin chào\u200B ',
    voiceFile: 'hhhh.wav',
    referenceIdentity,
    referenceText: 'Giọng mẫu',
    engineId: 'current-omnivoice',
    steps: '40',
    language: 'vi',
    seed: '',
    positionTemperature: 1
  };

  const preview = createVoiceAudioSignature({
    ...common,
    referenceAudioPath: 'D:\\task\\segments\\references\\voice.wav'
  });
  const render = createVoiceAudioSignature({
    ...common,
    referenceAudioPath: 'D:\\task\\work\\ref_voice.wav'
  });

  assert.equal(preview, render);
});

test('voice audio signatures change when synthesis inputs change', () => {
  const common = {
    text: 'Câu thử nghiệm',
    voiceFile: 'hhhh.wav',
    referenceIdentity: { path: 'C:\\voices\\hhhh.wav', size: 100, mtimeMs: 200 },
    referenceText: 'Giọng mẫu',
    engineId: 'current-omnivoice',
    steps: '40',
    language: 'vi',
    positionTemperature: 1
  };
  const original = createVoiceAudioSignature(common);

  assert.notEqual(original, createVoiceAudioSignature({ ...common, text: 'Câu khác' }));
  assert.notEqual(original, createVoiceAudioSignature({ ...common, steps: '16' }));
  assert.notEqual(original, createVoiceAudioSignature({ ...common, positionTemperature: 1.5 }));
  assert.notEqual(original, createVoiceAudioSignature({
    ...common,
    referenceIdentity: { ...common.referenceIdentity, mtimeMs: 201 }
  }));
});

test('legacy voice signatures remain available for one-time preview checkpoint migration', () => {
  const options = {
    text: 'Câu cũ',
    voiceFile: 'hhhh.wav',
    referenceAudioPath: 'C:\\task\\segments\\references\\legacy.wav',
    referenceText: 'Giọng mẫu',
    engineId: 'current-omnivoice',
    steps: '40',
    language: 'vi'
  };
  assert.equal(
    createLegacyVoiceAudioSignature(options),
    createLegacyVoiceAudioSignature(options)
  );
  assert.notEqual(
    createLegacyVoiceAudioSignature(options),
    createVoiceAudioSignature({
      ...options,
      referenceIdentity: { path: 'C:\\voices\\hhhh.wav', size: 100, mtimeMs: 200 }
    })
  );
});

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
