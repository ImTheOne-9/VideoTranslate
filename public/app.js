const views = {
  download: {
    title: 'Tải video',
    desc: 'Dán link YouTube Shorts, YouTube hoặc Xiaohongshu để tải về thư mục downloads.'
  },
  studio: {
    title: 'Studio render',
    desc: 'Dịch tiếng Việt, chèn sub, thêm voiceover hoặc nhạc nền rồi render ra MP4.'
  },
  'rendered-videos': {
    title: 'Kho video render',
    desc: 'Quản lý các video đã render thành công: Xem trước, đăng lên Facebook hoặc xóa.'
  },
  voices: {
    title: 'Kho giọng mẫu',
    desc: 'Quản lý các giọng mẫu đã lưu để lồng tiếng AI bằng Omni Cloner.'
  },
  music: {
    title: 'Kho nhạc nền',
    desc: 'Quản lý các file nhạc nền để chèn vào video khi render.'
  },
  bulk: {
    title: 'Tải hàng loạt',
    desc: 'Tải video từ playlist hoặc kênh theo số lượng đã chọn.'
  },
  pages: {
    title: 'Quản lý Fanpage',
    desc: 'Quản lý danh sách các Fanpage của bạn, bao gồm thêm, sửa, xóa và tìm kiếm.'
  }
};

let currentUrl = '';
let assets = { videos: [], voices: [], music: [], subtitles: [], renders: [], omiConfigured: false };

const $ = (id) => document.getElementById(id);

function toast(message, type = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3600);
}

function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    button.dataset.oldText = button.textContent;
    button.textContent = text || 'Đang xử lý...';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.oldText || button.textContent;
    button.disabled = false;
  }
}

function switchView(name) {
  stopAllAudio();
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $('view-title').textContent = views[name].title;
  $('view-desc').textContent = views[name].desc;
  if (name === 'rendered-videos') {
    currentVideoPage = 1;
    renderRenderedVideosGrid($('rendered-search-input')?.value || '');
  } else if (name === 'voices') {
    currentVoicePage = 1;
    renderVoicesList($('voice-search-input')?.value || '');
  } else if (name === 'music') {
    currentMusicPage = 1;
    renderMusicList($('music-search-input')?.value || '');
  }
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

document.querySelectorAll('.preview-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preview-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    const previewTab = $('tab-preview-content');
    const resultTab = $('tab-result-content');
    if (previewTab) previewTab.classList.toggle('hidden', tab !== 'preview');
    if (resultTab) resultTab.classList.toggle('hidden', tab !== 'result');
  });
});

function switchToResultTab() {
  const resultBtn = document.querySelector('.preview-tab-btn[data-tab="result"]');
  if (resultBtn) resultBtn.click();
}

function switchToPreviewTab() {
  const previewBtn = document.querySelector('.preview-tab-btn[data-tab="preview"]');
  if (previewBtn) previewBtn.click();
}

function fillSelect(id, items, placeholder) {
  const select = $(id);
  if (!select) return;
  select.innerHTML = `<option value="">${placeholder}</option>`;
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.filename;
    if (id === 'saved-voice-select' || id === 'saved-music-select') {
      const lastDot = item.filename.lastIndexOf('.');
      option.textContent = lastDot !== -1 ? item.filename.substring(0, lastDot) : item.filename;
    } else {
      option.textContent = item.filename;
    }
    select.appendChild(option);
  }
}

function renderAssetList(id, items) {
  const list = $(id);
  if (!list) return;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<li class="muted">Chưa có file</li>';
    return;
  }
  for (const item of items.slice(0, 8)) {
    const li = document.createElement('li');
    li.textContent = item.filename;
    list.appendChild(li);
  }
}

async function loadAssets() {
  const res = await fetch('/api/studio-assets');
  assets = await res.json();
  renderVideoGrid(assets.videos);
  renderReactionVideoGrid(assets.videos);
  fillSelect('saved-voice-select', assets.voices, 'Chọn giọng đã lưu');
  fillSelect('saved-music-select', assets.music, 'Chọn nhạc đã lưu');
  fillSelect('saved-subtitle-select', assets.subtitles, 'Chọn sub đã lưu');
  renderAssetList('asset-videos', assets.videos);
  renderAssetList('asset-voices', assets.voices);
  renderAssetList('asset-music', assets.music);
  renderAssetList('asset-subtitles', assets.subtitles);
  const omiStatusEl = $('omi-status');
  if (omiStatusEl) {
    if (assets.omiConfigured) {
      omiStatusEl.innerHTML = '<span class="dot ok"></span> OmniVoice sẵn sàng';
      omiStatusEl.style.cursor = 'default';
      omiStatusEl.onclick = null;
    } else {
      omiStatusEl.innerHTML = '<span class="dot warn"></span> Thiếu OmniVoice CLI/model (Bấm để tải)';
      omiStatusEl.style.cursor = 'pointer';
      omiStatusEl.onclick = () => openModelDownloadModal();
    }
  }
    
  // Tải danh sách giao diện nếu đang hiển thị
  if ($('voice-list-tbody')) renderVoicesList($('voice-search-input')?.value || '');
  if ($('music-list-tbody')) renderMusicList($('music-search-input')?.value || '');
  if ($('rendered-videos-grid')) renderRenderedVideosGrid($('rendered-search-input')?.value || '');
}

function isValidVideoUrl(url) {
  return /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/|facebook\.com\/|fb\.watch\/|fb\.com\/|tiktok\.com\/)/.test(url);
}

function formatDuration(seconds) {
  const value = Math.round(Number(seconds || 0));
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function fetchVideoInfo() {
  let url = $('url-input').value.trim();
  const match = url.match(/https?:\/\/[^\s]+/);
  if (match) {
    url = match[0];
    $('url-input').value = url;
  }
  if (!url || !isValidVideoUrl(url)) {
    toast('Link video không hợp lệ.', 'error');
    return;
  }

  const btn = $('fetch-btn');
  setBusy(btn, true, 'Đang lấy...');
  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không lấy được thông tin video');
    currentUrl = url;
    renderVideoInfo(data);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

function renderVideoInfo(data) {
  $('video-thumbnail').src = data.thumbnail || '';
  $('video-title').textContent = data.title || 'Untitled';
  $('video-meta').textContent = `${data.author || 'Unknown'} · ${formatDuration(data.duration)}`;
  const grid = $('quality-grid');
  grid.innerHTML = '';

  const vietsub = document.createElement('button');
  vietsub.className = 'quality-btn green';
  vietsub.type = 'button';
  const savedGeminiKey = localStorage.getItem('geminiApiKey') || '';
  const vietsubUrl = `/api/download-vi?url=${encodeURIComponent(currentUrl)}&geminiApiKey=${encodeURIComponent(savedGeminiKey)}`;
  vietsub.onclick = (e) => startDownload(e.target, vietsubUrl, data.title, data.thumbnail, 'Vietsub');
  vietsub.textContent = 'Tải + dịch Vietsub';
  grid.appendChild(vietsub);

  for (const format of data.formats || []) {
    const btn = document.createElement('button');
    btn.className = 'quality-btn';
    btn.type = 'button';
    const downloadUrl = `/api/download?url=${encodeURIComponent(currentUrl)}&format_id=${encodeURIComponent(format.format_id)}`;
    btn.onclick = (e) => startDownload(e.target, downloadUrl, data.title, data.thumbnail, format.quality);
    btn.textContent = `${format.quality} · ${format.size}`;
    grid.appendChild(btn);
  }

  $('video-card').classList.remove('hidden');
}

let downloadHistory = [];

function loadDownloadHistory() {
  try {
    const data = localStorage.getItem('downloadHistory');
    downloadHistory = data ? JSON.parse(data) : [];
  } catch (e) {
    console.error('Lỗi khi đọc lịch sử tải:', e);
    downloadHistory = [];
  }
  renderDownloadHistory();
}

function saveDownloadHistory() {
  localStorage.setItem('downloadHistory', JSON.stringify(downloadHistory));
}

function addDownloadHistory(title, thumbnail, status, filename, type) {
  const item = {
    id: Date.now().toString(),
    title: title || 'Không tên',
    thumbnail: thumbnail || '',
    url: currentUrl,
    timestamp: Date.now(),
    status: status,
    filename: filename || '',
    type: type || 'Gốc'
  };
  
  downloadHistory.unshift(item);
  if (downloadHistory.length > 50) {
    downloadHistory.pop();
  }
  
  saveDownloadHistory();
  renderDownloadHistory();
}

function deleteHistoryItem(id) {
  downloadHistory = downloadHistory.filter(item => item.id !== id);
  saveDownloadHistory();
  renderDownloadHistory();
}

function clearDownloadHistory() {
  downloadHistory = [];
  saveDownloadHistory();
  renderDownloadHistory();
}

function renderDownloadHistory() {
  const container = $('download-history-list');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (downloadHistory.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--muted); border: 2px dashed var(--border); border-radius: 8px; background: var(--panel-2); font-size: 12px;">
        📥 Chưa có lịch sử tải video nào.
      </div>
    `;
    return;
  }
  
  downloadHistory.forEach(item => {
    const d = new Date(item.timestamp);
    const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    
    const card = document.createElement('div');
    card.className = 'download-history-item';
    card.style = 'display: flex; align-items: center; justify-content: space-between; padding: 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; gap: 12px; transition: all 0.15s;';
    
    const badgeBg = item.status === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
    const badgeColor = item.status === 'success' ? '#10b981' : '#ef4444';
    const badgeText = item.status === 'success' ? 'Thành công' : 'Thất bại';
    
    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
        <img src="${item.thumbnail}" style="width: 50px; height: 50px; border-radius: 6px; object-fit: cover; background: #000;" onerror="this.style.display='none'">
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.title.replace(/"/g, '&quot;')}">${item.title}</div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 3px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
            <span>📅 ${dateStr}</span>
            <span>🔗 <a href="${item.url}" target="_blank" style="color: var(--accent); text-decoration: none;">Link nguồn</a></span>
            <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 2px 6px; font-size: 9px; font-weight: 600; border-radius: 4px;">
              ${badgeText}
            </span>
          </div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 11px; font-weight: 500; color: var(--muted); background: var(--border); padding: 4px 8px; border-radius: 4px;">${item.type}</span>
        <button type="button" class="rendered-card-btn rendered-btn-delete" style="padding: 6px 10px; margin: 0; font-size: 11px; height: auto;" onclick="deleteHistoryItem('${item.id}')">🗑️</button>
      </div>
    `;
    container.appendChild(card);
  });
}

