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

  try {
    await win.loadURL(url, { userAgent: DOUYIN_DESKTOP_UA, timeout: 30000 });
    log('[Douyin] Đã load trang, đang đợi player khởi tạo...');

    const startTime = Date.now();
    const MAX_WAIT = 30000;
    let videoList = null;
    let clickedPlay = false;

    while (Date.now() - startTime < MAX_WAIT) {
      try {
        videoList = await win.webContents.executeJavaScript(EXTRACT_JS);
      } catch (e) {}

      if (videoList && videoList.length > 0) {
        log(`[Douyin] Đã tìm thấy ${videoList.length} chất lượng video.`);
        break;
      }

      // Sau 5s, thử click play để trigger player
      if (!clickedPlay && Date.now() - startTime > 5000) {
        clickedPlay = true;
        try {
          await win.webContents.executeJavaScript(`(function(){
            var v = document.querySelector('video');
            if (v) { v.muted = true; v.play(); }
            var btn = document.querySelector('.xgplayer-start, .xgplayer-play-btn');
            if (btn) btn.click();
          })()`);
        } catch (e) {}
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
    return sorted;
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

/**
 * Lấy thông tin video Douyin (title + danh sách chất lượng).
 */
async function getDouyinVideoInfo(url, onLog) {
  const log = onLog || (() => {});
  const formats = await extractDouyinVideoList(url, onLog);
  // Trả format đơn giản (title lấy từ page sẽ phức tạp, tạm để generic)
  return {
    title: 'Douyin Video',
    thumbnail: '',
    duration: 0,
    formats
  };
}

module.exports = { extractDouyinVideoList, getDouyinVideoInfo, isAvailable: () => !!BrowserWindow };
