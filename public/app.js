// [Refactored] Các hàm thuần (sliderToVolume, volumeToSlider, isValidVideoUrl, formatDuration, formatTime) đã chuyển sang public/js/ui-utils.js
function toast(message, type = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3600);
}

document.addEventListener('click', function (e) {
  const modal = document.getElementById('cookie-modal');
  if (modal && !modal.classList.contains('hidden') && e.target === modal) {
    closeCookieModal();
  }
});
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

let pendingSwitchViewName = null;
let studioAssetsReady = false;
let studioVideoRefreshPromise = null;

function closeSaveProjectConfirmModal() {
  const modal = $('save-project-confirm-modal');
  if (modal) modal.classList.add('hidden');
  pendingSwitchViewName = null;
}

async function proceedWithSaveAndSwitch() {
  const modal = $('save-project-confirm-modal');
  if (modal) modal.classList.add('hidden');

  if (pendingSwitchViewName) {
    const hasVideo = $('selected-video-file')?.value || $('video-upload')?.files.length;
    if (hasVideo) {
      await saveProjectExplicitly();
    }
    // Perform the actual view switch bypassing the check
    executeSwitchView(pendingSwitchViewName);
    pendingSwitchViewName = null;
  }
}

// Add event listener for the confirm button
document.addEventListener('DOMContentLoaded', () => {
  const confirmBtn = $('confirm-save-project-btn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', proceedWithSaveAndSwitch);
  }
});

function switchView(name) {
  stopAllAudio();

  const isStudioViewActive = $('view-studio') && $('view-studio').classList.contains('active');
  const editorView = $('studio-editor-view');
  if (isStudioViewActive && editorView && !editorView.classList.contains('hidden') && currentProjectId) {
    const hasVideo = $('selected-video-file')?.value || $('video-upload')?.files.length;
    if (hasVideo) {
      pendingSwitchViewName = name;
      const modal = $('save-project-confirm-modal');
      if (modal) {
        modal.classList.remove('hidden');
        return; // Dừng việc chuyển tab, chờ người dùng xác nhận
      }
    }
  }

  executeSwitchView(name);
}

function executeSwitchView(name) {
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
  } else if (name === 'crawl-history') {
    crawlLoadHistory();
  } else if (name === 'studio') {
    refreshStudioVideoAssets().catch((error) => {
      console.error('Không cập nhật được Video nguồn:', error);
    });
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
    if (tab === 'preview') {
      refreshStudioPreviewLayout();
    }
  });
});

function refreshStudioPreviewLayout() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (typeof updateBlurBoxPreview === 'function') {
        updateBlurBoxPreview();
      }
      if (typeof renderTimeline === 'function') {
        renderTimeline();
      }
      if (typeof syncPlayhead === 'function') {
        syncPlayhead();
      }
    });
  });
}

