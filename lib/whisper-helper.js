const child_process = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDataRoot } = require('./path-helper');

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const cs = Math.round((s - Math.floor(s)) * 1000);
  const ss = Math.floor(s);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(cs).padStart(3, '0')}`;
}

function secondsFromMs(ms) {
  return ms / 1000;
}

// Helper: chạy execFile có timeout + reject khi proc bị kill (tránh Promise treo khi hủy)
function execFileWithTimeout(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeout || (30 * 60 * 1000);
    const proc = child_process.execFile(file, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (settled) return; settled = true; clearTimeout(handle);
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
    if (global.registerChildProcess) global.registerChildProcess(proc);
    const handle = setTimeout(() => {
      if (settled) return; settled = true;
      try { ['stdin','stdout','stderr'].forEach(s => { try { if (proc[s] && !proc[s].destroyed) proc[s].destroy(); } catch(e){} }); proc.kill('SIGKILL'); } catch (e) {}
      reject(new Error(`Timeout sau ${Math.round(timeoutMs/60000)} phút: ${file}`));
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      if (settled) return;
      if (signal === 'SIGKILL' || signal === 'SIGTERM' || code === null) {
        settled = true; clearTimeout(handle);
        reject(new Error(`Tiến trình bị hủy (signal=${signal})`));
      }
    });
  });
}

const isPackaged = __dirname.includes('app.asar');

// Helper phân giải đường dẫn tài nguyên ngoài (extraResources)
function getExtPath(...parts) {
  const base = isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  return path.join(base, ...parts);
}

// Whisper.cpp CLI
const WHISPER_CLI = path.join(__dirname, '..', 'tools', 'whisper.cpp', 'Release', 'whisper-cli.exe');
const appDataRoot = getAppDataRoot(path.join(__dirname, '..'));
const MODELS_DIR = path.join(appDataRoot, 'models');
const VAD_MODEL_PATH = path.join(MODELS_DIR, 'whisper', 'vad', 'ggml-silero-v6.2.0.bin');

function getModelPath(model) {
  const ggmlPath = path.join(MODELS_DIR, 'whisper', `ggml-${model}`, `ggml-${model}.bin`);
  if (fs.existsSync(ggmlPath)) {
    return ggmlPath;
  }
  // Fallback: nếu model yêu cầu chưa có, dùng ggml-small
  const fallbackPath = path.join(MODELS_DIR, 'whisper', 'ggml-small', 'ggml-small.bin');
  if (fs.existsSync(fallbackPath)) {
    console.warn(`[Whisper] Model '${model}' chưa tải, dùng ggml-small thay thế`);
    return fallbackPath;
  }
  return model;
}

async function extractAudioAndTranscribe(videoPath, tempDir, ffmpegPath, model = 'base', videoDurationMs) {
  const audioPath = path.join(tempDir, 'audio.wav');
  const srtPath = path.join(tempDir, 'audio.srt'); // Whisper defaults to outputting <filename>.srt

  console.log('Đang trích xuất âm thanh từ video...');
  if (global.updateStudioProgress) {
    global.updateStudioProgress(15, 'Trích xuất âm thanh từ video nguồn (FFmpeg)...');
  }
  
  // 1. Extract Audio + noise reduction (có timeout 5 phút + reject khi kill)
  await execFileWithTimeout(ffmpegPath, [
    '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    '-af', 'highpass=f=150,lowpass=f=8000,anlmdn=s=2',
    '-y', audioPath
  ], { timeout: 5 * 60 * 1000 }).catch(err => { throw new Error('Lỗi tách âm thanh: ' + (err.stderr || err.message)); });

  if (global.isStudioRendering === false) throw new Error('Đã hủy kết xuất (sau tách âm thanh)');

  console.log(`Đang chạy AI Whisper (model: ${model}) để nhận diện giọng nói...`);
  if (global.updateStudioProgress) {
    global.updateStudioProgress(20, `Đang nhận diện giọng nói AI (Whisper model ${model})...`);
  }

  // 2. Run Whisper.cpp with VAD (có timeout 30 phút + reject khi kill)
  // Output JSON full (-ojf) để lấy token timestamps, rồi tự build SRT
  const jsonPath = path.join(tempDir, 'audio.json');
  const customTempDir = path.join(appDataRoot, 'temp_env');
  if (!fs.existsSync(customTempDir)) { try { fs.mkdirSync(customTempDir, { recursive: true }); } catch (e) {} }
  // Map model name → DTW preset (phải khớp architecture của model)
  // DTW incompatible với flash_attn → dùng -nfa để tắt
  const resolvedModelPath = getModelPath(model);
  const actualModel = resolvedModelPath.match(/ggml-(\w[\w.-]*?)[\\/]ggml-\w[\w.-]*\.bin$/)?.[1] || model;
  const dtwPreset = actualModel.replace(/^large-v(\d+)$/, 'large.v$1');
  const whisperCliArgs = ['-f', audioPath, '-m', resolvedModelPath, '-ojf', '-l', 'auto', '--vad', '-vm', VAD_MODEL_PATH, '-vt', '0.85', '-vp', '5', '-vsd', '500', '-vmsd', '8', '-nth', '0.8', '-sns', '-dtw', dtwPreset, '-nfa', '-of', path.join(tempDir, 'audio')];
  await execFileWithTimeout(WHISPER_CLI, whisperCliArgs, {
    timeout: 30 * 60 * 1000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', TEMP: customTempDir, TMP: customTempDir }
  }).then(stdout => { if (stdout) console.log(stdout.trim()); })
  .catch(err => {
    if (global.isStudioRendering === false) throw new Error('Đã hủy kết xuất (trong khi Whisper đang chạy)');
    throw new Error('Lỗi Whisper: ' + (err.stderr || err.message));
  });

  if (!fs.existsSync(jsonPath)) {
    throw new Error('Whisper không tạo được file JSON.');
  }

  // 3. Đọc JSON whisper text + clip segment ends bằng DTW token timestamps (nếu có)
  const jsonRaw = fs.readFileSync(jsonPath, 'utf8');
  let jsonData;
  try { jsonData = JSON.parse(jsonRaw); } catch (e) { throw new Error('Lỗi parse JSON từ Whisper: ' + e.message); }

  const segments = jsonData.transcription || [];
  if (!segments.length) throw new Error('Whisper không trả về segment nào');

  // Nếu chưa có videoDurationMs, lấy từ ffprobe
  if (!videoDurationMs) {
    try {
      const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      const { execFileSync } = require('child_process');
      const durOut = execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { encoding: 'utf8', timeout: 10000 });
      videoDurationMs = Math.round(parseFloat(durOut.trim()) * 1000);
    } catch (e) {
      console.warn('[Whisper] Không thể lấy video duration từ ffprobe, bỏ qua cap:', e.message);
    }
  }

  // Helper: ước lượng segment end từ token-level DTW timestamps
  // t_dtw là centiseconds (1/100s) → nhân 10 để ra ms
  function computeEndMsFromDtw(tokens, fallbackEndMs) {
    if (!tokens || !tokens.length) return null;
    let maxDtw = -1;
    for (const tok of tokens) {
      if (typeof tok.t_dtw === 'number' && tok.t_dtw >= 0) {
        if (tok.t_dtw > maxDtw) maxDtw = tok.t_dtw;
      }
    }
    if (maxDtw < 0) return null;
    return Math.round(maxDtw * 10);
  }

  const srtLines = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = (seg.text || '').trim();
    if (!text) continue;

    const startMs = (seg.offsets && seg.offsets.from) || 0;
    const originalEndMs = (seg.offsets && seg.offsets.to) || 0;
    const charCount = text.length;
    // Không được vượt quá start của segment kế tiếp (tránh overlap) hoặc duration video
    const nextSeg = segments[i + 1];
    const maxEndMs = nextSeg ? (nextSeg.offsets && nextSeg.offsets.from) || (videoDurationMs || Infinity) : (videoDurationMs || Infinity);

    // DTW token timestamps (absolute centiseconds, hoặc -1 nếu không có)
    const dtwEndMs = computeEndMsFromDtw(seg.tokens, originalEndMs);
    // Floor: text-length heuristic (Chinese ~4 chars/s → ~250ms/char)
    const heuristicEndMs = startMs + Math.max(charCount * 250, 1000);

    let endMs;
    if (dtwEndMs !== null && dtwEndMs > startMs) {
      // DTW có thể clip (original quá dài nhưng không dưới floor heuristic)
      endMs = Math.max(Math.min(originalEndMs, dtwEndMs, maxEndMs), heuristicEndMs);
      if (endMs !== originalEndMs) {
        console.log(`[Whisper] Seg ${i + 1}: start=${startMs} original=${originalEndMs} dtw=${dtwEndMs} heuristic=${heuristicEndMs} maxEnd=${maxEndMs} → ${endMs} (${endMs > originalEndMs ? 'EXTEND' : 'CLIP'})`);
      }
    } else {
      // Fallback: text-length heuristic (giới hạn bởi next start)
      endMs = Math.min(originalEndMs, heuristicEndMs, maxEndMs);
    }

    // Đảm bảo end > start (tối thiểu 500ms)
    endMs = Math.max(endMs, startMs + 500);
    endMs = Math.min(endMs, maxEndMs); // luôn đảm bảo không overlap

    srtLines.push(`${i + 1}\n${formatSrtTime(secondsFromMs(startMs))} --> ${formatSrtTime(secondsFromMs(endMs))}\n${text}\n`);
  }
  const primarySrt = srtLines.join('\n');
  fs.writeFileSync(srtPath, primarySrt, 'utf8');
  console.log(`[Whisper] DTW timestamps: ${segments.length} segs (${srtPath})`);

  // Optional: chạy silencedetect để kiểm tra (chỉ log, không dùng)
  try {
    await execFileWithTimeout(ffmpegPath, [
      '-i', audioPath, '-af', 'silencedetect=noise=-8dB:d=0.2', '-f', 'null', '-'
    ], { timeout: 30 * 1000 });
  } catch (e) {
    // ignore
  }

  return srtPath;
}

async function transcribeVoice(audioPath, tempDir, ffmpegPath, model = 'base') {
  const convertedPath = path.join(tempDir, 'voice_16k.wav');
  const txtPath = path.join(tempDir, 'voice_16k.txt');

  console.log('Đang chuyển đổi giọng mẫu về định dạng chuẩn 16kHz...');
  await execFileWithTimeout(ffmpegPath, [
    '-i', audioPath, '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', convertedPath
  ], { timeout: 5 * 60 * 1000 }).catch(err => { throw new Error('Lỗi chuyển đổi âm thanh mẫu: ' + (err.stderr || err.message)); });

  console.log(`Đang chạy Whisper (model: ${model}) để tự động trích xuất Ref-text...`);
  if (global.isStudioRendering === false) throw new Error('Đã hủy kết xuất (trước khi Whisper nhận diện giọng mẫu)');
  const customTempDir = path.join(appDataRoot, 'temp_env');
  if (!fs.existsSync(customTempDir)) { try { fs.mkdirSync(customTempDir, { recursive: true }); } catch (e) {} }
  const whisperCliArgs = ['-f', convertedPath, '-m', getModelPath(model), '-otxt', '-l', 'auto', '--vad', '-vm', VAD_MODEL_PATH, '-vt', '0.85', '-vp', '10', '-vsd', '300', '-nth', '0.8', '-sns', '-of', path.join(tempDir, 'voice_16k')];
  await execFileWithTimeout(WHISPER_CLI, whisperCliArgs, {
    timeout: 30 * 60 * 1000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', TEMP: customTempDir, TMP: customTempDir }
  }).then(stdout => { if (stdout) console.log(stdout.trim()); })
  .catch(err => {
    if (global.isStudioRendering === false) throw new Error('Đã hủy kết xuất (trong khi Whisper nhận diện giọng mẫu)');
    throw new Error('Lỗi Whisper khi nhận diện giọng mẫu: ' + (err.stderr || err.message));
  });

  if (!fs.existsSync(txtPath)) {
    throw new Error('Whisper không tạo được file văn bản cho giọng mẫu.');
  }

  const transcribedText = fs.readFileSync(txtPath, 'utf8').trim();
  
  // Clean up
  try {
    if (fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
    if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
  } catch (e) {}

  return transcribedText;
}

module.exports = { extractAudioAndTranscribe, transcribeVoice };
