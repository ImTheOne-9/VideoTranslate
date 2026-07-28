'use strict';

const shared = require('../shared-state');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');
const { VoiceEngineRegistry } = require('./voice-engine-registry');
const { CurrentOmniVoiceEngine } = require('./current-omnivoice-engine');
const { OmniVoiceServerManager } = require('./omnivoice-server-manager');

const DEFAULT_VOICE_ENGINE_ID = 'current-omnivoice';

function createDefaultVoiceEngineRegistry(options = {}) {
  const registry = new VoiceEngineRegistry();
  const serverManager = options.serverManager || new OmniVoiceServerManager({
    serverPaths: options.serverPaths || shared.OMNIVOICE_SERVER_PATHS,
    existsSync: options.existsSync,
    spawn: options.spawnCli || shared.spawn,
    registerProcess: options.registerProcess || shared.registerChildProcess,
    killProcess: options.killProcess || shared.killProcessTree
  });
  registry.register(new CurrentOmniVoiceEngine({
    cliPath: options.cliPath || shared.OMNIVOICE_CLI_PATH,
    modelPath: options.modelPath || shared.OMNIVOICE_MODEL_PATH,
    existsSync: options.existsSync,
    statSync: options.statSync,
    runCli: options.runCli || shared.runOmnivoiceCLI,
    spawnCli: options.spawnCli || shared.spawn,
    killProcess: options.killProcess || shared.killProcessTree,
    serverManager
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
  OmniVoiceServerManager,
  createDefaultVoiceEngineRegistry,
  voiceEngineRegistry
};
