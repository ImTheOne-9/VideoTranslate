const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const net = require('net');
const axios = require('axios');

const shared = require('./lib/shared-state');
const { DownloadCrawlManager } = require('./lib/download-crawl-manager');
const douyinExtractor = require('./lib/douyin-extractor');
const platformBrowserExtractor = require('./lib/platform-browser-extractor');
const { MediaCrawlerAdapter } = require('./lib/mediacrawler-adapter');
const { ProjectYtDlpAdapter } = require('./lib/project-ytdlp-adapter');
const { CrawlerRuntimeManager } = require('./lib/crawler-runtime-manager');
const { readCrawlerHistory } = require('./lib/crawler-history-reader');
const { verifyLocalLicense, getLicenseFilePath, LICENSE_SERVER_URL } = require('./lib/license-manager');

function createBrowserPreviewResolver(platform) {
  return async ({ input, count, mode, onLog }) => {
    const values = String(input || '').split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    const items = new Map();
    for (const value of values) {
      const found = await platformBrowserExtractor.collect(platform, mode, value, count, onLog || (() => {}));
      for (const item of found) items.set(item.sourceUrl || item.url, item);
      if (items.size >= count) break;
    }
    return [...items.values()].slice(0, count);
  };
}

function createCookieSyncResolver(platform) {
  return async (task) => {
    await platformBrowserExtractor.syncCookies(platform, path.join(shared.COOKIES_DIR, `${platform}.txt`));
    return { url: task.sourceUrl || task.url };
  };
}

const mediaCrawler = new MediaCrawlerAdapter({ dataDir: shared.DOWNLOADS_DIR });
const projectYtDlp = new ProjectYtDlpAdapter({ dataDir: shared.DOWNLOADS_DIR });
const crawlerRuntimeManager = new CrawlerRuntimeManager();

function createMediaCrawlerPreviewResolver(platform) {
  return async ({ input, count, mode, onLog, onItem }) => {
    if (!mediaCrawler.status().available) return createBrowserPreviewResolver(platform)({ input, count, mode, onLog });
    return mediaCrawler.preview({ platform, input, count, mode, onLog, onItem });
  };
}

function createProjectYtDlpPreviewResolver(platform) {
  return ({ input, count, mode, sort, timeDays, onLog }) => projectYtDlp.preview({
    platform, input, count, mode, sort, timeDays, onLog
  });
}

