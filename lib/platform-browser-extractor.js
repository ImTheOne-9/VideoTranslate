let BrowserWindow;
let electronSession;
const fs = require('fs');
const path = require('path');
try {
  ({ BrowserWindow, session: electronSession } = require('electron'));
} catch (_) {}

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PLATFORM_CONFIG = Object.freeze({
  douyin: {
    home: 'https://www.douyin.com/',
    domains: ['douyin.com'],
    search: (input) => `https://www.douyin.com/search/${encodeURIComponent(input)}?type=video`,
    linkPattern: /\/video\/\d+/i
  },
  bilibili: {
    home: 'https://www.bilibili.com/',
    domains: ['bilibili.com'],
    search: (input) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(input)}`,
    linkPattern: /\/video\/(?:BV[\w]+|av\d+)/i
  },
  xiaohongshu: {
    home: 'https://www.xiaohongshu.com/explore',
    domains: ['xiaohongshu.com'],
    search: (input) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(input)}&source=web_search_result_notes`,
    linkPattern: /\/(?:explore|discovery\/item)\/[\w-]+/i
  },
  rednote: {
    home: 'https://www.rednote.com/',
    domains: ['rednote.com'],
    search: (input) => `https://www.rednote.com/search_result?keyword=${encodeURIComponent(input)}`,
    linkPattern: /\/(?:explore|discovery\/item)\/[\w-]+/i
  },
  weibo: {
    home: 'https://weibo.com/',
    domains: ['weibo.com', 'weibo.cn'],
    search: (input) => `https://s.weibo.com/weibo?q=${encodeURIComponent(input)}`,
    linkPattern: /weibo\.(?:com|cn)\/(?:tv\/show|\d+\/)[\w-]+/i
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAvailable() {
  return Boolean(BrowserWindow && electronSession);
}

function partition(platform) {
  return `persist:video-studio-crawl-${platform}`;
}

function createWindow(platform, show = false) {
  if (!isAvailable()) throw new Error('Extractor trình duyệt chỉ hoạt động trong ứng dụng Electron.');
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    show,
    title: `Đăng nhập ${platform}`,
    webPreferences: {
      partition: partition(platform),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setUserAgent(DESKTOP_UA);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) win.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  return win;
}

async function openLogin(platform) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new Error(`Chưa có trang đăng nhập cho ${platform}.`);
  const win = createWindow(platform, true);
  await win.loadURL(config.home);
  win.show();
  return true;
}

async function loginStatus(platform) {
  if (!isAvailable()) return 'unavailable';
  const config = PLATFORM_CONFIG[platform];
  if (!config) return 'na';
  try {
    const ses = electronSession.fromPartition(partition(platform));
    const groups = await Promise.all(config.domains.map((domain) => ses.cookies.get({ domain })));
    return groups.some((cookies) => cookies.length > 0) ? 'in' : 'out';
  } catch (_) {
    return 'unknown';
  }
}

async function syncCookies(platform, destination) {
  if (!isAvailable()) return false;
  const config = PLATFORM_CONFIG[platform];
  if (!config) return false;
  const ses = electronSession.fromPartition(partition(platform));
  const all = await ses.cookies.get({});
  const cookies = all.filter((cookie) => config.domains.some((domain) => String(cookie.domain || '').replace(/^\./, '').endsWith(domain)));
  if (!cookies.length) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const lines = ['# Netscape HTTP Cookie File', '# Exported by Video Studio'];
  for (const cookie of cookies) {
    const domain = String(cookie.domain || '');
    const cookieDomain = cookie.httpOnly ? `#HttpOnly_${domain}` : domain;
    lines.push([
      cookieDomain,
      domain.startsWith('.') ? 'TRUE' : 'FALSE',
      cookie.path || '/',
      cookie.secure ? 'TRUE' : 'FALSE',
      Math.floor(Number(cookie.expirationDate) || 0),
      cookie.name,
      cookie.value
    ].join('\t'));
  }
  fs.writeFileSync(destination, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

function buildTarget(config, mode, input) {
  if (mode === 'search') return config.search(input);
  if (!/^https?:\/\//i.test(input)) throw new Error('Theo kênh cần link đầy đủ bắt đầu bằng http:// hoặc https://.');
  return input;
}

async function collect(platform, mode, input, count = 100, onProgress = () => {}) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new Error(`Chưa có extractor trình duyệt cho ${platform}.`);
  if (!['search', 'creator'].includes(mode)) throw new Error(`Extractor trình duyệt không hỗ trợ chế độ ${mode}.`);
  const target = buildTarget(config, mode, String(input || '').trim());
  const win = createWindow(platform, false);
  const results = new Map();
  try {
    onProgress(`Đang mở ${platform}...`);
    await win.loadURL(target);
    await sleep(2600);
    for (let page = 1; page <= 40 && results.size < count; page += 1) {
      const rows = await win.webContents.executeJavaScript(`(() => {
        const out = [];
        for (const anchor of document.querySelectorAll('a[href]')) {
          const href = anchor.href || '';
          const box = anchor.closest('article,section,li,div') || anchor;
          const img = box.querySelector('img');
          const text = (anchor.getAttribute('title') || box.innerText || anchor.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 240);
          const likeText = Array.from(box.querySelectorAll('span')).map(x => x.innerText || '').find(x => /^[\\d,.]+[万亿wWkKmM]?$/.test(x.trim())) || '';
          out.push({ href, title: text, thumbnail: img ? (img.currentSrc || img.src || '') : '', likeText });
        }
        return out;
      })()`);
      for (const row of rows || []) {
        if (!config.linkPattern.test(String(row.href || ''))) continue;
        const normalized = String(row.href).split('#')[0];
        if (!results.has(normalized)) results.set(normalized, {
          id: normalized.match(/(?:video|explore|item|show)\/([\w-]+)/i)?.[1] || normalized,
          title: row.title || `${platform} video`,
          url: normalized,
          sourceUrl: normalized,
          thumbnail: String(row.thumbnail || '').startsWith('//') ? `https:${row.thumbnail}` : row.thumbnail,
          uploader: '', duration: 0, viewCount: 0, likeCount: 0, timestamp: 0
        });
      }
      onProgress(`Đang quét trang ${page}: tìm thấy ${results.size}/${count} video`);
      if (results.size >= count) break;
      await win.webContents.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight)');
      await sleep(page < 5 ? 900 : 1400);
    }
    return [...results.values()].slice(0, count);
  } finally {
    try { win.destroy(); } catch (_) {}
  }
}

module.exports = { PLATFORM_CONFIG, collect, isAvailable, loginStatus, openLogin, syncCookies };
