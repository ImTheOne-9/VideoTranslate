const path = require('path');
const fs = require('fs');
const os = require('os');
const child_process = require('child_process');
const { getAppDataRoot } = require('./path-helper');

const isPackaged = __dirname.includes('app.asar');

// Helper phân giải đường dẫn tài nguyên ngoài (extraResources)
function getExtPath(...parts) {
  const base = isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  return path.join(base, ...parts);
}

const TOOLS_DIR = getExtPath('tools');

// Thiết lập thư mục lưu trữ dữ liệu (downloads, uploads)
const appDataRoot = getAppDataRoot(path.join(__dirname, '..'));
const DOWNLOADS_DIR = path.join(appDataRoot, 'downloads');
const UPLOADS_DIR = path.join(appDataRoot, 'uploads');

const VOICES_DIR = path.join(UPLOADS_DIR, 'voices');
const MUSIC_DIR = path.join(UPLOADS_DIR, 'music');
const SUBTITLES_DIR = path.join(UPLOADS_DIR, 'subtitles');
const TMP_UPLOADS_DIR = path.join(UPLOADS_DIR, 'tmp');
const RENDERS_DIR = path.join(appDataRoot, 'renders');
const PROJECTS_DIR = path.join(appDataRoot, 'projects');
const MODELS_DIR = path.join(appDataRoot, 'models');

// Thư mục tools cho dependency tải SAU (whisper_onnx.exe, CUDA DLLs)
// Lưu ở data dir (NGOÀI thư mục cài đặt) để auto-update không làm mất -> không phải tải lại
const DATA_TOOLS_DIR = path.join(appDataRoot, 'tools');
const WHISPER_ONNX_PATH = path.join(DATA_TOOLS_DIR, 'whisper_onnx.exe');

// Đảm bảo toàn bộ thư mục dữ liệu tồn tại trước khi app dùng (fix lỗi ENOENT khi cài mới)
function ensureDataDirectories() {
  const dirs = [appDataRoot, DOWNLOADS_DIR, UPLOADS_DIR, VOICES_DIR, MUSIC_DIR, SUBTITLES_DIR, TMP_UPLOADS_DIR, RENDERS_DIR, PROJECTS_DIR, MODELS_DIR, DATA_TOOLS_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); console.log(`[Init] Đã tạo thư mục: ${dir}`); }
      catch (e) { console.error(`[Init] Lỗi tạo thư mục ${dir}: ${e.message}`); }
    }
  }
}

const FFMPEG_PATH = getExtPath('tools', 'ffmpeg.exe');
const YTDLP_PATH = getExtPath('tools', 'yt-dlp.exe');
const OMNIVOICE_CLI_PATH = process.env.OMNIVOICE_CLI_PATH || getExtPath('tools', 'omnivoice', 'omnivoice-cli.exe');
const NLLB_TRANSLATE_PATH = getExtPath('tools', 'nllb_translate.exe');
const OMNIVOICE_MODEL_PATH = process.env.OMNIVOICE_MODEL_PATH || path.join(MODELS_DIR, 'omnivoice-q8_0.gguf');

// Global state container
const state = {
  activeProcesses: new Set(),
  activeRenderProcesses: new Set(),
  isStudioRendering: false,
  activeRenderId: null,
  studioProgress: { status: 'idle', percent: 0, step: '', error: null },
  renderQueue: [],
  currentActiveTask: null,
  runningPort: 3456
};

// Process management
function registerChildProcess(proc) {
  if (!proc) return;
  state.activeProcesses.add(proc);
  if (state.isStudioRendering) {
    state.activeRenderProcesses.add(proc);
  }
  const cleanUp = () => {
    state.activeProcesses.delete(proc);
    state.activeRenderProcesses.delete(proc);
  };
  proc.on('close', cleanUp);
  proc.on('exit', cleanUp);
  proc.on('error', cleanUp);
}
global.registerChildProcess = registerChildProcess;

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  // Đóng pipe trước để Node không chờ dữ liệu trên pipe chết -> tránh block event loop
  ['stdin', 'stdout', 'stderr'].forEach(s => {
    try { if (proc[s] && !proc[s].destroyed) proc[s].destroy(); } catch (e) {}
  });
  try {
    if (process.platform === 'win32') {
      // execSync: đợi taskkill xong (không fire-and-forget) -> tiến trình chết hẳn
      const { execSync } = require('child_process');
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', timeout: 5000 });
    } else {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }
  } catch (e) {
    // taskkill fail (tiến trình đã chết) -> thử kill trực tiếp
    try { proc.kill('SIGKILL'); } catch (e2) {}
  }
  // KHÔNG dùng removeAllListeners — sẽ làm hỏng callback nội bộ của execFile
  // Thay vào đó: đóng pipe (đã làm ở trên) để Node fire 'close' sớm
}

function killActiveRenderProcesses() {
  console.log(`[Studio Render] Hủy toàn bộ tiến trình render cũ (${state.activeRenderProcesses.size})...`);
  for (const proc of state.activeRenderProcesses) {
    if (!proc) continue;
    console.log(`[Studio Render] Đang kill tiến trình render cũ PID: ${proc.pid}`);
    // Force close tất cả stream trước khi kill
    ['stdin', 'stdout', 'stderr'].forEach(s => {
      try { if (proc[s] && !proc[s].destroyed) proc[s].destroy(); } catch (e) {}
    });
    killProcessTree(proc);
  }
  state.activeRenderProcesses.clear();
}

