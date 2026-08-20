const fs = require('fs');
const path = require('path');
const shared = require('../lib/shared-state');
const { translateSubtitles, formatSubtitleFile, srtTimeToMs, msToSrtTime } = require('../lib/translate-sub');
const { fitSubtitleCue, resolveDisplayMaxLines } = require('../lib/subtitle-display-layout');
const { resolveAutomaticSubtitle } = require('../lib/subtitle-source-helper');
const anti = require('../lib/anti-dupe');
const { buildTimedBlurFilterGraph } = require('../lib/render-blur-helper');
const { RenderJobStore, normalizeUiSnapshot } = require('../lib/render-job-store');
const { createRenderOrchestrator } = require('../lib/render-orchestrator');
const { SegmentService } = require('../lib/segment-service');
const {
  createLegacyVoiceAudioSignature,
  createVoiceAudioSignature,
  resolveVoiceReference
} = require('../lib/voice-reference-helper');
const {
  createFittedVoiceChunk,
  isNarrationAudioUsable,
  readWavDurationMs,
  normalizeVoiceTrackFast,
  stretchVoiceWithAudioStretchy,
  trimVoiceSilence
} = require('../lib/voice-audio-fit');
const { resolveOmnivoiceSeed } = require('../lib/voice-defaults');
const { generateNarrationWithinCue } = require('../lib/narration-fit-service');
const {
  alignSubtitleCuesToNarration,
  createTimelineState,
  evaluateCoverage,
  evaluateOnsetAlignment,
  planAdaptiveCue,
  preparePiperCueText,
  synthesizeWithFallback
} = require('../lib/adaptive-dubbing-pipeline');
const { analyzeWavFile, readPcm16WavFile } = require('../lib/audio-quality');
const { classifyCueSpeakers } = require('../lib/voice-speaker-classifier');
const { EarlyTtsPipeline } = require('../lib/early-tts-pipeline');
const { normalizeTtsText } = require('../lib/tts-text-normalizer');
const { resolvePiperVoice } = require('../lib/voice-engines/piper-engine');
const { OUTPUT_LANGUAGES, OUTPUT_LANGUAGE_BY_CODE } = require('../lib/voice-language-catalog');
const { restoreVoiceCache, saveVoiceCache } = require('../lib/voice-content-cache');
const {
  buildAudioMixGraph,
  normalizeAudioMasteringConfig
} = require('../lib/audio-mastering');
const {
  createSmartFitSignature
} = require('../lib/smart-fit-service');
const {
  DEFAULT_VOICE_ENGINE_ID,
  VoiceEngineError,
  voiceEngineRegistry
} = require('../lib/voice-engines/index');
const {
  createCheckpointSignature,
  getFileIdentity,
  isUsableFile,
  readJsonFile,
  writeJsonAtomic
} = require('../lib/checkpoint-utils');
const { createMdxSeparatorManager } = require('../lib/mdx-separator-manager');
const mdxCudaComponentManager = require('../lib/mdx-cuda-component-manager');

const renderJobStore = new RenderJobStore(shared.RENDER_JOBS_DIR);
const renderOrchestrator = createRenderOrchestrator({
  store: renderJobStore,
  existsSync: fs.existsSync
});
const mdxSeparatorManager = createMdxSeparatorManager({
  fs,
  runExecFile: shared.runExecFile,
  cpuExecutablePath: shared.AUDIO_SEPARATOR_CLI_PATH,
  cudaExecutablePath: shared.AUDIO_SEPARATOR_CUDA_CLI_PATH,
  isCudaRuntimeReady: () => (
    Boolean(process.env.MDX_CUDA_EXECUTABLE_PATH) ||
    mdxCudaComponentManager.getStatus().status === 'ready'
  ),
  modelPath: shared.AUDIO_SEPARATOR_MODEL_PATH
});
const segmentService = new SegmentService();

class SegmentReviewRequiredError extends Error {
  constructor(message = 'Cần duyệt từng câu trước khi tiếp tục render') {
    super(message);
    this.name = 'SegmentReviewRequiredError';
    this.code = 'SEGMENT_REVIEW_REQUIRED';
  }
}

