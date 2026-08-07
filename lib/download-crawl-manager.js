const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PLATFORM_CAPABILITIES = Object.freeze({
  youtube: { search: true, detail: true, creator: true, chase: true },
  tiktok: { search: true, detail: true, creator: true, chase: false, login: true },
  douyin: { search: true, detail: true, creator: true, chase: false, login: true },
  facebook: { search: false, detail: true, creator: true, chase: false },
  bilibili: { search: true, detail: true, creator: true, chase: true, login: true },
  xiaohongshu: { search: true, detail: true, creator: true, chase: false, login: true },
  rednote: { search: true, detail: true, creator: true, chase: false, login: true },
  weibo: { search: true, detail: true, creator: true, chase: false, login: true },
  instagram: { search: false, detail: true, creator: true, chase: false, login: true },
  twitter: { search: false, detail: true, creator: true, chase: false, login: true },
  reddit: { search: true, detail: true, creator: true, chase: false }
});

function splitInputs(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeCount(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, parsed));
}

function cleanFilename(shared, title, id) {
  const base = shared.cleanVideoTitle(String(title || 'video')) || 'video';
  const safe = shared.removeVietnameseTones(base)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110) || 'video';
  const suffix = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-32);
  return suffix && !safe.endsWith(`[${suffix}]`) ? `${safe} [${suffix}]` : safe;
}

function parsePercent(text) {
  const match = String(text || '').match(/([0-9]+(?:\.[0-9]+)?)%/);
  return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
}

function parseDownloadTelemetry(text) {
  const value = String(text || '');
  const speed = value.match(/(?:at\s+)?([0-9.]+\s*(?:KiB|MiB|GiB|KB|MB|GB)\/s)/i)?.[1] || null;
  const eta = value.match(/ETA\s+([0-9:]+)/i)?.[1] || null;
  return { speed, eta };
}

function classifyCrawlError(message) {
  const text = String(message || '').toLowerCase();
  if (/login|đăng nhập|cookie|sign in/.test(text)) return 'login_expired';
  if (/captcha|anti.?bot|not a bot|risk|风控/.test(text)) return 'anti_bot';
  if (/429|too many|rate.?limit|tần suất/.test(text)) return 'rate_limit';
  if (/403|blocked|chặn|ip/.test(text)) return 'ip_blocked';
  if (/url|link|unsupported url|không hợp lệ/.test(text)) return 'invalid_link';
  if (/timeout|timed out|quá lâu/.test(text)) return 'timeout';
  if (/extractor|không tìm thấy luồng/.test(text)) return 'extractor';
  return 'error';
}

class DownloadCrawlManager {
  constructor(options = {}) {
    this.shared = options.shared;
    if (!this.shared) throw new Error('DownloadCrawlManager cần shared-state');
    this.downloadsDir = options.downloadsDir || this.shared.DOWNLOADS_DIR;
    this.historyPath = options.historyPath || path.join(this.downloadsDir, '.crawl-history.json');
    this.tasksPath = options.tasksPath || path.join(this.downloadsDir, '.crawl-tasks.json');
    this.platformCapabilities = options.platformCapabilities || DEFAULT_PLATFORM_CAPABILITIES;
    this.previewResolvers = options.previewResolvers || {};
    this.downloadResolvers = options.downloadResolvers || {};
    this.crawlResolvers = options.crawlResolvers || {};
    this.loginChecker = options.loginChecker || null;
    this.tasks = this._loadTasks();
    this.activeTaskId = null;
    this.activeProcess = null;
    this.running = false;
    this.pauseAfterCurrent = false;
    this.startedAt = Date.now();
    this.logs = [];
    this.history = this._loadHistory();
    this._resumePendingTasks();
  }