function killAllActiveProcesses() {
  console.log(`Bắt đầu tắt toàn bộ tiến trình con đang hoạt động (${state.activeProcesses.size})...`);
  for (const proc of state.activeProcesses) {
    console.log(`Đang kill tiến trình PID: ${proc.pid}`);
    killProcessTree(proc);
  }
  state.activeProcesses.clear();
}

const customTempDir = isPackaged 
  ? path.join(os.homedir(), 'VideoStudio', 'temp_env')
  : path.join(__dirname, '..', 'temp_env');

if (!fs.existsSync(customTempDir)) {
  try {
    fs.mkdirSync(customTempDir, { recursive: true });
  } catch (e) {
    console.error('Failed to create customTempDir:', e.message);
  }
}

// CLI runners
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

// Custom execFile
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

function runYtDlp(args, options = {}, retryCount = 0) {
  if (typeof options === 'number') {
    retryCount = options;
    options = {};
  }
  const actualArgs = [...args];
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
        if (errStr.includes('Unable to extract universal data for rehydration') && retryCount < 2) {
          console.log(`[Retry ${retryCount + 1}] Retrying yt-dlp due to TikTok API block...`);
          const newArgs = [...args];
          for (let i = 0; i < newArgs.length; i++) {
            if (newArgs[i].includes('tiktok:api_hostname')) {
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

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeout || (30 * 60 * 1000);
    const proc = execFile(command, args, { maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    const handle = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { killProcessTree(proc); } catch (e) {}
      reject(new Error(`Timeout sau ${Math.round(timeoutMs/60000)} phút: ${command}`));
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      if (settled) return;
      if (signal === 'SIGKILL' || signal === 'SIGTERM' || code === null) {
        settled = true;
        clearTimeout(handle);
        reject(new Error(`Tiến trình bị hủy (signal=${signal})`));
      }
    });
  });
}

async function runOmnivoiceCLI(args, options = {}, omiDevice = 'cpu', skipCheck = false) {
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

  if (!skipCheck && !state.isStudioRendering) {
    throw new Error('Đã hủy kết xuất (OmniVoice bị ngắt)');
  }
  try {
    return await runExecFile(OMNIVOICE_CLI_PATH, args, { ...options, timeout: 10 * 60 * 1000 });
  } catch (err) {
    if (!skipCheck && (!state.isStudioRendering || (err.message && err.message.includes('hủy')))) {
      throw err;
    }
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

// Helpers
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
  result = result.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
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
  } else if (url.includes('douyin.com') || url.includes('iesdouyin.com')) {
    args.push('--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    args.push('--extractor-args', 'douyin:mobile_api=1');
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
  cleaned = cleaned.replace(/^[\d\.,KMBkmb\s·]+(views|reactions|likes|shares|comments).*?\|\s*/i, '');
  const parts = cleaned.split(' | ');
  if (parts.length > 1) {
    const lastPart = parts[parts.length - 1];
    if (lastPart.length < 40) {
      parts.pop();
      cleaned = parts.join(' | ');
    }
  }
  return cleaned.trim() || 'Untitled';
}

// Check url pattern
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
  // BẢO MẬT: path.basename() loại bỏ mọi ký tự đường dẫn để chống path traversal
  const safeFilename = path.basename(filename);
  if (!safeFilename || safeFilename === '.' || safeFilename === '..') return null;
  const resolved = path.resolve(root, safeFilename);
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

function updateStudioProgress(percent, step, status = 'rendering') {
  state.studioProgress = {
    status,
    percent,
    step,
    error: null
  };
  if (state.currentActiveTask) {
    state.currentActiveTask.percent = percent;
    state.currentActiveTask.step = step;
    state.currentActiveTask.status = status;
  }
}
global.updateStudioProgress = updateStudioProgress;
// Getter để whisper-helper và module khác check trạng thái render mà không cần require shared-state (tránh circular dep)
Object.defineProperty(global, 'isStudioRendering', { get: () => state.isStudioRendering, configurable: true });

module.exports = {
  TOOLS_DIR,
  DOWNLOADS_DIR,
  UPLOADS_DIR,
  VOICES_DIR,
  MUSIC_DIR,
  SUBTITLES_DIR,
  TMP_UPLOADS_DIR,
  RENDERS_DIR,
  PROJECTS_DIR,
  MODELS_DIR,
  FFMPEG_PATH,
  YTDLP_PATH,
  OMNIVOICE_CLI_PATH,
  NLLB_TRANSLATE_PATH,
  OMNIVOICE_MODEL_PATH,
  state,
  registerChildProcess,
  killProcessTree,
  killActiveRenderProcesses,
  killAllActiveProcesses,
  spawn,
  execFile,
  runYtDlp,
  runExecFile,
  runOmnivoiceCLI,
  extractUrl,
  removeVietnameseTones,
  getCustomExtractorArgs,
  cleanupTempFiles,
  cleanVideoTitle,
  isValidVideoUrl,
  safeFileName,
  getUniqueFilePath,
  moveUploadedFile,
  listFiles,
  resolveAssetPath,
  getVideoDimensions,
  updateStudioProgress,
  ensureDataDirectories,
  DATA_TOOLS_DIR,
  WHISPER_ONNX_PATH
};
