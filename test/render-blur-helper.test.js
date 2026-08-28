const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTimedBlurFilterGraph,
  normalizeMaskStyle,
  normalizeOpaqueColor,
  normalizeBlurBox,
  optimizeAutomaticOcrBlurBoxes,
  prepareAutomaticBlurBoxes
} = require('../lib/render-blur-helper');

function makeOcrBoxes(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    x: 20,
    y: 88,
    width: 60,
    height: 10,
    start: index * 2,
    end: index * 2 + 1.5,
    source: 'viral_ocr',
    ...overrides
  }));
}

test('OCR grouping keeps at most 60 cues per dynamic blur filter', () => {
  const groups = optimizeAutomaticOcrBlurBoxes(makeOcrBoxes(152));

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.boxes.length), [60, 60, 32]);
  assert.ok(groups.every((group) => group.mode === 'dynamic'));

  const result = buildTimedBlurFilterGraph({
    videoWidth: 1920,
    videoHeight: 1080,
    automaticBoxes: makeOcrBoxes(152)
  });
  assert.equal(result.stats.automaticCount, 152);
  assert.equal(result.stats.groupedFilterCount, 3);
  assert.equal(result.stats.perBoxAutomaticCount, 0);
  assert.equal((result.filter.match(/gblur=/g) || []).length, 3);
  assert.match(result.filter, /between\(t,0\.000,1\.500\)\+between\(t,1\.900,3\.500\)/);
  assert.match(result.filter, /crop=.*x='if\(between\(t,/);
  assert.match(result.filter, /overlay=x='if\(between\(t,/);
});

test('unsafe vertical envelopes fall back to fit-per-box filters', () => {
  const boxes = [
    ...makeOcrBoxes(1, { y: 60, height: 4, start: 0, end: 1 }),
    ...makeOcrBoxes(1, { y: 65, height: 4, start: 2, end: 3 }),
    ...makeOcrBoxes(1, { y: 70, height: 4, start: 4, end: 5 })
  ];
  const groups = optimizeAutomaticOcrBlurBoxes(boxes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].mode, 'per_box');

  const result = buildTimedBlurFilterGraph({
    videoWidth: 1920,
    videoHeight: 1080,
    automaticBoxes: boxes
  });
  assert.equal(result.stats.groupedFilterCount, 0);
  assert.equal(result.stats.perBoxAutomaticCount, 3);
});

test('manual watermark blur and grouped OCR blur share one filter graph', () => {
  const result = buildTimedBlurFilterGraph({
    videoWidth: 1920,
    videoHeight: 1080,
    manualBoxes: [{ x: 0, y: 0, width: 16, height: 9, start: 0, end: 99999, radius: 50 }],
    automaticBoxes: makeOcrBoxes(10),
    outputLabel: 'v_base'
  });

  assert.equal(result.stats.manualCount, 1);
  assert.equal(result.stats.groupedFilterCount, 1);
  assert.equal((result.filter.match(/boxblur=/g) || []).length, 1);
  assert.equal((result.filter.match(/gblur=/g) || []).length, 1);
  assert.match(result.filter, /null\[v_base\]$/);
});

test('blur coordinates mirror with a horizontally flipped source', () => {
  const normalized = normalizeBlurBox(
    { x: 10, y: 20, width: 20, height: 10 },
    { mirrored: true }
  );
  assert.equal(normalized.x, 70);

  const result = buildTimedBlurFilterGraph({
    videoWidth: 1000,
    videoHeight: 500,
    manualBoxes: [{ x: 10, y: 20, width: 20, height: 10 }],
    mirrored: true
  });
  assert.match(result.filter, /crop=200:50:700:100/);
  assert.match(result.filter, /overlay=700:100/);
});

test('automatic boxes get conditional pre-roll and extend to matching subtitle timing', () => {
  const boxes = prepareAutomaticBlurBoxes([
    { x: 20, y: 88, width: 30, height: 9, start: 1, end: 1.4 },
    { x: 30, y: 88, width: 30, height: 9, start: 2, end: 2.4 }
  ], {
    horizontalPadding: 0.6,
    verticalPadding: 0.4,
    displayCues: [
      { startMs: 1000, endMs: 1800 },
      { startMs: 2000, endMs: 2600 }
    ]
  });

  assert.equal(boxes[0].start, 0.9);
  assert.equal(boxes[0].end, 1.8);
  assert.equal(boxes[1].start, 1.9);
  assert.equal(boxes[1].end, 2.6);
  assert.ok(boxes[0].x < 20);
  assert.ok(boxes[0].height < 10);
});

