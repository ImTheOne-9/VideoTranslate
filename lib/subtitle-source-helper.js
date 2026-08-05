const fs = require('node:fs/promises');
const path = require('node:path');

const ocrComponentManager = require('./ocr-component-manager');
const vseHelper = require('./vse-helper');
const subtitleQuality = require('./subtitle-quality');
const whisperHelper = require('./whisper-helper');

const DEFAULT_REGION = '0.70,0.98,0.05,0.95';
const DEFAULT_MODE = 'auto';
const OCR_MODES = new Set(['fast', 'auto', 'accurate']);

const defaultDependencies = {
  getOcrComponentStatus: ocrComponentManager.getOcrComponentStatus,
  getOcrExecutablePath: ocrComponentManager.getOcrExecutablePath,
  detectOcrDevice: vseHelper.detectOcrDevice,
  runVse: vseHelper.runVse,
  evaluateAndCleanSrt: subtitleQuality.evaluateAndCleanSrt,
  extractAudioAndTranscribe: whisperHelper.extractAudioAndTranscribe
};

class OcrComponentRequiredError extends Error {
  constructor(message = 'OCR component is required') {
    super(message);
    this.name = 'OcrComponentRequiredError';
    this.code = 'OCR_COMPONENT_REQUIRED';
  }
}

class OcrNoSubtitlesError extends Error {
  constructor(message = 'OCR không tìm thấy phụ đề đạt chất lượng') {
    super(message);
    this.name = 'OcrNoSubtitlesError';
    this.code = 'OCR_NO_SUBTITLES';
  }
}

function invalidOptions(message) {
  const error = new Error(message);
  error.name = 'OcrInvalidOptionsError';
  error.code = 'OCR_INVALID_OPTIONS';
  return error;
}

function normalizeRegion(region) {
  if (region === undefined) return DEFAULT_REGION;

  let values;
  if (typeof region === 'string') {
    const parts = region.split(',').map((part) => part.trim());
    if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
      throw invalidOptions('OCR region must contain four numbers');
    }
    values = parts.map(Number);
  } else if (Array.isArray(region) && region.length === 4) {
    values = [...region];
  } else {
    throw invalidOptions('OCR region must be a comma string or four-value array');
  }

  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw invalidOptions('OCR region values must be finite numbers from 0 to 1');
  }

  const [top, bottom, left, right] = values;
  if (top >= bottom || left >= right) {
    throw invalidOptions('OCR region must have top < bottom and left < right');
  }

  return values.join(',');
}

function normalizeMode(mode) {
  if (mode === undefined || mode === null || mode === '') return DEFAULT_MODE;
  if (typeof mode !== 'string' || !OCR_MODES.has(mode)) {
    throw invalidOptions(`Unsupported OCR mode: ${mode}`);
  }
  return mode;
}

function createProgressReporter(onProgress) {
  if (typeof onProgress !== 'function') return () => {};

  return (event) => {
    try {
      const callbackResult = onProgress(event);
      if (callbackResult && typeof callbackResult.catch === 'function') {
        callbackResult.catch(() => {});
      }
    } catch {
      // Progress reporting is observational and cannot interrupt subtitle generation.
    }
  };
}

async function removeOcrOutputs(rawPath, cleanPath) {
  await Promise.all([
    fs.rm(rawPath, { force: true }),
    fs.rm(cleanPath, { force: true })
  ]);
}

function whisperResult(subtitlePath, language, reason) {
  return {
    path: subtitlePath,
    source: 'whisper',
    language,
    cueCount: 0,
    removedWatermarks: 0,
    reason
  };
}

