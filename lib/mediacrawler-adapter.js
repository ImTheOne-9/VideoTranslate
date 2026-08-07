const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_APP_ROOT = 'D:\\New folder (3)\\New folder\\ViralCrawl\\resources\\app-src';
const DEFAULT_RUNTIME_ROOT = path.join(process.env.APPDATA || '', 'viralcrawl-desktop');
const PLATFORM_CODES = Object.freeze({
  douyin: 'dy',
  bilibili: 'bili',
  xiaohongshu: 'xhs',
  rednote: 'rednote',
  weibo: 'wb'
});
const DATA_FOLDERS = Object.freeze({ douyin: 'douyin', bilibili: 'bili', xiaohongshu: 'xhs', rednote: 'rednote', weibo: 'weibo' });
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.jpg', '.jpeg', '.png', '.webp']);

function countMediaFiles(directory) {
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) count += countMediaFiles(fullPath);
    else if (MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) count += 1;
  }
  return count;
}

function lastJsonLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try { return JSON.parse(lines[index]); } catch (_) {}
  }
  return null;
}

function mapPreviewItem(item, platform) {
  const id = String(item.id || '');
  return {
    id,
    title: String(item.title || `Video ${id}`),
    thumbnail: String(item.thumb || ''),
    url: String(item.url || id),
    sourceUrl: String(item.url || id),
    uploader: String(item.nick || ''),
    likeCount: Number(String(item.like || '').replace(/[^0-9.]/g, '')) || 0,
    viewCount: Number(String(item.view || '').replace(/[^0-9.]/g, '')) || 0,
    timestamp: Number(item.time) || 0,
    mediaType: item.loai || (item.video ? 'video' : 'image'),
    imageCount: Number(item.so_anh) || 0,
    platform,
    engine: 'MediaCrawler'
  };
}

class MediaCrawlerAdapter {
  constructor(options = {}) {
    this.appRoot = path.resolve(options.appRoot || process.env.MEDIACRAWLER_APP_ROOT || DEFAULT_APP_ROOT);
    this.crawlerRoot = path.join(this.appRoot, 'MediaCrawler');
    this.runtimeRoot = path.resolve(options.runtimeRoot || process.env.MEDIACRAWLER_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT);
    this.python = path.resolve(options.python || process.env.MEDIACRAWLER_PYTHON
      || path.join(this.runtimeRoot, 'runtime', 'venv', 'Scripts', 'python.exe'));
    this.browserDataDir = path.resolve(options.browserDataDir || process.env.MEDIACRAWLER_BROWSER_DATA
      || path.join(this.runtimeRoot, 'browser_data'));
    this.dataDir = path.resolve(options.dataDir || process.env.MEDIACRAWLER_DATA_DIR
      || path.join(this.runtimeRoot, 'data'));
  }

  status() {
    const missing = [];
    if (!fs.existsSync(this.python)) missing.push(this.python);
    if (!fs.existsSync(path.join(this.crawlerRoot, 'main.py'))) missing.push(path.join(this.crawlerRoot, 'main.py'));
    if (!fs.existsSync(path.join(this.appRoot, 'tim_anh.py'))) missing.push(path.join(this.appRoot, 'tim_anh.py'));
    return {
      available: missing.length === 0,
      engine: 'MediaCrawler',
      appRoot: this.appRoot,
      python: this.python,
      browserDataDir: this.browserDataDir,
      dataDir: this.dataDir,
      supportedPlatforms: Object.keys(PLATFORM_CODES),
      missing
    };
  }

  supports(platform) {
    return Boolean(PLATFORM_CODES[String(platform || '').toLowerCase()]);
  }

  _assertAvailable() {
    const state = this.status();
    if (!state.available) throw new Error(`MediaCrawler chưa sẵn sàng. Thiếu: ${state.missing.join(', ')}`);
  }

  _environment(extra = {}) {
    return {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      LIC_CACHE_DIR: this.runtimeRoot,
      KHACH_DB_DIR: this.runtimeRoot,
      MC_BROWSER_DATA_DIR: this.browserDataDir,
      MC_DATA_DIR: this.dataDir,
      ...extra
    };
  }

