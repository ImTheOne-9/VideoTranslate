const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  docTm,
  tyLeHan,
  nhipTuDich,
  tranTuDich,
  slotGiay,
  buildPrompt,
  parseResponseLo,
  nghiGopCau,
  filterSafeGeminiMap,
  buildRetryCorrection,
  selectGeminiCandidate,
  splitGeminiBatches,
  maxConsecutiveMissing,
  assessGeminiBatch,
  resolveGeminiDeadline,
  isGeminiTranslationValid,
  sendPromptToGemini,
  getGeminiProfileDir,
  getGeminiTranslationProfileDir,
  inspectGeminiPageState,
  captureGeminiFailure,
  extractGeminiResponseText,
  resolveGeminiEditorWaitSeconds,
  translateSrtItemsByGeminiWeb
} = require('../lib/gemini-web-service');
const { sanitizeResidualCjk } = require('../lib/translation-output-safety');

test('tyLeHan detects Chinese character ratio correctly', () => {
  assert.equal(tyLeHan('你好世界'), 1.0);
  assert.equal(tyLeHan('Xin chào thế giới'), 0.0);
  assert.ok(tyLeHan('你好 Hello') > 0.25);
});

test('slotGiay parses SRT timestamp strings to duration in seconds', () => {
  const duration = slotGiay('00:00:01,000 --> 00:00:03,500');
  assert.equal(duration, 2.5);
});

test('tranTuDich calculates max words limit based on duration and source syllables', () => {
  // 2s duration, 4 source syllables
  const maxW = tranTuDich(2.0, '你好世界');
  assert.ok(maxW >= 3);
  assert.ok(maxW <= 10);
});

test('parseResponseLo correctly parses numbered translation responses', () => {
  const sampleResp = `
1. Xin chào thế giới
2. Rất vui được gặp bạn
3. Chúc một ngày tốt lành
`;
  const parsed = parseResponseLo(sampleResp, 3);
  assert.equal(parsed[1], 'Xin chào thế giới');
  assert.equal(parsed[2], 'Rất vui được gặp bạn');
  assert.equal(parsed[3], 'Chúc một ngày tốt lành');
});

test('buildPrompt builds full system prompt with 1:1 constraint and length anchors', () => {
  const items = [
    { id: 1, timestamp: '00:00:01,000 --> 00:00:03,000', text: '你好' },
    { id: 2, timestamp: '00:00:03,500 --> 00:00:05,000', text: '谢谢' }
  ];
  const prompt = buildPrompt(items, '', 'vi', true);
  assert.ok(prompt.includes('QUY TẮC DỊCH THUẬT'));
  assert.ok(prompt.includes('DẤU PHẨY / DẤU CHẤM'));
  assert.ok(prompt.includes('KHÔNG ĐƯỢC VƯỢT số từ'));
  assert.ok(prompt.includes('SỐ DÒNG OUTPUT PHẢI BẰNG SỐ DÒNG INPUT'));
  assert.match(prompt, /王明 → Vương Minh/);
  assert.match(prompt, /北京 → Bắc Kinh/);
  assert.match(prompt, /TUYỆT ĐỐI KHÔNG Hán-Việt hoá cả câu/);
  assert.doesNotMatch(prompt, /CỔ TRANG \/ TU TIÊN: BẮT BUỘC dùng từ Hán-Việt/);
  assert.ok(prompt.includes('1. @00:00:01 [2.0s ≤'));
  assert.ok(prompt.includes('你好'));
  assert.ok(prompt.includes('谢谢'));
});

test('parseResponseLo strips echo timestamp and length anchor artifacts', () => {
  const sampleResp = `
1. @00:00:01 [2.0s ≤3 từ] Xin chào bạn
2. [1.5s ≤2 từ] Cảm ơn
3. 3 @00:10:59 [0.8s ≤3 từ] Ngay lúc đó
`;
  const parsed = parseResponseLo(sampleResp, 3);
  assert.equal(parsed[1], 'Xin chào bạn');
  assert.equal(parsed[2], 'Cảm ơn');
  assert.equal(parsed[3], 'Ngay lúc đó');
});

