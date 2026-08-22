(function initSegmentEditorModule() {
  const PAGE_SIZE = 100;
  const state = {
    taskId: null,
    manifest: null,
    voices: [],
    page: 1,
    search: '',
    filter: 'all',
    patches: new Map(),
    undo: [],
    redo: [],
    loading: false,
    regenerating: new Set(),
    asrRetrying: new Set(),
    batchGenerating: false,
    batchProgress: null,
    stopBatchRequested: false,
    previewEndSeconds: null
  };

  const el = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  function notify(message, type = 'info') {
    if (typeof window.toast === 'function') window.toast(message, type);
  }

  function formatTime(milliseconds) {
    const value = Math.max(0, Math.round(Number(milliseconds) || 0));
    const hours = Math.floor(value / 3600000);
    const minutes = Math.floor((value % 3600000) / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const millis = value % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`
      + `${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  }

  function parseTime(value) {
    const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(value || '').trim());
    if (!match) return Number.NaN;
    return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000)
      + Number(match[4].padEnd(3, '0'));
  }

  function durationLabel(milliseconds) {
    const seconds = Math.max(0, Number(milliseconds) || 0) / 1000;
    return `${seconds.toFixed(2)}s`;
  }

  function warningLabel(code) {
    return {
      empty_text: 'Thiếu nội dung',
      invalid_timing: 'Timestamp không hợp lệ',
      cue_too_short: 'Cue quá ngắn',
      overlap: 'Chồng thời gian',
      outside_video: 'Vượt thời lượng video',
      audio_too_long: 'Audio dài hơn cue',
      audio_silent: 'Audio gần như im lặng',
      audio_clipping: 'Audio bị vỡ tiếng',
      audio_too_quiet: 'Audio quá nhỏ',
      tts_error: 'Tạo giọng lỗi',
      smart_fit_trimmed: 'Bản audio cũ từng bị cắt phần vượt cue',
      smart_fit_rewrite_recommended: 'Nên viết ngắn câu này',
      asr_invalid_timestamp: 'ASR có timestamp không hợp lệ',
      asr_cue_too_short: 'ASR tạo câu quá ngắn',
      asr_dense_text: 'ASR dồn quá nhiều chữ',
      asr_cue_too_long: 'ASR tạo câu quá dài',
      asr_repeated_text: 'ASR có nội dung lặp',
      asr_script_mismatch: 'Ký tự không khớp ngôn ngữ đã chọn',
      asr_low_confidence: 'Whisper có độ tin cậy thấp',
      asr_translation_stale: 'Bản dịch cần cập nhật theo lời gốc mới',
      asr_retry_error: 'Nhận dạng lại bằng Whisper bị lỗi'
    }[code] || code;
  }

  function statusLabel(status) {
    return {
      pending: 'Chưa tạo',
      generating: 'Đang tạo',
      ready: 'Đã có audio',
      error: 'Lỗi'
    }[status] || status;
  }

  function fitStatusLabel(fit) {
    if (!fit) return '';
    return {
      unchanged: 'Giữ nguyên',
      borrowed: 'Mượn khoảng nghỉ',
      sped_up: `Tăng tốc ${Number(fit.speed || 1).toFixed(2)}x`,
      trimmed: `Đã cắt ${durationLabel(fit.trimmedMs)}`,
      rewrite_recommended: `Vượt giới hạn ${Number(fit.maxSpeed || 2).toFixed(2)}x`
    }[fit.status] || fit.status;
  }

  function renderAudioQuality(audioQuality) {
    if (!audioQuality) return '';
    const warnings = Array.isArray(audioQuality.warnings) ? audioQuality.warnings : [];
    const hasWarning = warnings.length > 0;
    const formatMetric = (value) => (
      Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} dB` : '—'
    );
    return `
      <div class="segment-editor-qc ${hasWarning ? 'is-warning' : 'is-good'}"
        title="Kiểm tra chất lượng audio sau khi chuẩn hóa">
        <div class="segment-editor-qc-header">
          <span>Chất lượng audio</span>
          <strong><i aria-hidden="true"></i>${hasWarning ? 'Cần kiểm tra' : 'Đạt'}</strong>
        </div>
        <div class="segment-editor-qc-metric"
          title="Mức âm lượng trung bình của câu sau khi chuẩn hóa">
          <span>Âm lượng</span>
          <strong>${formatMetric(audioQuality.rmsDbfs)}</strong>
        </div>
        <div class="segment-editor-qc-metric"
          title="Đỉnh âm lượng lớn nhất; càng gần 0 dB thì tín hiệu càng lớn">
          <span>Đỉnh</span>
          <strong>${formatMetric(audioQuality.peakDbfs)}</strong>
        </div>
      </div>
    `;
  }

  function renderAsrQuality(asr) {
    if (!asr) return '';
    const score = asr.qualityScore !== null
      && asr.qualityScore !== undefined
      && Number.isFinite(Number(asr.qualityScore))
      ? `${Math.round(Number(asr.qualityScore))}/100`
      : 'Chưa có';
    const confidence = asr.modelConfidence !== null
      && asr.modelConfidence !== undefined
      && Number.isFinite(Number(asr.modelConfidence))
      ? `${Math.round(Number(asr.modelConfidence) * 100)}%`
      : 'Không có từ model';
    const warningCount = Array.isArray(asr.warnings) ? asr.warnings.length : 0;
    return `
      <div class="segment-editor-asr-quality ${warningCount ? 'is-warning' : 'is-good'}">
        <span>ASR ${escapeHtml(score)}</span>
        <span title="Độ tin cậy do model trả về">${escapeHtml(confidence)}</span>
        ${asr.words?.length ? `<span>${asr.words.length} từ có timestamp</span>` : ''}
      </div>
    `;
  }

  function showError(message) {
    const box = el('segment-editor-error');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('hidden', !message);
  }

  function snapshotPatches() {
    return JSON.stringify([...state.patches.entries()]);
  }

  function restorePatchSnapshot(snapshot) {
    state.patches = new Map(JSON.parse(snapshot || '[]'));
    render();
  }

  function pushUndo() {
    state.undo.push(snapshotPatches());
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshotPatches());
    restorePatchSnapshot(state.undo.pop());
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshotPatches());
    restorePatchSnapshot(state.redo.pop());
  }

  function segmentWithPatch(segment) {
    return { ...segment, ...(state.patches.get(segment.id) || {}) };
  }

  function filteredSegments() {
    if (!state.manifest) return [];
    const needle = state.search.trim().toLocaleLowerCase();
    return state.manifest.segments
      .map(segmentWithPatch)
      .filter((segment) => {
        if (needle && !`${segment.sourceText} ${segment.text}`.toLocaleLowerCase().includes(needle)) {
          return false;
        }
        if (state.filter === 'warnings') return segment.warnings?.length > 0;
        if (state.filter === 'asr-review') {
          return (segment.warnings || []).some((warning) => warning.startsWith('asr_'));
        }
        if (state.filter === 'unapproved') return !segment.approved;
        if (state.filter === 'locked') return segment.locked;
        return true;
      });
  }

  function voiceOptions(selected) {
    const values = new Set(['', selected, ...state.voices].filter((value) => value !== undefined));
    const availableVoices = new Set(state.voices);
    return [...values].map((value) => (
      `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>`
      + `${escapeHtml(value
        ? `${value}${availableVoices.has(value) ? '' : ' (không còn file)'}`
        : 'Giọng mặc định')}</option>`
    )).join('');
  }

  function renderRow(segment, displayIndex) {
    const cueDuration = segment.endMs - segment.startMs;
    const warnings = (segment.warnings || []).map(warningLabel);
    const generationInProgress = state.batchGenerating
      || state.regenerating.size > 0
      || state.asrRetrying.size > 0;
    const disabled = segment.locked || generationInProgress ? ' disabled' : '';
    const dirty = state.patches.has(segment.id);
    const audioReady = segment.status === 'ready' && segment.audioFile;
    const rawAudioReady = Boolean(segment.rawAudioFile);
    const regenerating = state.regenerating.has(segment.id);
    const asrRetrying = state.asrRetrying.has(segment.id);
    const statusClass = segment.status === 'ready'
      ? 'is-ready'
      : segment.status === 'error'
        ? 'is-error'
        : segment.status === 'generating' || regenerating
          ? 'is-generating'
          : 'is-pending';
    return `
      <tr data-segment-id="${escapeHtml(segment.id)}"
        class="${dirty ? 'is-dirty ' : ''}${warnings.length ? 'has-warning ' : ''}${regenerating ? 'is-busy' : ''}">
        <td class="segment-editor-index">${displayIndex + 1}</td>
        <td>
          <div class="segment-editor-time-grid">
            <label>
              <span>Bắt đầu</span>
              <input data-field="startMs" aria-label="Thời gian bắt đầu câu ${displayIndex + 1}"
                value="${formatTime(segment.startMs)}"${disabled}>
            </label>
            <label>
              <span>Kết thúc</span>
              <input data-field="endMs" aria-label="Thời gian kết thúc câu ${displayIndex + 1}"
                value="${formatTime(segment.endMs)}"${disabled}>
            </label>
          </div>
        </td>
        <td>
          <div class="segment-editor-source">${escapeHtml(segment.sourceText || '')}</div>
          ${renderAsrQuality(segment.asr)}
        </td>
        <td><textarea data-field="text" aria-label="Bản dịch câu ${displayIndex + 1}"${disabled}>${escapeHtml(segment.text)}</textarea></td>
        <td>
          <select data-field="voiceFile" aria-label="Giọng đọc câu ${displayIndex + 1}"${disabled}>
            ${voiceOptions(segment.voiceFile || '')}
          </select>
        </td>
        <td class="segment-editor-duration">
          <div><span>Câu</span><strong>${durationLabel(cueDuration)}</strong></div>
          <div><span>Audio</span><strong>${segment.audioDurationMs ? durationLabel(segment.audioDurationMs) : '—'}</strong></div>
          ${renderAudioQuality(segment.audioQuality)}
        </td>
        <td>
          <div class="segment-editor-status">
            <span class="segment-editor-status-chip ${statusClass}">
              ${escapeHtml(regenerating ? 'Đang tạo' : statusLabel(segment.status))}
            </span>
            ${segment.narrationFit?.shortened
              ? `<span class="segment-editor-fit-result">Đã rút gọn tự động (${Number(segment.narrationFit.attempts) || 1} lần)</span>`
              : ''}
            ${segment.fit ? `<span class="segment-editor-fit-result">${escapeHtml(fitStatusLabel(segment.fit))}</span>` : ''}
            ${warnings.map((warning) => `<span class="segment-editor-warning">${escapeHtml(warning)}</span>`).join('')}
            ${segment.error ? `<span class="segment-editor-warning">${escapeHtml(segment.error)}</span>` : ''}
          </div>
        </td>
        <td>
          <div class="segment-editor-row-actions">
            <button type="button" class="icon-btn" data-action="seek"
              title="Đưa video xem trước tới đầu câu này" aria-label="Xem vị trí câu trên video">▶</button>
            <button type="button" class="icon-btn" data-action="play"
              title="Nghe audio đã tạo của câu này" aria-label="Nghe audio câu này"${audioReady ? '' : ' disabled'}>♪</button>
            <button type="button" class="icon-btn" data-action="play-raw"
              title="Nghe audio gốc trước khi khớp cue" aria-label="Nghe audio gốc"${rawAudioReady ? '' : ' disabled'}>G</button>
            <button type="button" class="icon-btn" data-action="regenerate"
              title="Tạo lại giọng cho riêng câu này" aria-label="Tạo lại giọng câu này"
              ${disabled || generationInProgress ? ' disabled' : ''}>↻</button>
            ${state.manifest?.asr ? `
              <button type="button" class="icon-btn segment-editor-asr-btn"
                data-action="${asrRetrying ? 'asr-cancel' : 'asr-retry'}"
                title="${asrRetrying ? 'Dừng nhận dạng lại câu này' : 'Nhận dạng lại lời gốc của riêng câu này bằng Whisper'}"
                aria-label="${asrRetrying ? 'Dừng nhận dạng lại' : 'Nhận dạng lại bằng Whisper'}"
                ${generationInProgress && !asrRetrying ? ' disabled' : ''}>${asrRetrying ? '■' : 'ASR'}</button>
            ` : ''}
          </div>
          <div class="segment-editor-row-flags">
            <label class="segment-editor-check">
              <input type="checkbox" data-field="approved"${segment.approved ? ' checked' : ''}${disabled}>
              <span>Đã duyệt</span>
            </label>
            <label class="segment-editor-check">
              <input type="checkbox" data-field="locked"${segment.locked ? ' checked' : ''}
                ${generationInProgress ? ' disabled' : ''}>
              <span>Khóa câu</span>
            </label>
          </div>
        </td>
      </tr>`;
  }

  function render() {
    const body = el('segment-editor-body');
    if (!body) return;
    const items = filteredSegments();
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.page = Math.max(1, Math.min(state.page, totalPages));
    const start = (state.page - 1) * PAGE_SIZE;
    body.innerHTML = items.slice(start, start + PAGE_SIZE)
      .map((segment, index) => renderRow(segment, start + index))
      .join('');

    function renderPagePills(currentPage, totalPages) {
      if (totalPages <= 1) return '';
      const pills = [];
      const addPill = (page) => {
        pills.push(`
          <button type="button" class="segment-page-pill ${page === currentPage ? 'is-active' : ''}"
            data-page="${page}" title="Đến trang ${page}">
            ${page}
          </button>
        `);
      };
      const addEllipsis = () => {
        pills.push('<span class="segment-page-ellipsis" aria-hidden="true">…</span>');
      };

      if (totalPages <= 7) {
        for (let p = 1; p <= totalPages; p++) addPill(p);
      } else {
        addPill(1);
        if (currentPage > 3) addEllipsis();
        const start = Math.max(2, currentPage - 1);
        const end = Math.min(totalPages - 1, currentPage + 1);
        for (let p = start; p <= end; p++) addPill(p);
        if (currentPage < totalPages - 2) addEllipsis();
        addPill(totalPages);
      }
      return pills.join('');
    }

    const manifestSegments = state.manifest?.segments || [];
    const approved = manifestSegments.filter((segment) => {
      const patch = state.patches.get(segment.id);
      return Object.hasOwn(patch || {}, 'approved') ? patch.approved : segment.approved;
    }).length;
    const warningCount = manifestSegments.filter((segment) => segment.warnings?.length).length;
    const summary = el('segment-editor-summary');
    if (summary) {
      summary.innerHTML = `
        <span><strong>${approved}/${manifestSegments.length}</strong> đã duyệt</span>
        <span class="${warningCount ? 'has-warning' : ''}"><strong>${warningCount}</strong> cảnh báo</span>
        <span class="${state.patches.size ? 'has-changes' : ''}"><strong>${state.patches.size}</strong> chưa lưu</span>`;
    }
    const pageInfo = el('segment-editor-page-info');
    if (pageInfo) pageInfo.textContent = `Trang ${state.page}/${totalPages} • ${items.length} segment`;
    const topPageInfo = el('segment-editor-top-page-info');
    if (topPageInfo) topPageInfo.textContent = `Trang ${state.page}/${totalPages}`;

    const isPrevDisabled = state.page <= 1;
    const isNextDisabled = state.page >= totalPages;
    if (el('segment-editor-prev')) el('segment-editor-prev').disabled = isPrevDisabled;
    if (el('segment-editor-next')) el('segment-editor-next').disabled = isNextDisabled;
    if (el('segment-editor-top-prev')) el('segment-editor-top-prev').disabled = isPrevDisabled;
    if (el('segment-editor-top-next')) el('segment-editor-top-next').disabled = isNextDisabled;

    const pagePills = el('segment-editor-page-pills');
    if (pagePills) pagePills.innerHTML = renderPagePills(state.page, totalPages);
    const generationInProgress = state.batchGenerating
      || state.regenerating.size > 0
      || state.asrRetrying.size > 0;
    if (el('segment-editor-undo')) {
      el('segment-editor-undo').disabled = generationInProgress || state.undo.length === 0;
    }
    if (el('segment-editor-redo')) {
      el('segment-editor-redo').disabled = generationInProgress || state.redo.length === 0;
    }
    if (el('segment-editor-save')) {
      el('segment-editor-save').disabled = generationInProgress || state.patches.size === 0;
    }
    if (el('segment-editor-approve')) el('segment-editor-approve').disabled = generationInProgress;
    if (el('segment-editor-replace')) el('segment-editor-replace').disabled = generationInProgress;
    const missingAudio = manifestSegments.filter((segment) => (
      !segment.locked && !(segment.status === 'ready' && segment.audioFile)
    )).length;
    const generateMissingButton = el('segment-editor-generate-missing');
    if (generateMissingButton) {
      generateMissingButton.classList.toggle('is-running', state.batchGenerating);
      generateMissingButton.disabled = state.batchGenerating
        ? state.stopBatchRequested
        : state.regenerating.size > 0 || missingAudio === 0;
      generateMissingButton.textContent = state.batchGenerating
        ? state.stopBatchRequested
          ? 'Đang dừng sau câu hiện tại...'
          : `Dừng sau câu hiện tại (${state.batchProgress.done}/${state.batchProgress.total})`
        : `Tạo tất cả câu chưa có audio (${missingAudio})`;
    }
  }

  function updatePatch(segmentId, field, value) {
    pushUndo();
    const current = { ...(state.patches.get(segmentId) || {}) };
    current.id = segmentId;
    current[field] = value;
    if (field === 'locked' && value === true) current.approved = true;
    state.patches.set(segmentId, current);
    render();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Không thể xử lý segment');
      error.code = data.code;
      error.currentRevision = data.currentRevision;
      error.manifest = data.manifest;
      throw error;
    }
    return data;
  }

  async function loadVoices() {
    try {
      const response = await fetch('/api/studio-assets');
      const data = await response.json();
      state.voices = (data.voices || []).map((item) => (
        typeof item === 'string' ? item : item.name || item.filename
      )).filter(Boolean);
    } catch {
      state.voices = [];
    }
  }

  async function reload() {
    const data = await api(`/api/render-tasks/${encodeURIComponent(state.taskId)}/segments`);
    state.manifest = data.manifest;
    state.patches.clear();
    state.undo = [];
    state.redo = [];
    render();
  }

  async function save() {
    if (!state.patches.size) return state.manifest;
    showError('');
    const patches = [...state.patches.entries()].map(([id, patch]) => ({ id, ...patch }));
    try {
      const data = await api(`/api/render-tasks/${encodeURIComponent(state.taskId)}/segments`, {
        method: 'PUT',
        body: JSON.stringify({ revision: state.manifest.revision, segments: patches })
      });
      state.manifest = data.manifest;
      state.patches.clear();
      state.undo = [];
      state.redo = [];
      render();
      notify('Đã lưu thay đổi segment.', 'success');
      return state.manifest;
    } catch (error) {
      if (error.code === 'SEGMENT_REVISION_CONFLICT') {
        await reload();
      }
      showError(error.message);
      throw error;
    }
  }

  async function replaceAll() {
    const search = el('segment-editor-replace-from')?.value || '';
    const replacement = el('segment-editor-replace-to')?.value || '';
    if (!search) return;
    if (state.patches.size) await save();
    const data = await api(`/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/replace`, {
      method: 'POST',
      body: JSON.stringify({ revision: state.manifest.revision, search, replacement })
    });
    state.manifest = data.manifest;
    render();
    notify('Đã thay thế nội dung trong các câu chưa khóa.', 'success');
  }

  async function approveAndContinue() {
    try {
      await save();
      const approved = await api(
        `/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ revision: state.manifest.revision })
        }
      );
      state.manifest = approved.manifest;
      await api('/api/render-resume', {
        method: 'POST',
        body: JSON.stringify({ taskId: state.taskId })
      });
      close();
      if (typeof window.startQueuePolling === 'function') window.startQueuePolling();
      notify('Đã duyệt segment và tiếp tục render.', 'success');
    } catch (error) {
      showError(error.message);
    }
  }

  async function open(taskId) {
    if (!taskId || state.loading) return;
    state.loading = true;
    state.taskId = taskId;
    state.page = 1;
    state.search = '';
    state.filter = 'all';
    showError('');
    const modal = el('segment-editor-modal');
    modal?.classList.remove('hidden');
    modal?.setAttribute('aria-hidden', 'false');
    try {
      await Promise.all([loadVoices(), reload()]);
      if (typeof window.closeQueueModal === 'function') window.closeQueueModal();
    } catch (error) {
      if (error.manifest) {
        state.manifest = error.manifest;
      } else {
        try {
          await reload();
        } catch {}
      }
      showError(error.message);
    } finally {
      state.loading = false;
    }
  }

  function close() {
    if (state.patches.size && !window.confirm('Bạn có thay đổi chưa lưu. Đóng trình chỉnh sửa?')) return;
    const modal = el('segment-editor-modal');
    modal?.classList.add('hidden');
    modal?.setAttribute('aria-hidden', 'true');
    el('segment-editor-audio')?.pause();
    closeVideoPreview();
  }

  async function playSegment(segmentId, variant = 'fitted') {
    const audio = el('segment-editor-audio');
    if (!audio) return;
    audio.src = `/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/`
      + `${encodeURIComponent(segmentId)}/audio?revision=${state.manifest.revision}`
      + `&variant=${encodeURIComponent(variant)}`;
    await audio.play();
  }

  function closeVideoPreview() {
    const video = el('segment-editor-video');
    video?.pause();
    state.previewEndSeconds = null;
    el('segment-editor-video-popover')?.classList.add('hidden');
  }

  async function seekSegment(segmentId) {
    const segment = state.manifest?.segments.find((item) => item.id === segmentId);
    const sourceVideo = el('studio-video-preview');
    const video = el('segment-editor-video');
    const source = sourceVideo?.currentSrc || sourceVideo?.src;
    if (!segment || !video || !source) {
      throw new Error('Không tìm thấy video nguồn để xem trước.');
    }
    if (video.src !== source) {
      video.src = source;
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('Không thể mở video xem trước.')), { once: true });
      });
    }
    video.currentTime = Math.max(0, segment.startMs / 1000);
    state.previewEndSeconds = Math.max(video.currentTime, segment.endMs / 1000);
    el('segment-editor-video-title').textContent = `Xem câu ${state.manifest.segments.indexOf(segment) + 1}`;
    el('segment-editor-video-popover')?.classList.remove('hidden');
    await video.play();
  }

  async function requestRegenerate(segmentId) {
    if (state.batchGenerating || state.regenerating.size > 0) {
      notify('Hãy chờ câu đang tạo giọng hoàn tất.', 'info');
      return;
    }
    state.regenerating.add(segmentId);
    render();
    try {
      await save();
      const data = await api(
        `/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/${encodeURIComponent(segmentId)}/regenerate`,
        { method: 'POST', body: JSON.stringify({ revision: state.manifest.revision }) }
      );
      state.manifest = data.manifest;
      render();
      notify('Đã tạo lại giọng cho segment.', 'success');
    } catch (error) {
      showError(error.message);
    } finally {
      state.regenerating.delete(segmentId);
      render();
    }
  }

  async function requestAsrRetry(segmentId) {
    if (state.batchGenerating || state.regenerating.size > 0 || state.asrRetrying.size > 0) {
      notify('Hãy chờ tác vụ audio hiện tại hoàn tất.', 'info');
      return;
    }
    state.asrRetrying.add(segmentId);
    showError('');
    render();
    try {
      await save();
      const data = await api(
        `/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/${encodeURIComponent(segmentId)}/asr-retry`,
        { method: 'POST', body: JSON.stringify({ revision: state.manifest.revision }) }
      );
      state.manifest = data.manifest;
      render();
      notify('Đã nhận dạng lại lời gốc của câu này.', 'success');
    } catch (error) {
      if (error.code === 'ASR_CANCELLED') {
        notify('Đã dừng nhận dạng lại bằng Whisper.', 'info');
        return;
      }
      if (error.manifest) state.manifest = error.manifest;
      showError(error.message);
    } finally {
      state.asrRetrying.delete(segmentId);
      render();
    }
  }

  async function cancelAsrRetry(segmentId) {
    try {
      await api(
        `/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/${encodeURIComponent(segmentId)}/asr-cancel`,
        { method: 'POST', body: '{}' }
      );
      notify('Đã gửi yêu cầu dừng Whisper.', 'info');
    } catch (error) {
      showError(error.message);
    }
  }

  async function regenerateMissing() {
    if (state.batchGenerating) {
      state.stopBatchRequested = true;
      render();
      notify('Sẽ dừng sau khi tạo xong câu hiện tại.', 'info');
      return;
    }
    if (state.regenerating.size > 0) return;
    try {
      await save();
    } catch {
      return;
    }

    const targets = state.manifest.segments
      .filter((segment) => !segment.locked && !(segment.status === 'ready' && segment.audioFile))
      .map((segment) => segment.id);
    if (!targets.length) {
      notify('Tất cả câu chưa khóa đều đã có audio.', 'info');
      return;
    }

    state.batchGenerating = true;
    state.batchProgress = { done: 0, total: targets.length };
    state.stopBatchRequested = false;
    showError('');
    render();
    const failures = [];

    for (const segmentId of targets) {
      state.regenerating.add(segmentId);
      render();
      try {
        const data = await api(
          `/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/${encodeURIComponent(segmentId)}/regenerate`,
          { method: 'POST', body: JSON.stringify({ revision: state.manifest.revision }) }
        );
        state.manifest = data.manifest;
      } catch (error) {
        failures.push(error.message);
        if (error.manifest) {
          state.manifest = error.manifest;
        } else {
          try {
            await reload();
          } catch {}
        }
      } finally {
        state.regenerating.delete(segmentId);
        state.batchProgress.done += 1;
        render();
      }
      if (state.stopBatchRequested) break;
    }

    const completed = state.batchProgress.done;
    const stopped = state.stopBatchRequested;
    state.batchGenerating = false;
    state.batchProgress = null;
    state.stopBatchRequested = false;
    render();
    if (stopped) {
      notify(`Đã dừng sau ${completed}/${targets.length} câu.`, 'info');
    } else if (failures.length) {
      showError(`Đã tạo xong với ${failures.length}/${targets.length} câu bị lỗi. `
        + 'Kiểm tra trạng thái từng câu để chọn lại giọng hoặc thử lại.');
      notify(`Có ${failures.length} câu tạo audio thất bại.`, 'error');
    } else {
      notify(`Đã tạo audio cho ${targets.length} câu.`, 'success');
    }
  }

  /* ==========================================================================
     EXPORT SRT & IMPORT SRT MODULE
     ========================================================================== */

  function parseTimeFlexible(value) {
    const str = String(value || '').trim();
    if (!str) return Number.NaN;

    // 1. hh:mm:ss[,.]ms (e.g. 00:01:23,456 or 0:01:23.456)
    let match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(str);
    if (match) {
      return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000)
        + Number(match[4].padEnd(3, '0'));
    }

    // 2. mm:ss[,.:]ms (e.g. 00:08:533 or 08:533 or 01:23,456)
    match = /^(\d{1,2}):(\d{1,2})[,.:](\d{1,3})$/.exec(str);
    if (match) {
      return ((Number(match[1]) * 60 + Number(match[2])) * 1000)
        + Number(match[3].padEnd(3, '0'));
    }

    // 3. hh:mm:ss (no ms)
    match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(str);
    if (match) {
      return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000);
    }

    // 4. mm:ss (no ms)
    match = /^(\d{1,2}):(\d{2})$/.exec(str);
    if (match) {
      return (Number(match[1]) * 60 + Number(match[2])) * 1000;
    }

    // 5. Raw number in seconds
    const num = Number(str.replace(',', '.'));
    if (Number.isFinite(num) && num >= 0) {
      return Math.round(num * 1000);
    }

    return Number.NaN;
  }

  function parseSrtText(rawText) {
    const normalized = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!normalized) return [];

    const blocks = normalized.split(/\n\s*\n+/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (!lines.length) continue;

      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          timeLineIdx = i;
          break;
        }
      }

      if (timeLineIdx === -1) continue;

      const timeLine = lines[timeLineIdx];
      const parts = timeLine.split('-->');
      if (parts.length < 2) continue;

      const startMs = parseTimeFlexible(parts[0]);
      const endMs = parseTimeFlexible(parts[1]);

      const textLines = lines.slice(timeLineIdx + 1);
      const text = textLines.join('\n').trim();

      cues.push({
        startMs: Number.isFinite(startMs) ? startMs : 0,
        endMs: Number.isFinite(endMs) ? endMs : 0,
        text
      });
    }

    return cues;
  }

  function generateSrtFromSegments(type = 'translated') {
    const segments = state.manifest?.segments || [];
    let out = '';
    segments.forEach((seg, idx) => {
      const patch = state.patches.get(seg.id) || {};
      const effective = { ...seg, ...patch };
      const startTime = formatTime(effective.startMs);
      const endTime = formatTime(effective.endMs);
      const translated = String(effective.text !== undefined ? effective.text : (effective.translatedText || '')).trim();
      const source = String(effective.sourceText || '').trim();
      let text = translated;
      if (type === 'source') {
        text = source || translated;
      } else if (type === 'bilingual') {
        text = translated && source ? `${translated}\n${source}` : (translated || source);
      }
      out += `${idx + 1}\n${startTime} --> ${endTime}\n${text}\n\n`;
    });
    return out.trim();
  }

  function openExportModal() {
    const segments = state.manifest?.segments || [];
    if (!segments.length) {
      notify('Chưa có câu thoại nào để xuất.', 'info');
      return;
    }
    const type = el('segment-export-type')?.value || 'translated';
    const srtText = generateSrtFromSegments(type);
    const textarea = el('segment-export-textarea');
    if (textarea) textarea.value = srtText;
    const countEl = el('segment-export-count');
    if (countEl) countEl.textContent = `${segments.length} câu thoại`;
    el('segment-editor-export-modal')?.classList.remove('hidden');
  }

  function closeExportModal() {
    el('segment-editor-export-modal')?.classList.add('hidden');
  }

  function copyExportSrt() {
    const textarea = el('segment-export-textarea');
    if (!textarea || !textarea.value) {
      notify('Không có nội dung SRT để sao chép.', 'info');
      return;
    }
    textarea.select();
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(textarea.value).then(() => {
        notify('📋 Đã sao chép nội dung SRT vào bộ nhớ tạm!', 'success');
      }).catch(() => {
        document.execCommand('copy');
        notify('📋 Đã sao chép nội dung SRT vào bộ nhớ tạm!', 'success');
      });
    } else {
      document.execCommand('copy');
      notify('📋 Đã sao chép nội dung SRT vào bộ nhớ tạm!', 'success');
    }
  }

  function downloadExportSrt() {
    const textarea = el('segment-export-textarea');
    if (!textarea || !textarea.value) {
      notify('Không có nội dung SRT để tải xuống.', 'info');
      return;
    }
    const type = el('segment-export-type')?.value || 'translated';
    const blob = new Blob([textarea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subtitles_${type}_${state.taskId || 'export'}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notify('💾 Đã tải xuống file SRT thành công!', 'success');
  }

  function openImportModal() {
    const fileInput = el('segment-import-file');
    if (fileInput) fileInput.value = '';
    const textarea = el('segment-import-textarea');
    if (textarea) textarea.value = '';
    const countEl = el('segment-import-parsed-count');
    if (countEl) countEl.textContent = '';
    el('segment-editor-import-modal')?.classList.remove('hidden');
  }

  function closeImportModal() {
    el('segment-editor-import-modal')?.classList.add('hidden');
  }

  function updateImportPreview() {
    const rawText = el('segment-import-textarea')?.value || '';
    const cues = parseSrtText(rawText);
    const countEl = el('segment-import-parsed-count');
    if (countEl) {
      if (cues.length > 0) {
        countEl.textContent = `✨ Đã nhận diện ${cues.length} câu thoại`;
      } else if (rawText.trim().length > 0) {
        countEl.textContent = '⚠️ Chưa nhận diện được định dạng SRT';
      } else {
        countEl.textContent = '';
      }
    }
  }

  function handleImportFile() {
    const fileInput = el('segment-import-file');
    const file = fileInput?.files?.[0];
    if (!file) {
      notify('Vui lòng chọn file SRT/TXT từ máy tính.', 'info');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result;
      const textarea = el('segment-import-textarea');
      if (textarea) {
        textarea.value = content || '';
        updateImportPreview();
      }
      notify(`Đã đọc file "${file.name}" thành công!`, 'info');
    };
    reader.onerror = () => {
      notify('Lỗi khi đọc file.', 'error');
    };
    reader.readAsText(file, 'utf-8');
  }

  function applyImportSrt() {
    const rawText = el('segment-import-textarea')?.value || '';
    const cues = parseSrtText(rawText);
    if (!cues.length) {
      notify('Không tìm thấy câu phụ đề hợp lệ nào trong nội dung đã nhập.', 'error');
      return;
    }

    const segments = state.manifest?.segments || [];
    if (!segments.length) {
      notify('Không có danh sách câu thoại trong dự án để cập nhật.', 'error');
      return;
    }

    const mode = document.querySelector('input[name="segment-import-mode"]:checked')?.value || 'text-only';
    pushUndo();

    let updatedCount = 0;
    segments.forEach((seg, idx) => {
      const cue = cues[idx];
      if (!cue) return;

      const currentPatch = state.patches.get(seg.id) || {};
      const newPatch = { ...currentPatch, id: seg.id };

      if (cue.text !== undefined) {
        newPatch.text = cue.text;
      }

      if (mode === 'full-timeline') {
        if (Number.isFinite(cue.startMs) && cue.startMs >= 0) {
          newPatch.startMs = cue.startMs;
        }
        if (Number.isFinite(cue.endMs) && cue.endMs > 0) {
          newPatch.endMs = cue.endMs;
        }
      }

      state.patches.set(seg.id, newPatch);
      updatedCount++;
    });

    render();
    closeImportModal();
    notify(`✅ Đã cập nhật thành công ${updatedCount} câu thoại từ SRT!`, 'success');
  }

  function bind() {
    el('segment-editor-close')?.addEventListener('click', close);
    el('segment-editor-video-close')?.addEventListener('click', closeVideoPreview);
    el('segment-editor-video')?.addEventListener('timeupdate', (event) => {
      if (Number.isFinite(state.previewEndSeconds)
        && event.currentTarget.currentTime >= state.previewEndSeconds) {
        event.currentTarget.pause();
        state.previewEndSeconds = null;
      }
    });

    el('segment-editor-export-srt')?.addEventListener('click', openExportModal);
    el('segment-editor-export-close')?.addEventListener('click', closeExportModal);
    el('segment-export-type')?.addEventListener('change', () => {
      const type = el('segment-export-type')?.value || 'translated';
      const srtText = generateSrtFromSegments(type);
      const textarea = el('segment-export-textarea');
      if (textarea) textarea.value = srtText;
    });
    el('segment-export-copy-btn')?.addEventListener('click', copyExportSrt);
    el('segment-export-download-btn')?.addEventListener('click', downloadExportSrt);

    el('segment-editor-import-srt')?.addEventListener('click', openImportModal);
    el('segment-editor-import-close')?.addEventListener('click', closeImportModal);
    el('segment-import-cancel-btn')?.addEventListener('click', closeImportModal);
    el('segment-import-file')?.addEventListener('change', handleImportFile);
    el('segment-import-read-file-btn')?.addEventListener('click', handleImportFile);
    el('segment-import-textarea')?.addEventListener('input', updateImportPreview);
    el('segment-import-apply-btn')?.addEventListener('click', applyImportSrt);

    el('segment-editor-save')?.addEventListener('click', () => save().catch(() => {}));
    el('segment-editor-generate-missing')?.addEventListener('click', regenerateMissing);
    el('segment-editor-approve')?.addEventListener('click', approveAndContinue);
    el('segment-editor-replace')?.addEventListener('click', () => replaceAll().catch((error) => showError(error.message)));
    el('segment-editor-undo')?.addEventListener('click', undo);
    el('segment-editor-redo')?.addEventListener('click', redo);
    el('segment-editor-prev')?.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; render(); } });
    el('segment-editor-next')?.addEventListener('click', () => {
      const items = filteredSegments();
      const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      if (state.page < totalPages) { state.page += 1; render(); }
    });
    el('segment-editor-top-prev')?.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; render(); } });
    el('segment-editor-top-next')?.addEventListener('click', () => {
      const items = filteredSegments();
      const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      if (state.page < totalPages) { state.page += 1; render(); }
    });
    el('segment-editor-page-pills')?.addEventListener('click', (event) => {
      const pill = event.target.closest('.segment-page-pill');
      if (!pill) return;
      const targetPage = Number(pill.dataset.page);
      if (Number.isFinite(targetPage) && targetPage !== state.page) {
        state.page = targetPage;
        render();
      }
    });
    el('segment-editor-search')?.addEventListener('input', (event) => {
      state.search = event.target.value;
      state.page = 1;
      render();
    });
    el('segment-editor-filter')?.addEventListener('change', (event) => {
      state.filter = event.target.value;
      state.page = 1;
      render();
    });
    el('segment-editor-body')?.addEventListener('change', (event) => {
      const row = event.target.closest('tr[data-segment-id]');
      const field = event.target.dataset.field;
      if (!row || !field) return;
      let value = event.target.value;
      if (field === 'startMs' || field === 'endMs') {
        value = parseTime(value);
        if (!Number.isFinite(value)) {
          showError('Timestamp phải có dạng 00:01:23,456.');
          render();
          return;
        }
      } else if (event.target.type === 'checkbox') {
        value = event.target.checked;
      }
      showError('');
      updatePatch(row.dataset.segmentId, field, value);
    });

    el('segment-editor-body')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      const row = event.target.closest('tr[data-segment-id]');
      if (!button || !row) return;
      if (button.dataset.action === 'seek') {
        seekSegment(row.dataset.segmentId).catch((error) => showError(error.message));
      }
      if (button.dataset.action === 'play') playSegment(row.dataset.segmentId).catch((error) => showError(error.message));
      if (button.dataset.action === 'play-raw') {
        playSegment(row.dataset.segmentId, 'raw').catch((error) => showError(error.message));
      }
      if (button.dataset.action === 'regenerate') requestRegenerate(row.dataset.segmentId);
      if (button.dataset.action === 'asr-retry') requestAsrRetry(row.dataset.segmentId);
      if (button.dataset.action === 'asr-cancel') cancelAsrRetry(row.dataset.segmentId);
    });

    document.addEventListener('keydown', (event) => {
      if (el('segment-editor-modal')?.classList.contains('hidden')) return;
      if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save().catch(() => {});
      } else if (event.ctrlKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
      } else if (event.ctrlKey && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (event.key === 'Escape') {
        close();
      } else {
        const isEditing = ['input', 'textarea', 'select'].includes(document.activeElement?.tagName?.toLowerCase());
        if (!isEditing) {
          if (event.key === '[' || (event.altKey && event.key === 'ArrowLeft')) {
            event.preventDefault();
            if (state.page > 1) { state.page -= 1; render(); }
          } else if (event.key === ']' || (event.altKey && event.key === 'ArrowRight')) {
            event.preventDefault();
            const items = filteredSegments();
            const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
            if (state.page < totalPages) { state.page += 1; render(); }
          }
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.openSegmentEditor = open;
  window.closeSegmentEditor = close;
  window.openExportSrtModal = openExportModal;
  window.closeExportSrtModal = closeExportModal;
  window.openImportSrtModal = openImportModal;
  window.closeImportSrtModal = closeImportModal;
})();
