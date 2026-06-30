const express = require('express');
const path = require('path');
const child_process = require('child_process');
const fs = require('fs');
const { getAppDataRoot } = require('./lib/path-helper');
const contentDisposition = require('content-disposition');
const multer = require('multer');
const { translateSubtitles, formatSubtitleFile, srtTimeToMs, msToSrtTime } = require('./lib/translate-sub');
const os = require('os');
const net = require('net');

const axios = require('axios');

// Vbee AI API credentials configuration
const VBEE_APP_ID = process.env.VBEE_APP_ID || '470eb36b-eca1-4d22-96b6-c88c997b5bea';
const VBEE_TOKEN = process.env.VBEE_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODIxNzkwMzd9.5k5_aMzZw-BQLLBPtFZMNL0O2bCS6mootc_UBMKlNIU';

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
const TOOLS_DIR = getExtPath('tools');

// Thiết lập thư mục lưu trữ dữ liệu (downloads, uploads)
const appDataRoot = getAppDataRoot(__dirname);
const DOWNLOADS_DIR = path.join(appDataRoot, 'downloads');
const UPLOADS_DIR = path.join(appDataRoot, 'uploads');

const VOICES_DIR = path.join(UPLOADS_DIR, 'voices');
const MUSIC_DIR = path.join(UPLOADS_DIR, 'music');
const SUBTITLES_DIR = path.join(UPLOADS_DIR, 'subtitles');
const TMP_UPLOADS_DIR = path.join(UPLOADS_DIR, 'tmp');
const RENDERS_DIR = path.join(DOWNLOADS_DIR, 'renders');

const PROJECTS_DIR = path.join(appDataRoot, 'projects');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
for (const dir of [VOICES_DIR, MUSIC_DIR, SUBTITLES_DIR, TMP_UPLOADS_DIR, RENDERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Tự động sao chép các file giọng mẫu mặc định từ bộ cài khi khởi động
const DEFAULT_VOICES_SRC = path.join(__dirname, 'public', 'default_voices');
if (fs.existsSync(DEFAULT_VOICES_SRC)) {
  try {
    const defaultFiles = fs.readdirSync(DEFAULT_VOICES_SRC);
    defaultFiles.forEach(file => {
      const srcPath = path.join(DEFAULT_VOICES_SRC, file);
      const destPath = path.join(VOICES_DIR, file);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`[Init] Đã sao chép giọng mẫu mặc định: ${file}`);
      }
    });
  } catch (err) {
    console.error('Lỗi khởi tạo giọng mẫu mặc định:', err.message);
  }
}

// Quản lý và dọn dẹp các tiến trình con tập trung
const activeProcesses = new Set();
const activeRenderProcesses = new Set();
let activeRenderId = null;
let isStudioRendering = false;

function registerChildProcess(proc) {
  if (!proc) return;
  activeProcesses.add(proc);
  
  if (isStudioRendering) {
    activeRenderProcesses.add(proc);
  }
  
  const cleanUp = () => {
    activeProcesses.delete(proc);
    activeRenderProcesses.delete(proc);
  };
  
  proc.on('close', cleanUp);
  proc.on('exit', cleanUp);
  proc.on('error', cleanUp);
}
global.registerChildProcess = registerChildProcess;

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      const { exec } = require('child_process');
      exec(`taskkill /F /T /PID ${proc.pid}`, (err) => {
        if (err) {
          // Fallback nếu taskkill gặp lỗi
          try { proc.kill('SIGKILL'); } catch (e) {}
        }
      });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (e) {
    console.error(`Không thể kill tiến trình PID ${proc.pid}:`, e.message);
  }
}

function killActiveRenderProcesses() {
  console.log(`[Studio Render] Hủy toàn bộ tiến trình render cũ (${activeRenderProcesses.size})...`);
  for (const proc of activeRenderProcesses) {
    console.log(`[Studio Render] Đang kill tiến trình render cũ PID: ${proc.pid}`);
    killProcessTree(proc);
  }
  activeRenderProcesses.clear();
}


function killAllActiveProcesses() {
  console.log(`Bắt đầu tắt toàn bộ tiến trình con đang hoạt động (${activeProcesses.size})...`);
  for (const proc of activeProcesses) {
    console.log(`Đang kill tiến trình PID: ${proc.pid}`);
    killProcessTree(proc);
  }
  activeProcesses.clear();
}

const customTempDir = isPackaged 
  ? path.join(os.homedir(), 'VideoStudio', 'temp_env')
  : path.join(__dirname, 'temp_env');

if (!fs.existsSync(customTempDir)) {
  try {
    fs.mkdirSync(customTempDir, { recursive: true });
  } catch (e) {
    console.error('Failed to create customTempDir:', e.message);
  }
}