test('buildPrompt switches to spelling correction without dubbing length anchors', () => {
  const prompt = buildPrompt([
    { id: 1, timestamp: '00:00:01,000 --> 00:00:03,000', text: 'Hòa ra cô ấy đã về' }
  ], '', 'vi', false, 'spellcheck');
  assert.match(prompt, /SỬA LỖI CHÍNH TẢ \+ dấu câu/);
  assert.match(prompt, /không dịch, không viết lại/i);
  assert.match(prompt, /1\. @00:00:01 Hòa ra cô ấy đã về/);
  assert.doesNotMatch(prompt, /≤\d+ từ/);
});

test('buildPrompt applies multilingual rules and supplied rules', () => {
  const prompt = buildPrompt([
    { id: 1, timestamp: '00:00:01,000 --> 00:00:03,000', text: '你好' }
  ], 'STYLE RULE\nNAME GLOSSARY', 'ko', true);
  assert.match(prompt, /RULES \+ STYLE \(MANDATORY, keep consistent\)/);
  assert.match(prompt, /STYLE RULE/);
  assert.match(prompt, /NAME GLOSSARY/);
  assert.match(prompt, /NATIVE Korean SPEAKER/);
  assert.match(prompt, /SOURCE HAS OCR ERRORS/);
  assert.match(prompt, /MATCH THE GENRE/);
  assert.match(prompt, /CRITICAL STRUCTURAL RULE/);
  assert.match(prompt, /\[2\.0s ≤4 words\]/);
  assert.match(prompt, /Korean bloats from honorific endings/);
  assert.match(prompt, /해요체\/반말/);
  assert.match(prompt, /RETURN ONLY THE TRANSLATION in Korean/);
});

test('Gemini Web pipeline loads Han-Vietnamese glossary only for Vietnamese target', async () => {
  const makeItems = () => [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' }
  ];
  let viPrompt = '';
  await translateSrtItemsByGeminiWeb(makeItems(), {
    targetLang: 'vi', srcLang: 'zho_Hans', styleRule: 'STYLE RULE', tmContent: 'HAN VIET GLOSSARY',
    requestFn: async prompt => { viPrompt = prompt; return '1. Câu thứ nhất'; },
    retryRounds: 0, batchDelayMs: 0, logFn() {}
  });
  assert.match(viPrompt, /STYLE RULE/);
  assert.match(viPrompt, /HAN VIET GLOSSARY/);

  let enPrompt = '';
  await translateSrtItemsByGeminiWeb(makeItems(), {
    targetLang: 'en', srcLang: 'zho_Hans', styleRule: 'STYLE RULE', tmContent: 'HAN VIET GLOSSARY',
    requestFn: async prompt => { enPrompt = prompt; return '1. First sentence'; },
    retryRounds: 0, batchDelayMs: 0, logFn() {}
  });
  assert.match(enPrompt, /STYLE RULE/);
  assert.doesNotMatch(enPrompt, /HAN VIET GLOSSARY/);
});

test('Gemini sender re-resolves the editor when the SPA detaches the old DOM node', async () => {
  let locatorCalls = 0;
  let clickCalls = 0;
  let insertCalls = 0;
  let pressCalls = 0;
  let reloads = 0;
  const page = {
    locator() {
      locatorCalls += 1;
      return {
        first() { return this; },
        async waitFor() {},
        async click() {
          clickCalls += 1;
          if (clickCalls === 1) throw new Error('Element is not attached to the DOM');
        }
      };
    },
    keyboard: {
      async insertText() { insertCalls += 1; },
      async press() { pressCalls += 1; }
    },
    isClosed() { return false; },
    async goto() { reloads += 1; }
  };
  await sendPromptToGemini(page, 'prompt', { attempts: 2, timeoutMs: 10, logFn() {} });
  assert.equal(locatorCalls, 2);
  assert.equal(clickCalls, 2);
  assert.equal(insertCalls, 1);
  assert.equal(pressCalls, 1);
  assert.equal(reloads, 1);
});

