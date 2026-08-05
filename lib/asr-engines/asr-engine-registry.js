'use strict';

const { AsrEngineError } = require('./asr-engine');

class AsrEngineRegistry {
  constructor() {
    this.engines = new Map();
  }

  register(engine) {
    if (!engine?.id) throw new Error('Cannot register an ASR engine without an id');
    if (this.engines.has(engine.id)) throw new Error(`ASR engine already registered: ${engine.id}`);
    this.engines.set(engine.id, engine);
    return engine;
  }

  get(engineId) {
    const engine = this.engines.get(engineId);
    if (!engine) {
      throw new AsrEngineError(`ASR engine is not supported: ${engineId}`, {
        code: 'ASR_ENGINE_NOT_FOUND',
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
}

module.exports = {
  AsrEngineRegistry
};
