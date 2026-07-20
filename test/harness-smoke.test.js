const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { findTestFiles } = require('./run-tests');

test('the harness discovers this smoke test', () => {
  const testFiles = findTestFiles();

  assert.ok(testFiles.includes(path.join(__dirname, 'harness-smoke.test.js')));
});
