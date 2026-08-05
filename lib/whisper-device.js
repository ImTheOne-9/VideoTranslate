'use strict';

function getWhisperDeviceCapabilities(onnxRuntime = require('onnxruntime-node')) {
  try {
    const backends = typeof onnxRuntime.listSupportedBackends === 'function'
      ? onnxRuntime.listSupportedBackends()
      : [];
    const names = (Array.isArray(backends) ? backends : [])
      .map((backend) => String(backend?.name || '').toLowerCase())
      .filter(Boolean);
    const devices = ['cpu'];
    if (names.includes('dml')) devices.push('dml');
    return { devices, dml: names.includes('dml'), error: null };
  } catch (error) {
    return { devices: ['cpu'], dml: false, error: error.message };
  }
}

function resolveWhisperDevice(requestedDevice, capabilities = getWhisperDeviceCapabilities()) {
  const requested = String(requestedDevice || 'cpu').trim().toLowerCase();
  if ((requested === 'auto' || requested === 'dml') && capabilities.dml) return 'dml';
  return 'cpu';
}

module.exports = {
  getWhisperDeviceCapabilities,
  resolveWhisperDevice
};