// Wrapper bọc spawn và execFile để tự động đăng ký dọn dẹp và chuyển hướng thư mục tạm (TEMP/TMP)
function spawn(command, args, options) {
  let actualOptions = options || {};
  actualOptions = { ...actualOptions };
  const env = {
    ...process.env,
    ...actualOptions.env,
    TEMP: customTempDir,
    TMP: customTempDir
  };
  actualOptions.env = env;

  const proc = child_process.spawn(command, args, actualOptions);
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
  actualOptions = { ...actualOptions };
  const env = {
    ...process.env,
    ...actualOptions.env,
    TEMP: customTempDir,
    TMP: customTempDir
  };
  actualOptions.env = env;

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
const NLLB_TRANSLATE_PATH = getExtPath('tools', 'nllb_translate.exe');

const COOKIES_PATH = path.join(appDataRoot, 'cookies.txt');
const MODELS_DIR = path.join(appDataRoot, 'models');
const NLLB_MODEL_DIR = path.join(MODELS_DIR, 'nllb');
const OMNIVOICE_MODEL_PATH = process.env.OMNIVOICE_MODEL_PATH || path.join(MODELS_DIR, 'omnivoice-q8_0.gguf');

// Tự động tìm kiếm và thêm đường dẫn CUDA và tools vào PATH trên Windows để tránh lỗi thiếu DLL khi chạy OmniVoice
if (process.platform === 'win32') {
  const toolsDir = getExtPath('tools');
  const omnivoiceDir = getExtPath('tools', 'omnivoice');
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(RENDERS_DIR));
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use('/voices', express.static(VOICES_DIR));
app.use('/music', express.static(MUSIC_DIR));

// Helper: Run yt-dlp command and get JSON output
function runYtDlp(args, options = {}, retryCount = 0) {
  if (typeof options === 'number') {
    retryCount = options;
    options = {};
  }

  // Clone args to avoid mutating the original array
  const actualArgs = [...args];
  // Auto-inject cookies if cookies.txt exists
  if (fs.existsSync(COOKIES_PATH)) {
    if (!actualArgs.includes('--cookies')) {
      actualArgs.unshift('--cookies', COOKIES_PATH);
    }
  }

  return new Promise((resolve, reject) => {
    const { signal, ...execOptions } = options;
    execFile(YTDLP_PATH, actualArgs, { maxBuffer: 10 * 1024 * 1024, signal, ...execOptions }, (error, stdout, stderr) => {
      if (error) {
        if (error.name === 'AbortError' || signal?.aborted) {
          reject(new Error('Tải xuống bị hủy'));
          return;
        }
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
            runYtDlp(newArgs, options, retryCount + 1).then(resolve).catch(reject);
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

function removeVietnameseTones(str) {
  if (!str) return '';
  let result = str;
  result = result.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  result = result.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  result = result.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  result = result.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  result = result.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  result = result.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  result = result.replace(/đ/g, "d");
  result = result.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  result = result.replace(/È|É|Ẹ|Ẻ|E|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  result = result.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
  result = result.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  result = result.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  result = result.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
  result = result.replace(/Đ/g, "D");
  return result;
}

function getCustomExtractorArgs(url) {
  const args = [];
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    args.push('--extractor-args', 'youtube:player_client=android_vr,android');
  } else if (url.includes('tiktok.com')) {
    args.push('--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7355_1.1.1-7355_0');
  }
  return args;
}

function cleanupTempFiles(tempFilePath) {
  try {
    if (!tempFilePath) return;
    const dir = path.dirname(tempFilePath);
    const baseWithoutExt = path.basename(tempFilePath, path.extname(tempFilePath));
    
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(baseWithoutExt)) {
          const fullPath = path.join(dir, file);
          try {
            if (fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
            }
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.error('Lỗi dọn dẹp file tạm:', err.message);
  }
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
  return /^https?:\/\/(www\.|vt\.|vm\.|v\.)?(youtube\.com\/(shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/|facebook\.com\/|fb\.watch\/|fb\.com\/|tiktok\.com\/|douyin\.com\/|iesdouyin\.com\/|instagram\.com\/|instagr\.am\/)/.test(cleanUrl);
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
    if (!srtTime) return "0:00:00.00";
    const parts = srtTime.split(':');
    let hours = 0;
    let minutes = "00";
    let seconds = "00";
    let ms = "000";
    
    if (parts.length === 2) {
      minutes = parts[0];
      const secParts = parts[1].split(',');
      seconds = secParts[0];
      ms = secParts[1] || '000';
    } else if (parts.length >= 3) {
      hours = parseInt(parts[0], 10);
      minutes = parts[1];
      const secParts = parts[2].split(',');
      seconds = secParts[0];
      ms = secParts[1] || '000';
    } else {
      return "0:00:00.00";
    }
    const cs = ms.substring(0, 2).padEnd(2, '0');
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
    marginH,
    theme
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
    let text = item.text.replace(/\n/g, '\\N');
    if (theme === 'neon-glow') {
      text = `{\\blur4}${text}`;
    }
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

async function runOmnivoiceCLI(args, options = {}, omiDevice = 'cpu') {
  if (process.platform === 'win32') {
    const cliDir = path.dirname(OMNIVOICE_CLI_PATH);
    const cudaDllPath = path.join(cliDir, 'ggml-cuda.dll');
    const cudaDllDisabledPath = path.join(cliDir, 'ggml-cuda.dll.disabled');

    const hasNvidiaDriver = fs.existsSync('C:\\Windows\\System32\\nvcuda.dll');
    const useCuda = omiDevice.includes('cuda') && hasNvidiaDriver;

    if (useCuda) {
      if (fs.existsSync(cudaDllDisabledPath)) {
        try {
          fs.renameSync(cudaDllDisabledPath, cudaDllPath);
          console.log('[OmniVoice] Đã bật lại ggml-cuda.dll để sử dụng GPU');
        } catch (e) {
          console.error('[OmniVoice] Lỗi khi bật lại ggml-cuda.dll:', e.message);
        }
      }
    } else {
      if (fs.existsSync(cudaDllPath)) {
        try {
          fs.renameSync(cudaDllPath, cudaDllDisabledPath);
          console.log('[OmniVoice] Đã tạm thời vô hiệu hóa ggml-cuda.dll để chạy trên CPU tránh lỗi thiếu DLL');
        } catch (e) {
          console.error('[OmniVoice] Lỗi khi vô hiệu hóa ggml-cuda.dll:', e.message);
        }
      }
    }
  }

  try {
    return await runExecFile(OMNIVOICE_CLI_PATH, args, options);
  } catch (err) {
    if (omiDevice.includes('cuda')) {
      console.warn(`[OmniVoice] Thử chạy bằng GPU thất bại (${err.message}). Đang tự động chuyển đổi sang CPU để xử lý...`);
      
      const cpuArgs = [...args];
      for (let i = 0; i < cpuArgs.length; i++) {
        if (cpuArgs[i] === '--device') {
          cpuArgs[i + 1] = 'cpu';
        }
      }
      
      if (process.platform === 'win32') {
        const cliDir = path.dirname(OMNIVOICE_CLI_PATH);
        const cudaDllPath = path.join(cliDir, 'ggml-cuda.dll');
        const cudaDllDisabledPath = path.join(cliDir, 'ggml-cuda.dll.disabled');
        if (fs.existsSync(cudaDllPath)) {
          try {
            fs.renameSync(cudaDllPath, cudaDllDisabledPath);
          } catch (e) {}
        }
      }
      
      return runExecFile(OMNIVOICE_CLI_PATH, cpuArgs, options);
    }
    throw err;
  }
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
      '--no-playlist',
      '--ignore-no-formats-error',
      ...getCustomExtractorArgs(url)
    ];
    ytArgs.push(url);

    const output = await runYtDlp(ytArgs);

    const info = JSON.parse(output);

    // Extract formats - any video with height, sorted to get the highest quality/size first
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
        // We will merge everything with audio, so everything "has audio" from the user's perspective
        hasAudio: true, 
        container: 'mp4',
        format_note: f.format_note || '',
      }))
      // Remove duplicates by quality (keeping the first one, which is now the best size/bitrate format)
      .reduce((acc, f) => {
        const key = `${f.quality}-${f.fps}`;
        if (!acc.map.has(key)) {
          acc.map.set(key, true);
          acc.list.push(f);
        }
        return acc;
      }, { map: new Map(), list: [] }).list;

    // Get best thumbnail
    const thumbnail = info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : '');
    let proxiedThumbnail = thumbnail;
    if (thumbnail && (thumbnail.startsWith('http://') || thumbnail.startsWith('https://'))) {
      proxiedThumbnail = `/api/proxy-image?url=${encodeURIComponent(thumbnail)}`;
    }
    
    // Get author properly
    let author = info.uploader || info.channel || info.uploader_id || (info.extractor === 'XiaoHongShu' ? 'Xiaohongshu User' : 'Unknown');
    let title = cleanVideoTitle(info.title);
    if ((url.includes('instagram.com') || url.includes('instagr.am')) && info.description) {
      const firstLine = info.description.split('\n')[0].trim();
      if (firstLine) {
        title = cleanVideoTitle(firstLine);
      }
    }

    // Thử cào lấy tiêu đề & tên tác giả nếu là link Xiaohongshu và dữ liệu yt-dlp trả về bị trống/dummy ID
    if (url.includes('xiaohongshu.com') && (title.startsWith('XiaoHongShu video #') || author === 'Xiaohongshu User' || /^[a-f0-9]{24}$/.test(author))) {
      try {
        const axios = require('axios');
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
          },
          timeout: 5000
        });
        const html = response.data;
        
        // Trích xuất tiêu đề từ og:title hoặc thẻ title
        const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          let scrapedTitle = titleMatch[1].trim();
          scrapedTitle = scrapedTitle.replace(/\s*\|\s*小红书\s*-\s*.*$/, '');
          if (scrapedTitle && !scrapedTitle.includes('你访问的页面不见了')) {
            title = scrapedTitle;
          }
        }

        // Trích xuất tên tác giả từ trường nickname
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
});

// API: Get Gemini models
app.post('/api/gemini-models', async (req, res) => {
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
});

// API: Get OpenRouter models
app.post('/api/openrouter-models', async (req, res) => {
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

    // Sort free models first, then sort by name
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
});

// ==========================================================================
// HỆ THỐNG QUẢN LÝ DỰ ÁN (PROJECT MANAGEMENT SYSTEM API)
// ==========================================================================

// API: Lấy tất cả dự án
app.get('/api/projects', (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) {
      return res.json({ projects: [] });
    }
    const files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
    const projects = files.map(file => {
      try {
        const content = fs.readFileSync(path.join(PROJECTS_DIR, file), 'utf8');
        const proj = JSON.parse(content);
        return {
          id: proj.id,
          name: proj.name,
          updatedAt: proj.updatedAt || new Date().toISOString(),
          videoTitle: proj.videoTitle || '',
          sourceVideoPath: proj.sourceVideoPath || '',
          thumbnail: proj.thumbnail || ''
        };
      } catch (err) {
        console.error(`Lỗi đọc file dự án ${file}:`, err.message);
        return null;
      }
    }).filter(Boolean);

    // Sắp xếp thời gian cập nhật giảm dần
    projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json({ projects });
  } catch (error) {
    console.error('Lỗi khi lấy danh sách dự án:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Lấy chi tiết một dự án
app.get('/api/projects/:id', (req, res) => {
  try {
    const { id } = req.params;
    const file = path.join(PROJECTS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: 'Không tìm thấy dự án' });
    }
    const content = fs.readFileSync(file, 'utf8');
    const proj = JSON.parse(content);
    res.json(proj);
  } catch (error) {
    console.error('Lỗi khi đọc chi tiết dự án:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Lưu / Cập nhật dự án
app.post('/api/projects', (req, res) => {
  try {
    let { id, name, data } = req.body;
    if (!id) {
      id = `proj_${Date.now()}`;
    }
    if (!name) {
      name = `Dự án_${new Date().toLocaleString('vi-VN')}`;
    }
    const file = path.join(PROJECTS_DIR, `${id}.json`);
    const projectObj = {
      id,
      name,
      updatedAt: new Date().toISOString(),
      ...data
    };
    fs.writeFileSync(file, JSON.stringify(projectObj, null, 2), 'utf8');
    res.json({ success: true, project: projectObj });
  } catch (error) {
    console.error('Lỗi khi lưu dự án:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Xóa dự án
app.delete('/api/projects/:id', (req, res) => {
  try {
    const { id } = req.params;
    const file = path.join(PROJECTS_DIR, `${id}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi khi xóa dự án:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Nhân bản dự án
app.post('/api/projects/:id/duplicate', (req, res) => {
  try {
    const { id } = req.params;
    const srcFile = path.join(PROJECTS_DIR, `${id}.json`);
    if (!fs.existsSync(srcFile)) {
      return res.status(404).json({ error: 'Không tìm thấy dự án nguồn' });
    }
    const content = fs.readFileSync(srcFile, 'utf8');
    const proj = JSON.parse(content);
    
    const newId = `proj_${Date.now()}`;
    const newName = `${proj.name} (Bản sao)`;
    const newProj = {
      ...proj,
      id: newId,
      name: newName,
      updatedAt: new Date().toISOString()
    };
    const destFile = path.join(PROJECTS_DIR, `${newId}.json`);
    fs.writeFileSync(destFile, JSON.stringify(newProj, null, 2), 'utf8');
    res.json({ success: true, project: newProj });
  } catch (error) {
    console.error('Lỗi khi nhân bản dự án:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Proxy image to bypass hotlinking protection
app.get('/api/proxy-image', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return res.status(400).send('Invalid image URL');
    }
    const axios = require('axios');
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': url.includes('instagram') ? 'https://www.instagram.com/' : (url.includes('xiaohongshu') ? 'https://www.xiaohongshu.com/' : 'https://www.google.com/')
      },
      timeout: 10000
    });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    response.data.pipe(res);
  } catch (error) {
    console.error('Proxy image error:', error.message);
    res.status(500).send('Error loading image');
  }
});

// API: Download video
app.get('/api/download', async (req, res) => {
  const controller = new AbortController();
  const { signal } = controller;
  let tempFilePath = null;

  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
      if (tempFilePath) {
        setTimeout(() => {
          cleanupTempFiles(tempFilePath);
        }, 1000);
      }
    }
  });

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
      '--no-playlist',
      ...getCustomExtractorArgs(url)
    ];
    ytInfoArgs.push(url);

    const infoOutput = await runYtDlp(ytInfoArgs, { signal });
    const info = JSON.parse(infoOutput);
    const safeTitle = removeVietnameseTones(cleanVideoTitle(info.title)).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);

    const tempFileName = `temp-${Date.now()}-${Math.floor(Math.random()*1000)}.mp4`;
    tempFilePath = path.join(DOWNLOADS_DIR, tempFileName);

    // Build yt-dlp args for download
    const args = [
      '--no-warnings',
      '--no-playlist',
      '-o', tempFilePath,
      ...getCustomExtractorArgs(url)
    ];

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
      await runYtDlp(args, { signal });
      if (fs.existsSync(tempFilePath)) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}.mp4`));
        
        const stream = fs.createReadStream(tempFilePath);
        stream.pipe(res);
        
        stream.on('end', () => {
          cleanupTempFiles(tempFilePath);
        });
      } else {
        console.error('Quá trình tải video thất bại - File không tồn tại:', tempFilePath);
        res.status(500).json({ error: 'Quá trình tải video thất bại: File không tồn tại trên server' });
      }
    } catch (err) {
      console.error('yt-dlp download error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Không thể tải video: ' + err.message });
      }
    }

  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể tải video. Vui lòng thử lại. Chi tiết: ' + error.message });
    }
  }
});

// API: Download video with hardcoded Vietnamese subtitles
app.get('/api/download-vi', async (req, res) => {
  const controller = new AbortController();
  const { signal } = controller;
  let tempDir = null;

  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
      if (tempDir) {
        setTimeout(() => {
          try {
            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
          } catch (e) {
            console.error('Lỗi khi xóa tempDir (req close):', e.message);
          }
        }, 1000);
      }
    }
  });

  try {
    let { url, aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel } = req.query;
    url = extractUrl(url);
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });
    if (!isValidVideoUrl(url)) return res.status(400).json({ error: 'URL không hợp lệ' });

    console.log('Bắt đầu tải video kèm Vietsub:', url);

    // Get video title and ID
    const ytInfoArgs = ['--dump-json', '--no-warnings', '--no-playlist', ...getCustomExtractorArgs(url)];
    ytInfoArgs.push(url);
    const infoOutput = await runYtDlp(ytInfoArgs, { signal });
    const info = JSON.parse(infoOutput);
    const safeTitle = removeVietnameseTones(cleanVideoTitle(info.title)).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    const videoId = info.id || Date.now();

    tempDir = path.join(DOWNLOADS_DIR, `temp_${videoId}_${Math.floor(Math.random() * 1000)}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const videoPathPattern = path.join(tempDir, `video.%(ext)s`);
    const subPathPattern = path.join(tempDir, `sub.%(ext)s`);
    const finalVideoPath = path.join(tempDir, `final.mp4`);
    const translatedSubPath = path.join(tempDir, `translated.srt`);

    // 1. Download video
    const videoArgs = ['--no-warnings', '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', videoPathPattern, ...getCustomExtractorArgs(url)];
    videoArgs.push(url);
    if (fs.existsSync(FFMPEG_PATH)) videoArgs.push('--ffmpeg-location', FFMPEG_PATH);
    
    await runYtDlp(videoArgs, { signal });

    // Find actual video path
    const files = fs.readdirSync(tempDir);
    const videoFile = files.find(f => f.startsWith('video.'));
    if (!videoFile) throw new Error('Không tìm thấy video đã tải');
    const actualVideoPath = path.join(tempDir, videoFile);

    // 2. Download subtitles
    const subArgs = ['--write-auto-subs', '--write-subs', '--convert-subs', 'srt', '--skip-download', '-o', subPathPattern, ...getCustomExtractorArgs(url), url];
    try { await runYtDlp(subArgs, { signal }); } catch (e) {}

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
      await translateSubtitles(actualSubPath, translatedSubPath, { aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel }, downloadMaxLines, downloadMaxChars);

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
          execFile(FFMPEG_PATH, ffmpegArgs, { signal }, (err, stdout, stderr) => {
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
  } catch (error) {
    console.error('Download Vietsub error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể tải video kèm Vietsub. Vui lòng thử lại. Chi tiết: ' + error.message });
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
      '--no-warnings',
      ...getCustomExtractorArgs(url)
    ];
    ytListArgs.push(url);

    const output = await runYtDlp(ytListArgs);

    // output contains multiple json objects separated by newline
    const lines = output.trim().split('\n');
    const videos = lines.map(line => {
      try {
        const item = JSON.parse(line);
        let videoUrl = item.url;
        if (!videoUrl || !videoUrl.startsWith('http')) {
          if (url.includes('youtube.com') || url.includes('youtu.be')) {
            videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
          } else if (url.includes('facebook.com')) {
            videoUrl = `https://www.facebook.com/watch/?v=${item.id}`;
          } else if (url.includes('tiktok.com')) {
            videoUrl = `https://www.tiktok.com/@placeholder/video/${item.id}`;
          } else if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) {
            videoUrl = `https://www.xiaohongshu.com/discovery/item/${item.id}`;
          } else if (url.includes('instagram.com') || url.includes('instagr.am')) {
            videoUrl = `https://www.instagram.com/p/${item.id}`;
          } else if (item.id) {
            videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
          } else {
            videoUrl = '';
          }
        }

        let itemTitle = item.title;
        if ((url.includes('instagram.com') || url.includes('instagr.am')) && item.description) {
          const firstLine = item.description.split('\n')[0].trim();
          if (firstLine) {
            itemTitle = firstLine;
          }
        }

        let thumbUrl = item.thumbnail || (item.thumbnails && item.thumbnails.length > 0 ? item.thumbnails[0].url : '');
        if (thumbUrl && (thumbUrl.startsWith('http://') || thumbUrl.startsWith('https://'))) {
          thumbUrl = `/api/proxy-image?url=${encodeURIComponent(thumbUrl)}`;
        }

        return {
          id: item.id,
          title: itemTitle,
          url: videoUrl,
          duration: item.duration,
          thumbnail: thumbUrl
        };
      } catch(e) {
        return null;
      }
    }).filter(v => v);

    // Giới hạn đúng số lượng yêu cầu do yt-dlp áp dụng --playlist-end cho từng sub-playlist (Videos, Shorts, Live) dẫn đến bị nhân lên
    const limitedVideos = videos.slice(0, limit);

    res.json({ videos: limitedVideos });
  } catch (error) {
    console.error('Playlist error:', error.message);
    res.status(500).json({ error: 'Không thể lấy thông tin kênh/playlist.' });
  }
});

