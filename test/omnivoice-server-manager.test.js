'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  OmniVoiceServerManager,
  normalizeServerDevice
} = require('../lib/voice-engines/omnivoice-server-manager');

function createFakeProcess() {
  const processHandle = new EventEmitter();
  processHandle.stdout = new PassThrough();
  processHandle.stderr = new PassThrough();
  return processHandle;
}

test('normalizes only supported persistent server device names', () => {
  assert.equal(normalizeServerDevice('CUDA:2'), 'cuda:2');
  assert.equal(normalizeServerDevice('vulkan:1'), 'vulkan:1');
  assert.equal(normalizeServerDevice('metal'), 'cpu');
});

test('reuses one persistent OmniVoice server for multiple speech requests', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnivoice-server-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spawnCalls = [];
  const requestCalls = [];
  const killed = [];
  const registered = [];
  const manager = new OmniVoiceServerManager({
    serverPaths: {
      cpu: path.join(directory, 'server-cpu.exe'),
      vulkan: path.join(directory, 'server-vulkan.exe')
    },
    existsSync: () => true,
    getFreePort: async () => 43123,
    spawn: (executable, args, options) => {
      spawnCalls.push({ executable, args, options });
      return createFakeProcess();
    },
    registerProcess: (processHandle) => registered.push(processHandle),
    killProcess: (processHandle) => killed.push(processHandle),
    request: async (options) => {
      requestCalls.push(options);
      if (options.pathname === '/health') return { statusCode: 200, data: Buffer.alloc(0) };
      options.onRequest?.({ destroy() {} });
      return { statusCode: 200, data: Buffer.from('RIFF-test-wave') };
    }
  });

  const common = {
    modelPath: path.join(directory, 'model.gguf'),
    device: 'vulkan:0',
    language: 'vi',
    referenceAudioPath: path.join(directory, 'reference.wav'),
    referenceText: 'Giong mau'
  };
  const firstPath = path.join(directory, 'first.wav');
  const secondPath = path.join(directory, 'second.wav');
  const first = await manager.synthesize({ ...common, text: 'Cau mot', outputPath: firstPath });
  const second = await manager.synthesize({ ...common, text: 'Cau hai', outputPath: secondPath });

  assert.equal(spawnCalls.length, 1);
  assert.equal(registered.length, 1);
  assert.equal(requestCalls.filter((call) => call.pathname === '/health').length, 1);
  assert.equal(requestCalls.filter((call) => call.pathname === '/v1/audio/speech').length, 2);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), 'RIFF-test-wave');
  assert.equal(fs.readFileSync(secondPath, 'utf8'), 'RIFF-test-wave');
  assert.equal(first.persistentRuntime, true);
  assert.equal(second.referencePromptCache, true);

  await manager.stop();
  assert.equal(killed.length, 1);
});

test('restarts the persistent server when the requested backend changes', async () => {
  const processes = [];
  const killed = [];
  const manager = new OmniVoiceServerManager({
    serverPaths: { cpu: 'cpu.exe', vulkan: 'vulkan.exe' },
    existsSync: () => true,
    getFreePort: async () => 43124 + processes.length,
    spawn: () => {
      const processHandle = createFakeProcess();
      processes.push(processHandle);
      return processHandle;
    },
    killProcess: (processHandle) => killed.push(processHandle),
    request: async () => ({ statusCode: 200, data: Buffer.alloc(0) })
  });

  await manager.ensureSession({ modelPath: 'model.gguf', device: 'cpu' });
  await manager.ensureSession({ modelPath: 'model.gguf', device: 'vulkan:0' });
  assert.equal(processes.length, 2);
  assert.deepEqual(killed, [processes[0]]);
  await manager.stop();
});
