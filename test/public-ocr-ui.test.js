const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createOcrComponentFlow,
  escapeHtml,
  getOcrFallbackAction,
  normalizeOcrRegion,
  normalizeSupportedLanguages,
  transformOcrRegion
} = require('../public/js/ocr-ui');

test('escapes OCR status text before inserting it into queue markup', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)> & "bad"'), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;bad&quot;');
});

test('normalizes supported OCR languages with Vietnamese labels', () => {
  assert.deepEqual(normalizeSupportedLanguages(['en', 'ch', 'vi', 'en', 'japan']), [
    { id: 'en', label: 'Anh' },
    { id: 'ch', label: 'Trung' },
    { id: 'vi', label: 'Việt' },
    { id: 'japan', label: 'Nhật' }
  ]);
});

test('normalizes OCR region and rejects inverted bounds', () => {
  assert.equal(normalizeOcrRegion(['0.70', '0.98', '0.05', '0.95']), '0.70,0.98,0.05,0.95');
  assert.throws(() => normalizeOcrRegion(['0.9', '0.7', '0.05', '0.95']), /trên.*dưới/i);
  assert.throws(() => normalizeOcrRegion(['0.7', '0.98', '-0.1', '0.95']), /0 đến 1/i);
});

test('moves and resizes OCR regions while keeping them inside the video', () => {
  assert.deepEqual(
    transformOcrRegion([0.70, 0.98, 0.05, 0.95], 'move', 0.20, 0.20),
    [0.72, 1, 0.1, 1]
  );
  assert.deepEqual(
    transformOcrRegion([0.70, 0.98, 0.05, 0.95], 'nw', 0.10, -0.10),
    [0.6, 0.98, 0.15, 0.95]
  );
  assert.deepEqual(
    transformOcrRegion([0.70, 0.98, 0.05, 0.95], 'se', -1, -1),
    [0.7, 0.73, 0.05, 0.08]
  );
});

test('component flow returns immediately when OCR is ready', async () => {
  const calls = [];
  const flow = createOcrComponentFlow({
    request: async (url, options) => {
      calls.push([url, options]);
      return { status: 'ready', supportedLanguages: ['vi', 'en'] };
    },
    wait: async () => {}
  });

  const result = await flow.check();
  assert.equal(result.ready, true);
  assert.deepEqual(result.supportedLanguages, ['vi', 'en']);
  assert.deepEqual(calls, [['/api/ocr-component/status', undefined]]);
});

test('component flow downloads once and polls until ready', async () => {
  const calls = [];
  const progress = [];
  const waits = [];
  let polls = 0;
  const flow = createOcrComponentFlow({
    request: async (url, options) => {
      calls.push([url, options?.method]);
      if (url.endsWith('/download')) return { success: true };
      polls += 1;
      return polls === 1
        ? { status: 'downloading', percent: 42 }
        : { status: 'ready', percent: 100 };
    },
    wait: async milliseconds => { waits.push(milliseconds); },
    onProgress: state => progress.push(state)
  });

  const result = await flow.download();
  assert.equal(result.ready, true);
  assert.deepEqual(calls, [
    ['/api/ocr-component/download', 'POST'],
    ['/api/ocr-component/download-status', undefined],
    ['/api/ocr-component/download-status', undefined]
  ]);
  assert.deepEqual(waits, [1500]);
  assert.equal(progress.at(-1).status, 'ready');
});

test('component flow waits and retries when progress polling is rate limited', async () => {
  let polls = 0;
  const waits = [];
  const flow = createOcrComponentFlow({
    request: async url => {
      if (url.endsWith('/download')) return { success: true };
      polls += 1;
      if (polls === 1) {
        const error = new Error('Quá nhiều yêu cầu.');
        error.status = 429;
        error.retryAfterMs = 3000;
        throw error;
      }
      return { status: 'ready', percent: 100 };
    },
    wait: async milliseconds => { waits.push(milliseconds); }
  });

  assert.equal((await flow.download()).ready, true);
  assert.equal(polls, 2);
  assert.deepEqual(waits, [3000]);
});

test('component flow cancellation stops polling and calls cancel endpoint', async () => {
  let releaseWait;
  const waitStarted = new Promise(resolve => { releaseWait = resolve; });
  const calls = [];
  const flow = createOcrComponentFlow({
    request: async (url, options) => {
      calls.push([url, options?.method]);
      if (url.endsWith('/download-status')) return { status: 'downloading', percent: 10 };
      return { success: true };
    },
    wait: async () => waitStarted
  });

  const downloading = flow.download();
  await new Promise(resolve => setImmediate(resolve));
  await flow.cancel();
  releaseWait();
  const result = await downloading;

  assert.equal(result.cancelled, true);
  assert.equal(calls.filter(([url]) => url.endsWith('/cancel')).length, 1);
  assert.equal(calls.filter(([url]) => url.endsWith('/download-status')).length, 1);
});

