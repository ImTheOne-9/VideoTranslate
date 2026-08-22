const fs = require('node:fs/promises');
const path = require('node:path');

const ocrComponentManager = require('./ocr-component-manager');
const vseHelper = require('./vse-helper');
const subtitleQuality = require('./subtitle-quality');
const whisperHelper = require('./whisper-helper');
const ocrIntroRecovery = require('./ocr-intro-recovery');
const dynamicOcr = require('./dynamic-ocr');
const viralOcrHelper = require('./viral-ocr-helper');

const DEFAULT_REGION = '0.70,0.98,0.05,0.95';
const DEFAULT_MODE = 'auto';
const OCR_MODES = new Set(['fast', 'auto', 'accurate']);

const defaultDependencies = {
  getOcrComponentStatus: ocrComponentManager.getOcrComponentStatus,
  getOcrExecutablePath: ocrComponentManager.getOcrExecutablePath,
  detectOcrDevice: vseHelper.detectOcrDevice,
  runVse: vseHelper.runVse,
  recoverMissingIntroCue: ocrIntroRecovery.recoverMissingIntroCue,
  evaluateAndCleanSrt: subtitleQuality.evaluateAndCleanSrt,
  extractAudioAndTranscribe: whisperHelper.extractAudioAndTranscribe,
  runViralOcr: viralOcrHelper.runViralOcr
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
    ocrExcludedRegions = [],
    ocrRegionStrategy = 'manual',
    ocrPipeline = 'auto',
    forceWhisper = false,
    ocrOnly = false,
    onProgress
  } = options;
  const deps = { ...defaultDependencies, ...dependencies };
  const reportProgress = createProgressReporter(onProgress);
  const reportPath = path.join(workDir, 'ocr-report.json');

  await fs.mkdir(workDir, { recursive: true });

  const runWhisper = async (reason, preserveOcrReport = false) => {
    if (!preserveOcrReport) await fs.rm(reportPath, { force: true });
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

  const chineseLanguage = typeof ocrLanguage === 'string'
    && ['ch', 'zh', 'zh-cn', 'zh-tw'].includes(ocrLanguage.toLowerCase());
  const normalizedOcrPipeline = ['auto', 'viral', 'vse'].includes(ocrPipeline) ? ocrPipeline : 'auto';
  if (normalizedOcrPipeline === 'viral' && !chineseLanguage) {
    throw invalidOptions('RapidOCR chỉ hỗ trợ tiếng Trung; hãy chọn VSE hoặc đổi ngôn ngữ chữ gốc thành Trung');
  }
  const useViralPipeline = chineseLanguage
    && (normalizedOcrPipeline === 'viral' || normalizedOcrPipeline === 'auto');
  let componentStatus = null;
  let executablePath = null;
  if (!useViralPipeline) {
    componentStatus = deps.getOcrComponentStatus();
    executablePath = deps.getOcrExecutablePath();
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
  }

  // RapidOCR tự tìm và theo dõi vùng chữ toàn khung hình, nên không nhận hay
  // kiểm tra vùng OCR thủ công. VSE mới cần các toạ độ này.
  const region = useViralPipeline ? null : normalizeRegion(ocrRegion);
  const regionStrategy = useViralPipeline ? 'manual' : dynamicOcr.normalizeStrategy(ocrRegionStrategy);
  const mode = normalizeMode(ocrMode);
  const rawPath = path.join(workDir, 'ocr-raw.srt');
  const cleanPath = path.join(workDir, 'ocr-clean.srt');

  reportProgress({ phase: 'ocr_starting' });

  if (useViralPipeline) {
    const rapidDevice = process.env.OCR_DUNG_GPU === '1' ? 'gpu' : 'cpu';
    const runTrackedOcr = async (device) => {
      await removeOcrOutputs(rawPath, cleanPath);
      await fs.rm(reportPath, { force: true });
      reportProgress({ phase: 'ocr_processing' });
      return deps.runViralOcr({
        videoPath,
        outputPath: rawPath,
        reportPath,
        device,
        model: mode === 'accurate' ? 'v6-medium' : 'v6-small',
        excludedRegions: ocrExcludedRegions,
        cwd: workDir,
        onProgress: (detail) => reportProgress({ phase: 'ocr_processing', detail })
      });
    };

    let trackedResult;
    try {
      trackedResult = await runTrackedOcr(rapidDevice);
    } catch (error) {
      if (rapidDevice !== 'gpu' || !error?.retryableOnCpu) throw error;
      reportProgress({ phase: 'ocr_retry_cpu' });
      trackedResult = await runTrackedOcr('cpu');
    }

    let trackedReport = null;
    try {
      trackedReport = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    } catch {
      trackedReport = null;
    }
    const trackedCueCount = Number(trackedReport?.cueCount) || 0;
    const hasTrackedBoxes = Array.isArray(trackedReport?.blurBoxes) && trackedReport.blurBoxes.length > 0;
    const accepted = trackedResult?.kind === 'success' && trackedCueCount >= 3;
    if (!accepted) {
      if (ocrOnly) {
        throw new OcrNoSubtitlesError(trackedCueCount > 0
          ? `RapidOCR chỉ đọc được ${trackedCueCount} câu, chưa đạt tối thiểu 3 câu`
          : 'RapidOCR không tìm thấy phụ đề trong video');
      }
      return runWhisper(trackedCueCount > 0 ? 'ocr_quality_rejected' : 'no_hardsub', hasTrackedBoxes);
    }

    await fs.copyFile(rawPath, cleanPath);
    return {
      path: cleanPath,
      source: 'ocr',
      language: ocrLanguage,
      cueCount: trackedCueCount,
      removedWatermarks: 0,
      reason: 'viral_ocr_accepted'
    };
  }

  const initialDevice = deps.detectOcrDevice();
  const runRegionAttempt = async ({ id, attemptRegion, attemptRawPath, attemptCleanPath }) => {
    let successfulDevice = initialDevice;
    const invoke = async (device) => {
      await removeOcrOutputs(attemptRawPath, attemptCleanPath);
      reportProgress({ phase: 'ocr_processing' });
      return deps.runVse({
        executablePath,
        videoPath,
        outputPath: attemptRawPath,
        language: ocrLanguage,
        mode,
        region: attemptRegion,
        device,
        cwd: workDir,
        onProgress: (detail) => reportProgress({ phase: 'ocr_processing', detail })
      });
    };

    let result;
    try {
      result = await invoke(initialDevice);
    } catch (error) {
      if (initialDevice !== 'gpu' || !error?.retryableOnCpu) throw error;
      reportProgress({ phase: 'ocr_retry_cpu' });
      successfulDevice = 'cpu';
      result = await invoke('cpu');
    }

    const attempt = { id, region: attemptRegion, resultKind: result?.kind || 'success', quality: null };
    if (result?.kind === 'no_subtitles') {
      attempt.reason = 'no_subtitles';
      return attempt;
    }

    await deps.recoverMissingIntroCue({
      rawPath: attemptRawPath,
      workDir,
      videoPath,
      ffmpegPath,
      durationMs,
      executablePath,
      language: ocrLanguage,
      mode,
      region: attemptRegion,
      device: successfulDevice,
      runVse: deps.runVse,
      onProgress: reportProgress
    });

    reportProgress({ phase: 'ocr_validating' });
    attempt.quality = await deps.evaluateAndCleanSrt(attemptRawPath, attemptCleanPath);
    attempt.rawPath = attemptRawPath;
    attempt.cleanPath = attemptCleanPath;
    return attempt;
  };

  const attempts = [await runRegionAttempt({
    id: 'selected',
    attemptRegion: region,
    attemptRawPath: rawPath,
    attemptCleanPath: cleanPath
  })];

  if (
    regionStrategy === 'auto'
    && dynamicOcr.shouldProbeAdditionalRegions(attempts[0].quality, durationMs)
  ) {
    for (const candidate of dynamicOcr.buildRegionCandidates(region)) {
      reportProgress({ phase: 'ocr_region_scan', detail: candidate });
      attempts.push(await runRegionAttempt({
        id: candidate.id,
        attemptRegion: candidate.region,
        attemptRawPath: path.join(workDir, `ocr-raw-${candidate.id}.srt`),
        attemptCleanPath: path.join(workDir, `ocr-clean-${candidate.id}.srt`)
      }));
    }
  }

  const selectedAttempt = dynamicOcr.chooseBestAttempt(attempts);
  if (!selectedAttempt) {
    const onlyNoSubtitles = attempts.every((attempt) => attempt.resultKind === 'no_subtitles');
    if (ocrOnly) {
      throw new OcrNoSubtitlesError(onlyNoSubtitles
        ? 'OCR không tìm thấy phụ đề trong video'
        : 'Kết quả OCR không đạt kiểm tra chất lượng');
    }
    return runWhisper(onlyNoSubtitles ? 'no_hardsub' : 'ocr_quality_rejected');
  }

  if (selectedAttempt.cleanPath !== cleanPath) {
    try {
      await fs.copyFile(selectedAttempt.cleanPath, cleanPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  await dynamicOcr.writeOcrReport(reportPath, {
    strategy: regionStrategy,
    selectedRegion: selectedAttempt.region,
    subtitlePath: cleanPath,
    quality: selectedAttempt.quality,
    attempts
  });

  const quality = selectedAttempt.quality;

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
