'use strict';

const { readPcm16WavFile } = require('./audio-quality');

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateFramePitch(samples, sampleRate) {
  let energy = 0;
  for (let index = 0; index < samples.length; index++) energy += samples[index] * samples[index];
  if (Math.sqrt(energy / Math.max(1, samples.length)) < 350) return null;
  const minLag = Math.floor(sampleRate / 350);
  const maxLag = Math.min(samples.length - 2, Math.ceil(sampleRate / 70));
  let bestLag = 0;
  let bestScore = -Infinity;
  const candidates = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index < samples.length - lag; index++) {
      const left = samples[index];
      const right = samples[index + lag];
      correlation += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const score = correlation / Math.sqrt(Math.max(1, leftEnergy * rightEnergy));
    candidates.push({ lag, score });
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestScore < 0.42 || !bestLag) return null;
  const firstStrongPeak = candidates.find((candidate, index) => (
    index > 0
    && index < candidates.length - 1
    && candidate.score >= 0.75
    && candidate.score >= candidates[index - 1].score
    && candidate.score >= candidates[index + 1].score
  ));
  if (firstStrongPeak) bestLag = firstStrongPeak.lag;
  return sampleRate / bestLag;
}

function estimateCuePitch(samples, sampleRate, startMs, endMs) {
  const start = Math.max(0, Math.floor(startMs * sampleRate / 1000));
  const end = Math.min(samples.length, Math.ceil(endMs * sampleRate / 1000));
  const frameSize = Math.max(640, Math.round(sampleRate * 0.05));
  const step = Math.max(frameSize, Math.round(sampleRate * 0.1));
  const pitches = [];
  for (let offset = start; offset + frameSize <= end && pitches.length < 24; offset += step) {
    const pitch = estimateFramePitch(samples.subarray(offset, offset + frameSize), sampleRate);
    if (pitch >= 70 && pitch <= 350) pitches.push(pitch);
  }
  return median(pitches);
}

function chooseAdaptiveThreshold(pitches) {
  const sorted = pitches.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 4) return 180;
  let largestGap = 0;
  let threshold = 180;
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index] - sorted[index - 1];
    const middle = (sorted[index] + sorted[index - 1]) / 2;
    if (middle >= 130 && middle <= 230 && gap > largestGap) {
      largestGap = gap;
      threshold = middle;
    }
  }
  return largestGap >= 12 ? threshold : Math.min(205, Math.max(155, median(sorted) || 180));
}

function classifyCueSpeakers(wavPath, cues) {
  const wav = readPcm16WavFile(wavPath);
  const frameCount = Math.floor(wav.pcmBuffer.length / wav.blockAlign);
  const mono = new Int16Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel++) {
      sum += wav.pcmBuffer.readInt16LE(frame * wav.blockAlign + channel * 2);
    }
    mono[frame] = Math.round(sum / wav.channels);
  }
  const pitches = cues.map((cue) => estimateCuePitch(
    mono,
    wav.sampleRate,
    Number(cue.startMs) || 0,
    Number(cue.endMs) || 0
  ));
  const valid = pitches.filter(Number.isFinite);
  if (valid.length < 4) return { accepted: false, reason: 'insufficient_pitch', pitches };
  const thresholdHz = chooseAdaptiveThreshold(valid);
  const speakers = [];
  let previous = median(valid) < thresholdHz ? 'male' : 'female';
  for (const pitch of pitches) {
    if (Number.isFinite(pitch) && Math.abs(pitch - thresholdHz) > 12) {
      previous = pitch < thresholdHz ? 'male' : 'female';
    }
    speakers.push(previous);
  }
  const maleCount = speakers.filter((speaker) => speaker === 'male').length;
  if (maleCount / speakers.length >= 0.9 || maleCount / speakers.length <= 0.1) {
    const dominant = maleCount >= speakers.length / 2 ? 'male' : 'female';
    speakers.fill(dominant);
  }
  return { accepted: true, speakers, pitches, thresholdHz, maleCount };
}

module.exports = {
  chooseAdaptiveThreshold,
  classifyCueSpeakers,
  estimateCuePitch,
  estimateFramePitch
};