async function startDownload(btn, url, videoTitle, thumbnail, type) {
  if (btn.disabled) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Đang tải...';

  try {
    const response = await fetch(url);
    if (!response.ok) {
      let errMsg = 'Không thể tải video';
      try {
        const errJson = await response.json();
        if (errJson && errJson.error) errMsg = errJson.error;
      } catch (e) {}
      throw new Error(errMsg);
    }

    let filename = 'video.mp4';
    const disposition = response.headers.get('content-disposition');
    if (disposition) {
      const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      if (matches && matches[1]) {
        filename = decodeURIComponent(matches[1].replace(/['"]/g, ''));
      }
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);

    toast(`🎉 Tải thành công: ${filename}`, 'success');
    addDownloadHistory(videoTitle, thumbnail, 'success', filename, type);
    await loadAssets();
  } catch (error) {
    toast(`❌ Lỗi: ${error.message}`, 'error');
    addDownloadHistory(videoTitle, thumbnail, 'failed', '', type);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function saveVoice(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const btn = event.submitter;
  setBusy(btn, true, 'Đang lưu...');
  try {
    const res = await fetch('/api/save-voice', { method: 'POST', body: new FormData(form) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không lưu được giọng');
    form.reset();
    toast(data.message || 'Đã lưu giọng', 'success');
    closeVoiceModal();
    await loadAssets();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function saveMusic(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const btn = event.submitter;
  setBusy(btn, true, 'Đang lưu...');
  try {
    const res = await fetch('/api/save-music', { method: 'POST', body: new FormData(form) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không lưu được nhạc');
    form.reset();
    toast(data.message || 'Đã lưu nhạc', 'success');
    closeMusicModal();
    await loadAssets();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function renderStudio(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const btn = $('render-btn');
  const status = $('render-status');
  const data = new FormData(form);

  if (!$('video-upload').files.length && !data.get('mainVideoFile')) {
    toast('Chọn video nguồn hoặc upload video mới.', 'error');
    return;
  }

  // Check if selected Whisper model is ready
  const subMode = data.get('subtitleMode');
  const whisperModel = data.get('whisperModel') || 'base';
  if (subMode === 'generate' && whisperModel !== 'base') {
    try {
      const checkRes = await fetch(`/api/whisper-model/status?model=${whisperModel}`);
      const checkStatus = await checkRes.json();
      if (!checkStatus.exists) {
        toast(`⚠️ Thiếu file Model Whisper ${whisperModel.toUpperCase()}. Vui lòng tải xuống!`, 'warn');
        openWhisperDownloadModal();
        return;
      }
    } catch (e) {
      console.error('Lỗi khi kiểm tra model Whisper trước khi render:', e);
    }
  }

  data.set('translateVi', $('translate-vi').checked ? 'true' : 'false');
  data.set('burnSub', $('burn-sub').checked ? 'true' : 'false');
  data.set('blurOriginalSub', $('blur-original-sub').checked ? 'true' : 'false');

  setBusy(btn, true, 'Đang render...');
  status.textContent = 'Đang xử lý. Video dài hoặc tạo sub Whisper sẽ mất thời gian.';
  
  // Hiển thị hiệu ứng Loading trực quan trên Tab kết quả
  const loadingHtml = `
    <div class="render-loading-state">
      <div class="loading-spinner"></div>
      <h3>Đang Render Video...</h3>
      <p>Hệ thống đang xử lý và trộn video. Tùy thuộc vào độ dài video và các thiết lập AI (Whisper, Omi Cloner), quá trình này có thể mất một vài phút. Vui lòng không tắt ứng dụng.</p>
    </div>
  `;
  const renderResultSidebar = $('render-result');
  if (renderResultSidebar) {
    renderResultSidebar.classList.remove('empty');
    renderResultSidebar.innerHTML = loadingHtml;
  }
  const studioResult = $('studio-render-result');
  if (studioResult) {
    studioResult.innerHTML = loadingHtml;
  }
  // Chuyển sang tab Xem trước ngay lập tức
  switchToResultTab();

  try {
    const res = await fetch('/api/render-studio', { method: 'POST', body: data });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Render lỗi');
    status.textContent = ''; // Bỏ chữ đang xử lý/hoàn tất trên nút
    const resultHtml = `
      <div class="video-preview-wrapper result-video-wrapper" style="margin-bottom: 10px;">
        <video controls src="${result.url}"></video>
      </div>
      <a class="premium-download-btn" href="${result.url}" download style="margin-bottom: 10px;">
        <span>📥</span> Tải video về máy
      </a>
      <button type="button" class="premium-render-btn" style="background: #1877F2; color: white;" onclick="openFbModal('${result.url}')">
        <svg viewBox="0 0 36 36" width="16" height="16" fill="currentColor" style="vertical-align: middle; margin-right: 5px; margin-top: -2px;">
          <path d="M15 35.8C6.5 34.3 0 26.9 0 18 0s18 8.1 18 18c0 8.9-6.5 16.3-15 17.8l-1-.8h-4l-1 .8z"></path><path fill="#fff" d="M21 18h-3v11h-4V18h-2v-3h2v-2c0-2.8 1.7-4 4.1-4 1.2 0 2.2.1 2.5.1v3h-1.7c-1.3 0-1.6.6-1.6 1.5v1.4h3.3L21 18z"></path>
        </svg>
        Đăng lên Fanpage
      </button>
    `;
    const renderResultSidebar_updated = $('render-result');
    if (renderResultSidebar_updated) {
      renderResultSidebar_updated.classList.remove('empty');
      renderResultSidebar_updated.innerHTML = resultHtml;
    }
    
    const studioResult_updated = $('studio-render-result');
    if (studioResult_updated) {
      studioResult_updated.innerHTML = resultHtml;
      
      // Clone safezone overlay to result wrapper
      const resultWrapper = studioResult_updated.querySelector('.result-video-wrapper');
      const resultVideo = resultWrapper ? resultWrapper.querySelector('video') : null;
      const previewOverlay = $('preview-safezone-overlay');
      if (resultWrapper && resultVideo && previewOverlay) {
        const resultOverlay = previewOverlay.cloneNode(true);
        resultOverlay.id = 'result-safezone-overlay';
        resultWrapper.appendChild(resultOverlay);
        
        // Apply initial active platform styling
        const select = $('safezone-platform-select');
        if (select) {
          resultOverlay.className = `preview-safezone-overlay result-safezone-overlay ${select.value}`;
          if (select.value !== 'none') {
            resultVideo.removeAttribute('controls');
          } else {
            resultVideo.setAttribute('controls', 'true');
          }
        }
        
        // Bind seeking/playback controls to result video
        if (typeof bindSafezoneControls === 'function') {
          bindSafezoneControls(resultVideo, resultOverlay);
        }
      }
    }

    // Copy safezone overlay to all result overlays and sync current platform selection
    const srcOverlay = $('preview-safezone-overlay');
    const platformSelect = $('safezone-platform-select');
    if (srcOverlay && platformSelect) {
      document.querySelectorAll('.result-safezone-overlay').forEach(destOverlay => {
        destOverlay.innerHTML = srcOverlay.innerHTML;
        destOverlay.className = `preview-safezone-overlay result-safezone-overlay ${platformSelect.value}`;
      });
    }
    toast('Render video thành công', 'success');
    switchToResultTab();
    await loadAssets();
  } catch (error) {
    status.textContent = '';
    toast(error.message, 'error');
    
    // Cập nhật giao diện lỗi
    const errorHtml = `
      <div class="render-loading-state" style="border-color: rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.05);">
        <div style="font-size: 40px; margin-bottom: 15px;">❌</div>
        <h3 style="color: #ef4444;">Render thất bại</h3>
        <p style="color: #fca5a5;">${error.message}</p>
      </div>
    `;
    if ($('render-result')) $('render-result').innerHTML = errorHtml;
    if ($('studio-render-result')) $('studio-render-result').innerHTML = errorHtml;
  } finally {
    setBusy(btn, false);
  }
}

async function fetchPlaylistInfo() {
  let url = $('bulk-url-input').value.trim();
  const match = url.match(/https?:\/\/[^\s]+/);
  if (match) {
    url = match[0];
    $('bulk-url-input').value = url;
  }
  const limit = Number($('bulk-limit').value || 10);
  if (!url) {
    toast('Nhập link kênh hoặc playlist.', 'error');
    return;
  }

  const btn = $('bulk-fetch-btn');
  const stats = $('bulk-stats');
  const list = $('bulk-list');
  setBusy(btn, true, 'Đang tải...');
  list.innerHTML = '';
  stats.textContent = 'Đang lấy danh sách video...';

  try {
    const res = await fetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, limit })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không lấy được playlist');

    let ok = 0;
    let fail = 0;
    for (const [index, video] of data.videos.entries()) {
      const li = document.createElement('li');
      li.textContent = `${index + 1}. ${video.title || video.id} - đang tải`;
      list.appendChild(li);
      try {
        const dl = await fetch('/api/download-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: video.url })
        });
        if (!dl.ok) throw new Error('download failed');
        li.textContent = `${index + 1}. ${video.title || video.id} - xong`;
        ok++;
      } catch (e) {
        li.textContent = `${index + 1}. ${video.title || video.id} - lỗi`;
        fail++;
      }
      stats.textContent = `Tiến trình ${index + 1}/${data.videos.length}. Thành công ${ok}, lỗi ${fail}.`;
    }
    await loadAssets();
  } catch (error) {
    toast(error.message, 'error');
    stats.textContent = 'Có lỗi khi tải hàng loạt.';
  } finally {
    setBusy(btn, false);
  }
}

function updateConditionalFields() {
  const subMode = $('subtitle-mode').value;
  $('sub-upload-wrapper').classList.toggle('hidden', subMode !== 'upload');
  $('sub-saved-wrapper').classList.toggle('hidden', subMode !== 'saved');
  
  const whisperModelWrapper = $('whisper-model-wrapper');
  if (whisperModelWrapper) {
    const isGenerate = (subMode === 'generate');
    whisperModelWrapper.classList.toggle('hidden', !isGenerate);
    if (isGenerate) {
      checkWhisperModelStatus();
    }
  }
  
  const subSettingsContainer = $('sub-settings-container');
  if (subSettingsContainer) {
    subSettingsContainer.classList.toggle('hidden', subMode === 'none');
  }

  const canvasWrapper = $('subtitle-canvas-wrapper');
  if (canvasWrapper) {
    canvasWrapper.classList.toggle('hidden', subMode === 'none');
  }

  const voiceMode = $('voice-mode').value;
  $('voice-saved-wrapper').classList.toggle('hidden', !['saved', 'omi'].includes(voiceMode));
  $('voice-upload-wrapper').classList.toggle('hidden', voiceMode !== 'upload');
  $('omi-cloner-container').classList.toggle('hidden', voiceMode !== 'omi');

  const musicMode = $('music-mode').value;
  $('music-saved-wrapper').classList.toggle('hidden', musicMode !== 'saved');
  $('music-upload-wrapper').classList.toggle('hidden', musicMode !== 'upload');

  const reactionMode = $('reaction-mode').value;
  $('reaction-library-container').classList.toggle('hidden', reactionMode !== 'library');
  $('reaction-upload-container').classList.toggle('hidden', reactionMode !== 'upload');
  $('reaction-settings-container').classList.toggle('hidden', !['library', 'upload'].includes(reactionMode));

  const voiceSlider = document.querySelector('input[name="voiceVolume"]');
  if (voiceSlider) {
    const isVoiceNone = (voiceMode === 'none');
    voiceSlider.disabled = isVoiceNone;
    const strip = voiceSlider.closest('.mixer-strip');
    if (strip) {
      strip.style.opacity = isVoiceNone ? '0.4' : '1';
      strip.style.pointerEvents = isVoiceNone ? 'none' : 'auto';
    }
  }

  const musicSlider = document.querySelector('input[name="musicVolume"]');
  if (musicSlider) {
    const isMusicNone = (musicMode === 'none');
    musicSlider.disabled = isMusicNone;
    const strip = musicSlider.closest('.mixer-strip');
    if (strip) {
      strip.style.opacity = isMusicNone ? '0.4' : '1';
      strip.style.pointerEvents = isMusicNone ? 'none' : 'auto';
    }
  }

  const originalSlider = document.querySelector('input[name="originalVolume"]');
  if (originalSlider) {
    const selectedVideo = $('selected-video-file') ? $('selected-video-file').value : '';
    const uploadedVideo = $('video-upload') ? $('video-upload').files.length : 0;
    const isOriginalNone = !selectedVideo && !uploadedVideo;
    originalSlider.disabled = isOriginalNone;
    const strip = originalSlider.closest('.mixer-strip');
    if (strip) {
      strip.style.opacity = isOriginalNone ? '0.4' : '1';
      strip.style.pointerEvents = isOriginalNone ? 'none' : 'auto';
    }
  }

  const blurCheck = $('blur-original-sub');
  const blurSettings = $('blur-settings-container');
  if (blurCheck && blurSettings) {
    blurSettings.classList.toggle('hidden', !blurCheck.checked);
  }
  if (typeof updateBlurBoxPreview === 'function') {
    updateBlurBoxPreview();
  }
}

function renderVideoGrid(videos) {
  const grid = $('studio-video-grid');
  if (!grid) return;
  grid.innerHTML = '';
  
  if (!videos.length) {
    grid.innerHTML = '<div class="no-videos">Chưa có video nào được tải về. Hãy qua tab Tải video trước.</div>';
    return;
  }
  
  const selectedFileVal = $('selected-video-file').value;
  
  for (const item of videos) {
    const card = document.createElement('div');
    card.className = 'video-card-item';
    if (selectedFileVal === item.filename) {
      card.classList.add('selected');
    }
    card.dataset.filename = item.filename;
    
    const videoUrl = `/downloads/${encodeURIComponent(item.filename)}`;
    
    card.innerHTML = `
      <div class="video-card-thumb">
        <video src="${videoUrl}" preload="metadata" muted playsinline></video>
        <div class="video-card-play-icon">▶</div>
        <div class="video-card-duration">--:--</div>
      </div>
      <div class="video-card-info">
        <div class="video-card-name" title="${item.filename}">${item.filename}</div>
        <div class="video-card-meta">${(item.size / (1024 * 1024)).toFixed(1)} MB</div>
      </div>
    `;
    
    const videoEl = card.querySelector('video');
    
    videoEl.addEventListener('loadedmetadata', () => {
      const durationEl = card.querySelector('.video-card-duration');
      if (durationEl) {
        durationEl.textContent = formatDuration(videoEl.duration);
      }
    });

    card.addEventListener('mouseenter', () => {
      videoEl.play().catch(() => {});
    });
    
    card.addEventListener('mouseleave', () => {
      videoEl.pause();
      videoEl.currentTime = 0;
    });
    
    card.addEventListener('click', () => {
      document.querySelectorAll('#studio-video-grid .video-card-item').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      $('selected-video-file').value = item.filename;
      setPreviewVideo(videoUrl);
      if (typeof switchToPreviewTab === 'function') switchToPreviewTab();
      updateConditionalFields();
    });
    
    grid.appendChild(card);
  }
}

function renderReactionVideoGrid(videos) {
  const grid = $('studio-reaction-video-grid');
  if (!grid) return;
  grid.innerHTML = '';
  
  if (!videos.length) {
    grid.innerHTML = '<div class="no-videos">Chưa có video nào được tải về. Hãy qua tab Tải video trước.</div>';
    return;
  }
  
  const selectedFileVal = $('selected-reaction-video-file').value;
  
  for (const item of videos) {
    const card = document.createElement('div');
    card.className = 'video-card-item';
    if (selectedFileVal === item.filename) {
      card.classList.add('selected');
    }
    card.dataset.filename = item.filename;
    
    const videoUrl = `/downloads/${encodeURIComponent(item.filename)}`;
    
    card.innerHTML = `
      <div class="video-card-thumb">
        <video src="${videoUrl}" preload="metadata" muted playsinline></video>
        <div class="video-card-play-icon">▶</div>
        <div class="video-card-duration">--:--</div>
      </div>
      <div class="video-card-info">
        <div class="video-card-name" title="${item.filename}">${item.filename}</div>
        <div class="video-card-meta">${(item.size / (1024 * 1024)).toFixed(1)} MB</div>
      </div>
    `;
    
    const videoEl = card.querySelector('video');
    
    videoEl.addEventListener('loadedmetadata', () => {
      const durationEl = card.querySelector('.video-card-duration');
      if (durationEl) {
        durationEl.textContent = formatDuration(videoEl.duration);
      }
    });

    card.addEventListener('mouseenter', () => {
      videoEl.play().catch(() => {});
    });
    
    card.addEventListener('mouseleave', () => {
      videoEl.pause();
      videoEl.currentTime = 0;
    });
    
    card.addEventListener('click', () => {
      document.querySelectorAll('#studio-reaction-video-grid .video-card-item').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      $('selected-reaction-video-file').value = item.filename;
      setPreviewReactionVideo(videoUrl);
    });
    
    grid.appendChild(card);
  }
}

function setPreviewReactionVideo(url) {
  const video = $('preview-reaction-video');
  const pipEl = $('preview-reaction-pip');
  if (url) {
    video.src = url;
    video.muted = !$('reaction-audio').checked;
    video.play().catch(() => {});
    const placeholder = pipEl.querySelector('.reaction-placeholder-box');
    if (placeholder) placeholder.classList.add('hidden');
    setTimeout(updateReactionPreview, 100);
  } else {
    video.pause();
    video.src = '';
    video.removeAttribute('src');
    const placeholder = pipEl.querySelector('.reaction-placeholder-box');
    if (placeholder) placeholder.classList.remove('hidden');
    updateReactionPreview();
  }
}

// Preview Video management for draggable subtitle positioner
function setPreviewVideo(url) {
  const video = $('studio-video-preview');
  const wrapper = $('video-preview-wrapper');
  const placeholder = $('preview-placeholder');
  
  if (url) {
    video.src = url;
    if (wrapper) wrapper.classList.remove('hidden');
    if (placeholder) placeholder.classList.add('hidden');
    video.onloadeddata = () => {
      // Re-trigger layout alignment calculation
      updateSubtitleOverlayFromInputs();
      if (typeof updateBlurBoxPreview === 'function') {
        updateBlurBoxPreview();
      }
    };
  } else {
    video.pause();
    video.src = '';
    video.removeAttribute('src');
    if (wrapper) wrapper.classList.add('hidden');
    if (placeholder) placeholder.classList.remove('hidden');
    
    // Clean up reaction preview
    const rxVid = $('preview-reaction-video');
    if (rxVid) {
      rxVid.pause();
      rxVid.src = '';
      rxVid.removeAttribute('src');
    }
    const rxPip = $('preview-reaction-pip');
    if (rxPip) rxPip.classList.add('hidden');
  }
  if (typeof updateBlurBoxPreview === 'function') {
    updateBlurBoxPreview();
  }
}

function getVideoContentRect(video) {
  const videoRect = video.getBoundingClientRect();
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  
  if (!videoWidth || !videoHeight) {
    return videoRect;
  }
  
  const videoRatio = videoWidth / videoHeight;
  const containerRatio = videoRect.width / videoRect.height;
  
  let actualWidth, actualHeight, actualLeft, actualTop;
  
  if (videoRatio > containerRatio) {
    actualWidth = videoRect.width;
    actualHeight = actualWidth / videoRatio;
    actualLeft = videoRect.left;
    actualTop = videoRect.top + (videoRect.height - actualHeight) / 2;
  } else {
    actualHeight = videoRect.height;
    actualWidth = actualHeight * videoRatio;
    actualLeft = videoRect.left + (videoRect.width - actualWidth) / 2;
    actualTop = videoRect.top;
  }
  
  return {
    left: actualLeft,
    top: actualTop,
    width: actualWidth,
    height: actualHeight,
    right: actualLeft + actualWidth,
    bottom: actualTop + actualHeight
  };
}

function updateInputsFromSubtitlePosition() {
  const dragEl = $('draggable-subtitle');
  const video = $('studio-video-preview');
  
  if (!dragEl || !video) return;
  
  const W_act = video.videoWidth || 1080;
  const H_act = video.videoHeight || 1920;
  
  // Position is in canvas coordinates because offsetParent is #subtitle-canvas-wrapper
  const left = dragEl.offsetLeft;
  const top = dragEl.offsetTop;
  const dragWidth = dragEl.offsetWidth;
  const dragHeight = dragEl.offsetHeight;
  
  // 1. Determine quadrants based on canvas coordinates
  const centerPercent = (left + dragWidth / 2) / W_act;
  const topPercent = top / H_act;
  
  let verticalSec = 'bottom';
  if (topPercent < 0.35) {
    verticalSec = 'top';
  } else if (topPercent > 0.65) {
    verticalSec = 'bottom';
  } else {
    verticalSec = 'middle';
  }
  
  let horizontalSec = 'center';
  if (centerPercent < 0.35) {
    horizontalSec = 'left';
  } else if (centerPercent > 0.65) {
    horizontalSec = 'right';
  } else {
    horizontalSec = 'center';
  }
  
  // 2. Select alignment
  let alignment = 2;
  if (verticalSec === 'bottom') {
    if (horizontalSec === 'left') alignment = 1;
    else if (horizontalSec === 'right') alignment = 3;
    else alignment = 2;
  } else if (verticalSec === 'top') {
    if (horizontalSec === 'left') alignment = 5;
    else if (horizontalSec === 'right') alignment = 7;
    else alignment = 6;
  } else {
    if (horizontalSec === 'left') alignment = 9;
    else if (horizontalSec === 'right') alignment = 11;
    else alignment = 10;
  }
  
  const alignmentInput = document.querySelector('[name="subtitleAlignment"]');
  if (alignmentInput) {
    alignmentInput.value = alignment;
  }
  const alignGrid = $('alignment-visual-grid');
  if (alignGrid) {
    alignGrid.querySelectorAll('.grid-cell').forEach(cell => {
      cell.classList.toggle('active', Number(cell.dataset.align) === alignment);
    });
  }
  
  // 3. Compute vertical margin based on quadrant (Top vs Bottom) in canvas coordinates
  let MarginV_act = 0;
  if (verticalSec === 'top') {
    MarginV_act = Math.round(top);
  } else {
    MarginV_act = Math.round(H_act - (top + dragHeight));
  }
  
  // Compute horizontal margin in canvas coordinates
  const marginL_act = left;
  const marginR_act = W_act - (left + dragWidth);
  const MarginH_act = Math.round(Math.min(marginL_act, marginR_act));
  
  document.querySelector('input[name="subtitleMargin"]').value = Math.max(0, MarginV_act);
  document.querySelector('input[name="subtitleMarginH"]').value = Math.max(0, MarginH_act);
}

function wrapTextToTwoLines(text, maxCharsPerLine = 22) {
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }

  const words = cleanText.split(' ');
  const midPoint = Math.floor(cleanText.length / 2);
  let bestIndex = -1;
  let minDiff = Infinity;
  
  let currentPos = 0;
  for (let i = 0; i < words.length - 1; i++) {
    currentPos += words[i].length + 1;
    const diff = Math.abs(currentPos - midPoint);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }

  if (bestIndex !== -1) {
    const line1 = words.slice(0, bestIndex + 1).join(' ');
    const line2 = words.slice(bestIndex + 1).join(' ');
    return `${line1}\n${line2}`;
  }

  return cleanText;
}

function wrapTextToThreeLines(text, maxCharsPerLine = 22) {
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }
  if (cleanText.length <= maxCharsPerLine * 1.6) {
    return wrapTextToTwoLines(cleanText, maxCharsPerLine);
  }
  
  const words = cleanText.split(' ');
  if (words.length <= 2) {
    return words.join('\n');
  }
  
  const totalLen = cleanText.length;
  
  let bestI = -1;
  let bestJ = -1;
  let minVariance = Infinity;
  
  let posI = 0;
  for (let i = 0; i < words.length - 2; i++) {
    posI += words[i].length + 1;
    
    let posJ = posI;
    for (let j = i + 1; j < words.length - 1; j++) {
      posJ += words[j].length + 1;
      
      const len1 = posI - 1;
      const len2 = posJ - posI - 1;
      const len3 = totalLen - posJ;
      
      const mean = totalLen / 3;
      const variance = Math.pow(len1 - mean, 2) + Math.pow(len2 - mean, 2) + Math.pow(len3 - mean, 2);
      
      if (variance < minVariance) {
        minVariance = variance;
        bestI = i;
        bestJ = j;
      }
    }
  }
  
  if (bestI !== -1 && bestJ !== -1) {
    const line1 = words.slice(0, bestI + 1).join(' ');
    const line2 = words.slice(bestI + 1, bestJ + 1).join(' ');
    const line3 = words.slice(bestJ + 1).join(' ');
    return `${line1}\n${line2}\n${line3}`;
  }
  
  return cleanText;
}

function updateSubtitleOverlayFromInputs() {
  const dragEl = $('draggable-subtitle');
  const video = $('studio-video-preview');
  const canvasWrapper = $('subtitle-canvas-wrapper');
  
  if (!dragEl || !video || !canvasWrapper) return;
  
  const textContentEl = $('subtitle-text-content');
  if (textContentEl) {
    if (!textContentEl.dataset.rawText) {
      textContentEl.dataset.rawText = textContentEl.innerText.trim();
    }
    
    if (textContentEl.contentEditable !== 'true') {
      dragEl.style.whiteSpace = 'pre';
      const fontSizeInput = Number(document.querySelector('input[name="subtitleSize"]').value || 18);
      const marginHInput = Number(document.querySelector('input[name="subtitleMarginH"]').value || 20);
      const maxLines = Number(document.querySelector('[name="subtitleMaxLines"]').value || 0);
      
      const W_act = video.videoWidth || 1080;
      const boxWidth = W_act - 2 * marginHInput;
      const maxChars = Math.max(10, Math.floor(boxWidth / (fontSizeInput * 0.5)));
      
      const rawText = textContentEl.dataset.rawText;
      let wrappedText = rawText;
      
      if (maxLines === 1) {
        wrappedText = rawText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
      } else if (maxLines === 2) {
        wrappedText = wrapTextToTwoLines(rawText, maxChars);
      } else if (maxLines === 3) {
        wrappedText = wrapTextToThreeLines(rawText, maxChars);
      } else { // maxLines === 0 (Tự động)
        const clean = rawText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (clean.length <= maxChars) {
          wrappedText = clean;
        } else if (clean.length <= maxChars * 1.6) {
          wrappedText = wrapTextToTwoLines(clean, maxChars);
        } else {
          wrappedText = wrapTextToThreeLines(clean, maxChars);
        }
      }
      
      textContentEl.innerText = wrappedText;
    } else {
      dragEl.style.whiteSpace = 'pre-wrap';
    }
  }
  
  const containerRect = video.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) return;
  
  const videoRect = getVideoContentRect(video);
  
  const W_act = video.videoWidth || 1080;
  const H_act = video.videoHeight || 1920;
  
  const font_scale = videoRect.height / H_act;
  
  // Align and scale the canvas wrapper exactly to match the displayed video content
  canvasWrapper.style.left = (videoRect.left - containerRect.left) + 'px';
  canvasWrapper.style.top = (videoRect.top - containerRect.top) + 'px';
  canvasWrapper.style.width = W_act + 'px';
  canvasWrapper.style.height = H_act + 'px';
  canvasWrapper.style.transform = `scale(${font_scale})`;
  
  const fontSizeInput = Number(document.querySelector('input[name="subtitleSize"]').value || 18);
  const marginVInput = Number(document.querySelector('input[name="subtitleMargin"]').value || 28);
  const marginHInput = Number(document.querySelector('input[name="subtitleMarginH"]').value || 20);
  const alignment = Number(document.querySelector('[name="subtitleAlignment"]').value || 2);
  
  dragEl.style.width = (W_act - 2 * marginHInput) + 'px';
  
  // Reconcile size with output video using same 1.35 scaleFactor from server.js.
  const scaleFactor = 1.35;
  const fontSize_canvas = fontSizeInput * scaleFactor;
  dragEl.style.fontSize = fontSize_canvas + 'px';
  
  // Clean up debug box if it exists
  const debugBox = $('debug-log-box');
  if (debugBox) {
    debugBox.remove();
  }
  
  // Force the dashed dragging boundary border to visually be 1.2px on screen
  dragEl.style.borderWidth = `${1.2 / font_scale}px`;

  // Apply visual styling dynamically from input controls
  const fontNameInput = document.querySelector('select[name="subtitleFont"]').value || 'Arial';
  const colorInput = document.querySelector('[name="subtitleColor"]').value || '#FFFFFF';
  const themeInput = document.querySelector('select[name="subtitleTheme"]').value || 'outline';
  const boldInput = document.querySelector('select[name="subtitleBold"]').value === 'true';

  dragEl.style.fontFamily = fontNameInput;
  dragEl.style.fontWeight = boldInput ? 'bold' : 'normal';
  
  // Apply visual themes in canvas coordinate space, so they scale down proportionally
  if (themeInput === 'box') {
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
    dragEl.style.textShadow = 'none';
    dragEl.style.webkitTextStroke = '0px';
    const paddingCanvas = 4.0 * scaleFactor; // Matches outline padding in server.js
    dragEl.style.padding = `${paddingCanvas}px ${paddingCanvas * 1.5}px`;
    dragEl.style.borderRadius = `${4 * scaleFactor}px`;
  } else if (themeInput === 'box-deep') {
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'rgba(0, 0, 0, 0.95)';
    dragEl.style.textShadow = 'none';
    dragEl.style.webkitTextStroke = '0px';
    const paddingCanvas = 4.0 * scaleFactor; // Matches outline padding in server.js
    dragEl.style.padding = `${paddingCanvas}px ${paddingCanvas * 1.5}px`;
    dragEl.style.borderRadius = `${4 * scaleFactor}px`;
  } else if (themeInput === 'shadow') {
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'transparent';
    dragEl.style.webkitTextStroke = '0px';
    const shadowSize = 2 * scaleFactor;
    dragEl.style.textShadow = `${shadowSize}px ${shadowSize}px ${shadowSize * 2}px rgba(0, 0, 0, 0.8)`;
    dragEl.style.padding = '0';
    dragEl.style.borderRadius = '0';
  } else if (themeInput === 'outline-thick') {
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'transparent';
    const strokeWidth = 5.0 * scaleFactor;
    dragEl.style.webkitTextStroke = `${strokeWidth}px black`;
    dragEl.style.textShadow = 'none';
    dragEl.style.padding = '0';
    dragEl.style.borderRadius = '0';
  } else if (themeInput === 'outline-shadow') {
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'transparent';
    const strokeWidth = 2.5 * scaleFactor;
    const shadowSize = 3 * scaleFactor;
    dragEl.style.webkitTextStroke = `${strokeWidth}px black`;
    dragEl.style.textShadow = `${shadowSize}px ${shadowSize}px ${shadowSize * 1.3}px rgba(0, 0, 0, 0.8)`;
    dragEl.style.padding = '0';
    dragEl.style.borderRadius = '0';
  } else { // 'outline'
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'transparent';
    const strokeWidth = 2.5 * scaleFactor;
    const shadowSize = 1 * scaleFactor;
    dragEl.style.webkitTextStroke = `${strokeWidth}px black`;
    dragEl.style.textShadow = `${shadowSize}px ${shadowSize}px ${shadowSize * 2}px rgba(0, 0, 0, 0.8)`;
    dragEl.style.padding = '0';
    dragEl.style.borderRadius = '0';
  }
  
  // Offset dimensions in canvas coordinates
  const dragWidth = dragEl.offsetWidth;
  const dragHeight = dragEl.offsetHeight;
  
  let left = 0;
  let top = 0;
  
  if ([5, 6, 7].includes(alignment)) {
    top = marginVInput;
  } else if ([9, 10, 11].includes(alignment)) {
    top = (H_act - dragHeight) / 2;
  } else {
    top = H_act - dragHeight - marginVInput;
  }
  
  if ([1, 5, 9].includes(alignment)) {
    left = marginHInput;
  } else if ([3, 7, 11].includes(alignment)) {
    left = W_act - dragWidth - marginHInput;
  } else {
    left = (W_act - dragWidth) / 2;
  }
  
  // Constrain dragging to actual video bounds (canvas coordinates)
  left = Math.max(0, Math.min(left, W_act - dragWidth));
  top = Math.max(0, Math.min(top, H_act - dragHeight));
  
  dragEl.style.left = left + 'px';
  dragEl.style.top = top + 'px';
  
  // Cập nhật vị trí hiển thị preview của video reaction/mặt
  updateReactionPreview();
}

function updateReactionPreview() {
  const pipEl = $('preview-reaction-pip');
  const mainVideo = $('studio-video-preview');
  const reactionVid = $('preview-reaction-video');
  
  if (!pipEl || !mainVideo) return;
  
  const reactionMode = $('reaction-mode').value;
  if (!['upload', 'library'].includes(reactionMode) || !mainVideo.src) {
    pipEl.classList.add('hidden');
    if (reactionVid) {
      reactionVid.pause();
    }
    return;
  }
  
  pipEl.classList.remove('hidden');
  
  const containerRect = mainVideo.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) return;
  
  const videoRect = getVideoContentRect(mainVideo);
  
  const W_act = mainVideo.videoWidth || 1080;
  const H_act = mainVideo.videoHeight || 1920;
  
  const widthInput = Number(document.querySelector('input[name="reactionWidth"]').value || 320);
  
  const scale = videoRect.width / W_act;
  const pipWidthDisp = widthInput * scale;
  
  let ratio = 3 / 4; // Aspect ratio góc mặt chân dung mặc định
  if (reactionVid && reactionVid.videoWidth && reactionVid.videoHeight) {
    ratio = reactionVid.videoHeight / reactionVid.videoWidth;
  }
  const pipHeightDisp = pipWidthDisp * ratio;
  
  let left = 0;
  let top = 0;
  
  // Check if we have custom geometry values stored
  const rx = $('reaction-x').value;
  const ry = $('reaction-y').value;
  
  if (rx !== '' && ry !== '' && pipEl.dataset.customGeometry === 'true') {
    left = (videoRect.left - containerRect.left) + Number(rx) * scale;
    top = (videoRect.top - containerRect.top) + Number(ry) * scale;
    
    // Constraint to video content bounds
    const minLeft = videoRect.left - containerRect.left;
    const maxLeft = videoRect.right - containerRect.left - pipWidthDisp;
    const minTop = videoRect.top - containerRect.top;
    const maxTop = videoRect.bottom - containerRect.top - pipHeightDisp;
    
    left = Math.max(minLeft, Math.min(left, maxLeft));
    top = Math.max(minTop, Math.min(top, maxTop));
  } else {
    const position = document.querySelector('select[name="reactionPosition"]').value || 'bottom-right';
    const marginDisp = 20 * scale;
    
    if (position === 'bottom-right') {
      left = (videoRect.right - containerRect.left) - pipWidthDisp - marginDisp;
      top = (videoRect.bottom - containerRect.top) - pipHeightDisp - marginDisp;
    } else if (position === 'bottom-left') {
      left = (videoRect.left - containerRect.left) + marginDisp;
      top = (videoRect.bottom - containerRect.top) - pipHeightDisp - marginDisp;
    } else if (position === 'top-right') {
      left = (videoRect.right - containerRect.left) - pipWidthDisp - marginDisp;
      top = (videoRect.top - containerRect.top) + marginDisp;
    } else if (position === 'top-left') {
      left = (videoRect.left - containerRect.left) + marginDisp;
      top = (videoRect.top - containerRect.top) + marginDisp;
    }
  }
  
  pipEl.style.width = Math.max(20, pipWidthDisp) + 'px';
  pipEl.style.height = Math.max(15, pipHeightDisp) + 'px';
  pipEl.style.left = left + 'px';
  pipEl.style.top = top + 'px';
}

function initDraggableSubtitle() {
  const dragEl = $('draggable-subtitle');
  const wrapper = $('video-preview-wrapper');
  const handleEl = $('subtitle-resizer-handle');
  const textContentEl = $('subtitle-text-content');
  
  if (!dragEl || !wrapper) return;
  
  let isDragging = false;
  let isResizing = false;
  let startX, startY;
  let initialLeft, initialTop;
  let initialWidth, initialHeight, initialFontSize;
  
  dragEl.addEventListener('mousedown', startDrag);
  dragEl.addEventListener('touchstart', startDrag, { passive: true });
  
  if (textContentEl) {
    textContentEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (!textContentEl.dataset.rawText) {
        textContentEl.dataset.rawText = textContentEl.innerText.trim();
      }
      textContentEl.innerText = textContentEl.dataset.rawText;
      
      textContentEl.contentEditable = 'true';
      textContentEl.focus();
      dragEl.classList.add('editing');
      
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(textContentEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    
    textContentEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        textContentEl.blur();
      }
    });
    
    textContentEl.addEventListener('blur', () => {
      textContentEl.contentEditable = 'false';
      dragEl.classList.remove('editing');
      textContentEl.dataset.rawText = textContentEl.innerText.trim();
      updateSubtitleOverlayFromInputs();
    });
  }
  
  function startDrag(e) {
    if (e.target === handleEl || (textContentEl && textContentEl.contentEditable === 'true')) return;
    isDragging = true;
    dragEl.classList.add('dragging');
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    
    startX = clientX;
    startY = clientY;
    
    initialLeft = dragEl.offsetLeft;
    initialTop = dragEl.offsetTop;
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('touchmove', drag, { passive: false });
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);
  }
  
  function drag(e) {
    if (!isDragging) return;
    if (e.type === 'touchmove') e.preventDefault();
    
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    
    const dx = clientX - startX;
    const dy = clientY - startY;
    
    const video = $('studio-video-preview');
    const videoRect = getVideoContentRect(video);
    
    const W_act = video.videoWidth || 1080;
    const H_act = video.videoHeight || 1920;
    const font_scale = videoRect.height / H_act;
    
    // Scale delta mouse movements to canvas coordinate space
    const dx_canvas = dx / font_scale;
    const dy_canvas = dy / font_scale;
    
    let newLeft = initialLeft + dx_canvas;
    let newTop = initialTop + dy_canvas;
    
    const dragWidth = dragEl.offsetWidth;
    const dragHeight = dragEl.offsetHeight;
    
    newLeft = Math.max(0, Math.min(newLeft, W_act - dragWidth));
    newTop = Math.max(0, Math.min(newTop, H_act - dragHeight));
    
    dragEl.style.left = newLeft + 'px';
    dragEl.style.top = newTop + 'px';
    
    updateInputsFromSubtitlePosition();
  }
  
  function stopDrag() {
    isDragging = false;
    dragEl.classList.remove('dragging');
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('touchmove', drag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchend', stopDrag);
  }
  
  if (handleEl) {
    handleEl.addEventListener('mousedown', startResize);
    handleEl.addEventListener('touchstart', startResize, { passive: false });
  }
  
  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    dragEl.classList.add('resizing');
    
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    
    startX = clientX;
    startY = clientY;
    
    initialWidth = dragEl.offsetWidth;
    initialHeight = dragEl.offsetHeight;
    
    const fontSizeInput = document.querySelector('input[name="subtitleSize"]');
    initialFontSize = fontSizeInput ? (parseInt(fontSizeInput.value) || 18) : 18;
    
    document.addEventListener('mousemove', resize);
    document.addEventListener('touchmove', resize, { passive: false });
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('touchend', stopResize);
  }
  
  function resize(e) {
    if (!isResizing) return;
    e.preventDefault();
    
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    
    const dx = clientX - startX;
    const dy = clientY - startY;
    
    const video = $('studio-video-preview');
    const videoRect = getVideoContentRect(video);
    
    const W_act = video.videoWidth || 1080;
    const H_act = video.videoHeight || 1920;
    const font_scale = videoRect.height / H_act;
    
    const dx_canvas = dx / font_scale;
    const dy_canvas = dy / font_scale;
    
    const newWidth = Math.max(100, initialWidth + dx_canvas);
    const newHeight = Math.max(20, initialHeight + dy_canvas);
    
    // 1. Update margin H based on new width (centered wrapper width constraint)
    let newMarginH = Math.round((W_act - newWidth) / 2);
    newMarginH = Math.max(10, Math.min(newMarginH, Math.floor(W_act / 2) - 50));
    
    // 2. Update line count based on vertical height
    const fontSizeInput = document.querySelector('input[name="subtitleSize"]');
    const fontSizeVal = fontSizeInput ? (parseInt(fontSizeInput.value) || 18) : 18;
    const scaleFactor = 1.35;
    const fontSize_canvas = fontSizeVal * scaleFactor;
    const lineHeight = fontSize_canvas * 1.3;
    
    let detectedLines = Math.max(1, Math.round(newHeight / lineHeight));
    detectedLines = Math.min(3, detectedLines); // Cap at 3 lines max
    
    const maxLinesSelect = document.querySelector('[name="subtitleMaxLines"]');
    if (maxLinesSelect && Number(maxLinesSelect.value) !== detectedLines) {
      maxLinesSelect.value = detectedLines;
      maxLinesSelect.dispatchEvent(new Event('change'));
    }
    
    const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
    if (marginHInput) marginHInput.value = newMarginH;
    
    updateSubtitleOverlayFromInputs();
    
    // Explicitly set temporary height on dragEl during active resize so it visually stretches
    dragEl.style.height = newHeight + 'px';
  }
  
  function stopResize() {
    isResizing = false;
    dragEl.classList.remove('resizing');
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('touchmove', resize);
    document.removeEventListener('mouseup', stopResize);
    document.removeEventListener('touchend', stopResize);
    
    // Remove temporary height style so it snaps to text wrapped height
    dragEl.style.height = '';
    updateSubtitleOverlayFromInputs();
  }
}

function updateBlurBoxPreview() {
  const blurBox = $('preview-blur-box');
  const video = $('studio-video-preview');
  const wrapper = $('video-preview-wrapper');
  const blurCheck = $('blur-original-sub');
  
  if (!blurBox || !video || !wrapper || !blurCheck) return;
  
  // Hide blur box if option is not checked, preview is hidden, or no video is loaded
  if (!blurCheck.checked || wrapper.classList.contains('hidden') || !video.src || video.src === '' || !video.videoWidth || !video.videoHeight) {
    blurBox.classList.add('hidden');
    return;
  }
  
  const containerRect = wrapper.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) {
    blurBox.classList.add('hidden');
    return;
  }
  
  const videoRect = getVideoContentRect(video);
  
  const blurXInput = $('blur-x-input');
  const blurWidthInput = $('blur-width-input');
  const blurYInput = $('blur-y-input');
  const blurHeightInput = $('blur-height-input');
  
  if (!blurXInput || !blurWidthInput || !blurYInput || !blurHeightInput) return;
  
  let blurX = parseFloat(blurXInput.value);
  if (isNaN(blurX)) blurX = 10;
  let blurWidth = parseFloat(blurWidthInput.value);
  if (isNaN(blurWidth)) blurWidth = 80;
  let blurY = parseFloat(blurYInput.value);
  if (isNaN(blurY)) blurY = 75;
  let blurHeight = parseFloat(blurHeightInput.value);
  if (isNaN(blurHeight)) blurHeight = 15;
  
  // Keep boundaries sanitized:
  if (blurX < 0) blurX = 0;
  if (blurX > 100) blurX = 100;
  if (blurWidth < 1) blurWidth = 1;
  if (blurWidth > 100) blurWidth = 100;
  if (blurX + blurWidth > 100) {
    blurX = 100 - blurWidth;
  }
  
  if (blurY < 0) blurY = 0;
  if (blurY > 100) blurY = 100;
  if (blurHeight < 1) blurHeight = 1;
  if (blurHeight > 100) blurHeight = 100;
  if (blurY + blurHeight > 100) {
    blurY = 100 - blurHeight;
  }
  
  // Show blur box
  blurBox.classList.remove('hidden');
  
  // Calculate relative top, left, width, height inside container wrapper
  const leftRel = videoRect.left - containerRect.left;
  const topRel = videoRect.top - containerRect.top;
  
  const boxWidth = videoRect.width * (blurWidth / 100);
  const boxLeft = leftRel + videoRect.width * (blurX / 100);
  const boxTop = topRel + videoRect.height * (blurY / 100);
  const boxHeight = videoRect.height * (blurHeight / 100);
  
  blurBox.style.left = `${boxLeft}px`;
  blurBox.style.width = `${boxWidth}px`;
  blurBox.style.top = `${boxTop}px`;
  blurBox.style.height = `${boxHeight}px`;

  const blurRadiusSlider = $('blur-radius-slider');
  let radius = 20;
  if (blurRadiusSlider) {
    radius = parseFloat(blurRadiusSlider.value) || 20;
  }
  const cssRadius = Math.max(1, radius * 0.5);
  blurBox.style.backdropFilter = `blur(${cssRadius}px)`;
  blurBox.style.webkitBackdropFilter = `blur(${cssRadius}px)`;
}

function initDraggableBlurBox() {
  const blurBox = $('preview-blur-box');
  const handleEl = $('blur-resizer-handle');
  const mainVideo = $('studio-video-preview');
  const wrapper = $('video-preview-wrapper');
  
  if (!blurBox || !handleEl || !mainVideo || !wrapper) return;
  
  let isDragging = false;
  let isResizing = false;
  
  let startX, startY;
  let initialLeft, initialTop, initialWidth, initialHeight;
  
  // Dragging blurBox body
  blurBox.addEventListener('mousedown', (e) => {
    if (e.target === handleEl) return;
    startDrag(e);
  });
  blurBox.addEventListener('touchstart', (e) => {
    if (e.target === handleEl) return;
    startDrag(e);
  }, { passive: false });
  
  // Resizing blurBox via handle
  handleEl.addEventListener('mousedown', startResize);
  handleEl.addEventListener('touchstart', startResize, { passive: false });
  
  function startDrag(e) {
    e.preventDefault();
    isDragging = true;
    blurBox.classList.add('dragging');
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    
    startX = clientX;
    startY = clientY;
    initialLeft = blurBox.offsetLeft;
    initialTop = blurBox.offsetTop;
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('touchmove', drag, { passive: false });
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);
  }
  
  function drag(e) {
    if (!isDragging) return;
    e.preventDefault();
    
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;
    
    let newLeft = initialLeft + dx;
    let newTop = initialTop + dy;
    
    const containerRect = wrapper.getBoundingClientRect();
    const videoRect = getVideoContentRect(mainVideo);
    
    const minLeft = videoRect.left - containerRect.left;
    const maxLeft = videoRect.right - containerRect.left - blurBox.offsetWidth;
    const minTop = videoRect.top - containerRect.top;
    const maxTop = videoRect.bottom - containerRect.top - blurBox.offsetHeight;
    
    newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));
    newTop = Math.max(minTop, Math.min(newTop, maxTop));
    
    // Update input values
    const leftInVideo = newLeft - minLeft;
    const blurX = Math.round((leftInVideo / videoRect.width) * 100);
    
    const topInVideo = newTop - minTop;
    const blurY = Math.round((topInVideo / videoRect.height) * 100);
    
    const blurXInput = $('blur-x-input');
    if (blurXInput) {
      blurXInput.value = blurX;
    }
    
    const blurYInput = $('blur-y-input');
    if (blurYInput) {
      blurYInput.value = blurY;
    }
    
    updateBlurBoxPreview();
  }
  
  function stopDrag() {
    isDragging = false;
    blurBox.classList.remove('dragging');
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('touchmove', drag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchend', stopDrag);
  }
  
  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    blurBox.classList.add('resizing');
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    
    startX = clientX;
    startY = clientY;
    initialWidth = blurBox.offsetWidth;
    initialHeight = blurBox.offsetHeight;
    
    document.addEventListener('mousemove', resize);
    document.addEventListener('touchmove', resize, { passive: false });
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('touchend', stopResize);
  }
  
  function resize(e) {
    if (!isResizing) return;
    e.preventDefault();
    
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;
    
    let newWidth = initialWidth + dx;
    let newHeight = initialHeight + dy;
    
    const containerRect = wrapper.getBoundingClientRect();
    const videoRect = getVideoContentRect(mainVideo);
    
    const spaceRight = (videoRect.right - containerRect.left) - blurBox.offsetLeft;
    const spaceBottom = (videoRect.bottom - containerRect.top) - blurBox.offsetTop;
    
    newWidth = Math.max(10, Math.min(newWidth, spaceRight));
    newHeight = Math.max(10, Math.min(newHeight, spaceBottom));
    
    // Update input values
    const blurWidth = Math.round((newWidth / videoRect.width) * 100);
    const blurHeight = Math.round((newHeight / videoRect.height) * 100);
    
    const blurWidthInput = $('blur-width-input');
    if (blurWidthInput) {
      blurWidthInput.value = blurWidth;
    }
    
    const blurHeightInput = $('blur-height-input');
    if (blurHeightInput) {
      blurHeightInput.value = blurHeight;
    }
    
    updateBlurBoxPreview();
  }
  
  function stopResize() {
    isResizing = false;
    blurBox.classList.remove('resizing');
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('touchmove', resize);
    document.removeEventListener('mouseup', stopResize);
    document.removeEventListener('touchend', stopResize);
  }
  
  // Register manual inputs change listeners
  const blurXInput = $('blur-x-input');
  const blurWidthInput = $('blur-width-input');
  const blurYInput = $('blur-y-input');
  const blurHeightInput = $('blur-height-input');
  
  if (blurXInput) {
    blurXInput.addEventListener('input', updateBlurBoxPreview);
    blurXInput.addEventListener('change', updateBlurBoxPreview);
  }
  if (blurWidthInput) {
    blurWidthInput.addEventListener('input', updateBlurBoxPreview);
    blurWidthInput.addEventListener('change', updateBlurBoxPreview);
  }
  if (blurYInput) {
    blurYInput.addEventListener('input', updateBlurBoxPreview);
    blurYInput.addEventListener('change', updateBlurBoxPreview);
  }
  if (blurHeightInput) {
    blurHeightInput.addEventListener('input', updateBlurBoxPreview);
    blurHeightInput.addEventListener('change', updateBlurBoxPreview);
  }
}