const downloadCrawlManager = new DownloadCrawlManager({
  shared,
  previewResolvers: {
    'youtube:search': createProjectYtDlpPreviewResolver('youtube'),
    'youtube:creator': createProjectYtDlpPreviewResolver('youtube'),
    'tiktok:search': createProjectYtDlpPreviewResolver('tiktok'),
    'tiktok:creator': createProjectYtDlpPreviewResolver('tiktok'),
    'tiktok:detail': createProjectYtDlpPreviewResolver('tiktok'),
    'facebook:creator': createProjectYtDlpPreviewResolver('facebook'),
    'instagram:creator': createProjectYtDlpPreviewResolver('instagram'),
    'instagram:detail': createProjectYtDlpPreviewResolver('instagram'),
    'douyin:search': createMediaCrawlerPreviewResolver('douyin'),
    'douyin:creator': createMediaCrawlerPreviewResolver('douyin'),
    'douyin:detail': createMediaCrawlerPreviewResolver('douyin'),
    'bilibili:search': createMediaCrawlerPreviewResolver('bilibili'),
    'bilibili:creator': createMediaCrawlerPreviewResolver('bilibili'),
    'bilibili:detail': createMediaCrawlerPreviewResolver('bilibili'),
    'xiaohongshu:search': createMediaCrawlerPreviewResolver('xiaohongshu'),
    'xiaohongshu:creator': createMediaCrawlerPreviewResolver('xiaohongshu'),
    'rednote:search': createMediaCrawlerPreviewResolver('rednote'),
    'rednote:creator': createMediaCrawlerPreviewResolver('rednote'),
    'weibo:search': createMediaCrawlerPreviewResolver('weibo'),
    'weibo:creator': createMediaCrawlerPreviewResolver('weibo'),
    'weibo:detail': createMediaCrawlerPreviewResolver('weibo')
  },
  downloadResolvers: {
    douyin: async (task) => {
      const info = await douyinExtractor.getDouyinVideoInfo(task.sourceUrl || task.url, () => {});
      const best = (info.formats || []).filter((format) => format.format === 'mp4' && format.src)
        .sort((a, b) => Number(b.height || 0) - Number(a.height || 0))[0];
      if (!best) throw new Error('Không tìm thấy luồng MP4 Douyin.');
      return { url: best.src };
    },
    bilibili: createCookieSyncResolver('bilibili'),
    xiaohongshu: createCookieSyncResolver('xiaohongshu'),
    rednote: createCookieSyncResolver('rednote'),
    weibo: createCookieSyncResolver('weibo')
  },
  crawlResolvers: {
    ...(mediaCrawler.status().available
      ? Object.fromEntries(['douyin', 'bilibili', 'xiaohongshu', 'rednote', 'weibo']
        .map((platform) => [platform, (config, hooks) => mediaCrawler.crawl(config, hooks)]))
      : {}),
    ...(projectYtDlp.status().available
      ? Object.fromEntries(['youtube', 'tiktok', 'facebook', 'instagram', 'twitter', 'reddit']
        .map((platform) => [platform, (config, hooks) => projectYtDlp.crawl(config, hooks)]))
      : {})
  },
  loginChecker: async (platform, mode) => {
    if (mediaCrawler.supports(platform) && mediaCrawler.status().available) return mediaCrawler.checkLogin(platform);
    if (projectYtDlp.status().available) {
      if (platform === 'tiktok' && mode === 'search') return projectYtDlp.checkLogin(platform);
      if (['instagram', 'twitter'].includes(platform)) return projectYtDlp.checkLogin(platform);
      if (projectYtDlp.supports(platform)) return 'in';
    }
    const cookies = shared.getCookieStatus();
    if (cookies[platform]) return 'in';
    return platformBrowserExtractor.loginStatus(platform);
  }
});

