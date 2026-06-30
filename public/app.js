const views = {
  download: {
    title: 'Tải video',
    desc: 'Dán link video đơn lẻ hoặc link kênh/playlist để tải về thư mục downloads.'
  },
  studio: {
    title: 'Studio render',
    desc: 'Dịch tiếng Việt, chèn sub, thêm voiceover hoặc nhạc nền rồi render ra MP4.'
  },
  library: {
    title: 'Thư viện',
    desc: 'Quản lý các tài nguyên của bạn: Video đã render, giọng lồng tiếng, và nhạc nền.'
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
let currentBulkPage = 1;
const bulkVideosPerPage = 10;
let currentPlaylistVideos = [];
let currentSavedChannelPage = 1;
const savedChannelsPerPage = 5;
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

// Timed multiple blur boxes variables
let blurBoxes = [];
let activeBlurBoxId = null;

const $ = (id) => document.getElementById(id);

const sliderToVolume = (x) => {
  x = Number(x);
  if (isNaN(x) || x < 0) return 0;
  if (x <= 1) {
    return x * x;
  } else {
    return x;
  }
};

const volumeToSlider = (v) => {
  v = Number(v);
  if (isNaN(v) || v < 0) return 0;
  if (v <= 1) {
    return Math.sqrt(v);
  } else {
    return v;
  }
};

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
    if (!button.dataset.oldText) {
      button.dataset.oldText = button.textContent;
    }
    button.textContent = text || 'Đang xử lý...';
    button.disabled = true;
  } else {
    if (button.dataset.oldText) {
      button.textContent = button.dataset.oldText;
      delete button.dataset.oldText;
    }
    button.disabled = false;
  }
}

function switchView(name) {
  stopAllAudio();

  const editorView = $('studio-editor-view');
  if (editorView && !editorView.classList.contains('hidden') && currentProjectId && name !== 'studio') {
    const hasVideo = $('selected-video-file')?.value || $('video-upload')?.files.length;
    if (hasVideo) {
      saveProjectExplicitly();
    }
  }

  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  
  // Mặc định luôn hiển thị tiêu đề tiêu chuẩn trong topbar
  const standardInfo = $('topbar-standard-info');
  const projectInfo = $('topbar-project-info');
  if (standardInfo) standardInfo.style.display = 'block';
  if (projectInfo) projectInfo.style.display = 'none';

  $('view-title').textContent = views[name].title;
  $('view-desc').textContent = views[name].desc;
  if (name === 'library') {
    switchLibraryTab(currentLibraryTab);
  } else if (name === 'studio') {
    const homeView = $('studio-home-view');
    const editorView = $('studio-editor-view');
    if (homeView) homeView.classList.remove('hidden');
    if (editorView) editorView.classList.add('hidden');
    renderProjectsList();
  }
}

let currentLibraryTab = 'videos';

function switchLibraryTab(tabName) {
  currentLibraryTab = tabName;
  document.querySelectorAll('.library-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.libTab === tabName);
  });
  document.querySelectorAll('.library-subview').forEach(view => {
    view.classList.toggle('hidden', view.id !== `lib-content-${tabName}`);
  });
  
  if (tabName === 'videos') {
    currentVideoPage = 1;
    renderRenderedVideosGrid($('rendered-search-input')?.value || '');
  } else if (tabName === 'voices') {
    currentVoicePage = 1;
    renderVoicesList($('voice-search-input')?.value || '');
  } else if (tabName === 'music') {
    currentMusicPage = 1;
    renderMusicList($('music-search-input')?.value || '');
  }
}
window.switchLibraryTab = switchLibraryTab;

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

// Setup bottom configuration tabs switcher
document.querySelectorAll('.config-tab-icon-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.config-tab-icon-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const targetPanelId = btn.dataset.target;
    
    const panels = ['panel-source-video', 'panel-reaction', 'panel-subtitle', 'panel-voice', 'panel-music'];
    panels.forEach(id => {
      const el = $(id);
      if (el) el.classList.toggle('hidden', id !== targetPanelId);
    });
  });
});

