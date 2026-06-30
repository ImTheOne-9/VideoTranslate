const child_process = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getAppDataRoot } = require('./path-helper');

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

const WHISPER_PATH = getExtPath('tools', 'whisper_onnx.exe');
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

  console.log(`Đang chạy AI Whisper (model: ${model}) để nhận diện giọng nói...`);
  if (global.updateStudioProgress) {
    global.updateStudioProgress(20, `Đang nhận diện giọng nói AI (Whisper model ${model})...`);
  }

  // 2. Run Whisper
  await new Promise((resolve, reject) => {
    const whisperCliArgs = [
      audioPath,
      '--model', getModelPath(model),
      '--output_format', 'srt',
      '--output_dir', tempDir
    ];
    
    const customTempDir = path.join(appDataRoot, 'temp_env');
    if (!fs.existsSync(customTempDir)) {
      try {
        fs.mkdirSync(customTempDir, { recursive: true });
      } catch (e) {
        console.error('Failed to create customTempDir:', e);
      }
    }
    
    execFile(WHISPER_PATH, whisperCliArgs, { 
      maxBuffer: 10 * 1024 * 1024,
      env: { 
        ...process.env, 
        PYTHONIOENCODING: 'utf-8',
        TEMP: customTempDir,
        TMP: customTempDir
      }
    }, (err, stdout, stderr) => {
      if (stdout) console.log(stdout.trim());
      if (err) reject(new Error('Lỗi Whisper: ' + (stderr || err.message)));
      else resolve();
    });
  });

  if (!fs.existsSync(srtPath)) {
    throw new Error('Whisper không tạo được file phụ đề.');
  }

  return srtPath;
}

async function transcribeVoice(audioPath, tempDir, ffmpegPath, model = 'base') {
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

  console.log(`Đang chạy Whisper (model: ${model}) để tự động trích xuất Ref-text...`);
  // Run Whisper to get txt output
  await new Promise((resolve, reject) => {
    const whisperCliArgs = [
      convertedPath,
      '--model', getModelPath(model),
      '--output_format', 'txt',
      '--output_dir', tempDir
    ];
    
    const customTempDir = path.join(appDataRoot, 'temp_env');
    if (!fs.existsSync(customTempDir)) {
      try {
        fs.mkdirSync(customTempDir, { recursive: true });
      } catch (e) {
        console.error('Failed to create customTempDir:', e);
      }
    }
    
    execFile(WHISPER_PATH, whisperCliArgs, { 
      maxBuffer: 10 * 1024 * 1024,
      env: { 
        ...process.env, 
        PYTHONIOENCODING: 'utf-8',
        TEMP: customTempDir,
        TMP: customTempDir
      }
    }, (err, stdout, stderr) => {
      if (stdout) console.log(stdout.trim());
      if (err) reject(new Error('Lỗi Whisper khi nhận diện giọng mẫu: ' + (stderr || err.message)));
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
