const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const axios = require('axios');
const shared = require('../lib/shared-state');
const { getCompositeHWID, saveLicenseLocal, verifyLocalLicense, LICENSE_SERVER_URL } = require('../lib/license-manager');
const { checkDependencyStatus, downloadAndExtract } = require('../lib/dependency-downloader');
const ocrComponentManager = require('../lib/ocr-component-manager');
const FacebookApiService = require('../lib/facebookApi');
const { validate, validators } = require('../lib/validate');

let electronShell = null;
let electronDialog = null;
try {
  const electron = require('electron');
  electronShell = electron.shell;
  electronDialog = electron.dialog;
} catch (e) {}

let modelDownloadStatus = { downloading: false, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };
let whisperDownloadStatus = {};

function normalizeWhisperOnnxVariant(value) {
  const variant = String(value || 'q8').trim().toLowerCase();
  if (['small', 'base', 'tiny', 'medium', 'large-v3'].includes(variant)) return 'q8';
  if (!['q8', 'fp32'].includes(variant)) {
    throw new Error(`Biến thể Whisper ONNX không hợp lệ: ${value}`);
  }
  return variant;
}

function getWhisperOnnxReadiness(variant) {
  const { getWhisperOnnxConfig } = require('../lib/model-downloader');
  const config = getWhisperOnnxConfig(variant);
  const modelDir = path.join(shared.MODELS_DIR, 'whisper', config.folder);
  return {
    config,
    modelDir,
    exists: config.files.every((file) => {
      const filePath = path.join(modelDir, ...file.name.split('/'));
      return fs.existsSync(filePath) && fs.statSync(filePath).size === file.size;
    })
  };
}
let activeDependencyDownload = null;

function createOcrComponentHandlers(manager, logger = console) {
  return {
    getOcrComponentStatus: async (req, res) => {
      try {
        const status = await manager.refreshOcrComponentStatus();
        return res.json(status);
      } catch (error) {
        logger.error('OCR component status refresh failed:', error);
        return res.status(500).json({ error: error.message });
      }
    },

    startOcrComponentDownload: (req, res) => {
      try {
        Promise.resolve(manager.downloadOcrComponent()).catch((error) => {
          logger.error('OCR component download failed:', error);
        });
        return res.status(202).json({ success: true, message: 'Bắt đầu tải OCR' });
      } catch (error) {
        logger.error('OCR component download start failed:', error);
        return res.status(500).json({ error: error.message });
      }
    },

    getOcrComponentDownloadStatus: (req, res) => {
      return res.json(manager.getOcrDownloadProgress());
    },

    cancelOcrComponentDownload: async (req, res) => {
      try {
        const status = await manager.cancelOcrComponentDownload();
        return res.json({ success: true, status });
      } catch (error) {
        logger.error('OCR component download cancel failed:', error);
        return res.status(500).json({ error: error.message });
      }
    }
  };
}

const ocrComponentHandlers = createOcrComponentHandlers(ocrComponentManager);

function registerOcrComponentRoutes(app, handlers) {
  app.get('/api/ocr-component/status', handlers.getOcrComponentStatus);
  app.post('/api/ocr-component/download', handlers.startOcrComponentDownload);
  app.get('/api/ocr-component/download-status', handlers.getOcrComponentDownloadStatus);
  app.post('/api/ocr-component/cancel', handlers.cancelOcrComponentDownload);
}

