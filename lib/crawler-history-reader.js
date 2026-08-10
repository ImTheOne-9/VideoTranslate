const fs = require('fs');
const path = require('path');

const PLATFORM_FOLDERS = Object.freeze({
  youtube: 'youtube', tiktok: 'tiktok', facebook: 'facebook', instagram: 'instagram',
  twitter: 'twitter', reddit: 'reddit', douyin: 'douyin', bilibili: 'bili',
  xiaohongshu: 'xhs', rednote: 'rednote', weibo: 'weibo'
});

function text(value) { return String(value == null ? '' : value).trim(); }

function listJsonl(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /contents.*\.jsonl$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function readArchive(root, folder) {
  const keys = new Set();
  for (const name of ['_da_tai_ids.txt', '_da_tai.txt']) {
    try {
      for (const line of fs.readFileSync(path.join(root, folder, name), 'utf8').split(/\r?\n/)) {
        const key = line.trim();
        if (key) keys.add(key);
      }
    } catch (_) {}
  }
  return keys;
}

function isDownloaded(keys, id, url) {
  if (keys.has(id) || keys.has(url)) return true;
  for (const key of keys) if (id && key.endsWith(` ${id}`)) return true;
  return false;
}

function readCrawlerHistory(root, options = {}) {
  const platformFilter = text(options.platform).toLowerCase();
  const query = text(options.query).toLowerCase();
  const onlyUndownloaded = options.onlyUndownloaded === true;
  const days = Math.max(0, Number(options.days || 0));
  const since = days ? Date.now() / 1000 - days * 86400 : 0;
  const limit = Math.min(2000, Math.max(1, Number(options.limit || 800)));
  const deduped = new Map();

  for (const [platform, folder] of Object.entries(PLATFORM_FOLDERS)) {
    if (platformFilter && platform !== platformFilter) continue;
    const archive = readArchive(root, folder);
    for (const file of listJsonl(path.join(root, folder, 'jsonl'))) {
      let fallbackTimestamp = 0;
      try { fallbackTimestamp = Math.floor(fs.statSync(file).mtimeMs / 1000); } catch (_) {}
      let lines = [];
      try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) { continue; }
      for (const line of lines) {
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch (_) { continue; }
        const id = text(item.video_id || item.note_id || item.aweme_id || item.id || item.bvid);
        let url = text(item.video_url || item.note_url || item.aweme_url || item.share_url || item.url || item.webpage_url);
        if (!url && id) {
          if (platform === 'douyin') url = `https://www.douyin.com/video/${id}`;
          else if (platform === 'bilibili') url = `https://www.bilibili.com/video/${text(item.bvid) || id}`;
          else if (['xiaohongshu', 'rednote'].includes(platform)) url = `https://www.xiaohongshu.com/explore/${id}`;
        }
        const key = url || id;
        if (!key) continue;
        let timestamp = Number(item.last_modify_ts || item.create_time || item.timestamp || 0);
        if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000);
        if (!timestamp) timestamp = fallbackTimestamp;
        if (since && timestamp && timestamp < since) continue;
        const title = text(item.title || item.desc || item.description);
        const uploader = text(item.nickname || item.nick || item.uploader || item.channel);
        const keyword = text(item.source_keyword || item.keyword);
        if (query && !`${title}\n${uploader}\n${keyword}`.toLowerCase().includes(query)) continue;
        const downloaded = isDownloaded(archive, id, url);
        if (onlyUndownloaded && downloaded) continue;
        const normalized = {
          key, id, platform, title: title || `Video ${id}`, uploader, keyword, url,
          thumbnail: text(item.video_cover_url || item.cover_url || item.thumbnail || item.thumb),
          timestamp, downloaded
        };
        const previous = deduped.get(key);
        if (!previous || timestamp > previous.timestamp) deduped.set(key, normalized);
      }
    }
  }
  return [...deduped.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

module.exports = { PLATFORM_FOLDERS, readCrawlerHistory };