// Setup bottom configuration tabs switcher
document.querySelectorAll('.config-tab-icon-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabButtons = Array.from(document.querySelectorAll('.config-tab-icon-btn'));
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const targetPanelId = btn.dataset.target;

    const panelIds = [...new Set(tabButtons.map(button => button.dataset.target).filter(Boolean))];
    panelIds.forEach(id => {
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
  const prevValue = select.value;
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
  if (prevValue) select.value = prevValue;
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

function populateOutputLanguageOptions(languages = []) {
  const select = $('global-output-lang');
  if (!select || !Array.isArray(languages) || languages.length === 0) return;
  const previous = select.value || 'vi';
  select.innerHTML = '';
  for (const language of languages) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.label || language.promptName || language.code.toUpperCase();
    select.appendChild(option);
  }
  select.value = languages.some((language) => language.code === previous) ? previous : 'vi';
  updateOutputLangInfo();
}

function refreshTtsVoiceCatalogs(voiceEngines = []) {
  const targetLang = ($('global-output-lang')?.value || 'vi').toLowerCase().split('-')[0];
  const fillEngineVoiceSelect = (selectId, engineId) => {
    const select = $(selectId);
    const descriptor = voiceEngines.find((engine) => engine.id === engineId);
    const voices = (descriptor?.capabilities?.voices || []).filter((voice) => voice.lang === targetLang);
    if (!select) return;
    if (voices.length === 0) {
      select.innerHTML = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = `${descriptor?.name || engineId} chưa hỗ trợ — sẽ dùng Edge TTS`;
      select.appendChild(option);
      return;
    }
    const previous = select.value;
    select.innerHTML = '';
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.name || voice.id;
      select.appendChild(option);
    }
    select.value = voices.some((voice) => voice.id === previous) ? previous : voices[0].id;
  };
  fillEngineVoiceSelect('edge-voice-select', 'edge-tts');
  fillEngineVoiceSelect('piper-voice-select', 'piper');

  const fillGenderSelect = (name, engineId, gender) => {
    const select = document.querySelector(`select[name="${name}"]`);
    const descriptor = voiceEngines.find((engine) => engine.id === engineId);
    const voices = (descriptor?.capabilities?.voices || []).filter(
      (voice) => voice.lang === targetLang && voice.gender === gender
    );
    if (!select) return;
    if (voices.length === 0) {
      select.innerHTML = '<option value="">Sẽ dùng Edge TTS</option>';
      return;
    }
    const previous = select.value;
    select.innerHTML = '';
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${gender === 'male' ? 'Nam' : 'Nữ'}: ${voice.name || voice.id}`;
      select.appendChild(option);
    }
    select.value = voices.some((voice) => voice.id === previous) ? previous : voices[0].id;
  };
  fillGenderSelect('piperMaleVoice', 'piper', 'male');
  fillGenderSelect('piperFemaleVoice', 'piper', 'female');
  fillGenderSelect('edgeMaleVoice', 'edge-tts', 'male');
  fillGenderSelect('edgeFemaleVoice', 'edge-tts', 'female');
}

function renderVoiceEngineOptions(voiceEngines = [], defaultEngineId = 'current-omnivoice') {
  const select = $('voice-engine-select');
  const capabilityText = $('voice-engine-capabilities');
  if (!select) return;
  const previousValue = select.value || defaultEngineId;
  select.innerHTML = '';

  for (const engine of voiceEngines) {
    const option = document.createElement('option');
    option.value = engine.id;
    option.textContent = engine.id === 'current-omnivoice'
      ? 'OmniVoice Clone'
      : engine.name;
    option.disabled = engine.status?.ready !== true;
    if (!engine.status?.ready) option.textContent += ' (chưa sẵn sàng)';
    select.appendChild(option);
  }

  const fallbackEngineId = voiceEngines.some(
    (engine) => engine.id === defaultEngineId && engine.status?.ready
  )
    ? defaultEngineId
    : (voiceEngines.find((engine) => engine.status?.ready)?.id || defaultEngineId);
  const preferred = voiceEngines.some((engine) => engine.id === previousValue && engine.status?.ready)
    ? previousValue
    : fallbackEngineId;
  select.value = preferred;
  refreshTtsVoiceCatalogs(voiceEngines);

  const targetLanguageSelect = $('global-output-lang');
  if (targetLanguageSelect && targetLanguageSelect.dataset.voiceCatalogBound !== 'true') {
    targetLanguageSelect.dataset.voiceCatalogBound = 'true';
    targetLanguageSelect.addEventListener('change', () => refreshTtsVoiceCatalogs(assets.voiceEngines || voiceEngines));
  }

  const updateDescription = () => {
    const engine = voiceEngines.find((item) => item.id === select.value);
    if (!engine || !capabilityText) return;
    const capabilities = engine.capabilities || {};

    if (engine.status?.ready !== true) {
      capabilityText.innerHTML = `
        <div class="engine-badge-list">
          <span class="engine-badge badge-error">❌ ${escapeHtml(engine.status?.error || 'Engine chưa sẵn sàng')}</span>
        </div>`;
    } else {
      const badges = [];
      if (engine.id === 'current-omnivoice') {
        badges.push('<span class="engine-badge badge-cyan">🎙️ Clone giọng AI</span>');
        badges.push('<span class="engine-badge badge-blue">🌍 70+ ngôn ngữ</span>');
        badges.push('<span class="engine-badge badge-purple">⚡ CUDA • Vulkan • CPU</span>');
        badges.push('<span class="engine-badge badge-slate">🎧 24 kHz GGUF</span>');
      } else if (engine.id === 'piper') {
        badges.push('<span class="engine-badge badge-green">⚡ Offline 100% (Siêu nhanh)</span>');
        badges.push('<span class="engine-badge badge-blue">🇻🇳 16 giọng Việt + Quốc tế</span>');
        const provider = engine.status?.providers?.includes('CUDAExecutionProvider') ? 'CUDA GPU' : 'CPU';
        badges.push(`<span class="engine-badge badge-purple">💻 Provider: ${provider}</span>`);
        badges.push('<span class="engine-badge badge-slate">🎧 22.05 kHz</span>');
      } else if (engine.id === 'edge-tts') {
        badges.push('<span class="engine-badge badge-blue">☁️ Microsoft Cloud</span>');
        badges.push('<span class="engine-badge badge-cyan">🌍 70+ ngôn ngữ Neural</span>');
        badges.push('<span class="engine-badge badge-amber">🌐 Cần Internet</span>');
        badges.push('<span class="engine-badge badge-slate">🎧 24 kHz HQ</span>');
      } else {
        if (capabilities.cloneVoice) badges.push('<span class="engine-badge badge-cyan">🎙️ Clone giọng</span>');
        const langCount = capabilities.languages?.length || 0;
        if (langCount > 10) badges.push(`<span class="engine-badge badge-blue">🌍 ${langCount} ngôn ngữ</span>`);
        else if (langCount > 0) badges.push('<span class="engine-badge badge-blue">🌍 Đa ngôn ngữ</span>');
        if (engine.status?.requiresInternet) badges.push('<span class="engine-badge badge-amber">🌐 Cần Internet</span>');
        else badges.push('<span class="engine-badge badge-green">⚡ Offline</span>');
        if (capabilities.sampleRate) badges.push(`<span class="engine-badge badge-slate">🎧 ${Math.round(capabilities.sampleRate / 1000)} kHz</span>`);
      }
      capabilityText.innerHTML = `<div class="engine-badge-list">${badges.join('')}</div>`;
    }

    const runtimeInstallButton = $('voice-runtime-install-btn');
    const piperDescriptor = voiceEngines.find((item) => item.id === 'piper');
    if (runtimeInstallButton) {
      runtimeInstallButton.classList.toggle('hidden', piperDescriptor?.status?.ready === true);
    }

    const edgeVoiceGroup = $('edge-voice-group');
    const isEdge = select.value === 'edge-tts';
    const isPiper = select.value === 'piper';
    if (edgeVoiceGroup) {
      edgeVoiceGroup.style.display = isEdge ? 'block' : 'none';
    }
    const piperVoiceGroup = $('piper-voice-group');
    if (piperVoiceGroup) piperVoiceGroup.style.display = isPiper ? 'block' : 'none';
    const dualVoiceGroup = $('dual-voice-group');
    if (dualVoiceGroup) dualVoiceGroup.style.display = isEdge || isPiper ? 'block' : 'none';
    const piperDualVoices = $('piper-dual-voices');
    if (piperDualVoices) piperDualVoices.style.display = isPiper ? 'grid' : 'none';
    const edgeDualVoices = $('edge-dual-voices');
    if (edgeDualVoices) edgeDualVoices.style.display = isEdge ? 'grid' : 'none';
    $('voice-device-group')?.classList.toggle('hidden', isEdge || isPiper);
    $('voice-cpu-fallback-group')?.classList.toggle('hidden', isEdge || isPiper);
    if (typeof updateClonerEngineUi === 'function') updateClonerEngineUi();
    if (typeof updateConditionalFields === 'function') updateConditionalFields();
  };

  select.onchange = updateDescription;
  updateDescription();

  const clonerSelect = $('cloner-voice-engine-select');
  if (clonerSelect) {
    const previousClonerValue = clonerSelect.value || preferred;
    clonerSelect.innerHTML = select.innerHTML;
    clonerSelect.value = voiceEngines.some(
      (engine) => engine.id === previousClonerValue && engine.status?.ready
    ) ? previousClonerValue : preferred;
  }
}

async function loadAssets() {
  try {
    await checkLocalDependencies();
  } catch (e) {
    console.error('Lỗi check local dependencies:', e);
  }
  // Mở modal thiết lập nếu thiếu Faster-Whisper hoặc MDX ONNX Separator (chỉ 1 lần)
  if (!window._setupModalShown && (!dependencyStatus.whisper || !dependencyStatus.separator)) {
    window._setupModalShown = true;
    setTimeout(() => openSetupModal(), 500);
  }
  const res = await fetch('/api/studio-assets');
  assets = await res.json();
  populateOutputLanguageOptions(assets.outputLanguages || []);
  applyStudioVideoAssets(assets.videos);
  fillSelect('saved-voice-select', assets.voices, 'Chọn giọng đã lưu');
  renderQuickVoices();
  fillSelect('saved-music-select', assets.music, 'Chọn nhạc đã lưu');
  renderQuickMusic();
  fillSelect('saved-logo-select', assets.logos || [], '-- Chọn logo --');
  updateLogoUi();
  fillSelect('saved-subtitle-select', assets.subtitles, 'Chọn sub đã lưu');
  renderAssetList('asset-voices', assets.voices);
  renderAssetList('asset-music', assets.music);
  renderAssetList('asset-subtitles', assets.subtitles);
  renderVoiceEngineOptions(assets.voiceEngines || [], assets.defaultVoiceEngineId);
  await refreshPiperRuntimeStatusForUi();
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
  studioAssetsReady = true;
  reapplyPendingRenderUiSnapshot();

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

  // === DOUYIN: dùng extractor BrowserWindow ẩn (không cần yt-dlp/cookies) ===
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) {
    return fetchDouyinInfo(url, $('fetch-btn'), $('video-card-loading'), finalExtractedTitle);
  }

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

async function fetchDouyinInfo(url, btn, loadingIndicator, extractedTitle) {
  setBusy(btn, true, 'Đang mở Douyin...');
  $('video-card').classList.add('hidden');
  if (loadingIndicator) loadingIndicator.classList.remove('hidden');
  try {
    const res = await fetch('/api/douyin-info?url=' + encodeURIComponent(url));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không lấy được thông tin Douyin');
    const title = extractedTitle || data.title || 'Douyin Video';
    currentUrl = url;
    $('video-thumbnail').src = data.thumbnail || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="124"><rect width="220" height="124" fill="%23161c24"/><text x="50%" y="50%" text-anchor="middle" font-size="14" fill="%23555">Douyin</text></svg>';
    $('video-title').textContent = title;
    $('video-meta').textContent = (data.author || 'Douyin') + (data.duration ? ' · ' + formatDuration(data.duration) : '');
    const fnInput = $('video-filename-input');
    if (fnInput) fnInput.value = title.replace(/[<>:\"/\\|?*]/g, '_').substring(0, 100);
    const grid = $('quality-grid');
    grid.innerHTML = '';
    if (!data.formats || data.formats.length === 0) {
      const msg = document.createElement('div');
      msg.style = 'color: var(--muted); font-size: 13px; padding: 10px; text-align: center; width: 100%;';
      msg.textContent = '⚠️ Không tìm thấy chất lượng. Video có thể cần đăng nhập.';
      grid.appendChild(msg);
    } else {
      for (const fmt of data.formats) {
        const b = document.createElement('button');
        b.className = 'quality-btn'; b.type = 'button'; b.dataset.src = fmt.src;
        b.onclick = (e) => startDouyinDownload(e.currentTarget, fmt.src, title, fmt.label);
        b.textContent = fmt.label + (fmt.sizeMB ? ' · ' + fmt.sizeMB + ' MB' : '');
        grid.appendChild(b);
      }
    }
    $('video-card').classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
    if (loadingIndicator) loadingIndicator.classList.add('hidden');
  }
}

async function startDouyinDownload(btn, cdnUrl, videoTitle, qualityLabel) {
  if (btn.disabled) return;

  const defaultName = encodeURIComponent(($('video-filename-input')?.value.trim() || videoTitle) + '.mp4');
  const saveRes = await fetch('/api/select-save-path?defaultFilename=' + defaultName);
  const saveData = await saveRes.json();
  if (saveData.canceled) return;
  const outputDir = saveData.dir;
  const customFilename = saveData.filename.replace(/\.mp4$/i, '');

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Đang tải...';
  try {
    const res = await fetch('/api/douyin-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: cdnUrl, filename: customFilename, outputDir })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi tải Douyin');
    const savedFilename = data.filename || (customFilename + '.mp4');
    toast(`Tải thành công: ${outputDir}\\${savedFilename}`, 'success');
    addDownloadHistory(videoTitle, '', 'success', savedFilename, 'Douyin ' + qualityLabel);
    await loadAssets();
  } catch (error) {
    console.error('Douyin download error:', error);
    toast(`Lỗi: ${error.message}`, 'error');
    addDownloadHistory(videoTitle, '', 'failed', '', 'Douyin ' + qualityLabel);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
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
  updateDownloadStats();
}

function saveDownloadHistory() {
  localStorage.setItem('downloadHistory', JSON.stringify(downloadHistory));
  updateDownloadStats();
}

// Cập nhật dải thống kê Tải video
function updateDownloadStats() {
  const totalEl = $('stat-total-downloads');
  const todayEl = $('stat-today-downloads');
  const errorEl = $('stat-error-count');

  if (totalEl) totalEl.textContent = downloadHistory.length;

  if (todayEl) {
    const today = new Date();
    const todayCount = downloadHistory.filter(item => {
      const d = new Date(item.timestamp);
      return d.toDateString() === today.toDateString();
    }).length;
    todayEl.textContent = todayCount;
  }

  if (errorEl) {
    const errCount = downloadHistory.filter(item => item.status === 'failed').length;
    errorEl.textContent = errCount;
  }

  // Cập nhật số hàng đợi từ badge
  const queueEl = $('stat-queue-count');
  const queueBadge = $('queue-badge');
  if (queueEl && queueBadge) {
    const count = parseInt(queueBadge.textContent || '0', 10);
    queueEl.textContent = isNaN(count) ? 0 : count;
  }
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
      <div class="empty-state-block">
        <div class="esb-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <h4>Chưa có lịch sử tải video nào</h4>
        <p>Sau khi tải xong video, lịch sử sẽ xuất hiện tại đây</p>
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
        <div style="position: relative; width: 50px; height: 50px; border-radius: 6px; overflow: hidden; flex-shrink: 0; background: var(--panel); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center;">
          ${item.thumbnail ? `<img src="${item.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='flex';" />` : ''}
          <div style="display: ${item.thumbnail ? 'none' : 'flex'}; align-items: center; justify-content: center; width: 100%; height: 100%;" class="placeholder-icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--soft)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;"><path d="M2 3h20v18H2z"/><path d="M2 7h20"/><path d="m5 3 3 4"/><path d="m10 3 3 4"/><path d="m15 3 3 4"/></svg>
          </div>
          ${isSuccess ? '<div style="position: absolute; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s;" class="history-thumb-overlay"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>' : ''}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div class="history-item-title" style="font-size: 13.5px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.15s;" title="${item.title.replace(/"/g, '&quot;')}">${item.title}</div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
            <span>${dateStr}</span>
            <span><a href="${item.url}" target="_blank" style="color: var(--accent); text-decoration: none;" onclick="event.stopPropagation();">Link nguồn</a></span>
            <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 2px 6px; font-size: 9px; font-weight: 600; border-radius: 4px;">
              ${badgeText}
            </span>
          </div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
        <span style="font-size: 11px; font-weight: 500; color: var(--muted); background: var(--border); padding: 4px 8px; border-radius: 4px;">${item.type}</span>
        ${isSuccess ? `<button type="button" class="ghost-btn" style="padding: 6px 10px; margin: 0; font-size: 11px; height: 30px; display: inline-flex; align-items: center;" onclick="openFileFolder('${item.filename}')" title="Mở thư mục chứa file video này">Mở</button>` : ''}
        <button type="button" class="ghost-btn" style="padding: 6px 10px; margin: 0; font-size: 11px; height: 30px; display: inline-flex; align-items: center;" onclick="redownloadHistoryItem('${item.url}')" title="Nạp lại link để tải lại">Tải lại</button>
        <button type="button" class="ghost-btn rendered-btn-delete" style="padding: 6px 10px; margin: 0; font-size: 11px; height: 30px; display: inline-flex; align-items: center; border-color: rgba(239, 68, 68, 0.2);" onclick="deleteHistoryItem('${item.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
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

  const defaultName = encodeURIComponent(($('video-filename-input')?.value.trim() || videoTitle) + '.mp4');
  const saveRes = await fetch('/api/select-save-path?defaultFilename=' + defaultName);
  const saveData = await saveRes.json();
  if (saveData.canceled) return;
  const outputDir = saveData.dir;
  const customFilename = saveData.filename.replace(/\.mp4$/i, '');

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Đang tải...';

  try {
    const res = await fetch('/api/download-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        format_id: formatId,
        customFilename,
        outputDir
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi tải video');

    const savedFilename = data.filename || `${customFilename}.mp4`;
    toast(`Tải thành công: ${outputDir}\\${savedFilename}`, 'success');
    addDownloadHistory(videoTitle, thumbnail, 'success', savedFilename, originalText);
    await loadAssets();
  } catch (error) {
    console.error('Client startDownload error:', error);
    toast(`Lỗi: ${error.message}`, 'error');
    addDownloadHistory(videoTitle, thumbnail, 'failed', '', originalText);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function saveVoice(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const btn = event.submitter;
  const fileInput = form.querySelector('input[type="file"][name="voice"]');
  if (fileInput && fileInput.files[0] && !isAllowedAudioFile(fileInput.files[0].name)) {
    toast('❌ Chỉ hỗ trợ file audio (.mp3, .wav, .m4a, .aac, .ogg)', 'error');
    return;
  }
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
  const fileInput = form.querySelector('input[type="file"][name="music"]');
  if (fileInput && fileInput.files[0] && !isAllowedAudioFile(fileInput.files[0].name)) {
    toast('❌ Chỉ hỗ trợ file audio (.mp3, .wav, .m4a, .aac, .ogg)', 'error');
    return;
  }
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

const OCR_DEFAULT_REGION = ['0.70', '0.98', '0.05', '0.95'];
let ocrReadyPromise = null;
let resolveOcrReady = null;
let ocrDownloadActive = false;
let currentOcrSupportedLanguages = [];

async function requestOcrJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Không thể kết nối bộ OCR.');
  return data;
}

const ocrComponentFlow = window.OcrUi?.createOcrComponentFlow({
  request: requestOcrJson,
  onProgress: updateOcrDownloadProgress
});

function updateOcrLanguages(languages) {
  const select = $('ocr-language-select');
  if (!select || !languages?.length) return;
  const previous = select.value;
  const normalized = window.OcrUi.normalizeSupportedLanguages(languages);
  currentOcrSupportedLanguages = normalized.map(language => language.id);
  select.innerHTML = '<option value="">Chọn ngôn ngữ...</option>';
  normalized.forEach(language => {
    const option = document.createElement('option');
    option.value = language.id;
    option.textContent = language.label;
    select.appendChild(option);
  });
  if (normalized.some(language => language.id === previous)) select.value = previous;
  updateOcrPipelineUi();
}

async function refreshOcrComponentStatusForUi() {
  if (!ocrComponentFlow) return;
  try {
    const status = await ocrComponentFlow.check();
    updateOcrLanguages(status.supportedLanguages);
  } catch (error) {
    console.error('Lỗi khi kiểm tra trạng thái OCR:', error);
  }
}

function updateOcrDownloadProgress(progress = {}) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const labels = {
    checking: 'Đang kiểm tra...',
    downloading: 'Đang tải...',
    verifying: 'Đang xác minh...',
    extracting: 'Đang giải nén...',
    installing: 'Đang cài đặt...',
    ready: 'OCR đã sẵn sàng',
    cancelled: 'Đã hủy'
  };
  if ($('ocr-download-progress-bar')) $('ocr-download-progress-bar').style.width = `${percent}%`;
  if ($('ocr-download-percent')) $('ocr-download-percent').textContent = `${percent}%`;
  if ($('ocr-download-status')) $('ocr-download-status').textContent = labels[progress.step] || labels[progress.status] || 'Đang xử lý...';
}

function finishOcrPreflight(ready) {
  $('ocr-component-modal')?.classList.add('hidden');
  const resolve = resolveOcrReady;
  resolveOcrReady = null;
  ocrReadyPromise = null;
  if (resolve) resolve(ready);
}

async function ensureOcrComponentReady() {
  if (!ocrComponentFlow) throw new Error('Không thể khởi tạo giao diện OCR.');
  const status = await ocrComponentFlow.check();
  updateOcrLanguages(status.supportedLanguages);
  if (status.ready) return true;
  if (ocrReadyPromise) return ocrReadyPromise;

  $('ocr-download-error')?.classList.add('hidden');
  updateOcrDownloadProgress({ status: 'not_installed', percent: 0 });
  $('ocr-component-modal')?.classList.remove('hidden');
  ocrReadyPromise = new Promise(resolve => { resolveOcrReady = resolve; });
  return ocrReadyPromise;
}

async function startOcrComponentDownload() {
  if (ocrDownloadActive) return;
  const button = $('ocr-download-btn');
  const error = $('ocr-download-error');
  ocrDownloadActive = true;
  setBusy(button, true, 'Đang tải...');
  error?.classList.add('hidden');
  try {
    const result = await ocrComponentFlow.download();
    if (result.ready) {
      const status = await ocrComponentFlow.check();
      updateOcrLanguages(status.supportedLanguages);
      finishOcrPreflight(true);
    }
  } catch (downloadError) {
    if (error) {
      error.textContent = downloadError.message;
      error.classList.remove('hidden');
    }
  } finally {
    ocrDownloadActive = false;
    setBusy(button, false);
  }
}

async function cancelOcrComponentDownload() {
  try {
    await ocrComponentFlow.cancel();
  } catch (error) {
    console.error('Lỗi khi hủy tải OCR:', error);
  } finally {
    finishOcrPreflight(false);
  }
}

function openOcrDownloadModal() {
  ensureOcrComponentReady();
  setTimeout(() => {
    startOcrComponentDownload();
  }, 150);
}
window.openOcrDownloadModal = openOcrDownloadModal;

const OCR_MODES = new Set(['fast', 'auto', 'accurate']);
const SUBTITLE_ENGINES = new Set(['auto', 'ocr', 'whisper']);
const OCR_PIPELINES = new Set(['auto', 'viral', 'vse']);
const WHISPER_TIMESTAMP_LEVELS = new Set(['segment', 'word']);
const WHISPER_DEVICES = new Set(['auto', 'cpu', 'cuda', 'dml']);
const WHISPER_BACKENDS = new Set(['faster-whisper']);

const OCR_REGION_INPUT_IDS = ['ocr-region-top', 'ocr-region-bottom', 'ocr-region-left', 'ocr-region-right'];

function updateOcrModeButtons() {
  const input = $('ocr-mode-value');
  if (!input) return;
  const mode = OCR_MODES.has(input.value) ? input.value : 'auto';
  input.value = mode;
  document.querySelectorAll('.ocr-mode-btn').forEach(button => {
    const active = button.dataset.ocrMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateSubtitleEngineUi() {
  const input = $('subtitle-engine-value');
  if (!input) return 'auto';
  const engine = SUBTITLE_ENGINES.has(input.value) ? input.value : 'auto';
  input.value = engine;
  document.querySelectorAll('.subtitle-engine-btn').forEach(button => {
    const active = button.dataset.subtitleEngine === engine;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.ocr-engine-settings').forEach(element => {
    element.classList.toggle('hidden', engine === 'whisper');
  });
  document.querySelectorAll('.whisper-engine-settings').forEach(element => {
    element.classList.toggle('hidden', engine === 'ocr');
  });
  updateOcrPipelineUi();
  return engine;
}

function isChineseOcrLanguage() {
  return ['ch', 'zh', 'zh-cn', 'zh-tw'].includes(String($('ocr-language-select')?.value || '').toLowerCase());
}

function usesRapidOcrUi() {
  const pipeline = $('ocr-pipeline-value')?.value;
  return pipeline === 'viral' || (pipeline === 'auto' && isChineseOcrLanguage());
}

function updateOcrPipelineUi() {
  const input = $('ocr-pipeline-value');
  if (!input) return 'auto';
  let pipeline = OCR_PIPELINES.has(input.value) ? input.value : 'auto';
  const chinese = isChineseOcrLanguage();
  if (pipeline === 'viral' && !chinese) {
    pipeline = 'auto';
    input.value = pipeline;
  }
  const rapidOption = input.querySelector('option[value="viral"]');
  if (rapidOption) rapidOption.disabled = !chinese;
  const usesRapid = usesRapidOcrUi();
  const shouldHideRegion = $('subtitle-engine-value')?.value === 'whisper' || usesRapid;
  document.querySelectorAll('.ocr-region-settings').forEach(element => {
    element.classList.toggle('hidden', shouldHideRegion);
  });
  const hint = $('ocr-pipeline-hint');
  if (hint) {
    hint.textContent = usesRapid
      ? 'RapidOCR tự quét & tracking chữ toàn khung hình.'
      : 'VSE dùng vùng OCR bạn đã chọn trên màn hình xem trước.';
  }
  updateOcrRegionOverlay();
  const showRapidRuntime = usesRapid && $('subtitle-engine-value')?.value !== 'whisper';
  updateRapidOcrRuntimeUi({ visible: showRapidRuntime });
  if (showRapidRuntime) void refreshRapidOcrRuntimeStatusForUi();
  return pipeline;
}

function getOcrRegionValues() {
  return OCR_REGION_INPUT_IDS.map(id => Number($(id)?.value));
}

function getOcrPreviewBounds() {
  const wrapper = $('video-preview-wrapper');
  const video = $('studio-video-preview');
  if (!wrapper || !video) return null;

  const width = wrapper.clientWidth;
  const height = wrapper.clientHeight;
  if (!width || !height) return null;

  const videoWidth = video.videoWidth || (wrapper.classList.contains('aspect-16-9') ? 16 : 9);
  const videoHeight = video.videoHeight || (wrapper.classList.contains('aspect-16-9') ? 9 : 16);
  const videoRatio = videoWidth / videoHeight;
  const wrapperRatio = width / height;

  if (videoRatio > wrapperRatio) {
    const actualHeight = width / videoRatio;
    return { left: 0, top: (height - actualHeight) / 2, width, height: actualHeight };
  }

  const actualWidth = height * videoRatio;
  return { left: (width - actualWidth) / 2, top: 0, width: actualWidth, height };
}

function updateOcrRegionOverlay() {
  const overlay = $('ocr-region-overlay');
  const wrapper = $('video-preview-wrapper');
  const shouldShow = $('subtitle-mode')?.value === 'generate'
    && $('subtitle-engine-value')?.value !== 'whisper'
    && !usesRapidOcrUi()
    && wrapper
    && !wrapper.classList.contains('hidden');
  if (!overlay || !shouldShow) {
    overlay?.classList.add('hidden');
    return;
  }

  const bounds = getOcrPreviewBounds();
  const [top, bottom, left, right] = getOcrRegionValues();
  if (!bounds || [top, bottom, left, right].some(value => !Number.isFinite(value))) return;

  overlay.style.left = `${bounds.left + left * bounds.width}px`;
  overlay.style.top = `${bounds.top + top * bounds.height}px`;
  overlay.style.width = `${(right - left) * bounds.width}px`;
  overlay.style.height = `${(bottom - top) * bounds.height}px`;
  overlay.classList.remove('hidden');
}

function setOcrRegionValues(values) {
  OCR_REGION_INPUT_IDS.forEach((id, index) => {
    if ($(id)) $(id).value = values[index].toFixed(2);
  });
  syncOcrRegion(false);
  updateOcrRegionOverlay();
}

function syncOcrRegion(updateOverlay = true) {
  const region = window.OcrUi.normalizeOcrRegion(getOcrRegionValues());
  $('ocr-region-value').value = region;
  if (updateOverlay) updateOcrRegionOverlay();
  return region;
}

function initOcrRegionOverlay() {
  const overlay = $('ocr-region-overlay');
  const wrapper = $('video-preview-wrapper');
  const video = $('studio-video-preview');
  if (!overlay || !wrapper || !video) return;

  let dragState = null;
  overlay.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const bounds = getOcrPreviewBounds();
    if (!bounds) return;
    dragState = {
      pointerId: event.pointerId,
      interaction: event.target.dataset.ocrHandle || 'move',
      startX: event.clientX,
      startY: event.clientY,
      values: getOcrRegionValues(),
      bounds
    };
    overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  overlay.addEventListener('pointermove', event => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - dragState.startX) / dragState.bounds.width;
    const deltaY = (event.clientY - dragState.startY) / dragState.bounds.height;
    const values = window.OcrUi.transformOcrRegion(
      dragState.values,
      dragState.interaction,
      deltaX,
      deltaY
    );
    setOcrRegionValues(values);
    event.preventDefault();
  });

  const endDrag = event => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    dragState = null;
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  OCR_REGION_INPUT_IDS.forEach(id => {
    $(id)?.addEventListener('input', () => {
      try { syncOcrRegion(); } catch { /* Wait until the typed bounds are valid. */ }
    });
    $(id)?.addEventListener('change', () => {
      try { syncOcrRegion(); } catch (error) { toast(error.message, 'error'); }
    });
  });

  video.addEventListener('loadedmetadata', updateOcrRegionOverlay);
  $('preview-aspect-select')?.addEventListener('change', () => requestAnimationFrame(updateOcrRegionOverlay));
  window.addEventListener('resize', updateOcrRegionOverlay);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(updateOcrRegionOverlay).observe(wrapper);
  }
  updateOcrRegionOverlay();
}

$('ocr-download-btn')?.addEventListener('click', startOcrComponentDownload);
$('ocr-download-cancel-btn')?.addEventListener('click', cancelOcrComponentDownload);
document.querySelectorAll('.subtitle-engine-btn').forEach(button => {
  button.addEventListener('click', () => {
    const input = $('subtitle-engine-value');
    if (!input || !SUBTITLE_ENGINES.has(button.dataset.subtitleEngine)) return;
    input.value = button.dataset.subtitleEngine;
    const engine = updateSubtitleEngineUi();
    if (engine !== 'whisper' && !usesRapidOcrUi() && $('subtitle-mode')?.value === 'generate') {
      refreshOcrComponentStatusForUi();
    }
  });
});
$('ocr-pipeline-value')?.addEventListener('change', updateOcrPipelineUi);
$('ocr-language-select')?.addEventListener('change', updateOcrPipelineUi);
document.querySelectorAll('.ocr-mode-btn').forEach(button => {
  button.addEventListener('click', () => {
    const input = $('ocr-mode-value');
    if (!input || !OCR_MODES.has(button.dataset.ocrMode)) return;
    input.value = button.dataset.ocrMode;
    updateOcrModeButtons();
  });
});
$('ocr-region-reset-btn')?.addEventListener('click', () => {
  OCR_REGION_INPUT_IDS.forEach((id, index) => {
    if ($(id)) $(id).value = OCR_DEFAULT_REGION[index];
  });
  syncOcrRegion();
});

initOcrRegionOverlay();

let rapidOcrRuntimeInstallPromise = null;
let piperRuntimeInstallPromise = null;
let rapidOcrGpuInstallPromise = null;

function updateRapidOcrGpuUi(status = {}) {
  const row = $('rapidocr-gpu-row');
  const label = $('rapidocr-gpu-status');
  const button = $('rapidocr-gpu-install-btn');
  if (!row || !label || !button) return;
  row.classList.toggle('hidden', status.runtimeReady === false);
  if (status.runtimeReady === false) return;
  if (status.installing || status.status === 'installing') {
    const percent = Number.isFinite(Number(status.percent)) ? ` ${Math.round(Number(status.percent))}%` : '';
    label.textContent = status.message || `Đang cài GPU${percent}…`;
    button.textContent = `Đang cài${percent}`;
    button.disabled = true;
    return;
  }
  if (status.gpuReady) {
    label.textContent = status.enabled
      ? `GPU CUDA đang bật`
      : 'GPU sẵn sàng (Mặc định chạy CPU)';
    button.textContent = status.enabled ? 'Đang dùng GPU' : 'GPU sẵn sàng';
    button.disabled = true;
    return;
  }
  if (status.status === 'unsupported') {
    label.textContent = 'GPU không hỗ trợ (Chạy CPU)';
    button.textContent = status.reason === 'driver_too_old' ? 'Driver cũ' : 'Không hỗ trợ';
    button.disabled = true;
    return;
  }
  if (status.status === 'error') {
    label.textContent = 'Lỗi GPU (Đang chạy CPU)';
    button.textContent = 'Thử sửa GPU';
    button.disabled = false;
    return;
  }
  label.textContent = 'Đang chạy CPU';
  button.textContent = 'Cài/sửa GPU';
  button.disabled = false;
}

function updatePiperRuntimeUi(status = {}) {
  const button = $('voice-runtime-install-btn');
  if (!button) return;
  const ready = status.ready === true;
  const installing = status.installing === true || status.status === 'installing';
  button.classList.toggle('hidden', ready);
  button.disabled = installing;
  if (installing) button.textContent = `Đang cài Piper… ${Math.max(0, Number(status.percent) || 0)}%`;
  else if (status.pythonExists || status.markerExists || status.status === 'error') button.textContent = 'Sửa Piper offline';
  else button.textContent = 'Cài Piper offline';
  button.title = ready
    ? 'Piper đã sẵn sàng.'
    : (status.error || status.message || 'Cài riêng runtime Piper offline.');
}

async function readPiperRuntimeStatus() {
  const response = await fetch('/api/piper-runtime/status');
  const status = await response.json();
  if (!response.ok) throw new Error(status.error || 'Không kiểm tra được Piper.');
  return status;
}

async function refreshPiperRuntimeStatusForUi() {
  try {
    const status = await readPiperRuntimeStatus();
    updatePiperRuntimeUi(status);
    return status;
  } catch (error) {
    updatePiperRuntimeUi({ status: 'error', error: error.message });
    return null;
  }
}

async function installPiperRuntime() {
  if (piperRuntimeInstallPromise) return piperRuntimeInstallPromise;
  piperRuntimeInstallPromise = (async () => {
    let status = await readPiperRuntimeStatus();
    updatePiperRuntimeUi(status);
    if (status.ready) return status;
    const force = status.pythonExists === true || status.markerExists === true;
    const response = await fetch('/api/piper-runtime/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không thể cài hoặc sửa Piper.');
    updatePiperRuntimeUi(result);
    toast(force ? 'Đang kiểm tra và sửa Piper offline…' : 'Đang cài Piper offline…', 'info');

    for (let attempt = 0; attempt < 1200; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      status = await readPiperRuntimeStatus();
      updatePiperRuntimeUi(status);
      if ($('render-status') && status.message) $('render-status').textContent = status.message;
      if (status.ready) return status;
      if (!status.installing && status.status === 'error') {
        throw new Error(status.error || status.message || 'Cài Piper thất bại.');
      }
    }
    throw new Error('Cài Piper quá thời gian chờ.');
  })();
  try {
    return await piperRuntimeInstallPromise;
  } finally {
    piperRuntimeInstallPromise = null;
  }
}

$('voice-runtime-install-btn')?.addEventListener('click', async () => {
  try {
    const status = await installPiperRuntime();
    await loadAssets();
    toast(status.defaultModel?.ready
      ? 'Piper offline và giọng mặc định đã sẵn sàng.'
      : 'Piper offline đã sẵn sàng. Model giọng sẽ tải ở lần dùng đầu tiên.', 'success');
  } catch (error) {
    updatePiperRuntimeUi({ status: 'error', error: error.message });
    toast(error.message, 'error');
  }
});

async function readRapidOcrGpuStatus() {
  const response = await fetch('/api/rapidocr-gpu/status');
  const status = await response.json();
  if (!response.ok) throw new Error(status.error || 'Không kiểm tra được RapidOCR GPU.');
  return status;
}

async function refreshRapidOcrGpuStatusForUi() {
  try {
    const status = await readRapidOcrGpuStatus();
    updateRapidOcrGpuUi(status);
    return status;
  } catch (error) {
    updateRapidOcrGpuUi({ status: 'error', runtimeReady: true, error: error.message });
    return null;
  }
}

function updateRapidOcrRuntimeUi({ visible, status } = {}) {
  const row = $('rapidocr-runtime-row');
  const label = $('rapidocr-runtime-status');
  const button = $('rapidocr-runtime-install-btn');
  if (!row || !label || !button) return;
  if (visible !== undefined) row.classList.toggle('hidden', !visible);
  if (row.classList.contains('hidden') || !status) return;

  if (status.ready) {
    label.textContent = 'RapidOCR đã sẵn sàng';
    button.textContent = 'Đã sẵn sàng';
    button.disabled = true;
    return;
  }
  if (status.status === 'installing') {
    const percent = Number.isFinite(Number(status.percent)) ? ` ${Math.round(Number(status.percent))}%` : '';
    label.textContent = status.message || `Đang cài RapidOCR${percent}…`;
    button.textContent = `Đang tải${percent}`;
    button.disabled = true;
    return;
  }
  if (status.status === 'error') {
    label.textContent = status.error || status.message || 'Cài RapidOCR thất bại.';
    button.textContent = 'Thử lại';
    button.disabled = false;
    return;
  }
  label.textContent = 'Chưa cài RapidOCR';
  button.textContent = 'Tải RapidOCR';
  button.disabled = false;
}

async function readRapidOcrRuntimeStatus() {
  const response = await fetch('/api/download-crawl/runtime-status');
  const status = await response.json();
  if (!response.ok) throw new Error(status.error || 'Không kiểm tra được runtime RapidOCR.');
  return status;
}

async function refreshRapidOcrRuntimeStatusForUi() {
  if (!usesRapidOcrUi()) return null;
  try {
    const status = await readRapidOcrRuntimeStatus();
    updateRapidOcrRuntimeUi({ visible: true, status });
    if (status.ready) await refreshRapidOcrGpuStatusForUi();
    else updateRapidOcrGpuUi({ runtimeReady: false });
    return status;
  } catch (error) {
    updateRapidOcrRuntimeUi({ visible: true, status: { status: 'error', error: error.message } });
    return null;
  }
}

async function installRapidOcrRuntime(purpose = 'RapidOCR') {
  if (rapidOcrRuntimeInstallPromise) return rapidOcrRuntimeInstallPromise;
  rapidOcrRuntimeInstallPromise = (async () => {
    let status = await readRapidOcrRuntimeStatus();
    if (status.ready) {
      updateRapidOcrRuntimeUi({ visible: true, status });
      return true;
    }
    const installResponse = await fetch('/api/download-crawl/runtime-install', { method: 'POST' });
    const installResult = await installResponse.json();
    if (!installResponse.ok) throw new Error(installResult.error || 'Không thể cài runtime RapidOCR.');
    toast(`Đang cài/cập nhật runtime ${purpose}. Chỉ cần thực hiện một lần.`, 'info');

    for (let attempt = 0; attempt < 1200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      status = await readRapidOcrRuntimeStatus();
      updateRapidOcrRuntimeUi({ visible: true, status });
      if ($('render-status') && status.message) $('render-status').textContent = status.message;
      if (status.ready) {
        toast(`${purpose} đã sẵn sàng.`, 'success');
        await refreshRapidOcrGpuStatusForUi();
        return true;
      }
      if (status.status === 'error') throw new Error(status.error || status.message || 'Cài RapidOCR thất bại.');
    }
    throw new Error('Cài RapidOCR quá thời gian chờ.');
  })();
  try {
    return await rapidOcrRuntimeInstallPromise;
  } finally {
    rapidOcrRuntimeInstallPromise = null;
  }
}

$('rapidocr-runtime-install-btn')?.addEventListener('click', async () => {
  try {
    await installRapidOcrRuntime();
  } catch (error) {
    updateRapidOcrRuntimeUi({ visible: true, status: { status: 'error', error: error.message } });
    toast(error.message, 'error');
  }
});

async function installRapidOcrGpu() {
  if (rapidOcrGpuInstallPromise) return rapidOcrGpuInstallPromise;
  rapidOcrGpuInstallPromise = (async () => {
    const response = await fetch('/api/rapidocr-gpu/install', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không thể cài tăng tốc RapidOCR GPU.');
    updateRapidOcrGpuUi(result);
    toast('Đang kiểm tra và cài tăng tốc GPU. Không render trong lúc này.', 'info');
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await readRapidOcrGpuStatus();
      updateRapidOcrGpuUi(status);
      if (status.status === 'error') throw new Error(status.error || status.message || 'Cài GPU thất bại.');
      if (!status.installing && status.status !== 'installing') {
        if (status.gpuReady) {
          toast(status.enabled
            ? 'RapidOCR đang dùng GPU thật bằng CUDAExecutionProvider.'
            : 'Đã cài GPU thành công. RapidOCR vẫn dùng CPU mặc định để đạt tốc độ tốt hơn.', 'success');
        }
        else toast(status.message || 'GPU không hoạt động; RapidOCR tiếp tục chạy CPU.', 'warning');
        return status.gpuReady === true;
      }
    }
    throw new Error('Cài RapidOCR GPU quá thời gian chờ.');
  })();
  try {
    return await rapidOcrGpuInstallPromise;
  } finally {
    rapidOcrGpuInstallPromise = null;
  }
}

$('rapidocr-gpu-install-btn')?.addEventListener('click', async () => {
  try {
    await installRapidOcrGpu();
  } catch (error) {
    updateRapidOcrGpuUi({ status: 'error', runtimeReady: true, error: error.message });
    toast(error.message, 'error');
  }
});

async function ensureViralOcrRuntimeReady() {
  let status = await readRapidOcrRuntimeStatus();
  updateRapidOcrRuntimeUi({ visible: true, status });
  if (status.ready) return true;
  return installRapidOcrRuntime();
}

async function renderStudio(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const btn = $('render-btn');
  const status = $('render-status');
  const data = new FormData(form);
  for (const name of ['audioNoiseGate', 'audioDucking', 'audioExportTracks']) {
    const input = form.elements[name];
    data.set(name, input?.checked ? 'true' : 'false');
  }
  data.set('uiSnapshot', JSON.stringify(serializeStudioForm()));

  const subMode = data.get('subtitleMode');
  const voiceMode = data.get('voiceMode');
  const omiDevice = data.get('omiDevice');
  const subtitleEngine = SUBTITLE_ENGINES.has(data.get('subtitleEngine')) ? data.get('subtitleEngine') : 'auto';
  const whisperOnnxVariant = 'medium-q8'; // lớp cứu cuối nội bộ, không còn cho người dùng chọn
  const whisperBackend = 'faster-whisper';
  const whisperTimestampLevel = WHISPER_TIMESTAMP_LEVELS.has(data.get('whisperTimestampLevel'))
    ? data.get('whisperTimestampLevel')
    : 'segment';
  const whisperDevice = WHISPER_DEVICES.has(data.get('whisperDevice'))
    ? data.get('whisperDevice')
    : 'auto';
  const globalOcrModeVal = $('global-ocr-mode-select')?.value || localStorage.getItem('global_ocr_mode') || 'auto';
  const ocrMode = OCR_MODES.has(globalOcrModeVal) ? globalOcrModeVal : 'auto';
  data.set('subtitleEngine', subtitleEngine);
  data.set('whisperOnnxVariant', whisperOnnxVariant);
  data.set('whisperBackend', whisperBackend);
  data.set('whisperTimestampLevel', whisperTimestampLevel);
  data.set('whisperDevice', whisperDevice);
  data.set('ocrMode', ocrMode);

  if (subMode === 'generate') {
    if (subtitleEngine !== 'whisper' && !data.get('ocrLanguage')) {
      toast('Chọn ngôn ngữ chữ gốc để nhận dạng phụ đề.', 'error');
      return;
    }
    if (subtitleEngine !== 'whisper') {
      try {
        data.set('ocrRegion', syncOcrRegion());
        const ocrPipeline = OCR_PIPELINES.has(data.get('ocrPipeline')) ? data.get('ocrPipeline') : 'auto';
        const isChinese = ['ch', 'zh', 'zh-cn', 'zh-tw'].includes(String(data.get('ocrLanguage') || '').toLowerCase());
        if (ocrPipeline === 'viral' && !isChinese) {
          toast('RapidOCR hiện chỉ hỗ trợ tiếng Trung. Hãy chọn VSE hoặc đổi ngôn ngữ chữ gốc thành Trung.', 'error');
          return;
        }
        const usesViralOcr = ocrPipeline === 'viral' || (ocrPipeline === 'auto' && isChinese);
        const ready = usesViralOcr
          ? await ensureViralOcrRuntimeReady()
          : await ensureOcrComponentReady();
        if (!ready) return;
        if (!usesViralOcr && currentOcrSupportedLanguages.length && !currentOcrSupportedLanguages.includes(data.get('ocrLanguage'))) {
          toast('Ngôn ngữ đã chọn không được bộ OCR hiện tại hỗ trợ.', 'error');
          return;
        }
      } catch (error) {
        toast(error.message, 'error');
        return;
      }
    }
    if (subtitleEngine !== 'ocr') {
      try {
        const checkRes = await fetch('/api/whisper-model/status');
        const checkStatus = await checkRes.json();
        if (!checkRes.ok) throw new Error(checkStatus.error || 'Không thể kiểm tra model Whisper');
        if (!checkStatus.exists) {
          toast('Thiếu model Faster-Whisper Large V3 Turbo. Hãy tải model trước khi render.', 'warn');
          if (typeof openWhisperDownloadModal === 'function') openWhisperDownloadModal();
          return;
        }
      } catch (error) {
        toast(error.message, 'error');
        return;
      }
    }
  }

  // Kiểm tra CUDA
  if (voiceMode === 'omi') {
    const voiceEngineId = data.get('voiceEngine') || assets.defaultVoiceEngineId || 'current-omnivoice';
    const voiceEngine = (assets.voiceEngines || []).find((engine) => engine.id === voiceEngineId);
    if (!voiceEngine?.status?.ready) {
      toast('Voice engine đã chọn chưa sẵn sàng. Hãy kiểm tra CLI và model.', 'error');
      return;
    }
    data.set('voiceEngine', voiceEngineId);
  }

  if (voiceMode === 'omi'
    && data.get('voiceEngine') === 'current-omnivoice'
    && omiDevice === 'cuda:0'
    && !dependencyStatus.cuda) {
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

  if (data.get('logoMode') === 'saved' && !data.get('savedLogoFile')) {
    toast('Hãy chọn một logo đã tải trước khi render.', 'error');
    return;
  }

  // Load global AI settings and set whisperModel
  const aiSettings = getGlobalAiSettings();
  const whisperModel = aiSettings.whisperModel || 'small';
  data.set('whisperModel', whisperModel);

  data.set('translateVi', 'true');
  data.set('burnSub', 'true');
  data.set('blurOriginalSub', (blurBoxes && blurBoxes.length > 0) ? 'true' : 'false');
  data.append('blurBoxes', JSON.stringify(blurBoxes));
  data.set('projectId', currentProjectId || '');
  data.set('projectName', currentProjectName || '');

  data.set('translateTargetLang', document.getElementById('global-output-lang')?.value || 'vi');
  data.set('aiProvider', aiSettings.aiProvider);
  data.set('geminiApiKey', aiSettings.geminiApiKey);
  data.set('geminiModel', aiSettings.geminiModel || '');
  data.set('openRouterApiKey', aiSettings.openRouterApiKey);
  data.set('openRouterModel', aiSettings.openRouterModel);
  data.set('ninerouterApiKey', aiSettings.ninerouterApiKey || '');
  data.set('ninerouterModel', aiSettings.ninerouterModel || '');
  data.set('ninerouterBaseUrl', aiSettings.ninerouterBaseUrl || 'http://localhost:20128/v1');
  data.set('opencodeModel', aiSettings.opencodeModel || 'DeepSeek V4 Flash (Free)');
  data.set('openaiApiKey', aiSettings.openaiApiKey || '');
  data.set('openaiModel', aiSettings.openaiModel || 'gpt-4o-mini');
  data.set('translationStyles', JSON.stringify(aiSettings.translationStyles || []));
  
  const keepBgmAi = document.querySelector('input[name="keepOriginalBgmAI"]')?.checked;
  if (keepBgmAi) {
    data.set('keepOriginalBgmAI', 'true');
    const mdxProvider = data.get('mdxProvider') || 'auto';
    if (!dependencyStatus.separator) {
      showDependencyModal('separator', () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      return;
    }
    if (mdxProvider === 'cuda') {
      const mdx = dependencyStatus.mdx;
      if (!mdx?.cuda?.hardwareAvailable) {
        toast('MDX CUDA yêu cầu GPU NVIDIA và driver NVIDIA hoạt động.', 'error');
        return;
      }
      if (!mdx?.cuda?.ready) {
        toast('Máy có NVIDIA nhưng chưa cài component MDX CUDA. Hãy dùng Tự động/CPU hoặc cài component CUDA.', 'warn');
        return;
      }
    }
  }

  // Map volumes logarithmically for FFmpeg
  const originalSlider = document.querySelector('input[name="originalVolume"]');
  const voiceSlider = document.querySelector('input[name="voiceVolume"]');
  const musicSlider = document.querySelector('input[name="musicVolume"]');
  if (originalSlider) data.set('originalVolume', sliderToVolume(originalSlider.value));
  if (voiceSlider) data.set('voiceVolume', sliderToVolume(voiceSlider.value));
  if (musicSlider) data.set('musicVolume', sliderToVolume(musicSlider.value));

  const flipOn = $('antidupe-flip')?.checked === true;
  const trimOn = $('antidupe-enable')?.checked === true;
  const wmOn = $('antidupe-wm-enable')?.checked === true;
  data.set('antidupeEnabled', (flipOn || trimOn || wmOn) ? 'true' : 'false');
  if (!trimOn) {
    data.set('antidupeStart', '0');
    data.set('antidupeEnd', '');
  }
  if (!wmOn) {
    data.set('antidupeWatermark', '');
  }
  // Convert độ mờ từ % → decimal cho backend
  const wmAlphaEl = $('antidupe-wm-alpha');
  if (wmAlphaEl) data.set('antidupeWmAlpha', (parseFloat(wmAlphaEl.value) / 100).toFixed(4));

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
let appliedRenderUiSnapshotTaskId = null;
let pendingRenderUiSnapshotTask = null;

function applyRenderTaskUiSnapshot(task, force = false) {
  if (!task?.uiSnapshot || typeof task.uiSnapshot !== 'object') return false;
  if (!force && appliedRenderUiSnapshotTaskId === task.id) return false;
  pendingRenderUiSnapshotTask = studioAssetsReady ? null : task;
  deserializeStudioForm(task.uiSnapshot);
  appliedRenderUiSnapshotTaskId = task.id;
  return true;
}

function reapplyPendingRenderUiSnapshot() {
  if (!pendingRenderUiSnapshotTask) return;
  deserializeStudioForm(pendingRenderUiSnapshotTask.uiSnapshot);
  appliedRenderUiSnapshotTaskId = pendingRenderUiSnapshotTask.id;
  pendingRenderUiSnapshotTask = null;
}

async function restoreLatestRenderUiSnapshotForCurrentProject() {
  if (!currentProjectId) return;
  try {
    const response = await fetch('/api/render-queue-status');
    if (!response.ok) return;
    const data = await response.json();
    const candidates = (Array.isArray(data.queue) ? data.queue : [])
      .filter((task) => task.projectId === currentProjectId
        && ['pending', 'rendering', 'waiting_input', 'error'].includes(task.status)
        && task.uiSnapshot)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!candidates.length) return;
    currentDisplayedTaskId = candidates[0].id;
    applyRenderTaskUiSnapshot(candidates[0], true);
  } catch (error) {
    console.error('[Render Snapshot] Không thể khôi phục cấu hình:', error.message);
  }
}

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

function renderTranslationReportSummary(report) {
  if (!report) return '';
  const stats = report.translation;
  let progressSummary = '';
  if (stats && Number(stats.total) > 0) {
    const total = Number(stats.total) || 0;
    const translated = Number(stats.translated) || 0;
    const failed = Number(stats.failed) || 0;
    const fallbackUsed = Number(stats.fallbackUsed) || 0;
    progressSummary = `
      <div class="translation-report-summary ${failed > 0 ? 'warning' : 'ok'}">
        <strong>Đã dịch ${translated}/${total} câu${failed > 0 ? ` · ${failed} câu lỗi` : ''}</strong>
        ${fallbackUsed > 0 ? `<div>${fallbackUsed} câu đã dùng NLLB dự phòng</div>` : ''}
      </div>`;
  }
  return progressSummary;
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
    const hasActiveOrPending = data.queue.some(t => ['rendering', 'pending', 'waiting_input'].includes(t.status));
    const statusText = $('render-status');

    // Cập nhật số lượng trên badge (chỉ đếm các task đang chạy hoặc đang chờ)
    const activeOrPendingCount = data.queue.filter(t => ['rendering', 'pending', 'waiting_input'].includes(t.status)).length;
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

function renderAudioResultSummary(result = {}) {
  const report = result.audioReport;
  const tracks = result.audioTracks || {};
  const links = [];
  if (tracks.voice?.url) {
    links.push(`
      <div class="audio-result-track">
        <span>Giọng đọc</span>
        <audio controls preload="none" src="${tracks.voice.url}"></audio>
        <a class="ghost-btn audio-result-link" href="${tracks.voice.url}" download>Tải</a>
      </div>`);
  }
  if (tracks.background?.url) {
    links.push(`
      <div class="audio-result-track">
        <span>Nhạc nền</span>
        <audio controls preload="none" src="${tracks.background.url}"></audio>
        <a class="ghost-btn audio-result-link" href="${tracks.background.url}" download>Tải</a>
      </div>`);
  }
  if (!report && links.length === 0) return '';

  let qcText = 'QC âm thanh chưa khả dụng';
  let qcClass = 'warn';
  if (report?.status === 'ready') {
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    qcText = warnings.length
      ? `QC âm thanh: ${warnings.length} cảnh báo`
      : 'QC âm thanh: đạt';
    qcClass = warnings.length ? 'warn' : 'success';
  }
  return `
    <div class="audio-result-summary ${qcClass}">
      <div class="audio-result-head">
        <span>${qcText}</span>
        ${links.length
    ? `<button type="button" class="audio-result-toggle"
            title="Nghe hoặc tải các track âm thanh"
            aria-label="Mở danh sách track âm thanh"
            aria-expanded="false"
            onclick="toggleAudioResultTracks(this)">⌄</button>`
    : ''}
      </div>
      ${links.length ? `<div class="audio-result-links" hidden>${links.join('')}</div>` : ''}
    </div>`;
}

function toggleAudioResultTracks(button) {
  const summary = button?.closest('.audio-result-summary');
  const tracks = summary?.querySelector('.audio-result-links');
  if (!tracks) return;
  const opening = tracks.hidden;
  tracks.hidden = !opening;
  summary.classList.toggle('expanded', opening);
  button.setAttribute('aria-expanded', String(opening));
  button.setAttribute(
    'aria-label',
    opening ? 'Đóng danh sách track âm thanh' : 'Mở danh sách track âm thanh'
  );
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
        <p style="font-size: 12px; color: var(--text); opacity: 0.8; max-width: 400px; line-height: 1.5; margin: 0 auto;">Hệ thống đang xử lý và trộn video. Tùy thuộc vào độ dài video và các thiết lập AI (Speech-to-Text, Omi Cloner), quá trình này có thể mất một vài phút. Vui lòng không tắt ứng dụng.</p>
        <button id="cancel-render-btn" style="margin-top: 20px; background: transparent; border: 1px solid rgba(239, 68, 68, 0.4); color: var(--danger); padding: 8px 20px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: all 0.15s;" onclick="cancelQueueTask('${targetTask.id}', event)" onmouseover="this.style.background='rgba(239, 68, 68, 0.06)'; this.style.borderColor='var(--danger)';" onmouseout="this.style.background='transparent'; this.style.borderColor='rgba(239, 68, 68, 0.4)';">Hủy Render</button>
      </div>
    `;
  } else if (targetTask.status === 'pending') {
    // 2. Giao diện Đang chờ xếp hàng
    html = `
      <div class="render-loading-state" style="border-color: var(--border); background: rgba(255, 255, 255, 0.01);">
        <div style="font-size: 32px; margin-bottom: 12px;">⏳</div>
        <h3 style="color: var(--accent-2); margin-bottom: 8px;">Đang chờ xếp hàng...</h3>
        <p style="color: var(--text); opacity: 0.8; max-width: 400px; margin: 0 auto; line-height: 1.5; font-size: 12.5px;">Video "${targetTask.videoName}" đang nằm trong hàng đợi render. Tiến trình sẽ tự động bắt đầu khi các tác vụ trước đó hoàn thành.</p>
        <button style="margin-top: 20px; background: transparent; border: 1px solid rgba(239, 68, 68, 0.4); color: var(--danger); padding: 8px 20px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: all 0.15s;" onclick="cancelQueueTask('${targetTask.id}', event)" onmouseover="this.style.background='rgba(239, 68, 68, 0.06)'; this.style.borderColor='var(--danger)';" onmouseout="this.style.background='transparent'; this.style.borderColor='rgba(239, 68, 68, 0.4)';">Hủy Chờ</button>
      </div>
    `;
  } else if (targetTask.status === 'waiting_input') {
    if (targetTask.actionRequired === 'segment_review') {
      const review = targetTask.segmentReview || {};
      const reviewText = `${Number(review.approved || 0)}/${Number(review.total || 0)} câu đã duyệt`
        + `${Number(review.warnings || 0) ? ` • ${Number(review.warnings)} câu có cảnh báo` : ''}`;
      html = `
        <div class="render-loading-state ocr-waiting-state">
          <h3>Cần duyệt lời thoại</h3>
          <p>${reviewText}</p>
          <div class="ocr-fallback-actions">
            <button type="button" class="premium-render-btn" onclick="openSegmentEditor('${targetTask.id}')">Mở trình chỉnh segment</button>
            <button type="button" class="premium-render-btn ghost-btn" onclick="cancelQueueTask('${targetTask.id}', event)">Hủy</button>
          </div>
        </div>`;
    } else if (targetTask.actionRequired === 'render_resume') {
      const resumeMessage = window.OcrUi.escapeHtml(
        targetTask.step || 'Tác vụ đã được khôi phục từ lần chạy trước.'
      );
      html = `
        <div class="render-loading-state ocr-waiting-state">
          <h3>Render đang chờ tiếp tục</h3>
          <p>${resumeMessage}</p>
          <div class="ocr-fallback-actions">
            <button type="button" class="premium-render-btn" onclick="resumeRenderTask('${targetTask.id}', event)">Tiếp tục từ checkpoint</button>
            <button type="button" class="premium-render-btn ghost-btn" onclick="cancelQueueTask('${targetTask.id}', event)">Hủy</button>
          </div>
        </div>`;
    } else {
      const fallback = window.OcrUi.getOcrFallbackAction(targetTask);
      const fallbackMessage = window.OcrUi.escapeHtml(fallback.message || targetTask.error || 'OCR gặp lỗi kỹ thuật.');
      const whisperAction = fallback.visible
        ? `<button type="button" class="premium-render-btn" onclick="useWhisperForTask('${targetTask.id}', event)">Dùng Whisper thay thế</button>`
        : '';
      html = `
        <div class="render-loading-state ocr-waiting-state">
          <h3>OCR cần bạn xác nhận</h3>
          <p>${fallbackMessage}</p>
          <div class="ocr-fallback-actions">
            ${whisperAction}
            <button type="button" class="premium-render-btn ghost-btn" onclick="cancelQueueTask('${targetTask.id}', event)">Hủy</button>
          </div>
        </div>`;
    }
  } else if (targetTask.status === 'success' && targetTask.result) {
    // 3. Giao diện Render thành công (Video Player full-size như cũ)
    html = `
      <div class="video-preview-wrapper result-video-wrapper" style="margin: 0 auto 10px auto;">
        <video controls src="${targetTask.result.url}"></video>
      </div>
      ${renderTranslationReportSummary(targetTask.translationReport || targetTask.result.translationReport)}
      ${renderAudioResultSummary(targetTask.result)}
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
    const errMsg = window.OcrUi.escapeHtml(targetTask.error || targetTask.step || 'Lỗi không xác định');
    const resumeAction = targetTask.canResume
      ? `<button type="button" class="premium-render-btn" style="margin-top: 12px;" onclick="resumeRenderTask('${targetTask.id}', event)">Tiếp tục từ checkpoint</button>`
      : '';

    html = `
      <div class="render-loading-state" style="border-color: ${borderColor}; background: ${bgColor}; max-width: 500px; margin: 20px auto; padding: 30px; border-radius: 12px; border: 1px solid;">
        <div style="font-size: 40px; margin-bottom: 15px;">${statusIcon}</div>
        <h3 style="color: ${statusColor}; margin-bottom: 10px;">${statusTitle}</h3>
        <p style="color: var(--muted); font-size: 13px; margin-bottom: 15px; line-height: 1.5;">${errMsg}</p>
        <p style="font-size: 12px; color: var(--muted);">Tên video: ${targetTask.videoName}</p>
        ${resumeAction}
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
    const isWaiting = task.status === 'waiting_input';
    const isSuccess = task.status === 'success';
    const isFailed = task.status === 'failed' || task.status === 'error';

    let statusBadge = '';
    let progressBarPercent = 0;
    let progressBarColor = 'rgba(255, 255, 255, 0.1)';

    if (isRunning) {
      statusBadge = `<span style="color: #3b82f6; background: rgba(59, 130, 246, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Đang chạy (${task.percent}%)</span>`;
      progressBarPercent = task.percent || 0;
      progressBarColor = 'linear-gradient(90deg, var(--heavy-action, #f97316), #ea580c)';
    } else if (isPending) {
      statusBadge = `<span style="color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Chờ render</span>`;
      progressBarPercent = 0;
      progressBarColor = 'rgba(255, 255, 255, 0.05)';
    } else if (isWaiting) {
      statusBadge = `<span style="color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Cần xác nhận</span>`;
      progressBarPercent = task.percent || 0;
      progressBarColor = '#f59e0b';
    } else if (isSuccess) {
      statusBadge = `<span style="color: #22c55e; background: rgba(34, 197, 94, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">Hoàn tất</span>`;
      progressBarPercent = 100;
      progressBarColor = '#22c55e';
    } else if (isFailed) {
      statusBadge = `<span style="color: #ef4444; background: rgba(239, 68, 68, 0.1); padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;" title="${task.error || ''}">Thất bại</span>`;
      progressBarPercent = task.percent || 0;
      progressBarColor = '#ef4444';
    }

    let actionHtml = '';
    let waitingMessageHtml = '';
    if (isWaiting && task.actionRequired === 'segment_review') {
      const review = task.segmentReview || {};
      waitingMessageHtml = `<div class="queue-ocr-error">`
        + `${Number(review.approved || 0)}/${Number(review.total || 0)} câu đã duyệt`
        + `${Number(review.warnings || 0) ? ` • ${Number(review.warnings)} cảnh báo` : ''}</div>`;
      actionHtml = `
        <button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="openSegmentEditor('${task.id}')">Duyệt câu</button>
        <button type="button" class="premium-render-btn ghost-btn" style="padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="cancelQueueTask('${task.id}', event)">Hủy</button>`;
    } else if (isWaiting && window.OcrUi.getOcrFallbackAction(task).visible) {
      const waitingMessage = window.OcrUi.escapeHtml(window.OcrUi.getOcrFallbackAction(task).message);
      waitingMessageHtml = `<div class="queue-ocr-error">${waitingMessage}</div>`;
      actionHtml = `
        <button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="useWhisperForTask('${task.id}', event)">Dùng Whisper</button>
        <button type="button" class="premium-render-btn ghost-btn" style="padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="cancelQueueTask('${task.id}', event)">Hủy</button>`;
    } else if ((isWaiting && task.actionRequired === 'render_resume') || (isFailed && task.canResume)) {
      const waitingMessage = window.OcrUi.escapeHtml(
        isWaiting && task.actionRequired === 'render_resume'
          ? (task.step || 'Tác vụ có thể tiếp tục từ checkpoint.')
          : (task.error || task.step || 'Tác vụ có thể tiếp tục từ checkpoint.')
      );
      waitingMessageHtml = `<div class="queue-ocr-error">${waitingMessage}</div>`;
      actionHtml = `
        <button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="resumeRenderTask('${task.id}', event)">Tiếp tục</button>
        <button type="button" class="premium-render-btn ghost-btn" style="padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="cancelQueueTask('${task.id}', event)">Hủy</button>`;
    } else if (isPending) {
      actionHtml = `<button type="button" class="premium-render-btn" style="background: #ef4444; color: white; padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="cancelQueueTask('${task.id}', event)">Hủy chờ</button>`;
    } else if (isRunning) {
      actionHtml = `<button type="button" class="premium-render-btn" style="background: #ef4444; color: white; padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="cancelQueueTask('${task.id}', event)">Hủy render</button>`;
    } else {
      actionHtml = `
        <button type="button" class="premium-render-btn" style="background: var(--accent); color: white; padding: 4px 10px; font-size: 11px; margin: 0; width: auto; height: 26px;" onclick="selectAndShowTask('${task.id}')">Xem Chi Tiết</button>
      `;
    }

    const voiceFallbackHtml = task.voiceExecution?.fallback
      ? `<div style="font-size: 11px; color: #f59e0b;">
          Voice engine đã chuyển từ ${window.OcrUi.escapeHtml(task.voiceExecution.requestedDevice || 'GPU')}
          sang ${window.OcrUi.escapeHtml(task.voiceExecution.usedDevice || 'CPU')}.
        </div>`
      : '';
    const timeStr = new Date(task.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

    html += `
      <div style="background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div class="queue-item-info-clickable" style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; cursor: pointer; transition: opacity 0.2s;" onclick="selectAndShowTask('${task.id}')" onmouseover="this.style.opacity='0.75'" onmouseout="this.style.opacity='1'">
            <span style="font-size: 11px; color: var(--muted); font-weight: 500;">[${timeStr}]</span>
            <div style="display: flex; flex-direction: column; min-width: 0;">
              <strong style="font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 280px;" title="${task.videoName}">${task.videoName}</strong>
              <span style="font-size: 10px; color: var(--muted); font-weight: 500;">Dự án: <span style="color: var(--accent); font-weight: 600;">${task.projectName || 'Chưa rõ'}</span></span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            ${statusBadge}
            ${actionHtml}
          </div>
        </div>
        ${waitingMessageHtml}
        ${voiceFallbackHtml}
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
      if (task && task.projectId) {
        if (task.projectId !== currentProjectId) {
          await loadProject(task.projectId, true);
        } else {
          executeSwitchView('studio');
          openStudioEditor();
        }
        applyRenderTaskUiSnapshot(task, true);
        currentDisplayedTaskId = taskId;
        switchToResultTab();
        updateQueueStatus();
        closeQueueModal();
        return;
      }
    }
  } catch (e) {
    console.error('Lỗi khi chuyển đổi dự án từ hàng đợi:', e);
  }

  currentDisplayedTaskId = taskId;
  try {
    const response = await fetch('/api/render-queue-status');
    if (response.ok) {
      const data = await response.json();
      applyRenderTaskUiSnapshot(data.queue.find((task) => task.id === taskId), true);
    }
  } catch {}
  executeSwitchView('studio');
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

async function useWhisperForTask(taskId, event) {
  const button = event?.currentTarget || event?.target;
  setBusy(button, true, 'Đang chuyển...');
  try {
    const response = await fetch('/api/render-use-whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, settings: getGlobalAiSettings() })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Không thể chuyển sang Whisper.');
    toast('Đã chuyển tác vụ sang Whisper.', 'success');
    startQueuePolling();
    await updateQueueStatus();
  } catch (error) {
    toast(error.message, 'error');
    setBusy(button, false);
  }
}
window.useWhisperForTask = useWhisperForTask;

async function resumeRenderTask(taskId, event) {
  const button = event?.currentTarget || event?.target;
  setBusy(button, true, 'Đang tiếp tục...');
  try {
    const response = await fetch('/api/render-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        settings: getGlobalAiSettings()
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Không thể tiếp tục tác vụ render.');
    }
    const skipped = Array.isArray(result.completedStages) ? result.completedStages.length : 0;
    toast(skipped > 0
      ? `Đang tiếp tục, giữ lại ${skipped} bước đã hoàn tất.`
      : 'Đã đưa tác vụ trở lại hàng chờ.', 'success');
    startQueuePolling();
    await updateQueueStatus();
  } catch (error) {
    toast(error.message, 'error');
    setBusy(button, false);
  }
}
window.resumeRenderTask = resumeRenderTask;

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
    const hasActiveOrPending = data.queue.some(t => ['rendering', 'pending', 'waiting_input'].includes(t.status));
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
    select.style.borderColor = 'var(--danger)';
    setTimeout(() => { select.style.borderColor = ''; }, 3000);
    return;
  }

  const defaultName = encodeURIComponent((video.title || 'video') + '.mp4');
  const saveRes = await fetch('/api/select-save-path?defaultFilename=' + defaultName);
  const saveData = await saveRes.json();
  if (saveData.canceled) return;
  const outputDir = saveData.dir;
  const customFilename = saveData.filename.replace(/\.mp4$/i, '');

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

    const res = await fetch('/api/download-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: video.url,
        format_id: val,
        customFilename,
        outputDir
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi tải video');

    if (statusLabel) {
      statusLabel.textContent = 'Thành công';
      statusLabel.style.color = '#10b981';
    }
    toast(`Tải thành công: ${outputDir}\\${data.filename || (video.title || video.id) + '.mp4'}`, 'success');
    
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

  // Validate format selected for all checked videos first
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

  // Choose folder once for all videos
  const folderRes = await fetch('/api/select-save-path?mode=folder');
  const folderData = await folderRes.json();
  if (folderData.canceled) return;
  const bulkOutputDir = folderData.dir;

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
    if (video.formats) {
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
      const res = await fetch('/api/download-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: video.url,
          format_id: formatId,
          customFilename: video.customTitle || video.title,
          outputDir: bulkOutputDir
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

function updateAudioMasteringUi() {
  const mode = $('audio-mastering-mode')?.value || 'auto';
  $('audio-mastering-custom')?.classList.toggle('hidden', mode !== 'custom');
}

function updateConditionalFields() {
  const subMode = $('subtitle-mode').value;
  $('sub-upload-wrapper').classList.toggle('hidden', subMode !== 'upload');
  $('sub-saved-wrapper').classList.toggle('hidden', subMode !== 'saved');
  updateOcrModeButtons();
  updateSubtitleEngineUi();
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
  const selectedVoiceEngine = $('voice-engine-select')?.value || 'current-omnivoice';
  const selectedVoiceDescriptor = (assets.voiceEngines || [])
    .find((engine) => engine.id === selectedVoiceEngine);
  const needsSavedVoice = voiceMode === 'saved'
    || (voiceMode === 'omi' && selectedVoiceDescriptor?.capabilities?.cloneVoice === true);
  $('voice-saved-wrapper').classList.toggle('hidden', !needsSavedVoice);
  $('voice-upload-wrapper').classList.toggle('hidden', voiceMode !== 'upload');
  $('omi-cloner-container').classList.toggle('hidden', voiceMode !== 'omi');

  const musicMode = $('music-mode').value;
  $('music-saved-wrapper').classList.toggle('hidden', musicMode !== 'saved');
  $('music-upload-wrapper').classList.toggle('hidden', musicMode !== 'upload');
  updateAudioMasteringUi();

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

const studioVideoPlatformLabels = {
  local: 'Tải đơn lẻ', youtube: 'YouTube', tiktok: 'TikTok', douyin: 'Douyin',
  bilibili: 'Bilibili', facebook: 'Facebook', instagram: 'Instagram',
  xiaohongshu: 'Xiaohongshu', rednote: 'RedNote'
};
const studioVideoModeLabels = { local: 'Tải đơn lẻ', detail: 'Theo link', search: 'Theo từ khóa', creator: 'Theo kênh', chase: 'Theo bộ' };

function applyStudioVideoAssets(videos) {
  assets.videos = Array.isArray(videos) ? videos : [];
  studioInitializeVideoFilters(assets.videos);
  renderReactionVideoGrid(assets.videos);
  renderAssetList('asset-videos', assets.videos);
}

async function refreshStudioVideoAssets() {
  if (studioVideoRefreshPromise) return studioVideoRefreshPromise;
  studioVideoRefreshPromise = (async () => {
    const response = await fetch('/api/studio-assets', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không đọc được danh sách video nguồn.');
    applyStudioVideoAssets(data.videos);
    return assets.videos;
  })();
  try {
    return await studioVideoRefreshPromise;
  } finally {
    studioVideoRefreshPromise = null;
  }
}

function studioDownloadUrl(relativePath) {
  const encoded = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `/downloads/${encoded}`;
}

function studioInitializeVideoFilters(videos = []) {
  const platformSelect = $('studio-video-platform-filter');
  if (platformSelect) {
    const previous = platformSelect.value;
    const platforms = [...new Set(videos.map((item) => item.platform || 'local'))];
    platformSelect.innerHTML = '<option value="">Tất cả nền tảng</option>' + platforms
      .map((platform) => `<option value="${crawlEscape(platform)}">${crawlEscape(studioVideoPlatformLabels[platform] || platform)}</option>`).join('');
    if (platforms.includes(previous)) platformSelect.value = previous;
    else platformSelect.value = '';
  }
  studioApplyVideoFilters();
}

function studioApplyVideoFilters() {
  const allVideos = Array.isArray(assets.videos) ? assets.videos : [];
  const platform = $('studio-video-platform-filter')?.value || '';
  const mode = $('studio-video-mode-filter')?.value || '';
  const sourceSelect = $('studio-video-source-filter');
  const sourceCandidates = allVideos.filter((item) => (!platform || item.platform === platform) && (!mode || item.mode === mode));
  if (sourceSelect) {
    const previous = sourceSelect.value;
    const sources = [...new Set(sourceCandidates.map((item) => item.source).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
    sourceSelect.innerHTML = '<option value="">Mọi nguồn</option>' + sources
      .map((source) => `<option value="${crawlEscape(source)}">${crawlEscape(source)}</option>`).join('');
    sourceSelect.value = sources.includes(previous) ? previous : '';
  }
  const source = sourceSelect?.value || '';
  const filtered = sourceCandidates.filter((item) => !source || item.source === source);
  if ($('studio-video-filter-summary')) $('studio-video-filter-summary').textContent = `${filtered.length}/${allVideos.length} video`;
  renderVideoGrid(filtered);
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

    const videoUrl = studioDownloadUrl(item.filename);
    const displayName = item.name || String(item.filename).split(/[\\/]/).pop();
    const platformLabel = studioVideoPlatformLabels[item.platform] || item.platform || 'Tải đơn lẻ';
    const modeLabel = studioVideoModeLabels[item.mode] || '';

    card.innerHTML = `
      <div class="video-card-thumb">
        <video src="${videoUrl}" preload="metadata" muted playsinline></video>
        <div class="video-card-play-icon">▶</div>
        <div class="video-card-duration">--:--</div>
      </div>
      <div class="video-card-info">
        <div class="video-card-name" title="${crawlEscape(item.filename)}">${crawlEscape(displayName)}</div>
        <div class="video-card-meta">${crawlEscape(platformLabel)}${modeLabel ? ` · ${crawlEscape(modeLabel)}` : ''}${item.source ? ` · ${crawlEscape(item.source)}` : ''}</div>
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
      videoEl.play().catch(() => { });
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

    const videoUrl = studioDownloadUrl(item.filename);
    const displayName = item.name || String(item.filename).split(/[\\/]/).pop();

    card.innerHTML = `
      <div class="video-card-thumb">
        <video src="${videoUrl}" preload="metadata" muted playsinline></video>
        <div class="video-card-play-icon">▶</div>
        <div class="video-card-duration">--:--</div>
      </div>
      <div class="video-card-info">
        <div class="video-card-name" title="${crawlEscape(item.filename)}">${crawlEscape(displayName)}</div>
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
      videoEl.play().catch(() => { });
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
    video.play().catch(() => { });
    const placeholder = pipEl.querySelector('.reaction-placeholder-box');
    if (placeholder) placeholder.classList.add('hidden');

    const onReactionMetadataLoaded = () => {
      updateReactionPreview();
    };

    if (video.readyState >= 1) {
      onReactionMetadataLoaded();
    } else {
      video.onloadedmetadata = onReactionMetadataLoaded;
    }
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

// [Canvas Module content moved to js/canvas-module.js]

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
    if (maxLinesSelect) subtitleParts.push(`Dòng: ${getSelectedText(maxLinesSelect)}`);
    if (marginInput) subtitleParts.push(`Lề dọc: ${marginInput.value}px`);
    if (marginHInput) subtitleParts.push(`Lề ngang: ${marginHInput.value}px`);

    summary.push(`<div>📝 <b>Phụ đề:</b> ${subtitleParts.join(' | ') || 'Không thiết lập'}</div>`);
  }

  // Che phụ đề gốc
  if (blurBoxes && blurBoxes.length > 0) {
    const details = blurBoxes.map((box, idx) => {
      const startSec = Number(box.start || 0).toFixed(1);
      const endSec = box.end === 99999 ? 'Hết video' : `${Number(box.end || 0).toFixed(1)}s`;
      return `Vùng ${idx + 1}: ${startSec}s - ${endSec}`;
    }).join(' | ');
    summary.push(`<div>🛡️ <b>Che chữ gốc:</b> Làm mờ (${blurBoxes.length} vùng)<br><span style="color: var(--muted); font-size: 11px; margin-left: 20px;">➔ ${details}</span></div>`);
  }

  // 2. Thuyết minh (Voiceover)
  const voiceModeInput = $('voice-mode');
  let voiceModeVal = 'none';
  if (voiceModeInput) {
    let voiceModeText = 'Không chèn';
    voiceModeVal = voiceModeInput.value;
    if (voiceModeVal === 'saved') voiceModeText = 'Giọng thuyết minh đã lưu';
    else if (voiceModeVal === 'upload') voiceModeText = 'Tải lên file mới';
    else if (voiceModeVal === 'omi' || voiceModeVal === 'cloner') voiceModeText = 'Thuyết minh AI tự động';

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

  // 5. Cấu hình pipeline thuyết minh AI
  if (voiceModeVal === 'omi' || voiceModeVal === 'cloner') {
    const outputLang = document.getElementById('global-output-lang');
    const omiDevice = document.querySelector('select[name="omiDevice"]');
    const omiSteps = document.querySelector('input[name="omiSteps"]');
    const omiSeed = $('omi-seed-preset');
    const omiCustomSeed = $('omi-seed-input');
    const voiceEngine = $('voice-engine-select');
    const allowCpuFallback = $('voice-allow-cpu-fallback');

    let clonerParts = [];
    if (voiceEngine) clonerParts.push(`Engine: ${getSelectedText(voiceEngine)}`);
    if (outputLang) clonerParts.push(`Ngôn ngữ: ${outputLang.options[outputLang.selectedIndex].text}`);
    if (omiDevice) clonerParts.push(`Thiết bị: ${getSelectedText(omiDevice)}`);
    if (omiSteps) clonerParts.push(`Bước (Steps): ${omiSteps.value}`);
    if (omiSeed && omiSeed.value === 'custom' && omiCustomSeed) {
      clonerParts.push(`Seed: ${omiCustomSeed.value}`);
    } else if (omiSeed) {
      clonerParts.push(`Seed: ${omiSeed.value}`);
    }
    clonerParts.push(`Fallback CPU: ${allowCpuFallback?.checked ? 'Cho phép' : 'Không'}`);
    summary.push(`<div>🤖 <b>Thuyết minh AI:</b> ${clonerParts.join(' | ')}</div>`);
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
    subtitleMarginL: document.querySelector('input[name="subtitleMarginL"]')?.value || '',
    subtitleMarginR: document.querySelector('input[name="subtitleMarginR"]')?.value || '',
    subtitleTemplateWidth: konvaStage ? konvaStage.width() : ($('preview-aspect-select')?.value === '16-9' ? 1920 : 1080),
    blurOriginalSub: (blurBoxes && blurBoxes.length > 0),
    blurBoxes: blurBoxes,
    voiceMode: $('voice-mode').value,
    savedVoiceFile: $('saved-voice-select').value,
    voiceEngine: $('voice-engine-select')?.value || 'current-omnivoice',
    edgeVoice: $('edge-voice-select')?.value || 'vi-VN-HoaiMyNeural',
    piperVoice: $('piper-voice-select')?.value || 'ngochuyen',
    piperDevice: $('piper-device-select')?.value || 'auto',
    edgeRate: $('edge-rate-select')?.value || '+0%',
    edgePitch: $('edge-pitch-select')?.value || '+0Hz',
    omiLanguage: document.getElementById('global-output-lang')?.value || 'vi',
    omiDevice: document.querySelector('select[name="omiDevice"]').value,
    omiSteps: document.querySelector('input[name="omiSteps"]').value,
    omiSeed: $('omi-seed-preset').value,
    omiCustomSeed: $('omi-seed-input').value,
    musicMode: $('music-mode').value,
    savedMusicFile: $('saved-music-select').value,
    logoMode: $('logo-mode')?.value || 'none',
    logoEnabled: $('logo-mode')?.value === 'saved',
    savedLogoFile: $('saved-logo-select')?.value || '',
    logoPosition: $('logo-position')?.value || 'br',
    logoXPercent: $('logo-x-percent')?.value || '80',
    logoYPercent: $('logo-y-percent')?.value || '85',
    logoWidthPercent: $('logo-width-percent')?.value || '18',
    logoOpacity: $('logo-opacity')?.value || '0.9',
    logoStart: $('logo-start')?.value || '0',
    logoEnd: $('logo-end')?.value || '',
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
          <button type="button" onclick="deleteCustomTemplate(event, '${name}')" class="delete-template-btn" style="background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 4px; transition: all 0.2s;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
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
  // Bố cục dòng hiện tự động theo tỷ lệ video; template cũ có giá trị 1/2/3
  // cũng được nâng về chế độ tự động để không tách cue/timestamp.
  document.querySelector('select[name="subtitleMaxLines"]').value = '0';
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

  // Khôi phục marginL và marginR nếu có
  const marginLInput = document.querySelector('input[name="subtitleMarginL"]');
  const marginRInput = document.querySelector('input[name="subtitleMarginR"]');
  if (marginLInput) marginLInput.value = template.subtitleMarginL || '';
  if (marginRInput) marginRInput.value = template.subtitleMarginR || '';

  blurBoxes = template.blurBoxes || [];
  activeBlurBoxId = blurBoxes.length > 0 ? blurBoxes[0].id : null;
  renderBlurBoxesList();

  // Restore voice engine before opening voice mode so Edge TTS does not depend on OmniVoice.
  const voiceEngineSelect = $('voice-engine-select');
  if (voiceEngineSelect && template.voiceEngine) {
    voiceEngineSelect.value = template.voiceEngine;
    voiceEngineSelect.dispatchEvent(new Event('change'));
  }
  if ($('edge-voice-select') && template.edgeVoice) $('edge-voice-select').value = template.edgeVoice;
  if ($('piper-voice-select') && template.piperVoice) $('piper-voice-select').value = template.piperVoice;
  if ($('piper-device-select') && template.piperDevice) $('piper-device-select').value = template.piperDevice;
  if ($('edge-rate-select') && template.edgeRate) $('edge-rate-select').value = template.edgeRate;
  if ($('edge-pitch-select') && template.edgePitch) $('edge-pitch-select').value = template.edgePitch;

  // Restore voice mode
  const voiceModeBtn = document.querySelector(`.voice-tab-btn[data-voice-mode="${template.voiceMode}"]`);
  if (voiceModeBtn) {
    voiceModeBtn.click();
  }
  if (template.savedVoiceFile) {
    $('saved-voice-select').value = template.savedVoiceFile;
  }

    // Restore Omi settings
  const globalLangSel = document.getElementById('global-output-lang');
  if (globalLangSel) {
    const langMap = { 'Vietnamese': 'vi', 'English': 'en', 'Chinese': 'zh' };
    globalLangSel.value = langMap[template.omiLanguage] || template.omiLanguage || 'vi';
    globalLangSel.dispatchEvent(new Event('change'));
  }
  document.querySelector('select[name="omiDevice"]').value = template.omiDevice;

  const stepsSlider = document.querySelector('input[name="omiSteps"]');
  if (stepsSlider) {
    stepsSlider.value = template.omiSteps;
    const stepsBadge = $('omi-steps-badge');
    if (stepsBadge) stepsBadge.textContent = template.omiSteps;
  }

  const omiSeedPreset = $('omi-seed-preset');
  if (omiSeedPreset) {
    omiSeedPreset.value = template.omiSeed || '42';
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

  const templateLogoMode = template.logoMode || ((template.logoEnabled === true || template.logoEnabled === 'true') ? 'saved' : 'none');
  const logoModeBtn = document.querySelector(`.logo-tab-btn[data-logo-mode="${templateLogoMode}"]`);
  if (logoModeBtn) logoModeBtn.click();
  if ($('saved-logo-select')) $('saved-logo-select').value = template.savedLogoFile || '';
  if ($('logo-position')) $('logo-position').value = template.logoPosition || 'br';
  if ($('logo-x-percent')) $('logo-x-percent').value = template.logoXPercent || '80';
  if ($('logo-y-percent')) $('logo-y-percent').value = template.logoYPercent || '85';
  if ($('logo-width-percent')) $('logo-width-percent').value = template.logoWidthPercent || '18';
  if ($('logo-opacity')) $('logo-opacity').value = template.logoOpacity || '0.9';
  if ($('logo-start')) $('logo-start').value = template.logoStart || '0';
  if ($('logo-end')) $('logo-end').value = template.logoEnd || '';
  updateLogoUi();

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
      // Không clear preview, giữ video đã chọn
    } else {
      $('video-upload').value = '';
      $('upload-video-preview').removeAttribute('src');
      $('upload-video-preview-container').classList.add('hidden');
      // Khôi phục preview nếu đã có video library được chọn
      const selectedFile = $('selected-video-file')?.value;
      if (selectedFile) {
        setPreviewVideo(studioDownloadUrl(selectedFile));
      }
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
      // Không clear preview, giữ video đã chọn
    } else if (mode === 'library') {
      $('reaction-upload').value = '';
      const preview = $('reaction-upload-preview');
      if (preview) preview.removeAttribute('src');
      const container = $('reaction-upload-preview-container');
      if (container) container.classList.add('hidden');
      // Khôi phục preview nếu đã có reaction video được chọn
      const selectedFile = $('selected-reaction-video-file')?.value;
      if (selectedFile) {
        setPreviewReactionVideo(studioDownloadUrl(selectedFile));
      }
    } else {
      // "none" mode: clear reaction hoàn toàn
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
$('video-upload').addEventListener('change', async function () {
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

// Kiểm tra định dạng file audio cho phép
function isAllowedAudioFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'mp4'].includes(ext);
}

// Voice upload validation
$('voice-upload').addEventListener('change', function() {
  if (this.files && this.files[0] && !isAllowedAudioFile(this.files[0].name)) {
    toast('❌ Chỉ hỗ trợ file audio (.mp3, .wav, .m4a, .aac, .ogg)', 'error');
    this.value = '';
  }
});

// Local music upload preview and auto-upload handler
$('music-upload').addEventListener('change', async function () {
  const container = $('upload-music-preview-container');
  const audio = $('upload-music-preview');
  const nameEl = $('upload-music-name');
  const sizeEl = $('upload-music-size');

  if (this.files && this.files[0]) {
    const file = this.files[0];
    if (!isAllowedAudioFile(file.name)) {
toast('❌ Chỉ hỗ trợ file audio/video (.mp3, .wav, .m4a, .aac, .ogg, .mp4)', 'error');
      this.value = '';
      container.classList.add('hidden');
      return;
    }
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
$('keep-bgm-ai')?.addEventListener('change', updateMdxProviderUI);
$('mdx-provider-select')?.addEventListener('change', updateMdxProviderUI);
$('mdx-cuda-install-btn')?.addEventListener('click', installMdxCudaComponent);
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

// Space bar to toggle preview video play/pause
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.code === 'Space') {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    e.preventDefault();
    const video = document.getElementById('studio-video-preview');
    if (video && video.src && video.src !== '') {
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  }
});

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

// Anti-dupe + watermark fields → realtime preview update
['antidupe-watermark', 'antidupe-wm-pos', 'antidupe-wm-size', 'antidupe-wm-color-input', 'antidupe-wm-alpha', 'antidupe-start', 'antidupe-end'].forEach(id => {
  const el = $(id);
  if (el) {
    el.addEventListener('input', () => updateSubtitleOverlayFromInputs());
    el.addEventListener('change', () => updateSubtitleOverlayFromInputs());
  }
});

// Khi user chỉnh marginH bằng tay → đồng bộ marginL = marginR = marginH (đối xứng)
const marginHSyncEl = document.querySelector('input[name="subtitleMarginH"]');
if (marginHSyncEl) {
  const syncMarginLR = (e) => {
    if (e && e.isTrusted) {
      const val = marginHSyncEl.value;
      const mL = document.querySelector('input[name="subtitleMarginL"]');
      const mR = document.querySelector('input[name="subtitleMarginR"]');
      if (mL) mL.value = val;
      if (mR) mR.value = val;
    }
  };
  marginHSyncEl.addEventListener('input', syncMarginLR);
  marginHSyncEl.addEventListener('change', syncMarginLR);
}

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

// Color swatches for watermark
const wmColorSwatches = $('wm-color-swatches');
if (wmColorSwatches) {
  wmColorSwatches.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      wmColorSwatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      const input = $('antidupe-wm-color-input');
      if (input) {
        input.value = swatch.dataset.color;
        input.dispatchEvent(new Event('input'));
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
const previewVideo = document.getElementById('studio-video-preview');
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
    updateLabel();
  }
});

// Connect original volume slider to preview video in real-time
const origSlider = document.querySelector('[name="originalVolume"]');
if (origSlider && previewVideo) {
  const syncVolume = () => {
    const vol = Math.min(sliderToVolume(origSlider.value), 1);
    previewVideo.volume = vol;
    previewVideo.muted = (vol === 0);
  };
  origSlider.addEventListener('input', syncVolume);
  origSlider.addEventListener('change', syncVolume);
  syncVolume();
}

// === Preview audio sync: thuyết minh & nhạc nền ===
const voiceAudio = document.getElementById('preview-voice-audio');
const musicAudio = document.getElementById('preview-music-audio');

function updatePreviewAudioSources() {
  if (!voiceAudio || !musicAudio) return;
  const voiceMode = document.querySelector('[name="voiceMode"]')?.value;
  const musicMode = document.querySelector('[name="musicMode"]')?.value;
  const voiceFile = document.getElementById('saved-voice-select')?.value;
  const musicFile = document.getElementById('saved-music-select')?.value;

  if (voiceMode && voiceMode !== 'none' && voiceFile) {
    voiceAudio.src = '/voices/' + encodeURIComponent(voiceFile);
  } else {
    voiceAudio.pause();
    voiceAudio.src = '';
  }
  if (musicMode && musicMode !== 'none' && musicFile) {
    musicAudio.src = '/music/' + encodeURIComponent(musicFile);
  } else {
    musicAudio.pause();
    musicAudio.src = '';
  }
}

// Sync play/pause/seek with video
if (previewVideo && voiceAudio && musicAudio) {
  voiceAudio.loop = true;
  musicAudio.loop = true;

  previewVideo.addEventListener('play', () => {
    if (typeof applyMixerVolumes === 'function') applyMixerVolumes();
    if (voiceAudio.src) voiceAudio.play().catch(() => {});
    if (musicAudio.src) musicAudio.play().catch(() => {});
  });
  previewVideo.addEventListener('pause', () => {
    voiceAudio.pause();
    musicAudio.pause();
  });
  previewVideo.addEventListener('seeked', () => {
    const t = previewVideo.currentTime;
    if (voiceAudio.src) {
      voiceAudio.currentTime = t;
      if (!previewVideo.paused) voiceAudio.play().catch(() => {});
    }
    if (musicAudio.src) {
      musicAudio.currentTime = t;
      if (!previewVideo.paused) musicAudio.play().catch(() => {});
    }
  });
  previewVideo.addEventListener('ended', () => {
    voiceAudio.pause();
    musicAudio.pause();
  });

  // Sync volume từ mixer sliders
  const voiceSlider = document.querySelector('[name="voiceVolume"]');
  const musicSlider = document.querySelector('[name="musicVolume"]');
  const syncVoiceVol = () => { voiceAudio.volume = Math.min(sliderToVolume(voiceSlider.value), 1); };
  const syncMusicVol = () => { musicAudio.volume = Math.min(sliderToVolume(musicSlider.value), 1); };
  if (voiceSlider) {
    voiceSlider.addEventListener('input', syncVoiceVol);
    voiceSlider.addEventListener('change', syncVoiceVol);
    syncVoiceVol();
  }
  if (musicSlider) {
    musicSlider.addEventListener('input', syncMusicVol);
    musicSlider.addEventListener('change', syncMusicVol);
    syncMusicVol();
  }
}

// Áp dụng âm lượng mixer lên preview (cho cả 3 kênh)
function applyMixerVolumes() {
  const previewVideo = document.getElementById('studio-video-preview');
  const voiceAudio = document.getElementById('preview-voice-audio');
  const musicAudio = document.getElementById('preview-music-audio');

  const origSlider = document.querySelector('[name="originalVolume"]');
  if (origSlider) {
    const vol = Math.min(sliderToVolume(origSlider.value), 1);
    console.log('[Mixer] originalVolume:', origSlider.value, '→ vol:', vol);
    if (previewVideo) {
      previewVideo.volume = vol;
      previewVideo.muted = (vol === 0);
    }
  }

  const voiceSlider = document.querySelector('[name="voiceVolume"]');
  if (voiceSlider) {
    const vol = Math.min(sliderToVolume(voiceSlider.value), 1);
    console.log('[Mixer] voiceVolume:', voiceSlider.value, '→ vol:', vol);
    if (voiceAudio) voiceAudio.volume = vol;
  }

  const musicSlider = document.querySelector('[name="musicVolume"]');
  if (musicSlider) {
    const vol = Math.min(sliderToVolume(musicSlider.value), 1);
    console.log('[Mixer] musicVolume:', musicSlider.value, '→ vol:', vol);
    if (musicAudio) musicAudio.volume = vol;
  }
}

// Cập nhật audio sources khi chọn giọng/nhạc khác
document.addEventListener('change', (e) => {
  if (e.target.id === 'saved-voice-select' || e.target.id === 'saved-music-select') {
    updatePreviewAudioSources();
  }
  if (e.target.id === 'global-output-lang') {
    updateOutputLangInfo();
  }
});
['voiceMode', 'musicMode'].forEach(name => {
  const el = document.querySelector(`[name="${name}"]`);
  if (el) el.addEventListener('change', updatePreviewAudioSources);
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
$('reaction-audio').addEventListener('change', function () {
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
    let selectedEngine = $('voice-engine-select')?.value || assets.defaultVoiceEngineId;
    const selectedDescriptor = (assets.voiceEngines || []).find((engine) => engine.id === selectedEngine);
    if (mode === 'omi' && selectedDescriptor?.status?.ready !== true && e && e.isTrusted) {
      const edgeReady = (assets.voiceEngines || []).some(
        (engine) => engine.id === 'edge-tts' && engine.status?.ready
      );
      if (edgeReady && $('voice-engine-select')) {
        $('voice-engine-select').value = 'edge-tts';
        $('voice-engine-select').dispatchEvent(new Event('change'));
        selectedEngine = 'edge-tts';
      } else {
        toast('⚠️ Chưa có engine thuyết minh sẵn sàng. Hãy cài runtime hoặc kiểm tra kết nối.', 'warn');
        openModelDownloadModal();
        return;
      }
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
      $('ocr-settings-container')?.classList.toggle('hidden', mode !== 'generate');
      updateOcrRegionOverlay();
      if (mode === 'generate' && $('subtitle-engine-value')?.value !== 'whisper' && !usesRapidOcrUi()) {
        refreshOcrComponentStatusForUi();
      }
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
  const grid = $('page-cards-grid');
  const countBadge = $('page-count-badge');
  const paginationContainer = $('page-pagination');
  if (!container || !grid) return;

  grid.innerHTML = '';
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
    grid.innerHTML = `
      <div class="empty-state-block" style="grid-column: 1 / -1;">
        <div class="esb-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
          </svg>
        </div>
        <h4>${searchVal ? 'Không tìm thấy Page nào phù hợp' : 'Chưa có Fanpage nào được lưu'}</h4>
        <p>${searchVal ? 'Thử tìm kiếm với từ khóa khác' : 'Nhấn "THÊM PAGE MỚI" ở trên để kết nối trang Facebook của bạn'}</p>
        ${!searchVal ? `<button type="button" onclick="openPageModal()" style="margin-top:4px;background:var(--accent);color:white;font-weight:600;padding:8px 18px;border-radius:var(--radius);">Thêm Page đầu tiên</button>` : ''}
      </div>
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
    const initials = page.name.charAt(0).toUpperCase() || 'F';

    const card = document.createElement('div');
    card.className = 'page-card';

    card.innerHTML = `
      <div class="page-card-header">
        <div class="page-card-avatar">${initials}</div>
        <div class="page-card-info">
          <div class="page-card-name" title="${page.name}">${page.name}</div>
          ${page.pageName && page.pageName !== page.name ? `<div style="font-size: 11px; color: var(--accent-2); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Tên Facebook: ${page.pageName}">📘 ${page.pageName}</div>` : ''}
          <div class="page-card-id">ID: ${page.id}</div>
        </div>
      </div>
      <div class="page-card-actions">
        <button type="button" class="ghost-btn" style="flex:1;font-size:12px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;" onclick="editFbPage(${originalIdx})">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Chỉnh sửa
        </button>
        <button type="button" class="ghost-btn" style="flex:1;font-size:12px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;border-color:rgba(239,68,68,0.25);color:var(--danger);" onclick="deleteFbPage(${originalIdx})">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          Xóa
        </button>
      </div>
    `;
    grid.appendChild(card);
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
    // Ẩn preview tên page
    const preview = $('page-name-preview');
    if (preview) preview.style.display = 'none';

    modal.classList.remove('hidden');
  }
}

function closePageModal() {
  const modal = $('page-modal');
  if (modal) {
    modal.classList.add('hidden');
    // Ẩn preview tên page khi đóng
    const preview = $('page-name-preview');
    if (preview) preview.style.display = 'none';
  }
}

async function lookupPageNameFromId() {
  const idInput = $('page-input-id');
  const tokenInput = $('page-input-token');
  const preview = $('page-name-preview');
  const previewText = $('page-name-preview-text');
  const reloadBtn = $('reload-page-name-btn');
  const icon = $('reload-page-icon');

  const id = idInput ? idInput.value.trim() : '';
  const token = tokenInput ? tokenInput.value.trim() : '';

  if (!id) {
    toast('Vui lòng nhập Page ID trước!', 'error');
    return;
  }
  if (!token) {
    toast('Vui lòng nhập Access Token để tra tên Page!', 'error');
    return;
  }

  // Hiệu ứng xoay icon
  if (icon) icon.style.animation = 'spin 1s linear infinite';
  if (reloadBtn) reloadBtn.disabled = true;

  // Thêm keyframe spin nếu chưa có
  if (!document.getElementById('spin-keyframe-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'spin-keyframe-style';
    styleEl.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.head.appendChild(styleEl);
  }

  try {
    const res = await fetch('/api/verify-facebook-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: id, pageToken: token })
    });
    const contentType = res.headers.get('content-type');
    let result;
    if (contentType && contentType.includes('application/json')) {
      result = await res.json();
    } else {
      throw new Error('Lỗi kết nối server');
    }
    if (!res.ok) throw new Error(result.error || 'Không thể lấy tên Page');

    // Hiển thị tên page tìm được
    if (previewText) previewText.textContent = result.name;
    if (preview) {
      preview.style.display = 'flex';
    }

    // Tự động điền vào ô Tên gợi nhớ nếu đang trống
    const nameInput = $('page-input-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = result.name;
    }

    toast(`✅ Tìm thấy Page: ${result.name}`, 'success');
  } catch (error) {
    toast('❌ Không lấy được tên Page: ' + error.message, 'error');
    if (preview) preview.style.display = 'none';
  } finally {
    if (icon) icon.style.animation = '';
    if (reloadBtn) reloadBtn.disabled = false;
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
      fbPages[editIndex] = { name, id, token, pageName: result.name };
      toast(`🎉 Đã cập nhật thành công Page: ${result.name}!`, 'success');
    } else {
      // Thêm mới
      fbPages.push({ name, id, token, pageName: result.name });
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

  // Hiện preview tên Facebook nếu đã có
  const preview = $('page-name-preview');
  const previewText = $('page-name-preview-text');
  if (preview && previewText) {
    if (page.pageName) {
      previewText.textContent = page.pageName;
      preview.style.display = 'flex';
    } else {
      preview.style.display = 'none';
    }
  }

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
    fbPageSelect.addEventListener('change', function () {
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
function initOutputLang() {
  updateOutputLangInfo();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initFbPages();
    initRenderedVideos();
    initVoicesAndMusic();
    loadDownloadHistory();
    initGeminiModelListeners();
    initOpenRouterModelListeners();
    initNineRouterModelListeners();
    initActiveProject();
    initOutputLang();
  });
} else {
  initFbPages();
  initRenderedVideos();
  initVoicesAndMusic();
  loadDownloadHistory();
  initGeminiModelListeners();
  initOpenRouterModelListeners();
  initNineRouterModelListeners();
  initActiveProject();
  initOutputLang();
}

/* ==========================================================================
   HÀM BỔ TRỢ PHÁT AUDIO (AUDIO PLAYBACK HELPER)
   ========================================================================== */
let currentAudio = null;
let currentAudioUrl = null;
let currentPlayBtn = null;

// [Library Module content moved to js/library-module.js]

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
  } catch (e) { }

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
      <button type="button" class="ghost-btn rendered-btn-delete" style="padding: 4px 8px; font-size: 11px; height: 26px; min-height: 26px; display: inline-flex; align-items: center; margin: 0; border-color: rgba(239, 68, 68, 0.2);" onclick="deleteSavedLink('${item.id}'); event.stopPropagation();">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
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
      <button type="button" class="ghost-btn rendered-btn-delete" style="padding: 4px 8px; font-size: 11px; height: 26px; min-height: 26px; display: inline-flex; align-items: center; margin: 0; border-color: rgba(239, 68, 68, 0.2);" onclick="deleteSavedChannel('${item.id}'); event.stopPropagation();">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
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

// ===== CÀO NGAY: preview đa nền tảng + chống trùng + hàng đợi tải tuần tự =====
function crawlLoadRecordedTaskIds() {
  try {
    const values = JSON.parse(localStorage.getItem('crawlRecordedTaskIds') || '[]');
    return new Set(Array.isArray(values) ? values : []);
  } catch (_) {
    return new Set();
  }
}

function crawlSaveRecordedTaskIds(ids) {
  try {
    localStorage.setItem('crawlRecordedTaskIds', JSON.stringify(Array.from(ids).slice(-500)));
  } catch (_) {}
}

const crawlNowState = {
  platform: 'youtube',
  mode: 'search',
  capabilities: {},
  engine: null,
  engines: [],
  previewItems: [],
  selected: new Set(),
  pollTimer: null,
  recordedSuccess: crawlLoadRecordedTaskIds(),
  studioRefreshSuccess: new Set(),
  lastSnapshot: null,
  previewBaseCount: 100,
  previewRequestedCount: 100,
  previewLoadingMore: false
};
const hiddenCrawlPlatforms = new Set(['weibo', 'twitter', 'reddit']);

function crawlEscape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function crawlFormatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '--:--';
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function crawlSetBusy(busy, label = '') {
  const previewButton = $('crawl-preview-btn');
  const previewModes = crawlNowState.capabilities[crawlNowState.platform]?.previewModes || [];
  if (previewButton) previewButton.disabled = busy || !previewModes.includes(crawlNowState.mode);
  const crawlAllButton = $('crawl-all-btn');
  if (crawlAllButton) crawlAllButton.disabled = busy;
  const pill = $('crawl-now-ready');
  if (pill) {
    pill.classList.toggle('busy', busy);
    pill.textContent = label || (busy ? 'Đang xử lý' : 'Sẵn sàng');
  }
}

function crawlCurrentRequest() {
  return {
    platform: crawlNowState.platform,
    mode: crawlNowState.mode,
    input: $('crawl-now-input')?.value?.trim() || '',
    count: Number($('crawl-now-count')?.value || 100),
    sort: $('crawl-now-sort')?.value || 'relevance',
    timeDays: Number($('crawl-now-time')?.value || 0),
    quality: $('crawl-now-quality')?.value || '1080',
    language: $('crawl-now-language')?.value || '',
    deepNew: $('crawl-now-skip-dupe')?.checked !== false
  };
}

function crawlKeywordList() {
  return ($('crawl-now-input')?.value || '').split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
}

async function crawlTranslateKeywords(silent = false) {
  const keywords = crawlKeywordList();
  if (!keywords.length) {
    if (!silent) toast('Hãy nhập từ khóa trước.', 'error');
    return [];
  }
  try {
    const response = await fetch('/api/download-crawl/translate-keywords', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords, target: $('crawl-now-language')?.value || 'zh-CN' })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không dịch được từ khóa.');
    if ($('crawl-now-input')) $('crawl-now-input').value = (data.translated || []).join('\n');
    if (!silent) toast('Đã dịch từ khóa sang tiếng Trung.', 'success');
    return data.translated || [];
  } catch (error) {
    if (!silent) toast(error.message, 'error');
    return [];
  }
}

async function crawlPrepareRequest() {
  const chinesePlatforms = ['douyin', 'bilibili', 'xiaohongshu', 'rednote', 'weibo'];
  if (crawlNowState.mode === 'search' && chinesePlatforms.includes(crawlNowState.platform)) {
    const keywords = crawlKeywordList();
    if (keywords.some((value) => !/[\u3400-\u9fff]/.test(value))) await crawlTranslateKeywords(true);
  }
  return crawlCurrentRequest();
}

function crawlUpdateModeUi() {
  const labels = {
    search: ['Từ khóa', 'Nhập từ khóa tìm kiếm...'],
    detail: ['Link video', 'Dán link video, mỗi dòng một link...'],
    creator: ['Link kênh / tài khoản', 'Dán link kênh, playlist hoặc @tên-kênh...'],
    chase: ['Link video trong bộ', 'Dán link playlist/bộ hoặc một video thuộc bộ...']
  };
  const [label, placeholder] = labels[crawlNowState.mode] || labels.detail;
  if ($('crawl-now-input-label')) $('crawl-now-input-label').textContent = label;
  if ($('crawl-now-input')) $('crawl-now-input').placeholder = placeholder;
  if ($('crawl-translate-keywords')) $('crawl-translate-keywords').classList.toggle('hidden', crawlNowState.mode !== 'search');
  document.querySelectorAll('#crawl-mode-tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === crawlNowState.mode);
  });
  crawlUpdateCapabilities();
}

function crawlUpdateCapabilities() {
  const caps = crawlNowState.capabilities[crawlNowState.platform] || {};
  $('crawl-now-quality-wrap')?.classList.toggle('hidden', crawlNowState.platform !== 'bilibili');
  const previewModes = Array.isArray(caps.previewModes) ? caps.previewModes : [];
  document.querySelectorAll('#crawl-mode-tabs button').forEach((button) => {
    button.disabled = caps[button.dataset.mode] === false;
    button.title = button.disabled ? 'Bộ tải hiện tại chưa hỗ trợ chế độ này cho nền tảng đã chọn' : '';
  });
  const previewButton = $('crawl-preview-btn');
  const canPreview = previewModes.includes(crawlNowState.mode);
  if (previewButton) {
    previewButton.disabled = !canPreview;
    previewButton.title = canPreview ? '' : 'Chế độ này vẫn cào được nhưng chưa hỗ trợ xem trước ổn định; hãy dùng Cào hết hoặc Thêm vào hàng đợi.';
  }
}

async function crawlLoadCapabilities() {
  try {
    const response = await fetch('/api/download-crawl/capabilities');
    const data = await response.json();
    crawlNowState.capabilities = data.platforms || {};
    crawlNowState.engine = data.engine || null;
    crawlNowState.engines = data.engines || [];
  } catch (_) {
    crawlNowState.capabilities = {};
    crawlNowState.engine = null;
    crawlNowState.engines = [];
  }
  const engineBadge = $('crawl-engine-badge');
  const installButton = $('crawl-runtime-install-btn');
  if (engineBadge) {
    const ready = crawlNowState.engine?.available;
    const projectReady = crawlNowState.engines.some((engine) => engine.engine === 'Video Studio yt-dlp' && engine.available);
    engineBadge.classList.toggle('unavailable', !ready && !projectReady);
    engineBadge.textContent = ready && projectReady
      ? 'MediaCrawler + Video Studio yt-dlp sẵn sàng'
      : ready ? 'MediaCrawler sẵn sàng' : projectReady ? 'Video Studio yt-dlp sẵn sàng' : 'Crawler chưa sẵn sàng · hãy cài runtime';
    installButton?.classList.toggle('hidden', ready || projectReady);
  }
  crawlUpdateCapabilities();
}

async function crawlInstallRuntime() {
  const button = $('crawl-runtime-install-btn');
  const badge = $('crawl-engine-badge');
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/download-crawl/runtime-install', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không thể bắt đầu cài bộ cào.');
    toast(data.alreadyReady ? 'Bộ cào đã sẵn sàng.' : 'Đang cài bộ cào. Có thể theo dõi trong nhật ký.', 'success');
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const statusResponse = await fetch('/api/download-crawl/runtime-status');
      const status = await statusResponse.json();
      if (badge) badge.textContent = status.status === 'installing'
        ? `Đang cài crawler ${Number(status.percent || 0)}% · ${status.message || 'vui lòng chờ'}`
        : status.message || 'Đang kiểm tra crawler…';
      if (status.ready) {
        toast('Đã cài xong bộ cào video.', 'success');
        await crawlLoadCapabilities();
        break;
      }
      if (status.status === 'error') throw new Error(status.message || 'Cài bộ cào thất bại.');
    }
  } catch (error) {
    toast(error.message, 'error');
    await crawlLoadCapabilities();
  } finally {
    if (button) button.disabled = false;
  }
}