test('Gemini editor lookup selects the first visible editor instead of a hidden trailing editor', async () => {
  let receivedSelector = '';
  let firstCalls = 0;
  let waitState = '';
  const visibleEditor = { id: 'visible-editor' };
  const page = {
    locator(selector) {
      receivedSelector = selector;
      return {
        first() {
          firstCalls += 1;
          return {
            async waitFor(options) { waitState = options.state; },
            ...visibleEditor
          };
        }
      };
    }
  };
  const { findGeminiEditorLocator } = require('../lib/gemini-web-service');
  const editor = await findGeminiEditorLocator(page, 10);
  assert.match(receivedSelector, /contenteditable='true'\]:visible/);
  assert.equal(firstCalls, 1);
  assert.equal(waitState, 'visible');
  assert.equal(editor.id, 'visible-editor');
});

test('Gemini Web waits 180 seconds for the first guest editor and 40 seconds afterwards', () => {
  assert.equal(resolveGeminiEditorWaitSeconds(true), 180);
  assert.equal(resolveGeminiEditorWaitSeconds(false), 40);
  assert.equal(resolveGeminiEditorWaitSeconds(true, 75), 75);
});

test('Gemini translation reuses the persistent login profile', (t) => {
  const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-login-'));
  const previousLogin = process.env.GEMINI_PROFILE_DIR;
  const previousTranslation = process.env.GEMINI_TRANSLATION_PROFILE_DIR;
  t.after(() => {
    if (previousLogin === undefined) delete process.env.GEMINI_PROFILE_DIR;
    else process.env.GEMINI_PROFILE_DIR = previousLogin;
    if (previousTranslation === undefined) delete process.env.GEMINI_TRANSLATION_PROFILE_DIR;
    else process.env.GEMINI_TRANSLATION_PROFILE_DIR = previousTranslation;
    fs.rmSync(loginDir, { recursive: true, force: true });
  });
  process.env.GEMINI_PROFILE_DIR = loginDir;
  process.env.GEMINI_TRANSLATION_PROFILE_DIR = path.join(os.tmpdir(), 'obsolete-translation-profile');
  const translationDir = getGeminiTranslationProfileDir();
  assert.equal(getGeminiProfileDir(), loginDir);
  assert.equal(translationDir, loginDir);
});

test('multilingual timing uses measured word rates instead of a shared character budget', () => {
  assert.equal(nhipTuDich('es'), 1.94);
  assert.equal(nhipTuDich('pt'), 1.96);
  assert.equal(nhipTuDich('ko'), 2.0);
  assert.equal(tranTuDich(3, '这是很长的原文', null, null, 'ko'), 6);
});

test('Gemini batches honor both cue count and formatted character limits', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), text: '1234567890' }));
  assert.deepEqual(splitGeminiBatches(items, 4, 90).map(batch => batch.length), [2, 2, 2]);
});

test('Gemini batch guard rejects a long consecutive missing cluster at 90 percent coverage', () => {
  const batch = Array.from({ length: 100 }, (_, index) => ({ text: `源${index + 1}` }));
  const parsed = {};
  for (let index = 1; index <= 91; index += 1) parsed[index] = `Câu ${index}`;
  assert.equal(maxConsecutiveMissing(parsed, 100), 9);
  const assessment = assessGeminiBatch(batch, parsed, {
    targetLang: 'vi', mode: 'translate', missingClusterMax: 8
  });
  assert.equal(assessment.valid, false);
  assert.match(assessment.reason, /thiếu 9 câu liên tiếp/);
});

test('Gemini deadline follows the same bounded per-cue budget', () => {
  const now = Date.now();
  const shortDeadline = resolveGeminiDeadline(100, { deadlineAt: now + 1234 });
  assert.equal(shortDeadline, now + 1234);
  const bounded = resolveGeminiDeadline(5000);
  assert.ok(bounded > now + 1790 * 1000 && bounded <= Date.now() + 1800 * 1000);
});

test('Gemini page inspection distinguishes signed-out guest editor from authenticated state', async () => {
  const page = {
    isClosed() { return false; },
    async evaluate(fn) {
      assert.equal(typeof fn, 'function');
      return {
        url: 'https://gemini.google.com/app',
        title: 'Google Gemini',
        signInVisible: true,
        editorVisible: true,
        bodyPreview: 'Sign in\nWhere should we start?'
      };
    }
  };
  const state = await inspectGeminiPageState(page);
  assert.equal(state.signInVisible, true);
  assert.equal(state.editorVisible, true);
});

