const path = require('path');
const { ensureWhisperModelExist } = require('../lib/model-downloader');

const MODELS_DIR = path.join(__dirname, '..', 'models');

console.log('Starting download of Whisper large-v3 model...');
ensureWhisperModelExist(MODELS_DIR, 'large-v3', (progress) => {
  console.log(`Progress: ${progress.file} - ${progress.percent}% (${progress.downloadedBytes}/${progress.totalBytes} bytes)`);
})
.then(() => {
  console.log('Download completed successfully!');
})
.catch((err) => {
  console.error('Download failed:', err);
});