async function crawlLoadLoginStatus() {
  try {
    const response = await fetch('/api/download-crawl/login-status');
    const data = await response.json();
    const platforms = data.platforms || {};
    const labels = {
      douyin: ['Douyin', '抖', 'dy'], bilibili: ['Bilibili', '哔', 'bili'],
      xiaohongshu: ['Xiaohongshu', '小', 'xhs'], rednote: ['RedNote', 'R', 'rednote'],
      youtube: ['YouTube', '▶', 'youtube'], tiktok: ['TikTok', '♪', 'tiktok'],
      facebook: ['Facebook', 'f', 'facebook'], instagram: ['Instagram', '◎', 'instagram']
    };
    const grid = $('crawl-login-grid');
    if (grid) grid.innerHTML = Object.entries(labels).map(([key, config]) => {
      const [label, icon, theme] = config;
      const status = platforms[key] || 'out';
      const text = status === 'in' ? 'Đã đăng nhập' : status === 'na' ? 'Không bắt buộc' : 'Chưa đăng nhập';
      const action = status === 'in' ? 'Mở lại' : status === 'na' ? 'Mở nền tảng' : 'Đăng nhập';
      return `<button type="button" class="crawl-login-card ${status} ${theme}" onclick="crawlOpenPlatformLogin('${key}')">
        <span class="crawl-login-icon">${icon}</span><span class="crawl-login-state"><i></i>${text}</span>
        <b>${label}</b><span class="crawl-login-action">${action}</span></button>`;
    }).join('');
  } catch (_) {}
}

