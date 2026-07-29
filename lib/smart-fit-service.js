const { createCheckpointSignature } = require('./checkpoint-utils');

const SMART_FIT_VERSION = 3;
const DEFAULT_SMART_FIT_MODE = 'cue';
const SMART_FIT_POLICIES = Object.freeze({
  natural: Object.freeze({
    id: 'natural',
    maxSpeed: 1.15,
    maxBorrowMs: 1200,
    rewriteRecommended: false
  }),
  cue: Object.freeze({
    id: 'cue',
    maxSpeed: null,
    maxBorrowMs: 0,
    unlimitedSpeed: true,
    rewriteRecommended: false
  }),
  cinematic: Object.freeze({
    id: 'cinematic',
    maxSpeed: 1.20,
    maxBorrowMs: 1800,
    rewriteRecommended: true
  })
});

function normalizeSmartFitMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return SMART_FIT_POLICIES[mode] ? mode : DEFAULT_SMART_FIT_MODE;
}

function roundSpeed(value) {
  return Math.round(value * 1000) / 1000;
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
  const nextStartValue = Number(options.nextStartMs);
  const timelineEndValue = Number(options.timelineEndMs);
  const boundaryMs = Number.isFinite(nextStartValue)
    ? Math.max(endMs, Math.round(nextStartValue))
    : Number.isFinite(timelineEndValue) && timelineEndValue > endMs
      ? Math.round(timelineEndValue)
      : endMs;
  const gapMs = Math.max(0, boundaryMs - endMs);
  const borrowedMs = Math.min(gapMs, policy.maxBorrowMs);
  const availableDurationMs = Math.max(1, baseAvailableMs + borrowedMs);

  let speed = 1;
  let fittedDurationMs = rawDurationMs;
  let status = 'unchanged';
  let trimmedMs = 0;

  if (rawDurationMs > baseAvailableMs) {
    if (policy.unlimitedSpeed) {
      speed = roundSpeedUp(rawDurationMs / baseAvailableMs);
      fittedDurationMs = Math.ceil(rawDurationMs / speed);
      status = 'sped_up';
    } else if (rawDurationMs <= availableDurationMs) {
      status = 'borrowed';
    } else {
      speed = roundSpeed(Math.min(policy.maxSpeed, rawDurationMs / availableDurationMs));
      fittedDurationMs = Math.ceil(rawDurationMs / speed);
      if (fittedDurationMs <= availableDurationMs) {
        status = 'sped_up';
      } else {
        trimmedMs = fittedDurationMs - availableDurationMs;
        fittedDurationMs = availableDurationMs;
        status = policy.rewriteRecommended ? 'rewrite_recommended' : 'trimmed';
      }
    }
  }

  const usedBorrowMs = Math.max(0, Math.min(
    borrowedMs,
    startMs + fittedDurationMs + safetyMarginMs - endMs
  ));
  const effectiveEndMs = Math.min(
    boundaryMs,
    Math.max(endMs, startMs + fittedDurationMs + safetyMarginMs)
  );

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
    borrowedMs: usedBorrowMs,
    effectiveEndMs,
    trimmedMs,
    warning: status === 'rewrite_recommended'
      ? 'smart_fit_rewrite_recommended'
      : status === 'trimmed'
        ? 'smart_fit_trimmed'
        : null
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
    nextStartMs: Number.isFinite(Number(options.nextStartMs))
      ? Math.round(Number(options.nextStartMs))
      : null,
    timelineEndMs: Number.isFinite(Number(options.timelineEndMs))
      ? Math.round(Number(options.timelineEndMs))
      : null,
    audioProcessing: options.audioProcessing || null
  });
}

module.exports = {
  DEFAULT_SMART_FIT_MODE,
  SMART_FIT_POLICIES,
  SMART_FIT_VERSION,
  createSmartFitSignature,
  normalizeSmartFitMode,
  planSmartFit
};
