const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MediaCrawlerAdapter, lastJsonLine, countMediaFiles } = require('./mediacrawler-adapter');
const { normalizeCrawlRequest } = require('./crawler-input-normalizer');

const PLATFORM_CODES = Object.freeze({
  youtube: 'yt',
  tiktok: 'tt',
  facebook: 'fb',
  instagram: 'ig',
  twitter: 'tw',
  reddit: 'rd'
});

const DATA_FOLDERS = Object.freeze({
  youtube: 'youtube',
  tiktok: 'tiktok',
  facebook: 'facebook',
  instagram: 'instagram',
  twitter: 'twitter',
  reddit: 'reddit'
});

const LOGIN_PLATFORMS = new Set(['tiktok', 'facebook', 'instagram', 'twitter']);

function mapMode(mode) {
  return mode === 'chase' ? 'bo' : mode;
}

function mapRedditSort(sort) {
  return ({ relevance: 'relevance', likes: 'top', views: 'top', newest: 'new' })[sort] || 'relevance';
}

function mapRedditTime(days) {
  const value = Number(days || 0);
  if (value <= 0) return 'all';
  if (value <= 1) return 'day';
  if (value <= 7) return 'week';
  if (value <= 31) return 'month';
  return 'year';
}

function mapPreviewItem(item, platform) {
  const id = String(item.id || '');
  const metric = Number(String(item.like || '').replace(/[^0-9.]/g, '')) || 0;
  let url = String(item.url || '');
  if (platform === 'youtube' && url && !/^https?:/i.test(url)) url = `https://www.youtube.com/watch?v=${id || url}`;
  return {
    id,
    title: String(item.title || `Video ${id}`),
    thumbnail: String(item.thumb || ''),
    url,
    sourceUrl: url,
    uploader: String(item.nick || ''),
    likeCount: platform === 'tiktok' ? metric : 0,
    viewCount: metric,
    timestamp: Number(item.time) || 0,
    duration: Number(item.duration) > 0 ? Number(item.duration) : null,
    mediaType: item.loai || 'video',
    imageCount: Number(item.so_anh) || 0,
    platform,
    engine: 'Video Studio yt-dlp'
  };
}

