/* Source management UI; all returned names/titles are untrusted text. */
let crawlDiscoveredSources = [];
let crawlSourceCatalog = [];
const sourceEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sourceApi(url, body, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Không thực hiện được thao tác kênh nguồn.');
  return data;
}

async function crawlDiscoverSources() {
  const button = document.getElementById('source-discovery-run');
  const output = document.getElementById('source-discovery-results');
  button.disabled = true; output.textContent = 'Đang tìm kênh; mỗi nền tảng có thể cần vài phút…';
  try {
    const data = await sourceApi('/api/source-channels/discover', {
      keywords: document.getElementById('source-discovery-keywords').value,
      platforms: [...document.querySelectorAll('[name="source-discovery-platform"]:checked')].map((input) => input.value),
      count: Number(document.getElementById('source-discovery-count').value),
      minVideos: Number(document.getElementById('source-discovery-min').value)
    });
    crawlDiscoveredSources = data.channels || [];
    output.innerHTML = crawlDiscoveredSources.map((channel, index) => `<label style="display:block"><input type="checkbox" data-discovered-source="${index}" checked> ${sourceEscape(channel.name)} · ${sourceEscape(channel.platform)} · ${channel.countIsLowerBound ? '≥' : ''}${channel.videoCount ?? '?'} video</label>`).join('')
      + (data.errors || []).map((error) => `<p>${sourceEscape(error.platform)} / ${sourceEscape(error.keyword)}: ${sourceEscape(error.message)}</p>`).join('');
    if (!crawlDiscoveredSources.length && !data.errors?.length) output.textContent = 'Không tìm thấy kênh phù hợp.';
  } catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
}

async function crawlSaveDiscoveredSources() {
  try {
    let count = 0;
    for (const input of document.querySelectorAll('[data-discovered-source]:checked')) {
      await sourceApi('/api/source-channels', crawlDiscoveredSources[Number(input.dataset.discoveredSource)]); count++;
    }
    toast(`Đã lưu ${count} kênh nguồn.`, 'success');
    await crawlOpenSources();
  } catch (error) { toast(error.message, 'error'); }
}

