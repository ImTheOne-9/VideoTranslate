'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SrtParser = require('srt-parser-2').default;

const {
  normalizeSubtitleTimeline,
  normalizeSubtitleTimelineFile
} = require('../lib/subtitle-timeline-normalizer');

test('trims overlapping OCR cues and keeps the ViralCrawl 80ms subtitle gap', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 6540, endMs: 8175, text: 'cue 5' },
    { startMs: 7508, endMs: 9676, text: 'cue 6' },
    { startMs: 8642, endMs: 9343, text: 'cue 7' }
  ]);

  assert.deepEqual(cues.map((cue) => [cue.startMs, cue.endMs]), [
    [6540, 7428],
    [7508, 8562],
    [8642, 9343]
  ]);
  assert.equal(report.trimmedCues, 2);
  assert.equal(report.droppedSameStartCues, 0);
  for (let index = 1; index < cues.length; index += 1) {
    assert.ok(cues[index].startMs - cues[index - 1].endMs >= 80);
  }
});

test('drops a later cue whose start is effectively identical to the previous cue', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 1000, endMs: 2200, text: 'lời thoại chính' },
    { startMs: 1015, endMs: 1800, text: 'chữ phụ cùng mốc' },
    { startMs: 2400, endMs: 3000, text: 'câu tiếp' }
  ]);

  assert.deepEqual(cues.map((cue) => cue.text), ['lời thoại chính', 'câu tiếp']);
  assert.equal(report.droppedSameStartCues, 1);
});

test('restores a short cue by borrowing preceding silence without overlapping', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 0, endMs: 1000, text: 'một' },
    { startMs: 1300, endMs: 1400, text: 'hai' }
  ]);

  assert.deepEqual([cues[1].startMs, cues[1].endMs], [1150, 1400]);
  assert.equal(report.restoredShortCues, 1);
  assert.ok(cues[1].startMs - cues[0].endMs >= 80);
});

test('normalizes an SRT file atomically and renumbers retained cues', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-timeline-'));
  const inputPath = path.join(directory, 'input.srt');
  const outputPath = path.join(directory, 'output.srt');
  fs.writeFileSync(inputPath, [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'A',
    '',
    '2',
    '00:00:01,010 --> 00:00:01,800',
    'B',
    '',
    '3',
    '00:00:02,200 --> 00:00:03,000',
    'C',
    ''
  ].join('\n'), 'utf8');

  const result = normalizeSubtitleTimelineFile(inputPath, outputPath);
  const cues = new SrtParser().fromSrt(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(result.report.outputCues, 2);
  assert.deepEqual(cues.map((cue) => cue.id), ['1', '2']);
  assert.deepEqual(cues.map((cue) => cue.text), ['A', 'C']);
});
