const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCrawlerHistory } = require('./crawler-history-reader');

function inferPlatform(url) {
  const value = String(url || '').toLowerCase();
  if (/bilibili\.tv|bstation\.tv/.test(value)) return 'bilitv';
  if (/bilibili\.com|b23\.tv/.test(value)) return 'bilibili';
  if (/douyin\.com|iesdouyin\.com/.test(value)) return 'douyin';
  if (/rednote\.com/.test(value)) return 'rednote';
  if (/xiaohongshu\.com|xhslink\.com/.test(value)) return 'xiaohongshu';
  if (/tiktok\.com/.test(value)) return 'tiktok';
  if (/kuaishou\.com|v\.kuaishou\.com/.test(value)) return 'kuaishou';
  if (/youtube\.com|youtu\.be/.test(value)) return 'youtube';
  if (/facebook\.com|fb\.watch/.test(value)) return 'facebook';
  if (/instagram\.com/.test(value)) return 'instagram';
  if (/(?:twitter|x)\.com/.test(value)) return 'twitter';
  if (/weibo\.com/.test(value)) return 'weibo';
  return '';
}

function canonicalChannelUrl(value) {
  const input = String(value || '').trim();
  const match = input.match(/https?:\/\/[^\s]+/i);
  if (!match) throw new Error('Link kênh không hợp lệ.');
  const parsed = new URL(match[0]);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:utm_|spm|share_|timestamp|from)/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function safeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

