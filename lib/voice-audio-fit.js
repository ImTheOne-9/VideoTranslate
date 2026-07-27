const fs = require('fs');

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

async function fitVoiceChunkToDuration(options) {
  const {
    filePath,
    maxDurationMs,
    ffmpegPath,
    runExecFile,
    label = 'Audio segment',
    logger = console
  } = options;
  const actualDurationMs = readWavDurationMs(filePath);
  if (actualDurationMs <= maxDurationMs) return actualDurationMs;

  const speedUpRatio = actualDurationMs / maxDurationMs;
  logger.log(
    `[Voice Fit] ${label} dài hơn cue (${actualDurationMs}ms > ${maxDurationMs}ms). `
    + `Tăng tốc ${speedUpRatio.toFixed(2)}x.`
  );
  const tempPath = filePath.replace(/\.wav$/i, '_speedup.wav');
  let remainingRatio = speedUpRatio;
  const filters = [];
  while (remainingRatio > 2.0) {
    filters.push('atempo=2.0');
    remainingRatio /= 2.0;
  }
  if (remainingRatio > 0.5) filters.push(`atempo=${remainingRatio.toFixed(3)}`);
  await runExecFile(ffmpegPath, [
    '-i', filePath,
    '-filter:a', filters.join(','),
    '-y', tempPath
  ]);
  if (!fs.existsSync(tempPath)) throw new Error(`Không thể tăng tốc ${label}`);
  fs.copyFileSync(tempPath, filePath);
  fs.unlinkSync(tempPath);
  return readWavDurationMs(filePath);
}

module.exports = {
  fitVoiceChunkToDuration,
  readWavDurationMs
};
