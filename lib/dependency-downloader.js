const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

const DEPENDENCIES = {
  cuda: {
    name: 'CUDA 12 Libraries',
    url: 'https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/cuda-libraries.zip',
    zipName: 'cuda.zip',
    expectedFiles: ['cublasLt64_12.dll', 'cublas64_12.dll', 'cudart64_12.dll']
  },
  whisper: {
    name: 'Whisper ONNX Executable',
    url: 'https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/whisper-onnx-runtime.zip',
    zipName: 'whisper.zip',
    expectedFiles: ['whisper_onnx.exe']
  }
};

// Hàm kiểm tra xem đã đầy đủ thư viện hay chưa
function checkDependencyStatus(toolsDir) {
  const status = { cuda: true, whisper: true };
  
  for (const [key, dep] of Object.entries(DEPENDENCIES)) {
    for (const file of dep.expectedFiles) {
      if (!fs.existsSync(path.join(toolsDir, file))) {
        status[key] = false;
        break;
      }
    }
  }
  return status;
}

// Giải nén tệp zip trực tiếp vào toolsDir
function downloadAndExtract(depKey, toolsDir, onProgress) {
  return new Promise((resolve, reject) => {
    const dep = DEPENDENCIES[depKey];
    if (!dep) return reject(new Error('Không tìm thấy cấu hình tài nguyên'));

    if (!fs.existsSync(toolsDir)) {
      fs.mkdirSync(toolsDir, { recursive: true });
    }

    const tempZipPath = path.join(toolsDir, dep.zipName);
    const file = fs.createWriteStream(tempZipPath);

    https.get(dep.url, (response) => {
      // Xử lý chuyển hướng HTTP (Hugging Face thường chuyển hướng đến AWS S3/Cloudflare CDN)
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        const redirectUrl = new URL(response.headers.location, dep.url).href;
        file.close();
        try { fs.unlinkSync(tempZipPath); } catch(e) {}
        return downloadFromUrlAndExtract(redirectUrl, depKey, toolsDir, onProgress).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tempZipPath); } catch(e) {}
        return reject(new Error(`Tải thất bại với mã lỗi HTTP: ${response.statusCode}`));
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;

      response.pipe(file);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      file.on('finish', () => {
        file.close(() => {
          try {
            console.log(`Đang giải nén ${dep.zipName} vào thư mục gốc ${toolsDir}...`);
            const zip = new AdmZip(tempZipPath);
            zip.extractAllToAsync(toolsDir, true, false, (err) => {
              if (err) {
                return reject(new Error(`Lỗi giải nén: ${err.message}`));
              }
              try {
                fs.unlinkSync(tempZipPath); // Xóa file zip tạm sau khi giải nén
              } catch (unlinkErr) {
                console.error('Không xóa được file zip tạm:', unlinkErr.message);
              }
              resolve(true);
            });
          } catch (err) {
            reject(new Error(`Lỗi giải nén: ${err.message}`));
          }
        });
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(tempZipPath, () => reject(err));
    });
  });
}

// Hàm hỗ trợ chuyển hướng
function downloadFromUrlAndExtract(url, depKey, toolsDir, onProgress) {
  return new Promise((resolve, reject) => {
    const dep = DEPENDENCIES[depKey];
    const tempZipPath = path.join(toolsDir, dep.zipName);
    const file = fs.createWriteStream(tempZipPath);

    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        const redirectUrl = new URL(response.headers.location, url).href;
        file.close();
        try { fs.unlinkSync(tempZipPath); } catch(e) {}
        return downloadFromUrlAndExtract(redirectUrl, depKey, toolsDir, onProgress).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tempZipPath); } catch(e) {}
        return reject(new Error(`Tải thất bại với mã lỗi HTTP: ${response.statusCode}`));
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;

      response.pipe(file);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      file.on('finish', () => {
        file.close(() => {
          try {
            console.log(`Đang giải nén ${dep.zipName} vào thư mục gốc ${toolsDir}...`);
            const zip = new AdmZip(tempZipPath);
            zip.extractAllToAsync(toolsDir, true, false, (err) => {
              if (err) {
                return reject(new Error(`Lỗi giải nén: ${err.message}`));
              }
              try {
                fs.unlinkSync(tempZipPath);
              } catch (unlinkErr) {
                console.error('Không xóa được file zip tạm:', unlinkErr.message);
              }
              resolve(true);
            });
          } catch (err) {
            reject(new Error(`Lỗi giải nén: ${err.message}`));
          }
        });
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(tempZipPath, () => reject(err));
    });
  });
}

module.exports = { checkDependencyStatus, downloadAndExtract };
