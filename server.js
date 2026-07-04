const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const net = require('net');
const axios = require('axios');

const shared = require('./lib/shared-state');
const { verifyLocalLicense } = require('./lib/license-manager');

// --- Rate Limiting (chống flood API local) ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120;
function rateLimiter(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.timestamp > RATE_LIMIT_WINDOW_MS) {
    entry = { timestamp: now, count: 1 };
    rateLimitMap.set(ip, entry);
    return next();
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.timestamp > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// Khởi chạy dọn dẹp các tệp tạm của lần chạy trước (Startup Cleanup Task)
function cleanupTempOnStartup() {
  console.log('[Cleanup] Bắt đầu dọn dẹp tệp tạm thời từ phiên chạy trước...');
  try {
    if (fs.existsSync(shared.TMP_UPLOADS_DIR)) {
      const files = fs.readdirSync(shared.TMP_UPLOADS_DIR);
      for (const file of files) {
        const fullPath = path.join(shared.TMP_UPLOADS_DIR, file);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch (e) {
          console.error(`[Cleanup] Không thể xóa tệp tạm ${file}:`, e.message);
        }
      }
    }
    if (fs.existsSync(shared.UPLOADS_DIR)) {
      const items = fs.readdirSync(shared.UPLOADS_DIR);
      for (const item of items) {
        if (item.startsWith('task_') || item.startsWith('render_')) {
          const fullPath = path.join(shared.UPLOADS_DIR, item);
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } catch (e) {
            console.error(`[Cleanup] Không thể xóa thư mục tạm ${item}:`, e.message);
          }
        }
      }
    }
    console.log('[Cleanup] Hoàn tất dọn dẹp tệp tạm thời khởi động.');
  } catch (err) {
    console.error('[Cleanup] Lỗi trong quá trình dọn dẹp khởi động:', err.message);
  }
}

// Đảm bảo toàn bộ thư mục dữ liệu tồn tại TRƯỚC khi thao tác file (fix ENOENT)
shared.ensureDataDirectories();

// === MIGRATE dữ liệu từ cấu trúc cũ sang cấu trúc mới (chạy 1 lần khi update) ===
// 1. Di chuyển file render từ downloads/renders/ cũ sang renders/ mới (riêng biệt)
// 2. Di chuyển whisper_onnx.exe + CUDA DLLs từ resources/tools/ sang DATA_TOOLS_DIR (data dir)
//    để auto-update không làm mất -> user không phải tải lại
function migrateOldDataLayout() {
  console.log('[Migrate] Kiểm tra cấu trúc dữ liệu cũ...');
  const path = require('path');
  const fs = require('fs');

  // --- 1. Migrate renders: downloads/renders/ -> renders/ ---
  const oldRendersDir = path.join(shared.DOWNLOADS_DIR, 'renders');
  if (fs.existsSync(oldRendersDir)) {
    try {
      const files = fs.readdirSync(oldRendersDir);
      let movedCount = 0;
      for (const file of files) {
        const src = path.join(oldRendersDir, file);
        const dest = path.join(shared.RENDERS_DIR, file);
        if (!fs.existsSync(dest)) {
          try {
            fs.renameSync(src, dest);
            movedCount++;
          } catch (e) {
            // rename fail (khác ổ) -> copy rồi xóa
            try {
              fs.copyFileSync(src, dest);
              fs.unlinkSync(src);
              movedCount++;
            } catch (e2) {
              console.error(`[Migrate] Lỗi di chuyển render ${file}: ${e2.message}`);
            }
          }
        }
      }
      if (movedCount > 0) {
        console.log(`[Migrate] ✅ Đã di chuyển ${movedCount} file render từ downloads/renders/ sang renders/`);
      }
      // Xóa thư mục renders cũ nếu rỗng
      const remaining = fs.readdirSync(oldRendersDir);
      if (remaining.length === 0) {
        try { fs.rmdirSync(oldRendersDir); console.log('[Migrate] Đã xóa thư mục renders cũ rỗng'); } catch (e) {}
      }
    } catch (e) {
      console.error('[Migrate] Lỗi migrate renders:', e.message);
    }
  }

  // --- 2. Migrate whisper_onnx.exe + CUDA DLLs: resources/tools/ -> DATA_TOOLS_DIR ---
  const oldToolsDir = shared.TOOLS_DIR; // resources/tools (app dir)
  const newToolsDir = shared.DATA_TOOLS_DIR; // data dir (VideoStudioData/tools)
  if (fs.existsSync(oldToolsDir) && oldToolsDir !== newToolsDir) {
    const depFiles = ['whisper_onnx.exe', 'cublasLt64_12.dll', 'cublas64_12.dll', 'cudart64_12.dll'];
    let depMoved = 0;
    for (const file of depFiles) {
      const src = path.join(oldToolsDir, file);
      const dest = path.join(newToolsDir, file);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try {
          fs.copyFileSync(src, dest); // copy (không xóa ở resources, vì resources thuộc app)
          depMoved++;
        } catch (e) {
          console.error(`[Migrate] Lỗi di chuyển ${file}: ${e.message}`);
        }
      }
    }
    if (depMoved > 0) {
      console.log(`[Migrate] ✅ Đã copy ${depMoved} file dependency (whisper/CUDA) sang DATA_TOOLS_DIR`);
    }
  }

  console.log('[Migrate] Hoàn tất kiểm tra migrate.');
}
migrateOldDataLayout();

