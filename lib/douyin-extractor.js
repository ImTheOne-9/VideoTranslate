/**
 * douyin-extractor.js — Trích xuất danh sách chất lượng video Douyin
 * bằng BrowserWindow ẩn của Electron (tận dụng session + JS của trang).
 *
 * URL CDN (zjcdn.com) tải được KHÔNG cần cookies/proxy.
 */

let BrowserWindow;
try {
  ({ BrowserWindow } = require('electron'));
} catch (e) {}

const DOUYIN_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const META_JS = `(function(){
  try {
    var title = '', author = '', thumb = '', dur = 0;
    // Cách 1: meta tags (og:title, og:image)
    var ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) title = ogTitle.content || '';
    var ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) thumb = ogImage.content || '';
    var ogDesc = document.querySelector('meta[property="og:description"]');
    // Cách 2: window._ROUTER_DATA (Douyin inject data vào đây)
    if (typeof window._ROUTER_DATA !== 'undefined' && window._ROUTER_DATA) {
      var rd = window._ROUTER_DATA;
      var loader = rd.loaderData || rd.loadData || rd;
      var aweme = loader.awemeDetail || loader.video || (loader.data && loader.data.awemeDetail) || null;
      if (aweme) {
        if (aweme.desc && !title) title = aweme.desc;
        if (aweme.author && aweme.author.nickname) author = aweme.author.nickname;
        if (aweme.video && aweme.video.cover && aweme.video.cover.url_list && aweme.video.cover.url_list[0]) thumb = aweme.video.cover.url_list[0];
        if (aweme.duration) dur = Math.round(aweme.duration / 1000);
        if (aweme.create_time) { /* seconds */ }
      }
    }
    // Cách 3: document.title fallback
    if (!title) title = document.title || '';
    // Cách 4: video element duration
    if (!dur) {
      var v = document.querySelector('video');
      if (v && v.duration) dur = Math.round(v.duration);
    }
    return { title: title.substring(0, 200), author: author, thumbnail: thumb, duration: dur };
  } catch(e) { return { title: '', author: '', thumbnail: '', duration: 0 }; }
})()`;

const EXTRACT_JS = `(function(){
  try {
    if (typeof player === 'undefined' || !player || !player.videoList) return null;
    var vl = player.videoList;
    if (!vl || !vl.length) return null;
    return vl.map(function(v){
      return {
        gearName: v.gearName || '',
        width: v.width || 0, height: v.height || 0,
        bitRate: v.bitRate || 0, dataSize: v.dataSize || 0,
        format: v.format || '', fps: v.fps || 0,
        src: (v.playAddr && v.playAddr[0] && v.playAddr[0].src) ? v.playAddr[0].src : null
      };
    }).filter(function(v){ return v.src; });
  } catch(e) { return null; }
})()`;

/**
 * Trích xuất danh sách chất lượng video từ link Douyin.
 */
async function extractDouyinVideoList(url, onLog) {
  const log = onLog || (() => {});
  if (!BrowserWindow) throw new Error('Extractor Douyin cần môi trường Electron.');

  log('[Douyin] Đang mở trang Douyin trong cửa sổ ẩn...');
  const win = new BrowserWindow({
    show: false, width: 1280, height: 720,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true }
  });
  await win.webContents.setUserAgent(DOUYIN_DESKTOP_UA);

  // Chặn protocol handler dialog (snssdk:// -> Windows 'get an app to open this link')
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    // Chỉ cho phép permission an toàn, chặn open-external/protocol
    callback(false);
  });
  // Chặn shell.openExternal khi snssdk:// được request
  win.webContents.on('will-prevent-unload', () => {});

  // CHỈN cửa sổ popup: Douyin hay window.open() cho ads/login/share
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('-add-new-contents', (e, contents) => {
    try { contents.destroy(); } catch (_) {}
  });
  win.webContents.on('will-navigate', (e, navUrl) => {
    if (navUrl && (navUrl.startsWith('snssdk') || navUrl.startsWith('aweme'))) {
      e.preventDefault();
    }
  });

  try {
    await win.loadURL(url, { userAgent: DOUYIN_DESKTOP_UA, timeout: 30000 });
    // Mute audio ngay để không nghe thấy video khi extract
    try { win.webContents.setAudioMuted(true); } catch (e) {}
    log('[Douyin] Đã load trang, đang đợi player khởi tạo...');

    const startTime = Date.now();
    const MAX_WAIT = 30000;
    let videoList = null;
    let meta = { title: '', author: '', thumbnail: '', duration: 0 };

    while (Date.now() - startTime < MAX_WAIT) {
      try {
        videoList = await win.webContents.executeJavaScript(EXTRACT_JS);
      } catch (e) {}

      if (videoList && videoList.length > 0) {
        log(`[Douyin] Đã tìm thấy ${videoList.length} chất lượng video.`);
        // Lấy metadata cùng lúc
        try {
          meta = await win.webContents.executeJavaScript(META_JS);
          log(`[Douyin] Title: ${(meta.title || '').substring(0, 60)}`);
        } catch (e) {}
        break;
      }

      await new Promise(r => setTimeout(r, 800));
    }

    if (!videoList || videoList.length === 0) {
      throw new Error('Không tìm thấy danh sách chất lượng. Douyin có thể đã đổi cấu trúc hoặc video cần đăng nhập.');
    }

    // Sắp xếp: mp4 trước, rồi height giảm dần
    const sorted = videoList.slice().sort((a, b) => {
      if (a.format === 'mp4' && b.format !== 'mp4') return -1;
      if (a.format !== 'mp4' && b.format === 'mp4') return 1;
      return (b.height || 0) - (a.height || 0);
    });
    return { formats: sorted, meta };
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

/**
 * Lấy thông tin video Douyin (title + danh sách chất lượng).
 */
async function getDouyinVideoInfo(url, onLog) {
  const log = onLog || (() => {});
  const { formats, meta } = await extractDouyinVideoList(url, onLog);
  return {
    title: meta.title || 'Douyin Video',
    author: meta.author || '',
    thumbnail: meta.thumbnail || '',
    duration: meta.duration || 0,
    formats
  };
}

module.exports = { extractDouyinVideoList, getDouyinVideoInfo, isAvailable: () => !!BrowserWindow };