async function crawlOpenSources() {
  try {
    const data = await sourceApi('/api/source-channels', undefined, 'GET');
    crawlSourceCatalog = data.channels || [];
    let dialog = document.getElementById('crawl-source-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'crawl-source-dialog';
      dialog.style.cssText = 'width:min(1000px,90vw);max-height:85vh;overflow:auto;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:20px';
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = '<form method="dialog"><button>Đóng</button></form><h3>Kênh nguồn · video mới · danh sách tập</h3>'
      + crawlSourceCatalog.map((channel, index) => `<details style="margin:12px 0"><summary>${sourceEscape(channel.name)} · ${channel.newCount || 0} mới · ${channel.videos.length} video</summary>
        <p>${sourceEscape(channel.url)}<br>${sourceEscape(channel.schedule?.lastError || '')}</p>
        <button data-source-action="refresh" data-source-index="${index}">Quét lại</button>
        <button data-source-action="seen" data-source-index="${index}">Đánh dấu đã xem</button>
        <button data-source-action="download" data-source-index="${index}">Tải mục đã chọn</button>
        <button data-source-action="save" data-source-index="${index}">Lưu danh sách</button>
        <button data-source-action="destination" data-source-index="${index}">Đổi tên / cấu hình đích</button>
        <button data-source-action="title" data-source-index="${index}">Đổi tiêu đề mục đã chọn</button>
        <div style="margin:10px 0;display:flex;gap:8px;flex-wrap:wrap">
          <label><input type="checkbox" id="catalog-schedule-${index}" ${channel.schedule?.enabled ? 'checked' : ''}> Bật lịch</label>
          <label>Mỗi ngày <input id="catalog-count-${index}" type="number" min="1" max="100" value="${Number(channel.schedule?.dailyCount) || 3}" style="width:55px"> video</label>
          <input type="time" id="catalog-time-${index}" value="${sourceEscape(channel.schedule?.time || '02:00')}">
          <button data-source-action="schedule" data-source-index="${index}">Lưu lịch</button>
        </div>
        <p>${(channel.lists || []).map((list, listIndex) => `<button data-source-action="load" data-source-index="${index}" data-list-index="${listIndex}">${sourceEscape(list.name)} (${list.ids.length})</button>`).join(' ')}</p>
        <div style="max-height:320px;overflow:auto">${channel.videos.map((video, vi) => `<label style="display:block"><input type="checkbox" data-catalog-channel="${index}" data-video-index="${vi}"> ${video.isNew && !video.seen ? '🆕 ' : ''}${sourceEscape(video.customTitle || video.title)} ${video.downloaded ? ' · đã tải' : ''}${video.duplicateOf ? ' · nghi trùng' : ''}</label>`).join('')}</div></details>`).join('');
    dialog.querySelectorAll('[data-source-action]').forEach((button) => button.addEventListener('click', () => crawlSourceAction(button)));
    if (!dialog.open) dialog.showModal();
  } catch (error) { toast(error.message, 'error'); }
}

async function crawlSourceAction(button) {
  const index = Number(button.dataset.sourceIndex), channel = crawlSourceCatalog[index];
  const selected = [...document.querySelectorAll(`[data-catalog-channel="${index}"]:checked`)].map((input) => channel.videos[Number(input.dataset.videoIndex)].id);
  const base = `/api/source-channels/${encodeURIComponent(channel.id)}`;
  button.disabled = true;
  try {
    switch (button.dataset.sourceAction) {
      case 'schedule': await sourceApi(`${base}/schedule`, {
        enabled: document.getElementById(`catalog-schedule-${index}`).checked,
        dailyCount: Number(document.getElementById(`catalog-count-${index}`).value),
        time: document.getElementById(`catalog-time-${index}`).value
      }); break;
      case 'title': {
        if (selected.length !== 1) throw new Error('Chọn đúng một video để sửa tiêu đề trong danh mục.');
        const video = channel.videos.find((item) => item.id === selected[0]);
        const title = prompt('Tiêu đề trong danh mục (không đổi tên file đã tải):', video.customTitle || video.title);
        if (title === null) return;
        await sourceApi(base, { titles: { [video.id]: title } }, 'PATCH'); break;
      }
      case 'refresh': await sourceApi(`${base}/refresh`, { count: 500 }); break;
      case 'seen': await sourceApi(base, { seenIds: selected }, 'PATCH'); break;
      case 'download': await sourceApi(`${base}/selected`, { ids: selected }); toast('Đã xếp tác vụ tải.', 'success'); crawlStartPolling(); return;
      case 'save': {
        const name = prompt('Tên danh sách tập/video:'); if (!name) return;
        await sourceApi(base, { list: { name, ids: selected, titles: Object.fromEntries(channel.videos.filter((video) => selected.includes(video.id)).map((video) => [video.id, video.customTitle || video.title])) } }, 'PATCH'); break;
      }
      case 'destination': {
        const name = prompt('Tên kênh nguồn:', channel.name); if (name === null) return;
        const pageName = prompt('Tên đích để bàn giao (chưa tự đăng bài):', channel.destination?.pageName || ''); if (pageName === null) return;
        const pageId = prompt('ID đích / Page ID (chỉ lưu cấu hình):', channel.destination?.pageId || ''); if (pageId === null) return;
        const hashtags = prompt('Hashtag mặc định:', channel.destination?.hashtags || ''); if (hashtags === null) return;
        await sourceApi(base, { name, destination: { ...channel.destination, pageName, pageId, hashtags } }, 'PATCH'); break;
      }
      case 'load': {
        const ids = new Set(channel.lists[Number(button.dataset.listIndex)].ids);
        document.querySelectorAll(`[data-catalog-channel="${index}"]`).forEach((input) => { input.checked = ids.has(channel.videos[Number(input.dataset.videoIndex)].id); });
        return;
      }
    }
    await crawlOpenSources();
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}
