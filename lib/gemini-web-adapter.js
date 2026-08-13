const {
  getGeminiProfileDir,
  openGeminiLoginWindow,
  hoiGeminiWebNodeJS
} = require('./gemini-web-service');

/**
 * Kích hoạt cửa sổ Chrome cho người dùng đăng nhập Gemini (Node.js Playwright)
 */
async function openGeminiLogin() {
  console.log('[GeminiWebAdapter] Kích hoạt cửa sổ đăng nhập Gemini bằng Node.js Playwright...');
  return await openGeminiLoginWindow();
}

/**
 * Gửi một prompt tới Gemini Web. Việc xây prompt, phân tích toàn bộ SRT,
 * checkpoint và kiểm tra JSON được giữ ở pipeline dịch dùng chung.
 */
async function requestViaGeminiWeb(prompt, options = {}) {
  console.log('[GeminiWebAdapter] Gửi prompt bằng phiên Gemini Web...');
  const response = await hoiGeminiWebNodeJS(prompt, {
    show: options.show || false,
    logFn: (msg) => {
      console.log(`[GeminiWebNodeJS] ${msg}`);
      if (typeof options.onProgress === 'function') {
        options.onProgress(msg);
      }
    }
  });
  if (!String(response || '').trim()) {
    throw new Error('Gemini Web không trả về nội dung.');
  }
  return response;
}

module.exports = {
  getGeminiProfileDir,
  openGeminiLogin,
  requestViaGeminiWeb
};