async function crawlOpenPlatformLogin(platform) {
  if (['douyin', 'bilibili', 'xiaohongshu', 'rednote', 'weibo', 'tiktok', 'facebook', 'instagram', 'twitter'].includes(platform)) {
    try {
      const response = await fetch('/api/download-crawl/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform })
      });
      const data = await response.json();
      if (response.ok) {
        toast(data.message || 'Đã mở cửa sổ đăng nhập.', 'success');
        return;
      }
    } catch (_) {}
  }
  openCookieModal();
  const select = $('cookie-platform-select');
  const mapped = platform;
  if (select && Array.from(select.options).some((option) => option.value === mapped)) select.value = mapped;
}

async function crawlRefreshStats() {
  try {
    const date = $('crawl-date-filter')?.value || '';
    const response = await fetch(`/api/download-crawl/stats?date=${encodeURIComponent(date)}`);
    const data = await response.json();
    if ($('stat-today-downloads')) $('stat-today-downloads').textContent = data.today || 0;
    if ($('stat-error-count')) $('stat-error-count').textContent = data.errors || 0;
    for (const platform of Object.keys(crawlNowState.capabilities)) {
      const el = $(`crawl-count-${platform}`);
      if (el) el.textContent = `${data.byPlatform?.[platform] || 0} đã cào`;
    }
    const select = $('crawl-date-filter');
    if (select && select.options.length <= 1) {
      for (const value of data.dates || []) select.add(new Option(value, value));
    }
  } catch (_) {}
}

function crawlRefreshAll() {
  crawlLoadCapabilities();
  crawlLoadLoginStatus();
  crawlRefreshStats();
  crawlPollStatus();
  crawlLoadHistory();
}

let crawlHistoryTimer = null;
let crawlHistoryItems = [];
const crawlHistorySelected = new Set();

function crawlScheduleHistory() {
  clearTimeout(crawlHistoryTimer);
  crawlHistoryTimer = setTimeout(crawlLoadHistory, 250);
}