// Setup source video tabs
document.querySelectorAll('.source-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.source-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.sourceMode;
    
    $('source-library-container').classList.toggle('hidden', mode !== 'library');
    $('source-upload-container').classList.toggle('hidden', mode !== 'upload');
    
    if (mode === 'upload') {
      $('selected-video-file').value = '';
      document.querySelectorAll('#studio-video-grid .video-card-item').forEach(card => card.classList.remove('selected'));
      setPreviewVideo(null);
    } else {
      $('video-upload').value = '';
      $('upload-video-preview').removeAttribute('src');
      $('upload-video-preview-container').classList.add('hidden');
      setPreviewVideo(null);
    }
    updateConditionalFields();
  });
});

// Setup reaction video tabs
document.querySelectorAll('.reaction-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.reaction-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.reactionTabMode;
    
    $('reaction-mode').value = mode;
    
    if (mode === 'upload') {
      $('selected-reaction-video-file').value = '';
      document.querySelectorAll('#studio-reaction-video-grid .video-card-item').forEach(card => card.classList.remove('selected'));
      setPreviewReactionVideo(null);
    } else if (mode === 'library') {
      $('reaction-upload').value = '';
      setPreviewReactionVideo(null);
    } else {
      $('selected-reaction-video-file').value = '';
      document.querySelectorAll('#studio-reaction-video-grid .video-card-item').forEach(card => card.classList.remove('selected'));
      $('reaction-upload').value = '';
      setPreviewReactionVideo(null);
    }
    
    updateConditionalFields();
  });
});

