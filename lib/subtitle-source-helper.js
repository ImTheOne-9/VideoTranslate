const fs = require('node:fs/promises');
const path = require('node:path');
const SrtParser = require('srt-parser-2').default;

const ocrComponentManager = require('./ocr-component-manager');
const vseHelper = require('./vse-helper');
const subtitleQuality = require('./subtitle-quality');
const whisperHelper = require('./whisper-helper');
const capCutAsr = require('./capcut-asr-helper');
const ocrIntroRecovery = require('./ocr-intro-recovery');
const dynamicOcr = require('./dynamic-ocr');
const viralOcrHelper = require('./viral-ocr-helper');
const { verifySubtitleLanguage } = require('./subtitle-language-detector');

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
  detectSpokenLanguage: whisperHelper.detectSpokenLanguage,
  extractAudioAndTranscribe: whisperHelper.extractAudioAndTranscribe,
  runCapCutAsr: capCutAsr.transcribeToSrt,
  probeChineseHardsub: viralOcrHelper.probeChineseHardsub,
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

const SOURCE_LANGUAGE_ALIASES = Object.freeze({
  auto: 'auto', ch: 'ch', zh: 'ch', 'zh-cn': 'ch', 'zh-tw': 'ch',
  chinese: 'ch', cn: 'ch', yue: 'ch', wuu: 'ch', nan: 'ch', hak: 'ch', gan: 'ch', cmn: 'ch',
  vi: 'vi', en: 'en', ja: 'japan', japan: 'japan', ko: 'korean', korean: 'korean'
});

function normalizeSourceLanguage(value, fallback = 'auto') {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return fallback;
  return SOURCE_LANGUAGE_ALIASES[key] || key;
}

function isChineseLanguage(value) {
  return normalizeSourceLanguage(value) === 'ch';
}

function isChinesePlatformPath(videoPath) {
  return /(?:^|[\\/])(douyin|bili|bilibili|rednote|xiaohongshu|xhs)(?:[\\/]|$)/iu.test(
    String(videoPath || '')
  );
}

async function readWhisperMetadata(subtitlePath) {
  try {
    return JSON.parse(await fs.readFile(`${subtitlePath}.asr.json`, 'utf8'));
  } catch {
    return null;
  }
}

async function verifyResultLanguage(subtitlePath, metadata, requestedLanguage) {
  const requested = normalizeSourceLanguage(requestedLanguage);
  if (requested !== 'auto') {
    return { language: requested, confidence: null, evidence: 'manual_source_language' };
  }
  let text = '';
  try {
    const cues = await dynamicOcr.parseSrtCues(subtitlePath);
    text = cues.map((cue) => cue.text).join(' ');
  } catch {}
  const textual = verifySubtitleLanguage(text);
  const audioLanguage = normalizeSourceLanguage(metadata?.language, 'auto');
  const audioConfidence = Number(metadata?.languageConfidence);
  if (textual.language && textual.confidence >= 0.15) {
    return {
      language: normalizeSourceLanguage(textual.language, audioLanguage),
      confidence: textual.confidence,
      evidence: textual.evidence
    };
  }
  if (audioLanguage !== 'auto') {
    return {
      language: audioLanguage,
      confidence: Number.isFinite(audioConfidence) ? audioConfidence : null,
      evidence: metadata?.engineId === 'capcut-asr' ? 'capcut_audio' : 'whisper_audio'
    };
  }
  if (textual.language) {
    return {
      language: normalizeSourceLanguage(textual.language),
      confidence: textual.confidence,
      evidence: textual.evidence
    };
  }
  return { language: 'auto', confidence: null, evidence: 'undetermined' };
}

