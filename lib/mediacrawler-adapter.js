const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  getCrawlerPaths,
  ensureCrawlerDirectories,
  crawlerEnvironment
} = require('./crawler-paths');
const {
  normalizeCrawlRequest,
  normalizeBilibiliMainlandInput,
  mapDouyinSort,
  mapDouyinCreatorSort
} = require('./crawler-input-normalizer');
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
  const sourceUrl = String(item.link || item.url || id);
  return {
    id,
    title: String(item.title || `Video ${id}`),
    thumbnail: String(item.thumb || ''),
    url: String(item.url || sourceUrl),
    sourceUrl,
    uploader: String(item.nick || ''),
    likeCount: Number(String(item.like || '').replace(/[^0-9.]/g, '')) || 0,
    viewCount: Number(String(item.view || '').replace(/[^0-9.]/g, '')) || 0,
    timestamp: Number(item.time) || 0,
    mediaType: item.loai || (item.video ? 'video' : 'image'),
    imageCount: Number(item.so_anh) || 0,
    downloaded: Boolean(item.da_tai || item.downloaded),
    seenBefore: Boolean(item.da_thay),
    platform,
    engine: 'MediaCrawler'
  };
}

function readKeyFile(filePath) {
  try {
    return new Set(fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function appendKeyFile(filePath, keys) {
  const merged = readKeyFile(filePath);
  for (const key of keys || []) if (String(key || '').trim()) merged.add(String(key).trim());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${[...merged].join('\n')}${merged.size ? '\n' : ''}`, 'utf8');
}

function appendBrowserHistory(root, platform, source, links, downloadedIds) {
  const ids = new Set((downloadedIds || []).map((value) => String(value || '').trim()).filter(Boolean));
  if (!ids.size) return 0;
  const linkById = new Map();
  for (const link of links || []) {
    const value = String(link || '').trim();
    const id = value.match(/\/(?:explore|discovery\/item|profile\/[^/]+)\/([0-9a-f]{16,})/i)?.[1] || '';
    if (id) linkById.set(id, value);
  }
  const sourceMode = ['search', 'creator', 'detail', 'chase'].includes(String(source.sourceMode || source.mode || '').toLowerCase())
    ? String(source.sourceMode || source.mode).toLowerCase() : 'detail';
  const directory = path.join(root, platform, 'jsonl');
  const file = path.join(directory, `${sourceMode}_contents_${new Date().toISOString().slice(0, 10)}.jsonl`);
  const now = Math.floor(Date.now() / 1000);
  const rows = [...ids].map((id) => JSON.stringify({
    note_id: id,
    title: `Video ${id}`,
    note_url: linkById.get(id) || (platform === 'rednote'
      ? `https://www.rednote.com/explore/${id}`
      : `https://www.xiaohongshu.com/explore/${id}`),
    last_modify_ts: now,
    source_mode: sourceMode,
    source_input: String(source.sourceInput || source.input || ''),
    source_name: String(source.sourceName || '')
  }));
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(file, `${rows.join('\n')}\n`, 'utf8');
  return rows.length;
}

function migrateLegacyBilibiliArchive(dataDir) {
  const legacyDirectory = path.join(dataDir, 'bilibili');
  const legacyArchive = path.join(legacyDirectory, '_da_tai_ids.txt');
  if (!fs.existsSync(legacyArchive)) return { migrated: false, count: 0 };
  const canonicalArchive = path.join(dataDir, 'bili', '_da_tai_ids.txt');
  const legacyKeys = readKeyFile(legacyArchive);
  appendKeyFile(canonicalArchive, legacyKeys);
  fs.unlinkSync(legacyArchive);
  try {
    if (fs.readdirSync(legacyDirectory).length === 0) fs.rmdirSync(legacyDirectory);
  } catch (_) {}
  return { migrated: true, count: legacyKeys.size, archive: canonicalArchive };
}

function snapshotJsonlOffsets(directory) {
  const snapshot = new Map();
  if (!fs.existsSync(directory)) return snapshot;
  for (const name of fs.readdirSync(directory)) {
    if (!/contents.*\.jsonl$/i.test(name)) continue;
    const filePath = path.join(directory, name);
    try { snapshot.set(filePath, { offset: fs.statSync(filePath).size, carry: '' }); } catch (_) {}
  }
  return snapshot;
}

