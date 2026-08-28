const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const SrtParser = require('srt-parser-2').default;

const execFileAsync = promisify(execFile);
const INTRO_PREROLL_MS = 750;
const INTRO_SCAN_MS = 6_000;
const INTRO_GAP_THRESHOLD_MS = 500;
const INTRO_START_TOLERANCE_MS = 250;
const INTRO_END_TOLERANCE_MS = 250;

function parseTimestamp(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) return null;
  return (((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000)
    + Number(milliseconds.padEnd(3, '0'));
}

function formatTimestamp(milliseconds) {
  const safeMilliseconds = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safeMilliseconds / 3_600_000);
  const minutes = Math.floor((safeMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMilliseconds % 60_000) / 1_000);
  const millis = safeMilliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function parseTimedCues(srt) {
  const parser = new SrtParser();
  let cues;
  try {
    cues = parser.fromSrt(srt);
  } catch {
    return [];
  }
  return cues.flatMap((cue) => {
    const start = parseTimestamp(cue.startTime);
    const end = parseTimestamp(cue.endTime);
    if (start === null || end === null || end <= start || !String(cue.text ?? '').trim()) return [];
    return [{ start, end, text: cue.text }];
  });
}

function mergeRecoveredIntro(mainSrt, introSrt, options = {}) {
  const prerollMs = options.prerollMs ?? INTRO_PREROLL_MS;
  const mainCues = parseTimedCues(mainSrt);
  const introCues = parseTimedCues(introSrt);
  if (mainCues.length === 0 || introCues.length === 0) {
    return { recovered: false, srt: mainSrt, recoveredCueCount: 0 };
  }

  const firstMainStart = mainCues[0].start;
  if (firstMainStart <= INTRO_GAP_THRESHOLD_MS) {
    return { recovered: false, srt: mainSrt, recoveredCueCount: 0 };
  }

  const candidates = introCues.flatMap((cue) => {
    const start = Math.max(0, cue.start - prerollMs);
    const detectedEnd = cue.end - prerollMs;
    if (
      start > INTRO_START_TOLERANCE_MS
      || detectedEnd > firstMainStart + INTRO_END_TOLERANCE_MS
    ) {
      return [];
    }
    const end = Math.min(firstMainStart, detectedEnd);
    if (end <= start) return [];
    return [{ start, end, text: cue.text }];
  });

  if (candidates.length === 0) {
    return { recovered: false, srt: mainSrt, recoveredCueCount: 0 };
  }

  const recoveredCue = candidates.reduce((latest, cue) => (
    !latest || cue.end > latest.end ? cue : latest
  ), null);
  const parser = new SrtParser();
  const outputCues = [recoveredCue, ...mainCues].map((cue, index) => ({
    id: String(index + 1),
    startTime: formatTimestamp(cue.start),
    endTime: formatTimestamp(cue.end),
    text: cue.text
  }));
  return {
    recovered: true,
    srt: parser.toSrt(outputCues),
    recoveredCueCount: 1
  };
}

async function createIntroPrerollClip({ ffmpegPath, videoPath, outputPath, durationMs, execFileImpl }) {
  const introDurationMs = Number.isFinite(durationMs) && durationMs > 0
    ? Math.min(INTRO_SCAN_MS, durationMs)
    : INTRO_SCAN_MS;
  const filter = [
    `trim=duration=${(introDurationMs / 1000).toFixed(3)}`,
    'setpts=PTS-STARTPTS',
    `tpad=start_duration=${(INTRO_PREROLL_MS / 1000).toFixed(3)}:color=black`
  ].join(',');
  const run = execFileImpl || execFileAsync;
  await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', videoPath,
    '-vf', filter,
    '-an',
    '-map_metadata', '-1',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '18',
    '-y', outputPath
  ], {
    windowsHide: true,
    timeout: 2 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024
  });
}

async function recoverMissingIntroCue(options) {
  const {
    rawPath,
    workDir,
    videoPath,
    ffmpegPath,
    durationMs,
    executablePath,
    language,
    mode,
    region,
    device,
    runVse,
    onProgress,
    createClip = createIntroPrerollClip
  } = options;

  let mainSrt;
  try {
    mainSrt = await fs.readFile(rawPath, 'utf8');
  } catch {
    return { recovered: false, recoveredCueCount: 0, reason: 'missing_raw' };
  }
  const mainCues = parseTimedCues(mainSrt);
  if (mainCues.length === 0 || mainCues[0].start <= INTRO_GAP_THRESHOLD_MS) {
    return { recovered: false, recoveredCueCount: 0, reason: 'intro_already_present' };
  }

  const clipPath = path.join(workDir, 'ocr-intro-preroll.mp4');
  const introRawPath = path.join(workDir, 'ocr-intro-raw.srt');
  onProgress?.({ phase: 'ocr_recovering_intro' });
  try {
    await Promise.all([
      fs.rm(clipPath, { force: true }),
      fs.rm(introRawPath, { force: true })
    ]);
    await createClip({ ffmpegPath, videoPath, outputPath: clipPath, durationMs });
    const result = await runVse({
      executablePath,
      videoPath: clipPath,
      outputPath: introRawPath,
      language,
      mode,
      region,
      device,
      cwd: workDir
    });
    if (result?.kind === 'no_subtitles') {
      return { recovered: false, recoveredCueCount: 0, reason: 'intro_not_detected' };
    }
    const introSrt = await fs.readFile(introRawPath, 'utf8');
    const merged = mergeRecoveredIntro(mainSrt, introSrt);
    if (!merged.recovered) {
      return { ...merged, reason: 'no_safe_intro_candidate' };
    }
    await fs.writeFile(rawPath, merged.srt, 'utf8');
    return { ...merged, reason: 'intro_recovered' };
  } catch (error) {
    onProgress?.({
      phase: 'ocr_intro_recovery_skipped',
      detail: { message: error?.message || String(error) }
    });
    return { recovered: false, recoveredCueCount: 0, reason: 'recovery_failed' };
  } finally {
    await Promise.allSettled([
      fs.rm(clipPath, { force: true }),
      fs.rm(introRawPath, { force: true })
    ]);
  }
}

module.exports = {
  INTRO_PREROLL_MS,
  createIntroPrerollClip,
  mergeRecoveredIntro,
  recoverMissingIntroCue
};
