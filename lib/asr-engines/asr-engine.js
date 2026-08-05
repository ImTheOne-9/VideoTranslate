'use strict';

class AsrEngineError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AsrEngineError';
    this.code = options.code || 'ASR_ENGINE_ERROR';
    this.engineId = options.engineId || null;
    this.details = options.details || null;
    if (options.cause) this.cause = options.cause;
  }
}

class AsrEngine {
  constructor(descriptor = {}) {
    if (!descriptor.id) throw new Error('AsrEngine requires an id');
    if (!descriptor.name) throw new Error('AsrEngine requires a name');
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.version = descriptor.version || '1';
  }

  async checkStatus() {
    throw new AsrEngineError('checkStatus() is not implemented', {
      code: 'ASR_ENGINE_NOT_IMPLEMENTED',
      engineId: this.id
    });
  }

  async transcribe() {
    throw new AsrEngineError('transcribe() is not implemented', {
      code: 'ASR_ENGINE_NOT_IMPLEMENTED',
      engineId: this.id
    });
  }

  async transcribeSegment() {
    throw new AsrEngineError('transcribeSegment() is not implemented', {
      code: 'ASR_ENGINE_NOT_IMPLEMENTED',
      engineId: this.id
    });
  }

  async cancel() {
    return false;
  }

  getCapabilities() {
    return {
      automaticLanguageDetection: false,
      manualLanguage: true,
      segmentTimestamps: true,
      wordTimestamps: false,
      vad: false,
      segmentRetry: false,
      devices: ['cpu']
    };
  }
}

module.exports = {
  AsrEngine,
  AsrEngineError
};
