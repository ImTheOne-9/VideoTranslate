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

function normalizeBilibiliMainlandInput(platform, mode, input) {
  if (platform !== 'bilibili' || !['detail', 'chase', 'creator'].includes(mode)) return input;
  const urls = extractHttpUrls(input);
  if (!urls.length) return input;

  return urls.map((rawUrl) => {
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) {
      throw new Error('Link Bilibili không hợp lệ.');
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'b23.tv') return rawUrl;
    if (host === 'bilibili.tv' || host.endsWith('.bilibili.tv')
      || host === 'bstation.tv' || host.endsWith('.bstation.tv')) {
      throw new Error('Tool chỉ hỗ trợ Bilibili nội địa (bilibili.com hoặc b23.tv), không hỗ trợ BiliIntl.');
    }
    if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) {
      throw new Error('Tool chỉ hỗ trợ link Bilibili nội địa thuộc bilibili.com hoặc b23.tv.');
    }
    if (mode === 'creator') return rawUrl;
    const video = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (!video) throw new Error('Link không phải video Bilibili nội địa hợp lệ (BV hoặc av).');
    return `https://www.bilibili.com/video/${video[1]}`;
  }).join('\n');
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
  input = normalizeBilibiliMainlandInput(platform, mode, input);
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
  normalizeBilibiliMainlandInput,
  mapDouyinSort,
  mapDouyinCreatorSort
};
