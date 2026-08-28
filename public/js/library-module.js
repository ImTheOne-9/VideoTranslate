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

function updateClonerEngineUi() {
  const engineId = $('cloner-voice-engine-select')?.value || 'current-omnivoice';
  const isEdge = engineId === 'edge-tts';
  const refAudio = $('cloner-ref-audio');
  const refText = $('cloner-ref-text');
  $('cloner-reference-audio-group')?.classList.toggle('hidden', isEdge);
  $('cloner-reference-text-group')?.classList.toggle('hidden', isEdge);
  $('cloner-device-group')?.classList.toggle('hidden', isEdge);
  $('cloner-cpu-fallback-group')?.classList.add('hidden');
  $('cloner-edge-settings')?.classList.toggle('hidden', !isEdge);
  if (refAudio) refAudio.required = !isEdge;
  if (refText) refText.required = !isEdge;

  const edgeVoice = $('cloner-edge-voice');
  const sourceVoices = $('edge-voice-select');
  if (edgeVoice && sourceVoices && edgeVoice.options.length === 0) {
    edgeVoice.innerHTML = sourceVoices.innerHTML;
    edgeVoice.value = sourceVoices.value;
  }

  const statusEl = $('cloner-omi-status');
  if (statusEl) {
    const descriptor = (assets.voiceEngines || []).find((engine) => engine.id === engineId);
    if (descriptor?.status?.ready) {
      statusEl.textContent = isEdge
        ? '✅ Edge TTS sẵn sàng (cần kết nối Internet)'
        : '✅ OmniVoice đã sẵn sàng';
      statusEl.style.color = '#22c55e';
    } else {
      statusEl.textContent = descriptor?.status?.error || `${descriptor?.name || engineId} chưa sẵn sàng`;
      statusEl.style.color = '#f59e0b';
    }
  }
  const title = $('cloner-modal-title');
  if (title) title.textContent = isEdge ? '🔊 Tạo giọng bằng Edge TTS' : '🤖 Tạo giọng bằng Omni Cloner';
}

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
  const engineSelect = $('cloner-voice-engine-select');
  if (engineSelect) engineSelect.onchange = updateClonerEngineUi;
  updateClonerEngineUi();
  const modal = $('omni-cloner-modal');
  if (modal) modal.classList.remove('hidden');
  $('cloner-generate-btn').classList.remove('hidden');
  $('cloner-cancel-btn').classList.add('hidden');
  const saveBtn = $('cloner-save-btn');
  if (saveBtn) saveBtn.classList.add('hidden');
  $('cloner-result-area').classList.add('hidden');
  $('cloner-ref-preview').classList.add('hidden');
  const closeBtn = $('cloner-close-btn');
  if (closeBtn) closeBtn.textContent = 'Đóng';
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
  if (deviceSelect) deviceSelect.value = 'cuda:0';
  $('cloner-progress-area').classList.add('hidden');
  $('cloner-error').classList.add('hidden');
  $('cloner-result-area').classList.add('hidden');
  $('cloner-ref-preview').classList.add('hidden');
  $('cloner-generate-btn').classList.remove('hidden');
  $('cloner-cancel-btn').classList.add('hidden');
  const saveBtn = $('cloner-save-btn');
  if (saveBtn) saveBtn.classList.add('hidden');
  const closeBtn = $('cloner-close-btn');
  if (closeBtn) closeBtn.textContent = 'Đóng';

  // Clear temporary cloner voice file if it exists
  fetch('/api/clear-temp-cloner-voice', { method: 'POST' }).catch(() => {});
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
  const engineId = $('cloner-voice-engine-select')?.value || 'current-omnivoice';
  const isEdge = engineId === 'edge-tts';

  if (!voiceName || !script || (!isEdge && (!refAudio || !refText))) {
    toast('❌ Vui lòng nhập đầy đủ thông tin!', 'error');
    return;
  }

  const engine = (assets.voiceEngines || []).find((item) => item.id === engineId);
  if (!engine?.status?.ready || (!isEdge && !assets.omiConfigured)) {
    toast(`❌ ${engine?.status?.error || 'Voice engine chưa sẵn sàng.'}`, 'error');
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
  if (refAudio) formData.append('refAudio', refAudio);
  if (refText) formData.append('refText', refText);
  formData.append('script', script);
  formData.append('device', $('cloner-device').value);
  formData.append('voiceEngine', engineId);
  if (isEdge) {
    formData.append('edgeVoice', $('cloner-edge-voice')?.value || 'vi-VN-HoaiMyNeural');
    formData.append('edgeRate', $('cloner-edge-rate')?.value || '+0%');
    formData.append('edgePitch', $('cloner-edge-pitch')?.value || '+0Hz');
  }
  formData.append('allowCpuFallback', $('cloner-allow-cpu-fallback')?.checked ? 'true' : 'false');

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
      const closeBtn = $('cloner-close-btn');
      if (closeBtn) closeBtn.textContent = 'Đóng';
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

    const saveBtn = $('cloner-save-btn');
    if (saveBtn) saveBtn.classList.remove('hidden');

    const closeBtn = $('cloner-close-btn');
    if (closeBtn) closeBtn.textContent = 'Hủy bỏ';

    toast('🎉 Tạo giọng mẫu thành công! Hãy nghe thử và nhấn "Lưu giọng".', 'success');
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
    const closeBtn = $('cloner-close-btn');
    if (closeBtn) closeBtn.textContent = 'Đóng';
    toast('❌ ' + err.message, 'error');
  }
}