// --- Rate Limiting (chống flood API local) ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_EXEMPT_PATHS = new Set([
  '/api/ocr-component/download-status',
  '/api/mdx-cuda-component/download-status',
  '/api/download-crawl/status',
  '/api/proxy-image',
  '/api/update-status'
]);
function rateLimiter(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  // Polling and image requests are read-only and can legitimately happen in bursts.
  // Do not let them consume the mutation/API flood budget.
  if (req.method === 'GET' && RATE_LIMIT_EXEMPT_PATHS.has(req.path)) return next();
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
        try { fs.rmdirSync(oldRendersDir); console.log('[Migrate] Đã xóa thư mục renders cũ rỗng'); } catch (e) { }
      }
    } catch (e) {
      console.error('[Migrate] Lỗi migrate renders:', e.message);
    }
  }

  // --- 2. Migrate CUDA DLLs: resources/tools/ -> DATA_TOOLS_DIR ---
  const oldToolsDir = shared.TOOLS_DIR; // resources/tools (app dir)
  const newToolsDir = shared.DATA_TOOLS_DIR; // data dir (VideoStudioData/tools)
  if (fs.existsSync(oldToolsDir) && oldToolsDir !== newToolsDir) {
    const depFiles = ['cublasLt64_12.dll', 'cublas64_12.dll', 'cudart64_12.dll'];
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
      console.log(`[Migrate] ✅ Đã copy ${depMoved} file CUDA sang DATA_TOOLS_DIR`);
    }
  }

  // --- 3. Dọn runtime và model Whisper cũ ---
  const onnxExe = path.join(shared.DATA_TOOLS_DIR, 'whisper_onnx.exe');
  if (fs.existsSync(onnxExe)) {
    try { fs.unlinkSync(onnxExe); console.log('[Migrate] ✅ Đã xoá whisper_onnx.exe cũ'); } catch (e) {}
  }
  const wDir = path.join(shared.MODELS_DIR, 'whisper');
  const legacyFolders = fs.existsSync(wDir)
    ? fs.readdirSync(wDir).filter((name) => name.startsWith('ggml-') || name === 'vad' || name === 'dtw')
    : [];
  for (const f of legacyFolders) {
    const dir = path.join(wDir, f);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('[Migrate] ✅ Đã xoá model Whisper cũ: whisper/' + f);
    } catch (e) {
      console.error('[Migrate] Lỗi xoá whisper/' + f + ': ' + e.message);
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
  const dataToolsDir = shared.DATA_TOOLS_DIR;
  const omnivoiceDir = path.join(shared.TOOLS_DIR, 'omnivoice');
  const omnivoiceDataDir = path.join(shared.DATA_TOOLS_DIR, 'omnivoice');
  const pathParts = [];
  if (fs.existsSync(toolsDir)) pathParts.push(toolsDir);
  if (fs.existsSync(dataToolsDir) && dataToolsDir !== toolsDir) pathParts.push(dataToolsDir);
  if (fs.existsSync(omnivoiceDir)) pathParts.push(omnivoiceDir);
  if (fs.existsSync(omnivoiceDataDir) && omnivoiceDataDir !== omnivoiceDir) pathParts.push(omnivoiceDataDir);
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
const segmentController = require('./controllers/segmentController');
const voiceController = require('./controllers/voiceController');
const systemController = require('./controllers/systemController');
const antiDupeController = require('./controllers/antiDupeController');

// 1. Download Routes
app.get('/api/download', downloadController.download);
app.post('/api/playlist', downloadController.playlist);
app.post('/api/download-local', downloadController.downloadLocal);
app.get('/api/proxy-image', downloadController.proxyImage);
app.get('/api/download-crawl/capabilities', (req, res) => {
  res.json({ platforms: downloadCrawlManager.capabilities(), engine: mediaCrawler.status(), engines: [mediaCrawler.status(), projectYtDlp.status()] });
});
app.get('/api/download-crawl/engine-status', (req, res) => res.json({ mediaCrawler: mediaCrawler.status(), projectYtDlp: projectYtDlp.status() }));
app.get('/api/download-crawl/runtime-status', (req, res) => res.json(crawlerRuntimeManager.status()));
app.post('/api/download-crawl/runtime-install', (req, res) => {
  try {
    const result = crawlerRuntimeManager.install((message, level) => {
      downloadCrawlManager._log(`[Runtime] ${message}`, level);
    });
    res.status(result.started || result.alreadyReady || result.alreadyRunning ? 202 : 200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Không thể cài runtime crawler.' });
  }
});
app.post('/api/download-crawl/preview', async (req, res) => {
  try {
    res.json(await downloadCrawlManager.preview(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message || 'Không lấy được danh sách video.' });
  }
});
app.post('/api/download-crawl/preview-stream', async (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const write = (payload) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(payload)}\n`);
  };
  try {
    const result = await downloadCrawlManager.preview(req.body || {}, {
      onItem: (item) => write({ type: 'item', item })
    });
    write({ type: 'result', data: result });
  } catch (error) {
    write({ type: 'error', error: error.message || 'Không lấy được danh sách video.' });
  } finally {
    if (!res.writableEnded) res.end();
  }
});
app.post('/api/download-crawl/enqueue', (req, res) => {
  try {
    res.json({ success: true, ...downloadCrawlManager.enqueue(req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Không thêm được video vào hàng đợi.' });
  }
});
app.post('/api/download-crawl/enqueue-job', (req, res) => {
  try {
    res.json({ success: true, ...downloadCrawlManager.enqueueJob(req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Không thêm được job cào.' });
  }
});
app.get('/api/download-crawl/status', (req, res) => {
  res.json(downloadCrawlManager.snapshot());
});
app.get('/api/download-crawl/stats', (req, res) => {
  res.json(downloadCrawlManager.stats(req.query?.date || ''));
});
app.get('/api/download-crawl/history', (req, res) => {
  const items = readCrawlerHistory(shared.DOWNLOADS_DIR, {
    platform: req.query?.platform,
    query: req.query?.q,
    onlyUndownloaded: String(req.query?.onlyUndownloaded || '') === '1',
    days: req.query?.days,
    limit: req.query?.limit
  });
  res.json({ items, count: items.length });
});
app.get('/api/download-crawl/login-status', async (req, res) => {
  const cookies = shared.getCookieStatus();
  const browserPlatforms = ['douyin', 'bilibili', 'xiaohongshu', 'rednote', 'weibo'];
  const browserStates = mediaCrawler.status().available
    ? await mediaCrawler.checkLogins(browserPlatforms)
    : Object.fromEntries(await Promise.all(browserPlatforms.map(async (platform) => [platform, await platformBrowserExtractor.loginStatus(platform)])));
  const projectStates = projectYtDlp.status().available
    ? await projectYtDlp.checkLogins(['tiktok', 'facebook', 'instagram', 'twitter'])
    : {};
  const loginState = (platform, hasCookie = false) => browserStates[platform] === 'in'
    ? 'in'
    : (browserStates[platform] === 'unknown' && hasCookie ? 'in' : 'out');
  res.json({
    platforms: {
      douyin: loginState('douyin', cookies.douyin),
      bilibili: loginState('bilibili', cookies.bilibili),
      xiaohongshu: loginState('xiaohongshu', cookies.xiaohongshu),
      rednote: loginState('rednote', cookies.rednote),
      weibo: loginState('weibo', cookies.weibo),
      youtube: 'na',
      tiktok: projectStates.tiktok || 'out',
      facebook: projectStates.facebook === 'in' ? 'in' : 'na',
      instagram: projectStates.instagram === 'in' ? 'in' : 'out',
      twitter: projectStates.twitter === 'in' ? 'in' : 'out',
      reddit: 'na'
    }
  });
});
app.post('/api/download-crawl/login', async (req, res) => {
  try {
    const platform = String(req.body?.platform || '');
    const result = mediaCrawler.supports(platform) && mediaCrawler.status().available
      ? mediaCrawler.openLogin(platform)
      : projectYtDlp.needsLogin(platform) && projectYtDlp.status().available
        ? projectYtDlp.openLogin(platform)
      : await platformBrowserExtractor.openLogin(platform);
    res.json({ success: true, engine: result?.engine || 'browser', message: `Đã mở cửa sổ đăng nhập ${platform}. Đăng nhập xong có thể đóng cửa sổ.` });
  } catch (error) {
    res.status(503).json({ error: error.message || 'Không mở được cửa sổ đăng nhập.' });
  }
});
app.post('/api/download-crawl/translate-keywords', async (req, res) => {
  try {
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : [];
    const target = req.body?.target === 'zh-TW' ? 'zh-TW' : 'zh-CN';
    const translated = [];
    for (const keyword of keywords.slice(0, 30)) {
      const text = String(keyword || '').trim();
      if (!text || /[\u3400-\u9fff]/.test(text)) { translated.push(text); continue; }
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Dịch từ khóa thất bại (${response.status})`);
      const data = await response.json();
      translated.push(Array.isArray(data?.[0]) ? data[0].map((part) => part?.[0] || '').join('') : text);
    }
    res.json({ translated });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Không dịch được từ khóa.' });
  }
});
app.post('/api/download-crawl/cancel', (req, res) => {
  const taskId = String(req.body?.taskId || '');
  res.json({ success: downloadCrawlManager.cancel(taskId) });
});
app.post('/api/download-crawl/stop', (req, res) => {
  downloadCrawlManager.stopAll();
  res.json({ success: true });
});
app.post('/api/download-crawl/clear', (req, res) => {
  res.json({ success: true, ...downloadCrawlManager.clearFinished() });
});
app.post('/api/download-crawl/remove', (req, res) => {
  res.json({ success: downloadCrawlManager.remove(String(req.body?.taskId || '')) });
});
app.post('/api/download-crawl/pause', (req, res) => {
  res.json({ success: true, ...downloadCrawlManager.setPaused(req.body?.paused) });
});
app.post('/api/download-crawl/retry', (req, res) => {
  res.json({ success: downloadCrawlManager.retry(String(req.body?.taskId || '')) });
});
app.post('/api/download-crawl/retry-all', (req, res) => {
  res.json({ success: true, count: downloadCrawlManager.retryAll(String(req.body?.platform || '')) });
});
app.post('/api/download-crawl/clear-logs', (req, res) => {
  downloadCrawlManager.clearLogs();
  res.json({ success: true });
});

