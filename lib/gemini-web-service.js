const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Parser = require('srt-parser-2').default;
const { getAppDataRoot } = require('./path-helper');

const APP_ROOT = path.resolve(__dirname, '..');

// Biến lưu phiên Browser persistent duy nhất trong Node.js
let _GEM_CTX = null;
let _GEM_PAGE = null;

/**
 * Lấy đường dẫn thư mục Profile Gemini
 */
function getGeminiProfileDir() {
  const dataRoot = getAppDataRoot(path.join(APP_ROOT, 'temp'));
  const profileDir = path.join(dataRoot, 'gemini_profile');
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  return profileDir;
}

/**
 * Tự động tìm đường dẫn Chromium của Playwright nếu thiếu env
 */
function setupPlaywrightEnv() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '');
    const candidates = [
      path.join(APP_ROOT, 'runtime', 'ms-playwright'),
      appData ? path.join(appData, 'video-studio-tools', 'runtime', 'ms-playwright') : null,
      path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
      appData ? path.join(appData, 'Video Studio Tools', 'crawler', 'runtime', 'ms-playwright-node') : null,
    ].filter(Boolean);

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = c;
        break;
      }
    }
  }
}

/**
 * Mở Persistent Context bằng Chromium Playwright -> Chrome hệ thống -> Edge
 */
async function launchPersistentBrowserContext(profileDir, options = {}) {
  const baseArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-features=IsolateOrigins,site-per-process'
  ];
  const launchOpts = {
    headless: options.headless ?? true,
    args: baseArgs,
    viewport: { width: 1200, height: 900 }
  };

  // 1. Ưu tiên Chromium Playwright mặc định
  try {
    setupPlaywrightEnv();
    return await chromium.launchPersistentContext(profileDir, launchOpts);
  } catch (err0) {
    console.warn(`[GeminiWeb] Thử Chromium Playwright thất bại (${err0.message}). Chuyển sang Chrome hệ thống...`);
  }

  // 2. Dự phòng Google Chrome hệ thống
  try {
    return await chromium.launchPersistentContext(profileDir, { ...launchOpts, channel: 'chrome' });
  } catch (err1) {
    console.warn(`[GeminiWeb] Thử Chrome hệ thống thất bại: ${err1.message}`);
  }

  // 3. Dự phòng Microsoft Edge hệ thống
  return await chromium.launchPersistentContext(profileDir, { ...launchOpts, channel: 'msedge' });
}

/**
 * Mở cửa sổ Chrome Playwright (headless: false) cho người dùng đăng nhập Gemini
 */
async function openGeminiLoginWindow() {
  const profileDir = getGeminiProfileDir();
  console.log(`[GeminiWebService] Mở cửa sổ đăng nhập Gemini với Profile: ${profileDir}`);

  const context = await launchPersistentBrowserContext(profileDir, { headless: false });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  try {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    console.warn(`[GeminiLogin] Cảnh báo điều hướng: ${err.message}`);
  }

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        if (page.isClosed() || context.pages().length === 0) {
          clearInterval(interval);
          try { await context.close(); } catch (e) {}
          console.log('[GeminiLogin] Người dùng đã đóng trình duyệt. Lưu profile thành công.');
          resolve({ success: true, profileDir });
        }
      } catch (err) {
        clearInterval(interval);
        resolve({ success: true, profileDir });
      }
    }, 1000);
  });
}

/**
 * Đọc file quy tắc & từ điển tên riêng (translation_memory/*.md & scripts/huong_dan_dich.md)
 */
function docTm(tmDir) {
  const parts = [];
  const defaultGuide = path.join(APP_ROOT, 'scripts', 'huong_dan_dich.md');
  if (fs.existsSync(defaultGuide)) {
    try {
      const text = fs.readFileSync(defaultGuide, 'utf-8').trim();
      if (text) parts.push(text);
    } catch (e) {}
  }

  const resolvedTmDir = tmDir && fs.existsSync(tmDir) ? tmDir : path.join(APP_ROOT, 'scripts', 'translation_memory');
  if (fs.existsSync(resolvedTmDir)) {
    try {
      const files = fs.readdirSync(resolvedTmDir).filter(f => f.endsWith('.md')).sort();
      for (const f of files) {
        const content = fs.readFileSync(path.join(resolvedTmDir, f), 'utf-8').trim();
        if (content) parts.push(content);
      }
    } catch (e) {}
  }
  return parts.join('\n\n');
}