function updateLogoUi() {
  const mode = $('logo-mode')?.value || 'none';
  const filename = $('saved-logo-select')?.value || '';
  const enabled = mode === 'saved' && Boolean(filename);
  if ($('logo-enabled')) $('logo-enabled').checked = mode === 'saved';
  $('logo-saved-wrapper')?.classList.toggle('hidden', mode !== 'saved');
  $('logo-upload-wrapper')?.classList.toggle('hidden', mode !== 'upload');
  $('logo-settings')?.classList.toggle('hidden', !enabled);
  const preview = $('selected-logo-preview');
  const image = $('selected-logo-image');
  const name = $('selected-logo-name');
  preview?.classList.toggle('hidden', !enabled);
  if (image) {
    const nextSrc = filename ? `/logos/${encodeURIComponent(filename)}` : '';
    if (image.getAttribute('src') !== nextSrc) image.src = nextSrc;
  }
  if (name) name.textContent = filename;
  if ($('logo-width-val')) $('logo-width-val').textContent = `${$('logo-width-percent')?.value || 18}%`;
  if ($('logo-opacity-val')) $('logo-opacity-val').textContent = `${Math.round(Number($('logo-opacity')?.value || 0.9) * 100)}%`;
  if (typeof updateSubtitleOverlayFromInputs === 'function') updateSubtitleOverlayFromInputs();
}

async function uploadStudioLogo(file) {
  if (!file) return;
  const data = new FormData();
  data.append('logo', file);
  data.append('logoName', file.name);
  try {
    const response = await fetch('/api/save-logo', { method: 'POST', body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không tải được logo.');
    await loadAssets();
    if ($('saved-logo-select')) $('saved-logo-select').value = result.logo;
    const savedTab = document.querySelector('.logo-tab-btn[data-logo-mode="saved"]');
    if (savedTab) savedTab.click();
    else updateLogoUi();
    toast('Đã thêm logo vào thư viện.', 'success');
  } catch (error) {
    toast(error.message || 'Không tải được logo.', 'error');
  } finally {
    if ($('logo-library-upload')) $('logo-library-upload').value = '';
  }
}

document.querySelectorAll('.logo-tab-btn').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.logo-tab-btn').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    if ($('logo-mode')) $('logo-mode').value = button.dataset.logoMode || 'none';
    updateLogoUi();
  });
});
$('saved-logo-select')?.addEventListener('change', updateLogoUi);
$('logo-library-upload')?.addEventListener('change', (event) => uploadStudioLogo(event.target.files?.[0]));
$('selected-logo-image')?.addEventListener('load', updateLogoUi);
['logo-position', 'logo-width-percent', 'logo-opacity', 'logo-start', 'logo-end'].forEach((id) => {
  $(id)?.addEventListener('input', updateLogoUi);
  $(id)?.addEventListener('change', updateLogoUi);
});

async function crawlLoadHistory() {
  const list = $('crawl-history-list');
  if (!list) return;
  list.innerHTML = '<div class="crawl-history-empty">Đang đọc lịch sử cào...</div>';
  const params = new URLSearchParams({
    platform: $('crawl-history-platform')?.value || '',
    q: $('crawl-history-query')?.value || '',
    onlyUndownloaded: $('crawl-history-undownloaded')?.checked ? '1' : '0',
    days: $('crawl-history-days')?.value || '0',
    limit: '800'
  });
  try {
    const response = await fetch(`/api/download-crawl/history?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không đọc được lịch sử cào.');
    crawlHistoryItems = (Array.isArray(data.items) ? data.items : [])
      .filter((item) => !hiddenCrawlPlatforms.has(String(item.platform || '').toLowerCase()));
    const liveKeys = new Set(crawlHistoryItems.map((item) => item.key));
    for (const key of crawlHistorySelected) if (!liveKeys.has(key)) crawlHistorySelected.delete(key);
    crawlHistoryPopulateSources();
    crawlRenderHistory();
  } catch (error) {
    crawlHistoryItems = [];
    list.innerHTML = `<div class="crawl-history-empty error">${crawlEscape(error.message || 'Không đọc được lịch sử cào.')}</div>`;
  }
}

function crawlHistorySource(item) {
  if (item.sourceMode === 'search') return String(item.sourceInput || item.keyword || item.uploader || '').trim();
  if (item.sourceMode === 'creator') return String(item.sourceName || item.uploader || item.sourceInput || '').trim();
  return String(item.sourceName || item.uploader || item.keyword || '').trim();
}

function crawlHistoryModeLabel(mode) {
  return ({ search: 'Từ khóa', creator: 'Kênh', detail: 'Link', chase: 'Bộ' })[mode] || 'Link';
}

function crawlHistoryPopulateSources() {
  const select = $('crawl-history-source');
  if (!select) return;
  const current = select.value;
  const channels = [...new Set(crawlHistoryItems.filter((item) => item.sourceMode === 'creator').map(crawlHistorySource).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
  const keywords = [...new Set(crawlHistoryItems.filter((item) => item.sourceMode === 'search').map(crawlHistorySource).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
  let html = '<option value="">Mọi kênh / từ khóa</option>';
  if (channels.length) html += `<optgroup label="Kênh (${channels.length})">${channels.map((source) => `<option value="creator:${crawlEscape(source)}">${crawlEscape(source)}</option>`).join('')}</optgroup>`;
  if (keywords.length) html += `<optgroup label="Từ khóa (${keywords.length})">${keywords.map((source) => `<option value="search:${crawlEscape(source)}">${crawlEscape(source)}</option>`).join('')}</optgroup>`;
  select.innerHTML = html;
  if (Array.from(select.options).some((option) => option.value === current)) select.value = current;
}

function crawlHistoryVisibleItems() {
  const source = $('crawl-history-source')?.value || '';
  const mode = $('crawl-history-mode')?.value || '';
  const oldestFirst = $('crawl-history-sort')?.value === 'oldest';
  return crawlHistoryItems
    .filter((item) => !mode || item.sourceMode === mode)
    .filter((item) => !source || `${item.sourceMode}:${crawlHistorySource(item)}` === source)
    .sort((a, b) => oldestFirst ? Number(a.timestamp || 0) - Number(b.timestamp || 0) : Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

function crawlHistoryDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return 'Không rõ ngày';
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value * 1000));
}

function crawlRenderHistory() {
  const list = $('crawl-history-list');
  if (!list) return;
  const items = crawlHistoryVisibleItems();
  const selectedVisible = items.filter((item) => crawlHistorySelected.has(item.key)).length;
  if ($('crawl-history-summary')) $('crawl-history-summary').textContent = `${items.length} video`;
  if ($('crawl-history-selected-count')) $('crawl-history-selected-count').textContent = `Đã chọn ${crawlHistorySelected.size}`;
  const selectAll = $('crawl-history-select-all');
  if (selectAll) {
    selectAll.checked = items.length > 0 && selectedVisible === items.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < items.length;
  }
  const downloadButton = $('crawl-history-download-selected');
  if (downloadButton) downloadButton.disabled = crawlHistorySelected.size === 0;
  if (!items.length) {
    list.innerHTML = '<div class="crawl-history-empty">Chưa có dữ liệu lịch sử phù hợp với bộ lọc.</div>';
    return;
  }
  list.innerHTML = items.map((item) => {
    const encodedKey = encodeURIComponent(item.key).replace(/'/g, '%27');
    const thumbnail = item.thumbnail ? `/api/proxy-image?url=${encodeURIComponent(item.thumbnail)}` : '';
    const source = crawlHistorySource(item) || item.platform;
    return `<article class="crawl-history-item${item.downloaded ? ' downloaded' : ''}">
      <div class="crawl-history-thumb">
        ${thumbnail ? `<img src="${crawlEscape(thumbnail)}" alt="" loading="lazy" decoding="async">` : '<span>▶</span>'}
        <input type="checkbox" aria-label="Chọn video" ${crawlHistorySelected.has(item.key) ? 'checked' : ''} onchange="crawlHistoryToggleItem('${encodedKey}', this.checked)">
        <em>${item.downloaded ? '✓ Đã tải' : 'Chưa tải'}</em>
      </div>
      <div class="crawl-history-content">
        <span class="crawl-history-kind ${crawlEscape(item.sourceMode || 'detail')}">${crawlHistoryModeLabel(item.sourceMode)}</span>
        <b title="${crawlEscape(item.title)}">${crawlEscape(item.title)}</b>
        <small>${crawlEscape(item.platform)} · ${crawlEscape(source)}</small>
        <small>${crawlHistoryDate(item.timestamp)}${item.keyword ? ` · ${crawlEscape(item.keyword)}` : ''}</small>
      </div>
      <div class="crawl-history-actions">
        ${item.url ? `<a href="${crawlEscape(item.url)}" target="_blank" rel="noreferrer">Mở bài gốc</a>` : ''}
        ${item.downloaded && item.mediaPath ? `<button type="button" onclick="crawlHistoryOpenFolder('${encodeURIComponent(item.mediaPath).replace(/'/g, '%27')}')">Mở thư mục</button>` : ''}
        <button type="button" onclick="crawlHistoryDownloadOne('${encodedKey}')">${item.downloaded ? 'Tải lại' : 'Tải video'}</button>
      </div>
    </article>`;
  }).join('');
}

async function crawlHistoryOpenFolder(encodedPath) {
  try {
    const relativePath = decodeURIComponent(encodedPath);
    const response = await fetch(`/api/download-crawl/open-file-folder?path=${encodeURIComponent(relativePath)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không mở được vị trí video.');
  } catch (error) {
    toast(error.message || 'Không mở được vị trí video.', 'error');
    await crawlLoadHistory();
  }
}

function crawlHistoryToggleItem(encodedKey, checked) {
  const key = decodeURIComponent(encodedKey);
  if (checked) crawlHistorySelected.add(key);
  else crawlHistorySelected.delete(key);
  crawlRenderHistory();
}

function crawlHistoryToggleAll(checked) {
  for (const item of crawlHistoryVisibleItems()) {
    if (checked) crawlHistorySelected.add(item.key);
    else crawlHistorySelected.delete(item.key);
  }
  crawlRenderHistory();
}

async function crawlHistoryEnqueue(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.url) continue;
    const sourceMode = item.sourceMode || 'detail';
    const sourceInput = item.sourceInput || '';
    const sourceName = item.sourceName || item.uploader || '';
    const groupKey = `${item.platform}\u0000${sourceMode}\u0000${sourceInput}\u0000${sourceName}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { platform: item.platform, sourceMode, sourceInput, sourceName, urls: [] });
    groups.get(groupKey).urls.push(item.url);
  }
  if (!groups.size) {
    toast('Các mục đã chọn không có link video hợp lệ.', 'error');
    return;
  }
  let queued = 0;
  try {
    for (const { platform, sourceMode, sourceInput, sourceName, urls } of groups.values()) {
      const response = await fetch('/api/download-crawl/enqueue-job', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, mode: 'detail', input: urls.join('\n'), count: urls.length, deepNew: false,
          sourceMode, sourceInput, sourceName, label: `${platform} · ${urls.length} video từ lịch sử` })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Không thêm được job ${platform}.`);
      queued += urls.length;
    }
    crawlHistorySelected.clear();
    crawlRenderHistory();
    toast(`Đã thêm ${queued} video từ lịch sử vào hàng đợi.`, 'success');
    crawlStartPolling();
    await crawlPollStatus();
  } catch (error) {
    toast(error.message || 'Không thêm được video từ lịch sử.', 'error');
  }
}

function crawlHistoryDownloadOne(encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const item = crawlHistoryItems.find((entry) => entry.key === key);
  return item ? crawlHistoryEnqueue([item]) : undefined;
}

function crawlHistoryDownloadSelected() {
  return crawlHistoryEnqueue(crawlHistoryItems.filter((item) => crawlHistorySelected.has(item.key)));
}

async function crawlHistoryDelete(value) {
  const select = $('crawl-history-delete-range');
  if (select) select.value = '';
  if (value === '' || value == null) return;
  const labels = { '1': 'trong 1 giờ qua', '24': 'trong 24 giờ qua', '168': 'trong 7 ngày qua', '720': 'trong 30 ngày qua', '0': 'TẤT CẢ' };
  const label = labels[String(value)] || '';
  const confirmed = window.confirm(`Xóa lịch sử cào ${label}?\n\nChỉ danh sách metadata bị xóa. Video đã tải và dữ liệu đánh dấu chống trùng vẫn được giữ nguyên. Danh sách đã xóa không thể khôi phục.`);
  if (!confirmed) return;
  try {
    const response = await fetch('/api/download-crawl/history/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours: Number(value) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không xóa được lịch sử cào.');
    crawlHistorySelected.clear();
    toast(`Đã xóa ${Number(data.deleted || 0)} mục khỏi lịch sử cào.`, 'success');
    await crawlLoadHistory();
  } catch (error) {
    toast(error.message || 'Không xóa được lịch sử cào.', 'error');
  }
}

function crawlFilteredItems() {
  const minLike = Number($('crawl-now-min-like')?.value || 0);
  const minView = Number($('crawl-now-min-view')?.value || 0);
  const days = Number($('crawl-now-days')?.value || $('crawl-now-time')?.value || 0);
  const minTimestamp = days > 0 ? Date.now() / 1000 - days * 86400 : 0;
  return crawlNowState.previewItems.filter((item) => {
    if (minLike && Number(item.likeCount || 0) < minLike) return false;
    if (minView && Number(item.viewCount || 0) < minView) return false;
    if (minTimestamp && Number(item.timestamp || 0) && Number(item.timestamp) < minTimestamp) return false;
    return true;
  });
}

function crawlRenderPreview() {
  const wrap = $('crawl-preview-wrap');
  const grid = $('crawl-preview-grid');
  if (!wrap || !grid) return;
  wrap.classList.remove('hidden');
  const items = crawlFilteredItems();
  if ($('crawl-preview-summary')) {
    $('crawl-preview-summary').textContent = `${items.length}/${crawlNowState.previewItems.length} video · đã chọn ${crawlNowState.selected.size}`;
  }
  if (!items.length) {
    grid.innerHTML = '<div class="status-line">Không có video khớp bộ lọc.</div>';
    return;
  }
  grid.innerHTML = items.map((item) => {
    const key = item.key || `${item.platform}:${item.id}`;
    const needsProxy = ['douyin', 'bilibili', 'xiaohongshu', 'rednote'].includes(item.platform);
    const thumb = item.thumbnail ? (needsProxy ? `/api/proxy-image?url=${encodeURIComponent(item.thumbnail)}` : item.thumbnail) : '';
    return `<article class="crawl-preview-item">
      <div class="crawl-preview-thumb">
        ${thumb ? `<img src="${crawlEscape(thumb)}" alt="" loading="lazy">` : ''}
        <input type="checkbox" data-crawl-key="${crawlEscape(key)}" ${crawlNowState.selected.has(key) ? 'checked' : ''}
          onchange="crawlToggleItem(${crawlEscape(JSON.stringify(key))}, this.checked)">
        ${item.downloaded ? '<span class="crawl-downloaded-badge">✓ đã tải</span>' : ''}
      </div>
      <div class="crawl-preview-info">
        <div class="crawl-preview-title" title="${crawlEscape(item.title)}">${crawlEscape(item.title)}</div>
        <div class="crawl-preview-meta">${crawlFormatDuration(item.duration)} · ${crawlEscape(item.uploader || item.platform)}</div>
      </div>
    </article>`;
  }).join('');
}

async function crawlPreview(options = {}) {
  const request = await crawlPrepareRequest();
  if (Number.isFinite(Number(options.requestCount))) {
    request.count = Math.min(500, Math.max(1, Number(options.requestCount)));
  }
  const previewModes = crawlNowState.capabilities[crawlNowState.platform]?.previewModes || [];
  if (!previewModes.includes(crawlNowState.mode)) {
    toast('Chế độ này chưa hỗ trợ xem trước ổn định. Hãy dùng Cào hết hoặc Thêm vào hàng đợi.', 'warn');
    return [];
  }
  if (!request.input) {
    toast('Hãy nhập từ khóa, link hoặc kênh trước.', 'error');
    return [];
  }
  crawlSetBusy(true, 'Đang tìm video');
  crawlStartPolling();
  await crawlPollStatus();
  try {
    if (!options.append) {
      crawlNowState.previewItems = [];
      crawlNowState.selected = new Set();
    }
    let renderQueued = false;
    const schedulePreviewRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        crawlRenderPreview();
      });
    };
    const response = await fetch('/api/download-crawl/preview-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
    });
    if (!response.ok) {
      const failed = await response.json().catch(() => ({}));
      throw new Error(failed.error || 'Không lấy được danh sách video.');
    }
    let data = null;
    let streamError = '';
    const reader = response.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      const consumeLine = (line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch (_) { return; }
        if (event.type === 'item' && event.item) {
          const item = event.item;
          const key = item.key || `${item.platform}:${item.id}`;
          const index = crawlNowState.previewItems.findIndex((current) => (current.key || `${current.platform}:${current.id}`) === key);
          if (index >= 0) crawlNowState.previewItems[index] = item;
          else crawlNowState.previewItems.push(item);
          crawlNowState.selected.add(key);
          schedulePreviewRender();
        } else if (event.type === 'result') data = event.data;
        else if (event.type === 'error') streamError = event.error || 'Không lấy được danh sách video.';
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) consumeLine(line);
        if (done) break;
      }
      consumeLine(buffer);
    } else {
      data = await response.json();
    }
    if (streamError) throw new Error(streamError);
    if (!data) throw new Error('Luồng xem trước kết thúc nhưng không trả về kết quả.');
    const received = Array.isArray(data.items) ? data.items : [];
    if (options.append) {
      const merged = new Map(crawlNowState.previewItems.map((item) => [item.key || `${item.platform}:${item.id}`, item]));
      for (const item of received) merged.set(item.key || `${item.platform}:${item.id}`, item);
      crawlNowState.previewItems = [...merged.values()];
      for (const item of received) crawlNowState.selected.add(item.key || `${item.platform}:${item.id}`);
    } else {
      crawlNowState.previewItems = received;
      crawlNowState.selected = new Set(crawlNowState.previewItems.map((item) => item.key || `${item.platform}:${item.id}`));
      crawlNowState.previewBaseCount = request.count;
    }
    crawlNowState.previewRequestedCount = request.count;
    if (!options.silent) crawlRenderPreview();
    if (!crawlNowState.previewItems.length) toast('Không tìm thấy video nào.', 'warn');
    return crawlNowState.previewItems;
  } catch (error) {
    toast(error.message, 'error');
    return [];
  } finally {
    crawlSetBusy(false);
    await crawlPollStatus();
  }
}

function crawlClosePreview() {
  $('crawl-preview-wrap')?.classList.add('hidden');
}

async function crawlLoadMore() {
  if (crawlNowState.previewLoadingMore) return;
  crawlNowState.previewLoadingMore = true;
  const previous = Number(crawlNowState.previewRequestedCount || crawlNowState.previewBaseCount || 100);
  const requestCount = Math.min(500, previous + crawlNowState.previewBaseCount);
  try {
    await crawlPreview({ append: true, requestCount });
  } finally {
    crawlNowState.previewLoadingMore = false;
  }
}

function crawlToggleItem(key, checked) {
  if (checked) crawlNowState.selected.add(key);
  else crawlNowState.selected.delete(key);
  crawlRenderPreview();
}

function crawlToggleAll(checked) {
  for (const item of crawlFilteredItems()) {
    const key = item.key || `${item.platform}:${item.id}`;
    if (checked) crawlNowState.selected.add(key);
    else crawlNowState.selected.delete(key);
  }
  crawlRenderPreview();
}

async function crawlEnqueue(items) {
  const selectedItems = items || crawlNowState.previewItems.filter((item) => {
    const key = item.key || `${item.platform}:${item.id}`;
    return crawlNowState.selected.has(key);
  });
  if (!selectedItems.length) {
    toast('Chưa chọn video nào.', 'error');
    return;
  }
  try {
    const jobCrawlerPlatforms = ['youtube', 'tiktok', 'facebook', 'instagram', 'twitter', 'reddit', 'douyin', 'bilibili', 'xiaohongshu', 'rednote', 'weibo'];
    if (jobCrawlerPlatforms.includes(crawlNowState.platform)) {
      const urls = selectedItems.map((item) => item.sourceUrl || item.url).filter(Boolean);
      const sourceRequest = crawlCurrentRequest();
      const sourceName = sourceRequest.mode === 'creator'
        ? String(selectedItems.find((item) => item.uploader)?.uploader || '')
        : '';
      const response = await fetch('/api/download-crawl/enqueue-job', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...sourceRequest, mode: 'detail', input: urls.join('\n'), count: urls.length,
          sourceMode: sourceRequest.mode, sourceInput: sourceRequest.input, sourceName,
          label: `${crawlNowState.platform} · ${urls.length} video đã chọn`
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Không thêm được job crawler vào hàng đợi.');
      toast(`Đã thêm ${urls.length} video vào job Video Studio yt-dlp.`, 'success');
      crawlStartPolling();
      await crawlPollStatus();
      return;
    }
    const response = await fetch('/api/download-crawl/enqueue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: crawlNowState.platform,
        skipDuplicates: $('crawl-now-skip-dupe')?.checked !== false,
        items: selectedItems
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không thêm được vào hàng đợi.');
    toast(`Đã thêm ${data.created} video vào hàng đợi${data.skipped ? `, bỏ qua ${data.skipped} video trùng` : ''}.`, 'success');
    crawlStartPolling();
    await crawlPollStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function crawlEnqueueSelected() { return crawlEnqueue(); }

async function crawlAllNow() {
  return crawlEnqueueJob(true);
}

function crawlTaskStatusLabel(task) {
  return ({ pending: 'Đang chờ', downloading: task.step || 'Đang tải', success: 'Đã xong', error: 'Lỗi', cancelled: 'Đã hủy' })[task.status] || task.status;
}

function crawlRenderQueue(snapshot) {
  crawlNowState.lastSnapshot = snapshot;
  const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
  const summary = snapshot.summary || {};
  const list = $('crawl-queue-list');
  if ($('crawl-queue-summary')) {
    $('crawl-queue-summary').textContent = queue.length
      ? `${summary.downloading || 0} đang tải · ${summary.pending || 0} chờ · ${summary.success || 0} xong · ${summary.error || 0} lỗi`
      : 'Chưa có tác vụ';
  }
  if (list) {
    list.innerHTML = queue.slice().reverse().map((task) => `<div class="crawl-queue-item">
      <div class="crawl-queue-item-head">
        <div style="min-width:0;flex:1"><div class="crawl-queue-item-title" title="${crawlEscape(task.title)}">${crawlEscape(task.title)}</div>
          <div class="crawl-queue-item-status" title="${crawlEscape(crawlTaskStatusLabel(task))}">${task.kind === 'crawl' ? 'Job cào · ' : ''}${crawlEscape(crawlTaskStatusLabel(task))}</div>
          ${task.reason ? `<div class="crawl-queue-reason">${crawlEscape(task.reason)}${task.error ? ` · ${crawlEscape(task.error)}` : ''}</div>` : ''}</div>
        ${['pending', 'downloading'].includes(task.status) ? `<button class="crawl-queue-cancel" onclick="crawlCancelTask('${crawlEscape(task.id)}')">Hủy</button>` : ''}
        ${['error', 'cancelled'].includes(task.status) ? `<button class="crawl-link-btn" onclick="crawlRetryTask('${crawlEscape(task.id)}')">Thử lại</button>` : ''}
        ${['success', 'error', 'cancelled'].includes(task.status) ? `<button class="crawl-link-btn" onclick="crawlRemoveTask('${crawlEscape(task.id)}')">✕</button>` : ''}
      </div>
      <div class="crawl-queue-mini-track"><i style="width:${Math.max(0, Math.min(100, Number(task.percent) || 0))}%"></i></div>
    </div>`).join('');
  }

  const total = queue.length;
  const completed = queue.filter((task) => ['success', 'error', 'cancelled'].includes(task.status)).length;
  const active = queue.find((task) => task.id === snapshot.activeTaskId) || queue.find((task) => task.status === 'downloading');
  const overall = total ? Math.round(((completed + (active ? (Number(active.percent) || 0) / 100 : 0)) / total) * 100) : 0;
  if ($('crawl-progress-count')) $('crawl-progress-count').textContent = `${completed}/${total} video`;
  if ($('crawl-progress-bar')) $('crawl-progress-bar').style.width = `${overall}%`;
  if ($('crawl-progress-percent')) $('crawl-progress-percent').textContent = `${overall}%`;
  if ($('crawl-progress-label')) $('crawl-progress-label').textContent = active?.step || (total ? 'Hàng đợi đã xử lý' : 'Sẵn sàng');
  if ($('crawl-progress-speed')) $('crawl-progress-speed').textContent = `Tốc độ: ${active?.speed || snapshot.speed || '—'}`;
  if ($('crawl-progress-eta')) $('crawl-progress-eta').textContent = `Ước tính còn: ${active?.eta || snapshot.eta || '—'}`;
  if ($('stat-queue-count')) $('stat-queue-count').textContent = (summary.pending || 0) + (summary.downloading || 0);
  const pauseButton = $('crawl-pause-btn');
  if (pauseButton) pauseButton.textContent = snapshot.paused ? '▶ Tiếp tục hàng đợi' : '⏸ Dừng sau task này';
  const retryPlatforms = $('crawl-retry-platforms');
  if (retryPlatforms) {
    const failed = {};
    queue.filter((task) => task.status === 'error').forEach((task) => { failed[task.platform] = (failed[task.platform] || 0) + 1; });
    retryPlatforms.innerHTML = Object.entries(failed).map(([platform, count]) => `<button type="button" onclick="crawlRetryAll('${crawlEscape(platform)}')">↻ ${crawlEscape(platform)} (${count})</button>`).join('');
  }

  const log = $('crawl-activity-log');
  if (log) {
    const entries = Array.isArray(snapshot.logs) ? snapshot.logs : [];
    log.innerHTML = entries.length ? entries.map((entry) => `<div class="crawl-log-line ${crawlEscape(entry.level)}"><span>${crawlEscape(new Date(entry.time).toLocaleTimeString('vi-VN'))}</span> · ${crawlEscape(entry.message)}</div>`).join('') : '<span>Chưa có hoạt động.</span>';
    log.scrollTop = log.scrollHeight;
  }

  let shouldRefreshStudioVideos = false;
  for (const task of queue.filter((candidate) => candidate.status === 'success')) {
    if (!crawlNowState.studioRefreshSuccess.has(task.id)) {
      crawlNowState.studioRefreshSuccess.add(task.id);
      shouldRefreshStudioVideos = true;
    }
    if (task.kind === 'crawl') continue;
    if (crawlNowState.recordedSuccess.has(task.id)) continue;
    crawlNowState.recordedSuccess.add(task.id);
    crawlSaveRecordedTaskIds(crawlNowState.recordedSuccess);
    const filename = String(task.outputPath || '').split(/[\\/]/).pop();
    addDownloadHistory(task.title, task.sourceUrl || task.url, 'success', filename, task.platform);
  }
  if (shouldRefreshStudioVideos) {
    refreshStudioVideoAssets().catch((error) => {
      console.error('Không cập nhật được Video nguồn sau khi tải:', error);
    });
  }
  crawlRefreshStats();
}

async function crawlPollStatus() {
  try {
    const response = await fetch('/api/download-crawl/status');
    if (!response.ok) return;
    const snapshot = await response.json();
    crawlRenderQueue(snapshot);
    const activeCount = Number(snapshot.summary?.pending || 0) + Number(snapshot.summary?.downloading || 0);
    if (activeCount > 0 || snapshot.previewing) crawlStartPolling();
    else crawlStopPolling();
  } catch (_) {}
}

function crawlStartPolling() {
  if (crawlNowState.pollTimer) return;
  crawlNowState.pollTimer = setInterval(crawlPollStatus, 3000);
}

function crawlStopPolling() {
  if (!crawlNowState.pollTimer) return;
  clearInterval(crawlNowState.pollTimer);
  crawlNowState.pollTimer = null;
}

async function crawlCancelTask(taskId) {
  await fetch('/api/download-crawl/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId })
  });
  await crawlPollStatus();
}

async function crawlRemoveTask(taskId) {
  await fetch('/api/download-crawl/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId })
  });
  await crawlPollStatus();
}

async function crawlStopAll() {
  await fetch('/api/download-crawl/stop', { method: 'POST' });
  toast('Đang dừng hàng đợi tải...', 'info');
  await crawlPollStatus();
}

async function crawlClearFinished() {
  await fetch('/api/download-crawl/clear', { method: 'POST' });
  await crawlPollStatus();
}

async function crawlTogglePause() {
  const paused = !(crawlNowState.lastSnapshot?.paused);
  await fetch('/api/download-crawl/pause', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused })
  });
  await crawlPollStatus();
}

async function crawlRetryTask(taskId) {
  await fetch('/api/download-crawl/retry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId })
  });
  crawlStartPolling();
  await crawlPollStatus();
}

async function crawlRetryAll(platform = '') {
  await fetch('/api/download-crawl/retry-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform })
  });
  crawlStartPolling();
  await crawlPollStatus();
}

async function crawlClearLogs() {
  await fetch('/api/download-crawl/clear-logs', { method: 'POST' });
  await crawlPollStatus();
}

async function crawlEnqueueJob(startNow = false) {
  const request = await crawlPrepareRequest();
  if (!request.input) {
    toast('Hãy nhập từ khóa, link hoặc kênh trước.', 'error');
    return;
  }
  try {
    const response = await fetch('/api/download-crawl/enqueue-job', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không thêm được job cào.');
    toast(startNow ? 'Đã bắt đầu job cào. Theo dõi ở hàng đợi.' : 'Đã thêm job cào vào hàng đợi.', 'success');
    crawlStartPolling();
    await crawlPollStatus();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function crawlAddCurrentToQueue() {
  return crawlEnqueueJob(false);
}

document.querySelectorAll('#crawl-platform-grid .crawl-platform').forEach((button) => {
  button.addEventListener('click', () => {
    crawlNowState.platform = button.dataset.platform;
    document.querySelectorAll('#crawl-platform-grid .crawl-platform').forEach((item) => item.classList.toggle('active', item === button));
    const caps = crawlNowState.capabilities[crawlNowState.platform] || {};
    if (caps[crawlNowState.mode] === false) crawlNowState.mode = caps.detail ? 'detail' : Object.keys(caps).find((mode) => caps[mode]) || 'detail';
    crawlUpdateModeUi();
  });
});
document.querySelectorAll('#crawl-mode-tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    crawlNowState.mode = button.dataset.mode;
    crawlUpdateModeUi();
  });
});
['crawl-now-min-like', 'crawl-now-min-view', 'crawl-now-days'].forEach((id) => $(id)?.addEventListener('input', crawlRenderPreview));
if ($('crawl-preview-select-all')) $('crawl-preview-select-all').checked = true;
crawlLoadCapabilities();
crawlLoadLoginStatus();
crawlRefreshStats();
crawlLoadHistory();
crawlPollStatus();

