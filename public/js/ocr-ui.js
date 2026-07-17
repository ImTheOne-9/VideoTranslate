(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OcrUi = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LANGUAGE_LABELS = {
    ch: 'Trung',
    vi: 'Việt',
    en: 'Anh',
    japan: 'Nhật',
    korean: 'Hàn'
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeSupportedLanguages(languages) {
    const seen = new Set();
    return (Array.isArray(languages) ? languages : [])
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim())
      .filter(id => !seen.has(id) && seen.add(id))
      .map(id => ({ id, label: LANGUAGE_LABELS[id] || id.toUpperCase() }));
  }

  function normalizeOcrRegion(values) {
    if (!Array.isArray(values) || values.length !== 4) {
      throw new Error('Vùng OCR phải có đủ bốn giá trị.');
    }
    const numbers = values.map(Number);
    if (numbers.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('Các giá trị vùng OCR phải nằm trong khoảng 0 đến 1.');
    }
    const [top, bottom, left, right] = numbers;
    if (top >= bottom) throw new Error('Mép trên phải nhỏ hơn mép dưới.');
    if (left >= right) throw new Error('Mép trái phải nhỏ hơn mép phải.');
    return numbers.map(value => value.toFixed(2)).join(',');
  }

  function getOcrFallbackAction(task) {
    const action = task?.actionRequired;
    const actionType = typeof action === 'string' ? action : action?.type;
    if (task?.status !== 'waiting_input' || actionType !== 'ocr_fallback') {
      return { visible: false, message: '' };
    }
    return { visible: true, message: action?.message || task.error || 'OCR gặp lỗi kỹ thuật.' };
  }

  function createOcrComponentFlow(options = {}) {
    const request = options.request;
    const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const onProgress = options.onProgress || (() => {});
    const pollInterval = options.pollInterval ?? 500;
    let cancelled = false;

    if (typeof request !== 'function') throw new TypeError('request is required');

    async function check() {
      const status = await request('/api/ocr-component/status');
      return { ...status, ready: status.status === 'ready' };
    }

    async function download() {
      cancelled = false;
      await request('/api/ocr-component/download', { method: 'POST' });
      while (!cancelled) {
        const progress = await request('/api/ocr-component/download-status');
        if (cancelled) return { cancelled: true };
        onProgress(progress);
        if (progress.status === 'ready') return { ...progress, ready: true };
        if (progress.status === 'error') throw new Error(progress.error || 'Không thể tải bộ OCR.');
        if (progress.status === 'cancelled') return { ...progress, cancelled: true };
        await wait(pollInterval);
      }
      return { cancelled: true };
    }

    async function cancel() {
      cancelled = true;
      return request('/api/ocr-component/cancel', { method: 'POST' });
    }

    return { check, download, cancel };
  }

  return {
    createOcrComponentFlow,
    escapeHtml,
    getOcrFallbackAction,
    normalizeOcrRegion,
    normalizeSupportedLanguages
  };
}));