// Setup aspect ratio dropdown changer
const aspectSelect = $('preview-aspect-select');
if (aspectSelect) {
  aspectSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    const previewWrapper = $('video-preview-wrapper');
    if (previewWrapper) {
      previewWrapper.classList.toggle('aspect-9-16', val === '9-16');
      previewWrapper.classList.toggle('aspect-16-9', val === '16-9');
    }
    
    // Update dynamically generated result wrapper if present
    document.querySelectorAll('.result-video-wrapper').forEach(wrapper => {
      wrapper.classList.toggle('aspect-9-16', val === '9-16');
      wrapper.classList.toggle('aspect-16-9', val === '16-9');
    });
    
    if (typeof updateSubtitleOverlayFromInputs === 'function') {
      updateSubtitleOverlayFromInputs();
    }
  });
}

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
  try {
    await checkLocalDependencies();
  } catch (e) {
    console.error('Lỗi check local dependencies:', e);
  }
  const res = await fetch('/api/studio-assets');
  assets = await res.json();
  renderVideoGrid(assets.videos);
  renderReactionVideoGrid(assets.videos);
  fillSelect('saved-voice-select', assets.voices, 'Chọn giọng đã lưu');
  renderQuickVoices();
  fillSelect('saved-music-select', assets.music, 'Chọn nhạc đã lưu');
  renderQuickMusic();
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
  
  // Kiểm tra xem có tiến trình render đang chạy ngầm hay không để khôi phục giao diện
  checkActiveRenderProgress();
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
  return /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/|facebook\.com\/|fb\.watch\/|fb\.com\/|tiktok\.com\/|douyin\.com\/|v\.douyin\.com\/|iesdouyin\.com\/|instagram\.com\/|instagr\.am\/)/.test(url);
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
  const loadingIndicator = $('video-card-loading');
  if (loadingIndicator) loadingIndicator.classList.remove('hidden');
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
    const isXhs = url.includes('xiaohongshu.com') || url.includes('xhslink.com');
    if (finalExtractedTitle && isXhs) {
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
    if (loadingIndicator) loadingIndicator.classList.add('hidden');
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
  
  // Set default filename in input (sanitize OS illegal characters)
  const filenameInput = $('video-filename-input');
  if (filenameInput) {
    filenameInput.value = (data.title || 'video').replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
  }

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
    vietsub.onclick = (e) => startDownload(e.target, currentUrl, data.title, data.thumbnail, 'vietsub');
    vietsub.textContent = 'Tải + dịch Vietsub';
    grid.appendChild(vietsub);

    for (const format of data.formats || []) {
      const btn = document.createElement('button');
      btn.className = 'quality-btn';
      btn.type = 'button';
      btn.onclick = (e) => startDownload(e.target, currentUrl, data.title, data.thumbnail, format.format_id);
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

async function startDownload(btn, url, videoTitle, thumbnail, formatId) {
  if (btn.disabled) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Đang tải...';

  const isVietsub = formatId === 'vietsub';

  try {
    const customFilename = $('video-filename-input')?.value.trim() || videoTitle;
    const subtitleSize = document.querySelector('input[name="subtitleSize"]')?.value || 18;
    const subtitleMarginH = document.querySelector('input[name="subtitleMarginH"]')?.value || 20;
    const subtitleMaxLines = document.querySelector('[name="subtitleMaxLines"]')?.value || 0;
    const aiSettings = getGlobalAiSettings();

    const res = await fetch('/api/download-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        format_id: formatId,
        customFilename,
        ...aiSettings,
        subtitleMaxLines,
        subtitleSize,
        subtitleMarginH
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi tải video');

    const savedFilename = data.filename || `${customFilename}${isVietsub ? '_Vietsub' : ''}.mp4`;
    toast(`Tải thành công và lưu vào thư mục downloads: ${savedFilename}`, 'success');
    addDownloadHistory(videoTitle, thumbnail, 'success', savedFilename, isVietsub ? 'Vietsub' : originalText);
    await loadAssets();
  } catch (error) {
    console.error('Client startDownload error:', error);
    toast(`Lỗi: ${error.message}`, 'error');
    addDownloadHistory(videoTitle, thumbnail, 'failed', '', isVietsub ? 'Vietsub' : originalText);
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

  const subMode = data.get('subtitleMode');
  const voiceMode = data.get('voiceMode');
  const omiDevice = data.get('omiDevice');

  // Kiểm tra Whisper
  if (subMode === 'generate' && !dependencyStatus.whisper) {
    showDependencyModal('whisper', () => {
      const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(submitEvent);
    });
    return;
  }

  // Kiểm tra CUDA
  if (voiceMode === 'omi' && omiDevice === 'cuda:0' && !dependencyStatus.cuda) {
    showDependencyModal('cuda', () => {
      const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(submitEvent);
    });
    return;
  }

  if (!$('video-upload').files.length && !data.get('mainVideoFile')) {
    toast('Chọn video nguồn hoặc upload video mới.', 'error');
    return;
  }

  // Load global AI settings and set whisperModel
  const aiSettings = getGlobalAiSettings();
  const whisperModel = aiSettings.whisperModel || 'base';
  data.set('whisperModel', whisperModel);

  // Check if selected Whisper model is ready
  if (subMode === 'generate' && whisperModel !== 'base') {
    try {
      const checkRes = await fetch(`/api/whisper-model/status?model=${whisperModel}`);
      const checkStatus = await checkRes.json();
      if (!checkStatus.exists) {
        toast(`⚠️ Thiếu file Model AI ${whisperModel.toUpperCase()}. Vui lòng tải xuống trong Cài đặt AI!`, 'warn');
        openGlobalSettingsModal();
        return;
      }
    } catch (e) {
      console.error('Lỗi khi kiểm tra model AI trước khi render:', e);
    }
  }

  data.set('translateVi', 'true');
  data.set('burnSub', 'true');
  data.set('blurOriginalSub', (blurBoxes && blurBoxes.length > 0) ? 'true' : 'false');
  data.append('blurBoxes', JSON.stringify(blurBoxes));
  data.set('projectId', currentProjectId || '');
  data.set('projectName', currentProjectName || '');

  data.set('aiProvider', aiSettings.aiProvider);
  data.set('geminiApiKey', aiSettings.geminiApiKey);
  data.set('geminiModel', aiSettings.geminiModel || '');
  data.set('openRouterApiKey', aiSettings.openRouterApiKey);
  data.set('openRouterModel', aiSettings.openRouterModel);

  // Map volumes logarithmically for FFmpeg
  const originalSlider = document.querySelector('input[name="originalVolume"]');
  const voiceSlider = document.querySelector('input[name="voiceVolume"]');
  const musicSlider = document.querySelector('input[name="musicVolume"]');
  if (originalSlider) data.set('originalVolume', sliderToVolume(originalSlider.value));
  if (voiceSlider) data.set('voiceVolume', sliderToVolume(voiceSlider.value));
  if (musicSlider) data.set('musicVolume', sliderToVolume(musicSlider.value));

  setBusy(btn, true, 'Đang render...');
  if (status) status.textContent = 'Đang xếp hàng kết xuất...';
  
  // Tăng trước số lượng trên badge (phản hồi UX tức thì)
  const badge = $('queue-badge');
  if (badge) {
    const currentVal = parseInt(badge.textContent || '0', 10);
    badge.textContent = currentVal + 1;
    badge.style.display = 'inline-block';
  }
  
  // Chuyển sang tab Xem trước ngay lập tức
  switchToResultTab();

  try {
    const res = await fetch('/api/render-studio', { method: 'POST', body: data });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Render lỗi');
    
    if (result.taskId) {
      currentDisplayedTaskId = result.taskId;
    }
    
    if (status) status.textContent = ''; // Bỏ chữ đang xử lý/hoàn tất trên nút
    setBusy(btn, false);
    toast('Đã thêm video vào hàng đợi thành công!', 'success');
    
    // Bắt đầu vòng lặp polling hàng đợi
    startQueuePolling();
    
  } catch (error) {
    if (status) status.textContent = '';
    setBusy(btn, false);
    toast(error.message, 'error');
  }
}

// ==========================================================================
// HỆ THỐNG HÀNG ĐỢI RENDER TUẦN TỰ (FRONTEND QUEUE MANAGER)
// ==========================================================================
let queuePollInterval = null;
let currentDisplayedTaskId = null;

function startQueuePolling() {
  if (queuePollInterval) return;
  updateQueueStatus();
  queuePollInterval = setInterval(updateQueueStatus, 1500);
}

function stopQueuePolling() {
  if (queuePollInterval) {
    clearInterval(queuePollInterval);
    queuePollInterval = null;
  }
}

async function updateQueueStatus() {
  try {
    const res = await fetch('/api/render-queue-status');
    if (!res.ok) return;
    const data = await res.json();
    
    // 1. Vẽ giao diện hàng đợi trong modal
    renderQueueModalUI(data.queue, data.currentActiveId);
    
    // 2. Vẽ giao diện xem trước full ở màn hình chính
    updateMainResultUI(data.queue, data.currentActiveId);
    
    // Kiểm tra xem còn tác vụ nào đang chạy hoặc chờ không để tiếp tục polling
    const hasActiveOrPending = data.queue.some(t => t.status === 'rendering' || t.status === 'pending');
    const statusText = $('render-status');
    
    // Cập nhật số lượng trên badge (chỉ đếm các task đang chạy hoặc đang chờ)
    const activeOrPendingCount = data.queue.filter(t => t.status === 'rendering' || t.status === 'pending').length;
    const badgeElement = $('queue-badge');
    if (badgeElement) {
      if (activeOrPendingCount > 0) {
        badgeElement.textContent = activeOrPendingCount;
        badgeElement.style.display = 'inline-block';
      } else {
        badgeElement.style.display = 'none';
      }
    }
    
    if (!hasActiveOrPending) {
      stopQueuePolling();
      if (statusText) statusText.textContent = '';
    } else {
      if (statusText) statusText.textContent = 'Có video đang được kết xuất dưới nền...';
    }
  } catch (err) {
    console.error('Lỗi cập nhật hàng đợi:', err);
  }
}

function updateMainResultUI(queue, currentActiveId) {
  const container = $('studio-render-result');
  const sidebar = $('render-result');
  if (!container && !sidebar) return;

  const projectQueue = queue.filter(t => !t.projectId || t.projectId === currentProjectId);

  if (projectQueue.length === 0) {
    const emptyHtml = `
      <div class="empty-result-msg" style="color: var(--muted); font-size: 13px; text-align: center; padding: 40px 0;">
        Chưa có video render nào cho dự án này. Hãy nhấn "Render video" ở tab Xem trước.
      </div>
    `;
    if (container) {
      container.innerHTML = emptyHtml;
      delete container.dataset.displayedTaskId;
      delete container.dataset.displayedTaskStatus;
    }
    if (sidebar) {
      sidebar.classList.add('empty');
      sidebar.innerHTML = emptyHtml;
      delete sidebar.dataset.displayedTaskId;
      delete sidebar.dataset.displayedTaskStatus;
    }
    return;
  }

  let targetTask = null;

  // 1. Nếu người dùng đã chọn một task cụ thể để hiển thị, hãy ưu tiên hiển thị task đó
  if (currentDisplayedTaskId) {
    targetTask = projectQueue.find(t => t.id === currentDisplayedTaskId);
  }

  // 2. Nếu chưa chọn hoặc task đã chọn không tồn tại trong queue, tự động chọn task đang render
  if (!targetTask) {
    const activeTask = projectQueue.find(t => t.status === 'rendering' || t.id === currentActiveId);
    if (activeTask) {
      targetTask = activeTask;
      currentDisplayedTaskId = activeTask.id;
    }
  }

  // 3. Nếu không có task nào đang chạy, mặc định hiển thị tác vụ được thêm gần đây nhất
  if (!targetTask && projectQueue.length > 0) {
    const sorted = [...projectQueue].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    targetTask = sorted[0];
    if (targetTask) {
      currentDisplayedTaskId = targetTask.id;
    }
  }

  if (!targetTask) return;

  let html = '';

  if (targetTask.status === 'rendering') {
    // 1. Giao diện Đang render full-size
    html = `
      <div class="render-loading-state">
        <div class="loading-spinner" style="border-top-color: var(--accent-2);"></div>
        <h3>Đang Render Video... <span id="render-progress-percent">${targetTask.percent}%</span></h3>
        
        <div class="render-progress-container" style="width: 100%; max-width: 400px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); border-radius: 20px; height: 10px; margin: 16px auto; overflow: hidden; position: relative;">
          <div id="render-progress-bar" style="width: ${targetTask.percent}%; height: 100%; background: linear-gradient(90deg, var(--accent-2), #a855f7); border-radius: 20px; transition: width 0.3s ease-out;"></div>
        </div>
        
        <p id="render-progress-text" style="font-weight: 600; color: var(--accent-2); margin-bottom: 8px;">${targetTask.step || 'Đang chuẩn bị...'}</p>
        <p style="font-size: 12px; color: var(--muted); max-width: 400px; line-height: 1.5; margin: 0 auto;">Hệ thống đang xử lý và trộn video. Tùy thuộc vào độ dài video và các thiết lập AI (Speech-to-Text, Omi Cloner), quá trình này có thể mất một vài phút. Vui lòng không tắt ứng dụng.</p>
        <button id="cancel-render-btn" style="margin-top: 15px; background: #ef4444; color: white; border: none; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; transition: background 0.2s;" onclick="cancelQueueTask('${targetTask.id}', event)" onmouseover="this.style.background='#dc2626'" onmouseout="this.style.background='#ef4444'">Hủy Render</button>
      </div>
    `;
  } else if (targetTask.status === 'pending') {
    // 2. Giao diện Đang chờ xếp hàng
    html = `
      <div class="render-loading-state" style="border-color: var(--border); background: rgba(255, 255, 255, 0.01);">
        <div style="font-size: 40px; margin-bottom: 15px;">⏳</div>
        <h3 style="color: var(--accent-2);">Đang chờ xếp hàng...</h3>
        <p style="color: var(--muted); max-width: 400px; margin: 0 auto; line-height: 1.5; font-size: 13px;">Video "${targetTask.videoName}" đang nằm trong hàng đợi render. Tiến trình sẽ tự động bắt đầu khi các tác vụ trước đó hoàn thành.</p>
        <button style="margin-top: 15px; background: #ef4444; color: white; border: none; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px;" onclick="cancelQueueTask('${targetTask.id}', event)">Hủy Chờ</button>
      </div>
    `;
  } else if (targetTask.status === 'success' && targetTask.result) {
    // 3. Giao diện Render thành công (Video Player full-size như cũ)
    html = `
      <div class="video-preview-wrapper result-video-wrapper" style="margin: 0 auto 10px auto;">
        <video controls src="${targetTask.result.url}"></video>
      </div>
      <div style="display: flex; gap: 10px; justify-content: center; width: 100%; max-width: 400px; margin: 0 auto;">
        <button type="button" class="premium-render-btn" style="background: #1877F2; color: white; flex: 1;" onclick="openFbModal('${targetTask.result.url}')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle; margin-right: 5px; margin-top: -2px;">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
          </svg>
          Đăng lên Fanpage
        </button>
      </div>
    `;
  } else {
    // 4. Giao diện Lỗi render
    const isCancelled = targetTask.step?.includes('hủy') || targetTask.error?.includes('hủy') || targetTask.error?.includes('cancel');
    const statusTitle = isCancelled ? 'Đã hủy render' : 'Render thất bại';
    const statusIcon = isCancelled ? '⏹️' : '❌';
    const statusColor = isCancelled ? 'var(--muted)' : '#ef4444';
    const borderColor = isCancelled ? 'var(--border)' : 'rgba(239, 68, 68, 0.3)';
    const bgColor = isCancelled ? 'rgba(255, 255, 255, 0.01)' : 'rgba(239, 68, 68, 0.05)';
    const errMsg = targetTask.error || targetTask.step || 'Lỗi không xác định';

    html = `
      <div class="render-loading-state" style="border-color: ${borderColor}; background: ${bgColor}; max-width: 500px; margin: 20px auto; padding: 30px; border-radius: 12px; border: 1px solid;">
        <div style="font-size: 40px; margin-bottom: 15px;">${statusIcon}</div>
        <h3 style="color: ${statusColor}; margin-bottom: 10px;">${statusTitle}</h3>
        <p style="color: var(--muted); font-size: 13px; margin-bottom: 15px; line-height: 1.5;">${errMsg}</p>
        <p style="font-size: 12px; color: var(--muted);">Tên video: ${targetTask.videoName}</p>
      </div>
    `;
  }

  if (container) {
    const prevId = container.dataset.displayedTaskId;
    const prevStatus = container.dataset.displayedTaskStatus;
    
    // 1. Nếu vẫn là tác vụ đó và đã hiển thị thành công, không vẽ lại DOM để tránh ngắt quãng/load lại video player
    if (prevId === targetTask.id && prevStatus === 'success' && targetTask.status === 'success') {
      // Giữ nguyên trình phát video đang chạy
    } 
    // 2. Nếu vẫn là tác vụ đó và đang render, chỉ cập nhật tiến trình cục bộ để tránh làm reset vòng xoay loading
    else if (prevId === targetTask.id && prevStatus === 'rendering' && targetTask.status === 'rendering') {
      const percentEl = container.querySelector('#render-progress-percent');
      const barEl = container.querySelector('#render-progress-bar');
      const textEl = container.querySelector('#render-progress-text');
      
      if (percentEl) percentEl.textContent = `${targetTask.percent}%`;
      if (barEl) barEl.style.width = `${targetTask.percent}%`;
      if (textEl) textEl.textContent = targetTask.step || 'Đang chuẩn bị...';
    } 
    // 3. Thay đổi tác vụ hoặc trạng thái thay đổi, vẽ lại toàn bộ DOM
    else {
      container.innerHTML = html;
      container.dataset.displayedTaskId = targetTask.id;
      container.dataset.displayedTaskStatus = targetTask.status;
      
      if (targetTask.status === 'success') {
        const resultWrapper = container.querySelector('.result-video-wrapper');
        if (resultWrapper) {
          const aspectVal = $('preview-aspect-select')?.value || '9-16';
          resultWrapper.classList.add(aspectVal === '9-16' ? 'aspect-9-16' : 'aspect-16-9');
        }
      }
    }
  }

  if (sidebar) {
    const prevId = sidebar.dataset.displayedTaskId;
    const prevStatus = sidebar.dataset.displayedTaskStatus;
    
    if (prevId === targetTask.id && prevStatus === 'success' && targetTask.status === 'success') {
      // Giữ nguyên
    } else if (prevId === targetTask.id && prevStatus === 'rendering' && targetTask.status === 'rendering') {
      const percentEl = sidebar.querySelector('#render-progress-percent');
      const barEl = sidebar.querySelector('#render-progress-bar');
      const textEl = sidebar.querySelector('#render-progress-text');
      
      if (percentEl) percentEl.textContent = `${targetTask.percent}%`;
      if (barEl) barEl.style.width = `${targetTask.percent}%`;
      if (textEl) textEl.textContent = targetTask.step || 'Đang chuẩn bị...';
    } else {
      sidebar.classList.remove('empty');
      sidebar.innerHTML = html;
      sidebar.dataset.displayedTaskId = targetTask.id;
      sidebar.dataset.displayedTaskStatus = targetTask.status;
    }
  }
}

function renderQueueModalUI(queue, currentActiveId) {
  const container = $('queue-modal-body');
  if (!container) return;

  if (queue.length === 0) {
    container.innerHTML = `
      <div class="empty-result-msg" style="color: var(--muted); font-size: 13px; text-align: center; padding: 40px 0;">
        Hàng đợi trống. Chưa có video render nào.
      </div>
    `;
    return;
  }

  const sortedQueue = [...queue].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  let html = `<div style="display: flex; flex-direction: column; gap: 10px;">`;

  sortedQueue.forEach((task) => {
    const isRunning = task.status === 'rendering';
    const isPending = task.status === 'pending';
    const isSuccess = task.status === 'success';
    const isFailed = task.status === 'failed' || task.status === 'error';

    let statusBadge = '';
    let progressBarPercent = 0;
    let progressBarColor = 'rgba(255, 255, 255, 0.1)';

    if (isRunning) {
      statusBadge = `<span style="color: #2563eb; background: rgba(37, 99, 235, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Đang chạy (${task.percent}%)</span>`;
      progressBarPercent = task.percent || 0;
      progressBarColor = 'linear-gradient(90deg, var(--accent-2, #8b5cf6), #a855f7)';
    } else if (isPending) {
      statusBadge = `<span style="color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Chờ render</span>`;
      progressBarPercent = 0;
      progressBarColor = 'rgba(255, 255, 255, 0.05)';
    } else if (isSuccess) {
      statusBadge = `<span style="color: #16a34a; background: rgba(22, 163, 74, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Hoàn tất ✅</span>`;
      progressBarPercent = 100;
      progressBarColor = '#16a34a';
    } else if (isFailed) {
      statusBadge = `<span style="color: #ef4444; background: rgba(239, 68, 68, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;" title="${task.error || ''}">Thất bại ❌</span>`;
      progressBarPercent = task.percent || 0;
      progressBarColor = '#ef4444';
    }

    let actionHtml = '';
    if (isPending) {
      actionHtml = `<button type="button" class="premium-render-btn" style="background: #ef4444; color: white; padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="cancelQueueTask('${task.id}', event)">Hủy chờ</button>`;
    } else if (isRunning) {
      actionHtml = `<button type="button" class="premium-render-btn" style="background: #ef4444; color: white; padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="cancelQueueTask('${task.id}', event)">Hủy render</button>`;
    } else {
      actionHtml = `
        <button type="button" class="premium-render-btn" style="background: var(--accent); color: white; padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="selectAndShowTask('${task.id}')">Xem Chi Tiết</button>
      `;
    }

    const timeStr = new Date(task.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

    html += `
      <div style="background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div class="queue-item-info-clickable" style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; cursor: pointer; transition: opacity 0.2s;" onclick="selectAndShowTask('${task.id}')" onmouseover="this.style.opacity='0.75'" onmouseout="this.style.opacity='1'">
            <span style="font-size: 11px; color: var(--muted); font-weight: 500;">[${timeStr}]</span>
            <div style="display: flex; flex-direction: column; min-width: 0;">
              <strong style="font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 280px;" title="${task.videoName}">${task.videoName}</strong>
              <span style="font-size: 10px; color: var(--muted); font-weight: 500;">📁 Dự án: <span style="color: var(--accent-2); font-weight: 600;">${task.projectName || 'Chưa rõ'}</span></span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            ${statusBadge}
            ${actionHtml}
          </div>
        </div>
        <!-- Progress Bar -->
        <div style="width: 100%; background: rgba(255, 255, 255, 0.05); height: 4px; border-radius: 2px; overflow: hidden; position: relative;">
          <div style="width: ${progressBarPercent}%; height: 100%; background: ${progressBarColor}; transition: width 0.3s ease-out;"></div>
        </div>
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;
}

async function selectAndShowTask(taskId) {
  try {
    const res = await fetch('/api/render-queue-status');
    if (res.ok) {
      const data = await res.json();
      const task = data.queue.find(t => t.id === taskId);
      if (task && task.projectId && task.projectId !== currentProjectId) {
        await loadProject(task.projectId);
      }
    }
  } catch (e) {
    console.error('Lỗi khi chuyển đổi dự án từ hàng đợi:', e);
  }

  currentDisplayedTaskId = taskId;
  switchView('studio');
  openStudioEditor();
  switchToResultTab();
  updateQueueStatus();
  closeQueueModal();
}

async function clearQueueTasks(event) {
  const confirmClear = confirm('Bạn có chắc chắn muốn xóa sạch toàn bộ hàng đợi render không? (Các tiến trình đang chạy cũng sẽ bị dừng)');
  if (!confirmClear) return;
  
  const clearBtn = document.getElementById('clear-queue-btn');
  const originalText = clearBtn ? clearBtn.textContent : 'Xóa tất cả';
  if (clearBtn) {
    clearBtn.disabled = true;
    clearBtn.textContent = 'Đang xóa...';
  }
  
  try {
    const res = await fetch('/api/clear-queue', { method: 'POST' });
    const result = await res.json();
    if (res.ok && result.success) {
      toast('Đã xóa sạch hàng đợi thành công.', 'success');
      updateQueueStatus();
    } else {
      toast(result.error || 'Lỗi khi xóa hàng đợi', 'error');
      if (clearBtn) {
        clearBtn.disabled = false;
        clearBtn.textContent = originalText;
      }
    }
  } catch (err) {
    console.error('Lỗi khi xóa hàng đợi:', err);
    toast('Lỗi kết nối khi xóa hàng đợi.', 'error');
    if (clearBtn) {
      clearBtn.disabled = false;
      clearBtn.textContent = originalText;
    }
  }
}
window.clearQueueTasks = clearQueueTasks;
window.selectAndShowTask = selectAndShowTask;

function openQueueModal() {
  const modal = $('render-queue-modal');
  if (modal) {
    modal.classList.remove('hidden');
    updateQueueStatus();
  }
}
window.openQueueModal = openQueueModal;

function closeQueueModal() {
  const modal = $('render-queue-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}
window.closeQueueModal = closeQueueModal;

async function cancelQueueTask(taskId, event) {
  const confirmCancel = confirm('Bạn có chắc chắn muốn hủy tác vụ kết xuất này không?');
  if (!confirmCancel) return;
  
  let targetBtn = null;
  if (event && event.target) {
    targetBtn = event.target;
  } else {
    targetBtn = $('cancel-render-btn');
  }
  
  const originalText = targetBtn ? targetBtn.textContent : 'Hủy';
  if (targetBtn) {
    targetBtn.disabled = true;
    targetBtn.textContent = 'Đang hủy...';
  }
  
  try {
    const res = await fetch('/api/cancel-queue-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
    const result = await res.json();
    if (res.ok && result.success) {
      toast(result.message || 'Đã hủy tác vụ thành công.', 'success');
      updateQueueStatus();
    } else {
      toast(result.error || 'Lỗi khi hủy tác vụ', 'error');
      if (targetBtn) {
        targetBtn.disabled = false;
        targetBtn.textContent = originalText;
      }
    }
  } catch (err) {
    console.error('Lỗi khi hủy tác vụ:', err);
    toast('Lỗi kết nối khi hủy tác vụ.', 'error');
    if (targetBtn) {
      targetBtn.disabled = false;
      targetBtn.textContent = originalText;
    }
  }
}
window.cancelQueueTask = cancelQueueTask;

async function cancelRenderVideo() {
  const confirmCancel = confirm('Bạn có chắc chắn muốn hủy tiến trình render hiện tại không?');
  if (!confirmCancel) return;
  
  const cancelBtn = $('cancel-render-btn');
  if (cancelBtn) {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Đang hủy...';
  }
  
  try {
    const res = await fetch('/api/cancel-render', { method: 'POST' });
    const result = await res.json();
    if (res.ok && result.success) {
      toast('Đã hủy tiến trình render thành công.', 'success');
      updateQueueStatus();
    } else {
      toast(result.message || 'Lỗi khi hủy render', 'error');
    }
  } catch (err) {
    console.error('Lỗi khi hủy render:', err);
    toast('Lỗi kết nối khi hủy render.', 'error');
  }
}
window.cancelRenderVideo = cancelRenderVideo;

async function checkActiveRenderProgress() {
  try {
    const pRes = await fetch('/api/render-queue-status');
    if (!pRes.ok) return;
    const data = await pRes.json();
    const hasActiveOrPending = data.queue.some(t => t.status === 'rendering' || t.status === 'pending');
    if (hasActiveOrPending || data.queue.length > 0) {
      startQueuePolling();
    }
  } catch (err) {
    console.error('Lỗi khi kiểm tra tiến trình render lúc khởi động:', err);
  }
}
window.checkActiveRenderProgress = checkActiveRenderProgress;

async function fetchPlaylistInfo() {
  const rawInput = $('bulk-url-input').value.trim();
  if (!rawInput) {
    toast('Nhập link kênh hoặc danh sách link video.', 'error');
    return;
  }

  // Tách các dòng và tìm link hợp lệ trên từng dòng
  const lines = rawInput.split('\n')
    .map(line => {
      const match = line.trim().match(/https?:\/\/[^\s]+/);
      return match ? match[0] : '';
    })
    .filter(link => link !== '');

  if (lines.length === 0) {
    toast('Nhập link kênh hoặc danh sách link video hợp lệ.', 'error');
    return;
  }

  const btn = $('bulk-fetch-btn');
  const stats = $('bulk-stats');
  const resultsContainer = $('bulk-results-container');

  if (lines.length > 1) {
    // CHẾ ĐỘ: TẢI HÀNG LOẠT TỪ DANH SÁCH LINK TỰ NHẬP
    setBusy(btn, true, 'Đang tải...');
    if (resultsContainer) resultsContainer.classList.add('hidden');
    const loadingContainer = $('bulk-loading-container');
    if (loadingContainer) {
      const loadingText = $('bulk-loading-text');
      if (loadingText) loadingText.textContent = 'Đang xử lý danh sách liên kết tự nhập...';
      loadingContainer.classList.remove('hidden');
    }
    stats.textContent = 'Đang xử lý danh sách link...';

    const sessionId = Date.now();
    currentPlaylistSessionId = sessionId;
    currentPlaylistVideos = lines.map((link, index) => {
      // Trích xuất ID từ link nếu có thể để hiển thị ảnh thu nhỏ Youtube (nếu là link Youtube)
      let id = `manual-${index}-${sessionId}`;
      const ytIdMatch = link.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
      if (ytIdMatch) {
        id = ytIdMatch[1];
      }
      return {
        id: id,
        title: `Video liên kết #${index + 1}`,
        url: link,
        duration: 0,
        thumbnail: '',
        selected: true // Mặc định chọn tất cả để tải
      };
    });

    currentBulkPage = 1;
    setBusy(btn, false);
    if (loadingContainer) {
      loadingContainer.classList.add('hidden');
    }
    if (resultsContainer) resultsContainer.classList.remove('hidden');
    renderPlaylistVideos();
    stats.textContent = `Đã nhận diện ${currentPlaylistVideos.length} video từ danh sách tự nhập.`;

    // Tự động tải chất lượng của các video này
    loadAllPlaylistFormats(sessionId);
    return;
  }

  // CHẾ ĐỘ MẶC ĐỊNH: QUÉT MỘT KÊNH / PLAYLIST
  let url = lines[0];
  const limit = Number($('bulk-limit').value || 10);

  setBusy(btn, true, 'Đang quét...');
  if (resultsContainer) resultsContainer.classList.add('hidden');
  const loadingContainer = $('bulk-loading-container');
  if (loadingContainer) {
    const loadingText = $('bulk-loading-text');
    if (loadingText) loadingText.textContent = 'Đang quét danh sách video từ kênh/playlist...';
    loadingContainer.classList.remove('hidden');
  }
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
    currentBulkPage = 1;
    currentPlaylistVideos.forEach(v => {
      v.selected = true;
      v.selectedFormat = '';
    });
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
      if (loadingContainer) {
        loadingContainer.classList.add('hidden');
      }
    }
  }
}

function renderPlaylistVideos() {
  const listContainer = $('bulk-videos-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (currentPlaylistVideos.length === 0) {
    listContainer.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--muted); font-size: 13px;">Không có video nào trong danh sách.</div>';
    const pagContainer = $('bulk-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(currentPlaylistVideos.length / bulkVideosPerPage);
  if (currentBulkPage > totalPages) currentBulkPage = totalPages;
  if (currentBulkPage < 1) currentBulkPage = 1;

  const startIndex = (currentBulkPage - 1) * bulkVideosPerPage;
  const endIndex = Math.min(startIndex + bulkVideosPerPage, currentPlaylistVideos.length);
  const pageVideos = currentPlaylistVideos.slice(startIndex, endIndex);

  pageVideos.forEach((video, pageIndex) => {
    const index = startIndex + pageIndex;
    const card = document.createElement('div');
    card.className = 'bulk-video-card';
    
    const thumbUrl = video.thumbnail || (video.id && (video.url.includes('youtube.com') || video.url.includes('youtu.be')) ? `https://img.youtube.com/vi/${video.id}/mqdefault.jpg` : '');
    const durationStr = video.duration ? formatDuration(video.duration) : '';

    const defaultFilename = (video.customTitle || video.title || 'video').replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);

    card.innerHTML = `
      <div style="align-self: center; display: flex; justify-content: center; align-items: center; height: 100%;">
        <input type="checkbox" class="bulk-video-checkbox" data-index="${index}" style="width: 20px; height: 20px; cursor: pointer; accent-color: var(--accent);" ${video.selected ? 'checked' : ''}>
      </div>
      <div style="position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; background: #090d12; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border);">
        ${thumbUrl ? `<img src="${thumbUrl}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">` : ''}
        <span style="font-size: 24px; display: ${thumbUrl ? 'none' : 'block'};">📹</span>
        ${durationStr ? `<span style="position: absolute; bottom: 4px; right: 4px; background: rgba(0,0,0,0.75); color: #fff; font-size: 10px; padding: 2px 4px; border-radius: 4px;">${durationStr}</span>` : ''}
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <h4 class="bulk-video-title" style="margin: 0; font-size: 14px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4;" title="${(video.title || '').replace(/"/g, '&quot;')}">${video.title || 'Video ' + video.id}</h4>
        
        <div style="display: flex; align-items: center; gap: 6px; margin: 2px 0;">
          <span style="font-size: 11px; color: var(--muted); font-weight: 600; white-space: nowrap;">Tên file:</span>
          <input type="text" class="premium-input bulk-filename-input" data-index="${index}" style="flex: 1; height: 26px; font-size: 11px; padding: 2px 6px; margin: 0; background: rgba(255,255,255,0.02); border-color: var(--border); border-radius: 4px; color: var(--text);" value="${defaultFilename}">
          <span style="font-size: 11px; color: var(--muted); font-weight: 600;">.mp4</span>
        </div>

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

    if (video.formats) {
      renderVideoCardFormats(index, { formats: video.formats });
    }
  });

  // Đồng bộ trạng thái checkbox thành viên
  const checkBoxes = listContainer.querySelectorAll('.bulk-video-checkbox');
  checkBoxes.forEach(cb => {
    cb.addEventListener('change', () => {
      const index = Number(cb.dataset.index);
      currentPlaylistVideos[index].selected = cb.checked;
      
      const selectAll = $('bulk-select-all');
      if (selectAll) {
        selectAll.checked = currentPlaylistVideos.every(v => v.selected);
      }
    });
  });

  // Đồng bộ thay đổi tên file tùy chỉnh
  const filenameInputs = listContainer.querySelectorAll('.bulk-filename-input');
  filenameInputs.forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.index);
      if (!isNaN(idx) && currentPlaylistVideos[idx]) {
        currentPlaylistVideos[idx].customTitle = e.target.value;
      }
    });
  });

  const selectAll = $('bulk-select-all');
  if (selectAll) {
    selectAll.checked = currentPlaylistVideos.every(v => v.selected);
  }

  // Render các nút phân trang
  renderPaginationControls('bulk-pagination', currentBulkPage, totalPages, (newPage) => {
    currentBulkPage = newPage;
    renderPlaylistVideos();
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
    if (grid) {
      grid.innerHTML = `<span style="font-size: 11px; color: var(--danger); font-weight: 500;">⚠️ Không lấy được tùy chọn tải</span>`;
    }
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

  if (video.selectedFormat) {
    select.value = video.selectedFormat;
  }

  select.addEventListener('change', () => {
    video.selectedFormat = select.value;
  });

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
    const aiSettings = getGlobalAiSettings();

    const res = await fetch('/api/download-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: video.url,
        format_id: val,
        ...aiSettings,
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
  const selectedVideos = currentPlaylistVideos.filter(v => v.selected);
  if (selectedVideos.length === 0) {
    toast('Vui lòng chọn ít nhất 1 video để tải.', 'warn');
    return;
  }

  // Validate format selected for all checked videos
  for (const video of selectedVideos) {
    if (!video.formats) {
      toast(`Đang tải danh sách định dạng cho video "${video.title || video.id}", vui lòng đợi...`, 'warn');
      return;
    }
    if (!video.selectedFormat) {
      toast('Vui lòng chọn chất lượng tải cho tất cả các video đã tích!', 'warn');
      
      const globalIndex = currentPlaylistVideos.indexOf(video);
      const pageOfVideo = Math.floor(globalIndex / bulkVideosPerPage) + 1;
      if (currentBulkPage !== pageOfVideo) {
        currentBulkPage = pageOfVideo;
        renderPlaylistVideos();
      }
      
      setTimeout(() => {
        const select = $(`format-select-${globalIndex}`);
        if (select) {
          select.focus();
          select.style.borderColor = 'var(--danger)';
          setTimeout(() => { select.style.borderColor = ''; }, 3000);
        }
      }, 100);
      return;
    }
  }

  const dlBtn = $('bulk-download-selected-btn');
  const stats = $('bulk-stats');
  
  const total = selectedVideos.length;
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
  selectedVideos.forEach((video, idx) => {
    const index = currentPlaylistVideos.indexOf(video);
    let formatLabel = 'Tự động';
    if (video.selectedFormat === 'vietsub') {
      formatLabel = 'Vietsub';
    } else if (video.formats) {
      const matched = video.formats.find(f => f.format_id === video.selectedFormat);
      if (matched) {
        formatLabel = matched.quality;
      }
    }
    
    const item = document.createElement('div');
    item.id = `bulk-progress-item-${index}`;
    item.style = 'display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--border);';
    item.innerHTML = `
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; font-weight: 500;" title="${(video.title || '').replace(/"/g, '&quot;')}">
        ${idx + 1}. ${video.title || 'Video ' + video.id} (${formatLabel})
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

    const video = selectedVideos[i];
    const index = currentPlaylistVideos.indexOf(video);
    if (!video) continue;

    const selectEl = $(`format-select-${index}`);
    const card = selectEl ? selectEl.closest('.bulk-video-card') : null;
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
      const formatId = video.selectedFormat;
      const subtitleSize = document.querySelector('input[name="subtitleSize"]')?.value || 18;
      const subtitleMarginH = document.querySelector('input[name="subtitleMarginH"]')?.value || 20;
      const subtitleMaxLines = document.querySelector('[name="subtitleMaxLines"]')?.value || 0;
      const aiSettings = getGlobalAiSettings();

      const res = await fetch('/api/download-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: video.url,
          format_id: formatId,
          customFilename: video.customTitle || video.title,
          ...aiSettings,
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
          const nextVideo = selectedVideos[j];
          const nextIndex = currentPlaylistVideos.indexOf(nextVideo);
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
    selectedVideos.forEach(video => {
      const index = currentPlaylistVideos.indexOf(video);
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
  const timelinePanel = $('studio-timeline-panel');
  
  if (url) {
    video.src = url;
    if (wrapper) wrapper.classList.remove('hidden');
    if (placeholder) placeholder.classList.add('hidden');
    if (timelinePanel) timelinePanel.classList.remove('hidden');
    
    const onMetadataLoaded = () => {
      updateSubtitleOverlayFromInputs();
      if (typeof updateBlurBoxPreview === 'function') {
        updateBlurBoxPreview();
      }
      if (typeof renderTimeline === 'function') {
        renderTimeline();
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
    if (timelinePanel) timelinePanel.classList.add('hidden');
    
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
  
  const stageW = konvaStage ? konvaStage.width() : W_act;
  const stageH = konvaStage ? konvaStage.height() : H_act;
  
  // 1. Determine quadrants based on stage coordinates
  const centerPercent = (left + dragWidth / 2) / stageW;
  const topPercent = top / stageH;
  
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
    alignmentInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const alignGrid = $('alignment-visual-grid');
  if (alignGrid) {
    alignGrid.querySelectorAll('.grid-cell').forEach(cell => {
      cell.classList.toggle('active', Number(cell.dataset.align) === alignment);
    });
  }
  
  // 3. Compute vertical margin based on quadrant (Top vs Bottom) in stage coordinates, then scale to video coordinates
  let MarginV_act = 0;
  if (verticalSec === 'top') {
    MarginV_act = Math.round((top / stageH) * H_act);
  } else {
    MarginV_act = Math.round(((stageH - (top + dragHeight)) / stageH) * H_act);
  }
  
  // Compute horizontal margin in stage coordinates, then scale to video coordinates
  const marginL_act = left;
  const marginR_act = stageW - (left + dragWidth);
  const MarginH_act = Math.round((Math.min(marginL_act, marginR_act) / stageW) * W_act);
  
  const marginInput = document.querySelector('input[name="subtitleMargin"]');
  if (marginInput) {
    marginInput.value = Math.max(0, MarginV_act);
    marginInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  
  const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
  if (marginHInput) {
    marginHInput.value = Math.max(0, MarginH_act);
    marginHInput.dataset.lastStageWidth = W_act;
    marginHInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
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

  const applySnapping = (node, w, h, currentX, currentY) => {
    let x = currentX;
    let y = currentY;
    
    if (!konvaStage) return { x, y };
    
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
    
    // Cập nhật đường căn dọc
    if (vGuideline) {
      if (snappedX) {
        vGuideline.points([stageCenterX, 0, stageCenterX, stageH]);
        vGuideline.visible(true);
        vGuideline.moveToTop();
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
        if (curr.name() === 'subtitle' || curr.name() === 'reaction' || curr.name() === 'blur' || curr.name() === 'blur-box-shape') {
          clickedNode = curr;
          break;
        }
        curr = curr.parent;
      }

      if (clickedNode) {
        // Cấu hình các điểm neo transformer tùy thuộc vào đối tượng được chọn
        if (clickedNode.name() === 'blur' || clickedNode.name() === 'blur-box-shape') {
          if (clickedNode.name() === 'blur-box-shape') {
            const boxId = clickedNode.getAttr('boxId');
            if (boxId && boxId !== activeBlurBoxId) {
              selectBlurBox(boxId);
            }
          }
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
      if (marginHInput) {
        marginHInput.value = newMarginH;
        marginHInput.dataset.lastStageWidth = stageW;
      }

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

      const rxXInput = $('reaction-x');
      if (rxXInput) {
        rxXInput.value = Math.round(x);
        rxXInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const rxYInput = $('reaction-y');
      if (rxYInput) {
        rxYInput.value = Math.round(y);
        rxYInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      
      const widthInput = document.querySelector('input[name="reactionWidth"]');
      if (widthInput) {
        widthInput.value = Math.round(w);
        const valSpan = $('reaction-width-val');
        if (valSpan) valSpan.textContent = widthInput.value + 'px';
        widthInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      $('preview-reaction-pip').dataset.customGeometry = 'true';
      const posSelect = document.querySelector('select[name="reactionPosition"]');
      if (posSelect) {
        posSelect.value = 'custom';
        posSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      
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
  
  const marginHEl = document.querySelector('input[name="subtitleMarginH"]');
  let marginHInput = Number(marginHEl ? marginHEl.value : 20) || 20;

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
  } else if (themeInput === 'neon-glow') {
    subTextNode.fill('#FFFFFF');
    subTextNode.stroke(colorInput);
    subTextNode.strokeWidth(1.5 * scaleFactor);
    subTextNode.shadowColor(colorInput);
    subTextNode.shadowBlur(10 * scaleFactor);
    subTextNode.shadowOffset({ x: 0, y: 0 });
    subTextNode.shadowOpacity(1.0);
    subTextNode.shadowEnabled(true);
  } else if (themeInput === 'three-d') {
    subTextNode.stroke('black');
    subTextNode.strokeWidth(1.0 * scaleFactor);
    const shadowSize = 3 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(0);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(1.0);
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

  const stageW = konvaStage ? konvaStage.width() : W_act;
  const stageH = konvaStage ? konvaStage.height() : H_act;

  const marginVStage = (marginVInput / H_act) * stageH;
  const marginHStage = (marginHInput / W_act) * stageW;

  const dragWidth = subTextNode.width();
  const dragHeight = subTextNode.height();

  let subX = marginHStage;
  let subY = 0;

  if ([5, 6, 7].includes(alignment)) {
    subY = marginVStage;
  } else if ([9, 10, 11].includes(alignment)) {
    subY = (stageH - dragHeight) / 2;
  } else {
    subY = stageH - dragHeight - marginVStage;
  }

  if ([1, 5, 9].includes(alignment)) {
    subX = marginHStage;
  } else if ([3, 7, 11].includes(alignment)) {
    subX = stageW - dragWidth - marginHStage;
  } else {
    subX = (stageW - dragWidth) / 2;
  }

  konvaSubtitle.position({ x: subX, y: subY });
  console.log(`[Subtitle Position Debug] alignment=${alignment}, marginVInput=${marginVInput}, marginHInput=${marginHInput}, stageW=${stageW}, stageH=${stageH}, W_act=${W_act}, H_act=${H_act}, subX=${subX}, subY=${subY}`);
  
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

  // 3. Cập nhật các vùng làm mờ (Multiple Blur Boxes)
  if (konvaBlur) {
    konvaBlur.visible(false); // Ẩn blur box đơn lẻ cũ
  }

  const isBlurEnabled = true;
  const mainVideoElement = $('studio-video-preview');
  const currentTime = mainVideoElement ? mainVideoElement.currentTime : 0;

  // Xóa các vùng mờ không còn trong danh sách blurBoxes
  if (konvaLayer) {
    const existingShapes = konvaLayer.find('.blur-box-shape');
    existingShapes.forEach(shape => {
      const boxId = shape.getAttr('boxId');
      if (!blurBoxes.some(b => b.id === boxId)) {
        shape.destroy();
      }
    });
  }

  if (isBlurEnabled && konvaLayer) {
    blurBoxes.forEach((box, index) => {
      const shapeId = 'blur-box-' + box.id;
      let shape = konvaLayer.findOne('#' + shapeId);
      const isActive = activeBlurBoxId === box.id;

      // Xác định xem vùng mờ có hiển thị không
      // Hiển thị nếu: thời gian hiện tại nằm trong khoảng [start, end], HOẶC vùng mờ này đang được chỉnh sửa
      const isTimeActive = currentTime >= box.start && currentTime <= box.end;
      const shouldShow = isTimeActive || isActive;

      if (!shouldShow) {
        if (shape) {
          shape.visible(false);
          if (isActive && konvaTransformer.nodes().includes(shape)) {
            konvaTransformer.nodes([]);
          }
        }
        return;
      }

      // Đổi tọa độ phần trạng sang pixel trên canvas
      const blurX = (box.x / 100) * W_act;
      const blurY = (box.y / 100) * H_act;
      const blurW = (box.width / 100) * W_act;
      const blurH = (box.height / 100) * H_act;

      if (!shape) {
        shape = new Konva.Shape({
          id: shapeId,
          name: 'blur-box-shape',
          boxId: box.id,
          draggable: true,
          stroke: '#00E5FF',
          strokeWidth: 3,
          fill: 'transparent',
          dash: [8, 4],
          sceneFunc: function (context, shape) {
            const ctx = context._context;
            const w = shape.width();
            const h = shape.height();

            ctx.save();

            // Vẽ nội dung video đã làm mờ
            const mainVideo = $('studio-video-preview');
            if (mainVideo && mainVideo.readyState >= 2) {
              ctx.beginPath();
              ctx.rect(0, 0, w, h);
              ctx.clip();

              const x = shape.x();
              const y = shape.y();
              const radius = Number(box.radius || 20);
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

            // Vẽ viền ngoài
            context.fillStrokeShape(shape);
          }
        });

        // Bắt sự kiện kéo thả/co giãn
        shape.on('dragmove transform', () => {
          const currentBox = blurBoxes.find(b => b.id === box.id);
          if (!currentBox) return;

          let scaleX = shape.scaleX();
          let scaleY = shape.scaleY();

          let w = shape.width() * scaleX;
          let h = shape.height() * scaleY;
          let x = shape.x();
          let y = shape.y();

          const stageW = konvaStage.width();
          const stageH = konvaStage.height();

          const minSize = 10;
          if (scaleX !== 1 || scaleY !== 1) {
            // Đang co giãn
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
            // Đang kéo thả
            x = Math.max(0, Math.min(x, stageW - w));
            y = Math.max(0, Math.min(y, stageH - h));

            // Bắt dính căn giữa
            const snapped = applySnapping(shape, w, h, x, y);
            x = snapped.x;
            y = snapped.y;
          }

          shape.position({ x, y });
          shape.scaleX(1);
          shape.scaleY(1);
          shape.width(w);
          shape.height(h);

          // Cập nhật giá trị vào object
          currentBox.x = Math.max(0, Math.min(100, Math.round((x / stageW) * 100)));
          currentBox.y = Math.max(0, Math.min(100, Math.round((y / stageH) * 100)));
          currentBox.width = Math.max(1, Math.min(100, Math.round((w / stageW) * 100)));
          currentBox.height = Math.max(1, Math.min(100, Math.round((h / stageH) * 100)));

          // Đồng bộ trực tiếp giá trị lên giao diện (không render lại danh sách để tránh mất focus)
          const itemEl = document.querySelector(`.blur-box-item[data-id="${currentBox.id}"]`);
          if (itemEl) {
            const xInput = itemEl.querySelector('input[data-field="x"]');
            const yInput = itemEl.querySelector('input[data-field="y"]');
            const wInput = itemEl.querySelector('input[data-field="width"]');
            const hInput = itemEl.querySelector('input[data-field="height"]');
            if (xInput) xInput.value = currentBox.x;
            if (yInput) yInput.value = currentBox.y;
            if (wInput) wInput.value = currentBox.width;
            if (hInput) hInput.value = currentBox.height;
          }

          konvaLayer.draw();
        });

        shape.on('dragend', () => {
          hideGuidelines();
        });

        konvaLayer.add(shape);
      }

      // Cập nhật các thuộc tính của shape
      shape.visible(true);
      shape.position({ x: blurX, y: blurY });
      shape.width(blurW);
      shape.height(blurH);
      shape.stroke(isActive ? 'var(--accent)' : '#00E5FF');
      shape.strokeWidth(isActive ? 4 : 2);

      // Nếu đang active, đưa vào transformer
      if (isActive) {
        const currentNodes = konvaTransformer.nodes();
        const isEditingOther = currentNodes.length > 0 && 
                               (currentNodes[0].name() === 'subtitle' || currentNodes[0].name() === 'reaction');
        
        if (!isEditingOther && !currentNodes.includes(shape)) {
          konvaTransformer.enabledAnchors([
            'top-left', 'top-center', 'top-right',
            'middle-right',
            'bottom-right', 'bottom-center', 'bottom-left',
            'middle-left'
          ]);
          konvaTransformer.nodes([shape]);
          shape.moveToTop();
          konvaTransformer.moveToTop();
        }
      }
    });
  } else {
    // Nếu tắt làm mờ hoặc layer chưa được tạo, ẩn toàn bộ shapes vùng mờ
    if (konvaLayer) {
      konvaLayer.find('.blur-box-shape').forEach(shape => {
        shape.visible(false);
      });
    }
  }

  // Đảm bảo thứ tự hiển thị (Z-Index): Blur box dưới cùng -> Reaction PIP -> Phụ đề -> Đường căn -> Transformer
  if (konvaLayer) {
    konvaLayer.find('.blur-box-shape').forEach(shape => {
      shape.moveToBottom();
    });
    if (konvaReaction) {
      konvaReaction.moveToTop();
    }
    if (konvaSubtitle) {
      konvaSubtitle.moveToTop();
    }
    if (vGuideline) vGuideline.moveToTop();
    if (hGuideline) hGuideline.moveToTop();
    if (konvaTransformer) {
      konvaTransformer.moveToTop();
    }
  }

  konvaLayer.draw();
}

function updateBlurBoxPreview() {
  updateSubtitleOverlayFromInputs();
}

// --- MULTIPLE TIMED BLUR BOXES LOGIC ---
function addBlurBox() {
  const newBox = {
    id: Date.now(),
    x: 10,
    y: 75,
    width: 80,
    height: 15,
    radius: 20,
    start: 0,
    end: 99999
  };
  blurBoxes.push(newBox);
  activeBlurBoxId = newBox.id;



  renderBlurBoxesList();
  updateSubtitleOverlayFromInputs();
}

function removeBlurBox(id) {
  blurBoxes = blurBoxes.filter(b => b.id !== id);
  if (activeBlurBoxId === id) {
    activeBlurBoxId = blurBoxes.length > 0 ? blurBoxes[0].id : null;
  }
  renderBlurBoxesList();
  updateSubtitleOverlayFromInputs();
}

function selectBlurBox(id) {
  activeBlurBoxId = id;
  
  // 1. Update active class and styles on the list items directly
  document.querySelectorAll('.blur-box-item').forEach(item => {
    const itemId = parseInt(item.dataset.id);
    const isActive = itemId === id;
    item.classList.toggle('active', isActive);
    
    // Update container style inline
    item.style.background = isActive ? '#141e2a' : '#10161d';
    item.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    
    // Update title span text and color
    const titleSpan = item.querySelector('span');
    if (titleSpan) {
      const match = titleSpan.textContent.match(/Vùng mờ\s+#(\d+)/);
      if (match) {
        const num = match[1];
        titleSpan.textContent = `Vùng mờ #${num} ${isActive ? '(Đang chỉnh)' : ''}`;
      }
      titleSpan.style.color = isActive ? 'var(--accent)' : 'var(--text)';
    }
  });

  // 2. Update active class on timeline blocks
  document.querySelectorAll('.timeline-block').forEach(block => {
    const blockId = parseInt(block.dataset.id);
    block.classList.toggle('active', blockId === id);
  });
  
  // 3. Update Konva stage selection
  updateSubtitleOverlayFromInputs();
}

function renderBlurBoxesList() {
  const container = $('blur-boxes-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (blurBoxes.length === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 12px; color: var(--muted); font-size: 12px;">Chưa có vùng làm mờ nào. Nhấn "Thêm vùng mờ" để bắt đầu.</div>`;
    if (typeof renderTimeline === 'function') {
      renderTimeline();
    }
    return;
  }
  
  blurBoxes.forEach((box, index) => {
    const isActive = activeBlurBoxId === box.id;
    const item = document.createElement('div');
    item.className = `blur-box-item ${isActive ? 'active' : ''}`;
    item.dataset.id = box.id;
    item.style = `margin-top: 10px; padding: 10px; background: ${isActive ? '#141e2a' : '#10161d'}; border: 1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}; border-radius: 6px; cursor: pointer; transition: all 0.2s ease;`;
    
    // Switch to this box on click (unless clicking inside input or delete button)
    item.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
        selectBlurBox(box.id);
      }
    });

    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-size: 12px; font-weight: 700; color: ${isActive ? 'var(--accent)' : 'var(--text)'};">Vùng mờ #${index + 1} ${isActive ? '(Đang chỉnh)' : ''}</span>
        <button type="button" class="ghost-btn" style="padding: 2px 6px; font-size: 11px; color: var(--danger); border-color: rgba(239,68,68,0.2); background: transparent; height: auto;" onclick="event.stopPropagation(); removeBlurBox(${box.id})">🗑️ Xóa</button>
      </div>
      
      <!-- Hidden coordinates to prevent JS code crash -->
      <div style="display: none;">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="x" value="${box.x}">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="y" value="${box.y}">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="width" value="${box.width}">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="height" value="${box.height}">
      </div>

      <!-- Time bounds & blur slider settings -->
      <div class="sub-settings-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
        <div class="form-group" style="margin: 0;">
          <label style="font-size: 10px; margin: 0 0 2px 0; font-weight: 600;">⏱️ Bắt đầu (s)</label>
          <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="start" value="${box.start}" min="0" step="any" style="padding: 4px 6px; height: 32px;">
        </div>
        <div class="form-group" style="margin: 0;">
          <label style="font-size: 10px; margin: 0 0 2px 0; font-weight: 600;">⏱️ Kết thúc (s)</label>
          <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="end" value="${box.end}" min="0" step="any" style="padding: 4px 6px; height: 32px;">
        </div>
      </div>
      
      <!-- Blur Radius Slider -->
      <div class="form-group" style="margin: 8px 0 0 0; display: flex; flex-direction: column; gap: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <label style="font-size: 10px; margin: 0; font-weight: 600;">💧 Độ mờ (Radius)</label>
          <span id="radius-val-${box.id}" style="color: var(--accent); font-weight: 700; font-size: 11px;">${box.radius || 20}px</span>
        </div>
        <input type="range" class="premium-slider blur-input" data-id="${box.id}" data-field="radius" value="${box.radius || 20}" min="1" max="50" step="1" style="width: 100%; margin: 2px 0; cursor: pointer;" oninput="document.getElementById('radius-val-${box.id}').textContent = this.value + 'px'">
      </div>
    `;
    container.appendChild(item);
  });

  // Bind change event to input fields
  document.querySelectorAll('.blur-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const id = parseInt(e.target.dataset.id);
      const field = e.target.dataset.field;
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 0;
      
      const box = blurBoxes.find(b => b.id === id);
      if (box) {
        box[field] = val;
        // Limit bounds
        if (field === 'x' && box.x + box.width > 100) box.width = 100 - box.x;
        if (field === 'width' && box.x + box.width > 100) box.x = 100 - box.width;
        if (field === 'y' && box.y + box.height > 100) box.height = 100 - box.y;
        if (field === 'height' && box.y + box.height > 100) box.y = 100 - box.height;
        
        // Re-draw preview
        updateSubtitleOverlayFromInputs();
        if (typeof renderTimeline === 'function') {
          renderTimeline();
        }
      }
    });
  });

  if (typeof renderTimeline === 'function') {
    renderTimeline();
  }
}

// --- INTERACTIVE VISUAL EDITING TIMELINE LOGIC ---

function syncBoxInputs(box) {
  const video = $('studio-video-preview');
  const duration = video ? (video.duration || 0) : 0;
  
  document.querySelectorAll(`.blur-input[data-id="${box.id}"]`).forEach(input => {
    const field = input.dataset.field;
    if (field === 'start') {
      input.value = Number(box.start).toFixed(1);
    } else if (field === 'end') {
      input.value = box.end === 99999 ? (duration > 0 ? duration.toFixed(1) : 99999) : Number(box.end).toFixed(1);
    }
  });
}

function syncPlayhead() {
  const video = $('studio-video-preview');
  if (!video || !video.duration) return;
  
  const duration = video.duration;
  const timeLabel = $('timeline-time-label');
  if (timeLabel) {
    timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
  }
  
  const ruler = $('timeline-ruler');
  if (ruler) {
    const rulerWidth = ruler.clientWidth;
    const playhead = $('timeline-playhead');
    if (playhead && rulerWidth > 0) {
      const playheadLeft = (video.currentTime / duration) * rulerWidth;
      playhead.style.left = `${playheadLeft}px`;
    }
  }
}

function renderTimeline() {
  const video = $('studio-video-preview');
  if (!video || !video.duration) return;
  
  const duration = video.duration;
  const ruler = $('timeline-ruler');
  if (!ruler) return;
  const rulerWidth = ruler.clientWidth;
  if (rulerWidth === 0) return; // Not visible/rendered yet
  
  // 1. Draw ruler ticks and labels
  ruler.innerHTML = '';
  
  let tickInterval = 1;
  let labelInterval = 5;
  if (duration <= 30) {
    tickInterval = 1;
    labelInterval = 5;
  } else if (duration <= 120) {
    tickInterval = 5;
    labelInterval = 10;
  } else if (duration <= 600) {
    tickInterval = 10;
    labelInterval = 60;
  } else {
    tickInterval = 30;
    labelInterval = 120;
  }
  
  for (let t = 0; t <= duration; t += tickInterval) {
    const leftPx = (t / duration) * rulerWidth;
    const isMajor = (t % labelInterval === 0);
    
    const tick = document.createElement('div');
    tick.className = `timeline-ruler-tick ${isMajor ? 'major' : ''}`;
    tick.style.left = `${leftPx}px`;
    ruler.appendChild(tick);
    
    if (isMajor) {
      const label = document.createElement('div');
      label.className = 'timeline-ruler-label';
      label.style.left = `${leftPx}px`;
      label.textContent = formatTime(t);
      ruler.appendChild(label);
    }
  }
  
  // 2. Draw capsules on blur-track
  const blurTrack = $('blur-track');
  if (blurTrack) {
    blurTrack.innerHTML = '';
    
    blurBoxes.forEach((box, index) => {
      const isSelected = activeBlurBoxId === box.id;
      const block = document.createElement('div');
      block.className = `timeline-block ${isSelected ? 'active' : ''}`;
      block.dataset.id = box.id;
      
      const start = Math.max(0, Math.min(duration, box.start));
      const end = Math.max(start, Math.min(duration, box.end === 99999 ? duration : box.end));
      
      const leftPx = (start / duration) * rulerWidth;
      const rightPx = (end / duration) * rulerWidth;
      const widthPx = Math.max(15, rightPx - leftPx);
      
      block.style.left = `${leftPx}px`;
      block.style.width = `${widthPx}px`;
      
      block.innerHTML = `
        <div class="timeline-resize-handle left-handle"></div>
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; pointer-events: none; user-select: none;">Vùng mờ #${index + 1} (${start.toFixed(1)}s-${end.toFixed(1)}s)</span>
        <div class="timeline-resize-handle right-handle"></div>
      `;
      
      block.addEventListener('click', (e) => {
        if (!block.dataset.dragging && !block.dataset.resizing) {
          selectBlurBox(box.id);
        }
      });
      
      block.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        
        selectBlurBox(box.id);
        
        const initialClientX = e.clientX;
        const initialStart = box.start;
        const initialEnd = box.end === 99999 ? duration : box.end;
        const handle = e.target;
        const isLeftResize = handle.classList.contains('left-handle');
        const isRightResize = handle.classList.contains('right-handle');
        const isMove = !isLeftResize && !isRightResize;
        
        if (isLeftResize) block.dataset.resizing = 'left';
        if (isRightResize) block.dataset.resizing = 'right';
        if (isMove) block.dataset.dragging = 'true';
        
        let lastMoveEvent = null;
        let animationFrameId = null;
        let seekTimeout = null;
        
        const seekVideoDebounced = (time) => {
          if (seekTimeout) {
            clearTimeout(seekTimeout);
          }
          seekTimeout = setTimeout(() => {
            video.currentTime = time;
          }, 80);
        };
        
        const onMouseMove = (moveEvent) => {
          lastMoveEvent = moveEvent;
          
          if (!animationFrameId) {
            animationFrameId = requestAnimationFrame(() => {
              if (lastMoveEvent) {
                const deltaX = lastMoveEvent.clientX - initialClientX;
                const deltaSec = (deltaX / rulerWidth) * duration;
                
                if (isMove) {
                  let newStart = initialStart + deltaSec;
                  let newEnd = initialEnd + deltaSec;
                  const diff = newEnd - newStart;
                  if (newStart < 0) {
                    newStart = 0;
                    newEnd = diff;
                  }
                  if (newEnd > duration) {
                    newEnd = duration;
                    newStart = duration - diff;
                  }
                  box.start = Number(newStart.toFixed(3));
                  box.end = Number(newEnd.toFixed(3));
                  seekVideoDebounced(box.start);
                } else if (isLeftResize) {
                  let newStart = initialStart + deltaSec;
                  if (newStart < 0) newStart = 0;
                  if (newStart > initialEnd - 0.2) newStart = initialEnd - 0.2;
                  box.start = Number(newStart.toFixed(3));
                  seekVideoDebounced(box.start);
                } else if (isRightResize) {
                  let newEnd = initialEnd + deltaSec;
                  if (newEnd > duration) newEnd = duration;
                  if (newEnd < initialStart + 0.2) newEnd = initialStart + 0.2;
                  box.end = Number(newEnd.toFixed(3));
                  seekVideoDebounced(box.end === 99999 ? duration : box.end);
                }
                
                // Fast UI updates
                const finalStart = box.start;
                const finalEnd = box.end === 99999 ? duration : box.end;
                block.style.left = `${(finalStart / duration) * rulerWidth}px`;
                block.style.width = `${Math.max(15, ((finalEnd - finalStart) / duration) * rulerWidth)}px`;
                const textSpan = block.querySelector('span');
                if (textSpan) {
                  textSpan.textContent = `Vùng mờ #${index + 1} (${finalStart.toFixed(1)}s-${finalEnd.toFixed(1)}s)`;
                }
                
                syncBoxInputs(box);
                updateSubtitleOverlayFromInputs();
              }
              animationFrameId = null;
            });
          }
        };
        
        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          
          if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
          }
          if (seekTimeout) {
            clearTimeout(seekTimeout);
            seekTimeout = null;
          }
          
          // Final instant seek on release
          const finalTime = isRightResize ? (box.end === 99999 ? duration : box.end) : box.start;
          video.currentTime = finalTime;
          
          setTimeout(() => {
            delete block.dataset.dragging;
            delete block.dataset.resizing;
          }, 50);
          
          renderBlurBoxesList();
        };
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
      
      blurTrack.appendChild(block);
    });
  }
  
  syncPlayhead();
}

function initTimelineControls() {
  const video = $('studio-video-preview');
  const ruler = $('timeline-ruler');
  if (!video || !ruler) return;
  
  const playBtn = $('timeline-play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (video.paused) {
        video.play().catch(err => console.log("Play interrupted:", err));
      } else {
        video.pause();
      }
    });
  }
  
  video.addEventListener('play', () => {
    if (playBtn) playBtn.textContent = '⏸ Tạm dừng';
  });
  video.addEventListener('pause', () => {
    if (playBtn) playBtn.textContent = '▶ Phát';
  });
  
  video.addEventListener('timeupdate', () => {
    syncPlayhead();
  });
  
  let lastScrubEvent = null;
  let scrubFrameId = null;
  
  const seekToPosition = (e) => {
    lastScrubEvent = e;
    
    if (!scrubFrameId) {
      scrubFrameId = requestAnimationFrame(() => {
        if (lastScrubEvent) {
          const rect = ruler.getBoundingClientRect();
          const clickX = lastScrubEvent.clientX - rect.left;
          const percent = Math.max(0, Math.min(1, clickX / rect.width));
          if (video.duration) {
            video.currentTime = percent * video.duration;
            syncPlayhead();
          }
        }
        scrubFrameId = null;
      });
    }
  };
  
  ruler.addEventListener('mousedown', (e) => {
    e.preventDefault();
    seekToPosition(e);
    
    const onMouseMove = (moveEvent) => {
      seekToPosition(moveEvent);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (scrubFrameId) {
        cancelAnimationFrame(scrubFrameId);
        scrubFrameId = null;
      }
    };
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  
  window.addEventListener('resize', () => {
    renderTimeline();
  });
}

// --- AUTOMATION STUDIO TEMPLATES MANAGEMENT ---
function closeSaveTemplateModal() {
  const modal = $('save-template-modal');
  if (modal) modal.classList.add('hidden');
}

function saveStudioTemplate() {
  const modal = $('save-template-modal');
  const input = $('save-template-name-input');
  if (modal && input) {
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();
    renderCurrentConfigSummary();
  }
}

function renderCurrentConfigSummary() {
  const list = $('save-template-summary-list');
  if (!list) return;

  const summary = [];

  // Helper function to safely get selected text of a SELECT element or value of an INPUT
  function getSelectedText(selectEl, fallback = '') {
    if (!selectEl) return fallback;
    if (selectEl.tagName === 'SELECT') {
      return selectEl.options[selectEl.selectedIndex]?.text || selectEl.value || fallback;
    }
    return selectEl.value || fallback;
  }

  // 1. Phụ đề (Subtitles)
  const subModeInput = $('subtitle-mode');
  const subModeVal = subModeInput ? subModeInput.value : 'none';
  if (subModeVal === 'none') {
    summary.push(`<div>📝 <b>Phụ đề:</b> Không dùng</div>`);
  } else {
    const fontSelect = document.querySelector('select[name="subtitleFont"]');
    const sizeInput = document.querySelector('input[name="subtitleSize"]');
    const colorInput = document.querySelector('input[name="subtitleColor"]');
    const themeSelect = document.querySelector('select[name="subtitleTheme"]');
    const boldSelect = document.querySelector('select[name="subtitleBold"]');
    const maxLinesSelect = document.querySelector('select[name="subtitleMaxLines"]');
    const marginInput = document.querySelector('input[name="subtitleMargin"]');
    const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
    
    let subtitleParts = [];
    if (fontSelect) subtitleParts.push(`Phông: ${getSelectedText(fontSelect)}`);
    if (sizeInput) subtitleParts.push(`Cỡ: ${sizeInput.value}px`);
    if (colorInput) {
      subtitleParts.push(`Màu: <span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${colorInput.value}; vertical-align:middle; border:1px solid rgba(255,255,255,0.2);"></span> ${colorInput.value}`);
    }
    if (themeSelect) subtitleParts.push(`Kiểu: ${getSelectedText(themeSelect)}`);
    if (boldSelect && boldSelect.value === 'yes') subtitleParts.push(`In đậm`);
    if (maxLinesSelect) subtitleParts.push(`Dòng tối đa: ${maxLinesSelect.value}`);
    if (marginInput) subtitleParts.push(`Lề dọc: ${marginInput.value}px`);
    if (marginHInput) subtitleParts.push(`Lề ngang: ${marginHInput.value}px`);

    summary.push(`<div>📝 <b>Phụ đề:</b> ${subtitleParts.join(' | ') || 'Không thiết lập'}</div>`);
  }

  // Làm mờ phụ đề gốc
  if (blurBoxes && blurBoxes.length > 0) {
    const details = blurBoxes.map((box, idx) => {
      const startSec = Number(box.start || 0).toFixed(1);
      const endSec = box.end === 99999 ? 'Hết video' : `${Number(box.end || 0).toFixed(1)}s`;
      return `Vùng ${idx + 1}: ${startSec}s - ${endSec} (Độ mờ: ${box.radius || 20}px)`;
    }).join(' | ');
    summary.push(`<div>🛡️ <b>Mờ phụ đề gốc:</b> Bật (${blurBoxes.length} vùng mờ)<br><span style="color: var(--muted); font-size: 11px; margin-left: 20px;">➔ ${details}</span></div>`);
  }

  // 2. Thuyết minh (Voiceover)
  const voiceModeInput = $('voice-mode');
  let voiceModeVal = 'none';
  if (voiceModeInput) {
    let voiceModeText = 'Không chèn';
    voiceModeVal = voiceModeInput.value;
    if (voiceModeVal === 'saved') voiceModeText = 'Giọng thuyết minh đã lưu';
    else if (voiceModeVal === 'upload') voiceModeText = 'Tải lên file mới';
    else if (voiceModeVal === 'omi' || voiceModeVal === 'cloner') voiceModeText = 'Thuyết minh tự động (Omni Cloner)';
    
    let voiceDetail = '';
    if (voiceModeVal !== 'none') {
      const voiceSelect = $('saved-voice-select');
      if (voiceSelect && voiceSelect.value) {
        voiceDetail = ` (${voiceSelect.value})`;
      }
    }
    summary.push(`<div>🎙️ <b>Thuyết minh:</b> ${voiceModeText}${voiceDetail}</div>`);
  }

  // 3. Nhạc nền (Background Music)
  const musicModeInput = $('music-mode');
  let musicModeVal = 'none';
  if (musicModeInput) {
    let musicModeText = 'Không dùng';
    musicModeVal = musicModeInput.value;
    if (musicModeVal === 'saved') musicModeText = 'Nhạc nền đã lưu';
    else if (musicModeVal === 'upload') musicModeText = 'Tải lên file mới';
    
    let musicDetail = '';
    if (musicModeVal !== 'none') {
      const musicSelect = $('saved-music-select');
      if (musicSelect && musicSelect.value) {
        musicDetail = ` (${musicSelect.value})`;
      }
    }
    summary.push(`<div>🎵 <b>Nhạc nền:</b> ${musicModeText}${musicDetail}</div>`);
  }

  // 4. Âm lượng (Volumes)
  const volOrg = document.querySelector('input[name="originalVolume"]');
  const volVoice = document.querySelector('input[name="voiceVolume"]');
  const volMusic = document.querySelector('input[name="musicVolume"]');
  if (volOrg || volVoice || volMusic) {
    const vols = [];
    if (volOrg) vols.push(`Gốc: ${Math.round(sliderToVolume(volOrg.value) * 100)}%`);
    if (volVoice && voiceModeVal !== 'none') vols.push(`Giọng đọc: ${Math.round(sliderToVolume(volVoice.value) * 100)}%`);
    if (volMusic && musicModeVal !== 'none') vols.push(`Nhạc nền: ${Math.round(sliderToVolume(volMusic.value) * 100)}%`);
    summary.push(`<div>🔊 <b>Âm lượng:</b> ${vols.join(' | ')}</div>`);
  }

  // 5. Cấu hình AI Cloner (nếu có thuyết minh cloner)
  if (voiceModeVal === 'omi' || voiceModeVal === 'cloner') {
    const omiLanguage = document.querySelector('select[name="omiLanguage"]');
    const omiDevice = document.querySelector('select[name="omiDevice"]');
    const omiSteps = document.querySelector('input[name="omiSteps"]');
    const omiSeed = $('omi-seed-preset');
    const omiCustomSeed = $('omi-seed-input');
    
    let clonerParts = [];
    if (omiLanguage) clonerParts.push(`Ngôn ngữ: ${getSelectedText(omiLanguage)}`);
    if (omiDevice) clonerParts.push(`Thiết bị: ${getSelectedText(omiDevice)}`);
    if (omiSteps) clonerParts.push(`Bước (Steps): ${omiSteps.value}`);
    if (omiSeed && omiSeed.value === 'custom' && omiCustomSeed) {
      clonerParts.push(`Seed: ${omiCustomSeed.value}`);
    } else if (omiSeed) {
      clonerParts.push(`Seed: ${omiSeed.value}`);
    }
    summary.push(`<div>🤖 <b>OmniVoice Cloner:</b> ${clonerParts.join(' | ')}</div>`);
  }

  list.innerHTML = summary.map(item => `<div style="line-height: 1.6; border-bottom: 1px solid rgba(255,255,255,0.02); padding-bottom: 4px; margin-bottom: 4px;">${item}</div>`).join('');
}



function submitSaveTemplate(event) {
  event.preventDefault();
  const input = $('save-template-name-input');
  if (!input) return;
  const templateName = input.value.trim();
  if (!templateName) return;

  closeSaveTemplateModal();

  let templates = JSON.parse(localStorage.getItem('studio_templates') || '{}');

  templates[templateName] = {
    subtitleMode: $('subtitle-mode') ? $('subtitle-mode').value : 'none',
    savedSubtitleFile: $('saved-subtitle-select') ? $('saved-subtitle-select').value : '',
    subtitleAlignment: $('subtitle-alignment-input') ? $('subtitle-alignment-input').value : '10',
    subtitleSize: document.querySelector('input[name="subtitleSize"]').value,
    subtitleFont: document.querySelector('select[name="subtitleFont"]').value,
    subtitleColor: document.querySelector('input[name="subtitleColor"]').value,
    subtitleTheme: document.querySelector('select[name="subtitleTheme"]').value,
    subtitleBold: document.querySelector('select[name="subtitleBold"]').value,
    subtitleMaxLines: document.querySelector('select[name="subtitleMaxLines"]').value,
    subtitleMargin: document.querySelector('input[name="subtitleMargin"]').value,
    subtitleMarginH: document.querySelector('input[name="subtitleMarginH"]').value,
    subtitleTemplateWidth: konvaStage ? konvaStage.width() : (document.querySelector('select[name="preview-aspect-select"]')?.value === '16-9' ? 1920 : 1080),
    blurOriginalSub: (blurBoxes && blurBoxes.length > 0),
    blurBoxes: blurBoxes,
    voiceMode: $('voice-mode').value,
    savedVoiceFile: $('saved-voice-select').value,
    omiLanguage: document.querySelector('select[name="omiLanguage"]').value,
    omiDevice: document.querySelector('select[name="omiDevice"]').value,
    omiSteps: document.querySelector('input[name="omiSteps"]').value,
    omiSeed: $('omi-seed-preset').value,
    omiCustomSeed: $('omi-seed-input').value,
    musicMode: $('music-mode').value,
    savedMusicFile: $('saved-music-select').value,
    originalVolume: sliderToVolume(document.querySelector('input[name="originalVolume"]').value),
    voiceVolume: sliderToVolume(document.querySelector('input[name="voiceVolume"]').value),
    musicVolume: sliderToVolume(document.querySelector('input[name="musicVolume"]').value),
  };

  localStorage.setItem('studio_templates', JSON.stringify(templates));
  toast('Đã lưu cấu hình sẵn thành công!', 'success');
  updateTemplateSelectDropdown();
  selectCustomTemplate(templateName);
}

// Toggle custom template dropdown menu visibility
function toggleCustomTemplateDropdown(event) {
  if (event) event.stopPropagation();
  const menu = $('custom-template-menu');
  if (menu) {
    menu.classList.toggle('hidden');
  }
}

// Select a template from the custom dropdown menu
function selectCustomTemplate(name) {
  const select = $('studio-template-select');
  const label = $('selected-template-label');
  if (select) {
    select.value = name;
    select.dispatchEvent(new Event('change'));
  } else {
    loadStudioTemplate(name);
  }
  if (label) {
    label.textContent = name || '-- Chọn cấu hình sẵn --';
  }
  const menu = $('custom-template-menu');
  if (menu) {
    menu.classList.add('hidden');
  }
}

// Delete a template from the custom dropdown list
function deleteCustomTemplate(event, name) {
  if (event) event.stopPropagation();
  if (!name) return;

  if (confirm(`Bạn có chắc chắn muốn xóa cấu hình "${name}" không?`)) {
    let templates = JSON.parse(localStorage.getItem('studio_templates') || '{}');
    delete templates[name];
    localStorage.setItem('studio_templates', JSON.stringify(templates));
    toast('🎉 Đã xóa cấu hình thành công!', 'success');
    
    const select = $('studio-template-select');
    if (select && select.value === name) {
      select.value = '';
      const label = $('selected-template-label');
      if (label) label.textContent = '-- Chọn cấu hình sẵn --';
    }
    
    updateTemplateSelectDropdown();
  }
}

// Global click handler to close template dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dropdown = document.querySelector('.premium-custom-dropdown');
  const menu = $('custom-template-menu');
  if (dropdown && !dropdown.contains(e.target) && menu) {
    menu.classList.add('hidden');
  }
});

function updateTemplateSelectDropdown() {
  const select = $('studio-template-select');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Chọn cấu hình sẵn --</option>';

  const templates = JSON.parse(localStorage.getItem('studio_templates') || '{}');
  Object.keys(templates).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  if (templates[currentVal]) {
    select.value = currentVal;
  }

  // Populate custom dropdown list
  const menu = $('custom-template-menu');
  if (menu) {
    let menuHtml = `
      <div class="custom-dropdown-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; cursor: pointer; color: var(--muted); font-size: 13px; transition: background 0.2s;" onclick="selectCustomTemplate('')">
        <span style="flex: 1; text-align: left;">-- Chọn cấu hình sẵn --</span>
      </div>
    `;
    
    Object.keys(templates).forEach(name => {
      menuHtml += `
        <div class="custom-dropdown-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; cursor: pointer; color: var(--text); font-size: 13px; transition: background 0.2s;">
          <span onclick="selectCustomTemplate('${name}')" style="flex: 1; text-align: left;">${name}</span>
          <button type="button" onclick="deleteCustomTemplate(event, '${name}')" class="delete-template-btn" style="background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; font-size: 14px; border-radius: 4px; transition: all 0.2s;">
            🗑️
          </button>
        </div>
      `;
    });
    menu.innerHTML = menuHtml;

    // Add mouseenter/mouseleave dynamic hover states
    menu.querySelectorAll('.custom-dropdown-item').forEach(item => {
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(255, 255, 255, 0.05)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
    });

    menu.querySelectorAll('.delete-template-btn').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        btn.style.color = '#ef4444';
        btn.style.background = 'rgba(239, 68, 68, 0.1)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.color = 'var(--muted)';
        btn.style.background = 'transparent';
      });
    });
  }

  // Update selection label
  const label = $('selected-template-label');
  if (label) {
    label.textContent = currentVal || '-- Chọn cấu hình sẵn --';
  }
}

function loadStudioTemplate(templateName) {
  if (!templateName) return;

  const templates = JSON.parse(localStorage.getItem('studio_templates') || '{}');
  const template = templates[templateName];
  if (!template) return;

  // Restore subtitle mode
  if (template.subtitleMode) {
    const subModeBtn = document.querySelector(`.sub-tab-btn[data-sub-mode="${template.subtitleMode}"]`);
    if (subModeBtn) {
      subModeBtn.click();
    }
  }

  // Restore subtitle alignment
  if (template.subtitleAlignment) {
    const alignInput = $('subtitle-alignment-input');
    if (alignInput) {
      alignInput.value = template.subtitleAlignment;
      alignInput.dispatchEvent(new Event('change'));
    }
    const alignGrid = $('alignment-visual-grid');
    if (alignGrid) {
      alignGrid.querySelectorAll('.grid-cell').forEach(c => {
        c.classList.toggle('active', c.dataset.align === template.subtitleAlignment);
      });
    }
  }

  // Restore saved subtitle file
  if (template.savedSubtitleFile) {
    const subSelect = $('saved-subtitle-select');
    if (subSelect) {
      subSelect.value = template.savedSubtitleFile;
      subSelect.dispatchEvent(new Event('change'));
    }
  }

  // Restore subtitle styles
  const sizeInput = document.querySelector('input[name="subtitleSize"]');
  if (sizeInput) {
    sizeInput.value = template.subtitleSize;
    sizeInput.dispatchEvent(new Event('input'));
  }
  document.querySelector('select[name="subtitleFont"]').value = template.subtitleFont;
  
  // Set subtitle color input and preview swatch
  const colorInput = document.querySelector('input[name="subtitleColor"]');
  if (colorInput) {
    colorInput.value = template.subtitleColor;
    const colorValSpan = $('subtitle-color-val');
    if (colorValSpan) colorValSpan.textContent = template.subtitleColor;
  }

  document.querySelector('select[name="subtitleTheme"]').value = template.subtitleTheme;
  document.querySelector('select[name="subtitleBold"]').value = template.subtitleBold;
  document.querySelector('select[name="subtitleMaxLines"]').value = template.subtitleMaxLines;
  document.querySelector('input[name="subtitleMargin"]').value = template.subtitleMargin;
  const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
  if (marginHInput) {
    marginHInput.value = template.subtitleMarginH;
    if (template.subtitleTemplateWidth) {
      marginHInput.dataset.lastStageWidth = template.subtitleTemplateWidth;
    } else {
      marginHInput.dataset.lastStageWidth = (Number(template.subtitleMarginH) > 200) ? '1920' : '1080';
    }
  }

  // Restore blur settings

  
  blurBoxes = template.blurBoxes || [];
  activeBlurBoxId = blurBoxes.length > 0 ? blurBoxes[0].id : null;
  renderBlurBoxesList();

  // Restore voice mode
  const voiceModeBtn = document.querySelector(`.voice-tab-btn[data-voice-mode="${template.voiceMode}"]`);
  if (voiceModeBtn) {
    voiceModeBtn.click();
  }
  if (template.savedVoiceFile) {
    $('saved-voice-select').value = template.savedVoiceFile;
  }

  // Restore Omi settings
  document.querySelector('select[name="omiLanguage"]').value = template.omiLanguage;
  document.querySelector('select[name="omiDevice"]').value = template.omiDevice;
  
  const stepsSlider = document.querySelector('input[name="omiSteps"]');
  if (stepsSlider) {
    stepsSlider.value = template.omiSteps;
    const stepsBadge = $('omi-steps-badge');
    if (stepsBadge) stepsBadge.textContent = template.omiSteps;
  }

  const omiSeedPreset = $('omi-seed-preset');
  if (omiSeedPreset) {
    omiSeedPreset.value = template.omiSeed;
    omiSeedPreset.dispatchEvent(new Event('change'));
  }
  if (template.omiCustomSeed) {
    $('omi-seed-input').value = template.omiCustomSeed;
  }

  // Restore music mode
  const musicModeBtn = document.querySelector(`.music-tab-btn[data-music-mode="${template.musicMode}"]`);
  if (musicModeBtn) {
    musicModeBtn.click();
  }
  if (template.savedMusicFile) {
    $('saved-music-select').value = template.savedMusicFile;
  }

  // Restore volumes
  const originalSlider = document.querySelector('input[name="originalVolume"]');
  if (originalSlider) {
    originalSlider.value = volumeToSlider(template.originalVolume);
    const valEl = $('original-volume-val');
    if (valEl) valEl.textContent = Math.round(template.originalVolume * 100) + '%';
  }

  const voiceSlider = document.querySelector('input[name="voiceVolume"]');
  if (voiceSlider) {
    voiceSlider.value = volumeToSlider(template.voiceVolume);
    const valEl = $('voice-volume-val');
    if (valEl) valEl.textContent = Math.round(template.voiceVolume * 100) + '%';
  }

  const musicSlider = document.querySelector('input[name="musicVolume"]');
  if (musicSlider) {
    musicSlider.value = volumeToSlider(template.musicVolume);
    const valEl = $('music-volume-val');
    if (valEl) valEl.textContent = Math.round(template.musicVolume * 100) + '%';
  }

  toast(`🎉 Đã áp dụng cấu hình "${templateName}"!`, 'success');
  updateSubtitleOverlayFromInputs();
  renderQuickVoices();
  renderQuickMusic();
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
      const preview = $('reaction-upload-preview');
      if (preview) preview.removeAttribute('src');
      const container = $('reaction-upload-preview-container');
      if (container) container.classList.add('hidden');
      setPreviewReactionVideo(null);
    } else {
      $('selected-reaction-video-file').value = '';
      document.querySelectorAll('#studio-reaction-video-grid .video-card-item').forEach(card => card.classList.remove('selected'));
      $('reaction-upload').value = '';
      const preview = $('reaction-upload-preview');
      if (preview) preview.removeAttribute('src');
      const container = $('reaction-upload-preview-container');
      if (container) container.classList.add('hidden');
      setPreviewReactionVideo(null);
    }
    
    updateConditionalFields();
  });
});

