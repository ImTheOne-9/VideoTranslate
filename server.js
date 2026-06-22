const express = require('express');
const path = require('path');
const child_process = require('child_process');
const fs = require('fs');
const contentDisposition = require('content-disposition');
const multer = require('multer');
const { translateSubtitles, formatSubtitleFile, srtTimeToMs, msToSrtTime } = require('./lib/translate-sub');
const os = require('os');
const net = require('net');

const axios = require('axios');

// Tích hợp Electron shell API nếu chạy trong Electron
let electronShell = null;
try {
  const electron = require('electron');
  electronShell = electron.shell;
} catch (e) {
  // Không chạy trong Electron
}

const isPackaged = __dirname.includes('app.asar');

// Helper phân giải đường dẫn tài nguyên ngoài (extraResources)
function getExtPath(...parts) {
  const base = isPackaged ? process.resourcesPath : __dirname;
  return path.join(base, ...parts);
}

// Thiết lập thư mục lưu trữ dữ liệu (downloads, uploads)
let DOWNLOADS_DIR, UPLOADS_DIR;
if (isPackaged) {
  // Bản đóng gói: lưu ở %USERPROFILE%/VideoStudio
  const appDataRoot = path.join(os.homedir(), 'VideoStudio');
  DOWNLOADS_DIR = path.join(appDataRoot, 'downloads');
  UPLOADS_DIR = path.join(appDataRoot, 'uploads');
} else {
  // Bản phát triển: lưu tại chỗ
  DOWNLOADS_DIR = path.join(__dirname, 'downloads');
  UPLOADS_DIR = path.join(__dirname, 'uploads');
}

const VOICES_DIR = path.join(UPLOADS_DIR, 'voices');
const MUSIC_DIR = path.join(UPLOADS_DIR, 'music');
const SUBTITLES_DIR = path.join(UPLOADS_DIR, 'subtitles');
const TMP_UPLOADS_DIR = path.join(UPLOADS_DIR, 'tmp');
const RENDERS_DIR = path.join(DOWNLOADS_DIR, 'renders');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
for (const dir of [VOICES_DIR, MUSIC_DIR, SUBTITLES_DIR, TMP_UPLOADS_DIR, RENDERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Quản lý và dọn dẹp các tiến trình con tập trung
const activeProcesses = new Set();

function registerChildProcess(proc) {
  if (!proc) return;
  activeProcesses.add(proc);
  
  const cleanUp = () => {
    activeProcesses.delete(proc);
  };
  
  proc.on('close', cleanUp);
  proc.on('exit', cleanUp);
  proc.on('error', cleanUp);
}
global.registerChildProcess = registerChildProcess;

function killAllActiveProcesses() {
  console.log(`Bắt đầu tắt toàn bộ tiến trình con đang hoạt động (${activeProcesses.size})...`);
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGKILL');
      console.log(`Đã kill tiến trình PID: ${proc.pid}`);
    } catch (e) {
      console.error(`Không thể kill tiến trình PID ${proc.pid || 'unknown'}:`, e.message);
    }
  }
  activeProcesses.clear();
}

// Wrapper bọc spawn và execFile để tự động đăng ký dọn dẹp
function spawn(command, args, options) {
  const proc = child_process.spawn(command, args, options);
  registerChildProcess(proc);
  return proc;
}

function execFile(file, args, options, callback) {
  let actualOptions = options;
  let actualCallback = callback;
  if (typeof options === 'function') {
    actualCallback = options;
    actualOptions = {};
  }
  const proc = child_process.execFile(file, args, actualOptions, actualCallback);
  registerChildProcess(proc);
  return proc;
}

const { exec } = child_process;

const app = express();
const PORT = 3456; // Khai báo tạm để tương thích ngược nếu cần

const upload = multer({ dest: UPLOADS_DIR });
const studioUpload = multer({ dest: TMP_UPLOADS_DIR });

const FFMPEG_PATH = getExtPath('tools', 'ffmpeg.exe');
const YTDLP_PATH = getExtPath('tools', 'yt-dlp.exe');
const OMNIVOICE_CLI_PATH = process.env.OMNIVOICE_CLI_PATH || getExtPath('tools', 'omnivoice', 'omnivoice-cli.exe');

const isPackagedServer = __dirname.includes('app.asar');
const appDataRoot = isPackagedServer ? path.join(require('os').homedir(), 'VideoStudio') : __dirname;
const MODELS_DIR = path.join(appDataRoot, 'models');
const OMNIVOICE_MODEL_PATH = process.env.OMNIVOICE_MODEL_PATH || path.join(MODELS_DIR, 'omnivoice-q8_0.gguf');

// Tự động tìm kiếm và thêm đường dẫn CUDA vào PATH trên Windows để tránh lỗi thiếu DLL khi chạy OmniVoice
if (process.platform === 'win32') {
  const cudaRoot = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
  if (fs.existsSync(cudaRoot)) {
    try {
      const versions = fs.readdirSync(cudaRoot);
      versions.forEach(ver => {
        const binX64 = path.join(cudaRoot, ver, 'bin', 'x64');
        const binBase = path.join(cudaRoot, ver, 'bin');
        if (fs.existsSync(binX64)) {
          process.env.PATH = `${binX64};${binBase};${process.env.PATH || ''}`;
          console.log(`[CUDA] Đã tự động thêm đường dẫn DLL vào PATH: ${binX64}`);
        }
      });
    } catch (e) {
      console.error('[CUDA] Lỗi quét thư mục CUDA:', e.message);
    }
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(RENDERS_DIR));
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use('/voices', express.static(VOICES_DIR));
app.use('/music', express.static(MUSIC_DIR));

// Helper: Run yt-dlp command and get JSON output
function runYtDlp(args, retryCount = 0) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const errStr = stderr || error.message || '';
        console.error('yt-dlp stderr:', errStr);
        
        // Auto-retry for TikTok rehydration errors
        if (errStr.includes('Unable to extract universal data for rehydration') && retryCount < 2) {
          console.log(`[Retry ${retryCount + 1}] Retrying yt-dlp due to TikTok API block...`);
          
          // Swap API hostnames in args
          const newArgs = [...args];
          for (let i = 0; i < newArgs.length; i++) {
            if (newArgs[i].includes('tiktok:api_hostname')) {
              // Rotate endpoints and valid app_infos
              const endpoints = [
                'api16-normal-c-useast1a.tiktokv.com',
                'api16-core-c-useast1a.tiktokv.com',
                'api22-normal-c-alisg.tiktokv.com',
                'api19-normal-c-useast1a.tiktokv.com'
              ];
              const validAppInfos = [
                '7355_1.1.1-7355_0',
                '1988_1.1.1-1988_0',
                '1180_1.1.1-1180_0'
              ];
              const randomEndpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
              const randomAppInfo = validAppInfos[Math.floor(Math.random() * validAppInfos.length)];
              newArgs[i] = `tiktok:api_hostname=${randomEndpoint};app_info=${randomAppInfo}`;
            }
          }
          
          // Wait 1.5 seconds before retry
          setTimeout(() => {
            runYtDlp(newArgs, retryCount + 1).then(resolve).catch(reject);
          }, 1500);
          return;
        }

        reject(new Error(errStr));
        return;
      }
      resolve(stdout);
    });
  });
}

function extractUrl(text) {
  if (!text) return '';
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : text;
}

function cleanVideoTitle(title) {
  if (!title) return 'Untitled';
  let cleaned = title;
  
  // Xóa phần thống kê ở đầu của Facebook (ví dụ: "28K views · 319 reactions | ")
  cleaned = cleaned.replace(/^[\d\.,KMBkmb\s·]+(views|reactions|likes|shares|comments).*?\|\s*/i, '');
  
  // Xóa phần tên page ở cuối (ví dụ: " | Lò Văn Vở" - thường phía sau dấu | cuối cùng)
  const parts = cleaned.split(' | ');
  if (parts.length > 1) {
    const lastPart = parts[parts.length - 1];
    // Tên page/kênh thường ngắn (dưới 40 ký tự)
    if (lastPart.length < 40) {
      parts.pop();
      cleaned = parts.join(' | ');
    }
  }
  
  return cleaned.trim() || 'Untitled';
}

