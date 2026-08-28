'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VoiceEngine, VoiceEngineError } = require('../lib/voice-engines/voice-engine');
const { VoiceEngineRegistry } = require('../lib/voice-engines/voice-engine-registry');
const {
  CurrentOmniVoiceEngine
} = require('../lib/voice-engines/current-omnivoice-engine');

function createReadyEngine(overrides = {}) {
  return new CurrentOmniVoiceEngine({
    cliPath: 'C:\\tools\\omnivoice-cli.exe',
    modelPath: 'C:\\models\\omnivoice.gguf',
    existsSync: () => true,
    statSync: () => ({ size: 123456 }),
    runCli: async () => ({}),
    ...overrides
  });
}

test('VoiceEngine exposes the stable Phase 3 contract', async () => {
  const engine = new VoiceEngine({ id: 'test', name: 'Test Engine' });
  assert.equal(typeof engine.checkStatus, 'function');
  assert.equal(typeof engine.loadModel, 'function');
  assert.equal(typeof engine.synthesize, 'function');
  assert.equal(typeof engine.cloneVoice, 'function');
  assert.equal(typeof engine.cancel, 'function');
  assert.equal(typeof engine.getCapabilities, 'function');
  await assert.rejects(() => engine.synthesize(), VoiceEngineError);
});

test('registry resolves engines and rejects unsupported ids explicitly', () => {
  const registry = new VoiceEngineRegistry();
  const engine = createReadyEngine();
  registry.register(engine);
  assert.equal(registry.get('current-omnivoice'), engine);
  assert.throws(
    () => registry.get('missing'),
    (error) => error.code === 'VOICE_ENGINE_NOT_FOUND'
  );
});

test('current OmniVoice adapter reports capabilities and installation status', async () => {
  const engine = createReadyEngine();
  const description = await engine.describe();
  assert.equal(description.status.ready, true);
  assert.equal(description.capabilities.cloneVoice, true);
  assert.ok(description.capabilities.languages.length > 60);
  assert.ok(['vi', 'en', 'zh', 'ja', 'fr', 'de'].every(
    language => description.capabilities.languages.includes(language)
  ));
  assert.ok(['ne', 'su', 'ar'].every(
    language => !description.capabilities.languages.includes(language)
  ));
  assert.deepEqual(description.capabilities.devices, ['cpu', 'vulkan:0', 'cuda:0']);
  assert.equal(description.capabilities.modelSizeBytes, 123456);
  assert.equal(description.capabilities.sampleRate, 24000);
});

test('adapter maps generic synthesis options to current OmniVoice CLI arguments', async () => {
  let received = null;
  const engine = createReadyEngine({
    runCli: async (args, options, device, behavior) => {
      received = { args, options, device, behavior };
      return {};
    }
  });
  const result = await engine.cloneVoice({
    text: ' Xin chao\u200B ',
    outputPath: 'D:\\work\\voice.wav',
    language: 'vi',
    device: 'vulkan:0',
    steps: 20,
    seed: 42,
    positionTemperature: 1,
    referenceAudioPath: 'D:\\work\\ref.wav',
    referenceText: 'Giong mau',
    allowCpuFallback: false
  });

  assert.equal(received.device, 'vulkan:0');
  assert.equal(received.behavior.allowCpuFallback, false);
  assert.equal(received.args[received.args.indexOf('--text') + 1], 'Xin chao');
  assert.equal(received.args[received.args.indexOf('--language') + 1], 'vi');
  assert.equal(received.args[received.args.indexOf('--ref-audio') + 1], 'D:\\work\\ref.wav');
  assert.equal(result.engineId, 'current-omnivoice');
  assert.equal(result.usedDevice, 'vulkan:0');
  assert.equal(result.fallback, false);
});

test('adapter prefers the persistent server and reports prompt-cache capability', async () => {
  let runCliCalled = false;
  let serverOptions = null;
  const engine = createReadyEngine({
    runCli: async () => {
      runCliCalled = true;
    },
    serverManager: {
      isAvailable: (device) => device === 'vulkan:0',
      synthesize: async (options) => {
        serverOptions = options;
        return {
          device: 'vulkan:0',
          fallback: false,
          persistentRuntime: true,
          referencePromptCache: true
        };
      }
    }
  });

  const result = await engine.cloneVoice({
    text: 'Cau thu nghiem',
    outputPath: 'D:\\work\\server.wav',
    language: 'vi',
    device: 'vulkan:0',
    referenceAudioPath: 'D:\\work\\ref.wav',
    referenceText: 'Giong mau'
  });

  assert.equal(runCliCalled, false);
  assert.equal(serverOptions.modelPath, 'C:\\models\\omnivoice.gguf');
  assert.equal(result.persistentRuntime, true);
  assert.equal(result.referencePromptCache, true);
  assert.deepEqual(engine.getCapabilities().persistentDevices, ['vulkan:0']);
});

test('CPU fallback is passed to the runner only after explicit opt-in', async () => {
  const calls = [];
  const engine = createReadyEngine({
    runCli: async (args, options, device, behavior) => {
      calls.push({ device, allowCpuFallback: behavior.allowCpuFallback });
      behavior.onFallback?.({ from: device, to: 'cpu', error: 'gpu failed' });
      return {};
    }
  });

  const result = await engine.synthesize({
    text: 'Test',
    outputPath: 'D:\\work\\voice.wav',
    device: 'vulkan:0',
    allowCpuFallback: true
  });
  assert.deepEqual(calls, [{ device: 'vulkan:0', allowCpuFallback: true }]);
  assert.equal(result.usedDevice, 'cpu');
  assert.equal(result.fallback, true);
});

test('preview synthesis can explicitly bypass the active render guard', async () => {
  let receivedBehavior = null;
  const engine = createReadyEngine({
    runCli: async (args, options, device, behavior) => {
      receivedBehavior = behavior;
      return {};
    }
  });

  await engine.synthesize({
    text: 'Nghe thu mot cau',
    outputPath: 'D:\\work\\preview.wav',
    device: 'vulkan:0',
    skipRenderCheck: true
  });

  assert.equal(receivedBehavior.skipRenderCheck, true);
});

test('cloneVoice rejects incomplete reference input before invoking the CLI', async () => {
  let called = false;
  const engine = createReadyEngine({
    runCli: async () => {
      called = true;
    }
  });
  await assert.rejects(
    () => engine.cloneVoice({
      text: 'Test',
      outputPath: 'voice.wav',
      referenceAudioPath: 'ref.wav'
    }),
    (error) => error.code === 'VOICE_ENGINE_REFERENCE_REQUIRED'
  );
  assert.equal(called, false);
});

test('engine status identifies missing CLI and model independently', async () => {
  const engine = new CurrentOmniVoiceEngine({
    cliPath: 'cli.exe',
    modelPath: 'model.gguf',
    existsSync: (target) => target === 'cli.exe'
  });
  const status = await engine.checkStatus();
  assert.equal(status.ready, false);
  assert.equal(status.cliExists, true);
  assert.equal(status.modelExists, false);
  await assert.rejects(
    () => engine.loadModel(),
    (error) => error.code === 'VOICE_ENGINE_NOT_READY'
  );
});
