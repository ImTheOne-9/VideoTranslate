const fs = require('fs');
const path = require('path');
const https = require('https');

// Các đường link tải model (Sẽ thay bằng link thật của khách hàng sau)
// Tạm thời dùng link dummy hoặc link mẫu
const MODELS_CONFIG = [
  {
    name: 'omnivoice-q8_0.gguf',
    url: 'https://huggingface.co/dvh1910/omnivoice/resolve/main/omnivoice-q8_0.gguf',
    size: 1400 * 1024 * 1024 // ~1.4GB
  }
];

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        const redirectUrl = new URL(response.headers.location, url).href;
        return downloadFile(redirectUrl, dest, onProgress).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`Tải thất bại với mã lỗi: ${response.statusCode}`));
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;

      const file = fs.createWriteStream(dest);
      response.pipe(file);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      file.on('finish', () => {
        file.close(resolve);
      });
    });

    request.on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

async function ensureModelsExist(modelsDir, progressCallback) {
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  for (let i = 0; i < MODELS_CONFIG.length; i++) {
    const config = MODELS_CONFIG[i];
    const destPath = path.join(modelsDir, config.name);

    if (fs.existsSync(destPath)) {
      const stats = fs.statSync(destPath);
      // Nếu file lớn hơn 1GB thì coi như đã tải xong (Có thể kiểm tra MD5 để chắc chắn hơn)
      if (stats.size > 1024 * 1024 * 1024) {
        console.log(`[Lazy Loading] File ${config.name} đã tồn tại. Bỏ qua tải xuống.`);
        continue;
      } else {
        console.log(`[Lazy Loading] File ${config.name} chưa hoàn thiện. Tiến hành tải lại.`);
        fs.unlinkSync(destPath);
      }
    }

    console.log(`[Lazy Loading] Đang tải ${config.name}...`);
    let lastPercent = -1;
    await downloadFile(config.url, destPath, (downloaded, total) => {
      const actualTotal = total || config.size;
      const percent = Math.floor((downloaded / actualTotal) * 100);
      if (percent > lastPercent) {
        lastPercent = percent;
        if (progressCallback) {
          progressCallback({
            file: config.name,
            current: i + 1,
            totalFiles: MODELS_CONFIG.length,
            percent: percent,
            downloadedBytes: downloaded,
            totalBytes: actualTotal
          });
        }
      }
    });
  }
}

const WHISPER_ONNX_SHARED_FILES = [
  { name: 'config.json', size: 2227 },
  { name: 'generation_config.json', size: 3893 },
  { name: 'preprocessor_config.json', size: 339 },
  { name: 'tokenizer.json', size: 2480466 },
  { name: 'tokenizer_config.json', size: 282683 }
];

const WHISPER_MEDIUM_ONNX_SHARED_FILES = [
  { name: 'config.json', size: 1417 },
  { name: 'generation_config.json', size: 3779 },
  { name: 'preprocessor_config.json', size: 339 },
  { name: 'tokenizer.json', size: 3930494 },
  { name: 'tokenizer_config.json', size: 282713 }
];

const WHISPER_ONNX_CONFIGS = Object.freeze({
  q8: {
    repo: 'onnx-community/whisper-small_timestamped',
    folder: 'onnx-small-timestamped',
    modelSize: 'small',
    dtype: 'q8',
    files: [
      ...WHISPER_ONNX_SHARED_FILES,
      { name: 'onnx/encoder_model_quantized.onnx', size: 92240498 },
      { name: 'onnx/decoder_model_merged_quantized.onnx', size: 156795750 }
    ]
  },
  fp32: {
    repo: 'onnx-community/whisper-small_timestamped',
    folder: 'onnx-small-timestamped-fp32',
    modelSize: 'small',
    dtype: 'fp32',
    files: [
      ...WHISPER_ONNX_SHARED_FILES,
      { name: 'onnx/encoder_model.onnx', size: 352791798 },
      { name: 'onnx/decoder_model_merged.onnx', size: 615656199 }
    ]
  },
  'medium-q8': {
    repo: 'onnx-community/whisper-medium_timestamped',
    folder: 'onnx-medium-timestamped',
    modelSize: 'medium',
    dtype: 'q8',
    files: [
      ...WHISPER_MEDIUM_ONNX_SHARED_FILES,
      { name: 'onnx/encoder_model_quantized.onnx', size: 313154567 },
      { name: 'onnx/decoder_model_merged_quantized.onnx', size: 672561526 }
    ]
  }
});

function getWhisperOnnxConfig(variant = 'q8') {
  const normalized = String(variant || 'q8').trim().toLowerCase();
  const config = WHISPER_ONNX_CONFIGS[normalized];
  if (!config) throw new Error(`Biến thể Whisper ONNX không hợp lệ: ${variant}`);
  return { variant: normalized, ...config };
}

