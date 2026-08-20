'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  alignSubtitleCuesToNarration,
  createTimelineState,
  evaluateCoverage,
  evaluateOnsetAlignment,
  planAdaptiveCue,
  preparePiperCueText,
  synthesizeWithFallback
} = require('../lib/adaptive-dubbing-pipeline');

test('adaptive cue fit keeps natural overflow inside tolerance', () => {
  const state = createTimelineState();
  const plan = planAdaptiveCue({ startMs: 0, endMs: 1000, rawDurationMs: 1100, state });
  assert.equal(plan.speed, 1);
  assert.equal(plan.status, 'natural');
  assert.equal(state.cursorMs, 1100);
});

test('adaptive cue fit caps normal compression at 1.6x', () => {
  const state = createTimelineState();
  const plan = planAdaptiveCue({ startMs: 0, endMs: 1000, rawDurationMs: 3000, state });
  assert.equal(plan.speed, 1.6);
  assert.equal(plan.capHit, true);
  assert.equal(plan.placementStartMs, 0);
  assert.equal(plan.placementEndMs, 1875);
});

test('adaptive cue fit enables catch-up and never overlaps previous speech', () => {
  const state = createTimelineState();
  const first = planAdaptiveCue({ startMs: 0, endMs: 1000, rawDurationMs: 3000, state });
  const second = planAdaptiveCue({ startMs: 1100, endMs: 2100, rawDurationMs: 1800, state });
  assert.equal(second.catchUp, true);
  assert.ok(second.speed > 1.6);
  assert.ok(second.speed <= 2.2);
  assert.ok(second.placementStartMs >= first.placementEndMs);
});

test('adaptive cue fit preserves a real long gap', () => {
  const state = createTimelineState();
  planAdaptiveCue({ startMs: 0, endMs: 500, rawDurationMs: 400, state });
  const plan = planAdaptiveCue({ startMs: 5000, endMs: 6000, rawDurationMs: 500, state });
  assert.equal(plan.placementStartMs, 5000);
  assert.equal(plan.insertedSilenceMs, 4600);
});

test('coverage guard rejects tracks below fifty percent', () => {
  assert.equal(evaluateCoverage(10, 4).accepted, false);
  assert.equal(evaluateCoverage(10, 5).accepted, true);
});

test('failed primary engine retries cue with fallback engine', async () => {
  const primary = { id: 'primary' };
  const fallback = { id: 'edge-tts' };
  const result = await synthesizeWithFallback({
    primary,
    fallback,
    synthesize: async (engine) => {
      if (engine.id === 'primary') throw new Error('primary failed');
      return { outputPath: 'ok.wav' };
    },
    validate: (value) => value.outputPath === 'ok.wav'
  });
  assert.equal(result.engine.id, 'edge-tts');
  assert.equal(result.fallback, true);
  assert.deepEqual(result.attempts.map((item) => item.ok), [false, true]);
});

test('Piper continuation punctuation keeps adjacent unfinished cues connected', () => {
  assert.equal(preparePiperCueText('Đây là một câu chưa hết', {}, {
    currentEndMs: 1000,
    nextStartMs: 1400
  }), 'Đây là một câu chưa hết,');
  assert.equal(preparePiperCueText('Câu đã kết thúc.', {}, {
    currentEndMs: 1000,
    nextStartMs: 1400
  }), 'Câu đã kết thúc.');
  assert.equal(preparePiperCueText('Đoạn cách xa', {}, {
    currentEndMs: 1000,
    nextStartMs: 1800
  }), 'Đoạn cách xa');
});

test('subtitle timing follows narration onset without overlapping the next spoken cue', () => {
  const cues = [
    { startTime: '00:00:00,000', endTime: '00:00:01,000', text: 'Một' },
    { startTime: '00:00:01,100', endTime: '00:00:02,000', text: 'Hai' }
  ];
  const aligned = alignSubtitleCuesToNarration(cues, [
    { cueIndex: 0, startMs: 250, endMs: 1400 },
    { cueIndex: 1, startMs: 1400, endMs: 2300 }
  ]);
  assert.equal(aligned[0].startTime, '00:00:00,250');
  assert.equal(aligned[0].endTime, '00:00:01,380');
  assert.equal(aligned[1].startTime, '00:00:01,400');
  assert.equal(aligned[1].endTime, '00:00:02,300');
});

test('onset sync requires broad, monotonic coverage instead of a clustered partial result', () => {
  const cues = Array.from({ length: 10 }, (_, index) => ({
    startTime: `00:00:${String(index).padStart(2, '0')},000`,
    endTime: `00:00:${String(index).padStart(2, '0')},800`,
    text: String(index)
  }));
  const healthy = cues.map((_, cueIndex) => ({ cueIndex, startMs: cueIndex * 1000, endMs: cueIndex * 1000 + 700 }));
  assert.equal(evaluateOnsetAlignment(cues, healthy).accepted, true);
  const clustered = healthy.slice(0, 7).map((item, index) => ({ ...item, startMs: index * 50 }));
  const report = evaluateOnsetAlignment(cues, clustered);
  assert.equal(report.accepted, false);
  assert.ok(report.reasons.includes('clustered_onsets') || report.reasons.includes('missing_end_span'));
});
