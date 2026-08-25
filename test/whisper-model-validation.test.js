'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FASTER_WHISPER_CONFIG,
  getFasterWhisperReadiness,
  getWhisperOnnxConfig,
  validateWhisperOnnxModel
} = require('../lib/model-downloader');

test('classifies a missing Whisper model separately from a corrupt one', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-model-validation-'));
  try {
    const missing = validateWhisperOnnxModel(directory, 'q8');
    assert.equal(missing.ready, false);
    assert.equal(missing.state, 'missing');
    assert.ok(missing.missingFiles.length > 0);

    const config = getWhisperOnnxConfig('q8');
    for (const file of config.files) {
      const filePath = path.join(directory, ...file.name.split('/'));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.alloc(1));
    }
    const corrupt = validateWhisperOnnxModel(directory, 'q8');
    assert.equal(corrupt.ready, false);
    assert.equal(corrupt.state, 'corrupt');
    assert.equal(corrupt.missingFiles.length, 0);
    assert.equal(corrupt.invalidFiles.length, config.files.length);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('classifies the application-managed Faster-Whisper model as missing or corrupt', () => {
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faster-whisper-model-validation-'));
  try {
    const missing = getFasterWhisperReadiness(modelsDir);
    assert.equal(missing.ready, false);
    assert.equal(missing.state, 'missing');
    assert.equal(missing.config.model, 'large-v3-turbo');

    const target = path.join(modelsDir, 'whisper', FASTER_WHISPER_CONFIG.folder, FASTER_WHISPER_CONFIG.localFolder);
    fs.mkdirSync(target, { recursive: true });
    for (const file of FASTER_WHISPER_CONFIG.files) {
      fs.writeFileSync(path.join(target, file.name), Buffer.alloc(1));
    }
    const corrupt = getFasterWhisperReadiness(modelsDir);
    assert.equal(corrupt.ready, false);
    assert.equal(corrupt.state, 'corrupt');
    assert.equal(corrupt.invalidFiles.length, FASTER_WHISPER_CONFIG.files.length);
  } finally {
    fs.rmSync(modelsDir, { recursive: true, force: true });
  }
});
