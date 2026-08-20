const fs = require('fs');
const path = require('path');
const {
  AUDIO_NORMALIZATION_VERSION,
  analyzeWavFile,
  buildVoiceNormalizationFilters
} = require('./audio-quality');
const { readPcm16WavFile } = require('./audio-quality');
const { getCrawlerPaths, crawlerEnvironment } = require('./crawler-paths');

function readWavDurationMs(filePath) {
  return analyzeWavFile(filePath).durationMs;
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
    normalizationOptions = {},
    label = 'Audio segment',
    logger = console,
    audioStretchy = null
  } = options;
  if (!rawPath || !fs.existsSync(rawPath)) {
    throw new Error(`Không tìm thấy audio gốc cho ${label}`);
  }
  if (!outputPath || path.resolve(outputPath) === path.resolve(rawPath)) {
    throw new Error('Audio Smart Fit phải được lưu riêng với audio gốc');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp.wav`;
  const stretchedPath = `${outputPath}.stretch.tmp.wav`;
  try {
    fs.rmSync(tempPath, { force: true });
    fs.rmSync(stretchedPath, { force: true });
    let processingInput = rawPath;
    let stretchEngine = 'ffmpeg-atempo';
    const requestedSpeed = Number(fitPlan?.speed) || 1;
    if (requestedSpeed > 1.001 && typeof audioStretchy === 'function') {
      try {
        const stretched = await audioStretchy({
          inputPath: rawPath,
          outputPath: stretchedPath,
          speed: requestedSpeed,
          runExecFile
        });
        if (stretched && fs.existsSync(stretchedPath)) {
          const quality = analyzeWavFile(stretchedPath);
          if (!quality.warnings.includes('audio_silent') && quality.durationMs >= 80) {
            processingInput = stretchedPath;
            stretchEngine = 'audiostretchy';
          }
        }
      } catch (error) {
        logger.warn(`[Smart Fit] AudioStretchy lỗi, dùng FFmpeg atempo: ${error.message}`);
      }
    }
    const filters = processingInput === rawPath ? buildAtempoFilters(requestedSpeed) : [];
    if (Number(fitPlan?.trimmedMs) > 0) {
      const durationSeconds = Math.max(0.001, Number(fitPlan.fittedDurationMs) / 1000);
      filters.push(`atrim=duration=${durationSeconds.toFixed(3)}`);
    }
    filters.push(...buildVoiceNormalizationFilters({
      ...normalizationOptions,
      durationMs: Number(fitPlan?.fittedDurationMs) || readWavDurationMs(rawPath)
    }));

    logger.log(
      `[Smart Fit] ${label}: ${fitPlan.status}, speed=${Number(fitPlan.speed).toFixed(3)}x,`
      + ` stretch=${stretchEngine}, normalize=v${AUDIO_NORMALIZATION_VERSION}`
    );
    await runExecFile(ffmpegPath, [
      '-i', processingInput,
      '-filter:a', filters.join(','),
      '-c:a', 'pcm_s16le',
      '-y', tempPath
    ]);
    if (!fs.existsSync(tempPath)) throw new Error(`Không thể tạo Smart Fit cho ${label}`);
    fs.copyFileSync(tempPath, outputPath);
    return readWavDurationMs(outputPath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

async function stretchVoiceWithAudioStretchy(options = {}) {
  if (process.env.DUB_STRETCH === 'ffmpeg') return false;
  const paths = getCrawlerPaths();
  const bridgePath = path.join(paths.appRoot, 'audio_stretch_bridge.py');
  if (!fs.existsSync(paths.python) || !fs.existsSync(bridgePath)) return false;
  const speed = Math.max(0.5, Number(options.speed) || 1);
  await options.runExecFile(paths.python, [
    bridgePath,
    '--input', options.inputPath,
    '--output', options.outputPath,
    '--ratio', (1 / speed).toFixed(6)
  ], {
    windowsHide: true,
    timeout: 120000,
    env: crawlerEnvironment(paths)
  });
  return fs.existsSync(options.outputPath);
}

function buildSilenceCompactionFilter(options = {}) {
  const threshold = options.threshold || '-40dB';
  const internalKeepSeconds = Math.max(0.05, Number(options.internalKeepSeconds) || 0.18);
  return [
    'silenceremove=start_periods=1',
    'start_duration=0.02',
    `start_threshold=${threshold}`,
    'start_silence=0.06',
    'stop_periods=-1',
    'stop_duration=0.30',
    `stop_threshold=${threshold}`,
    `stop_silence=${internalKeepSeconds.toFixed(2)}`
  ].join(':');
}

function isNarrationAudioUsable(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const quality = analyzeWavFile(filePath);
    const minimumDurationMs = Math.max(60, Number(options.minimumDurationMs) || 100);
    const minimumRmsDbfs = Number.isFinite(Number(options.minimumRmsDbfs))
      ? Number(options.minimumRmsDbfs) : -50;
    const minimumPeakDbfs = Number.isFinite(Number(options.minimumPeakDbfs))
      ? Number(options.minimumPeakDbfs) : -42;
    return quality.durationMs >= minimumDurationMs
      && !quality.warnings.includes('audio_silent')
      && Number(quality.rmsDbfs) > minimumRmsDbfs
      && Number(quality.peakDbfs) > minimumPeakDbfs;
  } catch (_) {
    return false;
  }
}

function writePcm16Wav(filePath, wav, pcmBuffer) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(wav.channels, 22);
  header.writeUInt32LE(wav.sampleRate, 24);
  header.writeUInt32LE(wav.sampleRate * wav.blockAlign, 28);
  header.writeUInt16LE(wav.blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(pcmBuffer.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

function compactPcmSilence(inputPath, outputPath, options = {}) {
  const wav = readPcm16WavFile(inputPath);
  const windowMs = Math.max(5, Number(options.windowMs) || 20);
  const padMs = Math.max(0, Number(options.padMs) || 60);
  const internalKeepMs = Math.max(20, Number(options.internalKeepMs) || 180);
  const relativeDb = Math.min(-1, Number(options.relativeDb) || -40);
  const frameCount = Math.floor(wav.pcmBuffer.length / wav.blockAlign);
  const framesPerWindow = Math.max(1, Math.round(wav.sampleRate * windowMs / 1000));
  const windows = [];
  let peak = 0;
  for (let frameStart = 0; frameStart < frameCount; frameStart += framesPerWindow) {
    const frameEnd = Math.min(frameCount, frameStart + framesPerWindow);
    let sum = 0;
    let samples = 0;
    for (let frame = frameStart; frame < frameEnd; frame += 1) {
      for (let channel = 0; channel < wav.channels; channel += 1) {
        sum += Math.abs(wav.pcmBuffer.readInt16LE(frame * wav.blockAlign + channel * 2));
        samples += 1;
      }
    }
    const energy = samples ? sum / samples : 0;
    peak = Math.max(peak, energy);
    windows.push({ frameStart, frameEnd, energy });
  }
  if (peak < 1 || windows.length < 3) return false;
  const threshold = peak * Math.pow(10, relativeDb / 20);
  const speech = windows.map(window => window.energy > threshold);
  const first = speech.indexOf(true);
  const last = speech.lastIndexOf(true);
  if (first < 0 || last < first) return false;
  const padWindows = Math.round(padMs / windowMs);
  const keepWindows = Math.max(1, Math.round(internalKeepMs / windowMs));
  const low = Math.max(0, first - padWindows);
  const high = Math.min(windows.length - 1, last + padWindows);
  const keep = new Array(windows.length).fill(false);
  for (let index = low; index <= high; index += 1) keep[index] = true;
  for (let index = low; index <= high;) {
    if (speech[index]) { index += 1; continue; }
    let end = index;
    while (end <= high && !speech[end]) end += 1;
    const gapLength = end - index;
    if (gapLength > keepWindows) {
      const removeStart = index + Math.floor(keepWindows / 2);
      const removeEnd = end - Math.ceil(keepWindows / 2);
      for (let cursor = removeStart; cursor < removeEnd; cursor += 1) keep[cursor] = false;
    }
    index = end;
  }
  const chunks = [];
  for (let index = low; index <= high; index += 1) {
    if (!keep[index]) continue;
    const window = windows[index];
    chunks.push(wav.pcmBuffer.subarray(
      window.frameStart * wav.blockAlign,
      window.frameEnd * wav.blockAlign
    ));
  }
  const output = Buffer.concat(chunks);
  const minimumBytes = Math.round(wav.sampleRate * 0.1) * wav.blockAlign;
  if (output.length < minimumBytes || output.length >= wav.pcmBuffer.length) return false;
  writePcm16Wav(outputPath, wav, output);
  return true;
}

async function trimVoiceSilence(options = {}) {
  const {
    inputPath,
    ffmpegPath,
    runExecFile,
    logger = console
  } = options;
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('Không tìm thấy WAV cần cắt khoảng lặng');
  }
  const originalQuality = analyzeWavFile(inputPath);
  if (originalQuality.durationMs < 120) return originalQuality.durationMs;

  const tempPath = `${inputPath}.trim.tmp.wav`;
  try {
    fs.rmSync(tempPath, { force: true });
    if (compactPcmSilence(inputPath, tempPath)) {
      const trimmedQuality = analyzeWavFile(tempPath);
      if (trimmedQuality.durationMs >= 100 && !trimmedQuality.warnings.includes('audio_silent')) {
        fs.copyFileSync(tempPath, inputPath);
        return trimmedQuality.durationMs;
      }
      fs.rmSync(tempPath, { force: true });
    }
    await runExecFile(ffmpegPath, [
      '-i', inputPath,
      '-af', buildSilenceCompactionFilter(),
      '-ar', '24000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-y', tempPath
    ]);
    if (!fs.existsSync(tempPath)) return originalQuality.durationMs;
    const trimmedQuality = analyzeWavFile(tempPath);
    if (trimmedQuality.durationMs < 100 || trimmedQuality.warnings.includes('audio_silent')) {
      logger.warn('[Dubbing] Bỏ qua kết quả cắt khoảng lặng không hợp lệ.');
      return originalQuality.durationMs;
    }
    fs.copyFileSync(tempPath, inputPath);
    return trimmedQuality.durationMs;
  } catch (error) {
    logger.warn(`[Dubbing] Không cắt được khoảng lặng, giữ WAV gốc: ${error.message}`);
    return originalQuality.durationMs;
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

async function normalizeVoiceTrackFast(options = {}) {
  const inputPath = options.inputPath;
  const ffmpegPath = options.ffmpegPath;
  const runExecFile = options.runExecFile;
  const targetLufs = Number.isFinite(Number(options.targetLufs)) ? Number(options.targetLufs) : -16;
  const truePeakDb = Number.isFinite(Number(options.truePeakDb)) ? Number(options.truePeakDb) : -1.5;
  const logger = options.logger || console;
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('Không tìm thấy track giọng cần chuẩn hóa');
  const outputPath = `${inputPath}.loudness.tmp.wav`;
  try {
    let measuredLufs = null;
    if (process.env.DUB_LOUDNORM !== '1') {
      try {
        const measured = await runExecFile(ffmpegPath, [
          '-v', 'info', '-i', inputPath, '-af', 'ebur128=peak=true', '-f', 'null', '-'
        ]);
        const matches = [...String(measured.stderr || '').matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)];
        if (matches.length) measuredLufs = Number(matches.at(-1)[1]);
      } catch (_) {
        measuredLufs = null;
      }
    }
    const limiter = Math.pow(10, truePeakDb / 20).toFixed(4);
    const filter = Number.isFinite(measuredLufs) && measuredLufs > -70
      ? `volume=${(targetLufs - measuredLufs).toFixed(2)}dB,alimiter=limit=${limiter}:level=false`
      : `loudnorm=I=${targetLufs.toFixed(1)}:TP=${truePeakDb}:LRA=11`;
    await runExecFile(ffmpegPath, [
      '-y', '-i', inputPath, '-af', filter,
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', outputPath
    ]);
    if (!isNarrationAudioUsable(outputPath, { minimumRmsDbfs: -45, minimumPeakDbfs: -36 })) {
      throw new Error('Track sau chuẩn hóa bị câm hoặc quá yếu');
    }
    fs.copyFileSync(outputPath, inputPath);
    logger.log(
      `[Dubbing] Chuẩn hóa track giọng ${targetLufs.toFixed(1)} LUFS bằng `
      + `${Number.isFinite(measuredLufs) ? 'ebur128 + gain + limiter' : 'loudnorm fallback'}.`
    );
    return { measuredLufs, targetLufs, method: Number.isFinite(measuredLufs) ? 'ebur128' : 'loudnorm' };
  } finally {
    try { fs.rmSync(outputPath, { force: true }); } catch {}
  }
}

module.exports = {
  buildAtempoFilters,
  buildSilenceCompactionFilter,
  compactPcmSilence,
  createFittedVoiceChunk,
  isNarrationAudioUsable,
  normalizeVoiceTrackFast,
  readWavDurationMs,
  stretchVoiceWithAudioStretchy,
  trimVoiceSilence
};