// Validate Video URL
function isValidVideoUrl(url) {
  const cleanUrl = extractUrl(url);
  return /^https?:\/\/(www\.|vt\.|vm\.)?(youtube\.com\/(shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/|facebook\.com\/|fb\.watch\/|fb\.com\/|tiktok\.com\/)/.test(cleanUrl);
}

function safeFileName(name) {
  return (name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
}

function getUniqueFilePath(targetDir, baseName, ext) {
  let counter = 0;
  let finalName = `${baseName}${ext}`;
  let finalPath = path.join(targetDir, finalName);
  while (fs.existsSync(finalPath)) {
    counter++;
    finalName = `${baseName}_${counter}${ext}`;
    finalPath = path.join(targetDir, finalName);
  }
  return finalPath;
}

function moveUploadedFile(file, targetDir, preferredName) {
  if (!file) return null;
  const ext = path.extname(preferredName || '') || path.extname(file.originalname || '') || '.bin';
  const rawBase = preferredName 
    ? path.basename(preferredName, ext) 
    : path.basename(file.originalname || `asset_${Date.now()}`, ext);
  const base = safeFileName(rawBase);
  
  let finalPath;
  if (preferredName) {
    finalPath = getUniqueFilePath(targetDir, base, ext);
  } else {
    const finalName = `${Date.now()}_${base}${ext}`;
    finalPath = path.join(targetDir, finalName);
  }
  
  fs.renameSync(file.path, finalPath);
  return finalPath;
}

function listFiles(dir, exts) {
  try {
    return fs.readdirSync(dir)
      .filter(name => exts.includes(path.extname(name).toLowerCase()))
      .map(name => {
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        return {
          filename: name,
          size: stat.size,
          modified: stat.mtime
        };
      })
      .filter(file => file.size > 0)
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
  } catch (e) {
    return [];
  }
}

function resolveAssetPath(kind, filename) {
  const roots = {
    video: DOWNLOADS_DIR,
    voice: VOICES_DIR,
    music: MUSIC_DIR,
    subtitle: SUBTITLES_DIR
  };
  const root = roots[kind];
  if (!root || !filename) return null;
  const resolved = path.resolve(root, filename);
  if (!resolved.startsWith(path.resolve(root))) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

function getVideoDimensions(videoPath) {
  return new Promise((resolve) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      return resolve({ width: 1280, height: 720 });
    }
    execFile(FFMPEG_PATH, ['-i', videoPath], (err, stdout, stderr) => {
      const output = stderr || '';
      const match = output.match(/Stream #.*Video:.*, (\d+)x(\d+)/);
      if (match) {
        resolve({
          width: parseInt(match[1], 10),
          height: parseInt(match[2], 10)
        });
      } else {
        resolve({ width: 1280, height: 720 });
      }
    });
  });
}

function convertSrtToAss(srtPath, assPath, options) {
  const Parser = require('srt-parser-2').default;
  const parser = new Parser();
  const srtContent = fs.readFileSync(srtPath, 'utf8');
  const srtArray = parser.fromSrt(srtContent);

  function convertSrtTime(srtTime) {
    const parts = srtTime.split(':');
    if (parts.length < 3) return "0:00:00.00";
    const hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    const secParts = parts[2].split(',');
    const seconds = secParts[0];
    const ms = secParts[1] || '000';
    const cs = ms.substring(0, 2);
    return `${hours}:${minutes}:${seconds}.${cs}`;
  }

  const {
    videoWidth,
    videoHeight,
    fontName,
    fontSize,
    assColor,
    isBold,
    borderStyle,
    outline,
    shadow,
    outlineColor,
    backColor,
    alignment,
    marginV,
    marginH
  } = options;

  const assLines = [];
  assLines.push('[Script Info]');
  assLines.push('ScriptType: v4.00+');
  assLines.push(`PlayResX: ${videoWidth}`);
  assLines.push(`PlayResY: ${videoHeight}`);
  assLines.push('WrapStyle: 0');
  assLines.push('');
  assLines.push('[V4+ Styles]');
  assLines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, Strikeout, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  assLines.push(`Style: Default,${fontName},${fontSize},${assColor},&H000000FF,${outlineColor},${backColor},${isBold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1`);
  assLines.push('');
  assLines.push('[Events]');
  assLines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  for (const item of srtArray) {
    const start = convertSrtTime(item.startTime);
    const end = convertSrtTime(item.endTime);
    const text = item.text.replace(/\n/g, '\\N');
    assLines.push(`Dialogue: 0,${start},${end},Default,,${marginH},${marginH},${marginV},,${text}`);
  }

  fs.writeFileSync(assPath, assLines.join('\n'), 'utf8');
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function escapeSubtitleForFilter(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function hexToAssColor(hexStr) {
  if (!hexStr || !hexStr.startsWith('#')) return '&H00FFFFFF';
  const cleanHex = hexStr.replace('#', '');
  if (cleanHex.length !== 6) return '&H00FFFFFF';
  const rr = cleanHex.substring(0, 2);
  const gg = cleanHex.substring(2, 4);
  const bb = cleanHex.substring(4, 6);
  return `&H00${bb}${gg}${rr}`;
}

function createWavHeader(dataLength, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  
  // "RIFF"
  header.write('RIFF', 0);
  // file size - 8
  header.writeUInt32LE(dataLength + 36, 4);
  // "WAVE"
  header.write('WAVE', 8);
  // "fmt "
  header.write('fmt ', 12);
  // chunk size (16 for PCM)
  header.writeUInt32LE(16, 16);
  // audio format (1 for PCM)
  header.writeUInt16LE(1, 20);
  // num channels
  header.writeUInt16LE(numChannels, 22);
  // sample rate
  header.writeUInt32LE(sampleRate, 24);
  // byte rate (sampleRate * numChannels * bitsPerSample / 8)
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  // block align (numChannels * bitsPerSample / 8)
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  // bits per sample
  header.writeUInt16LE(bitsPerSample, 34);
  // "data"
  header.write('data', 36);
  // chunk size
  header.writeUInt32LE(dataLength, 40);
  
  return header;
}

// API: Get video info
app.post('/api/info', async (req, res) => {
  try {
    let { url } = req.body;
    url = extractUrl(url);
    if (!url) {
      return res.status(400).json({ error: 'Vui lòng nhập URL video' });
    }

    if (!isValidVideoUrl(url)) {
      return res.status(400).json({ error: 'URL không hợp lệ' });
    }

    // Get video info as JSON using yt-dlp
    const ytArgs = [
      '--dump-json',
      '--no-warnings',
      '--no-playlist'
    ];
    if (url.includes('tiktok.com')) ytArgs.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');
    ytArgs.push(url);

    const output = await runYtDlp(ytArgs);

    const info = JSON.parse(output);

    // Extract formats - only mp4 with video
    const formats = (info.formats || [])
      .filter(f => {
        // Only mp4 container with video
        return f.ext === 'mp4' && f.vcodec && f.vcodec !== 'none' && f.height;
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
        // We will merge everything with audio, so everything "has audio" from the user's perspective
        hasAudio: true, 
        container: 'mp4',
        format_note: f.format_note || '',
      }))
      // Remove duplicates by quality
      .reduce((acc, f) => {
        const key = `${f.quality}-${f.fps}`;
        if (!acc.map.has(key)) {
          acc.map.set(key, true);
          acc.list.push(f);
        }
        return acc;
      }, { map: new Map(), list: [] }).list
      // Sort: height desc
      .sort((a, b) => {
        if (a.height !== b.height) return b.height - a.height;
        return b.fps - a.fps;
      });

    // Get best thumbnail
    const thumbnail = info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : '');
    
    // Get author properly
    const author = info.uploader || info.channel || info.uploader_id || (info.extractor === 'XiaoHongShu' ? 'Xiaohongshu User' : 'Unknown');

    res.json({
      title: cleanVideoTitle(info.title),
      thumbnail,
      duration: info.duration || 0,
      author,
      viewCount: info.view_count || 0,
      formats,
    });
  } catch (error) {
    console.error('Error getting info:', error.message);
    res.status(500).json({ error: 'Không thể lấy thông tin video. Vui lòng thử lại.' });
  }
});

// API: Download video
app.get('/api/download', async (req, res) => {
  try {
    let { url, format_id } = req.query;
    url = extractUrl(url);
    if (!url) {
      return res.status(400).json({ error: 'Thiếu URL' });
    }

    if (!isValidVideoUrl(url)) {
      return res.status(400).json({ error: 'URL không hợp lệ' });
    }

    // Get video title first
    const ytInfoArgs = [
      '--dump-json',
      '--no-warnings',
      '--no-playlist'
    ];
    if (url.includes('tiktok.com')) ytInfoArgs.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');
    ytInfoArgs.push(url);

    const infoOutput = await runYtDlp(ytInfoArgs);
    const info = JSON.parse(infoOutput);
    const safeTitle = cleanVideoTitle(info.title).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);

    const tempFileName = `temp-${Date.now()}-${Math.floor(Math.random()*1000)}.mp4`;
    const tempFilePath = path.join(DOWNLOADS_DIR, tempFileName);

    // Build yt-dlp args for download
    const args = [
      '--no-warnings',
      '--no-playlist',
      '-o', tempFilePath,
    ];
    if (url.includes('tiktok.com')) args.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');

    if (fs.existsSync(FFMPEG_PATH)) {
      args.push('--ffmpeg-location', FFMPEG_PATH);
    }

    if (format_id) {
      // Check if format has audio in the original data
      const selectedFormat = (info.formats || []).find(f => f.format_id === format_id);
      if (selectedFormat && selectedFormat.acodec === 'none') {
        // Video-only format: merge with best audio
        args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}+bestaudio/best`);
        args.push('--merge-output-format', 'mp4');
      } else {
        // If it already has audio or we can't find it, just download it
        args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}/best`);
        args.push('--merge-output-format', 'mp4');
      }
    } else {
      // Default: best quality with audio
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
      args.push('--merge-output-format', 'mp4');
    }

    args.push(url);

    console.log('Downloading with args:', args.join(' '));

    try {
      await runYtDlp(args);
      if (fs.existsSync(tempFilePath)) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}.mp4`));
        
        const stream = fs.createReadStream(tempFilePath);
        stream.pipe(res);
        
        stream.on('end', () => {
          try { fs.unlinkSync(tempFilePath); } catch (e) {}
        });
      } else {
        res.status(500).json({ error: 'Quá trình tải video thất bại' });
      }
    } catch (err) {
      console.error('yt-dlp download error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Không thể tải video' });
      }
    }

  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể tải video. Vui lòng thử lại.' });
    }
  }
});

// API: Download video with hardcoded Vietnamese subtitles
app.get('/api/download-vi', async (req, res) => {
  try {
    let { url, geminiApiKey } = req.query;
    url = extractUrl(url);
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });
    if (!isValidVideoUrl(url)) return res.status(400).json({ error: 'URL không hợp lệ' });

    console.log('Bắt đầu tải video kèm Vietsub:', url);

    // Get video title and ID
    const ytInfoArgs = ['--dump-json', '--no-warnings', '--no-playlist'];
    if (url.includes('tiktok.com')) ytInfoArgs.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');
    ytInfoArgs.push(url);
    const infoOutput = await runYtDlp(ytInfoArgs);
    const info = JSON.parse(infoOutput);
    const safeTitle = cleanVideoTitle(info.title).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    const videoId = info.id || Date.now();

    const tempDir = path.join(DOWNLOADS_DIR, `temp_${videoId}_${Math.floor(Math.random() * 1000)}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const videoPathPattern = path.join(tempDir, `video.%(ext)s`);
    const subPathPattern = path.join(tempDir, `sub.%(ext)s`);
    const finalVideoPath = path.join(tempDir, `final.mp4`);
    const translatedSubPath = path.join(tempDir, `translated.srt`);

    // 1. Download video
    const videoArgs = ['--no-warnings', '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', videoPathPattern];
    if (url.includes('tiktok.com')) videoArgs.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');
    videoArgs.push(url);
    if (fs.existsSync(FFMPEG_PATH)) videoArgs.push('--ffmpeg-location', FFMPEG_PATH);
    
    await runYtDlp(videoArgs);

    // Find actual video path
    const files = fs.readdirSync(tempDir);
    const videoFile = files.find(f => f.startsWith('video.'));
    if (!videoFile) throw new Error('Không tìm thấy video đã tải');
    const actualVideoPath = path.join(tempDir, videoFile);

    // 2. Download subtitles
    const subArgs = ['--write-auto-subs', '--write-subs', '--convert-subs', 'srt', '--skip-download', '-o', subPathPattern, url];
    try { await runYtDlp(subArgs); } catch (e) {}

    const updatedFiles = fs.readdirSync(tempDir);
    let subFile = updatedFiles.find(f => f.startsWith('sub.') && f.endsWith('.srt'));
    let actualSubPath = subFile ? path.join(tempDir, subFile) : null;

    if (!actualSubPath) {
      console.log('Không có phụ đề rời, khởi chạy Whisper Audio-to-Text...');
      const { extractAudioAndTranscribe } = require('./lib/whisper-helper');
      actualSubPath = await extractAudioAndTranscribe(actualVideoPath, tempDir, FFMPEG_PATH);
    }

    // 3. Translate subtitles and burn
    if (actualSubPath) {
      console.log('Tìm thấy phụ đề, tiến hành dịch:', actualSubPath);
      const downloadMaxLines = Number(req.query.subtitleMaxLines || 0);
      const downloadFontSize = Math.round(Number(req.query.subtitleSize || 18) * 1.35);
      const downloadMarginH = Number(req.query.subtitleMarginH || 20);
      const downloadWidth = 1080;
      const downloadBoxWidth = downloadWidth - 2 * downloadMarginH;
      const downloadMaxChars = Math.max(10, Math.floor(downloadBoxWidth / (downloadFontSize * 0.5)));
      await translateSubtitles(actualSubPath, translatedSubPath, geminiApiKey, downloadMaxLines, downloadMaxChars);

      let hasSubtitles = false;
      try {
        if (fs.existsSync(translatedSubPath)) {
          const content = fs.readFileSync(translatedSubPath, 'utf8').trim();
          if (content.length > 0) {
            hasSubtitles = true;
          }
        }
      } catch (e) {}

      if (hasSubtitles) {
        // Escape path for FFmpeg filter (windows paths need double backslashes escaping)
        const escapedSubPath = translatedSubPath.replace(/\\/g, '/').replace(/:/g, '\\:');

        // Burn sub: Background black, Text White, border style 3 is opaque box.
        const ffmpegArgs = [
          '-i', actualVideoPath,
          '-vf', `subtitles='${escapedSubPath}':force_style='BorderStyle=3,BackColour=&H80000000,MarginV=20,Fontsize=18,WrapStyle=0'`,
          '-c:a', 'copy',
          '-y', finalVideoPath
        ];

        console.log('Đang hardcode phụ đề...');
        await new Promise((resolve, reject) => {
          execFile(FFMPEG_PATH, ffmpegArgs, (err, stdout, stderr) => {
            if (err) reject(new Error('Lỗi chèn phụ đề: ' + stderr));
            else resolve();
          });
        });
      } else {
        console.log('Phụ đề trống, sử dụng video gốc.');
        fs.copyFileSync(actualVideoPath, finalVideoPath);
      }
    } else {
      console.log('Không tìm thấy phụ đề, sử dụng video gốc.');
      fs.copyFileSync(actualVideoPath, finalVideoPath);
    }

    // 4. Send to client
    if (fs.existsSync(finalVideoPath)) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}_Vietsub.mp4`));
      const stream = fs.createReadStream(finalVideoPath);
      stream.pipe(res);
      stream.on('end', () => {
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (e) {
          console.error('Lỗi khi xóa tempDir (stream end):', e.message);
        }
      });
    } else {
      throw new Error('Lỗi xuất video cuối');
    }

    req.on('close', () => {
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (e) {
        console.error('Lỗi khi xóa tempDir (req close):', e.message);
      }
    });
  } catch (error) {
    console.error('Download Vietsub error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể tải video kèm Vietsub. Vui lòng thử lại.' });
    }
  }
});

// API: Get playlist info
app.post('/api/playlist', async (req, res) => {
  try {
    let { url, limit } = req.body;
    url = extractUrl(url);
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });
    if (!limit || limit <= 0) return res.status(400).json({ error: 'Số lượng không hợp lệ' });

    // yt-dlp --dump-json --flat-playlist --playlist-end <limit> <url>
    const ytListArgs = [
      '--dump-json',
      '--flat-playlist',
      '--playlist-end', limit.toString(),
      '--no-warnings'
    ];
    if (url.includes('tiktok.com')) ytListArgs.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');
    ytListArgs.push(url);

    const output = await runYtDlp(ytListArgs);

    // output contains multiple json objects separated by newline
    const lines = output.trim().split('\n');
    const videos = lines.map(line => {
      try {
        const item = JSON.parse(line);
        return {
          id: item.id,
          title: item.title,
          url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
          duration: item.duration
        };
      } catch(e) {
        return null;
      }
    }).filter(v => v);

    res.json({ videos });
  } catch (error) {
    console.error('Playlist error:', error.message);
    res.status(500).json({ error: 'Không thể lấy thông tin kênh/playlist.' });
  }
});

// API: Download locally
app.post('/api/download-local', async (req, res) => {
  try {
    let { url } = req.body;
    url = extractUrl(url);
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    const args = [
      '--no-warnings',
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s'),
    ];
    if (url.includes('tiktok.com')) args.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');

    if (fs.existsSync(FFMPEG_PATH)) {
      args.push('--ffmpeg-location', FFMPEG_PATH);
    }

    args.push(url);

    execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp local stderr:', stderr);
        return res.status(500).json({ error: 'Lỗi tải video' });
      }
      res.json({ success: true, message: 'Đã tải thành công' });
    });

  } catch (error) {
    console.error('Download local error:', error.message);
    res.status(500).json({ error: 'Lỗi tải video' });
  }
});

// API: Open folder
app.get('/api/open-folder', async (req, res) => {
  if (electronShell) {
    try {
      await electronShell.openPath(DOWNLOADS_DIR);
      return res.json({ success: true });
    } catch (err) {
      console.error('Lỗi khi mở thư mục bằng Electron shell:', err.message);
    }
  }
  let command = '';
  switch (process.platform) { 
    case 'win32': command = `explorer "${DOWNLOADS_DIR}"`; break;
    case 'darwin': command = `open "${DOWNLOADS_DIR}"`; break;
    default: command = `xdg-open "${DOWNLOADS_DIR}"`; break;
  }
  child_process.exec(command);
  res.json({ success: true });
});

// API: Đăng video lên Facebook và bình luận
const FacebookApiService = require('./lib/facebookApi');

app.post('/api/publish-facebook', async (req, res) => {
  try {
    const { videoPath, description, comment, pageId, pageToken } = req.body;
    
    // videoPath từ frontend gửi lên thường chỉ là tên file hoặc url tương đối
    // Cần nối với RENDERS_DIR để ra đường dẫn thật
    const actualVideoPath = path.join(RENDERS_DIR, path.basename(videoPath));

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
});

// API: Xác thực Fanpage Facebook
app.post('/api/verify-facebook-page', async (req, res) => {
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
});

// API: Xóa video đã render
app.delete('/api/rendered-videos/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(RENDERS_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: 'Đã xóa video thành công!' });
    } else {
      return res.status(404).json({ error: 'Không tìm thấy file video' });
    }
  } catch (err) {
    console.error('Lỗi khi xóa video render:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Xóa giọng nói mẫu
app.delete('/api/voices/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(VOICES_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: 'Đã xóa giọng mẫu thành công!' });
    } else {
      return res.status(404).json({ error: 'Không tìm thấy file giọng mẫu' });
    }
  } catch (err) {
    console.error('Lỗi khi xóa giọng mẫu:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Xóa nhạc nền
app.delete('/api/music/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(MUSIC_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: 'Đã xóa nhạc nền thành công!' });
    } else {
      return res.status(404).json({ error: 'Không tìm thấy file nhạc nền' });
    }
  } catch (err) {
    console.error('Lỗi khi xóa nhạc nền:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// STUDIO APIs
// ==========================================

// List downloaded videos
app.get('/api/local-videos', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({
        filename: f,
        path: path.join(DOWNLOADS_DIR, f)
      }));
    res.json({ videos: files });
  } catch(e) {
    res.json({ videos: [] });
  }
});

// Render Reaction Video
app.post('/api/render-reaction', upload.single('reactionVideo'), (req, res) => {
  const { mainVideoFile, position } = req.body;
  const reactionFile = req.file;

  if (!mainVideoFile || !reactionFile) {
    return res.status(400).json({ error: 'Thiếu file video' });
  }

  const mainPath = path.join(DOWNLOADS_DIR, mainVideoFile);
  const outPath = path.join(DOWNLOADS_DIR, `reaction_${Date.now()}.mp4`);

  // Build ffmpeg filter complex for PIP
  // Default: bottom-right
  let overlayPos = 'main_w-overlay_w-20:main_h-overlay_h-20';
  if (position === 'bottom-left') overlayPos = '20:main_h-overlay_h-20';
  if (position === 'top-right') overlayPos = 'main_w-overlay_w-20:20';
  if (position === 'top-left') overlayPos = '20:20';

  // We scale the reaction video to width 320
  const filter = `[1:v]scale=320:-1[pip];[0:v][pip]overlay=${overlayPos}[v]`;

  const args = [
    '-i', mainPath,
    '-i', reactionFile.path,
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '0:a?', // Keep original audio
    '-c:v', 'libx264',
    '-c:a', 'copy',
    '-y', outPath
  ];

  console.log('Rendering Reaction with FFmpeg...');
  
  execFile(FFMPEG_PATH, args, (error, stdout, stderr) => {
    // Delete temp upload
    try { fs.unlinkSync(reactionFile.path); } catch(e){}

    if (error) {
      console.error('FFmpeg error:', stderr);
      return res.status(500).json({ error: 'Lỗi khi render video' });
    }
    res.json({ success: true, message: 'Tạo video thành công!', file: path.basename(outPath) });
  });
});

app.get('/api/studio-assets', (req, res) => {
  res.json({
    videos: listFiles(DOWNLOADS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
    renders: listFiles(RENDERS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
    voices: listFiles(VOICES_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg']),
    music: listFiles(MUSIC_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg']),
    subtitles: listFiles(SUBTITLES_DIR, ['.srt', '.vtt', '.ass']),
    omiConfigured: fs.existsSync(OMNIVOICE_CLI_PATH) && fs.existsSync(OMNIVOICE_MODEL_PATH),
    omnivoice: {
      cliExists: fs.existsSync(OMNIVOICE_CLI_PATH),
      modelExists: fs.existsSync(OMNIVOICE_MODEL_PATH),
      cliPath: OMNIVOICE_CLI_PATH,
      modelPath: OMNIVOICE_MODEL_PATH
    }
  });
});

let modelDownloadStatus = { downloading: false, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };

app.post('/api/download-model', async (req, res) => {
  if (modelDownloadStatus.downloading) {
    return res.json({ success: true, message: 'Đang tải rồi' });
  }

  const { ensureModelsExist } = require('./lib/model-downloader');
  
  modelDownloadStatus = { downloading: true, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };
  res.json({ success: true, message: 'Bắt đầu tải model' });

  try {
    await ensureModelsExist(MODELS_DIR, (progress) => {
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
});

app.get('/api/download-model/status', (req, res) => {
  const checkConfigured = fs.existsSync(OMNIVOICE_CLI_PATH) && fs.existsSync(OMNIVOICE_MODEL_PATH);
  res.json({
    ...modelDownloadStatus,
    omiConfigured: checkConfigured
  });
});

let whisperDownloadStatus = {};

app.get('/api/whisper-model/status', (req, res) => {
  const model = req.query.model || 'base';
  
  if (model === 'base') {
    return res.json({ exists: true, downloading: false, percent: 100 });
  }

  const modelPath = path.join(MODELS_DIR, 'whisper', model, 'model.bin');
  const exists = fs.existsSync(modelPath);
  
  const status = whisperDownloadStatus[model] || { downloading: false, percent: 0, error: null };
  res.json({
    exists: exists,
    downloading: status.downloading,
    percent: status.percent,
    error: status.error,
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.totalBytes
  });
});

app.post('/api/download-whisper-model', async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'Thiếu tham số model' });

  if (whisperDownloadStatus[model] && whisperDownloadStatus[model].downloading) {
    return res.json({ success: true, message: 'Đang tải rồi' });
  }

  const { ensureWhisperModelExist } = require('./lib/model-downloader');
  
  whisperDownloadStatus[model] = { downloading: true, percent: 0, error: null, downloadedBytes: 0, totalBytes: 0 };
  res.json({ success: true, message: 'Bắt đầu tải model Whisper' });

  try {
    await ensureWhisperModelExist(MODELS_DIR, model, (progress) => {
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
});

app.post('/api/save-voice', studioUpload.single('voice'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file giọng mẫu' });
    const savedPath = moveUploadedFile(req.file, VOICES_DIR, req.body.voiceName || req.file.originalname);
    res.json({
      success: true,
      message: 'Đã lưu giọng mẫu',
      voice: path.basename(savedPath)
    });
  } catch (error) {
    console.error('Save voice error:', error.message);
    res.status(500).json({ error: 'Không thể lưu giọng mẫu' });
  }
});

app.post('/api/save-music', studioUpload.single('music'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file nhạc nền' });
    const savedPath = moveUploadedFile(req.file, MUSIC_DIR, req.body.musicName || req.file.originalname);
    res.json({
      success: true,
      message: 'Đã lưu nhạc nền',
      music: path.basename(savedPath)
    });
  } catch (error) {
    console.error('Save music error:', error.message);
    res.status(500).json({ error: 'Không thể lưu nhạc nền' });
  }
});

app.post('/api/render-studio', studioUpload.fields([
  { name: 'videoUpload', maxCount: 1 },
  { name: 'subtitleUpload', maxCount: 1 },
  { name: 'voiceUpload', maxCount: 1 },
  { name: 'musicUpload', maxCount: 1 },
  { name: 'reactionUpload', maxCount: 1 }
]), async (req, res) => {
  const tempFiles = [];
  const voiceChunks = [];
  try {
    const body = req.body;
    const files = req.files || {};
    const timestamp = Date.now();
    const workDir = path.join(UPLOADS_DIR, `render_${timestamp}`);
    fs.mkdirSync(workDir, { recursive: true });

    let sourceVideo = null;
    if (files.videoUpload?.[0]) {
      sourceVideo = moveUploadedFile(files.videoUpload[0], workDir, 'source.mp4');
      tempFiles.push(sourceVideo);
    } else if (body.mainVideoFile) {
      sourceVideo = resolveAssetPath('video', body.mainVideoFile);
    }
    if (!sourceVideo) return res.status(400).json({ error: 'Thiếu video nguồn' });

    const dimensions = await getVideoDimensions(sourceVideo);
    const videoWidth = dimensions.width;
    const videoHeight = dimensions.height;
    console.log(`[Studio Render] Kích thước video nguồn: ${videoWidth}x${videoHeight}`);

    let reactionVideoPath = null;
    const reactionMode = body.reactionMode || 'none';
    if (reactionMode === 'upload' && files.reactionUpload?.[0]) {
      reactionVideoPath = moveUploadedFile(files.reactionUpload[0], workDir, 'reaction.mp4');
      tempFiles.push(reactionVideoPath);
    } else if (reactionMode === 'library' && body.savedReactionFile) {
      reactionVideoPath = resolveAssetPath('video', body.savedReactionFile);
    }

    let subtitlePath = null;
    const subtitleMode = body.subtitleMode || 'none';
    if (subtitleMode === 'upload' && files.subtitleUpload?.[0]) {
      subtitlePath = moveUploadedFile(files.subtitleUpload[0], SUBTITLES_DIR, files.subtitleUpload[0].originalname);
    } else if (subtitleMode === 'saved') {
      subtitlePath = resolveAssetPath('subtitle', body.savedSubtitleFile);
    } else if (subtitleMode === 'generate') {
      const { extractAudioAndTranscribe } = require('./lib/whisper-helper');
      subtitlePath = await extractAudioAndTranscribe(sourceVideo, workDir, FFMPEG_PATH, body.whisperModel || 'base');
    }

    let originalIsChinese = false;
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const originalSubContent = fs.readFileSync(subtitlePath, 'utf8');
      if (/[\u4e00-\u9fa5]/.test(originalSubContent)) {
        originalIsChinese = true;
        console.log('[Auto-Detect] Phát hiện video nguồn có phụ đề tiếng Trung.');
      }
    }

    const scaleFactor = 1.35;
    const studioFontSize = Math.round(Number(body.subtitleSize || 18) * scaleFactor);
    const studioMarginH = Number(body.subtitleMarginH || 20);
    const studioBoxWidth = videoWidth - 2 * studioMarginH;
    const studioMaxChars = Math.max(10, Math.floor(studioBoxWidth / (studioFontSize * 0.5)));

    if (subtitlePath && body.translateVi === 'true') {
      const translatedPath = path.join(workDir, `translated_${timestamp}.srt`);
      await translateSubtitles(subtitlePath, translatedPath, body.geminiApiKey, Number(body.subtitleMaxLines || 0), studioMaxChars);
      subtitlePath = translatedPath;
    } else if (subtitlePath && fs.existsSync(subtitlePath)) {
      // Định dạng phụ đề về 1-2 dòng ngay cả khi không dịch để khớp với lồng tiếng
      try {
        formatSubtitleFile(subtitlePath, Number(body.subtitleMaxLines || 0), studioMaxChars);
      } catch (err) {
        console.error('Lỗi định dạng phụ đề ban đầu:', err.message);
      }
    }

    let voicePath = null;
    const voiceMode = body.voiceMode || 'none';
    if (voiceMode === 'upload' && files.voiceUpload?.[0]) {
      voicePath = moveUploadedFile(files.voiceUpload[0], workDir, files.voiceUpload[0].originalname);
      tempFiles.push(voicePath);
    } else if (voiceMode === 'saved') {
      voicePath = resolveAssetPath('voice', body.savedVoiceFile);
    } else if (voiceMode === 'omi') {
      const refAudioPath = resolveAssetPath('voice', body.savedVoiceFile);
      let refText = (body.refText || '').trim();
      let omiScript = (body.omiScript || '').trim();

      if (!fs.existsSync(OMNIVOICE_CLI_PATH)) {
        return res.status(400).json({ error: `Thiếu omnivoice-cli.exe tại ${OMNIVOICE_CLI_PATH}` });
      }
      if (!fs.existsSync(OMNIVOICE_MODEL_PATH)) {
        return res.status(400).json({ error: `Thiếu model GGUF tại ${OMNIVOICE_MODEL_PATH}` });
      }

      let finalRefAudioPath = null;
      if (refAudioPath) {
        // Tự động trích xuất Ref-text từ giọng mẫu bằng Whisper nếu người dùng để trống
        if (!refText) {
          try {
            const { transcribeVoice } = require('./lib/whisper-helper');
            console.log('Đang tự động nhận diện câu thoại trong giọng mẫu...');
            refText = await transcribeVoice(refAudioPath, workDir, FFMPEG_PATH, body.whisperModel || 'base');
            console.log('Đã tự động trích xuất Ref-text:', refText);
          } catch (err) {
            console.error('Lỗi tự động nhận dạng giọng mẫu:', err.message);
            return res.status(400).json({ error: 'Không thể tự nhận diện giọng mẫu. Vui lòng nhập thủ công Ref-text.' });
          }
        }

        // Kiểm tra xem Ref-text có trống hay không để tránh lỗi OmniVoice
        if (!refText) {
          return res.status(400).json({ error: 'Không thể tự động nhận diện giọng mẫu (file quá nhiễu hoặc không có tiếng nói rõ ràng). Vui lòng nhập thủ công Ref-text hoặc chọn giọng mẫu khác.' });
        }

        refText = refText.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

        // Tự động chuyển đổi giọng mẫu (bất kể định dạng gốc như .m4a, .mp3, .ogg...) sang WAV chuẩn 16kHz trước khi đưa vào OmniVoice để tránh lỗi không hỗ trợ định dạng
        finalRefAudioPath = refAudioPath;
        const refWavPath = path.join(workDir, `ref_voice_${timestamp}.wav`);
        try {
          console.log('Đang chuyển đổi giọng mẫu sang định dạng WAV chuẩn 16kHz cho OmniVoice...');
          await new Promise((resolve, reject) => {
            execFile(FFMPEG_PATH, [
              '-i', refAudioPath,
              '-acodec', 'pcm_s16le',
              '-ar', '16000',
              '-ac', '1',
              '-y', refWavPath
            ], (err, stdout, stderr) => {
              if (err) reject(new Error('Lỗi FFmpeg: ' + stderr));
              else resolve();
            });
          });
          finalRefAudioPath = refWavPath;
          tempFiles.push(refWavPath);
        } catch (err) {
          console.error('Lỗi khi convert ref-audio sang WAV:', err.message);
          finalRefAudioPath = refAudioPath; // Fallback
        }
      }

      // Kiểm tra xem có sử dụng chế độ phụ đề để đọc khớp thời gian từng dòng (Line-by-Line Sync Mode) hay không
      if (subtitlePath && fs.existsSync(subtitlePath)) {
        console.log('Bắt đầu đồng bộ giọng đọc OmniVoice theo từng câu phụ đề...');
        const Parser = require('srt-parser-2').default;
        const parser = new Parser();
        const srtContent = fs.readFileSync(subtitlePath, 'utf8');
        const srtArray = parser.fromSrt(srtContent).filter(item => item.text && item.text.trim());

        if (srtArray.length === 0) {
          return res.status(400).json({ error: 'File phụ đề rỗng hoặc không có nội dung chữ.' });
        }

        // Nhóm các dòng phụ đề để đọc liền mạch thành câu hoàn chỉnh
        const groups = [];
        let currentGroup = [];
        
        for (let i = 0; i < srtArray.length; i++) {
          const item = srtArray[i];
          currentGroup.push(item);
          
          const currentEndMs = srtTimeToMs(item.endTime);
          const nextItem = srtArray[i + 1];
          
          let shouldSplit = false;
          if (!nextItem) {
            shouldSplit = true;
          } else {
            const nextStartMs = srtTimeToMs(nextItem.startTime);
            const gapMs = nextStartMs - currentEndMs;
            
            // Tách nhóm nếu có khoảng trống lớn (> 1.0 giây) hoặc câu phụ đề kết thúc bằng dấu chấm/hỏi/cảm thán
            const endsWithPunctuation = /[.!?…]$/.test(item.text.trim());
            if (gapMs > 1000 || endsWithPunctuation) {
              shouldSplit = true;
            }
          }
          
          if (shouldSplit) {
            groups.push(currentGroup);
            currentGroup = [];
          }
        }

        if (groups.length === 0) {
          return res.status(400).json({ error: 'Không thể phân nhóm phụ đề.' });
        }

        // Sử dụng mảng ở scope cha
        let lastSpeechEndMs = 0; // Thời điểm kết thúc giọng nói của câu trước (mili-giây)

        for (let idx = 0; idx < groups.length; idx++) {
          const group = groups[idx];
          // Gộp văn bản trong nhóm thành một chuỗi duy nhất để đọc liền mạch
          const lineText = group.map(item => item.text.replace(/\n/g, ' ').trim()).join(' ').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          if (!lineText) continue;

          const chunkPath = path.join(workDir, `chunk_${idx}_${timestamp}.wav`);
          
          const startMs = srtTimeToMs(group[0].startTime);
          const endMs = srtTimeToMs(group[group.length - 1].endTime);
          const durationSec = Math.max(0.5, (endMs - startMs) / 1000);
          
          const syllableCount = lineText.split(/\s+/).filter(w => w.length > 0).length;
          const naturalDuration = Math.max(0.6, syllableCount * 0.17);
          
          const minSpeed = originalIsChinese ? 0.85 : 1.0;
          const speed = Math.max(minSpeed, Math.min(2.0, naturalDuration / durationSec));
          const targetDuration = naturalDuration / speed;

          const omnivoiceArgs = [
            '--model', OMNIVOICE_MODEL_PATH,
            '--text', lineText,
            '--output', chunkPath,
            '--response-format', 'wav',
            '--language', body.omiLanguage === 'Vietnamese' ? 'vi' : (body.omiLanguage === 'English' ? 'en' : (body.omiLanguage === 'Chinese' ? 'zh' : (body.omiLanguage || 'vi'))),
            '--device', body.omiDevice || process.env.OMNIVOICE_DEVICE || 'cpu',
            '--num-step', body.omiSteps || process.env.OMNIVOICE_STEPS || '16',
            '--seed', (body.omiSeed && body.omiSeed.trim() !== '') ? body.omiSeed : String(Math.floor(Math.random() * 9999999)),
            '--speed', String(speed.toFixed(2)),
            '--position-temperature', '1.5'
          ];

          if (finalRefAudioPath && refText) {
            omnivoiceArgs.push('--ref-audio', finalRefAudioPath);
            omnivoiceArgs.push('--ref-text', refText);
          } else {
            omnivoiceArgs.push('--instruct', 'female');
            omnivoiceArgs.push('--duration', String(targetDuration.toFixed(2)));
          }

          console.log(`[OmniVoice-Sub] Đang đọc nhóm câu ${idx + 1}/${groups.length}: "${lineText}" (Tốc độ: ${speed.toFixed(2)}x, Thời lượng: ${targetDuration.toFixed(2)}s, Bắt đầu: ${(startMs/1000).toFixed(2)}s)`);
          try {
            await runExecFile(OMNIVOICE_CLI_PATH, omnivoiceArgs, { cwd: path.dirname(OMNIVOICE_CLI_PATH) });
            if (fs.existsSync(chunkPath)) {
              // Kiểm tra xem thời lượng thực tế của file âm thanh có vượt quá thời lượng phụ đề không
              try {
                const stats = fs.statSync(chunkPath);
                const pcmSize = stats.size - 44;
                const actualDurationMs = Math.round(pcmSize / 48); // 48 bytes/ms cho 24kHz 16bit mono
                
                const subtitleDurationMs = endMs - startMs;
                const maxAllowedDurationMs = Math.max(200, subtitleDurationMs - 50); // Chừa 50ms khoảng nghỉ
                
                if (actualDurationMs > maxAllowedDurationMs) {
                  const speedUpRatio = actualDurationMs / maxAllowedDurationMs;
                  console.log(`[OmniVoice-Sub] Nhóm câu ${idx + 1} dài hơn phụ đề (${actualDurationMs}ms > ${maxAllowedDurationMs}ms). Đang dùng FFmpeg để tăng tốc ${speedUpRatio.toFixed(2)}x...`);
                  
                  const tempSpeedUpPath = chunkPath.replace('.wav', '_speedup.wav');
                  
                  // Tạo chuỗi filter atempo (FFmpeg giới hạn mỗi filter atempo từ 0.5 đến 2.0)
                  let remainingRatio = speedUpRatio;
                  const filterParts = [];
                  while (remainingRatio > 2.0) {
                    filterParts.push('atempo=2.0');
                    remainingRatio /= 2.0;
                  }
                  if (remainingRatio > 0.5) {
                    filterParts.push(`atempo=${remainingRatio.toFixed(3)}`);
                  }
                  const atempoFilter = filterParts.join(',');
                  
                  const ffmpegSpeedArgs = [
                    '-i', chunkPath,
                    '-filter:a', atempoFilter,
                    '-y', tempSpeedUpPath
                  ];
                  
                  await runExecFile(FFMPEG_PATH, ffmpegSpeedArgs);
                  if (fs.existsSync(tempSpeedUpPath)) {
                    fs.copyFileSync(tempSpeedUpPath, chunkPath);
                    fs.unlinkSync(tempSpeedUpPath);
                    console.log(`[OmniVoice-Sub] Đã tăng tốc nhóm câu ${idx + 1} thành công.`);
                  }
                }
              } catch (speedUpErr) {
                console.error(`[OmniVoice-Sub] Lỗi khi xử lý tăng tốc nhóm câu ${idx + 1}:`, speedUpErr.message);
              }

              voiceChunks.push({
                filePath: chunkPath,
                startMs: startMs
              });
              tempFiles.push(chunkPath);
            }
          } catch (err) {
            console.error(`Lỗi khi đọc nhóm câu ${idx + 1}/${groups.length}:`, err.message);
          }
        }

        if (voiceChunks.length === 0) {
          return res.status(400).json({ error: 'Không thể tạo được bất kỳ file âm thanh nào cho các câu phụ đề.' });
        }

        // Sắp xếp theo thứ tự thời gian bắt đầu
        voiceChunks.sort((a, b) => a.startMs - b.startMs);

        // Gộp các chunk thành một file duy nhất
        try {
          console.log('[OmniVoice] Đang gộp các chunk giọng nói thành một file duy nhất...');
          let maxEndMs = 0;
          const chunkDataList = [];
          
          for (const chunk of voiceChunks) {
            const stats = fs.statSync(chunk.filePath);
            const pcmSize = stats.size - 44;
            const durationMs = Math.round(pcmSize / 48);
            const endMs = chunk.startMs + durationMs;
            if (endMs > maxEndMs) {
              maxEndMs = endMs;
            }
            
            // Đọc dữ liệu PCM (bỏ qua 44 bytes wav header)
            const fd = fs.openSync(chunk.filePath, 'r');
            const pcmBuffer = Buffer.alloc(pcmSize);
            fs.readSync(fd, pcmBuffer, 0, pcmSize, 44);
            fs.closeSync(fd);
            
            // Áp dụng fade-in/fade-out 15ms để loại bỏ tiếng "tách" (click/pop) ở ranh giới đoạn
            const totalSamples = pcmSize / 2;
            const fadeSamples = Math.min(360, Math.floor(totalSamples / 2)); // 360 samples = 15ms ở 24kHz
            for (let sampleIdx = 0; sampleIdx < totalSamples; sampleIdx++) {
              const byteOffset = sampleIdx * 2;
              let val = pcmBuffer.readInt16LE(byteOffset);
              
              if (sampleIdx < fadeSamples) {
                val = Math.round(val * (sampleIdx / fadeSamples));
              } else if (sampleIdx >= totalSamples - fadeSamples) {
                const distFromEnd = totalSamples - 1 - sampleIdx;
                val = Math.round(val * (distFromEnd / fadeSamples));
              }
              
              pcmBuffer.writeInt16LE(val, byteOffset);
            }
            
            chunkDataList.push({
              startMs: chunk.startMs,
              pcmBuffer: pcmBuffer,
              durationMs: durationMs
            });
          }
          
          if (maxEndMs > 0) {
            // Khởi tạo buffer chung cho toàn bộ voice track (sử dụng PCM 16-bit mono 24000Hz -> 48 bytes/ms)
            const combinedDataSize = maxEndMs * 48;
            const combinedBuffer = Buffer.alloc(combinedDataSize); // tự động điền 0 (im lặng)
            
            // Trộn các chunks vào buffer chung
            for (const chunk of chunkDataList) {
              const targetOffset = chunk.startMs * 48;
              const pcmLength = chunk.pcmBuffer.length;
              
              // Để an toàn, tránh lỗi overlap vượt quá kích thước buffer
              const limit = Math.min(pcmLength, combinedDataSize - targetOffset);
              
              for (let i = 0; i < limit; i += 2) {
                if (targetOffset + i + 1 >= combinedDataSize) break;
                
                const sample1 = combinedBuffer.readInt16LE(targetOffset + i);
                const sample2 = chunk.pcmBuffer.readInt16LE(i);
                
                let mixed = sample1 + sample2;
                if (mixed > 32767) mixed = 32767;
                else if (mixed < -32768) mixed = -32768;
                
                combinedBuffer.writeInt16LE(mixed, targetOffset + i);
              }
            }
            
            // Tạo file wav hoàn chỉnh
            const wavHeader = createWavHeader(combinedDataSize, 24000, 1, 16);
            voicePath = path.join(workDir, `combined_voice_${timestamp}.wav`);
            fs.writeFileSync(voicePath, Buffer.concat([wavHeader, combinedBuffer]));
            tempFiles.push(voicePath);
            
            console.log(`[OmniVoice] Đã gộp thành công ${voiceChunks.length} chunk thành file đơn: ${voicePath} (Thời lượng: ${(maxEndMs/1000).toFixed(2)}s)`);
            
            // Xóa danh sách voiceChunks để FFmpeg map theo voicePath duy nhất
            voiceChunks.length = 0;
          }
        } catch (mergeErr) {
          console.error('[OmniVoice] Lỗi khi gộp các file chunk âm thanh:', mergeErr.message);
          // Nếu lỗi, giữ nguyên voiceChunks để chạy theo cách cũ (fallback an toàn)
        }

        // Lưu kịch bản đầy đủ
        const fullScript = srtArray.map(item => item.text.replace(/\n/g, ' ')).join('\n');
        const scriptOutName = `studio_${timestamp}.txt`;
        fs.writeFileSync(path.join(RENDERS_DIR, scriptOutName), fullScript, 'utf8');
        console.log(`[OmniVoice] Đã xuất kịch bản thành file văn bản: ${path.join(RENDERS_DIR, scriptOutName)}`);
      } else {
        // Fallback: đọc toàn bộ kịch bản cùng lúc nếu không có file phụ đề
        if (!omiScript && subtitlePath && fs.existsSync(subtitlePath)) {
          try {
            const Parser = require('srt-parser-2').default;
            const parser = new Parser();
            const srtContent = fs.readFileSync(subtitlePath, 'utf8');
            const srtArray = parser.fromSrt(srtContent);
            omiScript = srtArray.map(item => item.text.replace(/\n/g, ' ')).join(' ');
            console.log('Tự động lấy kịch bản từ phụ đề tiếng Việt (fallback):', omiScript);
          } catch (e) {
            console.error('Lỗi phân tích phụ đề làm kịch bản:', e.message);
          }
        }

        if (!omiScript) {
          return res.status(400).json({ error: 'Vui lòng nhập kịch bản hoặc bật chế độ phụ đề để OmniVoice tự đọc.' });
        }

        omiScript = omiScript.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

        voicePath = path.join(workDir, `omnivoice_${timestamp}.wav`);
        const omnivoiceArgs = [
          '--model', OMNIVOICE_MODEL_PATH,
          '--text', omiScript,
          '--output', voicePath,
          '--response-format', 'wav',
          '--language', body.omiLanguage === 'Vietnamese' ? 'vi' : (body.omiLanguage === 'English' ? 'en' : (body.omiLanguage === 'Chinese' ? 'zh' : (body.omiLanguage || 'vi'))),
          '--device', body.omiDevice || process.env.OMNIVOICE_DEVICE || 'cpu',
          '--num-step', body.omiSteps || process.env.OMNIVOICE_STEPS || '16',
          '--seed', (body.omiSeed && body.omiSeed.trim() !== '') ? body.omiSeed : String(Math.floor(Math.random() * 9999999)),
          '--position-temperature', '1.5'
        ];

        if (finalRefAudioPath && refText) {
          omnivoiceArgs.push('--ref-audio', finalRefAudioPath);
          omnivoiceArgs.push('--ref-text', refText);
        } else {
          omnivoiceArgs.push('--instruct', 'female');
          const estDuration = Math.max(1.5, omiScript.length * 0.075);
          omnivoiceArgs.push('--duration', String(estDuration.toFixed(1)));
        }

        console.log('\n======================================================================');
        console.log(`[OmniVoice] Kịch bản đang đọc (${body.omiLanguage || 'vi'}):\n${omiScript}`);
        console.log('======================================================================\n');
        
        const scriptOutName = `studio_${timestamp}.txt`;
        fs.writeFileSync(path.join(RENDERS_DIR, scriptOutName), omiScript, 'utf8');
        console.log(`[OmniVoice] Đã xuất kịch bản thành file văn bản: ${path.join(RENDERS_DIR, scriptOutName)}`);

        await runExecFile(OMNIVOICE_CLI_PATH, omnivoiceArgs, { cwd: path.dirname(OMNIVOICE_CLI_PATH) });
        tempFiles.push(voicePath);
      }
    }

    let musicPath = null;
    const musicMode = body.musicMode || 'none';
    if (musicMode === 'upload' && files.musicUpload?.[0]) {
      musicPath = moveUploadedFile(files.musicUpload[0], MUSIC_DIR, files.musicUpload[0].originalname);
    } else if (musicMode === 'saved') {
      musicPath = resolveAssetPath('music', body.savedMusicFile);
    }

    const outName = `studio_${timestamp}.mp4`;
    const outPath = path.join(RENDERS_DIR, outName);
    const args = ['-i', sourceVideo];
    const audioInputs = [];

    const voiceVolume = Math.max(0, Number(body.voiceVolume !== undefined ? body.voiceVolume : 1.0));

    if (voiceChunks && voiceChunks.length > 0) {
      voiceChunks.forEach(chunk => {
        args.push('-i', chunk.filePath);
        audioInputs.push({
          index: args.filter(v => v === '-i').length - 1,
          volume: voiceVolume,
          type: 'chunk',
          startMs: chunk.startMs
        });
      });
    } else if (voicePath) {
      args.push('-i', voicePath);
      audioInputs.push({
        index: args.filter(v => v === '-i').length - 1,
        volume: voiceVolume,
        type: 'single'
      });
    }

    if (musicPath) {
      args.push('-stream_loop', '-1', '-i', musicPath);
      const bgmVolume = Math.max(0, Number(body.musicVolume || 0.18));
      audioInputs.push({
        index: args.filter(v => v === '-i').length - 1,
        volume: bgmVolume,
        type: 'music'
      });
    }

    let reactionInputIndex = -1;
    if (reactionVideoPath) {
      args.push('-stream_loop', '-1', '-i', reactionVideoPath);
      reactionInputIndex = args.filter(v => v === '-i').length - 1;
      
      if (body.reactionAudio === 'true') {
        audioInputs.push({
          index: reactionInputIndex,
          volume: 1.0,
          type: 'reaction'
        });
      }
    }

    let renderSubtitlePath = null;
    let videoFilter = null;
    let hasVideoFilter = false;

    if (subtitlePath && body.burnSub === 'true') {
      const scaleFactor = 1.35; // Scale factor to reconcile libass rendering with CSS pixels
      const fontSize = Math.round(Number(body.subtitleSize || 18) * scaleFactor);
      const marginV = Number(body.subtitleMargin || 28);
      const marginH = Number(body.subtitleMarginH || 20);
      const boxWidth = videoWidth - 2 * marginH;
      const maxChars = Math.max(10, Math.floor(boxWidth / (fontSize * 0.5)));

      try {
        formatSubtitleFile(subtitlePath, Number(body.subtitleMaxLines || 0), maxChars);
      } catch (err) {
        console.error('Lỗi định dạng phụ đề 1-2 dòng:', err.message);
      }
      
      const ssaToAssAlignment = {
        1: 1,  // Bottom-Left
        2: 2,  // Bottom-Center
        3: 3,  // Bottom-Right
        9: 4,  // Middle-Left
        10: 5, // Middle-Center
        11: 6, // Middle-Right
        5: 7,  // Top-Left
        6: 8,  // Top-Center
        7: 9   // Top-Right
      };
      const alignment = ssaToAssAlignment[Number(body.subtitleAlignment || 2)] || 2;
      
      const fontName = body.subtitleFont || 'Arial';
      const isBold = body.subtitleBold !== 'false';
      const assColor = hexToAssColor(body.subtitleColor || '#FFFFFF');
      const theme = body.subtitleTheme || 'outline';
      
      let borderStyle = 1;
      let outline = 2.5 * scaleFactor;
      let shadow = 1 * scaleFactor;
      let outlineColor = '&H00000000';
      let backColor = '&H80000000';
      
      if (theme === 'box') {
        borderStyle = 3;
        backColor = '&H66000000'; // 60% opacity black box
        outlineColor = '&H66000000'; // Match outline color with backColor to avoid borders
        outline = 4.0 * scaleFactor; // Acts as the padding of the box
        shadow = 0;
      } else if (theme === 'box-deep') {
        borderStyle = 3;
        backColor = '&H0D000000'; // 95% opacity black box
        outlineColor = '&H0D000000'; // Match outline color with backColor to avoid borders
        outline = 4.0 * scaleFactor;
        shadow = 0;
      } else if (theme === 'shadow') {
        borderStyle = 1;
        outline = 0;
        shadow = 2 * scaleFactor;
        backColor = '&H90000000';
      } else if (theme === 'outline-thick') {
        borderStyle = 1;
        outline = 5.0 * scaleFactor;
        shadow = 0;
        outlineColor = '&H00000000';
      } else if (theme === 'outline-shadow') {
        borderStyle = 1;
        outline = 2.5 * scaleFactor;
        shadow = 3 * scaleFactor;
        outlineColor = '&H00000000';
        backColor = '&H90000000';
      }

      const assPath = path.join(workDir, `render_subtitles_${timestamp}.ass`);
      try {
        convertSrtToAss(subtitlePath, assPath, {
          videoWidth,
          videoHeight,
          fontName,
          fontSize,
          assColor,
          isBold,
          borderStyle,
          outline,
          shadow,
          outlineColor,
          backColor,
          alignment,
          marginV,
          marginH
        });
        renderSubtitlePath = assPath;
      } catch (err) {
        console.error('Lỗi chuyển đổi SRT sang ASS:', err.message);
        renderSubtitlePath = subtitlePath;
      }
    }

    let baseVideoLabel = '0:v';
    let blurFilterString = '';

    if (body.blurOriginalSub === 'true') {
      hasVideoFilter = true;
      baseVideoLabel = 'v_base';
      
      const blurXPercentVal = Math.min(100, Math.max(0, Number(body.blurX !== undefined ? body.blurX : 10))) / 100;
      const blurWidthPercentVal = Math.min(100, Math.max(1, Number(body.blurWidth !== undefined ? body.blurWidth : 80))) / 100;
      const blurYPercentVal = Math.min(100, Math.max(0, Number(body.blurY !== undefined ? body.blurY : 75))) / 100;
      const blurHeightPercentVal = Math.min(100, Math.max(1, Number(body.blurHeight !== undefined ? body.blurHeight : 15))) / 100;
      const blurRadius = Math.min(50, Math.max(1, Number(body.blurRadius || 20)));
      
      let blurXPercent = blurXPercentVal;
      if (blurXPercent + blurWidthPercentVal > 1) {
        blurXPercent = 1 - blurWidthPercentVal;
      }
      let blurYPercent = blurYPercentVal;
      if (blurYPercent + blurHeightPercentVal > 1) {
        blurYPercent = 1 - blurHeightPercentVal;
      }
      
      const cropW = videoWidth * blurWidthPercentVal;
      const cropH = videoHeight * blurHeightPercentVal;
      const maxLumaR = Math.max(1, Math.floor(Math.min(cropW, cropH) / 2) - 1);
      const maxChromaR = Math.max(1, Math.floor(Math.min(cropW / 2, cropH / 2) / 2) - 1);
      const safeLumaRadius = Math.min(blurRadius, maxLumaR);
      const safeChromaRadius = Math.min(blurRadius, maxChromaR);
      
      blurFilterString = `[0:v]split[orig][copy];[copy]crop=iw*${blurWidthPercentVal}:ih*${blurHeightPercentVal}:iw*${blurXPercent}:ih*${blurYPercent},boxblur=lr=${safeLumaRadius}:cr=${safeChromaRadius}[blurred];[orig][blurred]overlay=W*${blurXPercent}:H*${blurYPercent}[v_base]`;
    }

    if (reactionVideoPath) {
      hasVideoFilter = true;
      
      const rx = body.reactionX !== undefined && body.reactionX !== '' ? Number(body.reactionX) : null;
      const ry = body.reactionY !== undefined && body.reactionY !== '' ? Number(body.reactionY) : null;
      
      let overlayPos = 'main_w-overlay_w-20:main_h-overlay_h-20';
      if (rx !== null && ry !== null) {
        overlayPos = `${rx}:${ry}`;
      } else {
        const position = body.reactionPosition || 'bottom-right';
        if (position === 'bottom-left') overlayPos = '20:main_h-overlay_h-20';
        if (position === 'top-right') overlayPos = 'main_w-overlay_w-20:20';
        if (position === 'top-left') overlayPos = '20:20';
      }
      
      const width = Number(body.reactionWidth || 320);
      
      let filterChain = '';
      if (blurFilterString) {
        filterChain += blurFilterString + ';';
      }
      filterChain += `[${reactionInputIndex}:v]scale=${width}:-1[pip];[${baseVideoLabel}][pip]overlay=${overlayPos}`;
      
      if (renderSubtitlePath) {
        filterChain += `[v_pip];[v_pip]subtitles='${escapeSubtitleForFilter(renderSubtitlePath)}'[vout]`;
      } else {
        filterChain += `[vout]`;
      }
      videoFilter = filterChain;
    } else if (renderSubtitlePath) {
      hasVideoFilter = true;
      let filterChain = '';
      if (blurFilterString) {
        filterChain += blurFilterString + ';';
      }
      filterChain += `[${baseVideoLabel}]subtitles='${escapeSubtitleForFilter(renderSubtitlePath)}'[vout]`;
      videoFilter = filterChain;
    } else if (body.blurOriginalSub === 'true') {
      const blurXPercentVal = Math.min(100, Math.max(0, Number(body.blurX !== undefined ? body.blurX : 10))) / 100;
      const blurWidthPercentVal = Math.min(100, Math.max(1, Number(body.blurWidth !== undefined ? body.blurWidth : 80))) / 100;
      const blurYPercentVal = Math.min(100, Math.max(0, Number(body.blurY !== undefined ? body.blurY : 75))) / 100;
      const blurHeightPercentVal = Math.min(100, Math.max(1, Number(body.blurHeight !== undefined ? body.blurHeight : 15))) / 100;
      const blurRadius = Math.min(50, Math.max(1, Number(body.blurRadius || 20)));
      
      let blurXPercent = blurXPercentVal;
      if (blurXPercent + blurWidthPercentVal > 1) {
        blurXPercent = 1 - blurWidthPercentVal;
      }
      let blurYPercent = blurYPercentVal;
      if (blurYPercent + blurHeightPercentVal > 1) {
        blurYPercent = 1 - blurHeightPercentVal;
      }
      
      const cropW = videoWidth * blurWidthPercentVal;
      const cropH = videoHeight * blurHeightPercentVal;
      const maxLumaR = Math.max(1, Math.floor(Math.min(cropW, cropH) / 2) - 1);
      const maxChromaR = Math.max(1, Math.floor(Math.min(cropW / 2, cropH / 2) / 2) - 1);
      const safeLumaRadius = Math.min(blurRadius, maxLumaR);
      const safeChromaRadius = Math.min(blurRadius, maxChromaR);
      
      videoFilter = `[0:v]split[orig][copy];[copy]crop=iw*${blurWidthPercentVal}:ih*${blurHeightPercentVal}:iw*${blurXPercent}:ih*${blurYPercent},boxblur=lr=${safeLumaRadius}:cr=${safeChromaRadius}[blurred];[orig][blurred]overlay=W*${blurXPercent}:H*${blurYPercent}[vout]`;
    }

    // Build filter complex array
    const filterComplex = [];
    if (hasVideoFilter && videoFilter) {
      filterComplex.push(videoFilter);
    }
    
    let hasAudioFilter = false;
    if (audioInputs.length > 0) {
      hasAudioFilter = true;
      const originalVolume = Math.max(0, Number(body.originalVolume || 0.45));
      const audioFilters = [`[0:a]volume=${originalVolume}[a0]`];
      const mixLabels = ['[a0]'];
      audioInputs.forEach((input, idx) => {
        const label = `a${idx + 1}`;
        if (input.type === 'chunk') {
          if (input.startMs > 0) {
            audioFilters.push(`[${input.index}:a]adelay=${input.startMs}:all=1,volume=${input.volume}[${label}]`);
          } else {
            audioFilters.push(`[${input.index}:a]volume=${input.volume}[${label}]`);
          }
        } else {
          audioFilters.push(`[${input.index}:a]volume=${input.volume}[${label}]`);
        }
        mixLabels.push(`[${label}]`);
      });
      audioFilters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`);
      filterComplex.push(audioFilters.join(';'));
    }
    
    if (filterComplex.length > 0) {
      args.push('-filter_complex', filterComplex.join(';'));
    }
    
    // Map outputs
    if (hasVideoFilter) {
      args.push('-map', '[vout]');
    } else {
      args.push('-map', '0:v');
    }
    
    if (hasAudioFilter) {
      args.push('-map', '[aout]', '-c:a', 'aac');
    } else {
      args.push('-map', '0:a?', '-c:a', 'aac');
    }

    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', '-shortest', '-y', outPath);
    await runExecFile(FFMPEG_PATH, args);

    res.json({
      success: true,
      message: 'Đã render video',
      file: outName,
      url: `/renders/${encodeURIComponent(outName)}`
    });
  } catch (error) {
    console.error('Render studio error:', error.stderr || error.message);
    res.status(500).json({ error: 'Không thể render video. Kiểm tra video, sub, voice hoặc nhạc nền.' });
  }
});