// Local video upload preview and auto-upload handler
$('video-upload').addEventListener('change', async function() {
  const container = $('upload-video-preview-container');
  const video = $('upload-video-preview');
  const nameEl = $('upload-video-name');
  const sizeEl = $('upload-video-size');
  
  if (this.files && this.files[0]) {
    const file = this.files[0];
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    nameEl.textContent = file.name;
    sizeEl.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    container.classList.remove('hidden');
    setPreviewVideo(objectUrl);

    try {
      toast('Đang tự động tải video lên thư mục...', 'info');
      const formData = new FormData();
      formData.append('video', file);
      formData.append('videoName', file.name);

      const res = await fetch('/api/save-video', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Không lưu được video');
      
      toast(data.message || 'Đã lưu video nguồn thành công!', 'success');
      await loadAssets();
      
      if (data.video) {
        selectSourceVideo(data.video);
      }
      
      const libraryTabBtn = document.querySelector('.source-tab-btn[data-source-mode="library"]');
      if (libraryTabBtn) {
        libraryTabBtn.click();
      }
    } catch (error) {
      toast(`Lỗi tải video: ${error.message}`, 'error');
    }
  } else {
    video.removeAttribute('src');
    container.classList.add('hidden');
    setPreviewVideo(null);
  }
  updateConditionalFields();
});

// Local music upload preview and auto-upload handler
$('music-upload').addEventListener('change', async function() {
  const container = $('upload-music-preview-container');
  const audio = $('upload-music-preview');
  const nameEl = $('upload-music-name');
  const sizeEl = $('upload-music-size');
  
  if (this.files && this.files[0]) {
    const file = this.files[0];
    const objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    nameEl.textContent = file.name;
    sizeEl.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    container.classList.remove('hidden');

    try {
      toast('Đang tự động tải nhạc lên thư mục...', 'info');
      const formData = new FormData();
      formData.append('music', file);
      formData.append('musicName', file.name);

      const res = await fetch('/api/save-music', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Không lưu được nhạc');
      
      toast(data.message || 'Đã lưu nhạc nền thành công!', 'success');
      await loadAssets();
      
      if (data.music) {
        selectMusicFile(data.music);
      }
      
      const savedTabBtn = document.querySelector('.music-tab-btn[data-music-mode="saved"]');
      if (savedTabBtn) {
        savedTabBtn.click();
      }
    } catch (error) {
      toast(`Lỗi tải nhạc: ${error.message}`, 'error');
    }
  } else {
    audio.removeAttribute('src');
    container.classList.add('hidden');
  }
  updateConditionalFields();
});

$('fetch-btn').addEventListener('click', fetchVideoInfo);
$('url-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fetchVideoInfo();
});
$('refresh-assets-btn').addEventListener('click', openConnectionStatusModal);
$('save-voice-form').addEventListener('submit', saveVoice);
$('save-music-form').addEventListener('submit', saveMusic);
$('studio-form').addEventListener('submit', renderStudio);
$('bulk-fetch-btn').addEventListener('click', fetchPlaylistInfo);
const selectAllCheck = $('bulk-select-all');
if (selectAllCheck) {
  selectAllCheck.addEventListener('change', (e) => {
    const checked = e.target.checked;
    currentPlaylistVideos.forEach(v => {
      v.selected = checked;
    });
    renderPlaylistVideos();
  });
}
const bulkDlBtn = $('bulk-download-selected-btn');
if (bulkDlBtn) {
  bulkDlBtn.addEventListener('click', downloadSelectedBulkVideos);
}
['subtitle-mode', 'voice-mode', 'music-mode', 'reaction-mode'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', updateConditionalFields);
});

