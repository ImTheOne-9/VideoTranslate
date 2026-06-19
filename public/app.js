const views = {
  download: {
    title: 'Tải video',
    desc: 'Dán link YouTube Shorts, YouTube hoặc Xiaohongshu để tải về thư mục downloads.'
  },
  studio: {
    title: 'Studio render',
    desc: 'Dịch tiếng Việt, chèn sub, thêm voiceover hoặc nhạc nền rồi render ra MP4.'
  },
  voices: {
    title: 'Kho giọng & nhạc',
    desc: 'Lưu sẵn giọng mẫu cho Omi Cloner và lưu nhạc nền dùng lại nhiều lần.'
  },
  bulk: {
    title: 'Tải hàng loạt',
    desc: 'Tải video từ playlist hoặc kênh theo số lượng đã chọn.'
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
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $('view-title').textContent = views[name].title;
  $('view-desc').textContent = views[name].desc;
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function fillSelect(id, items, placeholder) {
  const select = $(id);
  if (!select) return;
  select.innerHTML = `<option value="">${placeholder}</option>`;
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.filename;
    option.textContent = item.filename;
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
  $('omi-status').innerHTML = assets.omiConfigured
    ? '<span class="dot ok"></span> OmniVoice sẵn sàng'
    : '<span class="dot warn"></span> Thiếu OmniVoice CLI/model';
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

  const vietsub = document.createElement('a');
  vietsub.className = 'quality-btn green';
  vietsub.href = `/api/download-vi?url=${encodeURIComponent(currentUrl)}`;
  vietsub.textContent = 'Tải + dịch Vietsub';
  grid.appendChild(vietsub);

  for (const format of data.formats || []) {
    const link = document.createElement('a');
    link.className = 'quality-btn';
    link.href = `/api/download?url=${encodeURIComponent(currentUrl)}&format_id=${encodeURIComponent(format.format_id)}`;
    link.textContent = `${format.quality} · ${format.size}`;
    grid.appendChild(link);
  }

  $('video-card').classList.remove('hidden');
}

async function saveVoice(event) {
  event.preventDefault();
  const btn = event.submitter;
  setBusy(btn, true, 'Đang lưu...');
  try {
    const res = await fetch('/api/save-voice', { method: 'POST', body: new FormData(event.currentTarget) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không lưu được giọng');
    event.currentTarget.reset();
    toast(data.message || 'Đã lưu giọng', 'success');
    await loadAssets();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function saveMusic(event) {
  event.preventDefault();
  const btn = event.submitter;
  setBusy(btn, true, 'Đang lưu...');
  try {
    const res = await fetch('/api/save-music', { method: 'POST', body: new FormData(event.currentTarget) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không lưu được nhạc');
    event.currentTarget.reset();
    toast(data.message || 'Đã lưu nhạc', 'success');
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

  data.set('translateVi', $('translate-vi').checked ? 'true' : 'false');
  data.set('burnSub', $('burn-sub').checked ? 'true' : 'false');

  setBusy(btn, true, 'Đang render...');
  status.textContent = 'Đang xử lý. Video dài hoặc tạo sub Whisper sẽ mất thời gian.';
  try {
    const res = await fetch('/api/render-studio', { method: 'POST', body: data });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Render lỗi');
    status.textContent = 'Hoàn tất.';
    const resultHtml = `
      <video controls src="${result.url}"></video>
      <a class="download-link" href="${result.url}" download>Tải video render</a>
    `;
    const renderResultSidebar = $('render-result');
    if (renderResultSidebar) {
      renderResultSidebar.classList.remove('empty');
      renderResultSidebar.innerHTML = resultHtml;
    }
    
    const studioResult = $('studio-render-result');
    if (studioResult) {
      studioResult.innerHTML = resultHtml;
    }
    toast('Render video thành công', 'success');
    await loadAssets();
  } catch (error) {
    status.textContent = '';
    toast(error.message, 'error');
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
  
  const dragRect = dragEl.getBoundingClientRect();
  const videoRect = getVideoContentRect(video);
  
  const W_act = video.videoWidth || 1280;
  const H_act = video.videoHeight || 720;
  
  // 1. Determine quadrants
  const centerPercent = (dragRect.left - videoRect.left + dragRect.width / 2) / videoRect.width;
  const topPercent = (dragRect.top - videoRect.top) / videoRect.height;
  
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
  
  // 3. Compute vertical margin based on quadrant (Top vs Bottom)
  let MarginV_act = 0;
  if (verticalSec === 'top') {
    // Top alignment: margin is measured from the top edge
    const marginT_disp = dragRect.top - videoRect.top;
    MarginV_act = Math.round(marginT_disp * (H_act / videoRect.height));
  } else {
    // Bottom/Middle alignment: margin is measured from the bottom edge
    const marginV_disp = videoRect.bottom - dragRect.bottom;
    MarginV_act = Math.round(marginV_disp * (H_act / videoRect.height));
  }
  
  // Compute horizontal margin
  const marginL_disp = dragRect.left - videoRect.left;
  const marginR_disp = videoRect.right - dragRect.right;
  const marginH_disp = Math.min(marginL_disp, marginR_disp);
  const MarginH_act = Math.round(marginH_disp * (W_act / videoRect.width));
  
  document.querySelector('input[name="subtitleMargin"]').value = Math.max(0, MarginV_act);
  document.querySelector('input[name="subtitleMarginH"]').value = Math.max(0, MarginH_act);
}

function updateSubtitleOverlayFromInputs() {
  const dragEl = $('draggable-subtitle');
  const video = $('studio-video-preview');
  
  if (!dragEl || !video) return;
  
  const containerRect = video.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) return;
  
  const videoRect = getVideoContentRect(video);
  
  const W_act = video.videoWidth || 1280;
  const H_act = video.videoHeight || 720;
  
  const fontSizeInput = Number(document.querySelector('input[name="subtitleSize"]').value || 18);
  const marginVInput = Number(document.querySelector('input[name="subtitleMargin"]').value || 28);
  const marginHInput = Number(document.querySelector('input[name="subtitleMarginH"]').value || 20);
  const alignment = Number(document.querySelector('[name="subtitleAlignment"]').value || 2);
  
  const font_scale = videoRect.height / H_act;
  const fontSize_disp = Math.max(10, fontSizeInput * font_scale);
  dragEl.style.fontSize = fontSize_disp + 'px';

  // Apply visual styling dynamically from input controls
  const fontNameInput = document.querySelector('select[name="subtitleFont"]').value || 'Arial';
  const colorInput = document.querySelector('[name="subtitleColor"]').value || '#FFFFFF';
  const themeInput = document.querySelector('select[name="subtitleTheme"]').value || 'outline';
  const boldInput = document.querySelector('select[name="subtitleBold"]').value === 'true';

  dragEl.style.fontFamily = fontNameInput;
  dragEl.style.fontWeight = boldInput ? 'bold' : 'normal';
  
  if (themeInput === 'box') {
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
    dragEl.style.textShadow = 'none';
    dragEl.style.webkitTextStroke = '0px';
    dragEl.style.padding = '4px 8px';
    dragEl.style.borderRadius = '4px';
  } else if (themeInput === 'shadow') {
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'transparent';
    dragEl.style.webkitTextStroke = '0px';
    dragEl.style.textShadow = '2px 2px 4px rgba(0, 0, 0, 0.8)';
    dragEl.style.padding = '0';
  } else { // 'outline'
    dragEl.style.color = colorInput;
    dragEl.style.backgroundColor = 'transparent';
    dragEl.style.webkitTextStroke = '1.5px black';
    dragEl.style.textShadow = '1px 1px 2px rgba(0, 0, 0, 0.8)';
    dragEl.style.padding = '0';
  }
  
  const marginV_disp = marginVInput * (videoRect.height / H_act);
  const marginH_disp = marginHInput * (videoRect.width / W_act);
  
  const dragRect = dragEl.getBoundingClientRect();
  
  let left = 0;
  let top = 0;
  
  if ([5, 6, 7].includes(alignment)) {
    top = (videoRect.top - containerRect.top) + marginV_disp;
  } else if ([9, 10, 11].includes(alignment)) {
    top = (videoRect.top - containerRect.top) + (videoRect.height - dragRect.height) / 2;
  } else {
    top = (videoRect.bottom - containerRect.top) - dragRect.height - marginV_disp;
  }
  
  if ([1, 5, 9].includes(alignment)) {
    left = (videoRect.left - containerRect.left) + marginH_disp;
  } else if ([3, 7, 11].includes(alignment)) {
    left = (videoRect.right - containerRect.left) - dragRect.width - marginH_disp;
  } else {
    left = (videoRect.left - containerRect.left) + (videoRect.width - dragRect.width) / 2;
  }
  
  // Constrain dragging to actual video bounds relative to container
  const minLeft = videoRect.left - containerRect.left;
  const maxLeft = videoRect.right - containerRect.left - dragRect.width;
  const minTop = videoRect.top - containerRect.top;
  const maxTop = videoRect.bottom - containerRect.top - dragRect.height;
  
  left = Math.max(minLeft, Math.min(left, maxLeft));
  top = Math.max(minTop, Math.min(top, maxTop));
  
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
  
  const W_act = mainVideo.videoWidth || 1280;
  const H_act = mainVideo.videoHeight || 720;
  
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
  
  if (!dragEl || !wrapper) return;
  
  let isDragging = false;
  let startX, startY;
  let initialLeft, initialTop;
  
  dragEl.addEventListener('mousedown', startDrag);
  dragEl.addEventListener('touchstart', startDrag, { passive: true });
  
  function startDrag(e) {
    isDragging = true;
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
    const containerRect = video.getBoundingClientRect();
    const dragRect = dragEl.getBoundingClientRect();
    
    let newLeft = initialLeft + dx;
    let newTop = initialTop + dy;
    
    const minLeft = videoRect.left - containerRect.left;
    const maxLeft = videoRect.right - containerRect.left - dragRect.width;
    const minTop = videoRect.top - containerRect.top;
    const maxTop = videoRect.bottom - containerRect.top - dragRect.height;
    
    newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));
    newTop = Math.max(minTop, Math.min(newTop, maxTop));
    
    dragEl.style.left = newLeft + 'px';
    dragEl.style.top = newTop + 'px';
    
    updateInputsFromSubtitlePosition();
  }
  
  function stopDrag() {
    isDragging = false;
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('touchmove', drag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchend', stopDrag);
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
['subtitle-mode', 'voice-mode', 'music-mode', 'reaction-mode'].forEach(id => $(id).addEventListener('change', updateConditionalFields));

// Register two-way binding inputs
const subtitleInputs = [
  'subtitleSize', 'subtitleMargin', 'subtitleMarginH',
  'subtitleAlignment', 'subtitleFont', 'subtitleTheme',
  'subtitleColor', 'subtitleBold', 'reactionPosition', 'reactionWidth'
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

window.addEventListener('resize', updateSubtitleOverlayFromInputs);

function updateInputsFromReactionGeometry() {
  const pipEl = $('preview-reaction-pip');
  const mainVideo = $('studio-video-preview');
  
  if (!pipEl || !mainVideo || pipEl.classList.contains('hidden')) return;
  
  const containerRect = mainVideo.getBoundingClientRect();
  const videoRect = getVideoContentRect(mainVideo);
  
  const W_act = mainVideo.videoWidth || 1280;
  const H_act = mainVideo.videoHeight || 720;
  
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

loadAssets().then(updateConditionalFields).catch(() => toast('Không đọc được thư viện local.', 'error'));