// Local video upload preview handler
$('video-upload').addEventListener('change', function() {
  const container = $('upload-video-preview-container');
  const video = $('upload-video-preview');
  const nameEl = $('upload-video-name');
  const sizeEl = $('upload-video-size');
  
  if (this.files && this.files[0]) {
    const file = this.files[0];
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    nameEl.textContent = file.name;
    sizeEl.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    container.classList.remove('hidden');
    setPreviewVideo(objectUrl);
  } else {
    video.removeAttribute('src');
    container.classList.add('hidden');
    setPreviewVideo(null);
  }
  updateConditionalFields();
});

$('fetch-btn').addEventListener('click', fetchVideoInfo);
$('url-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fetchVideoInfo();
});
$('refresh-assets-btn').addEventListener('click', loadAssets);
$('open-folder-btn').addEventListener('click', () => fetch('/api/open-folder'));
$('save-voice-form').addEventListener('submit', saveVoice);
$('save-music-form').addEventListener('submit', saveMusic);
$('studio-form').addEventListener('submit', renderStudio);
$('bulk-fetch-btn').addEventListener('click', fetchPlaylistInfo);
['subtitle-mode', 'voice-mode', 'music-mode', 'reaction-mode', 'blur-original-sub'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', updateConditionalFields);
});

function formatTime(secs) {
  if (isNaN(secs)) return '00:00';
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function bindSafezoneControls(video, container) {
  if (!video || !container) return;

  // 1. Sync progress timeline fill, current duration time label, and play/pause icon states
  video.addEventListener('timeupdate', () => {
    const duration = video.duration || 0;
    const current = video.currentTime || 0;
    const percent = duration > 0 ? (current / duration) * 100 : 0;

    // Timeline fills
    container.querySelectorAll('.safezone-timeline-progress').forEach(progress => {
      progress.style.width = `${percent}%`;
    });

    // Xiaohongshu time display label
    container.querySelectorAll('.safezone-time-display').forEach(display => {
      display.textContent = `${formatTime(current)}/${formatTime(duration)}`;
    });

    // Play/Pause icon updates
    container.querySelectorAll('.xhs-playpause-icon').forEach(icon => {
      icon.textContent = video.paused ? '▶' : '⏸';
    });
    container.querySelectorAll('.fb-playpause-icon').forEach(icon => {
      icon.textContent = video.paused ? '▶' : '⏸';
    });
  });

  // 2. Click controls: play/pause, volume mute
  container.addEventListener('click', (e) => {
    const playPauseBtn = e.target.closest('.safezone-action-playpause');
    if (playPauseBtn) {
      e.stopPropagation();
      if (video.paused) {
        video.play().catch(err => console.log("Play interrupted:", err));
      } else {
        video.pause();
      }
      return;
    }

    const muteBtn = e.target.closest('.safezone-action-mute');
    if (muteBtn) {
      e.stopPropagation();
      video.muted = !video.muted;
      container.querySelectorAll('.safezone-action-mute').forEach(btn => {
        btn.textContent = video.muted ? '🔇' : '🔊';
      });
      return;
    }
  });

  // 3. Timeline Seeking / Scrubbing (click & drag to tua)
  const handleTimelineInteraction = (e, timelineContainer) => {
    const rect = timelineContainer.getBoundingClientRect();
    let clientX = e.clientX;
    if (e.touches && e.touches[0]) {
      clientX = e.touches[0].clientX;
    }
    const clickX = clientX - rect.left;
    const percent = Math.max(0, Math.min(1, clickX / rect.width));
    if (video.duration) {
      video.currentTime = percent * video.duration;
    }
  };

  container.addEventListener('mousedown', (e) => {
    const timeline = e.target.closest('.safezone-timeline-container');
    if (timeline) {
      e.stopPropagation();
      e.preventDefault();
      handleTimelineInteraction(e, timeline);

      const onMouseMove = (moveEvent) => {
        handleTimelineInteraction(moveEvent, timeline);
      };
      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }
  });

  container.addEventListener('touchstart', (e) => {
    const timeline = e.target.closest('.safezone-timeline-container');
    if (timeline) {
      e.stopPropagation();
      handleTimelineInteraction(e, timeline);

      const onTouchMove = (moveEvent) => {
        handleTimelineInteraction(moveEvent, timeline);
      };
      const onTouchEnd = () => {
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
      };
      document.addEventListener('touchmove', onTouchMove, { passive: true });
      document.addEventListener('touchend', onTouchEnd);
    }
  }, { passive: true });
}

// Bind dropdown selection behavior
const safezoneSelect = $('safezone-platform-select');
if (safezoneSelect) {
  safezoneSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    const previewOverlay = $('preview-safezone-overlay');
    if (previewOverlay) {
      previewOverlay.className = `preview-safezone-overlay ${val}`;
    }
    document.querySelectorAll('.result-safezone-overlay').forEach(el => {
      el.className = `preview-safezone-overlay result-safezone-overlay ${val}`;
    });
    document.querySelectorAll('.result-video-wrapper video').forEach(v => {
      if (val !== 'none') {
        v.removeAttribute('controls');
      } else {
        v.setAttribute('controls', 'true');
      }
    });
  });
}