function switchDownloadMode(mode) {
  const crawlBtn = $('download-mode-crawl-btn');
  const singleBtn = $('download-mode-single-btn');
  const bulkBtn = $('download-mode-bulk-btn');
  const crawlCont = $('download-crawl-container');
  const singleCont = $('download-single-container');
  const bulkCont = $('download-bulk-container');
  const historyPanel = $('download-history-panel');

  if (crawlBtn) crawlBtn.classList.toggle('active', mode === 'crawl');
  if (singleBtn) singleBtn.classList.toggle('active', mode === 'single');
  if (bulkBtn) bulkBtn.classList.toggle('active', mode === 'bulk');
  if (crawlCont) crawlCont.classList.toggle('hidden', mode !== 'crawl');
  if (singleCont) singleCont.classList.toggle('hidden', mode !== 'single');
  if (bulkCont) bulkCont.classList.toggle('hidden', mode !== 'bulk');
  if (historyPanel) historyPanel.classList.toggle('hidden', mode === 'crawl');
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
window.crawlPreview = crawlPreview;
window.crawlAllNow = crawlAllNow;
window.crawlToggleItem = crawlToggleItem;
window.crawlToggleAll = crawlToggleAll;
window.crawlEnqueueSelected = crawlEnqueueSelected;
window.crawlCancelTask = crawlCancelTask;
window.crawlStopAll = crawlStopAll;
window.crawlClearFinished = crawlClearFinished;

/* ==========================================================================
   GLOBAL AI SETTINGS MODAL & HELPERS
   ========================================================================== */

function getGlobalAiSettings() {
  let translationStyles = [];
  try {
    const savedStyles = JSON.parse(localStorage.getItem('global_translation_styles') || '[]');
    if (Array.isArray(savedStyles)) translationStyles = savedStyles.map(String);
  } catch {}
  return {
    aiProvider: localStorage.getItem('global_ai_provider') || 'gemini-web',
    geminiApiKey: localStorage.getItem('global_gemini_key') || '',
    geminiModel: localStorage.getItem('global_gemini_model') || '',
    openRouterApiKey: localStorage.getItem('global_openrouter_key') || '',
    openRouterModel: localStorage.getItem('global_openrouter_model') || 'openrouter/owl-alpha',
    ninerouterApiKey: localStorage.getItem('global_ninerouter_key') || '',
    ninerouterModel: localStorage.getItem('global_ninerouter_model') || '',
    ninerouterBaseUrl: localStorage.getItem('global_ninerouter_base_url') || 'http://localhost:20128/v1',
    opencodeModel: localStorage.getItem('global_opencode_model') || 'DeepSeek V4 Flash (Free)',
    openaiApiKey: localStorage.getItem('global_openai_key') || '',
    openaiModel: localStorage.getItem('global_openai_model') || 'gpt-4o-mini',
    translationStyles,
    whisperModel: 'medium',
    whisperOnnxVariant: 'medium-q8', // chỉ dùng cho lớp ONNX dự phòng nội bộ
    ocrMode: localStorage.getItem('global_ocr_mode') || 'auto'
  };
}

function getGlobalAiQueryParams() {
  const settings = getGlobalAiSettings();
  return `aiProvider=${encodeURIComponent(settings.aiProvider)}&geminiApiKey=${encodeURIComponent(settings.geminiApiKey)}&geminiModel=${encodeURIComponent(settings.geminiModel)}&openRouterApiKey=${encodeURIComponent(settings.openRouterApiKey)}&openRouterModel=${encodeURIComponent(settings.openRouterModel)}&ninerouterApiKey=${encodeURIComponent(settings.ninerouterApiKey)}&ninerouterModel=${encodeURIComponent(settings.ninerouterModel)}&ninerouterBaseUrl=${encodeURIComponent(settings.ninerouterBaseUrl)}&opencodeModel=${encodeURIComponent(settings.opencodeModel)}&openaiApiKey=${encodeURIComponent(settings.openaiApiKey)}&openaiModel=${encodeURIComponent(settings.openaiModel)}&translationStyles=${encodeURIComponent(settings.translationStyles.join(','))}&whisperModel=${encodeURIComponent(settings.whisperModel)}&whisperOnnxVariant=${encodeURIComponent(settings.whisperOnnxVariant)}`;
}

async function loadGeminiModels(apiKey) {
  const select = $('global-gemini-model');
  if (!select) return false;

  if (!apiKey || apiKey.trim() === '') {
    select.innerHTML = '<option value="">-- Vui lòng nhập API Key để chọn Model --</option>';
    return false;
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
      return false;
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
    return true;
  } catch (error) {
    console.error('Lỗi khi tải model Gemini:', error);
    select.innerHTML = `<option value="">❌ Lỗi: ${error.message}</option>`;
    throw error;
  }
}

function initGeminiModelListeners() {
  // Đã chuyển sang nút Kiểm tra kết nối thủ công
}

async function loadOpenRouterModels(apiKey) {
  const select = $('global-openrouter-model');
  if (!select) return false;

  if (!apiKey || apiKey.trim() === '') {
    select.innerHTML = '<option value="">-- Vui lòng nhập API Key để chọn Model --</option>';
    return false;
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
      return false;
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
    return true;
  } catch (error) {
    console.error('Lỗi khi tải model OpenRouter:', error);
    select.innerHTML = `<option value="">❌ Lỗi: ${error.message}</option>`;
    throw error;
  }
}

function initOpenRouterModelListeners() {
  // Đã chuyển sang nút Kiểm tra kết nối thủ công
}

async function loadNineRouterModels(apiKey, baseUrl) {
  const select = $('global-ninerouter-model');
  if (!select) return false;
  const resolvedBaseUrl = baseUrl || 'http://localhost:20128/v1';
  const savedModel = localStorage.getItem('global_ninerouter_model') || '';

  select.innerHTML = '<option value="">⏳ Đang quét các model từ 9Router...</option>';

  try {
    const res = await fetch('/api/ninerouter-models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ apiKey: apiKey.trim(), baseUrl: resolvedBaseUrl.trim() })
    });
    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || 'Lỗi không xác định');
    }

    const data = await res.json();
    const models = data.models || [];

    if (models.length === 0) {
      select.innerHTML = '<option value="">❌ Không tìm thấy model nào từ 9Router</option>';
      return false;
    }

    let html = '';
    models.forEach(m => {
      const isSelected = m.id === savedModel ? 'selected' : '';
      html += `<option value="${m.id}" ${isSelected}>${m.name}</option>`;
    });
    select.innerHTML = html;

    const dlProvider = $('dl-ai-provider');
    const dlModelSelect = $('dl-ai-model');
    if (dlProvider && dlModelSelect && dlProvider.value === '9router') {
      dlModelSelect.innerHTML = html;
      if (!dlModelSelect.value && models.length > 0) {
        dlModelSelect.value = models[0].id;
      }
    }

    const currentVal = select.value;
    if (!currentVal && models.length > 0) {
      select.value = models[0].id;
    }
    return true;
  } catch (error) {
    console.error('Lỗi khi tải model 9Router:', error);
    select.innerHTML = `<option value="">❌ Lỗi kết nối: ${error.message}</option>`;
    throw error;
  }
}

function initNineRouterModelListeners() {
  // Đã chuyển sang nút Kiểm tra kết nối thủ công
}

async function testGeminiConnection() {
  const keyInput = $('global-gemini-key');
  const statusSpan = $('gemini-connection-status');
  if (!keyInput || !statusSpan) return;

  const key = keyInput.value.trim();
  if (!key) {
    statusSpan.style.color = '#ef4444';
    statusSpan.textContent = '❌ Vui lòng nhập API Key trước';
    return;
  }

  statusSpan.style.color = '#f59e0b';
  statusSpan.textContent = '⏳ Đang kết nối...';

  try {
    const success = await loadGeminiModels(key);
    if (success) {
      statusSpan.style.color = '#10b981';
      statusSpan.textContent = '✅ Kết nối thành công!';
    } else {
      statusSpan.style.color = '#ef4444';
      statusSpan.textContent = '❌ Không có model phù hợp';
    }
  } catch (error) {
    statusSpan.style.color = '#ef4444';
    statusSpan.textContent = `❌ Thất bại: ${error.message}`;
  }
}

async function testOpenRouterConnection() {
  const keyInput = $('global-openrouter-key');
  const statusSpan = $('openrouter-connection-status');
  if (!keyInput || !statusSpan) return;

  const key = keyInput.value.trim();
  if (!key) {
    statusSpan.style.color = '#ef4444';
    statusSpan.textContent = '❌ Vui lòng nhập API Key trước';
    return;
  }

  statusSpan.style.color = '#f59e0b';
  statusSpan.textContent = '⏳ Đang kết nối...';

  try {
    const success = await loadOpenRouterModels(key);
    if (success) {
      statusSpan.style.color = '#10b981';
      statusSpan.textContent = '✅ Kết nối thành công!';
    } else {
      statusSpan.style.color = '#ef4444';
      statusSpan.textContent = '❌ Không có model phù hợp';
    }
  } catch (error) {
    statusSpan.style.color = '#ef4444';
    statusSpan.textContent = `❌ Thất bại: ${error.message}`;
  }
}

async function testNineRouterConnection() {
  const keyInput = $('global-ninerouter-key');
  const urlInput = $('global-ninerouter-base-url');
  const statusSpan = $('ninerouter-connection-status');
  if (!urlInput || !statusSpan) return;

  const baseUrl = urlInput.value.trim();
  const key = keyInput ? keyInput.value.trim() : '';

  statusSpan.style.color = '#f59e0b';
  statusSpan.textContent = '⏳ Đang kết nối...';

  try {
    const success = await loadNineRouterModels(key, baseUrl);
    if (success) {
      statusSpan.style.color = '#10b981';
      statusSpan.textContent = '✅ Kết nối thành công!';
    } else {
      statusSpan.style.color = '#ef4444';
      statusSpan.textContent = '❌ Không có model phù hợp';
    }
  } catch (error) {
    statusSpan.style.color = '#ef4444';
    statusSpan.textContent = `❌ Thất bại: ${error.message}`;
  }
}

async function loadOpenAiModels(keyOverride = null) {
  const input = $('global-openai-key');
  const select = $('global-openai-model');
  const statusEl = $('openai-connection-status');
  if (!select) return false;

  const apiKey = (keyOverride !== null && typeof keyOverride === 'string') ? keyOverride : (input ? input.value : '');

  if (!apiKey || apiKey.trim() === '') {
    if (statusEl) {
      statusEl.textContent = '❌ Chưa nhập Key';
      statusEl.style.color = '#ef4444';
    }
    return false;
  }

  if (statusEl) {
    statusEl.textContent = '⏳ Đang tải danh sách model...';
    statusEl.style.color = '#eab308';
  }

  try {
    const res = await fetch('/api/openai/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: apiKey.trim() })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Không thể tải danh sách model');
    }

    const savedModel = localStorage.getItem('global_openai_model') || 'gpt-4o-mini';
    select.innerHTML = '';
    data.models.forEach(modelId => {
      const opt = document.createElement('option');
      opt.value = modelId;
      opt.textContent = modelId;
      if (modelId === savedModel) opt.selected = true;
      select.appendChild(opt);
    });

    if (statusEl) {
      statusEl.textContent = `✅ Thành công (${data.models.length} models)`;
      statusEl.style.color = '#22c55e';
    }
    return true;
  } catch (err) {
    console.error('Lỗi loadOpenAiModels:', err);
    if (statusEl) {
      statusEl.textContent = `❌ ${err.message}`;
      statusEl.style.color = '#ef4444';
    }
    return false;
  }
}

function openGlobalSettingsModal() {
  const modal = $('global-settings-modal');
  if (!modal) return;

  const settings = getGlobalAiSettings();

  const providerSelect = $('global-ai-provider');
  const geminiInput = $('global-gemini-key');
  const openRouterInput = $('global-openrouter-key');
  const openaiInput = $('global-openai-key');
  const ninerouterInput = $('global-ninerouter-key');
  const ninerouterBaseUrlInput = $('global-ninerouter-base-url');
  const whisperModelSelect = $('whisper-model-select');

  if (providerSelect) providerSelect.value = settings.aiProvider;
  document.querySelectorAll('#global-translation-style-options input[type="checkbox"]').forEach((input) => {
    input.checked = settings.translationStyles.includes(input.value);
  });
  if (openaiInput) {
    openaiInput.value = settings.openaiApiKey;
    if (settings.openaiApiKey) {
      loadOpenAiModels(settings.openaiApiKey);
    }
  }
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
  if (ninerouterBaseUrlInput) {
    ninerouterBaseUrlInput.value = settings.ninerouterBaseUrl || 'http://localhost:20128/v1';
  }
  if ($('global-opencode-model')) { $('global-opencode-model').value = settings.opencodeModel || 'DeepSeek V4 Flash (Free)'; }
  if (ninerouterInput) {
    ninerouterInput.value = settings.ninerouterApiKey;
  }
  if (settings.aiProvider === 'ninerouter') {
    loadNineRouterModels(settings.ninerouterApiKey, settings.ninerouterBaseUrl);
  }
  if (whisperModelSelect) {
    whisperModelSelect.value = 'large-v3-turbo';
    checkWhisperModelStatus();
  }
  const globalOcrSelect = $('global-ocr-mode-select');
  if (globalOcrSelect) {
    globalOcrSelect.value = settings.ocrMode;
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
  const openaiFields = $('global-openai-fields');
  const ninerouterFields = $('global-ninerouter-fields');
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
  if (openaiFields) {
    if (val === 'openai') {
      openaiFields.classList.remove('hidden');
      const key = $('global-openai-key') ? $('global-openai-key').value : '';
      if (key) loadOpenAiModels(key);
    } else {
      openaiFields.classList.add('hidden');
    }
  }
  if (ninerouterFields) {
    if (val === 'ninerouter') {
      ninerouterFields.classList.remove('hidden');
      const key = $('global-ninerouter-key') ? $('global-ninerouter-key').value : '';
      const baseUrl = $('global-ninerouter-base-url') ? $('global-ninerouter-base-url').value : 'http://localhost:20128/v1';
      loadNineRouterModels(key, baseUrl);
    } else {
      ninerouterFields.classList.add('hidden');
    }
  }
  const opencodeFields = $('global-opencode-fields');
  if (opencodeFields) {
    if (val === 'opencode') {
      opencodeFields.classList.remove('hidden');
    } else {
      opencodeFields.classList.add('hidden');
    }
  }
  const geminiWebFields = $('global-gemini-web-fields');
  if (geminiWebFields) {
    if (val === 'gemini-web') {
      geminiWebFields.classList.remove('hidden');
    } else {
      geminiWebFields.classList.add('hidden');
    }
  }
}

async function openGeminiWebLoginWindow() {
  console.log('[GeminiWeb] 🌐 Đang mở cửa sổ trình duyệt đăng nhập Gemini...');
  if (typeof toast === 'function') {
    toast('Đang mở cửa sổ Chrome đăng nhập Gemini...', 'info');
  }
  try {
    const res = await fetch('/api/gemini-web/login', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      if (typeof toast === 'function') {
        toast(data.message || (data.loggedIn
          ? 'Đã xác nhận đăng nhập Gemini.'
          : 'Đã đóng trình duyệt. Gemini Web vẫn có thể dịch ở chế độ khách.'), data.loggedIn ? 'success' : 'info');
      }
    } else {
      if (typeof toast === 'function') {
        toast(`Lỗi mở đăng nhập Gemini: ${data.error}`, 'error');
      }
    }
  } catch (err) {
    if (typeof toast === 'function') {
      toast(`Lỗi mở đăng nhập Gemini: ${err.message}`, 'error');
    }
  }
}

function saveGlobalSettings() {
  const providerSelect = $('global-ai-provider');
  const geminiInput = $('global-gemini-key');
  const geminiModelSelect = $('global-gemini-model');
  const openRouterInput = $('global-openrouter-key');
  const openRouterModelSelect = $('global-openrouter-model');
  const openaiInput = $('global-openai-key');
  const openaiModelSelect = $('global-openai-model');
  const ninerouterInput = $('global-ninerouter-key');
  const ninerouterModelSelect = $('global-ninerouter-model');
  const ninerouterBaseUrlInput = $('global-ninerouter-base-url');
  const whisperModelSelect = $('whisper-model-select');
  const translationStyles = Array.from(document.querySelectorAll('#global-translation-style-options input[type="checkbox"]:checked'))
    .map(input => input.value);

  if (providerSelect) localStorage.setItem('global_ai_provider', providerSelect.value);
  if (geminiInput) localStorage.setItem('global_gemini_key', geminiInput.value);
  if (geminiModelSelect) localStorage.setItem('global_gemini_model', geminiModelSelect.value);
  if (openRouterInput) localStorage.setItem('global_openrouter_key', openRouterInput.value);
  if (openRouterModelSelect) localStorage.setItem('global_openrouter_model', openRouterModelSelect.value);
  if (openaiInput) localStorage.setItem('global_openai_key', openaiInput.value);
  if (openaiModelSelect) localStorage.setItem('global_openai_model', openaiModelSelect.value);
  if (ninerouterInput) localStorage.setItem('global_ninerouter_key', ninerouterInput.value);
  if (ninerouterModelSelect) localStorage.setItem('global_ninerouter_model', ninerouterModelSelect.value);
  if (ninerouterBaseUrlInput) localStorage.setItem('global_ninerouter_base_url', ninerouterBaseUrlInput.value);
  localStorage.removeItem('global_whisper_onnx_variant');
  localStorage.setItem('global_translation_styles', JSON.stringify(translationStyles));
  const globalOcrSelect = $('global-ocr-mode-select');
  if (globalOcrSelect) localStorage.setItem('global_ocr_mode', globalOcrSelect.value);

  toast('Đã lưu cài đặt AI toàn cục thành công!', 'success');
  closeGlobalSettingsModal();
}

function switchSettingsTab(tabName) {
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tabName);
  });
  document.querySelectorAll('.settings-tab-content').forEach(content => {
    if (content.id === `settings-tab-${tabName}`) {
      content.classList.remove('hidden');
    } else {
      content.classList.add('hidden');
    }
  });
}

// Cookie management
function openCookieModal() {
  document.getElementById('cookie-modal').classList.remove('hidden');
  loadCookieStatusList();
  switchCookieMethod('paste');
}

function closeCookieModal() {
  document.getElementById('cookie-modal').classList.add('hidden');
}

function switchCookieMethod(method) {
  document.querySelectorAll('[data-cookie-method]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cookieMethod === method);
  });
  document.getElementById('cookie-paste-area').classList.toggle('hidden', method !== 'paste');
  document.getElementById('cookie-file-area').classList.toggle('hidden', method !== 'file');
}