// API: Download locally
app.post('/api/download-local', async (req, res) => {
  const controller = new AbortController();
  const { signal } = controller;
  let tempDir = null;

  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
      if (tempDir) {
        setTimeout(() => {
          try {
            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
          } catch (e) {
            console.error('Lỗi khi xóa tempDir (local req close):', e.message);
          }
        }, 1000);
      }
    }
  });

  try {
    let { url, format_id, customFilename, aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel, subtitleMaxLines, subtitleSize, subtitleMarginH } = req.body;
    url = extractUrl(url);
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    // 1. Lấy thông tin tiêu đề video để đặt tên file an toàn
    const ytInfoArgs = ['--dump-json', '--no-warnings', '--no-playlist', ...getCustomExtractorArgs(url)];
    ytInfoArgs.push(url);
    
    const infoOutput = await runYtDlp(ytInfoArgs, { signal });
    const info = JSON.parse(infoOutput);
    
    let safeTitle;
    if (customFilename) {
      safeTitle = removeVietnameseTones(customFilename).replace(/[<>:"/\\|?*]/g, '_').trim();
      if (safeTitle.toLowerCase().endsWith('.mp4')) {
        safeTitle = safeTitle.substring(0, safeTitle.length - 4);
      }
      safeTitle = safeTitle.substring(0, 100);
    } else {
      safeTitle = removeVietnameseTones(cleanVideoTitle(info.title)).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    }
    
    const isVietsub = format_id === 'vietsub';

    if (isVietsub) {
      // --- LOGIC TẢI VIETSUB LOCAL ---
      const videoId = info.id || Date.now();
      tempDir = path.join(DOWNLOADS_DIR, `temp_local_${videoId}_${Math.floor(Math.random() * 1000)}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const videoPathPattern = path.join(tempDir, `video.%(ext)s`);
      const subPathPattern = path.join(tempDir, `sub.%(ext)s`);
      const finalVideoPath = path.join(DOWNLOADS_DIR, `${safeTitle}_Vietsub.mp4`);
      const translatedSubPath = path.join(tempDir, `translated.srt`);

      // Tải video gốc
      const videoArgs = ['--no-warnings', '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', videoPathPattern, ...getCustomExtractorArgs(url)];
      videoArgs.push(url);
      if (fs.existsSync(FFMPEG_PATH)) videoArgs.push('--ffmpeg-location', FFMPEG_PATH);
      
      await runYtDlp(videoArgs, { signal });

      const files = fs.readdirSync(tempDir);
      const videoFile = files.find(f => f.startsWith('video.'));
      if (!videoFile) throw new Error('Không tìm thấy video đã tải');
      const actualVideoPath = path.join(tempDir, videoFile);

      // Tải phụ đề rời
      const subArgs = ['--write-auto-subs', '--write-subs', '--convert-subs', 'srt', '--skip-download', '-o', subPathPattern, ...getCustomExtractorArgs(url), url];
      try { await runYtDlp(subArgs, { signal }); } catch (e) {}

      let subFile = fs.readdirSync(tempDir).find(f => f.startsWith('sub.') && f.endsWith('.srt'));
      let actualSubPath = subFile ? path.join(tempDir, subFile) : null;

      // Nếu không có phụ đề rời, dùng Whisper Audio-to-Text
      if (!actualSubPath) {
        console.log('Không có phụ đề rời, khởi chạy Whisper Audio-to-Text...');
        const { extractAudioAndTranscribe } = require('./lib/whisper-helper');
        actualSubPath = await extractAudioAndTranscribe(actualVideoPath, tempDir, FFMPEG_PATH);
      }

      if (actualSubPath) {
        console.log('Tìm thấy phụ đề, tiến hành dịch:', actualSubPath);
        const downloadMaxLines = Number(subtitleMaxLines || 0);
        const downloadFontSize = Math.round(Number(subtitleSize || 18) * 1.35);
        const downloadMarginH = Number(subtitleMarginH || 20);
        const downloadWidth = 1080;
        const downloadBoxWidth = downloadWidth - 2 * downloadMarginH;
        const downloadMaxChars = Math.max(10, Math.floor(downloadBoxWidth / (downloadFontSize * 0.5)));
        await translateSubtitles(actualSubPath, translatedSubPath, { aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel }, downloadMaxLines, downloadMaxChars);

        let hasSubtitles = false;
        try {
          if (fs.existsSync(translatedSubPath) && fs.readFileSync(translatedSubPath, 'utf8').trim().length > 0) {
            hasSubtitles = true;
          }
        } catch (e) {}

        if (hasSubtitles) {
          const escapedSubPath = translatedSubPath.replace(/\\/g, '/').replace(/:/g, '\\:');
          const ffmpegArgs = [
            '-i', actualVideoPath,
            '-vf', `subtitles='${escapedSubPath}':force_style='BorderStyle=3,BackColour=&H80000000,MarginV=20,Fontsize=18,WrapStyle=0'`,
            '-c:a', 'copy',
            '-y', finalVideoPath
          ];
          await new Promise((resolve, reject) => {
            execFile(FFMPEG_PATH, ffmpegArgs, { signal }, (err, stdout, stderr) => {
              if (err) reject(new Error('Lỗi chèn phụ đề: ' + stderr));
              else resolve();
            });
          });
        } else {
          fs.copyFileSync(actualVideoPath, finalVideoPath);
        }
      } else {
        fs.copyFileSync(actualVideoPath, finalVideoPath);
      }

      // Dọn dẹp thư mục tạm
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (e) {}
      
      res.json({ success: true, message: 'Đã tải thành công video Vietsub', filename: `${safeTitle}_Vietsub.mp4` });

    } else {
      // --- LOGIC TẢI CHẤT LƯỢNG THƯỜNG LOCAL ---
      const finalVideoPath = path.join(DOWNLOADS_DIR, `${safeTitle}.mp4`);
      
      const args = [
        '--no-warnings',
        '--no-playlist',
        '-o', finalVideoPath,
        ...getCustomExtractorArgs(url)
      ];
      if (fs.existsSync(FFMPEG_PATH)) args.push('--ffmpeg-location', FFMPEG_PATH);

      if (format_id && format_id !== 'best') {
        const selectedFormat = (info.formats || []).find(f => f.format_id === format_id);
        if (selectedFormat && selectedFormat.acodec === 'none') {
          args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}+bestaudio/best`);
        } else {
          args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}/best`);
        }
      } else {
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
      }
      args.push('--merge-output-format', 'mp4');
      args.push(url);

      await runYtDlp(args, { signal });
      res.json({ success: true, message: 'Đã tải thành công', filename: `${safeTitle}.mp4` });
    }

  } catch (error) {
    console.error('Download local error:', error.message);
    res.status(500).json({ error: 'Lỗi tải video: ' + error.message });
  }
});

// API: Check cookie status
app.get('/api/cookie/status', (req, res) => {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const stats = fs.statSync(COOKIES_PATH);
      return res.json({
        exists: true,
        lastModified: stats.mtime
      });
    }
    return res.json({ exists: false });
  } catch (error) {
    console.error('Lỗi kiểm tra cookie:', error.message);
    res.status(500).json({ error: 'Lỗi kiểm tra cookie' });
  }
});

// API: Save cookie content
app.post('/api/cookie/save', (req, res) => {
  try {
    const { cookieText } = req.body;
    if (!cookieText || cookieText.trim() === '') {
      return res.status(400).json({ error: 'Nội dung cookie trống' });
    }
    fs.writeFileSync(COOKIES_PATH, cookieText, 'utf8');
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi lưu cookie:', error.message);
    res.status(500).json({ error: 'Lỗi ghi file cookie: ' + error.message });
  }
});

// API: Clear/delete cookie file
app.post('/api/cookie/clear', (req, res) => {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      fs.unlinkSync(COOKIES_PATH);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi xóa cookie:', error.message);
    res.status(500).json({ error: 'Lỗi xóa file cookie: ' + error.message });
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

// API: Open specific file in folder
app.get('/api/open-file-folder', async (req, res) => {
  try {
    const { filename } = req.query;
    if (!filename) {
      return res.status(400).json({ error: 'Thiếu tên file' });
    }

    let fullPath = path.join(DOWNLOADS_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      fullPath = path.join(RENDERS_DIR, filename);
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
      // Fallback: Open directory if file not found
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
      return res.json({ success: true });
    }
  } catch (error) {
    console.error('Open file folder error:', error.message);
    res.status(500).json({ error: 'Lỗi mở thư mục' });
  }
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
      
      // Đồng thời xóa file kịch bản .txt đi kèm nếu có
      const txtPath = filePath.replace(path.extname(filePath), '.txt');
      if (fs.existsSync(txtPath)) {
        try {
          fs.unlinkSync(txtPath);
        } catch (e) {
          console.error('Lỗi khi xóa file kịch bản kèm theo:', e.message);
        }
      }
      
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

app.get('/api/check-dependencies', (req, res) => {
  const ffmpegOk = fs.existsSync(FFMPEG_PATH);
  const ytdlpOk = fs.existsSync(YTDLP_PATH);
  const whisperCliOk = fs.existsSync(getExtPath('tools', 'whisper_onnx.exe'));

  const whisperModels = ['base', 'tiny', 'small', 'medium', 'large-v3'];
  const downloadedWhisperModels = whisperModels.filter(model => 
    fs.existsSync(path.join(MODELS_DIR, 'whisper', model, 'model.bin'))
  );
  const whisperModelOk = downloadedWhisperModels.length > 0;

  const omnivoiceCliOk = fs.existsSync(OMNIVOICE_CLI_PATH);
  const omnivoiceModelOk = fs.existsSync(OMNIVOICE_MODEL_PATH);

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
  const cliExists = fs.existsSync(OMNIVOICE_CLI_PATH);
  const modelExists = fs.existsSync(OMNIVOICE_MODEL_PATH);
  console.log(`[Model Status] Checking CLI path: "${OMNIVOICE_CLI_PATH}" (Exists: ${cliExists})`);
  console.log(`[Model Status] Checking Model path: "${OMNIVOICE_MODEL_PATH}" (Exists: ${modelExists})`);
  const checkConfigured = cliExists && modelExists;
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

  const { WHISPER_MODELS_CONFIG } = require('./lib/model-downloader');
  const modelConfig = WHISPER_MODELS_CONFIG[model];
  let exists = false;

  if (modelConfig) {
    const whisperDir = path.join(MODELS_DIR, 'whisper', model);
    exists = modelConfig.files.every(file => {
      const filePath = path.join(whisperDir, file.name);
      return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    });
  } else {
    const modelPath = path.join(MODELS_DIR, 'whisper', model, 'model.bin');
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

app.post('/api/generate-vbee-voice', async (req, res) => {
  const { voiceCode, text, voiceName } = req.body;
  
  if (!voiceCode || !text || !voiceName) {
    return res.status(400).json({ error: 'Thiếu thông tin yêu cầu: voiceCode, text hoặc voiceName' });
  }

  const baseName = safeFileName(voiceName);
  if (!baseName) {
    return res.status(400).json({ error: 'Tên giọng mẫu không hợp lệ' });
  }

  const audioPath = path.join(VOICES_DIR, `${baseName}.wav`);
  const txtPath = path.join(VOICES_DIR, `${baseName}.txt`);

  if (fs.existsSync(audioPath) || fs.existsSync(txtPath)) {
    return res.status(400).json({ error: 'Giọng mẫu với tên này đã tồn tại, vui lòng chọn tên khác.' });
  }

  try {
    const isFemale = voiceCode.includes('female');
    let success = false;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VBEE_TOKEN}`,
      'App-Id': VBEE_APP_ID
    };

    const callVbeeSync = async () => {
      console.log(`[Vbee API Sync] Requesting ${baseName} (${voiceCode})...`);
      const response = await axios.post('https://api.vbee.vn/v1/tts', {
        text: text,
        voiceCode: voiceCode,
        outputFormat: 'wav',
        speed: 1.0,
        mode: 'sync'
      }, {
        headers,
        responseType: 'arraybuffer',
        timeout: 30000
      });
      fs.writeFileSync(audioPath, response.data);
      fs.writeFileSync(txtPath, text, 'utf8');
      console.log(`[Vbee API Sync] Saved to ${audioPath}`);
      return true;
    };

    const callVbeeAsync = async () => {
      console.log(`[Vbee API Async] Requesting ${baseName} (${voiceCode})...`);
      const response = await axios.post('https://api.vbee.vn/v1/tts', {
        text: text,
        voiceCode: voiceCode,
        outputFormat: 'wav',
        speed: 1.0,
        mode: 'async',
        bitrate: 128,
        webhookUrl: 'https://example.com/callback'
      }, {
        headers,
        timeout: 30000
      });

      const requestId = response.data?.requestId;
      if (!requestId) {
        throw new Error(response.data?.message || 'Không nhận được requestId từ Vbee.');
      }

      console.log(`[Vbee API Async] Request ID: ${requestId}. Bắt đầu polling...`);
      let status = 'PROCESSING';
      let audioLink = null;
      const maxAttempts = 30;
      let attempts = 0;

      while (status === 'PROCESSING' && attempts < maxAttempts) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));

        const pollRes = await axios.get(`https://api.vbee.vn/v1/tts/requests/${requestId}`, {
          headers,
          timeout: 10000
        });

        status = pollRes.data?.status;
        console.log(`[Vbee Polling] Lần ${attempts}/${maxAttempts} - Trạng thái: ${status}`);

        if (status === 'COMPLETED') {
          audioLink = pollRes.data?.audioLink;
          break;
        } else if (status === 'FAILED') {
          throw new Error('Yêu cầu xử lý giọng nói bị lỗi trên Vbee.');
        }
      }

      if (!audioLink) {
        throw new Error('Vbee xử lý quá thời gian chờ (timeout) hoặc không tìm thấy liên kết âm thanh.');
      }

      console.log(`[Vbee Downloading] Đang tải audio từ: ${audioLink}`);
      const audioRes = await axios.get(audioLink, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      fs.writeFileSync(audioPath, audioRes.data);
      fs.writeFileSync(txtPath, text, 'utf8');
      console.log(`[Vbee API Async] Saved to ${audioPath}`);
      return true;
    };

    if (isFemale) {
      try {
        success = await callVbeeSync();
      } catch (syncErr) {
        console.warn(`[Vbee Sync Warning] Sync failed: ${syncErr.message}. Thử lại bằng Async...`);
        success = await callVbeeAsync();
      }
    } else {
      success = await callVbeeAsync();
    }

    if (success) {
      return res.json({ success: true, message: 'Tạo giọng mẫu thành công!' });
    } else {
      throw new Error('Không thể sinh file hoặc lưu file.');
    }

  } catch (err) {
    console.error('Error generating Vbee voice:', err.message);
    let detailedError = err.message;
    if (err.response?.data) {
      try {
        const errorData = err.response.data;
        const errorBody = Buffer.isBuffer(errorData) 
          ? JSON.parse(errorData.toString('utf8'))
          : (typeof errorData === 'object' ? errorData : JSON.parse(errorData));
        if (errorBody.message) detailedError = errorBody.message;
        else if (errorBody.error) detailedError = errorBody.error;
      } catch (parseErr) {}
    }
    
    // Dọn dẹp nếu có file sinh lỗi
    try {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
    } catch (cleanupErr) {}

    res.status(500).json({ error: `Lỗi gọi API Vbee AI: ${detailedError}` });
  }
});

