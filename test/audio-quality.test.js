'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  analyzeWavBuffer,
  buildVoiceNormalizationFilters,
  parseWavBuffer
} = require('../lib/audio-quality');

function createPcm16Wav({
  durationMs = 1000,
  sampleRate = 24000,
  channels = 1,
  sample = () => 0,
  junkSize = 0
} = {}) {
  const frameCount = Math.round(sampleRate * durationMs / 1000);
  const dataSize = frameCount * channels * 2;
  const paddedJunkSize = junkSize + (junkSize % 2);
  const dataChunkOffset = 36 + (junkSize ? 8 + paddedJunkSize : 0);
  const buffer = Buffer.alloc(8 + dataChunkOffset + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  let offset = 36;
  if (junkSize) {
    buffer.write('JUNK', offset);
    buffer.writeUInt32LE(junkSize, offset + 4);
    offset += 8 + paddedJunkSize;
  }
  buffer.write('data', offset);
  buffer.writeUInt32LE(dataSize, offset + 4);
  offset += 8;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(sample(frame, channel), offset);
      offset += 2;
    }
  }
  return buffer;
}

test('parses PCM WAV files with metadata chunks before audio data', () => {
  const buffer = createPcm16Wav({ durationMs: 250, junkSize: 13 });
  const parsed = parseWavBuffer(buffer);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.channels, 1);
  assert.ok(parsed.dataOffset > 44);
  assert.equal(analyzeWavBuffer(buffer).durationMs, 250);
});

test('reports silent, clipping, and quiet voice chunks', () => {
  const silent = analyzeWavBuffer(createPcm16Wav());
  assert.deepEqual(silent.warnings, ['audio_silent']);

  const clipped = analyzeWavBuffer(createPcm16Wav({ sample: () => 32767 }));
  assert.ok(clipped.warnings.includes('audio_clipping'));
  assert.equal(clipped.peakDbfs, 0);

  const quiet = analyzeWavBuffer(createPcm16Wav({ sample: (frame) => frame % 2 ? 300 : -300 }));
  assert.ok(quiet.warnings.includes('audio_too_quiet'));
  assert.equal(quiet.warnings.includes('audio_silent'), false);
});

test('builds deterministic loudness, limiter, format, and edge-fade filters', () => {
  const filters = buildVoiceNormalizationFilters({ durationMs: 2000 });
  assert.match(filters.join(','), /loudnorm=I=-18:LRA=7:TP=-1\.5/);
  assert.match(filters.join(','), /alimiter=limit=0\.841/);
  assert.match(filters.join(','), /aresample=24000/);
  assert.match(filters.join(','), /channel_layouts=mono/);
  assert.match(filters.join(','), /afade=t=in/);
  assert.match(filters.join(','), /afade=t=out:st=1\.985/);
});
