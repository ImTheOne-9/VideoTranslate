'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SrtParser = require('srt-parser-2').default;

const {
  SUBTITLE_POSTPROCESS_VERSION,
  createSubtitlePostprocessSignature,
  normalizeComparableText,
  normalizeSubtitleTimeline,
  normalizeSubtitleTimelineFile,
  sequenceMatcherRatio
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

test('deep cleanup merges overlapping two-line OCR cues before enforcing timeline gaps', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 1000, endMs: 2200, text: '这是第一行' },
    { startMs: 1500, endMs: 2600, text: '这是第二行' },
    { startMs: 3000, endMs: 3600, text: '下一句' }
  ], { deepCleanup: true });

  assert.deepEqual(cues.map((cue) => cue.text), ['这是第一行 这是第二行', '下一句']);
  assert.equal(report.mergedOverlappingCues, 1);
  assert.equal(report.outputCues, 2);
});

test('deep cleanup keeps a complete cue and removes its adjacent reveal fragments', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 1000, endMs: 1600, text: '我们现在回家' },
    { startMs: 1650, endMs: 1900, text: '我们现在' },
    { startMs: 1950, endMs: 2200, text: '回家' },
    { startMs: 3000, endMs: 3600, text: '下一句对白' }
  ], { deepCleanup: true });

  assert.deepEqual(cues.map((cue) => cue.text), ['我们现在回家', '下一句对白']);
  assert.equal(report.removedSplitOrRepeatedCues, 2);
  assert.equal(cues[0].endMs, 2200);
});

test('deep cleanup removes a nearby contained fragment but preserves common short dialogue', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 0, endMs: 500, text: '好的' },
    { startMs: 700, endMs: 1200, text: '一直没有找到合适的' },
    { startMs: 1250, endMs: 1500, text: '没有找到' }
  ], { deepCleanup: true });

  assert.deepEqual(cues.map((cue) => cue.text), ['好的', '一直没有找到合适的']);
  assert.equal(report.removedFragmentCues, 1);
});

test('deep cleanup removes consecutive Whisper stutter without removing two-character repetition', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 0, endMs: 1000, text: '林总好林总好' },
    { startMs: 1200, endMs: 2000, text: '看看再看看' },
    { startMs: 2200, endMs: 3000, text: 'we need to go we need to go now' }
  ], { deepCleanup: true });

  assert.deepEqual(cues.map((cue) => cue.text), ['林总好', '看看再看看', 'we need to go now']);
  assert.equal(report.destutteredCues, 2);
});

test('reports suspiciously truncated generated subtitles without rejecting the usable cues', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 1000, endMs: 10000, text: 'chỉ có phần đầu video' }
  ], { deepCleanup: true, videoDurationMs: 120000 });

  assert.equal(cues.length, 1);
  assert.equal(report.coverageRatio, 10 / 120);
  assert.equal(report.possibleTruncation, true);
});

test('default cleanup stays conservative for uploaded or manually edited subtitles', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 0, endMs: 1000, text: 'we need to go we need to go' }
  ]);

  assert.equal(cues[0].text, 'we need to go we need to go');
  assert.equal(report.deepCleanup, false);
});

test('comparison normalization matches ViralCrawl by converting Traditional Chinese to Simplified', () => {
  assert.equal(normalizeComparableText('傑克薩利講！'), normalizeComparableText('杰克萨利讲'));
});

test('SequenceMatcher-compatible ratio keeps short number changes out of fuzzy deletion', () => {
  assert.ok(sequenceMatcherRatio('他今年二十岁', '他今年三十岁') > 0.8);
  const { cues } = normalizeSubtitleTimeline([
    { startMs: 0, endMs: 500, text: '他今年二十岁' },
    { startMs: 700, endMs: 1200, text: '他今年三十岁' }
  ], { deepCleanup: true });
  assert.equal(cues.length, 2);
});

test('deep cleanup recognizes prefix FULL suffix reveal and assigns the whole span to FULL', () => {
  const { cues, report } = normalizeSubtitleTimeline([
    { startMs: 1000, endMs: 1400, text: '我们现在马上' },
    { startMs: 1450, endMs: 2100, text: '我们现在马上一起回家' },
    { startMs: 2150, endMs: 2500, text: '马上一起回家' },
    { startMs: 3000, endMs: 3500, text: '完全不同的下一句' }
  ], { deepCleanup: true });

  assert.deepEqual(cues.map((cue) => cue.text), ['我们现在马上一起回家', '完全不同的下一句']);
  assert.deepEqual([cues[0].startMs, cues[0].endMs], [1000, 2500]);
  assert.equal(report.removedSplitOrRepeatedCues, 2);
  assert.equal(report.removedSplitOrRepeatedSamples.length, 2);
});

test('deep cleanup removes an exact short hallucination repeated across the distant window', () => {
  const texts = ['不知道了', '甲乙丙丁', '戊己庚辛', '天地玄黄', '不知道了', '宇宙洪荒', '日月盈昃', '不知道了'];
  const { cues, report } = normalizeSubtitleTimeline(texts.map((text, index) => ({
    startMs: index * 300,
    endMs: (index * 300) + 200,
    text
  })), { deepCleanup: true });

  assert.equal(cues.filter((cue) => cue.text === '不知道了').length, 1);
  assert.equal(report.removedSplitOrRepeatedCues, 2);
});

test('coverage accounting exposes version, detailed stages and action threshold', () => {
  const { report } = normalizeSubtitleTimeline([
    { startMs: 1000, endMs: 50000, text: 'phần đầu' }
  ], { deepCleanup: true, videoDurationMs: 120000 });

  assert.equal(report.algorithmVersion, SUBTITLE_POSTPROCESS_VERSION);
  assert.equal(report.algorithmSignature, createSubtitlePostprocessSignature({ deepCleanup: true }));
  assert.equal(report.invalidCues, 0);
  assert.equal(report.possibleTruncation, true);
  assert.equal(report.coverageRequiresAction, true);
});