test('Gemini response reader rebuilds CSS-only ordered-list markers', async () => {
  const makeItem = text => ({ async innerText() { return text; } });
  const makeList = (start, items) => ({
    async getAttribute(name) { return name === 'start' ? start : null; },
    async $$(selector) {
      assert.equal(selector, ':scope > li');
      return items.map(makeItem);
    }
  });
  const element = {
    async innerText() { return 'Câu một\nCâu hai\nCâu ba'; },
    async $$(selector) {
      assert.equal(selector, 'ol');
      return [makeList('1', ['Câu một', 'Câu hai']), makeList('3', ['Câu ba'])];
    }
  };

  assert.deepEqual(await extractGeminiResponseText(element), {
    text: '1. Câu một\n2. Câu hai\n3. Câu ba',
    orderedListItemCount: 3
  });
});

test('Gemini response reader keeps innerText when rebuilding would lose lines', async () => {
  const element = {
    async innerText() { return 'Dòng mở đầu\nCâu một\nCâu hai'; },
    async $$() {
      return [{
        async getAttribute() { return null; },
        async $$() { return [{ async innerText() { return 'Câu một'; } }]; }
      }];
    }
  };
  assert.deepEqual(await extractGeminiResponseText(element), {
    text: 'Dòng mở đầu\nCâu một\nCâu hai',
    orderedListItemCount: 0
  });
});

test('Gemini editor failure writes local diagnostic state, prompt and screenshot', async (t) => {
  const failureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-failure-'));
  const previous = process.env.GEMINI_FAILURE_DIR;
  const previousCapture = process.env.GEMINI_CAPTURE_FAILURE;
  process.env.GEMINI_FAILURE_DIR = failureDir;
  delete process.env.GEMINI_CAPTURE_FAILURE;
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_FAILURE_DIR;
    else process.env.GEMINI_FAILURE_DIR = previous;
    if (previousCapture === undefined) delete process.env.GEMINI_CAPTURE_FAILURE;
    else process.env.GEMINI_CAPTURE_FAILURE = previousCapture;
    fs.rmSync(failureDir, { recursive: true, force: true });
  });
  const page = {
    isClosed() { return false; },
    async evaluate() {
      return { url: 'https://gemini.google.com/app', title: 'Google Gemini', signInVisible: true, editorVisible: false, bodyPreview: 'Sign in' };
    },
    async screenshot({ path: outputPath }) { fs.writeFileSync(outputPath, 'png'); }
  };
  const captured = await captureGeminiFailure(
    page, 'khong-thay-o-nhap', 'PROMPT TEST', () => {}, 'RAW RESPONSE TEST'
  );
  assert.equal(captured.state.editorVisible, false);
  const names = fs.readdirSync(failureDir);
  assert.ok(names.some(name => name.endsWith('_state.json')));
  assert.ok(names.some(name => name.endsWith('_prompt.txt')));
  assert.ok(names.some(name => name.endsWith('_response.txt')));
  assert.ok(names.some(name => name.endsWith('.png')));
  const promptName = names.find(name => name.endsWith('_prompt.txt'));
  assert.equal(fs.readFileSync(path.join(failureDir, promptName), 'utf8'), 'PROMPT TEST');
  const responseName = names.find(name => name.endsWith('_response.txt'));
  assert.equal(fs.readFileSync(path.join(failureDir, responseName), 'utf8'), 'RAW RESPONSE TEST');
});

test('Gemini transport failure aborts translation instead of blanking every cue', async () => {
  const error = new Error('Không thể gửi prompt');
  error.code = 'GEMINI_PROMPT_SEND_FAILED';
  error.geminiWebTransport = true;
  await assert.rejects(() => translateSrtItemsByGeminiWeb([
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' }
  ], {
    targetLang: 'vi',
    srcLang: 'zho_Hans',
    requestFn: async () => { throw error; },
    requestRetryDelayMs: 0,
    retryRounds: 3,
    batchDelayMs: 0,
    tmContent: '',
    logFn() {}
  }), value => value === error);
});
test('parseResponseLo safely ignores one unnumbered preamble line without shifting cues', () => {
  const parsed = parseResponseLo('Bản dịch như sau\nXin chào\nCảm ơn', 2);
  assert.deepEqual(parsed, { 1: 'Xin chào', 2: 'Cảm ơn' });
});