test('component flow cancellation wins when an in-flight poll returns ready', async () => {
  let resolvePoll;
  let pollStartedResolve;
  const pollStarted = new Promise(resolve => { pollStartedResolve = resolve; });
  const pollResult = new Promise(resolve => { resolvePoll = resolve; });
  const calls = [];
  const flow = createOcrComponentFlow({
    request: async (url, options) => {
      calls.push([url, options?.method]);
      if (url.endsWith('/download-status')) {
        pollStartedResolve();
        return pollResult;
      }
      return { success: true };
    },
    wait: async () => {}
  });

  const downloading = flow.download();
  await pollStarted;
  const cancelling = flow.cancel();
  resolvePoll({ status: 'ready', percent: 100 });
  await cancelling;

  assert.deepEqual(await downloading, { cancelled: true });
  assert.equal(calls.filter(([url]) => url.endsWith('/cancel')).length, 1);
});

test('only OCR technical waiting tasks expose the Whisper fallback action', () => {
  assert.deepEqual(getOcrFallbackAction({
    status: 'waiting_input',
    actionRequired: { type: 'ocr_fallback', message: 'OCR bị lỗi kỹ thuật' }
  }), { visible: true, message: 'OCR bị lỗi kỹ thuật' });
  assert.deepEqual(getOcrFallbackAction({ status: 'pending' }), { visible: false, message: '' });
  assert.deepEqual(getOcrFallbackAction({ status: 'waiting_input', actionRequired: { type: 'other' } }), { visible: false, message: '' });
  assert.deepEqual(getOcrFallbackAction({
    status: 'waiting_input',
    actionRequired: 'ocr_fallback',
    error: 'CUDA runtime bị lỗi'
  }), { visible: true, message: 'CUDA runtime bị lỗi' });
});

test('studio markup exposes language, advanced region, and first-use download controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const id of [
    'ocr-settings-container',
    'ocr-language-select',
    'ocr-region-top',
    'ocr-region-bottom',
    'ocr-region-left',
    'ocr-region-right',
    'ocr-region-value',
    'ocr-region-overlay',
    'ocr-mode-value',
    'subtitle-engine-value',
    'ocr-component-modal',
    'ocr-download-btn',
    'ocr-download-cancel-btn'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /name=["']ocrLanguage["']/);
  assert.match(html, /name=["']ocrMode["']/);
  assert.match(html, /name=["']subtitleEngine["']/);
  assert.match(html, /name=["']whisperOnnxVariant["']/);
  assert.match(html, /data-whisper-onnx-variant=["']q8["']/);
  assert.match(html, /data-whisper-onnx-variant=["']fp32["']/);
  assert.match(html, /name=["']ocrRegion["']/);
  for (const mode of ['fast', 'auto', 'accurate']) {
    assert.match(html, new RegExp(`data-ocr-mode=["']${mode}["']`));
  }
  for (const engine of ['auto', 'ocr', 'whisper']) {
    assert.match(html, new RegExp(`data-subtitle-engine=["']${engine}["']`));
  }
  assert.match(html, /src=["']js\/ocr-ui\.js["']/);
});

test('studio client wires OCR preflight and Whisper fallback endpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /ensureOcrComponentReady/);
  assert.match(source, /refreshOcrComponentStatusForUi/);
  assert.match(source, /normalizeOcrRegion/);
  assert.match(source, /waiting_input/);
  assert.match(source, /\/api\/render-use-whisper/);
  assert.match(source, /useWhisperForTask/);

  const subtitleTabs = source.slice(source.indexOf('// Setup sub mode tabs'), source.indexOf('// Setup whisper model change handler'));
  const voiceTabs = source.slice(source.indexOf('// Setup voice mode tabs'), source.indexOf('// Setup sub mode tabs'));
  assert.match(subtitleTabs, /ocr-settings-container/);
  assert.doesNotMatch(voiceTabs, /ocr-settings-container/);

  const cancelDownload = source.slice(source.indexOf('async function cancelOcrComponentDownload'), source.indexOf('function syncOcrRegion'));
  assert.match(cancelDownload, /await ocrComponentFlow\.cancel\(\)/);
  assert.doesNotMatch(cancelDownload, /if \(ocrDownloadActive\)/);

  const mainWaiting = source.slice(source.indexOf("targetTask.status === 'waiting_input'"), source.indexOf("targetTask.status === 'success'"));
  assert.match(mainWaiting, /fallback\.visible/);

  const queueWaitingStart = source.indexOf('if (isWaiting &&');
  const queueWaiting = source.slice(queueWaitingStart, source.indexOf('} else if (isPending)', queueWaitingStart));
  assert.match(queueWaiting, /cancelQueueTask/);
  assert.match(queueWaiting, /escapeHtml/);
});