/**
 * Tính tỷ lệ ký tự Hán (CJK) trong chuỗi để phát hiện dịch sót
 */
function tyLeHan(str) {
  const text = String(str || '').trim();
  if (!text) return 0.0;
  const hanMatch = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
  const total = text.replace(/\s+/g, '').length;
  return total > 0 ? (hanMatch.length / total) : 0.0;
}

/**
 * Tính thời lượng giây từ chuỗi timestamp (00:00:01,000 --> 00:00:03,000)
 */
function slotGiay(ts) {
  try {
    const parts = String(ts || '').split('-->');
    if (parts.length < 2) return 0.0;
    const parseS = (x) => {
      const [h, m, s] = x.trim().replace(',', '.').split(':');
      return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
    };
    return Math.max(0.0, parseS(parts[1]) - parseS(parts[0]));
  } catch (e) {
    return 0.0;
  }
}

/**
 * Thuật toán Trần Số Từ Linh hoạt cho tiếng Việt (tran_tu_dich)
 */
function tranTuDich(giay, nguon, wpsMax = 5.0, tiLe = 0.75) {
  const text = String(nguon || '');
  const hanMatch = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
  const nAm = hanMatch.length || Math.max(1, text.split(/\s+/).length);
  return Math.max(3, Math.floor(Math.min(giay * wpsMax, nAm * tiLe)));
}

/**
 * Xây dựng Bộ QUY TẮC CHUNG 4 bậc ưu tiên & System Prompt
 */
function getQuyTacChung() {
  return `=== QUY TẮC DỊCH THUẬT & PHONG CÁCH (BẮT BUỘC) ===
0. THỨ TỰ ƯU TIÊN KHI CÁC QUY TẮC XUNG ĐỘT:
   ① ĐÚNG NGHĨA + NGƯỜI VIỆT ĐỌC LÀ HIỂU NGAY  →  ② ĐÚNG SỐ DÒNG (1 dòng gốc = 1 dòng dịch)  →  ③ NGẮN vừa khe thời gian  →  ④ PHONG CÁCH/GIỌNG VĂN.
1. XỬ LÝ LỖI OCR BẢN GỐC: Dữ liệu đầu vào quét từ video nên sẽ có lỗi OCR. Dựa vào ngữ cảnh cả đoạn để ĐOÁN chữ đúng và dịch theo ý đúng.
2. TỰ ĐỘNG NHẬN DIỆN THỂ LOẠI: Tự điều chỉnh xưng hô (Cổ trang/Tu tiên vs Hiện đại).
3. KHỬ VĂN DỊCH MÁY: Cấm các từ rập khuôn: "một cách...", "sự...", "việc mà...", "điều đó...".\n\n`;
}

/**
 * Dựng Prompt hoàn chỉnh gửi cho Gemini Web
 */