// Helpers for Studio rendering
function escapeSubtitleForFilter(filePath) {
  // FFmpeg subtitles filter: ' làm delimiter, cần dùng '\\'' để escape
  const noBackslash = filePath.replace(/\\/g, '/');
  const noColon = noBackslash.replace(/:/g, '\\:');
  const escaped = noColon.replace(/'/g, "'\\''");
  return escaped;
}

function mergeRenderBlurBoxes(manualBoxes, automaticBoxes, automaticEnabled) {
  const manual = Array.isArray(manualBoxes) ? manualBoxes : [];
  const automatic = automaticEnabled && Array.isArray(automaticBoxes) ? automaticBoxes : [];
  return [...manual, ...automatic];
}

function readSubtitleTimingCues(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const Parser = require('srt-parser-2').default;
    const parser = new Parser();
    return parser.fromSrt(fs.readFileSync(filePath, 'utf8')).flatMap((cue) => {
      const startMs = srtTimeToMs(cue.startTime);
      const endMs = srtTimeToMs(cue.endTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
      return [{ startMs, endMs }];
    });
  } catch (error) {
    console.warn('[Studio Blur] Không đọc được timing SRT để đồng bộ vùng che:', error.message);
    return [];
  }
}

function appendFilterComplexArgs(args, filterSegments, workDir, inlineLimit = 24000) {
  const filterText = filterSegments.join(';');
  if (filterText.length <= inlineLimit) {
    args.push('-filter_complex', filterText);
    return { mode: 'inline', filterText };
  }

  const scriptPath = path.join(workDir, 'render-filter-complex.txt');
  fs.writeFileSync(scriptPath, filterText, 'utf8');
  // Current bundled FFmpeg uses the documented option-file form; the removed
  // legacy -filter_complex_script switch fails on FFmpeg 8/nightly builds.
  args.push('-/filter_complex', scriptPath);
  return { mode: 'script', filterText, scriptPath };
}

function hexToAssColor(hexStr) {
  if (!hexStr || !hexStr.startsWith('#')) return '&H00FFFFFF';
  const cleanHex = hexStr.replace('#', '');
  if (cleanHex.length !== 6) return '&H00FFFFFF';
  const rr = cleanHex.substring(0, 2);
  const gg = cleanHex.substring(2, 4);
  const bb = cleanHex.substring(4, 6);
  return `&H00${bb}${gg}${rr}`;
}

function buildStudioLogoOverlay(body = {}, options = {}) {
  if (!(body.logoEnabled === true || body.logoEnabled === 'true') || !body.savedLogoFile) {
    return { enabled: false, segments: [] };
  }
  const inputIndex = Number(options.inputIndex);
  const videoWidth = Math.max(2, Number(options.videoWidth) || 1080);
  if (!Number.isInteger(inputIndex) || inputIndex < 1) throw new Error('Logo input index không hợp lệ');
  const widthPercent = Math.max(3, Math.min(60, Number(body.logoWidthPercent) || 18));
  const logoWidth = Math.max(2, Math.round(videoWidth * widthPercent / 100));
  const opacity = Math.max(0.05, Math.min(1, Number(body.logoOpacity) || 0.9));
  const position = String(body.logoPosition || 'br');
  const margin = Math.max(8, Math.round(videoWidth * 0.015));
  let x = `main_w-overlay_w-${margin}`;
  let y = `main_h-overlay_h-${margin}`;
  if (position === 'bl') { x = String(margin); y = `main_h-overlay_h-${margin}`; }
  else if (position === 'tr') { x = `main_w-overlay_w-${margin}`; y = String(margin); }
  else if (position === 'tl') { x = String(margin); y = String(margin); }
  else if (position === 'center') { x = '(main_w-overlay_w)/2'; y = '(main_h-overlay_h)/2'; }
  else if (position === 'custom') {
    const xPercent = Math.max(0, Math.min(100, Number(body.logoXPercent) || 0));
    const yPercent = Math.max(0, Math.min(100, Number(body.logoYPercent) || 0));
    x = `min(max(main_w*${(xPercent / 100).toFixed(6)},0),main_w-overlay_w)`;
    y = `min(max(main_h*${(yPercent / 100).toFixed(6)},0),main_h-overlay_h)`;
  }
  const start = Math.max(0, Number(body.logoStart) || 0);
  const rawEnd = body.logoEnd;
  const hasEnd = rawEnd !== '' && rawEnd !== null && rawEnd !== undefined && Number.isFinite(Number(rawEnd));
  const end = hasEnd ? Math.max(start, Number(rawEnd)) : null;
  const enable = end === null ? `gte(t,${start.toFixed(3)})` : `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
  const baseLabel = String(options.baseLabel || '0:v');
  return {
    enabled: true,
    segments: [
      `[${inputIndex}:v]format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)},scale=${logoWidth}:-1[studio_logo]`,
      `[${baseLabel}][studio_logo]overlay=x='${x}':y='${y}':enable='${enable}':eof_action=pass[vout]`
    ]
  };
}

function renameVideoOutput(filters, outputLabel) {
  for (let index = filters.length - 1; index >= 0; index -= 1) {
    if (/\[vout\]$/.test(filters[index])) {
      filters[index] = filters[index].replace(/\[vout\]$/, `[${outputLabel}]`);
      return true;
    }
  }
  return false;
}

function getVideoDurationInSeconds(videoPath) {
  return new Promise((resolve) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      return resolve(0);
    }
    shared.execFile(shared.FFMPEG_PATH, ['-i', videoPath], (err, stdout, stderr) => {
      const output = stderr || '';
      const match = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d+)/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const centiseconds = parseInt(match[4].padEnd(3, '0').slice(0, 3), 10);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds + centiseconds / 1000;
        resolve(totalSeconds);
      } else {
        resolve(0);
      }
    });
  });
}

function runFFmpegWithProgress(args, totalDuration) {
  return new Promise((resolve, reject) => {
    console.log(`[FFmpeg Progress] Running FFmpeg with total duration ${totalDuration}s`);
    const proc = shared.spawn(shared.FFMPEG_PATH, args);

    let stderrOutput = '';

    proc.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      stderrOutput += chunk;

      if (totalDuration > 0) {
        const match = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (match) {
          const hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const seconds = parseInt(match[3], 10);
          const currentTime = hours * 3600 + minutes * 60 + seconds;

          const ffmpegProgress = Math.floor((currentTime / totalDuration) * 100);
          const overallPercent = 83 + Math.floor((ffmpegProgress / 100) * 14);
          shared.updateStudioProgress(overallPercent, `Đang kết xuất (render) video: ${ffmpegProgress}%`);
        }
      }
    });

    let settled = false;
    const safeResolve = (v) => { if (!settled) { settled = true; clearTimeout(timeoutHandle); resolve(v); } };
    const safeReject = (e) => { if (!settled) { settled = true; clearTimeout(timeoutHandle); e.stderr = stderrOutput; reject(e); } };

    proc.on('close', (code) => {
      if (code === 0) {
        safeResolve();
      } else {
        safeReject(new Error(`FFmpeg error (code ${code})`));
      }
    });

    proc.on('error', (err) => {
      safeReject(err);
    });

    // Khi proc bị kill ngoài (user hủy), 'close' vẫn fire với code != 0 -> safeReject
    // Timeout dự phòng: 2 tiếng (tránh treo vĩnh viễn nếu pipe chết mà không fire event)
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        try { proc.kill('SIGKILL'); } catch (e) { }
        safeReject(new Error('FFmpeg render timeout (2h)'));
      }
    }, 2 * 60 * 60 * 1000);
  });
}

function createWavHeader(dataLength, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataLength + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function convertSrtToAss(srtPath, assPath, options) {
  const Parser = require('srt-parser-2').default;
  const parser = new Parser();
  const srtContent = fs.readFileSync(srtPath, 'utf8');
  const srtArray = parser.fromSrt(srtContent);

  function convertSrtTime(srtTime) {
    if (!srtTime) return "0:00:00.00";
    const parts = srtTime.split(':');
    let hours = 0;
    let minutes = "00";
    let seconds = "00";
    let ms = "000";

    if (parts.length === 2) {
      minutes = parts[0];
      const secParts = parts[1].split(',');
      seconds = secParts[0];
      ms = secParts[1] || '000';
    } else if (parts.length >= 3) {
      hours = parseInt(parts[0], 10);
      minutes = parts[1];
      const secParts = parts[2].split(',');
      seconds = secParts[0];
      ms = secParts[1] || '000';
    } else {
      return "0:00:00.00";
    }
    const cs = ms.substring(0, 2).padEnd(2, '0');
    return `${hours}:${minutes}:${seconds}.${cs}`;
  }

  const {
    videoWidth,
    videoHeight,
    fontName,
    fontSize,
    assColor,
    isBold,
    borderStyle,
    outline,
    shadow,
    outlineColor,
    backColor,
    alignment,
    marginV,
    marginL,
    marginR,
    theme
  } = options;

  const assLines = [];
  assLines.push('[Script Info]');
  assLines.push('ScriptType: v4.00+');
  assLines.push(`PlayResX: ${videoWidth}`);
  assLines.push(`PlayResY: ${videoHeight}`);
  // SRT giữ nguyên cue/timestamp; xuống dòng và co chữ chỉ diễn ra ở ASS.
  assLines.push('WrapStyle: 0');
  assLines.push('');
  assLines.push('[V4+ Styles]');
  assLines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, Strikeout, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  assLines.push(`Style: Default,${fontName},${fontSize},${assColor},&H000000FF,${outlineColor},${backColor},${isBold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`);
  assLines.push('');
  assLines.push('[Events]');
  assLines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  for (const item of srtArray) {
    const start = convertSrtTime(item.startTime);
    const end = convertSrtTime(item.endTime);
    const fitted = fitSubtitleCue(item.text, {
      fontSize,
      maxLines: Number(options.maxLines) || resolveDisplayMaxLines(videoWidth, videoHeight),
      boxWidth: Math.max(1, videoWidth - marginL - marginR)
    });
    let text = fitted.text;
    if (fitted.fontSize < fontSize) {
      text = `{\\fs${fitted.fontSize}}${text}`;
    }
    if (theme === 'neon-glow') {
      text = `{\\blur4}${text}`;
    }
    assLines.push(`Dialogue: 0,${start},${end},Default,,${marginL},${marginR},${marginV},,${text}`);
  }

  fs.writeFileSync(assPath, assLines.join('\n'), 'utf8');
}

function createRenderSourceResolver(dependencies = {}) {
  const existsSync = dependencies.existsSync || fs.existsSync;
  const moveUploadedFile = dependencies.moveUploadedFile || shared.moveUploadedFile;
  const downloadsDir = dependencies.downloadsDir || shared.DOWNLOADS_DIR;
  const resolveAssetPath = dependencies.resolveAssetPath || shared.resolveAssetPath;

  return function resolveRenderSource(task) {
    if (task.sourceVideoPath) {
      if (existsSync(task.sourceVideoPath)) return task.sourceVideoPath;
      const error = new Error('Video nguồn đã lưu không còn tồn tại. Vui lòng tạo lại tác vụ.');
      error.code = 'RENDER_SOURCE_MISSING';
      throw error;
    }

    const body = task.body || {};
    const files = task.files || {};
    let sourceVideo = null;

    if (files.videoUpload?.[0]) {
      const upload = files.videoUpload[0];
      sourceVideo = moveUploadedFile(upload, downloadsDir, upload.originalname);
    } else if (body.mainVideoFile) {
      sourceVideo = resolveAssetPath('video', body.mainVideoFile);
    }

    if (!sourceVideo) throw new Error('Thiếu video nguồn');
    task.sourceVideoPath = sourceVideo;
    return sourceVideo;
  };
}

const resolveRenderSource = createRenderSourceResolver();

function mapAutomaticSubtitleProgress(event = {}) {
  switch (event.phase) {
    case 'ocr_starting':
      return { percent: 12, step: 'Đang khởi động OCR...' };
    case 'ocr_processing': {
      const detailPercent = Number(event.detail?.pct);
      const hasPercent = Number.isFinite(detailPercent);
      const boundedPercent = hasPercent ? Math.max(0, Math.min(100, detailPercent)) : null;
      return {
        percent: hasPercent ? 13 + Math.round((boundedPercent / 100) * 21) : 18,
        step: hasPercent
          ? `Đang nhận dạng phụ đề bằng OCR: ${Math.round(boundedPercent)}%`
          : 'Đang nhận dạng phụ đề bằng OCR...'
      };
    }
    case 'ocr_retry_cpu':
      return { percent: 24, step: 'OCR đang thử lại bằng CPU...' };
    case 'ocr_region_scan':
      return { percent: 28, step: 'Đang tự dò vùng phụ đề khác...' };
    case 'ocr_validating':
      return { percent: 32, step: 'Đang kiểm tra phụ đề OCR...' };
    case 'whisper_fallback':
      return { percent: 33, step: 'Đang tạo phụ đề bằng Whisper...' };
    default:
      return null;
  }
}

function createAutomaticSubtitleProgressHandler(updateStudioProgress = shared.updateStudioProgress, logger = console) {
  let latestPercent = 12;
  let lastProviderLine = '';
  return function onAutomaticSubtitleProgress(event) {
    try {
      if (event.phase === 'ocr_processing' && event.detail?.kind === 'log') {
        const message = String(event.detail.message || '');
        if (/RapidOCR/i.test(message) && /(CUDAExecutionProvider|CPUExecutionProvider|GPU|CPU)/i.test(message)) {
          const line = `[RapidOCR] ${message}`;
          if (line !== lastProviderLine) {
            logger.log(line);
            lastProviderLine = line;
          }
        }
      }
      if (event.phase === 'ocr_processing' && event.detail?.kind === 'provider') {
        const requested = event.detail.requestedDevice || 'cpu';
        const provider = event.detail.provider || 'unknown';
        const model = event.detail.model || 'v6-small';
        const line = `[RapidOCR] model=${model} requestedDevice=${requested} actualProvider=${provider}`;
        if (line !== lastProviderLine) {
          logger.log(line);
          lastProviderLine = line;
        }
      }
      const progress = mapAutomaticSubtitleProgress(event);
      if (!progress) return;
      latestPercent = Math.min(34, Math.max(latestPercent, progress.percent));
      updateStudioProgress(latestPercent, progress.step);
    } catch {
      // Progress reporting must never interrupt OCR or Whisper processing.
    }
  };
}

function createAutomaticSubtitleResolver(dependencies = {}) {
  const resolveSubtitle = dependencies.resolveAutomaticSubtitle || resolveAutomaticSubtitle;
  const updateStudioProgress = dependencies.updateStudioProgress || shared.updateStudioProgress;
  const logger = dependencies.logger || console;

  return async function resolveRenderAutomaticSubtitle(options) {
    const body = options.body || {};
    const subtitleEngine = ['auto', 'ocr', 'whisper'].includes(body.subtitleEngine)
      ? body.subtitleEngine
      : 'auto';
    const forceWhisper = options.forceWhisper === true || subtitleEngine === 'whisper';
    const ocrOnly = subtitleEngine === 'ocr';
    const whisperOnnxVariant = ['q8', 'fp32', 'medium-q8'].includes(body.whisperOnnxVariant)
      ? body.whisperOnnxVariant
      : 'q8';
    logger.log(
      `[Auto Subtitle] route=${forceWhisper ? 'whisper_manual_fallback' : 'ocr_first'} `
      + `language=${body.ocrLanguage || 'unset'} voiceOnly=${options.isVoiceOnlySub === true}`
    );
    const result = await resolveSubtitle({
      videoPath: options.sourceVideo,
      workDir: options.workDir,
      ffmpegPath: options.ffmpegPath,
      durationMs: options.totalDuration * 1000,
      whisperModel: body.whisperModel || 'small',
      whisperOnnxVariant,
      ...(body.whisperLanguage ? { whisperLanguage: body.whisperLanguage } : {}),
      whisperTimestampLevel: body.whisperTimestampLevel === 'word' ? 'word' : 'segment',
      whisperDevice: ['auto', 'cpu', 'dml'].includes(body.whisperDevice) ? body.whisperDevice : 'cpu',
      ocrLanguage: body.ocrLanguage,
      ocrMode: body.ocrMode,
      ocrRegion: body.ocrRegion,
      ocrRegionStrategy: body.ocrRegionStrategy === 'manual' ? 'manual' : 'auto',
      ocrPipeline: ['auto', 'viral', 'vse'].includes(body.ocrPipeline) ? body.ocrPipeline : 'auto',
      forceWhisper,
      ocrOnly,
      onProgress: createAutomaticSubtitleProgressHandler(updateStudioProgress, logger)
    });
    logger.log(`[Auto Subtitle] source=${result.source || 'unknown'} reason=${result.reason || 'none'}`);
    return result.path;
  };
}

const resolveRenderAutomaticSubtitle = createAutomaticSubtitleResolver();

function applyRenderTaskSuccess(task, data, state = shared.state) {
  task.status = 'success';
  task.percent = 100;
  task.step = 'Hoàn tất render!';
  task.error = null;
  task.actionRequired = null;
  task.result = data;
  state.studioProgress = {
    status: 'success',
    percent: 100,
    step: 'Hoàn tất render!',
    error: null,
    result: data
  };
}

function isRenderTaskCancellation(task, error) {
  const taskStep = String(task.step || '').toLowerCase();
  const taskError = String(task.error || '').toLowerCase();
  const errorMessage = String(error?.message || '').toLowerCase();
  return task.status === 'failed'
    || taskStep.includes('hủy')
    || taskError.includes('hủy')
    || taskError.includes('cancel')
    || errorMessage.includes('hủy')
    || errorMessage.includes('cancel');
}

function applyRenderTaskFailure(task, error, state = shared.state) {
  state.isStudioRendering = false;
  state.activeRenderId = null;
  if (state.currentActiveTask === task) state.currentActiveTask = null;

  if (isRenderTaskCancellation(task, error)) {
    task.status = 'failed';
    task.step = 'Đã bị hủy';
    task.actionRequired = null;
    state.studioProgress = { status: 'idle', percent: 0, step: 'Đã hủy kết xuất', error: null };
    return 'cancelled';
  }

  if (error?.code === 'OCR_TECHNICAL_ERROR') {
    task.status = 'waiting_input';
    task.step = 'OCR gặp lỗi kỹ thuật';
    task.error = error.message;
    task.actionRequired = 'ocr_fallback';
    task.percent = Math.max(task.percent || 0, 12);
    state.studioProgress = {
      status: 'waiting_input',
      percent: task.percent,
      step: task.step,
      error: task.error
    };
    return 'waiting_input';
  }

  if (error?.code === 'SEGMENT_REVIEW_REQUIRED') {
    task.status = 'waiting_input';
    task.step = 'Cần duyệt lời thoại trước khi tạo giọng';
    task.error = null;
    task.actionRequired = 'segment_review';
    task.percent = Math.max(task.percent || 0, 38);
    state.studioProgress = {
      status: 'waiting_input',
      percent: task.percent,
      step: task.step,
      error: null
    };
    return 'waiting_input';
  }

  if (error?.code === 'TRANSLATION_INCOMPLETE') {
    task.status = 'error';
    task.translationReport = error.translationReport || task.translationReport || null;
    const stats = task.translationReport?.translation;
    task.step = stats
      ? `Dịch phụ đề chưa hoàn tất (${stats.translated}/${stats.total})`
      : 'Dịch phụ đề chưa hoàn tất';
    task.error = error.message;
    task.actionRequired = 'render_resume';
    state.studioProgress = {
      status: 'error',
      percent: Math.max(task.percent || 0, 35),
      step: task.step,
      error: task.error
    };
    return 'error';
  }

  task.status = 'error';
  task.error = error.message;
  task.step = 'Lỗi kết xuất';
  task.actionRequired = null;
  state.studioProgress = {
    status: 'error',
    percent: task.percent,
    step: 'Lỗi kết xuất: ' + error.message,
    error: error.message
  };
  return 'error';
}

async function cancelTaskVoiceEngine(task) {
  const engineId = task?.body?.voiceEngine || DEFAULT_VOICE_ENGINE_ID;
  const engineIds = task?.body?.narrationPipeline === 'legacy'
    ? [engineId]
    : [...new Set([engineId, 'edge-tts'])];
  for (const activeEngineId of engineIds) {
    try {
      await voiceEngineRegistry.cancel(activeEngineId);
    } catch (error) {
      console.warn(`[VoiceEngine] Không thể hủy ${activeEngineId}:`, error.message);
    }
  }
}

function cleanupRenderWorkDir(workDir, dependencies = {}) {
  const existsSync = dependencies.existsSync || fs.existsSync;
  const rmSync = dependencies.rmSync || fs.rmSync;
  const logger = dependencies.logger || console;
  try {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
      logger.log(`[Studio Render] Đã dọn thư mục tạm: ${workDir}`);
    }
  } catch (cleanErr) {
    logger.error('[Studio Render] Lỗi dọn dẹp temp:', cleanErr.message);
  }
}

function createVoiceChunkCheckpoint(workDir, signature, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const voiceDir = path.join(workDir, 'voice');
  const chunksDir = path.join(voiceDir, 'chunks');
  const rawDir = path.join(chunksDir, 'raw');
  const fittedDir = path.join(chunksDir, 'fitted');
  const statePath = path.join(voiceDir, 'checkpoint.json');
  let state = readJsonFile(statePath);

  if (state?.version !== 3 || state.globalSignature !== signature) {
    if (fileSystem.existsSync(voiceDir)) {
      fileSystem.rmSync(voiceDir, { recursive: true, force: true });
    }
    state = {
      version: 3,
      globalSignature: signature,
      completed: {},
      fitted: {},
      createdAt: new Date().toISOString()
    };
  }
  state.completed ||= {};
  state.fitted ||= {};
  fileSystem.mkdirSync(rawDir, { recursive: true });
  fileSystem.mkdirSync(fittedDir, { recursive: true });

  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath, state);
  };
  const normalizeKey = (key) => {
    if (Number.isInteger(key) || /^\d+$/.test(String(key))) {
      return String(key).padStart(4, '0');
    }
    const value = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!value) throw new Error('Mã checkpoint giọng nói không hợp lệ');
    return value;
  };
  const getRawChunkPath = (key) => path.join(rawDir, `chunk_${normalizeKey(key)}.wav`);
  const getFittedChunkPath = (key) => path.join(fittedDir, `chunk_${normalizeKey(key)}.wav`);
  const getChunkPath = getRawChunkPath;
  save();

  return {
    state,
    statePath,
    getChunkPath,
    getRawChunkPath,
    getFittedChunkPath,
    hasChunk(key, entrySignature = null) {
      const entry = state.completed[String(key)];
      return Boolean(
        entry
        && (!entrySignature || entry.signature === entrySignature)
        && isUsableFile(getRawChunkPath(key), 44)
      );
    },
    markChunk(key, entry) {
      state.completed[String(key)] = entry;
      save();
    },
    hasFittedChunk(key, fitSignature = null) {
      const entry = state.fitted[String(key)];
      return Boolean(
        entry
        && (!fitSignature || entry.signature === fitSignature)
        && isUsableFile(getFittedChunkPath(key), 44)
      );
    },
    markFittedChunk(key, entry) {
      state.fitted[String(key)] = entry;
      save();
    }
  };
}

function cleanupLegacyCheckpointFiles(workDir, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  if (!workDir || !fileSystem.existsSync(workDir)) return [];
  const legacyPattern = /^(?:chunk_\d+|ref_voice|combined_voice|instrumental|residual_vocals|original_audio)_\d+(?:_speedup)?\.wav$/;
  const removed = [];
  for (const name of fileSystem.readdirSync(workDir)) {
    if (!legacyPattern.test(name)) continue;
    const filePath = path.join(workDir, name);
    try {
      fileSystem.rmSync(filePath, { force: true });
      removed.push(filePath);
    } catch {}
  }
  return removed;
}

function findNextPendingRenderTask(queue) {
  return queue.find((task) => task.status === 'pending');
}

function createRenderQueueTask({ taskId, body, files, taskDir, createdAt = new Date() }) {
  const taskBody = { ...(body || {}) };
  const uiSnapshot = normalizeUiSnapshot(taskBody.uiSnapshot, taskBody);
  delete taskBody.uiSnapshot;
  return {
    id: taskId,
    projectId: taskBody.projectId || null,
    projectName: taskBody.projectName || 'Dự án chưa đặt tên',
    status: 'pending',
    percent: 0,
    step: 'Đang xếp hàng...',
    error: null,
    actionRequired: null,
    sourceVideoPath: null,
    forceWhisper: false,
    translationReport: null,
    backgroundSeparation: null,
    segmentReview: null,
    createdAt,
    body: taskBody,
    uiSnapshot,
    files,
    taskDir,
    workDir: renderJobStore.getWorkDir(taskId),
    currentStage: null,
    stages: {},
    result: null
  };
}


// Queue workers
async function executeRenderTask(task) {
  const tempFiles = [];
  const voiceChunks = [];
  const renderId = task.id;
  let workDir = null;

  global.activeRenderRes = null;
  shared.state.activeRenderId = renderId;
  shared.state.isStudioRendering = true;

  const res = {
    statusCode: 200,
    status: function (code) {
      this.statusCode = code;
      return this;
    },
    json: function (data) {
      if (this.statusCode >= 400 || data.error) {
        throw new Error(data.error || 'Lỗi không xác định khi kết xuất');
      }
      applyRenderTaskSuccess(task, data);
      renderJobStore.saveTask(task);
      return this;
    }
  };

  try {
    shared.state.studioProgress = {
      status: 'rendering',
      percent: 2,
      step: 'Khởi tạo thư mục làm việc...',
      error: null
    };
    task.status = 'rendering';
    task.percent = 2;
    task.step = 'Khởi tạo thư mục làm việc...';

    const body = task.body;
    const audioMastering = normalizeAudioMasteringConfig(body);
    if (body.narrationPipeline !== 'legacy') {
      // Track thuyết minh được chuẩn hóa một lần ở -16 LUFS trước khi trộn.
      // Mix cuối chỉ limiter, tránh loudnorm lần hai làm đổi tương quan giọng/nhạc.
      audioMastering.mixLoudnessEnabled = false;
    }
    const voiceProcessing = {
      enabled: audioMastering.enabled,
      voiceLufs: audioMastering.voiceLufs,
      truePeakDb: audioMastering.truePeakDb,
      loudnessRange: audioMastering.loudnessRange
    };
    const files = task.files || {};
    const timestamp = Date.now();
    renderJobStore.ensureJob(task.id);
    workDir = task.workDir || renderJobStore.getWorkDir(task.id);
    task.workDir = workDir;
    fs.mkdirSync(workDir, { recursive: true });
    cleanupLegacyCheckpointFiles(workDir);

    const preparedSource = await renderOrchestrator.runStage(task, 'prepare_source', async () => {
      const sourceVideoPath = resolveRenderSource(task);
      shared.updateStudioProgress(5, 'Đang phân tích thông tin video nguồn...');
      const dimensions = await shared.getVideoDimensions(sourceVideoPath);
      const totalDuration = await getVideoDurationInSeconds(sourceVideoPath);
      return {
        sourceVideoPath,
        width: dimensions.width,
        height: dimensions.height,
        totalDuration
      };
    });
    const sourceVideo = preparedSource.sourceVideoPath;
    const dimensions = preparedSource;
    const videoWidth = dimensions.width;
    const videoHeight = dimensions.height;
    const totalDuration = preparedSource.totalDuration;
    console.log(`[Studio Render] Kích thước video nguồn: ${videoWidth}x${videoHeight}, Thời lượng: ${totalDuration}s`);

    const backgroundStage = await renderOrchestrator.runStage(task, 'background_separation', async () => {
      if (body.keepOriginalBgmAI !== 'true') {
        return { instrumentalPath: null, residualVocalsPath: null, execution: null };
      }

      const tempAudioToSeparate = path.join(workDir, 'original_audio.wav');
      const instrumentalPath = path.join(workDir, 'instrumental.wav');
      const residualVocalsPath = path.join(workDir, 'residual_vocals.wav');
      try {
        if (isUsableFile(instrumentalPath, 44) && isUsableFile(residualVocalsPath, 44)) {
          shared.updateStudioProgress(6, 'Đang dùng lại nhạc nền MDX từ checkpoint...');
          return {
            instrumentalPath,
            residualVocalsPath,
            execution: task.backgroundSeparation || null
          };
        }

        if (!isUsableFile(tempAudioToSeparate, 44)) {
          await new Promise((resolve, reject) => {
            shared.execFile(shared.FFMPEG_PATH, [
              '-i', sourceVideo,
              '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
              '-y', tempAudioToSeparate
            ], (err, stdout, stderr) => {
              if (err) reject(new Error('Lỗi FFmpeg trích xuất audio gốc: ' + stderr));
              else resolve();
            });
          });
        }

        const requestedProvider = body.mdxProvider || 'auto';
        const execution = await mdxSeparatorManager.separate({
          requestedProvider,
          numThreads: body.mdxCpuThreads || 4,
          inputPath: tempAudioToSeparate,
          vocalsPath: instrumentalPath,
          accompanimentPath: residualVocalsPath,
          isCancelled: () => !shared.state.isStudioRendering || task.status === 'failed',
          onProviderSelected: ({ provider, reason }) => {
            const label = provider === 'cuda' ? 'NVIDIA CUDA' : 'CPU';
            const suffix = reason ? ` (${reason})` : '';
            shared.updateStudioProgress(6, `Đang dùng MDX ONNX ${label} tách nhạc nền${suffix}...`);
          },
          onFallback: ({ reason }) => {
            shared.updateStudioProgress(
              6,
              `MDX CUDA lỗi, đang chuyển sang CPU: ${reason}`
            );
          }
        });

        if (!fs.existsSync(instrumentalPath)) {
          throw new Error('MDX ONNX không tạo được file nhạc nền');
        }
        task.backgroundSeparation = execution;
        console.log(
          `[Studio Render] MDX ONNX đã tách xong bằng ${execution.usedProvider}:`,
          instrumentalPath
        );
        return { instrumentalPath, residualVocalsPath, execution };
      } catch (err) {
        if (!shared.state.isStudioRendering || task.status === 'failed') throw err;
        console.error('[Studio Render] Lỗi tách nhạc nền bằng AI:', err.message);
        if ((body.mdxProvider || 'auto') === 'cuda') throw err;
        task.backgroundSeparation = {
          requestedProvider: body.mdxProvider || 'auto',
          usedProvider: null,
          fallback: false,
          fallbackReason: null,
          error: err.message
        };
        return {
          instrumentalPath: null,
          residualVocalsPath: null,
          execution: task.backgroundSeparation
        };
      }
    });
    task.backgroundSeparation = backgroundStage.execution || task.backgroundSeparation || null;
    const extractedBgmPath = backgroundStage.instrumentalPath;

    let reactionVideoPath = null;
    const reactionMode = body.reactionMode || 'none';
    if (reactionMode === 'upload' && files.reactionUpload?.[0]) {
      reactionVideoPath = shared.moveUploadedFile(files.reactionUpload[0], workDir, 'reaction.mp4');
      tempFiles.push(reactionVideoPath);
    } else if (reactionMode === 'library' && body.savedReactionFile) {
      reactionVideoPath = shared.resolveAssetPath('video', body.savedReactionFile);
    }

    let logoPath = null;
    const logoRequested = body.logoEnabled === true || body.logoEnabled === 'true';
    if (logoRequested && !body.savedLogoFile) throw new Error('Hãy chọn logo trước khi render');
    if (logoRequested) {
      logoPath = shared.resolveAssetPath('logo', body.savedLogoFile);
      if (!logoPath) throw new Error('Logo đã chọn không còn tồn tại');
    }

    let subtitlePath = null;
    let subtitleMode = body.subtitleMode || 'none';
    const voiceMode = body.voiceMode || 'none';
    // Pipeline cue-based là đường mặc định mới. Đường grouped/Smart Fit cũ vẫn
    // được giữ dưới cờ legacy để có thể khôi phục mà không làm mất dữ liệu job cũ.
    const adaptiveNarrationEnabled = body.narrationPipeline !== 'legacy';
    const omiScriptText = (body.omiScript || '').trim();

    let isVoiceOnlySub = false;
    if (voiceMode === 'omi' && !omiScriptText && subtitleMode === 'none') {
      subtitleMode = 'generate';
      isVoiceOnlySub = true;
      console.log('[Studio Render] Tự động chuyển sang chế độ tạo phụ đề ngầm để phục vụ thuyết minh.');
    }

    const subtitleStage = await renderOrchestrator.runStage(task, 'subtitle', async () => {
      let resolvedSubtitlePath = null;
      let ocrReport = null;
      if (subtitleMode === 'upload' && files.subtitleUpload?.[0]) {
        shared.updateStudioProgress(10, 'Đang chuẩn bị file phụ đề tải lên...');
        resolvedSubtitlePath = shared.moveUploadedFile(files.subtitleUpload[0], shared.SUBTITLES_DIR, files.subtitleUpload[0].originalname);
      } else if (subtitleMode === 'saved') {
        shared.updateStudioProgress(10, 'Đang nạp file phụ đề đã chọn...');
        resolvedSubtitlePath = shared.resolveAssetPath('subtitle', body.savedSubtitleFile);
      } else if (subtitleMode === 'generate') {
        shared.updateStudioProgress(12, 'Đang chuẩn bị tạo phụ đề tự động bằng AI...');
        resolvedSubtitlePath = await resolveRenderAutomaticSubtitle({
          body,
          sourceVideo,
          workDir,
          totalDuration,
          isVoiceOnlySub,
          forceWhisper: task.forceWhisper === true,
          ffmpegPath: shared.FFMPEG_PATH
        });
        ocrReport = readJsonFile(path.join(workDir, 'ocr-report.json'));
      }
      return { subtitlePath: resolvedSubtitlePath, ocrReport };
    });
    subtitlePath = subtitleStage.subtitlePath;
    const ocrReport = subtitleStage.ocrReport || null;
    const sourceSubtitlePath = subtitlePath;

    let originalIsChinese = false;
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const originalSubContent = fs.readFileSync(subtitlePath, 'utf8');
      if (/[\u4e00-\u9fa5]/.test(originalSubContent)) {
        originalIsChinese = true;
        console.log('[Auto-Detect] Phát hiện video nguồn có phụ đề tiếng Trung.');
      }
    }

    const scaleFactor = 1.35;
    const studioFontSize = Math.round(Number(body.subtitleSize || 18) * scaleFactor);
    const studioMarginH = Number(body.subtitleMarginH || 20);
    const studioMarginL = (body.subtitleMarginL !== undefined && body.subtitleMarginL !== '') ? Number(body.subtitleMarginL) : studioMarginH;
    const studioMarginR = (body.subtitleMarginR !== undefined && body.subtitleMarginR !== '') ? Number(body.subtitleMarginR) : studioMarginH;

    const studioBoxWidth = videoWidth - studioMarginL - studioMarginR;
    const subtitleDisplayMaxLines = resolveDisplayMaxLines(videoWidth, videoHeight);
    console.log(
      `[Subtitle Layout] Tự động ${subtitleDisplayMaxLines} dòng cho video `
      + `${videoWidth}x${videoHeight}; giữ nguyên cue và timestamp.`
    );
    const requestedTargetLang = String(body.translateTargetLang || 'vi').toLowerCase().split(/[-_]/)[0];
    const targetLang = OUTPUT_LANGUAGE_BY_CODE[requestedTargetLang] ? requestedTargetLang : 'vi';
    const charWidthRatio = targetLang === 'zh' ? 1.0 : 0.5;
    const studioMaxChars = Math.max(10, Math.floor(studioBoxWidth / (studioFontSize * charWidthRatio)));

    let earlyTtsPipeline = null;
    const earlyPiperVoice = resolvePiperVoice(targetLang, body.piperVoice);
    const earlyTtsRequested = adaptiveNarrationEnabled
      && voiceMode === 'omi'
      && (body.voiceEngine || DEFAULT_VOICE_ENGINE_ID) === 'piper'
      && body.aiProvider === 'gemini-web'
      && body.translateVi === 'true'
      && Boolean(earlyPiperVoice)
      && !(body.dualVoiceEnabled === true || body.dualVoiceEnabled === 'true' || body.dualVoiceEnabled === 'on')
      && process.env.TTS_SOM !== '0';
    if (earlyTtsRequested) {
      try {
        const earlyEngine = voiceEngineRegistry.get('piper');
        await earlyEngine.loadModel();
        earlyTtsPipeline = new EarlyTtsPipeline({
          engine: earlyEngine,
          workDir: path.join(workDir, 'early-tts'),
          voice: earlyPiperVoice,
          language: targetLang,
          device: ['auto', 'cpu', 'cuda'].includes(body.piperDevice) ? body.piperDevice : 'auto',
          logger: console
        });
        console.log('[TTS đọc sớm] Piper đã sẵn sàng; mỗi lô Gemini hoàn tất sẽ được tạo giọng ngay.');
      } catch (error) {
        console.warn(`[TTS đọc sớm] Không khởi động được Piper, đường TTS chính vẫn tiếp tục: ${error.message}`);
      }
    }

    let translationStage;
    try {
      translationStage = await renderOrchestrator.runStage(task, 'translation', async () => {
      let finalSubtitlePath = subtitlePath;
      if (subtitlePath && body.translateVi === 'true') {
        const targetLanguageName = OUTPUT_LANGUAGE_BY_CODE[targetLang]?.label || targetLang.toUpperCase();
        shared.updateStudioProgress(35, `Đang dịch phụ đề sang ${targetLanguageName} bằng AI...`);
        const translatedPath = path.join(workDir, 'translated.srt');
        const translationResult = await translateSubtitles(subtitlePath, translatedPath, {
          aiProvider: body.aiProvider,
          geminiApiKey: body.geminiApiKey,
          geminiModel: body.geminiModel,
          openRouterApiKey: body.openRouterApiKey,
          openRouterModel: body.openRouterModel,
          ninerouterApiKey: body.ninerouterApiKey,
          ninerouterModel: body.ninerouterModel,
          ninerouterBaseUrl: body.ninerouterBaseUrl,
          opencodeModel: body.opencodeModel,
          openaiApiKey: body.openaiApiKey,
          openaiModel: body.openaiModel,
          targetLang,
          srcLang: originalIsChinese
            ? 'zho_Hans'
            : (body.whisperLanguage || body.ocrLanguage || 'auto'),
          translationStyles: body.translationStyles,
          onTranslationBatch: earlyTtsPipeline ? (translatedItems) => {
            earlyTtsPipeline.enqueue(translatedItems.map(item => ({
              ...item,
              startMs: srtTimeToMs(item.startTime),
              endMs: srtTimeToMs(item.endTime),
              nextStartMs: item.nextStartTime ? srtTimeToMs(item.nextStartTime) : null
            })));
          } : null
        }, subtitleDisplayMaxLines, studioMaxChars, () => shared.state.activeRenderId !== renderId);
        task.translationReport = translationResult?.report || null;
        finalSubtitlePath = translatedPath;
      } else if (subtitlePath && fs.existsSync(subtitlePath)) {
        shared.updateStudioProgress(35, 'Đang định dạng cấu trúc phụ đề...');
        try {
          formatSubtitleFile(subtitlePath, subtitleDisplayMaxLines, studioMaxChars);
        } catch (err) {
          console.error('Lỗi định dạng phụ đề ban đầu:', err.message);
        }
      }
      return {
        subtitlePath: finalSubtitlePath,
        translationReport: task.translationReport || null
      };
      });
    } catch (error) {
      if (earlyTtsPipeline) {
        await earlyTtsPipeline.cancel().catch(() => {});
      }
      throw error;
    }
    subtitlePath = translationStage.subtitlePath;
    task.translationReport = translationStage.translationReport || null;

    let segmentManifest = null;
    const segmentReviewEnabled = body.segmentReviewEnabled === true
      || body.segmentReviewEnabled === 'true'
      || body.segmentReviewEnabled === 'on';
    if (!adaptiveNarrationEnabled && voiceMode === 'omi' && subtitlePath && fs.existsSync(subtitlePath)) {
      segmentManifest = segmentService.createOrLoad({
        taskId: task.id,
        workDir,
        sourceSubtitlePath,
        finalSubtitlePath: subtitlePath,
        durationMs: totalDuration * 1000,
        reviewRequired: segmentReviewEnabled,
        defaultVoiceFile: body.savedVoiceFile || '',
        defaultEngineId: body.voiceEngine || DEFAULT_VOICE_ENGINE_ID,
        asrMetadataPath: fs.existsSync(`${sourceSubtitlePath}.asr.json`)
          ? `${sourceSubtitlePath}.asr.json`
          : null
      });
      task.segmentReview = segmentService.summarize(segmentManifest);
      renderJobStore.saveTask(task);

      if (segmentReviewEnabled && segmentManifest.reviewStatus !== 'approved') {
        throw new SegmentReviewRequiredError();
      }
      subtitlePath = segmentManifest.reviewedSrtPath;
    }

    let voicePath = null;
    renderOrchestrator.markStage(task, 'voice');
    if (voiceMode === 'upload' && files.voiceUpload?.[0]) {
      shared.updateStudioProgress(38, 'Đang chuẩn bị file lồng tiếng tải lên...');
      voicePath = shared.moveUploadedFile(files.voiceUpload[0], workDir, files.voiceUpload[0].originalname);
      tempFiles.push(voicePath);
    } else if (voiceMode === 'saved') {
      shared.updateStudioProgress(38, 'Đang nạp giọng lồng tiếng đã chọn...');
      voicePath = shared.resolveAssetPath('voice', body.savedVoiceFile);
    } else if (voiceMode === 'omi') {
      shared.updateStudioProgress(40, 'Đang khởi động voice engine...');
      const refAudioPath = shared.resolveAssetPath('voice', body.savedVoiceFile);
      let refText = (body.refText || '').trim();
      let omiScript = (body.omiScript || '').trim();
      const voiceEngineId = body.voiceEngine || DEFAULT_VOICE_ENGINE_ID;
      const allowCpuFallback = body.voiceAllowCpuFallback === true
        || body.voiceAllowCpuFallback === 'true'
        || body.voiceAllowCpuFallback === 'on';
      let voiceEngine;
      try {
        voiceEngine = voiceEngineRegistry.resolve(voiceEngineId, DEFAULT_VOICE_ENGINE_ID);
        await voiceEngine.loadModel();
      } catch (error) {
        if (adaptiveNarrationEnabled && voiceEngineId !== 'edge-tts') {
          console.warn(`[Dubbing] ${voiceEngineId} chưa sẵn sàng: ${error.message}. Chuyển sang Edge TTS.`);
          voiceEngine = voiceEngineRegistry.get('edge-tts');
          await voiceEngine.loadModel();
        } else {
          if (error instanceof VoiceEngineError) throw error;
          throw new VoiceEngineError(`Không thể khởi động voice engine: ${error.message}`, {
            code: error.code || 'VOICE_ENGINE_ERROR',
            engineId: voiceEngineId,
            cause: error
          });
        }
      }
      const voiceCapabilities = voiceEngine.getCapabilities();
      const supportsVoiceCloning = voiceCapabilities.cloneVoice === true;
      const edgeVoice = voiceEngine.id === 'edge-tts' ? String(body.edgeVoice || '') : '';
      const edgeRate = voiceEngine.id === 'edge-tts' ? String(body.edgeRate || '+0%') : '+0%';
      const edgePitch = voiceEngine.id === 'edge-tts' ? String(body.edgePitch || '+0Hz') : '+0Hz';
      const voiceLogTag = voiceEngine.id === 'edge-tts'
        ? 'EdgeTTS'
        : (voiceEngine.id === 'piper' ? 'Piper' : 'OmniVoice');
      const piperVoice = voiceEngine.id === 'piper'
        ? resolvePiperVoice(targetLang, body.piperVoice)
        : '';
      const piperDevice = voiceEngine.id === 'piper'
        ? (['auto', 'cpu', 'cuda'].includes(body.piperDevice) ? body.piperDevice : 'auto')
        : '';
      const requestedLanguage = String(targetLang || body.omiLanguage || 'vi')
        .toLowerCase().split(/[-_]/)[0];
      const requestedVoiceDevice = voiceEngine.id === 'edge-tts'
        ? 'cpu'
        : voiceEngine.id === 'piper'
          ? piperDevice
        : (body.omiDevice || process.env.OMNIVOICE_DEVICE || 'cpu');
      const onVoiceFallback = (detail) => {
        task.voiceExecution = {
          engineId: voiceEngine.id,
          requestedDevice: detail.from,
          usedDevice: detail.to,
          fallback: true,
          fallbackReason: detail.error
        };
        renderJobStore.saveTask(task);
        shared.updateStudioProgress(
          Math.max(40, Number(task.percent || 0)),
          `Voice engine dang chuyen tu ${detail.from} sang CPU theo cau hinh da chon...`
        );
      };
      const runVoiceEngine = async (options, selectedEngine = voiceEngine) => {
        const lockOwner = `render:${task.id}`;
        shared.acquireVoiceEngine(lockOwner);
        try {
          const selectedCapabilities = selectedEngine.getCapabilities();
          const method = selectedCapabilities.cloneVoice === true
            && options.referenceAudioPath
            && options.referenceText
            ? 'cloneVoice'
            : 'synthesize';
          const selectedIsEdge = selectedEngine.id === 'edge-tts';
          const selectedIsPiper = selectedEngine.id === 'piper';
          const result = await selectedEngine[method]({
            ...options,
            voice: selectedIsEdge
              ? (selectedEngine.id === voiceEngine.id && String(options.voice || '').includes('-')
                ? options.voice : edgeVoice)
              : (selectedIsPiper ? (options.voice || piperVoice) : options.voice),
            rate: selectedIsEdge ? edgeRate : options.rate,
            pitch: selectedIsEdge ? edgePitch : options.pitch,
            language: requestedLanguage,
            device: selectedIsEdge ? 'cpu' : requestedVoiceDevice,
            steps: options.steps || body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
            seed: resolveOmnivoiceSeed(options.seed ?? body.omiSeed),
            allowCpuFallback,
            onFallback: onVoiceFallback
          });
          task.voiceExecution = {
            engineId: result.engineId,
            requestedDevice: result.requestedDevice,
            usedDevice: result.usedDevice,
            fallback: result.fallback,
            language: result.language,
            persistentRuntime: result.persistentRuntime === true,
            referencePromptCache: result.referencePromptCache === true
          };
          renderJobStore.saveTask(task);
          return result;
        } finally {
          shared.releaseVoiceEngine(lockOwner);
        }
      };

      const runVoiceEngineBatch = async (items, selectedEngine = voiceEngine) => {
        const lockOwner = `render:${task.id}:batch`;
        shared.acquireVoiceEngine(lockOwner);
        try {
          const selectedIsEdge = selectedEngine.id === 'edge-tts';
          const selectedIsPiper = selectedEngine.id === 'piper';
          const preparedItems = items.map((item) => ({
            ...item,
            voice: selectedIsEdge
              ? (selectedEngine.id === voiceEngine.id && String(item.voice || '').includes('-')
                ? item.voice : edgeVoice)
              : (selectedIsPiper ? (item.voice || piperVoice) : item.voice),
            rate: selectedIsEdge ? edgeRate : item.rate,
            pitch: selectedIsEdge ? edgePitch : item.pitch,
            language: requestedLanguage,
            device: selectedIsEdge ? 'cpu' : requestedVoiceDevice
          }));
          const results = await selectedEngine.synthesizeBatch({
            items: preparedItems,
            concurrency: selectedEngine.getCapabilities().batchConcurrency || 1
          });
          const successfulResults = results.filter((item) => item.ok);
          const actualDevice = successfulResults.find((item) => item.result?.usedDevice)?.result?.usedDevice
            || (selectedIsEdge ? 'cpu' : requestedVoiceDevice);
          task.voiceExecution = {
            engineId: selectedEngine.id,
            requestedDevice: selectedIsEdge ? 'cpu' : requestedVoiceDevice,
            usedDevice: actualDevice,
            fallback: false,
            language: requestedLanguage,
            persistentRuntime: selectedEngine.getCapabilities().persistentRuntime === true,
            batch: {
              total: results.length,
              successful: successfulResults.length
            }
          };
          renderJobStore.saveTask(task);
          return results;
        } finally {
          shared.releaseVoiceEngine(lockOwner);
        }
      };

      let fallbackVoiceEngine = null;
      if (adaptiveNarrationEnabled && voiceEngine.id !== 'edge-tts') {
        try {
          fallbackVoiceEngine = voiceEngineRegistry.get('edge-tts');
        } catch (_) {
          fallbackVoiceEngine = null;
        }
      }

      if (earlyTtsPipeline) {
        const earlyCount = await earlyTtsPipeline.drain();
        console.log(`[TTS đọc sớm] Đã chuẩn bị trước ${earlyCount} cue trong lúc Gemini dịch.`);
      }

      let finalRefAudioPath = null;
      if (supportsVoiceCloning && refAudioPath) {
        const refCheckpointPath = path.join(workDir, 'ref-voice-checkpoint.json');
        const refCheckpointKey = createCheckpointSignature({
          version: 1,
          referenceAudio: getFileIdentity(refAudioPath),
          whisperModel: body.whisperModel || 'small',
          whisperVariant: ['q8', 'fp32', 'medium-q8'].includes(body.whisperOnnxVariant)
            ? body.whisperOnnxVariant
            : 'q8',
          language: body.ocrLanguage || ''
        });
        let refCheckpoint = readJsonFile(refCheckpointPath);
        if (refCheckpoint?.checkpointKey !== refCheckpointKey) {
          refCheckpoint = { version: 1, checkpointKey: refCheckpointKey };
        }

        if (!refText && refAudioPath) {
          const txtPath = refAudioPath.replace(path.extname(refAudioPath), '.txt');
          if (fs.existsSync(txtPath)) {
            try {
              refText = fs.readFileSync(txtPath, 'utf8').trim();
              console.log('Đã tìm thấy kịch bản giọng mẫu có sẵn:', refText);
            } catch (txtErr) {
              console.error('Lỗi khi đọc file kịch bản có sẵn:', txtErr.message);
            }
          }
        }

        if (!refText && refCheckpoint.refText) {
          refText = String(refCheckpoint.refText).trim();
          console.log('[OmniVoice] Dùng lại Ref-text từ checkpoint.');
        }

        if (!refText) {
          try {
            shared.updateStudioProgress(42, 'Đang trích xuất câu thoại từ giọng mẫu (AI Whisper)...');
            const { transcribeVoice } = require('../lib/whisper-helper');
            console.log('Đang tự động nhận diện câu thoại trong giọng mẫu...');
            refText = await transcribeVoice(
              refAudioPath,
              workDir,
              shared.FFMPEG_PATH,
              body.whisperModel || 'small',
              body.ocrLanguage,
              ['q8', 'fp32', 'medium-q8'].includes(body.whisperOnnxVariant) ? body.whisperOnnxVariant : 'q8'
            );
            console.log('Đã tự động trích xuất Ref-text:', refText);
            refCheckpoint.refText = refText;
            writeJsonAtomic(refCheckpointPath, refCheckpoint);
          } catch (err) {
            console.error('Lỗi tự động nhận dạng giọng mẫu:', err.message);
            return res.status(400).json({ error: 'Không thể tự nhận diện giọng mẫu. Vui lòng nhập thủ công Ref-text.' });
          }
        }

        if (!refText) {
          return res.status(400).json({ error: 'Không thể tự động nhận diện giọng mẫu (file quá nhiễu hoặc không có tiếng nói rõ ràng). Vui lòng nhập thủ công Ref-text hoặc chọn giọng mẫu khác.' });
        }

        refText = refText.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

        finalRefAudioPath = refAudioPath;
        const refWavPath = path.join(workDir, 'ref_voice.wav');
        try {
          if (refCheckpoint.convertedPath === refWavPath && isUsableFile(refWavPath, 44)) {
            shared.updateStudioProgress(45, 'Đang dùng lại giọng mẫu đã chuẩn hóa...');
          } else {
            shared.updateStudioProgress(45, 'Đang chuẩn bị giọng mẫu (FFmpeg)...');
            console.log('Đang chuyển đổi giọng mẫu sang định dạng WAV chuẩn 16kHz cho OmniVoice...');
            await new Promise((resolve, reject) => {
              shared.execFile(shared.FFMPEG_PATH, [
                '-i', refAudioPath,
                '-acodec', 'pcm_s16le',
                '-ar', '16000',
                '-ac', '1',
                '-y', refWavPath
              ], (err, stdout, stderr) => {
                if (err) reject(new Error('Lỗi FFmpeg: ' + stderr));
                else resolve();
              });
            });
            refCheckpoint.convertedPath = refWavPath;
            refCheckpoint.refText = refText;
            writeJsonAtomic(refCheckpointPath, refCheckpoint);
          }
          finalRefAudioPath = refWavPath;
        } catch (err) {
          console.error('Lỗi khi convert ref-audio sang WAV:', err.message);
          finalRefAudioPath = refAudioPath;
        }
      }

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        console.log(`Bắt đầu đồng bộ giọng đọc ${voiceLogTag} theo từng câu phụ đề...`);
        const Parser = require('srt-parser-2').default;
        const parser = new Parser();
        const srtContent = fs.readFileSync(subtitlePath, 'utf8');
        const srtArray = parser.fromSrt(srtContent).filter(item => item.text && item.text.trim());

        if (srtArray.length === 0) {
          return res.status(400).json({ error: 'File phụ đề rỗng hoặc không có nội dung chữ.' });
        }

        const groups = adaptiveNarrationEnabled
          ? srtArray.map((item) => [item])
          : segmentManifest
          ? segmentManifest.segments.map((segment) => [{
              id: segment.id,
              startTime: msToSrtTime(segment.startMs),
              endTime: msToSrtTime(segment.endMs),
              text: segment.text,
              segment
            }])
          : [];
        let currentGroup = [];

        if (!adaptiveNarrationEnabled && !segmentManifest) {
          for (let i = 0; i < srtArray.length; i++) {
            const item = srtArray[i];
            currentGroup.push(item);

            const currentEndMs = srtTimeToMs(item.endTime);
            const nextItem = srtArray[i + 1];

            let shouldSplit = false;
            if (!nextItem) {
              shouldSplit = true;
            } else {
              const nextStartMs = srtTimeToMs(nextItem.startTime);
              const gapMs = nextStartMs - currentEndMs;

              const endsWithPunctuation = /[.!?…。]$/.test(item.text.trim());
              if (gapMs > 1000 || endsWithPunctuation) {
                shouldSplit = true;
              }

              // Tách group nếu tổng thời gian đã vượt quá 10s để tránh đọc quá sớm
              if (!shouldSplit) {
                const groupStartMs = srtTimeToMs(currentGroup[0].startTime);
                if (currentEndMs - groupStartMs > 10000) {
                  shouldSplit = true;
                }
              }
            }

            if (shouldSplit) {
              groups.push(currentGroup);
              currentGroup = [];
            }
          }
        }

        if (groups.length === 0) {
          return res.status(400).json({ error: 'Không thể phân nhóm phụ đề.' });
        }

        const dualVoiceEnabled = adaptiveNarrationEnabled
          && (body.dualVoiceEnabled === true || body.dualVoiceEnabled === 'true' || body.dualVoiceEnabled === 'on')
          && ['piper', 'edge-tts'].includes(voiceEngine.id);
        let dualVoiceSpeakers = null;
        if (dualVoiceEnabled) {
          const analysisPath = path.join(workDir, 'speaker-analysis-16k.wav');
          try {
            if (!isUsableFile(analysisPath, 44)) {
              await new Promise((resolve, reject) => {
                shared.execFile(shared.FFMPEG_PATH, [
                  '-i', sourceVideo, '-vn', '-ac', '1', '-ar', '16000',
                  '-c:a', 'pcm_s16le', '-y', analysisPath
                ], (error, stdout, stderr) => {
                  if (error) reject(new Error(stderr || error.message));
                  else resolve();
                });
              });
            }
            const classified = classifyCueSpeakers(analysisPath, srtArray.map((item) => ({
              startMs: srtTimeToMs(item.startTime),
              endMs: srtTimeToMs(item.endTime)
            })));
            if (classified.accepted) {
              dualVoiceSpeakers = classified.speakers;
              console.log(
                `[Dubbing] Phân giọng F0: nam=${classified.maleCount},`
                + ` nữ=${classified.speakers.length - classified.maleCount},`
                + ` ngưỡng=${classified.thresholdHz.toFixed(1)}Hz.`
              );
            } else {
              console.warn('[Dubbing] Không đủ cao độ để phân hai giọng; dùng một giọng đã chọn.');
            }
          } catch (error) {
            console.warn(`[Dubbing] Phân hai giọng lỗi, dùng một giọng: ${error.message}`);
          }
        }
        const voiceForGroup = (groupIndex) => {
          const speaker = dualVoiceSpeakers?.[groupIndex];
          if (voiceEngine.id === 'edge-tts') {
            if (speaker === 'male') return String(body.edgeMaleVoice || 'vi-VN-NamMinhNeural');
            if (speaker === 'female') return String(body.edgeFemaleVoice || 'vi-VN-HoaiMyNeural');
            return edgeVoice;
          }
          if (voiceEngine.id === 'piper') {
            if (speaker === 'male') return String(body.piperMaleVoice || 'manhdung');
            if (speaker === 'female') return String(body.piperFemaleVoice || 'ngochuyen');
            return piperVoice;
          }
          return '';
        };

        const voiceCheckpointSignature = createCheckpointSignature({
          version: adaptiveNarrationEnabled ? 5 : 3,
          narrationPipeline: adaptiveNarrationEnabled ? 'adaptive-cue' : 'legacy-grouped',
          referenceAudio: supportsVoiceCloning ? getFileIdentity(refAudioPath) : null,
          refText: supportsVoiceCloning ? refText : '',
          engineId: voiceEngine.id,
          voice: edgeVoice || piperVoice,
          dualVoice: dualVoiceSpeakers ? {
            speakers: dualVoiceSpeakers,
            male: voiceEngine.id === 'edge-tts' ? body.edgeMaleVoice : body.piperMaleVoice,
            female: voiceEngine.id === 'edge-tts' ? body.edgeFemaleVoice : body.piperFemaleVoice
          } : null,
          rate: edgeRate,
          pitch: edgePitch,
          model: voiceEngine.id === DEFAULT_VOICE_ENGINE_ID
            ? getFileIdentity(shared.OMNIVOICE_MODEL_PATH)
            : voiceEngine.getCapabilities(),
          language: requestedLanguage,
          steps: body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
          seed: resolveOmnivoiceSeed(body.omiSeed),
          positionTemperature: '1.0'
        });
        const voiceCheckpoint = createVoiceChunkCheckpoint(workDir, voiceCheckpointSignature);
        const narrationTimeline = createTimelineState();
        const narrationPlacements = [];
        let narrationFailures = 0;
        const narrationTextForGroup = (groupIndex) => {
          const group = groups[groupIndex] || [];
          const text = group.map((item) => item.text.replace(/\n/g, ' ').trim())
            .join(' ')
            .normalize('NFC')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .trim();
          const normalizedText = normalizeTtsText(text, { language: requestedLanguage });
          if (!adaptiveNarrationEnabled || voiceEngine.id !== 'piper' || !normalizedText) return normalizedText;
          const currentItem = group[group.length - 1];
          const nextItem = groups[groupIndex + 1]?.[0];
          return preparePiperCueText(normalizedText, nextItem, {
            currentEndMs: currentItem ? srtTimeToMs(currentItem.endTime) : 0,
            nextStartMs: nextItem ? srtTimeToMs(nextItem.startTime) : 0,
            currentId: currentItem?.id,
            nextId: nextItem?.id
          });
        };

        if (adaptiveNarrationEnabled && voiceCapabilities.batchSynthesis === true) {
          const pendingBatch = [];
          for (let batchIndex = 0; batchIndex < groups.length; batchIndex++) {
            const group = groups[batchIndex];
            const text = narrationTextForGroup(batchIndex);
            if (!text) continue;
            const checkpointKey = group[0]?.segment?.id || batchIndex;
            const signature = createVoiceAudioSignature({
              text,
              voiceFile: '',
              referenceIdentity: null,
              referenceText: '',
              engineId: voiceEngine.id,
              voice: voiceForGroup(batchIndex),
              rate: edgeRate,
              pitch: edgePitch,
              steps: body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
              language: requestedLanguage,
              seed: resolveOmnivoiceSeed(body.omiSeed),
              positionTemperature: 1
            });
            if (voiceCheckpoint.hasChunk(checkpointKey, signature)) continue;
            const earlyRawPath = voiceCheckpoint.getRawChunkPath(checkpointKey);
            if (restoreVoiceCache(signature, earlyRawPath)) {
              voiceCheckpoint.markChunk(checkpointKey, {
                filePath: earlyRawPath,
                startMs: srtTimeToMs(group[0].startTime),
                endMs: srtTimeToMs(group[group.length - 1].endTime),
                signature,
                textSignature: createCheckpointSignature(text),
                contentCache: true
              });
              continue;
            }
            if (earlyTtsPipeline?.restore(group[0], text, earlyRawPath)) {
              await trimVoiceSilence({
                inputPath: earlyRawPath,
                ffmpegPath: shared.FFMPEG_PATH,
                runExecFile: shared.runExecFile
              });
              if (isNarrationAudioUsable(earlyRawPath)) {
                voiceCheckpoint.markChunk(checkpointKey, {
                  filePath: earlyRawPath,
                  startMs: srtTimeToMs(group[0].startTime),
                  endMs: srtTimeToMs(group[group.length - 1].endTime),
                  signature,
                  textSignature: createCheckpointSignature(text),
                  earlySynthesis: true
                });
                continue;
              }
            }
            pendingBatch.push({
              key: checkpointKey,
              text,
              signature,
              startMs: srtTimeToMs(group[0].startTime),
              endMs: srtTimeToMs(group[group.length - 1].endTime),
              outputPath: voiceCheckpoint.getRawChunkPath(checkpointKey),
              voice: voiceForGroup(batchIndex),
              lengthScale: 0.8
            });
          }
          if (pendingBatch.length > 0) {
            shared.updateStudioProgress(48, `Đang tạo trước ${pendingBatch.length} câu thoại theo lô...`);
            console.log(
              `[${voiceLogTag}] Tạo theo lô ${pendingBatch.length} cue,`
              + ` song song=${voiceCapabilities.batchConcurrency || 1}.`
            );
            const batchResults = await runVoiceEngineBatch(pendingBatch);
            for (const batchResult of batchResults) {
              const item = pendingBatch[batchResult.index];
              if (!batchResult.ok || !isUsableFile(item.outputPath, 44)) {
                console.warn(
                  `[Dubbing] Batch cue ${batchResult.index + 1} lỗi; sẽ retry riêng trong vòng chính:`
                  + ` ${batchResult.error?.message || 'audio rỗng'}`
                );
                continue;
              }
              await trimVoiceSilence({
                inputPath: item.outputPath,
                ffmpegPath: shared.FFMPEG_PATH,
                runExecFile: shared.runExecFile
              });
              if (!isNarrationAudioUsable(item.outputPath)) {
                console.warn(`[Dubbing] Batch cue ${batchResult.index + 1} có WAV câm/yếu; sẽ retry riêng.`);
                try { fs.rmSync(item.outputPath, { force: true }); } catch (_) {}
                continue;
              }
              voiceCheckpoint.markChunk(item.key, {
                filePath: item.outputPath,
                startMs: item.startMs,
                endMs: item.endMs,
                signature: item.signature,
                textSignature: createCheckpointSignature(item.text)
              });
              saveVoiceCache(item.signature, item.outputPath);
            }
          }
        }
        let defaultPreviewReference = null;
        if (supportsVoiceCloning && segmentManifest && body.savedVoiceFile) {
          defaultPreviewReference = await resolveVoiceReference({
            voiceFile: body.savedVoiceFile,
            defaultVoiceFile: body.savedVoiceFile,
            providedText: refText,
            workDir,
            whisperModel: body.whisperModel || 'small',
            whisperOnnxVariant: body.whisperOnnxVariant || 'q8',
            language: body.ocrLanguage || ''
          });
        }

        for (let idx = 0; idx < groups.length; idx++) {
          if (!shared.state.isStudioRendering || task.status === 'failed' || (task.step && task.step.includes('hủy'))) {
            console.log(`[Studio Render] Phát hiện đã hủy, dừng loop OmniVoice tại câu ${idx + 1}/${groups.length}`);
            throw new Error('Đã hủy kết xuất bởi người dùng');
          }
          const group = groups[idx];
          let lineText = narrationTextForGroup(idx);
          if (!lineText) continue;

          const startMs = srtTimeToMs(group[0].startTime);
          const endMs = srtTimeToMs(group[group.length - 1].endTime);
          const durationSec = Math.max(0.5, (endMs - startMs) / 1000);
          const progressPercent = 48 + Math.floor((idx / groups.length) * 30);
          const segment = group[0].segment || null;
          const checkpointKey = segment?.id || idx;
          let segmentReferenceAudioPath = supportsVoiceCloning ? finalRefAudioPath : null;
          let segmentReferenceText = supportsVoiceCloning ? refText : '';
          let segmentReferenceIdentity = supportsVoiceCloning ? getFileIdentity(refAudioPath) : null;
          let legacyReferenceAudioPath = defaultPreviewReference?.audioPath || finalRefAudioPath;
          const segmentVoiceFile = segment?.voiceFile || body.savedVoiceFile || '';
          if (supportsVoiceCloning && segment && segmentVoiceFile && segmentVoiceFile !== body.savedVoiceFile) {
            const segmentReference = await resolveVoiceReference({
              voiceFile: segmentVoiceFile,
              defaultVoiceFile: body.savedVoiceFile || '',
              providedText: '',
              workDir,
              whisperModel: body.whisperModel || 'small',
              whisperOnnxVariant: body.whisperOnnxVariant || 'q8',
              language: body.ocrLanguage || ''
            });
            segmentReferenceAudioPath = segmentReference.audioPath;
            segmentReferenceText = segmentReference.text;
            segmentReferenceIdentity = segmentReference.sourceIdentity;
            legacyReferenceAudioPath = segmentReference.audioPath;
          }
          const initialChunkSignature = createVoiceAudioSignature({
            text: lineText,
            voiceFile: segmentVoiceFile,
            referenceIdentity: segmentReferenceIdentity,
            referenceText: segmentReferenceText,
            engineId: voiceEngine.id,
            voice: voiceForGroup(idx),
            rate: edgeRate,
            pitch: edgePitch,
            steps: body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
            language: requestedLanguage,
            seed: resolveOmnivoiceSeed(body.omiSeed),
            positionTemperature: 1
          });
          const legacyChunkSignature = supportsVoiceCloning && segment
            ? createLegacyVoiceAudioSignature({
                text: lineText,
                voiceFile: segmentVoiceFile,
                referenceAudioPath: legacyReferenceAudioPath,
                referenceText: segmentReferenceText,
                engineId: voiceEngine.id,
                steps: body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
                language: ['vi', 'en', 'zh'].includes(body.omiLanguage) ? body.omiLanguage : 'vi'
              })
            : null;
          const rawChunkPath = voiceCheckpoint.getRawChunkPath(checkpointKey);
          const fittedChunkPath = voiceCheckpoint.getFittedChunkPath(checkpointKey);
          let hasRawChunk = voiceCheckpoint.hasChunk(checkpointKey, initialChunkSignature);

          if (!hasRawChunk && restoreVoiceCache(initialChunkSignature, rawChunkPath)) {
            hasRawChunk = true;
            voiceCheckpoint.markChunk(checkpointKey, {
              filePath: rawChunkPath,
              startMs,
              endMs,
              signature: initialChunkSignature,
              textSignature: createCheckpointSignature(lineText),
              contentCache: true
            });
          }

          if (hasRawChunk) {
            shared.updateStudioProgress(
              progressPercent,
              `AI Cloner: Dùng lại câu thoại ${idx + 1}/${groups.length} từ checkpoint...`
            );
          }

          const reusableSegmentAudio = segment && (
            segment.rawAudioSignature === initialChunkSignature
            || segment.rawAudioSignature === legacyChunkSignature
          );
          if (!hasRawChunk && reusableSegmentAudio) {
            const previewPath = segmentService.getRawAudioPath(workDir, segment.id);
            if (previewPath && path.resolve(previewPath) !== path.resolve(rawChunkPath)) {
              fs.mkdirSync(path.dirname(rawChunkPath), { recursive: true });
              fs.copyFileSync(previewPath, rawChunkPath);
              hasRawChunk = true;
              shared.updateStudioProgress(
                progressPercent,
                `AI Cloner: Dùng audio đã duyệt cho câu ${idx + 1}/${groups.length}...`
              );
            }
          }

          if (!hasRawChunk) {
            shared.updateStudioProgress(progressPercent, `AI Cloner: Đang đọc câu thoại ${idx + 1}/${groups.length}...`);
          }

          const usedDevice = requestedVoiceDevice;
          const voiceLogDetails = voiceEngine.id === 'edge-tts'
            ? `Voice: ${voiceForGroup(idx)}, Rate: ${edgeRate}, Pitch: ${edgePitch}`
            : (voiceEngine.id === 'piper' ? `Voice: ${voiceForGroup(idx)}, Device: ${piperDevice}` : `Device: ${usedDevice}`);

          console.log(
            `[${voiceLogTag}-Sub] ${hasRawChunk ? 'Dùng lại audio' : 'Đang đọc'} nhóm câu`
            + ` ${idx + 1}/${groups.length}: "${lineText}"`
            + ` (Thời lượng sub: ${durationSec.toFixed(2)}s,`
            + ` Bắt đầu: ${(startMs / 1000).toFixed(2)}s, ${voiceLogDetails})`
          );
          try {
            let rawDurationMs;
            let chunkSignature;
            let fitSignature;
            let fitPlan;
            let narration;
              try {
                const narrationOptions = {
                  initialText: lineText,
                  startMs,
                  endMs,
                  createSignature: (text) => createVoiceAudioSignature({
                    text,
                    voiceFile: segmentVoiceFile,
                    referenceIdentity: segmentReferenceIdentity,
                    referenceText: segmentReferenceText,
                    engineId: voiceEngine.id,
                    voice: voiceForGroup(idx),
                    rate: edgeRate,
                    pitch: edgePitch,
                    steps: body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
                    language: requestedLanguage,
                    seed: resolveOmnivoiceSeed(body.omiSeed),
                    positionTemperature: 1
                  }),
                  isReusable: (signature) => (
                    signature === initialChunkSignature
                    && hasRawChunk
                    && isUsableFile(rawChunkPath, 44)
                  ),
                  synthesize: async (text) => {
                    const synthesisOptions = {
                      text,
                      outputPath: rawChunkPath,
                      voice: voiceForGroup(idx),
                      steps: body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
                      positionTemperature: 1,
                      referenceAudioPath: segmentReferenceAudioPath,
                      referenceText: segmentReferenceText,
                      instruct: 'female'
                    };
                    if (!adaptiveNarrationEnabled) {
                      fs.rmSync(rawChunkPath, { force: true });
                      await runVoiceEngine(synthesisOptions);
                    } else {
                      const synthesis = await synthesizeWithFallback({
                        primary: voiceEngine,
                        fallback: fallbackVoiceEngine,
                        beforeAttempt: async (engine) => {
                          if (engine.id !== voiceEngine.id) await engine.loadModel();
                          fs.rmSync(rawChunkPath, { force: true });
                        },
                        synthesize: (engine) => runVoiceEngine(synthesisOptions, engine),
                        validate: () => isNarrationAudioUsable(rawChunkPath),
                        onAttemptError: (error, engine) => {
                          console.warn(
                            `[Dubbing] ${engine.name || engine.id} lỗi ở cue ${idx + 1}: ${error.message}`
                          );
                        }
                      });
                      if (synthesis.fallback) {
                        console.log(`[Dubbing] Cue ${idx + 1} đã được cứu bằng ${synthesis.engine.name}.`);
                      }
                    }
                    if (!isUsableFile(rawChunkPath, 44)) {
                      throw new Error('Voice engine không tạo được audio thuyết minh');
                    }
                  },
                  measureDuration: () => readWavDurationMs(rawChunkPath)
                };
                if (adaptiveNarrationEnabled) {
                  const originalText = lineText;
                  const signature = narrationOptions.createSignature(originalText);
                  const reusable = narrationOptions.isReusable(signature);
                  if (!reusable) {
                    await narrationOptions.synthesize(originalText);
                    await trimVoiceSilence({
                      inputPath: rawChunkPath,
                      ffmpegPath: shared.FFMPEG_PATH,
                      runExecFile: shared.runExecFile
                    });
                    if (!isNarrationAudioUsable(rawChunkPath)) {
                      const silentError = new Error('Voice engine tạo WAV câm hoặc âm lượng quá thấp');
                      silentError.code = 'VOICE_AUDIO_SILENT';
                      throw silentError;
                    }
                  }
                  const measuredDurationMs = narrationOptions.measureDuration();
                  narration = {
                    text: originalText,
                    originalText,
                    signature,
                    rawDurationMs: measuredDurationMs,
                    fitPlan: planAdaptiveCue({
                      startMs,
                      endMs,
                      rawDurationMs: measuredDurationMs,
                      state: narrationTimeline
                    }),
                    attempts: 0,
                    shortened: false
                  };
                } else {
                  narration = await generateNarrationWithinCue(narrationOptions);
                }
                lineText = narration.text;
                rawDurationMs = narration.rawDurationMs;
                chunkSignature = narration.signature;
                fitPlan = narration.fitPlan;
                voiceCheckpoint.markChunk(checkpointKey, {
                  filePath: rawChunkPath,
                  startMs,
                  endMs,
                  signature: chunkSignature,
                  textSignature: createCheckpointSignature(lineText)
                });
                saveVoiceCache(chunkSignature, rawChunkPath);
                fitSignature = adaptiveNarrationEnabled
                  ? createCheckpointSignature({
                      version: 2,
                      type: 'adaptive-cue-fit',
                      rawSignature: chunkSignature,
                      rawFile: getFileIdentity(rawChunkPath),
                      plan: fitPlan,
                      audioProcessing: voiceProcessing,
                      stretchEngine: process.env.DUB_STRETCH === 'ffmpeg' ? 'ffmpeg' : 'audiostretchy-first',
                      internalSilenceKeepSeconds: 0.18
                    })
                  : createSmartFitSignature({
                      rawSignature: chunkSignature,
                      rawFile: getFileIdentity(rawChunkPath),
                      mode: 'cue',
                      startMs,
                      endMs,
                      audioProcessing: voiceProcessing
                    });
                if (!voiceCheckpoint.hasFittedChunk(checkpointKey, fitSignature)) {
                  await createFittedVoiceChunk({
                    rawPath: rawChunkPath,
                    outputPath: fittedChunkPath,
                    fitPlan,
                    ffmpegPath: shared.FFMPEG_PATH,
                    runExecFile: shared.runExecFile,
                    normalizationOptions: {
                      integratedLufs: audioMastering.voiceLufs,
                      loudnessRange: audioMastering.loudnessRange,
                      truePeakDb: audioMastering.truePeakDb,
                      skipLoudness: adaptiveNarrationEnabled
                    },
                    audioStretchy: stretchVoiceWithAudioStretchy,
                    label: `Nhóm câu ${idx + 1}`
                  });
                }
                if (!isNarrationAudioUsable(fittedChunkPath, { minimumRmsDbfs: -45, minimumPeakDbfs: -36 })) {
                  const silentError = new Error('Audio sau Smart Fit bị câm hoặc quá yếu');
                  silentError.code = 'VOICE_FITTED_AUDIO_SILENT';
                  throw silentError;
                }
              } catch (speedUpErr) {
                console.error(`[${voiceLogTag}-Sub] Lỗi khi xử lý tăng tốc nhóm câu ${idx + 1}:`, speedUpErr.message);
                throw speedUpErr;
              }

              voiceChunks.push({
                filePath: fittedChunkPath,
                startMs: adaptiveNarrationEnabled ? fitPlan.placementStartMs : startMs
              });
              if (adaptiveNarrationEnabled) {
                narrationPlacements.push({
                  cueIndex: idx,
                  startMs: fitPlan.placementStartMs,
                  endMs: fitPlan.placementEndMs
                });
              }
              const fittedQuality = analyzeWavFile(fittedChunkPath);
              voiceCheckpoint.markFittedChunk(checkpointKey, {
                filePath: fittedChunkPath,
                signature: fitSignature,
                plan: fitPlan,
                quality: fittedQuality
              });
              if (segment) {
                const audioQuality = fittedQuality;
                const fittedDurationMs = audioQuality.durationMs;
                segmentManifest = segmentService.setSegmentAudio(workDir, segment.id, {
                  status: 'ready',
                  rawAudioFile: path.relative(workDir, rawChunkPath),
                  rawAudioDurationMs: rawDurationMs,
                  rawAudioSignature: chunkSignature,
                  audioFile: path.relative(workDir, fittedChunkPath),
                  audioDurationMs: fittedDurationMs,
                  audioSignature: fitSignature,
                  audioQuality,
                  fit: { ...fitPlan, fittedDurationMs, signature: fitSignature },
                  narrationText: narration.text,
                  narrationFit: {
                    shortened: narration.shortened || segment.narrationFit?.shortened === true,
                    originalText: segment.narrationFit?.originalText || narration.originalText,
                    attempts: (Number(segment.narrationFit?.attempts) || 0) + narration.attempts,
                    maxSpeed: fitPlan.maxSpeed,
                    finalSpeed: fitPlan.speed
                  }
                });
                task.segmentReview = segmentService.summarize(segmentManifest);
                renderJobStore.saveTask(task);
            }
          } catch (err) {
            console.error(`Lỗi khi thuyết minh nhóm câu ${idx + 1}/${groups.length}:`, err.stderr || err.message);
            if (!adaptiveNarrationEnabled) throw err;
            narrationFailures += 1;
            console.warn(`[Dubbing] Bỏ cue ${idx + 1}; sẽ kiểm tra độ phủ sau khi hoàn tất.`);
          }
        }

        if (adaptiveNarrationEnabled) {
          const coverage = evaluateCoverage(groups.length, voiceChunks.length);
          task.voiceCoverage = {
            ...coverage,
            failed: narrationFailures,
            timeline: { ...narrationTimeline }
          };
          renderJobStore.saveTask(task);
          console.log(
            `[Dubbing] Độ phủ ${coverage.successful}/${coverage.total}`
            + ` (${Math.round(coverage.ratio * 100)}%), catch-up=${narrationTimeline.catchUps},`
            + ` cap-hit=${narrationTimeline.capHits}.`
          );
          if (!coverage.accepted) {
            const coverageError = new Error(
              `Thuyết minh chỉ tạo được ${coverage.successful}/${coverage.total} cue; thấp hơn ngưỡng ${Math.round(coverage.minimum * 100)}%.`
            );
            coverageError.code = 'VOICE_COVERAGE_TOO_LOW';
            throw coverageError;
          }
          const subtitleSyncRequested = body.syncSubtitleToVoice === true
            || body.syncSubtitleToVoice === 'true'
            || body.syncSubtitleToVoice === 'on';
          const onsetGuard = evaluateOnsetAlignment(srtArray, narrationPlacements);
          task.voiceSubtitleSync = { requested: subtitleSyncRequested, ...onsetGuard };
          renderJobStore.saveTask(task);
          if (subtitleSyncRequested && onsetGuard.accepted) {
            const alignedSubtitlePath = path.join(workDir, 'voice-aligned.srt');
            const alignedCues = alignSubtitleCuesToNarration(srtArray, narrationPlacements);
            fs.writeFileSync(alignedSubtitlePath, parser.toSrt(alignedCues), 'utf8');
            subtitlePath = alignedSubtitlePath;
            console.log(
              `[Dubbing] Đã đồng bộ onset phụ đề theo ${narrationPlacements.length}`
              + ` cue giọng đọc: ${alignedSubtitlePath}`
            );
          } else if (subtitleSyncRequested) {
            console.warn(
              `[Dubbing] Giữ timing SRT gốc vì onset không an toàn:`
              + ` ${onsetGuard.reasons.join(', ') || 'không có onset'}.`
            );
          }
        }

        if (voiceChunks.length === 0) {
          return res.status(400).json({ error: 'Không thể tạo được bất kỳ file âm thanh nào cho các câu phụ đề.' });
        }

        voiceChunks.sort((a, b) => a.startMs - b.startMs);

        try {
          shared.updateStudioProgress(78, 'Đang gộp các đoạn giọng nói...');
          console.log(`[${voiceLogTag}] Đang gộp các chunk giọng nói thành một file duy nhất...`);
          let maxEndMs = 0;
          const chunkDataList = [];
          let combinedSampleRate = null;
          let combinedBlockAlign = null;
          let combinedByteRate = null;

          for (let ci = 0; ci < voiceChunks.length; ci++) {
            const chunk = voiceChunks[ci];
            const wavInfo = readPcm16WavFile(chunk.filePath);
            const {
              sampleRate,
              channels,
              bitsPerSample,
              blockAlign,
              byteRate,
              dataSize,
              pcmBuffer
            } = wavInfo;
            if (channels !== 1 || bitsPerSample !== 16) {
              throw new Error(`Chunk WAV phải là PCM 16-bit mono: ${chunk.filePath}`);
            }
            if (combinedSampleRate === null) {
              combinedSampleRate = sampleRate;
              combinedBlockAlign = blockAlign;
              combinedByteRate = byteRate;
            } else if (
              sampleRate !== combinedSampleRate
              || blockAlign !== combinedBlockAlign
              || byteRate !== combinedByteRate
            ) {
              throw new Error(`Các chunk WAV không cùng định dạng: ${chunk.filePath}`);
            }
            const durationMs = (dataSize / byteRate) * 1000;
            const endMs = chunk.startMs + durationMs;
            if (endMs > maxEndMs) {
              maxEndMs = endMs;
            }

            chunkDataList.push({
              startMs: chunk.startMs,
              pcmBuffer: pcmBuffer,
              durationMs: durationMs,
              sampleRate,
              blockAlign
            });
          }

          if (maxEndMs > 0) {
            const maxSafeMs = Math.min(maxEndMs, 7200000);
            const combinedFrameCount = Math.ceil(maxSafeMs * combinedSampleRate / 1000);
            const combinedDataSize = combinedFrameCount * combinedBlockAlign;
            let combinedBuffer;
            try {
              combinedBuffer = Buffer.alloc(combinedDataSize);
            } catch (e) {
              throw new Error(`Không thể cấp phát bộ nhớ cho WAV gộp (${(combinedDataSize / 1024 / 1024).toFixed(0)}MB): ${e.message}`);
            }

            for (const chunk of chunkDataList) {
              const targetFrame = Math.max(0, Math.round(chunk.startMs * chunk.sampleRate / 1000));
              const targetOffset = targetFrame * chunk.blockAlign;
              const pcmLength = chunk.pcmBuffer.length;
              const availableBytes = Math.max(0, combinedDataSize - targetOffset);
              const limit = Math.floor(
                Math.min(pcmLength, availableBytes) / chunk.blockAlign
              ) * chunk.blockAlign;

              for (let i = 0; i < limit; i += 2) {
                if (targetOffset + i + 1 >= combinedDataSize) break;

                const sample1 = combinedBuffer.readInt16LE(targetOffset + i);
                const sample2 = chunk.pcmBuffer.readInt16LE(i);

                let mixed = sample1 + sample2;
                if (mixed > 32767) mixed = 32767;
                else if (mixed < -32768) mixed = -32768;

                combinedBuffer.writeInt16LE(mixed, targetOffset + i);
              }
            }

            const wavHeader = createWavHeader(combinedDataSize, combinedSampleRate, 1, 16);
            voicePath = path.join(workDir, 'voice', 'combined_voice.wav');
            fs.writeFileSync(voicePath, Buffer.concat([wavHeader, combinedBuffer]));
            const voiceLoudness = await normalizeVoiceTrackFast({
              inputPath: voicePath,
              ffmpegPath: shared.FFMPEG_PATH,
              runExecFile: shared.runExecFile,
              targetLufs: -16,
              truePeakDb: -1.5,
              logger: console
            });
            audioMastering.voicePreNormalized = true;
            task.voiceLoudness = voiceLoudness;
            if (!isNarrationAudioUsable(voicePath, { minimumRmsDbfs: -60, minimumPeakDbfs: -42 })) {
              try { fs.rmSync(voicePath, { force: true }); } catch (_) {}
              voicePath = null;
              const silentTrackError = new Error('Track thuyết minh sau khi gộp bị câm hoặc quá yếu');
              silentTrackError.code = 'VOICE_TRACK_SILENT';
              throw silentTrackError;
            }
            tempFiles.push(voicePath);

            console.log(`[${voiceLogTag}] Đã gộp thành công ${voiceChunks.length} chunk thành file đơn: ${voicePath} (Thời lượng: ${(maxEndMs / 1000).toFixed(2)}s, Sample Rate: ${combinedSampleRate}Hz)`);
            voiceChunks.length = 0;
          }
        } catch (mergeErr) {
          console.error(`[${voiceLogTag}] Lỗi khi gộp các file chunk âm thanh:`, mergeErr.message);
          console.warn(`[${voiceLogTag}] Dùng các chunk riêng lẻ (adelay) với cảnh báo: chất lượng ghép nối có thể không mượt.`);
          // Không throw — để render tiếp với individual chunks (voiceChunks chưa bị clear)
        }
      } else {
        if (!omiScript && subtitlePath && fs.existsSync(subtitlePath)) {
          try {
            const Parser = require('srt-parser-2').default;
            const parser = new Parser();
            const srtContent = fs.readFileSync(subtitlePath, 'utf8');
            const srtArray = parser.fromSrt(srtContent);
            omiScript = srtArray.map(item => item.text.replace(/\n/g, ' ')).join(' ');
            console.log('Tự động lấy kịch bản từ phụ đề tiếng Việt (fallback):', omiScript);
          } catch (e) {
            console.error('Lỗi phân tích phụ đề làm kịch bản:', e.message);
          }
        }

        if (!omiScript) {
          return res.status(400).json({ error: 'Vui lòng nhập kịch bản hoặc bật chế độ phụ đề để voice engine tự đọc.' });
        }

        omiScript = normalizeTtsText(omiScript, { language: requestedLanguage });
        voicePath = path.join(workDir, `voice_${voiceEngine.id}_${timestamp}.wav`);
        const usedDevice = requestedVoiceDevice;
        const estDuration = finalRefAudioPath && refText
          ? null
          : Math.max(1.5, omiScript.length * 0.075);

        console.log('\n======================================================================');
        console.log(`[OmniVoice] Kịch bản đang đọc (${body.omiLanguage || 'vi'}, Device: ${usedDevice}):\n${omiScript}`);
        console.log('======================================================================\n');

        const scriptOutName = `studio_${timestamp}.txt`;
        fs.writeFileSync(path.join(shared.RENDERS_DIR, scriptOutName), omiScript, 'utf8');
        console.log(`[OmniVoice] Đã xuất kịch bản thành file văn bản: ${path.join(shared.RENDERS_DIR, scriptOutName)}`);

        shared.updateStudioProgress(55, 'AI Cloner: Đang đọc toàn bộ kịch bản...');
        await runVoiceEngine({
          text: omiScript,
          outputPath: voicePath,
          steps: body.omiSteps || process.env.OMNIVOICE_STEPS || '8',
          positionTemperature: 1.5,
          duration: estDuration ? Number(estDuration.toFixed(1)) : undefined,
          referenceAudioPath: finalRefAudioPath,
          referenceText: refText,
          instruct: 'female'
        });
        tempFiles.push(voicePath);
      }
    }

    shared.updateStudioProgress(80, 'Đang chuẩn bị các track nhạc nền và lồng tiếng...');
    let musicPath = null;
    const musicMode = body.musicMode || 'none';
    if (extractedBgmPath) {
      musicPath = extractedBgmPath;
    } else if (musicMode === 'upload' && files.musicUpload?.[0]) {
      musicPath = shared.moveUploadedFile(files.musicUpload[0], shared.MUSIC_DIR, files.musicUpload[0].originalname);
    } else if (musicMode === 'saved') {
      musicPath = shared.resolveAssetPath('music', body.savedMusicFile);
    }

    renderOrchestrator.markStage(task, 'render');
    const hasCUDA = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\nvcuda.dll');
    const outName = `studio_${timestamp}.mp4`;
    const outPath = path.join(shared.RENDERS_DIR, outName);
    const args = ['-i', sourceVideo];
    const audioInputs = [];

    const voiceVolume = Math.max(0, Number(body.voiceVolume !== undefined ? body.voiceVolume : 1.0));

    if (voiceChunks && voiceChunks.length > 0) {
      voiceChunks.forEach(chunk => {
        args.push('-i', chunk.filePath);
        audioInputs.push({
          index: args.filter(v => v === '-i').length - 1,
          volume: voiceVolume,
          type: 'chunk',
          startMs: chunk.startMs
        });
      });
    } else if (voicePath) {
      args.push('-i', voicePath);
      audioInputs.push({
        index: args.filter(v => v === '-i').length - 1,
        volume: voiceVolume,
        type: 'single'
      });
    }

    if (musicPath) {
      args.push('-stream_loop', '-1', '-i', musicPath);
      const bgmVolume = Math.max(0, Number(body.musicVolume || 0.18));
      audioInputs.push({
        index: args.filter(v => v === '-i').length - 1,
        volume: bgmVolume,
        type: 'music'
      });
    }

    let reactionInputIndex = -1;
    if (reactionVideoPath) {
      args.push('-stream_loop', '-1', '-i', reactionVideoPath);
      reactionInputIndex = args.filter(v => v === '-i').length - 1;
      if (body.reactionAudio === 'true') {
        audioInputs.push({
          index: reactionInputIndex,
          volume: 1.0,
          type: 'reaction'
        });
      }
    }

    let logoInputIndex = -1;
    if (logoPath) {
      args.push('-loop', '1', '-framerate', '25', '-i', logoPath);
      logoInputIndex = args.filter(value => value === '-i').length - 1;
    }

    let renderSubtitlePath = null;
    let videoFilter = null;
    let hasVideoFilter = false;

    if (subtitlePath && body.burnSub === 'true' && !isVoiceOnlySub) {
      const scaleFactor = 1.35;
      const fontSize = Math.round(Number(body.subtitleSize || 18) * scaleFactor);
      const marginV = Number(body.subtitleMargin || 28);
      const marginH = Number(body.subtitleMarginH || 20);
      // Đọc marginL và marginR riêng biệt, fallback về marginH đối xứng
      const marginL = (body.subtitleMarginL !== undefined && body.subtitleMarginL !== '') ? Number(body.subtitleMarginL) : marginH;
      const marginR = (body.subtitleMarginR !== undefined && body.subtitleMarginR !== '') ? Number(body.subtitleMarginR) : marginH;
      const boxWidth = videoWidth - marginL - marginR;
      const maxChars = Math.max(10, Math.floor(boxWidth / (fontSize * 0.5)));

      try {
        formatSubtitleFile(subtitlePath, subtitleDisplayMaxLines, maxChars);
      } catch (err) {
        console.error('Lỗi định dạng phụ đề 1-2 dòng:', err.message);
      }

      const ssaToAssAlignment = {
        1: 1, 2: 2, 3: 3, 9: 4, 10: 5, 11: 6, 5: 7, 6: 8, 7: 9
      };
      const alignment = ssaToAssAlignment[Number(body.subtitleAlignment || 2)] || 2;
      const fontName = body.subtitleFont || 'Arial';
      const isBold = body.subtitleBold !== 'false';
      const assColor = hexToAssColor(body.subtitleColor || '#FFFFFF');
      const theme = body.subtitleTheme || 'outline';

      let borderStyle = 1;
      let outline = 2.5 * scaleFactor;
      let shadow = 1 * scaleFactor;
      let outlineColor = '&H00000000';
      let backColor = '&H80000000';
      let finalAssColor = assColor;

      if (theme === 'box') {
        borderStyle = 3;
        backColor = '&H66000000';
        outlineColor = '&H66000000';
        outline = 4.0 * scaleFactor;
        shadow = 0;
      } else if (theme === 'box-deep') {
        borderStyle = 3;
        backColor = '&H0D000000';
        outlineColor = '&H0D000000';
        outline = 4.0 * scaleFactor;
        shadow = 0;
      } else if (theme === 'shadow') {
        borderStyle = 1;
        outline = 0;
        shadow = 2 * scaleFactor;
        backColor = '&H90000000';
      } else if (theme === 'outline-thick') {
        borderStyle = 1;
        outline = 5.0 * scaleFactor;
        shadow = 0;
        outlineColor = '&H00000000';
      } else if (theme === 'outline-shadow') {
        borderStyle = 1;
        outline = 2.5 * scaleFactor;
        shadow = 3 * scaleFactor;
        outlineColor = '&H00000000';
        backColor = '&H90000000';
      } else if (theme === 'neon-glow') {
        borderStyle = 1;
        outline = 2.0 * scaleFactor;
        shadow = 0;
        outlineColor = assColor;
        finalAssColor = '&H00FFFFFF';
      } else if (theme === 'three-d') {
        borderStyle = 1;
        outline = 1.0 * scaleFactor;
        shadow = 3.0 * scaleFactor;
        outlineColor = '&H00000000';
        backColor = '&H00000000';
      }

      const assPath = path.join(workDir, `render_subtitles_${timestamp}.ass`);
      try {
        convertSrtToAss(subtitlePath, assPath, {
          videoWidth, videoHeight, fontName, fontSize,
          assColor: finalAssColor, isBold, borderStyle, outline, shadow,
          outlineColor, backColor, alignment, marginV, marginL, marginR, theme, maxLines: subtitleDisplayMaxLines
        });
        renderSubtitlePath = assPath;
      } catch (err) {
        console.error('Lỗi chuyển đổi SRT sang ASS:', err.message);
        renderSubtitlePath = subtitlePath;
      }
    }

    let baseVideoLabel = '0:v';
    let blurFilterString = '';
    const hasReaction = !!reactionVideoPath;
    const hasSubtitles = !!renderSubtitlePath;
    const flipEnabled = anti.bool(body.antidupeFlip);
    if (flipEnabled) {
      baseVideoLabel = 'v_flipped';
    }

    let requestedBlurBoxes = [];
    if (body.blurBoxes) {
      try {
        requestedBlurBoxes = JSON.parse(body.blurBoxes);
      } catch (e) {
        console.error('Lỗi parse blurBoxes JSON:', e.message);
      }
    }
    if (!Array.isArray(requestedBlurBoxes)) requestedBlurBoxes = [];
    const automaticOcrBlurBoxes = [];
    const useAutomaticOcrBlur = false;
    const shouldBlurOriginalSub = body.blurOriginalSub === 'true' || useAutomaticOcrBlur;

    if (shouldBlurOriginalSub) {
      hasVideoFilter = true;
      baseVideoLabel = (hasReaction || hasSubtitles) ? 'v_base' : 'vout';
      const blurBoxes = mergeRenderBlurBoxes(
        requestedBlurBoxes,
        automaticOcrBlurBoxes,
        useAutomaticOcrBlur
      );

      if (!Array.isArray(blurBoxes) || blurBoxes.length === 0) {
        const blurXPercentVal = Math.min(100, Math.max(0, Number(body.blurX !== undefined ? body.blurX : 10))) / 100;
        const blurWidthPercentVal = Math.min(100, Math.max(1, Number(body.blurWidth !== undefined ? body.blurWidth : 80))) / 100;
        const blurYPercentVal = Math.min(100, Math.max(0, Number(body.blurY !== undefined ? body.blurY : 75))) / 100;
        const blurHeightPercentVal = Math.min(100, Math.max(1, Number(body.blurHeight !== undefined ? body.blurHeight : 15))) / 100;
        const blurRadius = Math.min(50, Math.max(1, Number(body.blurRadius || 20)));

        let blurXPercent = blurXPercentVal;
        if (blurXPercent + blurWidthPercentVal > 1) blurXPercent = 1 - blurWidthPercentVal;
        let blurYPercent = blurYPercentVal;
        if (blurYPercent + blurHeightPercentVal > 1) blurYPercent = 1 - blurHeightPercentVal;

        const rawCropW = videoWidth * blurWidthPercentVal;
        const rawCropH = videoHeight * blurHeightPercentVal;
        const rawCropX = videoWidth * blurXPercent;
        const rawCropY = videoHeight * blurYPercent;

        const evenCropW = Math.max(2, Math.floor(rawCropW / 2) * 2);
        const evenCropH = Math.max(2, Math.floor(rawCropH / 2) * 2);
        const evenCropX = Math.max(0, Math.floor(rawCropX / 2) * 2);
        const evenCropY = Math.max(0, Math.floor(rawCropY / 2) * 2);

        const maxLumaR = Math.max(1, Math.floor(Math.min(evenCropW, evenCropH) / 2) - 1);
        const maxChromaR = Math.max(1, Math.floor(Math.min(evenCropW / 2, evenCropH / 2) / 2) - 1);
        const safeLumaRadius = Math.min(blurRadius, maxLumaR);
        const safeChromaRadius = Math.min(blurRadius, maxChromaR);

        blurFilterString = `[0:v]split[orig][copy];[copy]crop=${evenCropW}:${evenCropH}:${evenCropX}:${evenCropY},boxblur=lr=${safeLumaRadius}:cr=${safeChromaRadius},format=yuv420p[blurred];[orig][blurred]overlay=${evenCropX}:${evenCropY}[${baseVideoLabel}]`;
      } else {
        const timedBlur = buildTimedBlurFilterGraph({
          inputLabel: '0:v',
          outputLabel: baseVideoLabel,
          videoWidth,
          videoHeight,
          manualBoxes: requestedBlurBoxes,
          automaticBoxes: useAutomaticOcrBlur ? automaticOcrBlurBoxes : [],
          displayCues: useAutomaticOcrBlur ? readSubtitleTimingCues(sourceSubtitlePath) : [],
          maskStyle: 'blur',
          maskColor: '#000000',
          mirrored: flipEnabled
        });
        blurFilterString = timedBlur.filter;
        console.log('[Studio Mask] OCR timing:', JSON.stringify(timedBlur.stats));
      }
    }

    if (reactionVideoPath) {
      hasVideoFilter = true;
      const rx = body.reactionX !== undefined && body.reactionX !== '' ? Number(body.reactionX) : null;
      const ry = body.reactionY !== undefined && body.reactionY !== '' ? Number(body.reactionY) : null;

      let overlayPos = 'main_w-overlay_w-20:main_h-overlay_h-20';
      if (rx !== null && ry !== null) {
        overlayPos = `${rx}:${ry}`;
      } else {
        const position = body.reactionPosition || 'bottom-right';
        if (position === 'bottom-left') overlayPos = '20:main_h-overlay_h-20';
        if (position === 'top-right') overlayPos = 'main_w-overlay_w-20:20';
        if (position === 'top-left') overlayPos = '20:20';
      }

      const width = Number(body.reactionWidth || 320);
      let filterChain = '';
      if (blurFilterString) {
        filterChain += blurFilterString + ';';
      }
      filterChain += `[${reactionInputIndex}:v]scale=${width}:-1[pip];[${baseVideoLabel}][pip]overlay=${overlayPos}`;

      if (renderSubtitlePath) {
        filterChain += `[v_pip];[v_pip]subtitles='${escapeSubtitleForFilter(renderSubtitlePath)}'[vout]`;
      } else {
        filterChain += `[vout]`;
      }
      videoFilter = filterChain;
    } else if (renderSubtitlePath) {
      hasVideoFilter = true;
      let filterChain = '';
      if (blurFilterString) {
        filterChain += blurFilterString + ';';
      }
      filterChain += `[${baseVideoLabel}]subtitles='${escapeSubtitleForFilter(renderSubtitlePath)}'[vout]`;
      videoFilter = filterChain;
    } else if (shouldBlurOriginalSub) {
      videoFilter = blurFilterString;
    }

    // Flip is applied at source level (before sub/reaction/blur) so it doesn't flip sub/reaction/watermark
    if (flipEnabled && videoFilter) {
      videoFilter = videoFilter.replace(/\[0:v\]/g, '[v_flipped]');
    }

    const filterComplex = [];
    if (flipEnabled) {
      if (videoFilter) {
        filterComplex.push('[0:v]hflip[v_flipped]');
        filterComplex.push(videoFilter);
      } else {
        hasVideoFilter = true;
        filterComplex.push('[0:v]hflip[vout]');
      }
    } else if (videoFilter) {
      filterComplex.push(videoFilter);
    }

    if (logoPath) {
      const logoBaseLabel = hasVideoFilter ? 'v_logo_base' : '0:v';
      if (hasVideoFilter && !renameVideoOutput(filterComplex, logoBaseLabel)) {
        throw new Error('Không thể nối logo vào filter video');
      }
      const logoOverlay = buildStudioLogoOverlay(body, {
        inputIndex: logoInputIndex,
        videoWidth,
        baseLabel: logoBaseLabel
      });
      filterComplex.push(...logoOverlay.segments);
      hasVideoFilter = true;
    }

    let hasAudioFilter = false;
    let originalVolume = Math.max(0, Number(body.originalVolume !== undefined ? body.originalVolume : 1.0));
    if ((body.keepOriginalBgmAI === true || body.keepOriginalBgmAI === 'true') && extractedBgmPath) {
      originalVolume = 0;
    }
    if (audioInputs.length > 0 || audioMastering.enabled) {
      hasAudioFilter = true;
      const audioMix = buildAudioMixGraph({
        inputs: audioInputs,
        originalVolume,
        config: audioMastering
      });
      task.audioMastering = {
        config: audioMastering,
        duckingApplied: audioMix.duckingApplied,
        hasVoice: audioMix.hasVoice
      };
      filterComplex.push(audioMix.filter);
    } else if (body.originalVolume !== undefined && originalVolume !== 1.0) {
      hasAudioFilter = true;
      filterComplex.push(`[0:a]volume=${originalVolume}[aout]`);
    }

    // ---- Anti-dupe filter (single pass) ----
    // Flip is already pre-applied at source level, skip it here
    const antidupeEnabled = body.antidupeEnabled === 'true';
    if (antidupeEnabled) {
      const trimWin = anti.resolveTrimWindow(body.antidupeStart, body.antidupeEnd, totalDuration);
      const hasTrim = trimWin.start > 0 || trimWin.end !== null;
      const hasAdWm = (body.antidupeWatermark || '').toString().trim().length > 0;
      const hasAdVideo = hasTrim || hasAdWm;

      const needsVideoRename = hasAdVideo; // trim or watermark
      const needsAudioRename = hasTrim; // trim only

      if (needsVideoRename || needsAudioRename) {
        console.log('[AntiDupe] Received:', JSON.stringify({ start: body.antidupeStart, end: body.antidupeEnd, totalDuration }));
        console.log('[AntiDupe] TrimWin:', JSON.stringify(trimWin));
        for (let i = 0; i < filterComplex.length; i++) {
          if (hasVideoFilter && needsVideoRename) filterComplex[i] = filterComplex[i].replace(/\[vout\]$/, '[v_ad_in]');
          if (hasAudioFilter && needsAudioRename) filterComplex[i] = filterComplex[i].replace(/\[aout\]$/, '[a_ad_in]');
        }
      }

      const adCfg = {
        flip: false, // already pre-applied at source level
        startSec: trimWin.start,
        endSec: trimWin.end,
        watermarkText: (body.antidupeWatermark || '').toString().trim(),
        watermarkPos: (body.antidupeWmPos || 'br').toString().trim(),
        watermarkSize: anti.num(body.antidupeWmSize, 30),
        watermarkColor: (body.antidupeWmColor || 'white').toString().trim(),
        watermarkAlpha: anti.num(body.antidupeWmAlpha, 0.85),
      };

      const built = anti.buildAntiDupeFilters(adCfg, {
        inputVideoLabel: needsVideoRename ? 'v_ad_in' : '0:v',
        inputAudioLabel: hasAudioFilter && needsAudioRename ? 'a_ad_in' : '0:a',
        outputVideoLabel: 'vout',
        outputAudioLabel: 'aout',
        workDir
      });
      if (built.hasVideo || built.hasAudio) filterComplex.push(...built.segments);
      if (built.hasVideo) hasVideoFilter = true;
      if (built.hasAudio) hasAudioFilter = true;
    }

    if (filterComplex.length > 0) {
      appendFilterComplexArgs(args, filterComplex, workDir);
    }

    if (hasVideoFilter) {
      args.push('-map', '[vout]');
    } else {
      args.push('-map', '0:v');
    }

    if (hasAudioFilter) {
      args.push('-map', '[aout]', '-c:a', 'aac');
    } else {
      args.push('-map', '0:a?', '-c:a', 'aac');
    }

    const encoderArgs = hasCUDA
      ? ['-c:v', 'h264_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '23']
      : ['-c:v', 'libx264', '-preset', 'veryfast'];
    args.push(...encoderArgs, '-movflags', '+faststart', '-shortest', '-y', outPath);
    shared.updateStudioProgress(83, 'Bắt đầu render video thành phẩm (FFmpeg)...');
    console.log('[FFmpeg Command Arguments]:', JSON.stringify(args));
    try {
      await runFFmpegWithProgress(args, totalDuration);
    } catch (ffErr) {
      const stderrMsg = (ffErr.stderr || ffErr.message || '').toLowerCase();
      if (hasCUDA && stderrMsg.includes('nvenc')) {
        console.log('[FFmpeg] NVENC không khả dụng, fallback sang libx264...');
        const fallbackArgs = args.map(a => a);
        // Thay h264_nvenc → libx264
        const nvencIdx = fallbackArgs.indexOf('h264_nvenc');
        if (nvencIdx !== -1) {
          fallbackArgs[nvencIdx] = 'libx264';
          // Xóa các tùy chọn NVENC cụ thể (-rc vbr -cq N) nếu tìm thấy
          const nvencEncoderArgs = ['-rc', 'vbr', '-cq', '23', '-cq', '23']; // mẫu cần xóa
          for (let ii = nvencIdx + 1; ii < fallbackArgs.length - 1; ii++) {
            if (fallbackArgs[ii] === '-rc' && fallbackArgs[ii + 1] === 'vbr') {
              fallbackArgs.splice(ii, 2);
              break;
            }
          }
          for (let ii = nvencIdx + 1; ii < fallbackArgs.length - 1; ii++) {
            if (fallbackArgs[ii] === '-cq') {
              fallbackArgs.splice(ii, 2);
              break;
            }
          }
          // Thay preset p7 → veryfast
          const p7Idx = fallbackArgs.indexOf('p7');
          if (p7Idx !== -1) fallbackArgs[p7Idx] = 'veryfast';
          await runFFmpegWithProgress(fallbackArgs, totalDuration);
        } else {
          throw ffErr;
        }
      } else {
        throw ffErr;
      }
    }

    let audioReport = null;
    const audioTracks = {};
    shared.updateStudioProgress(97, 'Đang kiểm tra chất lượng âm thanh...');
    const qcAudioPath = path.join(workDir, 'output', 'final_mix_qc.wav');
    try {
      fs.mkdirSync(path.dirname(qcAudioPath), { recursive: true });
      await shared.runExecFile(shared.FFMPEG_PATH, [
        '-i', outPath,
        '-vn',
        '-ac', '2',
        '-ar', '48000',
        '-c:a', 'pcm_s16le',
        '-y', qcAudioPath
      ]);
      audioReport = analyzeWavFile(qcAudioPath);
      audioReport.status = 'ready';
    } catch (audioQcError) {
      audioReport = {
        status: 'unavailable',
        warnings: ['audio_qc_unavailable'],
        error: audioQcError.message
      };
      console.warn('[Audio QC] Không thể phân tích bản phối:', audioQcError.message);
    }

    if (audioMastering.exportTracks) {
      const exportTrack = (sourcePath, suffix) => {
        if (!sourcePath || !fs.existsSync(sourcePath)) return null;
        const extension = path.extname(sourcePath) || '.wav';
        const file = `studio_${timestamp}_${suffix}${extension}`;
        fs.copyFileSync(sourcePath, path.join(shared.RENDERS_DIR, file));
        return { file, url: `/renders/${encodeURIComponent(file)}` };
      };
      const voiceTrack = exportTrack(voicePath, 'voice');
      const backgroundTrack = exportTrack(musicPath, 'background');
      if (voiceTrack) audioTracks.voice = voiceTrack;
      if (backgroundTrack) audioTracks.background = backgroundTrack;
    }

    if (subtitlePath && fs.existsSync(subtitlePath)) {
      try {
        shared.updateStudioProgress(98, 'Đang xuất các file phụ đề bổ sung...');
        const outSrtName = `studio_${timestamp}.srt`;
        fs.copyFileSync(subtitlePath, path.join(shared.RENDERS_DIR, outSrtName));
        fs.copyFileSync(subtitlePath, path.join(shared.SUBTITLES_DIR, outSrtName));
        console.log(`[Studio Render] Đã xuất file phụ đề bổ sung: ${outSrtName}`);
      } catch (srtCopyErr) {
        console.error('Lỗi khi sao chép file phụ đề kết quả:', srtCopyErr.message);
      }
    }

    if (shared.state.activeRenderId === renderId) {
      shared.updateStudioProgress(100, 'Hoàn tất render!');
      shared.state.isStudioRendering = false;
      res.json({
        success: true,
        message: 'Đã render video',
        file: outName,
        url: `/renders/${encodeURIComponent(outName)}`,
        translationReport: task.translationReport || null,
        audioMastering: task.audioMastering || { config: audioMastering },
        audioReport,
        audioTracks
      });
    } else {
      console.log(`[Studio Render] Phiên render cũ (${renderId}) đã hoàn thành nhưng đã bị thay thế hoặc hủy trước đó.`);
    }
  } catch (error) {
    console.error('Render studio error:', error.stderr || error.message, error.code ? `(code: ${error.code})` : '');
    const failureKind = applyRenderTaskFailure(task, error);
    if (failureKind === 'cancelled') {
      console.log(`[Queue] Tác vụ ${task.id} đã bị hủy, reset state.`);
    }
    if (!task.discardCheckpoint) renderJobStore.saveTask(task);
  } finally {
    if (task.status === 'success' || task.status === 'failed') {
      cleanupRenderWorkDir(workDir);
    }
    if (task.discardCheckpoint) renderJobStore.removeTask(task.id);
  }
}

let _processingNext = false;
async function processNextRenderTask() {
  if (_processingNext || shared.state.currentActiveTask) {
    console.log('[Queue] Đang chạy một tác vụ kết xuất khác...');
    return;
  }
  _processingNext = true;
  const nextTask = findNextPendingRenderTask(shared.state.renderQueue);
  if (!nextTask) {
    console.log('[Queue] Hàng đợi trống. Không có tác vụ nào chờ xử lý.');
    _processingNext = false;
    return;
  }
  shared.state.currentActiveTask = nextTask;
  console.log(`[Queue] Bắt đầu thực thi tác vụ kết xuất: ${nextTask.id}`);
  try {
    await executeRenderTask(nextTask);
  } catch (err) {
    console.error(`[Queue] Lỗi nghiêm trọng khi thực thi tác vụ ${nextTask.id}:`, err.message);
    nextTask.status = 'error';
    nextTask.error = err.message;
    nextTask.step = 'Lỗi hệ thống';
    nextTask.actionRequired = null;
  } finally {
    shared.state.currentActiveTask = null;
    _processingNext = false;
    setTimeout(() => {
      processNextRenderTask();
    }, 1500);
  }
}

function startQueueProcessing(processNext, logger) {
  try {
    const processing = processNext();
    if (processing && typeof processing.catch === 'function') {
      processing.catch((error) => logger.error('[Queue] Lỗi khởi động tác vụ tiếp theo:', error));
    }
  } catch (error) {
    logger.error('[Queue] Lỗi khởi động tác vụ tiếp theo:', error);
  }
}

function createRenderQueueHandlers(dependencies = {}) {
  const state = dependencies.state || shared.state;
  const existsSync = dependencies.existsSync || fs.existsSync;
  const rmSync = dependencies.rmSync || fs.rmSync;
  const killActiveRenderProcesses = dependencies.killActiveRenderProcesses || shared.killActiveRenderProcesses;
  const processNext = dependencies.processNextRenderTask || processNextRenderTask;
  const schedule = dependencies.schedule || setTimeout;
  const logger = dependencies.logger || console;
  const jobStore = dependencies.jobStore || (dependencies.state ? null : renderJobStore);
  const persistTask = (task) => {
    if (jobStore && !task.discardCheckpoint) jobStore.saveTask(task);
  };
  const removeCheckpoint = (task) => {
    if (jobStore) jobStore.removeTask(task.id);
  };

  return {
    getQueueStatus: async (req, res) => {
      res.json({
        queue: state.renderQueue.map((task) => ({
          id: task.id,
          projectId: task.projectId,
          projectName: task.projectName,
          status: task.status,
          percent: task.percent,
          step: task.step,
          error: task.error,
          actionRequired: task.actionRequired || null,
          createdAt: task.createdAt,
          videoName: task.body.mainVideoFile || (task.files.videoUpload?.[0]
            ? task.files.videoUpload[0].originalname
            : 'Video Tải Lên'),
          result: task.result,
          translationReport: task.translationReport || null,
          voiceExecution: task.voiceExecution || null,
          backgroundSeparation: task.backgroundSeparation || null,
          segmentReview: task.segmentReview || null,
          currentStage: task.currentStage || null,
          completedStages: Object.entries(task.stages || {})
            .filter(([, stage]) => stage.status === 'success')
            .map(([name]) => name),
          uiSnapshot: normalizeUiSnapshot(task.uiSnapshot, task.body),
          canResume: task.status === 'error'
            || task.actionRequired === 'render_resume'
            || task.actionRequired === 'segment_review'
        })),
        currentActiveId: state.currentActiveTask ? state.currentActiveTask.id : null
      });
    },

    useWhisperForRenderTask: async (req, res) => {
      const { taskId, settings = {} } = req.body || {};
      if (!taskId) return res.status(400).json({ error: 'Thiếu mã tác vụ taskId' });

      const task = state.renderQueue.find((candidate) => candidate.id === taskId);
      if (!task) return res.status(404).json({ error: 'Không tìm thấy tác vụ kết xuất' });
      if (task.status !== 'waiting_input' || task.actionRequired !== 'ocr_fallback') {
        return res.status(409).json({ error: 'Tác vụ không chờ chuyển sang Whisper' });
      }

      if (!task.sourceVideoPath || !existsSync(task.sourceVideoPath)) {
        const errorMessage = 'Video nguồn đã lưu không còn tồn tại. Vui lòng tạo lại tác vụ.';
        task.error = errorMessage;
        return res.status(409).json({ error: errorMessage });
      }

      task.forceWhisper = true;
      for (const field of [
        'aiProvider', 'geminiApiKey', 'geminiModel',
        'openRouterApiKey', 'openRouterModel',
        'ninerouterApiKey', 'ninerouterModel', 'ninerouterBaseUrl',
        'whisperModel', 'whisperOnnxVariant'
      ]) {
        if (Object.hasOwn(settings, field)) task.body[field] = settings[field];
      }
      task.status = 'pending';
      task.error = null;
      task.actionRequired = null;
      task.step = 'Đang chuyển sang Whisper...';
      if (task.stages?.subtitle) delete task.stages.subtitle;
      if (task.stages?.translation) delete task.stages.translation;
      persistTask(task);

      const response = res.json({ success: true, taskId });
      startQueueProcessing(processNext, logger);
      return response;
    },

    resumeRenderTask: async (req, res) => {
      const { taskId, settings = {} } = req.body || {};
      if (!taskId) return res.status(400).json({ error: 'Thiếu mã tác vụ taskId' });

      const task = state.renderQueue.find((candidate) => candidate.id === taskId);
      if (!task) return res.status(404).json({ error: 'Không tìm thấy tác vụ kết xuất' });
      const isApprovedSegmentReview = task.status === 'waiting_input'
        && task.actionRequired === 'segment_review'
        && segmentService.load(task.workDir)?.reviewStatus === 'approved';
      const resumable = task.status === 'error'
        || (task.status === 'waiting_input' && task.actionRequired === 'render_resume')
        || isApprovedSegmentReview;
      if (!resumable) return res.status(409).json({ error: 'Tác vụ này không ở trạng thái có thể tiếp tục' });

      if (isApprovedSegmentReview && (!task.sourceVideoPath || !existsSync(task.sourceVideoPath))) {
        return res.status(409).json({
          error: 'Video nguồn không còn tồn tại. Không thể tiếp tục render.'
        });
      }

      const settingFields = [
        'aiProvider',
        'geminiApiKey',
        'geminiModel',
        'openRouterApiKey',
        'openRouterModel',
        'ninerouterApiKey',
        'ninerouterModel',
        'ninerouterBaseUrl',
        'opencodeModel',
        'openaiApiKey',
        'openaiModel',
        'translateTargetLang',
        'translationStyles',
        'whisperModel',
        'whisperOnnxVariant'
      ];
      for (const field of settingFields) {
        if (Object.hasOwn(settings, field)) task.body[field] = settings[field];
      }

      task.status = 'pending';
      task.error = null;
      task.actionRequired = null;
      task.step = 'Đang tiếp tục từ checkpoint...';
      persistTask(task);

      const response = res.json({
        success: true,
        taskId,
        completedStages: Object.entries(task.stages || {})
          .filter(([, stage]) => stage.status === 'success')
          .map(([name]) => name)
      });
      startQueueProcessing(processNext, logger);
      return response;
    },

    cancelQueueTask: async (req, res) => {
      const { taskId } = req.body;
      if (!taskId) {
        return res.status(400).json({ error: 'Thiếu mã tác vụ taskId' });
      }
      const taskIndex = state.renderQueue.findIndex((task) => task.id === taskId);
      if (taskIndex === -1) {
        return res.status(404).json({ error: 'Không tìm thấy tác vụ kết xuất' });
      }
      const task = state.renderQueue[taskIndex];

      if (task.status === 'waiting_input') {
        state.renderQueue.splice(taskIndex, 1);
        try {
          if (task.taskDir && existsSync(task.taskDir)) {
            rmSync(task.taskDir, { recursive: true, force: true });
          }
        } catch (error) {
          logger.error(`[Queue] Không thể dọn thư mục tải lên của tác vụ ${taskId}:`, error);
        }
        removeCheckpoint(task);
        logger.log(`[Queue] Đã gỡ tác vụ đang chờ phản hồi: ${taskId}`);
        return res.json({ success: true, message: 'Đã gỡ tác vụ khỏi hàng đợi thành công.' });
      }

      if (task.status === 'pending') {
        state.renderQueue.splice(taskIndex, 1);
        removeCheckpoint(task);
        logger.log(`[Queue] Đã gỡ tác vụ đang chờ khỏi hàng đợi: ${taskId}`);
        return res.json({ success: true, message: 'Đã gỡ tác vụ khỏi hàng đợi thành công.' });
      }

      if (task.status === 'rendering') {
        logger.log(`[Queue] Nhận yêu cầu hủy và gỡ tác vụ đang chạy trực tiếp: ${taskId}`);
        await cancelTaskVoiceEngine(task);
        killActiveRenderProcesses();
        state.isStudioRendering = false;
        state.activeRenderId = null;
        state.studioProgress = {
          status: 'idle', percent: 0, step: 'Đã hủy kết xuất', error: null
        };
        task.status = 'failed';
        task.step = 'Đã bị người dùng hủy';
        task.actionRequired = null;
        task.discardCheckpoint = true;

        state.renderQueue.splice(taskIndex, 1);
        state.currentActiveTask = null;

        schedule(() => processNext(), 1500);
        return res.json({ success: true, message: 'Đã hủy tiến trình và gỡ tác vụ khỏi hàng đợi thành công.' });
      }

      state.renderQueue.splice(taskIndex, 1);
      removeCheckpoint(task);
      return res.json({ success: true, message: 'Đã gỡ tác vụ khỏi danh sách.' });
    }
  };
}

const renderQueueHandlers = createRenderQueueHandlers();

function restoreRenderQueue() {
  if (shared.state.renderQueue.length > 0) return shared.state.renderQueue;
  const restored = renderJobStore.loadUnfinishedTasks();
  for (const task of restored) {
    shared.state.renderQueue.push(task);
    renderJobStore.saveTask(task);
  }
  if (restored.length > 0) {
    console.log(`[Render Job] Đã khôi phục ${restored.length} tác vụ từ checkpoint.`);
  }
  return restored;
}

module.exports = {
  applyRenderTaskFailure,
  applyRenderTaskSuccess,
  cleanupLegacyCheckpointFiles,
  cleanupRenderWorkDir,
  createAutomaticSubtitleProgressHandler,
  createAutomaticSubtitleResolver,
  createRenderQueueHandlers,
  createRenderQueueTask,
  createRenderSourceResolver,
  appendFilterComplexArgs,
  buildStudioLogoOverlay,
  mergeRenderBlurBoxes,
  readSubtitleTimingCues,
  renameVideoOutput,
  createVoiceChunkCheckpoint,
  findNextPendingRenderTask,
  mapAutomaticSubtitleProgress,
  restoreRenderQueue,
  getProjects: async (req, res) => {
    try {
      if (!fs.existsSync(shared.PROJECTS_DIR)) {
        return res.json({ projects: [] });
      }
      const files = fs.readdirSync(shared.PROJECTS_DIR).filter(f => f.endsWith('.json'));
      const projects = files.map(file => {
        try {
          const content = fs.readFileSync(path.join(shared.PROJECTS_DIR, file), 'utf8');
          const proj = JSON.parse(content);
          return {
            id: proj.id,
            name: proj.name,
            updatedAt: proj.updatedAt || new Date().toISOString(),
            videoTitle: proj.videoTitle || '',
            sourceVideoPath: proj.sourceVideoPath || '',
            thumbnail: proj.thumbnail || ''
          };
        } catch (err) {
          console.error(`Lỗi đọc file dự án ${file}:`, err.message);
          return null;
        }
      }).filter(Boolean);

      projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.json({ projects });
    } catch (error) {
      console.error('Lỗi khi lấy danh sách dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  getProjectById: async (req, res) => {
    try {
      const { id } = req.params;
      const file = path.join(shared.PROJECTS_DIR, `${id}.json`);
      if (!fs.existsSync(file)) {
        return res.status(404).json({ error: 'Không tìm thấy dự án' });
      }
      const content = fs.readFileSync(file, 'utf8');
      const proj = JSON.parse(content);
      res.json(proj);
    } catch (error) {
      console.error('Lỗi khi đọc chi tiết dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  saveProject: async (req, res) => {
    try {
      let { id, name, data } = req.body;
      if (!id) {
        id = `proj_${Date.now()}`;
      }
      if (!name) {
        name = `Dự án_${new Date().toLocaleString('vi-VN')}`;
      }
      const file = path.join(shared.PROJECTS_DIR, `${id}.json`);
      const projectObj = {
        ...data, id, name, updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(file, JSON.stringify(projectObj, null, 2), 'utf8');
      res.json({ success: true, project: projectObj });
    } catch (error) {
      console.error('Lỗi khi lưu dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  deleteProject: async (req, res) => {
    try {
      const { id } = req.params;
      const file = path.join(shared.PROJECTS_DIR, `${id}.json`);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Lỗi khi xóa dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  duplicateProject: async (req, res) => {
    try {
      const { id } = req.params;
      const srcFile = path.join(shared.PROJECTS_DIR, `${id}.json`);
      if (!fs.existsSync(srcFile)) {
        return res.status(404).json({ error: 'Không tìm thấy dự án nguồn' });
      }
      const content = fs.readFileSync(srcFile, 'utf8');
      const proj = JSON.parse(content);

      const newId = `proj_${Date.now()}`;
      const newName = `${proj.name} (Bản sao)`;
      const newProj = {
        ...proj, id: newId, name: newName, updatedAt: new Date().toISOString()
      };
      const destFile = path.join(shared.PROJECTS_DIR, `${newId}.json`);
      fs.writeFileSync(destFile, JSON.stringify(newProj, null, 2), 'utf8');
      res.json({ success: true, project: newProj });
    } catch (error) {
      console.error('Lỗi khi nhân bản dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  renderReaction: async (req, res) => {
    const { mainVideoFile, position } = req.body;
    const reactionFile = req.file;
    if (!mainVideoFile || !reactionFile) {
      return res.status(400).json({ error: 'Thiếu file video' });
    }

    const mainPath = shared.resolveAssetPath('video', mainVideoFile);
    if (!mainPath) return res.status(404).json({ error: 'Video nguồn không còn tồn tại' });
    const outPath = path.join(shared.DOWNLOADS_DIR, `reaction_${Date.now()}.mp4`);
    let overlayPos = 'main_w-overlay_w-20:main_h-overlay_h-20';
    if (position === 'bottom-left') overlayPos = '20:main_h-overlay_h-20';
    if (position === 'top-right') overlayPos = 'main_w-overlay_w-20:20';
    if (position === 'top-left') overlayPos = '20:20';

    const filter = `[1:v]scale=320:-1[pip];[0:v][pip]overlay=${overlayPos}[v]`;
    const args = [
      '-i', mainPath, '-i', reactionFile.path,
      '-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-c:a', 'copy', '-y', outPath
    ];

    console.log('Rendering Reaction with FFmpeg...');
    shared.execFile(shared.FFMPEG_PATH, args, (error, stdout, stderr) => {
      try { fs.unlinkSync(reactionFile.path); } catch (e) { }
      if (error) {
        console.error('FFmpeg error:', stderr);
        return res.status(500).json({ error: 'Lỗi khi render video' });
      }
      res.json({ success: true, message: 'Tạo video thành công!', file: path.basename(outPath) });
    });
  },

  getStudioAssets: async (req, res) => {
    const voiceEngines = await voiceEngineRegistry.describeAll();
    const defaultVoiceEngine = voiceEngines.find((engine) => engine.id === DEFAULT_VOICE_ENGINE_ID);
    res.json({
      videos: shared.listVideoFiles(shared.DOWNLOADS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
      renders: shared.listFiles(shared.RENDERS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
      voices: shared.listFiles(shared.VOICES_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4']),
      music: shared.listFiles(shared.MUSIC_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4']),
      logos: shared.listFiles(shared.LOGOS_DIR, ['.png', '.jpg', '.jpeg', '.webp']),
      subtitles: shared.listFiles(shared.SUBTITLES_DIR, ['.srt', '.vtt', '.ass']),
      omiConfigured: defaultVoiceEngine?.status?.ready === true,
      defaultVoiceEngineId: DEFAULT_VOICE_ENGINE_ID,
      outputLanguages: OUTPUT_LANGUAGES,
      voiceEngines,
      omnivoice: {
        cliExists: fs.existsSync(shared.OMNIVOICE_CLI_PATH),
        modelExists: fs.existsSync(shared.OMNIVOICE_MODEL_PATH),
        cliPath: shared.OMNIVOICE_CLI_PATH,
        modelPath: shared.OMNIVOICE_MODEL_PATH
      }
    });
  },

  getRenderProgress: async (req, res) => {
    res.json(shared.state.studioProgress);
  },

  renderStudio: async (req, res) => {
    const timestamp = Date.now();
    const taskId = `task_${timestamp}`;
    try {
      const body = req.body;
      const files = req.files || {};
      renderJobStore.ensureJob(taskId);
      const taskDir = renderJobStore.getTaskDir(taskId);
      fs.mkdirSync(taskDir, { recursive: true });

      const movedFiles = {};
      for (const [fieldname, fileArr] of Object.entries(files)) {
        if (fileArr && fileArr[0]) {
          const file = fileArr[0];
          const newPath = path.join(taskDir, file.filename + path.extname(file.originalname));
          fs.renameSync(file.path, newPath);
          movedFiles[fieldname] = [{ ...file, path: newPath }];
        }
      }

      const task = createRenderQueueTask({
        taskId,
        body,
        files: movedFiles,
        taskDir
      });

      shared.state.renderQueue.push(task);
      renderJobStore.saveTask(task);
      console.log(`[Queue] Đã xếp hàng tác vụ ${taskId}. Tổng hàng đợi: ${shared.state.renderQueue.length}`);
      processNextRenderTask();

      return res.json({
        success: true,
        message: 'Đã thêm video vào hàng đợi thành công.',
        taskId: taskId
      });
    } catch (error) {
      console.error('[Queue Error] Lỗi xếp hàng tác vụ:', error.message);
      return res.status(500).json({ error: 'Không thể thêm video vào hàng đợi: ' + error.message });
    }
  },

  getQueueStatus: renderQueueHandlers.getQueueStatus,
  useWhisperForRenderTask: renderQueueHandlers.useWhisperForRenderTask,
  resumeRenderTask: renderQueueHandlers.resumeRenderTask,
  cancelQueueTask: renderQueueHandlers.cancelQueueTask,

  clearQueue: async (req, res) => {
    console.log('[Queue] Nhận yêu cầu xóa sạch toàn bộ hàng đợi...');
    if (shared.state.isStudioRendering || (shared.state.studioProgress && shared.state.studioProgress.status === 'rendering')) {
      await cancelTaskVoiceEngine(shared.state.currentActiveTask);
      shared.killActiveRenderProcesses();
    }
    shared.state.isStudioRendering = false;
    shared.state.activeRenderId = null;
    shared.state.studioProgress = {
      status: 'idle', percent: 0, step: 'Hàng đợi trống', error: null
    };
    shared.state.currentActiveTask = null;
    for (const task of shared.state.renderQueue) {
      task.discardCheckpoint = true;
      renderJobStore.removeTask(task.id);
    }
    shared.state.renderQueue.length = 0;
    return res.json({ success: true, message: 'Đã xóa sạch hàng đợi thành công.' });
  },

  cancelRender: async (req, res) => {
    if (shared.state.isStudioRendering || (shared.state.studioProgress && shared.state.studioProgress.status === 'rendering')) {
      const renderId = shared.state.activeRenderId;
      console.log(`[Studio Render] Nhận yêu cầu hủy render ID: ${renderId}...`);
      await cancelTaskVoiceEngine(shared.state.currentActiveTask);
      shared.killActiveRenderProcesses();
      shared.state.isStudioRendering = false;
      if (shared.state.activeRenderId === renderId) {
        shared.state.activeRenderId = null;
      }
      shared.state.studioProgress = {
        status: 'idle', percent: 0, step: 'Đã hủy kết xuất', error: null
      };

      if (shared.state.currentActiveTask) {
        const cancelledTask = shared.state.currentActiveTask;
        cancelledTask.status = 'failed';
        cancelledTask.step = 'Đã bị hủy';
        cancelledTask.discardCheckpoint = true;
        shared.state.currentActiveTask = null;
        setTimeout(() => {
          processNextRenderTask();
        }, 1500);
      }

      if (global.activeRenderRes) {
        try {
          global.activeRenderRes.status(400).json({ error: 'Render đã bị hủy.' });
        } catch (e) { }
        global.activeRenderRes = null;
      }
    }
    res.json({ success: true, message: 'Đã hủy render thành công.' });
  },

  processNextRenderTask // Expose helper if other controllers need it
};
