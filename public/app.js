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
let currentHistoryPage = 1;
const historyPerPage = 10;
let currentSavedLinkPage = 1;
const savedLinksPerPage = 5;
let currentPlaylistVideos = [];
let currentPlaylistSessionId = null;
let assets = { videos: [], voices: [], music: [], subtitles: [], renders: [], omiConfigured: false };
let isBulkDownloadCancelled = false;
let activeBulkDownloadController = null;

let konvaStage = null;
let konvaLayer = null;
let konvaSubtitle = null;
let konvaReaction = null;
let konvaBlur = null;
let konvaTransformer = null;
let vGuideline = null;
let hGuideline = null;

const $ = (id) => document.getElementById(id);

function toast(message, type = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3600);
}

// Global error handlers for UI debugging
window.onerror = function (message, source, lineno, colno, error) {
  toast(`Lỗi UI: ${message} (dòng ${lineno})`, 'error');
  return false;
};
window.addEventListener('unhandledrejection', function (event) {
  toast(`Lỗi Promise: ${event.reason}`, 'error');
});

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

function extractTitleFromPastedText(rawText) {
  if (!rawText) return null;
  const bracketMatch = rawText.match(/【([^】]+)】/);
  if (bracketMatch) {
    let title = bracketMatch[1].trim();
    title = title.replace(/\s*\|\s*小红书\s*-\s*.*$/, '');
    return title;
  }
  const urlMatch = rawText.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const urlIndex = rawText.indexOf(urlMatch[0]);
    if (urlIndex > 10) {
      let prefix = rawText.substring(0, urlIndex).trim();
      prefix = prefix.replace(/(?:复制打开抖音，看看|😆|\s+|-)+$/, '').trim();
      if (prefix && prefix.length > 5) {
        return prefix;
      }
    }
  }
  return null;
}

function extractAuthorFromPastedText(rawText) {
  if (!rawText) return null;
  const authorMatch = rawText.match(/】\s*😆\s*([^\s😆]+)\s*😆/);
  if (authorMatch) {
    return authorMatch[1].trim();
  }
  return null;
}

function isValidVideoUrl(url) {
  return /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/|facebook\.com\/|fb\.watch\/|fb\.com\/|tiktok\.com\/|douyin\.com\/|v\.douyin\.com\/|iesdouyin\.com\/)/.test(url);
}

function formatDuration(seconds) {
  const value = Math.round(Number(seconds || 0));
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function fetchVideoInfo() {
  const rawText = $('url-input').value.trim();
  const extractedTitle = extractTitleFromPastedText(rawText);
  const extractedAuthor = extractAuthorFromPastedText(rawText);

  let url = rawText;
  const match = url.match(/https?:\/\/[^\s]+/);
  if (match) {
    url = match[0];
    $('url-input').value = url;
  }
  if (!url || !isValidVideoUrl(url)) {
    toast('Link video không hợp lệ.', 'error');
    return;
  }

  // Tra cứu xem liên kết này có nằm trong danh mục đã lưu không để lấy tên đã lưu làm dự phòng
  let localSavedTitle = '';
  const savedItem = savedLinks.find(item => item.url === url);
  if (savedItem && savedItem.name) {
    if (!savedItem.name.startsWith('XiaoHongShu video #') && !savedItem.name.startsWith('[Xiaohongshu]')) {
      localSavedTitle = savedItem.name;
    }
  }

  const finalExtractedTitle = extractedTitle || localSavedTitle;

  const btn = $('fetch-btn');
  setBusy(btn, true, 'Đang lấy...');
  $('video-card').classList.add('hidden');
  $('video-card-loading').classList.remove('hidden');
  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không lấy được thông tin video');

    if (finalExtractedTitle) {
      if (!data.title || data.title.startsWith('XiaoHongShu video #') || data.title.includes('Untitled')) {
        data.title = finalExtractedTitle;
      }
    }
    if (extractedAuthor) {
      if (!data.author || data.author === 'Unknown') {
        data.author = extractedAuthor;
      }
    }

    currentUrl = url;
    renderVideoInfo(data);
  } catch (error) {
    if (finalExtractedTitle) {
      currentUrl = url;
      renderVideoInfo({
        title: finalExtractedTitle,
        author: extractedAuthor || 'Xiaohongshu User',
        duration: 0,
        thumbnail: '',
        formats: []
      });
      toast('Hiển thị thông tin dự phòng (Bài viết không có video)', 'warn');
    } else {
      toast(error.message, 'error');
    }
  } finally {
    setBusy(btn, false);
    $('video-card-loading').classList.add('hidden');
  }
}

function renderVideoInfo(data) {
  if (!data.thumbnail) {
    $('video-thumbnail').src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="124" viewBox="0 0 220 124"><rect width="220" height="124" fill="%23161c24"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="%23555">Bài viết hình ảnh</text></svg>';
  } else {
    $('video-thumbnail').src = data.thumbnail;
  }
  $('video-title').textContent = data.title || 'Untitled';
  $('video-meta').textContent = `${data.author || 'Unknown'}` + (data.duration ? ` · ${formatDuration(data.duration)}` : '');
  const grid = $('quality-grid');
  grid.innerHTML = '';

  if (!data.formats || data.formats.length === 0) {
    const msg = document.createElement('div');
    msg.style = 'color: var(--muted); font-size: 13px; padding: 10px; border: 1px dashed var(--border); border-radius: 6px; width: 100%; text-align: center;';
    msg.textContent = '⚠️ Đây là bài đăng hình ảnh tĩnh hoặc slide ảnh (Không hỗ trợ tải video).';
    grid.appendChild(msg);
  } else {
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
  
  currentHistoryPage = 1;
  saveDownloadHistory();
  renderDownloadHistory();
}

function deleteHistoryItem(id) {
  downloadHistory = downloadHistory.filter(item => item.id !== id);
  saveDownloadHistory();
  const totalPages = Math.ceil(downloadHistory.length / historyPerPage) || 1;
  if (currentHistoryPage > totalPages) {
    currentHistoryPage = totalPages;
  }
  renderDownloadHistory();
}

function clearDownloadHistory() {
  downloadHistory = [];
  currentHistoryPage = 1;
  saveDownloadHistory();
  renderDownloadHistory();
}

// Function to populate URL input and fetch info to redownload
function redownloadHistoryItem(url) {
  const urlInput = $('url-input');
  if (urlInput) {
    urlInput.value = url;
    urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    urlInput.focus();
    fetchVideoInfo();
    toast('Đang nạp link và lấy thông tin video...', 'info');
  }
}
window.redownloadHistoryItem = redownloadHistoryItem;

// Function to call API to open the directory containing the file
async function openFileFolder(filename) {
  if (!filename) return;
  try {
    const res = await fetch(`/api/open-file-folder?filename=${encodeURIComponent(filename)}`);
    const data = await res.json();
    if (data.success) {
      toast('Đã mở thư mục chứa video', 'success');
    } else {
      toast('Không thể mở thư mục', 'error');
    }
  } catch (e) {
    console.error(e);
    toast('Lỗi khi kết nối với server', 'error');
  }
}
window.openFileFolder = openFileFolder;

function renderDownloadHistory() {
  const container = $('download-history-list');
  const paginationContainer = $('download-history-pagination');
  if (!container) return;
  
  container.innerHTML = '';
  if (paginationContainer) paginationContainer.innerHTML = '';
  
  if (downloadHistory.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--muted); border: 2px dashed var(--border); border-radius: 8px; background: var(--panel-2); font-size: 12px;">
        📥 Chưa có lịch sử tải video nào.
      </div>
    `;
    return;
  }
  
  const totalPages = Math.ceil(downloadHistory.length / historyPerPage);
  if (currentHistoryPage > totalPages) {
    currentHistoryPage = totalPages;
  }
  if (currentHistoryPage < 1) {
    currentHistoryPage = 1;
  }
  
  const paginatedItems = downloadHistory.slice((currentHistoryPage - 1) * historyPerPage, currentHistoryPage * historyPerPage);
  
  paginatedItems.forEach(item => {
    const d = new Date(item.timestamp);
    const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    
    const card = document.createElement('div');
    card.className = 'download-history-item';
    card.style = 'display: flex; align-items: center; justify-content: space-between; padding: 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; gap: 12px; transition: all 0.15s;';
    
    const badgeBg = item.status === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
    const badgeColor = item.status === 'success' ? '#10b981' : '#ef4444';
    const badgeText = item.status === 'success' ? 'Thành công' : 'Thất bại';
    
    const isSuccess = item.status === 'success';
    const clickHandler = isSuccess ? `onclick="openFileFolder('${item.filename}')"` : '';
    const hoverStyle = isSuccess ? 'cursor: pointer;' : '';
    const titleTooltip = isSuccess ? 'Bấm để mở thư mục chứa video này' : '';
    
    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; ${hoverStyle}" ${clickHandler} title="${titleTooltip}">
        <div style="position: relative; width: 50px; height: 50px; border-radius: 6px; overflow: hidden; flex-shrink: 0; background: #000;">
          <img src="${item.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'">
          ${isSuccess ? '<div style="position: absolute; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s;" class="history-thumb-overlay"><span style="font-size: 14px;">📂</span></div>' : ''}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div class="history-item-title" style="font-size: 13.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.15s;" title="${item.title.replace(/"/g, '&quot;')}">${item.title}</div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
            <span>📅 ${dateStr}</span>
            <span>🔗 <a href="${item.url}" target="_blank" style="color: var(--accent); text-decoration: none;" onclick="event.stopPropagation();">Link nguồn</a></span>
            <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 2px 6px; font-size: 9px; font-weight: 600; border-radius: 4px;">
              ${badgeText}
            </span>
          </div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
        <span style="font-size: 11px; font-weight: 500; color: var(--muted); background: var(--border); padding: 4px 8px; border-radius: 4px;">${item.type}</span>
        ${isSuccess ? `<button type="button" class="rendered-card-btn" style="padding: 6px 10px; margin: 0; font-size: 11px; height: 30px; display: inline-flex; align-items: center; gap: 4px; background: var(--panel-1); border: 1px solid var(--border); color: var(--text);" onclick="openFileFolder('${item.filename}')" title="Mở thư mục chứa file video này">📂 Mở</button>` : ''}
        <button type="button" class="rendered-card-btn" style="padding: 6px 10px; margin: 0; font-size: 11px; height: 30px; display: inline-flex; align-items: center; gap: 4px; background: var(--panel-1); border: 1px solid var(--border); color: var(--text);" onclick="redownloadHistoryItem('${item.url}')" title="Nạp lại link để tải lại">🔄 Tải lại</button>
        <button type="button" class="rendered-card-btn rendered-btn-delete" style="padding: 6px 10px; margin: 0; font-size: 11px; height: 30px; display: inline-flex; align-items: center;" onclick="deleteHistoryItem('${item.id}')">🗑️</button>
      </div>
    `;
    container.appendChild(card);
  });

  renderPaginationControls('download-history-pagination', currentHistoryPage, totalPages, (newPage) => {
    currentHistoryPage = newPage;
    renderDownloadHistory();
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
    console.error('Client startDownload error:', error);
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
  const resultsContainer = $('bulk-results-container');
  setBusy(btn, true, 'Đang quét...');
  if (resultsContainer) resultsContainer.classList.add('hidden');
  stats.textContent = 'Đang lấy danh sách video...';
  currentPlaylistVideos = [];
  const sessionId = Date.now();
  currentPlaylistSessionId = sessionId;

  try {
    const res = await fetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, limit })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không lấy được playlist');

    if (sessionId !== currentPlaylistSessionId) return;

    currentPlaylistVideos = data.videos || [];
    renderPlaylistVideos();
    stats.textContent = `Tìm thấy ${currentPlaylistVideos.length} video.`;
    if (resultsContainer) {
      resultsContainer.classList.remove('hidden');
    }
    const selectAllCheck = $('bulk-select-all');
    if (selectAllCheck) {
      selectAllCheck.checked = true;
    }
  } catch (error) {
    if (sessionId === currentPlaylistSessionId) {
      toast(error.message, 'error');
      stats.textContent = 'Có lỗi khi quét danh sách.';
    }
  } finally {
    if (sessionId === currentPlaylistSessionId) {
      setBusy(btn, false);
    }
  }
}

