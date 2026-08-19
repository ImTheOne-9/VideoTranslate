const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Parser = require('srt-parser-2').default;
const { getAppDataRoot } = require('./path-helper');

const APP_ROOT = path.resolve(__dirname, '..');

// Biến lưu phiên Browser persistent duy nhất trong Node.js
let _GEM_CTX = null;
let _GEM_PAGE = null;
let _GEM_PROFILE_DIR = null;
let _GEM_FIRST_EDITOR_WAIT = true;
let _GEM_OP_LOCK = Promise.resolve();
let _GEM_LOGIN_ACTIVE = false;
let _GEM_CHAT_READY = false;

/**
 * Dọn dẹp các file Lock Singleton bị kẹt từ phiên trước (tránh crash exitCode 21)
 */
function cleanProfileLocks(profileDir) {
  if (!profileDir || !fs.existsSync(profileDir)) return;
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];
  for (const name of lockFiles) {
    const fp = path.join(profileDir, name);
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
      }
    } catch (e) {
      // Bỏ qua nếu file đang bị lock cứng bởi tiến trình đang sống
    }
  }
}

/**
 * Lấy đường dẫn thư mục Profile Gemini
 */
function getGeminiProfileDir() {
  const customDir = process.env.GEMINI_PROFILE_DIR;
  if (customDir && String(customDir).trim()) {
    if (!fs.existsSync(customDir)) {
      fs.mkdirSync(customDir, { recursive: true });
    }
    return customDir;
  }

  const dataRoot = getAppDataRoot(path.join(APP_ROOT, 'temp'));
  const profileDir = path.join(dataRoot, 'gemini_profile');
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  return profileDir;
}

/**
 * Giữ tên hàm cũ để tương thích với các nơi gọi hiện có, nhưng dịch và đăng nhập
 * phải dùng chung một profile bền vững để cookie tài khoản thực sự có hiệu lực.
 */
function getGeminiTranslationProfileDir() {
  return getGeminiProfileDir();
}

function getGeminiFailureDir() {
  const customDir = process.env.GEMINI_FAILURE_DIR;
  const failureDir = customDir && String(customDir).trim()
    ? String(customDir).trim()
    : path.join(getAppDataRoot(path.join(APP_ROOT, 'temp')), 'gemini-web-errors');
  if (!fs.existsSync(failureDir)) fs.mkdirSync(failureDir, { recursive: true });
  return failureDir;
}

async function inspectGeminiPageState(page) {
  if (!page || page.isClosed?.()) {
    return { url: '', title: '', signInVisible: false, editorVisible: false, bodyPreview: '' };
  }
  try {
    return await page.evaluate(() => {
      const visible = element => Boolean(element && element.offsetParent !== null);
      const signInVisible = Array.from(document.querySelectorAll('button,a,div,span')).some(element => {
        if (!visible(element)) return false;
        const text = String(element.textContent || '').trim();
        return text.length <= 12 && /^(sign\s?in|đăng\s?nhập)$/i.test(text);
      });
      const editor = document.querySelector(
        "div.ql-editor[contenteditable='true'], div[contenteditable='true'][role='textbox'], div[contenteditable='true']"
      );
      return {
        url: location.href,
        title: document.title || '',
        signInVisible,
        editorVisible: visible(editor),
        bodyPreview: String(document.body?.innerText || '').slice(0, 2000)
      };
    });
  } catch (error) {
    return { url: page.url?.() || '', title: '', signInVisible: false, editorVisible: false, bodyPreview: '', error: error.message };
  }
}