  _run(script, args, options = {}) {
    this._assertAvailable();
    return new Promise((resolve, reject) => {
      const proc = spawn(this.python, [script, ...args], {
        cwd: options.cwd || this.appRoot,
        env: this._environment(options.env),
        windowsHide: options.windowsHide !== false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeout = options.timeoutMs ? setTimeout(() => {
        timedOut = true;
        options.onTimeout?.(proc);
        try { proc.kill(); } catch (_) {}
      }, options.timeoutMs) : null;
      timeout?.unref?.();
      const onChunk = (chunk, isError = false) => {
        const value = chunk.toString('utf8');
        if (isError) stderr += value;
        else stdout += value;
        for (const line of value.split(/\r?\n/).filter(Boolean)) options.onLog?.(line, isError ? 'error' : 'info');
      };
      proc.stdout.on('data', (chunk) => onChunk(chunk));
      proc.stderr.on('data', (chunk) => onChunk(chunk, true));
      proc.once('error', reject);
      proc.once('close', (code, signal) => {
        if (timeout) clearTimeout(timeout);
        if (timedOut) return reject(Object.assign(new Error('MediaCrawler chạy quá 2 giờ nên đã tự dừng.'), { reason: 'timeout' }));
        if (signal) return reject(Object.assign(new Error('Đã hủy MediaCrawler.'), { reason: 'cancelled' }));
        if (code !== 0) return reject(new Error((stderr || stdout || `MediaCrawler dừng với mã ${code}`).trim().slice(-1200)));
        resolve({ stdout, stderr, code });
      });
      options.onProcess?.(proc);
    });
  }

  async preview({ platform, mode, input, count, onLog }) {
    const code = PLATFORM_CODES[platform];
    if (!code) throw new Error(`MediaCrawler không hỗ trợ ${platform}.`);
    if (!['search', 'creator'].includes(mode)) throw new Error(`MediaCrawler preview chưa hỗ trợ chế độ ${mode}.`);
    const args = ['--platform', code, '--type', mode, '--count', String(count), '--headless', 'yes'];
    args.push(mode === 'creator' ? '--creator' : '--keyword', String(input || '').trim());
    const result = await this._run(path.join(this.appRoot, 'tim_anh.py'), args, { onLog });
    const payload = lastJsonLine(result.stdout);
    if (!payload) throw new Error('MediaCrawler không trả về JSON xem trước hợp lệ.');
    if (!payload.ok) throw new Error(payload.msg || 'MediaCrawler không lấy được danh sách video.');
    return (payload.items || []).map((item) => mapPreviewItem(item, platform));
  }

  async crawl(config, hooks = {}) {
    const platform = String(config.platform || '').toLowerCase();
    const code0 = PLATFORM_CODES[platform];
    if (!code0) throw new Error(`MediaCrawler không hỗ trợ ${platform}.`);
    const mode = String(config.mode || 'search').toLowerCase();
    const code = platform === 'rednote' ? 'xhs' : code0;
    const args = ['main.py', '--platform', code, '--lt', 'qrcode', '--headless', 'yes',
      '--type', mode === 'detail' ? 'detail' : mode,
      '--crawler_max_notes_count', String(config.count || 20), '--get_comment', 'no', '--save_data_option', 'jsonl'];
    if (mode === 'search') args.push('--keywords', String(config.input || '').trim());
    else if (mode === 'creator' || mode === 'chase') args.push('--creator_id', String(config.input || '').trim());
    else args.push('--specified_id', String(config.input || '').trim());
    const deepSupported = config.deepNew && (
      (platform === 'douyin' && ['search', 'creator'].includes(mode))
      || (platform === 'bilibili' && mode === 'search')
    );
    const env = {
      MC_DATA_DIR: path.resolve(config.outputDir || this.dataDir),
      MC_GET_MEDIAS: '1',
      MC_DEEP_NEW: deepSupported ? '1' : '0',
      MC_DEEP_PAGE_CAP: deepSupported ? '40' : '1'
    };
    if (platform === 'rednote' || platform === 'xiaohongshu') {
      env.MC_XHS_INTL = platform === 'rednote' ? '1' : '0';
      env.MC_XHS_PROFILE = 'xhs_user_data_dir';
      env.MC_XHS_LEAF = platform === 'rednote' ? 'rednote' : 'xhs';
    }
    const mediaDirectory = path.join(env.MC_DATA_DIR, DATA_FOLDERS[platform] || platform);
    const beforeCount = countMediaFiles(mediaDirectory);
    await this._run('main.py', args.slice(1), {
      cwd: this.crawlerRoot,
      env,
      onLog: hooks.onLog,
      onProcess: hooks.onProcess,
      onTimeout: hooks.onTimeout,
      timeoutMs: Number(config.timeoutMs || 2 * 60 * 60 * 1000)
    });
    const completedVideos = Math.max(0, countMediaFiles(mediaDirectory) - beforeCount);
    return { success: true, engine: 'MediaCrawler', outputDir: mediaDirectory, completedVideos };
  }

  checkLogin(platform) {
    const code = PLATFORM_CODES[platform];
    if (!code) return Promise.resolve('unknown');
    return this._run(path.join(this.appRoot, 'kiem_tra_login.py'), [code], {})
      .then(({ stdout }) => {
        const match = stdout.match(/LOGIN_CHECK_DONE\s+({.*})/);
        if (!match) return 'unknown';
        try { return JSON.parse(match[1])[code] || 'unknown'; } catch (_) { return 'unknown'; }
      })
      .catch(() => 'unknown');
  }

  checkLogins(platforms = Object.keys(PLATFORM_CODES)) {
    const requested = [...new Set(platforms.map((platform) => String(platform || '').toLowerCase()))];
    const codes = [...new Set(requested.map((platform) => PLATFORM_CODES[platform]).filter(Boolean))];
    if (!codes.length) return Promise.resolve({});
    return this._run(path.join(this.appRoot, 'kiem_tra_login.py'), codes, {})
      .then(({ stdout }) => {
        const match = stdout.match(/LOGIN_CHECK_DONE\s+({.*})/);
        const raw = match ? JSON.parse(match[1]) : {};
        return Object.fromEntries(requested.map((platform) => [platform, raw[PLATFORM_CODES[platform]] || 'unknown']));
      })
      .catch(() => Object.fromEntries(requested.map((platform) => [platform, 'unknown'])));
  }

  openLogin(platform, onLog) {
    this._assertAvailable();
    const code = PLATFORM_CODES[platform];
    if (!code) throw new Error(`Không hỗ trợ đăng nhập ${platform}.`);
    const proc = spawn(this.python, [path.join(this.appRoot, 'mo_dang_nhap.py'), code], {
      cwd: this.appRoot,
      env: this._environment(),
      windowsHide: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', (chunk) => onLog?.(chunk.toString('utf8')));
    proc.stderr.on('data', (chunk) => onLog?.(chunk.toString('utf8')));
    return { started: true, pid: proc.pid, platform, engine: 'MediaCrawler' };
  }
}

module.exports = { MediaCrawlerAdapter, PLATFORM_CODES, lastJsonLine, mapPreviewItem, countMediaFiles };