// Update template select dropdown on startup
updateTemplateSelectDropdown();

// Bind studio-template-select change event listener
const templateSelect = $('studio-template-select');
if (templateSelect) {
  templateSelect.addEventListener('change', (e) => {
    loadStudioTemplate(e.target.value);
  });
}

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
    container.querySelectorAll('.tiktok-playpause-icon').forEach(icon => {
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
    el.addEventListener('input', (e) => {
      if (e && e.isTrusted) updateSubtitleOverlayFromInputs();
    });
    el.addEventListener('change', (e) => {
      if (e && e.isTrusted) updateSubtitleOverlayFromInputs();
    });
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

    // Row 5: Viền Mỏng (Arial Bold, Outline)
    'thin-white': { color: '#FFFFFF', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-yellow': { color: '#FFEB3B', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-cyan': { color: '#00E5FF', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-green': { color: '#00FF00', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-pink': { color: '#FF4081', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-red': { color: '#FF0000', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-orange': { color: '#FF9800', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },
    'thin-black': { color: '#000000', theme: 'outline', font: 'Arial', bold: 'true', size: 24 },

    // Row 6: Neon & 3D (CapCut Style)
    'neon-green': { color: '#00FF00', theme: 'neon-glow', font: 'Impact', bold: 'true', size: 32 },
    'neon-pink': { color: '#FF4081', theme: 'neon-glow', font: 'Impact', bold: 'true', size: 32 },
    'neon-cyan': { color: '#00E5FF', theme: 'neon-glow', font: 'Impact', bold: 'true', size: 32 },
    'neon-yellow': { color: '#FFEB3B', theme: 'neon-glow', font: 'Impact', bold: 'true', size: 32 },
    '3d-yellow': { color: '#FFEB3B', theme: 'three-d', font: 'Impact', bold: 'true', size: 32 },
    '3d-blue': { color: '#00E5FF', theme: 'three-d', font: 'Impact', bold: 'true', size: 32 },
    '3d-red': { color: '#FF3B30', theme: 'three-d', font: 'Impact', bold: 'true', size: 32 },
    '3d-orange': { color: '#FF9800', theme: 'three-d', font: 'Impact', bold: 'true', size: 32 }
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
        valSpan.textContent = Math.round(sliderToVolume(el.value) * 100) + '%';
      }
    };
    el.addEventListener('input', updateLabel);
    el.addEventListener('change', updateLabel);
    // Initialize
    updateLabel();
  }
});