async function saveClonerVoice() {
  const voiceName = $('cloner-voice-name').value.trim();
  if (!voiceName) {
    toast('❌ Vui lòng nhập tên giọng mẫu gợi nhớ!', 'error');
    return;
  }

  const saveBtn = $('cloner-save-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Đang lưu...';
  }

  try {
    const res = await fetch('/api/save-cloner-voice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ voiceName })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi khi lưu giọng');

    toast('🎉 ' + (data.message || 'Lưu giọng mẫu thành công!'), 'success');
    closeOmniClonerModal();
    await loadAssets();
  } catch (err) {
    toast('❌ ' + err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Lưu giọng';
    }
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
window.saveClonerVoice = saveClonerVoice;

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
    
    if (bytesLabel) bytesLabel.textContent = status.message || 'Đang cài runtime/model…';
    
    if (actionBtn) {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Đang tải...';
      actionBtn.style.display = '';
    }
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.style.display = '';
    }
    if (closeBtn) closeBtn.style.display = 'none';
  } else {
    isDownloadingModel = false;
    if (status.percent === 100) {
      if (statusLabel) statusLabel.textContent = 'Tải thành công! Đã lưu vào thư mục cài đặt.';
      if (percentLabel) percentLabel.textContent = '100%';
      if (progressBar) progressBar.style.width = '100%';
      if (bytesLabel) bytesLabel.textContent = 'CUDA inference đã được xác minh';
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Hoàn tất';
        actionBtn.style.background = '';
        actionBtn.style.color = '';
        actionBtn.style.display = '';
        actionBtn.onclick = () => {
          closeModelDownloadModal();
          loadAssets();
        };
      }
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
      }
      if (closeBtn) closeBtn.style.display = 'block';
    } else if (status.error) {
      if (statusLabel) statusLabel.textContent = `Lỗi: ${status.error}`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Thử lại';
        actionBtn.style.display = '';
        actionBtn.onclick = startModelDownload;
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Đóng';
        cancelBtn.style.background = '';
        cancelBtn.style.color = '';
        cancelBtn.style.display = '';
        cancelBtn.onclick = closeModelDownloadModal;
      }
      if (closeBtn) closeBtn.style.display = 'block';
    } else {
      if (statusLabel) statusLabel.textContent = 'Sẵn sàng tải xuống';
      if (percentLabel) percentLabel.textContent = '0%';
      if (progressBar) progressBar.style.width = '0%';
      if (bytesLabel) bytesLabel.textContent = 'Theo tiến trình cài đặt';
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Bắt đầu tải';
        actionBtn.style.display = '';
        actionBtn.onclick = startModelDownload;
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Đóng';
        cancelBtn.style.background = '';
        cancelBtn.style.color = '';
        cancelBtn.style.display = '';
        cancelBtn.onclick = closeModelDownloadModal;
      }
      if (closeBtn) closeBtn.style.display = 'block';
    }
  }
}

