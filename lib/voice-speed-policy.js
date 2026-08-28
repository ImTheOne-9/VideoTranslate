'use strict';

const DEFAULT_VOICE_SPEED = 1;
const DEFAULT_VOICE_SPEED_MAX = 1.15;
const DEFAULT_PIPER_LENGTH_SCALE = 0.8;

function finiteNumber(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function edgeRateToSpeed(value) {
  const match = String(value || '').trim().match(/^([+-]?)(\d{1,3})%$/);
  if (!match) return DEFAULT_VOICE_SPEED;
  const percent = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return Math.max(0.5, Math.min(2, 1 + percent / 100));
}

function resolveVoiceSpeed(value, options = {}) {
  const legacySpeed = edgeRateToSpeed(options.legacyEdgeRate);
  const requested = finiteNumber(value, finiteNumber(options.environmentSpeed, legacySpeed));
  const configuredMax = finiteNumber(options.maxSpeed, DEFAULT_VOICE_SPEED_MAX);
  const maximum = configuredMax > 0 ? Math.max(0.5, Math.min(2, configuredMax)) : 2;
  return Number(Math.max(0.5, Math.min(maximum, requested)).toFixed(3));
}

function voiceSpeedToEdgeRate(speed) {
  const resolved = Math.max(0.5, Math.min(2, finiteNumber(speed, DEFAULT_VOICE_SPEED)));
  const percent = Math.round((resolved - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function voiceSpeedToPiperLengthScale(speed, base = DEFAULT_PIPER_LENGTH_SCALE) {
  const resolved = Math.max(0.5, Math.min(2, finiteNumber(speed, DEFAULT_VOICE_SPEED)));
  return Number(Math.max(0.68, Math.min(1.5, finiteNumber(base, DEFAULT_PIPER_LENGTH_SCALE) / resolved)).toFixed(4));
}

function engineUsesNativeVoiceSpeed(engineId) {
  return engineId === 'edge-tts' || engineId === 'piper';
}

module.exports = {
  DEFAULT_PIPER_LENGTH_SCALE,
  DEFAULT_VOICE_SPEED,
  DEFAULT_VOICE_SPEED_MAX,
  edgeRateToSpeed,
  engineUsesNativeVoiceSpeed,
  resolveVoiceSpeed,
  voiceSpeedToEdgeRate,
  voiceSpeedToPiperLengthScale
};