$('reaction-upload').addEventListener('change', async function() {
  const container = $('reaction-upload-preview-container');
  const video = $('reaction-upload-preview');
  const nameEl = $('reaction-upload-video-name');
  const sizeEl = $('reaction-upload-video-size');

  if (this.files && this.files[0]) {
    const file = this.files[0];
    const objectUrl = URL.createObjectURL(file);
    if (video) video.src = objectUrl;
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    if (container) container.classList.remove('hidden');
    setPreviewReactionVideo(objectUrl);

    try {
      toast('Đang tự động tải video reaction lên thư mục...', 'info');
      const formData = new FormData();
      formData.append('video', file);
      formData.append('videoName', file.name);

      const res = await fetch('/api/save-video', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Không lưu được video reaction');
      
      toast(data.message || 'Đã lưu video reaction thành công!', 'success');
      await loadAssets();
      
      if (data.video) {
        selectReactionVideo(data.video);
      }
      
      const savedTabBtn = document.querySelector('.reaction-tab-btn[data-reaction-tab-mode="library"]');
      if (savedTabBtn) {
        savedTabBtn.click();
      }
    } catch (error) {
      toast(`Lỗi tải video reaction: ${error.message}`, 'error');
    }
  } else {
    if (video) video.removeAttribute('src');
    if (container) container.classList.add('hidden');
    setPreviewReactionVideo(null);
  }
  updateConditionalFields();
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
  btn.addEventListener('click', (e) => {
    const mode = btn.dataset.voiceMode;
    if (mode === 'omi' && !assets.omiConfigured && e && e.isTrusted) {
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
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const input = $('subtitle-mode');
    if (input) {
      const mode = btn.dataset.subMode;
      input.value = mode;
      

      
      // Automatically center subtitle overlay when any active subtitle mode is selected
      if (e && e.isTrusted && mode !== 'none') {
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

// Live updating Subtitle Size badge
const subtitleSizeSlider = document.getElementById('subtitle-size-slider');
if (subtitleSizeSlider) {
  const subtitleSizeVal = document.getElementById('subtitle-size-val');
  const updateSubtitleSize = () => {
    if (subtitleSizeVal) subtitleSizeVal.textContent = subtitleSizeSlider.value + 'px';
  };
  subtitleSizeSlider.addEventListener('input', updateSubtitleSize);
  subtitleSizeSlider.addEventListener('change', updateSubtitleSize);
  updateSubtitleSize();
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

// Initialize default global settings if not set
if (!localStorage.getItem('global_ai_provider')) {
  localStorage.setItem('global_ai_provider', 'google-translate');
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
    initGeminiModelListeners();
    initOpenRouterModelListeners();
    initActiveProject();
  });
} else {
  initFbPages();
  initRenderedVideos();
  initVoicesAndMusic();
  loadDownloadHistory();
  initGeminiModelListeners();
  initOpenRouterModelListeners();
  initActiveProject();
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
  const uploadAudio = $('upload-music-preview');
  if (uploadAudio) {
    uploadAudio.pause();
  }
}

function togglePlayAudio(btn, url) {
  if (currentAudio && currentAudioUrl === url) {
    if (!currentAudio.paused) {
      currentAudio.pause();
      updatePlayButtonsState(url, false);
      return;
    } else {
      currentAudio.play().catch(() => {});
      updatePlayButtonsState(url, true);
      return;
    }
  }

  if (currentAudio) {
    currentAudio.pause();
    updatePlayButtonsState(currentAudioUrl, false);
  }

  currentAudioUrl = url;
  currentPlayBtn = btn;
  currentAudio = new Audio(url);
  updatePlayButtonsState(url, true);
  
  currentAudio.play().catch(err => {
    toast('❌ Không thể phát audio: ' + err.message, 'error');
    updatePlayButtonsState(url, false);
  });

  currentAudio.onended = () => {
    updatePlayButtonsState(url, false);
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

function toggleVoiceDropdown(e) {
  if (e) e.stopPropagation();
  const dropdown = $('voice-dropdown-content');
  if (dropdown) {
    dropdown.classList.toggle('hidden');
  }
}

// Close the voice dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dropdown = $('voice-dropdown-content');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    const trigger = $('open-add-voice-btn');
    const isClickInside = dropdown.contains(e.target) || (trigger && trigger.contains(e.target));
    if (!isClickInside) {
      dropdown.classList.add('hidden');
    }
  }
});

function openVbeeGenerateVoiceModal() {
  const modal = $('vbee-generate-voice-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeVbeeGenerateVoiceModal() {
  const modal = $('vbee-generate-voice-modal');
  if (modal) {
    modal.classList.add('hidden');
    $('vbee-generate-voice-form').reset();
  }
}

async function generateVbeeVoice(event) {
  event.preventDefault();
  const voiceName = $('vbee-voice-name').value.trim();
  const voiceCode = $('vbee-voice-code').value;
  const text = $('vbee-text').value.trim();

  if (!voiceName || !voiceCode || !text) {
    toast('❌ Vui lòng nhập đầy đủ thông tin!', 'error');
    return;
  }

  const btn = $('vbee-generate-btn');
  setBusy(btn, true, 'Đang tạo giọng...');

  try {
    const res = await fetch('/api/generate-vbee-voice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ voiceName, voiceCode, text })
    });

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Lỗi khi kết nối với Vbee AI');
    }

    toast('🎉 ' + (result.message || 'Tạo giọng mẫu thành công!'), 'success');
    closeVbeeGenerateVoiceModal();
    await loadAssets();
  } catch (err) {
    toast('❌ Lỗi tạo giọng: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
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

  if (typeof initTimelineControls === 'function') {
    initTimelineControls();
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
    toast('⚠️ Đang tải model AI, vui lòng không đóng bảng!', 'warn');
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
    if (statusLabel) statusLabel.textContent = 'Đang tải model từ máy chủ...';
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
        toast('🚀 Bắt đầu tải bộ nhận diện giọng nói AI...', 'info');
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
            toast(`🎉 Tải xuống model AI ${model.toUpperCase()} thành công!`, 'success');
            checkWhisperModelStatus();
          } else if (status.error) {
            toast('❌ Lỗi khi tải model AI: ' + status.error, 'error');
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
  } else if (/instagram\.com|instagr\.am/i.test(url)) {
    domain = 'Instagram';
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
  toast('Đã lưu link thành công', 'success');

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
  currentSavedChannelPage = 1;
  renderSavedChannels();
  toast('Đã lưu kênh thành công', 'success');
}

function deleteSavedChannel(id) {
  savedChannels = savedChannels.filter(item => item.id !== id);
  saveSavedChannels();
  const totalPages = Math.ceil(savedChannels.length / savedChannelsPerPage) || 1;
  if (currentSavedChannelPage > totalPages) {
    currentSavedChannelPage = totalPages;
  }
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
  const paginationContainer = $('saved-channels-pagination');
  if (!container || !list) return;

  if (savedChannels.length === 0) {
    container.style.display = 'none';
    list.innerHTML = '';
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = '';
  if (paginationContainer) paginationContainer.innerHTML = '';

  const totalPages = Math.ceil(savedChannels.length / savedChannelsPerPage);
  if (currentSavedChannelPage > totalPages) {
    currentSavedChannelPage = totalPages;
  }
  if (currentSavedChannelPage < 1) {
    currentSavedChannelPage = 1;
  }

  const paginatedItems = savedChannels.slice((currentSavedChannelPage - 1) * savedChannelsPerPage, currentSavedChannelPage * savedChannelsPerPage);

  paginatedItems.forEach(item => {
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

  renderPaginationControls('saved-channels-pagination', currentSavedChannelPage, totalPages, (newPage) => {
    currentSavedChannelPage = newPage;
    renderSavedChannels();
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

function switchDownloadMode(mode) {
  const singleBtn = $('download-mode-single-btn');
  const bulkBtn = $('download-mode-bulk-btn');
  const singleCont = $('download-single-container');
  const bulkCont = $('download-bulk-container');
  
  if (mode === 'single') {
    if (singleBtn) singleBtn.classList.add('active');
    if (bulkBtn) bulkBtn.classList.remove('active');
    if (singleCont) singleCont.classList.remove('hidden');
    if (bulkCont) bulkCont.classList.add('hidden');
  } else {
    if (singleBtn) singleBtn.classList.remove('active');
    if (bulkBtn) bulkBtn.classList.add('active');
    if (singleCont) singleCont.classList.add('hidden');
    if (bulkCont) bulkCont.classList.remove('hidden');
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
window.switchDownloadMode = switchDownloadMode;

/* ==========================================================================
   GLOBAL AI SETTINGS MODAL & HELPERS
   ========================================================================== */

function getGlobalAiSettings() {
  return {
    aiProvider: localStorage.getItem('global_ai_provider') || 'google-translate',
    geminiApiKey: localStorage.getItem('global_gemini_key') || '',
    geminiModel: localStorage.getItem('global_gemini_model') || '',
    openRouterApiKey: localStorage.getItem('global_openrouter_key') || '',
    openRouterModel: localStorage.getItem('global_openrouter_model') || 'openrouter/owl-alpha',
    whisperModel: localStorage.getItem('global_whisper_model') || 'base'
  };
}

function getGlobalAiQueryParams() {
  const settings = getGlobalAiSettings();
  return `aiProvider=${encodeURIComponent(settings.aiProvider)}&geminiApiKey=${encodeURIComponent(settings.geminiApiKey)}&geminiModel=${encodeURIComponent(settings.geminiModel)}&openRouterApiKey=${encodeURIComponent(settings.openRouterApiKey)}&openRouterModel=${encodeURIComponent(settings.openRouterModel)}&whisperModel=${encodeURIComponent(settings.whisperModel)}`;
}

async function loadGeminiModels(apiKey) {
  const select = $('global-gemini-model');
  if (!select) return;

  if (!apiKey || apiKey.trim() === '') {
    select.innerHTML = '<option value="">-- Vui lòng nhập API Key để chọn Model --</option>';
    return;
  }

  const savedModel = localStorage.getItem('global_gemini_model') || '';

  // Show loading state
  select.innerHTML = '<option value="">⏳ Đang tải danh sách model...</option>';

  try {
    const res = await fetch('/api/gemini-models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ apiKey: apiKey.trim() })
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || 'Lỗi không xác định');
    }

    const data = await res.json();
    const models = data.models || [];

    if (models.length === 0) {
      select.innerHTML = '<option value="">❌ Không tìm thấy model nào phù hợp</option>';
      return;
    }

    let html = '';
    models.forEach(m => {
      const isSelected = m.name === savedModel ? 'selected' : '';
      html += `<option value="${m.name}" ${isSelected}>${m.displayName}</option>`;
    });
    select.innerHTML = html;

    // If there is no saved model or the saved model is not in the list, auto-select the first one
    const currentVal = select.value;
    if (!currentVal && models.length > 0) {
      select.value = models[0].name;
    }
  } catch (error) {
    console.error('Lỗi khi tải model Gemini:', error);
    select.innerHTML = `<option value="">❌ Lỗi: ${error.message}</option>`;
  }
}

function initGeminiModelListeners() {
  const geminiInput = $('global-gemini-key');
  if (geminiInput) {
    // Tải khi có thay đổi (blur hoặc enter)
    geminiInput.addEventListener('change', () => {
      loadGeminiModels(geminiInput.value);
    });

    // Thêm debounce tải trên mỗi lần gõ phím nếu độ dài đạt tới độ dài thông thường của api key
    let timer = null;
    geminiInput.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const val = geminiInput.value.trim();
        if (val.length >= 35) {
          loadGeminiModels(val);
        }
      }, 1000);
    });
  }
}

async function loadOpenRouterModels(apiKey) {
  const select = $('global-openrouter-model');
  if (!select) return;

  if (!apiKey || apiKey.trim() === '') {
    select.innerHTML = '<option value="">-- Vui lòng nhập API Key để chọn Model --</option>';
    return;
  }

  const savedModel = localStorage.getItem('global_openrouter_model') || 'openrouter/owl-alpha';

  // Show loading state
  select.innerHTML = '<option value="">⏳ Đang tải danh sách model...</option>';

  try {
    const res = await fetch('/api/openrouter-models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ apiKey: apiKey.trim() })
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || 'Lỗi không xác định');
    }

    const data = await res.json();
    const models = data.models || [];

    if (models.length === 0) {
      select.innerHTML = '<option value="">❌ Không tìm thấy model nào phù hợp</option>';
      return;
    }

    let html = '';
    models.forEach(m => {
      const isSelected = m.id === savedModel ? 'selected' : '';
      const label = m.isFree ? `🎁 [Miễn phí] ${m.name}` : m.name;
      html += `<option value="${m.id}" ${isSelected}>${label}</option>`;
    });
    select.innerHTML = html;

    // If there is no saved model or the saved model is not in the list, auto-select the first one
    const currentVal = select.value;
    if (!currentVal && models.length > 0) {
      select.value = models[0].id;
    }
  } catch (error) {
    console.error('Lỗi khi tải model OpenRouter:', error);
    select.innerHTML = `<option value="">❌ Lỗi: ${error.message}</option>`;
  }
}

function initOpenRouterModelListeners() {
  const openRouterInput = $('global-openrouter-key');
  if (openRouterInput) {
    // Tải khi có thay đổi (blur hoặc enter)
    openRouterInput.addEventListener('change', () => {
      loadOpenRouterModels(openRouterInput.value);
    });

    // Thêm debounce tải trên mỗi lần gõ phím nếu độ dài đạt tới độ dài thông thường của api key
    let timer = null;
    openRouterInput.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const val = openRouterInput.value.trim();
        if (val.length >= 35) {
          loadOpenRouterModels(val);
        }
      }, 1000);
    });
  }
}

function openGlobalSettingsModal() {
  const modal = $('global-settings-modal');
  if (!modal) return;

  const settings = getGlobalAiSettings();

  const providerSelect = $('global-ai-provider');
  const geminiInput = $('global-gemini-key');
  const openRouterInput = $('global-openrouter-key');
  const openRouterModelSelect = $('global-openrouter-model');
  const whisperModelSelect = $('whisper-model-select');

  if (providerSelect) providerSelect.value = settings.aiProvider;
  if (geminiInput) {
    geminiInput.value = settings.geminiApiKey;
    if (settings.geminiApiKey) {
      loadGeminiModels(settings.geminiApiKey);
    } else {
      const select = $('global-gemini-model');
      if (select) select.innerHTML = '<option value="">-- Vui lòng nhập API Key để chọn Model --</option>';
    }
  }
  if (openRouterInput) {
    openRouterInput.value = settings.openRouterApiKey;
    if (settings.openRouterApiKey) {
      loadOpenRouterModels(settings.openRouterApiKey);
    } else {
      const select = $('global-openrouter-model');
      if (select) select.innerHTML = '<option value="">-- Vui lòng nhập API Key để chọn Model --</option>';
    }
  }
  if (whisperModelSelect) {
    whisperModelSelect.value = settings.whisperModel;
    checkWhisperModelStatus();
  }

  toggleGlobalAiProviderFields();
  switchSettingsTab('translate');
  modal.classList.remove('hidden');
}

function closeGlobalSettingsModal() {
  const modal = $('global-settings-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function toggleGlobalAiProviderFields() {
  const providerSelect = $('global-ai-provider');
  if (!providerSelect) return;

  const val = providerSelect.value;
  const geminiFields = $('global-gemini-fields');
  const openRouterFields = $('global-openrouter-fields');

  if (geminiFields) {
    if (val === 'gemini') {
      geminiFields.classList.remove('hidden');
    } else {
      geminiFields.classList.add('hidden');
    }
  }

  if (openRouterFields) {
    if (val === 'openrouter') {
      openRouterFields.classList.remove('hidden');
    } else {
      openRouterFields.classList.add('hidden');
    }
  }
}

function saveGlobalSettings() {
  const providerSelect = $('global-ai-provider');
  const geminiInput = $('global-gemini-key');
  const geminiModelSelect = $('global-gemini-model');
  const openRouterInput = $('global-openrouter-key');
  const openRouterModelSelect = $('global-openrouter-model');
  const whisperModelSelect = $('whisper-model-select');

  if (providerSelect) localStorage.setItem('global_ai_provider', providerSelect.value);
  if (geminiInput) localStorage.setItem('global_gemini_key', geminiInput.value);
  if (geminiModelSelect) localStorage.setItem('global_gemini_model', geminiModelSelect.value);
  if (openRouterInput) localStorage.setItem('global_openrouter_key', openRouterInput.value);
  if (openRouterModelSelect) localStorage.setItem('global_openrouter_model', openRouterModelSelect.value);
  if (whisperModelSelect) localStorage.setItem('global_whisper_model', whisperModelSelect.value);

  toast('Đã lưu cài đặt AI toàn cục thành công!', 'success');
  closeGlobalSettingsModal();
}

function switchSettingsTab(tabName) {
  // Toggle tab buttons active class
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tabName);
  });

  // Toggle tab content visibility
  document.querySelectorAll('.settings-tab-content').forEach(content => {
    if (content.id === `settings-tab-${tabName}`) {
      content.classList.remove('hidden');
    } else {
      content.classList.add('hidden');
    }
  });
}

window.openGlobalSettingsModal = openGlobalSettingsModal;
window.closeGlobalSettingsModal = closeGlobalSettingsModal;
window.toggleGlobalAiProviderFields = toggleGlobalAiProviderFields;
window.saveGlobalSettings = saveGlobalSettings;
window.switchSettingsTab = switchSettingsTab;
window.loadGeminiModels = loadGeminiModels;
window.initGeminiModelListeners = initGeminiModelListeners;
window.loadOpenRouterModels = loadOpenRouterModels;
window.initOpenRouterModelListeners = initOpenRouterModelListeners;

/* ==========================================================================
   COOKIE SETTINGS MODAL & HELPERS
   ========================================================================== */

async function openCookieSettingsModal() {
  const modal = $('cookie-settings-modal');
  if (!modal) return;

  modal.classList.remove('hidden');
  await loadCookieStatus();
}

function closeCookieSettingsModal() {
  const modal = $('cookie-settings-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function loadCookieStatus() {
  try {
    const res = await fetch('/api/cookie/status');
    const data = await res.json();

    const dot = $('cookie-status-dot');
    const text = $('cookie-status-text');
    const clearBtn = $('clear-cookie-btn');
    const textInput = $('cookie-text-input');

    if (data.exists) {
      if (dot) {
        dot.style.background = '#10b981'; // Green
      }
      if (text) {
        const timeStr = new Date(data.lastModified).toLocaleString('vi-VN');
        text.innerHTML = `Đã cấu hình Cookie (Cập nhật: <span style="color: var(--muted);">${timeStr}</span>)`;
      }
      if (clearBtn) {
        clearBtn.style.display = 'inline-block';
      }
    } else {
      if (dot) {
        dot.style.background = '#ef4444'; // Red
      }
      if (text) {
        text.textContent = 'Chưa cấu hình Cookie';
      }
      if (clearBtn) {
        clearBtn.style.display = 'none';
      }
      if (textInput) {
        textInput.value = '';
      }
    }
  } catch (error) {
    console.error('Lỗi tải trạng thái cookie:', error);
  }
}

async function saveCookieSettings() {
  const textInput = $('cookie-text-input');
  if (!textInput) return;

  const cookieText = textInput.value.trim();
  if (!cookieText) {
    toast('⚠️ Vui lòng dán nội dung cookie hoặc chọn file .txt', 'error');
    return;
  }

  try {
    const res = await fetch('/api/cookie/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookieText })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu cookie');

    toast('Lưu Cookie thành công!', 'success');
    await loadCookieStatus();
  } catch (error) {
    toast(`Lỗi: ${error.message}`, 'error');
  }
}

async function clearCookieSettings() {
  if (!confirm('Bạn có chắc chắn muốn xóa cấu hình Cookie hiện tại?')) return;

  try {
    const res = await fetch('/api/cookie/clear', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi xóa cookie');

    toast('🗑️ Đã xóa cấu hình Cookie', 'success');
    await loadCookieStatus();
  } catch (error) {
    toast(`❌ Lỗi: ${error.message}`, 'error');
  }
}

function handleCookieFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const textInput = $('cookie-text-input');
    if (textInput) {
      textInput.value = e.target.result;
      toast('📂 Đã tải nội dung file cookie lên ô nhập!', 'success');
    }
  };
  reader.readAsText(file);
}

// Export to window
window.openCookieSettingsModal = openCookieSettingsModal;
window.closeCookieSettingsModal = closeCookieSettingsModal;
window.saveCookieSettings = saveCookieSettings;
window.clearCookieSettings = clearCookieSettings;
window.handleCookieFileUpload = handleCookieFileUpload;

function openConnectionStatusModal() {
  const modal = $('connection-status-modal');
  if (modal) {
    modal.classList.remove('hidden');
    checkSystemConnections();
  }
}

function closeConnectionStatusModal() {
  const modal = $('connection-status-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function checkSystemConnections() {
  const tools = ['ffmpeg', 'ytdlp', 'whisper', 'omnivoice'];
  tools.forEach(tool => {
    const dot = $(`conn-${tool}-dot`);
    const desc = $(`conn-${tool}-desc`);
    const action = $(`conn-${tool}-action`);
    if (dot) {
      dot.className = 'dot';
      dot.style.background = '#888';
      dot.style.boxShadow = 'none';
    }
    if (desc) desc.textContent = 'Đang kiểm tra...';
    if (action) action.innerHTML = '';
  });

  try {
    loadAssets();
  } catch (err) {
    console.error('Error loadAssets in connection check:', err);
  }

  try {
    const res = await fetch('/api/check-dependencies');
    const data = await res.json();

    // 1. FFmpeg
    const ffmpegDot = $('conn-ffmpeg-dot');
    const ffmpegDesc = $('conn-ffmpeg-desc');
    if (data.ffmpeg) {
      ffmpegDot.className = 'dot ok';
      ffmpegDot.style.background = 'var(--accent)';
      ffmpegDot.style.boxShadow = '0 0 8px var(--accent)';
      ffmpegDesc.textContent = 'Đã kết nối';
    } else {
      ffmpegDot.className = 'dot error';
      ffmpegDot.style.background = 'var(--danger)';
      ffmpegDot.style.boxShadow = '0 0 8px var(--danger)';
      ffmpegDesc.textContent = 'Thiếu bộ xử lý video';
    }

    // 2. yt-dlp
    const ytdlpDot = $('conn-ytdlp-dot');
    const ytdlpDesc = $('conn-ytdlp-desc');
    if (data.ytdlp) {
      ytdlpDot.className = 'dot ok';
      ytdlpDot.style.background = 'var(--accent)';
      ytdlpDot.style.boxShadow = '0 0 8px var(--accent)';
      ytdlpDesc.textContent = 'Đã kết nối';
    } else {
      ytdlpDot.className = 'dot error';
      ytdlpDot.style.background = 'var(--danger)';
      ytdlpDot.style.boxShadow = '0 0 8px var(--danger)';
      ytdlpDesc.textContent = 'Thiếu bộ tải video';
    }

    // 3. Whisper (Speech to text)
    const whisperDot = $('conn-whisper-dot');
    const whisperDesc = $('conn-whisper-desc');
    const whisperAction = $('conn-whisper-action');
    if (data.whisper) {
      whisperDot.className = 'dot ok';
      whisperDot.style.background = 'var(--accent)';
      whisperDot.style.boxShadow = '0 0 8px var(--accent)';
      whisperDesc.textContent = 'Đã sẵn sàng';
    } else {
      if (!data.whisperCli) {
        whisperDot.className = 'dot error';
        whisperDot.style.background = 'var(--danger)';
        whisperDot.style.boxShadow = '0 0 8px var(--danger)';
        whisperDesc.textContent = 'Thiếu công cụ nhận diện giọng nói (Chưa tải)';
        if (whisperAction) {
          whisperAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); showDependencyModal('whisper');">📥 Tải</button>`;
        }
      } else {
        whisperDot.className = 'dot warn';
        whisperDot.style.background = 'var(--warn)';
        whisperDot.style.boxShadow = '0 0 8px var(--warn)';
        whisperDesc.textContent = 'Thiếu tệp dữ liệu AI';
        if (whisperAction) {
          whisperAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); openWhisperDownloadModal();">📥 Tải</button>`;
        }
      }
    }

    // 4. OmniVoice
    const omnivoiceDot = $('conn-omnivoice-dot');
    const omnivoiceDesc = $('conn-omnivoice-desc');
    const omnivoiceAction = $('conn-omnivoice-action');
    if (data.omnivoice) {
      omnivoiceDot.className = 'dot ok';
      omnivoiceDot.style.background = 'var(--accent)';
      omnivoiceDot.style.boxShadow = '0 0 8px var(--accent)';
      omnivoiceDesc.textContent = 'Đã sẵn sàng';
    } else {
      if (!data.omnivoiceCli) {
        omnivoiceDot.className = 'dot error';
        omnivoiceDot.style.background = 'var(--danger)';
        omnivoiceDot.style.boxShadow = '0 0 8px var(--danger)';
        omnivoiceDesc.textContent = 'Thiếu công cụ thuyết minh';
      } else {
        omnivoiceDot.className = 'dot warn';
        omnivoiceDot.style.background = 'var(--warn)';
        omnivoiceDot.style.boxShadow = '0 0 8px var(--warn)';
        omnivoiceDesc.textContent = 'Thiếu tệp giọng nói AI';
        if (omnivoiceAction) {
          omnivoiceAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); openModelDownloadModal();">📥 Tải</button>`;
        }
      }
    }

  } catch (err) {
    console.error('Error checking connection status:', err);
    toast('Lỗi khi kết nối với máy chủ kiểm tra', 'error');
  }
}

window.openConnectionStatusModal = openConnectionStatusModal;
window.closeConnectionStatusModal = closeConnectionStatusModal;
window.checkSystemConnections = checkSystemConnections;

/* ==========================================================================
   QUẢN LÝ CHỌN GIỌNG NÓI ĐÃ LƯU (NEW GRID VOICE SELECTOR)
   ========================================================================== */

function updatePlayButtonsState(url, isPlaying) {
  const filename = url.substring(url.lastIndexOf('/') + 1);
  const decodedFilename = decodeURIComponent(filename);
  document.querySelectorAll('.voice-item-play-btn, .rendered-btn-play').forEach(btn => {
    const html = btn.outerHTML;
    if (html.includes(filename) || html.includes(decodedFilename)) {
      btn.innerHTML = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
      btn.classList.toggle('playing', isPlaying);
    }
  });
}

function renderSelectedVoiceRow() {
  const container = $('selected-voice-row');
  if (!container) return;

  const selectedVoice = $('saved-voice-select').value;
  
  if (!selectedVoice) {
    container.innerHTML = `
      <div class="selected-voice-row-header">Giọng đang chọn</div>
      <div class="selected-voice-card-placeholder">Chưa chọn giọng nào</div>
    `;
    return;
  }

  const lastDot = selectedVoice.lastIndexOf('.');
  const displayName = lastDot !== -1 ? selectedVoice.substring(0, lastDot) : selectedVoice;
  const voiceUrl = `/voices/${encodeURIComponent(selectedVoice)}`;
  
  const isPlaying = currentAudio && currentAudioUrl === voiceUrl && !currentAudio.paused;
  const btnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
  const btnClass = isPlaying ? 'voice-item-play-btn playing' : 'voice-item-play-btn';

  container.innerHTML = `
    <div class="selected-voice-row-header">Giọng đang chọn</div>
    <div class="voice-item-card active" style="margin-top: 4px; cursor: default;" data-filename="${selectedVoice}">
      <div class="voice-item-info">
        <span class="voice-item-name" title="${displayName}">${displayName}</span>
      </div>
      <div class="voice-item-actions">
        <button type="button" class="${btnClass}" onclick="playVoicePreview(event, '${selectedVoice.replace(/'/g, "\\'")}')">
          ${btnText}
        </button>
      </div>
    </div>
  `;
}

function renderQuickVoices() {
  renderSelectedVoiceRow();

  const quickList = $('quick-voices-list');
  if (!quickList) return;

  const voices = assets.voices || [];
  const selectedVoice = $('saved-voice-select').value;

  quickList.innerHTML = '';
  
  if (voices.length === 0) {
    quickList.innerHTML = '<div style="color: var(--muted); font-size: 13px; padding: 8px;">Chưa có giọng mẫu nào được lưu.</div>';
    return;
  }

  // Lấy tối đa 3 giọng
  const top3 = voices.slice(0, 3);
  top3.forEach(voice => {
    const card = document.createElement('div');
    const isSelected = voice.filename === selectedVoice;
    card.className = `voice-item-card${isSelected ? ' active' : ''}`;
    card.dataset.filename = voice.filename;
    
    const lastDot = voice.filename.lastIndexOf('.');
    const displayName = lastDot !== -1 ? voice.filename.substring(0, lastDot) : voice.filename;
    const voiceUrl = `/voices/${encodeURIComponent(voice.filename)}`;
    
    const isPlaying = currentAudio && currentAudioUrl === voiceUrl && !currentAudio.paused;
    const btnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
    const btnClass = isPlaying ? 'voice-item-play-btn playing' : 'voice-item-play-btn';

    card.innerHTML = `
      <div class="voice-item-info">
        <span class="voice-item-name" title="${displayName}">${displayName}</span>
      </div>
      <div class="voice-item-actions">
        <button type="button" class="${btnClass}" onclick="playVoicePreview(event, '${voice.filename.replace(/'/g, "\\'")}')">
          ${btnText}
        </button>
      </div>
    `;
    
    card.addEventListener('click', (e) => {
      if (e.target.closest('.voice-item-play-btn')) return;
      selectVoiceFile(voice.filename);
    });

    quickList.appendChild(card);
  });
}

function selectVoiceFile(filename) {
  const select = $('saved-voice-select');
  if (select) {
    select.value = filename;
    select.dispatchEvent(new Event('change'));
  }
  
  // Cập nhật trạng thái active chỉ cho phần giọng nói
  document.querySelectorAll('#quick-voices-container .voice-item-card, #modal-voices-list .voice-item-card').forEach(card => {
    card.classList.toggle('active', card.dataset.filename === filename);
  });

  renderSelectedVoiceRow();
}

function playVoicePreview(event, filename) {
  if (event) event.stopPropagation();
  const btn = event.currentTarget;
  const voiceUrl = `/voices/${encodeURIComponent(filename)}`;
  togglePlayAudio(btn, voiceUrl);
}

function openAllVoicesModal() {
  const modal = $('all-voices-modal');
  if (modal) {
    modal.classList.remove('hidden');
    $('modal-voice-search').value = '';
    renderModalVoices();
  }
}

function closeAllVoicesModal() {
  const modal = $('all-voices-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function renderModalVoices(filter = '') {
  const container = $('modal-voices-list');
  if (!container) return;

  const voices = assets.voices || [];
  const selectedVoice = $('saved-voice-select').value;
  const filtered = voices.filter(v => 
    v.filename.toLowerCase().includes(filter.toLowerCase())
  );

  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = '<div style="color: var(--muted); font-size: 13px; text-align: center; padding: 12px;">Không tìm thấy giọng mẫu nào.</div>';
    return;
  }

  filtered.forEach(voice => {
    const card = document.createElement('div');
    const isSelected = voice.filename === selectedVoice;
    card.className = `voice-item-card${isSelected ? ' active' : ''}`;
    card.dataset.filename = voice.filename;
    
    const lastDot = voice.filename.lastIndexOf('.');
    const displayName = lastDot !== -1 ? voice.filename.substring(0, lastDot) : voice.filename;
    const voiceUrl = `/voices/${encodeURIComponent(voice.filename)}`;
    
    let sizeStr = '';
    if (voice.size) {
      sizeStr = voice.size > 1024 * 1024 
        ? `${(voice.size / (1024 * 1024)).toFixed(1)} MB` 
        : `${(voice.size / 1024).toFixed(0)} KB`;
    }

    const isPlaying = currentAudio && currentAudioUrl === voiceUrl && !currentAudio.paused;
    const btnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
    const btnClass = isPlaying ? 'voice-item-play-btn playing' : 'voice-item-play-btn';

    card.innerHTML = `
      <div class="voice-item-info">
        <span class="voice-item-name" title="${displayName}">${displayName}</span>
        ${sizeStr ? `<span class="voice-item-meta">${sizeStr}</span>` : ''}
      </div>
      <div class="voice-item-actions">
        <button type="button" class="${btnClass}" onclick="playVoicePreview(event, '${voice.filename.replace(/'/g, "\\'")}')">
          ${btnText}
        </button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.voice-item-play-btn')) return;
      selectVoiceFile(voice.filename);
      closeAllVoicesModal();
    });

    container.appendChild(card);
  });
}

function filterModalVoices() {
  const searchInput = $('modal-voice-search');
  if (searchInput) {
    renderModalVoices(searchInput.value);
  }
}

// Gán vào window để truy cập từ inline HTML
window.playVoicePreview = playVoicePreview;
window.openAllVoicesModal = openAllVoicesModal;
window.closeAllVoicesModal = closeAllVoicesModal;
window.filterModalVoices = filterModalVoices;
window.renderQuickVoices = renderQuickVoices;
window.selectVoiceFile = selectVoiceFile;
window.updatePlayButtonsState = updatePlayButtonsState;

function resetStudioConfig() {
  // Clear selected template label in custom dropdown
  const select = $('studio-template-select');
  if (select) select.value = '';
  const label = $('selected-template-label');
  if (label) label.textContent = '-- Chọn cấu hình sẵn --';

  // Subtitle styling defaults
  const sizeInput = document.querySelector('input[name="subtitleSize"]');
  if (sizeInput) {
    sizeInput.value = '32';
    sizeInput.dispatchEvent(new Event('input'));
  }
  
  const fontSelect = document.querySelector('select[name="subtitleFont"]');
  if (fontSelect) fontSelect.value = 'Arial';

  const colorInput = document.querySelector('input[name="subtitleColor"]');
  if (colorInput) {
    colorInput.value = '#FFFFFF';
    const colorValSpan = $('subtitle-color-val');
    if (colorValSpan) colorValSpan.textContent = '#FFFFFF';
  }
  
  // Reset selected color swatch
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === '#FFFFFF');
  });

  const themeSelect = document.querySelector('select[name="subtitleTheme"]');
  if (themeSelect) themeSelect.value = 'outline';

  const boldSelect = document.querySelector('select[name="subtitleBold"]');
  if (boldSelect) boldSelect.value = 'true';

  const maxLinesSelect = document.querySelector('select[name="subtitleMaxLines"]');
  if (maxLinesSelect) maxLinesSelect.value = '0';

  const marginInput = document.querySelector('input[name="subtitleMargin"]');
  if (marginInput) marginInput.value = '28';

  const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
  if (marginHInput) {
    marginHInput.value = '20';
    delete marginHInput.dataset.lastStageWidth;
  }

  // Subtitle alignment
  const alignInput = $('subtitle-alignment-input');
  if (alignInput) alignInput.value = '10';
  const alignGrid = $('alignment-visual-grid');
  if (alignGrid) {
    alignGrid.querySelectorAll('.grid-cell').forEach(c => {
      c.classList.toggle('active', c.dataset.align === '10');
    });
  }

  // Reset subtitle mode & saved subtitle selection
  const subModeBtn = document.querySelector('.sub-tab-btn[data-sub-mode="none"]');
  if (subModeBtn) {
    subModeBtn.click();
  }
  const savedSubSelect = $('saved-subtitle-select');
  if (savedSubSelect) {
    savedSubSelect.value = '';
  }

  // Clear blur boxes
  blurBoxes = [];
  activeBlurBoxId = null;
  renderBlurBoxesList();

  // Reset voice mode
  const voiceModeBtn = document.querySelector('.voice-tab-btn[data-voice-mode="none"]');
  if (voiceModeBtn) {
    voiceModeBtn.click();
  }
  const savedVoiceSelect = $('saved-voice-select');
  if (savedVoiceSelect) {
    savedVoiceSelect.value = '';
  }
  renderQuickVoices();

  // Reset Omi settings
  const omiLanguage = document.querySelector('select[name="omiLanguage"]');
  if (omiLanguage) omiLanguage.value = 'Vietnamese';
  
  const omiDevice = document.querySelector('select[name="omiDevice"]');
  if (omiDevice) omiDevice.value = 'cpu';

  const stepsSlider = document.querySelector('input[name="omiSteps"]');
  if (stepsSlider) {
    stepsSlider.value = '40';
    const stepsBadge = $('omi-steps-badge');
    if (stepsBadge) stepsBadge.textContent = '40';
  }

  const omiSeedPreset = $('omi-seed-preset');
  if (omiSeedPreset) {
    omiSeedPreset.value = '';
    omiSeedPreset.dispatchEvent(new Event('change'));
  }
  const omiSeedInput = $('omi-seed-input');
  if (omiSeedInput) omiSeedInput.value = '';

  // Reset music mode
  const musicModeBtn = document.querySelector('.music-tab-btn[data-music-mode="none"]');
  if (musicModeBtn) {
    musicModeBtn.click();
  }
  const savedMusicSelect = $('saved-music-select');
  if (savedMusicSelect) {
    savedMusicSelect.value = '';
  }
  renderQuickMusic();

  // Reset volumes
  const originalSlider = document.querySelector('input[name="originalVolume"]');
  if (originalSlider) {
    originalSlider.value = '0.67';
    originalSlider.dispatchEvent(new Event('input'));
  }

  const voiceSlider = document.querySelector('input[name="voiceVolume"]');
  if (voiceSlider) {
    voiceSlider.value = '1.00';
    voiceSlider.dispatchEvent(new Event('input'));
  }

  const musicSlider = document.querySelector('input[name="musicVolume"]');
  if (musicSlider) {
    musicSlider.value = '0.42';
    musicSlider.dispatchEvent(new Event('input'));
  }

  toast('🔄 Đã đặt lại cấu hình studio về mặc định!', 'info');
  updateSubtitleOverlayFromInputs();
}

window.resetStudioConfig = resetStudioConfig;

/* ==========================================================================
   QUẢN LÝ CHỌN NHẠC NỀN ĐÃ LƯU (NEW GRID MUSIC SELECTOR)
   ========================================================================== */

function renderSelectedMusicRow() {
  const container = $('selected-music-row');
  if (!container) return;

  const selectedMusic = $('saved-music-select').value;
  
  if (!selectedMusic) {
    container.innerHTML = `
      <div class="selected-voice-row-header">Nhạc nền đang chọn</div>
      <div class="selected-voice-card-placeholder">Chưa chọn nhạc nền nào</div>
    `;
    return;
  }

  const lastDot = selectedMusic.lastIndexOf('.');
  const displayName = lastDot !== -1 ? selectedMusic.substring(0, lastDot) : selectedMusic;
  const musicUrl = `/music/${encodeURIComponent(selectedMusic)}`;
  
  const isPlaying = currentAudio && currentAudioUrl === musicUrl && !currentAudio.paused;
  const btnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
  const btnClass = isPlaying ? 'voice-item-play-btn playing' : 'voice-item-play-btn';

  container.innerHTML = `
    <div class="selected-voice-row-header">Nhạc nền đang chọn</div>
    <div class="voice-item-card active" style="margin-top: 4px; cursor: default;" data-filename="${selectedMusic}">
      <div class="voice-item-info">
        <span class="voice-item-name" title="${displayName}">${displayName}</span>
      </div>
      <div class="voice-item-actions">
        <button type="button" class="${btnClass}" onclick="playMusicPreview(event, '${selectedMusic.replace(/'/g, "\\'")}')">
          ${btnText}
        </button>
      </div>
    </div>
  `;
}

function renderQuickMusic() {
  renderSelectedMusicRow();

  const quickList = $('quick-music-list');
  if (!quickList) return;

  const music = assets.music || [];
  const selectedMusic = $('saved-music-select').value;

  quickList.innerHTML = '';
  
  if (music.length === 0) {
    quickList.innerHTML = '<div style="color: var(--muted); font-size: 13px; padding: 8px;">Chưa có nhạc nền nào được lưu.</div>';
    return;
  }

  // Lấy tối đa 3 bản nhạc
  const top3 = music.slice(0, 3);
  top3.forEach(item => {
    const card = document.createElement('div');
    const isSelected = item.filename === selectedMusic;
    card.className = `voice-item-card${isSelected ? ' active' : ''}`;
    card.dataset.filename = item.filename;
    
    const lastDot = item.filename.lastIndexOf('.');
    const displayName = lastDot !== -1 ? item.filename.substring(0, lastDot) : item.filename;
    const musicUrl = `/music/${encodeURIComponent(item.filename)}`;
    
    const isPlaying = currentAudio && currentAudioUrl === musicUrl && !currentAudio.paused;
    const btnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
    const btnClass = isPlaying ? 'voice-item-play-btn playing' : 'voice-item-play-btn';

    card.innerHTML = `
      <div class="voice-item-info">
        <span class="voice-item-name" title="${displayName}">${displayName}</span>
      </div>
      <div class="voice-item-actions">
        <button type="button" class="${btnClass}" onclick="playMusicPreview(event, '${item.filename.replace(/'/g, "\\'")}')">
          ${btnText}
        </button>
      </div>
    `;
    
    card.addEventListener('click', (e) => {
      if (e.target.closest('.voice-item-play-btn')) return;
      selectMusicFile(item.filename);
    });

    quickList.appendChild(card);
  });
}

function selectMusicFile(filename) {
  const select = $('saved-music-select');
  if (select) {
    select.value = filename;
    select.dispatchEvent(new Event('change'));
  }
  
  // Cập nhật trạng thái active
  document.querySelectorAll('#quick-music-container .voice-item-card, #modal-music-list .voice-item-card').forEach(card => {
    card.classList.toggle('active', card.dataset.filename === filename);
  });

  renderSelectedMusicRow();
}

function playMusicPreview(event, filename) {
  if (event) event.stopPropagation();
  const btn = event.currentTarget;
  const musicUrl = `/music/${encodeURIComponent(filename)}`;
  togglePlayAudio(btn, musicUrl);
}

function openAllMusicModal() {
  const modal = $('all-music-modal');
  if (modal) {
    modal.classList.remove('hidden');
    $('modal-music-search').value = '';
    renderModalMusic();
  }
}

function closeAllMusicModal() {
  const modal = $('all-music-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function renderModalMusic(filter = '') {
  const container = $('modal-music-list');
  if (!container) return;

  const music = assets.music || [];
  const selectedMusic = $('saved-music-select').value;
  const filtered = music.filter(m => 
    m.filename.toLowerCase().includes(filter.toLowerCase())
  );

  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = '<div style="color: var(--muted); font-size: 13px; text-align: center; padding: 12px;">Không tìm thấy nhạc nền nào.</div>';
    return;
  }

  filtered.forEach(item => {
    const card = document.createElement('div');
    const isSelected = item.filename === selectedMusic;
    card.className = `voice-item-card${isSelected ? ' active' : ''}`;
    card.dataset.filename = item.filename;
    
    const lastDot = item.filename.lastIndexOf('.');
    const displayName = lastDot !== -1 ? item.filename.substring(0, lastDot) : item.filename;
    const musicUrl = `/music/${encodeURIComponent(item.filename)}`;
    
    let sizeStr = '';
    if (item.size) {
      sizeStr = item.size > 1024 * 1024 
        ? `${(item.size / (1024 * 1024)).toFixed(1)} MB` 
        : `${(item.size / 1024).toFixed(0)} KB`;
    }

    const isPlaying = currentAudio && currentAudioUrl === musicUrl && !currentAudio.paused;
    const btnText = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
    const btnClass = isPlaying ? 'voice-item-play-btn playing' : 'voice-item-play-btn';

    card.innerHTML = `
      <div class="voice-item-info">
        <span class="voice-item-name" title="${displayName}">${displayName}</span>
        ${sizeStr ? `<span class="voice-item-meta">${sizeStr}</span>` : ''}
      </div>
      <div class="voice-item-actions">
        <button type="button" class="${btnClass}" onclick="playMusicPreview(event, '${item.filename.replace(/'/g, "\\'")}')">
          ${btnText}
        </button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.voice-item-play-btn')) return;
      selectMusicFile(item.filename);
      closeAllMusicModal();
    });

    container.appendChild(card);
  });
}