async function resolveAutomaticSubtitle(options, dependencies = {}) {
  const {
    videoPath,
    workDir,
    ffmpegPath,
    durationMs,
    whisperModel,
    whisperOnnxVariant = 'q8',
    whisperLanguage,
    whisperTimestampLevel = 'segment',
    whisperDevice = 'cpu',
    ocrLanguage,
    ocrMode,
    ocrRegion,
    forceWhisper = false,
    ocrOnly = false,
    onProgress
  } = options;
  const deps = { ...defaultDependencies, ...dependencies };
  const reportProgress = createProgressReporter(onProgress);

  await fs.mkdir(workDir, { recursive: true });

  const runWhisper = async (reason) => {
    reportProgress({ phase: 'whisper_fallback' });
    const whisperArgs = [
      videoPath,
      workDir,
      ffmpegPath,
      whisperModel,
      durationMs,
      ocrLanguage,
      whisperOnnxVariant
    ];
    if (whisperLanguage !== undefined || whisperTimestampLevel !== 'segment') {
      whisperArgs.push(whisperLanguage);
    }
    if (whisperTimestampLevel !== 'segment') whisperArgs.push(whisperTimestampLevel);
    if (whisperDevice !== 'cpu') {
      if (whisperTimestampLevel === 'segment') whisperArgs.push('segment');
      whisperArgs.push(whisperDevice);
    }
    const subtitlePath = await deps.extractAudioAndTranscribe(...whisperArgs);
    return whisperResult(subtitlePath, whisperLanguage || ocrLanguage, reason);
  };

  if (forceWhisper) {
    return runWhisper('forced_whisper');
  }

  const componentStatus = deps.getOcrComponentStatus();
  const executablePath = deps.getOcrExecutablePath();
  if (
    componentStatus?.status !== 'ready'
    || typeof executablePath !== 'string'
    || executablePath.trim().length === 0
  ) {
    throw new OcrComponentRequiredError();
  }

  if (
    typeof ocrLanguage !== 'string'
    || ocrLanguage.length === 0
    || !Array.isArray(componentStatus.supportedLanguages)
    || !componentStatus.supportedLanguages.includes(ocrLanguage)
  ) {
    throw invalidOptions(`Unsupported OCR language: ${ocrLanguage}`);
  }

  const region = normalizeRegion(ocrRegion);
  const mode = normalizeMode(ocrMode);
  const rawPath = path.join(workDir, 'ocr-raw.srt');
  const cleanPath = path.join(workDir, 'ocr-clean.srt');
  const initialDevice = deps.detectOcrDevice();

  reportProgress({ phase: 'ocr_starting' });

  const runOcrAttempt = async (device) => {
    await removeOcrOutputs(rawPath, cleanPath);
    reportProgress({ phase: 'ocr_processing' });
    return deps.runVse({
      executablePath,
      videoPath,
      outputPath: rawPath,
      language: ocrLanguage,
      mode,
      region,
      device,
      cwd: workDir,
      onProgress: (detail) => reportProgress({ phase: 'ocr_processing', detail })
    });
  };

  let ocrResult;
  try {
    ocrResult = await runOcrAttempt(initialDevice);
  } catch (error) {
    if (initialDevice !== 'gpu' || !error?.retryableOnCpu) throw error;
    reportProgress({ phase: 'ocr_retry_cpu' });
    ocrResult = await runOcrAttempt('cpu');
  }

  if (ocrResult?.kind === 'no_subtitles') {
    if (ocrOnly) throw new OcrNoSubtitlesError('OCR không tìm thấy phụ đề trong video');
    return runWhisper('no_hardsub');
  }

  reportProgress({ phase: 'ocr_validating' });
  const quality = await deps.evaluateAndCleanSrt(rawPath, cleanPath);
  if (!quality.accepted) {
    if (ocrOnly) throw new OcrNoSubtitlesError('Kết quả OCR không đạt kiểm tra chất lượng');
    return runWhisper('ocr_quality_rejected');
  }

  return {
    path: cleanPath,
    source: 'ocr',
    language: ocrLanguage,
    cueCount: quality.cueCount,
    removedWatermarks: Array.isArray(quality.removedRepeatedLines)
      ? quality.removedRepeatedLines.length
      : 0,
    reason: 'ocr_accepted'
  };
}

module.exports = {
  OcrComponentRequiredError,
  OcrNoSubtitlesError,
  resolveAutomaticSubtitle
};