function buildPrompt(items, tmContent, targetLang = 'vi', fit = true) {
  let prefix = getQuyTacChung();
  if (tmContent) {
    prefix += `QUY TẮC + TỪ ĐIỂN TÊN RIÊNG (BẮT BUỘC, nhất quán Hán-Việt):\n=== QUY TẮC ===\n${tmContent}\n=== HẾT ===\n\n`;
  }

  prefix += `Bạn là NGƯỜI BẢN NGỮ đang KỂ LẠI câu chuyện dưới đây bằng tiếng Việt — KHÔNG PHẢI máy dịch từng chữ.
CÁCH LÀM:
1) ĐỌC HẾT cả đoạn trước — đây là 1 ĐOẠN LIÊN TỤC của CÙNG người nói.
2) HIỂU tình huống và ý định truyền đạt — không chỉ dịch nghĩa đen.
3) GIỮ NHẤT QUÁN xưng hô xuyên suốt.
4) VIẾT LẠI từng câu bằng tiếng Việt tự nhiên — NHƯ NGƯỜI VIỆT THẬT SỰ SẼ NÓI. Mục tiêu là ĐÚNG Ý NGHĨA + CẢM XÚC.

QUY TẮC PHỤ ĐỀ LỒNG TIẾNG:
- DỊCH 1:1: MỖI dòng gốc VẪN → ĐÚNG 1 dòng dịch, đúng thứ tự, TUYỆT ĐỐI KHÔNG gộp/tách/bỏ dòng. OUTPUT LINE COUNT MUST EQUAL INPUT LINE COUNT.
- DẤU CÂU: Cuối mỗi khối phụ đề đã hoàn chỉnh ý, BẮT BUỘC đặt dấu chấm (.), dấu hỏi (?) hoặc dấu cảm (!) phù hợp. Nếu ý còn tiếp nối sang dòng kế tiếp thì KHÔNG ép dấu kết câu; vẫn dùng dấu phẩy hoặc không có dấu theo cách nói tự nhiên. Quy tắc này giúp bộ đọc thoại nhận diện điểm ngắt và gộp câu tự nhiên.\n`;

  if (fit) {
    prefix += `- KHỚP LỒNG TIẾNG: đầu mỗi dòng có [Ts ≤N từ] = câu này có T GIÂY để TTS đọc → dịch tối đa N TỪ.
  ĐỊNH NGHĨA 'giữ nghĩa': giữ THÔNG TIN CỐT LỒI (AI làm GÌ, cái GÌ, con số) — CẮT BỎ: từ đệm (thực sự, rất, một cách), từ nối (thì, mà, là), đại từ thừa.
  VÍ DỤ (Gốc → SAI dài → ĐÚNG ngắn):
  '他来了' → 'Anh ấy đã đến nơi đây rồi đấy' (8 từ, SAI) → 'Anh ấy tới rồi' (4 từ, ĐÚNG);
  '太美了' → 'Cái này thực sự là quá đẹp đi mà' (8 từ, SAI) → 'Đẹp quá' (2 từ, ĐÚNG).\n`;
  }

  prefix += `CHỈ trả về BẢN DỊCH: mỗi dòng MỘT câu, GIỮ NGUYÊN số thứ tự '1.' '2.'… đầu mỗi dòng. TUYỆT ĐỐI KHÔNG thêm chữ nào khác:\n\n`;

  const formattedLines = items.map((it, idx) => {
    const duration = slotGiay(it.timestamp);
    const maxW = fit && duration > 0 ? tranTuDich(duration, it.text) : 0;
    const anchor = maxW > 0 ? `[${duration.toFixed(1)}s ≤${maxW} từ] ` : '';
    return `${idx + 1}. ${anchor}${it.text}`;
  });

  return prefix + formattedLines.join('\n');
}

/**
 * Poll chờ phản hồi từ Gemini Web trên Playwright Page
 */
async function doiPhanHoi(page, minLen = 50, validate = null, logFn = console.log) {
  let lastLen = 0;
  let stableCount = 0;
  let doneStableCount = 0;
  let emptyCount = 0;
  let doneLen = -1;
  let responseText = '';

  for (let k = 0; k < 160; k++) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      await page.mouse.wheel(0, 6000);
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        document.querySelectorAll('message-content .markdown, .model-response-text, .markdown')
          .forEach(e => e.scrollIntoView({ block: 'end' }));
      });
    } catch (e) {}

    const els = await page.$$('message-content .markdown, .model-response-text, .markdown');
    if (!els || els.length === 0) {
      emptyCount++;
      if (emptyCount >= 40) {
        logFn('   ⚠ Gemini 0 response element ~60s → nghi GỬI HỤT (cold-start) → thoát sớm.');
        break;
      }
    } else {
      emptyCount = 0;
    }

    const curText = els.length > 0 ? await els[els.length - 1].innerText() : '';
    const curLen = curText.length;

    if (k % 6 === 0) {
      logFn(`   ...resp len=${curLen} (els=${els.length}, stable=${stableCount}, done=${doneStableCount})`);
    }

    if (validate && validate(curText)) {
      if (curLen === doneLen) {
        doneStableCount++;
      } else {
        doneStableCount = 1;
        doneLen = curLen;
      }
      if (doneStableCount >= 2) {
        responseText = curText;
        break;
      }
    } else {
      doneStableCount = 0;
      doneLen = -1;
    }

    if (curLen > minLen && curLen === lastLen) {
      stableCount++;
      if (stableCount >= 3) {
        responseText = curText;
        break;
      }
    } else {
      stableCount = 0;
    }
    lastLen = curLen;
  }

  return responseText || '';
}

/**
 * Phân tích câu trả lời của Gemini Web thành Map { index(1..N): translatedText }
 */