// Chạy dọn dẹp
cleanupTempOnStartup();

// Tự động sao chép các file giọng mẫu mặc định từ bộ cài khi khởi động
const DEFAULT_VOICES_SRC = path.join(__dirname, 'public', 'default_voices');
if (fs.existsSync(DEFAULT_VOICES_SRC)) {
  try {
    const defaultFiles = fs.readdirSync(DEFAULT_VOICES_SRC);
    defaultFiles.forEach(file => {
      const srcPath = path.join(DEFAULT_VOICES_SRC, file);
      const destPath = path.join(shared.VOICES_DIR, file);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`[Init] Đã sao chép giọng mẫu mặc định: ${file}`);
      }
    });
  } catch (err) {
    console.error('Lỗi khởi tạo giọng mẫu mặc định:', err.message);
  }
}

// Cấu hình CUDA DLLs và tools path
if (process.platform === 'win32') {
  const toolsDir = shared.TOOLS_DIR;
  const omnivoiceDir = path.join(shared.TOOLS_DIR, 'omnivoice');
  const pathParts = [];
  if (fs.existsSync(toolsDir)) pathParts.push(toolsDir);
  if (fs.existsSync(omnivoiceDir)) pathParts.push(omnivoiceDir);
  const cudaRoot = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
  if (fs.existsSync(cudaRoot)) {
    try {
      const versions = fs.readdirSync(cudaRoot);
      versions.forEach(ver => {
        const binX64 = path.join(cudaRoot, ver, 'bin', 'x64');
        const binBase = path.join(cudaRoot, ver, 'bin');
        if (fs.existsSync(binX64)) {
          pathParts.push(binX64);
          pathParts.push(binBase);
          console.log(`[CUDA] Đã tự động thêm đường dẫn DLL vào PATH: ${binX64}`);
        }
      });
    } catch (e) {
      console.error('[CUDA] Lỗi quét thư mục CUDA:', e.message);
    }
  }
  if (pathParts.length > 0) {
    process.env.PATH = `${pathParts.join(';')};${process.env.PATH || ''}`;
    console.log(`[PATH] Đã thiết lập PATH cho các tiến trình con: ${process.env.PATH}`);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(shared.RENDERS_DIR));
app.use('/downloads', express.static(shared.DOWNLOADS_DIR));
app.use('/voices', express.static(shared.VOICES_DIR));
app.use('/music', express.static(shared.MUSIC_DIR));

const upload = multer({ dest: shared.UPLOADS_DIR });
const studioUpload = multer({ dest: shared.TMP_UPLOADS_DIR });

// Middleware chặn các yêu cầu API nếu bản quyền không hợp lệ
function licenseMiddleware(req, res, next) {
  if (req.path.startsWith('/api/license/')) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    const check = verifyLocalLicense();
    if (!check.valid) {
      return res.status(403).json({ error: `Bản quyền không hợp lệ: ${check.error}. Vui lòng kích hoạt phần mềm.` });
    }
  }
  next();
}
app.use(rateLimiter);
app.use(licenseMiddleware);

// Controllers
const downloadController = require('./controllers/downloadController');
const studioController = require('./controllers/studioController');
const voiceController = require('./controllers/voiceController');
const systemController = require('./controllers/systemController');

// 1. Download Routes
app.get('/api/download', downloadController.download);
app.get('/api/download-vi', downloadController.downloadVi);
app.post('/api/playlist', downloadController.playlist);
app.post('/api/download-local', downloadController.downloadLocal);
app.get('/api/proxy-image', downloadController.proxyImage);

// 2. Project Routes
app.get('/api/projects', studioController.getProjects);
app.get('/api/projects/:id', studioController.getProjectById);
app.post('/api/projects', studioController.saveProject);
app.delete('/api/projects/:id', studioController.deleteProject);
app.post('/api/projects/:id/duplicate', studioController.duplicateProject);

// 3. Studio routes
app.post('/api/render-reaction', upload.single('reactionVideo'), studioController.renderReaction);
app.get('/api/studio-assets', studioController.getStudioAssets);
app.get('/api/render-progress', studioController.getRenderProgress);
app.get('/api/render-queue-status', studioController.getQueueStatus);
app.post('/api/cancel-queue-task', studioController.cancelQueueTask);
app.post('/api/clear-queue', studioController.clearQueue);
app.post('/api/cancel-render', studioController.cancelRender);
app.post('/api/render-studio', studioUpload.fields([
  { name: 'videoUpload', maxCount: 1 },
  { name: 'subtitleUpload', maxCount: 1 },
  { name: 'voiceUpload', maxCount: 1 },
  { name: 'musicUpload', maxCount: 1 },
  { name: 'reactionUpload', maxCount: 1 }
]), studioController.renderStudio);

