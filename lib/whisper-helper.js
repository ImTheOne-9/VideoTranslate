const child_process = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDataRoot } = require('./path-helper');

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

// Whisper CLI tải về DATA_TOOLS_DIR (data dir, không bị mất khi update)
// Fallback: nếu chưa có ở data dir, thử resources/tools (bản cũ)
const DATA_TOOLS_WHISPER = path.join(getAppDataRoot(path.join(__dirname, '..')), 'tools', 'whisper_onnx.exe');
const RESOURCES_WHISPER = getExtPath('tools', 'whisper_onnx.exe');
const WHISPER_PATH = fs.existsSync(DATA_TOOLS_WHISPER) ? DATA_TOOLS_WHISPER : RESOURCES_WHISPER;
const appDataRoot = getAppDataRoot(path.join(__dirname, '..'));
const MODELS_DIR = path.join(appDataRoot, 'models');

function getModelPath(model) {
  const localModelPath = path.join(MODELS_DIR, 'whisper', model);
  if (fs.existsSync(path.join(localModelPath, 'model.bin'))) {
    return localModelPath;
  }
  return model;
}

async function extractAudioAndTranscribe(videoPath, tempDir, ffmpegPath, model = 'base') {
  const audioPath = path.join(tempDir, 'audio.wav');
  const srtPath = path.join(tempDir, 'audio.srt'); // Whisper defaults to outputting <filename>.srt

  console.log('Đang trích xuất âm thanh từ video...');
  if (global.updateStudioProgress) {
    global.updateStudioProgress(15, 'Trích xuất âm thanh từ video nguồn (FFmpeg)...');
  }
  
  // 1. Extract Audio (có timeout 5 phút + reject khi kill)
  await execFileWithTimeout(ffmpegPath, [
    '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', audioPath
  ], { timeout: 5 * 60 * 1000 }).catch(err => { throw new Error('Lỗi tách âm thanh: ' + (err.stderr || err.message)); });

  if (global.isStudioRendering === false) throw new Error('Đã hủy kết xuất (sau tách âm thanh)');

  console.log(`Đang chạy AI Whisper (model: ${model}) để nhận diện giọng nói...`);
  if (global.updateStudioProgress) {
    global.updateStudioProgress(20, `Đang nhận diện giọng nói AI (Whisper model ${model})...`);
  }

  // 2. Run Whisper (có timeout 30 phút + reject khi kill)
  const customTempDir = path.join(appDataRoot, 'temp_env');
  if (!fs.existsSync(customTempDir)) { try { fs.mkdirSync(customTempDir, { recursive: true }); } catch (e) {} }
  const whisperCliArgs = [audioPath, '--model', getModelPath(model), '--output_format', 'srt', '--output_dir', tempDir];
  await execFileWithTimeout(WHISPER_PATH, whisperCliArgs, {
    timeout: 30 * 60 * 1000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', TEMP: customTempDir, TMP: customTempDir }
  }).then(stdout => { if (stdout) console.log(stdout.trim()); })
  .catch(err => { throw new Error('Lỗi Whisper: ' + (err.stderr || err.message)); });

  if (!fs.existsSync(srtPath)) {
    throw new Error('Whisper không tạo được file phụ đề.');
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
  const customTempDir = path.join(appDataRoot, 'temp_env');
  if (!fs.existsSync(customTempDir)) { try { fs.mkdirSync(customTempDir, { recursive: true }); } catch (e) {} }
  const whisperCliArgs = [convertedPath, '--model', getModelPath(model), '--output_format', 'txt', '--output_dir', tempDir];
  await execFileWithTimeout(WHISPER_PATH, whisperCliArgs, {
    timeout: 30 * 60 * 1000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', TEMP: customTempDir, TMP: customTempDir }
  }).then(stdout => { if (stdout) console.log(stdout.trim()); })
  .catch(err => { throw new Error('Lỗi Whisper khi nhận diện giọng mẫu: ' + (err.stderr || err.message)); });

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
