'use strict';

const fs = require('fs');

const { AsrEngine, AsrEngineError } = require('./asr-engine');
const { assessAsrCue } = require('../asr-quality');
const whisperOnnx = require('../whisper-onnx-helper');

class WhisperOnnxAsrEngine extends AsrEngine {
  constructor(options = {}) {
    super({ id: 'whisper-onnx', name: 'Whisper ONNX', version: '1' });
    this.helper = options.helper || whisperOnnx;
    this.resolveModelPath = options.resolveModelPath;
  }

  getCapabilities() {
    return {
      automaticLanguageDetection: true,
      manualLanguage: true,
      segmentTimestamps: true,
      wordTimestamps: true,
      vad: true,
      segmentRetry: true,
      devices: ['cpu', 'dml']
    };
  }

  async checkStatus(options = {}) {
    const modelPath = options.modelPath
      || this.resolveModelPath?.(options.variant || 'q8');
    return {
      ready: Boolean(modelPath && fs.existsSync(modelPath)),
      state: modelPath && fs.existsSync(modelPath) ? 'ready' : 'missing',
      modelPath: modelPath || null
    };
  }

  async transcribe(options = {}) {
    return this.helper.transcribeAudio(options);
  }

  async transcribeSegment(options = {}) {
    const startMs = Number(options.startMs);
    const endMs = Number(options.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
      throw new AsrEngineError('Khoảng thời gian nhận dạng lại không hợp lệ', {
        code: 'ASR_INVALID_RANGE',
        engineId: this.id
      });
    }

    const [region] = this.helper.loadAudioRegions(options.audioPath, [{
      start: startMs / 1000,
      end: endMs / 1000
    }]);
    const result = await this.helper.transcribeAudio({
      ...options,
      useVad: false,
      speechRegions: [region],
      timestampLevel: 'word',
      owner: options.owner
    });
    const text = String(result?.text || '').trim();
    const words = (Array.isArray(result?.chunks) ? result.chunks : [])
      .map((chunk) => ({
        text: String(chunk?.text || '').trim(),
        startMs: Number.isFinite(Number(chunk?.timestamp?.[0]))
          ? Math.round(Number(chunk.timestamp[0]) * 1000)
          : null,
        endMs: Number.isFinite(Number(chunk?.timestamp?.[1]))
          ? Math.round(Number(chunk.timestamp[1]) * 1000)
          : null
      }))
      .filter((word) => word.text);
    const quality = assessAsrCue({
      text,
      start: startMs / 1000,
      end: endMs / 1000,
      confidence: result?.confidence,
      score: result?.score,
      avg_logprob: result?.avg_logprob
    });

    return {
      text,
      words,
      ...quality,
      language: options.language || 'auto',
      engineId: this.id,
      variant: options.variant || 'q8'
    };
  }

  async cancel(owner) {
    return this.helper.cancelWhisperWorker(owner);
  }
}

module.exports = {
  WhisperOnnxAsrEngine
};
