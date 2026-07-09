const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const { exec } = require('child_process');

// Hàm giải nén file ZIP hỗ trợ đa nền tảng và không gây nghẽn luồng chính Electron
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // 1. Thử dùng lệnh native tar của Windows để chạy luồng riêng, tối ưu hóa tốc độ và tránh đơ UI
    console.log(`[Dependency Downloader] Đang giải nén bằng công cụ native tar: ${zipPath}`);
    exec(`tar -xf "${zipPath}" -C "${destDir}"`, (err) => {
      if (!err) {
        console.log(`[Dependency Downloader] Giải nén thành công bằng native tar.`);
        return resolve(true);
      }

      // 2. Fallback sang adm-zip nếu Windows cũ hoặc lệnh tar bị lỗi
      console.warn(`[Dependency Downloader] Giải nén native tar gặp lỗi hoặc không khả dụng. Chuyển sang dùng adm-zip làm dự phòng... Chi tiết: ${err.message}`);
      try {
        const zip = new AdmZip(zipPath);
        zip.extractAllToAsync(destDir, true, false, (zipErr) => {
          if (zipErr) {
            return reject(new Error(`Giải nén fallback thất bại: ${zipErr.message}`));
          }
          console.log(`[Dependency Downloader] Giải nén dự phòng bằng adm-zip thành công.`);
          resolve(true);
        });
      } catch (zipCatchErr) {
        reject(new Error(`Lỗi khởi tạo adm-zip fallback: ${zipCatchErr.message}`));
      }
    });
  });
}

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
  },
  separator: {
    name: 'Audio Separator',
    url: 'https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/audio-separator.zip',
    zipName: 'audio-separator.zip',
    expectedFiles: ['audio-separator.exe']
  }
};

// Hàm kiểm tra xem đã đầy đủ thư viện hay chưa
function checkDependencyStatus(toolsDir) {
  const status = { cuda: true, whisper: true, separator: true };
  
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
          extractZip(tempZipPath, toolsDir)
            .then(() => {
              try {
                fs.unlinkSync(tempZipPath); // Xóa file zip tạm sau khi giải nén
              } catch (unlinkErr) {
                console.error('Không xóa được file zip tạm:', unlinkErr.message);
              }
              resolve(true);
            })
            .catch((err) => {
              reject(err);
            });
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
          extractZip(tempZipPath, toolsDir)
            .then(() => {
              try {
                fs.unlinkSync(tempZipPath); // Xóa file zip tạm sau khi giải nén
              } catch (unlinkErr) {
                console.error('Không xóa được file zip tạm:', unlinkErr.message);
              }
              resolve(true);
            })
            .catch((err) => {
              reject(err);
            });
        });
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(tempZipPath, () => reject(err));
    });
  });
}

module.exports = { checkDependencyStatus, downloadAndExtract };
