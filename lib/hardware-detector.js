const childProcess = require('node:child_process');

function parseNvidiaSmiOutput(output) {
  const firstLine = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;

  const parts = firstLine.split(',').map((part) => part.trim());
  const memoryMb = Number.parseInt(parts[2], 10);
  return {
    available: true,
    name: parts[0] || 'NVIDIA GPU',
    driverVersion: parts[1] || null,
    memoryMb: Number.isFinite(memoryMb) ? memoryMb : null
  };
}

function detectNvidiaGpu(options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const platform = options.platform || process.platform;

  if (platform !== 'win32') {
    return {
      available: false,
      reason: 'unsupported_platform',
      name: null,
      driverVersion: null,
      memoryMb: null
    };
  }

  try {
    const output = execFileSync('nvidia-smi', [
      '--query-gpu=name,driver_version,memory.total',
      '--format=csv,noheader,nounits'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parseNvidiaSmiOutput(output) || {
      available: false,
      reason: 'empty_nvidia_smi_output',
      name: null,
      driverVersion: null,
      memoryMb: null
    };
  } catch (error) {
    return {
      available: false,
      reason: error.code === 'ENOENT' ? 'nvidia_smi_missing' : 'nvidia_smi_failed',
      name: null,
      driverVersion: null,
      memoryMb: null
    };
  }
}

function detectHardware(options = {}) {
  return {
    platform: options.platform || process.platform,
    nvidia: detectNvidiaGpu(options)
  };
}

module.exports = {
  detectHardware,
  detectNvidiaGpu,
  parseNvidiaSmiOutput
};
