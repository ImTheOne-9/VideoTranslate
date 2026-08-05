'use strict';

const fs = require('fs');

const AUDIO_NORMALIZATION_VERSION = 1;
const DEFAULT_VOICE_NORMALIZATION = Object.freeze({
  sampleRate: 24000,
  integratedLufs: -18,
  loudnessRange: 7,
  truePeakDb: -1.5
});

function dbfs(value) {
  if (!(value > 0)) return -Infinity;
  return 20 * Math.log10(value);
}

function parseWavBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('WAV không hợp lệ hoặc quá ngắn');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('File không phải WAV RIFF');
  }

  let format = null;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const declaredSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const availableSize = Math.max(0, Math.min(declaredSize, buffer.length - payloadOffset));
    if (chunkId === 'fmt ' && availableSize >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(payloadOffset),
        channels: buffer.readUInt16LE(payloadOffset + 2),
        sampleRate: buffer.readUInt32LE(payloadOffset + 4),
        byteRate: buffer.readUInt32LE(payloadOffset + 8),
        blockAlign: buffer.readUInt16LE(payloadOffset + 12),
        bitsPerSample: buffer.readUInt16LE(payloadOffset + 14)
      };
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataSize = availableSize;
      break;
    }
    offset = payloadOffset + declaredSize + (declaredSize % 2);
  }

  if (!format || dataOffset < 0 || dataSize <= 0) {
    throw new Error('WAV thiếu fmt hoặc data chunk');
  }
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error('QC hiện chỉ hỗ trợ WAV PCM 16-bit');
  }
  if (format.channels < 1 || format.sampleRate < 8000 || format.blockAlign < 2) {
    throw new Error('Thông số WAV không hợp lệ');
  }
  return { ...format, dataOffset, dataSize };
}

function readPcm16WavFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const info = parseWavBuffer(buffer);
  const dataSize = Math.floor(info.dataSize / info.blockAlign) * info.blockAlign;
  if (dataSize <= 0) {
    throw new Error('WAV không có frame PCM hoàn chỉnh');
  }
  return {
    ...info,
    dataSize,
    pcmBuffer: Buffer.from(buffer.subarray(info.dataOffset, info.dataOffset + dataSize))
  };
}

function analyzeWavBuffer(buffer) {
  const info = parseWavBuffer(buffer);
  const sampleCount = Math.floor(info.dataSize / 2);
  let sumSquares = 0;
  let peak = 0;
  let clippingSamples = 0;
  let silentSamples = 0;
  const silenceThreshold = Math.round(32768 * Math.pow(10, -50 / 20));

  for (let index = 0; index < sampleCount; index += 1) {
    const value = buffer.readInt16LE(info.dataOffset + index * 2);
    const absolute = Math.abs(value);
    peak = Math.max(peak, absolute);
    sumSquares += value * value;
    if (absolute >= 32760) clippingSamples += 1;
    if (absolute <= silenceThreshold) silentSamples += 1;
  }

  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const durationMs = Math.round(
    (sampleCount / Math.max(1, info.channels) / info.sampleRate) * 1000
  );
  const clippingRatio = sampleCount > 0 ? clippingSamples / sampleCount : 0;
  const silenceRatio = sampleCount > 0 ? silentSamples / sampleCount : 1;
  const peakDbfs = dbfs(peak / 32768);
  const rmsDbfs = dbfs(rms / 32768);
  const warnings = [];
  if (!sampleCount || rmsDbfs <= -55 || silenceRatio >= 0.98) warnings.push('audio_silent');
  if (clippingSamples >= 10 && clippingRatio >= 0.001) warnings.push('audio_clipping');
  if (!warnings.includes('audio_silent') && rmsDbfs < -32) warnings.push('audio_too_quiet');

  return {
    version: AUDIO_NORMALIZATION_VERSION,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitsPerSample: info.bitsPerSample,
    durationMs,
    peakDbfs: Number.isFinite(peakDbfs) ? (Number(peakDbfs.toFixed(2)) || 0) : null,
    rmsDbfs: Number.isFinite(rmsDbfs) ? (Number(rmsDbfs.toFixed(2)) || 0) : null,
    clippingSamples,
    clippingRatio: Number(clippingRatio.toFixed(6)),
    silenceRatio: Number(silenceRatio.toFixed(4)),
    warnings
  };
}

function analyzeWavFile(filePath) {
  return analyzeWavBuffer(fs.readFileSync(filePath));
}

function buildVoiceNormalizationFilters(options = {}) {
  const config = { ...DEFAULT_VOICE_NORMALIZATION, ...options };
  return [
    `loudnorm=I=${config.integratedLufs}:LRA=${config.loudnessRange}:TP=${config.truePeakDb}`,
    'alimiter=limit=0.841:attack=5:release=50:level=disabled',
    `aresample=${Math.round(config.sampleRate)}:async=0:first_pts=0`,
    'aformat=sample_fmts=s16:channel_layouts=mono'
  ];
}

module.exports = {
  AUDIO_NORMALIZATION_VERSION,
  DEFAULT_VOICE_NORMALIZATION,
  analyzeWavBuffer,
  analyzeWavFile,
  buildVoiceNormalizationFilters,
  parseWavBuffer,
  readPcm16WavFile
};
