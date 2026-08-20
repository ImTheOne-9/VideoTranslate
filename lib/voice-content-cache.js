'use strict';

const fs = require('fs');
const path = require('path');
const { createCheckpointSignature } = require('./checkpoint-utils');
const { getCrawlerPaths } = require('./crawler-paths');

function isEnabled(environment = process.env) {
  return String(environment.VC_RESUME || '') === '1';
}

function cacheRoot() {
  return path.join(getCrawlerPaths().runtimeRoot, 'tts_cache');
}

function createVoiceCacheKey(options = {}) {
  return createCheckpointSignature({
    version: 1,
    text: String(options.text || ''),
    engine: String(options.engineId || ''),
    voice: String(options.voice || ''),
    language: String(options.language || ''),
    rate: String(options.rate || ''),
    pitch: String(options.pitch || ''),
    steps: String(options.steps || ''),
    reference: options.referenceIdentity || null
  });
}

function cachePathForKey(key, root = cacheRoot()) {
  return path.join(root, String(key).slice(0, 2), `${key}.wav`);
}

function restoreVoiceCache(key, outputPath, options = {}) {
  if (!isEnabled(options.environment)) return false;
  const source = cachePathForKey(key, options.root || cacheRoot());
  try {
    if (!fs.existsSync(source) || fs.statSync(source).size <= 44) return false;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(source, outputPath);
    return fs.statSync(outputPath).size > 44;
  } catch (_) {
    return false;
  }
}

function saveVoiceCache(key, inputPath, options = {}) {
  if (!isEnabled(options.environment)) return false;
  try {
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size <= 44) return false;
    const destination = cachePathForKey(key, options.root || cacheRoot());
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.copyFileSync(inputPath, temporary);
    try { fs.rmSync(destination, { force: true }); } catch {}
    fs.renameSync(temporary, destination);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  cachePathForKey,
  createVoiceCacheKey,
  isEnabled,
  restoreVoiceCache,
  saveVoiceCache
};
