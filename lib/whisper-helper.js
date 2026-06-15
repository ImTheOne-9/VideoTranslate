const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const WHISPER_PATH = path.join(__dirname, '..', 'tools', 'whisper.exe');
const WHISPER_MODEL_DIR = path.join(__dirname, '..', 'tools', 'whisper_models');
const PYTHON_ENGINE_PATH = path.join(__dirname, '..', 'python_engine', 'python.exe');

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

module.exports = { extractAudioAndTranscribe };
