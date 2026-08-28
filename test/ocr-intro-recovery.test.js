const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { withTempDir } = require('./helpers/temp-dir');
const {
  createIntroPrerollClip,
  mergeRecoveredIntro,
  recoverMissingIntroCue
} = require('../lib/ocr-intro-recovery');

const MAIN_WITH_MISSING_INTRO = [
  '1',
  '00:00:02,433 --> 00:00:02,865',
  '对',
  '',
  '2',
  '00:00:03,000 --> 00:00:05,099',
  '你以为沧龙够让人窒息了?',
  ''
].join('\n');

const INTRO_WITH_PREROLL = [
  '1',
  '00:00:00,766 --> 00:00:03,199',
  '你以为巨齿鲨的咬合力最恐怖?',
  '',
  '2',
  '00:00:03,200 --> 00:00:03,632',
  '对',
  '',
  '3',
  '00:00:03,766 --> 00:00:05,865',
  '你以为沧龙够让人窒息了?',
  ''
].join('\n');

test('merges only the missing frame-zero cue and prevents overlap with the main OCR result', () => {
  const result = mergeRecoveredIntro(MAIN_WITH_MISSING_INTRO, INTRO_WITH_PREROLL);

  assert.equal(result.recovered, true);
  assert.equal(result.recoveredCueCount, 1);
  assert.match(result.srt, /00:00:00,016 --> 00:00:02,433\r?\n你以为巨齿鲨的咬合力最恐怖\?/u);
  assert.equal((result.srt.match(/\n对\r?\n/gu) || []).length, 1);
  assert.equal((result.srt.match(/你以为沧龙够让人窒息了\?/gu) || []).length, 1);
});

test('does not add a recovered cue when the main OCR already starts near frame zero', () => {
  const main = MAIN_WITH_MISSING_INTRO.replaceAll('00:00:02,433', '00:00:00,100');
  const result = mergeRecoveredIntro(main, INTRO_WITH_PREROLL);

  assert.equal(result.recovered, false);
  assert.equal(result.srt, main);
});

test('creates a short silent preroll clip instead of re-encoding the complete video', async () => {
  const calls = [];
  await createIntroPrerollClip({
    ffmpegPath: 'ffmpeg.exe',
    videoPath: 'source.mp4',
    outputPath: 'intro.mp4',
    durationMs: 90_000,
    execFileImpl: async (...args) => calls.push(args)
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ffmpeg.exe');
  assert.deepEqual(calls[0][1].slice(0, 6), [
    '-hide_banner', '-loglevel', 'error', '-i', 'source.mp4', '-vf'
  ]);
  assert.match(calls[0][1][6], /trim=duration=6\.000/);
  assert.match(calls[0][1][6], /tpad=start_duration=0\.750:color=black/);
  assert.equal(calls[0][1].includes('-an'), true);
  assert.equal(calls[0][1].at(-1), 'intro.mp4');
});

test('recovers the missing intro before quality validation and removes temporary files', async () => {
  await withTempDir('ocr-intro-recovery-', async (directory) => {
    const rawPath = path.join(directory, 'ocr-raw.srt');
    await fs.writeFile(rawPath, MAIN_WITH_MISSING_INTRO, 'utf8');
    const progress = [];
    let clipOptions;
    let vseOptions;

    const result = await recoverMissingIntroCue({
      rawPath,
      workDir: directory,
      videoPath: 'source.mp4',
      ffmpegPath: 'ffmpeg.exe',
      durationMs: 10_000,
      executablePath: 'vse-cli.exe',
      language: 'ch',
      mode: 'accurate',
      region: '0.85,1.00,0.00,1.00',
      device: 'cpu',
      createClip: async (options) => {
        clipOptions = options;
        await fs.writeFile(options.outputPath, 'temporary clip');
      },
      runVse: async (options) => {
        vseOptions = options;
        await fs.writeFile(options.outputPath, INTRO_WITH_PREROLL, 'utf8');
        return { kind: 'success' };
      },
      onProgress: (event) => progress.push(event)
    });

    assert.equal(result.reason, 'intro_recovered');
    assert.equal(clipOptions.durationMs, 10_000);
    assert.equal(vseOptions.videoPath, path.join(directory, 'ocr-intro-preroll.mp4'));
    assert.equal(vseOptions.device, 'cpu');
    assert.deepEqual(progress, [{ phase: 'ocr_recovering_intro' }]);
    assert.match(await fs.readFile(rawPath, 'utf8'), /你以为巨齿鲨的咬合力最恐怖\?/u);
    await assert.rejects(fs.access(path.join(directory, 'ocr-intro-preroll.mp4')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(directory, 'ocr-intro-raw.srt')), { code: 'ENOENT' });
  });
});

test('keeps the main OCR result when optional intro recovery fails', async () => {
  await withTempDir('ocr-intro-recovery-', async (directory) => {
    const rawPath = path.join(directory, 'ocr-raw.srt');
    await fs.writeFile(rawPath, MAIN_WITH_MISSING_INTRO, 'utf8');
    const progress = [];

    const result = await recoverMissingIntroCue({
      rawPath,
      workDir: directory,
      videoPath: 'source.mp4',
      ffmpegPath: 'ffmpeg.exe',
      durationMs: 10_000,
      executablePath: 'vse-cli.exe',
      language: 'ch',
      mode: 'auto',
      region: '0.85,1.00,0.00,1.00',
      device: 'gpu',
      createClip: async () => {
        throw new Error('cannot create intro clip');
      },
      runVse: async () => {
        throw new Error('must not run');
      },
      onProgress: (event) => progress.push(event)
    });

    assert.equal(result.reason, 'recovery_failed');
    assert.equal(await fs.readFile(rawPath, 'utf8'), MAIN_WITH_MISSING_INTRO);
    assert.deepEqual(progress.map((event) => event.phase), [
      'ocr_recovering_intro',
      'ocr_intro_recovery_skipped'
    ]);
  });
});