function findSuspiciousOcrGaps(cues, durationMs) {
  const duration = Math.max(0, Number(durationMs) || 0);
  if (duration < 30_000 || !Array.isArray(cues) || cues.length < 3) return [];
  const sorted = [...cues].sort((left, right) => left.startMs - right.startMs);
  const ordinary = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index].startMs - sorted[index - 1].endMs;
    if (gap > 0 && gap < 20_000) ordinary.push(gap);
  }
  ordinary.sort((left, right) => left - right);
  const median = ordinary.length ? ordinary[Math.floor(ordinary.length / 2)] : 2_000;
  const internalThreshold = Math.max(20_000, median * 8);
  const edgeThreshold = Math.max(20_000, duration * 0.18);
  const gaps = [];
  if (sorted[0].startMs > edgeThreshold) gaps.push({ startMs: 0, endMs: sorted[0].startMs, kind: 'head' });
  for (let index = 1; index < sorted.length; index += 1) {
    const startMs = sorted[index - 1].endMs;
    const endMs = sorted[index].startMs;
    if (endMs - startMs > internalThreshold) gaps.push({ startMs, endMs, kind: 'internal' });
  }
  const lastEnd = sorted.at(-1).endMs;
  if (duration - lastEnd > edgeThreshold) gaps.push({ startMs: lastEnd, endMs: duration, kind: 'tail' });
  return gaps;
}

function overlapsCue(candidate, cue, toleranceMs = 250) {
  return candidate.startMs < cue.endMs + toleranceMs && candidate.endMs > cue.startMs - toleranceMs;
}

function mergeOcrAndWhisperCues(ocrCues, whisperCues, gaps) {
  const primary = Array.isArray(ocrCues) ? ocrCues : [];
  const additions = (Array.isArray(whisperCues) ? whisperCues : []).filter((cue) => {
    const midpoint = (cue.startMs + cue.endMs) / 2;
    const insideMissingRange = gaps.some((gap) => midpoint >= gap.startMs && midpoint <= gap.endMs);
    return insideMissingRange && !primary.some((ocrCue) => overlapsCue(cue, ocrCue));
  });
  return {
    added: additions.length,
    cues: [...primary.map((cue) => ({ ...cue, source: 'ocr' })),
      ...additions.map((cue) => ({ ...cue, source: 'whisper' }))]
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  };
}

const CHANNEL_ONLY_PATTERNS = [
  /@\s*[\p{L}\p{N}_.-]{2,}/gu,
  /(?:抖音|快手|微博|小红书|微信|视频|作者)?\s*(?:号|id)\s*[:：]?\s*[\w.@-]{2,}/giu
];
const PLATFORM_WATERMARKS = [
  'bilibili', '哔哩哔哩', 'b站', '抖音', 'douyin', '快手', 'kuaishou', '小红书',
  'xiaohongshu', 'rednote', '微博', 'weibo', 'tiktok', '西瓜视频', '腾讯视频',
  '爱奇艺', '优酷', 'youtube', 'facebook', 'instagram'
];