function readAppendedJsonlRows(directory, snapshot, flush = false) {
  if (!fs.existsSync(directory)) return [];
  const rows = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/contents.*\.jsonl$/i.test(name)) continue;
    const filePath = path.join(directory, name);
    let state = snapshot.get(filePath) || { offset: 0, carry: '' };
    let size;
    try { size = fs.statSync(filePath).size; } catch (_) { continue; }
    if (size < state.offset) state = { offset: 0, carry: '' };
    let appended = '';
    if (size > state.offset) {
      const length = size - state.offset;
      const buffer = Buffer.allocUnsafe(length);
      let handle;
      try {
        handle = fs.openSync(filePath, 'r');
        fs.readSync(handle, buffer, 0, length, state.offset);
        appended = buffer.toString('utf8');
      } catch (_) {
        continue;
      } finally {
        if (handle !== undefined) try { fs.closeSync(handle); } catch (_) {}
      }
    }
    const lines = `${state.carry}${appended}`.split(/\r?\n/);
    const carry = flush ? '' : (lines.pop() || '');
    if (flush && lines.at(-1) === '') lines.pop();
    for (const line of lines.filter(Boolean)) {
      try { rows.push(JSON.parse(line)); } catch (_) {}
    }
    snapshot.set(filePath, { offset: size, carry });
  }
  return rows;
}

