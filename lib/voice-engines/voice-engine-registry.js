'use strict';

const { VoiceEngineError } = require('./voice-engine');

class VoiceEngineRegistry {
  constructor() {
    this.engines = new Map();
  }

  register(engine) {
    if (!engine?.id) throw new Error('Cannot register a voice engine without an id');
    if (this.engines.has(engine.id)) {
      throw new Error(`Voice engine already registered: ${engine.id}`);
    }
    this.engines.set(engine.id, engine);
    return engine;
  }

  get(engineId) {
    const engine = this.engines.get(engineId);
    if (!engine) {
      throw new VoiceEngineError(`Voice engine is not supported: ${engineId}`, {
        code: 'VOICE_ENGINE_NOT_FOUND',
        engineId
      });
    }
    return engine;
  }

  resolve(engineId, fallbackId) {
    return this.get(engineId || fallbackId);
  }

  list() {
    return [...this.engines.values()];
  }

  async describeAll() {
    return Promise.all(this.list().map(async (engine) => {
      try {
        return await engine.describe();
      } catch (error) {
        return {
          id: engine.id,
          name: engine.name,
          version: engine.version,
          capabilities: engine.getCapabilities(),
          status: {
            ready: false,
            state: 'error',
            error: error.message
          }
        };
      }
    }));
  }

  async cancel(engineId) {
    return this.get(engineId).cancel();
  }
}

module.exports = {
  VoiceEngineRegistry
};