function parseResponseLo(respText, expectedCount) {
  const result = {};
  if (!respText) return result;

  const lines = respText.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Khớp mẫu "1. text" hoặc "1 @00:10:59 text"
    const m = line.match(/^\s*(\d+)\s*[\.\):\-]\s*(.+?)\s*$/) ||
              line.match(/^\s*(\d+)\s+(@\d{1,2}:\d{2}:\d{2}.*?|\[.*?)\s*$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (idx >= 1 && idx <= expectedCount) {
        let text = m[2].trim().replace(/^["']|["']$/g, '');
        // Xóa echo prefix nếu có
        text = text.replace(/^(?:\[\d+(?:\.\d+)?s\s*≤\d+\s*từ\]|@\d{1,2}:\d{2}:\d{2})\s*/i, '').trim();
        result[idx] = text;
      }
    }
  }

  // Fallback map theo thứ tự dòng nếu Gemini không đánh số câu
  if (Object.keys(result).length < expectedCount * 0.6) {
    const seq = lines.map(x => x.trim()).filter(x => x && !x.endsWith(':'));
    if (seq.length === expectedCount) {
      seq.forEach((txt, i) => {
        let clean = txt.replace(/^\d+\s*[\.\):\-]\s*/, '').trim();
        clean = clean.replace(/^(?:\[\d+(?:\.\d+)?s\s*≤\d+\s*từ\]|@\d{1,2}:\d{2}:\d{2})\s*/i, '').trim();
        result[i + 1] = clean;
      });
    }
  }

  return result;
}

/**
 * Mở và giữ phiên trình duyệt ngầm Playwright
 */
async function getGeminiSession(show = false, logFn = console.log) {
  if (_GEM_CTX && _GEM_PAGE && !_GEM_PAGE.isClosed()) {
    return { context: _GEM_CTX, page: _GEM_PAGE };
  }

  const profileDir = getGeminiProfileDir();
  logFn(`🔥 Gemini Web Node.js mở phiên BỀN với Profile: ${profileDir}`);

  _GEM_CTX = await launchPersistentBrowserContext(profileDir, { headless: !show });
  _GEM_PAGE = _GEM_CTX.pages().length > 0 ? _GEM_CTX.pages()[0] : await _GEM_CTX.newPage();
  return { context: _GEM_CTX, page: _GEM_PAGE };
}

/**
 * Đóng phiên trình duyệt ngầm
 */
async function closeGeminiSession() {
  try {
    if (_GEM_CTX) {
      await _GEM_CTX.close();
      _GEM_CTX = null;
      _GEM_PAGE = null;
    }
  } catch (e) {}
}

/**
 * Thực hiện gửi mẻ Prompt dịch qua Playwright Node.js
 */
