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
      durationControl: false
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
