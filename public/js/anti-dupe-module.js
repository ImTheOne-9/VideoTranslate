'use strict';

let adVideos = [];
let adProgressTimer = null;

function adFmtSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function loadAntiDupeVideos() {
  const grid = $('ad-video-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="no-videos">⏳ Đang nạp danh sách video...</div>';
  try {
    const res = await fetch('/api/studio-assets');
    const data = await res.json();
    adVideos = Array.isArray(data.videos) ? data.videos : [];

    if (!adVideos.length) {
      grid.innerHTML = '<div class="no-videos">Chưa có video nào được tải về. Hãy qua tab Tải video trước.</div>';
      return;
    }

    grid.innerHTML = '';
    const selectedVal = $('ad-selected-video').value;

    for (const item of adVideos) {
      const card = document.createElement('div');
      card.className = 'video-card-item';
      if (selectedVal === item.filename) card.classList.add('selected');
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
          <div class="video-card-meta">${adFmtSize(item.size)}</div>
        </div>
      `;

      const videoEl = card.querySelector('video');
      videoEl.addEventListener('loadedmetadata', () => {
        const dur = card.querySelector('.video-card-duration');
        if (dur) dur.textContent = formatDuration(videoEl.duration);
      });

      card.addEventListener('mouseenter', () => videoEl.play().catch(() => {}));
      card.addEventListener('mouseleave', () => { videoEl.pause(); videoEl.currentTime = 0; });

      card.addEventListener('click', () => {
        grid.querySelectorAll('.video-card-item').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        $('ad-selected-video').value = item.filename;
      });

      grid.appendChild(card);
    }
  } catch (e) {
    grid.innerHTML = '<div class="no-videos">Lỗi nạp danh sách video</div>';
  }
}

function adSelectedSource() {
  // Check upload first
  const upload = $('ad-source-upload');
  if (upload && upload.files && upload.files.length) return { file: upload.files[0], name: upload.files[0].name };

  // Check selected from grid
  const grid = $('ad-video-grid');
  if (grid) {
    const selected = grid.querySelector('.video-card-item.selected');
    if (selected) return { mainVideoFile: selected.dataset.filename, name: selected.dataset.filename };
  }

  return null;
}

function adSwitchSourceTab(mode) {
  const lib = $('ad-source-library');
  const upl = $('ad-source-upload-section');
  document.querySelectorAll('[data-ad-source-mode]').forEach(b => {
    b.classList.toggle('active', b.dataset.adSourceMode === mode);
  });
  if (lib) lib.classList.toggle('hidden', mode !== 'library');
  if (upl) upl.classList.toggle('hidden', mode !== 'upload');
}

function adSetProgress(p) {
  const bar = $('ad-progress-bar'), pct = $('ad-progress-pct'), step = $('ad-progress-step'), meta = $('ad-progress-meta');
  const pctVal = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
  if (bar) bar.style.width = pctVal + '%';
  if (pct) pct.textContent = pctVal + '%';
  if (step) step.textContent = p.step || (p.status === 'idle' ? 'Chưa có tác vụ nào.' : p.status);
  if (meta) {
    let m = '';
    if (p.total) m += 'Tổng: ' + p.total + ' · Đang: ' + (p.current || 0);
    if (p.type) m = (m ? m + ' · ' : '') + (p.type === 'antidupe' ? 'Né trùng' : 'Băm cảnh');
    meta.textContent = m;
  }
  const cancelBtn = $('ad-cancel-btn');
  if (cancelBtn) cancelBtn.style.display = (p.status === 'running' || p.status === 'rendering') ? '' : 'none';
}

function adStopPolling() {
  if (adProgressTimer) { clearInterval(adProgressTimer); adProgressTimer = null; }
}

async function adPoll() {
  try {
    const res = await fetch('/api/anti-dupe-progress');
    const p = await res.json();
    adSetProgress(p);
    if (p.status === 'done' || p.status === 'error' || p.status === 'cancelled' || p.status === 'idle') {
      adStopPolling();
    }
  } catch (e) { /* ignore */ }
}

function adStartPolling() {
  adStopPolling();
  adPoll();
  adProgressTimer = setInterval(adPoll, 1000);
}

async function adCall(url, fd, label) {
  adSetProgress({ percent: 1, step: 'Đang gửi yêu cầu ' + (label || '') + '...', status: 'running' });
  adStartPolling();
  try {
    const res = await fetch(url, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      adStopPolling();
      adSetProgress({ percent: 0, step: 'Lỗi: ' + (data.error || 'Không xác định'), status: 'error' });
      toast(data.error || 'Lỗi xử lý', 'error');
      return null;
    }
    return data;
  } catch (e) {
    adStopPolling();
    adSetProgress({ percent: 0, step: 'Lỗi mạng: ' + e.message, status: 'error' });
    toast('Lỗi mạng: ' + e.message, 'error');
    return null;
  }
}

function adShowResultSingle(data) {
  const box = $('ad-result');
  if (!box || !data) return;
  if (data.url) {
    box.innerHTML = `<div style="display:flex; flex-direction:column; gap:8px;">
      <div style="color:var(--text); font-weight:600;">✅ ${data.message || 'Đã xong'}</div>
      <video src="${data.url}" controls style="width:100%; max-height:320px; border-radius:8px; background:#000;"></video>
      <div style="font-size:12px; color:var(--muted);">${data.file || ''}</div>
      <a href="${data.url}" download="${data.file || ''}" class="ghost-btn" style="text-decoration:none; display:inline-block; width:fit-content; padding:8px 14px;">⬇ Tải file đã xử lý</a>
    </div>`;
  } else if (data.path) {
    box.innerHTML = '<div style="color:var(--text); font-weight:600;">✅ ' + (data.message || 'Đã xong') + '</div><div style="font-size:12px; color:var(--muted);">' + data.path + '</div>';
  }
}

function adShowResultClips(data) {
  const box = $('ad-result');
  if (!box || !data) return;
  const clips = data.clips || [];
  box.innerHTML = '<div style="color:var(--text); font-weight:600; margin-bottom:8px;">✅ ' + (data.message || ('Đã băm ' + data.count + ' clip')) + '</div>' +
    clips.map(c => '<div style="margin-bottom:10px; border:1px solid var(--border); border-radius:8px; overflow:hidden;">' +
      '<video src="' + (c.url || '') + '" controls style="width:100%; max-height:220px; background:#000;"></video>' +
      '<div style="padding:6px 10px; font-size:12px; color:var(--muted); display:flex; justify-content:space-between;">' +
      '<span>#' + c.index + ' · ' + c.file + '</span><span>' + (c.start || 0).toFixed(1) + 's–' + (c.end || 0).toFixed(1) + 's</span>' +
      '</div></div>').join('');
}

function adBuildFd(src, fields) {
  const fd = new FormData();
  if (src.file) fd.append('videoUpload', src.file);
  if (src.mainVideoFile) fd.append('mainVideoFile', src.mainVideoFile);
  for (const k in fields) {
    const v = fields[k];
    if (v !== undefined && v !== null && v !== '') fd.append(k, v);
  }
  return fd;
}

function adSplit() {
  const src = adSelectedSource();
  if (!src) { toast('Hãy chọn video nguồn hoặc tải file lên', 'error'); return; }
  const fd = adBuildFd(src, {
    numCopies: $('ad-num-copies').value,
    sensitivity: $('ad-sensitivity').value,
    aspect: $('ad-aspect2').value,
    flip: $('ad-flip2').checked ? 'true' : '',
    outputDir: $('ad-output-dir').value
  });
  (async () => {
    const btn = $('ad-split-btn'); if (btn) btn.disabled = true;
    const data = await adCall('/api/anti-dupe-scene-split', fd, 'băm cảnh');
    if (btn) btn.disabled = false;
    if (data) { adShowResultClips(data); toast(data.message || 'Băm xong', 'success'); }
  })();
}

async function adCancel() {
  try {
    await fetch('/api/anti-dupe-cancel', { method: 'POST' });
    toast('Đã gửi yêu cầu hủy', 'info');
  } catch (e) { toast('Lỗi hủy: ' + e.message, 'error'); }
}

document.addEventListener('DOMContentLoaded', () => {
  const sp = $('ad-split-btn'); if (sp) sp.addEventListener('click', adSplit);
  const cn = $('ad-cancel-btn'); if (cn) cn.addEventListener('click', adCancel);

  // Tab switching cho video source
  document.querySelectorAll('[data-ad-source-mode]').forEach(btn => {
    btn.addEventListener('click', () => adSwitchSourceTab(btn.dataset.adSourceMode));
  });

  // Chọn thư mục lưu
  const dirBtn = $('ad-output-dir-btn');
  if (dirBtn) dirBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/select-save-path?mode=folder');
      const data = await res.json();
      if (!data.canceled && data.dir) {
        $('ad-output-dir').value = data.dir;
      }
    } catch (e) { toast('Lỗi chọn thư mục', 'error'); }
  });

  // Upload handler
  const up = $('ad-source-upload');
  if (up) up.addEventListener('change', () => {
    if (up.files && up.files.length) {
      const file = up.files[0];
      const prev = $('ad-upload-preview');
      const video = $('ad-upload-video');
      const nm = $('ad-upload-name');
      const sz = $('ad-upload-size');
      if (prev) prev.classList.remove('hidden');
      if (video) video.src = URL.createObjectURL(file);
      if (nm) nm.textContent = file.name;
      if (sz) sz.textContent = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
      const nm2 = $('ad-source-name');
      if (nm2) nm2.textContent = '';
    }
  });

  // Toggle switch cho Lật ngang
  const setupFlipToggle = (id, trackId, knobId) => {
    const cb = $(id), track = $(trackId), knob = $(knobId);
    if (cb && track && knob) {
      const update = () => {
        const on = cb.checked;
        track.style.background = on ? 'var(--accent, #3B82F6)' : '#444';
        knob.style.transform = on ? 'translateX(18px)' : 'translateX(0)';
        knob.style.background = on ? '#fff' : '#ccc';
      };
      cb.addEventListener('change', update);
      update();
    }
  };
  setupFlipToggle('ad-flip2', 'ad-flip2-track', 'ad-flip2-knob');

  // Nạp danh sách video khi mở tab "Băm cảnh"
  const navBtn = document.querySelector('.nav-btn[data-view="antidupe"]');
  if (navBtn) navBtn.addEventListener('click', () => setTimeout(loadAntiDupeVideos, 60));
});
