const fs = require('fs');
const path = require('path');

const PLATFORM_FOLDERS = Object.freeze({
  youtube: 'youtube', tiktok: 'tiktok', facebook: 'facebook', instagram: 'instagram',
  twitter: 'twitter', reddit: 'reddit', douyin: 'douyin', bilibili: 'bili',
  xiaohongshu: 'xhs', rednote: 'rednote', weibo: 'weibo', bilitv: 'bilitv', kuaishou: 'kuaishou', honggo: 'honggo'
});
const ORIGIN_FILE = '.crawl-source-origins.json';

function localMediaMetadata(mediaPath) {
  if (!mediaPath) return {};
  try { return JSON.parse(fs.readFileSync(`${mediaPath}.metadata.json`, 'utf8')); } catch (_) { return {}; }
}

function text(value) { return String(value == null ? '' : value).trim(); }

function historyUrl(platform, id) {
  if (!id) return '';
  if (platform === 'tiktok') return `https://www.tiktok.com/video/${id}`;
  if (platform === 'facebook') return `https://www.facebook.com/reel/${id}`;
  if (platform === 'douyin') return `https://www.douyin.com/video/${id}`;
  if (platform === 'bilibili') return `https://www.bilibili.com/video/${id}`;
  if (platform === 'rednote') return `https://www.rednote.com/explore/${id}`;
  if (platform === 'xiaohongshu') return `https://www.xiaohongshu.com/explore/${id}`;
  return '';
}

function inferFileSource(root, mediaPath) {
  const parts = path.relative(root, mediaPath).split(path.sep);
  const videosIndex = parts.indexOf('videos');
  const folder = videosIndex >= 0 ? parts[videosIndex + 1] : '';
  const source = videosIndex >= 0 ? text(parts[videosIndex + 2]) : '';
  const sourceMode = folder === 'tu-khoa' ? 'search'
    : folder === 'kenh' ? 'creator'
      : folder === 'bo' ? 'chase' : 'detail';
  return {
    sourceMode,
    sourceInput: sourceMode === 'search' || sourceMode === 'creator' || sourceMode === 'chase' ? source : '',
    sourceName: sourceMode === 'creator' ? source : ''
  };
}

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
        // RedNote's browser downloader uses the note id as the entire filename
        // (for example 64f0123456789abcdef01234.mp4), without [] or a suffix.
        const basename = path.basename(entry.name, path.extname(entry.name));
        if (/^(?:BV[0-9A-Za-z]+|av\d+|\d{6,}|[0-9a-f]{16,})$/i.test(basename) && !files.has(basename)) {
          files.set(basename, fullPath);
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

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function isPathInside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.toLowerCase().startsWith(`${base}${path.sep}`.toLowerCase());
}