// Bind preview video elements on startup
const mainVideo = $('studio-video-preview');
const previewOverlay = $('preview-safezone-overlay');
if (mainVideo && previewOverlay) {
  bindSafezoneControls(mainVideo, previewOverlay);
}

// Register two-way binding inputs
const subtitleInputs = [
  'subtitleSize', 'subtitleMargin', 'subtitleMarginH',
  'subtitleAlignment', 'subtitleFont', 'subtitleTheme',
  'subtitleColor', 'subtitleBold', 'subtitleMaxLines', 'reactionPosition', 'reactionWidth'
];
subtitleInputs.forEach(name => {
  const el = document.querySelector(`[name="${name}"]`);
  if (el) {
    el.addEventListener('input', updateSubtitleOverlayFromInputs);
    el.addEventListener('change', updateSubtitleOverlayFromInputs);
  }
});

// Interactive Alignment Grid Clicks
const alignmentGrid = $('alignment-visual-grid');
if (alignmentGrid) {
  alignmentGrid.querySelectorAll('.grid-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      alignmentGrid.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('active'));
      cell.classList.add('active');
      const val = cell.dataset.align;
      const input = $('subtitle-alignment-input');
      if (input) {
        input.value = val;
        // Dispatch event manually
        input.dispatchEvent(new Event('change'));
      }
    });
  });
}

// Interactive Color Swatches Clicks
const colorSwatches = $('color-swatches-container');
if (colorSwatches) {
  colorSwatches.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      colorSwatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      const color = swatch.dataset.color;
      const input = $('subtitle-color-input');
      if (input) {
        input.value = color;
        // Dispatch event manually
        input.dispatchEvent(new Event('change'));
      }
    });
  });
}

// Interactive Subtitle Presets Clicks
const presetGrid = $('subtitle-presets-grid');
if (presetGrid) {
  const presets = {
    classic: { color: '#FFFFFF', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    tiktok: { color: '#FFEB3B', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    netflix: { color: '#FFFFFF', theme: 'box', font: 'Arial', bold: 'false', size: 18 },
    cyber: { color: '#00E5FF', theme: 'outline-shadow', font: 'Trebuchet MS', bold: 'true', size: 28 }
  };
  
  presetGrid.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', () => {
      presetGrid.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      
      const config = presets[card.dataset.preset];
      if (config) {
        const fontSelect = document.querySelector('select[name="subtitleFont"]');
        if (fontSelect) fontSelect.value = config.font;
        
        const sizeInput = document.querySelector('input[name="subtitleSize"]');
        if (sizeInput) sizeInput.value = config.size;
        
        const themeSelect = document.querySelector('select[name="subtitleTheme"]');
        if (themeSelect) themeSelect.value = config.theme;
        
        const boldSelect = document.querySelector('select[name="subtitleBold"]');
        if (boldSelect) boldSelect.value = config.bold;
        
        const colorInput = $('subtitle-color-input');
        if (colorInput) colorInput.value = config.color;
        
        const swatches = $('color-swatches-container');
        if (swatches) {
          swatches.querySelectorAll('.color-swatch').forEach(s => {
            s.classList.toggle('active', s.dataset.color.toLowerCase() === config.color.toLowerCase());
          });
        }
        
        updateSubtitleOverlayFromInputs();
      }
    });
  });
}

// Register volume slider listeners with live percentage labels
const volumeInputs = ['originalVolume', 'voiceVolume', 'musicVolume'];
volumeInputs.forEach(name => {
  const el = document.querySelector(`[name="${name}"]`);
  if (el) {
    const spanId = name.replace(/([A-Z])/g, "-$1").toLowerCase() + "-val";
    const valSpan = $(spanId);
    const updateLabel = () => {
      if (valSpan) {
        valSpan.textContent = Math.round(Number(el.value) * 100) + '%';
      }
    };
    el.addEventListener('input', updateLabel);
    el.addEventListener('change', updateLabel);
    // Initialize
    updateLabel();
  }
});

$('reaction-upload').addEventListener('change', function() {
  if (this.files && this.files[0]) {
    const objectUrl = URL.createObjectURL(this.files[0]);
    setPreviewReactionVideo(objectUrl);
  } else {
    setPreviewReactionVideo(null);
  }
});

// Sync checkbox state changes with preview video muted state
$('reaction-audio').addEventListener('change', function() {
  const video = $('preview-reaction-video');
  if (video) {
    video.muted = !this.checked;
  }
});

// Live updating width slider badge
const rwInput = document.querySelector('input[name="reactionWidth"]');
if (rwInput) {
  const valSpan = $('reaction-width-val');
  const updateLabel = () => {
    if (valSpan) valSpan.textContent = rwInput.value + 'px';
  };
  rwInput.addEventListener('input', updateLabel);
  rwInput.addEventListener('change', updateLabel);
  updateLabel();
}

window.addEventListener('resize', () => {
  updateSubtitleOverlayFromInputs();
  if (typeof updateBlurBoxPreview === 'function') {
    updateBlurBoxPreview();
  }
});

function updateInputsFromReactionGeometry() {
  const pipEl = $('preview-reaction-pip');
  const mainVideo = $('studio-video-preview');
  
  if (!pipEl || !mainVideo || pipEl.classList.contains('hidden')) return;
  
  const containerRect = mainVideo.getBoundingClientRect();
  const videoRect = getVideoContentRect(mainVideo);
  
  const W_act = mainVideo.videoWidth || 1080;
  const H_act = mainVideo.videoHeight || 1920;
  
  // Calculate visual offsets relative to the video content bounds
  const x_disp = pipEl.offsetLeft - (videoRect.left - containerRect.left);
  const y_disp = pipEl.offsetTop - (videoRect.top - containerRect.top);
  const w_disp = pipEl.offsetWidth;
  
  const scale = videoRect.width / W_act;
  
  const rx = Math.round(x_disp / scale);
  const ry = Math.round(y_disp / scale);
  const rw = Math.round(w_disp / scale);
  
  $('reaction-x').value = rx;
  $('reaction-y').value = ry;
  
  const widthInput = document.querySelector('input[name="reactionWidth"]');
  if (widthInput) {
    widthInput.value = Math.max(100, Math.min(640, rw));
    const valSpan = $('reaction-width-val');
    if (valSpan) {
      valSpan.textContent = widthInput.value + 'px';
    }
  }
  
  pipEl.dataset.customGeometry = 'true';
  
  // Synchronize dropdown menu with the manual dragging state
  const posSelect = document.querySelector('select[name="reactionPosition"]');
  if (posSelect) {
    posSelect.value = 'custom';
  }
}

function initDraggableReaction() {
  const pipEl = $('preview-reaction-pip');
  const handleEl = $('reaction-resizer-handle');
  const mainVideo = $('studio-video-preview');
  
  if (!pipEl || !handleEl || !mainVideo) return;
  
  let isDragging = false;
  let isResizing = false;
  let startX, startY;
  let initialLeft, initialTop, initialWidth;
  let ratio = 3 / 4;
  
  // Dragging PIP body
  pipEl.addEventListener('mousedown', (e) => {
    if (e.target === handleEl) return;
    startDrag(e);
  });
  pipEl.addEventListener('touchstart', (e) => {
    if (e.target === handleEl) return;
    startDrag(e);
  }, { passive: false });
  
  // Resizing PIP via handle
  handleEl.addEventListener('mousedown', startResize);
  handleEl.addEventListener('touchstart', startResize, { passive: false });
  
  function startDrag(e) {
    e.preventDefault();
    isDragging = true;
    pipEl.classList.add('dragging');
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    
    startX = clientX;
    startY = clientY;
    
    initialLeft = pipEl.offsetLeft;
    initialTop = pipEl.offsetTop;
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('touchmove', drag, { passive: false });
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);
  }
  
  function drag(e) {
    if (!isDragging) return;
    e.preventDefault();
    
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    
    const dx = clientX - startX;
    const dy = clientY - startY;
    
    let newLeft = initialLeft + dx;
    let newTop = initialTop + dy;
    
    const containerRect = mainVideo.getBoundingClientRect();
    const videoRect = getVideoContentRect(mainVideo);
    
    const pipWidth = pipEl.offsetWidth;
    const pipHeight = pipEl.offsetHeight;
    
    const minLeft = videoRect.left - containerRect.left;
    const maxLeft = videoRect.right - containerRect.left - pipWidth;
    const minTop = videoRect.top - containerRect.top;
    const maxTop = videoRect.bottom - containerRect.top - pipHeight;
    
    newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));
    newTop = Math.max(minTop, Math.min(newTop, maxTop));
    
    pipEl.style.left = newLeft + 'px';
    pipEl.style.top = newTop + 'px';
    
    updateInputsFromReactionGeometry();
  }
  
  function stopDrag() {
    isDragging = false;
    pipEl.classList.remove('dragging');
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('touchmove', drag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchend', stopDrag);
  }
  
  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    pipEl.classList.add('resizing');
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    
    startX = clientX;
    initialWidth = pipEl.offsetWidth;
    
    const reactionVid = $('preview-reaction-video');
    if (reactionVid && reactionVid.videoWidth && reactionVid.videoHeight) {
      ratio = reactionVid.videoHeight / reactionVid.videoWidth;
    } else {
      ratio = 3 / 4;
    }
    
    document.addEventListener('mousemove', resize);
    document.addEventListener('touchmove', resize, { passive: false });
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('touchend', stopResize);
  }
  
  function resize(e) {
    if (!isResizing) return;
    e.preventDefault();
    
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const dx = clientX - startX;
    
    let newWidth = initialWidth + dx;
    
    const videoRect = getVideoContentRect(mainVideo);
    const W_act = mainVideo.videoWidth || 1280;
    const scale = videoRect.width / W_act;
    
    // Bounds check on source width limits [100, 640]
    const minWDisp = 100 * scale;
    const maxWDisp = 640 * scale;
    newWidth = Math.max(minWDisp, Math.min(newWidth, maxWDisp));
    
    // Constraints on edges of the video preview content area
    const containerRect = mainVideo.getBoundingClientRect();
    const spaceRight = (videoRect.right - containerRect.left) - pipEl.offsetLeft;
    const spaceBottom = (videoRect.bottom - containerRect.top) - pipEl.offsetTop;
    
    const maxWByEdge = spaceRight;
    const maxWByHeight = spaceBottom / ratio;
    const maxWAllowed = Math.min(maxWByEdge, maxWByHeight);
    
    newWidth = Math.min(newWidth, maxWAllowed);
    const newHeight = newWidth * ratio;
    
    pipEl.style.width = newWidth + 'px';
    pipEl.style.height = newHeight + 'px';
    
    updateInputsFromReactionGeometry();
  }
  
  function stopResize() {
    isResizing = false;
    pipEl.classList.remove('resizing');
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('touchmove', resize);
    document.removeEventListener('mouseup', stopResize);
    document.removeEventListener('touchend', stopResize);
  }
  
  // Register reset event on select element
  const posSelect = document.querySelector('select[name="reactionPosition"]');
  if (posSelect) {
    posSelect.addEventListener('change', () => {
      $('reaction-x').value = '';
      $('reaction-y').value = '';
      delete pipEl.dataset.customGeometry;
      updateReactionPreview();
    });
  }
}

initDraggableSubtitle();
initDraggableReaction();
initDraggableBlurBox();

