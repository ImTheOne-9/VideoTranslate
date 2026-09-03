'use strict';

let adVideos = [];
let adItems = [];
let adPickerSelection = new Set();
let adProgressTimer = null;
let adEditorCuts = [];
let adEditorDuration = 0;
let adEditorItem = null;

const adEl = (id) => document.getElementById(id);
const adEsc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const adVideoUrl = (filename) => `/downloads/${String(filename).split(/[\\/]/).map(encodeURIComponent).join('/')}`;
const adFmtSize = (bytes) => Number(bytes) >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round((bytes || 0) / 1024)} KB`;
function adFmtTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

async function loadAntiDupeVideos() {
  try {
    const response = await fetch('/api/studio-assets');
    const data = await response.json();
    adVideos = (Array.isArray(data.videos) ? data.videos : []).filter((item) => !item.isSplitClip);
    adRenderLibrary();
  } catch (_) {
    const grid = adEl('ad-video-grid');
    if (grid) grid.innerHTML = '<div class="ad-empty">Không tải được thư viện video.</div>';
  }
}

function adItemKey(item) { return item.kind === 'file' ? item.key : `library:${item.filename}`; }
function adAddItems(items) {
  const keys = new Set(adItems.map(adItemKey));
  for (const item of items) if (!keys.has(adItemKey(item))) { adItems.push(item); keys.add(adItemKey(item)); }
  adRenderSelected();
}

function adRenderSelected() {
  const list = adEl('ad-selected-list');
  const count = adEl('ad-source-count');
  if (count) count.textContent = `${adItems.length} video`;
  if (!list) return;
  if (!adItems.length) { list.innerHTML = '<div class="ad-empty">Chưa chọn video.</div>'; return; }
  list.innerHTML = adItems.map((item, index) => {
    const name = item.name || item.filename;
    const badge = item.kind === 'file' ? 'Từ máy' : item.chopped ? 'Đã băm' : 'Video đã tải';
    return `<div class="ad-source-item"><video src="${adEsc(item.url)}" muted preload="metadata"></video><div><b title="${adEsc(name)}">${adEsc(name)}</b><small>${adEsc(badge)}${item.size ? ` · ${adFmtSize(item.size)}` : ''}</small></div><button type="button" class="ad-remove-source" data-index="${index}" title="Bỏ video">✕</button></div>`;
  }).join('');
  list.querySelectorAll('.ad-remove-source').forEach((button) => button.addEventListener('click', () => {
    const [removed] = adItems.splice(Number(button.dataset.index), 1);
    if (removed?.kind === 'file') URL.revokeObjectURL(removed.url);
    adRenderSelected();
  }));
}

function adRenderLibrary() {
  const grid = adEl('ad-video-grid');
  if (!grid) return;
  const query = String(adEl('ad-library-search')?.value || '').trim().toLowerCase();
  const videos = adVideos.filter((item) => String(item.name || item.filename).toLowerCase().includes(query));
  if (!videos.length) { grid.innerHTML = '<div class="ad-empty">Không có video phù hợp.</div>'; return; }
  grid.innerHTML = videos.map((item) => {
    const selected = adPickerSelection.has(item.filename);
    return `<button type="button" class="ad-library-item${selected ? ' selected' : ''}" data-file="${adEsc(item.filename)}"><span class="ad-library-check">${selected ? '✓' : ''}</span><video src="${adEsc(adVideoUrl(item.filename))}" muted preload="metadata"></video><span><b title="${adEsc(item.name || item.filename)}">${adEsc(item.name || item.filename)}</b><small>${adFmtSize(item.size)} · ${item.chopped ? 'Đã băm nhỏ' : 'Chưa băm'}</small></span></button>`;
  }).join('');
  grid.querySelectorAll('.ad-library-item').forEach((button) => button.addEventListener('click', () => {
    const filename = button.dataset.file;
    if (adPickerSelection.has(filename)) adPickerSelection.delete(filename); else adPickerSelection.add(filename);
    adRenderLibrary(); adUpdatePickerCount();
  }));
}

function adUpdatePickerCount() {
  const label = adEl('ad-library-selected-count');
  if (label) label.textContent = `${adPickerSelection.size} video đã chọn`;
}
function adOpenPicker() { adPickerSelection = new Set(); adRenderLibrary(); adUpdatePickerCount(); adEl('ad-library-picker')?.classList.remove('hidden'); }
function adClosePicker() { adEl('ad-library-picker')?.classList.add('hidden'); }

function adAppendSources(formData, items) {
  const library = [];
  for (const item of items) {
    if (item.kind === 'file') formData.append('videoUpload', item.file, item.name);
    else library.push(item.filename);
  }
  if (library.length) formData.append('mainVideoFiles', JSON.stringify(library));
}

function adSetProgress(progress) {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
  if (adEl('ad-progress-bar')) adEl('ad-progress-bar').style.width = `${percent}%`;
  if (adEl('ad-progress-pct')) adEl('ad-progress-pct').textContent = `${percent}%`;
  if (adEl('ad-progress-step')) adEl('ad-progress-step').textContent = progress.step || 'Chưa có tác vụ nào.';
  if (adEl('ad-progress-meta')) adEl('ad-progress-meta').textContent = progress.total ? `${progress.current || 0}/${progress.total} clip` : '';
  const cancel = adEl('ad-cancel-btn');
  if (cancel) cancel.hidden = !['running', 'rendering'].includes(progress.status);
  const log = adEl('ad-progress-log');
  if (log) { log.textContent = (progress.logs || []).join('\n'); log.scrollTop = log.scrollHeight; }
}
function adStopPolling() { if (adProgressTimer) clearInterval(adProgressTimer); adProgressTimer = null; }
async function adPoll() {
  try {
    const response = await fetch('/api/anti-dupe-progress');
    const progress = await response.json();
    adSetProgress(progress);
    if (['done', 'error', 'cancelled'].includes(progress.status)) {
      adStopPolling();
      if (progress.status === 'done') {
        adShowResultClips(progress.result);
        loadAntiDupeVideos();
        if (typeof refreshStudioVideoAssets === 'function') refreshStudioVideoAssets();
      } else if (progress.status === 'error') toast(progress.error || 'Băm video thất bại', 'error');
    }
  } catch (_) {}
}
function adStartPolling() { adStopPolling(); adPoll(); adProgressTimer = setInterval(adPoll, 800); }

async function adStartSplit(items, extra = {}) {
  if (!items.length) { toast('Hãy thêm ít nhất một video', 'error'); return; }
  const formData = new FormData();
  adAppendSources(formData, items);
  const fields = {
    splitMode: adEl('ad-split-mode').value,
    numCopies: adEl('ad-num-copies').value,
    targetSeconds: adEl('ad-target-seconds').value,
    sensitivity: adEl('ad-sensitivity').value,
    aspect: adEl('ad-aspect2').value,
    flip: adEl('ad-flip2').checked ? '1' : '',
    precise: adEl('ad-precise').checked ? '1' : '',
    outputDir: adEl('ad-output-dir').value,
    ...extra
  };
  Object.entries(fields).forEach(([key, value]) => { if (value !== undefined && value !== '') formData.append(key, value); });
  adSetProgress({ status: 'running', percent: 1, step: 'Đang khởi tạo tác vụ…', logs: [] });
  const button = adEl(extra.ranges ? 'ad-manual-split-btn' : 'ad-split-btn');
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/anti-dupe-scene-split', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không thể bắt đầu băm video');
    adStartPolling();
    toast(`Đã bắt đầu băm ${data.videos || items.length} video`, 'success');
  } catch (error) {
    adSetProgress({ status: 'error', percent: 0, step: error.message, logs: [] });
    toast(error.message, 'error');
  } finally { if (button) button.disabled = false; }
}

function adShowResultClips(data) {
  const box = adEl('ad-result');
  if (!box) return;
  const clips = data?.clips || [];
  if (!clips.length) { box.innerHTML = '<div class="ad-empty">Không có clip đầu ra.</div>'; return; }
  box.innerHTML = `<div class="ad-result-summary">✓ Hoàn tất ${clips.length} clip</div>${clips.map((clip) => `<article class="ad-result-clip"><video controls preload="none" data-src="${adEsc(clip.url || '')}"></video><div><b>${adEsc(clip.file)}</b><small>${adFmtTime(clip.start)} – ${adFmtTime(clip.end)}${clip.reused ? ' · dùng lại' : ''}</small></div></article>`).join('')}`;
  const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries, obs) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.src = entry.target.dataset.src; obs.unobserve(entry.target);
  }), { rootMargin: '300px' }) : null;
  box.querySelectorAll('video[data-src]').forEach((video) => observer ? observer.observe(video) : video.src = video.dataset.src);
}

async function adOpenEditor() {
  if (adItems.length !== 1) { toast('Trình chỉnh mốc cần đúng 1 video trong danh sách', 'info'); return; }
  const item = adItems[0];
  const formData = new FormData();
  adAppendSources(formData, [item]);
  formData.append('sensitivity', adEl('ad-sensitivity').value);
  const button = adEl('ad-editor-btn');
  button.disabled = true; button.textContent = 'Đang phân tích cảnh…';
  try {
    const response = await fetch('/api/anti-dupe-scene-analyze', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không phân tích được video');
    if (item.kind === 'file' && data.source) {
      URL.revokeObjectURL(item.url);
      Object.assign(item, { kind: 'library', filename: data.source, url: adVideoUrl(data.source), name: data.name });
      delete item.file; adRenderSelected();
    }
    adEditorItem = item;
    adEditorDuration = data.durationSec;
    adEl('ad-editor-name').textContent = `${data.name} · ${adFmtTime(data.durationSec)}${data.skippedLongVideo ? ' · video dài, dùng mốc chia đều' : ''}`;
    const video = adEl('ad-editor-video'); video.src = data.previewUrl || item.url;
    adEl('ad-cut-count').value = adEl('ad-num-copies').value;
    adEl('ad-editor-precise').checked = adEl('ad-precise').checked;
    adResetCuts(data.cuts || []);
    adEl('ad-editor').classList.remove('hidden');
    adEl('ad-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = '✂ Chỉnh mốc thủ công'; }
}

function adResetCuts(sceneCuts = []) {
  const count = Math.max(1, Math.min(200, Number(adEl('ad-cut-count').value) || 1));
  const part = adEditorDuration / count;
  const used = new Set();
  adEditorCuts = [];
  for (let index = 1; index < count; index += 1) {
    const ideal = part * index;
    let best = null;
    for (const cut of sceneCuts) if (!used.has(cut) && (best === null || Math.abs(cut - ideal) < Math.abs(best - ideal))) best = cut;
    const picked = best !== null && Math.abs(best - ideal) <= part / 2 ? best : ideal;
    if (picked === best) used.add(best);
    adEditorCuts.push(picked);
  }
  adDrawTimeline();
}

function adDrawTimeline() {
  const timeline = adEl('ad-timeline');
  if (!timeline || !adEditorDuration) return;
  timeline.querySelectorAll('.ad-cut-marker,.ad-clip-zone').forEach((element) => element.remove());
  const points = [0, ...adEditorCuts, adEditorDuration];
  for (let index = 0; index < points.length - 1; index += 1) {
    const zone = document.createElement('div');
    zone.className = 'ad-clip-zone';
    zone.style.left = `${points[index] / adEditorDuration * 100}%`;
    zone.style.width = `${(points[index + 1] - points[index]) / adEditorDuration * 100}%`;
    zone.textContent = String(index + 1); timeline.appendChild(zone);
  }
  adEditorCuts.forEach((cut, index) => {
    const marker = document.createElement('button');
    marker.type = 'button'; marker.className = 'ad-cut-marker'; marker.style.left = `${cut / adEditorDuration * 100}%`;
    marker.title = adFmtTime(cut); marker.dataset.index = index; timeline.appendChild(marker);
    marker.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const move = (moveEvent) => {
        const rect = timeline.getBoundingClientRect();
        const value = Math.max(0, Math.min(adEditorDuration, (moveEvent.clientX - rect.left) / rect.width * adEditorDuration));
        const previous = index ? adEditorCuts[index - 1] + 0.5 : 0.5;
        const next = index < adEditorCuts.length - 1 ? adEditorCuts[index + 1] - 0.5 : adEditorDuration - 0.5;
        adEditorCuts[index] = Math.max(previous, Math.min(next, value));
        marker.style.left = `${adEditorCuts[index] / adEditorDuration * 100}%`;
        marker.title = adFmtTime(adEditorCuts[index]);
      };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); adDrawTimeline(); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
  });
}

function adTimelineSeek(event) {
  if (event.target.classList.contains('ad-cut-marker')) return;
  const rect = adEl('ad-timeline').getBoundingClientRect();
  adEl('ad-editor-video').currentTime = Math.max(0, Math.min(adEditorDuration, (event.clientX - rect.left) / rect.width * adEditorDuration));
}
function adManualSplit() {
  const points = [0, ...adEditorCuts, adEditorDuration];
  const ranges = points.slice(0, -1).map((start, index) => [Number(start.toFixed(3)), Number(points[index + 1].toFixed(3))]);
  adEl('ad-precise').checked = adEl('ad-editor-precise').checked;
  adStartSplit([adEditorItem], { ranges: JSON.stringify(ranges) });
}

document.addEventListener('DOMContentLoaded', () => {
  adRenderSelected();
  adEl('ad-add-library-btn')?.addEventListener('click', adOpenPicker);
  adEl('ad-library-close')?.addEventListener('click', adClosePicker);
  adEl('ad-library-picker')?.addEventListener('click', (event) => { if (event.target.id === 'ad-library-picker') adClosePicker(); });
  adEl('ad-library-search')?.addEventListener('input', adRenderLibrary);
  adEl('ad-library-confirm')?.addEventListener('click', () => {
    adAddItems(adVideos.filter((item) => adPickerSelection.has(item.filename)).map((item) => ({ ...item, kind: 'library', url: adVideoUrl(item.filename) })));
    adClosePicker();
  });
  adEl('ad-add-files-btn')?.addEventListener('click', () => adEl('ad-source-upload').click());
  adEl('ad-source-upload')?.addEventListener('change', (event) => {
    const items = [...event.target.files].map((file) => ({ kind: 'file', key: `file:${file.name}:${file.size}:${file.lastModified}`, file, name: file.name, size: file.size, url: URL.createObjectURL(file) }));
    adAddItems(items); event.target.value = '';
  });
  adEl('ad-split-mode')?.addEventListener('change', (event) => {
    adEl('ad-count-setting').classList.toggle('hidden', event.target.value !== 'count');
    adEl('ad-duration-setting').classList.toggle('hidden', event.target.value !== 'duration');
  });
  adEl('ad-output-dir-btn')?.addEventListener('click', async () => {
    try {
      const response = await fetch('/api/select-save-path?mode=folder');
      const data = await response.json();
      if (!data.canceled && data.dir) adEl('ad-output-dir').value = data.dir;
    } catch (_) { toast('Không mở được hộp chọn thư mục', 'error'); }
  });
  adEl('ad-split-btn')?.addEventListener('click', () => adStartSplit(adItems));
  adEl('ad-cancel-btn')?.addEventListener('click', async () => { await fetch('/api/anti-dupe-cancel', { method: 'POST' }); });
  adEl('ad-editor-btn')?.addEventListener('click', adOpenEditor);
  adEl('ad-editor-close')?.addEventListener('click', () => adEl('ad-editor').classList.add('hidden'));
  adEl('ad-reset-cuts')?.addEventListener('click', () => adResetCuts());
  adEl('ad-cut-count')?.addEventListener('change', () => adResetCuts());
  adEl('ad-timeline')?.addEventListener('click', adTimelineSeek);
  adEl('ad-manual-split-btn')?.addEventListener('click', adManualSplit);
  adEl('ad-editor-video')?.addEventListener('timeupdate', (event) => {
    const current = event.target.currentTime || 0;
    adEl('ad-editor-time').textContent = `${adFmtTime(current)} / ${adFmtTime(adEditorDuration)}`;
    adEl('ad-timeline-progress').style.width = `${adEditorDuration ? current / adEditorDuration * 100 : 0}%`;
    adEl('ad-playhead').style.left = `${adEditorDuration ? current / adEditorDuration * 100 : 0}%`;
  });
  document.querySelector('.nav-btn[data-view="antidupe"]')?.addEventListener('click', () => setTimeout(loadAntiDupeVideos, 50));
});
