const {
  getGeminiProfileDir,
  openGeminiLoginWindow,
  dichSrtNodeJS
} = require('./gemini-web-service');

/**
 * Kích hoạt cửa sổ Chrome cho người dùng đăng nhập Gemini (Node.js Playwright)
 */
async function openGeminiLogin() {
  console.log('[GeminiWebAdapter] Kích hoạt cửa sổ đăng nhập Gemini bằng Node.js Playwright...');
  return await openGeminiLoginWindow();
}

/**
 * Thực hiện dịch phụ đề SRT qua Gemini Web Playwright (Node.js Thuần)
 */
async function translateViaGeminiWeb(inputSrtPath, outputSrtPath, options = {}) {
  console.log(`[GeminiWebAdapter] Kích hoạt luồng dịch phụ đề Gemini Web Thuần Node.js...`);
  return await dichSrtNodeJS(inputSrtPath, outputSrtPath, {
    targetLang: options.targetLang || 'vi',
    show: options.show || false,
    logFn: (msg) => {
      console.log(`[GeminiWebNodeJS] ${msg}`);
      if (typeof options.onProgress === 'function') {
        options.onProgress(msg);
      }
    }
  });
}

module.exports = {
  getGeminiProfileDir,
  openGeminiLogin,
  translateViaGeminiWeb
};
