'use strict';

const { AsrEngine } = require('./asr-engine');
const fasterWhisper = require('../faster-whisper-helper');

class FasterWhisperAsrEngine extends AsrEngine {
  constructor(options = {}) {
    super({ id: 'faster-whisper', name: 'Faster Whisper Large V3 Turbo', version: '1' });
    this.helper = options.helper || fasterWhisper;
    this.segmentFallback = options.segmentFallback;
    this.resolveFallbackModelPath = options.resolveFallbackModelPath;
  }

  getCapabilities() {
    return {
      automaticLanguageDetection: true,
      manualLanguage: true,
      segmentTimestamps: true,
      wordTimestamps: true,
      vad: true,
      segmentRetry: true,
      devices: ['auto', 'cuda', 'cpu']
    };
  }

  async checkStatus(options = {}) {
    return this.helper.checkStatus(options);
  }

  async transcribe(options = {}) {
    return this.helper.transcribeAudio(options);
  }

  async transcribeSegment(options = {}) {
    // Segment review is deliberately retried on the stable CPU adapter: loading
    // large-v3-turbo again for one short cue wastes VRAM and can evict the TTS model.
    return this.segmentFallback.transcribeSegment({
      ...options,
      modelPath: this.resolveFallbackModelPath('q8'),
      variant: 'q8',
      device: 'cpu'
    });
  }

  async cancel(owner) {
    return this.helper.cancelFasterWhisper(owner)
      || this.segmentFallback.cancel(owner);
  }
}

module.exports = { FasterWhisperAsrEngine };