function startModelDownload() {
  fetch('/api/download-model', { method: 'POST' })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.message || `HTTP ${res.status}`);
      }
      return data;
    })
    .then(data => {
      toast('🚀 Bắt đầu cài OmniVoice Python/CUDA...', 'info');
      startStatusPolling();
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
            toast('🎉 OmniVoice đã cài xong và vượt qua inference CUDA thật!', 'success');
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
let whisperEnsurePromise = null;
const FASTER_WHISPER_MODEL_ID = 'large-v3-turbo';
const FASTER_WHISPER_MODEL_LABEL = 'FASTER-WHISPER LARGE V3 TURBO';

function openWhisperDownloadModal() {
  const modal = $('whisper-download-modal');
  if (modal) modal.classList.remove('hidden');

  const modelNameEl = $('whisper-download-model-name');
  if (modelNameEl) {
    modelNameEl.textContent = FASTER_WHISPER_MODEL_LABEL;
  }

  fetch('/api/whisper-model/status')
    .then(res => res.json())
    .then(status => {
      updateWhisperDownloadUI(status);
      if (status.downloading) {
        startWhisperStatusPolling();
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

function updateWhisperDownloadUI(status) {
  updateWhisperRuntimeUi(status);
  const statusLabel = $('whisper-download-status-label');
  const percentLabel = $('whisper-download-percent-label');
  const progressBar = $('whisper-download-progress-bar');
  const sizeLabel = $('whisper-download-size-label');
  const bytesLabel = $('whisper-download-bytes-label');
  const actionBtn = $('whisper-download-action-btn');
  const cancelBtn = $('whisper-download-cancel-btn');
  const closeBtn = $('whisper-download-close');

  const targetSize = '1.51 GB';
  if (sizeLabel) sizeLabel.textContent = `Kích thước: ~${targetSize}`;

  if (status.downloading) {
    isDownloadingWhisper = true;
    if (statusLabel) statusLabel.textContent = status.message || (status.phase === 'runtime'
      ? 'Đang cài bộ công cụ Faster-Whisper...'
      : 'Đang tải model từ máy chủ...');
    if (percentLabel) percentLabel.textContent = `${status.percent}%`;
    if (progressBar) progressBar.style.width = `${status.percent}%`;
    
    const mbDownloaded = (Number(status.downloadedBytes || 0) / (1024 * 1024)).toFixed(1);
    const mbTotal = (Number(status.totalBytes || 0) / (1024 * 1024)).toFixed(1);
    if (bytesLabel) bytesLabel.textContent = status.phase === 'runtime'
      ? 'Đang chuẩn bị Python và thư viện ASR'
      : `${mbDownloaded} MB / ${mbTotal} MB`;
    
    if (actionBtn) {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Đang tải...';
      actionBtn.style.display = '';
    }
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.style.display = '';
    }
    if (closeBtn) closeBtn.style.display = 'none';
  } else {
    isDownloadingWhisper = false;
    if (status.ready) {
      if (statusLabel) statusLabel.textContent = 'Faster-Whisper đã sẵn sàng bằng runtime hệ thống.';
      if (percentLabel) percentLabel.textContent = '100%';
      if (progressBar) progressBar.style.width = '100%';
      const mbTotal = status.totalBytes ? (status.totalBytes / (1024 * 1024)).toFixed(1) : targetSize.split(' ')[0];
      if (bytesLabel) bytesLabel.textContent = `${mbTotal} MB / ${mbTotal} MB`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Hoàn tất';
        actionBtn.style.background = '';
        actionBtn.style.color = '';
        actionBtn.style.display = '';
        actionBtn.onclick = () => {
          closeWhisperDownloadModal();
          checkWhisperModelStatus();
        };
      }
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
      }
      if (closeBtn) closeBtn.style.display = 'block';
    } else if (status.error) {
      if (statusLabel) statusLabel.textContent = `Lỗi: ${status.error}`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Thử lại';
        actionBtn.style.display = '';
        actionBtn.onclick = startWhisperDownload;
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Đóng';
        cancelBtn.style.background = '';
        cancelBtn.style.color = '';
        cancelBtn.style.display = '';
        cancelBtn.onclick = closeWhisperDownloadModal;
      }
      if (closeBtn) closeBtn.style.display = 'block';
    } else {
      if (statusLabel) statusLabel.textContent = status.state === 'runtime_missing'
        ? 'Thiếu bộ công cụ Python/Faster-Whisper'
        : 'Sẵn sàng tải xuống';
      if (percentLabel) percentLabel.textContent = '0%';
      if (progressBar) progressBar.style.width = '0%';
      if (bytesLabel) bytesLabel.textContent = `0 MB / ${targetSize}`;
      if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.textContent = status.state === 'runtime_missing' && status.exists
          ? 'Cài bộ công cụ'
          : 'Cài đặt và tải';
        actionBtn.style.display = '';
        actionBtn.onclick = startWhisperDownload;
      }
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Đóng';
        cancelBtn.style.background = '';
        cancelBtn.style.color = '';
        cancelBtn.style.display = '';
        cancelBtn.onclick = closeWhisperDownloadModal;
      }
      if (closeBtn) closeBtn.style.display = 'block';
    }
  }
}

function startWhisperDownload() {
  ensureFasterWhisperReady({ openModal: true }).catch(err => {
    toast('❌ Không chuẩn bị được Faster-Whisper: ' + err.message, 'error');
  });
}

