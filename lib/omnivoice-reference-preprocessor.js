'use strict';

const fs = require('fs');
const path = require('path');

const TARGET_SECONDS = 10;
const MAX_SECONDS = 12;
const MIN_SILENCE_CUT_SECONDS = 6;

function parseDuration(output) {
  const value = Number(String(output || '').trim().split(/\r?\n/).find(Boolean));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseSilenceStarts(output) {
  return [...String(output || '').matchAll(/silence_start:\s*([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= MIN_SILENCE_CUT_SECONDS);
}

async function probeDuration({ inputPath, ffprobePath, runExecFile }) {
  try {
    const result = await runExecFile(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath
    ]);
    return parseDuration(result.stdout);
  } catch (_) {
    return 0;
  }
}

async function normalizeReference({ inputPath, outputPath, ffmpegPath, runExecFile, trim }) {
  const args = ['-y', '-i', inputPath];
  if (trim) {
    args.push(
      '-af', 'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-38dB',
      '-t', String(TARGET_SECONDS)
    );
  }
  args.push('-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', outputPath);
  await runExecFile(ffmpegPath, args);
}

async function trimToLastSilence({ outputPath, ffmpegPath, ffprobePath, runExecFile }) {
  let detected = null;
  try {
    detected = await runExecFile(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', outputPath,
      '-af', 'silencedetect=noise=-35dB:d=0.10', '-f', 'null', '-'
    ]);
  } catch (error) {
    detected = { stdout: error.stdout || '', stderr: error.stderr || '' };
  }
  const silenceStarts = parseSilenceStarts(`${detected?.stdout || ''}\n${detected?.stderr || ''}`);
  if (!silenceStarts.length) return { silenceAware: false, cutAt: null };
  const duration = await probeDuration({ inputPath: outputPath, ffprobePath, runExecFile });
  const silenceStart = Math.max(...silenceStarts);
  if (!duration || silenceStart >= duration - 0.05) return { silenceAware: false, cutAt: null };
  const cutAt = Math.min(silenceStart + 0.15, duration);
  const temporaryPath = `${outputPath}.silence.wav`;
  try {
    await runExecFile(ffmpegPath, [
      '-y', '-i', outputPath, '-t', cutAt.toFixed(3),
      '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', temporaryPath
    ]);
    const trimmedDuration = await probeDuration({ inputPath: temporaryPath, ffprobePath, runExecFile });
    if (trimmedDuration < 3) return { silenceAware: false, cutAt: null };
    fs.rmSync(outputPath, { force: true });
    fs.renameSync(temporaryPath, outputPath);
    return { silenceAware: true, cutAt };
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

async function prepareOmnivoiceReference(options = {}) {
  const { inputPath, outputPath, ffmpegPath, ffprobePath, runExecFile } = options;
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('Không tìm thấy file giọng mẫu OmniVoice');
  if (!outputPath || !ffmpegPath || !ffprobePath || typeof runExecFile !== 'function') {
    throw new Error('Thiếu công cụ tiền xử lý giọng mẫu OmniVoice');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const sourceDuration = await probeDuration({ inputPath, ffprobePath, runExecFile });
  const shouldTrim = sourceDuration > MAX_SECONDS;
  try {
    await normalizeReference({ inputPath, outputPath, ffmpegPath, runExecFile, trim: shouldTrim });
  } catch (error) {
    if (!shouldTrim) throw error;
    await runExecFile(ffmpegPath, [
      '-y', '-i', inputPath, '-t', String(TARGET_SECONDS),
      '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', outputPath
    ]);
  }
  const normalizedDuration = await probeDuration({ inputPath: outputPath, ffprobePath, runExecFile });
  if (normalizedDuration < 1) throw new Error('Giọng mẫu sau chuẩn hóa quá ngắn hoặc không hợp lệ');
  const silence = shouldTrim
    ? await trimToLastSilence({ outputPath, ffmpegPath, ffprobePath, runExecFile })
    : { silenceAware: false, cutAt: null };
  return {
    outputPath,
    sourceDuration,
    duration: await probeDuration({ inputPath: outputPath, ffprobePath, runExecFile }),
    trimmed: shouldTrim,
    silenceAware: silence.silenceAware,
    cutAt: silence.cutAt,
    sampleRate: 24000
  };
}

module.exports = {
  MAX_SECONDS,
  MIN_SILENCE_CUT_SECONDS,
  TARGET_SECONDS,
  parseDuration,
  parseSilenceStarts,
  prepareOmnivoiceReference
};