function renderPlaylistVideos() {
  const listContainer = $('bulk-videos-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (currentPlaylistVideos.length === 0) {
    listContainer.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--muted); font-size: 13px;">Không có video nào trong danh sách.</div>';
    return;
  }

  currentPlaylistVideos.forEach((video, index) => {
    const card = document.createElement('div');
    card.className = 'bulk-video-card';
    
    const thumbUrl = video.thumbnail || (video.id && (video.url.includes('youtube.com') || video.url.includes('youtu.be')) ? `https://img.youtube.com/vi/${video.id}/mqdefault.jpg` : '');
    const durationStr = video.duration ? formatDuration(video.duration) : '';

    card.innerHTML = `
      <div style="align-self: center; display: flex; justify-content: center; align-items: center; height: 100%;">
        <input type="checkbox" class="bulk-video-checkbox" data-index="${index}" style="width: 20px; height: 20px; cursor: pointer; accent-color: var(--accent);" checked>
      </div>
      <div style="position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; background: #090d12; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border);">
        ${thumbUrl ? `<img src="${thumbUrl}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">` : ''}
        <span style="font-size: 24px; display: ${thumbUrl ? 'none' : 'block'};">📹</span>
        ${durationStr ? `<span style="position: absolute; bottom: 4px; right: 4px; background: rgba(0,0,0,0.75); color: #fff; font-size: 10px; padding: 2px 4px; border-radius: 4px;">${durationStr}</span>` : ''}
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <h4 class="bulk-video-title" style="margin: 0; font-size: 14px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4;" title="${(video.title || '').replace(/"/g, '&quot;')}">${video.title || 'Video ' + video.id}</h4>
        <p style="margin: 0; font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; align-items: center; gap: 8px;">
          <span>🔗 <a href="${video.url}" target="_blank" style="color: var(--accent); text-decoration: none;" onclick="event.stopPropagation();">Link nguồn</a></span>
          <span class="bulk-video-status" style="font-weight: 600; color: var(--muted); background: rgba(255, 255, 255, 0.05); padding: 1px 6px; border-radius: 3px; font-size: 10px;">Sẵn sàng</span>
        </p>
        <div class="quality-grid" id="quality-grid-${index}" style="margin-top: 6px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="info-spinner" style="width: 16px; height: 16px; border-width: 2px; margin: 0;"></div>
            <span style="font-size: 12px; color: var(--muted);">Đang tải tùy chọn...</span>
          </div>
        </div>
      </div>
    `;
    listContainer.appendChild(card);
  });

  // Đồng bộ trạng thái checkbox "Chọn tất cả" khi thay đổi các checkbox thành viên
  const checkBoxes = listContainer.querySelectorAll('.bulk-video-checkbox');
  checkBoxes.forEach(cb => {
    cb.addEventListener('change', () => {
      const allChecked = Array.from(checkBoxes).every(c => c.checked);
      const selectAll = $('bulk-select-all');
      if (selectAll) selectAll.checked = allChecked;
    });
  });

  // Bắt đầu tải danh sách định dạng/chất lượng cho tất cả các video
  loadAllPlaylistFormats(currentPlaylistSessionId);
}

async function loadAllPlaylistFormats(sessionId) {
  const queue = [...currentPlaylistVideos.keys()];
  const concurrency = 2; // Tải tối đa 2 video song song để tránh quá tải
  
  async function worker() {
    while (queue.length > 0) {
      if (sessionId !== currentPlaylistSessionId) break;
      const index = queue.shift();
      if (index === undefined) break;
      await fetchVideoFormatsForIndex(index, sessionId);
    }
  }
  
  const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(() => worker());
  await Promise.all(workers);
}

async function fetchVideoFormatsForIndex(index, sessionId) {
  if (sessionId !== currentPlaylistSessionId) return;
  const video = currentPlaylistVideos[index];
  if (!video) return;
  
  const grid = $(`quality-grid-${index}`);
  if (!grid) return;
  
  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: video.url })
    });
    if (sessionId !== currentPlaylistSessionId) return;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi');
    
    // Lưu lại thông tin formats vào video object để dùng
    video.formats = data.formats || [];
    renderVideoCardFormats(index, data);
  } catch (error) {
    if (sessionId !== currentPlaylistSessionId) return;
    console.error(`Lỗi tải format cho video ${index}:`, error);
    grid.innerHTML = `<span style="font-size: 11px; color: var(--danger); font-weight: 500;">⚠️ Không lấy được tùy chọn tải</span>`;
  }
}

function renderVideoCardFormats(index, data) {
  const grid = $(`quality-grid-${index}`);
  if (!grid) return;
  grid.innerHTML = '';

  const video = currentPlaylistVideos[index];
  if (!video) return;

  if (!data.formats || data.formats.length === 0) {
    const msg = document.createElement('div');
    msg.style = 'color: var(--muted); font-size: 11px; padding: 4px 8px; border: 1px dashed var(--border); border-radius: 6px; width: 100%; text-align: center;';
    msg.textContent = '⚠️ Không hỗ trợ tải video (chỉ có hình ảnh).';
    grid.appendChild(msg);
    return;
  }

  // Container dạng hàng để xếp ngang Select và Nút tải
  const container = document.createElement('div');
  container.style = 'display: flex; gap: 8px; align-items: center; width: 100%;';

  // Dropdown chọn định dạng
  const select = document.createElement('select');
  select.id = `format-select-${index}`;
  select.className = 'quality-select';
  select.style = 'flex: 1; height: 32px; font-size: 11px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); color: var(--text); padding: 0 8px; cursor: pointer; outline: none; transition: border-color 0.15s;';
  
  // Tùy chọn mặc định
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '--- Chọn chất lượng ---';
  select.appendChild(defaultOpt);

  // Tùy chọn Vietsub
  const vietsubOpt = document.createElement('option');
  vietsubOpt.value = 'vietsub';
  vietsubOpt.textContent = 'Tải + dịch Vietsub';
  select.appendChild(vietsubOpt);

  // Thêm các format chất lượng
  for (const format of data.formats || []) {
    const opt = document.createElement('option');
    opt.value = format.format_id;
    opt.textContent = `${format.quality} · ${format.size}`;
    select.appendChild(opt);
  }

  container.appendChild(select);

  // Nút Tải xuống
  const btn = document.createElement('button');
  btn.className = 'quality-btn bulk-item-download-btn';
  btn.type = 'button';
  btn.style = 'font-size: 11px; padding: 6px 12px; height: 32px; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; margin: 0; background: var(--accent); color: white; border: none;';
  btn.textContent = 'Tải xuống';
  
  btn.onclick = () => {
    downloadSingleBulkVideo(btn, index);
  };

  container.appendChild(btn);
  grid.appendChild(container);
}