async function ensureFasterWhisperReady({ openModal = false } = {}) {
  if (whisperEnsurePromise) return whisperEnsurePromise;
  whisperEnsurePromise = (async () => {
    let response = await fetch('/api/whisper-model/status');
    let status = await response.json();
    if (!response.ok) throw new Error(status.error || 'Không kiểm tra được Faster-Whisper.');
    if (status.ready) return true;
    if (openModal) openWhisperDownloadModal();

    response = await fetch('/api/download-whisper-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: FASTER_WHISPER_MODEL_ID })
    });
    const start = await response.json();
    if (!response.ok) throw new Error(start.error || 'Không bắt đầu được quá trình cài Faster-Whisper.');
    toast('Đang chuẩn bị runtime và model Faster-Whisper. Chỉ cần thực hiện một lần.', 'info');

    for (let attempt = 0; attempt < 2400; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      response = await fetch('/api/whisper-model/status');
      status = await response.json();
      if (!response.ok) throw new Error(status.error || 'Không đọc được tiến trình Faster-Whisper.');
      updateWhisperDownloadUI(status);
      if ($('render-status') && status.message) $('render-status').textContent = status.message;
      if (status.ready) {
        toast('Faster-Whisper Large V3 Turbo đã sẵn sàng.', 'success');
        checkWhisperModelStatus();
        checkWhisperDeviceStatus();
        return true;
      }
      if (!status.downloading && status.error) throw new Error(status.error);
    }
    throw new Error('Cài Faster-Whisper quá thời gian chờ.');
  })();
  try {
    return await whisperEnsurePromise;
  } finally {
    whisperEnsurePromise = null;
  }
}
window.ensureFasterWhisperReady = ensureFasterWhisperReady;