test('parseResponseLo never position-maps a partially numbered response', () => {
  const parsed = parseResponseLo('1. Câu một\nCâu hai không có số\n3. Câu ba', 3);
  assert.deepEqual(parsed, { 1: 'Câu một', 3: 'Câu ba' });
});

test('Gemini Web guard detects merged cues and safely cleans only light residual Han text', () => {
  assert.equal(nghiGopCau({
    1: 'Một câu bình thường',
    2: 'Một câu khá tự nhiên',
    3: 'Một câu ngắn gọn',
    4: 'Đây là một câu dài bất thường '.repeat(5)
  }), true);
  const rescued = isGeminiTranslationValid('剑技', 'Kiếm技 tuyệt đỉnh', {
    targetLang: 'vi',
    final: true
  });
  assert.equal(rescued.valid, true);
  assert.equal(rescued.text, 'Kiếm tuyệt đỉnh');
  assert.equal(rescued.rescued, true);
  assert.equal(isGeminiTranslationValid('剑技', 'Đây là 剑技 tuyệt đỉnh', {
    targetLang: 'vi', final: true, cleanupThreshold: 0.05
  }).reason, 'source_language_remaining');
});

test('merged-cue filtering also catches a single oversized cue and preserves safe siblings', () => {
  const batch = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const filtered = filterSafeGeminiMap(batch, {
    1: 'Câu tốt thứ nhất',
    2: 'Một đoạn bị dồn '.repeat(20),
    3: 'Câu tốt thứ ba'
  }, { targetLang: 'vi' });
  assert.deepEqual(filtered.cleaned, { 1: 'Câu tốt thứ nhất', 3: 'Câu tốt thứ ba' });
  assert.ok(filtered.merged[2]);
  assert.equal(nghiGopCau({ 1: 'Câu tốt', 2: 'X'.repeat(201) }), true);
});

test('retry correction reports the previous failure and candidate selection excludes unsafe cues', () => {
  const batch = Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1) }));
  const mergedAssessment = {
    valid: false, reasonCode: 'merged_cue', reason: 'gộp cue', mergedKeys: [2]
  };
  assert.match(buildRetryCorrection(mergedAssessment, 4), /LƯỢT TRƯỚC/);
  assert.match(buildRetryCorrection(mergedAssessment, 4), /ID: 2/);
  const selected = selectGeminiCandidate(batch, [
    {
      parsed: { 1: 'Câu một', 2: 'Đoạn bị dồn '.repeat(30), 3: 'Câu ba', 4: 'Câu bốn' },
      assessment: mergedAssessment,
      responseLength: 500,
      attempt: 1
    },
    {
      parsed: { 1: 'Câu một mới', 2: 'Câu hai mới', 3: 'Câu ba mới' },
      assessment: { valid: false, reasonCode: 'insufficient_coverage', parsedCount: 3 },
      responseLength: 60,
      attempt: 2
    }
  ], { targetLang: 'vi' });
  assert.equal(selected.attempt, 2);
  assert.deepEqual(selected.parsed, { 1: 'Câu một mới', 2: 'Câu hai mới', 3: 'Câu ba mới' });
});

test('residual CJK cleanup removes light Han and kana but blanks source-heavy output', () => {
  assert.equal(sanitizeResidualCjk('大哥：Nhị ca tới.', { targetLang: 'vi' }).valid, false);
  assert.equal(
    sanitizeResidualCjk('技：Nhị ca đã tới nơi rồi.', { targetLang: 'vi' }).text,
    'Nhị ca đã tới nơi rồi.'
  );
  assert.equal(sanitizeResidualCjk('Đây là 技 tuyệt đỉnh', { targetLang: 'vi' }).valid, true);
  assert.equal(sanitizeResidualCjk('这是整段没有翻译', { targetLang: 'vi' }).valid, false);
  assert.equal(sanitizeResidualCjk('日本語です', { targetLang: 'vi' }).valid, false);
});