async function hoiGeminiWebNodeJS(prompt, options = {}) {
  const logFn = options.logFn || console.log;
  const { page } = await getGeminiSession(options.show || false, logFn);

  logFn('[GeminiWebNodeJS] Mở trang Gemini App...');
  try {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {}

  // Tìm ô nhập liệu
  let editor = null;
  for (let i = 0; i < (options.waitLogin || 40); i++) {
    editor = await page.$("div.ql-editor[contenteditable='true']") ||
             await page.$("div[contenteditable='true'][role='textbox']") ||
             await page.$("div[contenteditable='true']");
    if (editor) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!editor) {
    throw new Error('Không thấy ô nhập liệu Gemini (chưa đăng nhập hoặc thay đổi giao diện web).');
  }

  logFn('[GeminiWebNodeJS] Gõ prompt + gửi...');
  await editor.click();
  await page.keyboard.insertText(prompt);
  await new Promise(r => setTimeout(r, 600));
  await page.keyboard.press('Enter');

  logFn('[GeminiWebNodeJS] Chờ Gemini phản hồi...');
  const resp = await doiPhanHoi(page, 50, options.validate, logFn);
  return resp;
}

/**
 * Hàm Dịch Phụ Đề Chính Thuần Node.js (dichSrt)
 */
async function dichSrtNodeJS(srtPath, outPath, options = {}) {
  const logFn = options.logFn || console.log;
  const tmDir = options.tmDir || path.join(APP_ROOT, 'scripts', 'translation_memory');
  const targetLang = options.targetLang || 'vi';

  if (!fs.existsSync(srtPath)) {
    throw new Error(`File phụ đề nguồn không tồn tại: ${srtPath}`);
  }

  const parser = new Parser();
  const rawSrt = fs.readFileSync(srtPath, 'utf-8');
  const items = parser.fromSrt(rawSrt).map(it => ({
    id: it.id,
    timestamp: `${it.startTime} --> ${it.endTime}`,
    text: it.text.trim()
  }));

  logFn(`[GeminiWebNodeJS] Đọc ${items.length} câu từ ${path.basename(srtPath)}`);

  const tmContent = docTm(tmDir);
  const BATCH_SIZE = 40;
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  const translatedMap = {};

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const offset = bIdx * BATCH_SIZE;
    logFn(`[GeminiWebNodeJS] Dịch lô ${bIdx + 1}/${batches.length} (${batch.length} câu)...`);

    const prompt = buildPrompt(batch, tmContent, targetLang, true);
    const validate = (respText) => {
      const parsed = parseResponseLo(respText, batch.length);
      return Object.keys(parsed).length >= Math.floor(batch.length * 0.9);
    };

    let respText = '';
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        respText = await hoiGeminiWebNodeJS(prompt, { logFn, validate, show: options.show });
        const parsed = parseResponseLo(respText, batch.length);
        if (Object.keys(parsed).length >= Math.floor(batch.length * 0.8)) {
          for (const [k, v] of Object.entries(parsed)) {
            translatedMap[offset + parseInt(k, 10)] = v;
          }
          success = true;
          break;
        }
      } catch (err) {
        logFn(`⚠ Thử lại lô ${bIdx + 1} (lần ${attempt}/3): ${err.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (!success) {
      logFn(`⚠ Lô ${bIdx + 1} không đủ số câu trả về, vá bằng câu gốc.`);
      batch.forEach((it, i) => {
        if (!translatedMap[offset + i + 1]) {
          translatedMap[offset + i + 1] = it.text;
        }
      });
    }
  }

  // Vá câu sót (Rescue Retry - Lớp 3 & Lớp 4)
  const sotIndices = [];
  items.forEach((it, idx) => {
    const trans = translatedMap[idx + 1] || '';
    if (!trans || trans === it.text || tyLeHan(trans) > 0.2) {
      sotIndices.push(idx + 1);
    }
  });

  if (sotIndices.length > 0 && sotIndices.length < items.length) {
    logFn(`🔁 Phát hiện ${sotIndices.length} câu dịch sót/còn chữ Hán → Dịch vá riêng...`);
    const sotItems = sotIndices.map(i => items[i - 1]);
    try {
      const sotPrompt = buildPrompt(sotItems, tmContent, targetLang, false);
      const respSot = await hoiGeminiWebNodeJS(sotPrompt, { logFn, show: options.show });
      const parsedSot = parseResponseLo(respSot, sotItems.length);
      for (const [k, v] of Object.entries(parsedSot)) {
        const itemIdx = sotIndices[parseInt(k, 10) - 1];
        if (v && tyLeHan(v) <= 0.2 && v !== items[itemIdx - 1].text) {
          translatedMap[itemIdx] = v;
        }
      }
    } catch (e) {
      logFn(`⚠ Vá câu sót thất bại: ${e.message}`);
    }
  }

  // Lớp 4 - Triệt hạ chữ Trung còn sót sau các bước
  items.forEach((it, idx) => {
    const trans = translatedMap[idx + 1] || '';
    if (tyLeHan(trans) > 0.2 || trans === it.text) {
      translatedMap[idx + 1] = ''; // Bỏ trống để không lộ chữ Trung trên video
    }
  });

  // Xuất file SRT kết quả
  const outputSrtArray = items.map((it, idx) => {
    const times = it.timestamp.split('-->');
    return {
      id: String(it.id),
      startTime: times[0].trim(),
      endTime: times[1].trim(),
      text: translatedMap[idx + 1] || ''
    };
  });

  const outSrtContent = parser.toSrt(outputSrtArray);
  fs.writeFileSync(outPath, outSrtContent, 'utf-8');
  logFn(`[GeminiWebNodeJS] ✔ DỊCH XONG! Đã lưu tại: ${outPath} (${Object.keys(translatedMap).length}/${items.length} câu)`);

  return { outputPath: outPath, translatedCount: Object.keys(translatedMap).length, totalCount: items.length };
}

module.exports = {
  getGeminiProfileDir,
  openGeminiLoginWindow,
  docTm,
  tyLeHan,
  tranTuDich,
  slotGiay,
  buildPrompt,
  parseResponseLo,
  getGeminiSession,
  closeGeminiSession,
  hoiGeminiWebNodeJS
};