function filterModalMusic() {
  const searchInput = $('modal-music-search');
  if (searchInput) {
    renderModalMusic(searchInput.value);
  }
}

// Gán vào window
window.playMusicPreview = playMusicPreview;
window.openAllMusicModal = openAllMusicModal;
window.closeAllMusicModal = closeAllMusicModal;
window.filterModalMusic = filterModalMusic;
window.renderQuickMusic = renderQuickMusic;
window.selectMusicFile = selectMusicFile;

function selectSourceVideo(filename) {
  const input = $('selected-video-file');
  if (input) {
    input.value = filename;
    input.dispatchEvent(new Event('change'));
  }
  
  document.querySelectorAll('#studio-video-grid .video-card-item').forEach(card => {
    const isMatch = card.dataset.filename === filename;
    card.classList.toggle('selected', isMatch);
  });
  
  const videoUrl = `/downloads/${encodeURIComponent(filename)}`;
  setPreviewVideo(videoUrl);
  if (typeof switchToPreviewTab === 'function') switchToPreviewTab();
  updateConditionalFields();
}

function selectReactionVideo(filename) {
  const input = $('selected-reaction-video-file');
  if (input) {
    input.value = filename;
    input.dispatchEvent(new Event('change'));
  }
  
  document.querySelectorAll('#studio-reaction-video-grid .video-card-item').forEach(card => {
    const isMatch = card.dataset.filename === filename;
    card.classList.toggle('selected', isMatch);
  });
  
  const videoUrl = `/downloads/${encodeURIComponent(filename)}`;
  setPreviewReactionVideo(videoUrl);
  updateConditionalFields();
}