// Cookie management routes
app.post('/api/upload-cookie', upload.single('cookieFile'), (req, res) => {
  try {
    const platform = req.body.platform;
    if (!platform || !req.file) {
      return res.status(400).json({ error: 'Thiếu platform hoặc file cookies' });
    }
    const validPlatforms = ['bilibili', 'douyin', 'tiktok', 'youtube', 'facebook', 'instagram', 'xiaohongshu', 'rednote', 'weibo', 'youku', 'mgtv', 'iq'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ error: 'Platform không hợp lệ' });
    }
    shared.saveCookieFile(platform, req.file.path);
    res.json({ success: true, message: `Đã lưu cookies cho ${platform}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cookie-status', (req, res) => {
  try {
    res.json(shared.getCookieStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete-cookie', (req, res) => {
  try {
    const platform = req.body.platform;
    if (!platform) return res.status(400).json({ error: 'Thiếu platform' });
    shared.deleteCookieFile(platform);
    res.json({ success: true, message: `Đã xóa cookies cho ${platform}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
app.post('/api/render-use-whisper', studioController.useWhisperForRenderTask);
app.post('/api/render-resume', studioController.resumeRenderTask);
app.get('/api/render-tasks/:taskId/segments', segmentController.getSegments);
app.put('/api/render-tasks/:taskId/segments', segmentController.updateSegments);
app.post('/api/render-tasks/:taskId/segments/replace', segmentController.replaceText);
app.post('/api/render-tasks/:taskId/segments/approve', segmentController.approveSegments);
app.post('/api/render-tasks/:taskId/segments/:segmentId/regenerate', segmentController.regenerateSegment);
app.post('/api/render-tasks/:taskId/segments/:segmentId/asr-retry', segmentController.retryAsrSegment);
app.post('/api/render-tasks/:taskId/segments/:segmentId/asr-cancel', segmentController.cancelAsrRetry);
app.get('/api/render-tasks/:taskId/segments/:segmentId/audio', segmentController.streamSegmentAudio);
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

// --- Anti-dupe: NÉ TRÙNG render + BĂM VIDEO THEO CẢNH ---
app.post('/api/anti-dupe-render', studioUpload.fields([
  { name: 'videoUpload', maxCount: 1 },
  { name: 'logoUpload', maxCount: 1 }
]), antiDupeController.renderAntiDupe);
app.post('/api/anti-dupe-scene-split', studioUpload.fields([
  { name: 'videoUpload', maxCount: 1 },
  { name: 'logoUpload', maxCount: 1 }
]), antiDupeController.renderSceneSplit);
app.get('/api/anti-dupe-progress', antiDupeController.getProgress);
app.post('/api/anti-dupe-cancel', antiDupeController.cancel);

// 4. Voice and asset routes
app.get('/api/voice-engines', voiceController.getVoiceEngines);
app.post('/api/generate-cloner-voice', studioUpload.single('refAudio'), voiceController.generateClonerVoice);
app.get('/api/cloner-voice-progress', voiceController.getClonerProgress);
app.post('/api/cancel-cloner-voice', voiceController.cancelClonerVoice);
app.post('/api/save-cloner-voice', voiceController.saveClonerVoice);
app.post('/api/clear-temp-cloner-voice', voiceController.clearTempClonerVoice);
app.post('/api/save-voice', studioUpload.single('voice'), voiceController.saveVoice);
app.post('/api/save-music', studioUpload.single('music'), voiceController.saveMusic);
app.post('/api/save-video', studioUpload.single('video'), voiceController.saveVideo);
app.delete('/api/rendered-videos/:filename', voiceController.deleteVideo);
app.delete('/api/voices/:filename', voiceController.deleteVoice);
app.delete('/api/music/:filename', voiceController.deleteMusic);
app.get('/api/local-videos', voiceController.getLocalVideos);

// API: Mở trình duyệt Đăng nhập Gemini Web
app.post('/api/gemini-web/login', async (req, res) => {
  try {
    const { openGeminiLogin } = require('./lib/gemini-web-adapter');
    const result = await openGeminiLogin();
    res.json({ success: true, message: 'Đã mở trình duyệt đăng nhập Gemini', ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
app.get('/api/select-save-path', systemController.selectSavePath);
app.get('/api/open-folder', systemController.openFolder);
// Douyin: extract + download qua BrowserWindow ẩn (không cần yt-dlp/cookies)
app.get('/api/douyin-info', downloadController.getDouyinInfo);
app.post('/api/douyin-download', downloadController.downloadDouyin);

app.get('/api/open-file-folder', systemController.openFileFolder);
app.get('/api/serve-file', systemController.serveFile);
app.post('/api/publish-facebook', systemController.publishFacebook);
app.post('/api/verify-facebook-page', systemController.verifyFacebookPage);
app.get('/api/check-dependencies', systemController.checkDependencies);
app.get('/api/check-dependencies-status', systemController.checkDependenciesStatus);
app.post('/api/download-dependency', systemController.downloadDependency);
app.get('/api/download-dependency-progress', systemController.getDependencyDownloadProgress);
systemController.registerOcrComponentRoutes(app, systemController);
systemController.registerMdxCudaComponentRoutes(app, systemController);
app.post('/api/download-model', systemController.downloadModel);
app.get('/api/download-model/status', systemController.getModelStatus);
app.get('/api/whisper-model/status', systemController.getWhisperModelStatus);
app.get('/api/whisper-device/status', systemController.getWhisperDeviceStatus);
app.post('/api/download-whisper-model', systemController.downloadWhisperModel);
app.get('/api/license/hwid', systemController.getLicenseHwid);
app.post('/api/license/activate', systemController.activateLicense);
app.get('/api/update-status', systemController.getUpdateStatus);
app.post('/api/quit-and-install', systemController.quitAndInstallUpdate);

// Tải danh sách model khả dụng từ OpenAI API theo Key
app.post('/api/openai/models', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'Vui lòng cung cấp OpenAI API Key.' });
    }
    const response = await axios.get('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      timeout: 10000
    });
    const rawModels = response.data?.data || [];
    const chatModels = rawModels
      .map(m => m.id)
      .filter(id => /^(gpt|o1|o3)/i.test(id) && !id.includes('realtime') && !id.includes('audio') && !id.includes('tts') && !id.includes('whisper') && !id.includes('embedding') && !id.includes('dall-e'))
      .sort((a, b) => {
        if (a.startsWith('gpt-4o') && !b.startsWith('gpt-4o')) return -1;
        if (!a.startsWith('gpt-4o') && b.startsWith('gpt-4o')) return 1;
        return a.localeCompare(b);
      });

    const resultModels = chatModels.length > 0 ? chatModels : ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'];
    res.json({ success: true, models: resultModels });
  } catch (err) {
    const status = err.response?.status || 500;
    const msg = err.response?.data?.error?.message || err.message || 'Lỗi kết nối tới OpenAI API.';
    res.status(status).json({ error: msg });
  }
});

// Thông tin phiên bản app + changelog
app.get('/api/app-version', (req, res) => {
  try {
    const pkg = require('./package.json');
    const currentVersion = pkg.version;
    
    // Đọc changelog
    let changelog = [];
    try {
      const changelogData = require('./changelog.json');
      changelog = changelogData.versions || [];
    } catch (_) { /* Không có file changelog */ }
    
    // Tìm changelog cho phiên bản hiện tại
    const currentChangelog = changelog.find(v => v.version === currentVersion) || null;
    
    // Kiểm tra xem app vừa update xong không
    const justUpdated = global.justUpdated || false;
    
    // Reset flag sau khi đã thông báo
    if (global.justUpdated) {
      global.justUpdated = false;
    }
    
    res.json({
      version: currentVersion,
      changelog: currentChangelog,
      allChangelog: changelog,
      justUpdated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Thông tin app: license + disk usage cho sidebar
app.get('/api/app-info', async (req, res) => {
  const result = { license: { valid: false }, disk: { usedByApp: 0, total: 0, free: 0 } };

  // --- License info ---
  try {
    const local = verifyLocalLicense();
    if (local.valid) {
      const p = local.payload;
      result.license = {
        valid: true,
        expiresAt: p.expiresAt,
        keyMasked: p.key ? (p.key.slice(0, 4) + '****' + p.key.slice(-4)) : 'N/A',
        customerName: null,
        plan: null,
        daysLeft: null
      };
      // Thử lấy thêm từ license server (customerName, plan, daysLeft)
      try {
        const resp = await axios.post(
          `${LICENSE_SERVER_URL}/api/server/verify`,
          { key: p.key, hwid: p.hwid },
          { timeout: 3000 }
        );
        if (resp.data && resp.data.status === 'active') {
          result.license.customerName = resp.data.customerName || null;
          result.license.plan = resp.data.planType || resp.data.plan || null;
          result.license.daysLeft = resp.data.daysLeft != null ? resp.data.daysLeft : null;
        }
      } catch (_) { /* offline — dùng local expiresAt */ }

      // Tính daysLeft từ local nếu server không trả về
      if (result.license.daysLeft == null && p.expiresAt) {
        const diff = new Date(p.expiresAt) - new Date();
        result.license.daysLeft = Math.max(0, Math.floor(diff / 86400000));
      }
    }
  } catch (e) {
    result.license = { valid: false, error: e.message };
  }

  // --- Disk info ---
  try {
    const { execSync } = require('child_process');
    const os = require('os');
    const licFile = getLicenseFilePath();
    const drive = licFile.substring(0, 2).toUpperCase(); // e.g. "C:"
    const driveLetter = drive[0]; // e.g. "C"

    let total = 0, free = 0;

    // Thử wmic trước (Windows 10 / Server)
    try {
      const wmicOut = execSync(
        `wmic logicaldisk where "DeviceID='${drive}'" get Size,FreeSpace /value`,
        { encoding: 'utf8', timeout: 3000 }
      );
      const freeMatch = wmicOut.match(/FreeSpace=(\d+)/);
      const sizeMatch = wmicOut.match(/Size=(\d+)/);
      if (freeMatch && sizeMatch) {
        total = parseInt(sizeMatch[1]);
        free  = parseInt(freeMatch[1]);
      }
    } catch (_) {
      // wmic không có (Windows 11 22H2+) → dùng PowerShell
    }

    // Fallback: PowerShell qua Command (tránh quoting/execution policy issues)
    if (total === 0) {
      try {
        const psOut = execSync(
          `powershell -NoProfile -Command "$d = Get-WmiObject Win32_LogicalDisk | Where-Object { $_.DeviceID -eq '${driveLetter}:' }; if ($d) { Write-Output ($d.Size.ToString() + ',' + $d.FreeSpace.ToString()) } else { Write-Output '0,0' }"`,
          { encoding: 'utf8', timeout: 6000 }
        ).trim();
        const parts = psOut.split(',');
        if (parts.length === 2) {
          total = parseInt(parts[0]) || 0;
          free  = parseInt(parts[1]) || 0;
        }
      } catch (_) { /* cả 2 đều lỗi, trả 0 */ }
      try { fs.unlinkSync(tmpFile); } catch (_) { }
    }

    if (total > 0) {
      // Tính dung lượng do app dùng: userData folder + downloads folder
      function getDirSize(dir) {
        if (!fs.existsSync(dir)) return 0;
        let size = 0;
        try {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, item.name);
            try {
              if (item.isDirectory()) size += getDirSize(full);
              else size += fs.statSync(full).size;
            } catch (_) { }
          }
        } catch (_) { }
        return size;
      }

      const userDataDir = path.dirname(licFile);
      const downloadsDir = shared.DOWNLOADS_DIR || path.join(userDataDir, 'downloads');
      const usedByApp = downloadsDir.startsWith(userDataDir)
        ? getDirSize(userDataDir)
        : getDirSize(userDataDir) + getDirSize(downloadsDir);

      result.disk = { total, free, usedByApp };
    }
  } catch (e) {
    result.disk = { total: 0, free: 0, usedByApp: 0 };
    console.error('[AppInfo] Disk error:', e.message);
  }

  res.json(result);
});

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
      studioController.restoreRenderQueue();
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
