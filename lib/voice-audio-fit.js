const fs = require('fs');
const path = require('path');

function readWavDurationMs(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(44);
  fs.readSync(fd, header, 0, 44, 0);
  fs.closeSync(fd);
  const sampleRate = header.readUInt32LE(24);
  const channels = header.readUInt16LE(22);
  const bitsPerSample = header.readUInt16LE(34);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return bytesPerSecond > 0 ? Math.round(((stat.size - 44) / bytesPerSecond) * 1000) : 0;
}

function buildAtempoFilters(speed) {
  let remaining = Math.max(0.01, Number(speed) || 1);
  const filters = [];
  while (remaining > 2) {
    filters.push('atempo=2.0');
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 0.001) {
    filters.push(`atempo=${remaining.toFixed(3)}`);
  }
  return filters;
}

async function createFittedVoiceChunk(options) {
  const {
    rawPath,
    outputPath,
    fitPlan,
    ffmpegPath,
    runExecFile,
    label = 'Audio segment',
    logger = console
  } = options;
  if (!rawPath || !fs.existsSync(rawPath)) {
    throw new Error(`Không tìm thấy audio gốc cho ${label}`);
  }
  if (!outputPath || path.resolve(outputPath) === path.resolve(rawPath)) {
    throw new Error('Audio Smart Fit phải được lưu riêng với audio gốc');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp.wav`;
  try {
    fs.rmSync(tempPath, { force: true });
    const filters = buildAtempoFilters(fitPlan?.speed);
    if (Number(fitPlan?.trimmedMs) > 0) {
      const durationSeconds = Math.max(0.001, Number(fitPlan.fittedDurationMs) / 1000);
      filters.push(`atrim=duration=${durationSeconds.toFixed(3)}`);
      const fadeDuration = Math.min(0.03, durationSeconds / 2);
      const fadeStart = Math.max(0, durationSeconds - fadeDuration);
      filters.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}`);
    }

    if (!filters.length) {
      fs.copyFileSync(rawPath, tempPath);
    } else {
      logger.log(
        `[Smart Fit] ${label}: ${fitPlan.status}, speed=${Number(fitPlan.speed).toFixed(3)}x`
      );
      await runExecFile(ffmpegPath, [
        '-i', rawPath,
        '-filter:a', filters.join(','),
        '-c:a', 'pcm_s16le',
        '-y', tempPath
      ]);
    }
    if (!fs.existsSync(tempPath)) throw new Error(`Không thể tạo Smart Fit cho ${label}`);
    fs.copyFileSync(tempPath, outputPath);
    return readWavDurationMs(outputPath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

module.exports = {
  buildAtempoFilters,
  createFittedVoiceChunk,
  readWavDurationMs
};
