const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { withTempDir } = require('./helpers/temp-dir');
const { evaluateAndCleanSrt } = require('../lib/subtitle-quality');

async function writeSrt(directory, name, contents) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, contents, 'utf8');
  return filePath;
}

async function assertMissing(filePath) {
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
}

test('accepts two distinct timed cues and preserves their original text', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'Hello, WORLD!',
      '',
      '2',
      '00:00:02,000 --> 00:00:04,000',
      'Xin chao ban',
      ''
    ].join('\n'));
    const outputPath = path.join(directory, 'cleaned.srt');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.deepEqual(result, {
      accepted: true,
      path: outputPath,
      cueCount: 2,
      distinctCueCount: 2,
      removedRepeatedLines: [],
      reason: 'accepted'
    });
    const cleaned = await fs.readFile(outputPath, 'utf8');
    assert.match(cleaned, /Hello, WORLD!/);
    assert.match(cleaned, /Xin chao ban/);
  });
});

test('rejects an empty SRT and removes an existing output file', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', ' \n\t ');
    const outputPath = await writeSrt(directory, 'cleaned.srt', 'stale output');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.deepEqual(result, {
      accepted: false,
      path: null,
      cueCount: 0,
      distinctCueCount: 0,
      removedRepeatedLines: [],
      reason: 'empty'
    });
    await assertMissing(outputPath);
  });
});

test('rejects one static phrase repeated throughout the video', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', [
      '1',
      '00:00:00,000 --> 00:00:01,000',
      'Subscribe now',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,000',
      'Subscribe now',
      '',
      '3',
      '00:00:02,000 --> 00:00:03,000',
      'Subscribe now',
      ''
    ].join('\n'));
    const outputPath = await writeSrt(directory, 'cleaned.srt', 'stale output');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.deepEqual(result, {
      accepted: false,
      path: null,
      cueCount: 0,
      distinctCueCount: 0,
      removedRepeatedLines: ['Subscribe now'],
      reason: 'too_few_distinct_cues'
    });
    await assertMissing(outputPath);
  });
});

test('removes repeated fixed lines while retaining changing dialogue lines', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', [
      '1',
      '00:00:00,000 --> 00:00:01,000',
      'AUTO CAPTION',
      'The first changing line',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,000',
      'auto caption!',
      'The second changing line',
      '',
      '3',
      '00:00:02,000 --> 00:00:03,000',
      'Auto Caption',
      'The third changing line',
      '',
      '4',
      '00:00:03,000 --> 00:00:04,000',
      'AUTO CAPTION',
      'The fourth changing line',
      ''
    ].join('\n'));
    const outputPath = path.join(directory, 'cleaned.srt');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.deepEqual(result, {
      accepted: true,
      path: outputPath,
      cueCount: 4,
      distinctCueCount: 4,
      removedRepeatedLines: ['AUTO CAPTION'],
      reason: 'accepted'
    });
    const cleaned = await fs.readFile(outputPath, 'utf8');
    assert.doesNotMatch(cleaned, /AUTO CAPTION|auto caption!|Auto Caption/);
    assert.match(cleaned, /The first changing line/);
    assert.match(cleaned, /The fourth changing line/);
  });
});

test('rejects malformed and non-positive-duration cues when no valid timing remains', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', [
      '1',
      'not a timestamp',
      'Broken subtitle',
      '',
      '2',
      '00:00:03,000 --> 00:00:03,000',
      'Zero duration',
      '',
      '3',
      '00:00:05,000 --> 00:00:04,000',
      'Backward timing',
      ''
    ].join('\n'));
    const outputPath = await writeSrt(directory, 'cleaned.srt', 'stale output');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.deepEqual(result, {
      accepted: false,
      path: null,
      cueCount: 0,
      distinctCueCount: 0,
      removedRepeatedLines: [],
      reason: 'invalid_timing'
    });
    await assertMissing(outputPath);
  });
});

test('discards invalid cues individually before evaluating the remaining cues', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'This valid line is long enough',
      '',
      '2',
      '00:00:02,000 --> 00:00:02,000',
      'Discard this invalid cue',
      '',
      '3',
      '00:00:03,000 --> 00:00:05,000',
      'Another valid line remains',
      ''
    ].join('\n'));
    const outputPath = path.join(directory, 'cleaned.srt');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.equal(result.accepted, true);
    assert.equal(result.cueCount, 2);
    const cleaned = await fs.readFile(outputPath, 'utf8');
    assert.doesNotMatch(cleaned, /Discard this invalid cue/);
  });
});

test('accepts Chinese text without relying on Latin word boundaries', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      '你好世界',
      '',
      '2',
      '00:00:02,000 --> 00:00:04,000',
      '今天很好',
      ''
    ].join('\n'));
    const outputPath = path.join(directory, 'cleaned.srt');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.deepEqual(result, {
      accepted: true,
      path: outputPath,
      cueCount: 2,
      distinctCueCount: 2,
      removedRepeatedLines: [],
      reason: 'accepted'
    });
  });
});

test('rejects distinct timed cues when too little meaningful text remains', async () => {
  await withTempDir('subtitle-quality-', async (directory) => {
    const inputPath = await writeSrt(directory, 'input.srt', [
      '1',
      '00:00:00,000 --> 00:00:01,000',
      'a',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,000',
      'b',
      ''
    ].join('\n'));
    const outputPath = path.join(directory, 'cleaned.srt');

    const result = await evaluateAndCleanSrt(inputPath, outputPath);

    assert.deepEqual(result, {
      accepted: false,
      path: null,
      cueCount: 2,
      distinctCueCount: 2,
      removedRepeatedLines: [],
      reason: 'too_little_text'
    });
    await assertMissing(outputPath);
  });
});
