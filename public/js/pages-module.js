/**
 * pages-module.js — Nhóm hàm Quản lý Fanpage / Facebook
 * Được tách từ app.js (dòng ~3532-3868) làm bước thứ 2 modular hóa.
 * Các hàm expose lên window để app.js và HTML onclick vẫn gọi được.
 *
 * Phụ thuộc: globals.js ($), toast(), setBusy() từ app.js
 */

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
        <td colspan="4" style="text-align: center; padding: 40px 16px; border-bottom: none;">
          <div style="display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--muted);">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--soft)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.6;"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
            <div style="font-size: 13.5px; font-weight: 600; color: var(--text);">${searchVal ? 'Không tìm thấy Page nào phù hợp' : 'Chưa có Fanpage nào được lưu'}</div>
            <div style="font-size: 11px;">${searchVal ? 'Thử tìm kiếm với từ khóa khác' : 'Nhấn "THÊM PAGE MỚI" ở trên để kết nối trang Facebook của bạn'}</div>
          </div>
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
          <button type="button" class="ghost-btn" style="padding: 4px 8px; font-size: 11px; height: auto;" onclick="editFbPage(${originalIdx})">Sửa</button>
          <button type="button" class="ghost-btn" style="padding: 4px 8px; font-size: 11px; height: auto; border-color: rgba(239, 68, 68, 0.2); color: var(--danger);" onclick="deleteFbPage(${originalIdx})">Xóa</button>
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
