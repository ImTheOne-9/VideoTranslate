function stopAllAudio() {
  if (currentAudio) {
    currentAudio.pause();
    if (currentPlayBtn) {
      currentPlayBtn.innerHTML = 'Nghe';
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

// Cập nhật dải thống kê Thư viện
function updateLibraryStats() {
  const videoBadge = $('rendered-count-badge');
  const voiceBadge = $('voice-count-badge');
  const musicBadge = $('music-count-badge');

  const statVideos = $('stat-lib-videos');
  const statVoices = $('stat-lib-voices');
  const statMusic  = $('stat-lib-music');

  if (statVideos && videoBadge) {
    const n = parseInt(videoBadge.textContent, 10);
    statVideos.textContent = isNaN(n) ? 0 : n;
  }
  if (statVoices && voiceBadge) {
    const n = parseInt(voiceBadge.textContent, 10);
    statVoices.textContent = isNaN(n) ? 0 : n;
  }
  if (statMusic && musicBadge) {
    const n = parseInt(musicBadge.textContent, 10);
    statMusic.textContent = isNaN(n) ? 0 : n;
  }
}

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
  setTimeout(updateLibraryStats, 0);

  container.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(filtered.length / videosPerPage));
  if (currentVideoPage > totalPages) {
    currentVideoPage = totalPages;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state-block" style="grid-column: 1 / -1;">
        <div class="esb-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </div>
        <h4>Chưa có video đã render nào</h4>
        <p>Sau khi render xong, video sẽ xuất hiện tại đây</p>
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
        <video src="${videoUrl}?t=${video.modified || Date.now()}" muted playsinline preload="metadata"></video>
        <div class="rendered-card-play-btn" onclick="playRenderedVideo('${video.filename.replace(/'/g, "\\'")}', '${videoUrl.replace(/'/g, "\\'")}')">▶</div>
      </div>
      <div class="rendered-card-info">
        <div class="rendered-card-name" title="${video.filename.replace(/"/g, '&quot;')}">${video.filename}</div>
        <div class="rendered-card-meta">
          <span>${sizeStr}</span>
          <span>${dateStr}</span>
        </div>
      </div>
      <div class="rendered-card-actions">
        <button type="button" class="rendered-card-btn rendered-btn-publish" onclick="openFbModal('${videoUrl.replace(/'/g, "\\'")}')">
          Đăng FB
        </button>
        <button type="button" class="rendered-card-btn rendered-btn-delete" onclick="confirmDeleteRenderedVideo('${video.filename.replace(/'/g, "\\'")}')">
          Xóa
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

// ==========================================
// Omni Cloner Voice Generator
// ==========================================
let clonerPollInterval = null;

function previewClonerRefAudio(input) {
  const preview = $('cloner-ref-preview');
  const player = $('cloner-ref-audio-player');
  if (input.files && input.files[0]) {
    player.src = URL.createObjectURL(input.files[0]);
    preview.classList.remove('hidden');
  } else {
    player.src = '';
    preview.classList.add('hidden');
  }
}

function openOmniClonerModal() {
  const statusEl = $('cloner-omi-status');
  if (statusEl) {
    if (assets.omiConfigured) {
      statusEl.textContent = '✅ OmniVoice đã sẵn sàng';
      statusEl.style.color = '#22c55e';
    } else {
      statusEl.textContent = '⚠️ OmniVoice chưa được cài đặt. Vào Cài đặt hệ thống để tải.';
      statusEl.style.color = '#f59e0b';
    }
  }
  const modal = $('omni-cloner-modal');
  if (modal) modal.classList.remove('hidden');
  $('cloner-generate-btn').classList.remove('hidden');
  $('cloner-cancel-btn').classList.add('hidden');
  $('cloner-result-area').classList.add('hidden');
  $('cloner-ref-preview').classList.add('hidden');
}