test('Gemini Web retry prompt is specialized from the previous merged-cue failure', async () => {
  const items = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1), startTime: '00:00:00,000', endTime: '00:00:01,000', text: `原文${index + 1}`
  }));
  const prompts = [];
  const result = await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi', srcLang: 'zho_Hans', splitRounds: 0, requestRetryDelayMs: 0,
    batchDelayMs: 0, tmContent: '', logFn() {},
    requestFn: async prompt => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return `1. Câu một\n2. ${'Dồn cả đoạn '.repeat(30)}\n3. Câu ba\n4. Câu bốn`;
      }
      return '1. Câu một\n2. Câu hai\n3. Câu ba\n4. Câu bốn';
    }
  });
  assert.equal(result.failedItems.length, 0);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /SỬA LỖI LƯỢT TRƯỚC/);
  assert.match(prompts[1], /DỒN NHIỀU cue/);
  assert.match(prompts[1], /ID: 2/);
});

test('Gemini Web pipeline retries only missing cues and writes progressive SRT', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-web-lines-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'translated.srt');
  const items = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,500', text: '第一句' },
    { id: '2', startTime: '00:00:01,500', endTime: '00:00:03,000', text: '第二句' },
    { id: '3', startTime: '00:00:03,000', endTime: '00:00:04,500', text: '第三句' }
  ];
  const calls = [];
  const requestFn = async (prompt) => {
    calls.push(prompt);
    if (calls.length <= 2) return '1. Câu thứ nhất';
    return '1. Câu thứ hai\n2. Câu thứ ba';
  };

  const result = await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi',
    srcLang: 'zho_Hans',
    outputPath,
    requestFn,
    batchSize: 20,
    batchDelayMs: 0,
    retryRounds: 2,
    tmContent: '',
    logFn() {}
  });

  assert.equal(result.failedItems.length, 0);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /1\. @00:00:00 \[1\.5s ≤3 từ\] 第一句/);
  assert.match(calls[2], /1\. @00:00:01/);
  assert.doesNotMatch(calls[2], /第一句/);
  assert.deepEqual(items.map(item => item.text), ['Câu thứ nhất', 'Câu thứ hai', 'Câu thứ ba']);
  const output = fs.readFileSync(outputPath, 'utf8');
  assert.match(output, /Câu thứ nhất/);
  assert.match(output, /Câu thứ ba/);
});

test('Gemini Web keeps one conversation across successful batches', async () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    id: String(index + 1),
    startTime: `00:00:${String(index).padStart(2, '0')},000`,
    endTime: `00:00:${String(index + 1).padStart(2, '0')},000`,
    text: `原文${index + 1}`
  }));
  const conversationModes = [];
  const result = await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi', srcLang: 'zho_Hans', batchSize: 20, batchMaxChars: 100000,
    batchDelayMs: 0, splitRounds: 0, requestRetryDelayMs: 0, tmContent: '', logFn() {},
    requestFn: async (prompt, requestOptions) => {
      conversationModes.push(requestOptions.continueChat);
      const count = (prompt.match(/^\d+\. @/gm) || []).length;
      return Array.from({ length: count }, (_, index) => `${index + 1}. Bản dịch ${index + 1}`).join('\n');
    }
  });
  assert.equal(result.failedItems.length, 0);
  assert.deepEqual(conversationModes, [false, true]);
});

test('Gemini Web publishes each accepted batch immediately for early TTS', async () => {
  const items = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' },
    { id: '2', startTime: '00:00:01,200', endTime: '00:00:02,000', text: '第二句' }
  ];
  const published = [];
  await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi', srcLang: 'zho_Hans', batchDelayMs: 0,
    splitRounds: 0, requestRetryDelayMs: 0, tmContent: '', logFn() {},
    requestFn: async () => '1. Câu một\n2. Câu hai',
    onBatchTranslated: async batch => published.push(batch)
  });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].map(item => item.text), ['Câu một', 'Câu hai']);
  assert.equal(published[0][0].nextId, '2');
  assert.equal(published[0][0].nextStartTime, '00:00:01,200');
});

