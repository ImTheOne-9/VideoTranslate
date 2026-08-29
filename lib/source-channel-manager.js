const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function inferPlatform(url) {
  const value = String(url || '').toLowerCase();
  if (/bilibili\.tv|bstation\.tv/.test(value)) return 'bilitv';
  if (/bilibili\.com|b23\.tv/.test(value)) return 'bilibili';
  if (/douyin\.com|iesdouyin\.com/.test(value)) return 'douyin';
  if (/rednote\.com/.test(value)) return 'rednote';
  if (/xiaohongshu\.com|xhslink\.com/.test(value)) return 'xiaohongshu';
  if (/tiktok\.com/.test(value)) return 'tiktok';
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
      .filter((entry) => entry?.status === 'success')
      .map((entry) => String(entry.key || '')));
    let changed = false;
    for (const channel of this.channels) {
      for (const video of channel.videos || []) {
        const isDownloaded = video.downloaded || downloaded.has(`${channel.platform}:${video.id}`);
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
    const channel = this.channels.find((item) => item.id === id);
    if (!channel) throw new Error('Không tìm thấy Kênh nguồn.');
    const result = await this.crawlManager.preview({
      platform: channel.platform, mode: 'creator', input: channel.url,
      count: safeInteger(count, 100, 1, 500), deepNew: false, sort: 'newest'
    }, { allowUnsupportedPreview: true });
    const previous = new Map((channel.videos || []).map((video) => [String(video.id), video]));
    channel.videos = (result.items || []).map((item) => ({
      id: String(item.id), title: String(item.title || ''), url: String(item.sourceUrl || item.url || ''),
      thumbnail: String(item.thumbnail || ''), timestamp: Number(item.timestamp || 0),
      downloaded: Boolean(item.downloaded || previous.get(String(item.id))?.downloaded)
    }));
    channel.discoveredCount = channel.videos.length;
    channel.downloadedCount = channel.videos.filter((video) => video.downloaded).length;
    channel.lastScannedAt = new Date().toISOString();
    channel.updatedAt = channel.lastScannedAt;
    this._save();
    return channel;
  }

  enqueueChannel(channel, count) {
    return this.crawlManager.enqueueJob({
      platform: channel.platform, mode: 'creator', input: channel.url,
      count: safeInteger(count, channel.schedule?.dailyCount || 3, 1, 100),
      deepNew: true, sourceMode: 'creator', sourceInput: channel.url,
      sourceName: channel.name, label: `Kênh nguồn · ${channel.name}`
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
      if (!schedule.enabled || schedule.lastRunDate === date || localTime < String(schedule.time || '02:00')) continue;
      schedule.lastRunDate = date;
      channel.updatedAt = now.toISOString();
      changed = true;
      try { this.enqueueChannel(channel, schedule.dailyCount); }
      catch (error) {
        schedule.lastError = error.message;
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
}

module.exports = { SourceChannelManager, inferPlatform, canonicalChannelUrl, localDateKey };
