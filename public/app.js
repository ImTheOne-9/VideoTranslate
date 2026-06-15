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
  fillSelect('main-video-select', assets.videos, 'Chọn video trong downloads');
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
  return /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/)/.test(url);
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function fetchVideoInfo() {
  const url = $('url-input').value.trim();
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
  vietsub.target = '_blank';
  vietsub.textContent = 'Tải + dịch Vietsub';
  grid.appendChild(vietsub);

  for (const format of data.formats || []) {
    const link = document.createElement('a');
    link.className = 'quality-btn';
    link.href = `/api/download?url=${encodeURIComponent(currentUrl)}&format_id=${encodeURIComponent(format.format_id)}`;
    link.target = '_blank';
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
    $('render-result').classList.remove('empty');
    $('render-result').innerHTML = `
      <video controls src="${result.url}"></video>
      <a class="download-link" href="${result.url}" target="_blank">Mở video render</a>
    `;
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
  const url = $('bulk-url-input').value.trim();
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
  $('subtitle-upload').classList.toggle('hidden', subMode !== 'upload');
  $('saved-subtitle-select').classList.toggle('hidden', subMode !== 'saved');

  const voiceMode = $('voice-mode').value;
  $('saved-voice-select').classList.toggle('hidden', !['saved', 'omi'].includes(voiceMode));
  $('voice-upload').classList.toggle('hidden', voiceMode !== 'upload');
  $('ref-text').classList.toggle('hidden', voiceMode !== 'omi');
  $('omi-script').classList.toggle('hidden', voiceMode !== 'omi');
  document.querySelector('.omi-options').classList.toggle('hidden', voiceMode !== 'omi');

  const musicMode = $('music-mode').value;
  $('saved-music-select').classList.toggle('hidden', musicMode !== 'saved');
  $('music-upload').classList.toggle('hidden', musicMode !== 'upload');
}

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
['subtitle-mode', 'voice-mode', 'music-mode'].forEach(id => $(id).addEventListener('change', updateConditionalFields));

loadAssets().then(updateConditionalFields).catch(() => toast('Không đọc được thư viện local.', 'error'));