function startWhisperStatusPolling() {
  if (whisperDownloadInterval) clearInterval(whisperDownloadInterval);
  
  whisperDownloadInterval = setInterval(() => {
    fetch('/api/whisper-model/status')
      .then(res => res.json())
      .then(status => {
        updateWhisperDownloadUI(status);
        if (!status.downloading) {
          clearInterval(whisperDownloadInterval);
          if (status.ready) {
            toast(`🎉 Tải ${FASTER_WHISPER_MODEL_LABEL} thành công!`, 'success');
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

function updateWhisperRuntimeUi(status = {}) {
  const label = $('whisper-runtime-status');
  const button = $('whisper-runtime-install-btn');
  if (!label || !button) return;

  if (status.ready) {
    label.textContent = 'Faster Whisper đã sẵn sàng';
    button.textContent = 'Đã sẵn sàng';
    button.disabled = true;
    return;
  }
  if (status.downloading || status.status === 'installing') {
    const percent = Math.max(0, Math.round(Number(status.percent) || 0));
    label.textContent = status.message || `Đang cài Faster Whisper ${percent}%…`;
    button.textContent = `Đang tải ${percent}%`;
    button.disabled = true;
    return;
  }
  if (status.error || status.status === 'error') {
    label.textContent = status.error || status.message || 'Faster Whisper đang gặp lỗi';
    button.textContent = 'Thử sửa';
    button.disabled = false;
    return;
  }

  const runtimeMissing = status.state === 'runtime_missing';
  const corrupt = status.state === 'corrupt';
  label.textContent = corrupt
    ? 'Model Whisper bị lỗi'
    : runtimeMissing && status.exists
      ? 'Thiếu runtime Faster Whisper'
      : 'Chưa cài Faster Whisper';
  button.textContent = corrupt || (runtimeMissing && status.exists) ? 'Cài/sửa Whisper' : 'Tải Whisper';
  button.disabled = false;
}

async function checkWhisperModelStatus() {
  const modelSelect = $('whisper-model-select');
  if (!modelSelect) return;
  const statusLabel = $('whisper-model-status');
  const downloadBtn = $('whisper-model-download-btn');
  const runtimeDetail = $('whisper-runtime-detail');

  try {
    const res = await fetch('/api/whisper-model/status');
    if (!res.ok) throw new Error('Không thể kiểm tra trạng thái model');
    const status = await res.json();
    updateWhisperRuntimeUi(status);
    if (runtimeDetail) {
      runtimeDetail.textContent = status.runtime?.ready
        ? 'Runtime hệ thống: sẵn sàng · Model: Large V3 Turbo'
        : status.exists
          ? 'Model đã có · Thiếu runtime Python/Faster-Whisper'
          : 'Thiếu runtime và model; nút Cài đặt sẽ tự chuẩn bị cả hai.';
    }
    
    if (status.ready) {
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
        startWhisperStatusPolling();
      } else {
        if (statusLabel) {
          statusLabel.textContent = status.state === 'runtime_missing'
            ? (status.exists ? 'Thiếu runtime hệ thống' : 'Thiếu runtime và model')
            : status.state === 'corrupt' ? 'Model bị lỗi — cần sửa' : 'Chưa tải';
          statusLabel.style.color = status.state === 'corrupt' ? '#FF3B30' : '#FFA500';
        }
        if (downloadBtn) {
          downloadBtn.style.display = 'inline-block';
          downloadBtn.textContent = status.state === 'corrupt' ? '🛠 Sửa model' : '📥 Cài đặt';
          downloadBtn.disabled = false;
        }
      }
    }
  } catch (error) {
    console.error('Lỗi checkWhisperModelStatus:', error);
    updateWhisperRuntimeUi({ status: 'error', error: error.message });
    if (statusLabel) {
      statusLabel.textContent = 'Lỗi kết nối';
      statusLabel.style.color = '#FF3B30';
    }
  }
}

let whisperGpuInstallPromise = null;

function updateWhisperGpuUi(status = {}) {
  const select = $('whisper-device-select');
  const cudaOption = select?.querySelector('option[value="cuda"]');
  const hint = $('whisper-device-hint');
  const label = $('whisper-gpu-status');
  const button = $('whisper-gpu-install-btn');
  const hybridFill = $('whisper-hybrid-fill');
  const ready = status.gpuReady === true && status.actualInference === true;
  const unsupported = status.supported === false;
  if (cudaOption) cudaOption.disabled = !ready;
  if (select?.value === 'cuda' && !ready) select.value = 'auto';
  if (label) label.textContent = status.message || (ready
    ? 'Large V3 Turbo CUDA đã chạy thật'
    : 'Whisper đang dùng CPU; có thể cài tăng tốc GPU.');
  if (hint) hint.textContent = ready
    ? `${status.gpuName || 'NVIDIA GPU'} · CUDA int8_float16 đã được xác minh bằng inference thật.`
    : 'Tự động sẽ dùng CPU int8 cho đến khi kiểm thử CUDA thành công.';
  if (hybridFill) {
    hybridFill.disabled = !ready;
    if (!ready) hybridFill.checked = false;
    hybridFill.title = ready
      ? 'Chỉ chạy Whisper khi RapidOCR có khoảng trống lớn bất thường.'
      : 'Cần xác minh Faster Whisper CUDA trước khi bật bù OCR.';
  }
  if (button) {
    button.disabled = status.installing || status.runtimeReady === false || status.modelReady === false || unsupported;
    button.textContent = status.installing
      ? `Đang cài ${Math.round(Number(status.percent) || 0)}%`
      : ready ? 'Kiểm tra lại'
        : unsupported ? (status.reason === 'driver_too_old' ? 'Driver quá cũ' : 'GPU không hỗ trợ')
          : status.runtimeReady === false || status.modelReady === false
            ? 'Cài Whisper trước' : 'Cài/sửa GPU';
  }
}

async function checkWhisperDeviceStatus() {
  try {
    const response = await fetch('/api/whisper-gpu/status');
    const status = await response.json();
    if (!response.ok) throw new Error(status.error || 'Không thể kiểm tra Whisper GPU');
    updateWhisperGpuUi(status);
    return status;
  } catch (error) {
    updateWhisperGpuUi({ status: 'error', message: error.message, gpuReady: false });
    return null;
  }
}

async function installWhisperGpu() {
  if (whisperGpuInstallPromise) return whisperGpuInstallPromise;
  whisperGpuInstallPromise = (async () => {
    const response = await fetch('/api/whisper-gpu/install', { method: 'POST' });
    const started = await response.json();
    if (!response.ok) throw new Error(started.error || 'Không bắt đầu được cài Whisper GPU.');
    updateWhisperGpuUi(started);
    toast('Đang cài/sửa CUDA cho Whisper. CPU vẫn được giữ làm đường dự phòng.', 'info');
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const poll = await fetch('/api/whisper-gpu/status');
      const status = await poll.json();
      if (!poll.ok) throw new Error(status.error || 'Không đọc được tiến trình Whisper GPU.');
      updateWhisperGpuUi(status);
      if (!status.installing) {
        if (status.gpuReady && status.actualInference) {
          toast('Whisper GPU đã sẵn sàng và Large V3 Turbo đã chạy CUDA thật.', 'success');
          return status;
        }
        if (status.status === 'error') throw new Error(status.error || status.message || 'Cài Whisper GPU thất bại.');
        toast(status.message || 'Không bật được GPU; Whisper tiếp tục chạy CPU.', 'warn');
        return status;
      }
    }
    throw new Error('Cài Whisper GPU quá thời gian chờ.');
  })();
  try {
    return await whisperGpuInstallPromise;
  } finally {
    whisperGpuInstallPromise = null;
  }
}

$('whisper-gpu-install-btn')?.addEventListener('click', () => {
  installWhisperGpu().catch(error => toast(error.message, 'error'));
});

$('whisper-runtime-install-btn')?.addEventListener('click', () => {
  ensureFasterWhisperReady({ openModal: true })
    .then(async () => {
      await checkWhisperModelStatus();
      await checkWhisperDeviceStatus();
    })
    .catch(error => {
      updateWhisperRuntimeUi({ status: 'error', error: error.message });
      toast(error.message, 'error');
    });
});

checkWhisperDeviceStatus();

// Global state for download configuration modal callback
let currentDlConfirmCallback = null;

function openDownloadTranslateModal(videoTitle, thumbnailUrl, onConfirm, formats = [], previewVideoUrl = null) {
  currentDlConfirmCallback = onConfirm;

  const previewFrame = document.querySelector('.dl-preview-frame');
  if (previewFrame) {
    previewFrame.style.aspectRatio = '16/9';
    previewFrame.style.height = '';
    previewFrame.style.width = '100%';
  }

  const titleEl = document.getElementById('dl-preview-video-title');
  if (titleEl) titleEl.textContent = videoTitle || 'Đang tải video...';

  const thumbEl = document.getElementById('dl-preview-thumbnail');
  const videoEl = document.getElementById('dl-preview-video');

  if (previewVideoUrl) {
    if (videoEl) {
      videoEl.src = previewVideoUrl;
      videoEl.load();
      videoEl.classList.remove('hidden');
      videoEl.play().catch(e => {
        console.warn('Không thể tự động phát video xem trước:', e);
      });
    }
    if (thumbEl) thumbEl.classList.add('hidden');
  } else {
    if (videoEl) {
      videoEl.src = '';
      videoEl.classList.add('hidden');
    }
    if (thumbEl) {
      thumbEl.src = thumbnailUrl || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='%23111'/></svg>";
      thumbEl.classList.remove('hidden');
    }
  }

  // Populate output video quality dropdown
  const qualitySelect = document.getElementById('dl-video-quality');
  if (qualitySelect) {
    qualitySelect.innerHTML = '';
    
    const defaultOpt = document.createElement('option');
    defaultOpt.value = 'vietsub';
    defaultOpt.textContent = 'Tải bản chất lượng tốt nhất tự động (Mặc định)';
    qualitySelect.appendChild(defaultOpt);

    if (previewVideoUrl) {
      const fastOpt = document.createElement('option');
      fastOpt.value = 'temp_preview';
      fastOpt.textContent = '⚡ Sử dụng video xem trước sẵn có (Không tải lại - Rất nhanh)';
      qualitySelect.appendChild(fastOpt);
    }

    if (formats && formats.length > 0) {
      formats.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.format_id;
        opt.textContent = `${f.quality} · ${f.size}`;
        qualitySelect.appendChild(opt);
      });
    }
  }

  // Load defaults from localStorage
  const provider = localStorage.getItem('global_ai_provider') || 'nllb';
  const targetLang = localStorage.getItem('global_target_lang') || 'vi';
  
  // Use default subtitle values from active config inputs, or sensible defaults
  const size = document.querySelector('input[name="subtitleSize"]')?.value || '18';
  const marginV = '20';
  const marginH = document.querySelector('input[name="subtitleMarginH"]')?.value || '20';
  const maxLines = document.querySelector('[name="subtitleMaxLines"]')?.value || '0';

  // Set inputs
  const providerSelect = document.getElementById('dl-ai-provider');
  if (providerSelect) providerSelect.value = provider;

  const targetLangSelect = document.getElementById('dl-target-lang');
  if (targetLangSelect) targetLangSelect.value = targetLang;

  const maxLinesSelect = document.getElementById('dl-subtitle-max-lines');
  if (maxLinesSelect) maxLinesSelect.value = maxLines;

  const sizeSlider = document.getElementById('dl-subtitle-size-slider');
  if (sizeSlider) sizeSlider.value = size;

  const marginVSlider = document.getElementById('dl-subtitle-margin-v-slider');
  if (marginVSlider) marginVSlider.value = marginV;

  const marginHSlider = document.getElementById('dl-subtitle-margin-h-slider');
  if (marginHSlider) marginHSlider.value = marginH;

  // Render provider fields (API keys, models)
  onDlAiProviderChange();

  // Show modal
  const modal = document.getElementById('download-translate-modal');
  if (modal) modal.classList.remove('hidden');

  // Trigger preview update
  updateLiveSubPreview();
}

function closeDownloadTranslateModal() {
  const modal = document.getElementById('download-translate-modal');
  if (modal) modal.classList.add('hidden');
  currentDlConfirmCallback = null;
}

function isValidModelSelect(globalSelect) {
  if (!globalSelect || globalSelect.options.length === 0) return false;
  const firstOpt = globalSelect.options[0];
  const val = (firstOpt.value || '').trim();
  const text = (firstOpt.textContent || '').toLowerCase();
  if (!val && (text.includes('đang') || text.includes('vui lòng') || text.includes('lỗi') || text.includes('không'))) {
    return false;
  }
  return true;
}

// AI Provider select handling
function onDlAiProviderChange() {
  const provider = document.getElementById('dl-ai-provider').value;
  const modelRow = document.getElementById('dl-model-settings-row');
  const modelSelect = document.getElementById('dl-ai-model');
  const keyInput = document.getElementById('dl-ai-key');

  if (provider === 'google-translate' || provider === 'nllb') {
    modelRow.classList.add('hidden');
    return;
  }

  modelRow.classList.remove('hidden');
  modelSelect.innerHTML = '';

  if (provider === 'gemini') {
    keyInput.value = localStorage.getItem('global_gemini_key') || '';
    keyInput.placeholder = 'Nhập Gemini API Key...';
    
    const globalSelect = document.getElementById('global-gemini-model');
    if (isValidModelSelect(globalSelect)) {
      for (let i = 0; i < globalSelect.options.length; i++) {
        const opt = globalSelect.options[i];
        const newOpt = document.createElement('option');
        newOpt.value = opt.value;
        newOpt.textContent = opt.textContent;
        modelSelect.appendChild(newOpt);
      }
      modelSelect.value = localStorage.getItem('global_gemini_model') || '';
    } else {
      const geminiModels = [
        { value: 'models/gemini-2.5-flash', label: 'gemini-2.5-flash' },
        { value: 'models/gemini-1.5-flash', label: 'gemini-1.5-flash' },
        { value: 'models/gemini-1.5-pro', label: 'gemini-1.5-pro' }
      ];
      geminiModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      });
      const savedModel = localStorage.getItem('global_gemini_model') || 'models/gemini-2.5-flash';
      modelSelect.value = savedModel.startsWith('models/') ? savedModel : 'models/' + savedModel;
    }

  } else if (provider === 'openrouter') {
    keyInput.value = localStorage.getItem('global_openrouter_key') || '';
    keyInput.placeholder = 'Nhập OpenRouter API Key...';
    
    const globalSelect = document.getElementById('global-openrouter-model');
    if (isValidModelSelect(globalSelect)) {
      for (let i = 0; i < globalSelect.options.length; i++) {
        const opt = globalSelect.options[i];
        const newOpt = document.createElement('option');
        newOpt.value = opt.value;
        newOpt.textContent = opt.textContent;
        modelSelect.appendChild(newOpt);
      }
      modelSelect.value = localStorage.getItem('global_openrouter_model') || 'openrouter/owl-alpha';
    } else {
      const orModels = [
        { value: 'openrouter/owl-alpha', label: 'Owl Alpha (Chuyên dịch)' },
        { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { value: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' },
        { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' }
      ];
      orModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      });
      modelSelect.value = localStorage.getItem('global_openrouter_model') || 'openrouter/owl-alpha';
    }

  } else if (provider === '9router') {
    keyInput.value = localStorage.getItem('global_ninerouter_key') || '';
    keyInput.placeholder = 'Nhập 9Router API Key (nếu có)...';
    
    const globalSelect = document.getElementById('global-ninerouter-model');
    if (isValidModelSelect(globalSelect)) {
      for (let i = 0; i < globalSelect.options.length; i++) {
        const opt = globalSelect.options[i];
        const newOpt = document.createElement('option');
        newOpt.value = opt.value;
        newOpt.textContent = opt.textContent;
        modelSelect.appendChild(newOpt);
      }
      modelSelect.value = localStorage.getItem('global_ninerouter_model') || 'google/gemini-1.5-flash';
    } else {
      const nineModels = [
        { value: 'google/gemini-1.5-flash', label: 'Gemini 1.5 Flash (Proxy)' },
        { value: 'meta-llama/llama-3-8b-instruct', label: 'Llama 3 8B (Proxy)' },
        { value: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B (Proxy)' },
        { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat (Proxy)' }
      ];
      nineModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      });
      modelSelect.value = localStorage.getItem('global_ninerouter_model') || 'google/gemini-1.5-flash';
    }
  }
}

// Live update subtitle text design
function updateLiveSubPreview() {
  const size = document.getElementById('dl-subtitle-size-slider').value;
  const marginV = document.getElementById('dl-subtitle-margin-v-slider').value;
  const marginH = document.getElementById('dl-subtitle-margin-h-slider').value;
  const maxLines = document.getElementById('dl-subtitle-max-lines').value;

  // Update labels
  document.getElementById('dl-subtitle-size-val').textContent = size + 'px';
  document.getElementById('dl-subtitle-margin-v-val').textContent = marginV + 'px';
  document.getElementById('dl-subtitle-margin-h-val').textContent = marginH + 'px';

  // Apply to preview elements
  const subBox = document.getElementById('dl-preview-sub-box');
  const subText = document.getElementById('dl-preview-sub-text');

  if (subBox && subText) {
    subText.style.fontSize = Math.round(Number(size) * 0.7) + 'px'; // Scale preview font size a bit to fit simulated frame
    subBox.style.bottom = Math.round(Number(marginV) * 0.5) + 'px'; // Scale vertical margin slightly too
    subBox.style.width = `calc(100% - ${Math.round(Number(marginH) * 0.5) * 2}px)`;

    if (maxLines === '1') {
      subText.textContent = "Đây là dòng phụ đề Vietsub mẫu tối đa 1 dòng.";
    } else if (maxLines === '2') {
      subText.textContent = "Đây là dòng phụ đề Vietsub mẫu\nchia thành tối đa 2 dòng hiển thị.";
    } else {
      subText.textContent = "Đây là dòng phụ đề Vietsub mẫu sẽ hiển thị trên video của bạn, tự động ngắt dòng thông minh khi câu thoại dài hơn.";
    }
  }
}

// Bind click event for confirmation button
document.addEventListener('DOMContentLoaded', () => {
  const dlConfirmBtn = document.getElementById('dl-confirm-btn');
  if (dlConfirmBtn) {
    dlConfirmBtn.onclick = function() {
      if (currentDlConfirmCallback) {
        const aiProvider = document.getElementById('dl-ai-provider').value;
        const targetLang = document.getElementById('dl-target-lang').value;
        const subtitleSize = document.getElementById('dl-subtitle-size-slider').value;
        const subtitleMarginH = document.getElementById('dl-subtitle-margin-h-slider').value;
        const subtitleMarginV = document.getElementById('dl-subtitle-margin-v-slider').value;
        const subtitleMaxLines = document.getElementById('dl-subtitle-max-lines').value;
        
        let model = '';
        let apiKey = '';
        const modelSelect = document.getElementById('dl-ai-model');
        const keyInput = document.getElementById('dl-ai-key');
        if (modelSelect && !document.getElementById('dl-model-settings-row').classList.contains('hidden')) {
          model = modelSelect.value;
          apiKey = keyInput.value;
        }

        const formatSelect = document.getElementById('dl-video-quality');
        const formatId = formatSelect ? formatSelect.value : 'vietsub';
        const useExistingPreview = (formatId === 'temp_preview');

        currentDlConfirmCallback({
          aiProvider,
          targetLang,
          subtitleSize,
          subtitleMarginH,
          subtitleMarginV,
          subtitleMaxLines,
          model,
          apiKey,
          formatId,
          useExistingPreview
        });
      }
      closeDownloadTranslateModal();
    };
  }

  // Auto aspect ratio for vertical video preview
  const previewVideo = document.getElementById('dl-preview-video');
  if (previewVideo) {
    previewVideo.addEventListener('loadedmetadata', () => {
      const width = previewVideo.videoWidth;
      const height = previewVideo.videoHeight;
      if (width && height) {
        const ratio = width / height;
        const previewFrame = document.querySelector('.dl-preview-frame');
        if (previewFrame) {
          if (ratio < 1) {
            // Vertical video (9:16)
            previewFrame.style.aspectRatio = '9/16';
            previewFrame.style.height = '280px';
            previewFrame.style.width = 'auto';
          } else {
            // Horizontal video (16:9)
            previewFrame.style.aspectRatio = '16/9';
            previewFrame.style.height = 'auto';
            previewFrame.style.width = '100%';
          }
          // Recalculate subtitle preview scaling since width changed
          updateLiveSubPreview();
        }
      }
    });
  }
});

// Expose functions globally
window.openDownloadTranslateModal = openDownloadTranslateModal;
window.closeDownloadTranslateModal = closeDownloadTranslateModal;
window.onDlAiProviderChange = onDlAiProviderChange;
window.updateLiveSubPreview = updateLiveSubPreview;