module.exports = {
  createOcrComponentHandlers,
  registerOcrComponentRoutes,
  ...ocrComponentHandlers,
  getVideoInfo: async (req, res) => {
    try {
      // Validation tập trung qua validate helper
      const { err, values } = validate(req.body, {
        url: validators.url('Vui lòng nhập URL video hợp lệ (http/https)')
      });
      if (err) return res.status(400).json({ error: err });

      let url = shared.extractUrl(values.url);
      if (!url || !shared.isValidVideoUrl(url)) {
        return res.status(400).json({ error: 'URL không hợp lệ' });
      }

      const ytArgs = [
        '--dump-json',
        '--no-warnings',
        '--no-playlist',
        '--ignore-no-formats-error',
        ...shared.getCustomExtractorArgs(url)
      ];
      ytArgs.push(url);

      const output = await shared.runYtDlp(ytArgs);
      const info = JSON.parse(output);

      const formats = (info.formats || [])
        .filter(f => {
          return (f.vcodec && f.vcodec !== 'none' || f.video_ext) && f.height;
        })
        .sort((a, b) => {
          if (a.height !== b.height) return b.height - a.height;
          const aSize = a.filesize || a.filesize_approx || a.tbr || 0;
          const bSize = b.filesize || b.filesize_approx || b.tbr || 0;
          if (aSize !== bSize) return bSize - aSize;
          return (b.fps || 30) - (a.fps || 30);
        })
        .map(f => ({
          format_id: f.format_id,
          quality: f.height ? `${f.height}p` : f.format_note || 'N/A',
          height: f.height || 0,
          fps: f.fps || 30,
          size: f.filesize
            ? (f.filesize / (1024 * 1024)).toFixed(1) + ' MB'
            : f.filesize_approx
              ? '~' + (f.filesize_approx / (1024 * 1024)).toFixed(1) + ' MB'
              : 'N/A',
          hasAudio: true, 
          container: 'mp4',
          format_note: f.format_note || '',
          url: f.url || '',
        }))
        .reduce((acc, f) => {
          const key = `${f.quality}-${f.fps}`;
          if (!acc.map.has(key)) {
            acc.map.set(key, true);
            acc.list.push(f);
          }
          return acc;
        }, { map: new Map(), list: [] }).list;

      const thumbnail = info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : '');
      let proxiedThumbnail = thumbnail;
      if (thumbnail && (thumbnail.startsWith('http://') || thumbnail.startsWith('https://'))) {
        proxiedThumbnail = `/api/proxy-image?url=${encodeURIComponent(thumbnail)}`;
      }
      
      let author = info.uploader || info.channel || info.uploader_id || (info.extractor === 'XiaoHongShu' ? 'Xiaohongshu User' : 'Unknown');
      let title = shared.cleanVideoTitle(info.title);
      if ((url.includes('instagram.com') || url.includes('instagr.am')) && info.description) {
        const firstLine = info.description.split('\n')[0].trim();
        if (firstLine) {
          title = shared.cleanVideoTitle(firstLine);
        }
      }

      if (url.includes('xiaohongshu.com') && (title.startsWith('XiaoHongShu video #') || author === 'Xiaohongshu User' || /^[a-f0-9]{24}$/.test(author))) {
        try {
          const response = await axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            timeout: 5000
          });
          const html = response.data;
          const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
          if (titleMatch) {
            let scrapedTitle = titleMatch[1].trim();
            scrapedTitle = scrapedTitle.replace(/\s*\|\s*小红书\s*-\s*.*$/, '');
            if (scrapedTitle && !scrapedTitle.includes('你访问 của 页面不见了')) {
              title = scrapedTitle;
            }
          }
          const nickMatch = html.match(/"nickname"\s*:\s*"([^"]+)"/);
          if (nickMatch && nickMatch[1]) {
            author = nickMatch[1];
          }
        } catch (e) {
          console.error('Scraping fallback error:', e.message);
        }
      }

      res.json({
        title,
        thumbnail: proxiedThumbnail,
        duration: info.duration || 0,
        author,
        viewCount: info.view_count || 0,
        formats,
      });
    } catch (error) {
      console.error('Error getting info:', error.message);
      let errorMsg = 'Không thể lấy thông tin video. Vui lòng thử lại.';
      if (error.message.includes('No video formats found')) {
        errorMsg = 'Bài viết không chứa video (đây có thể là bài đăng hình ảnh/slide).';
      } else if (error.message.includes('Sign in to confirm your age') || error.message.includes('confirm your age')) {
        errorMsg = 'Video giới hạn độ tuổi, yêu cầu tài khoản.';
      } else if (error.message.includes('Private video')) {
        errorMsg = 'Video ở chế độ riêng tư hoặc đã bị xóa.';
      } else if (error.message.includes('Fresh cookies') || error.message.includes('cookies are needed') || error.message.includes('Failed to parse JSON')) {
        errorMsg = 'Lỗi kết nối Douyin: Yêu cầu cookie mới. Nếu bạn đã lưu cookie mới nhất mà vẫn gặp lỗi này, có thể Douyin đang chặn IP/User-Agent của công cụ hoặc yt-dlp đang bị lỗi trích xuất (hãy thử cập nhật yt-dlp hoặc sử dụng trang web tải ngoài như SnapTik/SSSTik).';
      }
      res.status(500).json({ error: errorMsg });
    }
  },

  getGeminiModels: async (req, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey) {
        return res.status(400).json({ error: 'Thiếu API Key' });
      }
      const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const models = response.data.models || [];
      const validModels = models
        .filter(m => 
          m.supportedGenerationMethods && 
          m.supportedGenerationMethods.includes('generateContent') &&
          m.name.includes('gemini')
        )
        .map(m => ({
          name: m.name,
          displayName: m.displayName || m.name.replace('models/', '')
        }));

      res.json({ models: validModels });
    } catch (error) {
      console.error('Lỗi khi lấy danh sách model Gemini:', error.message);
      const errorMsg = error.response?.data?.error?.message || error.message;
      res.status(500).json({ error: `Lỗi: ${errorMsg}` });
    }
  },

  getOpenRouterModels: async (req, res) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey) {
        return res.status(400).json({ error: 'Thiếu API Key' });
      }
      const response = await axios.get('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });
      const models = response.data.data || [];
      const formattedModels = models.map(m => {
        const isFree = m.id.endsWith(':free') || (m.pricing && parseFloat(m.pricing.prompt) === 0 && parseFloat(m.pricing.completion) === 0);
        return {
          id: m.id,
          name: m.name || m.id,
          isFree: isFree,
          contextLength: m.context_length
        };
      });

      formattedModels.sort((a, b) => {
        if (a.isFree && !b.isFree) return -1;
        if (!a.isFree && b.isFree) return 1;
        return a.name.localeCompare(b.name);
      });

      res.json({ models: formattedModels });
    } catch (error) {
      console.error('Lỗi khi lấy danh sách model OpenRouter:', error.message);
      const errorMsg = error.response?.data?.error?.message || error.message;
      res.status(500).json({ error: `Lỗi: ${errorMsg}` });
    }
  },

  selectSavePath: async (req, res) => {
    try {
      const { defaultFilename, mode } = req.query;
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

      if (mode === 'folder') {
        const result = await electronDialog.showOpenDialog(win, {
          defaultPath: shared.DOWNLOADS_DIR,
          properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled) return res.json({ canceled: true });
        return res.json({ canceled: false, dir: result.filePaths[0] });
      }

      const defaultPath = defaultFilename
        ? path.join(shared.DOWNLOADS_DIR, defaultFilename)
        : shared.DOWNLOADS_DIR;
      const result = await electronDialog.showSaveDialog(win, {
        defaultPath,
        filters: [{ name: 'Video files', extensions: ['mp4'] }]
      });
      if (result.canceled) return res.json({ canceled: true });
      return res.json({
        canceled: false,
        dir: path.dirname(result.filePath),
        filename: path.basename(result.filePath)
      });
    } catch (err) {
      console.error('selectSavePath error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  },

  openFolder: async (req, res) => {
    if (electronShell) {
      try {
        await electronShell.openPath(shared.DOWNLOADS_DIR);
        return res.json({ success: true });
      } catch (err) {
        console.error('Lỗi khi mở thư mục bằng Electron shell:', err.message);
      }
    }
    // Bảo mật: dùng execFile (không qua shell) để tránh command injection
    try {
      const cmd = process.platform === 'win32' ? 'explorer'
        : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      child_process.execFile(cmd, [shared.DOWNLOADS_DIR]);
      res.json({ success: true });
    } catch (err) {
      console.error('Lỗi mở thư mục:', err.message);
      res.status(500).json({ error: 'Lỗi mở thư mục' });
    }
  },

  openFileFolder: async (req, res) => {
    try {
      const { filename } = req.query;
      if (!filename) {
        return res.status(400).json({ error: 'Thiếu tên file' });
      }

      // BẢO MẬT: path.basename() loại bỏ mọi ký tự đường dẫn để chống path traversal & command injection
      const safeFilename = path.basename(filename);
      if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
        return res.status(400).json({ error: 'Tên file không hợp lệ' });
      }

      let fullPath = path.join(shared.DOWNLOADS_DIR, safeFilename);
      if (!fs.existsSync(fullPath)) {
        fullPath = path.join(shared.RENDERS_DIR, safeFilename);
      }
      if (!fs.existsSync(fullPath)) {
        const homeDir = os.homedir();
        fullPath = path.join(homeDir, 'Downloads', safeFilename);
      }

      if (fs.existsSync(fullPath)) {
        if (electronShell) {
          try {
            electronShell.showItemInFolder(fullPath);
            return res.json({ success: true });
          } catch (err) {
            console.error('Lỗi khi hiển thị file bằng Electron shell:', err.message);
          }
        }

        // Bảo mật: dùng execFile (không qua shell) để tránh command injection
        if (process.platform === 'win32') {
          child_process.execFile('explorer.exe', ['/select,', fullPath]);
        } else if (process.platform === 'darwin') {
          child_process.execFile('open', ['-R', fullPath]);
        } else {
          child_process.execFile('xdg-open', [path.dirname(fullPath)]);
        }
        return res.json({ success: true });
      } else {
        if (electronShell) {
          try {
            await electronShell.openPath(shared.DOWNLOADS_DIR);
            return res.json({ success: true });
          } catch (err) {
            console.error('Lỗi khi mở thư mục bằng Electron shell:', err.message);
          }
        }
        const cmd = process.platform === 'win32' ? 'explorer'
          : (process.platform === 'darwin' ? 'open' : 'xdg-open');
        child_process.execFile(cmd, [shared.DOWNLOADS_DIR]);
        return res.json({ success: true });
      }
    } catch (error) {
      console.error('Open file folder error:', error.message);
      res.status(500).json({ error: 'Lỗi mở thư mục' });
    }
  },

  serveFile: async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'Thiếu path' });
      // Validate: chỉ cho phép file .mp4 từ thư mục tùy chỉnh
      const resolved = path.resolve(filePath);
      if (!resolved.endsWith('.mp4') && !resolved.endsWith('.webm')) {
        return res.status(403).json({ error: 'Định dạng không được hỗ trợ' });
      }
      if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File không tồn tại' });
      res.sendFile(resolved);
    } catch (e) {
      res.status(500).json({ error: 'Lỗi serve file: ' + e.message });
    }
  },

  publishFacebook: async (req, res) => {
    try {
      const { videoPath, description, comment, pageId, pageToken } = req.body;
      const actualVideoPath = path.join(shared.RENDERS_DIR, path.basename(videoPath));

      if (!videoPath || !fs.existsSync(actualVideoPath)) {
        return res.status(400).json({ error: 'Không tìm thấy file video trên máy chủ' });
      }
      if (!pageId || !pageToken) {
        return res.status(400).json({ error: 'Thiếu Facebook Page ID hoặc Token' });
      }

      const fbService = new FacebookApiService(pageId, pageToken);
      const result = await fbService.publishAndComment(actualVideoPath, description, comment);
      
      if (result.success) {
        res.json({ success: true, postId: result.postId, warning: result.warning });
      } else {
        res.status(500).json({ error: result.error });
      }
    } catch (err) {
      console.error('Lỗi khi đăng Facebook:', err);
      res.status(500).json({ error: err.message });
    }
  },

  verifyFacebookPage: async (req, res) => {
    try {
      const { pageId, pageToken } = req.body;
      if (!pageId || !pageToken) {
        return res.status(400).json({ error: 'Thiếu Facebook Page ID hoặc Token' });
      }
      const response = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
        params: {
          fields: 'id,name',
          access_token: pageToken
        }
      });
      res.json({ success: true, name: response.data.name });
    } catch (err) {
      let errMsg = err.message;
      if (err.response && err.response.data && err.response.data.error) {
        errMsg = err.response.data.error.message;
      }
      console.error('Lỗi khi xác thực Facebook page:', errMsg);
      res.status(400).json({ error: errMsg });
    }
  },

  checkDependencies: async (req, res) => {
    const ffmpegOk = fs.existsSync(shared.FFMPEG_PATH);
    const ytdlpOk = fs.existsSync(shared.YTDLP_PATH);
    const whisperVariants = {
      q8: getWhisperOnnxReadiness('q8').exists,
      fp32: getWhisperOnnxReadiness('fp32').exists
    };
    const whisperModelOk = whisperVariants.q8;
    const downloadedWhisperModels = whisperModelOk ? ['small'] : [];

    const omnivoiceCliOk = fs.existsSync(shared.OMNIVOICE_CLI_PATH);
    const omnivoiceModelOk = fs.existsSync(shared.OMNIVOICE_MODEL_PATH);

    const separatorCliOk = fs.existsSync(shared.AUDIO_SEPARATOR_CLI_PATH) || fs.existsSync(path.join(shared.TOOLS_DIR, 'audio-separator.exe'));

    res.json({
      ffmpeg: ffmpegOk,
      ytdlp: ytdlpOk,
      whisper: whisperModelOk,
      whisperModel: whisperModelOk,
      whisperVariants,
      downloadedWhisperModels: downloadedWhisperModels,
      omnivoice: omnivoiceCliOk && omnivoiceModelOk,
      omnivoiceCli: omnivoiceCliOk,
      omnivoiceModel: omnivoiceModelOk,
      separator: separatorCliOk,
      separatorCli: separatorCliOk,
      separatorGpu: fs.existsSync(path.join(__dirname, '..', 'temp_env', 'Scripts', 'python.exe'))
    });
  },

  checkDependenciesStatus: async (req, res) => {
    try {
      // Ưu tiên DATA_TOOLS_DIR (data dir), fallback TOOLS_DIR (resources, bản cũ)
      const checkDir = fs.existsSync(shared.DATA_TOOLS_DIR) ? shared.DATA_TOOLS_DIR : shared.TOOLS_DIR;
      const status = checkDependencyStatus(checkDir);
      res.json(status);
    } catch (error) {
      console.error('Check dependency status error:', error.message);
      res.status(500).json({ error: 'Không thể kiểm tra trạng thái thư viện' });
    }
  },

  downloadDependency: async (req, res) => {
    const { type } = req.body;
    if (!['cuda', 'separator', 'separator-gpu'].includes(type)) {
      return res.status(400).json({ error: 'Loại thư viện không hợp lệ' });
    }

    if (activeDependencyDownload) {
      return res.status(400).json({ error: 'Đang có tiến trình tải xuống chạy ngầm khác' });
    }

    activeDependencyDownload = { type, percent: 0, status: 'downloading' };
    res.json({ message: 'Bắt đầu tải xuống ngầm' });

    try {
      console.log(`[Dependency Downloader] Bắt đầu tải ${type} vào ${shared.DATA_TOOLS_DIR}...`);
      await downloadAndExtract(type, shared.DATA_TOOLS_DIR, (downloaded, total) => {
        if (activeDependencyDownload) {
          activeDependencyDownload.percent = Math.floor((downloaded / (total || 1)) * 100);
        }
      });

      // Chạy post-setup cho GPU separator
      if (type === 'separator-gpu') {
        if (activeDependencyDownload) {
          activeDependencyDownload.status = 'setup';
          activeDependencyDownload.step = 'Đang cài GPU packages (Python, PyTorch)...';
        }
        const setupScript = path.join(shared.DATA_TOOLS_DIR, 'setup_gpu_separator.ps1');
        if (fs.existsSync(setupScript)) {
          // Patch lỗi script gốc: xóa Out-Null, sửa CUDA check bị PowerShell parse lỗi
          let psContent = fs.readFileSync(setupScript, 'utf8');
          if (psContent.includes('| Out-Null') || psContent.includes("cuda.get_device_name(0) if")) {
            psContent = psContent.replace(/\| Out-Null/g, '');
            psContent = psContent.replace(/\$result = & \$venvPython -c "[^"]*torch\.cuda[^"]*" 2>&1/g, '# CUDA check handled via check_cuda.py below');
            // Chèn block CUDA check mới dùng file riêng
            const checkPy = path.join(shared.DATA_TOOLS_DIR, 'check_cuda.py');
            if (!fs.existsSync(checkPy)) {
              fs.writeFileSync(checkPy, `import torch\nprint('CUDA: ' + str(torch.cuda.is_available()) + ' | Device: ' + (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A') + ' | PyTorch: ' + torch.__version__)\n`, 'utf8');
            }
            const marker = '# ── Bước 5: Kiểm tra ──';
            const idx = psContent.indexOf(marker);
            if (idx >= 0) {
              const blockEnd = psContent.indexOf('# ── Bước 6:', idx);
              const oldBlock = blockEnd >= 0 ? psContent.substring(idx, blockEnd) : psContent.substring(idx);
              const newBlock = `# ── Bước 5: Kiểm tra ──
Write-Step "Đang kiểm tra CUDA availability..."
try {
    # Kiểm tra CUDA
    $checkScript = Join-Path $ToolsDir "check_cuda.py"
    if (Test-Path $checkScript) {
        $result = & $venvPython $checkScript 2>&1
        Write-OK $result
    }
    # Kiểm tra import audio-separator
    & $venvPython -c "from audio_separator.separator import Separator; print('audio-separator OK')" 2>&1
    Write-OK "audio-separator import OK"
} catch {
    Write-Warn "Kiểm tra thất bại: $_"
    throw
}
`;
              psContent = psContent.replace(oldBlock, newBlock);
            }
            fs.writeFileSync(setupScript, psContent, 'utf8');
            console.log('[Dependency Downloader] Đã patch setup_gpu_separator.ps1 (fix Out-Null + CUDA check).');
          }

          const { execFile } = require('child_process');
          await new Promise((resolve, reject) => {
            const proc = execFile('powershell.exe', [
              '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript
            ], { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
              if (err) reject(new Error(`Setup thất bại: ${err.message}\n${stdout}`));
              else resolve();
            });
            if (global.registerChildProcess) {
              global.registerChildProcess(proc);
            }
          });

          // Kiểm tra venv đã được tạo chưa (script hay nuốt lỗi vì Out-Null)
          const venvRoot = path.resolve(shared.DATA_TOOLS_DIR, '..');
          const venvPython = path.join(venvRoot, 'temp_env', 'Scripts', 'python.exe');
          if (!fs.existsSync(venvPython)) {
            console.error('[Dependency Downloader] GPU separator setup script chạy xong nhưng không tạo được venv.');
            throw new Error('Script setup chạy xong nhưng không tạo được Python venv. Hãy kiểm tra log chi tiết.');
          }

          console.log('[Dependency Downloader] GPU separator setup hoàn tất.');
        }
      }

      if (activeDependencyDownload) {
        activeDependencyDownload.status = 'success';
        activeDependencyDownload.percent = 100;
      }
      console.log(`[Dependency Downloader] Tải và giải nén ${type} thành công.`);
    } catch (err) {
      console.error(`[Dependency Downloader] Lỗi khi tải ${type}:`, err.message);
      if (activeDependencyDownload) {
        activeDependencyDownload.status = 'error';
        activeDependencyDownload.error = err.message;
      }
    } finally {
      setTimeout(() => {
        activeDependencyDownload = null;
      }, 8000);
    }
  },

  getDependencyDownloadProgress: async (req, res) => {
    res.json(activeDependencyDownload || { status: 'idle' });
  },

  downloadModel: async (req, res) => {
    if (modelDownloadStatus.downloading) {
      return res.json({ success: true, message: 'Đang tải rồi' });
    }
    const { ensureModelsExist } = require('../lib/model-downloader');
    modelDownloadStatus = { downloading: true, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };
    res.json({ success: true, message: 'Bắt đầu tải model' });

    try {
      await ensureModelsExist(shared.MODELS_DIR, (progress) => {
        modelDownloadStatus.percent = progress.percent;
        modelDownloadStatus.downloadedBytes = progress.downloadedBytes;
        modelDownloadStatus.totalBytes = progress.totalBytes;
      });
      modelDownloadStatus.downloading = false;
      modelDownloadStatus.percent = 100;
    } catch (err) {
      console.error('Lỗi tải model qua API:', err.message);
      modelDownloadStatus.downloading = false;
      modelDownloadStatus.error = err.message;
    }
  },

  getModelStatus: async (req, res) => {
    const cliExists = fs.existsSync(shared.OMNIVOICE_CLI_PATH);
    const modelExists = fs.existsSync(shared.OMNIVOICE_MODEL_PATH);
    const checkConfigured = cliExists && modelExists;
    res.json({
      ...modelDownloadStatus,
      omiConfigured: checkConfigured
    });
  },

  getWhisperModelStatus: async (req, res) => {
    let variant;
    try {
      variant = normalizeWhisperOnnxVariant(req.query?.variant || req.query?.model);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const { config, exists } = getWhisperOnnxReadiness(variant);
    const totalBytes = config.files.reduce((sum, file) => sum + file.size, 0);

    const status = whisperDownloadStatus[variant] || { downloading: false, percent: 0, error: null };
    res.json({
      variant,
      exists,
      downloading: status.downloading,
      percent: status.percent,
      error: status.error,
      downloadedBytes: status.downloadedBytes,
      totalBytes: status.totalBytes || totalBytes
    });
  },

  downloadWhisperModel: async (req, res) => {
    let variant;
    try {
      variant = normalizeWhisperOnnxVariant(req.body?.variant || req.body?.model);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    if (whisperDownloadStatus[variant] && whisperDownloadStatus[variant].downloading) {
      return res.json({ success: true, message: 'Đang tải rồi' });
    }
    const { ensureWhisperOnnxModelExist } = require('../lib/model-downloader');
    whisperDownloadStatus[variant] = { downloading: true, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };
    res.json({ success: true, message: 'Bắt đầu tải model Whisper' });

    try {
      await ensureWhisperOnnxModelExist(shared.MODELS_DIR, variant, (progress) => {
        whisperDownloadStatus[variant].percent = progress.percent;
        whisperDownloadStatus[variant].downloadedBytes = progress.downloadedBytes;
        whisperDownloadStatus[variant].totalBytes = progress.totalBytes;
      });
      whisperDownloadStatus[variant].downloading = false;
      whisperDownloadStatus[variant].percent = 100;
    } catch (err) {
      console.error(`Lỗi tải model Whisper ${variant} qua API:`, err.message);
      whisperDownloadStatus[variant].downloading = false;
      whisperDownloadStatus[variant].error = err.message;
    }
  },

  getLicenseHwid: async (req, res) => {
    try {
      const hwid = getCompositeHWID();
      res.json({ hwid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  activateLicense: async (req, res) => {
    const { key } = req.body;
    if (!key) {
      return res.status(400).json({ error: 'Mã bản quyền là bắt buộc' });
    }
    try {
      const hwid = getCompositeHWID();
      const response = await axios.post(`${LICENSE_SERVER_URL}/api/server/activate`, { key, hwid }, { timeout: 6000 });
      
      if (response.data && response.data.status === 'success') {
        const { expiresAt, signature, issuedAt, nonce } = response.data;
        const payload = {
          key, hwid, expiresAt, issuedAt, nonce,
          lastOnlineCheck: Date.now(),
          launchCountSinceOnlineCheck: 0,
          lastRunTimestamp: Date.now()
        };
        saveLicenseLocal(payload, signature);
        return res.json({ success: true, message: 'Kích hoạt bản quyền thành công' });
      } else {
        return res.status(400).json({ error: (response.data && response.data.error) || 'Mã kích hoạt không đúng' });
      }
    } catch (err) {
      console.error('Lỗi kích hoạt license:', err.message);
      const errorMsg = err.response && err.response.data && err.response.data.error
        ? err.response.data.error
        : 'Không thể kết nối đến máy chủ bản quyền. Vui lòng thử lại sau.';
      res.status(500).json({ error: errorMsg });
    }
  },

  getUpdateStatus: async (req, res) => {
    res.json(global.updateStatus || { status: 'idle', percent: 0, error: null });
  },

  quitAndInstallUpdate: async (req, res) => {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall();
      res.json({ success: true });
    } catch (err) {
      console.error('Lỗi khi thực hiện quitAndInstall:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
};
