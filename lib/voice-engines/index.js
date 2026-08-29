'use strict';

const shared = require('../shared-state');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');
const { VoiceEngineRegistry } = require('./voice-engine-registry');
const { CurrentOmniVoiceEngine } = require('./current-omnivoice-engine');
const { OmniVoiceServerManager } = require('./omnivoice-server-manager');
const { PythonOmniVoiceEngine } = require('./python-omnivoice-engine');
const { EdgeTTSEngine } = require('./edge-tts-engine');
const { PiperEngine } = require('./piper-engine');
const { CapCutTTSEngine } = require('./capcut-tts-engine');

const DEFAULT_VOICE_ENGINE_ID = 'piper';

function createDefaultVoiceEngineRegistry(options = {}) {
  const registry = new VoiceEngineRegistry();
  registry.register(new PythonOmniVoiceEngine({
    ...(options.pythonOmnivoiceOptions || {}),
    id: 'current-omnivoice',
    name: 'OmniVoice Clone',
    spawnImpl: options.spawnCli || shared.spawn,
    registerProcess: options.registerProcess || shared.registerChildProcess,
    killProcess: options.killProcess || shared.killProcessTree
  }));
  // Runtime GGUF cũ được giữ để quay lui khi cần chẩn đoán, nhưng không đăng ký
  // trong bản phát hành mặc định nên sẽ không xuất hiện trên giao diện.
  if (process.env.OMNIVOICE_LEGACY_VISIBLE === '1') {
    const serverManager = options.serverManager || new OmniVoiceServerManager({
      serverPaths: options.serverPaths || shared.OMNIVOICE_SERVER_PATHS,
      existsSync: options.existsSync,
      spawn: options.spawnCli || shared.spawn,
      registerProcess: options.registerProcess || shared.registerChildProcess,
      killProcess: options.killProcess || shared.killProcessTree
    });
    registry.register(new CurrentOmniVoiceEngine({
      id: 'legacy-omnivoice',
      name: 'OmniVoice GGUF (cũ)',
      cliPath: options.cliPath || shared.OMNIVOICE_CLI_PATH,
      modelPath: options.modelPath || shared.OMNIVOICE_MODEL_PATH,
      existsSync: options.existsSync,
      statSync: options.statSync,
      runCli: options.runCli || shared.runOmnivoiceCLI,
      spawnCli: options.spawnCli || shared.spawn,
      killProcess: options.killProcess || shared.killProcessTree,
      serverManager
    }));
  }
  registry.register(new PiperEngine(options.piperOptions || {}));
  registry.register(new CapCutTTSEngine({
    ...(options.capcutOptions || {}),
    ffmpegPath: options.ffmpegPath || shared.FFMPEG_PATH
  }));
  registry.register(new EdgeTTSEngine({
    existsSync: options.existsSync,
    execFile: options.execFile || shared.execFile,
    ffmpegPath: options.ffmpegPath || shared.FFMPEG_PATH
  }));
  return registry;
}

const voiceEngineRegistry = createDefaultVoiceEngineRegistry();

module.exports = {
  DEFAULT_VOICE_ENGINE_ID,
  VoiceEngine,
  VoiceEngineError,
  VoiceEngineRegistry,
  CurrentOmniVoiceEngine,
  PythonOmniVoiceEngine,
  OmniVoiceServerManager,
  EdgeTTSEngine,
  PiperEngine,
  CapCutTTSEngine,
  createDefaultVoiceEngineRegistry,
  voiceEngineRegistry
};
