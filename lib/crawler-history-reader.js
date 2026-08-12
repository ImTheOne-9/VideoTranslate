const fs = require('fs');
const path = require('path');

const PLATFORM_FOLDERS = Object.freeze({
  youtube: 'youtube', tiktok: 'tiktok', facebook: 'facebook', instagram: 'instagram',
  twitter: 'twitter', reddit: 'reddit', douyin: 'douyin', bilibili: 'bili',
  xiaohongshu: 'xhs', rednote: 'rednote', weibo: 'weibo'
});
const ORIGIN_FILE = '.crawl-source-origins.json';

function text(value) { return String(value == null ? '' : value).trim(); }

function listJsonl(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /contents.*\.jsonl$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function readDownloadedMediaFiles(directory) {
  const files = new Map();
  if (!fs.existsSync(directory)) return files;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (/\.(?:mp4|mkv|webm|mov)$/i.test(entry.name)) {
        for (const match of entry.name.matchAll(/\[([^\[\]]+)\]|_(BV[0-9A-Za-z]+|av\d+|\d{6,}|[0-9a-f]{16,})(?=\.[^.]+$)/gi)) {
          const id = text(match[1] || match[2]);
          if (id && !files.has(id)) files.set(id, fullPath);
        }
      }
    }
  }
  return files;
}

function findDownloadedMedia(mediaFiles, id, platform) {
  if (!id) return '';
  if (mediaFiles.has(id)) return mediaFiles.get(id);
  // MediaCrawler names Bilibili files with only the final six digits of the
  // numeric AV id (for example 117018632129322 -> *_129322.mp4).
  if (platform === 'bilibili' && /^\d+$/.test(id)) {
    for (const [mediaId, mediaPath] of mediaFiles) {
      if (/^\d{6,}$/.test(mediaId) && id.endsWith(mediaId)) return mediaPath;
    }
  }
  return '';
}

function originKeys(platform, value) {
  const raw = text(value);
  if (!raw) return [];
  const values = new Set([`${platform}:${raw}`]);
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    values.add(`${platform}:${parsed.toString()}`);
    parsed.search = '';
    values.add(`${platform}:${parsed.toString().replace(/\/$/, '')}`);
  } catch (_) {}
  for (const match of raw.matchAll(/(?:video\/|reel\/|shorts\/|explore\/|item\/|\b)(BV[0-9A-Za-z]+|av\d+|\d{8,}|[0-9a-f]{16,})/gi)) {
    values.add(`${platform}:${match[1]}`);
  }
  return [...values];
}

function readCrawlerOrigins(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ORIGIN_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function recordCrawlerOrigins(root, record = {}) {
  const platform = text(record.platform).toLowerCase();
  const sourceMode = text(record.sourceMode).toLowerCase();
  if (!platform || !['search', 'creator', 'detail', 'chase'].includes(sourceMode)) return 0;
  const origins = readCrawlerOrigins(root);
  const values = String(record.input || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const saved = { sourceMode, sourceInput: text(record.sourceInput), sourceName: text(record.sourceName), updatedAt: Date.now() };
  let count = 0;
  for (const value of values) {
    for (const key of originKeys(platform, value)) {
      origins[key] = saved;
      count += 1;
    }
  }
  const entries = Object.entries(origins).sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0)).slice(0, 20000);
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, ORIGIN_FILE);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8');
  fs.renameSync(temporary, target);
  return count;
}

function readCrawlerHistory(root, options = {}) {
  const platformFilter = text(options.platform).toLowerCase();
  const query = text(options.query).toLowerCase();
  const onlyUndownloaded = options.onlyUndownloaded === true;
  const days = Math.max(0, Number(options.days || 0));
  const since = days ? Date.now() / 1000 - days * 86400 : 0;
  const limit = Math.min(2000, Math.max(1, Number(options.limit || 800)));
  const deduped = new Map();
  const origins = readCrawlerOrigins(root);

  for (const [platform, folder] of Object.entries(PLATFORM_FOLDERS)) {
    if (platformFilter && platform !== platformFilter) continue;
    const mediaFiles = readDownloadedMediaFiles(path.join(root, folder, 'videos'));
    for (const file of listJsonl(path.join(root, folder, 'jsonl'))) {
      const historyName = path.basename(file).toLowerCase();
      const fileSourceMode = historyName.startsWith('search') ? 'search'
        : historyName.startsWith('creator') ? 'creator'
          : (historyName.startsWith('chase') || historyName.startsWith('bo')) ? 'chase' : 'detail';
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
        const origin = originKeys(platform, url).concat(originKeys(platform, id))
          .map((originKey) => origins[originKey]).find(Boolean);
        const sourceMode = origin?.sourceMode || fileSourceMode;
        const sourceInput = origin?.sourceInput
          || (sourceMode === 'search' ? keyword : (sourceMode === 'creator' ? uploader : ''));
        const sourceName = text(origin?.sourceName);
        if (query && !`${title}\n${uploader}\n${keyword}\n${sourceInput}\n${sourceName}`.toLowerCase().includes(query)) continue;
        // Archive records that a video was downloaded in the past, but the user may
        // have deleted the media since then. History must reflect the file on disk.
        const mediaPath = findDownloadedMedia(mediaFiles, id, platform);
        const downloaded = Boolean(mediaPath);
        if (onlyUndownloaded && downloaded) continue;
        const normalized = {
          key, id, platform, title: title || `Video ${id}`, uploader, keyword, url,
          thumbnail: text(item.video_cover_url || item.cover_url || item.thumbnail || item.thumb),
          timestamp, downloaded, mediaPath: mediaPath ? path.relative(root, mediaPath) : '',
          sourceMode, sourceInput, sourceName
        };
        const previous = deduped.get(key);
        if (!previous || timestamp > previous.timestamp) deduped.set(key, normalized);
      }
    }
  }
  return [...deduped.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

function historyTimestamp(item) {
  let timestamp = Number(item?.last_modify_ts || item?.create_time || item?.timestamp || 0);
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function deleteCrawlerHistory(root, hours = 0) {
  const numericHours = Number(hours);
  if (!Number.isFinite(numericHours) || numericHours < 0) throw new Error('Khoảng thời gian xóa không hợp lệ.');
  const cutoff = numericHours > 0 ? Date.now() / 1000 - numericHours * 3600 : 0;
  let deleted = 0;

  for (const folder of new Set(Object.values(PLATFORM_FOLDERS))) {
    for (const file of listJsonl(path.join(root, folder, 'jsonl'))) {
      let lines;
      try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()); } catch (_) { continue; }
      if (!cutoff) {
        deleted += lines.length;
        try { fs.unlinkSync(file); } catch (_) {}
        continue;
      }

      const kept = [];
      for (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch (_) { kept.push(line); continue; }
        const timestamp = historyTimestamp(item);
        if (timestamp && timestamp >= cutoff) deleted += 1;
        else kept.push(line);
      }
      if (kept.length === lines.length) continue;
      try {
        if (!kept.length) {
          fs.unlinkSync(file);
        } else {
          const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
          fs.writeFileSync(temporary, `${kept.join('\n')}\n`, 'utf8');
          try { fs.renameSync(temporary, file); } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
        }
      } catch (_) {}
    }
  }
  return { deleted };
}

module.exports = { PLATFORM_FOLDERS, readCrawlerHistory, deleteCrawlerHistory, recordCrawlerOrigins };
