const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTranslationStyleRule,
  detectSourceLanguage,
  getSubtitleAnalysisPrompt,
  getTranslationPrompt,
  sourceMatchesTarget
} = require('../lib/translate-sub');

test('Gemini Web detects source equals target and builds fixed translation style rules', () => {
  assert.equal(detectSourceLanguage('Hóa ra cô ấy vẫn luôn chờ anh.', 'auto'), 'vie_Latn');
  assert.equal(detectSourceLanguage('原来她一直在等他', 'auto'), 'zho_Hans');
  assert.equal(sourceMatchesTarget('vie_Latn', 'vi'), true);
  assert.equal(sourceMatchesTarget('zho_Hans', 'vi'), false);
  assert.equal(sourceMatchesTarget('jpn_Jpan', 'ja'), true);
  assert.equal(sourceMatchesTarget('kor_Hang', 'ko'), true);
  assert.equal(
    buildTranslationStyleRule(['viral', 'ngan_gon']),
    'VIẾT LẠI lời thoại theo phong cách: viral kiểu TikTok (câu mở gây tò mò, cuốn người xem), ngắn gọn, súc tích. GIỮ NGUYÊN ý nghĩa, KHÔNG thêm/bớt tình tiết, KHÔNG đổi timeline hay số câu.'
  );
});

test('studio no longer exposes, sends, or restores a translation profile', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'controllers', 'studioController.js'), 'utf8');

  assert.doesNotMatch(html, /translationProfile|translation-profile|Hồ sơ dịch/i);
  assert.doesNotMatch(app, /translationProfile|translation-profile/i);
  assert.doesNotMatch(controller, /translationProfile|translation-profile/i);
});

test('translation uses the standard prompt without project profile instructions', () => {
  const prompt = getTranslationPrompt({ 1: 'Hello' }, 'Tiếng Việt', []);

  assert.match(prompt, /dịch nội dung phụ đề sang Tiếng Việt/i);
  assert.match(prompt, /Dữ liệu đầu vào/i);
  assert.doesNotMatch(prompt, /HỒ SƠ DỊCH|VST_TERM|translationProfile/i);
});

test('whole-SRT analysis prompt contains every cue before translation batches', () => {
  const cues = Array.from({ length: 115 }, (_, index) => ({
    id: String(index + 1),
    startTime: `00:00:${String(index % 60).padStart(2, '0')},000`,
    endTime: `00:00:${String(index % 60).padStart(2, '0')},900`,
    text: `Nội dung nguồn ${index + 1}`
  }));
  const prompt = getSubtitleAnalysisPrompt(cues, 'Tiếng Việt');

  assert.match(prompt, /đọc TOÀN BỘ file SRT/i);
  assert.match(prompt, /"id": "1"/);
  assert.match(prompt, /Nội dung nguồn 1/);
  assert.match(prompt, /"id": "115"/);
  assert.match(prompt, /Nội dung nguồn 115/);
  assert.match(prompt, /characters/);
  assert.match(prompt, /terminology/);
});

test('translation prompt receives the same whole-SRT context for every batch', () => {
  const globalContext = {
    summary: 'Mine chiến đấu cùng Night Raid.',
    characters: [{ name: 'Mine', gender: 'nữ', role: 'thành viên Night Raid' }],
    terminology: [{ source: '帝具', target: 'Đế Cụ' }],
    tone: 'Bi tráng',
    translationRules: ['Giữ tên Mine']
  };
  const prompt = getTranslationPrompt({
    81: { text: '下一句', durationSec: 1.5 }
  }, 'Tiếng Việt', [], globalContext);

  assert.match(prompt, /PHÂN TÍCH TOÀN BỘ SRT/);
  assert.match(prompt, /Mine chiến đấu cùng Night Raid/);
  assert.match(prompt, /Đế Cụ/);
});

test('translation backend contains no configurable profile pipeline', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'translate-sub.js'), 'utf8');

  assert.doesNotMatch(
    source,
    /normalizeTranslationProfile|buildTranslationProfileInstructions|applyTranslationProfileToText|translationProfile/
  );
});

test('Gemini Web uses the isolated line pipeline while Gemini API keeps JSON translation', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'lib', 'translate-sub.js'), 'utf8');
  const adapterSource = fs.readFileSync(path.join(root, 'lib', 'gemini-web-adapter.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const adapter = require('../lib/gemini-web-adapter');
  const webService = require('../lib/gemini-web-service');

  assert.equal(typeof adapter.requestViaGeminiWeb, 'function');
  assert.equal(typeof adapter.translateViaGeminiWeb, 'function');
  assert.equal(typeof webService.translateSrtItemsByGeminiWeb, 'function');
  assert.equal(webService.dichSrtNodeJS, undefined);
  assert.match(source, /translateViaGeminiWeb\(srtArray/);
  assert.doesNotMatch(source.slice(
    source.indexOf("if (aiProvider === 'gemini-web')"),
    source.indexOf('// 4. Dịch bằng OpenCode')
  ), /resolveGlobalTranslationContext|requestGeminiWebJson|getTranslationPrompt/);
  assert.match(adapterSource, /translateSrtItemsByGeminiWeb/);
  assert.doesNotMatch(adapterSource, /dichSrtNodeJS/);
  assert.match(html, /Gemini Web · Dịch phụ đề thông minh/);
  assert.match(html, /global-translation-style-options/);
  assert.match(html, /<option value="tr">Türkçe<\/option>/);
  assert.match(source, /VC_GEMINI_KEEP_HOT !== '1'/);
  assert.match(source, /closeGeminiWebSession\(\)/);
  assert.doesNotMatch(html, /Gemini Web Automation/);
});

test('Gemini Web and Gemini API never fall back to NLLB automatically', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'lib', 'translate-sub.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const webStart = source.indexOf("if (aiProvider === 'gemini-web')");
  const webEnd = source.indexOf('// 4. Dịch bằng OpenCode', webStart);
  const webBlock = source.slice(webStart, webEnd);

  assert.doesNotMatch(webBlock, /fallbackFailedItemsWithNllb|translateWithNllb/);
  assert.match(webBlock, /primary\.failedItems\.length > 0/);
  assert.match(webBlock, /để trống các cue đó và tiếp tục render/);
  assert.doesNotMatch(webBlock, /createTranslationIncompleteError/);
  assert.match(webBlock, /Giữ checkpoint để tiếp tục, không chuyển sang NLLB/);
  assert.match(source, /const remaining = isGemini \? primary\.failedItems : await fallbackFailedItemsWithNllb/);
  assert.match(source, /if \(isGemini\) \{[\s\S]*?không chuyển sang NLLB[\s\S]*?throw err;/);
  assert.match(html, /Không tự chuyển sang NLLB/);
});
