'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeWarp,
  buildVideoAssistAudioFilters,
  buildVideoAssistVideoFilters,
  warpTimedBoxes
} = require('../lib/video-assist');

const warp = [
  { startMs: 0, endMs: 1000, factor: 1, outputStartMs: 0, outputEndMs: 1000 },
  { startMs: 1000, endMs: 2000, factor: 0.9, outputStartMs: 1000, outputEndMs: 2111 },
  { startMs: 2000, endMs: 3000, factor: 1, outputStartMs: 2111, outputEndMs: 3111 }
];

test('Video Assist builds matching piecewise video and audio filter graphs', () => {
  assert.equal(activeWarp(warp), true);
  const video = buildVideoAssistVideoFilters({ timeWarp: warp });
  const audio = buildVideoAssistAudioFilters({ timeWarp: warp });
  assert.match(video.segments.join(';'), /trim=start=1\.000000:end=2\.000000/);
  assert.match(video.segments.join(';'), /setpts=\(PTS-STARTPTS\)\/0\.900000/);
  assert.match(audio.segments.join(';'), /atempo=0\.900000/);
  assert.match(audio.segments.at(-1), /concat=n=3:v=0:a=1\[a_assist\]/);
});

test('Video Assist maps timed blur boxes to the output timeline', () => {
  const mapped = warpTimedBoxes([{ start: 1.5, end: 2.5, x: 10 }], warp);
  assert.ok(mapped[0].start > 1.5);
  assert.ok(mapped[0].end > 2.5);
  assert.equal(mapped[0].x, 10);
});
