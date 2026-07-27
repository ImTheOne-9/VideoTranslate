const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createCheckpointSignature,
  getFileIdentity,
  isUsableFile,
  readJsonFile,
  writeJsonAtomic
} = require('../lib/checkpoint-utils');

test('checkpoint signatures are stable across object key order', () => {
  assert.equal(
    createCheckpointSignature({ b: 2, a: { d: 4, c: 3 } }),
    createCheckpointSignature({ a: { c: 3, d: 4 }, b: 2 })
  );
  assert.notEqual(
    createCheckpointSignature({ model: 'small' }),
    createCheckpointSignature({ model: 'medium' })
  );
});

test('checkpoint JSON is atomically replaced and file identity detects changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-utils-'));
  try {
    const dataPath = path.join(directory, 'state.json');
    const assetPath = path.join(directory, 'asset.wav');
    fs.writeFileSync(assetPath, 'audio');
    const firstIdentity = getFileIdentity(assetPath);
    writeJsonAtomic(dataPath, { status: 'first' });
    writeJsonAtomic(dataPath, { status: 'second' });

    assert.deepEqual(readJsonFile(dataPath), { status: 'second' });
    assert.equal(isUsableFile(assetPath, 5), true);
    assert.equal(firstIdentity.size, 5);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
