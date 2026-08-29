(function () {
  'use strict';

  const modelLabels = {
    piper: ['Model 1', 'Piper', 'Offline · nhẹ và ổn định'],
    'edge-tts': ['Model 2', 'Edge TTS', 'Online · nhiều ngôn ngữ'],
    'current-omnivoice': ['Model 3', 'OmniVoice Clone', 'GPU · sao chép giọng mẫu'],
    'capcut-tts': ['Model VIP', 'CapCut TTS', 'Online · danh mục giọng cao cấp']
  };
  let engines = [];
  let savedVoices = [];
  let selectedEngine = 'piper';
  let progressTimer = null;

  const element = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function updateCounter() {
    const text = element('tts-text')?.value || '';
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
    if (element('tts-text-counter')) element('tts-text-counter').textContent = `${lines} dòng · ${text.length.toLocaleString('vi-VN')} ký tự`;
  }

  function descriptor() {
    return engines.find((engine) => engine.id === selectedEngine);
  }

  function renderEngines() {
    const grid = element('tts-engine-grid');
    if (!grid) return;
    grid.innerHTML = engines.map((engine) => {
      const labels = modelLabels[engine.id] || ['', engine.name, ''];
      const ready = engine.status?.ready === true;
      return `<button type="button" class="tts-engine-card${selectedEngine === engine.id ? ' selected' : ''}" data-engine="${escapeHtml(engine.id)}">
        <span class="tts-model-label">${escapeHtml(labels[0])}</span>
        <strong>${escapeHtml(labels[1])}</strong><small>${escapeHtml(labels[2])}</small>
        <span class="tts-ready ${ready ? 'ready' : 'missing'}">${ready ? 'Sẵn sàng' : 'Chưa cài'}</span>
      </button>`;
    }).join('');
    grid.querySelectorAll('.tts-engine-card').forEach((button) => button.addEventListener('click', () => {
      selectedEngine = button.dataset.engine;
      renderEngines();
      refreshVoiceOptions();
    }));
    const current = descriptor();
    if (element('tts-engine-status')) {
      element('tts-engine-status').textContent = current?.status?.ready ? 'Sẵn sàng' : (current?.status?.error || 'Chưa cài runtime');
      element('tts-engine-status').classList.toggle('danger', !current?.status?.ready);
    }
  }

  function refreshVoiceOptions() {
    const engine = descriptor();
    const language = element('tts-language')?.value || 'vi';
    const gender = element('tts-gender')?.value || 'female';
    const voiceSelect = element('tts-voice');
    const cloneBox = element('tts-clone-box');
    if (cloneBox) cloneBox.classList.toggle('hidden', selectedEngine !== 'current-omnivoice');
    if (!voiceSelect) return;
    const catalog = (engine?.capabilities?.voices || []).filter((voice) => {
      const sameLanguage = !voice.lang || String(voice.lang).toLowerCase().split(/[-_]/)[0] === language;
      const sameGender = !voice.gender || voice.gender === gender;
      return sameLanguage && sameGender;
    });
    voiceSelect.innerHTML = catalog.length
      ? catalog.map((voice) => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.name || voice.id)}</option>`).join('')
      : '<option value="">Giọng mặc định</option>';
    renderEngines();
  }

  function renderSavedReferences() {
    const select = element('tts-reference-voice');
    if (!select) return;
    select.innerHTML = '<option value="">Tải file mới bên dưới</option>' + savedVoices
      .map((voice) => `<option value="${escapeHtml(voice.filename)}">${escapeHtml(voice.filename.replace(/\.[^.]+$/, ''))}</option>`).join('');
  }

  async function loadOutputs() {
    const list = element('tts-output-list');
    if (!list) return;
    try {
      const response = await fetch('/api/standalone-tts/outputs');
      const data = await response.json();
      const outputs = data.outputs || [];
      list.innerHTML = outputs.length ? outputs.map((item) => `<div class="tts-output-item">
        <div><strong>${escapeHtml(item.filename)}</strong><small>${(item.size / 1024).toFixed(0)} KB</small></div>
        <audio controls preload="none" src="${item.audioUrl}"></audio>
        <a class="ghost-btn" href="${item.audioUrl}" download="${escapeHtml(item.filename)}">Tải WAV</a>
      </div>`).join('') : '<div class="ad-empty">Chưa có file Voice.</div>';
    } catch (error) {
      list.innerHTML = `<div class="ad-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  async function loadData() {
    const [engineResponse, assetResponse] = await Promise.all([fetch('/api/voice-engines'), fetch('/api/studio-assets')]);
    const engineData = await engineResponse.json();
    const assetData = await assetResponse.json();
    engines = (engineData.engines || []).filter((engine) => modelLabels[engine.id]);
    savedVoices = assetData.voices || [];
    if (!engines.some((engine) => engine.id === selectedEngine)) selectedEngine = engines[0]?.id || 'piper';
    renderEngines();
    renderSavedReferences();
    refreshVoiceOptions();
    await loadOutputs();
  }

  async function pollProgress() {
    try {
      const response = await fetch('/api/standalone-tts/status');
      const status = await response.json();
      const percent = Math.max(0, Math.min(100, Number(status.percent) || 0));
      if (element('tts-progress-pct')) element('tts-progress-pct').textContent = `${percent}%`;
      if (element('tts-progress-bar')) element('tts-progress-bar').style.width = `${percent}%`;
      if (element('tts-progress-step')) element('tts-progress-step').textContent = status.error || status.step || 'Đang xử lý...';
    } catch (_) {}
  }

  async function generate() {
    const button = element('tts-generate-btn');
    const text = element('tts-text')?.value || '';
    if (!text.trim()) return toast('Hãy nhập nội dung cần đọc.', 'error');
    const current = descriptor();
    if (!current?.status?.ready) return toast(`${current?.name || 'Engine'} chưa được cài hoặc chưa sẵn sàng.`, 'error');
    const form = new FormData();
    form.append('text', text);
    form.append('engine', selectedEngine);
    form.append('language', element('tts-language')?.value || 'vi');
    form.append('gender', element('tts-gender')?.value || 'female');
    form.append('voice', element('tts-voice')?.value || '');
    form.append('voiceSpeed', element('tts-speed')?.value || '1');
    form.append('referenceVoice', element('tts-reference-voice')?.value || '');
    form.append('referenceText', element('tts-reference-text')?.value || '');
    const upload = element('tts-reference-audio')?.files?.[0];
    if (upload) form.append('referenceAudio', upload);
    setBusy(button, true, 'ĐANG TẠO VOICE...');
    element('tts-cancel-btn')?.classList.remove('hidden');
    progressTimer = setInterval(pollProgress, 700);
    try {
      const response = await fetch('/api/standalone-tts/generate', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Không tạo được Voice.');
      await pollProgress();
      await loadOutputs();
      toast(`Đã tạo ${data.lineCount} dòng thành ${data.filename}.`, 'success');
      const newest = element('tts-output-list')?.querySelector('audio');
      newest?.play().catch(() => {});
    } catch (error) {
      toast(error.message, 'error');
      if (element('tts-progress-step')) element('tts-progress-step').textContent = error.message;
    } finally {
      clearInterval(progressTimer);
      progressTimer = null;
      setBusy(button, false);
      element('tts-cancel-btn')?.classList.add('hidden');
    }
  }

  async function preview() {
    if (selectedEngine === 'current-omnivoice') return toast('OmniVoice cần giọng mẫu; hãy dùng nút Tạo file Voice để nghe đúng giọng clone.', 'info');
    const text = (element('tts-text')?.value || '').split(/\r?\n/).find((line) => line.trim()) || '';
    try {
      const response = await fetch('/api/preview-engine-voice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: selectedEngine, voice: element('tts-voice')?.value || '', text, voiceSpeed: element('tts-speed')?.value || 1 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Không nghe thử được.');
      new Audio(data.audioUrl).play();
    } catch (error) { toast(error.message, 'error'); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    element('tts-text')?.addEventListener('input', updateCounter);
    element('tts-language')?.addEventListener('change', refreshVoiceOptions);
    element('tts-gender')?.addEventListener('change', refreshVoiceOptions);
    element('tts-speed')?.addEventListener('input', (event) => { if (element('tts-speed-value')) element('tts-speed-value').textContent = `${Number(event.target.value).toFixed(2)}x`; });
    element('tts-generate-btn')?.addEventListener('click', generate);
    element('tts-preview-btn')?.addEventListener('click', preview);
    element('tts-refresh-output')?.addEventListener('click', loadOutputs);
    element('tts-cancel-btn')?.addEventListener('click', async () => { await fetch('/api/standalone-tts/cancel', { method: 'POST' }); });
  });

  window.loadStandaloneTts = () => loadData().catch((error) => toast(`Không tải được TTS: ${error.message}`, 'error'));
})();