app.post('/api/save-voice', studioUpload.single('voice'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file giọng mẫu' });
    const savedPath = moveUploadedFile(req.file, VOICES_DIR, req.body.voiceName || req.file.originalname);
    
    if (req.body.voiceText && req.body.voiceText.trim()) {
      const txtPath = savedPath.replace(path.extname(savedPath), '.txt');
      fs.writeFileSync(txtPath, req.body.voiceText.trim(), 'utf8');
    }

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

app.post('/api/save-video', studioUpload.single('video'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file video' });
    const savedPath = moveUploadedFile(req.file, DOWNLOADS_DIR, req.body.videoName || req.file.originalname);
    res.json({
      success: true,
      message: 'Đã lưu video thành công',
      video: path.basename(savedPath)
    });
  } catch (error) {
    console.error('Save video error:', error.message);
    res.status(500).json({ error: 'Không thể lưu video' });
  }
});

// ==========================================================
// HỆ THỐNG TẢI ĐỘNG CÁC THƯ VIỆN AI NẶNG (CUDA, WHISPER)
// ==========================================================
const { checkDependencyStatus, downloadAndExtract } = require('./lib/dependency-downloader');
let activeDependencyDownload = null;

app.get('/api/check-dependencies-status', (req, res) => {
  try {
    const status = checkDependencyStatus(TOOLS_DIR);
    res.json(status);
  } catch (error) {
    console.error('Check dependency status error:', error.message);
    res.status(500).json({ error: 'Không thể kiểm tra trạng thái thư viện' });
  }
});

app.post('/api/download-dependency', async (req, res) => {
  const { type } = req.body; // 'cuda' hoặc 'whisper'
  if (!['cuda', 'whisper'].includes(type)) {
    return res.status(400).json({ error: 'Loại thư viện không hợp lệ' });
  }

  if (activeDependencyDownload) {
    return res.status(400).json({ error: 'Đang có tiến trình tải xuống chạy ngầm khác' });
  }

  activeDependencyDownload = { type, percent: 0, status: 'downloading' };
  res.json({ message: 'Bắt đầu tải xuống ngầm' });

  try {
    console.log(`[Dependency Downloader] Bắt đầu tải ${type} vào ${TOOLS_DIR}...`);
    await downloadAndExtract(type, TOOLS_DIR, (downloaded, total) => {
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
    // Reset tiến trình sau 8 giây
    setTimeout(() => {
      activeDependencyDownload = null;
    }, 8000);
  }
});

app.get('/api/download-dependency-progress', (req, res) => {
  res.json(activeDependencyDownload || { status: 'idle' });
});

// ==========================================================
// HỆ THỐNG THEO DÕI TIẾN TRÌNH RENDER STUDIO
// ==========================================================
// ==========================================================
// HỆ THỐNG HÀNG ĐỢI RENDER TUẦN TỰ (PREMIUM RENDER QUEUE)
// ==========================================================
const renderQueue = [];
let currentActiveTask = null;

let studioProgress = {
  status: 'idle',
  percent: 0,
  step: '',
  error: null
};

function updateStudioProgress(percent, step) {
  studioProgress.percent = percent;
  if (step) studioProgress.step = step;
  console.log(`[Studio Progress] ${percent}% - ${studioProgress.step}`);
  if (currentActiveTask) {
    currentActiveTask.percent = percent;
    if (step) currentActiveTask.step = step;
  }
}

global.updateStudioProgress = updateStudioProgress;

app.get('/api/render-progress', (req, res) => {
  res.json(studioProgress);
});

function getVideoDurationInSeconds(videoPath) {
  return new Promise((resolve) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      return resolve(0);
    }
    child_process.execFile(FFMPEG_PATH, ['-i', videoPath], (err, stdout, stderr) => {
      const output = stderr || '';
      const match = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        resolve(totalSeconds);
      } else {
        resolve(0);
      }
    });
  });
}