// Setup voice mode tabs
document.querySelectorAll('.voice-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.voiceMode;
    if (mode === 'omi' && !assets.omiConfigured) {
      toast('⚠️ Thiếu file Model AI để chạy Omi Cloner. Vui lòng tải xuống!', 'warn');
      openModelDownloadModal();
      return;
    }
    document.querySelectorAll('.voice-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const input = $('voice-mode');
    if (input) {
      input.value = mode;
      input.dispatchEvent(new Event('change'));
    }
  });
});

// Setup sub mode tabs
document.querySelectorAll('.sub-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const input = $('subtitle-mode');
    if (input) {
      input.value = btn.dataset.subMode;
      input.dispatchEvent(new Event('change'));
    }
  });
});

// Setup whisper model change handler
const whisperModelSelect = $('whisper-model-select');
if (whisperModelSelect) {
  whisperModelSelect.addEventListener('change', checkWhisperModelStatus);
}

// Setup music mode tabs
document.querySelectorAll('.music-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.music-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const input = $('music-mode');
    if (input) {
      input.value = btn.dataset.musicMode;
      input.dispatchEvent(new Event('change'));
    }
  });
});
// Live updating Omi Steps badge
const stepsSlider = document.getElementById('omi-steps-slider');
if (stepsSlider) {
  const stepsBadge = document.getElementById('omi-steps-badge');
  const updateSteps = () => {
    if (stepsBadge) stepsBadge.textContent = stepsSlider.value;
  };
  stepsSlider.addEventListener('input', updateSteps);
  stepsSlider.addEventListener('change', updateSteps);
  updateSteps();
}

// Live updating Blur Radius badge
const blurRadiusSlider = document.getElementById('blur-radius-slider');
if (blurRadiusSlider) {
  const blurRadiusVal = document.getElementById('blur-radius-val');
  const updateBlurRadius = () => {
    if (blurRadiusVal) blurRadiusVal.textContent = blurRadiusSlider.value;
    if (typeof updateBlurBoxPreview === 'function') {
      updateBlurBoxPreview();
    }
  };
  blurRadiusSlider.addEventListener('input', updateBlurRadius);
  blurRadiusSlider.addEventListener('change', updateBlurRadius);
  updateBlurRadius();
}

// Link Omi Cloner Seed Presets dropdown to hidden numeric input
const seedPreset = $('omi-seed-preset');
const seedInput = $('omi-seed-input');
const customSeedWrapper = $('omi-custom-seed-wrapper');
if (seedPreset && seedInput && customSeedWrapper) {
  seedPreset.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'custom') {
      customSeedWrapper.classList.remove('hidden');
      seedInput.value = '';
      seedInput.focus();
    } else {
      customSeedWrapper.classList.add('hidden');
      seedInput.value = val;
    }
  });
  // Trigger initial state
  seedInput.value = seedPreset.value;
}

// Restore and save Gemini API Key
const savedGeminiKey = localStorage.getItem('geminiApiKey');
if (savedGeminiKey && $('gemini-api-key')) {
  $('gemini-api-key').value = savedGeminiKey;
}
if ($('gemini-api-key')) {
  $('gemini-api-key').addEventListener('input', (e) => {
    localStorage.setItem('geminiApiKey', e.target.value.trim());
  });
}

loadAssets().then(updateConditionalFields).catch(() => toast('Không đọc được thư viện local.', 'error'));

// Init Collapsible Panels
document.querySelectorAll('.studio-config-column .panel-head').forEach(head => {
  head.style.cursor = 'pointer';
  head.title = 'Click để thu gọn/mở rộng';
  
  const rightSpan = head.querySelector('span');
  if (rightSpan) {
    rightSpan.style.display = 'flex';
    rightSpan.style.alignItems = 'center';
    
    const icon = document.createElement('span');
    icon.className = 'collapse-icon';
    icon.innerHTML = '▼';
    rightSpan.appendChild(icon);
  }
  
  head.addEventListener('click', () => {
    const panel = head.closest('.panel');
    if (panel) panel.classList.toggle('collapsed');
  });
});

function openFbModal(url) {
  const modal = document.getElementById('fb-modal');
  if (modal) {
    modal.classList.remove('hidden');
    document.getElementById('fb-video-url').value = url;

    // Reset ẩn/hiện các trường thủ công
    const manualFields = document.getElementById('fb-manual-fields');
    if (manualFields) {
      manualFields.classList.add('hidden'); // Ẩn mặc định
    }

    // Tải động danh sách Page vào select dropdown
    const select = document.getElementById('fb-page-select');
    if (select) {
      select.innerHTML = '';
      loadFbPages(); // Đọc danh sách Page mới nhất
      
      if (fbPages.length === 0) {
        select.innerHTML = '<option value="manual">Chưa có Page nào được lưu (Nhập thủ công)</option>';
        if (manualFields) {
          manualFields.classList.remove('hidden'); // Hiện nếu chưa lưu Page nào
        }
      } else {
        let optionsHtml = '<option value="" disabled selected>-- Chọn Page đã lưu --</option>';
        fbPages.forEach((page, idx) => {
          optionsHtml += `<option value="${idx}">${page.name} (${page.id})</option>`;
        });
        optionsHtml += '<option value="manual">Nhập thủ công / Tùy chỉnh...</option>';
        select.innerHTML = optionsHtml;
      }
    }
  }
}

function closeFbModal() {
  const modal = document.getElementById('fb-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function publishToFacebook() {
  const videoUrl = document.getElementById('fb-video-url').value;
  const pageId = document.getElementById('fb-page-id').value.trim();
  const pageToken = document.getElementById('fb-page-token').value.trim();
  const description = document.getElementById('fb-description').value.trim();
  const comment = document.getElementById('fb-comment').value.trim();

  if (!videoUrl) {
    toast('Không tìm thấy đường dẫn video', 'error');
    return;
  }

  if (!pageId || !pageToken) {
    toast('Vui lòng nhập đủ Page ID và Page Token!', 'error');
    return;
  }

  const btn = document.getElementById('fb-publish-btn');
  setBusy(btn, true, 'Đang tải lên Facebook...');

  try {
    const videoFilename = videoUrl.split('/').pop();

    const res = await fetch('/api/publish-facebook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: videoFilename,
        description,
        comment,
        pageId,
        pageToken
      })
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Lỗi khi đăng lên Facebook');

    if (result.warning) {
      toast('⚠️ ' + result.warning, 'warning');
    } else {
      toast('🎉 Đăng video & bình luận thành công!', 'success');
    }
    closeFbModal();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

// ==========================================
// QUẢN LÝ DANH SÁCH FANPAGE FACEBOOK
// ==========================================
let fbPages = [];

function loadFbPages() {
  try {
    const data = localStorage.getItem('fbPages');
    fbPages = data ? JSON.parse(data) : [];
  } catch (e) {
    console.error('Lỗi khi đọc danh sách Page:', e);
    fbPages = [];
  }
  return fbPages;
}

function saveFbPagesToStorage() {
  localStorage.setItem('fbPages', JSON.stringify(fbPages));
}

let currentPage = 1;
const pagesPerPage = 12;

let currentVideoPage = 1;
const videosPerPage = 24;

let currentVoicePage = 1;
const voicesPerPage = 12;

let currentMusicPage = 1;
const musicPerPage = 12;

function renderFbPages(filter = '') {
  const container = $('page-list-container');
  const tbody = $('page-list-tbody');
  const countBadge = $('page-count-badge');
  const paginationContainer = $('page-pagination');
  if (!container || !tbody) return;

  tbody.innerHTML = '';
  const searchVal = filter.toLowerCase().trim();
  const filtered = fbPages.filter(p => 
    p.name.toLowerCase().includes(searchVal) || 
    p.id.includes(searchVal)
  );

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Page`;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / pagesPerPage));
  if (currentPage > totalPages) {
    currentPage = totalPages;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--muted); padding: 36px 16px; font-size: 13px; border-bottom: none;">
          ${searchVal ? 'Không tìm thấy Page nào phù hợp.' : 'Chưa có Page nào được lưu.'}
        </td>
      </tr>
    `;
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  // Phân trang bằng slice
  const startIndex = (currentPage - 1) * pagesPerPage;
  const pageItems = filtered.slice(startIndex, startIndex + pagesPerPage);

  pageItems.forEach((page) => {
    // Tìm index tuyệt đối trong mảng gốc fbPages
    const originalIdx = fbPages.findIndex(p => p.id === page.id);
    
    // Mask token để hiển thị an toàn
    const maskedToken = page.token.length > 10 
      ? page.token.substring(0, 6) + '...' + page.token.substring(page.token.length - 4)
      : '...';

    const tr = document.createElement('tr');
    tr.style = 'border-bottom: 1px solid var(--border); transition: background 0.15s ease;';
    
    // Thêm hiệu ứng hover dòng
    tr.onmouseover = function() { this.style.background = 'rgba(255, 255, 255, 0.02)'; };
    tr.onmouseout = function() { this.style.background = 'transparent'; };

    tr.innerHTML = `
      <td style="padding: 12px 8px; font-weight: 600; color: var(--text); font-size: 13px; max-width: 200px; word-break: break-all;">${page.name}</td>
      <td style="padding: 12px 8px; color: var(--muted); font-size: 13px; font-family: monospace;">${page.id}</td>
      <td style="padding: 12px 8px; color: var(--soft); font-size: 13px; font-family: monospace; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${page.token}">${maskedToken}</td>
      <td style="padding: 12px 8px; text-align: right;">
        <div style="display: inline-flex; gap: 6px; flex-shrink: 0;">
          <button type="button" class="ghost-btn" style="padding: 4px 8px; font-size: 11px; height: auto;" onclick="editFbPage(${originalIdx})">✏️ Sửa</button>
          <button type="button" class="ghost-btn" style="padding: 4px 8px; font-size: 11px; height: auto; border-color: var(--danger); color: var(--danger);" onclick="deleteFbPage(${originalIdx})">🗑️ Xóa</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Vẽ các nút điều khiển phân trang
  if (paginationContainer) {
    paginationContainer.innerHTML = '';
    
    if (totalPages > 1) {
      // Nút Trước (Prev)
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'ghost-btn';
      prevBtn.style = 'padding: 6px 12px; font-size: 12px; height: auto; margin: 0;';
      prevBtn.innerHTML = '◀';
      prevBtn.disabled = currentPage === 1;
      prevBtn.onclick = () => {
        currentPage--;
        renderFbPages(filter);
      };
      paginationContainer.appendChild(prevBtn);

      // Các nút số trang
      for (let i = 1; i <= totalPages; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.type = 'button';
        pageBtn.className = i === currentPage ? 'primary-btn' : 'ghost-btn';
        pageBtn.style = `padding: 6px 12px; font-size: 12px; height: auto; margin: 0; ${i === currentPage ? 'background: var(--accent); color: white;' : ''}`;
        pageBtn.textContent = i;
        pageBtn.onclick = () => {
          currentPage = i;
          renderFbPages(filter);
        };
        paginationContainer.appendChild(pageBtn);
      }

      // Nút Sau (Next)
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'ghost-btn';
      nextBtn.style = 'padding: 6px 12px; font-size: 12px; height: auto; margin: 0;';
      nextBtn.innerHTML = '▶';
      nextBtn.disabled = currentPage === totalPages;
      nextBtn.onclick = () => {
        currentPage++;
        renderFbPages(filter);
      };
      paginationContainer.appendChild(nextBtn);
    }
  }
}

function openPageModal() {
  const modal = $('page-modal');
  if (modal) {
    // Reset form trước khi mở để tránh lưu lại vết chỉnh sửa cũ
    $('page-input-name').value = '';
    $('page-input-id').value = '';
    $('page-input-token').value = '';
    $('edit-page-index').value = '-1';
    $('page-form-title').textContent = 'Thêm Page mới';
    $('save-page-btn').textContent = 'Thêm Page';
    $('cancel-edit-btn').classList.add('hidden');
    
    modal.classList.remove('hidden');
  }
}

function closePageModal() {
  const modal = $('page-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function saveFbPage() {
  const nameInput = $('page-input-name');
  const idInput = $('page-input-id');
  const tokenInput = $('page-input-token');
  const editIndexInput = $('edit-page-index');
  const saveBtn = $('save-page-btn');

  if (!nameInput || !idInput || !tokenInput) return;

  const name = nameInput.value.trim();
  const id = idInput.value.trim();
  const token = tokenInput.value.trim();
  const editIndex = parseInt(editIndexInput.value);

  if (!name || !id || !token) {
    toast('Vui lòng điền đầy đủ thông tin!', 'error');
    return;
  }

  // Kiểm tra trùng ID (ngoại trừ Page đang sửa)
  const duplicateIdx = fbPages.findIndex(p => p.id === id);
  if (duplicateIdx !== -1 && duplicateIdx !== editIndex) {
    toast('Page ID này đã tồn tại trong danh sách!', 'error');
    return;
  }

  // Khóa nút bấm và hiển thị trạng thái đang xác thực
  setBusy(saveBtn, true, 'Đang xác thực...');

  try {
    const res = await fetch('/api/verify-facebook-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: id, pageToken: token })
    });
    
    // Tránh lỗi phân tích cú pháp HTML thành JSON (Unexpected token '<')
    const contentType = res.headers.get('content-type');
    let result;
    if (contentType && contentType.includes('application/json')) {
      result = await res.json();
    } else {
      throw new Error('Máy chủ chưa nhận diện được API mới. Vui lòng tắt phần mềm và khởi động lại (restart electron-dev) để tải lại backend!');
    }

    if (!res.ok) {
      throw new Error(result.error || 'Lỗi kết nối Graph API');
    }

    if (editIndex >= 0 && editIndex < fbPages.length) {
      // Cập nhật
      fbPages[editIndex] = { name, id, token };
      toast(`🎉 Đã cập nhật thành công Page: ${result.name}!`, 'success');
    } else {
      // Thêm mới
      fbPages.push({ name, id, token });
      toast(`🎉 Đã thêm thành công Page: ${result.name}!`, 'success');
    }

    saveFbPagesToStorage();
    closePageModal();
    renderFbPages($('page-search-input')?.value || '');
  } catch (error) {
    toast('❌ Xác thực thất bại: ' + error.message, 'error');
  } finally {
    setBusy(saveBtn, false);
  }
}

function editFbPage(index) {
  if (index < 0 || index >= fbPages.length) return;
  const page = fbPages[index];

  $('page-input-name').value = page.name;
  $('page-input-id').value = page.id;
  $('page-input-token').value = page.token;
  $('edit-page-index').value = index;

  $('page-form-title').textContent = 'Cập nhật Page';
  $('save-page-btn').textContent = 'Cập nhật';
  $('cancel-edit-btn').classList.remove('hidden');

  // Mở modal
  const modal = $('page-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function cancelEditPage() {
  $('page-input-name').value = '';
  $('page-input-id').value = '';
  $('page-input-token').value = '';
  $('edit-page-index').value = '-1';

  $('page-form-title').textContent = 'Thêm Page mới';
  $('save-page-btn').textContent = 'Thêm Page';
  $('cancel-edit-btn').classList.add('hidden');

  closePageModal();
}

let pageIndexToDelete = -1;

function deleteFbPage(index) {
  if (index < 0 || index >= fbPages.length) return;
  const page = fbPages[index];
  pageIndexToDelete = index;

  const msgEl = $('delete-confirm-message');
  if (msgEl) {
    msgEl.innerHTML = `Bạn có chắc chắn muốn xóa Page <strong>"${page.name}"</strong> (ID: ${page.id}) khỏi danh sách không?<br><span style="color: var(--danger); font-size: 12px; margin-top: 6px; display: inline-block;">⚠️ Hành động này không thể hoàn tác!</span>`;
  }

  const modal = $('delete-confirm-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeDeleteModal() {
  const modal = $('delete-confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
  pageIndexToDelete = -1;
}

function executeDeletePage() {
  if (pageIndexToDelete < 0 || pageIndexToDelete >= fbPages.length) return;

  fbPages.splice(pageIndexToDelete, 1);
  saveFbPagesToStorage();
  renderFbPages($('page-search-input')?.value || '');
  toast('Đã xóa Page khỏi danh sách!', 'success');

  // Nếu đang sửa đúng Page vừa xóa thì reset form
  if (parseInt($('edit-page-index').value) === pageIndexToDelete) {
    cancelEditPage();
  }

  closeDeleteModal();
}

function togglePageTokenInputVisibility() {
  const tokenInput = $('page-input-token');
  const btn = $('toggle-token-visibility');
  if (tokenInput && btn) {
    if (tokenInput.type === 'password') {
      tokenInput.type = 'text';
      btn.textContent = '🙈';
    } else {
      tokenInput.type = 'password';
      btn.textContent = '👁️';
    }
  }
}

function initFbPages() {
  // Khởi chạy load và render danh sách Page ban đầu
  loadFbPages();
  renderFbPages();

  const searchInput = $('page-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentPage = 1; // Reset về trang 1 khi tìm kiếm
      renderFbPages(e.target.value);
    });
  }

  const fbPageSelect = $('fb-page-select');
  if (fbPageSelect) {
    fbPageSelect.addEventListener('change', function() {
      const val = this.value;
      const manualFields = $('fb-manual-fields');
      
      if (val === 'manual' || val === '') {
        $('fb-page-id').value = '';
        $('fb-page-token').value = '';
        if (manualFields) {
          if (val === 'manual') {
            manualFields.classList.remove('hidden'); // Hiện trường nhập thủ công
          } else {
            manualFields.classList.add('hidden'); // Ẩn nếu chọn "-- Chọn Page đã lưu --"
          }
        }
      } else {
        const index = parseInt(val);
        if (index >= 0 && index < fbPages.length) {
          const page = fbPages[index];
          $('fb-page-id').value = page.id;
          $('fb-page-token').value = page.token;
        }
        if (manualFields) {
          manualFields.classList.add('hidden'); // Ẩn đi khi chọn Page đã lưu
        }
      }
    });
  }
}

// Chạy khởi tạo ngay lập tức nếu DOM đã sẵn sàng, nếu không thì đợi sự kiện DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initFbPages();
    initRenderedVideos();
    initVoicesAndMusic();
    loadDownloadHistory();
  });
} else {
  initFbPages();
  initRenderedVideos();
  initVoicesAndMusic();
  loadDownloadHistory();
}

/* ==========================================================================
   HÀM BỔ TRỢ PHÁT AUDIO (AUDIO PLAYBACK HELPER)
   ========================================================================== */
let currentAudio = null;
let currentAudioUrl = null;
let currentPlayBtn = null;

function stopAllAudio() {
  if (currentAudio) {
    currentAudio.pause();
    if (currentPlayBtn) {
      currentPlayBtn.innerHTML = '🔊 Nghe';
    }
    currentAudio = null;
    currentAudioUrl = null;
    currentPlayBtn = null;
  }
}

function togglePlayAudio(btn, url) {
  if (currentAudio && currentAudioUrl === url) {
    if (!currentAudio.paused) {
      currentAudio.pause();
      btn.innerHTML = '🔊 Nghe';
      return;
    } else {
      currentAudio.play().catch(() => {});
      btn.innerHTML = '⏸ Dừng';
      return;
    }
  }

  if (currentAudio) {
    currentAudio.pause();
    if (currentPlayBtn) {
      currentPlayBtn.innerHTML = '🔊 Nghe';
    }
  }

  currentAudioUrl = url;
  currentPlayBtn = btn;
  currentAudio = new Audio(url);
  btn.innerHTML = '⏸ Dừng';
  
  currentAudio.play().catch(err => {
    toast('❌ Không thể phát audio: ' + err.message, 'error');
    btn.innerHTML = '🔊 Nghe';
  });

  currentAudio.onended = () => {
    btn.innerHTML = '🔊 Nghe';
    currentAudio = null;
    currentAudioUrl = null;
    currentPlayBtn = null;
  };
}

/* ==========================================================================
   HÀM BỔ TRỢ PHÂN TRANG (PAGINATION HELPER)
   ========================================================================== */

function renderPaginationControls(containerId, currentPage, totalPages, onPageChange) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (totalPages <= 1) return;

  // Nút Trước (Prev)
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'ghost-btn';
  prevBtn.style = 'padding: 6px 12px; font-size: 12px; height: auto; margin: 0;';
  prevBtn.innerHTML = '◀';
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => onPageChange(currentPage - 1);
  container.appendChild(prevBtn);

  // Các nút số trang
  for (let i = 1; i <= totalPages; i++) {
    const pageBtn = document.createElement('button');
    pageBtn.type = 'button';
    pageBtn.className = i === currentPage ? 'primary-btn' : 'ghost-btn';
    pageBtn.style = `padding: 6px 12px; font-size: 12px; height: auto; margin: 0; ${i === currentPage ? 'background: var(--accent); color: white;' : ''}`;
    pageBtn.textContent = i;
    pageBtn.onclick = () => onPageChange(i);
    container.appendChild(pageBtn);
  }

  // Nút Sau (Next)
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'ghost-btn';
  nextBtn.style = 'padding: 6px 12px; font-size: 12px; height: auto; margin: 0;';
  nextBtn.innerHTML = '▶';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => onPageChange(currentPage + 1);
  container.appendChild(nextBtn);
}

/* ==========================================================================
   HÀM ĐIỀU KHIỂN KHO VIDEO
   ========================================================================== */

async function renderRenderedVideosGrid(searchFilter = '') {
  const container = $('rendered-videos-grid');
  if (!container) return;

  try {
    const res = await fetch('/api/studio-assets');
    if (!res.ok) throw new Error('Không thể tải danh sách tài nguyên');
    assets = await res.json();
  } catch (err) {
    console.error('Lỗi khi tải assets:', err.message);
  }

  const countBadge = $('rendered-count-badge');
  const rendersList = assets.renders || [];
  const filtered = rendersList.filter(v => 
    v.filename.toLowerCase().includes(searchFilter.toLowerCase())
  );

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Video`;
  }

  container.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(filtered.length / videosPerPage));
  if (currentVideoPage > totalPages) {
    currentVideoPage = totalPages;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--muted); border: 2px dashed var(--border); border-radius: 8px; background: var(--panel-2);">
        🎞️ Không tìm thấy video render nào.
      </div>
    `;
    const pagContainer = $('rendered-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  // Phân trang bằng slice
  const startIndex = (currentVideoPage - 1) * videosPerPage;
  const pageItems = filtered.slice(startIndex, startIndex + videosPerPage);

  pageItems.forEach(video => {
    const videoUrl = `/renders/${encodeURIComponent(video.filename)}`;
    const card = document.createElement('div');
    card.className = 'rendered-card-item';

    // Định dạng kích thước
    let sizeStr = 'Không rõ';
    if (video.size) {
      if (video.size > 1024 * 1024) {
        sizeStr = `${(video.size / (1024 * 1024)).toFixed(1)} MB`;
      } else {
        sizeStr = `${(video.size / 1024).toFixed(0)} KB`;
      }
    }

    // Định dạng ngày sửa đổi
    let dateStr = 'Không rõ';
    if (video.modified) {
      const d = new Date(video.modified);
      dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    card.innerHTML = `
      <div class="rendered-card-thumb">
        <video src="${videoUrl}" muted playsinline preload="metadata"></video>
        <div class="rendered-card-play-btn" onclick="playRenderedVideo('${video.filename.replace(/'/g, "\\'")}', '${videoUrl.replace(/'/g, "\\'")}')">▶</div>
      </div>
      <div class="rendered-card-info">
        <div class="rendered-card-name" title="${video.filename.replace(/"/g, '&quot;')}">${video.filename}</div>
        <div class="rendered-card-meta">
          <span>💾 ${sizeStr}</span>
          <span>📅 ${dateStr}</span>
        </div>
      </div>
      <div class="rendered-card-actions">
        <button type="button" class="rendered-card-btn rendered-btn-publish" onclick="openFbModal('${videoUrl.replace(/'/g, "\\'")}')">
          🔵 Đăng FB
        </button>
        <button type="button" class="rendered-card-btn rendered-btn-delete" onclick="confirmDeleteRenderedVideo('${video.filename.replace(/'/g, "\\'")}')">
          🗑️ Xóa
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  // Render các nút phân trang
  renderPaginationControls('rendered-pagination', currentVideoPage, totalPages, (newPage) => {
    stopAllAudio();
    currentVideoPage = newPage;
    renderRenderedVideosGrid(searchFilter);
  });
}

