const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const axios = require('axios');
const shared = require('../lib/shared-state');
const { getCompositeHWID, saveLicenseLocal, verifyLocalLicense, LICENSE_SERVER_URL } = require('../lib/license-manager');
const { checkDependencyStatus, downloadAndExtract } = require('../lib/dependency-downloader');
const FacebookApiService = require('../lib/facebookApi');

let electronShell = null;
try {
  const electron = require('electron');
  electronShell = electron.shell;
} catch (e) {}

let modelDownloadStatus = { downloading: false, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };
let whisperDownloadStatus = {};
let activeDependencyDownload = null;

module.exports = {
  getVideoInfo: async (req, res) => {
    try {
      let { url } = req.body;
      url = shared.extractUrl(url);
      if (!url) {
        return res.status(400).json({ error: 'Vui lòng nhập URL video' });
      }

      if (!shared.isValidVideoUrl(url)) {
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
          return f.vcodec && f.vcodec !== 'none' && f.height;
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

  getCookieStatus: async (req, res) => {
    try {
      if (fs.existsSync(shared.COOKIES_PATH)) {
        const stats = fs.statSync(shared.COOKIES_PATH);
        return res.json({ exists: true, lastModified: stats.mtime });
      }
      return res.json({ exists: false });
    } catch (error) {
      console.error('Lỗi kiểm tra cookie:', error.message);
      res.status(500).json({ error: 'Lỗi kiểm tra cookie' });
    }
  },

  saveCookie: async (req, res) => {
    try {
      const { cookieText } = req.body;
      if (!cookieText || cookieText.trim() === '') {
        return res.status(400).json({ error: 'Nội dung cookie trống' });
      }
      fs.writeFileSync(shared.COOKIES_PATH, cookieText, 'utf8');
      res.json({ success: true });
    } catch (error) {
      console.error('Lỗi lưu cookie:', error.message);
      res.status(500).json({ error: 'Lỗi ghi file cookie: ' + error.message });
    }
  },

  clearCookie: async (req, res) => {
    try {
      if (fs.existsSync(shared.COOKIES_PATH)) {
        fs.unlinkSync(shared.COOKIES_PATH);
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Lỗi xóa cookie:', error.message);
      res.status(500).json({ error: 'Lỗi xóa file cookie: ' + error.message });
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
    let command = '';
    switch (process.platform) { 
      case 'win32': command = `explorer "${shared.DOWNLOADS_DIR}"`; break;
      case 'darwin': command = `open "${shared.DOWNLOADS_DIR}"`; break;
      default: command = `xdg-open "${shared.DOWNLOADS_DIR}"`; break;
    }
    child_process.exec(command);
    res.json({ success: true });
  },

  openFileFolder: async (req, res) => {
    try {
      const { filename } = req.query;
      if (!filename) {
        return res.status(400).json({ error: 'Thiếu tên file' });
      }

      let fullPath = path.join(shared.DOWNLOADS_DIR, filename);
      if (!fs.existsSync(fullPath)) {
        fullPath = path.join(shared.RENDERS_DIR, filename);
      }
      if (!fs.existsSync(fullPath)) {
        const homeDir = os.homedir();
        fullPath = path.join(homeDir, 'Downloads', filename);
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

        let command = '';
        switch (process.platform) {
          case 'win32':
            command = `explorer.exe /select,"${fullPath}"`;
            break;
          case 'darwin':
            command = `open -R "${fullPath}"`;
            break;
          default:
            command = `xdg-open "${path.dirname(fullPath)}"`;
            break;
        }
        child_process.exec(command);
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
        let command = '';
        switch (process.platform) { 
          case 'win32': command = `explorer "${shared.DOWNLOADS_DIR}"`; break;
          case 'darwin': command = `open "${shared.DOWNLOADS_DIR}"`; break;
          default: command = `xdg-open "${shared.DOWNLOADS_DIR}"`; break;
        }
        child_process.exec(command);
        return res.json({ success: true });
      }
    } catch (error) {
      console.error('Open file folder error:', error.message);
      res.status(500).json({ error: 'Lỗi mở thư mục' });
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
    const whisperCliOk = fs.existsSync(shared.TOOLS_DIR + '/whisper_onnx.exe');

    const whisperModels = ['base', 'tiny', 'small', 'medium', 'large-v3'];
    const downloadedWhisperModels = whisperModels.filter(model => 
      fs.existsSync(path.join(shared.MODELS_DIR, 'whisper', model, 'model.bin'))
    );
    const whisperModelOk = downloadedWhisperModels.length > 0;

    const omnivoiceCliOk = fs.existsSync(shared.OMNIVOICE_CLI_PATH);
    const omnivoiceModelOk = fs.existsSync(shared.OMNIVOICE_MODEL_PATH);

    res.json({
      ffmpeg: ffmpegOk,
      ytdlp: ytdlpOk,
      whisper: whisperCliOk && whisperModelOk,
      whisperCli: whisperCliOk,
      whisperModel: whisperModelOk,
      downloadedWhisperModels: downloadedWhisperModels,
      omnivoice: omnivoiceCliOk && omnivoiceModelOk,
      omnivoiceCli: omnivoiceCliOk,
      omnivoiceModel: omnivoiceModelOk
    });
  },

  checkDependenciesStatus: async (req, res) => {
    try {
      const status = checkDependencyStatus(shared.TOOLS_DIR);
      res.json(status);
    } catch (error) {
      console.error('Check dependency status error:', error.message);
      res.status(500).json({ error: 'Không thể kiểm tra trạng thái thư viện' });
    }
  },

  downloadDependency: async (req, res) => {
    const { type } = req.body;
    if (!['cuda', 'whisper'].includes(type)) {
      return res.status(400).json({ error: 'Loại thư viện không hợp lệ' });
    }

    if (activeDependencyDownload) {
      return res.status(400).json({ error: 'Đang có tiến trình tải xuống chạy ngầm khác' });
    }

    activeDependencyDownload = { type, percent: 0, status: 'downloading' };
    res.json({ message: 'Bắt đầu tải xuống ngầm' });

    try {
      console.log(`[Dependency Downloader] Bắt đầu tải ${type} vào ${shared.TOOLS_DIR}...`);
      await downloadAndExtract(type, shared.TOOLS_DIR, (downloaded, total) => {
        if (activeDependencyDownload) {
          activeDependencyDownload.percent = Math.floor((downloaded / (total || 1)) * 100);
        }
      });
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
    const model = req.query.model || 'base';
    if (model === 'base') {
      return res.json({ exists: true, downloading: false, percent: 100 });
    }

    const { WHISPER_MODELS_CONFIG } = require('../lib/model-downloader');
    const modelConfig = WHISPER_MODELS_CONFIG[model];
    let exists = false;

    if (modelConfig) {
      const whisperDir = path.join(shared.MODELS_DIR, 'whisper', model);
      exists = modelConfig.files.every(file => {
        const filePath = path.join(whisperDir, file.name);
        return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
      });
    } else {
      const modelPath = path.join(shared.MODELS_DIR, 'whisper', model, 'model.bin');
      exists = fs.existsSync(modelPath);
    }
    
    const status = whisperDownloadStatus[model] || { downloading: false, percent: 0, error: null };
    res.json({
      exists: exists,
      downloading: status.downloading,
      percent: status.percent,
      error: status.error,
      downloadedBytes: status.downloadedBytes,
      totalBytes: status.totalBytes
    });
  },

  downloadWhisperModel: async (req, res) => {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: 'Thiếu tham số model' });

    if (whisperDownloadStatus[model] && whisperDownloadStatus[model].downloading) {
      return res.json({ success: true, message: 'Đang tải rồi' });
    }
    const { ensureWhisperModelExist } = require('../lib/model-downloader');
    whisperDownloadStatus[model] = { downloading: true, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };
    res.json({ success: true, message: 'Bắt đầu tải model Whisper' });

    try {
      await ensureWhisperModelExist(shared.MODELS_DIR, model, (progress) => {
        whisperDownloadStatus[model].percent = progress.percent;
        whisperDownloadStatus[model].downloadedBytes = progress.downloadedBytes;
        whisperDownloadStatus[model].totalBytes = progress.totalBytes;
      });
      whisperDownloadStatus[model].downloading = false;
      whisperDownloadStatus[model].percent = 100;
    } catch (err) {
      console.error(`Lỗi tải model Whisper ${model} qua API:`, err.message);
      whisperDownloadStatus[model].downloading = false;
      whisperDownloadStatus[model].error = err.message;
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
