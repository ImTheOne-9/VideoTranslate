'use strict';

class VoiceEngineError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'VoiceEngineError';
    this.code = options.code || 'VOICE_ENGINE_ERROR';
    this.engineId = options.engineId || null;
    this.details = options.details || null;
    if (options.cause) this.cause = options.cause;
  }
}

class VoiceEngine {
  constructor(descriptor = {}) {
    if (!descriptor.id) throw new Error('VoiceEngine requires an id');
    if (!descriptor.name) throw new Error('VoiceEngine requires a name');
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.version = descriptor.version || '1';
  }

  async checkStatus() {
    throw new VoiceEngineError('checkStatus() is not implemented', {
      code: 'VOICE_ENGINE_NOT_IMPLEMENTED',
      engineId: this.id
    });
  }

  async loadModel() {
    throw new VoiceEngineError('loadModel() is not implemented', {
      code: 'VOICE_ENGINE_NOT_IMPLEMENTED',
      engineId: this.id
    });
  }

  async synthesize() {
    throw new VoiceEngineError('synthesize() is not implemented', {
      code: 'VOICE_ENGINE_NOT_IMPLEMENTED',
      engineId: this.id
    });
  }

  /**
   * Synthesizes independent cues while preserving their input order.
   * Engines may override this to use a native batch API. A failed cue is
   * returned as a failed item so the caller can retry/fallback only that cue.
   */
  async synthesizeBatch(options = {}) {
    const items = Array.isArray(options.items) ? options.items : [];
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 1));
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index] || {};
        try {
          results[index] = {
            ok: true,
            index,
            key: item.key ?? index,
            result: await this.synthesize(item)
          };
        } catch (error) {
          results[index] = {
            ok: false,
            index,
            key: item.key ?? index,
            error
          };
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(concurrency, Math.max(1, items.length)) },
      () => worker()
    ));
    return results;
  }

  async cloneVoice() {
    throw new VoiceEngineError('cloneVoice() is not implemented', {
      code: 'VOICE_ENGINE_NOT_IMPLEMENTED',
      engineId: this.id
    });
  }

  async cancel() {
    return false;
  }

  getCapabilities() {
    return {
      cloneVoice: false,
      languages: [],
      devices: ['cpu'],
      modelSizeBytes: null,
      sampleRate: null,
      emotion: false,
      speedControl: false,
      durationControl: false,
      batchSynthesis: false,
      batchConcurrency: 1
    };
  }

  async describe() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      capabilities: this.getCapabilities(),
      status: await this.checkStatus()
    };
  }
}

module.exports = {
  VoiceEngine,
  VoiceEngineError
};