function playRenderedVideo(filename, url) {
  const modal = $('video-preview-modal');
  const player = $('preview-modal-player');
  const title = $('video-preview-title');
  if (modal && player) {
    title.textContent = `📺 Xem trước: ${filename}`;
    player.src = url;
    modal.classList.remove('hidden');
    player.play().catch(() => {});
  }
}

function closeVideoPreviewModal() {
  const modal = $('video-preview-modal');
  const player = $('preview-modal-player');
  if (modal && player) {
    player.pause();
    player.src = '';
    modal.classList.add('hidden');
  }
}

function confirmDeleteRenderedVideo(filename) {
  const modal = $('video-delete-confirm-modal');
  const msg = $('video-delete-confirm-message');
  const input = $('delete-video-filename');
  if (modal && msg && input) {
    input.value = filename;
    msg.innerHTML = `Bạn có chắc chắn muốn xóa video <strong>"${filename}"</strong> khỏi thư mục lưu trữ?<br><span style="color: var(--danger); font-size: 12px; margin-top: 6px; display: inline-block;">⚠️ File sẽ bị xóa vĩnh viễn trên máy tính và không thể khôi phục!</span>`;
    modal.classList.remove('hidden');
  }
}

function closeVideoDeleteModal() {
  const modal = $('video-delete-confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function executeDeleteRenderedVideo() {
  const input = $('delete-video-filename');
  if (!input || !input.value) return;

  const filename = input.value;
  const btn = $('confirm-delete-video-btn');
  setBusy(btn, true, 'Đang xóa...');

  try {
    const res = await fetch(`/api/rendered-videos/${encodeURIComponent(filename)}`, {
      method: 'DELETE'
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Lỗi khi xóa video');

    toast('🎉 Đã xóa video thành công!', 'success');
    closeVideoDeleteModal();
    renderRenderedVideosGrid($('rendered-search-input')?.value || '');
  } catch (error) {
    toast('❌ Xóa video thất bại: ' + error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

function initRenderedVideos() {
  const searchInput = $('rendered-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentVideoPage = 1;
      renderRenderedVideosGrid(e.target.value);
    });
  }
}

/* ==========================================================================
   HÀM ĐIỀU KHIỂN KHO GIỌNG MẪU
   ========================================================================== */

function openVoiceModal() {
  const modal = $('voice-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeVoiceModal() {
  const modal = $('voice-modal');
  if (modal) {
    modal.classList.add('hidden');
    $('save-voice-form').reset();
  }
}

function renderVoicesList(searchFilter = '') {
  const tbody = $('voice-list-tbody');
  const countBadge = $('voice-count-badge');
  if (!tbody) return;

  const voicesList = assets.voices || [];
  const filtered = voicesList.filter(v => 
    v.filename.toLowerCase().includes(searchFilter.toLowerCase())
  );

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Giọng`;
  }

  tbody.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(filtered.length / voicesPerPage));
  if (currentVoicePage > totalPages) {
    currentVoicePage = totalPages;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 24px; color: var(--muted);">
          🎙️ Không tìm thấy giọng mẫu nào.
        </td>
      </tr>
    `;
    const pagContainer = $('voice-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const startIndex = (currentVoicePage - 1) * voicesPerPage;
  const pageItems = filtered.slice(startIndex, startIndex + voicesPerPage);

  pageItems.forEach(voice => {
    // Dung lượng
    let sizeStr = 'Không rõ';
    if (voice.size) {
      if (voice.size > 1024 * 1024) {
        sizeStr = `${(voice.size / (1024 * 1024)).toFixed(1)} MB`;
      } else {
        sizeStr = `${(voice.size / 1024).toFixed(0)} KB`;
      }
    }

    // Ngày sửa đổi
    let dateStr = 'Không rõ';
    if (voice.modified) {
      const d = new Date(voice.modified);
      dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';
    const voiceUrl = `/voices/${encodeURIComponent(voice.filename)}`;
    const isPlaying = currentAudio && currentAudioUrl === voiceUrl && !currentAudio.paused;
    const playBtnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';

    tr.innerHTML = `
      <td style="padding: 12px 8px; font-weight: 500; word-break: break-all;">${voice.filename}</td>
      <td style="padding: 12px 8px; color: var(--muted);">${sizeStr}</td>
      <td style="padding: 12px 8px; color: var(--muted);">${dateStr}</td>
      <td style="padding: 12px 8px;">
        <div style="display: flex; justify-content: flex-end; align-items: center; gap: 6px;">
          <button type="button" class="rendered-card-btn rendered-btn-play" style="padding: 4px 8px; margin: 0;" onclick="togglePlayAudio(this, '${voiceUrl.replace(/'/g, "\\'")}')">
            ${playBtnText}
          </button>
          <button type="button" class="rendered-card-btn rendered-btn-delete" style="padding: 4px 8px; margin: 0;" onclick="confirmDeleteVoice('${voice.filename.replace(/'/g, "\\'")}')">
            🗑️ Xóa
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  renderPaginationControls('voice-pagination', currentVoicePage, totalPages, (newPage) => {
    stopAllAudio();
    currentVoicePage = newPage;
    renderVoicesList(searchFilter);
  });
}

function confirmDeleteVoice(filename) {
  const modal = $('voice-delete-confirm-modal');
  const msg = $('voice-delete-confirm-message');
  const input = $('delete-voice-filename');
  if (modal && msg && input) {
    input.value = filename;
    msg.innerHTML = `Bạn có chắc chắn muốn xóa giọng mẫu <strong>"${filename}"</strong> không?<br><span style="color: var(--danger); font-size: 12px; margin-top: 6px; display: inline-block;">⚠️ Hành động này sẽ xóa file vĩnh viễn trên máy tính của bạn!</span>`;
    modal.classList.remove('hidden');
  }
}

function closeVoiceDeleteModal() {
  const modal = $('voice-delete-confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function executeDeleteVoice() {
  const input = $('delete-voice-filename');
  if (!input || !input.value) return;

  const filename = input.value;
  const btn = $('confirm-delete-voice-btn');
  setBusy(btn, true, 'Đang xóa...');

  try {
    const res = await fetch(`/api/voices/${encodeURIComponent(filename)}`, {
      method: 'DELETE'
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Lỗi khi xóa giọng mẫu');

    toast('🎉 Đã xóa giọng mẫu thành công!', 'success');
    closeVoiceDeleteModal();
    await loadAssets();
  } catch (error) {
    toast('❌ Xóa giọng mẫu thất bại: ' + error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

/* ==========================================================================
   HÀM ĐIỀU KHIỂN KHO NHẠC NỀN
   ========================================================================== */

function openMusicModal() {
  const modal = $('music-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeMusicModal() {
  const modal = $('music-modal');
  if (modal) {
    modal.classList.add('hidden');
    $('save-music-form').reset();
  }
}

function renderMusicList(searchFilter = '') {
  const tbody = $('music-list-tbody');
  const countBadge = $('music-count-badge');
  if (!tbody) return;

  const musicList = assets.music || [];
  const filtered = musicList.filter(v => 
    v.filename.toLowerCase().includes(searchFilter.toLowerCase())
  );

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Nhạc`;
  }

  tbody.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(filtered.length / musicPerPage));
  if (currentMusicPage > totalPages) {
    currentMusicPage = totalPages;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 24px; color: var(--muted);">
          🎵 Không tìm thấy nhạc nền nào.
        </td>
      </tr>
    `;
    const pagContainer = $('music-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const startIndex = (currentMusicPage - 1) * musicPerPage;
  const pageItems = filtered.slice(startIndex, startIndex + musicPerPage);

  pageItems.forEach(music => {
    // Dung lượng
    let sizeStr = 'Không rõ';
    if (music.size) {
      if (music.size > 1024 * 1024) {
        sizeStr = `${(music.size / (1024 * 1024)).toFixed(1)} MB`;
      } else {
        sizeStr = `${(music.size / 1024).toFixed(0)} KB`;
      }
    }

    // Ngày sửa đổi
    let dateStr = 'Không rõ';
    if (music.modified) {
      const d = new Date(music.modified);
      dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';
    const musicUrl = `/music/${encodeURIComponent(music.filename)}`;
    const isPlaying = currentAudio && currentAudioUrl === musicUrl && !currentAudio.paused;
    const playBtnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';

    tr.innerHTML = `
      <td style="padding: 12px 8px; font-weight: 500; word-break: break-all;">${music.filename}</td>
      <td style="padding: 12px 8px; color: var(--muted);">${sizeStr}</td>
      <td style="padding: 12px 8px; color: var(--muted);">${dateStr}</td>
      <td style="padding: 12px 8px;">
        <div style="display: flex; justify-content: flex-end; align-items: center; gap: 6px;">
          <button type="button" class="rendered-card-btn rendered-btn-play" style="padding: 4px 8px; margin: 0;" onclick="togglePlayAudio(this, '${musicUrl.replace(/'/g, "\\'")}')">
            ${playBtnText}
          </button>
          <button type="button" class="rendered-card-btn rendered-btn-delete" style="padding: 4px 8px; margin: 0;" onclick="confirmDeleteMusic('${music.filename.replace(/'/g, "\\'")}')">
            🗑️ Xóa
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  renderPaginationControls('music-pagination', currentMusicPage, totalPages, (newPage) => {
    stopAllAudio();
    currentMusicPage = newPage;
    renderMusicList(searchFilter);
  });
}

function confirmDeleteMusic(filename) {
  const modal = $('music-delete-confirm-modal');
  const msg = $('music-delete-confirm-message');
  const input = $('delete-music-filename');
  if (modal && msg && input) {
    input.value = filename;
    msg.innerHTML = `Bạn có chắc chắn muốn xóa nhạc nền <strong>"${filename}"</strong> không?<br><span style="color: var(--danger); font-size: 12px; margin-top: 6px; display: inline-block;">⚠️ Hành động này sẽ xóa file vĩnh viễn trên máy tính của bạn!</span>`;
    modal.classList.remove('hidden');
  }
}

function closeMusicDeleteModal() {
  const modal = $('music-delete-confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function executeDeleteMusic() {
  const input = $('delete-music-filename');
  if (!input || !input.value) return;

  const filename = input.value;
  const btn = $('confirm-delete-music-btn');
  setBusy(btn, true, 'Đang xóa...');

  try {
    const res = await fetch(`/api/music/${encodeURIComponent(filename)}`, {
      method: 'DELETE'
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Lỗi khi xóa nhạc nền');

    toast('🎉 Đã xóa nhạc nền thành công!', 'success');
    closeMusicDeleteModal();
    await loadAssets();
  } catch (error) {
    toast('❌ Xóa nhạc nền thất bại: ' + error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

function initVoicesAndMusic() {
  const voiceSearch = $('voice-search-input');
  if (voiceSearch) {
    voiceSearch.addEventListener('input', (e) => {
      currentVoicePage = 1;
      renderVoicesList(e.target.value);
    });
  }

  const musicSearch = $('music-search-input');
  if (musicSearch) {
    musicSearch.addEventListener('input', (e) => {
      currentMusicPage = 1;
      renderMusicList(e.target.value);
    });
  }
}

let isDownloadingModel = false;
let modelDownloadInterval = null;

function openModelDownloadModal() {
  const modal = $('model-download-modal');
  if (modal) modal.classList.remove('hidden');
  
  fetch('/api/download-model/status')
    .then(res => res.json())
    .then(status => {
      updateModelDownloadUI(status);
      if (status.downloading) {
        startStatusPolling();
      }
    })
    .catch(err => console.error(err));
}

function closeModelDownloadModal() {
  if (isDownloadingModel) {
    toast('⚠️ Đang tải model, vui lòng không đóng bảng!', 'warn');
    return;
  }
  const modal = $('model-download-modal');
  if (modal) modal.classList.add('hidden');
}

function updateModelDownloadUI(status) {
  const statusLabel = $('model-download-status-label');
  const percentLabel = $('model-download-percent-label');
  const progressBar = $('model-download-progress-bar');
  const bytesLabel = $('model-download-bytes-label');
  const actionBtn = $('model-download-action-btn');
  const cancelBtn = $('model-download-cancel-btn');
  const closeBtn = $('model-download-close');

  if (status.downloading) {
    isDownloadingModel = true;
    if (statusLabel) statusLabel.textContent = 'Đang tải model từ HuggingFace...';
    if (percentLabel) percentLabel.textContent = `${status.percent}%`;
    if (progressBar) progressBar.style.width = `${status.percent}%`;
    
    const mbDownloaded = (status.downloadedBytes / (1024 * 1024)).toFixed(1);
    const mbTotal = (status.totalBytes / (1024 * 1024)).toFixed(1);
    if (bytesLabel) bytesLabel.textContent = `${mbDownloaded} MB / ${mbTotal} MB`;
    
    if (actionBtn) {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Đang tải...';
    }
    if (cancelBtn) cancelBtn.disabled = true;
    if (closeBtn) closeBtn.style.display = 'none';
  } else {
    isDownloadingModel = false;
    if (status.percent === 100) {
      if (statusLabel) statusLabel.textContent = 'Tải thành công! Đã lưu vào thư mục cài đặt.';
      if (percentLabel) percentLabel.textContent = '100%';
      if (progressBar) progressBar.style.width = '100%';
      if (bytesLabel) bytesLabel.textContent = '1400 MB / 1400 MB';
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Tải lại';
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Hoàn tất';
        cancelBtn.style.background = 'var(--success)';
        cancelBtn.style.color = 'white';
        cancelBtn.onclick = () => {
          closeModelDownloadModal();
          loadAssets();
        };
      }
      if (closeBtn) closeBtn.style.display = 'block';
    } else if (status.error) {
      if (statusLabel) statusLabel.textContent = `Lỗi: ${status.error}`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Thử lại';
      }
      if (cancelBtn) cancelBtn.disabled = false;
      if (closeBtn) closeBtn.style.display = 'block';
    } else {
      if (statusLabel) statusLabel.textContent = 'Sẵn sàng tải xuống';
      if (percentLabel) percentLabel.textContent = '0%';
      if (progressBar) progressBar.style.width = '0%';
      if (bytesLabel) bytesLabel.textContent = '0 MB / 1400 MB';
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Bắt đầu tải';
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Đóng';
        cancelBtn.style.background = '';
        cancelBtn.style.color = '';
        cancelBtn.onclick = closeModelDownloadModal;
      }
      if (closeBtn) closeBtn.style.display = 'block';
    }
  }
}

function startModelDownload() {
  fetch('/api/download-model', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        toast('🚀 Bắt đầu tải bộ xử lý giọng nói...', 'info');
        startStatusPolling();
      }
    })
    .catch(err => {
      toast('❌ Không khởi động được download: ' + err.message, 'error');
    });
}

function startStatusPolling() {
  if (modelDownloadInterval) clearInterval(modelDownloadInterval);
  
  modelDownloadInterval = setInterval(() => {
    fetch('/api/download-model/status')
      .then(res => res.json())
      .then(status => {
        updateModelDownloadUI(status);
        if (!status.downloading) {
          clearInterval(modelDownloadInterval);
          if (status.percent === 100) {
            toast('🎉 Tải xuống model OmniVoice thành công!', 'success');
            loadAssets();
          } else if (status.error) {
            toast('❌ Lỗi khi tải model: ' + status.error, 'error');
          }
        }
      })
      .catch(err => {
        console.error(err);
        clearInterval(modelDownloadInterval);
      });
  }, 1000);
}

// Whisper Model Management & Downloading
let whisperDownloadInterval = null;
let isDownloadingWhisper = false;

function openWhisperDownloadModal() {
  const modal = $('whisper-download-modal');
  if (modal) modal.classList.remove('hidden');
  
  const modelSelect = $('whisper-model-select');
  const model = modelSelect ? modelSelect.value : 'base';
  
  const modelNameEl = $('whisper-download-model-name');
  if (modelNameEl) {
    modelNameEl.textContent = model.toUpperCase();
  }
  
  fetch(`/api/whisper-model/status?model=${model}`)
    .then(res => res.json())
    .then(status => {
      updateWhisperDownloadUI(status, model);
      if (status.downloading) {
        startWhisperStatusPolling(model);
      }
    })
    .catch(err => console.error(err));
}

function closeWhisperDownloadModal() {
  if (isDownloadingWhisper) {
    toast('⚠️ Đang tải model Whisper, vui lòng không đóng bảng!', 'warn');
    return;
  }
  const modal = $('whisper-download-modal');
  if (modal) modal.classList.add('hidden');
}

function updateWhisperDownloadUI(status, model) {
  const statusLabel = $('whisper-download-status-label');
  const percentLabel = $('whisper-download-percent-label');
  const progressBar = $('whisper-download-progress-bar');
  const sizeLabel = $('whisper-download-size-label');
  const bytesLabel = $('whisper-download-bytes-label');
  const actionBtn = $('whisper-download-action-btn');
  const cancelBtn = $('whisper-download-cancel-btn');
  const closeBtn = $('whisper-download-close');

  const whisperSizes = {
    tiny: '75 MB',
    base: '140 MB',
    small: '460 MB',
    medium: '1.5 GB',
    'large-v3': '3.0 GB'
  };
  const targetSize = whisperSizes[model] || '...';
  if (sizeLabel) sizeLabel.textContent = `Kích thước: ~${targetSize}`;

  if (status.downloading) {
    isDownloadingWhisper = true;
    if (statusLabel) statusLabel.textContent = 'Đang tải model từ HuggingFace...';
    if (percentLabel) percentLabel.textContent = `${status.percent}%`;
    if (progressBar) progressBar.style.width = `${status.percent}%`;
    
    const mbDownloaded = (status.downloadedBytes / (1024 * 1024)).toFixed(1);
    const mbTotal = (status.totalBytes / (1024 * 1024)).toFixed(1);
    if (bytesLabel) bytesLabel.textContent = `${mbDownloaded} MB / ${mbTotal} MB`;
    
    if (actionBtn) {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Đang tải...';
    }
    if (cancelBtn) cancelBtn.disabled = true;
    if (closeBtn) closeBtn.style.display = 'none';
  } else {
    isDownloadingWhisper = false;
    if (status.exists) {
      if (statusLabel) statusLabel.textContent = 'Tải thành công! Đã lưu vào thư mục cài đặt.';
      if (percentLabel) percentLabel.textContent = '100%';
      if (progressBar) progressBar.style.width = '100%';
      const mbTotal = status.totalBytes ? (status.totalBytes / (1024 * 1024)).toFixed(1) : targetSize.split(' ')[0];
      if (bytesLabel) bytesLabel.textContent = `${mbTotal} MB / ${mbTotal} MB`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Tải lại';
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Hoàn tất';
        cancelBtn.style.background = 'var(--success)';
        cancelBtn.style.color = 'white';
        cancelBtn.onclick = () => {
          closeWhisperDownloadModal();
          checkWhisperModelStatus();
        };
      }
      if (closeBtn) closeBtn.style.display = 'block';
    } else if (status.error) {
      if (statusLabel) statusLabel.textContent = `Lỗi: ${status.error}`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Thử lại';
      }
      if (cancelBtn) cancelBtn.disabled = false;
      if (closeBtn) closeBtn.style.display = 'block';
    } else {
      if (statusLabel) statusLabel.textContent = 'Sẵn sàng tải xuống';
      if (percentLabel) percentLabel.textContent = '0%';
      if (progressBar) progressBar.style.width = '0%';
      if (bytesLabel) bytesLabel.textContent = `0 MB / ${targetSize}`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Bắt đầu tải';
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Đóng';
        cancelBtn.style.background = '';
        cancelBtn.style.color = '';
        cancelBtn.onclick = closeWhisperDownloadModal;
      }
      if (closeBtn) closeBtn.style.display = 'block';
    }
  }
}

function startWhisperDownload() {
  const modelSelect = $('whisper-model-select');
  const model = modelSelect ? modelSelect.value : 'base';
  
  fetch('/api/download-whisper-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model })
  })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        toast('🚀 Bắt đầu tải bộ nhận diện giọng nói Whisper...', 'info');
        startWhisperStatusPolling(model);
      }
    })
    .catch(err => {
      toast('❌ Không khởi động được download: ' + err.message, 'error');
    });
}