function mapJsonlPreviewRow(row, platform) {
  const images = String(platform === 'douyin' ? row.note_download_url || '' : row.image_list || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (['xiaohongshu', 'rednote'].includes(platform)) {
    const video = Boolean(String(row.video_url || '').trim()) || row.type === 'video';
    return { id: String(row.note_id || ''), title: String(row.title || row.desc || '').trim().slice(0, 160),
      thumb: images[0] || '', loai: video ? 'video' : 'anh', video, so_anh: images.length,
      url: row.note_url || '', like: String(row.liked_count || ''), time: Number(row.time || row.create_time || 0), nick: row.nickname || '' };
  }
  if (platform === 'douyin') {
    const video = Boolean(String(row.video_download_url || '').trim());
    return { id: String(row.aweme_id || ''), title: String(row.title || row.desc || '').trim().slice(0, 160),
      thumb: row.cover_url || images[0] || '', loai: video ? 'video' : 'anh', video, so_anh: images.length,
      url: row.aweme_url || '', like: String(row.liked_count || ''), time: Number(row.create_time || 0), nick: row.nickname || '' };
  }
  if (platform === 'weibo') {
    return { id: String(row.note_id || ''), title: String(row.content || '').trim().slice(0, 160),
      thumb: images[0] || '', loai: 'anh', video: false, so_anh: images.length, url: String(row.note_id || ''),
      like: String(row.liked_count || ''), time: Number(row.create_time || row.time || 0), nick: row.nickname || '' };
  }
  if (platform === 'bilibili') {
    return { id: String(row.video_id || ''), title: String(row.title || row.desc || '').trim().slice(0, 160),
      thumb: String(row.video_cover_url || '').replace(/^http:\/\//i, 'https://'), loai: 'video', video: true, so_anh: 0,
      url: row.video_url || '', like: String(row.liked_count || ''), view: String(row.video_play_count || ''),
      time: Number(row.create_time || 0), nick: row.nickname || '' };
  }
  return null;
}

function splitCrawlerInputs(value) {
  return String(value || '').split(/[\s,，]+/).map((entry) => entry.trim()).filter(Boolean);
}

function safeDirectoryName(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80);
}

async function resolveBilibiliShortUrls(value, fetchImpl = global.fetch) {
  const normalized = normalizeBilibiliMainlandInput('bilibili', 'detail', String(value || ''));
  if (!/b23\.tv\//i.test(normalized) || typeof fetchImpl !== 'function') return normalized;
  const parts = splitCrawlerInputs(normalized);
  const resolved = [];
  for (const part of parts) {
    if (!/https?:\/\/b23\.tv\//i.test(part)) { resolved.push(part); continue; }
    try {
      const response = await fetchImpl(part, { method: 'HEAD', redirect: 'follow' });
      const target = String(response.url || '');
      const canonical = normalizeBilibiliMainlandInput('bilibili', 'detail', target);
      const match = canonical.match(/bilibili\.com\/video\/(BV[\w]+|av\d+)/i);
      if (!match) throw new Error('Link b23.tv không chuyển tới video Bilibili nội địa hợp lệ.');
      resolved.push(`https://www.bilibili.com/video/${match[1]}`);
    } catch (_) {
      if (_ instanceof Error && /chỉ hỗ trợ|BiliIntl|không chuyển tới/.test(_.message)) throw _;
      throw new Error(`Không mở rộng được link rút gọn Bilibili: ${part}`);
    }
  }
  return resolved.join('\n');
}

class MediaCrawlerAdapter {
  constructor(options = {}) {
    this.paths = getCrawlerPaths(options);
    this.appRoot = this.paths.appRoot;
    this.crawlerRoot = this.paths.crawlerRoot;
    this.runtimeRoot = this.paths.runtimeRoot;
    this.python = this.paths.python;
    this.browserDataDir = this.paths.browserDataDir;
    this.dataDir = this.paths.dataDir;
    this.fetchImpl = options.fetchImpl || global.fetch;
    try { migrateLegacyBilibiliArchive(this.dataDir); } catch (_) {}
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
    ensureCrawlerDirectories(this.paths);
    return crawlerEnvironment(this.paths, {
      LIC_CACHE_DIR: this.runtimeRoot,
      KHACH_DB_DIR: this.runtimeRoot,
      ...extra
    });
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
      let stdoutLogBuffer = '';
      let stderrLogBuffer = '';
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
        let buffer = (isError ? stderrLogBuffer : stdoutLogBuffer) + value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        if (isError) stderrLogBuffer = buffer;
        else stdoutLogBuffer = buffer;
        for (const line of lines.filter(Boolean)) {
          const level = /(?:\bERROR\b|Traceback|Exception)/i.test(line)
            ? 'error'
            : /(?:\bWARN(?:ING)?\b|⚠)/i.test(line) ? 'warn' : 'info';
          options.onLog?.(line, level);
        }
      };
      proc.stdout.on('data', (chunk) => onChunk(chunk));
      proc.stderr.on('data', (chunk) => onChunk(chunk, true));
      proc.once('error', reject);
      proc.once('close', (code, signal) => {
        if (timeout) clearTimeout(timeout);
        for (const line of [stdoutLogBuffer, stderrLogBuffer]) {
          if (!line) continue;
          const level = /(?:\bERROR\b|Traceback|Exception)/i.test(line)
            ? 'error'
            : /(?:\bWARN(?:ING)?\b|⚠)/i.test(line) ? 'warn' : 'info';
          options.onLog?.(line, level);
        }
        if (timedOut) return reject(Object.assign(new Error('MediaCrawler chạy quá 2 giờ nên đã tự dừng.'), { reason: 'timeout' }));
        if (signal) return reject(Object.assign(new Error('Đã hủy MediaCrawler.'), { reason: 'cancelled' }));
        if (code !== 0) return reject(new Error((stderr || stdout || `MediaCrawler dừng với mã ${code}`).trim().slice(-1200)));
        resolve({ stdout, stderr, code });
      });
      options.onProcess?.(proc);
    });
  }

  async preview({ platform, mode, input, count, onLog, onItem }) {
    const code = PLATFORM_CODES[platform];
    if (!code) throw new Error(`MediaCrawler không hỗ trợ ${platform}.`);
    if (!['search', 'creator', 'detail'].includes(mode)) throw new Error(`MediaCrawler preview chưa hỗ trợ chế độ ${mode}.`);
    if (platform === 'bilibili' && mode === 'detail') input = await resolveBilibiliShortUrls(input, this.fetchImpl);
    const args = ['--platform', code, '--type', mode, '--count', String(count), '--headless', 'yes'];
    args.push(mode === 'creator' ? '--creator' : mode === 'detail' ? '--detail' : '--keyword', String(input || '').trim());
    const previewLog = (line, level) => {
      const value = String(line || '').trim();
      if (value.startsWith('PREVIEW_ITEM ')) {
        try { onItem?.(mapPreviewItem(JSON.parse(value.slice('PREVIEW_ITEM '.length)), platform)); } catch (_) {}
        return;
      }
      if (!value.startsWith('{')) onLog?.(line, level);
    };
    const jsonlDirectory = path.join(this.dataDir, DATA_FOLDERS[platform], 'jsonl');
    const snapshot = snapshotJsonlOffsets(jsonlDirectory);
    const emitted = new Set();
    const pollRows = () => {
      for (const row of readAppendedJsonlRows(jsonlDirectory, snapshot)) {
        const mapped = mapJsonlPreviewRow(row, platform);
        if (!mapped?.id || emitted.has(mapped.id)) continue;
        emitted.add(mapped.id);
        onItem?.(mapPreviewItem(mapped, platform));
      }
    };
    const pollTimer = onItem ? setInterval(pollRows, 1500) : null;
    pollTimer?.unref?.();
    let result;
    try {
      result = await this._run(path.join(this.appRoot, 'tim_anh.py'), args, { onLog: previewLog });
      for (const row of readAppendedJsonlRows(jsonlDirectory, snapshot, true)) {
        const mapped = mapJsonlPreviewRow(row, platform);
        if (!mapped?.id || emitted.has(mapped.id)) continue;
        emitted.add(mapped.id);
        onItem?.(mapPreviewItem(mapped, platform));
      }
    } finally {
      if (pollTimer) clearInterval(pollTimer);
    }
    const payload = lastJsonLine(result.stdout);
    if (!payload) throw new Error('MediaCrawler không trả về JSON xem trước hợp lệ.');
    if (!payload.ok) throw new Error(payload.msg || 'MediaCrawler không lấy được danh sách video.');
    const downloadedKeys = readKeyFile(path.join(this.dataDir, DATA_FOLDERS[platform], '_da_tai_ids.txt'));
    return (payload.items || []).map((item) => {
      const mapped = mapPreviewItem(item, platform);
      mapped.downloaded = mapped.downloaded || downloadedKeys.has(mapped.id) || downloadedKeys.has(mapped.sourceUrl) || downloadedKeys.has(mapped.url);
      return mapped;
    });
  }

  async crawl(config, hooks = {}) {
    const request = normalizeCrawlRequest(config);
    const platform = request.platform;
    const code0 = PLATFORM_CODES[platform];
    if (!code0) throw new Error(`MediaCrawler không hỗ trợ ${platform}.`);
    const mode = request.mode;
    if (['xiaohongshu', 'rednote'].includes(platform) && ['creator', 'detail'].includes(mode)) {
      return this._crawlXhsBrowser(request, hooks);
    }
    let input = request.input;
    if (platform === 'bilibili' && mode === 'detail') input = await resolveBilibiliShortUrls(input, this.fetchImpl);
    const code = platform === 'rednote' ? 'xhs' : code0;
    const args = ['main.py', '--platform', code, '--lt', 'qrcode', '--headless', 'yes',
      '--type', mode === 'detail' ? 'detail' : mode,
      '--crawler_max_notes_count', String(request.count || 20), '--get_comment', 'no', '--save_data_option', 'jsonl'];
    if (mode === 'search') args.push('--keywords', String(input || '').trim().replace(/\n+/g, ','));
    else if (mode === 'creator') args.push('--creator_id', String(input || '').trim());
    else args.push('--specified_id', splitCrawlerInputs(input).join(','));
    const deepSupported = request.deepNew && (
      (platform === 'douyin' && ['search', 'creator'].includes(mode))
      || (platform === 'bilibili' && mode === 'search')
    );
    const env = {
      MC_DATA_DIR: path.resolve(request.outputDir || this.dataDir),
      MC_GET_MEDIAS: '1',
      MC_SOURCE_MODE: String(request.sourceMode || mode),
      MC_SOURCE_INPUT: String(request.sourceInput || ''),
      MC_DEEP_NEW: deepSupported ? '1' : '0',
      MC_DEEP_PAGE_CAP: deepSupported ? '40' : '1',
      DY_SORT_TYPE: mapDouyinSort(request.sort),
      DY_PUBLISH_TIME: String(Number(request.timeDays || 0)),
      DY_CREATOR_SORT: mapDouyinCreatorSort(request.sort)
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
      timeoutMs: Number(request.timeoutMs || 2 * 60 * 60 * 1000)
    });
    const completedVideos = Math.max(0, countMediaFiles(mediaDirectory) - beforeCount);
    return { success: true, engine: 'MediaCrawler', outputDir: mediaDirectory, completedVideos };
  }

  async _crawlXhsBrowser(config, hooks = {}) {
    const platform = config.platform;
    const intl = platform === 'rednote' ? '1' : '0';
    const outputRoot = path.resolve(config.outputDir || this.dataDir);
    const leaf = platform === 'rednote' ? 'rednote' : 'xhs';
    const mediaRoot = path.join(outputRoot, leaf, 'videos');
    const env = {
      MC_DATA_DIR: outputRoot,
      MC_XHS_INTL: intl,
      MC_XHS_PROFILE: 'xhs_user_data_dir',
      MC_XHS_LEAF: leaf
    };
    const profile = path.join(this.browserDataDir, 'xhs_user_data_dir');
    let links;
    let historySourceName = String(config.sourceName || '');
    const sourceMode = String(config.sourceMode || config.mode || 'detail');
    let outputDir = sourceMode === 'search'
      ? path.join(mediaRoot, 'tu-khoa', safeDirectoryName(config.sourceInput || 'khac'))
      : sourceMode === 'creator' ? path.join(mediaRoot, 'kenh') : path.join(mediaRoot, 'link');

    if (config.mode === 'creator') {
      const listed = await this._run(path.join(this.appRoot, 'xhs_browser.py'), [
        '--action', 'list', '--url', config.input, '--count', String(config.count || 20),
        '--intl', intl, '--profile', profile, '--headless', 'yes'
      ], {
        env, onLog: hooks.onLog, onProcess: hooks.onProcess, onTimeout: hooks.onTimeout,
        timeoutMs: Number(config.timeoutMs || 10 * 60 * 1000)
      });
      const payload = lastJsonLine(listed.stdout);
      if (!payload?.ok) throw new Error(payload?.msg || 'Không lấy được danh sách kênh XHS/RedNote.');
      links = (payload.items || []).map((item) => item.link).filter((link) => link && /xsec_token=/i.test(link))
        .slice(0, Number(config.count || 20));
      const uid = String(config.input || '').match(/\/user\/profile\/([0-9a-f]{16,})/i)?.[1] || '';
      const nick = safeDirectoryName(payload.nick);
      const channel = safeDirectoryName(nick && uid ? `${nick}_${uid.slice(-8)}` : uid.slice(-8) || nick);
      if (channel) outputDir = path.join(outputDir, channel);
      historySourceName = historySourceName || nick || channel;
    } else {
      links = splitCrawlerInputs(config.input).filter((link) => /xsec_token=/i.test(link));
      if (!links.length) {
        throw new Error('Link RedNote/Xiaohongshu cần có xsec_token. Hãy mở Xem trước & chọn lại rồi tải.');
      }
      if (sourceMode === 'creator') {
        const channel = safeDirectoryName(config.sourceName || config.sourceInput || 'kenh');
        outputDir = path.join(outputDir, channel);
      }
    }

    if (!links.length) throw new Error('Không có video XHS/RedNote nào chứa xsec_token để tải.');
    fs.mkdirSync(outputDir, { recursive: true });
    const beforeCount = countMediaFiles(outputDir);
    const downloaded = await this._run(path.join(this.appRoot, 'xhs_browser.py'), [
      '--action', 'tai_links', '--links', links.join('|'), '--intl', intl,
      '--headless', 'yes', '--out-dir', outputDir
    ], {
      env, onLog: hooks.onLog, onProcess: hooks.onProcess, onTimeout: hooks.onTimeout,
      timeoutMs: Number(config.timeoutMs || Math.max(300000, links.length * 60000))
    });
    const payload = lastJsonLine(downloaded.stdout);
    if (!payload?.ok) throw new Error(payload?.msg || 'Không tải được video XHS/RedNote nào.');
    const completedVideos = Array.isArray(payload.tai)
      ? payload.tai.length
      : Math.max(0, countMediaFiles(outputDir) - beforeCount);
    if (completedVideos > 0) {
      const keys = links.flatMap((link) => {
        const clean = String(link || '').trim();
        const id = clean.match(/\/(?:explore|discovery\/item)\/([0-9a-f]+)/i)?.[1] || '';
        return [clean, id].filter(Boolean);
      });
      appendKeyFile(path.join(mediaRoot, '_da_tai_ids.txt'), keys);
      appendBrowserHistory(outputRoot, platform, { ...config, sourceName: historySourceName }, links, payload.tai || keys);
    }
    return { success: true, engine: 'MediaCrawler Browser', outputDir, completedVideos };
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

module.exports = {
  MediaCrawlerAdapter,
  PLATFORM_CODES,
  lastJsonLine,
  mapPreviewItem,
  countMediaFiles,
  splitCrawlerInputs,
  resolveBilibiliShortUrls,
  snapshotJsonlOffsets,
  readAppendedJsonlRows,
  mapJsonlPreviewRow,
  migrateLegacyBilibiliArchive,
  appendBrowserHistory
};
