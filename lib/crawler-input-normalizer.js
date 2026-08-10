function extractHttpUrls(value) {
  return String(value || '').match(/https?:\/\/[^\s,，]+/gi) || [];
}

function normalizeDouyin(platform, mode, input) {
  if (platform !== 'douyin') return { mode, input };
  let nextMode = mode;
  let nextInput = input;

  const search = nextInput.match(/douyin\.com\/search\/([^/?#]+)/i);
  if (search) {
    try { nextInput = decodeURIComponent(search[1]).trim(); } catch (_) { nextInput = search[1].trim(); }
    if (nextInput) nextMode = 'search';
    return { mode: nextMode, input: nextInput };
  }

  if (nextMode === 'detail' && /douyin\.com/i.test(nextInput)) {
    const urls = extractHttpUrls(nextInput);
    nextInput = (urls.length ? urls : [nextInput]).map((url) => {
      const video = url.match(/\/video\/(\d+)/i)
        || url.match(/[?&](?:vid|modal_id)=(\d+)/i)
        || url.match(/\/note\/(\d+)/i);
      return video ? `https://www.douyin.com/video/${video[1]}` : url;
    }).join('\n');
  } else if (nextMode === 'creator' && /\/user\//i.test(nextInput)) {
    nextInput = nextInput.split('?')[0];
  }
  return { mode: nextMode, input: nextInput };
}

function normalizeCrawlRequest(body = {}) {
  const platform = String(body.platform || 'youtube').toLowerCase();
  let mode = String(body.mode || body.type || 'search').toLowerCase();
  if (mode === 'post') mode = 'detail';
  let input = String(body.input || '').trim();

  if (['detail', 'chase'].includes(mode)) {
    const links = extractHttpUrls(input);
    if (links.length && (links.length > 1 || input !== links[0])) input = links.join('\n');
  }

  ({ mode, input } = normalizeDouyin(platform, mode, input));
  return { ...body, platform, mode, input };
}

function mapDouyinSort(value) {
  return ({ relevance: '0', likes: '1', views: '0', newest: '2', 0: '0', 1: '1', 2: '2' })[String(value)] || '0';
}

function mapDouyinCreatorSort(value) {
  return String(value) === 'likes' || String(value) === 'most_liked' ? 'most_liked' : 'newest';
}

module.exports = {
  extractHttpUrls,
  normalizeCrawlRequest,
  mapDouyinSort,
  mapDouyinCreatorSort
};