function meaningfulText(value) {
  return String(value || '').replace(/[\s|/\\_.·•,，、:：;；!?！？'"“”‘’()（）[\]【】<>《》*#~^`+=-]+/gu, '');
}

function isChannelOnlyCue(text) {
  const original = String(text || '').trim();
  if (!original) return false;
  let remaining = original;
  for (const pattern of CHANNEL_ONLY_PATTERNS) remaining = remaining.replace(pattern, '');
  for (const watermark of PLATFORM_WATERMARKS) {
    remaining = remaining.replace(new RegExp(watermark.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), '');
  }
  const originalMeaning = meaningfulText(original);
  const remainingMeaning = meaningfulText(remaining);
  return remainingMeaning !== originalMeaning && remainingMeaning.length <= 1;
}

function commonEdge(cues, fromStart, minimumLength = 6, maximumLength = 40) {
  const texts = cues.map((cue) => String(cue.text || '').replace(/\s+/gu, ' ').trim())
    .filter((text) => text.length >= minimumLength + 2);
  if (texts.length < 8) return '';
  const required = Math.max(4, Math.floor(texts.length * 0.5));
  let winner = '';
  for (let length = minimumLength; length <= maximumLength; length += 1) {
    const counts = new Map();
    for (const text of texts) {
      if (text.length < length + 2) continue;
      const candidate = fromStart ? text.slice(0, length) : text.slice(-length);
      counts.set(candidate, (counts.get(candidate) || 0) + 1);
    }
    const best = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
    if (!best || best[1] < required || !best[0].trim()) break;
    winner = best[0];
  }
  return winner;
}

function cleanRapidOcrCues(cues) {
  const input = Array.isArray(cues) ? cues : [];
  const withoutChannels = input.filter((cue) => !isChannelOnlyCue(cue.text));
  const channelRemoved = input.length - withoutChannels.length;
  const safeChannels = channelRemoved * 2 >= input.length ? input : withoutChannels;
  const prefix = commonEdge(safeChannels, true);
  const suffix = commonEdge(safeChannels, false);
  const edge = prefix.length > suffix.length ? { value: prefix, prefix: true } : { value: suffix, prefix: false };
  let edgeCleaned = 0;
  const cleaned = safeChannels.map((cue) => {
    const text = String(cue.text || '').replace(/\s+/gu, ' ').trim();
    if (!edge.value) return cue;
    const matches = edge.prefix ? text.startsWith(edge.value) : text.endsWith(edge.value);
    if (!matches) return cue;
    const remaining = (edge.prefix ? text.slice(edge.value.length) : text.slice(0, -edge.value.length)).trim();
    if (meaningfulText(remaining).length < 2) return cue;
    edgeCleaned += 1;
    return { ...cue, text: remaining };
  });
  return {
    cues: cleaned,
    removedChannelCues: safeChannels === input ? 0 : channelRemoved,
    cleanedRepeatedEdges: edgeCleaned,
    repeatedEdge: edge.value || null
  };
}

function msToSrtTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const milliseconds = total % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

async function writeMergedSrt(outputPath, cues) {
  const parser = new SrtParser();
  const content = parser.toSrt(cues.map((cue, index) => ({
    id: String(index + 1),
    startTime: msToSrtTimestamp(cue.startMs),
    endTime: msToSrtTimestamp(cue.endMs),
    text: String(cue.text || '').trim()
  })));
  await fs.writeFile(outputPath, content, 'utf8');
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
    whisperDevice = 'auto',
    whisperBackend = 'faster-whisper',
    sourceLanguage,
    ocrLanguage,
    ocrMode,
    ocrRegion,
    ocrExcludedRegions = [],
    ocrRegionStrategy = 'manual',
    ocrPipeline = 'auto',
    forceWhisper = false,
    ocrOnly = false,
    hybridWhisperFill = false,
    capcutAsrEnabled = false,
    onProgress
  } = options;
  const deps = { ...defaultDependencies, ...dependencies };
  const reportProgress = createProgressReporter(onProgress);
  const reportPath = path.join(workDir, 'ocr-report.json');
  const legacyLanguage = forceWhisper
    ? (whisperLanguage || ocrLanguage)
    : (ocrLanguage || whisperLanguage);
  let resolvedSourceLanguage = normalizeSourceLanguage(
    sourceLanguage,
    normalizeSourceLanguage(legacyLanguage)
  );
  const automaticSourceLanguage = resolvedSourceLanguage === 'auto';
  let spokenLanguageDetection = null;
  let hardsubProbe = null;
  let capCutAttemptedForHardsub = false;

  await fs.mkdir(workDir, { recursive: true });

  if (automaticSourceLanguage && !forceWhisper) {
    reportProgress({ phase: 'language_detecting', detail: { sampleSeconds: 25, model: 'tiny' } });
    try {
      const detected = await deps.detectSpokenLanguage(
        videoPath, workDir, ffmpegPath, whisperDevice
      );
      const detectedLanguage = normalizeSourceLanguage(detected?.language, 'auto');
      const probability = Number(detected?.probability) || 0;
      spokenLanguageDetection = {
        language: detectedLanguage,
        probability,
        model: detected?.model || 'tiny',
        sampleSeconds: Number(detected?.sampleSeconds) || 25
      };
      const chinesePlatformConflict = isChinesePlatformPath(videoPath)
        && detectedLanguage !== 'auto'
        && !isChineseLanguage(detectedLanguage);
      if (chinesePlatformConflict && probability < 0.90) {
        resolvedSourceLanguage = 'ch';
        reportProgress({
          phase: 'language_detected',
          detail: { ...spokenLanguageDetection, language: 'ch', keptChinesePlatformGuess: true }
        });
      } else if (detectedLanguage !== 'auto') {
        resolvedSourceLanguage = detectedLanguage;
        reportProgress({ phase: 'language_detected', detail: spokenLanguageDetection });
      }
    } catch (error) {
      if (isChinesePlatformPath(videoPath)) resolvedSourceLanguage = 'ch';
      reportProgress({
        phase: 'language_detection_fallback',
        detail: { message: error?.message || String(error), language: resolvedSourceLanguage }
      });
    }

    reportProgress({ phase: 'ocr_hardsub_probe', detail: { frames: 20, minimumBoxes: 3 } });
    try {
      hardsubProbe = await deps.probeChineseHardsub({
        videoPath,
        device: process.env.OCR_DUNG_GPU === '1' ? 'gpu' : 'cpu',
        model: 'v6-small',
        frames: 20,
        minimumBoxes: 3,
        cwd: workDir,
        onProgress: (detail) => reportProgress({ phase: 'ocr_hardsub_probe', detail })
      });
      if (hardsubProbe?.hasHan) {
        resolvedSourceLanguage = 'ch';
        reportProgress({ phase: 'ocr_hardsub_detected', detail: hardsubProbe });
      }
    } catch (error) {
      hardsubProbe = { hasHan: false, conclusive: false, error: error?.message || String(error) };
      reportProgress({ phase: 'ocr_hardsub_probe_fallback', detail: hardsubProbe });
    }
  }

  const runWhisper = async (reason, preserveOcrReport = false) => {
    if (!preserveOcrReport) await fs.rm(reportPath, { force: true });
    reportProgress({ phase: reason === 'ocr_gap_fill' ? 'whisper_gap_fill' : 'whisper_fallback' });
    const whisperArgs = [
      videoPath,
      workDir,
      ffmpegPath,
      whisperModel,
      durationMs,
      resolvedSourceLanguage,
      whisperOnnxVariant,
      resolvedSourceLanguage,
      whisperTimestampLevel,
      whisperDevice,
      whisperBackend
    ];
    const subtitlePath = await deps.extractAudioAndTranscribe(...whisperArgs);
    const metadata = await readWhisperMetadata(subtitlePath);
    const verified = await verifyResultLanguage(
      subtitlePath, metadata, automaticSourceLanguage ? 'auto' : resolvedSourceLanguage
    );
    if (!metadata) {
      return {
        ...whisperResult(subtitlePath, verified.language, reason),
        languageConfidence: verified.confidence,
        languageEvidence: verified.evidence
      };
    }
    return {
      ...whisperResult(subtitlePath, verified.language, reason),
      cueCount: Array.isArray(metadata.cues) ? metadata.cues.length : 0,
      languageConfidence: verified.confidence,
      languageEvidence: verified.evidence
    };
  };

  const writeNoSpeechResult = async (reason) => {
    const subtitlePath = path.join(workDir, 'capcut-no-speech.srt');
    await fs.writeFile(subtitlePath, '', 'utf8');
    await fs.writeFile(`${subtitlePath}.asr.json`, `${JSON.stringify({
      version: 1,
      engineId: 'capcut-asr',
      online: true,
      uploadedAudio: true,
      noSpeech: true,
      language: resolvedSourceLanguage,
      languageConfidence: null,
      cues: []
    }, null, 2)}\n`, 'utf8');
    return {
      path: subtitlePath,
      source: 'capcut-asr',
      language: resolvedSourceLanguage,
      cueCount: 0,
      removedWatermarks: 0,
      reason,
      languageConfidence: null,
      languageEvidence: 'capcut_no_speech',
      online: true,
      uploadedAudio: true,
      noSpeech: true
    };
  };

  const runCapCut = async (reason, preserveOcrReport = false, allowNoSpeechResult = true) => {
    if (!capcutAsrEnabled) return null;
    if (!preserveOcrReport) await fs.rm(reportPath, { force: true });
    reportProgress({ phase: 'capcut_asr', detail: { online: true, uploadedAudio: true } });
    try {
      const result = await deps.runCapCutAsr({
        videoPath,
        workDir,
        ffmpegPath,
        durationMs,
        language: resolvedSourceLanguage,
        outputPath: path.join(workDir, 'capcut-asr.srt'),
        onStage: (detail) => reportProgress({ phase: 'capcut_asr', detail })
      });
      const metadata = await readWhisperMetadata(result.path);
      const verified = await verifyResultLanguage(
        result.path, metadata, automaticSourceLanguage ? 'auto' : resolvedSourceLanguage
      );
      const detectorVerified = automaticSourceLanguage
        && Boolean(spokenLanguageDetection?.language)
        && spokenLanguageDetection.language !== 'auto'
        && (!verified.language || verified.language === 'auto' || verified.evidence === 'capcut_audio');
      return {
        path: result.path,
        source: 'capcut-asr',
        language: detectorVerified ? spokenLanguageDetection.language : verified.language,
        cueCount: Array.isArray(result.cues) ? result.cues.length : 0,
        removedWatermarks: 0,
        reason,
        languageConfidence: detectorVerified ? spokenLanguageDetection.probability : verified.confidence,
        languageEvidence: detectorVerified ? 'whisper_tiny_25s' : verified.evidence,
        online: true,
        uploadedAudio: true
      };
    } catch (error) {
      if (error?.code === 'CAPCUT_ASR_NO_SPEECH') {
        reportProgress({ phase: 'capcut_asr_no_speech', detail: { preserveOcrReport } });
        return allowNoSpeechResult ? writeNoSpeechResult('capcut_no_speech') : null;
      }
      reportProgress({
        phase: 'capcut_asr_fallback',
        detail: { code: error?.code || 'CAPCUT_ASR_ERROR', message: error?.message || String(error) }
      });
      return null;
    }
  };

  const runPreferredAsr = async (reason, preserveOcrReport = false) => (
    await runCapCut(reason, preserveOcrReport)
    || runWhisper(reason, preserveOcrReport)
  );

  if (forceWhisper) {
    return runWhisper('forced_whisper');
  }

  if (automaticSourceLanguage && hardsubProbe?.conclusive && !hardsubProbe.hasHan) {
    return runPreferredAsr('no_chinese_hardsub_detected');
  }

  const chineseLanguage = isChineseLanguage(resolvedSourceLanguage);
  const normalizedOcrPipeline = ['auto', 'viral', 'vse'].includes(ocrPipeline) ? ocrPipeline : 'auto';
  if (normalizedOcrPipeline === 'viral' && !chineseLanguage && !automaticSourceLanguage) {
    throw invalidOptions('RapidOCR chỉ hỗ trợ tiếng Trung; hãy chọn VSE hoặc đổi ngôn ngữ chữ gốc thành Trung');
  }
  const useViralPipeline = normalizedOcrPipeline === 'viral'
    || (normalizedOcrPipeline === 'auto' && (chineseLanguage || automaticSourceLanguage));

  if (automaticSourceLanguage && useViralPipeline && hardsubProbe?.hasHan && capcutAsrEnabled && !ocrOnly) {
    capCutAttemptedForHardsub = true;
    const capCutFirst = await runCapCut('capcut_hardsub_audio_preferred_before_ocr', false, false);
    if (capCutFirst) return capCutFirst;
  }
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
      typeof resolvedSourceLanguage !== 'string'
      || resolvedSourceLanguage.length === 0
      || automaticSourceLanguage
      || !Array.isArray(componentStatus.supportedLanguages)
      || !componentStatus.supportedLanguages.includes(resolvedSourceLanguage)
    ) {
      throw invalidOptions(`Unsupported OCR language: ${resolvedSourceLanguage}`);
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
      return capCutAttemptedForHardsub
        ? runWhisper(trackedCueCount > 0 ? 'ocr_quality_rejected' : 'no_hardsub', hasTrackedBoxes)
        : runPreferredAsr(trackedCueCount > 0 ? 'ocr_quality_rejected' : 'no_hardsub', hasTrackedBoxes);
    }

    await fs.copyFile(rawPath, cleanPath);
    const parsedOcrCues = await dynamicOcr.parseSrtCues(cleanPath);
    const rapidCleanup = cleanRapidOcrCues(parsedOcrCues);
    const ocrCues = rapidCleanup.cues;
    if (rapidCleanup.removedChannelCues > 0 || rapidCleanup.cleanedRepeatedEdges > 0) {
      await writeMergedSrt(cleanPath, ocrCues);
      trackedReport = {
        ...(trackedReport || {}),
        cueCount: ocrCues.length,
        cleanup: {
          removedChannelCues: rapidCleanup.removedChannelCues,
          cleanedRepeatedEdges: rapidCleanup.cleanedRepeatedEdges,
          repeatedEdge: rapidCleanup.repeatedEdge
        }
      };
      await fs.writeFile(reportPath, `${JSON.stringify(trackedReport, null, 2)}\n`, 'utf8');
    }
    if (ocrCues.length < 3) {
      if (ocrOnly) throw new OcrNoSubtitlesError('RapidOCR còn dưới 3 câu sau khi lọc watermark/tên kênh');
      return runPreferredAsr('ocr_quality_rejected_after_watermark_cleanup', hasTrackedBoxes);
    }
    const gaps = hybridWhisperFill ? findSuspiciousOcrGaps(ocrCues, durationMs) : [];
    if (gaps.length && !ocrOnly) {
      reportProgress({ phase: 'whisper_gap_fill', detail: { gapCount: gaps.length } });
      const whisper = await runPreferredAsr('ocr_gap_fill', true);
      const whisperCues = await dynamicOcr.parseSrtCues(whisper.path);
      const merged = mergeOcrAndWhisperCues(ocrCues, whisperCues, gaps);
      if (merged.added > 0) {
        const hybridPath = path.join(workDir, 'hybrid-ocr-whisper.srt');
        await writeMergedSrt(hybridPath, merged.cues);
        await fs.writeFile(`${hybridPath}.asr.json`, `${JSON.stringify({
          version: 1,
          engineId: `rapidocr+${whisper.source === 'whisper' ? 'faster-whisper' : (whisper.source || 'asr')}`,
          language: 'ch',
          languageConfidence: whisper.languageConfidence ?? null,
          cues: merged.cues.map((cue, index) => ({
            id: String(index + 1),
            text: cue.text,
            startMs: cue.startMs,
            endMs: cue.endMs,
            source: cue.source
          }))
        }, null, 2)}\n`, 'utf8');
        await fs.writeFile(reportPath, `${JSON.stringify({
          ...(trackedReport || {}),
          hybrid: { enabled: true, gapCount: gaps.length, addedWhisperCues: merged.added, gaps }
        }, null, 2)}\n`, 'utf8');
        return {
          path: hybridPath,
          source: 'hybrid',
          language: 'ch',
          cueCount: merged.cues.length,
          removedWatermarks: 0,
          reason: 'rapidocr_with_whisper_gap_fill',
          languageEvidence: 'rapidocr_hardsub'
        };
      }
    }
    const capCutHardsub = !ocrOnly && !capCutAttemptedForHardsub
      ? await runCapCut('capcut_hardsub_audio_preferred', true, false)
      : null;
    if (capCutHardsub) return capCutHardsub;
    return {
      path: cleanPath,
      source: 'ocr',
      language: 'ch',
      cueCount: ocrCues.length,
      removedWatermarks: rapidCleanup.removedChannelCues,
      reason: automaticSourceLanguage ? 'rapidocr_auto_detected_chinese_hardsub' : 'viral_ocr_accepted',
      languageEvidence: 'rapidocr_hardsub'
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
        language: resolvedSourceLanguage,
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
      language: resolvedSourceLanguage,
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
    return runPreferredAsr(onlyNoSubtitles ? 'no_hardsub' : 'ocr_quality_rejected');
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
    language: resolvedSourceLanguage,
    cueCount: quality.cueCount,
    removedWatermarks: Array.isArray(quality.removedRepeatedLines)
      ? quality.removedRepeatedLines.length
      : 0,
    reason: 'ocr_accepted',
    languageEvidence: 'manual_source_language'
  };
}

module.exports = {
  OcrComponentRequiredError,
  OcrNoSubtitlesError,
  findSuspiciousOcrGaps,
  cleanRapidOcrCues,
  isChannelOnlyCue,
  mergeOcrAndWhisperCues,
  normalizeSourceLanguage,
  resolveAutomaticSubtitle
};
