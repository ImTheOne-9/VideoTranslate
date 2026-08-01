const { createCheckpointSignature } = require('./checkpoint-utils');

const SMART_FIT_VERSION = 5;
const MAX_NARRATION_SPEED = 2;
const DEFAULT_SMART_FIT_MODE = 'cue';
const SMART_FIT_POLICIES = Object.freeze({
  cue: Object.freeze({
    id: 'cue',
    maxSpeed: MAX_NARRATION_SPEED,
    unlimitedSpeed: false
  })
});

function normalizeSmartFitMode() {
  return DEFAULT_SMART_FIT_MODE;
}

function roundSpeedUp(value) {
  return Math.ceil(value * 1000) / 1000;
}

function planSmartFit(options = {}) {
  const mode = normalizeSmartFitMode(options.mode);
  const policy = SMART_FIT_POLICIES[mode];
  const startMs = Math.max(0, Math.round(Number(options.startMs) || 0));
  const endMs = Math.max(startMs + 1, Math.round(Number(options.endMs) || 0));
  const rawDurationMs = Math.max(1, Math.round(Number(options.rawDurationMs) || 0));
  const safetyMarginMs = Math.max(0, Math.round(Number(options.safetyMarginMs) || 50));
  const cueDurationMs = endMs - startMs;
  const baseAvailableMs = Math.max(1, cueDurationMs - safetyMarginMs);
  const availableDurationMs = baseAvailableMs;

  let speed = 1;
  let fittedDurationMs = rawDurationMs;
  let status = 'unchanged';

  if (rawDurationMs > baseAvailableMs) {
    const requiredSpeed = roundSpeedUp(rawDurationMs / baseAvailableMs);
    speed = Math.min(requiredSpeed, policy.maxSpeed);
    fittedDurationMs = Math.ceil(rawDurationMs / speed);
    status = requiredSpeed > policy.maxSpeed ? 'rewrite_recommended' : 'sped_up';
  }

  return {
    version: SMART_FIT_VERSION,
    mode,
    status,
    maxSpeed: policy.maxSpeed,
    unlimitedSpeed: Boolean(policy.unlimitedSpeed),
    speed,
    startMs,
    endMs,
    cueDurationMs,
    rawDurationMs,
    fittedDurationMs,
    baseAvailableMs,
    availableDurationMs,
    borrowedMs: 0,
    effectiveEndMs: endMs,
    trimmedMs: 0,
    warning: status === 'rewrite_recommended' ? 'smart_fit_rewrite_recommended' : null
  };
}

function createSmartFitSignature(options = {}) {
  return createCheckpointSignature({
    version: SMART_FIT_VERSION,
    rawSignature: options.rawSignature || '',
    rawFile: options.rawFile || null,
    mode: normalizeSmartFitMode(options.mode),
    startMs: Math.round(Number(options.startMs) || 0),
    endMs: Math.round(Number(options.endMs) || 0),
    audioProcessing: options.audioProcessing || null
  });
}

module.exports = {
  DEFAULT_SMART_FIT_MODE,
  MAX_NARRATION_SPEED,
  SMART_FIT_POLICIES,
  SMART_FIT_VERSION,
  createSmartFitSignature,
  normalizeSmartFitMode,
  planSmartFit
};