function readHonggoAppHistory(platformRoot, downloadsRoot) {
  const items = [];
  const metadata = new Map();
  let directories = [];
  try { directories = fs.readdirSync(platformRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch (_) {}
  for (const directory of directories) {
    if (['videos', 'jsonl', '.hgstate'].includes(directory.name.toLowerCase())) continue;
    const folder = path.join(platformRoot, directory.name);
    const meta = readJsonFile(path.join(folder, '.series.json'));
    if (meta?.series_id) metadata.set(String(meta.series_id), { ...meta, folder });
  }

  const represented = new Set();
  const stateRoot = path.join(platformRoot, '.hgstate');
  let stateFiles = [];
  try { stateFiles = fs.readdirSync(stateRoot).filter((name) => /^series_.+\.json$/i.test(name)); } catch (_) {}
  for (const stateFile of stateFiles) {
    const state = readJsonFile(path.join(stateRoot, stateFile));
    if (!state || typeof state !== 'object') continue;
    const seriesId = text(state.series_id || stateFile.match(/^series_(.+)\.json$/i)?.[1]);
    if (!seriesId) continue;
    const meta = metadata.get(seriesId) || {};
    const seriesTitle = text(meta.title || state.title || seriesId);
    for (const [episodeKey, episode] of Object.entries(state.episodes || {})) {
      if (!episode || episode.status !== 'done' || !episode.file) continue;
      const mediaFile = path.resolve(String(episode.file));
      if (!isPathInside(downloadsRoot, mediaFile) || !fs.existsSync(mediaFile)) continue;
      let stat;
      try { stat = fs.statSync(mediaFile); } catch (_) { continue; }
      if (!stat.isFile() || stat.size <= 0) continue;
      const episodeNumber = Number(episodeKey) || null;
      const vid = text(episode.vid || episodeKey);
      const id = `${seriesId}/${vid}`;
      represented.add(mediaFile.toLowerCase());
      items.push({
        key: `honggo:${id}`, id, platform: 'honggo',
        title: `${seriesTitle}${episodeNumber ? ` — Tập ${episodeNumber}` : ''}`,
        uploader: seriesTitle, keyword: '',
        url: vid && /^\d{10,22}$/.test(vid)
          ? `https://hongguoduanju.com/player/${seriesId}/${vid}`
          : `https://hongguoduanju.com/player/${seriesId}`,
        thumbnail: text(meta.cover),
        timestamp: Number(episode.ts) || Math.floor(stat.mtimeMs / 1000),
        downloaded: true, mediaPath: path.relative(downloadsRoot, mediaFile),
        sourceMode: 'chase', sourceInput: seriesTitle, sourceName: seriesTitle,
        seriesId, seriesTitle, episodeNumber
      });
    }
  }

  for (const [seriesId, meta] of metadata) {
    let files = [];
    try { files = fs.readdirSync(meta.folder, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of files) {
      if (!entry.isFile() || !/\.(?:mp4|mkv|webm|mov)$/i.test(entry.name)) continue;
      const mediaFile = path.resolve(meta.folder, entry.name);
      if (represented.has(mediaFile.toLowerCase())) continue;
      const match = entry.name.match(/第\s*(\d+)\s*集/i);
      const episodeNumber = match ? Number(match[1]) : null;
      let stat;
      try { stat = fs.statSync(mediaFile); } catch (_) { continue; }
      if (stat.size <= 0) continue;
      const id = `${seriesId}/episode-${episodeNumber || path.parse(entry.name).name}`;
      items.push({
        key: `honggo:${id}`, id, platform: 'honggo',
        title: `${text(meta.title || seriesId)}${episodeNumber ? ` — Tập ${episodeNumber}` : ''}`,
        uploader: text(meta.title), keyword: '', url: `https://hongguoduanju.com/player/${seriesId}`,
        thumbnail: text(meta.cover), timestamp: Math.floor(stat.mtimeMs / 1000), downloaded: true,
        mediaPath: path.relative(downloadsRoot, mediaFile), sourceMode: 'chase',
        sourceInput: text(meta.title), sourceName: text(meta.title),
        seriesId, seriesTitle: text(meta.title), episodeNumber
      });
    }
  }
  return items;
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
    const platformRoot = path.join(root, folder);
    const mediaFiles = readDownloadedMediaFiles(platform === 'honggo' ? platformRoot : path.join(platformRoot, 'videos'));
    const representedIds = new Set();
    if (platform === 'honggo') {
      for (const item of readHonggoAppHistory(platformRoot, root)) {
        if (since && item.timestamp && item.timestamp < since) continue;
        if (query && ![item.title, item.uploader, item.sourceInput, item.sourceName].join('\\n').toLowerCase().includes(query)) continue;
        if (onlyUndownloaded && item.downloaded) continue;
        representedIds.add(item.id);
        const previous = deduped.get(item.key);
        if (!previous || item.timestamp > previous.timestamp) deduped.set(item.key, item);
      }
    }
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
        if (id) representedIds.add(id);
        let url = text(item.video_url || item.note_url || item.aweme_url || item.share_url || item.url || item.webpage_url);
        if (!url && id) {
          if (platform === 'douyin') url = `https://www.douyin.com/video/${id}`;
          else if (platform === 'bilibili') url = `https://www.bilibili.com/video/${text(item.bvid) || id}`;
          else if (['xiaohongshu', 'rednote'].includes(platform)) url = historyUrl(platform, id);
        }
        const key = id ? `${platform}:${id}` : url;
        if (!key) continue;
        let timestamp = Number(item.last_modify_ts || item.create_time || item.timestamp || 0);
        if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000);
        if (!timestamp) timestamp = fallbackTimestamp;
        if (since && timestamp && timestamp < since) continue;
        const title = text(item.title || item.desc || item.description);
        const uploader = text(item.nickname || item.nick || item.uploader || item.channel);
        const keyword = text(item.source_keyword || item.keyword);
        const origin = originKeys(platform, id).concat(originKeys(platform, url))
          .map((originKey) => origins[originKey]).find(Boolean);
        const explicitMode = text(item.source_mode || item.sourceMode).toLowerCase();
        const sourceMode = origin?.sourceMode
          || (['search', 'creator', 'detail', 'chase'].includes(explicitMode) ? explicitMode : fileSourceMode);
        const sourceInput = origin?.sourceInput || text(item.source_input || item.sourceInput)
          || (sourceMode === 'search' ? keyword : (sourceMode === 'creator' ? uploader : ''));
        const sourceName = text(origin?.sourceName || item.source_name || item.sourceName);
        if (query && !`${title}\n${uploader}\n${keyword}\n${sourceInput}\n${sourceName}`.toLowerCase().includes(query)) continue;
        // Archive records that a video was downloaded in the past, but the user may
        // have deleted the media since then. History must reflect the file on disk.
        const mediaPath = findDownloadedMedia(mediaFiles, id, platform);
        const downloaded = Boolean(mediaPath);
        const localMetadata = localMediaMetadata(mediaPath);
        if (onlyUndownloaded && downloaded) continue;
        const normalized = {
          key, id, platform, title: localMetadata.title || title || `Video ${id}`, uploader, keyword, url: url || localMetadata.url || '',
          thumbnail: text(item.video_cover_url || item.cover_url || item.thumbnail || item.thumb || localMetadata.thumbnail),
          timestamp, downloaded, mediaPath: mediaPath ? path.relative(root, mediaPath) : '',
          sourceMode, sourceInput, sourceName,
          seriesId: text(item.series_id), seriesTitle: text(item.series_title), episodeNumber: Number(item.episode_number) || null
        };
        const previous = deduped.get(key);
        if (!previous || timestamp > previous.timestamp) deduped.set(key, normalized);
      }
    }
    // Browser fallbacks (notably TikTok and RedNote) may successfully create a
    // video without receiving enough metadata to append JSONL. Reconstruct a
    // minimal history row from the actual downloaded file so existing downloads
    // never disappear from the history page.
    for (const [id, mediaPath] of mediaFiles) {
      if (representedIds.has(id)) continue;
      const inferred = inferFileSource(path.join(root, folder), mediaPath);
      const origin = originKeys(platform, id).map((originKey) => origins[originKey]).find(Boolean);
      const stat = fs.statSync(mediaPath);
      const sourceMode = origin?.sourceMode || inferred.sourceMode;
      const sourceInput = origin?.sourceInput || inferred.sourceInput;
      const sourceName = origin?.sourceName || inferred.sourceName;
      const title = path.basename(mediaPath, path.extname(mediaPath))
        .replace(new RegExp(`\\s*(?:\\[${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]|_${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`, 'i'), '')
        .trim() || `Video ${id}`;
      const localMetadata = localMediaMetadata(mediaPath);
      const url = localMetadata.url || historyUrl(platform, id);
      const key = url || `${platform}:${id}`;
      const timestamp = Math.floor(stat.mtimeMs / 1000);
      const normalized = {
        key, id, platform, title: localMetadata.title || title, uploader: sourceMode === 'creator' ? sourceName : '',
        keyword: sourceMode === 'search' ? sourceInput : '', url, thumbnail: text(localMetadata.thumbnail), timestamp,
        downloaded: true, mediaPath: path.relative(root, mediaPath), sourceMode, sourceInput, sourceName
      };
      const previous = deduped.get(key);
      if (!previous || timestamp > previous.timestamp) deduped.set(key, normalized);
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
