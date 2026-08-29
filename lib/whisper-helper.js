const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { getAppDataRoot } = require('./path-helper');
const { getWhisperOnnxConfig } = require('./model-downloader');
const whisperOnnx = require('./whisper-onnx-helper');
const fasterWhisper = require('./faster-whisper-helper');
const { resolveWhisperDevice } = require('./whisper-device');
const {
  createCheckpointSignature,
  getFileIdentity,
  isUsableFile,
  readJsonFile,
  writeJsonAtomic
} = require('./checkpoint-utils');

function execFileWithTimeout(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const effectiveTimeoutMs = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 0;
    const proc = childProcess.execFile(file, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    if (global.registerChildProcess) global.registerChildProcess(proc);
    const timeout = effectiveTimeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`Timeout sau ${Math.round(effectiveTimeoutMs / 60000)} phút: ${file}`));
    }, effectiveTimeoutMs) : null;
    proc.on('exit', (code, signal) => {
      if (settled) return;
      if (signal === 'SIGKILL' || signal === 'SIGTERM' || code === null) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Tiến trình bị hủy (signal=${signal})`));
      }
    });
  });
}

const WHISPER_AUDIO_FILTER = 'highpass=f=150,lowpass=f=8000,anlmdn=s=2';
const WHISPER_AUDIO_SAFE_FILTER = 'highpass=f=150,lowpass=f=8000';

function ffmpegErrorText(error) {
  return String(error?.stderr || error?.message || '').trim();
}

function isMissingAudioStreamError(error) {
  return /Output file does not contain any stream|does not contain any stream/i.test(ffmpegErrorText(error));
}

function isInterruptedProcessError(error) {
  return /Timeout sau|Tiến trình bị hủy|signal=SIG(?:KILL|TERM)|cancelled|canceled/i.test(
    `${error?.message || ''}\n${error?.stderr || ''}`
  );
}

async function extractWhisperAudioWithFallback(options = {}) {
  const {
    ffmpegPath,
    videoPath,
    audioPath,
    timeout = 5 * 60 * 1000,
    run = execFileWithTimeout,
    onFallback
  } = options;
  const argsFor = (audioFilter) => [
    '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    '-af', audioFilter, '-y', audioPath
  ];
  try {
    await run(ffmpegPath, argsFor(WHISPER_AUDIO_FILTER), { timeout });
    return { fallbackUsed: false, audioFilter: WHISPER_AUDIO_FILTER };
  } catch (error) {
    try { fs.rmSync(audioPath, { force: true }); } catch {}
    if (isMissingAudioStreamError(error) || isInterruptedProcessError(error)) throw error;
    onFallback?.(error);
    try {
      await run(ffmpegPath, argsFor(WHISPER_AUDIO_SAFE_FILTER), { timeout });
      return { fallbackUsed: true, audioFilter: WHISPER_AUDIO_SAFE_FILTER };
    } catch (fallbackError) {
      try { fs.rmSync(audioPath, { force: true }); } catch {}
      throw fallbackError;
    }
  }
}

const appDataRoot = getAppDataRoot(path.join(__dirname, '..'));
const modelsDir = path.join(appDataRoot, 'models');

function normalizeOnnxVariant(variant) {
  const normalized = String(variant || 'medium-q8').trim().toLowerCase();
  return ['q8', 'fp32', 'medium-q8'].includes(normalized) ? normalized : 'medium-q8';
}

function getOnnxModelPath(variant) {
  if (process.env.WHISPER_ONNX_MODEL_PATH) return process.env.WHISPER_ONNX_MODEL_PATH;
  const config = getWhisperOnnxConfig(normalizeOnnxVariant(variant));
  return path.join(modelsDir, 'whisper', config.folder);
}

function normalizeWhisperBackend(value) {
  return String(value || 'faster-whisper').trim().toLowerCase() === 'whisper-onnx'
    ? 'whisper-onnx'
    : 'faster-whisper';
}

async function detectSpokenLanguage(videoPath, tempDir, ffmpegPath, whisperDevice = 'auto', options = {}) {
  fs.mkdirSync(tempDir, { recursive: true });
  return fasterWhisper.detectSpokenLanguage({
    sourcePath: videoPath,
    audioPath: videoPath,
    ffmpegPath,
    workDir: tempDir,
    resultPath: path.join(tempDir, 'spoken-language.json'),
    modelRoot: path.join(modelsDir, 'whisper', 'faster-whisper-language'),
    model: 'tiny',
    sampleSeconds: 25,
    device: ['cuda', 'cpu'].includes(String(whisperDevice || '').toLowerCase())
      ? String(whisperDevice).toLowerCase()
      : 'auto',
    owner: 'studio-language-detection',
    ...options
  });
}


function throwIfCancelled(stage) {
  if (global.isStudioRenderActive && global.isStudioRendering === false) {
    throw new Error(`Đã hủy kết xuất (${stage})`);
  }
}

async function extractAudioAndTranscribe(
  videoPath,
  tempDir,
  ffmpegPath,
  model = 'medium',
  videoDurationMs,
  language,
  onnxVariant = 'medium-q8',
  whisperLanguage,
  whisperTimestampLevel = 'segment',
  whisperDevice,
  whisperBackend = 'faster-whisper'
) {
  const audioPath = path.join(tempDir, 'audio.wav');
  const srtPath = path.join(tempDir, 'audio.srt');
  const audioMetaPath = path.join(tempDir, 'whisper-audio.json');
  const regionCheckpointPath = path.join(tempDir, 'whisper-regions.json');
  const variant = normalizeOnnxVariant(onnxVariant);
  const backend = normalizeWhisperBackend(whisperBackend);
  const audioFilter = WHISPER_AUDIO_FILTER;
  const audioCheckpointKey = createCheckpointSignature({
    version: 1,
    source: getFileIdentity(videoPath),
    audioFilter
  });
  const checkpointKey = createCheckpointSignature({
    version: 5,
    source: getFileIdentity(videoPath),
    model,
    variant,
    backend,
    language: String(whisperLanguage || language || ''),
    timestampLevel: whisperTimestampLevel === 'word' ? 'word' : 'segment',
    audioFilter
  });
  const audioMeta = readJsonFile(audioMetaPath);
  const canReuseAudio = audioMeta?.checkpointKey === audioCheckpointKey
    && isUsableFile(audioPath, 44);

  if (canReuseAudio) {
    global.updateStudioProgress?.(15, 'Đang dùng lại âm thanh đã trích từ checkpoint...');
  } else {
    for (const stalePath of [audioPath, srtPath, regionCheckpointPath]) {
      try { fs.rmSync(stalePath, { force: true }); } catch {}
    }
  }

  if (!canReuseAudio && global.updateStudioProgress) {
    global.updateStudioProgress(15, 'Trích xuất âm thanh từ video nguồn (FFmpeg)...');
  }
  if (!canReuseAudio) {
    let extractionResult;
    await extractWhisperAudioWithFallback({
      ffmpegPath,
      videoPath,
      audioPath,
      onFallback(error) {
        console.warn('[Whisper] FFmpeg anlmdn bị lỗi, thử lại không dùng khử nhiễu anlmdn:', error?.code || error?.message || 'unknown');
        global.updateStudioProgress?.(15, 'FFmpeg khử nhiễu bị lỗi, đang thử lại bằng bộ lọc âm thanh an toàn...');
      }
    }).then((result) => {
      extractionResult = result;
    }).catch((error) => {
      const errText = error.stderr || error.message || '';
      if (errText.includes('Output file does not contain any stream') || errText.includes('does not contain any stream')) {
        throw new Error('Lỗi tách âm thanh: Video nguồn không chứa luồng âm thanh nào để nhận diện Whisper.');
      }
      throw new Error('Lỗi tách âm thanh: ' + errText);
    });
    writeJsonAtomic(audioMetaPath, {
      version: 1,
      checkpointKey: audioCheckpointKey,
      audioPath,
      audioFilter: extractionResult?.audioFilter || audioFilter,
      denoiseFallbackUsed: Boolean(extractionResult?.fallbackUsed),
      createdAt: new Date().toISOString()
    });
  }

  throwIfCancelled('sau tách âm thanh');
  if (backend === 'faster-whisper') {
    global.updateStudioProgress?.(20, 'Đang nhận diện video gốc bằng Faster Whisper Large V3 Turbo...');
    try {
      await fasterWhisper.transcribeToSrt({
        audioPath,
        sourcePath: videoPath,
        ffmpegPath,
        outputPath: srtPath,
        resultPath: path.join(tempDir, 'faster-whisper-result.json'),
        checkpointPath: path.join(tempDir, 'faster-whisper-checkpoint.json'),
        workDir: tempDir,
        modelRoot: path.join(modelsDir, 'whisper', 'faster-whisper'),
        model: 'large-v3-turbo',
        language: whisperLanguage || language || 'auto',
        timestampLevel: whisperTimestampLevel === 'word' ? 'word' : 'segment',
        durationSeconds: Number.isFinite(videoDurationMs) ? videoDurationMs / 1000 : undefined,
        device: ['cuda', 'cpu'].includes(String(whisperDevice || '').toLowerCase())
          ? String(whisperDevice).toLowerCase()
          : 'auto',
        owner: 'studio-render',
        onStage(event) {
          if (event.event === 'loading_model') {
            global.updateStudioProgress?.(20, 'Đang nạp Faster Whisper Large V3 Turbo lên CUDA...');
          } else if (event.event === 'model_loaded') {
            global.updateStudioProgress?.(22, 'Đã nạp model, đang nhận dạng lời nói...');
          } else if (event.event === 'checkpoint_resumed') {
            global.updateStudioProgress?.(22, `Tiếp tục Faster Whisper từ checkpoint (${event.segmentCount || 0} câu đã giữ)...`);
          } else if (event.event === 'gpu_fallback') {
            global.updateStudioProgress?.(22, `CUDA lỗi sau ${event.partialCount || 0} câu, đang tiếp tục bằng Large V3 Turbo CPU int8...`);
          } else if (event.event === 'vad_retry') {
            global.updateStudioProgress?.(22, 'VAD phủ lời thoại kém, đang nghe lại không VAD...');
          } else if (event.event === 'vad_retry_selected') {
            global.updateStudioProgress?.(22, `Đã chọn bản không VAD phủ tốt hơn (${event.newCount || 0} câu)...`);
          } else if (event.event === 'gpu_temporarily_disabled') {
            global.updateStudioProgress?.(20, 'GPU vừa lỗi nhiều lần, dùng Large V3 Turbo CPU int8 cho lượt này...');
          } else if (event.event === 'watchdog_cpu_resume') {
            global.updateStudioProgress?.(22, 'Watchdog đã dừng tiến trình treo; đang tiếp tục checkpoint bằng Large V3 Turbo CPU int8...');
          } else if (event.event === 'progress') {
            const percent = Math.max(0, Math.min(100, Number(event.percent) || 0));
            global.updateStudioProgress?.(22 + Math.round(percent * 0.08), `Faster Whisper đang nhận dạng... ${percent}%`);
          }
        }
      });
      console.log(`[Faster Whisper] Đã tạo phụ đề Large V3 Turbo: ${srtPath}`);
      return srtPath;
    } catch (error) {
      throwIfCancelled('trong khi Faster Whisper đang chạy');
      console.warn('[Faster Whisper] Cả Large V3 Turbo CUDA/CPU không hoàn tất; chuyển sang ONNX CPU cuối cùng:', error.message);
      global.updateStudioProgress?.(20, 'Faster Whisper CUDA và CPU không hoàn tất, đang dùng Whisper ONNX CPU cuối cùng...');
      for (const stalePath of [srtPath, `${srtPath}.asr.json`, path.join(tempDir, 'faster-whisper-result.json')]) {
        try { fs.rmSync(stalePath, { force: true }); } catch {}
      }
    }
  }
  if (global.updateStudioProgress) {
    const config = getWhisperOnnxConfig(variant);
    global.updateStudioProgress(20, `Đang nhận diện giọng nói bằng Whisper ${config.modelSize.toUpperCase()} ${config.dtype.toUpperCase()}...`);
  }

  try {
    await whisperOnnx.transcribeToSrt({
      audioPath,
      outputPath: srtPath,
      modelPath: getOnnxModelPath(variant),
      variant,
      language: whisperLanguage || language,
      timestampLevel: whisperTimestampLevel === 'word' ? 'word' : 'segment',
      durationSeconds: Number.isFinite(videoDurationMs) ? videoDurationMs / 1000 : undefined,
      device: backend === 'faster-whisper'
        ? 'cpu'
        : resolveWhisperDevice(whisperDevice || process.env.WHISPER_ONNX_DEVICE || 'cpu'),
      checkpointPath: regionCheckpointPath,
      checkpointKey,
      onStage(event) {
        if (event.stage === 'gpu_fallback') {
          console.warn('[Whisper ONNX] DirectML lỗi, chuyển sang CPU:', event.error);
        } else if (event.stage === 'vad_analyzing') {
          global.updateStudioProgress?.(20, 'Đang phát hiện các vùng có giọng nói (Silero VAD)...');
        } else if (event.stage === 'vad_progress') {
          const vadPercent = Math.max(0, Math.min(100, Number(event.percent) || 0));
          global.updateStudioProgress?.(
            20 + Math.round(vadPercent * 0.02),
            `Đang phát hiện các vùng có giọng nói (Silero VAD)... ${vadPercent}%`
          );
        } else if (event.stage === 'vad_complete') {
          const speechSeconds = Math.round(Number(event.speechSeconds) || 0);
          const prefix = event.resumed ? 'Dùng lại VAD:' : 'VAD tìm thấy';
          global.updateStudioProgress?.(22, `${prefix} ${event.regionCount} vùng giọng nói (${speechSeconds} giây)...`);
        } else if (event.stage === 'language_detected') {
          const confidence = Number.isFinite(Number(event.confidence))
            ? ` (${Math.round(Number(event.confidence) * 100)}%)`
            : '';
          global.updateStudioProgress?.(
            22,
            `Whisper đã phát hiện ngôn ngữ ${String(event.value || '').toUpperCase()}${confidence}...`
          );
        } else if (event.stage === 'transcribing_region' && event.total) {
          const percent = 22 + Math.round((event.current / event.total) * 8);
          global.updateStudioProgress?.(
            percent,
            `Whisper đang nhận dạng vùng giọng ${event.current}/${event.total}...`
          );
        }
      }
    });
    console.log(`[Whisper ONNX] Đã tạo phụ đề ${variant.toUpperCase()}: ${srtPath}`);
    return srtPath;
  } catch (error) {
    throwIfCancelled('trong khi Whisper ONNX đang chạy');
    throw new Error(`Whisper ONNX ${variant.toUpperCase()} không thể nhận dạng: ${error.message}`);
  }
}

async function transcribeVoice(audioPath, tempDir, ffmpegPath, model = 'small', language, onnxVariant = 'q8') {
  const convertedPath = path.join(tempDir, 'voice_16k.wav');
  const variant = normalizeOnnxVariant(onnxVariant);
  await execFileWithTimeout(ffmpegPath, [
    '-i', audioPath, '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', convertedPath
  ], { timeout: 5 * 60 * 1000 }).catch((error) => {
    throw new Error('Lỗi chuyển đổi âm thanh mẫu: ' + (error.stderr || error.message));
  });

  throwIfCancelled('trước khi Whisper ONNX nhận diện giọng mẫu');
  try {
    const result = await whisperOnnx.transcribeAudio({
      audioPath: convertedPath,
      modelPath: getOnnxModelPath(variant),
      variant,
      language,
      device: process.env.WHISPER_ONNX_DEVICE || 'cpu'
    });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('không trả về nội dung');
    return text;
  } catch (error) {
    throwIfCancelled('trong khi Whisper ONNX nhận diện giọng mẫu');
    throw new Error(`Whisper ONNX ${variant.toUpperCase()} không thể nhận dạng giọng mẫu: ${error.message}`);
  }
}

module.exports = {
  detectSpokenLanguage,
  extractAudioAndTranscribe,
  transcribeVoice,
  extractWhisperAudioWithFallback,
  WHISPER_AUDIO_FILTER,
  WHISPER_AUDIO_SAFE_FILTER,
  normalizeWhisperBackend
};