function validateWhisperOnnxModel(modelDir, variant = 'q8') {
  const config = getWhisperOnnxConfig(variant);
  const missingFiles = [];
  const invalidFiles = [];
  for (const file of config.files) {
    const filePath = path.join(modelDir, ...file.name.split('/'));
    if (!fs.existsSync(filePath)) {
      missingFiles.push(file.name);
      continue;
    }
    const actualSize = fs.statSync(filePath).size;
    if (actualSize !== file.size) {
      invalidFiles.push({ name: file.name, expectedSize: file.size, actualSize });
    }
  }
  const ready = missingFiles.length === 0 && invalidFiles.length === 0;
  return {
    ready,
    exists: ready,
    state: ready ? 'ready' : invalidFiles.length > 0 ? 'corrupt' : 'missing',
    config,
    modelDir,
    missingFiles,
    invalidFiles
  };
}

async function ensureWhisperOnnxModelExist(modelsDir, variant = 'q8', progressCallback) {
  if (typeof variant === 'function') {
    progressCallback = variant;
    variant = 'q8';
  }
  const config = getWhisperOnnxConfig(variant);
  const whisperDir = path.join(modelsDir, 'whisper', config.folder);
  fs.mkdirSync(whisperDir, { recursive: true });
  const totalBytes = config.files.reduce((sum, file) => sum + file.size, 0);
  let overallDownloadedBytes = 0;

  for (const fileInfo of config.files) {
    const destPath = path.join(whisperDir, ...fileInfo.name.split('/'));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath) && fs.statSync(destPath).size === fileInfo.size) {
      overallDownloadedBytes += fileInfo.size;
      continue;
    }
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    let fileDownloadedBytes = 0;
    const encodedName = fileInfo.name.split('/').map(encodeURIComponent).join('/');
    await downloadFile(
      `https://huggingface.co/${config.repo}/resolve/main/${encodedName}`,
      destPath,
      (downloaded) => {
        overallDownloadedBytes += downloaded - fileDownloadedBytes;
        fileDownloadedBytes = downloaded;
        progressCallback?.({
          file: fileInfo.name,
          percent: Math.min(99, Math.floor((overallDownloadedBytes / totalBytes) * 100)),
          downloadedBytes: overallDownloadedBytes,
          totalBytes
        });
      }
    );
  }

  progressCallback?.({
    file: config.folder,
    percent: 100,
    downloadedBytes: totalBytes,
    totalBytes
  });
  return whisperDir;
}

const NLLB_MODEL_CONFIG = {
  repo: 'JustFrederik/nllb-200-distilled-600M-ct2-int8',
  files: [
    { name: 'model.bin', size: 600 * 1024 * 1024 }, // ~600MB
    { name: 'sentencepiece.bpe.model', size: 4.8 * 1024 * 1024 },
    { name: 'shared_vocabulary.txt', size: 4.8 * 1024 * 1024 },
    { name: 'config.json', size: 2.3 * 1024 },
    { name: 'tokenizer.json', size: 16 * 1024 * 1024 },
    { name: 'tokenizer_config.json', size: 560 },
    { name: 'special_tokens_map.json', size: 3.5 * 1024 }
  ]
};

async function ensureNllbModelExist(modelsDir, progressCallback) {
  const nllbDir = path.join(modelsDir, 'nllb');
  if (!fs.existsSync(nllbDir)) {
    fs.mkdirSync(nllbDir, { recursive: true });
  }

  const totalFiles = NLLB_MODEL_CONFIG.files.length;
  const totalBytes = NLLB_MODEL_CONFIG.files.reduce((sum, f) => sum + f.size, 0);
  let overallDownloadedBytes = 0;
  let lastPercent = -1;

  for (let i = 0; i < totalFiles; i++) {
    const fileInfo = NLLB_MODEL_CONFIG.files[i];
    const destPath = path.join(nllbDir, fileInfo.name);
    const fileUrl = `https://huggingface.co/${NLLB_MODEL_CONFIG.repo}/resolve/main/${fileInfo.name}`;

    if (fs.existsSync(destPath)) {
      const stats = fs.statSync(destPath);
      if (stats.size >= fileInfo.size * 0.95) {
        overallDownloadedBytes += stats.size;
        continue;
      }
      fs.unlinkSync(destPath);
    }

    let fileDownloadedBytes = 0;
    await downloadFile(fileUrl, destPath, (downloaded, total) => {
      const delta = downloaded - fileDownloadedBytes;
      fileDownloadedBytes = downloaded;
      overallDownloadedBytes += delta;

      const percent = Math.floor((overallDownloadedBytes / totalBytes) * 100);
      if (percent > lastPercent) {
        lastPercent = percent;
        if (progressCallback) {
          progressCallback({
            file: `nllb/${fileInfo.name}`,
            percent: Math.min(99, percent),
            downloadedBytes: overallDownloadedBytes,
            totalBytes: totalBytes
          });
        }
      }
    });
  }

  if (progressCallback) {
    progressCallback({
      file: 'nllb',
      percent: 100,
      downloadedBytes: totalBytes,
      totalBytes: totalBytes
    });
  }
}

module.exports = {
  ensureModelsExist,
  ensureWhisperOnnxModelExist,
  getWhisperOnnxConfig,
  validateWhisperOnnxModel,
  ensureNllbModelExist,
  WHISPER_ONNX_CONFIG: WHISPER_ONNX_CONFIGS.q8,
  WHISPER_ONNX_CONFIGS
};
