const childProcess = require('child_process');
const path = require('path');
const { getAppDataRoot } = require('./path-helper');
const whisperOnnx = require('./whisper-onnx-helper');

function execFileWithTimeout(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeout || 30 * 60 * 1000;
    const proc = childProcess.execFile(file, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    if (global.registerChildProcess) global.registerChildProcess(proc);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`Timeout sau ${Math.round(timeoutMs / 60000)} phút: ${file}`));
    }, timeoutMs);
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

const appDataRoot = getAppDataRoot(path.join(__dirname, '..'));
const modelsDir = path.join(appDataRoot, 'models');

function normalizeOnnxVariant(variant) {
  return String(variant || 'q8').trim().toLowerCase() === 'fp32' ? 'fp32' : 'q8';
}

function getOnnxModelPath(variant) {
  if (process.env.WHISPER_ONNX_MODEL_PATH) return process.env.WHISPER_ONNX_MODEL_PATH;
  const folder = normalizeOnnxVariant(variant) === 'fp32'
    ? 'onnx-small-timestamped-fp32'
    : 'onnx-small-timestamped';
  return path.join(modelsDir, 'whisper', folder);
}

function throwIfCancelled(stage) {
  if (global.isStudioRendering === false) {
    throw new Error(`Đã hủy kết xuất (${stage})`);
  }
}

async function extractAudioAndTranscribe(videoPath, tempDir, ffmpegPath, model = 'small', videoDurationMs, language, onnxVariant = 'q8') {
  const audioPath = path.join(tempDir, 'audio.wav');
  const srtPath = path.join(tempDir, 'audio.srt');
  const variant = normalizeOnnxVariant(onnxVariant);

  if (global.updateStudioProgress) {
    global.updateStudioProgress(15, 'Trích xuất âm thanh từ video nguồn (FFmpeg)...');
  }
  await execFileWithTimeout(ffmpegPath, [
    '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    '-af', 'highpass=f=150,lowpass=f=8000,anlmdn=s=2',
    '-y', audioPath
  ], { timeout: 5 * 60 * 1000 }).catch((error) => {
    throw new Error('Lỗi tách âm thanh: ' + (error.stderr || error.message));
  });

  throwIfCancelled('sau tách âm thanh');
  if (global.updateStudioProgress) {
    global.updateStudioProgress(20, `Đang nhận diện giọng nói bằng Whisper Small ${variant.toUpperCase()}...`);
  }

  try {
    await whisperOnnx.transcribeToSrt({
      audioPath,
      outputPath: srtPath,
      modelPath: getOnnxModelPath(variant),
      variant,
      language,
      durationSeconds: Number.isFinite(videoDurationMs) ? videoDurationMs / 1000 : undefined,
      device: process.env.WHISPER_ONNX_DEVICE || 'cpu',
      onStage(event) {
        if (event.stage === 'gpu_fallback') {
          console.warn('[Whisper ONNX] DirectML lỗi, chuyển sang CPU:', event.error);
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

module.exports = { extractAudioAndTranscribe, transcribeVoice };