function startWhisperStatusPolling(model) {
  if (whisperDownloadInterval) clearInterval(whisperDownloadInterval);
  
  whisperDownloadInterval = setInterval(() => {
    fetch(`/api/whisper-model/status?model=${model}`)
      .then(res => res.json())
      .then(status => {
        updateWhisperDownloadUI(status, model);
        if (!status.downloading) {
          clearInterval(whisperDownloadInterval);
          if (status.exists) {
            toast(`🎉 Tải xuống model Whisper ${model.toUpperCase()} thành công!`, 'success');
            checkWhisperModelStatus();
          } else if (status.error) {
            toast('❌ Lỗi khi tải model Whisper: ' + status.error, 'error');
          }
        }
      })
      .catch(err => {
        console.error(err);
        clearInterval(whisperDownloadInterval);
      });
  }, 1000);
}

async function checkWhisperModelStatus() {
  const modelSelect = $('whisper-model-select');
  if (!modelSelect) return;
  const model = modelSelect.value;
  const statusLabel = $('whisper-model-status');
  const downloadBtn = $('whisper-model-download-btn');

  try {
    const res = await fetch(`/api/whisper-model/status?model=${model}`);
    if (!res.ok) throw new Error('Không thể kiểm tra trạng thái model');
    const status = await res.json();
    
    if (status.exists) {
      if (statusLabel) {
        statusLabel.textContent = 'Đã có sẵn';
        statusLabel.style.color = '#25D366';
      }
      if (downloadBtn) {
        downloadBtn.style.display = 'none';
      }
    } else {
      if (status.downloading) {
        if (statusLabel) {
          statusLabel.textContent = `Đang tải (${status.percent}%)`;
          statusLabel.style.color = 'var(--accent)';
        }
        if (downloadBtn) {
          downloadBtn.style.display = 'inline-block';
          downloadBtn.textContent = '⏳ Đang tải...';
          downloadBtn.disabled = true;
        }
        startWhisperStatusPolling(model);
      } else {
        if (statusLabel) {
          statusLabel.textContent = 'Chưa tải';
          statusLabel.style.color = '#FFA500';
        }
        if (downloadBtn) {
          downloadBtn.style.display = 'inline-block';
          downloadBtn.textContent = '📥 Tải';
          downloadBtn.disabled = false;
        }
      }
    }
  } catch (error) {
    console.error('Lỗi checkWhisperModelStatus:', error);
    if (statusLabel) {
      statusLabel.textContent = 'Lỗi kết nối';
      statusLabel.style.color = '#FF3B30';
    }
  }
}