window.selectSourceVideo = selectSourceVideo;
window.selectReactionVideo = selectReactionVideo;

function toggleSidebar() {
  const shell = document.querySelector('.app-shell');
  const icon = $('sidebar-toggle-icon');
  if (shell) {
    const isCollapsed = shell.classList.toggle('sidebar-collapsed');
    
    // Save state in localStorage
    localStorage.setItem('sidebar_collapsed', isCollapsed ? 'true' : 'false');
    
    if (icon) {
      icon.textContent = isCollapsed ? '▶' : '◀';
    }
  }
}

function initSidebarState() {
  const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
  if (isCollapsed) {
    const shell = document.querySelector('.app-shell');
    const icon = $('sidebar-toggle-icon');
    if (shell) {
      shell.classList.add('sidebar-collapsed');
    }
    if (icon) {
      icon.textContent = '▶';
    }
  }
}

// Initialize sidebar state on startup
// Initialize sidebar state on startup
initSidebarState();

window.toggleSidebar = toggleSidebar;

/* ==========================================================================
   HỆ THỐNG TẢI ĐỘNG CÁC THƯ VIỆN AI NẶNG (CUDA, WHISPER)
   ========================================================================== */
let dependencyStatus = { cuda: true, whisper: true };
let activeDownloadType = null;
let downloadSuccessCallback = null;
let downloadProgressInterval = null;

async function checkLocalDependencies() {
  try {
    const res = await fetch('/api/check-dependencies-status');
    if (res.ok) {
      dependencyStatus = await res.json();
      updateDependencyUI();
    }
  } catch (err) {
    console.error('Lỗi khi kiểm tra thư viện AI:', err);
  }
}

function updateDependencyUI() {
  const omiDeviceSelect = document.querySelector('select[name="omiDevice"]');
  if (omiDeviceSelect) {
    const cudaOption = omiDeviceSelect.querySelector('option[value="cuda:0"]');
    if (cudaOption) {
      if (!dependencyStatus.cuda) {
        cudaOption.textContent = 'Card đồ họa GPU (CUDA) (⚠️ Chưa tải)';
      } else {
        cudaOption.textContent = 'Card đồ họa GPU (CUDA)';
      }
    }
    bindDeviceChangeCheck();
  }
}

function bindDeviceChangeCheck() {
  const omiDeviceSelect = document.querySelector('select[name="omiDevice"]');
  if (omiDeviceSelect) {
    if (omiDeviceSelect.dataset.dependencyBound) return;
    omiDeviceSelect.dataset.dependencyBound = 'true';
    
    omiDeviceSelect.addEventListener('change', (e) => {
      if (e.target.value === 'cuda:0' && !dependencyStatus.cuda) {
        e.target.value = 'cpu';
        showDependencyModal('cuda');
      }
    });
  }
}

function showDependencyModal(type, callback) {
  activeDownloadType = type;
  downloadSuccessCallback = callback;

  const modal = $('dependency-download-modal');
  const title = $('dep-modal-title');
  const icon = $('dep-icon');
  const name = $('dep-name');
  const desc = $('dep-desc');
  const progressBar = $('dep-progress-bar');
  const progressText = $('dep-progress-text');
  const sizeText = $('dep-size-text');
  const errorMsg = $('dep-error-message');
  const startBtn = $('dep-start-btn');
  const cancelBtn = $('dep-cancel-btn');
  const closeBtn = $('dep-modal-close');

  if (!modal) return;

  // Reset modal state
  progressBar.style.width = '0%';
  progressText.textContent = 'Đang chuẩn bị: 0%';
  errorMsg.classList.add('hidden');
  startBtn.disabled = false;
  startBtn.textContent = 'Tải Ngay';
  startBtn.style.display = 'inline-block';
  cancelBtn.style.display = 'inline-block';
  cancelBtn.disabled = false;
  closeBtn.style.display = 'none';

  if (type === 'cuda') {
    title.textContent = '📥 Tải xuống thư viện CUDA';
    icon.textContent = '🚀';
    name.textContent = 'Thư viện CUDA 12';
    desc.textContent = 'Hệ thống cần tải thêm các thư viện CUDA (cublas, cudart...) để kích hoạt tăng tốc GPU, giúp render/thuyết minh nhanh gấp 5-10 lần. Dung lượng tải khoảng ~480MB.';
    sizeText.textContent = 'Dung lượng: ~480 MB';
  } else if (type === 'whisper') {
    title.textContent = '📥 Tải xuống công cụ Whisper';
    icon.textContent = '🎙️';
    name.textContent = 'Công cụ nhận diện giọng nói Whisper';
    desc.textContent = 'Hệ thống cần tải công cụ Whisper ONNX Runtime (whisper_onnx.exe) để thực hiện nhận diện giọng nói và tự động tạo phụ đề từ video. Dung lượng tải khoảng ~90MB.';
    sizeText.textContent = 'Dung lượng: ~90 MB';
  }

  modal.classList.remove('hidden');
}

function closeDependencyModal() {
  if (downloadProgressInterval) {
    clearInterval(downloadProgressInterval);
    downloadProgressInterval = null;
  }
  const modal = $('dependency-download-modal');
  if (modal) modal.classList.add('hidden');
  activeDownloadType = null;
  downloadSuccessCallback = null;
}

async function startDependencyDownload() {
  if (!activeDownloadType) return;

  const startBtn = $('dep-start-btn');
  const cancelBtn = $('dep-cancel-btn');
  const errorMsg = $('dep-error-message');
  const progressBar = $('dep-progress-bar');
  const progressText = $('dep-progress-text');
  const closeBtn = $('dep-modal-close');

  startBtn.style.display = 'none';
  cancelBtn.style.display = 'none';
  errorMsg.classList.add('hidden');

  try {
    const res = await fetch('/api/download-dependency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: activeDownloadType })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Yêu cầu tải thất bại');

    // Bắt đầu vòng lặp polling tiến trình
    downloadProgressInterval = setInterval(async () => {
      try {
        const pRes = await fetch('/api/download-dependency-progress');
        if (!pRes.ok) return;
        const pData = await pRes.json();

        if (pData.status === 'downloading') {
          const pct = pData.percent || 0;
          progressBar.style.width = `${pct}%`;
          progressText.textContent = `Đang tải: ${pct}%`;
        } else if (pData.status === 'success') {
          clearInterval(downloadProgressInterval);
          downloadProgressInterval = null;
          progressBar.style.width = '100%';
          progressText.textContent = 'Giải nén thành công!';
          toast('Tải xuống và cài đặt tài nguyên thành công!', 'success');
          
          // Cập nhật trạng thái local
          await checkLocalDependencies();
          
          setTimeout(() => {
            closeDependencyModal();
            if (downloadSuccessCallback) {
              downloadSuccessCallback();
            }
          }, 1000);
        } else if (pData.status === 'error') {
          clearInterval(downloadProgressInterval);
          downloadProgressInterval = null;
          errorMsg.textContent = `Lỗi: ${pData.error || 'Không xác định'}`;
          errorMsg.classList.remove('hidden');
          
          // Hiện lại nút để tải lại
          startBtn.style.display = 'inline-block';
          startBtn.textContent = 'Thử lại';
          cancelBtn.style.display = 'inline-block';
          closeBtn.style.display = 'block';
        }
      } catch (err) {
        console.error('Lỗi khi lấy tiến trình tải:', err);
      }
    }, 500);

  } catch (err) {
    errorMsg.textContent = `Lỗi: ${err.message}`;
    errorMsg.classList.remove('hidden');
    startBtn.style.display = 'inline-block';
    startBtn.textContent = 'Thử lại';
    cancelBtn.style.display = 'inline-block';
    closeBtn.style.display = 'block';
  }
}

// Export functions to global scope
window.checkLocalDependencies = checkLocalDependencies;
window.showDependencyModal = showDependencyModal;
window.closeDependencyModal = closeDependencyModal;
window.startDependencyDownload = startDependencyDownload;

// ==========================================
// AUTO-UPDATE FEATURE HANDLER
// ==========================================
let updatePollInterval = null;

function startUpdateMonitoring() {
  const modal = document.getElementById('app-update-modal');
  const icon = document.getElementById('update-status-icon');
  const title = document.getElementById('update-title');
  const desc = document.getElementById('update-desc');
  const progressContainer = document.getElementById('update-progress-container');
  const progressBar = document.getElementById('update-progress-bar');
  const actionBtn = document.getElementById('update-action-btn');
  const closeBtn = document.getElementById('update-close-btn');

  if (!modal) return;

  updatePollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/update-status');
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'idle') {
        modal.classList.add('hidden');
        progressContainer.classList.add('hidden');
        actionBtn.classList.add('hidden');
      } else if (data.status === 'checking') {
        // Chạy ngầm kiểm tra, không mở modal tránh làm phiền
      } else if (data.status === 'available') {
        modal.classList.remove('hidden');
        icon.textContent = '🔄';
        title.textContent = 'Phát hiện bản cập nhật mới!';
        desc.textContent = 'Đang chuẩn bị tải xuống tệp cài đặt mới từ máy chủ...';
        progressContainer.classList.remove('hidden');
        progressBar.style.width = '0%';
        actionBtn.classList.add('hidden');
        closeBtn.classList.add('hidden'); // Khóa nút đóng để đảm bảo tải liền mạch
      } else if (data.status === 'downloading') {
        modal.classList.remove('hidden');
        icon.textContent = '⏳';
        title.textContent = 'Đang tải bản cập nhật mới';
        desc.textContent = `Vui lòng chờ, ứng dụng đang được tải về (${data.percent}%)...`;
        progressContainer.classList.remove('hidden');
        progressBar.style.width = `${data.percent}%`;
        actionBtn.classList.add('hidden');
        closeBtn.classList.add('hidden');
      } else if (data.status === 'downloaded') {
        modal.classList.remove('hidden');
        icon.textContent = '🎉';
        title.textContent = 'Đã tải xong bản cập nhật!';
        desc.textContent = 'Phiên bản mới đã sẵn sàng. Vui lòng bấm nút bên dưới để khởi động lại và nâng cấp ứng dụng ngay.';
        progressContainer.classList.add('hidden');
        actionBtn.classList.remove('hidden');
        actionBtn.textContent = 'Khởi động lại & Cập nhật';
        closeBtn.classList.remove('hidden');
        closeBtn.textContent = 'Để sau';
        
        // Khi tải xong thì ngừng kiểm tra
        clearInterval(updatePollInterval);
        updatePollInterval = null;
      } else if (data.status === 'error') {
        modal.classList.remove('hidden');
        icon.textContent = '❌';
        title.textContent = 'Lỗi cập nhật tự động';
        desc.textContent = `Không thể tải bản cập nhật: ${data.error || 'Lỗi không xác định'}`;
        progressContainer.classList.add('hidden');
        actionBtn.classList.add('hidden');
        closeBtn.classList.remove('hidden');
        closeBtn.textContent = 'Đóng';
        
        clearInterval(updatePollInterval);
        updatePollInterval = null;
      }
    } catch (err) {
      console.error('Lỗi khi kiểm tra trạng thái cập nhật:', err);
    }
  }, 2000);
}

