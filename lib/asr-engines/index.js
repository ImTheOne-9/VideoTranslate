'use strict';

const path = require('path');

const { getAppDataRoot } = require('../path-helper');
const { getWhisperOnnxConfig } = require('../model-downloader');
const { AsrEngine, AsrEngineError } = require('./asr-engine');
const { AsrEngineRegistry } = require('./asr-engine-registry');
const { WhisperOnnxAsrEngine } = require('./whisper-onnx-asr-engine');

const DEFAULT_ASR_ENGINE_ID = 'whisper-onnx';
const appDataRoot = getAppDataRoot(path.join(__dirname, '..', '..'));

function resolveWhisperModelPath(variant = 'q8') {
  if (process.env.WHISPER_ONNX_MODEL_PATH) return process.env.WHISPER_ONNX_MODEL_PATH;
  const config = getWhisperOnnxConfig(variant);
  return path.join(appDataRoot, 'models', 'whisper', config.folder);
}

function createDefaultAsrEngineRegistry(options = {}) {
  const registry = new AsrEngineRegistry();
  registry.register(new WhisperOnnxAsrEngine({
    helper: options.whisperHelper,
    resolveModelPath: options.resolveModelPath || resolveWhisperModelPath
  }));
  return registry;
}

const asrEngineRegistry = createDefaultAsrEngineRegistry();

module.exports = {
  DEFAULT_ASR_ENGINE_ID,
  AsrEngine,
  AsrEngineError,
  AsrEngineRegistry,
  WhisperOnnxAsrEngine,
  asrEngineRegistry,
  createDefaultAsrEngineRegistry,
  resolveWhisperModelPath
};