function closeOmniClonerModal() {
  if (clonerPollInterval) {
    clearInterval(clonerPollInterval);
    clonerPollInterval = null;
  }
  const modal = $('omni-cloner-modal');
  if (modal) modal.classList.add('hidden');
  const form = $('omni-cloner-form');
  if (form) form.reset();
  const deviceSelect = $('cloner-device');
  if (deviceSelect) deviceSelect.value = 'cpu';
  $('cloner-progress-area').classList.add('hidden');
  $('cloner-error').classList.add('hidden');
  $('cloner-result-area').classList.add('hidden');
  $('cloner-ref-preview').classList.add('hidden');
  $('cloner-generate-btn').classList.remove('hidden');
  $('cloner-cancel-btn').classList.add('hidden');
}

async function generateOmniClonerVoice(event) {
  event.preventDefault();

  const voiceName = $('cloner-voice-name').value.trim();
  const refAudio = $('cloner-ref-audio').files[0];
  const refText = $('cloner-ref-text').value.trim();
  const script = $('cloner-script').value.trim();
  const btn = $('cloner-generate-btn');
  const cancelBtn = $('cloner-cancel-btn');
  const progressArea = $('cloner-progress-area');
  const progressBar = $('cloner-progress-bar');
  const progressText = $('cloner-progress-text');
  const progressPct = $('cloner-progress-pct');
  const errorEl = $('cloner-error');

  if (!voiceName || !refAudio || !refText || !script) {
    toast('❌ Vui lòng nhập đầy đủ thông tin!', 'error');
    return;
  }

  if (!assets.omiConfigured) {
    toast('❌ OmniVoice chưa được cài đặt. Vui lòng tải OmniVoice trước.', 'error');
    return;
  }

  btn.classList.add('hidden');
  cancelBtn.classList.remove('hidden');
  errorEl.classList.add('hidden');
  progressArea.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = 'Đang khởi tạo...';
  progressPct.textContent = '0%';

  const formData = new FormData();
  formData.append('voiceName', voiceName);
  formData.append('refAudio', refAudio);
  formData.append('refText', refText);
  formData.append('script', script);
  formData.append('device', $('cloner-device').value);

  // Bắt đầu polling tiến trình
  clonerPollInterval = setInterval(async () => {
    try {
      const pRes = await fetch('/api/cloner-voice-progress');
      const pData = await pRes.json();
      if (pData.active || pData.percent < 100) {
        progressBar.style.width = `${pData.percent}%`;
        progressText.textContent = pData.stage || 'Đang xử lý...';
        progressPct.textContent = `${pData.percent}%`;
      }
    } catch (e) {}
  }, 500);

  try {
    const res = await fetch('/api/generate-cloner-voice', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (clonerPollInterval) {
      clearInterval(clonerPollInterval);
      clonerPollInterval = null;
    }

    if (data.cancelled) {
      toast('⏹ Đã hủy tạo giọng', 'info');
      btn.classList.remove('hidden');
      cancelBtn.classList.add('hidden');
      progressArea.classList.add('hidden');
      return;
    }

    if (!res.ok) throw new Error(data.error || 'Lỗi tạo giọng');

    progressBar.style.width = '100%';
    progressText.textContent = '✅ Hoàn tất!';
    progressPct.textContent = '100%';
    cancelBtn.classList.add('hidden');

    // Hiển thị kết quả để nghe
    const resultArea = $('cloner-result-area');
    const resultAudio = $('cloner-result-audio');
    resultArea.classList.remove('hidden');
    resultAudio.src = `/voices/${encodeURIComponent(data.filename)}`;
    resultAudio.play().catch(() => {});

    toast('🎉 ' + (data.message || 'Tạo giọng mẫu thành công!'), 'success');
    await loadAssets();
  } catch (err) {
    console.error('Lỗi tạo giọng Omni Cloner:', err);
    if (clonerPollInterval) {
      clearInterval(clonerPollInterval);
      clonerPollInterval = null;
    }
    errorEl.textContent = `Lỗi: ${err.message}`;
    errorEl.classList.remove('hidden');
    btn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    toast('❌ ' + err.message, 'error');
  }
}

async function cancelClonerVoice() {
  try {
    await fetch('/api/cancel-cloner-voice', { method: 'POST' });
  } catch (e) {}
}

window.previewClonerRefAudio = previewClonerRefAudio;
window.openOmniClonerModal = openOmniClonerModal;
window.closeOmniClonerModal = closeOmniClonerModal;
window.generateOmniClonerVoice = generateOmniClonerVoice;
window.cancelClonerVoice = cancelClonerVoice;

// ==========================================
function renderVoicesList(searchFilter = '') {
  const container = $('voice-list-tbody');
  const countBadge = $('voice-count-badge');
  if (!container) return;

  const voicesList = assets.voices || [];
  const filtered = voicesList.filter(v =>
    v.filename.toLowerCase().includes(searchFilter.toLowerCase())
  );

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Giọng`;
  }

  container.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(filtered.length / voicesPerPage));
  if (currentVoicePage > totalPages) {
    currentVoicePage = totalPages;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="audio-gallery-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--soft)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
          <line x1="12" y1="19" x2="12" y2="22"/>
        </svg>
        <div class="audio-gallery-empty-title">${searchFilter ? 'Không tìm thấy giọng mẫu nào phù hợp' : 'Chưa có giọng mẫu nào'}</div>
        <div class="audio-gallery-empty-sub">${searchFilter ? 'Thử tìm kiếm với từ khóa khác' : 'Tải lên file ghi âm (.mp3, .wav, .m4a...) để làm giọng mẫu'}</div>
      </div>
    `;
    const pagContainer = $('voice-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const startIndex = (currentVoicePage - 1) * voicesPerPage;
  const pageItems = filtered.slice(startIndex, startIndex + voicesPerPage);

  // Generate hue color from filename for avatar
  function getVoiceHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }

  pageItems.forEach(voice => {
    let sizeStr = 'Không rõ';
    if (voice.size) {
      sizeStr = voice.size > 1024 * 1024
        ? `${(voice.size / (1024 * 1024)).toFixed(1)} MB`
        : `${(voice.size / 1024).toFixed(0)} KB`;
    }

    let dateStr = 'Không rõ';
    if (voice.modified) {
      const d = new Date(voice.modified);
      dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    const voiceUrl = `/voices/${encodeURIComponent(voice.filename)}`;
    const isPlaying = currentAudio && currentAudioUrl === voiceUrl && !currentAudio.paused;
    const nameNoExt = voice.filename.replace(/\.[^.]+$/, '');
    const initials = nameNoExt.slice(0, 2).toUpperCase();
    const hue = getVoiceHue(voice.filename);

    const card = document.createElement('div');
    card.className = 'audio-gallery-card';
    card.innerHTML = `
      <div class="agc-header">
        <div class="agc-avatar" style="--hue: ${hue}deg">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
            <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
          </svg>
          <span class="agc-initials">${initials}</span>
        </div>
        <div class="agc-info">
          <div class="agc-name" title="${voice.filename.replace(/"/g, '&quot;')}">${nameNoExt}</div>
          <div class="agc-meta">
            <span>${sizeStr}</span>
            <span class="agc-dot">•</span>
            <span>${dateStr}</span>
          </div>
        </div>
      </div>
      <div class="agc-waveform">
        ${Array.from({length: 20}, (_, i) => `<span class="agc-bar" style="--h: ${30 + Math.abs(Math.sin(i * 1.3 + hue * 0.02) * 50)}%"></span>`).join('')}
      </div>
      <div class="agc-actions">
        <button type="button" class="agc-btn agc-btn-play ${isPlaying ? 'playing' : ''}" onclick="togglePlayAudio(this, '${voiceUrl.replace(/'/g, "\\'")}')"
          data-audio-url="${voiceUrl.replace(/"/g, '&quot;')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
            <polygon points="5,3 19,12 5,21"/>
          </svg>
          ${isPlaying ? 'Dừng' : 'Nghe'}
        </button>
        <button type="button" class="agc-btn agc-btn-delete" onclick="confirmDeleteVoice('${voice.filename.replace(/'/g, "\\'")}')"
          title="Xóa giọng mẫu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <polyline points="3,6 5,6 21,6"/>
            <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/>
          </svg>
          Xóa
        </button>
      </div>
    `;
    container.appendChild(card);
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
  const container = $('music-list-tbody');
  const countBadge = $('music-count-badge');
  if (!container) return;

  const musicList = assets.music || [];
  const filtered = musicList.filter(v =>
    v.filename.toLowerCase().includes(searchFilter.toLowerCase())
  );

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Nhạc`;
  }

  container.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(filtered.length / musicPerPage));
  if (currentMusicPage > totalPages) {
    currentMusicPage = totalPages;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="audio-gallery-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--soft)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
        <div class="audio-gallery-empty-title">${searchFilter ? 'Không tìm thấy nhạc nền nào phù hợp' : 'Chưa có nhạc nền nào'}</div>
        <div class="audio-gallery-empty-sub">${searchFilter ? 'Thử tìm kiếm với từ khóa khác' : 'Nhấn "THÊM NHẠC MỚI" để tải nhạc nền từ máy của bạn'}</div>
      </div>
    `;
    const pagContainer = $('music-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const startIndex = (currentMusicPage - 1) * musicPerPage;
  const pageItems = filtered.slice(startIndex, startIndex + musicPerPage);

  function getMusicHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return (h + 180) % 360;
  }

  pageItems.forEach(music => {
    let sizeStr = 'Không rõ';
    if (music.size) {
      sizeStr = music.size > 1024 * 1024
        ? `${(music.size / (1024 * 1024)).toFixed(1)} MB`
        : `${(music.size / 1024).toFixed(0)} KB`;
    }

    let dateStr = 'Không rõ';
    if (music.modified) {
      const d = new Date(music.modified);
      dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    const musicUrl = `/music/${encodeURIComponent(music.filename)}`;
    const isPlaying = currentAudio && currentAudioUrl === musicUrl && !currentAudio.paused;
    const nameNoExt = music.filename.replace(/\.[^.]+$/, '');
    const initials = nameNoExt.slice(0, 2).toUpperCase();
    const hue = getMusicHue(music.filename);

    const card = document.createElement('div');
    card.className = 'audio-gallery-card music-card';
    card.innerHTML = `
      <div class="agc-header">
        <div class="agc-avatar agc-avatar-music" style="--hue: ${hue}deg">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
          <span class="agc-initials">${initials}</span>
        </div>
        <div class="agc-info">
          <div class="agc-name" title="${music.filename.replace(/"/g, '&quot;')}">${nameNoExt}</div>
          <div class="agc-meta">
            <span>${sizeStr}</span>
            <span class="agc-dot">•</span>
            <span>${dateStr}</span>
          </div>
        </div>
      </div>
      <div class="agc-waveform agc-waveform-music">
        ${Array.from({length: 20}, (_, i) => `<span class="agc-bar" style="--h: ${25 + Math.abs(Math.cos(i * 0.9 + hue * 0.03) * 55)}%"></span>`).join('')}
      </div>
      <div class="agc-actions">
        <button type="button" class="agc-btn agc-btn-play agc-btn-play-music ${isPlaying ? 'playing' : ''}" onclick="togglePlayAudio(this, '${musicUrl.replace(/'/g, "\\'")}')"
          data-audio-url="${musicUrl.replace(/"/g, '&quot;')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
            <polygon points="5,3 19,12 5,21"/>
          </svg>
          ${isPlaying ? 'Dừng' : 'Nghe'}
        </button>
        <button type="button" class="agc-btn agc-btn-delete" onclick="confirmDeleteMusic('${music.filename.replace(/'/g, "\\'")}')"
          title="Xóa nhạc nền">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <polyline points="3,6 5,6 21,6"/>
            <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/>
          </svg>
          Xóa
        </button>
      </div>
    `;
    container.appendChild(card);
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