// ==========================================
// TÍCH HỢP HỆ THỐNG XÁC THỰC BẢN QUYỀN
// ==========================================
const { getCompositeHWID, saveLicenseLocal, verifyLocalLicense, LICENSE_SERVER_URL } = require('./lib/license-manager');

// Middleware chặn các yêu cầu API nếu bản quyền không hợp lệ
function licenseMiddleware(req, res, next) {
  // Cho phép gọi các API kích hoạt license và lấy HWID
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
app.use(licenseMiddleware);

// 1. Endpoint lấy HWID thô cho giao diện kích hoạt
app.get('/api/license/hwid', (req, res) => {
  try {
    const hwid = getCompositeHWID();
    res.json({ hwid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Endpoint thực hiện kích hoạt trực tuyến
app.post('/api/license/activate', async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Mã bản quyền là bắt buộc' });
  }

  try {
    const hwid = getCompositeHWID();
    
    // Gửi yêu cầu kích hoạt lên server trung tâm của bạn
    const response = await axios.post(`${LICENSE_SERVER_URL}/api/server/activate`, { key, hwid }, { timeout: 6000 });
    
    if (response.data && response.data.status === 'success') {
      const { expiresAt, signature, issuedAt, nonce } = response.data;
      
      const payload = {
        key,
        hwid,
        expiresAt,
        issuedAt,
        nonce,
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
});

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
      server.on('error', (err) => {
        reject(err);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Hỗ trợ chạy trực tiếp qua `node server.js`
if (require.main === module) {
  startServer(3456).catch(err => {
    console.error('Lỗi khi khởi động server trực tiếp:', err.message);
  });
}

module.exports = { startServer, killAllActiveProcesses };