// 4. Voice and asset routes
app.post('/api/generate-vbee-voice', voiceController.generateVbeeVoice);
app.post('/api/save-voice', studioUpload.single('voice'), voiceController.saveVoice);
app.post('/api/save-music', studioUpload.single('music'), voiceController.saveMusic);
app.post('/api/save-video', studioUpload.single('video'), voiceController.saveVideo);
app.delete('/api/rendered-videos/:filename', voiceController.deleteVideo);
app.delete('/api/voices/:filename', voiceController.deleteVoice);
app.delete('/api/music/:filename', voiceController.deleteMusic);
app.get('/api/local-videos', voiceController.getLocalVideos);

// 5. System/Helper Routes
app.post('/api/info', systemController.getVideoInfo);
app.post('/api/gemini-models', systemController.getGeminiModels);
app.post('/api/openrouter-models', systemController.getOpenRouterModels);

// API: Get 9Router models
app.post('/api/ninerouter-models', async (req, res) => {
  try {
    const { apiKey, baseUrl } = req.body;
    const resolvedBaseUrl = baseUrl || 'http://localhost:20128/v1';
    const headers = {};
    if (apiKey && apiKey.trim() !== '') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await axios.get(`${resolvedBaseUrl}/models`, { headers });
    const models = response.data.data || [];
    
    const formattedModels = models.map(m => {
      return {
        id: m.id,
        name: m.id,
        displayName: m.id
      };
    });

    res.json({ models: formattedModels });
  } catch (error) {
    console.error('Lỗi khi lấy danh sách model 9Router:', error.message);
    const errorMsg = error.response?.data?.error?.message || error.message;
    res.status(500).json({ error: `Lỗi kết nối tới 9Router: ${errorMsg}` });
  }
});
app.get('/api/cookie/status', systemController.getCookieStatus);
app.post('/api/cookie/save', systemController.saveCookie);
app.post('/api/cookie/clear', systemController.clearCookie);
app.get('/api/open-folder', systemController.openFolder);
// Douyin: extract + download qua BrowserWindow ẩn (không cần yt-dlp/cookies)
app.get('/api/douyin-info', downloadController.getDouyinInfo);
app.post('/api/douyin-download', downloadController.downloadDouyin);

app.get('/api/open-file-folder', systemController.openFileFolder);
app.post('/api/publish-facebook', systemController.publishFacebook);
app.post('/api/verify-facebook-page', systemController.verifyFacebookPage);
app.get('/api/check-dependencies', systemController.checkDependencies);
app.get('/api/check-dependencies-status', systemController.checkDependenciesStatus);
app.post('/api/download-dependency', systemController.downloadDependency);
app.get('/api/download-dependency-progress', systemController.getDependencyDownloadProgress);
app.post('/api/download-model', systemController.downloadModel);
app.get('/api/download-model/status', systemController.getModelStatus);
app.get('/api/whisper-model/status', systemController.getWhisperModelStatus);
app.post('/api/download-whisper-model', systemController.downloadWhisperModel);
app.get('/api/license/hwid', systemController.getLicenseHwid);
app.post('/api/license/activate', systemController.activateLicense);
app.get('/api/update-status', systemController.getUpdateStatus);
app.post('/api/quit-and-install', systemController.quitAndInstallUpdate);

// Find free ports
function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      server.once('close', () => resolve(startPort));
      server.close();
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

function startServer(preferredPort = 3456) {
  return new Promise(async (resolve, reject) => {
    try {
      const port = await findAvailablePort(preferredPort);
      const server = app.listen(port, '127.0.0.1', () => {
        console.log(`\n🚀 YouTube Shorts Downloader đang chạy tại:`);
        console.log(`   http://127.0.0.1:${port}\n`);
        resolve({ server, port });
      });
      
      server.timeout = 0; 
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      server.keepAliveTimeout = 5000;

      server.on('error', (err) => {
        reject(err);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function killAllActiveProcesses() {
  shared.killAllActiveProcesses();
}


// --- Centralized Error Handler Middleware ---
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[Unhandled Error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File quá lớn. Giới hạn upload là 50MB.' });
  }
  if (err.code && err.code.startsWith('LIMIT_')) {
    return res.status(400).json({ error: 'Lỗi upload file: ' + err.message });
  }
  res.status(500).json({ error: 'Lỗi server nội bộ: ' + (err.message || 'Không xác định') });
});
if (require.main === module) {
  startServer(3456).catch(err => {
    console.error('Lỗi khi khởi động server trực tiếp:', err.message);
  });
}

module.exports = { startServer, killAllActiveProcesses };
