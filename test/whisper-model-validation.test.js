'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
