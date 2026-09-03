const test = require('node:test');
const assert = require('node:assert/strict');
const anti = require('../lib/anti-dupe');

test('scene planner always returns the requested number of clips', () => {
  const segments = anti.planSceneSegments([9, 11, 19, 21, 29, 31, 39, 41], 50, 5);
  assert.equal(segments.length, 5);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, 50);
  assert.ok(segments.every((segment) => segment.duration > 0));
});

test('scene planner moves ideal boundaries to nearby scene changes', () => {
  const segments = anti.planSceneSegments([8.5, 22], 30, 3);
  assert.equal(segments[0].end, 8.5);
  assert.equal(segments[1].end, 22);
});

test('target-duration planner covers the whole source without gaps', () => {
  const segments = anti.planTargetDurationSegments([20, 41, 61, 82], 100, 40);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, 100);
  segments.slice(1).forEach((segment, index) => assert.equal(segment.start, segments[index].end));
});

test('aspect conversion uses blurred background and preserves optional audio', () => {
  const withAudio = anti.buildSceneClipFilters({ startSec: 2, endSec: 8, aspect: '9:16' }, { hasAudio: true });
  assert.match(withAudio.segments.join(';'), /boxblur/);
  assert.match(withAudio.segments.join(';'), /overlay=/);
  assert.match(withAudio.segments.join(';'), /\[aout\]/);
  const silent = anti.buildSceneClipFilters({ startSec: 0, endSec: 3, aspect: 'keep' }, { hasAudio: false });
  assert.doesNotMatch(silent.segments.join(';'), /0:a/);
});