function runFFmpegWithProgress(args, totalDuration) {
  return new Promise((resolve, reject) => {
    console.log(`[FFmpeg Progress] Running FFmpeg with total duration ${totalDuration}s`);
    const proc = child_process.spawn(FFMPEG_PATH, args);
    registerChildProcess(proc);
    
    let stderrOutput = '';
    
    proc.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      stderrOutput += chunk;
      
      if (totalDuration > 0) {
        const match = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (match) {
          const hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const seconds = parseInt(match[3], 10);
          const currentTime = hours * 3600 + minutes * 60 + seconds;
          
          const ffmpegProgress = Math.min(99, Math.floor((currentTime / totalDuration) * 100));
          // Ánh xạ tiến trình FFmpeg từ 83% đến 97% trong tổng tiến trình render
          const overallPercent = 83 + Math.floor((ffmpegProgress / 100) * 14);
          updateStudioProgress(overallPercent, `Đang kết xuất (render) video: ${ffmpegProgress}%`);
        }
      }
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`FFmpeg error (code ${code})`);
        err.stderr = stderrOutput;
        reject(err);
      }
    });
    
    proc.on('error', (err) => {
      err.stderr = stderrOutput;
      reject(err);
    });
  });
}

app.post('/api/render-studio', studioUpload.fields([
  { name: 'videoUpload', maxCount: 1 },
  { name: 'subtitleUpload', maxCount: 1 },
  { name: 'voiceUpload', maxCount: 1 },
  { name: 'musicUpload', maxCount: 1 },
  { name: 'reactionUpload', maxCount: 1 }
]), async (req, res) => {
  const timestamp = Date.now();
  const taskId = `task_${timestamp}`;

  try {
    const body = req.body;
    const files = req.files || {};

    // 1. Tạo thư mục chuyên biệt cho task để lưu tệp tin lâu dài tránh bị Multer dọn dẹp
    const taskDir = path.join(UPLOADS_DIR, `task_${timestamp}`);
    fs.mkdirSync(taskDir, { recursive: true });

    // Di chuyển các tệp tải lên vào thư mục taskDir và cập nhật đường dẫn tệp tin
    const movedFiles = {};
    for (const [fieldname, fileArr] of Object.entries(files)) {
      if (fileArr && fileArr[0]) {
        const file = fileArr[0];
        const newPath = path.join(taskDir, file.filename + path.extname(file.originalname));
        fs.renameSync(file.path, newPath);
        movedFiles[fieldname] = [{
          ...file,
          path: newPath
        }];
      }
    }

    // 2. Tạo đối tượng Task mới đưa vào hàng chờ
    const task = {
      id: taskId,
      projectId: body.projectId || null,
      projectName: body.projectName || 'Dự án chưa đặt tên',
      status: 'pending',
      percent: 0,
      step: 'Đang xếp hàng...',
      error: null,
      createdAt: new Date(),
      body: body,
      files: movedFiles,
      taskDir: taskDir,
      result: null
    };

    renderQueue.push(task);
    console.log(`[Queue] Đã xếp hàng tác vụ ${taskId}. Tổng hàng đợi: ${renderQueue.length}`);

    // Kích hoạt worker chạy tác vụ tiếp theo dưới nền
    processNextRenderTask();

    // Phản hồi bất đồng bộ về client ngay lập tức
    return res.json({
      success: true,
      message: 'Đã thêm video vào hàng đợi thành công.',
      taskId: taskId
    });

  } catch (error) {
    console.error('[Queue Error] Lỗi xếp hàng tác vụ:', error.message);
    return res.status(500).json({ error: 'Không thể thêm video vào hàng đợi: ' + error.message });
  }
});