test('same-track OCR sampling gaps are bridged but real subtitle pauses remain', () => {
  const boxes = prepareAutomaticBlurBoxes([
    { x: 20, y: 88, width: 30, height: 9, start: 0, end: 1 },
    { x: 30, y: 88, width: 30, height: 9, start: 1.267, end: 2 },
    { x: 25, y: 88, width: 30, height: 9, start: 2.8, end: 3.5 }
  ]);

  assert.equal(boxes[1].start, 1);
  assert.equal(boxes[1].timingAdjustment, 'continuous_gap');
  assert.equal(boxes[2].start, 2.7);
  assert.equal(boxes[2].timingAdjustment, 'pre_roll');

  const result = buildTimedBlurFilterGraph({
    videoWidth: 1000,
    videoHeight: 500,
    automaticBoxes: [
      { x: 20, y: 88, width: 30, height: 9, start: 0, end: 1 },
      { x: 30, y: 88, width: 30, height: 9, start: 1.267, end: 2 }
    ]
  });
  assert.equal(result.stats.bridgedGapCount, 1);
  assert.match(result.filter, /between\(t,1\.000,2\.000\)/);
});

test('dynamic blur follows each cue instead of using the union of distant x positions', () => {
  const result = buildTimedBlurFilterGraph({
    videoWidth: 1000,
    videoHeight: 500,
    automaticBoxes: [
      { x: 10, y: 88, width: 20, height: 9, start: 0, end: 1 },
      { x: 70, y: 88, width: 20, height: 9, start: 2, end: 3 }
    ],
    preRoll: 0,
    horizontalPadding: 0,
    verticalPadding: 0
  });

  assert.equal(result.stats.groupedFilterCount, 1);
  assert.match(result.filter, /if\(between\(t,0\.000,1\.000\),100,if\(between\(t,2\.000,3\.000\),700,0\)\)/);
  assert.doesNotMatch(result.filter, /crop=800:/);
});

test('opaque mask draws one exact black bar per manual and OCR box', () => {
  const result = buildTimedBlurFilterGraph({
    videoWidth: 1000,
    videoHeight: 500,
    maskStyle: 'solid',
    maskColor: '#ff00ff',
    manualBoxes: [{ x: 5, y: 5, width: 10, height: 10, start: 0, end: 2 }],
    automaticBoxes: [
      { x: 20, y: 88, width: 30, height: 8, start: 1, end: 1.5 },
      { x: 40, y: 88, width: 25, height: 8, start: 3, end: 3.5 }
    ],
    preRoll: 0
  });

  assert.equal(result.stats.maskStyle, 'solid');
  assert.equal(result.stats.maskColor, '#000000');
  assert.equal(result.stats.solidFilterCount, 3);
  assert.equal((result.filter.match(/drawbox=/g) || []).length, 3);
  assert.equal((result.filter.match(/gblur=|boxblur=/g) || []).length, 0);
  assert.match(result.filter, /color=0x000000@1\.0:t=fill/);
  assert.match(result.filter, /drawbox=x=200:y=440:w=300:h=40/);
  assert.match(result.filter, /enable='between\(t,1\.000,1\.500\)'/);
});

test('custom opaque mask validates color and follows mirrored coordinates', () => {
  const result = buildTimedBlurFilterGraph({
    videoWidth: 1000,
    videoHeight: 500,
    maskStyle: 'custom',
    maskColor: '#12abEF',
    manualBoxes: [{ x: 10, y: 20, width: 20, height: 10 }],
    mirrored: true
  });

  assert.equal(result.stats.maskColor, '#12ABEF');
  assert.match(result.filter, /drawbox=x=700:y=100:w=200:h=50:color=0x12ABEF@1\.0/);
  assert.equal(normalizeOpaqueColor('red'), '#000000');
  assert.equal(normalizeMaskStyle('unknown'), 'blur');
});
