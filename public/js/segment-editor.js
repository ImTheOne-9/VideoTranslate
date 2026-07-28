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
      tts_error: 'Tạo giọng lỗi',
      smart_fit_trimmed: 'Smart Fit phải cắt phần vượt',
      smart_fit_rewrite_recommended: 'Nên viết ngắn câu này'
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
      rewrite_recommended: `Vượt giới hạn ${Number(fit.maxSpeed || 1.2).toFixed(2)}x`
    }[fit.status] || fit.status;
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
    const generationInProgress = state.batchGenerating || state.regenerating.size > 0;
    const disabled = segment.locked || generationInProgress ? ' disabled' : '';
    const dirty = state.patches.has(segment.id);
    const audioReady = segment.status === 'ready' && segment.audioFile;
    const rawAudioReady = Boolean(segment.rawAudioFile);
    const regenerating = state.regenerating.has(segment.id);
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
        <td><div class="segment-editor-source">${escapeHtml(segment.sourceText || '')}</div></td>
        <td><textarea data-field="text" aria-label="Bản dịch câu ${displayIndex + 1}"${disabled}>${escapeHtml(segment.text)}</textarea></td>
        <td>
          <select data-field="voiceFile" aria-label="Giọng đọc câu ${displayIndex + 1}"${disabled}>
            ${voiceOptions(segment.voiceFile || '')}
          </select>
        </td>
        <td class="segment-editor-duration">
          <div><span>Câu</span><strong>${durationLabel(cueDuration)}</strong></div>
          <div><span>Audio</span><strong>${segment.audioDurationMs ? durationLabel(segment.audioDurationMs) : '—'}</strong></div>
        </td>
        <td>
          <div class="segment-editor-status">
            <span class="segment-editor-status-chip ${statusClass}">
              ${escapeHtml(regenerating ? 'Đang tạo' : statusLabel(segment.status))}
            </span>
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
              title="Nghe audio gốc trước Smart Fit" aria-label="Nghe audio gốc"${rawAudioReady ? '' : ' disabled'}>G</button>
            <button type="button" class="icon-btn" data-action="regenerate"
              title="Tạo lại giọng cho riêng câu này" aria-label="Tạo lại giọng câu này"
              ${disabled || generationInProgress ? ' disabled' : ''}>↻</button>
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
    const fitModeSelect = el('segment-editor-fit-mode');
    if (fitModeSelect) fitModeSelect.value = state.manifest?.smartFit?.mode || 'cue';
    const pageInfo = el('segment-editor-page-info');
    if (pageInfo) pageInfo.textContent = `Trang ${state.page}/${totalPages} • ${items.length} segment`;
    if (el('segment-editor-prev')) el('segment-editor-prev').disabled = state.page <= 1;
    if (el('segment-editor-next')) el('segment-editor-next').disabled = state.page >= totalPages;
    const generationInProgress = state.batchGenerating || state.regenerating.size > 0;
    if (fitModeSelect) fitModeSelect.disabled = generationInProgress;
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
    const patches = [...state.patches.values()];
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

  async function updateSmartFitMode(mode) {
    if (!state.manifest || mode === state.manifest.smartFit?.mode) return;
    if (state.patches.size) await save();
    const data = await api(
      `/api/render-tasks/${encodeURIComponent(state.taskId)}/segments/smart-fit`,
      {
        method: 'POST',
        body: JSON.stringify({ revision: state.manifest.revision, mode })
      }
    );
    state.manifest = data.manifest;
    render();
    notify('Đã đổi Smart Fit. Audio gốc được giữ lại; hãy tạo lại các bản khớp thời gian.', 'success');
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
    el('segment-editor-save')?.addEventListener('click', () => save().catch(() => {}));
    el('segment-editor-generate-missing')?.addEventListener('click', regenerateMissing);
    el('segment-editor-approve')?.addEventListener('click', approveAndContinue);
    el('segment-editor-replace')?.addEventListener('click', () => replaceAll().catch((error) => showError(error.message)));
    el('segment-editor-undo')?.addEventListener('click', undo);
    el('segment-editor-redo')?.addEventListener('click', redo);
    el('segment-editor-prev')?.addEventListener('click', () => { state.page -= 1; render(); });
    el('segment-editor-next')?.addEventListener('click', () => { state.page += 1; render(); });
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
    el('segment-editor-fit-mode')?.addEventListener('change', (event) => {
      updateSmartFitMode(event.target.value).catch((error) => {
        showError(error.message);
        render();
      });
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
      }
    });
  }

  document.addEventListener('DOMContentLoaded', bind);
  window.openSegmentEditor = open;
  window.closeSegmentEditor = close;
})();
