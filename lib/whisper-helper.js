const child_process = require('child_process');
const path = require('path');
const fs = require('fs');

// Wrapper bọc execFile để tự động đăng ký dọn dẹp tiến trình
function execFile(file, args, options, callback) {
  let actualOptions = options;
  let actualCallback = callback;
  if (typeof options === 'function') {
    actualCallback = options;
    actualOptions = {};
  }
  const proc = child_process.execFile(file, args, actualOptions, actualCallback);
  if (global.registerChildProcess) {
    global.registerChildProcess(proc);
  }
  return proc;
}

const isPackaged = __dirname.includes('app.asar');

// Helper phân giải đường dẫn tài nguyên ngoài (extraResources)
function getExtPath(...parts) {
  const base = isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  return path.join(base, ...parts);
}

const WHISPER_PATH = getExtPath('tools', 'whisper.exe');
const WHISPER_MODEL_DIR = getExtPath('tools', 'whisper_models');
const PYTHON_ENGINE_PATH = getExtPath('python_engine', 'python.exe');

async function extractAudioAndTranscribe(videoPath, tempDir, ffmpegPath) {
  const audioPath = path.join(tempDir, 'audio.wav');
  const srtPath = path.join(tempDir, 'audio.srt'); // Whisper defaults to outputting <filename>.srt

  console.log('Đang trích xuất âm thanh từ video...');
  
  // 1. Extract Audio
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y', audioPath
    ], (err, stdout, stderr) => {
      if (err) reject(new Error('Lỗi tách âm thanh: ' + stderr));
      else resolve();
    });
  });

  console.log('Đang chạy AI Whisper để nhận diện giọng nói (có thể mất thời gian)...');

  // 2. Run Whisper
  await new Promise((resolve, reject) => {
    // Use the bundled launcher and local model cache so packaged builds do not depend on PATH.
    const whisperCliArgs = [
      audioPath,
      '--model', 'base',
      '--model_dir', WHISPER_MODEL_DIR,
      '--output_format', 'srt',
      '--output_dir', tempDir
    ];
    if (fs.existsSync(PYTHON_ENGINE_PATH)) {
      whisperCliArgs.push(
        '--word_timestamps', 'True',
        '--max_line_width', '24',
        '--max_line_count', '1',
        '--max_words_per_line', '4'
      );
    }
    const command = fs.existsSync(PYTHON_ENGINE_PATH) ? PYTHON_ENGINE_PATH : WHISPER_PATH;
    const args = fs.existsSync(PYTHON_ENGINE_PATH)
      ? ['-m', 'whisper.transcribe', ...whisperCliArgs]
      : whisperCliArgs;
    
    execFile(command, args, { 
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    }, (err, stdout, stderr) => {
      if (err) reject(new Error('Lỗi Whisper: ' + stderr));
      else resolve();
    });
  });

  if (!fs.existsSync(srtPath)) {
    throw new Error('Whisper không tạo được file phụ đề.');
  }

  return srtPath;
}

async function transcribeVoice(audioPath, tempDir, ffmpegPath) {
  const convertedPath = path.join(tempDir, 'voice_16k.wav');
  const txtPath = path.join(tempDir, 'voice_16k.txt');

  console.log('Đang chuyển đổi giọng mẫu về định dạng chuẩn 16kHz...');
  // Convert audio to 16kHz mono wav for Whisper
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-i', audioPath,
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y', convertedPath
    ], (err, stdout, stderr) => {
      if (err) reject(new Error('Lỗi chuyển đổi âm thanh mẫu: ' + stderr));
      else resolve();
    });
  });

  console.log('Đang chạy Whisper để tự động trích xuất Ref-text...');
  // Run Whisper to get txt output
  await new Promise((resolve, reject) => {
    const whisperCliArgs = [
      convertedPath,
      '--model', 'base',
      '--model_dir', WHISPER_MODEL_DIR,
      '--output_format', 'txt',
      '--output_dir', tempDir
    ];
    const command = fs.existsSync(PYTHON_ENGINE_PATH) ? PYTHON_ENGINE_PATH : WHISPER_PATH;
    const args = fs.existsSync(PYTHON_ENGINE_PATH)
      ? ['-m', 'whisper.transcribe', ...whisperCliArgs]
      : whisperCliArgs;
    
    execFile(command, args, { 
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    }, (err, stdout, stderr) => {
      if (err) reject(new Error('Lỗi Whisper khi nhận diện giọng mẫu: ' + stderr));
      else resolve();
    });
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