async function captureGeminiFailure(page, reason, prompt = '', logFn = console.log, response = '') {
  if (process.env.GEMINI_CAPTURE_FAILURE === '0') return null;
  try {
    const failureDir = getGeminiFailureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = String(reason || 'unknown').replace(/[^a-z0-9_-]+/gi, '-');
    const base = path.join(failureDir, `${stamp}_${safeReason}`);
    const state = await inspectGeminiPageState(page);
    fs.writeFileSync(`${base}_state.json`, JSON.stringify({ reason, ...state }, null, 2), 'utf8');
    fs.writeFileSync(`${base}_prompt.txt`, String(prompt || ''), 'utf8');
    fs.writeFileSync(`${base}_response.txt`, String(response || ''), 'utf8');
    try { await page.screenshot({ path: `${base}.png`, fullPage: false }); } catch (error) {}

    const files = fs.readdirSync(failureDir)
      .map(name => ({ fullPath: path.join(failureDir, name), time: fs.statSync(path.join(failureDir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const file of files.slice(45)) {
      try { fs.unlinkSync(file.fullPath); } catch (error) {}
    }
    logFn(`🔬 Đã lưu hiện vật lỗi Gemini tại: ${failureDir}`);
    return { failureDir, state };
  } catch (error) {
    return null;
  }
}

/**
 * Đọc phản hồi Gemini mà vẫn giữ số thứ tự của danh sách HTML. Với <ol><li>,
 * số hiển thị thuộc CSS ::marker nên innerText không chứa số và parser cue sẽ
 * nhận 0/N dù người dùng nhìn thấy danh sách được đánh số trên màn hình.
 */
async function extractGeminiResponseText(element) {
  if (!element) return { text: '', orderedListItemCount: 0 };
  let innerText = '';
  try { innerText = String(await element.innerText() || ''); } catch (error) {}

  try {
    const orderedLists = await element.$$('ol');
    if (!orderedLists.length) return { text: innerText, orderedListItemCount: 0 };
    const rebuilt = [];
    for (const list of orderedLists) {
      const rawStart = await list.getAttribute('start');
      const parsedStart = Number.parseInt(rawStart || '1', 10);
      const start = Number.isFinite(parsedStart) ? parsedStart : 1;
      const items = await list.$$(':scope > li');
      for (let offset = 0; offset < items.length; offset += 1) {
        const itemText = String(await items[offset].innerText() || '').trim().replace(/\s+/g, ' ');
        if (itemText) rebuilt.push(`${start + offset}. ${itemText}`);
      }
    }
    if (!rebuilt.length) return { text: innerText, orderedListItemCount: 0 };
    const oldLineCount = innerText.split(/\r?\n/).filter(line => line.trim()).length;
    if (rebuilt.length < oldLineCount) return { text: innerText, orderedListItemCount: 0 };
    return { text: rebuilt.join('\n'), orderedListItemCount: rebuilt.length };
  } catch (error) {
    return { text: innerText, orderedListItemCount: 0 };
  }
}

/**
 * Tự động tìm đường dẫn Chromium của Playwright nếu thiếu env
 */
function setupPlaywrightEnv() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) {
    const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '');
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    const execDir = path.dirname(process.execPath || '');

    const candidates = [
      path.join(APP_ROOT, 'runtime', 'ms-playwright'),
      path.join(APP_ROOT, 'runtime', 'ms-playwright-python'),
      path.join(APP_ROOT, '..', 'runtime', 'ms-playwright'),
      path.join(APP_ROOT, '..', 'runtime', 'ms-playwright-python'),
      execDir ? path.join(execDir, 'ms-playwright') : null,
      execDir ? path.join(execDir, 'ms-playwright-python') : null,
      execDir ? path.join(execDir, '..', 'runtime', 'ms-playwright') : null,
      appData ? path.join(appData, 'video-studio-tools', 'runtime', 'ms-playwright') : null,
      appData ? path.join(appData, 'video-studio-tools', 'runtime', 'ms-playwright-python') : null,
      appData ? path.join(appData, 'Video Studio Tools', 'crawler', 'runtime', 'ms-playwright-python') : null,
      appData ? path.join(appData, 'Video Studio Tools', 'crawler', 'runtime', 'ms-playwright-node') : null,
      localAppData ? path.join(localAppData, 'ms-playwright') : null,
      appData ? path.join(appData, 'ms-playwright') : null
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
  cleanProfileLocks(profileDir);

  const baseArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-first-run',
    '--no-default-browser-check'
  ];
  const launchOpts = {
    headless: options.headless ?? true,
    args: baseArgs,
    viewport: { width: 1200, height: 900 }
  };

  const tryLaunch = async (channelName) => {
    cleanProfileLocks(profileDir);
    const opts = channelName ? { ...launchOpts, channel: channelName } : launchOpts;
    return await chromium.launchPersistentContext(profileDir, opts);
  };

  // 1. Ưu tiên Chromium Playwright mặc định
  try {
    setupPlaywrightEnv();
    return await tryLaunch();
  } catch (err0) {
    console.warn(`[GeminiWeb] Thử Chromium Playwright thất bại (${err0.message}). Chuyển sang Chrome hệ thống...`);
  }

  // 2. Dự phòng Google Chrome hệ thống
  try {
    return await tryLaunch('chrome');
  } catch (err1) {
    console.warn(`[GeminiWeb] Thử Chrome hệ thống thất bại: ${err1.message}`);
  }

  // 3. Dự phòng Microsoft Edge hệ thống (kèm cơ chế dọn lock retry)
  try {
    return await tryLaunch('msedge');
  } catch (err2) {
    console.warn(`[GeminiWeb] Thử Edge lần 1 thất bại (${err2.message}). Dọn lock và thử lại...`);
    cleanProfileLocks(profileDir);
    await new Promise(r => setTimeout(r, 1000));
    return await tryLaunch('msedge');
  }
}

/**
 * Mở cửa sổ Chrome Playwright (headless: false) cho người dùng đăng nhập Gemini
 */
async function openGeminiLoginWindow() {
  if (_GEM_LOGIN_ACTIVE) {
    throw new Error('Cửa sổ đăng nhập Gemini đang mở. Hãy hoàn tất hoặc đóng cửa sổ hiện tại.');
  }
  if (_GEM_CTX && _GEM_PAGE && !_GEM_PAGE.isClosed()) {
    throw new Error('Gemini Web đang được dùng để dịch. Hãy chờ dịch xong rồi mở cửa sổ đăng nhập.');
  }
  _GEM_LOGIN_ACTIVE = true;
  const profileDir = getGeminiProfileDir();
  cleanProfileLocks(profileDir);
  console.log(`[GeminiWebService] Mở cửa sổ đăng nhập Gemini với Profile: ${profileDir}`);
  let context;
  try {
    context = await launchPersistentBrowserContext(profileDir, { headless: false });
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
    } catch (err) {
      console.warn(`[GeminiLogin] Cảnh báo điều hướng: ${err.message}`);
    }

    let lastState = await inspectGeminiPageState(page);
    return await new Promise((resolve) => {
      let finishing = false;
      const finish = async () => {
        if (finishing) return;
        finishing = true;
        clearInterval(interval);
        try { await context.close(); } catch (error) {}
        cleanProfileLocks(profileDir);
        _GEM_LOGIN_ACTIVE = false;
        const loggedIn = !lastState.signInVisible && Boolean(lastState.url?.includes('gemini.google.com'));
        const message = loggedIn
          ? 'Đã xác nhận đăng nhập Gemini và lưu profile.'
          : 'Đã đóng trình duyệt nhưng chưa xác nhận đăng nhập Gemini. Chế độ khách vẫn có thể dịch.';
        console.log(`[GeminiLogin] ${message}`);
        resolve({ success: true, profileDir, loggedIn, guestAvailable: Boolean(lastState.editorVisible), message });
      };
      const interval = setInterval(async () => {
        try {
          if (page.isClosed() || context.pages().length === 0) return finish();
          lastState = await inspectGeminiPageState(page);
        } catch (err) {
          return finish();
        }
      }, 1000);
    });
  } catch (error) {
    _GEM_LOGIN_ACTIVE = false;
    try { await context?.close(); } catch (closeError) {}
    throw error;
  }
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
function nhipTuDich(targetLang = 'vi') {
  const configured = Number(process.env.DUB_WPS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  const measured = { vi: 5.0, es: 1.94, pt: 1.96 };
  return measured[String(targetLang || '').toLowerCase().slice(0, 2)] || 2.0;
}

function tranTuDich(giay, nguon, wpsMax = null, tiLe = 0.75, targetLang = 'vi') {
  const text = String(nguon || '');
  const hanMatch = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
  const nAm = hanMatch.length || Math.max(1, text.split(/\s+/).length);
  const physicalWps = wpsMax !== null && wpsMax !== undefined && Number.isFinite(Number(wpsMax))
    ? Number(wpsMax)
    : nhipTuDich(targetLang);
  if (tiLe === null || tiLe === undefined) {
    return Math.max(3, Math.floor(giay * physicalWps));
  }
  return Math.max(3, Math.floor(Math.min(giay * physicalWps, nAm * Number(tiLe))));
}

/**
 * Xây dựng Bộ QUY TẮC CHUNG 4 bậc ưu tiên & System Prompt
 */
function getQuyTacChung() {
  return `=== QUY TẮC DỊCH THUẬT & PHONG CÁCH (BẮT BUỘC) ===
0. THỨ TỰ ƯU TIÊN KHI CÁC QUY TẮC XUNG ĐỘT (áp dụng cho TOÀN BỘ tài liệu này, kể cả các mục ghi 'BẮT BUỘC'/'TUYỆT ĐỐI'/'THẮNG'):
   ① ĐÚNG NGHĨA + NGƯỜI VIỆT ĐỌC LÀ HIỂU NGAY  →  ② ĐÚNG SỐ DÒNG (1 dòng gốc = 1 dòng dịch)  →  ③ NGẮN vừa khe thời gian  →  ④ PHONG CÁCH/GIỌNG VĂN.
   Nghĩa là: thà DÀI hơn trần một chút còn hơn viết ra câu người Việt không hiểu; và KHÔNG BAO GIỜ hy sinh ① để đạt ③.
1. XỬ LÝ LỖI OCR BẢN GỐC: Dữ liệu đầu vào quét từ video nên sẽ có lỗi OCR (sai mặt chữ, sinh ra từ vô nghĩa, sai ngữ cảnh). Nếu thấy một từ phá vỡ ngữ pháp, BẮT BUỘC phải dựa vào ngữ cảnh cả đoạn để ĐOÁN chữ đúng và dịch theo ý đúng, TUYỆT ĐỐI KHÔNG dịch bám vào chữ sai đó.
2. TỰ ĐỘNG NHẬN DIỆN & THÍCH ỨNG THỂ LOẠI (RẤT QUAN TRỌNG): Dựa vào nội dung đoạn thoại, tự xác định thể loại video và áp dụng quy tắc xưng hô, văn phong tương ứng.
   ⚠ ƯU TIÊN: nếu BÊN DƯỚI có khối "QUY TẮC + TỪ ĐIỂN TÊN RIÊNG" (phong cách do NGƯỜI DÙNG tự chọn) thì PHONG CÁCH ĐÓ THẮNG mục 2 này — mục 2 chỉ dùng khi người dùng KHÔNG chọn phong cách riêng. Người dùng chọn giọng gì thì viết đúng giọng đó, KHÔNG tự đổi sang giọng theo thể loại bạn đoán được.
   - Nếu là CỔ TRANG / TU TIÊN: BẮT BUỘC dùng từ Hán-Việt cho danh từ đặc thù (chiêu thức, đan dược, tông môn, pháp bảo, cảnh giới...). VD: 'Ngự Kiếm Thuật', 'Trúc Cơ' (Cấm dịch thuần Việt như 'Kỳ xây nền'). Xưng hô: tại hạ, các hạ, sư tôn, đồ đệ, đạo hữu, vãn bối, lão phu...
   - Nếu là HIỆN ĐẠI / DRAMA / ĐỜI SỐNG: Lời thoại phải là KHẨU NGỮ đời thường, mượt mà. Xưng hô linh hoạt theo quan hệ (anh/em, ông/tôi, mày/tao, vợ/chồng...). Có thể dùng từ lóng, nói giảm, nói tắt của người Việt hiện đại.
   - Nếu là REVIEW / TIN TỨC / KIẾN THỨC: Giọng kể khách quan, rõ ràng, gãy gọn. Chú trọng dịch chuẩn xác các thông số, con số và thuật ngữ chuyên ngành.
2b. KHÔNG ĐỂ LỌT CHỮ HÁN — NHƯNG CŨNG KHÔNG PHIÊN ÂM: bản dịch không được còn BẤT KỲ ký tự chữ Hán nào (kể cả 1 chữ lẻ dính trong từ, vd 技, 剣) hay pinyin. Từ gốc Hán phải được dịch sang NGHĨA tiếng Việt (vd 剣技 → 'kiếm thuật' / 'kỹ năng').
   ⛔ NGHIÊM CẤM PHIÊN ÂM HÁN-VIỆT MÁY MÓC TỪNG CHỮ. Phiên âm KHÔNG phải là dịch. Đối chiếu SAI → ĐÚNG: '这是一种' → SAI 'giá thị nhất loại' / ĐÚNG 'Đây là một loại'; '流浪行星' → SAI 'lưu láng hành tinh' / ĐÚNG 'hành tinh lang thang'; '公转' → SAI 'công chuyển' / ĐÚNG 'quay quanh'; '虽然…不太现实' → SAI 'tuy tuyển… bất thái hiện thực' / ĐÚNG 'tuy… không thực tế lắm'. Hư từ (这是, 虽然, 但是, 因此…) LUÔN dịch thành hư từ tiếng Việt thường ngày, TUYỆT ĐỐI không phiên âm.
3. KHỬ VĂN DỊCH MÁY: Áp dụng cho MỌI thể loại. Cấm dùng các cụm từ rập khuôn, thừa thãi như "một cách...", "sự...", "việc mà...", "điều đó...". Lời thoại phải mượt như người Việt thật sự nói.
=== HẾT QUY TẮC ===\n\n`;
}

const TARGET_LANGUAGE_NAMES = {
  vi: 'Vietnamese', en: 'English', ko: 'Korean', fr: 'French', es: 'Spanish',
  pt: 'Portuguese', th: 'Thai', de: 'German', it: 'Italian', ja: 'Japanese',
  ru: 'Russian', id: 'Indonesian', ms: 'Malay', hi: 'Hindi', ar: 'Arabic',
  tr: 'Turkish', zh: 'Chinese'
};

const TARGET_BREVITY_RULES = {
  en: "- {L} BREVITY: use contractions (don't, it's, I'm), reduced clauses (V-ing/V-ed), drop 'that' in relative clauses, cut redundant articles/pronouns.",
  ko: '- {L} BREVITY: Korean bloats from honorific endings — use short informal/plain endings (해요체/반말: -어/-아) or noun-style endings (-음/-기); DROP particles 은/는/이/가/을/를 where clear.',
  th: '- {L} BREVITY: Thai bloats from sentence-final politeness words — DROP ครับ/ค่ะ and unnecessary pronouns; use short compound words instead of descriptive phrases.',
  ja: '- {L} BREVITY: use plain form (だ/-る) instead of です/ます, DROP topic/subject/object particles は/が/を where clear.',
  es: "- {L} BREVITY: Spanish is pro-drop — DROP subject pronouns (yo/tú/él); use gerund (-ando/-iendo) instead of 'que' relative clauses (el hombre que corre -> el hombre corriendo).",
  pt: "- {L} BREVITY: Portuguese is pro-drop — DROP subject pronouns; contract estar (está -> tá in casual), turn 'de + pronoun' possessives into short possessive adjectives.",
  fr: "- {L} BREVITY: replace 'est-ce que' with inversion/intonation; use pronouns en/y to collapse long prepositional phrases; drop redundant subject repetition.",
  de: '- {L} BREVITY: contract preposition+article (in dem -> im, zu dem -> zum); turn relative clauses into pre-nominal participle phrases; drop optional pronouns.',
  it: '- {L} BREVITY: Italian is pro-drop — DROP subject pronouns; attach object pronouns to the verb (mancarlo, not mancare a lui).',
  ru: "- {L} BREVITY: DROP the present-tense 'to be' (быть); use case endings to omit non-essential prepositions; drop optional subject pronouns.",
  id: "- {L} BREVITY: drop formal verb prefixes (me-, ber-) where natural; use short suffix -ku instead of 'punya saya'; cut the connector 'yang' when possible.",
  ms: "- {L} BREVITY: drop prefixes (meng-, ber-), drop the connector 'yang', use short casual forms (dah for sudah).",
  ar: '- {L} BREVITY: DROP subject pronouns (already in the verb ending); use Idhafa (direct noun-noun genitive) instead of prepositional possessive.',
  hi: "- {L} BREVITY: drop the copula होना (to be) at the end when the tense is clear from context; use the -कर conjunctive participle to join two actions.",
  tr: '- {L} BREVITY: DROP subject pronouns (verb ending already marks person); collapse subordinate clauses into a single verbal noun via suffixes (-dığı, -en).'
};

/**
 * Dựng Prompt hoàn chỉnh gửi cho Gemini Web
 */
function buildPrompt(items, tmContent, targetLang = 'vi', fit = true, mode = 'translate') {
  const targetName = TARGET_LANGUAGE_NAMES[targetLang] || String(targetLang || '').toUpperCase();
  const isVietnamese = targetLang === 'vi';
  let prefix = '';
  if (mode === 'spellcheck') {
    prefix = `Dưới đây là phụ đề do phần mềm nhận dạng giọng nói (Whisper) tạo ra nên có LỖI CHÍNH TẢ, sai dấu thanh, sai từ đồng âm và thiếu dấu câu. Nhiệm vụ của bạn: KIỂM TRA và SỬA LỖI CHÍNH TẢ + dấu câu cho từng dòng.
- CHỈ sửa chính tả/dấu — GIỮ NGUYÊN Ý, KHÔNG dịch, KHÔNG viết lại, KHÔNG thêm/bớt/gộp/tách câu.
- Dòng nào đã đúng → chép lại y nguyên.
CHỈ trả về kết quả: mỗi dòng MỘT câu, GIỮ NGUYÊN số thứ tự '1.' '2.'… đầu mỗi dòng, đúng thứ tự, KHÔNG gộp/tách dòng. TUYỆT ĐỐI KHÔNG thêm gì khác — không lời dẫn, không giải thích, không markdown:\n\n`;
  } else if (isVietnamese) {
    prefix = getQuyTacChung();
    if (tmContent) {
      prefix += `QUY TẮC + TỪ ĐIỂN TÊN RIÊNG (BẮT BUỘC, nhất quán Hán-Việt):\n=== QUY TẮC ===\n${tmContent}\n=== HẾT ===\n\n`;
    }
    prefix += `Bạn là NGƯỜI BẢN NGỮ đang KỂ LẠI câu chuyện dưới đây bằng tiếng Việt — KHÔNG PHẢI máy dịch từng chữ. Áp dụng các quy tắc ở trên.
CÁCH LÀM (theo đúng thứ tự):
1) ĐỌC HẾT cả đoạn dưới trước — đây là 1 ĐOẠN LIÊN TỤC (hội thoại/thuyết minh của CÙNG người nói), KHÔNG phải câu rời rạc.
2) HIỂU tình huống: chuyện gì đang xảy ra, ai nói với ai, họ đang muốn truyền đạt điều gì (thông tin/cảm xúc/ý định) — không chỉ dịch nghĩa đen từng chữ.
3) Chốt xưng hô + đại từ (tôi/mình/bạn/anh/chị...) và GIỮ NHẤT QUÁN xuyên suốt cả đoạn.
4) VIẾT LẠI từng câu bằng tiếng Việt tự nhiên — NHƯ NGƯỜI VIỆT THẬT SỰ SẼ NÓI trong tình huống đó. Mục tiêu là ĐÚNG Ý NGHĨA + CẢM XÚC + TÌNH TIẾT của cả câu chuyện, KHÔNG PHẢI đúng câu chữ gốc. ĐƯỢC PHÉP đổi cấu trúc câu, đổi cách diễn đạt, viết lại hoàn toàn khác — miễn giữ đủ thông tin và tình tiết. Câu cụt/thiếu chủ ngữ → suy đúng nghĩa từ ngữ cảnh xung quanh.
QUY TẮC PHỤ ĐỀ — bạn LÀM PHỤ ĐỀ cho LỒNG TIẾNG, giọng phải đọc kịp trong khe thời gian mỗi câu nên CÀNG NGẮN CÀNG TỐT miễn giữ đủ ý — NGẮN phải là KẾT QUẢ TỰ NHIÊN của việc kể lại theo cách người Việt nói, KHÔNG PHẢI dịch sát nghĩa xong rồi mới cắt bớt chữ:
- Nếu Ở TRÊN có yêu cầu VIẾT LẠI theo phong cách → phong cách đó quyết GIỌNG VĂN, nhưng các quy tắc ngắn-gọn/thời-lượng ở đây vẫn là TRẦN độ dài.
- GIỮ ý CỐT LÕI + MỌI chi tiết mô tả (đặc điểm, con số, tính chất được kể) — KHÔNG bỏ tình tiết + KHÔNG bịa. Câu LIỆT KÊ nhiều đặc điểm (vd đặc tính đồ vật) → GIỮ ĐỦ mọi đặc điểm, chỉ rút gọn CÁCH NÓI.
- Thêm DẤU PHẨY / DẤU CHẤM ở chỗ NGẮT NHỊP tự nhiên (tool cắt dòng phụ đề theo các dấu này).
- KHÔNG viết tắt (KHÔNG 'TQ','HN','ko'…) — phụ đề này còn dùng để LỒNG TIẾNG đọc thành tiếng.
- DỊCH 1:1 (RÀNG BUỘC CỨNG, KHÔNG ĐƯỢC PHÁ dù viết lại tự do về CÁCH NÓI): MỖI dòng gốc VẪN → ĐÚNG 1 dòng dịch, đúng thứ tự, TUYỆT ĐỐI KHÔNG gộp/tách/bỏ dòng — mỗi dòng gốc gắn 1 khe thời gian cố định trong video, gộp/tách sẽ làm LỆCH đồng bộ hình-tiếng (tool dedupe câu trùng TRƯỚC khi gửi — bạn KHÔNG cần lo lặp).
  ⚠ KỂ CẢ dòng RẤT NGẮN hay câu DẪN/NỐI ('tóm lại', 'tức là', 'nói cách khác', 'và', 'thì', 'nó là'…) VẪN phải có 1 dòng dịch RIÊNG mang ĐÚNG số đó — TUYỆT ĐỐI KHÔNG dồn câu dẫn ngắn vào dòng kế rồi đánh số lại. Bỏ 1 dòng sẽ làm LỆCH SỐ toàn bộ phụ đề phía sau (chữ hiện sai thời điểm, sub gốc dài mà bản dịch ngắn). SỐ DÒNG OUTPUT PHẢI BẰNG SỐ DÒNG INPUT.
  ⚠ ĐOẠN CUỐI/LỜI BÌNH có NHIỀU DÒNG NGẮN LIÊN TIẾP (3-6 chữ, cùng 1 mạch ý — vd lời bình kết phim) là nơi DỄ PHẠM LUẬT 1:1 NHẤT: bạn sẽ có xu hướng gộp chúng thành 1 câu văn xuôi trôi chảy cho tự nhiên — TUYỆT ĐỐI KHÔNG LÀM VẬY. VD 3 dòng gốc '却又在最高潮处' / '无情撕碎了人定胜天的幻想' / '电影安东败给闯红灯的路人' PHẢI ra ĐÚNG 3 dòng dịch riêng (mỗi dòng ý ngắn/cụt cũng được, KHÔNG được nối chúng thành 1 câu dài rồi bỏ 2 dòng kia). Nghe rời rạc hơn văn xuôi KHÔNG SAO — đây là PHỤ ĐỀ đồng bộ theo khung hình, không phải văn bản đọc liền mạch.\n`;
    if (fit) {
      prefix += `- KHỚP LỒNG TIẾNG (QUAN TRỌNG — đọc kỹ): đầu mỗi dòng có [Ts ≤N từ] = câu này có T GIÂY để TTS đọc. Đếm rất dễ: mỗi từ cách nhau 1 dấu cách ('Anh ấy tới rồi' = 4 từ).
  N LÀ MỤC TIÊU, KHÔNG PHẢI LUẬT CẤM: hãy cố viết trong N từ. Nhưng nếu ép đúng N làm CỤT Ý hoặc câu văn Việt nghe gượng, được phép vượt một chút (đừng quá khoảng 1/5 số N). ĐỦ NGHĨA và TỰ NHIÊN quan trọng hơn ngắn; không được bịa thêm ý để làm câu dài.
  Vì sao dễ vượt: tiếng Trung 1 chữ = 1 âm, tiếng Việt cùng ý thường TỐN NHIỀU ÂM HƠN — nên dịch sát chữ gần như luôn tràn. Phải CHỦ ĐỘNG nén ngay từ lúc viết, không phải viết dài rồi cắt.
  ĐỊNH NGHĨA 'giữ nghĩa' Ở ĐÂY = giữ THÔNG TIN CỐT LÕI (AI làm GÌ, cái GÌ, con số, tình tiết) — và ĐƯỢC PHÉP CẮT BỎ: từ đệm (thật sự, rất rất, một cách, đấy, ấy mà, vô cùng), từ nối (thì, mà, là, rằng), đại từ/chủ ngữ khi ngữ cảnh đã rõ. Được dùng từ Hán-Việt THÔNG DỤNG khi nó ngắn hơn mà người Việt vẫn hiểu ngay ('phát biểu' 2 từ thay 'đưa ra ý kiến' 4 từ) — NHƯNG TUYỆT ĐỐI KHÔNG vì ngắn mà PHIÊN ÂM Hán-Việt những từ người Việt không dùng đời thường (SAI: 'giá thị', 'công chuyển', 'bất thái', 'lưu láng'). Ngắn mà người nghe KHÔNG HIỂU thì còn tệ hơn dài. TUYỆT ĐỐI KHÔNG in [Ts ≤N từ] vào bản dịch.
  VÍ DỤ (Gốc → SAI dài → ĐÚNG ngắn), để ý số TỪ: '他来了' → 'Anh ấy đã đến nơi đây rồi đấy' (8 từ, SAI) → 'Anh ấy tới rồi' (4 từ, ĐÚNG); '太美了' → 'Cái này thực sự là quá đẹp đi mà' (8 từ, SAI) → 'Đẹp quá' (2 từ, ĐÚNG); '我不知道该怎么办' → 'Tôi thực sự không biết mình nên phải làm thế nào' (11 từ, SAI) → 'Không biết làm sao' (4 từ, ĐÚNG).\n`;
    }
    prefix += `LƯU Ý INPUT: '@HH:MM:SS' đầu mỗi dòng = MỐC GIỜ câu xuất hiện trong video — CHỈ để bạn hiểu TIMING. TUYỆT ĐỐI KHÔNG in '@HH:MM:SS' vào bản dịch.\n`;
    if (fit) {
      prefix += `★ NHẮC LẠI (quan trọng nhất): mỗi dòng KHÔNG ĐƯỢC VƯỢT số từ ghi ở [Ts ≤N từ] — đếm theo dấu cách. Giữ THÔNG TIN CỐT LÕI, cắt từ đệm/nối/đại từ thừa, ưu tiên Hán-Việt.\n`;
    }
    prefix += `CHỈ trả về BẢN DỊCH: mỗi dòng MỘT câu, GIỮ NGUYÊN số thứ tự '1.' '2.'… đầu mỗi dòng, đúng thứ tự, KHÔNG gộp/tách dòng. TUYỆT ĐỐI KHÔNG thêm chữ nào khác — không lời dẫn, không xác nhận, không giải thích, không markdown:\n\n`;
  } else {
    if (tmContent) {
      prefix += `RULES + STYLE (MANDATORY, keep consistent):\n=== RULES ===\n${tmContent}\n=== END ===\n\n`;
    }
    prefix += `CRITICAL STRUCTURAL RULE (read this first, it outranks everything below): the input is an ARRAY OF INDEPENDENT LINES, not a paragraph. Output EXACTLY as many lines as the input has. For every input line 'N. @time [meta] text' your output line MUST start with 'N. ' followed by the translation. Zero merging, zero splitting, zero omissions, zero renumbering.
You are a NATIVE ${targetName} SPEAKER retelling the story below in ${targetName} - you are NOT a word-for-word translation machine. Write in the native script of ${targetName} - do NOT romanize (e.g. Hangul for Korean, Thai script for Thai).
SOURCE HAS OCR ERRORS: the input was scanned off video frames, so some characters are misread and produce nonsense words or break the grammar. When a word breaks the sentence, you MUST infer the intended word from the surrounding lines and translate the INTENDED meaning - never translate the corrupted characters literally.
MATCH THE GENRE (important): infer the genre from the dialogue itself and adapt the register accordingly - historical/xianxia (cultivation, sects, honorifics: keep the established terms of that genre in ${targetName}, do not flatten them into plain modern words), modern drama (natural everyday speech), or commentary/review (a narrator explaining the plot to the viewer). A flat neutral register for every video is WRONG.
PRIORITY WHEN RULES CONFLICT (applies to EVERYTHING below, including rules marked MANDATORY/CRITICAL/HARD):
   (1) CORRECT MEANING, natural ${targetName}  ->  (2) EXACTLY ONE OUTPUT LINE PER INPUT LINE, each keeping its leading number  ->  (3) SHORT enough for the [Ts <=N words] slot - COUNT the words, stay within N.
   If (3) fights (2): obey (2). Never delete, merge or skip a line to save space - write it short instead, and if it still does not fit, leave it slightly long.
HOW TO DO THIS (follow in order):
1) READ ALL LINES below first for CONTEXT - they are consecutive lines of the SAME speaker/scene, so meaning carries across them. Use that context, but still translate them as SEPARATE lines (see CRITICAL STRUCTURAL RULE).
2) UNDERSTAND the situation: what is happening, who is speaking to whom, what are they trying to convey (information/emotion/intent) - not just the literal words.
3) Decide the register/pronouns and keep them CONSISTENT throughout the whole passage.
4) REWRITE each line in natural ${targetName}, the way a real ${targetName} speaker would actually say it in that situation. Your goal is to preserve the MEANING, EMOTION and STORY of the whole conversation, NOT the exact wording of the source. You MAY restructure sentences, change phrasing, or rewrite it completely differently - as long as no information or plot detail is lost. A fragment or subject-less line -> infer the real meaning from context.
SUBTITLE RULES - you are a professional SUBTITLE LOCALIZER for DUBBING; the voice must finish within each line's time slot, so SHORTER IS BETTER as long as meaning survives - brevity must come NATURALLY from retelling it the way a native speaker would, NOT from translating literally first and then trimming words:
- If a STYLE rewrite is requested above, that style controls the TONE - but these timing/brevity rules still cap the LENGTH.
- Keep the CORE meaning + ALL descriptive facts (attributes, numbers, qualities being described) - NEVER drop a plot detail and NEVER invent anything. If a line LISTS several attributes, keep EVERY attribute - only shorten the wording, never the list.
- Add natural punctuation at pauses (the tool splits subtitle lines on these marks).
- Do NOT abbreviate and do NOT romanize - this subtitle is also read aloud for DUBBING.
- 1:1 TRANSLATION (HARD CONSTRAINT, DO NOT BREAK even though you rewrite freely in WORDING): EACH source line MUST STILL map to EXACTLY 1 translated line, same order - NEVER merge/split/drop lines (each source line is tied to a fixed time slot in the video; merging/splitting breaks audio-video sync). OUTPUT LINE COUNT MUST EQUAL INPUT LINE COUNT.
  EVEN very short filler or connector lines MUST still get their OWN line with the EXACT SAME number - never merge a short line into the next one and renumber.
  ⚠ A RUN OF MANY SHORT CONSECUTIVE LINES (3-6 words, same train of thought - e.g. closing commentary) is where you are MOST LIKELY to break the 1:1 rule: you will be tempted to merge them into one flowing sentence for naturalness - DO NOT. Each of those short lines still gets its OWN translated line, even if it reads choppy/fragmented — this is a TIME-SYNCED SUBTITLE, not prose meant to be read as one paragraph.\n`;
    if (fit) {
      const brevityRule = TARGET_BREVITY_RULES[targetLang]
        || '- {L} BREVITY: drop filler words, honorifics and optional pronouns; pick the shortest natural wording.';
      prefix += `- DUB TIMING (CRITICAL): each line starts with [Ts <=N words] = this line has T SECONDS for the TTS voice, so it must fit in AT MOST N WORDS. COUNT THE WORDS — do not exceed N. 'Keep meaning' HERE = keep the CORE INFO (who does what, the facts/numbers) and you ARE ALLOWED to DROP: filler words, connectors, and pronouns/subjects when context is clear. Do NOT write long out of caution — trimming filler does NOT lose plot. If a line simply cannot fit, go slightly over rather than deleting information — but NEVER drop or merge a line. NEVER print [Ts <=N words] in the translation.\n`;
      prefix += `${brevityRule.replaceAll('{L}', targetName)}\n`;
      prefix += `- BREVITY EXAMPLES (English shown; keep this tightness in ${targetName}, Source -> WRONG long -> RIGHT short): '他来了' -> 'He has finally arrived here now' (WRONG) -> "He's here" (RIGHT); '太美了' -> 'This is really way too beautiful' (WRONG) -> 'So beautiful' (RIGHT); '我不知道该怎么办' -> 'I really have no idea what I am supposed to do now' (WRONG) -> "I don't know what to do" (RIGHT).\n`;
    }
    prefix += `INPUT NOTE: '@HH:MM:SS' at the start of each line = the TIME MARK the line appears in the video - ONLY for you to understand TIMING. NEVER print '@HH:MM:SS' in the translation.\n`;
    if (fit) {
      prefix += `REMINDER (rank 3 - see PRIORITY): keep every line WITHIN the word count in its [Ts <=N words] slot - keep CORE INFO, cut fillers/connectors/optional pronouns, use the language's short forms. BUT never drop a line to make it shorter: an over-long line is a minor flaw, a missing line breaks the whole batch.\n`;
    }
    prefix += `RETURN ONLY THE TRANSLATION in ${targetName}: one line per sentence, same order, do NOT merge or split lines. The leading number ('1. ', '2. ') is PART OF THE REQUIRED FORMAT, not an addition - EVERY line MUST start with its number, exactly as in the input. Add nothing beyond that - no preamble, no confirmation, no explanation, no markdown:\n\n`;
  }

  const formattedLines = items.map((it, idx) => {
    const duration = slotGiay(it.timestamp);
    const wps = nhipTuDich(targetLang);
    const ratio = Number(process.env.DUB_TILE_AM || 0.75) || 0.75;
    const limit = fit && duration > 0
      ? (isVietnamese
          ? tranTuDich(duration, it.text, wps, ratio, targetLang)
          : tranTuDich(duration, it.text, wps, null, targetLang))
      : 0;
    const anchor = limit > 0
      ? `[${duration.toFixed(1)}s ≤${limit}${isVietnamese ? ' từ' : ' words'}] `
      : '';
    const startTime = String(it.timestamp || '').split('-->')[0].trim().split(',')[0];
    const timeAnchor = startTime ? `@${startTime} ` : '';
    return `${idx + 1}. ${timeAnchor}${anchor}${it.text}`;
  });

  return prefix + formattedLines.join('\n');
}

/**
 * Poll chờ phản hồi từ Gemini Web trên Playwright Page
 */
async function doiPhanHoi(page, minLen = 50, validate = null, logFn = console.log, options = {}) {
  let lastLen = 0;
  let stableCount = 0;
  let doneStableCount = 0;
  let emptyCount = 0;
  let doneLen = -1;
  let responseText = '';
  let reportedOrderedList = false;

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
    const candidate = els?.length > 0
      ? await extractGeminiResponseText(els[els.length - 1])
      : { text: '', orderedListItemCount: 0 };
    const hasNewResponse = Boolean(els) && (
      els.length >= Math.max(1, Number(options.minResponseElements || 1))
      || (candidate.text && candidate.text !== String(options.baselineText || ''))
    );
    if (!hasNewResponse) {
      emptyCount++;
      if (emptyCount >= 40) {
        logFn('   ⚠ Gemini 0 response element ~60s → nghi GỬI HỤT (cold-start) → thoát sớm.');
        break;
      }
    } else {
      emptyCount = 0;
    }

    const extracted = hasNewResponse ? candidate : { text: '', orderedListItemCount: 0 };
    const curText = extracted.text;
    if (extracted.orderedListItemCount > 0 && !reportedOrderedList) {
      reportedOrderedList = true;
      logFn(
        `   ↳ phản hồi là danh sách <ol> ${extracted.orderedListItemCount} mục — `
        + 'đã dựng lại số thứ tự bị innerText loại bỏ.'
      );
    }
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
 * Xóa echo phần đầu dòng nếu Gemini chép lại input
 */
function boEchoDauDong(x) {
  let str = String(x || '');
  for (let i = 0; i < 4; i++) {
    const prev = str;
    if (i === 0) {
      str = str.replace(/^\s*\d+\s*[\.\):\-]\s*/, '');
      str = str.replace(/^\s*\d+\s+(?=@\d{1,2}:\d{2}:\d{2}|\[)/, '');
    }
    str = str.replace(/^\s*@\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\s*/, '');
    str = str.replace(/^\s*\[[^\]]*\]\s*/, '');
    if (str === prev) break;
  }
  return str.trim();
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
        text = boEchoDauDong(text);
        result[idx] = text;
      }
    }
  }

  // Fallback map theo thứ tự dòng nếu Gemini không đánh số câu
  if (Object.keys(result).length < expectedCount * 0.6) {
    const seq = lines.map(x => x.trim()).filter(x => x && !x.endsWith(':'));
    if (seq.length === expectedCount) {
      seq.forEach((txt, i) => {
        let clean = boEchoDauDong(txt);
        result[i + 1] = clean;
      });
    } else if (seq.length === expectedCount + 1) {
      // Gemini đôi khi thêm đúng một dòng mở đầu dù prompt đã cấm.
      // Chỉ bỏ dòng đầu trong trường hợp chắc chắn này để tránh làm lệch toàn bộ cue.
      seq.slice(1).forEach((txt, i) => {
        result[i + 1] = boEchoDauDong(txt);
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

  if (_GEM_LOGIN_ACTIVE) {
    throw createGeminiWebError(
      'GEMINI_LOGIN_WINDOW_ACTIVE',
      'Cửa sổ đăng nhập Gemini đang mở. Hãy đăng nhập xong và đóng cửa sổ trước khi render.'
    );
  }

  const profileDir = getGeminiTranslationProfileDir();
  cleanProfileLocks(profileDir);
  logFn(`🔥 Gemini Web mở profile đăng nhập bền vững: ${profileDir}`);

  try {
    _GEM_CTX = await launchPersistentBrowserContext(profileDir, { headless: !show });
    _GEM_PAGE = _GEM_CTX.pages().length > 0 ? _GEM_CTX.pages()[0] : await _GEM_CTX.newPage();
    _GEM_PROFILE_DIR = profileDir;
    _GEM_FIRST_EDITOR_WAIT = true;
    return { context: _GEM_CTX, page: _GEM_PAGE };
  } catch (err) {
    await closeGeminiSession();
    throw err;
  }
}

/**
 * Đóng phiên trình duyệt ngầm
 */
async function closeGeminiSession() {
  try {
    if (_GEM_CTX) {
      await _GEM_CTX.close();
    }
  } catch (e) {
  } finally {
    _GEM_CTX = null;
    _GEM_PAGE = null;
    _GEM_PROFILE_DIR = null;
    _GEM_FIRST_EDITOR_WAIT = true;
    _GEM_CHAT_READY = false;
  }
}

function createGeminiWebError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  error.geminiWebTransport = true;
  if (cause) error.cause = cause;
  return error;
}

function isGeminiWebTransportError(error) {
  return Boolean(error?.geminiWebTransport || [
    'GEMINI_BROWSER_CLOSED',
    'GEMINI_EDITOR_NOT_FOUND',
    'GEMINI_PROMPT_SEND_FAILED'
  ].includes(error?.code));
}

function resolveGeminiEditorWaitSeconds(firstEditorWait, configuredWait) {
  const configured = Number(configuredWait);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return firstEditorWait ? 180 : 40;
}

async function findGeminiEditorLocator(page, timeoutMs = 40000) {
  const selector = [
    "div.ql-editor[contenteditable='true']:visible",
    "div[contenteditable='true'][role='textbox']:visible",
    "div[contenteditable='true']:visible"
  ].join(', ');
  // Gemini giữ cả editor ẩn trong DOM. Lấy `.last()` có thể chọn đúng editor
  // ẩn và chờ hết timeout dù ô "Ask Gemini" đang hiện. Lấy phần tử khớp đầu
  // tiên và thêm `:visible` để chỉ nhận editor có thể thao tác.
  const editor = page.locator(selector).first();
  try {
    await editor.waitFor({ state: 'visible', timeout: timeoutMs });
    return editor;
  } catch (error) {
    throw createGeminiWebError(
      'GEMINI_EDITOR_NOT_FOUND',
      'Không thấy ô nhập Gemini (chưa đăng nhập hoặc Gemini đã đổi giao diện).',
      error
    );
  }
}

async function sendPromptToGemini(page, prompt, options = {}) {
  const logFn = options.logFn || console.log;
  const attempts = Math.max(1, Number(options.attempts || 2));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Locator được tạo lại ở mỗi lần gửi và tự resolve lại khi Gemini SPA thay DOM.
      const timeoutMs = attempt === 1
        ? Number(options.timeoutMs || 40000)
        : Number(options.retryTimeoutMs || 40000);
      const editor = await findGeminiEditorLocator(page, timeoutMs);
      await editor.click({ timeout: 20000 });
      await page.keyboard.insertText(String(prompt || ''));
      await new Promise(resolve => setTimeout(resolve, 600));
      await page.keyboard.press('Enter');
      return true;
    } catch (error) {
      lastError = error;
      logFn(`⚠ Ô nhập Gemini thay đổi hoặc gửi prompt lỗi, thử lại ${attempt}/${attempts}: ${error.message}`);
      if (error?.code === 'GEMINI_EDITOR_NOT_FOUND') {
        await captureGeminiFailure(page, 'khong-thay-o-nhap', prompt, logFn);
      }
      if (page.isClosed?.()) {
        throw createGeminiWebError('GEMINI_BROWSER_CLOSED', 'Trình duyệt Gemini đã bị đóng trong lúc gửi prompt.', error);
      }
      if (attempt < attempts) {
        try {
          await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch {}
      }
    }
  }
  throw createGeminiWebError(
    'GEMINI_PROMPT_SEND_FAILED',
    `Không thể nhập và gửi prompt vào Gemini Web sau ${attempts} lần thử: ${lastError?.message || 'không rõ lỗi'}`,
    lastError
  );
}

/**
 * Thực hiện gửi mẻ Prompt dịch qua Playwright Node.js với khóa serialize
 */
async function hoiGeminiWebNodeJS(prompt, options = {}) {
  const prevOp = _GEM_OP_LOCK;
  let releaseLock;
  _GEM_OP_LOCK = new Promise(resolve => { releaseLock = resolve; });

  await prevOp.catch(() => {});

  try {
    return await _hoiGeminiWebNodeJSInternal(prompt, options);
  } finally {
    releaseLock();
  }
}

async function _hoiGeminiWebNodeJSInternal(prompt, options = {}) {
  const logFn = options.logFn || console.log;
  const { page } = await getGeminiSession(options.show || false, logFn);

  const continueChat = options.continueChat === true && _GEM_CHAT_READY;
  if (continueChat) {
    logFn('[GeminiWebNodeJS] Tiếp tục hội thoại hiện tại để giữ ngữ cảnh giữa các lô...');
  } else {
    logFn('[GeminiWebNodeJS] Mở cuộc trò chuyện Gemini mới...');
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      if (page.isClosed()) {
        await closeGeminiSession();
        throw new Error(`Trình duyệt Gemini bị đóng đột ngột: ${e.message}`);
      }
    }
  }

  logFn('[GeminiWebNodeJS] Gõ prompt + gửi...');
  const responseSelector = 'message-content .markdown, .model-response-text, .markdown';
  const responsesBeforeSend = continueChat ? await page.$$(responseSelector) : [];
  const responseElementsBeforeSend = responsesBeforeSend.length;
  const baselineResponse = responseElementsBeforeSend > 0
    ? await extractGeminiResponseText(responsesBeforeSend[responseElementsBeforeSend - 1])
    : { text: '' };
  const firstEditorWait = _GEM_FIRST_EDITOR_WAIT;
  _GEM_FIRST_EDITOR_WAIT = false;
  await sendPromptToGemini(page, prompt, {
    logFn,
    attempts: 2,
    timeoutMs: resolveGeminiEditorWaitSeconds(firstEditorWait, options.waitLogin) * 1000,
    retryTimeoutMs: 40000
  });

  const accessState = await inspectGeminiPageState(page);
  if (accessState.signInVisible) {
    logFn('[GeminiWebNodeJS] Phiên chưa đăng nhập; tiếp tục bằng chế độ khách.');
  } else {
    logFn('[GeminiWebNodeJS] Đã xác nhận đang dùng phiên Gemini đăng nhập.');
  }

  logFn('[GeminiWebNodeJS] Chờ Gemini phản hồi...');
  const resp = await doiPhanHoi(page, 50, options.validate, logFn, {
    minResponseElements: responseElementsBeforeSend + 1,
    baselineText: baselineResponse.text
  });
  _GEM_CHAT_READY = true;
  if (options.validate && !options.validate(resp)) {
    await captureGeminiFailure(page, 'phan-hoi-khong-hop-le', prompt, logFn, resp);
  }
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

function nghiGopCau(translatedMap, minimumMedian = 8, multiplier = null, absoluteFloor = null) {
  const values = Object.values(translatedMap || {}).map(value => String(value || '').trim()).filter(Boolean);
  if (values.length < 4) return false;
  const envMultiplier = Number(process.env.GEMINI_GOP_BOI);
  const envFloor = Number(process.env.GEMINI_GOP_SAN);
  const effectiveMultiplier = multiplier !== null && multiplier !== undefined && Number.isFinite(Number(multiplier))
    ? Number(multiplier)
    : (Number.isFinite(envMultiplier) && envMultiplier > 0 ? envMultiplier : 4.0);
  const effectiveFloor = absoluteFloor !== null && absoluteFloor !== undefined && Number.isFinite(Number(absoluteFloor))
    ? Number(absoluteFloor)
    : (Number.isFinite(envFloor) && envFloor > 0 ? envFloor : 120);
  const lengths = values.map(value => value.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  return median >= minimumMedian
    && lengths[lengths.length - 1] > Math.max(effectiveFloor, median * effectiveMultiplier);
}

function splitGeminiBatches(items, maxCount = 400, maxChars = maxCount * 45) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const item of items || []) {
    const itemChars = String(item?.text || '').length + 30;
    if (current.length > 0 && (current.length >= maxCount || currentChars + itemChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function maxConsecutiveMissing(parsed, expectedCount) {
  let longest = 0;
  let current = 0;
  for (let index = 1; index <= expectedCount; index += 1) {
    if (!Object.hasOwn(parsed || {}, index)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function assessGeminiBatch(batch, parsed, options = {}) {
  const expected = batch.length;
  const parsedCount = Object.keys(parsed || {}).length;
  const required = Math.ceil(expected * 0.9);
  const targetLang = options.targetLang || 'vi';
  const mode = options.mode === 'spellcheck' ? 'spellcheck' : 'translate';
  const hanThreshold = Number.isFinite(Number(options.hanThreshold)) ? Number(options.hanThreshold) : 0.35;
  const missingClusterMax = Number.isFinite(Number(options.missingClusterMax))
    ? Number(options.missingClusterMax)
    : 8;

  if (parsedCount < required) {
    return { valid: false, reason: `parse ra ${parsedCount}/${expected} câu (cần ≥${required})`, parsedCount };
  }
  const missingRun = maxConsecutiveMissing(parsed, expected);
  if (missingClusterMax > 0 && missingRun > missingClusterMax) {
    return { valid: false, reason: `thiếu ${missingRun} câu liên tiếp (trần ${missingClusterMax})`, parsedCount };
  }
  if (mode === 'translate' && hanThreshold > 0 && !['zh', 'ja'].includes(targetLang)) {
    for (let index = 1; index <= expected; index += 1) {
      const value = parsed?.[index];
      if (value && tyLeHan(value) >= hanThreshold) {
        return {
          valid: false,
          reason: `câu ${index} còn chữ Hán (${Math.round(tyLeHan(value) * 100)}% ≥ ${Math.round(hanThreshold * 100)}%)`,
          parsedCount
        };
      }
    }
  }
  if (nghiGopCau(parsed)) {
    return { valid: false, reason: 'nghi gộp nhiều cue vào một câu dài bất thường', parsedCount };
  }
  return { valid: true, reason: '', parsedCount };
}

function resolveGeminiDeadline(totalCues, options = {}) {
  if (Number.isFinite(Number(options.deadlineAt))) return Number(options.deadlineAt);
  const seconds = Number.isFinite(Number(options.deadlineSeconds))
    ? Number(options.deadlineSeconds)
    : Math.min(1800, 360 + Math.max(0, Number(totalCues) || 0) * 1.4);
  return Date.now() + Math.max(1, seconds) * 1000;
}

function isGeminiTranslationValid(source, translated, options = {}) {
  const value = String(translated || '').trim();
  if (!value) return { valid: false, reason: 'empty_translation' };
  if (options.mode === 'spellcheck') return { valid: true, reason: null };
  const comparable = text => String(text || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:'"“”‘’…()[\]{}，。！？；：、]/g, '')
    .trim()
    .toLocaleLowerCase();
  const sourceComparable = comparable(source);
  if (sourceComparable === comparable(value) && (tyLeHan(source) > 0 || sourceComparable.length >= 6)) {
    return { valid: false, reason: 'unchanged_from_source' };
  }
  if (!['zh', 'ja'].includes(options.targetLang)) {
    const hanRatio = tyLeHan(value);
    const threshold = options.final === true ? 0 : Number(options.hanThreshold ?? 0.35);
    if (hanRatio > threshold || (threshold === 0 && hanRatio > 0)) {
      return { valid: false, reason: 'source_language_remaining' };
    }
  }
  return { valid: true, reason: null };
}

function writeProgressiveSrt(items, translatedById, outputPath) {
  if (!outputPath) return;
  const parser = new Parser();
  const output = items.map(item => ({
    id: String(item.id),
    startTime: item.startTime,
    endTime: item.endTime,
    text: Object.hasOwn(translatedById, String(item.id))
      ? translatedById[String(item.id)]
      : item.text
  }));
  fs.writeFileSync(outputPath, parser.toSrt(output), 'utf8');
}

/**
 * Pipeline dịch Gemini Web theo dòng đánh số:
 * - dòng đánh số + @timestamp + trần từ động;
 * - lô lớn, kiểm tra đủ 90%, chữ Hán và dấu hiệu gộp câu;
 * - ghi SRT lũy tiến, sau đó chỉ retry các cue còn sót bằng chính Gemini Web.
 */
async function translateSrtItemsByGeminiWeb(items, options = {}) {
  const logFn = options.logFn || console.log;
  const requestFn = options.requestFn || hoiGeminiWebNodeJS;
  const targetLang = options.targetLang || 'vi';
  const srcLang = options.srcLang || 'auto';
  const mode = options.mode === 'spellcheck' ? 'spellcheck' : 'translate';
  const checkpoint = options.checkpoint || null;
  const sourceById = options.sourceById || Object.fromEntries(items.map(item => [String(item.id), item.text]));
  const baseTmContent = options.tmContent !== undefined
    ? String(options.tmContent || '')
    : docTm(options.tmDir || path.join(APP_ROOT, 'scripts', 'translation_memory'));
  // translation_memory hiện là từ điển Hán→Việt nên chỉ nạp
  // khi đích là tiếng Việt. Phong cách vẫn áp dụng cho mọi ngôn ngữ đích.
  const targetGlossary = targetLang === 'vi' ? baseTmContent : '';
  const tmContent = [String(options.styleRule || '').trim(), targetGlossary]
    .filter(Boolean)
    .join('\n\n');
  const envBatchSize = Number(process.env.GEMINI_CHUNK || 400);
  const batchSize = Math.max(20, Math.min(600, Number(options.batchSize || envBatchSize) || 400));
  const envMaxChars = Number(process.env.GEMINI_MAX_CHARS || batchSize * 45);
  const batchMaxChars = Math.max(1000, Number(options.batchMaxChars || envMaxChars) || batchSize * 45);
  const batchDelayMs = Math.max(0, Number(options.batchDelayMs ?? 2000) || 0);
  const splitRounds = Math.max(0, Math.min(5, Number(options.splitRounds ?? options.retryRounds ?? process.env.GEMINI_CHIA_VONG ?? 2) || 0));
  const splitFloor = Math.max(2, Number(options.splitFloor ?? process.env.GEMINI_CHIA_SAN ?? 24) || 24);
  const missingClusterMax = Math.max(0, Number(options.missingClusterMax ?? process.env.GEMINI_CUM_THIEU_MAX ?? 8) || 0);
  const hanThreshold = Number(options.hanThreshold ?? process.env.HAN_NET_NGUONG ?? 0.35);
  const requestRetryDelayMs = Math.max(0, Number(options.requestRetryDelayMs ?? 2000) || 0);
  const continuousChat = options.continuousChat !== false && process.env.GEMINI_CHAT_LIEN !== '0';
  const deadlineAt = resolveGeminiDeadline(items.length, options);
  const translatedById = {};
  const normalizedItems = items.map(item => ({
    id: String(item.id),
    startTime: item.startTime,
    endTime: item.endTime,
    timestamp: `${item.startTime} --> ${item.endTime}`,
    text: String(sourceById[String(item.id)] ?? item.text ?? '').replace(/[\r\n]+/g, ' ').trim()
  }));

  const cancelled = () => typeof options.isCancelled === 'function' && options.isCancelled();
  const wait = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
  const deadlineReached = (reserveMs = 0) => Date.now() > deadlineAt - reserveMs;
  const cacheOptions = { targetLang, srcLang };
  for (const item of normalizedItems) {
    const cachedEntry = checkpoint?.checkpoint?.entries?.[item.id];
    const cached = mode === 'spellcheck'
      && cachedEntry?.status === 'success'
      && cachedEntry.source === item.text
      ? cachedEntry.translated
      : checkpoint?.get?.({ id: item.id, text: item.text }, cacheOptions);
    if (cached) translatedById[item.id] = cached;
  }

  const pendingItems = () => normalizedItems.filter(item => {
    const translated = translatedById[item.id];
    return !isGeminiTranslationValid(item.text, translated, { targetLang, final: true, mode }).valid;
  });

  const acceptMap = (batch, parsed) => {
    if (nghiGopCau(parsed)) return 0;
    let accepted = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const value = String(parsed[index + 1] || '').trim();
      const validation = isGeminiTranslationValid(item.text, value, { targetLang, final: true, mode });
      if (!validation.valid) continue;
      if (isGeminiTranslationValid(item.text, translatedById[item.id], { targetLang, final: true, mode }).valid) {
        continue;
      }
      translatedById[item.id] = value;
      checkpoint?.success?.({ id: item.id, text: item.text }, value, 'Gemini Web');
      accepted += 1;
    }
    checkpoint?.save?.();
    writeProgressiveSrt(normalizedItems, translatedById, options.outputPath);
    return accepted;
  };

  let hasSentPrompt = false;
  const requestBatch = async (batch, attempts, label) => {
    let bestParsed = {};
    let bestScore = -1;
    let bestAssessment = assessGeminiBatch(batch, bestParsed, {
      targetLang, mode, hanThreshold, missingClusterMax
    });
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (cancelled()) throw new Error('Đã hủy kết xuất trong khi dịch Gemini Web');
      if (deadlineReached()) {
        logFn(`⚠ Gemini Web đã chạm thời hạn tổng trước ${label}; giữ kết quả tốt nhất đã có.`);
        break;
      }
      const prompt = buildPrompt(batch, tmContent, targetLang, options.fit !== false, mode);
      const validate = responseText => {
        const parsed = parseResponseLo(responseText, batch.length);
        return assessGeminiBatch(batch, parsed, {
          targetLang, mode, hanThreshold, missingClusterMax
        }).valid;
      };
      try {
        logFn(`[Gemini Web] ${label} · lần ${attempt}/${attempts} · ${batch.length} cue.`);
        const continueChat = continuousChat && hasSentPrompt && attempt === 1;
        hasSentPrompt = true;
        const response = await requestFn(prompt, {
          logFn,
          validate,
          show: options.show === true,
          continueChat
        });
        const parsed = parseResponseLo(response, batch.length);
        const assessment = assessGeminiBatch(batch, parsed, {
          targetLang, mode, hanThreshold, missingClusterMax
        });
        const score = assessment.parsedCount;
        if (!nghiGopCau(parsed) && score > bestScore) {
          bestParsed = parsed;
          bestScore = score;
          bestAssessment = assessment;
        }
        if (assessment.valid) return { parsed, assessment };
        logFn(`⚠ ${label} chưa đạt: ${assessment.reason}; Gemini sẽ dịch lại lô này.`);
      } catch (error) {
        logFn(`⚠ ${label} lỗi lần ${attempt}/${attempts}: ${error.message}`);
        if (isGeminiWebTransportError(error) && attempt >= attempts) throw error;
      }
      if (attempt < attempts) await wait(requestRetryDelayMs);
    }
    return { parsed: bestParsed, assessment: bestAssessment };
  };

  const initial = pendingItems();
  const initialBatches = splitGeminiBatches(initial, batchSize, batchMaxChars);
  const failedBatches = [];
  logFn(`[Gemini Web] Chia ${initial.length} cue thành ${initialBatches.length} lô `
    + `(tối đa ${batchSize} cue hoặc ${batchMaxChars} ký tự/lô) · hội thoại liên tục: ${continuousChat ? 'bật' : 'tắt'}.`);
  for (let batchIndex = 0; batchIndex < initialBatches.length; batchIndex += 1) {
    if (deadlineReached()) {
      logFn(`⚠ Gemini Web đã chạm thời hạn tổng — dừng trước lô ${batchIndex + 1}/${initialBatches.length}, giữ các lô đã ghi.`);
      break;
    }
    const batch = initialBatches[batchIndex];
    const attempts = initialBatches.length > 1 ? 3 : 2;
    const result = await requestBatch(batch, attempts, `lô ${batchIndex + 1}/${initialBatches.length}`);
    const accepted = acceptMap(batch, result.parsed);
    logFn(`[Gemini Web] Đã ghi lũy tiến lô ${batchIndex + 1}/${initialBatches.length}: ${accepted}/${batch.length} cue mới.`);
    if (batch.some(item => pendingItems().some(pending => pending.id === item.id))) failedBatches.push(batch);
    if (batchIndex + 1 < initialBatches.length) await wait(batchDelayMs);
  }

  let rescueJobs = failedBatches.length > 0 ? failedBatches : (pendingItems().length ? [pendingItems()] : []);
  for (let round = 1; round <= splitRounds && rescueJobs.length > 0; round += 1) {
    if (deadlineReached(90000)) {
      logFn('⚠ [cứu lô] Sát thời hạn tổng → dừng chia, giữ các cue đã cứu được.');
      break;
    }
    const fragments = [];
    for (const job of rescueJobs) {
      if (job.length < 2) {
        fragments.push(job);
        continue;
      }
      const middle = Math.floor(job.length / 2);
      fragments.push(job.slice(0, middle), job.slice(middle));
    }
    const pendingFragments = fragments
      .map(fragment => fragment.filter(item => pendingItems().some(pending => pending.id === item.id)))
      .filter(fragment => fragment.length > 0);
    logFn(`⚠ [cứu lô] Vòng ${round}/${splitRounds}: chia thành ${pendingFragments.length} mảnh, giữ nguyên cue đã dịch được.`);
    const nextJobs = [];
    for (let index = 0; index < pendingFragments.length; index += 1) {
      if (deadlineReached(90000)) break;
      const fragment = pendingFragments[index];
      const result = await requestBatch(fragment, 2, `cứu ${round} · mảnh ${index + 1}/${pendingFragments.length}`);
      acceptMap(fragment, result.parsed);
      const stillPending = fragment.filter(item => pendingItems().some(pending => pending.id === item.id));
      if (!result.assessment.valid && stillPending.length >= splitFloor) nextJobs.push(stillPending);
      if (index + 1 < pendingFragments.length) await wait(batchDelayMs);
    }
    rescueJobs = nextJobs;
  }

  const failedItems = pendingItems().map(item => {
    const reason = translatedById[item.id] ? 'source_language_remaining' : 'missing_id';
    checkpoint?.failure?.({ id: item.id, text: item.text }, 'Gemini Web', reason, reason);
    return { item: items.find(value => String(value.id) === item.id) || item, source: item.text, reason };
  });
  checkpoint?.save?.();
  if (mode === 'translate') {
    for (const failed of failedItems) translatedById[String(failed.item.id)] = '';
  }
  for (const item of items) {
    if (Object.hasOwn(translatedById, String(item.id))) item.text = translatedById[String(item.id)];
  }
  writeProgressiveSrt(normalizedItems, translatedById, options.outputPath);
  return {
    failedItems,
    translatedById,
    reused: normalizedItems.length - initial.length,
    mode,
    blanked: mode === 'translate' ? failedItems.length : 0
  };
}

module.exports = {
  cleanProfileLocks,
  setupPlaywrightEnv,
  getGeminiProfileDir,
  getGeminiTranslationProfileDir,
  getGeminiFailureDir,
  inspectGeminiPageState,
  captureGeminiFailure,
  extractGeminiResponseText,
  openGeminiLoginWindow,
  docTm,
  tyLeHan,
  nhipTuDich,
  tranTuDich,
  slotGiay,
  buildPrompt,
  parseResponseLo,
  getGeminiSession,
  closeGeminiSession,
  findGeminiEditorLocator,
  sendPromptToGemini,
  isGeminiWebTransportError,
  resolveGeminiEditorWaitSeconds,
  hoiGeminiWebNodeJS,
  nghiGopCau,
  splitGeminiBatches,
  maxConsecutiveMissing,
  assessGeminiBatch,
  resolveGeminiDeadline,
  isGeminiTranslationValid,
  translateSrtItemsByGeminiWeb
};