class SourceChannelManager {
  constructor(options = {}) {
    this.crawlManager = options.crawlManager;
    if (!this.crawlManager) throw new Error('SourceChannelManager cần crawlManager');
    this.storePath = options.storePath;
    if (!this.storePath) throw new Error('SourceChannelManager cần storePath');
    this.channels = this._load();
    this.timer = null;
    this.refreshing = new Map();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      return Array.isArray(data?.channels) ? data.channels : [];
    } catch (_) { return []; }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, channels: this.channels }, null, 2), 'utf8');
    fs.renameSync(temporary, this.storePath);
  }

  _syncDownloaded() {
    const downloaded = new Set((this.crawlManager.history || [])
      .filter((entry) => entry?.status === 'success' && (!entry.outputPath || fs.existsSync(entry.outputPath)))
      .map((entry) => String(entry.key || '')));
    const disk = new Map();
    if (this.crawlManager.downloadsDir) {
      for (const entry of readCrawlerHistory(this.crawlManager.downloadsDir, { limit: 2000 })) disk.set(`${entry.platform}:${entry.id}`, entry.downloaded);
    }
    let changed = false;
    for (const channel of this.channels) {
      for (const video of channel.videos || []) {
        const key = `${channel.platform}:${video.id}`;
        const isDownloaded = disk.has(key) ? disk.get(key) : video.downloaded || downloaded.has(key);
        if (isDownloaded !== video.downloaded) { video.downloaded = isDownloaded; changed = true; }
      }
      const count = (channel.videos || []).filter((video) => video.downloaded).length;
      if (channel.downloadedCount !== count) { channel.downloadedCount = count; changed = true; }
    }
    if (changed) this._save();
  }

  list() {
    this._syncDownloaded();
    return this.channels.map((channel) => ({ ...channel, videos: [...(channel.videos || [])] }));
  }

  discoverFromItems(items = [], limit = 8) {
    const added = [];
    const seen = new Set();
    for (const item of items) {
      if (added.length >= safeInteger(limit, 8, 1, 8)) break;
      const candidate = String(item?.creatorUrl || '').trim();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const before = this.channels.length;
        const channel = this.add({
          platform: item.platform,
          url: candidate,
          name: item.uploader || item.creatorName || candidate,
          avatar: item.creatorAvatar || ''
        });
        if (this.channels.length > before) added.push(channel);
      } catch (_) {}
    }
    return added;
  }

  add(input = {}) {
    const url = canonicalChannelUrl(input.url);
    const platform = String(input.platform || inferPlatform(url)).toLowerCase();
    if (!platform || !this.crawlManager.capabilities()[platform]?.creator) {
      throw new Error('Nền tảng này chưa hỗ trợ theo dõi kênh tự động.');
    }
    const existing = this.channels.find((channel) => channel.url === url);
    if (existing) return existing;
    const now = new Date().toISOString();
    const channel = {
      id: crypto.randomUUID(), platform, url,
      name: String(input.name || '').trim() || url,
      avatar: String(input.avatar || ''), videos: [],
      discoveredCount: 0, downloadedCount: 0, lastScannedAt: null,
      baselineAt: null, newCount: 0, lists: [], destination: {},
      schedule: { enabled: false, dailyCount: 3, time: '02:00', lastRunDate: '' },
      createdAt: now, updatedAt: now
    };
    this.channels.unshift(channel);
    this._save();
    return channel;
  }

  remove(id) {
    const before = this.channels.length;
    this.channels = this.channels.filter((channel) => channel.id !== id);
    if (this.channels.length !== before) this._save();
    return this.channels.length !== before;
  }

  updateSchedule(id, input = {}) {
    const channel = this.channels.find((item) => item.id === id);
    if (!channel) throw new Error('Không tìm thấy Kênh nguồn.');
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time || '')) ? String(input.time) : '02:00';
    channel.schedule = {
      ...(channel.schedule || {}),
      enabled: input.enabled === true,
      dailyCount: safeInteger(input.dailyCount, 3, 1, 100),
      time
    };
    channel.updatedAt = new Date().toISOString();
    this._save();
    return channel;
  }

  async refresh(id, count = 100) {
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const running = this._refresh(id, count);
    this.refreshing.set(id, running);
    try { return await running; } finally { this.refreshing.delete(id); }
  }

  async _refresh(id, count = 100) {
    const channel = this.channels.find((item) => item.id === id);
    if (!channel) throw new Error('Không tìm thấy Kênh nguồn.');
    const result = await this.crawlManager.preview({
      platform: channel.platform, mode: 'creator', input: channel.url,
      count: safeInteger(count, 100, 1, 500), deepNew: false, sort: 'newest'
    }, { allowUnsupportedPreview: true });
    const previous = new Map((channel.videos || []).map((video) => [String(video.id), video]));
    const now = new Date().toISOString();
    const baseline = !channel.lastScannedAt;
    let freshCount = 0;
    for (const item of result.items || []) {
      if (!item.id) continue;
      const old = previous.get(String(item.id));
      if (!old && !baseline) freshCount++;
      previous.set(String(item.id), {
      ...old,
      id: String(item.id), title: String(item.title || ''), url: String(item.sourceUrl || item.url || ''),
      thumbnail: String(item.thumbnail || ''), timestamp: Number(item.timestamp || 0),
      downloaded: item.downloaded === undefined ? Boolean(old?.downloaded) : Boolean(item.downloaded),
      discoveredAt: old?.discoveredAt || now, lastSeenAt: now,
      seen: old ? old.seen !== false : baseline, isNew: old ? old.isNew === true : !baseline
      });
    }
    const retainedIds = new Set((channel.lists || []).flatMap((list) => list.ids || []));
    const videos = [...previous.values()].sort((a, b) => String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
    channel.videos = videos.filter((video, index) => index < 1000 || retainedIds.has(video.id));
    // Conservative hint only: never auto-delete/download-skip a suspected duplicate.
    const originals = new Map();
    for (const video of [...channel.videos].sort((a, b) => Number(b.downloaded) - Number(a.downloaded))) {
      video.duplicateOf = null;
      const title = video.title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
      let thumbnail = '';
      try { thumbnail = new URL(video.thumbnail).pathname.split('/').pop(); } catch (_) {}
      const episode = /(?:tập|tap|episode|ep|phần|第)\s*\d+/i.test(title);
      if (!title || (!episode && !thumbnail)) continue;
      const key = `${title}:${episode ? 'episode' : thumbnail}`;
      if (originals.has(key)) video.duplicateOf = originals.get(key);
      else originals.set(key, video.id);
    }
    if (baseline) channel.baselineAt = now;
    channel.newCount = channel.videos.filter((video) => video.isNew && !video.seen).length;
    channel.discoveredCount = channel.videos.length;
    channel.downloadedCount = channel.videos.filter((video) => video.downloaded).length;
    channel.lastScannedAt = new Date().toISOString();
    channel.updatedAt = channel.lastScannedAt;
    this._save();
    if (freshCount) this.crawlManager._log?.(`Kênh nguồn ${channel.name}: phát hiện ${freshCount} video mới.`, 'info');
    return channel;
  }

  enqueueChannel(channel, count) {
    const active = (this.crawlManager.tasks || []).find((task) => task.config?.sourceChannelId === channel.id && ['pending', 'downloading'].includes(task.status));
    if (active) return { created: 0, taskId: active.id };
    return this.crawlManager.enqueueJob({
      platform: channel.platform, mode: 'creator', input: channel.url,
      count: safeInteger(count, channel.schedule?.dailyCount || 3, 1, 100),
      deepNew: true, sourceMode: 'creator', sourceInput: channel.url,
      sourceName: channel.name, sourceChannelId: channel.id, label: `Kênh nguồn · ${channel.name}`
    });
  }

  runNow(id, count) {
    const channel = this.channels.find((item) => item.id === id);
    if (!channel) throw new Error('Không tìm thấy Kênh nguồn.');
    return this.enqueueChannel(channel, count);
  }

  tick(now = new Date()) {
    const date = localDateKey(now);
    const localTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    let changed = false;
    for (const channel of this.channels) {
      const schedule = channel.schedule || {};
      if (schedule.retryDate !== date) { schedule.retryDate = date; schedule.retryCount = 0; changed = true; }
      const active = (this.crawlManager.tasks || []).find((task) => task.id === schedule.activeTaskId);
      if (active && ['pending', 'downloading'].includes(active.status)) continue;
      if (active?.status === 'success' && schedule.cataloguedTaskId !== active.id && typeof this.crawlManager.preview === 'function'
        && !this.refreshing.has(channel.id) && Number(schedule.catalogRetryAt || 0) <= now.getTime()) {
        const taskId = active.id;
        this.refresh(channel.id).then(() => {
          schedule.cataloguedTaskId = taskId; schedule.catalogRetryAt = 0; this._save();
        }).catch((error) => {
          schedule.catalogRetryAt = Date.now() + 5 * 60 * 1000; this._save();
          this.crawlManager._log?.(`Không cập nhật được danh mục ${channel.name}: ${error.message}`, 'warn');
        });
      }
      if (active?.status === 'error' && schedule.handledTaskId !== active.id) {
        schedule.handledTaskId = active.id;
        schedule.lastError = active.error || 'Tác vụ cào thất bại';
        schedule.retryCount = Number(schedule.retryCount || 0) + 1;
        if (schedule.retryCount <= 3) {
          schedule.lastRunDate = '';
          schedule.nextRetryAt = now.getTime() + schedule.retryCount * 5 * 60 * 1000;
        }
        changed = true;
      }
      if (Number(schedule.nextRetryAt || 0) > now.getTime()) continue;
      if (!schedule.enabled || schedule.lastRunDate === date || localTime < String(schedule.time || '02:00')) continue;
      channel.updatedAt = now.toISOString();
      changed = true;
      try {
        const result = this.enqueueChannel(channel, schedule.dailyCount);
        schedule.lastRunDate = date;
        schedule.activeTaskId = result.taskId;
        schedule.lastError = '';
        schedule.nextRetryAt = 0;
      }
      catch (error) {
        schedule.lastError = error.message;
        schedule.nextRetryAt = now.getTime() + 5 * 60 * 1000;
        this.crawlManager._log(`[Kênh nguồn] Không xếp được lịch ${channel.name}: ${error.message}`, 'error');
      }
    }
    if (changed) this._save();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60 * 1000);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 2000).unref?.();
  }

  update(id, input = {}) {
    const channel = this.channels.find((entry) => entry.id === id);
    if (!channel) throw new Error('Không tìm thấy kênh nguồn.');
    if (input.name !== undefined) channel.name = String(input.name).trim().slice(0, 200) || channel.url;
    if (input.destination) channel.destination = Object.fromEntries(['type', 'pageId', 'pageName', 'group', 'hashtags'].map((key) => [key, String(input.destination[key] || '').slice(0, 500)]));
    if (input.titles && typeof input.titles === 'object') {
      for (const video of channel.videos) if (Object.hasOwn(input.titles, video.id)) video.customTitle = String(input.titles[video.id] || '').trim().slice(0, 200);
    }
    if (Array.isArray(input.seenIds)) {
      const ids = new Set(input.seenIds.map(String));
      for (const video of channel.videos) if (ids.has(video.id)) { video.seen = true; video.isNew = false; }
    }
    if (input.list) {
      const name = String(input.list.name || '').trim().slice(0, 100);
      if (!name) throw new Error('Danh sách cần tên.');
      const known = new Set(channel.videos.map((video) => video.id));
      const list = { name, ids: [...new Set((input.list.ids || []).map(String))].filter((value) => known.has(value)).slice(0, 1000),
        titles: Object.fromEntries(Object.entries(input.list.titles || {}).filter(([key]) => known.has(key)).map(([key, value]) => [key, String(value).slice(0, 200)])) };
      channel.lists = [...(channel.lists || []).filter((entry) => entry.name !== name), list].slice(-30);
    }
    if (input.deleteList) channel.lists = (channel.lists || []).filter((entry) => entry.name !== input.deleteList);
    channel.newCount = (channel.videos || []).filter((video) => video.isNew && !video.seen).length;
    channel.updatedAt = new Date().toISOString();
    this._save();
    return channel;
  }

  runSelected(id, ids) {
    const channel = this.channels.find((entry) => entry.id === id);
    if (!channel) throw new Error('Không tìm thấy kênh nguồn.');
    const selected = new Set((ids || []).map(String));
    const videos = channel.videos.filter((video) => selected.has(video.id) && /^https?:\/\//i.test(video.url));
    if (!videos.length) throw new Error('Chưa chọn video hợp lệ.');
    return this.crawlManager.enqueueJob({ platform: channel.platform, mode: 'detail',
      input: videos.map((video) => video.url).join('\n'), count: videos.length,
      sourceMode: 'creator', sourceInput: channel.url, sourceName: channel.name, sourceChannelId: id,
      label: `${channel.name} · ${videos.length} video đã chọn` });
  }
}

module.exports = { SourceChannelManager, inferPlatform, canonicalChannelUrl, localDateKey };