async function downloadSingleBulkVideo(btn, index) {
  const video = currentPlaylistVideos[index];
  if (!video) return;

  const select = $(`format-select-${index}`);
  if (!select) return;
  const val = select.value;
  if (!val) {
    toast('Vui lòng chọn chất lượng tải!', 'warn');
    select.focus();
    // Highlight màu đỏ viền dropdown để báo hiệu
    select.style.borderColor = 'var(--danger)';
    setTimeout(() => { select.style.borderColor = ''; }, 3000);
    return;
  }

  const card = btn.closest('.bulk-video-card');
  const statusLabel = card ? card.querySelector('.bulk-video-status') : null;
  
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ ...';
  
  if (statusLabel) {
    statusLabel.textContent = 'Đang tải...';
    statusLabel.style.color = 'var(--accent)';
  }

  try {
    const oldCurrentUrl = currentUrl;
    currentUrl = video.url;

    const subtitleSize = document.querySelector('input[name="subtitleSize"]')?.value || 18;
    const subtitleMarginH = document.querySelector('input[name="subtitleMarginH"]')?.value || 20;
    const subtitleMaxLines = document.querySelector('[name="subtitleMaxLines"]')?.value || 0;
    const geminiApiKey = localStorage.getItem('geminiApiKey') || '';

    const res = await fetch('/api/download-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: video.url,
        format_id: val,
        geminiApiKey,
        subtitleMaxLines,
        subtitleSize,
        subtitleMarginH
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi tải video');
    
    if (statusLabel) {
      statusLabel.textContent = 'Thành công';
      statusLabel.style.color = '#10b981';
    }
    toast(`🎉 Tải thành công: ${video.title || video.id}`, 'success');
    
    const thumbUrl = video.thumbnail || (video.id && (video.url.includes('youtube.com') || video.url.includes('youtu.be')) ? `https://img.youtube.com/vi/${video.id}/mqdefault.jpg` : '');
    addDownloadHistory(video.title, thumbUrl, 'success', data.filename || `${video.title || video.id}.mp4`, 'Kênh/Playlist');

    currentUrl = oldCurrentUrl;
  } catch (err) {
    if (statusLabel) {
      statusLabel.textContent = 'Thất bại';
      statusLabel.style.color = '#ef4444';
    }
    toast(`❌ Lỗi tải: ${err.message}`, 'error');
    
    const oldCurrentUrl = currentUrl;
    currentUrl = video.url;
    const thumbUrl = video.thumbnail || (video.id && (video.url.includes('youtube.com') || video.url.includes('youtu.be')) ? `https://img.youtube.com/vi/${video.id}/mqdefault.jpg` : '');
    addDownloadHistory(video.title, thumbUrl, 'failed', '', 'Kênh/Playlist');
    currentUrl = oldCurrentUrl;
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function downloadSelectedBulkVideos() {
  const checkboxes = document.querySelectorAll('.bulk-video-checkbox:checked');
  if (checkboxes.length === 0) {
    toast('Vui lòng chọn ít nhất 1 video để tải.', 'warn');
    return;
  }

  // Validate format selected for all checked videos
  for (const cb of checkboxes) {
    const index = Number(cb.dataset.index);
    const select = $(`format-select-${index}`);
    if (select && !select.value) {
      toast('Vui lòng chọn chất lượng tải cho tất cả các video đã tích!', 'warn');
      
      const card = cb.closest('.bulk-video-card');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      select.focus();
      select.style.borderColor = 'var(--danger)';
      setTimeout(() => { select.style.borderColor = ''; }, 3000);
      return;
    }
  }

  const dlBtn = $('bulk-download-selected-btn');
  const stats = $('bulk-stats');
  
  const total = checkboxes.length;
  let ok = 0;
  let fail = 0;

  isBulkDownloadCancelled = false;
  activeBulkDownloadController = null;

  // Open the progress modal
  openBulkDownloadModal();

  const statusLabel = $('bulk-progress-status-label');
  const percentLabel = $('bulk-progress-percent-label');
  const progressBar = $('bulk-progress-bar');
  const statsLabel = $('bulk-progress-stats');
  const progressList = $('bulk-download-progress-list');

  // Clear and populate progress details list
  progressList.innerHTML = '';
  checkboxes.forEach((cb, idx) => {
    const index = Number(cb.dataset.index);
    const video = currentPlaylistVideos[index];
    const select = $(`format-select-${index}`);
    const selectedOpt = select ? select.options[select.selectedIndex] : null;
    const formatName = selectedOpt ? selectedOpt.textContent.split(' · ')[0] : 'Tự động';
    
    const item = document.createElement('div');
    item.id = `bulk-progress-item-${index}`;
    item.style = 'display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--border);';
    item.innerHTML = `
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; font-weight: 500;" title="${(video.title || '').replace(/"/g, '&quot;')}">
        ${idx + 1}. ${video.title || 'Video ' + video.id} (${formatName})
      </span>
      <span class="bulk-item-status" style="font-weight: 600; color: var(--muted);">Đang chờ...</span>
    `;
    progressList.appendChild(item);
  });

  statusLabel.textContent = 'Đang chuẩn bị...';
  percentLabel.textContent = '0%';
  progressBar.style.width = '0%';
  statsLabel.textContent = `Tiến trình: 0/${total} video (Thành công: 0, Thất bại: 0)`;
  
  // Show cancel button, hide close button
  $('bulk-download-modal-cancel-btn').classList.remove('hidden');
  $('bulk-download-modal-close-action-btn').classList.add('hidden');

  setBusy(dlBtn, true, 'Đang tải...');
  $('bulk-fetch-btn').disabled = true;
  $('bulk-url-input').disabled = true;
  $('bulk-limit').disabled = true;
  document.querySelectorAll('.bulk-video-checkbox').forEach(cb => cb.disabled = true);
  document.querySelectorAll('.bulk-item-download-btn').forEach(b => b.disabled = true);
  
  stats.textContent = `Bắt đầu tải ${total} video...`;

  for (let i = 0; i < total; i++) {
    if (isBulkDownloadCancelled) {
      break;
    }

    const cb = checkboxes[i];
    const index = Number(cb.dataset.index);
    const video = currentPlaylistVideos[index];
    if (!video) continue;

    const card = cb.closest('.bulk-video-card');
    const cardStatusLabel = card ? card.querySelector('.bulk-video-status') : null;
    const itemRow = $(`bulk-progress-item-${index}`);
    const itemStatusLabel = itemRow ? itemRow.querySelector('.bulk-item-status') : null;

    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    if (cardStatusLabel) {
      cardStatusLabel.textContent = 'Đang tải...';
      cardStatusLabel.style.color = 'var(--accent)';
    }
    if (itemStatusLabel) {
      itemStatusLabel.textContent = 'Đang tải...';
      itemStatusLabel.style.color = 'var(--accent)';
    }
    statusLabel.textContent = `Đang tải: ${video.title || 'Video ' + video.id}`;

    activeBulkDownloadController = new AbortController();

    try {
      const select = $(`format-select-${index}`);
      const formatId = select ? select.value : '';
      const subtitleSize = document.querySelector('input[name="subtitleSize"]')?.value || 18;
      const subtitleMarginH = document.querySelector('input[name="subtitleMarginH"]')?.value || 20;
      const subtitleMaxLines = document.querySelector('[name="subtitleMaxLines"]')?.value || 0;
      const geminiApiKey = localStorage.getItem('geminiApiKey') || '';

      const res = await fetch('/api/download-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: video.url,
          format_id: formatId,
          geminiApiKey,
          subtitleMaxLines,
          subtitleSize,
          subtitleMarginH
        }),
        signal: activeBulkDownloadController.signal
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lỗi tải video');

      if (cardStatusLabel) {
        cardStatusLabel.textContent = 'Thành công';
        cardStatusLabel.style.color = '#10b981';
      }
      if (itemStatusLabel) {
        itemStatusLabel.textContent = 'Thành công';
        itemStatusLabel.style.color = '#10b981';
      }
      ok++;
      
      const thumbUrl = video.thumbnail || (video.id && (video.url.includes('youtube.com') || video.url.includes('youtu.be')) ? `https://img.youtube.com/vi/${video.id}/mqdefault.jpg` : '');
      addDownloadHistory(video.title, thumbUrl, 'success', data.filename || `${video.title || video.id}.mp4`, 'Kênh/Playlist');
      
    } catch (err) {
      if (err.name === 'AbortError' || isBulkDownloadCancelled) {
        if (cardStatusLabel) {
          cardStatusLabel.textContent = 'Đã hủy';
          cardStatusLabel.style.color = 'var(--muted)';
        }
        if (itemStatusLabel) {
          itemStatusLabel.textContent = 'Đã hủy';
          itemStatusLabel.style.color = 'var(--muted)';
        }
        // Mark remaining items as cancelled
        for (let j = i + 1; j < total; j++) {
          const nextCb = checkboxes[j];
          const nextIndex = Number(nextCb.dataset.index);
          const nextItemRow = $(`bulk-progress-item-${nextIndex}`);
          const nextItemStatus = nextItemRow ? nextItemRow.querySelector('.bulk-item-status') : null;
          if (nextItemStatus) {
            nextItemStatus.textContent = 'Đã hủy';
            nextItemStatus.style.color = 'var(--muted)';
          }
        }
        break;
      }

      if (cardStatusLabel) {
        cardStatusLabel.textContent = 'Thất bại';
        cardStatusLabel.style.color = '#ef4444';
      }
      if (itemStatusLabel) {
        itemStatusLabel.textContent = 'Thất bại';
        itemStatusLabel.style.color = '#ef4444';
      }
      fail++;

      const thumbUrl = video.thumbnail || (video.id && (video.url.includes('youtube.com') || video.url.includes('youtu.be')) ? `https://img.youtube.com/vi/${video.id}/mqdefault.jpg` : '');
      addDownloadHistory(video.title, thumbUrl, 'failed', '', 'Kênh/Playlist');
    } finally {
      activeBulkDownloadController = null;
    }
    
    const progressPercent = Math.round(((i + 1) / total) * 100);
    percentLabel.textContent = `${progressPercent}%`;
    progressBar.style.width = `${progressPercent}%`;
    statsLabel.textContent = `Tiến trình: ${i + 1}/${total} video (Thành công: ${ok}, Thất bại: ${fail})`;
  }

  if (isBulkDownloadCancelled) {
    statusLabel.textContent = 'Đã hủy tải hàng loạt';
    statusLabel.style.color = '#ef4444';
    // Mark items that were still "Đang chờ..." as "Đã hủy"
    checkboxes.forEach(cb => {
      const index = Number(cb.dataset.index);
      const itemRow = $(`bulk-progress-item-${index}`);
      const itemStatusLabel = itemRow ? itemRow.querySelector('.bulk-item-status') : null;
      if (itemStatusLabel && itemStatusLabel.textContent === 'Đang chờ...') {
        itemStatusLabel.textContent = 'Đã hủy';
        itemStatusLabel.style.color = 'var(--muted)';
      }
    });
    stats.textContent = `Đã hủy tải hàng loạt. Thành công ${ok}, lỗi ${fail}.`;
    toast('Đã hủy tải hàng loạt.', 'warn');
  } else {
    statusLabel.textContent = 'Hoàn thành';
    statusLabel.style.color = '#10b981';
    stats.textContent = `Hoàn thành tải hàng loạt. Thành công ${ok}, lỗi ${fail}.`;
    toast(`Hoàn thành tải hàng loạt. Thành công ${ok}, lỗi ${fail}.`, 'info');
  }
  
  setBusy(dlBtn, false);
  $('bulk-fetch-btn').disabled = false;
  $('bulk-url-input').disabled = false;
  $('bulk-limit').disabled = false;
  document.querySelectorAll('.bulk-video-checkbox').forEach(cb => cb.disabled = false);
  document.querySelectorAll('.bulk-item-download-btn').forEach(b => b.disabled = false);

  // Update modal buttons
  $('bulk-download-modal-cancel-btn').classList.add('hidden');
  $('bulk-download-modal-close-action-btn').classList.remove('hidden');

  await loadAssets();
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
    
    const onMetadataLoaded = () => {
      updateSubtitleOverlayFromInputs();
      if (typeof updateBlurBoxPreview === 'function') {
        updateBlurBoxPreview();
      }
    };

    if (video.readyState >= 1) {
      onMetadataLoaded();
    } else {
      video.onloadedmetadata = onMetadataLoaded;
    }
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

function updateInputsFromSubtitlePosition(left, top, dragWidth, dragHeight) {
  const video = $('studio-video-preview');
  
  if (!video) return;
  
  const W_act = video.videoWidth || 1080;
  const H_act = video.videoHeight || 1920;
  
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
  const video = $('studio-video-preview');
  const container = $('konva-stage-container');
  if (!video || !container) return;

  if (!video.src || video.src === '') {
    if (konvaStage) {
      konvaStage.destroy();
      konvaStage = null;
    }
    return;
  }

  const containerRect = video.parentElement.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) return;

  const videoRect = getVideoContentRect(video);
  const W_act = video.videoWidth || 1080;
  const H_act = video.videoHeight || 1920;
  const font_scale = videoRect.height / H_act;
  console.log(`[Overlay] updateSubtitleOverlayFromInputs: videoWidth=${video.videoWidth}, videoHeight=${video.videoHeight}, videoRect.height=${videoRect.height}, font_scale=${font_scale}`);

  // Căn chỉnh và tỷ lệ container của stage khớp chính xác với video đang hiển thị
  container.style.left = (videoRect.left - containerRect.left) + 'px';
  container.style.top = (videoRect.top - containerRect.top) + 'px';
  container.style.width = W_act + 'px';
  container.style.height = H_act + 'px';
  container.style.transform = `scale(${font_scale})`;
  container.style.transformOrigin = 'top left';
  container.style.pointerEvents = 'auto'; // Cho phép tương tác Konva Stage

  // Khởi tạo Stage và Layer nếu chưa có
  if (!konvaStage) {

    konvaStage = new Konva.Stage({
      container: 'konva-stage-container',
      width: W_act,
      height: H_act
    });

    konvaLayer = new Konva.Layer();
    konvaStage.add(konvaLayer);

    vGuideline = new Konva.Line({
      points: [0, 0, 0, 0],
      stroke: '#FF3B30',
      strokeWidth: 3,
      dash: [6, 6],
      visible: false,
      listening: false
    });
    hGuideline = new Konva.Line({
      points: [0, 0, 0, 0],
      stroke: '#FF3B30',
      strokeWidth: 3,
      dash: [6, 6],
      visible: false,
      listening: false
    });
    konvaLayer.add(vGuideline);
    konvaLayer.add(hGuideline);

    // 1. Phụ đề (Subtitle)
    konvaSubtitle = new Konva.Group({
      name: 'subtitle',
      draggable: true
    });
    
    const subText = new Konva.Text({
      id: 'sub-text',
      text: 'Phụ đề mẫu',
      fontSize: 18,
      fontFamily: 'Arial',
      fill: '#FFFFFF',
      align: 'center'
    });

    const subBg = new Konva.Rect({
      id: 'sub-bg',
      fill: 'transparent'
    });

    konvaSubtitle.add(subBg);
    konvaSubtitle.add(subText);
    konvaLayer.add(konvaSubtitle);

    // 2. Reaction PIP
    konvaReaction = new Konva.Group({
      name: 'reaction',
      draggable: true
    });

    const rxVideoElement = $('preview-reaction-video');
    const rxVideoImage = new Konva.Image({
      id: 'rx-video-image',
      image: rxVideoElement,
      draggable: false
    });

    const rxRect = new Konva.Rect({
      id: 'rx-rect',
      stroke: '#FF9800',
      strokeWidth: 4,
      fill: 'transparent',
      dash: [10, 5]
    });

    const rxText = new Konva.Text({
      id: 'rx-text',
      text: 'Reaction PIP (Kéo & Co giãn)',
      fontSize: 18,
      fontFamily: 'Arial',
      fill: '#FF9800',
      align: 'center',
      verticalAlign: 'middle'
    });

    konvaReaction.add(rxVideoImage);
    konvaReaction.add(rxRect);
    konvaReaction.add(rxText);
    konvaLayer.add(konvaReaction);

    // Vòng lặp vẽ lại liên tục khi video reaction chơi để cập nhật khung hình
    const rxAnim = new Konva.Animation(() => {}, konvaLayer);
    rxVideoElement.addEventListener('play', () => rxAnim.start());
    rxVideoElement.addEventListener('pause', () => rxAnim.stop());
    rxVideoElement.addEventListener('seeked', () => konvaLayer.batchDraw());
    if (!rxVideoElement.paused) {
      rxAnim.start();
    }

    // 3. Blur Box
    konvaBlur = new Konva.Shape({
      name: 'blur',
      draggable: true,
      stroke: '#00E5FF',
      strokeWidth: 4,
      fill: 'transparent',
      dash: [10, 5],
      sceneFunc: function (context, shape) {
        const ctx = context._context;
        const w = shape.width();
        const h = shape.height();
        
        ctx.save();
        
        // 1. Vẽ nội dung video đã làm mờ
        const mainVideo = $('studio-video-preview');
        if (mainVideo && mainVideo.readyState >= 2) {
          ctx.beginPath();
          ctx.rect(0, 0, w, h);
          ctx.clip();
          
          const x = shape.x();
          const y = shape.y();
          const radius = Number($('blur-radius-slider')?.value || 20);
          ctx.filter = `blur(${radius}px)`;
          
          ctx.drawImage(
            mainVideo,
            x, y, w, h,
            0, 0, w, h
          );
        } else {
          ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
          ctx.fillRect(0, 0, w, h);
        }
        
        ctx.restore();
        
        // 2. Vẽ viền nét đứt bên ngoài (không bị clip)
        context.fillStrokeShape(shape);
      }
    });
    konvaLayer.add(konvaBlur);

    // Vòng lặp vẽ lại liên tục khi video chính chơi để cập nhật khung hình mờ
    const mainAnim = new Konva.Animation(() => {}, konvaLayer);
    const mainVideoElement = $('studio-video-preview');
    mainVideoElement.addEventListener('play', () => mainAnim.start());
    mainVideoElement.addEventListener('pause', () => mainAnim.stop());
    mainVideoElement.addEventListener('seeked', () => konvaLayer.batchDraw());
    mainVideoElement.addEventListener('timeupdate', () => konvaLayer.batchDraw());
    if (!mainVideoElement.paused) {
      mainAnim.start();
    }

    // Transformer co giãn
    konvaTransformer = new Konva.Transformer({
      nodes: [],
      rotateEnabled: false,
      enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
      boundBoxFunc: (oldBox, newBox) => {
        if (newBox.width < 50 || newBox.height < 20) {
          return oldBox;
        }
        return newBox;
      }
    });
    konvaLayer.add(konvaTransformer);

    // Xử lý sự kiện click trên Stage để chọn đối tượng hoặc chuyển tiếp click cho các control dưới canvas
    konvaStage.on('mousedown touchstart', (e) => {
      if (e.target === konvaStage) {
        konvaTransformer.nodes([]);
        konvaLayer.draw();

        // 1. Tạm thời cho phép click xuyên qua để tìm phần tử bên dưới
        container.style.pointerEvents = 'none';

        let clientX = e.evt.clientX;
        let clientY = e.evt.clientY;
        if (e.evt.touches && e.evt.touches[0]) {
          clientX = e.evt.touches[0].clientX;
          clientY = e.evt.touches[0].clientY;
        }

        let clickedEl = null;
        if (clientX !== undefined && clientY !== undefined) {
          clickedEl = document.elementFromPoint(clientX, clientY);
        }

        container.style.pointerEvents = 'auto';

        // 2. Chuyển tiếp sự kiện nếu click vào các control của safezone (mute, play/pause, timeline)
        if (clickedEl && (
          clickedEl.closest('.safezone-action-mute') ||
          clickedEl.closest('.safezone-action-playpause') ||
          clickedEl.closest('.safezone-timeline-container') ||
          clickedEl.tagName === 'INPUT' ||
          clickedEl.tagName === 'BUTTON'
        )) {
          const eventType = e.evt.type;
          let clonedEvent;
          if (typeof window.TouchEvent !== 'undefined' && e.evt instanceof TouchEvent) {
            clonedEvent = new TouchEvent(eventType, e.evt);
          } else {
            clonedEvent = new MouseEvent(eventType, e.evt);
          }
          clickedEl.dispatchEvent(clonedEvent);
        } else {
          // Play/Pause video nếu click ngoài vùng control
          const previewVideo = $('studio-video-preview');
          if (previewVideo && previewVideo.src) {
            if (previewVideo.paused) {
              previewVideo.play().catch(() => {});
            } else {
              previewVideo.pause();
            }
          }
        }
        return;
      }

      // Nếu click vào chính Transformer hoặc các anchor của nó, không thay đổi selection
      let isTransformer = false;
      let check = e.target;
      while (check && check !== konvaStage) {
        if (check === konvaTransformer) {
          isTransformer = true;
          break;
        }
        check = check.parent;
      }
      if (isTransformer) return;

      // Tìm đối tượng được chọn (Subtitle, Reaction, hoặc Blur)
      let clickedNode = null;
      let curr = e.target;
      while (curr && curr !== konvaStage) {
        if (curr.name() === 'subtitle' || curr.name() === 'reaction' || curr.name() === 'blur') {
          clickedNode = curr;
          break;
        }
        curr = curr.parent;
      }

      if (clickedNode) {
        // Cấu hình các điểm neo transformer tùy thuộc vào đối tượng được chọn
        if (clickedNode.name() === 'blur') {
          konvaTransformer.enabledAnchors([
            'top-left', 'top-center', 'top-right',
            'middle-right',
            'bottom-right', 'bottom-center', 'bottom-left',
            'middle-left'
          ]);
        } else if (clickedNode.name() === 'subtitle') {
          // Phụ đề cho phép kéo góc và kéo cạnh bên (ngang) để chỉnh độ rộng khung chữ
          konvaTransformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right']);
        } else {
          // Reaction chỉ kéo góc để tránh méo tỷ lệ khung hình video
          konvaTransformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
        }
        konvaTransformer.nodes([clickedNode]);
        konvaLayer.draw();
      } else {
        konvaTransformer.nodes([]);
        konvaLayer.draw();
      }
    });

    const applySnapping = (node, w, h, currentX, currentY) => {
      let x = currentX;
      let y = currentY;
      
      const stageW = konvaStage.width();
      const stageH = konvaStage.height();
      
      const SNAP_THRESHOLD = 8;
      const stageCenterX = Math.round(stageW / 2);
      const stageCenterY = Math.round(stageH / 2);
      
      const centerX = x + w / 2;
      const centerY = y + h / 2;
      
      let snappedX = false;
      let snappedY = false;
      
      if (Math.abs(centerX - stageCenterX) < SNAP_THRESHOLD) {
        x = stageCenterX - w / 2;
        snappedX = true;
      }
      
      if (Math.abs(centerY - stageCenterY) < SNAP_THRESHOLD) {
        y = stageCenterY - h / 2;
        snappedY = true;
      }
      
      console.log(`[Snapping] node=${node.name()}, w=${w}, h=${h}, x=${x}, y=${y}, stageCenterX=${stageCenterX}, stageCenterY=${stageCenterY}, centerX=${centerX}, centerY=${centerY}, snappedX=${snappedX}, snappedY=${snappedY}`);

      // Cập nhật đường căn dọc
      if (vGuideline) {
        if (snappedX) {
          vGuideline.points([stageCenterX, 0, stageCenterX, stageH]);
          vGuideline.visible(true);
          vGuideline.moveToTop();
          console.log(`[Snapping] Show vertical guideline at ${stageCenterX}, stageH=${stageH}`);
        } else {
          vGuideline.visible(false);
        }
      }
      
      // Cập nhật đường căn ngang
      if (hGuideline) {
        if (snappedY) {
          hGuideline.points([0, stageCenterY, stageW, stageCenterY]);
          hGuideline.visible(true);
          hGuideline.moveToTop();
          console.log(`[Snapping] Show horizontal guideline at ${stageCenterY}, stageW=${stageW}`);
        } else {
          hGuideline.visible(false);
        }
      }
      
      if (konvaLayer) {
        konvaLayer.draw();
      }
      
      return { x, y };
    };

    const hideGuidelines = () => {
      if (vGuideline) vGuideline.visible(false);
      if (hGuideline) hGuideline.visible(false);
      if (konvaLayer) konvaLayer.draw();
    };

    // Kéo phụ đề
    konvaSubtitle.on('dragmove', () => {
      const subTextNode = konvaSubtitle.findOne('#sub-text');
      const w = subTextNode.width();
      const h = subTextNode.height();
      
      let x = konvaSubtitle.x();
      let y = konvaSubtitle.y();
      
      const stageW = konvaStage.width();
      const stageH = konvaStage.height();
      
      // Giới hạn trong khung hình trước khi hít
      x = Math.max(0, Math.min(x, stageW - w));
      y = Math.max(0, Math.min(y, stageH - h));
      
      // Tự bắt dính căn giữa
      const snapped = applySnapping(konvaSubtitle, w, h, x, y);
      x = snapped.x;
      y = snapped.y;
      
      konvaSubtitle.position({ x, y });

      updateInputsFromSubtitlePosition(x, y, w, h);
    });

    konvaSubtitle.on('dragend', () => {
      hideGuidelines();
    });

    // Co giãn phụ đề
    konvaSubtitle.on('transform', () => {
      const subTextNode = konvaSubtitle.findOne('#sub-text');
      let scaleX = konvaSubtitle.scaleX();
      let newW = subTextNode.width() * scaleX;
      
      const fontSizeInput = document.querySelector('input[name="subtitleSize"]');
      const fontSizeVal = fontSizeInput ? (parseInt(fontSizeInput.value) || 32) : 32;
      
      const stageW = konvaStage.width();
      let newMarginH = Math.round((stageW - newW) / 2);
      newMarginH = Math.max(10, Math.min(newMarginH, Math.floor(stageW / 2) - 50));
      
      const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
      if (marginHInput) marginHInput.value = newMarginH;

      konvaSubtitle.scaleX(1);
      konvaSubtitle.scaleY(1);

      updateSubtitleOverlayFromInputs();
    });

    // Kéo & co giãn Reaction PIP
    konvaReaction.on('dragmove transform', () => {
      const rxRectNode = konvaReaction.findOne('#rx-rect');
      let scaleX = konvaReaction.scaleX();
      let scaleY = konvaReaction.scaleY();
      
      let w = rxRectNode.width() * scaleX;
      let h = rxRectNode.height() * scaleY;
      let x = konvaReaction.x();
      let y = konvaReaction.y();

      const stageW = konvaStage.width();
      const stageH = konvaStage.height();

      const minSize = 20;
      if (scaleX !== 1 || scaleY !== 1) {
        // Resizing - keep aspect ratio and clamp boundaries
        const aspect = w / h || 4 / 3;
        if (x < 0) {
          w = Math.max(minSize, w + x);
          h = w / aspect;
          x = 0;
        }
        if (y < 0) {
          h = Math.max(minSize, h + y);
          w = h * aspect;
          y = 0;
        }
        if (x + w > stageW) {
          w = Math.max(minSize, stageW - x);
          h = w / aspect;
        }
        if (y + h > stageH) {
          h = Math.max(minSize, stageH - y);
          w = h * aspect;
        }
      } else {
        // Dragging/moving - clamp position within active bounds
        x = Math.max(0, Math.min(x, stageW - w));
        y = Math.max(0, Math.min(y, stageH - h));

        // Tự bắt dính căn giữa
        const snapped = applySnapping(konvaReaction, w, h, x, y);
        x = snapped.x;
        y = snapped.y;
      }

      konvaReaction.position({ x, y });

      konvaReaction.scaleX(1);
      konvaReaction.scaleY(1);
      rxRectNode.width(w);
      rxRectNode.height(h);
      
      const rxVideoImageNode = konvaReaction.findOne('#rx-video-image');
      if (rxVideoImageNode) {
        rxVideoImageNode.width(w);
        rxVideoImageNode.height(h);
      }
      
      const rxTextNode = konvaReaction.findOne('#rx-text');
      rxTextNode.width(w);
      rxTextNode.height(h);

      $('reaction-x').value = Math.round(x);
      $('reaction-y').value = Math.round(y);
      
      const widthInput = document.querySelector('input[name="reactionWidth"]');
      if (widthInput) {
        widthInput.value = Math.round(w);
        const valSpan = $('reaction-width-val');
        if (valSpan) valSpan.textContent = widthInput.value + 'px';
      }

      $('preview-reaction-pip').dataset.customGeometry = 'true';
      const posSelect = document.querySelector('select[name="reactionPosition"]');
      if (posSelect) posSelect.value = 'custom';
      
      konvaLayer.draw();
    });

    konvaReaction.on('dragend', () => {
      hideGuidelines();
    });

    // Kéo & co giãn Blur Box
    konvaBlur.on('dragmove transform', () => {
      let scaleX = konvaBlur.scaleX();
      let scaleY = konvaBlur.scaleY();
      
      let w = konvaBlur.width() * scaleX;
      let h = konvaBlur.height() * scaleY;
      let x = konvaBlur.x();
      let y = konvaBlur.y();

      const stageW = konvaStage.width();
      const stageH = konvaStage.height();

      const minSize = 10;
      if (scaleX !== 1 || scaleY !== 1) {
        // Resizing - clamp position and size
        if (x < 0) {
          w = Math.max(minSize, w + x);
          x = 0;
        }
        if (y < 0) {
          h = Math.max(minSize, h + y);
          y = 0;
        }
        if (x + w > stageW) {
          w = Math.max(minSize, stageW - x);
        }
        if (y + h > stageH) {
          h = Math.max(minSize, stageH - y);
        }
      } else {
        // Dragging/moving - clamp position within active bounds
        x = Math.max(0, Math.min(x, stageW - w));
        y = Math.max(0, Math.min(y, stageH - h));

        // Tự bắt dính căn giữa
        const snapped = applySnapping(konvaBlur, w, h, x, y);
        x = snapped.x;
        y = snapped.y;
      }

      konvaBlur.position({ x, y });
      
      konvaBlur.scaleX(1);
      konvaBlur.scaleY(1);
      konvaBlur.width(w);
      konvaBlur.height(h);

      const blurX = Math.round((x / stageW) * 100);
      const blurY = Math.round((y / stageH) * 100);
      const blurW = Math.round((w / stageW) * 100);
      const blurH = Math.round((h / stageH) * 100);

      $('blur-x-input').value = Math.max(0, Math.min(100, blurX));
      $('blur-y-input').value = Math.max(0, Math.min(100, blurY));
      $('blur-width-input').value = Math.max(1, Math.min(100, blurW));
      $('blur-height-input').value = Math.max(1, Math.min(100, blurH));

      konvaLayer.draw();
    });

    konvaBlur.on('dragend', () => {
      hideGuidelines();
    });
  } else {
    konvaStage.width(W_act);
    konvaStage.height(H_act);
  }

  // 1. Cập nhật Phụ đề (Subtitle)
  const subTextNode = konvaSubtitle.findOne('#sub-text');
  const subBgNode = konvaSubtitle.findOne('#sub-bg');

  const textContentEl = $('subtitle-text-content');
  let rawText = 'Phụ đề mẫu';
  if (textContentEl && textContentEl.dataset.rawText) {
    rawText = textContentEl.dataset.rawText;
  }
  
  const fontSizeInput = Number(document.querySelector('input[name="subtitleSize"]').value || 32);
  const marginHInput = Number(document.querySelector('input[name="subtitleMarginH"]').value || 20);
  const maxLines = Number(document.querySelector('[name="subtitleMaxLines"]').value || 0);
  const boxWidth = W_act - 2 * marginHInput;
  const maxChars = Math.max(10, Math.floor(boxWidth / (fontSizeInput * 0.5)));

  let wrappedText = rawText;
  if (maxLines === 1) {
    wrappedText = rawText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  } else if (maxLines === 2) {
    wrappedText = wrapTextToTwoLines(rawText, maxChars);
  } else if (maxLines === 3) {
    wrappedText = wrapTextToThreeLines(rawText, maxChars);
  } else {
    const clean = rawText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length <= maxChars) {
      wrappedText = clean;
    } else if (clean.length <= maxChars * 1.6) {
      wrappedText = wrapTextToTwoLines(clean, maxChars);
    } else {
      wrappedText = wrapTextToThreeLines(clean, maxChars);
    }
  }

  const scaleFactor = 1.35;
  const fontSize_canvas = fontSizeInput * scaleFactor;

  subTextNode.text(wrappedText);
  subTextNode.fontSize(fontSize_canvas);
  subTextNode.fontFamily(document.querySelector('select[name="subtitleFont"]').value || 'Arial');
  subTextNode.fontStyle(document.querySelector('select[name="subtitleBold"]').value === 'true' ? 'bold' : 'normal');
  subTextNode.width(boxWidth);

  const colorInput = document.querySelector('[name="subtitleColor"]').value || '#FFFFFF';
  const themeInput = document.querySelector('select[name="subtitleTheme"]').value || 'outline';

  subTextNode.fill(colorInput);
  subTextNode.stroke(null);
  subTextNode.strokeWidth(0);
  subTextNode.shadowEnabled(false);
  subBgNode.fill('transparent');

  if (themeInput === 'box') {
    subBgNode.fill('rgba(0, 0, 0, 0.6)');
    const paddingCanvas = 4.0 * scaleFactor;
    subBgNode.width(subTextNode.width() + paddingCanvas * 3);
    subBgNode.height(subTextNode.height() + paddingCanvas * 2);
    subBgNode.x(-paddingCanvas * 1.5);
    subBgNode.y(-paddingCanvas);
    subBgNode.cornerRadius(4 * scaleFactor);
  } else if (themeInput === 'box-deep') {
    subBgNode.fill('rgba(0, 0, 0, 0.95)');
    const paddingCanvas = 4.0 * scaleFactor;
    subBgNode.width(subTextNode.width() + paddingCanvas * 3);
    subBgNode.height(subTextNode.height() + paddingCanvas * 2);
    subBgNode.x(-paddingCanvas * 1.5);
    subBgNode.y(-paddingCanvas);
    subBgNode.cornerRadius(4 * scaleFactor);
  } else if (themeInput === 'shadow') {
    const shadowSize = 2 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(shadowSize * 2);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(0.8);
    subTextNode.shadowEnabled(true);
  } else if (themeInput === 'outline-thick') {
    subTextNode.stroke('black');
    subTextNode.strokeWidth(5.0 * scaleFactor);
  } else if (themeInput === 'outline-shadow') {
    subTextNode.stroke('black');
    subTextNode.strokeWidth(2.5 * scaleFactor);
    const shadowSize = 3 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(shadowSize * 1.3);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(0.8);
    subTextNode.shadowEnabled(true);
  } else { // 'outline'
    subTextNode.stroke('black');
    subTextNode.strokeWidth(2.5 * scaleFactor);
    const shadowSize = 1 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(shadowSize * 2);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(0.8);
    subTextNode.shadowEnabled(true);
  }

  const alignment = Number(document.querySelector('[name="subtitleAlignment"]').value || 2);
  const marginVInput = Number(document.querySelector('input[name="subtitleMargin"]').value || 28);

  const dragWidth = subTextNode.width();
  const dragHeight = subTextNode.height();

  let subX = marginHInput;
  let subY = 0;

  if ([5, 6, 7].includes(alignment)) {
    subY = marginVInput;
  } else if ([9, 10, 11].includes(alignment)) {
    subY = (H_act - dragHeight) / 2;
  } else {
    subY = H_act - dragHeight - marginVInput;
  }

  if ([1, 5, 9].includes(alignment)) {
    subX = marginHInput;
  } else if ([3, 7, 11].includes(alignment)) {
    subX = W_act - dragWidth - marginHInput;
  } else {
    subX = (W_act - dragWidth) / 2;
  }

  konvaSubtitle.position({ x: subX, y: subY });
  
  const subMode = $('subtitle-mode').value;
  konvaSubtitle.visible(subMode !== 'none');

  // 2. Cập nhật Reaction PIP
  const rxMode = $('reaction-mode').value;
  if (!['upload', 'library'].includes(rxMode)) {
    konvaReaction.visible(false);
  } else {
    konvaReaction.visible(true);
    const rx = $('reaction-x').value;
    const ry = $('reaction-y').value;
    let widthInput = Number(document.querySelector('input[name="reactionWidth"]').value || 320);
    
    let ratio = 4 / 3;
    const reactionVid = $('preview-reaction-video');
    if (reactionVid && reactionVid.videoWidth && reactionVid.videoHeight) {
      ratio = reactionVid.videoHeight / reactionVid.videoWidth;
    }
    if (isNaN(ratio) || !isFinite(ratio) || ratio <= 0) {
      ratio = 4 / 3;
    }
    
    // Clamp width input to not exceed active video bounds
    widthInput = Math.max(20, Math.min(widthInput, W_act));
    let heightInput = widthInput * ratio;
    heightInput = Math.max(20, Math.min(heightInput, H_act));

    console.log(`[Overlay] Reaction PIP: rxMode=${rxMode}, rx=${rx}, ry=${ry}, width=${widthInput}, height=${heightInput}`);

    let rxX = rx !== '' ? Number(rx) : 0;
    let rxY = ry !== '' ? Number(ry) : 0;

    if (rx === '' || ry === '' || $('preview-reaction-pip').dataset.customGeometry !== 'true') {
      const position = document.querySelector('select[name="reactionPosition"]').value || 'bottom-right';
      const margin = 20;
      if (position === 'bottom-right') {
        rxX = W_act - widthInput - margin;
        rxY = H_act - heightInput - margin;
      } else if (position === 'bottom-left') {
        rxX = margin;
        rxY = H_act - heightInput - margin;
      } else if (position === 'top-right') {
        rxX = W_act - widthInput - margin;
        rxY = margin;
      } else if (position === 'top-left') {
        rxX = margin;
        rxY = margin;
      }
    }

    // Clamp coordinates to keep Reaction PIP fully within canvas
    rxX = Math.max(0, Math.min(rxX, W_act - widthInput));
    rxY = Math.max(0, Math.min(rxY, H_act - heightInput));

    konvaReaction.position({ x: rxX, y: rxY });
    
    const rxRectNode = konvaReaction.findOne('#rx-rect');
    rxRectNode.width(widthInput);
    rxRectNode.height(heightInput);
    rxRectNode.fill(reactionVid.src ? 'transparent' : 'rgba(255, 152, 0, 0.15)');

    const rxVideoImageNode = konvaReaction.findOne('#rx-video-image');
    if (rxVideoImageNode) {
      rxVideoImageNode.width(widthInput);
      rxVideoImageNode.height(heightInput);
    }

    const rxTextNode = konvaReaction.findOne('#rx-text');
    rxTextNode.width(widthInput);
    rxTextNode.height(heightInput);
    rxTextNode.visible(!reactionVid.src || reactionVid.src === '');
    
    // Update inputs to match clamped values
    $('reaction-x').value = Math.round(rxX);
    $('reaction-y').value = Math.round(rxY);
    const widthEl = document.querySelector('input[name="reactionWidth"]');
    if (widthEl) {
      widthEl.value = Math.round(widthInput);
      const valSpan = $('reaction-width-val');
      if (valSpan) valSpan.textContent = widthEl.value + 'px';
    }
  }

  // 3. Cập nhật Blur Box
  const blurCheck = $('blur-original-sub');
  if (!blurCheck || !blurCheck.checked) {
    konvaBlur.visible(false);
  } else {
    konvaBlur.visible(true);
    let bxPercent = Math.max(0, Math.min(100, Number($('blur-x-input').value || 10)));
    let byPercent = Math.max(0, Math.min(100, Number($('blur-y-input').value || 75)));
    let bwPercent = Math.max(1, Math.min(100, Number($('blur-width-input').value || 80)));
    let bhPercent = Math.max(1, Math.min(100, Number($('blur-height-input').value || 15)));

    if (bxPercent + bwPercent > 100) {
      bwPercent = 100 - bxPercent;
    }
    if (byPercent + bhPercent > 100) {
      bhPercent = 100 - byPercent;
    }

    // Sync input values with clamped percentages
    $('blur-x-input').value = bxPercent;
    $('blur-y-input').value = byPercent;
    $('blur-width-input').value = bwPercent;
    $('blur-height-input').value = bhPercent;

    const blurX = (bxPercent / 100) * W_act;
    const blurY = (byPercent / 100) * H_act;
    const blurW = (bwPercent / 100) * W_act;
    const blurH = (bhPercent / 100) * H_act;
    console.log(`[Overlay] Blur Box: bxPercent=${bxPercent}, byPercent=${byPercent}, bwPercent=${bwPercent}, bhPercent=${bhPercent}, blurX=${blurX}, blurY=${blurY}, blurW=${blurW}, blurH=${blurH}`);

    konvaBlur.position({ x: blurX, y: blurY });
    konvaBlur.width(blurW);
    konvaBlur.height(blurH);
  }

  konvaLayer.draw();
}

function updateBlurBoxPreview() {
  updateSubtitleOverlayFromInputs();
}

function updateReactionPreview() {
  const reactionVid = $('preview-reaction-video');
  const reactionMode = $('reaction-mode').value;
  const mainVideo = $('studio-video-preview');
  if (reactionVid) {
    if (['upload', 'library'].includes(reactionMode) && mainVideo && mainVideo.src) {
      // Đồng bộ trạng thái chơi video reaction
    } else {
      reactionVid.pause();
    }
  }
  updateSubtitleOverlayFromInputs();
}

function initDraggableSubtitle() {
  // Đã chuyển sang xử lý kéo thả của Konva
}

function initDraggableReaction() {
  // Đã chuyển sang xử lý kéo thả của Konva
}

function initDraggableBlurBox() {
  // Đã chuyển sang xử lý kéo thả của Konva
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
const selectAllCheck = $('bulk-select-all');
if (selectAllCheck) {
  selectAllCheck.addEventListener('change', (e) => {
    const checked = e.target.checked;
    document.querySelectorAll('.bulk-video-checkbox').forEach(cb => {
      cb.checked = checked;
    });
  });
}
const bulkDlBtn = $('bulk-download-selected-btn');
if (bulkDlBtn) {
  bulkDlBtn.addEventListener('click', downloadSelectedBulkVideos);
}
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
  'subtitleColor', 'subtitleBold', 'subtitleMaxLines', 'reactionPosition', 'reactionWidth',
  'blurX', 'blurY', 'blurWidth', 'blurHeight'
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
const presetContainer = $('subtitle-presets-container') || $('subtitle-presets-grid');
if (presetContainer) {
  const presets = {
    // Row 1: Viền Dày (Impact Bold, Outline Thick)
    'thick-white': { color: '#FFFFFF', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    'thick-yellow': { color: '#FFEB3B', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    'thick-cyan': { color: '#00E5FF', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    'thick-green': { color: '#00FF00', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    'thick-pink': { color: '#FF4081', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    'thick-red': { color: '#FF0000', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    'thick-orange': { color: '#FF9800', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },
    'thick-black': { color: '#000000', theme: 'outline-thick', font: 'Impact', bold: 'true', size: 32 },

    // Row 2: Hộp Nền (Arial Bold, Box)
    'box-white': { color: '#FFFFFF', theme: 'box', font: 'Arial', bold: 'true', size: 22 },
    'box-yellow': { color: '#FFEB3B', theme: 'box', font: 'Arial', bold: 'true', size: 22 },
    'box-cyan': { color: '#00E5FF', theme: 'box', font: 'Arial', bold: 'true', size: 22 },
    'box-green': { color: '#00FF00', theme: 'box', font: 'Arial', bold: 'true', size: 22 },
    'box-pink': { color: '#FF4081', theme: 'box', font: 'Arial', bold: 'true', size: 22 },
    'box-red': { color: '#FF0000', theme: 'box', font: 'Arial', bold: 'true', size: 22 },
    'box-orange': { color: '#FF9800', theme: 'box', font: 'Arial', bold: 'true', size: 22 },
    'box-black': { color: '#000000', theme: 'box', font: 'Arial', bold: 'true', size: 22 },

    // Row 3: Hộp Nền Đen Sâu (Arial Bold, Box Deep)
    'boxdeep-white': { color: '#FFFFFF', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },
    'boxdeep-yellow': { color: '#FFEB3B', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },
    'boxdeep-cyan': { color: '#00E5FF', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },
    'boxdeep-green': { color: '#00FF00', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },
    'boxdeep-pink': { color: '#FF4081', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },
    'boxdeep-red': { color: '#FF0000', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },
    'boxdeep-orange': { color: '#FF9800', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },
    'boxdeep-black': { color: '#000000', theme: 'box-deep', font: 'Arial', bold: 'true', size: 22 },

    // Row 4: Đổ Bóng (Tahoma Bold, Shadow)
    'shadow-white': { color: '#FFFFFF', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },
    'shadow-yellow': { color: '#FFEB3B', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },
    'shadow-cyan': { color: '#00E5FF', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },
    'shadow-green': { color: '#00FF00', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },
    'shadow-pink': { color: '#FF4081', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },
    'shadow-red': { color: '#FF0000', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },
    'shadow-orange': { color: '#FF9800', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },
    'shadow-black': { color: '#000000', theme: 'shadow', font: 'Tahoma', bold: 'true', size: 24 },

    // Row 4: Viền Mỏng (Arial Bold, Outline)
    'thin-white': { color: '#FFFFFF', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-yellow': { color: '#FFEB3B', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-cyan': { color: '#00E5FF', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-green': { color: '#00FF00', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-pink': { color: '#FF4081', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-red': { color: '#FF0000', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-orange': { color: '#FF9800', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-black': { color: '#000000', theme: 'outline', font: 'Arial', bold: 'true', size: 24 }
  };
  
  presetContainer.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', () => {
      presetContainer.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
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
  // Đã chuyển sang xử lý kéo thả của Konva
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
      const mode = btn.dataset.subMode;
      input.value = mode;
      
      // Automatically center subtitle overlay when any active subtitle mode is selected
      if (mode !== 'none') {
        const alignInput = $('subtitle-alignment-input');
        if (alignInput) {
          alignInput.value = '10';
        }
        const alignGrid = $('alignment-visual-grid');
        if (alignGrid) {
          alignGrid.querySelectorAll('.grid-cell').forEach(c => {
            c.classList.toggle('active', c.dataset.align === '10');
          });
        }
      }
      
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

// ==========================================
// QUẢN LÝ LINK VÀ KÊNH ĐÃ LƯU
// ==========================================
let savedLinks = [];
let savedChannels = [];

function loadSavedLinks() {
  try {
    const data = localStorage.getItem('savedLinks');
    savedLinks = data ? JSON.parse(data) : [];
  } catch (e) {
    console.error('Lỗi khi đọc savedLinks:', e);
    savedLinks = [];
  }
  renderSavedLinks();
}

function saveSavedLinks() {
  localStorage.setItem('savedLinks', JSON.stringify(savedLinks));
}

function getFriendlyNameFromUrl(url) {
  let domain = 'Link';
  if (/youtube\.com|youtu\.be/i.test(url)) {
    domain = 'YouTube';
  } else if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) {
    domain = 'Facebook';
  } else if (/tiktok\.com/i.test(url)) {
    domain = 'TikTok';
  } else if (/douyin\.com|iesdouyin\.com/i.test(url)) {
    domain = 'Douyin';
  } else if (/xiaohongshu\.com|xhslink\.com/i.test(url)) {
    domain = 'Xiaohongshu';
  }

  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    if (path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    const lastPart = path.split('/').pop();
    if (lastPart && lastPart.length > 0) {
      const decoded = decodeURIComponent(lastPart);
      return `[${domain}] ${decoded.substring(0, 24)}`;
    }
  } catch (e) {}

  const d = new Date();
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  return `[${domain}] ${timeStr}`;
}

function saveCurrentLink() {
  const urlInput = $('url-input');
  if (!urlInput) return;
  const rawText = urlInput.value.trim();
  
  let url = rawText;
  const match = url.match(/https?:\/\/[^\s]+/);
  if (match) {
    url = match[0];
    urlInput.value = url;
  }
  if (!url) {
    toast('Vui lòng nhập link video để lưu.', 'error');
    return;
  }
  if (!isValidVideoUrl(url)) {
    toast('Link video không hợp lệ.', 'error');
    return;
  }

  // Check duplicate
  if (savedLinks.some(item => item.url === url)) {
    toast('Link này đã được lưu trước đó.', 'warn');
    return;
  }

  let displayName = '';
  const titleEl = $('video-title');
  const card = $('video-card');
  if (card && !card.classList.contains('hidden') && titleEl && titleEl.textContent && url === currentUrl) {
    displayName = titleEl.textContent;
  } else {
    displayName = extractTitleFromPastedText(rawText) || getFriendlyNameFromUrl(url);
  }

  const newItem = {
    id: Date.now().toString(),
    url: url,
    name: displayName,
    timestamp: Date.now()
  };

  savedLinks.unshift(newItem);
  currentSavedLinkPage = 1;
  saveSavedLinks();
  renderSavedLinks();
  toast('⭐ Đã lưu link thành công', 'success');

  // Tự động quét lấy tiêu đề thực tế ngầm từ YouTube nếu đang lưu bằng tên tạm
  const tempName = getFriendlyNameFromUrl(url);
  if (displayName === tempName) {
    fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    .then(res => {
      if (!res.ok) throw new Error();
      return res.json();
    })
    .then(data => {
      if (data && data.title) {
        const item = savedLinks.find(i => i.url === url);
        if (item) {
          item.name = data.title;
          saveSavedLinks();
          renderSavedLinks();
        }
      }
    })
    .catch(err => console.error('Lỗi lấy tiêu đề chạy ngầm:', err));
  }
}

function deleteSavedLink(id) {
  savedLinks = savedLinks.filter(item => item.id !== id);
  saveSavedLinks();
  const totalPages = Math.ceil(savedLinks.length / savedLinksPerPage) || 1;
  if (currentSavedLinkPage > totalPages) {
    currentSavedLinkPage = totalPages;
  }
  renderSavedLinks();
  toast('Đã xóa link đã lưu', 'info');
}

function loadSavedLink(url) {
  const urlInput = $('url-input');
  if (urlInput) {
    urlInput.value = url;
    urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    urlInput.focus();
    fetchVideoInfo();
  }
}

function renderSavedLinks() {
  const container = $('saved-links-container');
  const list = $('saved-links-list');
  const paginationContainer = $('saved-links-pagination');
  if (!container || !list) return;

  if (savedLinks.length === 0) {
    container.style.display = 'none';
    list.innerHTML = '';
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = '';
  if (paginationContainer) paginationContainer.innerHTML = '';

  const totalPages = Math.ceil(savedLinks.length / savedLinksPerPage);
  if (currentSavedLinkPage > totalPages) {
    currentSavedLinkPage = totalPages;
  }
  if (currentSavedLinkPage < 1) {
    currentSavedLinkPage = 1;
  }

  const paginatedItems = savedLinks.slice((currentSavedLinkPage - 1) * savedLinksPerPage, currentSavedLinkPage * savedLinksPerPage);

  paginatedItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'saved-item';
    card.style = 'display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; gap: 10px; transition: all 0.15s;';
    card.innerHTML = `
      <div style="flex: 1; min-width: 0; cursor: pointer;" onclick="loadSavedLink('${item.url}')" title="Nhấn để tải video này">
        <div style="font-size: 12.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.name}</div>
        <div style="font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;">${item.url}</div>
      </div>
      <button type="button" class="rendered-card-btn rendered-btn-delete" style="padding: 4px 8px; font-size: 11px; height: 26px; min-height: 26px; display: inline-flex; align-items: center; margin: 0;" onclick="deleteSavedLink('${item.id}'); event.stopPropagation();">🗑️</button>
    `;
    list.appendChild(card);
  });

  renderPaginationControls('saved-links-pagination', currentSavedLinkPage, totalPages, (newPage) => {
    currentSavedLinkPage = newPage;
    renderSavedLinks();
  });
}

function loadSavedChannels() {
  try {
    const data = localStorage.getItem('savedChannels');
    savedChannels = data ? JSON.parse(data) : [];
  } catch (e) {
    console.error('Lỗi khi đọc savedChannels:', e);
    savedChannels = [];
  }
  renderSavedChannels();
}

function saveSavedChannels() {
  localStorage.setItem('savedChannels', JSON.stringify(savedChannels));
}

function saveCurrentChannel() {
  const urlInput = $('bulk-url-input');
  if (!urlInput) return;
  const rawText = urlInput.value.trim();

  let url = rawText;
  const match = url.match(/https?:\/\/[^\s]+/);
  if (match) {
    url = match[0];
    urlInput.value = url;
  }
  if (!url) {
    toast('Vui lòng nhập link kênh hoặc playlist để lưu.', 'error');
    return;
  }

  // Check duplicate
  if (savedChannels.some(item => item.url === url)) {
    toast('Kênh/playlist này đã được lưu trước đó.', 'warn');
    return;
  }

  const displayName = extractTitleFromPastedText(rawText) || getFriendlyNameFromUrl(url);

  const newItem = {
    id: Date.now().toString(),
    url: url,
    name: displayName,
    timestamp: Date.now()
  };

  savedChannels.unshift(newItem);
  saveSavedChannels();
  renderSavedChannels();
  toast('⭐ Đã lưu kênh thành công', 'success');
}

function deleteSavedChannel(id) {
  savedChannels = savedChannels.filter(item => item.id !== id);
  saveSavedChannels();
  renderSavedChannels();
  toast('Đã xóa kênh đã lưu', 'info');
}

function loadSavedChannel(url) {
  const urlInput = $('bulk-url-input');
  if (urlInput) {
    urlInput.value = url;
    urlInput.focus();
    fetchPlaylistInfo();
  }
}

function renderSavedChannels() {
  const container = $('saved-channels-container');
  const list = $('saved-channels-list');
  if (!container || !list) return;

  if (savedChannels.length === 0) {
    container.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = '';

  savedChannels.forEach(item => {
    const card = document.createElement('div');
    card.className = 'saved-item';
    card.style = 'display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; gap: 10px; transition: all 0.15s;';
    card.innerHTML = `
      <div style="flex: 1; min-width: 0; cursor: pointer;" onclick="loadSavedChannel('${item.url}')" title="Nhấn để nạp link kênh">
        <div style="font-size: 12.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.name}</div>
        <div style="font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;">${item.url}</div>
      </div>
      <button type="button" class="rendered-card-btn rendered-btn-delete" style="padding: 4px 8px; font-size: 11px; height: 26px; min-height: 26px; display: inline-flex; align-items: center; margin: 0;" onclick="deleteSavedChannel('${item.id}'); event.stopPropagation();">🗑️</button>
    `;
    list.appendChild(card);
  });
}

// Hàm quản lý hiển thị và hủy tải hàng loạt
function openBulkDownloadModal() {
  const modal = $('bulk-download-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeBulkDownloadModal() {
  const modal = $('bulk-download-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
  const cancelBtn = $('bulk-download-modal-cancel-btn');
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Hủy tải hàng loạt';
  }
}

function cancelBulkDownload() {
  isBulkDownloadCancelled = true;
  if (activeBulkDownloadController) {
    activeBulkDownloadController.abort();
  }
  toast('Đang hủy tải hàng loạt...', 'info');
  const cancelBtn = $('bulk-download-modal-cancel-btn');
  if (cancelBtn) {
    cancelBtn.disabled = true;
    cancelBtn.textContent = '⏳ Đang hủy...';
  }
}

// Khởi chạy nạp danh sách đã lưu
loadSavedLinks();
loadSavedChannels();

// Xuất các hàm ra ngoài window để các phần tử HTML onclick gọi được
window.saveCurrentLink = saveCurrentLink;
window.deleteSavedLink = deleteSavedLink;
window.loadSavedLink = loadSavedLink;
window.saveCurrentChannel = saveCurrentChannel;
window.deleteSavedChannel = deleteSavedChannel;
window.loadSavedChannel = loadSavedChannel;
window.downloadSingleBulkVideo = downloadSingleBulkVideo;
window.downloadSelectedBulkVideos = downloadSelectedBulkVideos;
window.openBulkDownloadModal = openBulkDownloadModal;
window.closeBulkDownloadModal = closeBulkDownloadModal;
window.cancelBulkDownload = cancelBulkDownload;


