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

module.exports = { ensureModelsExist };