async function applyAppUpdate() {
  const actionBtn = document.getElementById('update-action-btn');
  if (actionBtn) {
    actionBtn.textContent = 'Đang khởi động lại...';
    actionBtn.disabled = true;
  }
  try {
    await fetch('/api/quit-and-install', { method: 'POST' });
  } catch (err) {
    console.error('Lỗi khi gửi yêu cầu cập nhật:', err);
    alert('Không thể tự động khởi động lại để cập nhật. Vui lòng tắt và mở lại app thủ công.');
  }
}

function closeUpdateModal() {
  const modal = document.getElementById('app-update-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
  if (updatePollInterval) {
    clearInterval(updatePollInterval);
    updatePollInterval = null;
  }
}

// Theo dõi cập nhật sau khi tải trang
document.addEventListener('DOMContentLoaded', () => {
  // Trì hoãn 5 giây sau khi khởi động để nhường tài nguyên cho quá trình tải models
  setTimeout(startUpdateMonitoring, 5000);
});

// ==========================================================================
// HỆ THỐNG QUẢN LÝ DỰ ÁN STUDIO (PROJECT MANAGEMENT ACTIONS & STATE)
// ==========================================================================
let currentProjectId = null;
let currentProjectName = 'Dự án chưa đặt tên';

function serializeStudioForm() {
  const form = $('studio-form');
  if (!form) return {};
  const formData = new FormData(form);
  const obj = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      obj[key + '_fileName'] = value.name;
    } else {
      obj[key] = value;
    }
  }
  
  // Lưu trạng thái các tabs đang kích hoạt
  obj._sourceMode = document.querySelector('.source-tab-btn.active')?.dataset.sourceMode || 'library';
  obj._reactionMode = document.querySelector('.reaction-tab-btn.active')?.dataset.reactionTabMode || 'none';
  obj._subMode = document.querySelector('.sub-tab-btn.active')?.dataset.subMode || 'none';
  obj._voiceMode = document.querySelector('.voice-tab-btn.active')?.dataset.voiceMode || 'none';
  obj._musicMode = document.querySelector('.music-tab-btn.active')?.dataset.musicMode || 'none';
  
  // Lưu danh sách vùng làm mờ
  obj.blurBoxes = blurBoxes;
  
  return obj;
}

function deserializeStudioForm(obj) {
  const form = $('studio-form');
  if (!form) return;
  
  // Khôi phục các input cơ bản
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    if (key.endsWith('_fileName')) continue;
    
    const input = form.elements[key];
    if (input) {
      if (input.type === 'checkbox') {
        input.checked = (val === 'true' || val === true);
      } else if (input.type === 'radio') {
        if (input.forEach) {
          input.forEach(radio => {
            radio.checked = (radio.value === val);
          });
        } else {
          input.checked = (input.value === val);
        }
      } else {
        input.value = val;
      }
    }
  }

  // Khôi phục thuộc tính customGeometry cho Reaction PIP
  const pipEl = $('preview-reaction-pip');
  if (pipEl) {
    pipEl.dataset.customGeometry = (obj.reactionPosition === 'custom') ? 'true' : 'false';
  }
  
  // Kích hoạt các tab tương ứng
  if (obj._sourceMode) {
    const btn = document.querySelector(`.source-tab-btn[data-source-mode="${obj._sourceMode}"]`);
    if (btn) btn.click();
  }
  if (obj._reactionMode) {
    const btn = document.querySelector(`.reaction-tab-btn[data-reaction-tab-mode="${obj._reactionMode}"]`);
    if (btn) btn.click();
  }
  if (obj._subMode) {
    const btn = document.querySelector(`.sub-tab-btn[data-sub-mode="${obj._subMode}"]`);
    if (btn) btn.click();
  }
  if (obj._voiceMode) {
    const btn = document.querySelector(`.voice-tab-btn[data-voice-mode="${obj._voiceMode}"]`);
    if (btn) btn.click();
  }
  if (obj._musicMode) {
    const btn = document.querySelector(`.music-tab-btn[data-music-mode="${obj._musicMode}"]`);
    if (btn) btn.click();
  }
  
  // Tải lại video nguồn đã chọn và nạp preview
  if (obj.mainVideoFile) {
    const item = Array.from(document.querySelectorAll('#studio-video-grid .video-card-item'))
      .find(c => c.querySelector('.video-card-title')?.textContent === obj.mainVideoFile || c.dataset.filename === obj.mainVideoFile);
    if (item) {
      item.click();
    } else {
      $('selected-video-file').value = obj.mainVideoFile;
      setPreviewVideo(`/downloads/${encodeURIComponent(obj.mainVideoFile)}`);
    }
  }
  
  // Chọn lại video reaction
  if (obj.savedReactionFile) {
    const item = Array.from(document.querySelectorAll('#studio-reaction-video-grid .video-card-item'))
      .find(c => c.dataset.filename === obj.savedReactionFile);
    if (item) {
      item.click();
    } else {
      $('selected-reaction-video-file').value = obj.savedReactionFile;
    }
  }
  
  // Cập nhật lại các trường phụ đề
  updateConditionalFields();

  // Khôi phục danh sách vùng làm mờ
  if (obj.blurBoxes) {
    try {
      blurBoxes = typeof obj.blurBoxes === 'string' ? JSON.parse(obj.blurBoxes) : obj.blurBoxes;
    } catch (e) {
      console.error('Lỗi khôi phục blurBoxes:', e);
      blurBoxes = [];
    }
  } else {
    blurBoxes = [];
  }
  activeBlurBoxId = blurBoxes.length > 0 ? blurBoxes[0].id : null;
  renderBlurBoxesList();
  updateSubtitleOverlayFromInputs();
}

function resetStudioForm() {
  const form = $('studio-form');
  if (form) form.reset();
  $('selected-video-file').value = '';
  $('selected-reaction-video-file').value = '';
  
  const sourceBtn = document.querySelector('.source-tab-btn[data-source-mode="library"]');
  if (sourceBtn) sourceBtn.click();
  const reactionBtn = document.querySelector('.reaction-tab-btn[data-reaction-tab-mode="none"]');
  if (reactionBtn) reactionBtn.click();
  const subBtn = document.querySelector('.sub-tab-btn[data-sub-mode="none"]');
  if (subBtn) subBtn.click();
  const voiceBtn = document.querySelector('.voice-tab-btn[data-voice-mode="none"]');
  if (voiceBtn) voiceBtn.click();
  const musicBtn = document.querySelector('.music-tab-btn[data-music-mode="none"]');
  if (musicBtn) musicBtn.click();
  
  const previewVideo = $('studio-video-preview');
  if (previewVideo) {
    previewVideo.src = '';
    previewVideo.load();
  }
  $('video-preview-wrapper').classList.add('hidden');
  $('preview-placeholder').classList.remove('hidden');
  
  updateConditionalFields();

  // Xóa vùng làm mờ
  blurBoxes = [];
  activeBlurBoxId = null;
  renderBlurBoxesList();
  updateSubtitleOverlayFromInputs();
}

function generateNextProjectName() {
  let maxNum = 0;
  if (currentProjectsList && currentProjectsList.length) {
    currentProjectsList.forEach(p => {
      const match = p.name.match(/^Dự án (\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    });
  }
  return `Dự án ${maxNum + 1}`;
}

function openStudioEditor() {
  const homeView = $('studio-home-view');
  const editorView = $('studio-editor-view');
  if (homeView) homeView.classList.add('hidden');
  if (editorView) editorView.classList.remove('hidden');

  const standardInfo = $('topbar-standard-info');
  const projectInfo = $('topbar-project-info');
  if (standardInfo) standardInfo.style.display = 'none';
  if (projectInfo) projectInfo.style.display = 'flex';
}

async function backToStudioHome() {
  if (currentProjectId) {
    const hasVideo = $('selected-video-file')?.value || $('video-upload')?.files.length;
    if (hasVideo) {
      await saveProjectExplicitly();
    }
  }

  const homeView = $('studio-home-view');
  const editorView = $('studio-editor-view');
  if (homeView) homeView.classList.remove('hidden');
  if (editorView) editorView.classList.add('hidden');

  const standardInfo = $('topbar-standard-info');
  const projectInfo = $('topbar-project-info');
  if (standardInfo) standardInfo.style.display = 'block';
  if (projectInfo) projectInfo.style.display = 'none';

  renderProjectsList();
}

async function createNewProject() {
  try {
    const res = await fetch('/api/projects');
    if (res.ok) {
      const data = await res.json();
      currentProjectsList = data.projects || [];
    }
  } catch (err) {
    console.error('Không thể đồng bộ danh sách dự án trước khi tạo mới:', err);
  }

  currentProjectId = `proj_${Date.now()}`;
  currentProjectName = generateNextProjectName();
  localStorage.setItem('current_project_id', currentProjectId);
  localStorage.setItem('current_project_name', currentProjectName);

  const nameInput = $('project-name-input');
  if (nameInput) nameInput.value = currentProjectName;

  resetStudioForm();
  toast('🆕 Đã tạo dự án mới! Bắt đầu thiết lập chỉnh sửa.', 'success');
}

function createNewProjectAndNavigate() {
  createNewProject().then(() => {
    switchView('studio');
    openStudioEditor();
  });
}

async function saveProjectExplicitly() {
  if (!currentProjectId) {
    currentProjectId = `proj_${Date.now()}`;
  }
  const nameInput = $('project-name-input');
  if (nameInput) {
    currentProjectName = nameInput.value.trim() || `Dự án_${Date.now()}`;
  }
  
  const formData = serializeStudioForm();
  let thumbnail = '';
  const selectedVideoCard = document.querySelector('#studio-video-grid .video-card-item.selected');
  if (selectedVideoCard) {
    const img = selectedVideoCard.querySelector('img');
    if (img) thumbnail = img.src;
  }
  
  const payload = {
    id: currentProjectId,
    name: currentProjectName,
    data: {
      ...formData,
      videoTitle: $('selected-video-file')?.value || '',
      thumbnail: thumbnail
    }
  };

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Không thể lưu dự án');
    
    localStorage.setItem('current_project_id', currentProjectId);
    localStorage.setItem('current_project_name', currentProjectName);
    
    toast('Đã lưu dự án thành công!', 'success');
  } catch (error) {
    console.error('Lỗi khi lưu dự án:', error);
    toast('Lỗi khi lưu dự án: ' + error.message, 'error');
  }
}

function setupStudioFormAutoSave() {
  const form = $('studio-form');
  if (!form) return;

  let autoSaveTimeout = null;
  const triggerAutoSave = () => {
    if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(async () => {
      const hasVideo = $('selected-video-file')?.value || $('video-upload')?.files.length;
      if (!hasVideo) return;

      if (!currentProjectId) {
        currentProjectId = `proj_${Date.now()}`;
        currentProjectName = `Dự án_${new Date().toLocaleDateString('vi-VN')} ${new Date().toLocaleTimeString('vi-VN')}`;
        localStorage.setItem('current_project_id', currentProjectId);
        localStorage.setItem('current_project_name', currentProjectName);
        const nameInput = $('project-name-input');
        if (nameInput) nameInput.value = currentProjectName;
      }

      const nameInput = $('project-name-input');
      if (nameInput) {
        currentProjectName = nameInput.value.trim() || currentProjectName;
      }

      const formData = serializeStudioForm();
      let thumbnail = '';
      const selectedVideoCard = document.querySelector('#studio-video-grid .video-card-item.selected');
      if (selectedVideoCard) {
        const img = selectedVideoCard.querySelector('img');
        if (img) thumbnail = img.src;
      }

      const payload = {
        id: currentProjectId,
        name: currentProjectName,
        data: {
          ...formData,
          videoTitle: $('selected-video-file')?.value || '',
          thumbnail: thumbnail
        }
      };

      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          console.log('[Auto-save] Dự án đã được tự động lưu.');
        }
      } catch (err) {
        console.error('[Auto-save] Lỗi tự động lưu:', err.message);
      }
    }, 2000);
  };

  form.addEventListener('input', triggerAutoSave);
  form.addEventListener('change', triggerAutoSave);
  
  const nameInput = $('project-name-input');
  if (nameInput) {
    nameInput.addEventListener('input', triggerAutoSave);
  }
}

async function loadProject(id) {
  try {
    if (currentProjectId && currentProjectId !== id) {
      const hasVideo = $('selected-video-file')?.value || $('video-upload')?.files.length;
      if (hasVideo) {
        try {
          await saveProjectExplicitly();
        } catch (e) {
          console.error('Lỗi khi tự động lưu dự án cũ:', e);
        }
      }
    }

    const res = await fetch(`/api/projects/${id}`);
    if (!res.ok) throw new Error('Không thể đọc dữ liệu dự án');
    const proj = await res.json();
    
    currentProjectId = proj.id;
    currentProjectName = proj.name;
    localStorage.setItem('current_project_id', currentProjectId);
    localStorage.setItem('current_project_name', currentProjectName);

    const nameInput = $('project-name-input');
    if (nameInput) nameInput.value = currentProjectName;

    resetStudioForm();
    deserializeStudioForm(proj);

    toast(`📂 Đã nạp dự án "${currentProjectName}" thành công!`, 'success');
    switchView('studio');
    openStudioEditor();
  } catch (error) {
    console.error('Lỗi khi nạp dự án:', error);
    toast('Lỗi khi nạp dự án: ' + error.message, 'error');
  }
}

async function loadProjectQuietly(id) {
  try {
    const res = await fetch(`/api/projects/${id}`);
    if (res.ok) {
      const proj = await res.json();
      deserializeStudioForm(proj);
      console.log(`[Project] Đã tự động khôi phục dự án "${proj.name}"`);
    }
  } catch (e) {
    console.error('[Project] Không thể tự động khôi phục dự án cũ:', e.message);
  }
}

async function renameProject(id, oldName) {
  const newName = prompt('Nhập tên mới cho dự án:', oldName);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (trimmed === '') {
    toast('Tên dự án không được để trống.', 'error');
    return;
  }

  try {
    const getRes = await fetch(`/api/projects/${id}`);
    if (!getRes.ok) throw new Error('Không tìm thấy dự án');
    const proj = await getRes.json();
    
    const saveRes = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: trimmed, data: proj })
    });
    if (!saveRes.ok) throw new Error('Lỗi cập nhật tên');

    if (id === currentProjectId) {
      currentProjectName = trimmed;
      localStorage.setItem('current_project_name', trimmed);
      const nameInput = $('project-name-input');
      if (nameInput) nameInput.value = trimmed;
    }

    toast('✏️ Đã đổi tên dự án thành công!', 'success');
    renderProjectsList();
  } catch (error) {
    console.error('Lỗi đổi tên dự án:', error);
    toast('Lỗi đổi tên dự án: ' + error.message, 'error');
  }
}

async function duplicateProject(id) {
  try {
    const res = await fetch(`/api/projects/${id}/duplicate`, { method: 'POST' });
    if (!res.ok) throw new Error('Không thể nhân bản dự án');
    toast('👯 Đã nhân bản dự án thành công!', 'success');
    renderProjectsList();
  } catch (error) {
    console.error('Lỗi nhân bản dự án:', error);
    toast('Lỗi nhân bản dự án: ' + error.message, 'error');
  }
}

async function deleteProject(id) {
  if (!confirm('Bạn có chắc chắn muốn xóa dự án này? Thao tác này không thể hoàn tác.')) return;
  try {
    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Không thể xóa dự án');
    
    if (id === currentProjectId) {
      currentProjectId = null;
      currentProjectName = 'Dự án chưa đặt tên';
      localStorage.removeItem('current_project_id');
      localStorage.removeItem('current_project_name');
      const nameInput = $('project-name-input');
      if (nameInput) nameInput.value = currentProjectName;
      resetStudioForm();
    }
    
    toast('🗑️ Đã xóa dự án thành công!', 'success');
    renderProjectsList();
  } catch (error) {
    console.error('Lỗi xóa dự án:', error);
    toast('Lỗi xóa dự án: ' + error.message, 'error');
  }
}

let currentProjectsList = [];

async function renderProjectsList() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Không thể tải danh sách dự án');
    const data = await res.json();
    currentProjectsList = data.projects || [];
    
    filterAndRenderProjects();
  } catch (error) {
    console.error('Lỗi khi nạp danh sách dự án:', error);
    toast('Lỗi khi nạp danh sách dự án: ' + error.message, 'error');
  }
}

function filterAndRenderProjects() {
  const query = $('project-search-input')?.value.toLowerCase() || '';
  const filtered = currentProjectsList.filter(p => p.name.toLowerCase().includes(query));
  
  const recentGrid = $('recent-projects-grid');
  if (recentGrid) {
    recentGrid.innerHTML = '';
    const recent = filtered.slice(0, 4);
    if (recent.length === 0) {
      recentGrid.innerHTML = '<div style="grid-column: 1/-1; color: var(--muted); font-size: 13px; text-align: center; padding: 20px;">Chưa có dự án nào gần đây.</div>';
    } else {
      recent.forEach(p => {
        const card = document.createElement('div');
        card.className = 'video-card-item';
        card.style.cssText = 'display: flex; flex-direction: column; cursor: pointer; padding: 12px; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2);';
        card.innerHTML = `
          <div style="aspect-ratio: 16/9; background: #000; border-radius: 4px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;">
            ${p.thumbnail ? `<img src="${p.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 28px;">🎬</span>`}
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="font-weight: 600; font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}</span>
            <span style="font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.videoTitle || 'Chưa chọn video'}</span>
            <span style="font-size: 10px; color: var(--accent); margin-top: 4px;">🕒 ${new Date(p.updatedAt).toLocaleString('vi-VN')}</span>
          </div>
        `;
        card.addEventListener('click', () => {
          loadProject(p.id);
        });
        recentGrid.appendChild(card);
      });
    }
  }

  const tbody = $('project-list-tbody');
  if (tbody) {
    tbody.innerHTML = '';
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: var(--muted);">Không tìm thấy dự án nào.</td></tr>`;
    } else {
      filtered.forEach(p => {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom: 1px solid var(--border); font-size: 13px;';
        tr.innerHTML = `
          <td style="padding: 12px 8px; font-weight: 600; color: var(--text);">${p.name}</td>
          <td style="padding: 12px 8px; color: var(--muted);">${p.videoTitle || '---'}</td>
          <td style="padding: 12px 8px; color: var(--muted);">${new Date(p.updatedAt).toLocaleString('vi-VN')}</td>
          <td style="padding: 12px 8px; text-align: right;">
            <button type="button" class="ghost-btn" style="padding: 4px 10px; font-size: 11px; margin-right: 4px; font-weight: 600; color: var(--accent);" onclick="loadProject('${p.id}')">📂 Mở</button>
            <button type="button" class="ghost-btn" style="padding: 4px 10px; font-size: 11px; margin-right: 4px; font-weight: 600;" onclick="renameProject('${p.id}', '${p.name.replace(/'/g, "\\'")}')">✏️ Đổi tên</button>
            <button type="button" class="ghost-btn" style="padding: 4px 10px; font-size: 11px; margin-right: 4px; font-weight: 600;" onclick="duplicateProject('${p.id}')">👯 Nhân bản</button>
            <button type="button" class="ghost-btn" style="padding: 4px 10px; font-size: 11px; font-weight: 600; color: #ef4444;" onclick="deleteProject('${p.id}')">🗑️ Xóa</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }
  }
}

function initActiveProject() {
  currentProjectId = localStorage.getItem('current_project_id') || null;
  currentProjectName = localStorage.getItem('current_project_name') || 'Dự án chưa đặt tên';
  
  const nameInput = $('project-name-input');
  if (nameInput) {
    nameInput.value = currentProjectName;
  }
  
  if (currentProjectId) {
    loadProjectQuietly(currentProjectId);
  }
  
  setupStudioFormAutoSave();
}

// Export functions to global scope
window.applyAppUpdate = applyAppUpdate;
window.closeUpdateModal = closeUpdateModal;
window.createNewProject = createNewProject;
window.createNewProjectAndNavigate = createNewProjectAndNavigate;
window.saveProjectExplicitly = saveProjectExplicitly;
window.loadProject = loadProject;
window.renameProject = renameProject;
window.duplicateProject = duplicateProject;
window.deleteProject = deleteProject;
window.renderProjectsList = renderProjectsList;
window.initActiveProject = initActiveProject;
window.backToStudioHome = backToStudioHome;
window.openStudioEditor = openStudioEditor;

function saveProjectSynchronously() {
  if (!currentProjectId) return;
  const hasVideo = $('selected-video-file')?.value || $('video-upload')?.files.length;
  if (!hasVideo) return;

  const formData = serializeStudioForm();
  let thumbnail = '';
  const selectedVideoCard = document.querySelector('#studio-video-grid .video-card-item.selected');
  if (selectedVideoCard) {
    const img = selectedVideoCard.querySelector('img');
    if (img) thumbnail = img.src;
  }

  const payload = {
    id: currentProjectId,
    name: currentProjectName,
    data: {
      ...formData,
      videoTitle: $('selected-video-file')?.value || '',
      thumbnail: thumbnail
    }
  };

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects', false); // Synchronous request to block unloading until saved
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(payload));
    console.log('[Unload] Dự án đã được tự động lưu đồng bộ trước khi đóng/chuyển.');
  } catch (e) {
    console.error('[Unload] Lỗi khi tự động lưu đồng bộ trước khi đóng/chuyển:', e);
  }
}

window.addEventListener('beforeunload', () => {
  saveProjectSynchronously();
});