async function loadCookieStatusList() {
  try {
    const res = await fetch('/api/cookie-status');
    const status = await res.json();
    const container = document.getElementById('cookie-status-list');
    if (!container) return;
    const platforms = [
      { id: 'bilibili', label: 'Bilibili', icon: '📺' },
      { id: 'douyin', label: 'Douyin', icon: '🎵' },
      { id: 'tiktok', label: 'TikTok', icon: '🎶' },
      { id: 'youtube', label: 'YouTube', icon: '▶️' },
      { id: 'facebook', label: 'Facebook', icon: '📘' },
      { id: 'instagram', label: 'Instagram', icon: '📷' },
      { id: 'xiaohongshu', label: 'Xiaohongshu', icon: '📕' },
      { id: 'youku', label: 'Youku', icon: '🎬' },
      { id: 'mgtv', label: 'MangoTV', icon: '🥭' },
      { id: 'iq', label: 'iQIYI', icon: '🍿' }
    ];
    container.innerHTML = platforms.map(p => {
      const has = status[p.id];
      return `
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 4px;">
          <span style="font-size: 14px;">${p.icon}</span>
          <span style="flex: 1; font-size: 12px;">${p.label}</span>
          <span style="font-size: 11px; padding: 1px 6px; border-radius: 3px; background: ${has ? 'rgba(76,175,80,0.15)' : 'rgba(255,82,82,0.15)'}; color: ${has ? '#4CAF50' : '#FF5252'};">
            ${has ? 'Đã có' : 'Chưa có'}
          </span>
          ${has ? `<button style="margin:0; padding:0 6px; font-size:10px; height:20px; line-height:20px; border:none; border-radius:3px; background:rgba(255,82,82,0.15); color:#FF5252; cursor:pointer; white-space:nowrap;" onclick="deleteCookieStatus('${p.id}')">Xóa</button>` : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Lỗi tải trạng thái cookies:', err);
  }
}

async function saveCookiePaste() {
  const platform = document.getElementById('cookie-platform-select').value;
  const text = document.getElementById('cookie-text-input').value.trim();
  if (!text) { toast('Vui lòng dán nội dung cookies', 'error'); return; }

  const blob = new Blob([text], { type: 'text/plain' });
  const file = new File([blob], `${platform}.txt`, { type: 'text/plain' });
  const formData = new FormData();
  formData.append('cookieFile', file);
  formData.append('platform', platform);

  try {
    const res = await fetch('/api/upload-cookie', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      toast(`Đã lưu cookies cho ${platform}`, 'success');
      loadCookieStatusList();
    } else {
      toast(data.error || 'Lỗi lưu cookies', 'error');
    }
  } catch (err) {
    toast('Lỗi kết nối', 'error');
  }
}

async function saveCookieFile() {
  const platform = document.getElementById('cookie-platform-select').value;
  const input = document.getElementById('cookie-file-input');
  const file = input?.files?.[0];
  if (!file) { toast('Vui lòng chọn file', 'error'); return; }

  const formData = new FormData();
  formData.append('cookieFile', file);
  formData.append('platform', platform);

  try {
    const res = await fetch('/api/upload-cookie', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      toast(`Đã lưu cookies cho ${platform}`, 'success');
      input.value = '';
      loadCookieStatusList();
    } else {
      toast(data.error || 'Lỗi upload cookies', 'error');
    }
  } catch (err) {
    toast('Lỗi kết nối', 'error');
  }
}

async function deleteCookieStatus(platform) {
  if (!confirm(`Xóa cookies cho ${platform}?`)) return;
  try {
    const res = await fetch('/api/delete-cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform }) });
    const data = await res.json();
    if (data.success) {
      toast(`Đã xóa cookies cho ${platform}`, 'success');
      loadCookieStatusList();
    }
  } catch (err) {
    toast('Lỗi kết nối', 'error');
  }
}

function updateOutputLangInfo() {
  const sel = document.getElementById('global-output-lang');
  const info = document.getElementById('output-lang-info');
  if (!sel || !info) return;
  const selectedLabel = sel.options[sel.selectedIndex]?.textContent || sel.value.toUpperCase();
  info.textContent = `Dịch + Giọng đọc: ${selectedLabel}`;
  info.style.color = 'var(--muted)';
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
window.loadOpenAiModels = loadOpenAiModels;
window.loadNineRouterModels = loadNineRouterModels;
window.initNineRouterModelListeners = initNineRouterModelListeners;
window.testGeminiConnection = testGeminiConnection;
window.testOpenRouterConnection = testOpenRouterConnection;
window.testNineRouterConnection = testNineRouterConnection;
window.updateOutputLangInfo = updateOutputLangInfo;

/* ==========================================================================
   CONNECTION STATUS MODAL & HELPERS
   ========================================================================== */
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
  const tools = ['ffmpeg', 'ytdlp', 'whisper', 'separator', 'omnivoice'];
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
    dependencyStatus = data;
    updateMdxProviderUI();

    // 1. FFmpeg
    const ffmpegDot = $('conn-ffmpeg-dot');
    const ffmpegDesc = $('conn-ffmpeg-desc');
    if (data.ffmpeg) {
      ffmpegDot.className = 'dot ok';
      ffmpegDot.style.background = 'var(--success)';
      ffmpegDot.style.boxShadow = '0 0 8px var(--success)';
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
      ytdlpDot.style.background = 'var(--success)';
      ytdlpDot.style.boxShadow = '0 0 8px var(--success)';
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
      whisperDot.style.background = 'var(--success)';
      whisperDot.style.boxShadow = '0 0 8px var(--success)';
      whisperDesc.textContent = 'Đã sẵn sàng';
    } else {
      whisperDot.className = 'dot warn';
      whisperDot.style.background = 'var(--warn)';
      whisperDot.style.boxShadow = '0 0 8px var(--warn)';
      whisperDesc.textContent = 'Thiếu Faster-Whisper Large V3 Turbo (~1,51 GB)';
      if (whisperAction) {
        whisperAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); openWhisperDownloadModal();">Tải</button>`;
      }
    }

    // 4. MDX ONNX Audio Separator
    const separatorDot = $('conn-separator-dot');
    const separatorDesc = $('conn-separator-desc');
    const separatorAction = $('conn-separator-action');
    if (data.separator) {
      separatorDot.className = 'dot ok';
      separatorDot.style.background = 'var(--success)';
      separatorDot.style.boxShadow = '0 0 8px var(--success)';
      const mdx = data.mdx;
      if (mdx?.cuda?.hardwareAvailable && mdx?.cuda?.ready) {
        separatorDesc.textContent = `Sẵn sàng CPU + CUDA (${mdx.hardware?.nvidia?.name || 'NVIDIA'})`;
      } else if (mdx?.cuda?.hardwareAvailable) {
        separatorDesc.textContent = 'CPU sẵn sàng; phát hiện NVIDIA nhưng chưa có MDX CUDA';
        if (separatorAction) {
          separatorAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); installMdxCudaComponent();">Cài CUDA</button>`;
        }
      } else {
        separatorDesc.textContent = 'Đã sẵn sàng bằng CPU';
      }
    } else {
      separatorDot.className = 'dot error';
      separatorDot.style.background = 'var(--danger)';
      separatorDot.style.boxShadow = '0 0 8px var(--danger)';
      separatorDesc.textContent = 'Thiếu công cụ (Chưa tải)';
      if (separatorAction) {
        separatorAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); showDependencyModal('separator');">Tải</button>`;
      }
    }


    // 5. OmniVoice
    const omnivoiceDot = $('conn-omnivoice-dot');
    const omnivoiceDesc = $('conn-omnivoice-desc');
    const omnivoiceAction = $('conn-omnivoice-action');
    if (data.omnivoice) {
      omnivoiceDot.className = 'dot ok';
      omnivoiceDot.style.background = 'var(--success)';
      omnivoiceDot.style.boxShadow = '0 0 8px var(--success)';
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
          omnivoiceAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); openModelDownloadModal();">Tải</button>`;
        }
      }
    }

    // 6. OCR (Optical Character Recognition)
    const ocrDot = $('conn-ocr-dot');
    const ocrDesc = $('conn-ocr-desc');
    const ocrAction = $('conn-ocr-action');
    if (ocrDot) {
      if (data.ocr) {
        ocrDot.className = 'dot ok';
        ocrDot.style.background = 'var(--success)';
        ocrDot.style.boxShadow = '0 0 8px var(--success)';
        ocrDesc.textContent = 'Đã sẵn sàng';
        if (ocrAction) ocrAction.innerHTML = '';
      } else {
        ocrDot.className = 'dot warn';
        ocrDot.style.background = 'var(--warn)';
        ocrDot.style.boxShadow = '0 0 8px var(--warn)';
        ocrDesc.textContent = 'Thiếu bộ công cụ OCR';
        if (ocrAction) {
          ocrAction.innerHTML = `<button type="button" class="premium-render-btn" style="padding: 4px 10px; font-size: 11px; height: 26px; margin: 0; width: auto; background: var(--accent);" onclick="closeConnectionStatusModal(); openOcrDownloadModal();">Tải</button>`;
        }
      }
    }

    // Tính toán danh sách các tài nguyên còn thiếu
    let missingList = [];
    if (!data.whisper) missingList.push({ type: 'whisper', label: 'Faster-Whisper Large V3 Turbo' });
    if (!data.separator) missingList.push({ type: 'separator', label: 'MDX ONNX Audio Separator' });
    if (!data.omnivoice) missingList.push({ type: 'omnivoice', label: 'Mẫu giọng thuyết minh OmniVoice' });
    if (!data.ocr) missingList.push({ type: 'ocr', label: 'Bộ công cụ OCR phụ đề' });

    window._latestMissingDependencies = missingList;
    const downloadAllBtn = $('conn-download-all-btn');
    if (downloadAllBtn) {
      if (missingList.length > 0) {
        downloadAllBtn.classList.remove('hidden');
        downloadAllBtn.disabled = false;
        downloadAllBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Tải tất cả còn thiếu (${missingList.length})
        `;
      } else {
        downloadAllBtn.classList.remove('hidden');
        downloadAllBtn.disabled = true;
        downloadAllBtn.innerHTML = `✅ Tất cả tài nguyên đã đầy đủ`;
      }
    }

    // Cập nhật connection dot trên topbar
    const connDot = $('connection-dot');
    const connBtn = $('refresh-assets-btn');
    if (data.ffmpeg && data.ytdlp) {
      if (connDot) connDot.className = 'status-dot connected';
      if (connBtn) connBtn.classList.add('btn-connected');
    } else {
      if (connDot) connDot.className = 'status-dot error';
      if (connBtn) connBtn.classList.remove('btn-connected');
    }

  } catch (err) {
    console.error('Error checking connection status:', err);
    toast('Lỗi khi kết nối với máy chủ kiểm tra', 'error');
    // Cập nhật connection dot lỗi
    const dot = $('connection-dot');
    if (dot) { dot.className = 'status-dot error'; }
    const btn = $('refresh-assets-btn');
    if (btn) btn.classList.remove('btn-connected');
  }
}

let isBatchDownloading = false;

async function downloadAllMissingDependencies() {
  if (isBatchDownloading) return;
  const missingList = window._latestMissingDependencies || [];
  if (missingList.length === 0) {
    toast('Tất cả tài nguyên hệ thống đã được cài đặt đầy đủ!', 'info');
    return;
  }

  isBatchDownloading = true;
  const progressArea = $('conn-download-all-progress-area');
  const progressBar = $('conn-download-all-progress-bar');
  const progressText = $('conn-download-all-progress-text');
  const statusText = $('conn-download-all-status-text');
  const downloadAllBtn = $('conn-download-all-btn');
  const refreshBtn = $('conn-refresh-btn');

  if (progressArea) progressArea.classList.remove('hidden');
  if (downloadAllBtn) { downloadAllBtn.disabled = true; downloadAllBtn.style.opacity = '0.5'; }
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.style.opacity = '0.5'; }

  const totalItems = missingList.length;

  try {
    for (let index = 0; index < totalItems; index++) {
      const item = missingList[index];
      const basePercent = (index / totalItems) * 100;
      const stepWeight = 100 / totalItems;

      const updateProgress = (itemPercent, customStatusMsg) => {
        const overallPercent = Math.min(99, Math.round(basePercent + (itemPercent * stepWeight / 100)));
        if (progressBar) progressBar.style.width = `${overallPercent}%`;
        if (progressText) progressText.textContent = `${overallPercent}%`;
        const textMsg = (typeof customStatusMsg === 'string' && customStatusMsg.trim())
          ? customStatusMsg
          : `Đang tải ${item.label} (${index + 1}/${totalItems})...`;
        if (statusText) statusText.textContent = textMsg;
      };

      updateProgress(0, `Bắt đầu tải ${item.label} (${index + 1}/${totalItems})...`);

      if (item.type === 'whisper') {
        await fetch('/api/download-whisper-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'large-v3-turbo' })
        });
        await pollProgress('/api/whisper-model/status', updateProgress, (d) => d.exists || d.status === 'success' || d.status === 'completed', (d) => d.percent || 0);
      } else if (item.type === 'separator') {
        await fetch('/api/download-dependency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'separator' })
        });
        await pollProgress('/api/download-dependency-progress', updateProgress, (d) => d.status === 'success' || d.status === 'completed' || d.percent >= 100, (d) => d.percent || 0);
      } else if (item.type === 'omnivoice') {
        await fetch('/api/download-model', { method: 'POST' });
        await pollProgress('/api/download-model/status', updateProgress, (d) => d.status === 'completed' || d.status === 'success' || (!d.downloading && d.percent >= 100), (d) => d.percent || 0);
      } else if (item.type === 'ocr') {
        await fetch('/api/ocr-component/download', { method: 'POST' });
        await pollProgress(
          '/api/ocr-component/download-status',
          (percent, data) => {
            let msg = `Đang tải ${item.label} (${index + 1}/${totalItems})...`;
            if (data && data.step === 'extracting') {
              msg = `Đang giải nén ${item.label} (${index + 1}/${totalItems})...`;
            } else if (data && data.step === 'installing') {
              msg = `Đang cài đặt ${item.label} (${index + 1}/${totalItems})...`;
            }
            updateProgress(percent, msg);
          },
          (d) => d.status === 'ready' || d.status === 'completed' || d.status === 'success',
          (d) => d.percent || d.downloadPercent || 0
        );
      }
    }

    if (progressBar) progressBar.style.width = '100%';
    if (progressText) progressText.textContent = '100%';
    if (statusText) statusText.textContent = '✅ Đã hoàn tất cài đặt tất cả tài nguyên!';
    toast('Đã tải và cài đặt thành công tất cả tài nguyên hệ thống!', 'success');

  } catch (err) {
    console.error('Lỗi khi tải tập trung tài nguyên:', err);
    toast(`Lỗi khi tải tài nguyên: ${err.message}`, 'error');
    if (statusText) statusText.textContent = `❌ Lỗi: ${err.message}`;
  } finally {
    isBatchDownloading = false;
    if (downloadAllBtn) { downloadAllBtn.disabled = false; downloadAllBtn.style.opacity = '1'; }
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.style.opacity = '1'; }
    await checkSystemConnections();
  }
}

async function pollProgress(url, onProgress, isDoneCheck, getPercent) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Không thể kiểm tra tiến trình');
        const data = await res.json();
        const percent = getPercent(data);
        onProgress(percent, data);

        if (isDoneCheck(data)) {
          clearInterval(interval);
          resolve(true);
        } else if (data.status === 'error' || data.error) {
          clearInterval(interval);
          reject(new Error(data.error || 'Lỗi khi tải tài nguyên'));
        }
      } catch (e) {
        if (attempts > 300) { // Max 5 phút timeout
          clearInterval(interval);
          reject(e);
        }
      }
    }, 1000);
  });
}

window.openConnectionStatusModal = openConnectionStatusModal;
window.closeConnectionStatusModal = closeConnectionStatusModal;
window.checkSystemConnections = checkSystemConnections;
window.downloadAllMissingDependencies = downloadAllMissingDependencies;

/* ==========================================================================
   QUẢN LÝ CHỌN GIỌNG NÓI ĐÃ LƯU (NEW GRID VOICE SELECTOR)
   ========================================================================== */

function updatePlayButtonsState(url, isPlaying) {
  const filename = url.substring(url.lastIndexOf('/') + 1);
  const decodedFilename = decodeURIComponent(filename);
  // Handle old-style table play buttons
  document.querySelectorAll('.voice-item-play-btn, .rendered-btn-play').forEach(btn => {
    const html = btn.outerHTML;
    if (html.includes(filename) || html.includes(decodedFilename)) {
      btn.innerHTML = isPlaying ? '⏸ Dừng' : '🔊 Nghe';
      btn.classList.toggle('playing', isPlaying);
    }
  });
  // Handle new gallery card play buttons
  document.querySelectorAll('.agc-btn-play').forEach(btn => {
    const btnUrl = btn.getAttribute('data-audio-url') || '';
    if (btnUrl === url || decodeURIComponent(btnUrl) === decodeURIComponent(url)) {
      const playIcon = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="5,3 19,12 5,21"/></svg>`;
      const pauseIcon = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
      btn.innerHTML = isPlaying ? `${pauseIcon} Dừng` : `${playIcon} Nghe`;
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
    select.dispatchEvent(new Event('change', { bubbles: true }));
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

async function previewEngineVoice(engineId) {
  let voice = '';
  let btnId = '';
  if (engineId === 'piper') {
    voice = $('piper-voice-select')?.value || 'ngochuyen';
    btnId = 'preview-piper-voice-btn';
  } else if (engineId === 'edge-tts') {
    voice = $('edge-voice-select')?.value || 'vi-VN-HoaiMyNeural';
    btnId = 'preview-edge-voice-btn';
  }
  const btn = $(btnId);
  if (!btn) return;

  const currentUrl = btn.getAttribute('data-preview-url');
  if (currentAudio && currentAudioUrl === currentUrl && !currentAudio.paused) {
    currentAudio.pause();
    updatePlayButtonsState(currentUrl, false);
    btn.innerHTML = '🔊 Nghe thử';
    btn.classList.remove('playing');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '⏳ Đang tạo...';

  try {
    const res = await fetch('/api/preview-engine-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: engineId, voice })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể tạo giọng mẫu.');

    btn.setAttribute('data-preview-url', data.audioUrl);
    togglePlayAudio(btn, data.audioUrl);
    btn.innerHTML = '⏸ Dừng';
    btn.classList.add('playing');
  } catch (error) {
    console.error('Lỗi khi nghe thử giọng:', error);
    toast(error.message || 'Lỗi nghe thử giọng.', 'error');
    btn.innerHTML = '🔊 Nghe thử';
    btn.classList.remove('playing');
  } finally {
    btn.disabled = false;
  }
}
window.previewEngineVoice = previewEngineVoice;

$('piper-voice-select')?.addEventListener('change', () => {
  const btn = $('preview-piper-voice-btn');
  if (btn) {
    btn.removeAttribute('data-preview-url');
    btn.innerHTML = '🔊 Nghe thử';
    btn.classList.remove('playing');
  }
});
$('edge-voice-select')?.addEventListener('change', () => {
  const btn = $('preview-edge-voice-btn');
  if (btn) {
    btn.removeAttribute('data-preview-url');
    btn.innerHTML = '🔊 Nghe thử';
    btn.classList.remove('playing');
  }
});

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

function togglePresetPanel(e) {
  const body = $('preset-panel-body');
  const arrow = $('preset-panel-arrow');
  if (!body || !arrow) return;
  if (body.style.display === 'none') {
    body.style.display = 'block';
    arrow.style.transform = 'rotate(0deg)';
  } else {
    body.style.display = 'none';
    arrow.style.transform = 'rotate(-90deg)';
  }
}
window.togglePresetPanel = togglePresetPanel;

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

  // Reset marginL/marginR
  const marginLInput = document.querySelector('input[name="subtitleMarginL"]');
  const marginRInput = document.querySelector('input[name="subtitleMarginR"]');
  if (marginLInput) marginLInput.value = '';
  if (marginRInput) marginRInput.value = '';

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
  const globalLangSel = document.getElementById('global-output-lang');
  if (globalLangSel) globalLangSel.value = 'vi';

  const omiDevice = document.querySelector('select[name="omiDevice"]');
  if (omiDevice) omiDevice.value = 'vulkan:0';

  const stepsSlider = document.querySelector('input[name="omiSteps"]');
  if (stepsSlider) {
    stepsSlider.value = '8';
    const stepsBadge = $('omi-steps-badge');
    if (stepsBadge) stepsBadge.textContent = '8';
  }

  const omiSeedPreset = $('omi-seed-preset');
  if (omiSeedPreset) {
    omiSeedPreset.value = '42';
    omiSeedPreset.dispatchEvent(new Event('change'));
  }
  const omiSeedInput = $('omi-seed-input');
  if (omiSeedInput) omiSeedInput.value = '42';

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
    select.dispatchEvent(new Event('change', { bubbles: true }));
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

  const videoUrl = studioDownloadUrl(filename);
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

  const videoUrl = studioDownloadUrl(filename);
  setPreviewReactionVideo(videoUrl);
  updateConditionalFields();
}

window.selectSourceVideo = selectSourceVideo;
window.selectReactionVideo = selectReactionVideo;

// [Drag Drop Module content moved to js/drag-drop-module.js]

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
  updateMdxProviderUI();
}

function updateMdxProviderUI() {
  const enabled = $('keep-bgm-ai')?.checked === true;
  const settings = $('mdx-provider-settings');
  const select = $('mdx-provider-select');
  const hint = $('mdx-provider-hint');
  const installButton = $('mdx-cuda-install-btn');
  if (settings) settings.classList.toggle('hidden', !enabled);
  if (!select || !hint) return;

  const runtime = dependencyStatus.mdx;
  const canInstall = runtime?.cuda?.hardwareAvailable && !runtime?.cuda?.ready;
  installButton?.classList.toggle('hidden', !enabled || !canInstall);
  const value = select.value || 'auto';
  if (value === 'cpu') {
    hint.textContent = 'CPU tương thích mọi máy. Hiện MDX sử dụng tối đa 4 luồng CPU.';
    hint.style.color = 'var(--muted)';
    return;
  }
  if (value === 'cuda') {
    if (!runtime?.cuda?.hardwareAvailable) {
      hint.textContent = 'Không phát hiện GPU NVIDIA. Chế độ CUDA sẽ không thể chạy trên máy này.';
      hint.style.color = 'var(--danger)';
    } else if (!runtime?.cuda?.ready) {
      hint.textContent = 'Đã phát hiện NVIDIA nhưng component MDX CUDA chưa được cài.';
      hint.style.color = 'var(--warn)';
    } else {
      const gpuName = runtime.hardware?.nvidia?.name || 'NVIDIA GPU';
      hint.textContent = `Sẵn sàng chạy bằng CUDA: ${gpuName}.`;
      hint.style.color = 'var(--success)';
    }
    return;
  }

  if (runtime?.cuda?.hardwareAvailable && runtime?.cuda?.ready) {
    hint.textContent = `Tự động sẽ dùng CUDA trên ${runtime.hardware?.nvidia?.name || 'NVIDIA GPU'}; nếu CUDA lỗi sẽ chuyển sang CPU.`;
    hint.style.color = 'var(--success)';
  } else if (runtime?.cuda?.hardwareAvailable) {
    hint.textContent = 'Máy có NVIDIA nhưng chưa cài MDX CUDA; chế độ Tự động hiện sẽ dùng CPU.';
    hint.style.color = 'var(--warn)';
  } else {
    hint.textContent = 'Không có MDX CUDA phù hợp; chế độ Tự động sẽ dùng CPU.';
    hint.style.color = 'var(--muted)';
  }
}

let mdxCudaDownloadActive = false;

async function installMdxCudaComponent() {
  if (mdxCudaDownloadActive) return;
  const button = $('mdx-cuda-install-btn');
  mdxCudaDownloadActive = true;
  setBusy(button, true, 'Đang chuẩn bị...');
  try {
    const startResponse = await fetch('/api/mdx-cuda-component/download', { method: 'POST' });
    const startData = await startResponse.json();
    if (!startResponse.ok) throw new Error(startData.error || 'Không thể bắt đầu tải MDX CUDA');

    while (true) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const response = await fetch('/api/mdx-cuda-component/download-status');
      const progress = await response.json();
      if (!response.ok) throw new Error(progress.error || 'Không đọc được tiến trình MDX CUDA');
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      setBusy(button, true, `Đang cài ${percent}%`);
      if (progress.status === 'ready') break;
      if (progress.status === 'error') {
        throw new Error(progress.error || 'Cài MDX CUDA thất bại');
      }
      if (progress.status === 'cancelled') {
        throw new Error('Đã hủy cài MDX CUDA');
      }
    }

    const dependencyResponse = await fetch('/api/check-dependencies');
    dependencyStatus = await dependencyResponse.json();
    if (!dependencyResponse.ok || !dependencyStatus.mdx?.cuda?.ready) {
      throw new Error('Component đã tải nhưng chưa vượt qua kiểm tra sẵn sàng');
    }
    updateMdxProviderUI();
    toast('✅ MDX CUDA đã sẵn sàng', 'success');
  } catch (error) {
    toast(`❌ ${error.message}`, 'error');
  } finally {
    mdxCudaDownloadActive = false;
    setBusy(button, false);
    updateMdxProviderUI();
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
    title.textContent = '📥 Tải Faster-Whisper';
    icon.textContent = '🎙️';
    name.textContent = 'Faster-Whisper Large V3 Turbo';
    desc.textContent = 'Model nhận diện giọng nói chính của phần mềm, chạy CUDA khi có GPU NVIDIA và tự tiếp tục bằng CPU int8 khi cần.';
    sizeText.textContent = 'Dung lượng: ~1,51 GB';
  } else if (type === 'separator') {
    title.textContent = '📥 Tải xuống MDX ONNX';
    icon.textContent = '🎵';
    name.textContent = 'Công cụ tách nhạc nền MDX ONNX';
    desc.textContent = 'Một model UVR MDX chạy bằng ONNX Runtime C++. Không cần Python hoặc PyTorch.';
    sizeText.textContent = 'Dung lượng: ~53 MB';
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
// SETUP MODAL (gộp CUDA & Whisper khi lần đầu vào app)
// ==========================================
let setupDownloadState = { cuda: false, whisper: false, separator: false };

function openSetupModal() {
  const cudaMissing = false;
  const whisperMissing = !dependencyStatus.whisper;
  const separatorMissing = !dependencyStatus.separator;
  if (!whisperMissing && !separatorMissing) return;

  const cudaItem = $('setup-cuda-item');
  const whisperItem = $('setup-whisper-item');
  const separatorItem = $('setup-separator-item');

  if (cudaItem) {
    cudaItem.classList.add('hidden');
    resetSetupItemUI('cuda');
  }
  if (whisperItem) {
    whisperItem.classList.toggle('hidden', !whisperMissing);
    resetSetupItemUI('whisper');
  }
  if (separatorItem) {
    separatorItem.classList.toggle('hidden', !separatorMissing);
    resetSetupItemUI('separator');
  }

  setupDownloadState = { cuda: false, whisper: false, separator: false };

  const modal = $('setup-dependencies-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeSetupModal() {
  const modal = $('setup-dependencies-modal');
  if (modal) modal.classList.add('hidden');
}

function resetSetupItemUI(type) {
  const progressArea = $(`setup-${type}-progress-area`);
  const errorEl = $(`setup-${type}-error`);
  const btn = $(`setup-${type}-btn`);
  if (progressArea) progressArea.classList.add('hidden');
  if (errorEl) errorEl.classList.add('hidden');
  if (btn) {
    const labels = { cuda: '📥 Tải CUDA', whisper: '📥 Tải Whisper', separator: '📥 Tải MDX ONNX' };
    btn.textContent = labels[type] || '📥 Tải xuống';
    btn.style.background = 'var(--accent)';
  }
}

async function startSetupDownload(type) {
  if (setupDownloadState[type]) return; // đang tải rồi
  setupDownloadState[type] = true;

  // Vô hiệu hóa nút các item khác (chỉ tải 1 cái 1 lúc)
  const setupOtherTypes = ['cuda', 'whisper', 'separator'].filter(t => t !== type);
  setupOtherTypes.forEach(t => {
    const b = $(`setup-${t}-btn`);
    if (b && !b.disabled) {
      b.disabled = true;
      b.style.opacity = '0.5';
    }
  });

  const btn = $(`setup-${type}-btn`);
  const progressArea = $(`setup-${type}-progress-area`);
  const progressBar = $(`setup-${type}-progress-bar`);
  const progressText = $(`setup-${type}-progress-text`);
  const statusText = $(`setup-${type}-status-text`);
  const errorEl = $(`setup-${type}-error`);

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang tải...'; btn.style.background = '#6b7280'; }
  if (progressArea) progressArea.classList.remove('hidden');
  if (errorEl) errorEl.classList.add('hidden');
  if (progressBar) progressBar.style.width = '0%';
  if (progressText) progressText.textContent = '0%';
  if (statusText) statusText.textContent = 'Đang tải...';

  try {
    const downloadUrl = type === 'whisper' ? '/api/download-whisper-model' : '/api/download-dependency';
    const requestBody = type === 'whisper' ? { model: 'large-v3-turbo' } : { type };
    const res = await fetch(downloadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Yêu cầu tải thất bại');

    // Poll progress
    await pollSetupDownload(type);

  } catch (err) {
    console.error(`Lỗi tải ${type}:`, err);
    if (errorEl) {
      errorEl.textContent = `Lỗi: ${err.message}`;
      errorEl.classList.remove('hidden');
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📥 Thử lại';
      btn.style.background = 'var(--accent)';
    }
    // Kích hoạt lại các nút khác
    setupOtherTypes.forEach(t => {
      const b = $(`setup-${t}-btn`);
      if (b && b.disabled) {
        b.disabled = false;
        b.style.opacity = '1';
      }
    });
    if (statusText) statusText.textContent = 'Thất bại';
    setupDownloadState[type] = false;
  }
}

function pollSetupDownload(type) {
  const setupOtherTypes = ['cuda', 'whisper', 'separator'].filter(t => t !== type);
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const progressUrl = type === 'whisper'
          ? '/api/whisper-model/status'
          : '/api/download-dependency-progress';
        const pRes = await fetch(progressUrl);
        if (!pRes.ok) return;
        const rawProgress = await pRes.json();
        const pData = type === 'whisper'
          ? {
              ...rawProgress,
              status: rawProgress.downloading
                ? 'downloading'
                : rawProgress.exists
                  ? 'success'
                  : rawProgress.error
                    ? 'error'
                    : 'idle'
            }
          : rawProgress;

        const progressBar = $(`setup-${type}-progress-bar`);
        const progressText = $(`setup-${type}-progress-text`);
        const statusText = $(`setup-${type}-status-text`);
        const btn = $(`setup-${type}-btn`);
        const errorEl = $(`setup-${type}-error`);

        if (pData.status === 'downloading') {
          const pct = pData.percent || 0;
          if (progressBar) progressBar.style.width = `${pct}%`;
          if (progressText) progressText.textContent = `${pct}%`;
          if (statusText) statusText.textContent = `Đang tải... ${pct}%`;
        } else if (pData.status === 'setup') {
          if (statusText) statusText.textContent = pData.step || 'Đang cài đặt packages...';
        } else if (pData.status === 'success') {
          clearInterval(interval);
          if (progressBar) progressBar.style.width = '100%';
          if (progressText) progressText.textContent = '100%';
          if (statusText) statusText.textContent = '✅ Hoàn tất';
          if (btn) {
            btn.textContent = '✅ Đã tải';
            btn.style.background = '#22c55e';
          }

          // Check lại dependency status
          await checkLocalDependencies();

          setupDownloadState[type] = false;

          // Nếu tất cả đều xong thì đóng modal
          const allDone = !setupDownloadState.cuda && !setupDownloadState.whisper && !setupDownloadState.separator
            && dependencyStatus.whisper && dependencyStatus.separator;
          if (allDone) {
            setTimeout(() => {
              closeSetupModal();
              toast('🎉 Đã tải xong tất cả tài nguyên hệ thống!', 'success');
            }, 1200);
          } else {
            // Chỉ disable nút tải của cái đã xong
            if (btn) btn.disabled = true;
            // Kích hoạt lại các nút khác nếu đang bị vô hiệu
            setupOtherTypes.forEach(t => {
              const b = $(`setup-${t}-btn`);
              if (b && b.disabled) {
                b.disabled = false;
                b.style.opacity = '1';
              }
            });
          }
          resolve(true);
        } else if (pData.status === 'error') {
          clearInterval(interval);
          if (errorEl) {
            errorEl.textContent = `Lỗi: ${pData.error || 'Không xác định'}`;
            errorEl.classList.remove('hidden');
          }
          if (statusText) statusText.textContent = '❌ Thất bại';
          if (btn) {
            btn.disabled = false;
            btn.textContent = '📥 Thử lại';
            btn.style.background = 'var(--accent)';
          }
          setupDownloadState[type] = false;
          resolve(false);
        }
      } catch (err) {
        console.error(`Lỗi poll ${type}:`, err);
        clearInterval(interval);
      }
    }, 500);
  });
}

window.openSetupModal = openSetupModal;
window.closeSetupModal = closeSetupModal;
window.startSetupDownload = startSetupDownload;

// ==========================================
// AUTO-UPDATE FEATURE HANDLER + VERSION & CHANGELOG
// ==========================================
let updatePollInterval = null;
let _cachedAppVersionData = null;

// --- Hàm tiện ích: render danh sách thay đổi thành HTML ---
function renderChangelogHTML(versions, currentVersion) {
  if (!versions || !versions.length) return '<p style="color: var(--muted); font-size: 13px; text-align: center; padding: 20px;">Chưa có thông tin lịch sử cập nhật.</p>';
  const typeLabels = { feature: { label: 'Mới', icon: '🆕' }, fix: { label: 'Sửa lỗi', icon: '🐛' }, improve: { label: 'Cải thiện', icon: '⚡' } };
  return versions.map(v => {
    const isCurrent = v.version === currentVersion;
    const changesHTML = (v.changes || []).map(c => {
      const t = typeLabels[c.type] || { label: c.type, icon: '📌' };
      return `<li class="changelog-change-item"><span class="changelog-type-badge ${c.type || ''}">${t.icon} ${t.label}</span><span>${c.text}</span></li>`;
    }).join('');
    return `<div class="changelog-version-card ${isCurrent ? 'current' : ''}"><div class="changelog-version-header"><span class="changelog-version-tag">📦 v${v.version}</span>${isCurrent ? '<span class="changelog-current-badge">Hiện tại</span>' : ''}<span class="changelog-version-date">${v.date || ''}</span></div>${v.title ? `<div class="changelog-version-title">"${v.title}"</div>` : ''}<ul class="changelog-changes-list" style="margin-top: 8px;">${changesHTML}</ul></div>`;
  }).join('');
}

function renderSingleVersionChangelog(versionData) {
  if (!versionData || !versionData.changes || !versionData.changes.length) return '';
  const typeLabels = { feature: { label: 'Mới', icon: '🆕' }, fix: { label: 'Sửa lỗi', icon: '🐛' }, improve: { label: 'Cải thiện', icon: '⚡' } };
  return `<div style="margin-bottom: 4px; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">Nội dung cập nhật:</div><ul class="changelog-changes-list">${versionData.changes.map(c => {
    const t = typeLabels[c.type] || { label: c.type, icon: '📌' };
    return `<li class="changelog-change-item"><span class="changelog-type-badge ${c.type || ''}">${t.icon} ${t.label}</span><span>${c.text}</span></li>`;
  }).join('')}</ul>`;
}

async function fetchAndDisplayVersion() {
  try {
    const res = await fetch('/api/app-version');
    if (!res.ok) return;
    const data = await res.json();
    _cachedAppVersionData = data;
    const versionEl = document.getElementById('sidebar-version-text');
    if (versionEl && data.version) versionEl.textContent = `v${data.version}`;
    if (data.justUpdated && data.changelog) showWhatsNewModal(data.version, data.changelog);
  } catch (err) { console.error('[Version] Lỗi khi lấy thông tin phiên bản:', err); }
}

function showWhatsNewModal(version, changelog) {
  const modal = document.getElementById('whats-new-modal');
  const titleEl = document.getElementById('whats-new-title');
  const subtitleEl = document.getElementById('whats-new-subtitle');
  const bodyEl = document.getElementById('whats-new-body');
  if (!modal || !bodyEl) return;
  if (titleEl) titleEl.textContent = `Chào mừng phiên bản v${version}!`;
  if (subtitleEl) subtitleEl.textContent = changelog.title ? `"${changelog.title}" — Ứng dụng đã được cập nhật thành công.` : 'Ứng dụng đã được cập nhật thành công.';
  bodyEl.innerHTML = renderSingleVersionChangelog(changelog);
  modal.classList.remove('hidden');
}

function closeWhatsNewModal() { const m = document.getElementById('whats-new-modal'); if (m) m.classList.add('hidden'); }
window.closeWhatsNewModal = closeWhatsNewModal;

async function openChangelogModal() {
  const modal = document.getElementById('changelog-modal');
  const body = document.getElementById('changelog-modal-body');
  if (!modal || !body) return;
  let data = _cachedAppVersionData;
  if (!data) { try { const res = await fetch('/api/app-version'); if (res.ok) data = await res.json(); } catch (_) {} }
  if (data && data.allChangelog && data.allChangelog.length) {
    body.innerHTML = renderChangelogHTML(data.allChangelog, data.version);
  } else {
    body.innerHTML = '<p style="color: var(--muted); font-size: 13px; text-align: center; padding: 20px;">Chưa có thông tin lịch sử cập nhật.</p>';
  }
  modal.classList.remove('hidden');
}
function closeChangelogModal() { const m = document.getElementById('changelog-modal'); if (m) m.classList.add('hidden'); }
window.openChangelogModal = openChangelogModal;
window.closeChangelogModal = closeChangelogModal;