  _loadTasks() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.tasksPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(-1000).map((task) => ({
        ...task,
        status: ['pending', 'downloading'].includes(task.status) ? 'pending' : task.status,
        step: task.status === 'downloading' ? 'Chờ tiếp tục sau khi mở lại ứng dụng' : task.step,
        speed: null,
        eta: null
      }));
    } catch (_) {
      return [];
    }
  }

  _saveTasks() {
    fs.mkdirSync(path.dirname(this.tasksPath), { recursive: true });
    const temp = `${this.tasksPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.tasks.slice(-1000), null, 2), 'utf8');
    fs.renameSync(temp, this.tasksPath);
  }

  _resumePendingTasks() {
    if (this.tasks.some((task) => task.status === 'pending')) {
      setImmediate(() => this._processQueue());
    }
  }

  _log(message, level = 'info', taskId = null) {
    const entry = { id: crypto.randomUUID(), time: new Date().toISOString(), level, message, taskId };
    this.logs.push(entry);
    this.logs = this.logs.slice(-500);
    return entry;
  }

  _loadHistory() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  _saveHistory() {
    fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
    const temp = `${this.historyPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.history.slice(-5000), null, 2), 'utf8');
    fs.renameSync(temp, this.historyPath);
  }

  capabilities() {
    return this.platformCapabilities;
  }

  _assertSupported(platform, mode) {
    const caps = this.platformCapabilities[platform];
    if (!caps) throw new Error(`Nền tảng "${platform}" chưa được cấu hình.`);
    if (!caps[mode]) {
      const labels = { search: 'theo từ khóa', detail: 'theo link', creator: 'theo kênh', chase: 'theo bộ' };
      throw new Error(`${platform} hiện chưa hỗ trợ cào ${labels[mode] || mode} trong bộ tải hiện tại. Hãy dùng Theo link hoặc nền tảng được hỗ trợ.`);
    }
  }

  _sourceForPreview(platform, mode, input, count) {
    this._assertSupported(platform, mode);
    const values = splitInputs(input);
    if (!values.length) throw new Error('Chưa nhập từ khóa, link hoặc kênh.');
    if (mode === 'search') {
      if (platform !== 'youtube') throw new Error('Tìm theo từ khóa hiện chỉ hỗ trợ YouTube.');
      return { sources: [`ytsearch${Math.min(1500, count * 3)}:${values.join(' ')}`], flat: true };
    }
    if (mode === 'detail') return { sources: values, flat: false };
    return { sources: [values[0]], flat: true };
  }

  async preview(body = {}) {
    const platform = String(body.platform || 'youtube').toLowerCase();
    const mode = String(body.mode || 'detail').toLowerCase();
    const count = safeCount(body.count, 20);
    const deepNew = body.deepNew === true && ['search', 'creator'].includes(mode);
    const deepPreview = deepNew && ['douyin', 'bilibili'].includes(platform);
    const scanCount = deepPreview ? Math.min(5000, Math.max(count, count * 40)) : count;
    const resolver = this.previewResolvers[`${platform}:${mode}`];
    if (resolver) {
      const resolved = await resolver({
        input: body.input, count: scanCount, platform, mode,
        sort: body.sort, timeDays: body.timeDays, language: body.language, deepNew
      });
      const resolvedItems = (Array.isArray(resolved) ? resolved : []).map((item) => {
        const id = String(item.id || crypto.createHash('sha1').update(String(item.sourceUrl || item.url)).digest('hex').slice(0, 16));
        const key = `${platform}:${id}`;
        return { ...item, id, key, platform, downloaded: this.history.some((entry) => entry.key === key && entry.status === 'success') };
      });
      resolvedItems.sort((a, b) => Number(a.downloaded) - Number(b.downloaded));
      const selected = deepNew ? resolvedItems.filter((item) => !item.downloaded).slice(0, count) : resolvedItems.slice(0, count);
      this._log(`Xem trước ${selected.length}/${resolvedItems.length} video ${platform} bằng extractor chuyên dụng${deepNew ? ' · đào sâu chống trùng' : ''}.`);
      return { items: selected, count: selected.length, scanned: resolvedItems.length, requested: count, deepNew, platform, mode };
    }
    const { sources, flat } = this._sourceForPreview(platform, mode, body.input, scanCount);
    const items = [];

    for (const source of sources) {
      const args = [
        '--dump-json', '--skip-download', '--no-warnings',
        ...(flat ? ['--flat-playlist', '--playlist-end', String(scanCount)] : ['--no-playlist']),
        ...this.shared.getCustomExtractorArgs(source),
        source
      ];
      const output = await this.shared.runYtDlp(args);
      for (const line of String(output || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch (_) { continue; }
        const id = String(item.id || crypto.randomUUID());
        let url = item.webpage_url || item.original_url || item.url || source;
        if (platform === 'youtube' && mode === 'search'
          && (/youtube\.com\/(?:channel\/|@|c\/|user\/)/i.test(String(url)) || /YoutubeTab/i.test(String(item.ie_key || item.extractor_key || '')))) continue;
        if ((!url || !/^https?:/i.test(url)) && platform === 'youtube' && item.id) {
          url = `https://www.youtube.com/watch?v=${item.id}`;
        }
        let thumbnail = item.thumbnail || item.thumbnails?.at?.(-1)?.url || '';
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
        const key = `${platform}:${id}`;
        items.push({
          id,
          key,
          platform,
          title: item.title || item.description?.split?.('\n')?.[0] || `Video ${id}`,
          url,
          thumbnail,
          duration: Number(item.duration) || 0,
          uploader: item.uploader || item.channel || item.creator || '',
          viewCount: Number(item.view_count) || 0,
          likeCount: Number(item.like_count) || 0,
          timestamp: Number(item.timestamp || item.release_timestamp) || 0,
          downloaded: this.history.some((entry) => entry.key === key && entry.status === 'success')
        });
        if (items.length >= scanCount) break;
      }
      if (items.length >= scanCount) break;
    }

    const sort = String(body.sort || 'relevance');
    if (sort === 'likes') items.sort((a, b) => b.likeCount - a.likeCount);
    if (sort === 'views') items.sort((a, b) => b.viewCount - a.viewCount);
    if (sort === 'newest') items.sort((a, b) => b.timestamp - a.timestamp);
    items.sort((a, b) => Number(a.downloaded) - Number(b.downloaded));
    const selected = deepNew
      ? items.filter((item) => !item.downloaded).slice(0, count)
      : items.slice(0, count);
    this._log(`Xem trước ${selected.length}/${items.length} video từ ${platform} (${mode})${deepNew ? ' · đào sâu chống trùng' : ''}.`);
    return { items: selected, count: selected.length, scanned: items.length, requested: count, deepNew, platform, mode };
  }

  enqueue(body = {}) {
    const platform = String(body.platform || 'youtube').toLowerCase();
    const skipDuplicates = body.skipDuplicates !== false;
    const outputDir = body.outputDir ? path.resolve(String(body.outputDir)) : this.downloadsDir;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) throw new Error('Chưa chọn video nào để tải.');
    fs.mkdirSync(outputDir, { recursive: true });

    const created = [];
    let skipped = 0;
    for (const raw of rawItems.slice(0, 500)) {
      const id = String(raw.id || crypto.randomUUID());
      const key = String(raw.key || `${platform}:${id}`);
      if (skipDuplicates && this.history.some((entry) => entry.key === key && entry.status === 'success')) {
        skipped += 1;
        continue;
      }
      const task = {
        id: crypto.randomUUID(), key, platform,
        sourceId: id,
        title: String(raw.title || `Video ${id}`),
        url: String(raw.url || ''),
        sourceUrl: String(raw.sourceUrl || raw.url || ''),
        resolvedDownload: Boolean(raw.resolvedDownload || (platform === 'douyin' && raw.sourceUrl && raw.url !== raw.sourceUrl)),
        outputDir,
        filenameBase: cleanFilename(this.shared, raw.customFilename || raw.title, id),
        status: 'pending', percent: 0, step: 'Đang chờ', error: null,
        speed: null, eta: null, retryCount: 0,
        createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
        outputPath: null
      };
      if (!/^https?:/i.test(task.url)) throw new Error(`Video "${task.title}" không có URL tải hợp lệ.`);
      this.tasks.push(task);
      created.push(task);
      this._log(`Đã thêm vào hàng đợi: ${task.title}`, 'info', task.id);
    }
    this._saveTasks();
    this._processQueue();
    return { created: created.length, skipped, taskIds: created.map((task) => task.id) };
  }

  enqueueJob(body = {}) {
    const platform = String(body.platform || 'youtube').toLowerCase();
    const mode = String(body.mode || body.type || 'search').toLowerCase();
    this._assertSupported(platform, mode);
    const input = String(body.input || '').trim();
    if (!input) throw new Error('Chưa nhập từ khóa, link hoặc kênh.');
    const count = safeCount(body.count, 100);
    const task = {
      id: crypto.randomUUID(),
      kind: 'crawl',
      platform,
      title: String(body.label || `${platform} · ${mode} · ${input.slice(0, 48)}`),
      config: {
        platform, mode, input, count,
        sort: String(body.sort || 'relevance'),
        timeDays: Number(body.timeDays || 0),
        language: String(body.language || ''),
        deepNew: body.deepNew !== false
      },
      status: 'pending', percent: 0, step: 'Đang chờ', error: null, reason: null,
      speed: null, eta: null, retryCount: 0, found: 0, completedVideos: 0, failedVideos: 0,
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null
    };
    this.tasks.push(task);
    this._saveTasks();
    this._log(`Đã thêm job cào: ${task.title}`, 'info', task.id);
    this._processQueue();
    return { created: 1, taskId: task.id };
  }

  snapshot() {
    const summary = {
      pending: this.tasks.filter((task) => task.status === 'pending').length,
      downloading: this.tasks.filter((task) => task.status === 'downloading').length,
      success: this.tasks.filter((task) => task.status === 'success').length,
      error: this.tasks.filter((task) => task.status === 'error').length,
      cancelled: this.tasks.filter((task) => task.status === 'cancelled').length
    };
    const active = this.tasks.find((task) => task.id === this.activeTaskId) || null;
    return {
      running: this.running,
      paused: this.pauseAfterCurrent,
      activeTaskId: this.activeTaskId,
      queue: this.tasks.map((task) => ({ ...task })),
      summary,
      speed: active?.speed || null,
      eta: active?.eta || null,
      logs: this.logs.slice(-150)
    };
  }

  stats(date = '') {
    const day = String(date || '').slice(0, 10);
    const success = this.history.filter((entry) => entry.status === 'success');
    const crawlSuccess = this.tasks.filter((task) => task.kind === 'crawl' && task.status === 'success');
    const combined = [...success, ...crawlSuccess];
    const filtered = day ? combined.filter((entry) => String(entry.completedAt || '').slice(0, 10) === day) : combined;
    const byPlatform = {};
    const weight = (entry) => entry.kind === 'crawl' ? Math.max(1, Number(entry.completedVideos || 0)) : 1;
    for (const entry of filtered) byPlatform[entry.platform] = (byPlatform[entry.platform] || 0) + weight(entry);
    const today = new Date().toISOString().slice(0, 10);
    return {
      selectedDate: day,
      today: combined.filter((entry) => String(entry.completedAt || '').slice(0, 10) === today).reduce((sum, entry) => sum + weight(entry), 0),
      completed: filtered.reduce((sum, entry) => sum + weight(entry), 0),
      downloading: this.tasks.filter((task) => task.status === 'downloading').length,
      errors: this.tasks.filter((task) => task.status === 'error').length,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      byPlatform,
      dates: [...new Set(combined.map((entry) => String(entry.completedAt || '').slice(0, 10)).filter(Boolean))].sort().reverse()
    };
  }

  setPaused(value) {
    this.pauseAfterCurrent = Boolean(value);
    this._log(this.pauseAfterCurrent ? 'Hàng đợi sẽ tạm nghỉ sau tác vụ hiện tại.' : 'Đã tiếp tục hàng đợi tải.');
    if (!this.pauseAfterCurrent) this._processQueue();
    return this.snapshot();
  }

  retry(taskId) {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !['error', 'cancelled'].includes(task.status)) return false;
    task.status = 'pending';
    task.percent = 0;
    task.error = null;
    task.speed = null;
    task.eta = null;
    task.step = 'Đang chờ thử lại';
    task.retryCount = Number(task.retryCount || 0) + 1;
    task.cancelRequested = false;
    task.completedVideos = 0;
    task.failedVideos = 0;
    task.completedAt = null;
    this._saveTasks();
    this._log(`Thử lại: ${task.title}`, 'info', task.id);
    this._processQueue();
    return true;
  }

  retryAll(platform = '') {
    let count = 0;
    for (const task of this.tasks) {
      if (task.status !== 'error' || (platform && task.platform !== platform)) continue;
      task.status = 'pending';
      task.percent = 0;
      task.error = null;
      task.step = 'Đang chờ thử lại';
      task.retryCount = Number(task.retryCount || 0) + 1;
      task.cancelRequested = false;
      task.completedVideos = 0;
      task.failedVideos = 0;
      task.completedAt = null;
      count += 1;
    }
    this._saveTasks();
    if (count) this._processQueue();
    return count;
  }

  clearLogs() {
    this.logs = [];
  }

  cancel(taskId) {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;
    if (task.status === 'pending') {
      task.status = 'cancelled';
      task.step = 'Đã hủy';
      task.completedAt = new Date().toISOString();
      this._saveTasks();
      return true;
    }
    if (task.kind === 'crawl' && task.status === 'downloading') {
      task.cancelRequested = true;
      task.step = 'Đang hủy job...';
      if (this.activeProcess) this.shared.killProcessTree(this.activeProcess);
      this._saveTasks();
      return true;
    }
    if (task.id === this.activeTaskId && this.activeProcess) {
      task.step = 'Đang hủy...';
      this.shared.killProcessTree(this.activeProcess);
      return true;
    }
    return false;
  }

  stopAll() {
    for (const task of this.tasks) {
      if (task.status === 'pending') {
        task.status = 'cancelled';
        task.step = 'Đã hủy';
        task.completedAt = new Date().toISOString();
      }
    }
    const active = this.tasks.find((task) => task.id === this.activeTaskId);
    if (active?.kind === 'crawl') active.cancelRequested = true;
    if (this.activeProcess) this.shared.killProcessTree(this.activeProcess);
    this._saveTasks();
  }

  clearFinished() {
    this.tasks = this.tasks.filter((task) => ['pending', 'downloading'].includes(task.status));
    this._saveTasks();
    return this.snapshot();
  }

  remove(taskId) {
    const index = this.tasks.findIndex((task) => task.id === taskId);
    if (index < 0 || ['pending', 'downloading'].includes(this.tasks[index].status)) return false;
    this.tasks.splice(index, 1);
    this._saveTasks();
    return true;
  }

  async _processQueue() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        if (this.pauseAfterCurrent) break;
        const task = this.tasks.find((candidate) => candidate.status === 'pending');
        if (!task) break;
        if (task.kind === 'crawl') {
          await this._runCrawlTask(task);
          continue;
        }
        const resolver = this.downloadResolvers[task.platform];
        if (resolver && !task.resolvedDownload) {
          try {
            task.status = 'downloading';
            task.step = `Đang lấy link tải trực tiếp từ ${task.platform}`;
            task.startedAt = new Date().toISOString();
            this.activeTaskId = task.id;
            const resolved = await resolver({ ...task });
            if (!resolved?.url) throw new Error('Extractor không trả về URL tải.');
            task.url = resolved.url;
            task.resolvedDownload = true;
            task.status = 'pending';
            task.step = 'Đã lấy link trực tiếp';
          } catch (error) {
            task.status = 'error';
            task.step = 'Không lấy được link tải trực tiếp';
            task.error = error.message;
            task.completedAt = new Date().toISOString();
            this._log(`Lỗi extractor ${task.platform}: ${error.message}`, 'error', task.id);
            this._saveTasks();
            this.activeTaskId = null;
            continue;
          }
        }
        await this._download(task);
      }
    } finally {
      this.running = false;
      this.activeTaskId = null;
      this.activeProcess = null;
    }
  }

  async _runCrawlTask(task) {
    task.status = 'downloading';
    task.startedAt = new Date().toISOString();
    task.step = 'Đang kiểm tra phiên đăng nhập';
    this.activeTaskId = task.id;
    this._saveTasks();
    try {
      if (this.loginChecker) {
        const login = await this.loginChecker(task.platform, task.config?.mode);
        if (login === 'out') {
          const error = new Error(`Cần đăng nhập lại ${task.platform} trước khi chạy job.`);
          error.reason = 'login_expired';
          throw error;
        }
      }
      const crawlResolver = this.crawlResolvers[task.platform];
      if (crawlResolver) {
        task.step = task.config?.deepNew
          ? 'MediaCrawler đang đào tối đa 40 trang để tìm nội dung mới'
          : 'MediaCrawler đang cào và tải nội dung';
        this._saveTasks();
        const result = await crawlResolver({ ...task.config, outputDir: this.downloadsDir }, {
          onProcess: (proc) => { this.activeProcess = proc; },
          onTimeout: (proc) => this.shared.killProcessTree(proc),
          onLog: (line, level = 'info') => {
            if (task.cancelRequested) return;
            task.step = String(line || '').trim().slice(0, 240) || task.step;
            const downloaded = task.step.match(/(?:Đã tải|Downloaded)\s+(\d+)/i);
            if (downloaded) {
              task.completedVideos = Number(downloaded[1]);
              task.found = Math.max(Number(task.found || 0), Number(task.config?.count || 0));
              task.percent = Math.min(99, Math.round((task.completedVideos / Math.max(1, Number(task.config?.count || 1))) * 100));
            } else {
              const itemPercent = parsePercent(task.step);
              if (itemPercent !== null && task.config?.count) {
                task.percent = Math.min(99, Math.round(((Number(task.completedVideos || 0) + itemPercent / 100) / Number(task.config.count)) * 100));
              }
            }
            const telemetry = parseDownloadTelemetry(task.step);
            if (telemetry.speed) task.speed = telemetry.speed;
            if (telemetry.eta) task.eta = telemetry.eta;
            const progress = task.step.match(/(?:\[|\b)(\d+)\s*\/\s*(\d+)(?:\]|\b)/);
            if (progress && Number(progress[2]) > 0) {
              task.percent = Math.min(99, Math.round((Number(progress[1]) / Number(progress[2])) * 100));
              task.completedVideos = Number(progress[1]);
              task.found = Number(progress[2]);
            }
            this._log(`[MediaCrawler] ${task.step}`, level, task.id);
            this._saveTasks();
          }
        });
        if (task.cancelRequested) throw Object.assign(new Error('Đã hủy job.'), { reason: 'cancelled' });
        task.status = 'success';
        task.percent = 100;
        task.step = 'MediaCrawler đã cào và tải xong';
        task.engine = result?.engine || 'MediaCrawler';
        task.outputPath = result?.outputDir || this.downloadsDir;
        task.completedVideos = Number(result?.completedVideos || 0);
        this._log(`Job MediaCrawler hoàn tất: ${task.title}`, 'success', task.id);
        return;
      }
      task.step = task.config?.deepNew ? 'Đang đào tối đa 40 trang để tìm video mới' : 'Đang lấy danh sách video';
      const result = await this.preview(task.config || {});
      const items = Array.isArray(result.items) ? result.items : [];
      task.found = items.length;
      if (!items.length) throw new Error('Không tìm thấy video phù hợp hoặc toàn bộ video đã tải trước đó.');
      for (let index = 0; index < items.length; index += 1) {
        if (task.cancelRequested) throw Object.assign(new Error('Đã hủy job.'), { reason: 'cancelled' });
        const item = items[index];
        const child = {
          id: `${task.id}:${index}`,
          kind: 'video-child',
          parentId: task.id,
          key: item.key || `${task.platform}:${item.id}`,
          platform: task.platform,
          sourceId: String(item.id || index),
          title: String(item.title || `Video ${index + 1}`),
          url: String(item.url || ''),
          sourceUrl: String(item.sourceUrl || item.url || ''),
          resolvedDownload: Boolean(item.resolvedDownload || (task.platform === 'douyin' && item.sourceUrl && item.url !== item.sourceUrl)),
          outputDir: this.downloadsDir,
          filenameBase: cleanFilename(this.shared, item.title, item.id),
          status: 'pending', percent: 0, step: 'Đang chờ', error: null,
          speed: null, eta: null, retryCount: 0,
          createdAt: task.createdAt, startedAt: null, completedAt: null, outputPath: null
        };
        const resolver = this.downloadResolvers[child.platform];
        if (resolver && !child.resolvedDownload) {
          task.step = `Đang lấy link trực tiếp ${index + 1}/${items.length}`;
          const resolved = await resolver({ ...child });
          if (!resolved?.url) throw new Error('Extractor không trả về URL tải.');
          child.url = resolved.url;
          child.resolvedDownload = true;
        }
        task.step = `Đang tải ${index + 1}/${items.length}: ${child.title}`;
        await this._download(child);
        if (child.status === 'success') task.completedVideos += 1;
        else if (child.status === 'cancelled') throw Object.assign(new Error('Đã hủy job.'), { reason: 'cancelled' });
        else task.failedVideos += 1;
        task.percent = Math.round(((index + 1) / items.length) * 100);
        this.activeTaskId = task.id;
        this._saveTasks();
      }
      if (!task.completedVideos && task.failedVideos) throw new Error('Tất cả video trong job đều tải thất bại.');
      task.status = 'success';
      task.percent = 100;
      task.step = task.failedVideos ? `Hoàn tất ${task.completedVideos}, lỗi ${task.failedVideos}` : `Hoàn tất ${task.completedVideos} video`;
      task.reason = task.failedVideos ? 'partial' : null;
      this._log(`Job hoàn tất: ${task.title} · ${task.completedVideos} video`, 'success', task.id);
    } catch (error) {
      task.status = error.reason === 'cancelled' ? 'cancelled' : 'error';
      task.error = error.message;
      task.reason = error.reason || classifyCrawlError(error.message);
      task.step = task.status === 'cancelled' ? 'Đã hủy' : error.message;
      this._log(`Job lỗi [${task.reason}]: ${task.title} · ${error.message}`, 'error', task.id);
      if (task.reason === 'login_expired') {
        for (const queued of this.tasks) {
          if (queued.id !== task.id && queued.kind === 'crawl' && queued.platform === task.platform && queued.status === 'pending') {
            queued.status = 'error';
            queued.reason = 'login_expired';
            queued.error = `Bỏ qua vì cần đăng nhập lại ${task.platform}.`;
            queued.step = queued.error;
            queued.completedAt = new Date().toISOString();
          }
        }
      }
    } finally {
      task.completedAt = new Date().toISOString();
      task.speed = null;
      task.eta = null;
      this.activeTaskId = null;
      this.activeProcess = null;
      this._saveTasks();
    }
  }

  _download(task) {
    return new Promise((resolve) => {
      task.status = 'downloading';
      task.step = 'Đang chuẩn bị tải';
      task.startedAt = new Date().toISOString();
      this._saveTasks();
      this._log(`Bắt đầu tải: ${task.title}`, 'info', task.id);
      this.activeTaskId = task.parentId || task.id;
      const outputTemplate = path.join(task.outputDir, `${task.filenameBase}.%(ext)s`);
      const args = [
        '--newline', '--no-warnings', '--no-playlist',
        '--progress-template', 'download:%(progress._percent_str)s',
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4', '-o', outputTemplate,
        ...this.shared.getCustomExtractorArgs(task.url)
      ];
      if (task.platform === 'douyin' && task.sourceUrl && task.sourceUrl !== task.url) {
        args.push('--add-header', 'Referer:https://www.douyin.com/');
        args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
      }
      if (fs.existsSync(this.shared.FFMPEG_PATH)) args.push('--ffmpeg-location', this.shared.FFMPEG_PATH);
      args.push(task.url);

      const proc = this.shared.spawn(this.shared.YTDLP_PATH, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.activeProcess = proc;
      const onLine = (chunk) => {
        for (const line of String(chunk || '').split(/\r?\n/)) {
          const percent = parsePercent(line);
          const telemetry = parseDownloadTelemetry(line);
          if (telemetry.speed) task.speed = telemetry.speed;
          if (telemetry.eta) task.eta = telemetry.eta;
          if (task.parentId) {
            const parent = this.tasks.find((candidate) => candidate.id === task.parentId);
            if (parent) {
              const total = Math.max(1, Number(parent.found || 1));
              parent.percent = Math.round(((Number(parent.completedVideos || 0) + (Number(percent || 0) / 100)) / total) * 100);
              parent.speed = telemetry.speed || task.speed;
              parent.eta = telemetry.eta || task.eta;
            }
          }
          if (percent !== null) {
            task.percent = Math.round(percent);
            task.step = `Đang tải ${task.percent}%`;
          } else if (/merg/i.test(line)) {
            task.step = 'Đang ghép video và âm thanh';
            task.percent = Math.max(task.percent, 96);
          }
        }
      };
      proc.stdout?.on('data', onLine);
      proc.stderr?.on('data', onLine);
      proc.once('error', (error) => {
        task.status = 'error';
        task.error = error.message;
        task.step = 'Tải thất bại';
        this._log(`Lỗi tải ${task.title}: ${error.message}`, 'error', task.id);
      });
      proc.once('close', (code, signal) => {
        if (task.status === 'error') {
          // giữ lỗi đã ghi từ event error
        } else if (code === 0) {
          const expected = path.join(task.outputDir, `${task.filenameBase}.mp4`);
          task.status = 'success';
          task.percent = 100;
          task.step = 'Đã tải xong';
          task.outputPath = fs.existsSync(expected) ? expected : task.outputDir;
          this.history.push({
            key: task.key, platform: task.platform, sourceId: task.sourceId,
            title: task.title, url: task.sourceUrl || task.url, outputPath: task.outputPath,
            status: 'success', completedAt: new Date().toISOString()
          });
          try { this._saveHistory(); } catch (_) {}
          this._log(`Đã tải xong: ${task.title}`, 'success', task.id);
        } else {
          task.status = signal || code === null ? 'cancelled' : 'error';
          task.step = task.status === 'cancelled' ? 'Đã hủy' : 'Tải thất bại';
          task.error = task.status === 'error' ? `yt-dlp dừng với mã ${code}` : null;
          this._log(task.status === 'cancelled' ? `Đã hủy: ${task.title}` : `Tải thất bại: ${task.title}`, task.status === 'error' ? 'error' : 'warn', task.id);
        }
        task.completedAt = new Date().toISOString();
        task.speed = null;
        task.eta = null;
        this._saveTasks();
        this.activeTaskId = null;
        this.activeProcess = null;
        resolve();
      });
    });
  }
}

module.exports = {
  DownloadCrawlManager,
  DEFAULT_PLATFORM_CAPABILITIES,
  splitInputs,
  safeCount,
  parsePercent,
  parseDownloadTelemetry
};
