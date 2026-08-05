'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getWhisperDeviceCapabilities,
  resolveWhisperDevice
} = require('../lib/whisper-device');

test('detects bundled DirectML and resolves auto safely', () => {
  const capabilities = getWhisperDeviceCapabilities({
    listSupportedBackends: () => [{ name: 'cpu' }, { name: 'dml' }]
  });
  assert.deepEqual(capabilities.devices, ['cpu', 'dml']);
  assert.equal(resolveWhisperDevice('auto', capabilities), 'dml');
  assert.equal(resolveWhisperDevice('dml', capabilities), 'dml');
});

test('falls back to CPU when DirectML is unavailable or probing fails', () => {
  const cpuOnly = getWhisperDeviceCapabilities({ listSupportedBackends: () => [{ name: 'cpu' }] });
  assert.equal(resolveWhisperDevice('dml', cpuOnly), 'cpu');
  const failed = getWhisperDeviceCapabilities({ listSupportedBackends: () => { throw new Error('probe'); } });
  assert.equal(failed.dml, false);
  assert.equal(resolveWhisperDevice('auto', failed), 'cpu');
});