function startUpdateMonitoring() {
  const modal = document.getElementById('app-update-modal');
  const icon = document.getElementById('update-status-icon');
  const title = document.getElementById('update-title');
  const desc = document.getElementById('update-desc');
  const progressContainer = document.getElementById('update-progress-container');
  const progressBar = document.getElementById('update-progress-bar');
  const actionBtn = document.getElementById('update-action-btn');
  const closeBtn = document.getElementById('update-close-btn');
  const changelogPreview = document.getElementById('update-changelog-preview');

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
        const vt1 = data.newVersion ? ` v${data.newVersion}` : '';
        title.textContent = `Phát hiện bản cập nhật mới${vt1}!`;
        desc.textContent = 'Đang chuẩn bị tải xuống tệp cài đặt mới từ máy chủ...';
        progressContainer.classList.remove('hidden');
        progressBar.style.width = '0%';
        actionBtn.classList.add('hidden');
        closeBtn.classList.add('hidden');
        if (changelogPreview && _cachedAppVersionData && _cachedAppVersionData.allChangelog && data.newVersion) {
          const nvd = _cachedAppVersionData.allChangelog.find(v => v.version === data.newVersion);
          if (nvd) { changelogPreview.innerHTML = renderSingleVersionChangelog(nvd); changelogPreview.classList.remove('hidden'); }
        }
      } else if (data.status === 'downloading') {
        modal.classList.remove('hidden');
        icon.textContent = '⏳';
        const vt2 = data.newVersion ? ` v${data.newVersion}` : '';
        title.textContent = `Đang tải bản cập nhật${vt2}`;
        desc.textContent = `Vui lòng chờ, ứng dụng đang được tải về (${data.percent}%)...`;
        progressContainer.classList.remove('hidden');
        progressBar.style.width = `${data.percent}%`;
        actionBtn.classList.add('hidden');
        closeBtn.classList.add('hidden');
      } else if (data.status === 'downloaded') {
        modal.classList.remove('hidden');
        icon.textContent = '🎉';
        const vt3 = data.newVersion ? ` v${data.newVersion}` : '';
        title.textContent = `Đã tải xong bản cập nhật${vt3}!`;
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

// Khởi tạo khi tải trang
document.addEventListener('DOMContentLoaded', () => {
  // Fetch phiên bản + kiểm tra What's New ngay lập tức
  fetchAndDisplayVersion();
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
  for (const name of ['audioNoiseGate', 'audioDucking', 'audioExportTracks']) {
    const input = form.elements[name];
    obj[name] = input?.checked ? 'true' : 'false';
  }

  // Lưu trạng thái các tabs đang kích hoạt
  obj._sourceMode = document.querySelector('.source-tab-btn.active')?.dataset.sourceMode || 'library';
  obj._reactionMode = document.querySelector('.reaction-tab-btn.active')?.dataset.reactionTabMode || 'none';
  obj._subMode = document.querySelector('.sub-tab-btn.active')?.dataset.subMode || 'none';
  obj._voiceMode = document.querySelector('.voice-tab-btn.active')?.dataset.voiceMode || 'none';
  obj._musicMode = document.querySelector('.music-tab-btn.active')?.dataset.musicMode || 'none';
  obj._logoMode = document.querySelector('.logo-tab-btn.active')?.dataset.logoMode || 'none';

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
        input.checked = (val === 'true' || val === true || val === 'on');
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
  if (obj._logoMode || obj.logoMode || obj.logoEnabled === 'true') {
    const logoMode = obj._logoMode || obj.logoMode || 'saved';
    const btn = document.querySelector(`.logo-tab-btn[data-logo-mode="${logoMode}"]`);
    if (btn) btn.click();
  }

  // Tải lại video nguồn đã chọn và nạp preview
  if (obj.mainVideoFile) {
    const item = Array.from(document.querySelectorAll('#studio-video-grid .video-card-item'))
      .find(c => c.querySelector('.video-card-title')?.textContent === obj.mainVideoFile || c.dataset.filename === obj.mainVideoFile);
    if (item) {
      item.click();
    } else {
      selectSourceVideo(obj.mainVideoFile);
    }
  }

  // Chọn lại video reaction
  if (obj.savedReactionFile) {
    const item = Array.from(document.querySelectorAll('#studio-reaction-video-grid .video-card-item'))
      .find(c => c.dataset.filename === obj.savedReactionFile);
    if (item) {
      item.click();
    } else {
      selectReactionVideo(obj.savedReactionFile);
    }
  }

  // Cập nhật lại các trường phụ đề
  updateConditionalFields();
  updateLogoUi();
  // Kích hoạt lại giao diện toggle switches cho cắt đầu cuối & watermark
  ['antidupe-flip', 'antidupe-enable', 'antidupe-wm-enable'].forEach(id => {
    const el = $(id);
    if (el) el.dispatchEvent(new Event('change'));
  });

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
  if (typeof updateBlurBoxPreview === 'function') updateBlurBoxPreview();

  // Đợi video load metadata xong rồi mới cập nhật overlay phụ đề
  // để tránh tính toán sai vị trí khi videoWidth/videoHeight chưa sẵn sàng
  const previewVideo = $('studio-video-preview');
  if (previewVideo && previewVideo.src && previewVideo.src !== '') {
    if (previewVideo.readyState >= 1) {
      // Video đã có metadata, delay nhỏ để đảm bảo input values đã được gán hết
      setTimeout(() => updateSubtitleOverlayFromInputs(), 150);
    } else {
      // Chờ video tải metadata xong rồi mới cập nhật overlay
      previewVideo.addEventListener('loadedmetadata', () => {
        // Delay nhỏ để đảm bảo callback gốc từ setPreviewVideo chạy xong trước
        setTimeout(() => updateSubtitleOverlayFromInputs(), 100);
      }, { once: true });
    }
  } else {
    updateSubtitleOverlayFromInputs();
  }

  // Áp dụng tỉ lệ màn hình đã lưu lên preview
  const aspectInput = form.elements['previewAspect'];
  if (aspectInput) {
    aspectInput.dispatchEvent(new Event('change'));
  }

  // Cập nhật giao diện giọng đang chọn
  if (obj.savedVoiceFile) {
    document.querySelectorAll('.voice-item-card').forEach(card => {
      card.classList.toggle('active', card.dataset.filename === obj.savedVoiceFile);
    });
  }
  renderSelectedVoiceRow();

  // Cập nhật giao diện nhạc đang chọn
  if (obj.savedMusicFile) {
    document.querySelectorAll('.music-item-card').forEach(card => {
      card.classList.toggle('active', card.dataset.filename === obj.savedMusicFile);
    });
  }
  renderSelectedMusicRow();

  // Áp dụng âm lượng mixer đã lưu lên preview
  applyMixerVolumes();

  // Cập nhật label % cho volume sliders
  ['originalVolume', 'voiceVolume', 'musicVolume'].forEach(name => {
    const el = document.querySelector(`[name="${name}"]`);
    if (el) {
      const spanId = name.replace(/([A-Z])/g, "-$1").toLowerCase() + "-val";
      const valSpan = $(spanId);
      if (valSpan) valSpan.textContent = Math.round(sliderToVolume(el.value) * 100) + '%';
    }
  });

  // Cập nhật nguồn audio preview cho giọng/nhạc
  if (typeof updatePreviewAudioSources === 'function') {
    updatePreviewAudioSources();
  }
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
  const logoBtn = document.querySelector('.logo-tab-btn[data-logo-mode="none"]');
  if (logoBtn) logoBtn.click();

  const previewVideo = $('studio-video-preview');
  if (previewVideo) {
    previewVideo.src = '';
    previewVideo.load();
  }
  $('video-preview-wrapper').classList.add('hidden');
  $('preview-placeholder').classList.remove('hidden');

  updateConditionalFields();
  updateLogoUi();

  // Xóa vùng làm mờ
  blurBoxes = [];
  activeBlurBoxId = null;
  renderBlurBoxesList();
  updateSubtitleOverlayFromInputs();
}

let currentProjectsList = [];

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
  if (projectInfo) projectInfo.style.display = 'grid';
}

async function backToStudioHome() {
  switchView('studio');
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
  window.__projectDirty = true;
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
    
    window.__projectDirty = false;
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
    window.__projectDirty = true;

    // Backup form data to localStorage ngay lập tức khi có thay đổi
    try {
      const formData = serializeStudioForm();
      localStorage.setItem('studio_form_backup', JSON.stringify(formData));
    } catch (e) { /* silent */ }

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

async function loadProject(id, skipSaveCheck) {
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
    window.__projectDirty = false;

    toast(`📂 Đã nạp dự án "${currentProjectName}" thành công!`, 'success');
    if (skipSaveCheck) {
      executeSwitchView('studio');
      openStudioEditor();
    } else {
      switchView('studio');
      openStudioEditor();
    }
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

    // Khôi phục backup từ localStorage (ưu tiên cao nhất — ghi đè dữ liệu server)
    const backup = localStorage.getItem('studio_form_backup');
    if (backup) {
      try {
        const backupData = JSON.parse(backup);
        const form = $('studio-form');
        if (form) {
          Object.entries(backupData).forEach(([key, val]) => {
            const input = form.elements[key];
            if (input) {
              if (input.type === 'checkbox') {
                input.checked = (val === 'true' || val === true || val === 'on');
              } else {
                input.value = val;
              }
            }
          });
          // Cập nhật giao diện toggle switches sau khi restore backup
          ['antidupe-flip', 'antidupe-enable', 'antidupe-wm-enable'].forEach(id => {
            const el = $(id);
            if (el) el.dispatchEvent(new Event('change'));
          });
        }
        console.log('[Project] Đã merge backup localStorage.');

        // Gọi lại các hàm cập nhật UI sau khi merge backup
        if (typeof applyMixerVolumes === 'function') applyMixerVolumes();
        // Cập nhật label % cho volume sliders
        ['originalVolume', 'voiceVolume', 'musicVolume'].forEach(name => {
          const el = document.querySelector(`[name="${name}"]`);
          if (el) {
            const spanId = name.replace(/([A-Z])/g, "-$1").toLowerCase() + "-val";
            const valSpan = $(spanId);
            if (valSpan) valSpan.textContent = Math.round(sliderToVolume(el.value) * 100) + '%';
          }
        });
        const aspectInput = form.elements['previewAspect'];
        if (aspectInput) aspectInput.dispatchEvent(new Event('change'));
        renderSelectedVoiceRow();
        renderSelectedMusicRow();
        if (typeof updatePreviewAudioSources === 'function') updatePreviewAudioSources();
      } catch (e) {
        console.error('[Project] Lỗi parse backup localStorage:', e.message);
      }
    }
  } catch (e) {
    console.error('[Project] Không thể tự động khôi phục dự án cũ:', e.message);
  }
}

function closeRenameModal() {
  const modal = $('rename-project-modal');
  if (modal) modal.classList.add('hidden');
}

function confirmRenameProject() {
  const modal = $('rename-project-modal');
  const input = $('rename-project-input');
  const val = input ? input.value.trim() : '';
  const id = modal ? modal.dataset.projectId : null;

  if (val === '') {
    toast('Tên dự án không được để trống.', 'error');
    return;
  }
  if (!id) {
    toast('Không tìm thấy ID dự án.', 'error');
    return;
  }

  if (modal) modal.classList.add('hidden');

  const trimmed = val.trim();
  (async () => {
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
  })();
}

function renameProject(id, oldName) {
  const modal = $('rename-project-modal');
  const input = $('rename-project-input');
  if (modal) {
    modal.dataset.projectId = id;
    input.value = oldName || '';
    input.focus();
    input.select();
    input.onkeydown = e => {
      if (e.key === 'Enter') confirmRenameProject();
      if (e.key === 'Escape') closeRenameModal();
    };
    modal.onclick = e => {
      if (e.target === modal) closeRenameModal();
    };
    modal.classList.remove('hidden');
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

    toast('Đã xóa dự án thành công!', 'success');
    renderProjectsList();
  } catch (error) {
    console.error('Lỗi xóa dự án:', error);
    toast('Lỗi xóa dự án: ' + error.message, 'error');
  }
}

async function renderProjectsList() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Không thể tải danh sách dự án');
    const data = await res.json();
    currentProjectsList = data.projects || [];
    projectsPage = 1;
    
    filterAndRenderProjects();
    renderSidebarRecentProjects(); // Cập nhật sidebar recent

    // Cập nhật stat strip Studio
    const statProjects = $('stat-total-projects');
    if (statProjects) statProjects.textContent = currentProjectsList.length;
  } catch (error) {
    console.error('Lỗi khi nạp danh sách dự án:', error);
    toast('Lỗi khi nạp danh sách dự án: ' + error.message, 'error');
  }
}

const PROJECTS_PER_PAGE = 5;
let projectsPage = 1;

function renderProjectPaginationControls(total, perPage, currentPage, container) {
  if (!container || typeof container.appendChild !== 'function') return;
  const totalPages = Math.ceil(total / perPage);
  if (totalPages <= 1) return;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display: flex; align-items: center; justify-content: center; gap: 6px; padding: 12px 0;';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'ghost-btn';
  prevBtn.textContent = '‹';
  prevBtn.style.cssText = 'padding: 4px 12px; font-size: 14px; font-weight: 700;';
  prevBtn.disabled = currentPage <= 1;
  prevBtn.onclick = () => { projectsPage = currentPage - 1; filterAndRenderProjects(); };
  wrap.appendChild(prevBtn);

  const maxVisible = 5;
  let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let end = Math.min(totalPages, start + maxVisible - 1);
  if (end - start + 1 < maxVisible) start = Math.max(1, end - maxVisible + 1);

  if (start > 1) {
    const first = document.createElement('button');
    first.type = 'button';
    first.className = 'ghost-btn';
    first.textContent = '1';
    first.style.cssText = 'padding: 4px 10px; font-size: 13px;';
    first.onclick = () => { projectsPage = 1; filterAndRenderProjects(); };
    wrap.appendChild(first);
    if (start > 2) {
      const dots = document.createElement('span');
      dots.textContent = '...';
      dots.style.cssText = 'color: var(--muted); font-size: 12px; padding: 0 2px;';
      wrap.appendChild(dots);
    }
  }

  for (let i = start; i <= end; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-btn';
    btn.textContent = String(i);
    btn.style.cssText = `padding: 4px 10px; font-size: 13px; font-weight: ${i === currentPage ? '700' : '400'}; background: ${i === currentPage ? 'var(--accent)' : 'transparent'}; color: ${i === currentPage ? 'white' : 'var(--text)'};`;
    btn.onclick = () => { projectsPage = i; filterAndRenderProjects(); };
    wrap.appendChild(btn);
  }

  if (end < totalPages) {
    if (end < totalPages - 1) {
      const dots = document.createElement('span');
      dots.textContent = '...';
      dots.style.cssText = 'color: var(--muted); font-size: 12px; padding: 0 2px;';
      wrap.appendChild(dots);
    }
    const last = document.createElement('button');
    last.type = 'button';
    last.className = 'ghost-btn';
    last.textContent = String(totalPages);
    last.style.cssText = 'padding: 4px 10px; font-size: 13px;';
    last.onclick = () => { projectsPage = totalPages; filterAndRenderProjects(); };
    wrap.appendChild(last);
  }

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'ghost-btn';
  nextBtn.textContent = '›';
  nextBtn.style.cssText = 'padding: 4px 12px; font-size: 14px; font-weight: 700;';
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.onclick = () => { projectsPage = currentPage + 1; filterAndRenderProjects(); };
  wrap.appendChild(nextBtn);
  container.appendChild(wrap);
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
          <div style="aspect-ratio: 16/9; background: var(--panel); border-radius: 4px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; border: 1px solid var(--border);">
            ${p.thumbnail ? `<img src="${p.thumbnail}?t=${p.updatedAt || Date.now()}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--soft)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;"><path d="M2 3h20v18H2z"/><path d="M2 7h20"/><path d="m5 3 3 4"/><path d="m10 3 3 4"/><path d="m15 3 3 4"/></svg>`}
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="font-weight: 600; font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}</span>
            <span style="font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.videoTitle || 'Chưa chọn video'}</span>
            <span style="font-size: 10px; color: var(--muted); margin-top: 4px;">Cập nhật: ${new Date(p.updatedAt).toLocaleString('vi-VN')}</span>
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
      const totalPages = Math.ceil(filtered.length / PROJECTS_PER_PAGE);
      if (projectsPage > totalPages) projectsPage = totalPages;
      const startIdx = (projectsPage - 1) * PROJECTS_PER_PAGE;
      const pageItems = filtered.slice(startIdx, startIdx + PROJECTS_PER_PAGE);
      pageItems.forEach(p => {
        const isActive = p.id === currentProjectId;
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom: 1px solid var(--border); font-size: 13px;';
        tr.innerHTML = `
          <td style="padding: 12px 8px; font-weight: 600; color: var(--text);">${p.name}</td>
          <td style="padding: 12px 8px; color: var(--muted);">${p.videoTitle || '---'}</td>
          <td style="padding: 12px 8px; color: var(--muted);">${new Date(p.updatedAt).toLocaleString('vi-VN')}</td>
          <td style="padding: 12px 8px; text-align: right;">
            <div style="display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%;">
              ${isActive ? `<span style="background: rgba(34, 197, 94, 0.15); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.2); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; white-space: nowrap;">Đang mở</span>` : ''}
              <button type="button" class="ghost-btn" style="padding: 4px 10px; font-size: 11px; font-weight: 600;" onclick="loadProject('${p.id}')">Mở</button>
              <div class="project-action-dropdown">
                <button type="button" class="project-action-btn-trigger">•••</button>
                <div class="project-action-menu">
                  <button type="button" class="project-action-item" onclick="renameProject('${p.id}', '${p.name.replace(/'/g, "\\'")}')">Đổi tên</button>
                  <button type="button" class="project-action-item" onclick="duplicateProject('${p.id}')">Nhân bản</button>
                  <button type="button" class="project-action-item danger-action" onclick="deleteProject('${p.id}')">Xóa</button>
                </div>
              </div>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }
    // Pagination controls
    const paginationRoot = $('project-pagination-root');
    if (paginationRoot) paginationRoot.innerHTML = '';
    if (filtered.length > PROJECTS_PER_PAGE && paginationRoot) {
      const paginationWrap = document.createElement('div');
      paginationWrap.className = 'project-pagination';
      renderProjectPaginationControls(filtered.length, PROJECTS_PER_PAGE, projectsPage, paginationWrap);
      paginationRoot.appendChild(paginationWrap);
    }
  }
}

function positionDropdown(trigger, menu) {
  menu.style.visibility = 'hidden';
  menu.style.display = 'block';
  menu.classList.add('project-action-fixed');
  menu.style.top = '-9999px';
  menu.style.left = '-9999px';
  // Force reflow để đo kích thước
  void menu.offsetHeight;

  const menuH = menu.offsetHeight;
  const menuW = menu.offsetWidth;

  menu.style.visibility = '';
  menu.style.display = '';
  menu.style.top = '';
  menu.style.left = '';

  const tr = trigger.getBoundingClientRect();
  const gap = 4;
  const menuWidth = Math.min(Math.max(menuW, 120), 160);
  const spaceBelow = window.innerHeight - tr.bottom - gap;
  const spaceAbove = tr.top - gap;

  menu.style.width = menuWidth + 'px';
  menu.style.left = Math.max(gap, tr.right - menuWidth) + 'px';

  if (spaceBelow >= menuH) {
    menu.style.top = (tr.bottom + gap) + 'px';
  } else {
    menu.style.top = Math.max(gap, tr.top - menuH - gap) + 'px';
  }
}

document.addEventListener('click', e => {
  const trigger = e.target.closest('.project-action-btn-trigger');
  if (!trigger) return;
  const dropdown = trigger.closest('.project-action-dropdown');
  if (!dropdown) return;

  e.stopPropagation();

  const isOpening = !dropdown.classList.contains('open');

  // Đóng tất cả dropdown khác, xoá inline styles + class
  document.querySelectorAll('.project-action-dropdown.open').forEach(d => {
    d.classList.remove('open');
    const m = d.querySelector('.project-action-menu');
    if (m) {
      m.classList.remove('project-action-fixed');
      m.style.top = '';
      m.style.left = '';
      m.style.width = '';
    }
  });

  if (isOpening) {
    dropdown.classList.add('open');
    const menu = dropdown.querySelector('.project-action-menu');
    if (menu) positionDropdown(trigger, menu);
  }
});

document.addEventListener('click', e => {
  if (!e.target.closest('.project-action-dropdown')) {
    document.querySelectorAll('.project-action-dropdown.open').forEach(d => {
      d.classList.remove('open');
      const m = d.querySelector('.project-action-menu');
      if (m) {
        m.classList.remove('project-action-fixed');
        m.style.top = '';
        m.style.left = '';
        m.style.width = '';
      }
    });
  }
});

async function initActiveProject() {
  currentProjectId = localStorage.getItem('current_project_id') || null;
  currentProjectName = localStorage.getItem('current_project_name') || 'Dự án chưa đặt tên';

  const nameInput = $('project-name-input');
  if (nameInput) {
    nameInput.value = currentProjectName;
  }

  if (currentProjectId) {
    await loadProjectQuietly(currentProjectId);
    await restoreLatestRenderUiSnapshotForCurrentProject();
  }
  window.__projectDirty = false;
  
  setupStudioFormAutoSave();
}

// Dirty flag for unsaved project changes
window.__projectDirty = false;
window.__isProjectDirty = () => window.__projectDirty;
window.__getProjectName = () => currentProjectName || 'Dự án chưa đặt tên';
window.__saveProjectForQuit = async () => {
  // Backup form data to localStorage ngay lập tức (luôn chạy trước)
  try {
    const formData = serializeStudioForm();
    localStorage.setItem('studio_form_backup', JSON.stringify(formData));
  } catch (e) { /* silent */ }

  try {
    await saveProjectExplicitly();
  } catch (e) {
    console.error('[Quit] Lỗi lưu dự án:', e.message);
  }
  window.__projectDirty = false;
};

// Export functions to global scope
window.applyAppUpdate = applyAppUpdate;
window.closeUpdateModal = closeUpdateModal;
window.createNewProject = createNewProject;
window.createNewProjectAndNavigate = createNewProjectAndNavigate;
window.saveProjectExplicitly = saveProjectExplicitly;
window.loadProject = loadProject;
window.renameProject = renameProject;
window.closeRenameModal = closeRenameModal;
window.confirmRenameProject = confirmRenameProject;
window.duplicateProject = duplicateProject;
window.deleteProject = deleteProject;
window.renderProjectsList = renderProjectsList;
window.initActiveProject = initActiveProject;
window.backToStudioHome = backToStudioHome;
window.openStudioEditor = openStudioEditor;

function saveProjectSynchronously() {
  if (!currentProjectId) {
    currentProjectId = `proj_${Date.now()}`;
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

  // Backup form data to localStorage trước, đảm bảo không mất dữ liệu
  try {
    localStorage.setItem('studio_form_backup', JSON.stringify(payload.data));
    localStorage.setItem('current_project_id', currentProjectId);
    localStorage.setItem('current_project_name', currentProjectName);
  } catch (e) {
    console.error('[Unload] Lỗi lưu backup localStorage:', e.message);
  }

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects', false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(payload));
    const resp = JSON.parse(xhr.responseText || '{}');
    if (!resp.success) throw new Error(resp.error || 'Unknown error');
    window.__projectDirty = false;
    console.log('[Unload] Dự án đã được lưu đồng bộ:', currentProjectId);
  } catch (e) {
    console.error('[Unload] Lỗi lưu dự án:', e.message);
  }
}

// beforeunload removed — việc lưu project được xử lý qua close confirmation dialog

// Điều chỉnh âm lượng video gốc khi xem trước
document.addEventListener('DOMContentLoaded', () => {
  const volSlider = document.getElementById('main-video-volume-slider');
  const mainVideo = document.getElementById('studio-video-preview');
  const volIcon = document.getElementById('main-video-volume-icon');

  if (volSlider && mainVideo && volIcon) {
    const updateIcon = () => {
      if (mainVideo.muted || mainVideo.volume === 0) {
        volIcon.textContent = '🔇';
      } else {
        volIcon.textContent = '🔊';
      }
    };

    volSlider.addEventListener('input', (e) => {
      mainVideo.volume = e.target.value;
      if (mainVideo.volume > 0) {
        mainVideo.muted = false;
      } else {
        mainVideo.muted = true;
      }
      updateIcon();
    });

    volIcon.addEventListener('click', () => {
      if (mainVideo.muted || mainVideo.volume === 0) {
        mainVideo.muted = false;
        if (mainVideo.volume === 0) {
          mainVideo.volume = 1;
          volSlider.value = 1;
        }
      } else {
        mainVideo.muted = true;
      }
      updateIcon();
    });

    // Đặt lại âm lượng nếu video được load
    mainVideo.addEventListener('loadedmetadata', () => {
      mainVideo.volume = volSlider.value;
      mainVideo.muted = false;
      updateIcon();
    });
  }
});

// =============================================
// SIDEBAR — Dự án gần đây, Disk, User Info
// =============================================

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const gb = bytes / 1073741824;
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  const mb = bytes / 1048576;
  if (mb >= 1) return mb.toFixed(0) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function renderSidebarRecentProjects() {
  const container = $('sidebar-recent-list');
  if (!container) return;

  const list = (currentProjectsList || []).slice(0, 5);
  if (list.length === 0) {
    container.innerHTML = '<div class="sidebar-recent-empty">Chưa có dự án nào</div>';
    return;
  }

  container.innerHTML = list.map(p => `
    <div class="sidebar-recent-item" onclick="openProjectFromSidebar('${p.id}')" title="${p.name}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h20v18H2z"/><path d="M2 7h20"/><path d="m5 3 3 4"/><path d="m10 3 3 4"/><path d="m15 3 3 4"/></svg>
      <span>${p.name}</span>
    </div>
  `).join('');
}

function openProjectFromSidebar(projectId) {
  // Chuyển sang Studio render rồi mở project
  executeSwitchView('studio');
  if (typeof loadProject === 'function') {
    setTimeout(() => loadProject(projectId), 80);
  }
}
window.openProjectFromSidebar = openProjectFromSidebar;

async function loadAppInfo() {
  try {
    // Fetch projects cho sidebar (nếu chưa có)
    if (!currentProjectsList || currentProjectsList.length === 0) {
      try {
        const pr = await fetch('/api/projects');
        if (pr.ok) {
          const pd = await pr.json();
          currentProjectsList = pd.projects || [];
          renderSidebarRecentProjects();
        }
      } catch (_) { }
    }

    const res = await fetch('/api/app-info');
    if (!res.ok) return;
    const data = await res.json();

    // --- Disk ---
    const { usedByApp = 0, total = 0 } = data.disk || {};
    const diskText = $('sidebar-disk-text');
    const diskBar = $('sidebar-disk-bar');
    const diskTrack = $('sidebar-disk-track');
    if (diskText && diskBar) {
      const txt = formatBytes(usedByApp) + ' / ' + formatBytes(total);
      diskText.textContent = txt;
      if (diskTrack) diskTrack.dataset.text = txt;
      const pct = total > 0 ? Math.min(100, (usedByApp / total) * 100) : 0;
      diskBar.style.width = pct + '%';
      // Cảnh báo màu đỏ nếu gần đầy (>90%)
      diskBar.style.background = pct > 90
        ? 'linear-gradient(90deg,#ef4444,#f87171)'
        : 'linear-gradient(90deg,var(--accent),var(--accent-2))';
    }

    // --- License / User ---
    const lic = data.license || {};
    const nameEl = $('sidebar-user-name');
    const planEl = $('sidebar-user-plan');
    const expiryEl = $('sidebar-user-expiry');
    const avatarEl = $('sidebar-user-avatar');

    if (lic.valid) {
      const name = lic.customerName || 'Khách hàng';
      const plan = lic.plan || 'Standard';
      const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      if (avatarEl) avatarEl.textContent = initials;
      if (nameEl) nameEl.textContent = name;
      if (planEl) planEl.textContent = plan;
      if (expiryEl) {
        const days = lic.daysLeft;
        if (days === null || days === undefined) {
          expiryEl.textContent = 'Vĩnh viễn';
          expiryEl.style.color = 'var(--accent)';
        } else {
          const dateStr = lic.expiresAt ? new Date(lic.expiresAt).toLocaleDateString('vi-VN') : '';
          expiryEl.textContent = `Còn ${days} ngày (${dateStr})`;
          expiryEl.style.color = days <= 7 ? 'var(--danger)' : days <= 30 ? 'var(--warn)' : 'var(--muted)';
        }
      }
    } else {
      if (avatarEl) avatarEl.textContent = '?';
      if (nameEl) nameEl.textContent = 'Chưa kích hoạt';
      if (planEl) planEl.textContent = '';
      if (expiryEl) expiryEl.textContent = '';
    }
  } catch (e) {
    console.warn('[AppInfo] Lỗi:', e.message);
  }
}

function toggleSidebarSettings(e) {
  e.stopPropagation();
  const dropdown = $('sidebar-settings-dropdown');
  const btn = $('sidebar-settings-btn');
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  dropdown.classList.toggle('open', !isOpen);
  if (btn) btn.classList.toggle('active', !isOpen);
}
window.toggleSidebarSettings = toggleSidebarSettings;

// Đóng dropdown khi click ra ngoài
document.addEventListener('click', (e) => {
  const dropdown = $('sidebar-settings-dropdown');
  const btn = $('sidebar-settings-btn');
  if (!dropdown || !dropdown.classList.contains('open')) return;
  if (!dropdown.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
    dropdown.classList.remove('open');
    if (btn) btn.classList.remove('active');
  }
});

// Gọi khi app khởi động
document.addEventListener('DOMContentLoaded', () => {
  loadAppInfo();
  renderSidebarRecentProjects();
  // Refresh mỗi 30 phút
  setInterval(loadAppInfo, 30 * 60 * 1000);

  // Collapsible sections
  function toggleCollapse(headerId, fieldsId, iconId) {
    const header = $(headerId);
    const fields = $(fieldsId);
    const icon = $(iconId);
    if (header && fields && icon) {
      header.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const isOpen = fields.style.display !== 'none';
        fields.style.display = isOpen ? 'none' : 'block';
        icon.textContent = isOpen ? '▶' : '▼';
        updateSubtitleOverlayFromInputs();
      });
    }
  }
  // Toggle switch for flip
  const setupToggleSwitch = (id, fieldsId) => {
    const cb = $(id);
    const track = $(`${id}-track`);
    const knob = $(`${id}-knob`);
    const fields = $(fieldsId);
    if (cb && track && knob) {
      const update = () => {
        const on = cb.checked;
        track.style.background = on ? 'var(--accent, #3B82F6)' : '#444';
        knob.style.transform = on ? 'translateX(20px)' : 'translateX(0)';
        knob.style.background = on ? '#fff' : '#ccc';
        if (fields) fields.style.display = on ? 'block' : 'none';
        updateSubtitleOverlayFromInputs();
      };
      cb.addEventListener('change', update);
      update();
    }
  };
  setupToggleSwitch('antidupe-enable', 'antidupe-fields');
  setupToggleSwitch('antidupe-wm-enable', 'antidupe-wm-fields');
  const flipCheckbox = $('antidupe-flip');
  const flipTrack = $('antidupe-flip-track');
  const flipKnob = $('antidupe-flip-knob');
  if (flipCheckbox && flipTrack && flipKnob) {
    const updateFlip = () => {
      const on = flipCheckbox.checked;
      flipTrack.style.background = on ? 'var(--accent, #3B82F6)' : '#444';
      flipKnob.style.transform = on ? 'translateX(20px)' : 'translateX(0)';
      flipKnob.style.background = on ? '#fff' : '#ccc';
    };
    flipCheckbox.addEventListener('change', () => { updateFlip(); updateSubtitleOverlayFromInputs(); });
    updateFlip();
  }
});
