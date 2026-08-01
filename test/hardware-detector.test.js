const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectNvidiaGpu,
  parseNvidiaSmiOutput
} = require('../lib/hardware-detector');

test('parses NVIDIA name, driver, and VRAM from nvidia-smi', () => {
  assert.deepEqual(
    parseNvidiaSmiOutput('NVIDIA GeForce RTX Test, 555.99, 8192\n'),
    {
      available: true,
      name: 'NVIDIA GeForce RTX Test',
      driverVersion: '555.99',
      memoryMb: 8192
    }
  );
});

test('uses nvidia-smi with a bounded timeout on Windows', () => {
  let received = null;
  const result = detectNvidiaGpu({
    platform: 'win32',
    execFileSync: (file, args, options) => {
      received = { file, args, options };
      return 'NVIDIA Test GPU, 600.01, 4096';
    }
  });

  assert.equal(result.available, true);
  assert.equal(received.file, 'nvidia-smi');
  assert.match(received.args.join(' '), /memory\.total/);
  assert.equal(received.options.timeout, 5000);
  assert.equal(received.options.windowsHide, true);
});

test('reports unavailable when nvidia-smi fails', () => {
  const result = detectNvidiaGpu({
    platform: 'win32',
    execFileSync: () => {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'nvidia_smi_missing');
});

test('does not probe NVIDIA CUDA on unsupported platforms', () => {
  let called = false;
  const result = detectNvidiaGpu({
    platform: 'linux',
    execFileSync: () => {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'unsupported_platform');
});
