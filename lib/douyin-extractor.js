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
    var debug = { globals: [], foundIn: '' };
    title = document.title || '';
    debug.docTitle = title;
    var found = null;
    var globalKeys = ['_ROUTER_DATA', '_SSR_HYDRATED_DATA', '__INITIAL_STATE__', '_SSR_DATA_', 'RENDER_DATA', '_initialState', '__nuxt__', 'videoData', 'awemeData', 'detail'];
    for (var i = 0; i < globalKeys.length; i++) {
      try {
        var g = window[globalKeys[i]];
        if (g && typeof g === 'object') {
          debug.globals.push(globalKeys[i]);
          var stack = [{ obj: g, path: globalKeys[i], depth: 0 }];
          while (stack.length && !found) {
            var item = stack.shift();
            if (item.depth > 4) continue;
            var keys = Object.keys(item.obj);
            if ((item.obj.desc !== undefined || item.obj.aweme_id !== undefined) &&
                (item.obj.author !== undefined || item.obj.video !== undefined || item.obj.music !== undefined)) {
              found = item.obj;
              debug.foundIn = item.path;
              break;
            }
            for (var k = 0; k < keys.length && k < 30; k++) {
              try {
                var v = item.obj[keys[k]];
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                  stack.push({ obj: v, path: item.path + '.' + keys[k], depth: item.depth + 1 });
                }
              } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }
    if (found) {
      debug.foundKeys = Object.keys(found).slice(0, 20);
      if (found.desc) title = found.desc;
      var au = found.author || found.userInfo || found.user_info || null;
      if (au) author = au.nickname || au.unique_id || au.name || au.user_name || au.uid || '';
      var cv = found.video || found.image || found.cover || null;
      if (cv) {
        if (cv.cover && cv.cover.url_list) thumb = cv.cover.url_list[0];
        else if (cv.origin_cover && cv.origin_cover.url_list) thumb = cv.origin_cover.url_list[0];
        else if (cv.url_list) thumb = cv.url_list[0];
        else if (cv.dynamic_cover && cv.dynamic_cover.url_list) thumb = cv.dynamic_cover.url_list[0];
      }
      if (found.duration) dur = Math.round(found.duration / 1000);
      if (found.video && found.video.duration) dur = Math.round(found.video.duration / 1000);
    }
    if (!title) { var ogT = document.querySelector('meta[property="og:title"]'); if (ogT) title = ogT.content || ''; }
    if (!thumb) { var ogI = document.querySelector('meta[property="og:image"]'); if (ogI) thumb = ogI.content || ''; }
    if (!dur) { var vEl = document.querySelector('video'); if (vEl && vEl.duration) dur = Math.round(vEl.duration); }
    if (title && title.endsWith(' \u62b6\u97f3')) title = title.slice(0, -3).trim();
    if (title && title.indexOf(' - ') > 5) title = title.split(' - ').slice(0, -1).join(' - ').trim();
    return { title: title.substring(0, 200), author: author, thumbnail: thumb, duration: dur, debug: debug };
  } catch(e) {
    return { title: document.title || '', author: '', thumbnail: '', duration: 0, debug: { error: e.message } };
  }
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
          log(`[Douyin] Author: ${meta.author || '(empty)'}`);
          log(`[Douyin] Thumb: ${(meta.thumbnail || '').substring(0, 50)}`);
          log(`[Douyin] Debug: ${JSON.stringify(meta.debug || {})}`);
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