test('Gemini Web splits a failed batch and preserves translations already accepted', async () => {
  const items = Array.from({ length: 24 }, (_, index) => ({
    id: String(index + 1), startTime: '00:00:00,000', endTime: '00:00:01,000', text: `原文${index + 1}`
  }));
  const requestedCounts = [];
  let call = 0;
  const result = await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi', srcLang: 'zho_Hans', batchSize: 24, batchMaxChars: 100000,
    batchDelayMs: 0, splitRounds: 2, splitFloor: 2, requestRetryDelayMs: 0,
    tmContent: '', logFn() {},
    requestFn: async (prompt) => {
      call += 1;
      const count = (prompt.match(/^\d+\. @/gm) || []).length;
      requestedCounts.push(count);
      if (call <= 2) return '1. Bản dịch được giữ';
      return Array.from({ length: count }, (_, index) => `${index + 1}. Câu cứu ${index + 1}`).join('\n');
    }
  });
  assert.equal(result.failedItems.length, 0);
  assert.deepEqual(requestedCounts, [24, 24, 11, 12]);
  assert.equal(items[0].text, 'Bản dịch được giữ');
});

test('Gemini Web stops before new work when the total deadline has expired', async () => {
  const items = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' }
  ];
  let calls = 0;
  const result = await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi', srcLang: 'zho_Hans', deadlineAt: Date.now() - 1,
    splitRounds: 0, batchDelayMs: 0, tmContent: '', logFn() {},
    requestFn: async () => { calls += 1; return '1. Không được gọi'; }
  });
  assert.equal(calls, 0);
  assert.equal(result.failedItems.length, 1);
  assert.equal(items[0].text, '');
});

test('Gemini Web spellcheck accepts unchanged correct lines', async () => {
  const items = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: 'Câu này đã đúng.' }
  ];
  const result = await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi',
    srcLang: 'vie_Latn',
    mode: 'spellcheck',
    fit: false,
    requestFn: async () => '1. Câu này đã đúng.',
    retryRounds: 0,
    batchDelayMs: 0,
    tmContent: '',
    logFn() {}
  });
  assert.equal(result.failedItems.length, 0);
  assert.equal(result.mode, 'spellcheck');
  assert.equal(items[0].text, 'Câu này đã đúng.');
});

test('Gemini Web translation blanks cues that still fail after retries', async () => {
  const items = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' }
  ];
  const result = await translateSrtItemsByGeminiWeb(items, {
    targetLang: 'vi',
    srcLang: 'zho_Hans',
    mode: 'translate',
    requestFn: async () => '',
    retryRounds: 0,
    batchDelayMs: 0,
    tmContent: '',
    logFn() {}
  });
  assert.equal(result.failedItems.length, 1);
  assert.equal(result.blanked, 1);
  assert.equal(items[0].text, '');
});

test('cleanProfileLocks removes stale singleton locks successfully', () => {
  const { cleanProfileLocks } = require('../lib/gemini-web-service');
  const tempDir = path.join(__dirname, 'temp_test_profile_' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  const lock1 = path.join(tempDir, 'SingletonLock');
  const lock2 = path.join(tempDir, 'SingletonCookie');
  fs.writeFileSync(lock1, 'dummy');
  fs.writeFileSync(lock2, 'dummy');

  assert.ok(fs.existsSync(lock1));
  assert.ok(fs.existsSync(lock2));

  cleanProfileLocks(tempDir);

  assert.equal(fs.existsSync(lock1), false);
  assert.equal(fs.existsSync(lock2), false);

  try { fs.rmdirSync(tempDir); } catch (e) {}
});

test('getGeminiProfileDir respects custom GEMINI_PROFILE_DIR environment variable', () => {
  const { getGeminiProfileDir } = require('../lib/gemini-web-service');
  const custom = path.join(__dirname, 'custom_gem_profile_' + Date.now());
  const prev = process.env.GEMINI_PROFILE_DIR;
  try {
    process.env.GEMINI_PROFILE_DIR = custom;
    assert.equal(getGeminiProfileDir(), custom);
    assert.ok(fs.existsSync(custom));
  } finally {
    if (prev !== undefined) process.env.GEMINI_PROFILE_DIR = prev;
    else delete process.env.GEMINI_PROFILE_DIR;
    try { fs.rmdirSync(custom); } catch (e) {}
  }
});