function readDownloadArchive(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

class ProjectYtDlpAdapter extends MediaCrawlerAdapter {
  status() {
    const missing = [];
    if (!fs.existsSync(this.python)) missing.push(this.python);
    const script = path.join(this.appRoot, 'tai_ytdlp.py');
    if (!fs.existsSync(script)) missing.push(script);
    return {
      available: missing.length === 0,
      engine: 'Video Studio yt-dlp',
      appRoot: this.appRoot,
      python: this.python,
      browserDataDir: this.browserDataDir,
      dataDir: this.dataDir,
      supportedPlatforms: Object.keys(PLATFORM_CODES),
      previewPlatforms: ['youtube', 'tiktok', 'facebook', 'instagram'],
      missing
    };
  }

  supports(platform) {
    return Boolean(PLATFORM_CODES[String(platform || '').toLowerCase()]);
  }

  _assertAvailable() {
    const state = this.status();
    if (!state.available) throw new Error(`Video Studio yt-dlp chưa sẵn sàng. Thiếu: ${state.missing.join(', ')}`);
  }

  needsLogin(platform) {
    return LOGIN_PLATFORMS.has(String(platform || '').toLowerCase());
  }

  async preview({ platform, mode, input, count, sort = '', timeDays = 0, onLog }) {
    ({ platform, mode, input } = normalizeCrawlRequest({ platform, mode, input }));
    const code = PLATFORM_CODES[platform];
    if (!code) throw new Error(`Video Studio yt-dlp không hỗ trợ ${platform}.`);
    if (!['youtube', 'tiktok', 'facebook', 'instagram'].includes(platform)) {
      throw new Error(`${platform} không hỗ trợ xem trước trong tai_ytdlp.py; hãy dùng Cào hết hoặc Theo link.`);
    }
    if (platform === 'facebook' && mode !== 'creator') {
      throw new Error('Facebook chỉ xem trước theo kênh Page; tải một video bằng chế độ Theo link.');
    }
    if (platform === 'instagram' && !['creator', 'detail'].includes(mode)) {
      throw new Error('Instagram chỉ xem trước theo kênh hoặc theo link.');
    }
    if (!['search', 'creator', 'detail'].includes(mode)
      || (mode === 'detail' && platform !== 'instagram')) {
      throw new Error(`Chế độ ${mode} không hỗ trợ xem trước bằng tai_ytdlp.py.`);
    }
    const requestedCount = platform === 'youtube' && mode === 'search' ? Math.min(500, Math.max(count, count * 3)) : count;
    const args = ['--list', '--platform', code, '--type', mapMode(mode), '--input', String(input || '').trim(),
      '--count', String(requestedCount)];
    if (platform === 'reddit') {
      args.push('--sort', mapRedditSort(sort), '--time', mapRedditTime(timeDays));
    }
    const previewLog = (line, level) => {
      if (!String(line || '').trim().startsWith('{')) onLog?.(line, level);
    };
    const result = await this._run(path.join(this.appRoot, 'tai_ytdlp.py'), args, {
      onLog: previewLog,
      timeoutMs: 30 * 60 * 1000
    });
    const payload = lastJsonLine(result.stdout);
    if (!payload) throw new Error('tai_ytdlp.py không trả về JSON xem trước hợp lệ.');
    if (!payload.ok) throw new Error(payload.msg || 'Không lấy được danh sách xem trước.');
    const archive = readDownloadArchive(path.join(this.dataDir, DATA_FOLDERS[platform], '_da_tai.txt'));
    return (payload.items || [])
      .map((item) => mapPreviewItem(item, platform))
      .map((item) => ({
        ...item,
        downloaded: archive.some((key) => key === item.id || key === item.url || key.endsWith(` ${item.id}`))
      }))
      .filter((item) => !(platform === 'youtube' && mode === 'search' && /youtube\.com\/(?:channel\/|@|c\/|user\/)/i.test(item.url)))
      .slice(0, count);
  }

  async crawl(config, hooks = {}) {
    const request = normalizeCrawlRequest(config);
    const platform = request.platform;
    const code = PLATFORM_CODES[platform];
    if (!code) throw new Error(`Video Studio yt-dlp không hỗ trợ ${platform}.`);
    const outputRoot = path.resolve(request.outputDir || this.dataDir);
    const platformDirectory = path.join(outputRoot, DATA_FOLDERS[platform] || platform);
    const beforeCount = countMediaFiles(platformDirectory);
    const args = ['--platform', code, '--type', mapMode(request.mode),
      '--input', request.input, '--count', String(request.count || 20)];
    if (platform === 'reddit') {
      args.push('--sort', mapRedditSort(request.sort), '--time', mapRedditTime(request.timeDays));
    }
    if (request.cookies) args.push('--cookies', request.cookies);
    else if (request.cookiesBrowser) args.push('--cookies-browser', request.cookiesBrowser);
    await this._run(path.join(this.appRoot, 'tai_ytdlp.py'), args, {
      env: { MC_DATA_DIR: outputRoot },
      onLog: hooks.onLog,
      onProcess: hooks.onProcess,
      onTimeout: hooks.onTimeout,
      timeoutMs: Number(request.timeoutMs || 2 * 60 * 60 * 1000)
    });
    const completedVideos = Math.max(0, countMediaFiles(platformDirectory) - beforeCount);
    return {
      success: true,
      engine: 'Video Studio yt-dlp',
      outputDir: path.join(platformDirectory, 'videos'),
      completedVideos
    };
  }

  async checkLogin(platform) {
    if (!this.needsLogin(platform)) return 'na';
    const code = PLATFORM_CODES[platform];
    return this._run(path.join(this.appRoot, 'kiem_tra_login.py'), [code], {})
      .then(({ stdout }) => {
        const match = stdout.match(/LOGIN_CHECK_DONE\s+({.*})/);
        if (!match) return 'unknown';
        try { return JSON.parse(match[1])[code] || 'unknown'; } catch (_) { return 'unknown'; }
      })
      .catch(() => 'unknown');
  }

  async checkLogins(platforms) {
    const requested = [...new Set((platforms || []).filter((platform) => this.needsLogin(platform)))];
    if (!requested.length) return {};
    const codes = requested.map((platform) => PLATFORM_CODES[platform]);
    return this._run(path.join(this.appRoot, 'kiem_tra_login.py'), codes, {})
      .then(({ stdout }) => {
        const match = stdout.match(/LOGIN_CHECK_DONE\s+({.*})/);
        const raw = match ? JSON.parse(match[1]) : {};
        return Object.fromEntries(requested.map((platform) => [platform, raw[PLATFORM_CODES[platform]] || 'unknown']));
      })
      .catch(() => Object.fromEntries(requested.map((platform) => [platform, 'unknown'])));
  }

  openLogin(platform, onLog) {
    if (!this.needsLogin(platform)) throw new Error(`${platform} không bắt buộc đăng nhập.`);
    this._assertAvailable();
    const code = PLATFORM_CODES[platform];
    const proc = spawn(this.python, [path.join(this.appRoot, 'mo_dang_nhap.py'), code], {
      cwd: this.appRoot,
      env: this._environment(),
      windowsHide: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', (chunk) => onLog?.(chunk.toString('utf8')));
    proc.stderr.on('data', (chunk) => onLog?.(chunk.toString('utf8')));
    return { started: true, pid: proc.pid, platform, engine: 'Video Studio yt-dlp' };
  }
}

module.exports = { ProjectYtDlpAdapter, PLATFORM_CODES, DATA_FOLDERS, mapMode, mapPreviewItem, mapRedditSort, mapRedditTime };