// Hàm chạy tiến trình render dưới nền cho một tác vụ cụ thể
async function executeRenderTask(task) {
  const tempFiles = [];
  const voiceChunks = [];
  const timestamp = Date.now();
  const renderId = task.id; // Sử dụng ID task làm renderId

  global.activeRenderRes = null;
  activeRenderId = renderId;
  isStudioRendering = true;

  // Tạo mock response object để giữ nguyên toàn bộ mã xử lý cũ mà không bị lỗi
  const res = {
    statusCode: 200,
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(data) {
      if (this.statusCode >= 400 || data.error) {
        throw new Error(data.error || 'Lỗi không xác định khi kết xuất');
      }
      task.status = 'success';
      task.percent = 100;
      task.step = 'Hoàn tất render!';
      task.result = data;
      studioProgress = {
        status: 'success',
        percent: 100,
        step: 'Hoàn tất render!',
        error: null,
        result: data
      };
      return this;
    }
  };

  try {
    studioProgress = {
      status: 'rendering',
      percent: 2,
      step: 'Khởi tạo thư mục làm việc...',
      error: null
    };
    task.status = 'rendering';
    task.percent = 2;
    task.step = 'Khởi tạo thư mục làm việc...';

    const body = task.body;
    const files = task.files || {};
    const timestamp = Date.now();
    const workDir = path.join(UPLOADS_DIR, `render_${timestamp}`);
    fs.mkdirSync(workDir, { recursive: true });

    let sourceVideo = null;
    if (files.videoUpload?.[0]) {
      const originalName = files.videoUpload[0].originalname;
      sourceVideo = moveUploadedFile(files.videoUpload[0], DOWNLOADS_DIR, originalName);
    } else if (body.mainVideoFile) {
      sourceVideo = resolveAssetPath('video', body.mainVideoFile);
    }
    if (!sourceVideo) return res.status(400).json({ error: 'Thiếu video nguồn' });

    updateStudioProgress(5, 'Đang phân tích thông tin video nguồn...');
    const dimensions = await getVideoDimensions(sourceVideo);
    const videoWidth = dimensions.width;
    const videoHeight = dimensions.height;
    const totalDuration = await getVideoDurationInSeconds(sourceVideo);
    console.log(`[Studio Render] Kích thước video nguồn: ${videoWidth}x${videoHeight}, Thời lượng: ${totalDuration}s`);

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
      updateStudioProgress(10, 'Đang chuẩn bị file phụ đề tải lên...');
      subtitlePath = moveUploadedFile(files.subtitleUpload[0], SUBTITLES_DIR, files.subtitleUpload[0].originalname);
    } else if (subtitleMode === 'saved') {
      updateStudioProgress(10, 'Đang nạp file phụ đề đã chọn...');
      subtitlePath = resolveAssetPath('subtitle', body.savedSubtitleFile);
    } else if (subtitleMode === 'generate') {
      updateStudioProgress(12, 'Đang chuẩn bị tạo phụ đề tự động bằng AI (Whisper)...');
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
      updateStudioProgress(35, 'Đang dịch phụ đề sang tiếng Việt bằng AI...');
      const translatedPath = path.join(workDir, `translated_${timestamp}.srt`);
      await translateSubtitles(subtitlePath, translatedPath, {
        aiProvider: body.aiProvider,
        geminiApiKey: body.geminiApiKey,
        geminiModel: body.geminiModel,
        openRouterApiKey: body.openRouterApiKey,
        openRouterModel: body.openRouterModel
      }, Number(body.subtitleMaxLines || 0), studioMaxChars, () => activeRenderId !== renderId);
      subtitlePath = translatedPath;
    } else if (subtitlePath && fs.existsSync(subtitlePath)) {
      updateStudioProgress(35, 'Đang định dạng cấu trúc phụ đề...');
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
      updateStudioProgress(38, 'Đang chuẩn bị file lồng tiếng tải lên...');
      voicePath = moveUploadedFile(files.voiceUpload[0], workDir, files.voiceUpload[0].originalname);
      tempFiles.push(voicePath);
    } else if (voiceMode === 'saved') {
      updateStudioProgress(38, 'Đang nạp giọng lồng tiếng đã chọn...');
      voicePath = resolveAssetPath('voice', body.savedVoiceFile);
    } else if (voiceMode === 'omi') {
      updateStudioProgress(40, 'Đang khởi động bộ nhân bản giọng nói AI (OmniVoice)...');
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
        // Kiểm tra xem có file kịch bản .txt đi kèm giọng mẫu không để dùng trực tiếp
        if (!refText && refAudioPath) {
          const txtPath = refAudioPath.replace(path.extname(refAudioPath), '.txt');
          if (fs.existsSync(txtPath)) {
            try {
              refText = fs.readFileSync(txtPath, 'utf8').trim();
              console.log('Đã tìm thấy kịch bản giọng mẫu có sẵn:', refText);
            } catch (txtErr) {
              console.error('Lỗi khi đọc file kịch bản có sẵn:', txtErr.message);
            }
          }
        }

        // Tự động trích xuất Ref-text từ giọng mẫu bằng Whisper nếu người dùng để trống
        if (!refText) {
          try {
            updateStudioProgress(42, 'Đang trích xuất câu thoại từ giọng mẫu (AI Whisper)...');
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
          updateStudioProgress(45, 'Đang chuẩn bị giọng mẫu (FFmpeg)...');
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

          const progressPercent = 48 + Math.floor((idx / groups.length) * 30);
          updateStudioProgress(progressPercent, `AI Cloner: Đang đọc câu thoại ${idx + 1}/${groups.length}...`);

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
            await runOmnivoiceCLI(omnivoiceArgs, { cwd: path.dirname(OMNIVOICE_CLI_PATH) }, body.omiDevice || 'cpu');
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
          updateStudioProgress(78, 'Đang gộp các đoạn giọng nói...');
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

        updateStudioProgress(55, 'AI Cloner: Đang đọc toàn bộ kịch bản...');
        await runOmnivoiceCLI(omnivoiceArgs, { cwd: path.dirname(OMNIVOICE_CLI_PATH) }, body.omiDevice || 'cpu');
        tempFiles.push(voicePath);
      }
    }

    updateStudioProgress(80, 'Đang chuẩn bị các track nhạc nền và lồng tiếng...');
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
      let finalAssColor = assColor;
      
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
      } else if (theme === 'neon-glow') {
        borderStyle = 1;
        outline = 2.0 * scaleFactor;
        shadow = 0;
        outlineColor = assColor;
        finalAssColor = '&H00FFFFFF'; // Primary body is white
      } else if (theme === 'three-d') {
        borderStyle = 1;
        outline = 1.0 * scaleFactor;
        shadow = 3.0 * scaleFactor;
        outlineColor = '&H00000000';
        backColor = '&H00000000';
      }

      const assPath = path.join(workDir, `render_subtitles_${timestamp}.ass`);
      try {
        convertSrtToAss(subtitlePath, assPath, {
          videoWidth,
          videoHeight,
          fontName,
          fontSize,
          assColor: finalAssColor,
          isBold,
          borderStyle,
          outline,
          shadow,
          outlineColor,
          backColor,
          alignment,
          marginV,
          marginH,
          theme
        });
        renderSubtitlePath = assPath;
      } catch (err) {
        console.error('Lỗi chuyển đổi SRT sang ASS:', err.message);
        renderSubtitlePath = subtitlePath;
      }
    }

    let baseVideoLabel = '0:v';
    let blurFilterString = '';

    const hasReaction = !!reactionVideoPath;
    const hasSubtitles = !!renderSubtitlePath;

    if (body.blurOriginalSub === 'true') {
      hasVideoFilter = true;
      baseVideoLabel = (hasReaction || hasSubtitles) ? 'v_base' : 'vout';
      
      // Parse blurBoxes from body
      let blurBoxes = [];
      if (body.blurBoxes) {
        try {
          blurBoxes = JSON.parse(body.blurBoxes);
        } catch (e) {
          console.error('Lỗi parse blurBoxes JSON:', e.message);
        }
      }
      
      // Nếu không có blurBoxes hoặc parse lỗi, fallback về cấu hình đơn lẻ cũ để tương thích ngược
      if (!Array.isArray(blurBoxes) || blurBoxes.length === 0) {
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
        
        blurFilterString = `[0:v]split[orig][copy];[copy]crop=iw*${blurWidthPercentVal}:ih*${blurHeightPercentVal}:iw*${blurXPercent}:ih*${blurYPercent},boxblur=lr=${safeLumaRadius}:cr=${safeChromaRadius}[blurred];[orig][blurred]overlay=W*${blurXPercent}:H*${blurYPercent}[${baseVideoLabel}]`;
      } else {
        // Có blurBoxes -> Xây dựng chuỗi nối tiếp
        let currentInputLabel = '0:v';
        const filters = [];
        
        blurBoxes.forEach((box, index) => {
          const isLast = index === blurBoxes.length - 1;
          const outputLabel = isLast ? baseVideoLabel : `v_blur_${index}`;
          
          const xPercent = Math.min(100, Math.max(0, Number(box.x !== undefined ? box.x : 10))) / 100;
          const widthPercent = Math.min(100, Math.max(1, Number(box.width !== undefined ? box.width : 80))) / 100;
          const yPercent = Math.min(100, Math.max(0, Number(box.y !== undefined ? box.y : 75))) / 100;
          const heightPercent = Math.min(100, Math.max(1, Number(box.height !== undefined ? box.height : 15))) / 100;
          const radius = Math.min(50, Math.max(1, Number(box.radius || 20)));
          
          let clampedX = xPercent;
          if (clampedX + widthPercent > 1) {
            clampedX = 1 - widthPercent;
          }
          let clampedY = yPercent;
          if (clampedY + heightPercent > 1) {
            clampedY = 1 - heightPercent;
          }
          
          const cropW = videoWidth * widthPercent;
          const cropH = videoHeight * heightPercent;
          const maxLumaR = Math.max(1, Math.floor(Math.min(cropW, cropH) / 2) - 1);
          const maxChromaR = Math.max(1, Math.floor(Math.min(cropW / 2, cropH / 2) / 2) - 1);
          const safeLumaRadius = Math.min(radius, maxLumaR);
          const safeChromaRadius = Math.min(radius, maxChromaR);
          
          const start = Number(box.start !== undefined ? box.start : 0);
          const end = Number(box.end !== undefined ? box.end : 99999);
          
          const origLabel = `orig_${index}`;
          const copyLabel = `copy_${index}`;
          const blurredLabel = `blurred_${index}`;
          
          filters.push(`[${currentInputLabel}]split[${origLabel}][${copyLabel}]`);
          filters.push(`[${copyLabel}]crop=iw*${widthPercent}:ih*${heightPercent}:iw*${clampedX}:ih*${clampedY},boxblur=lr=${safeLumaRadius}:cr=${safeChromaRadius}[${blurredLabel}]`);
          filters.push(`[${origLabel}][${blurredLabel}]overlay=W*${clampedX}:H*${clampedY}:enable='between(t,${start},${end})'[${outputLabel}]`);
          
          currentInputLabel = outputLabel;
        });
        
        blurFilterString = filters.join(';');
      }
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
      videoFilter = blurFilterString;
    }

    // Build filter complex array
    const filterComplex = [];
    if (hasVideoFilter && videoFilter) {
      filterComplex.push(videoFilter);
    }
    
    let hasAudioFilter = false;
    const originalVolume = Math.max(0, Number(body.originalVolume !== undefined ? body.originalVolume : 1.0));
    if (audioInputs.length > 0) {
      hasAudioFilter = true;
      const audioFilters = [`[0:a]volume=${originalVolume}[a0]`];
      const mixLabels = ['[a0]'];
      audioInputs.forEach((input, idx) => {
        const label = `a${idx + 1}`;
        const targetVolume = input.volume;
        if (input.type === 'chunk') {
          if (input.startMs > 0) {
            audioFilters.push(`[${input.index}:a]adelay=${input.startMs}:all=1,volume=${targetVolume}[${label}]`);
          } else {
            audioFilters.push(`[${input.index}:a]volume=${targetVolume}[${label}]`);
          }
        } else {
          audioFilters.push(`[${input.index}:a]volume=${targetVolume}[${label}]`);
        }
        mixLabels.push(`[${label}]`);
      });
      audioFilters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`);
      filterComplex.push(audioFilters.join(';'));
    } else if (body.originalVolume !== undefined && originalVolume !== 1.0) {
      hasAudioFilter = true;
      filterComplex.push(`[0:a]volume=${originalVolume}[aout]`);
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
    updateStudioProgress(83, 'Bắt đầu render video thành phẩm (FFmpeg)...');
    console.log('[FFmpeg Command Arguments]:', JSON.stringify(args));
    await runFFmpegWithProgress(args, totalDuration);

    // Sao chép file phụ đề kết quả vào thư mục renders và subtitles để người dùng chỉnh sửa hoặc lồng tiếng tiếp
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      try {
        updateStudioProgress(98, 'Đang xuất các file phụ đề bổ sung...');
        const outSrtName = `studio_${timestamp}.srt`;
        fs.copyFileSync(subtitlePath, path.join(RENDERS_DIR, outSrtName));
        fs.copyFileSync(subtitlePath, path.join(SUBTITLES_DIR, outSrtName));
        console.log(`[Studio Render] Đã xuất file phụ đề bổ sung: ${outSrtName}`);
      } catch (srtCopyErr) {
        console.error('Lỗi khi sao chép file phụ đề kết quả:', srtCopyErr.message);
      }
    }

    if (activeRenderId === renderId) {
      updateStudioProgress(100, 'Hoàn tất render!');
      isStudioRendering = false;

      res.json({
        success: true,
        message: 'Đã render video',
        file: outName,
        url: `/renders/${encodeURIComponent(outName)}`
      });
    } else {
      console.log(`[Studio Render] Phiên render cũ (${renderId}) đã hoàn thành nhưng đã bị thay thế hoặc hủy trước đó.`);
    }
  } catch (error) {
    console.error('Render studio error:', error.stderr || error.message);
    isStudioRendering = false;
    
    // Nếu tác vụ đã bị hủy bởi người dùng, không ghi đè trạng thái lỗi
    if (task.status === 'failed' || task.step?.includes('hủy') || task.error?.includes('hủy') || task.error?.includes('cancel')) {
      console.log(`[Queue] Tác vụ ${task.id} đã bị hủy trước đó, giữ nguyên trạng thái.`);
      return;
    }

    task.status = 'error';
    task.error = error.message;
    task.step = 'Lỗi kết xuất';
    
    studioProgress = {
      status: 'error',
      percent: task.percent,
      step: 'Lỗi kết xuất: ' + error.message,
      error: error.message
    };
  }
}

// Bộ lập lịch điều khiển hàng đợi kết xuất tuần tự
async function processNextRenderTask() {
  if (currentActiveTask) {
    console.log('[Queue] Đang chạy một tác vụ kết xuất khác...');
    return;
  }

  // Tìm tác vụ đầu tiên đang chờ
  const nextTask = renderQueue.find(t => t.status === 'pending');
  if (!nextTask) {
    console.log('[Queue] Hàng đợi trống. Không có tác vụ nào chờ xử lý.');
    return;
  }

  currentActiveTask = nextTask;
  console.log(`[Queue] Bắt đầu thực thi tác vụ kết xuất: ${nextTask.id}`);

  try {
    await executeRenderTask(nextTask);
  } catch (err) {
    console.error(`[Queue] Lỗi nghiêm trọng khi thực thi tác vụ ${nextTask.id}:`, err.message);
    nextTask.status = 'error';
    nextTask.error = err.message;
    nextTask.step = 'Lỗi hệ thống';
  } finally {
    currentActiveTask = null;
    // Chờ 1.5 giây rồi chuyển sang xử lý tác vụ tiếp theo
    setTimeout(() => {
      processNextRenderTask();
    }, 1500);
  }
}

// API endpoint mới: Lấy trạng thái toàn bộ hàng đợi render
app.get('/api/render-queue-status', (req, res) => {
  res.json({
    queue: renderQueue.map(t => ({
      id: t.id,
      projectId: t.projectId,
      projectName: t.projectName,
      status: t.status,
      percent: t.percent,
      step: t.step,
      error: t.error,
      createdAt: t.createdAt,
      videoName: t.body.mainVideoFile || (t.files.videoUpload?.[0] ? t.files.videoUpload[0].originalname : 'Video Tải Lên'),
      result: t.result
    })),
    currentActiveId: currentActiveTask ? currentActiveTask.id : null
  });
});

// API endpoint mới: Hủy hoặc xóa tác vụ khỏi hàng đợi
app.post('/api/cancel-queue-task', (req, res) => {
  const { taskId } = req.body;
  if (!taskId) {
    return res.status(400).json({ error: 'Thiếu mã tác vụ taskId' });
  }

  const taskIndex = renderQueue.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    return res.status(404).json({ error: 'Không tìm thấy tác vụ kết xuất' });
  }

  const task = renderQueue[taskIndex];

  if (task.status === 'pending') {
    // Nếu đang chờ, gỡ luôn khỏi hàng đợi
    renderQueue.splice(taskIndex, 1);
    console.log(`[Queue] Đã gỡ tác vụ đang chờ khỏi hàng đợi: ${taskId}`);
    return res.json({ success: true, message: 'Đã gỡ tác vụ khỏi hàng đợi thành công.' });
  }

  if (task.status === 'rendering') {
    // Nếu đang chạy, kích hoạt hủy tiến trình con và gỡ khỏi hàng đợi
    console.log(`[Queue] Nhận yêu cầu hủy và gỡ tác vụ đang chạy trực tiếp: ${taskId}`);
    killActiveRenderProcesses();
    isStudioRendering = false;
    activeRenderId = null;
    studioProgress = {
      status: 'idle',
      percent: 0,
      step: 'Đã hủy kết xuất',
      error: null
    };
    task.status = 'failed';
    task.step = 'Đã bị người dùng hủy';
    
    // Gỡ khỏi mảng hàng đợi
    renderQueue.splice(taskIndex, 1);
    currentActiveTask = null;

    // Chạy tác vụ tiếp theo sau khi dọn dẹp
    setTimeout(() => {
      processNextRenderTask();
    }, 1500);

    return res.json({ success: true, message: 'Đã hủy tiến trình và gỡ tác vụ khỏi hàng đợi thành công.' });
  }

  // Đối với các trạng thái khác (hoàn tất, lỗi), cho phép xóa luôn khỏi danh sách để dọn dẹp hàng đợi
  renderQueue.splice(taskIndex, 1);
  return res.json({ success: true, message: 'Đã gỡ tác vụ khỏi danh sách.' });
});

// API endpoint mới: Xóa sạch toàn bộ hàng đợi
app.post('/api/clear-queue', (req, res) => {
  console.log('[Queue] Nhận yêu cầu xóa sạch toàn bộ hàng đợi...');
  
  // Hủy tiến trình đang chạy nếu có
  if (isStudioRendering || (studioProgress && studioProgress.status === 'rendering')) {
    killActiveRenderProcesses();
  }
  
  // Reset trạng thái điều phối
  isStudioRendering = false;
  activeRenderId = null;
  studioProgress = {
    status: 'idle',
    percent: 0,
    step: 'Hàng đợi trống',
    error: null
  };
  currentActiveTask = null;
  
  // Xóa toàn bộ các phần tử trong hàng đợi
  renderQueue.length = 0;
  
  return res.json({ success: true, message: 'Đã xóa sạch hàng đợi thành công.' });
});

app.post('/api/cancel-render', (req, res) => {
  if (isStudioRendering || (studioProgress && studioProgress.status === 'rendering')) {
    console.log('[Studio Render] Nhận yêu cầu hủy tiến trình render hiện tại...');
    killActiveRenderProcesses();
    isStudioRendering = false;
    activeRenderId = null;
    studioProgress = {
      status: 'idle',
      percent: 0,
      step: 'Đã hủy kết xuất',
      error: null
    };

    if (currentActiveTask) {
      currentActiveTask.status = 'failed';
      currentActiveTask.step = 'Đã bị hủy';
      currentActiveTask = null;
      // Chạy tác vụ tiếp theo sau khi dọn dẹp
      setTimeout(() => {
        processNextRenderTask();
      }, 1500);
    }

    if (global.activeRenderRes) {
      try {
        global.activeRenderRes.status(400).json({ error: 'Render đã bị hủy.' });
      } catch (e) {}
      global.activeRenderRes = null;
    }
  }
  res.json({ success: true, message: 'Đã hủy render thành công.' });
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
// API: Get auto-update status
app.get('/api/update-status', (req, res) => {
  res.json(global.updateStatus || { status: 'idle', percent: 0, error: null });
});

// API: Quit and install update
app.post('/api/quit-and-install', (req, res) => {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
    res.json({ success: true });
  } catch (err) {
    console.error('Lỗi khi thực hiện quitAndInstall:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function startServer(preferredPort = 3456) {
  return new Promise(async (resolve, reject) => {
    try {
      const port = await findAvailablePort(preferredPort);
      const server = app.listen(port, '127.0.0.1', () => {
        console.log(`\n🚀 YouTube Shorts Downloader đang chạy tại:`);
        console.log(`   http://127.0.0.1:${port}\n`);
        resolve({ server, port });
      });
      
      // Vô hiệu hóa timeouts cho server để tránh ngắt kết nối khi render video dài hoặc lồng tiếng nhiều câu thoại
      server.timeout = 0; 
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      // Giữ keepAliveTimeout mặc định nhỏ (5 giây) để tránh rò rỉ socket/port (ERR_NO_BUFFER_SPACE)
      server.keepAliveTimeout = 5000;

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
