let isDevMode = false;
let currentUser = null;
let authMode = 'login'; // 'login' | 'register' | 'forgot'
let redirectActionAfterAuth = null; // Stored subscribe action if unauthenticated

window.addEventListener('load', async () => {
  lucide.createIcons();
  await checkConfig();
  await checkSession();
});

// Toast Alert system
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg transform translate-y-2 opacity-0 transition-all duration-300 bg-zinc-900 text-sm ${
    type === 'error' ? 'border-rose-900/50 text-rose-400' : 'border-emerald-900/50 text-emerald-400'
  }`;
  
  const iconName = type === 'error' ? 'alert-triangle' : 'check-circle';
  toast.innerHTML = `
    <i data-lucide="${iconName}" class="h-5 w-5 shrink-0"></i>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  lucide.createIcons();

  // Animate in
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  // Animate out and remove
  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Call server API config
async function checkConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    isDevMode = data.isDev;
  } catch (err) {
    console.warn('Lỗi kiểm tra cấu hình:', err.message);
  }
}

// Parse Session token from client-side cookies or check via profile API load
async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 200) {
      const data = await res.json();
      if (data.success && data.user) {
        currentUser = data.user;
        localStorage.setItem('vst_user', JSON.stringify(currentUser));
        updateAuthHeader();
        await loadDashboard();
      } else {
        localStorage.removeItem('vst_user');
        currentUser = null;
        updateAuthHeader();
      }
      
      // Redirect if there is a pending payment key in storage
      const pendingKey = localStorage.getItem('pending_payment_key');
      if (pendingKey) {
        window.location.href = `/payment.html?key=${pendingKey}`;
        return;
      }
    } else {
      localStorage.removeItem('vst_user');
      currentUser = null;
      updateAuthHeader();
      // Open login modal if there is a pending key in storage awaiting login
      const pendingKey = localStorage.getItem('pending_payment_key');
      if (pendingKey) {
        openAuthModal('login');
      }
    }
  } catch (err) {
    localStorage.removeItem('vst_user');
    currentUser = null;
    updateAuthHeader();
    const pendingKey = localStorage.getItem('pending_payment_key');
    if (pendingKey) {
      openAuthModal('login');
    }
  }
}

function updateAuthHeader() {
  const unauth = document.getElementById('unauthHeader');
  const auth = document.getElementById('authHeader');
  const emailDisp = document.getElementById('headerUserEmail');
  const dbSection = document.getElementById('dashboard');
  
  if (currentUser) {
    unauth.classList.add('hidden');
    auth.classList.remove('hidden');
    emailDisp.innerText = currentUser.email;
    emailDisp.classList.remove('hidden');
    dbSection.classList.remove('hidden');
  } else {
    unauth.classList.remove('hidden');
    auth.classList.add('hidden');
    emailDisp.classList.add('hidden');
    dbSection.classList.add('hidden');
  }
}

// Modal Control including Forgot Password Mode
function openAuthModal(mode = 'login', redirectAction = null) {
  authMode = mode;
  redirectActionAfterAuth = redirectAction;
  
  const modal = document.getElementById('authModal');
  const title = document.getElementById('authModalTitle');
  const sub = document.getElementById('authModalSub');
  const icon = document.getElementById('authModalIcon');
  
  const nameGroup = document.getElementById('nameFieldGroup');
  const phoneGroup = document.getElementById('phoneFieldGroup');
  const passwordGroup = document.getElementById('passwordFieldGroup');
  
  const submitText = document.getElementById('submitBtnText');
  const submitIcon = document.getElementById('submitBtnIcon');
  
  const toggleText = document.getElementById('authToggleText');
  const toggleLink = document.getElementById('authToggleLink');
  
  // Hide status notice initially
  hideModalNotice();

  if (mode === 'register') {
    title.innerText = 'Đăng ký tài khoản mới';
    sub.innerText = 'Nhận ngay License Key dùng thử 7 ngày miễn phí';
    icon.setAttribute('data-lucide', 'user-plus');
    
    nameGroup.classList.remove('hidden');
    phoneGroup.classList.remove('hidden');
    passwordGroup.classList.remove('hidden');
    
    submitText.innerText = 'Đăng ký ngay';
    submitIcon.setAttribute('data-lucide', 'arrow-right');
    
    toggleText.innerText = 'Đã có tài khoản?';
    toggleLink.innerText = 'Đăng nhập';
    toggleLink.setAttribute('onclick', "openAuthModal('login')");
  } else if (mode === 'forgot') {
    title.innerText = 'Khôi phục mật khẩu';
    sub.innerText = 'Nhập email của bạn để nhận liên kết khôi phục';
    icon.setAttribute('data-lucide', 'key-round');
    
    nameGroup.classList.add('hidden');
    phoneGroup.classList.add('hidden');
    passwordGroup.classList.add('hidden');
    
    submitText.innerText = 'Gửi liên kết khôi phục';
    submitIcon.setAttribute('data-lucide', 'send');
    
    toggleText.innerText = 'Quay lại';
    toggleLink.innerText = 'Đăng nhập';
    toggleLink.setAttribute('onclick', "openAuthModal('login')");
  } else {
    // default: login
    title.innerText = 'Đăng nhập tài khoản';
    sub.innerText = 'Nhập email và mật khẩu của bạn';
    icon.setAttribute('data-lucide', 'lock');
    
    nameGroup.classList.add('hidden');
    phoneGroup.classList.add('hidden');
    passwordGroup.classList.remove('hidden');
    
    submitText.innerText = 'Xác nhận đăng nhập';
    submitIcon.setAttribute('data-lucide', 'log-in');
    
    toggleText.innerText = 'Chưa có tài khoản?';
    toggleLink.innerText = 'Đăng ký ngay';
    toggleLink.setAttribute('onclick', "openAuthModal('register')");
  }

  modal.classList.remove('hidden');
  lucide.createIcons();
}

function closeAuthModal() {
  document.getElementById('authModal').classList.add('hidden');
}

function toggleAuthType() {
  if (authMode === 'login') {
    openAuthModal('register', redirectActionAfterAuth);
  } else {
    openAuthModal('login', redirectActionAfterAuth);
  }
}

function showModalNotice(text, isError = true) {
  const box = document.getElementById('authModalNotice');
  const msg = document.getElementById('noticeText');
  const icon = document.getElementById('noticeIcon');
  
  msg.innerHTML = text;
  box.className = `mb-4 p-3 rounded-lg border text-xs flex items-start gap-2 ${
    isError ? 'border-rose-955/60 bg-rose-950/20 text-rose-400' : 'border-indigo-950/60 bg-indigo-950/20 text-indigo-400'
  }`;
  icon.setAttribute('data-lucide', isError ? 'alert-triangle' : 'info');
  box.classList.remove('hidden');
  lucide.createIcons();
}

function hideModalNotice() {
  document.getElementById('authModalNotice').classList.add('hidden');
}

// Resend email verification caller
async function triggerResendVerification(email) {
  if (!email) return;
  showToast('Đang gửi lại email xác thực...');
  try {
    const res = await fetch('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (res.status === 200 && data.success) {
      showToast('Đã gửi lại email xác thực thành công!');
      showModalNotice('Đã gửi lại thư kích hoạt tài khoản mới. Vui lòng kiểm tra email của bạn.', false);
    } else {
      showToast(data.error || 'Gửi lại xác thực thất bại!', 'error');
      showModalNotice(data.error || 'Không thể gửi lại email xác thực.');
    }
  } catch (err) {
    showToast('Lỗi kết nối máy chủ.', 'error');
  }
}

// Form Submissions
async function handleAuthSubmit() {
  hideModalNotice();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const fullName = document.getElementById('authFullName').value.trim();
  const phoneNumber = document.getElementById('authPhone').value.trim();

  if (!email) {
    showModalNotice('Vui lòng điền Email!');
    return;
  }

  if (authMode === 'forgot') {
    // FORGOT PASSWORD
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      
      if (data.success) {
        showToast('Yêu cầu quên mật khẩu đã được tiếp nhận!');
        showModalNotice('Nếu địa chỉ email tồn tại trên hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu trong vài phút.', false);
      } else {
        showModalNotice(data.error || 'Có lỗi xảy ra, vui lòng thử lại.');
      }
    } catch (err) {
      showModalNotice('Lỗi hệ thống: Không kết nối được tới máy chủ.');
    }
    return;
  }

  if (!password) {
    showModalNotice('Vui lòng điền Mật khẩu!');
    return;
  }

  if (authMode === 'register') {
    if (!fullName || !phoneNumber) {
      showModalNotice('Vui lòng điền Họ tên và Số điện thoại!');
      return;
    }

    if (password.length < 8) {
      showModalNotice('Mật khẩu phải dài tối thiểu 8 ký tự!');
      return;
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, fullName, phoneNumber })
      });
      const data = await res.json();
      
      if (res.status === 429) {
        showModalNotice(data.error);
        return;
      }

      if (data.success) {
        showToast('Đăng ký tài khoản thành công!');
        // Show custom verification notice inside modal
        showModalNotice(`
          <strong>Đăng ký thành công!</strong><br/>
          Chúng tôi đã gửi email kích hoạt đến <strong>${email}</strong>.<br/>
          Vui lòng kiểm tra email của bạn để xác thực trước khi đăng nhập.<br/>
          <span class="underline cursor-pointer font-bold text-indigo-400" onclick="triggerResendVerification('${email}')">Bấm vào đây để gửi lại email xác thực</span>
        `, false);
        
        // Switch view internally without clearing notice
        authMode = 'login';
        document.getElementById('authModalTitle').innerText = 'Đăng nhập tài khoản';
        document.getElementById('authModalSub').innerText = 'Kích hoạt tài khoản xong? Đăng nhập ngay';
        document.getElementById('nameFieldGroup').classList.add('hidden');
        document.getElementById('phoneFieldGroup').classList.add('hidden');
        document.getElementById('submitBtnText').innerText = 'Xác nhận đăng nhập';
        document.getElementById('submitBtnIcon').setAttribute('data-lucide', 'log-in');
        document.getElementById('authToggleText').innerText = 'Chưa có tài khoản?';
        document.getElementById('authToggleLink').innerText = 'Đăng ký ngay';
        document.getElementById('authToggleLink').setAttribute('onclick', "openAuthModal('register')");
        lucide.createIcons();
      } else {
        showModalNotice(data.error || 'Đăng ký thất bại!');
      }
    } catch (err) {
      showModalNotice('Lỗi hệ thống: ' + err.message);
    }
  } else {
    // LOGIN
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      
      if (res.status === 429) {
        showModalNotice(data.error);
        return;
      }

      if (res.status === 403) {
        // Unverified Email error
        showModalNotice(`
          ${data.error}<br/>
          <span class="underline cursor-pointer font-bold text-indigo-400" onclick="triggerResendVerification('${email}')">Bấm vào đây để gửi lại email xác thực</span>
        `);
        return;
      }

      if (data.success) {
        showToast('Đăng nhập thành công!');
        currentUser = data.user;
        localStorage.setItem('vst_user', JSON.stringify(currentUser));
        updateAuthHeader();
        closeAuthModal();
        
        await loadDashboard();
        scrollToDashboard();

        // Redirect if there is a pending payment key in storage
        const pendingKey = localStorage.getItem('pending_payment_key');
        if (pendingKey) {
          window.location.href = `/payment.html?key=${pendingKey}`;
          return;
        }

        if (redirectActionAfterAuth) {
          const act = redirectActionAfterAuth;
          redirectActionAfterAuth = null;
          await handleSubscribePlan(act);
        }
      } else {
        showModalNotice(data.error || 'Email hoặc mật khẩu không chính xác!');
      }
    } catch (err) {
      showModalNotice('Lỗi hệ thống: ' + err.message);
    }
  }
}

async function handleLogout() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Đã đăng xuất tài khoản!');
      currentUser = null;
      localStorage.removeItem('vst_user');
      updateAuthHeader();
      window.location.hash = '';
    }
  } catch (err) {
    showToast('Lỗi đăng xuất: ' + err.message, 'error');
  }
}

// Scroll to dashboard helper
function scrollToDashboard() {
  const el = document.getElementById('dashboard');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' });
  }
}

// Load User Dashboard Data
async function loadDashboard() {
  if (!currentUser) return;
  
  document.getElementById('profileEmail').innerText = currentUser.email;
  document.getElementById('profileName').innerText = currentUser.fullName;
  
  const names = currentUser.fullName.split(' ');
  const initials = names.length > 1 ? (names[0][0] + names[names.length-1][0]).toUpperCase() : names[0][0].toUpperCase();
  document.getElementById('profileInitials').innerText = initials;

  await loadUserKeys();
}

async function loadUserKeys() {
  try {
    const res = await fetch('/api/user/keys');
    const data = await res.json();
    
    if (data.success) {
      renderUserKeys(data.keys);
    } else {
      showToast(data.error || 'Lỗi khi tải dữ liệu key!', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối tải keys: ' + err.message, 'error');
  }
}

function renderUserKeys(keys) {
  const tbody = document.getElementById('userKeysTableBody');
  const now = new Date();
  
  if (!keys || keys.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="px-4 py-8 text-center text-zinc-500">Chưa có License Key nào. Hãy chọn đăng ký một gói phía trên!</td>
      </tr>
    `;
    renderPaymentInstruction(null);
    return;
  }

  const pendingKey = keys.find(k => k.paymentStatus === 'pending' && k.status !== 'suspended');
  renderPaymentInstruction(pendingKey);

  tbody.innerHTML = keys.map(k => {
    const isExpired = new Date(k.expiresAt) < now;
    let badge = '';
    
    if (k.status === 'suspended') {
      badge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-rose-955/80 text-rose-400 border border-rose-900/30">Bị Khóa</span>';
    } else if (k.paymentStatus === 'pending') {
      badge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-955/80 text-amber-400 border border-amber-900/30">Chờ Thanh Toán</span>';
    } else if (isExpired) {
      badge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-zinc-900 text-zinc-500 border border-zinc-800">Hết Hạn</span>';
    } else if (k.hwid) {
      badge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-955/80 text-emerald-400 border border-emerald-900/30">Kích Hoạt</span>';
    } else {
      badge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-955/80 text-blue-400 border border-blue-900/30">Chờ Kích Hoạt</span>';
    }

    const planName = k.planType === 'trial' ? 'Dùng thử' : (k.planType === 'monthly' ? 'Tháng' : 'Năm');
    const formattedExpires = new Date(k.expiresAt).toLocaleDateString('vi-VN', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    });

    const copyMarkup = `<i data-lucide="copy" class="h-3.5 w-3.5 inline ml-1.5 cursor-pointer text-zinc-500 hover:text-white" onclick="copyText('${k.key}')" title="Sao chép Key"></i>`;
    
    let quotaText = '';
    let disableReset = false;
    
    if (k.status === 'suspended' || k.paymentStatus === 'pending' || isExpired || !k.hwid) {
      disableReset = true;
    }

    const lastReset = k.lastResetAt ? new Date(k.lastResetAt) : null;
    const currentYear = now.getFullYear();
    let activeResets = k.resetCount || 0;
    if (lastReset && lastReset.getFullYear() !== currentYear) {
      activeResets = 0;
    }
    
    const remainingResets = Math.max(0, 2 - activeResets);
    quotaText = `<div class="text-[9px] text-zinc-500 mt-1">Còn ${remainingResets} lần đổi máy/năm</div>`;

    let actionBtnMarkup = '';
    let quotaMarkup = '';
    
    if (k.paymentStatus === 'pending' && k.status !== 'suspended') {
      actionBtnMarkup = `
        <div class="flex items-center gap-1.5 justify-end">
          <a href="/payment.html?key=${k.key}" class="px-2.5 py-1.5 text-[10px] font-bold bg-amber-600 hover:bg-amber-500 text-white rounded-md transition-all shadow-sm inline-block">
            Thanh Toán
          </a>
          <button onclick="handleCancelKey('${k.key}')" class="px-2.5 py-1.5 text-[10px] font-bold bg-rose-955/40 border border-rose-900/40 hover:bg-rose-900/60 text-rose-400 rounded-md transition-all shadow-sm cursor-pointer">
            Hủy
          </button>
        </div>
      `;
    } else {
      actionBtnMarkup = `
        <button onclick="handleResetHwid('${k.key}')" class="px-2 py-1 text-[10px] font-semibold bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-md transition-all shadow-sm" ${disableReset ? 'disabled class="opacity-30 cursor-not-allowed px-2 py-1 text-[10px] font-semibold bg-zinc-955 border border-zinc-900 text-zinc-600 rounded-md"' : ''}>
          Reset HWID
        </button>
      `;
      quotaMarkup = quotaText;
    }

    return `
      <tr class="hover:bg-zinc-900/20 transition-colors">
        <td class="px-4 py-4 font-bold text-white">${planName}</td>
        <td class="px-4 py-4 font-mono text-zinc-400 text-xs">
          <span class="bg-zinc-955 border border-zinc-900 px-1.5 py-0.5 rounded select-all">${k.key}</span>
          ${copyMarkup}
        </td>
        <td class="px-4 py-4 text-[11px] text-zinc-400">${formattedExpires}</td>
        <td class="px-4 py-4 font-mono text-[10px] text-zinc-500 max-w-[120px] truncate" title="${k.hwid || 'Chưa liên kết'}">
          ${k.hwid ? `${k.hwid.slice(0, 10)}...` : '<span class="italic text-zinc-700">Chưa dùng</span>'}
        </td>
        <td class="px-4 py-4 text-center">${badge}</td>
        <td class="px-4 py-4 text-right">
          <div class="inline-block text-left">
            ${actionBtnMarkup}
            ${quotaMarkup}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

// Copy to clipboard helper
function copyText(val) {
  navigator.clipboard.writeText(val);
  showToast('Đã sao chép mã bản quyền vào clipboard!');
}

// Dynamic QR generation and simulate payment view
function renderPaymentInstruction(keyObj) {
  const container = document.getElementById('paymentPanelContainer');
  if (!keyObj) {
    container.innerHTML = `
      <div class="glass-card p-6 rounded-2xl h-full flex flex-col items-center justify-center text-center text-zinc-500 py-12">
        <i data-lucide="credit-card" class="h-10 w-10 text-zinc-600 mb-3"></i>
        <p class="text-sm">Khi có key ở trạng thái <strong class="text-zinc-400">Chờ thanh toán</strong>, thông tin chuyển khoản thanh toán động sẽ tự động xuất hiện tại đây.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const amount = keyObj.planType === 'monthly' ? 199000 : 1499000;
  const priceText = keyObj.planType === 'monthly' ? '199.000đ' : '1.499.000đ';
  const keyRef = keyObj.key.split('-')[1]; // VST STUDIO-XXXX-XXXX... => VST XXXX
  const memo = `VST ${keyRef}`;
  
  const qrUrl = `https://img.vietqr.io/image/MB-0352516480-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=HOANG%20DEVS`;

  container.innerHTML = `
    <div class="glass-card p-6 rounded-2xl space-y-4 glow-indigo border-indigo-500/30">
      <h3 class="text-base font-bold text-white flex items-center gap-2 border-b border-zinc-800 pb-3">
        <i data-lucide="qr-code" class="text-indigo-400 h-5 w-5"></i>
        <span>Thanh Toán Kích Hoạt Key</span>
      </h3>
      
      <div class="text-xs text-zinc-400 space-y-2 leading-relaxed">
        <p>Vui lòng chuyển khoản đúng thông tin dưới đây để hệ thống tự động kiểm tra và kích hoạt mã bản quyền của bạn.</p>
      </div>
      
      <!-- Bank Account Info -->
      <div class="bg-zinc-950/80 border border-zinc-900 rounded-xl p-4 space-y-2.5">
        <div class="flex justify-between items-center text-xs">
          <span class="text-zinc-500">Ngân hàng:</span>
          <span class="font-bold text-white">MB Bank (Quân Đội)</span>
        </div>
        <div class="flex justify-between items-center text-xs">
          <span class="text-zinc-500">Số tài khoản:</span>
          <span class="font-mono font-bold text-white select-all">0352516480</span>
        </div>
        <div class="flex justify-between items-center text-xs">
          <span class="text-zinc-500">Chủ tài khoản:</span>
          <span class="font-bold text-white">NGUYEN SY HOANG</span>
        </div>
        <div class="flex justify-between items-center text-xs border-t border-zinc-900 pt-2.5">
          <span class="text-zinc-500">Số tiền:</span>
          <span class="font-bold text-emerald-400 text-sm">${priceText}</span>
        </div>
        <div class="flex justify-between items-center text-xs">
          <span class="text-zinc-500">Nội dung CK:</span>
          <span class="font-mono bg-indigo-955/60 border border-indigo-850 px-2 py-1 rounded text-indigo-400 font-bold select-all" id="memoText">${memo}</span>
        </div>
      </div>
      
      <!-- QR Code Display -->
      <div class="flex flex-col items-center justify-center p-3 bg-white rounded-xl shadow-inner max-w-[200px] mx-auto">
        <img src="${qrUrl}" alt="VietQR Code" class="w-full h-auto" onerror="this.onerror=null; this.src='https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https://vietqr.net';">
        <p class="text-[9px] text-zinc-500 mt-1 font-semibold">Quét mã QR qua app ngân hàng</p>
      </div>

      <div class="pt-2" id="devSimulateContainer">
        <!-- Simulated Payment button dynamically loaded if isDevMode -->
      </div>
    </div>
  `;

  if (isDevMode) {
    document.getElementById('devSimulateContainer').innerHTML = `
      <button onclick="handleSimulatePayment('${keyObj.key}')" class="w-full py-2.5 bg-emerald-600/10 border border-emerald-500/30 hover:bg-emerald-600/20 text-emerald-400 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5">
        <i data-lucide="zap" class="h-4 w-4"></i>
        <span>[Dev Only] Mô Phỏng Thanh Toán</span>
      </button>
    `;
  }
  
  lucide.createIcons();
}

// Subscribe to Plan API call
async function handleSubscribePlan(planType) {
  if (!currentUser) {
    showToast('Vui lòng đăng nhập tài khoản để thực hiện chức năng này!', 'error');
    openAuthModal('login', planType);
    return;
  }

  try {
    const res = await fetch('/api/plans/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planType })
    });
    const data = await res.json();

    if (res.status === 401) {
      showToast('Phiên làm việc hết hạn. Vui lòng đăng nhập lại.', 'error');
      currentUser = null;
      updateAuthHeader();
      openAuthModal('login', planType);
      return;
    }

    if (data.success) {
      if (planType === 'trial') {
        showToast('Đăng ký gói Dùng thử thành công! Key đã kích hoạt & gửi qua Email.');
        await loadUserKeys();
        scrollToDashboard();
      } else {
        showToast('Đăng ký thành công! Đang chuyển hướng sang trang thanh toán...');
        setTimeout(() => {
          window.location.href = `/payment.html?key=${data.key}`;
        }, 1200);
      }
    } else {
      if (data.pendingKey) {
        showToast('Bạn đang có một mã bản quyền chờ thanh toán! Đang chuyển hướng sang trang thanh toán...', 'error');
        setTimeout(() => {
          window.location.href = `/payment.html?key=${data.pendingKey}`;
        }, 1500);
      } else {
        showToast(data.error || 'Không thể đăng ký gói!', 'error');
      }
    }
  } catch (err) {
    showToast('Lỗi khi đăng ký gói: ' + err.message, 'error');
  }
}

// Dev payment simulator API
async function handleSimulatePayment(key) {
  try {
    const res = await fetch('/api/user/simulate-payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    
    if (data.success) {
      showToast('Mô phỏng thanh toán thành công! Key bản quyền của bạn đã được kích hoạt.');
      await loadUserKeys();
    } else {
      showToast(data.error || 'Duyệt thanh toán lỗi', 'error');
    }
  } catch (err) {
    showToast('Lỗi API mô phỏng thanh toán: ' + err.message, 'error');
  }
}

// User Cancel pending key
async function handleCancelKey(key) {
  if (!confirm('Bạn có chắc chắn muốn hủy đơn đăng ký gói bản quyền này không?')) {
    return;
  }

  try {
    const res = await fetch('/api/user/keys/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Đã hủy đăng ký gói thành công!');
      localStorage.removeItem('pending_payment_key');
      await loadUserKeys();
    } else {
      showToast(data.error || 'Lỗi khi hủy gói đăng ký', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối khi hủy gói: ' + err.message, 'error');
  }
}

// User Reset HWID API call
async function handleResetHwid(key) {
  if (!confirm(`Bạn có chắc chắn muốn giải phóng thiết bị liên kết (Reset HWID) cho key bản quyền này?`)) {
    return;
  }

  try {
    const res = await fetch('/api/user/reset-hwid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();

    if (res.status === 429) {
      showToast(data.error, 'error');
      return;
    }

    if (data.success) {
      showToast('Giải phóng thiết bị thành công! Key có thể sử dụng kích hoạt trên thiết bị mới.');
      await loadUserKeys();
    } else {
      showToast(data.error || 'Không thể reset thiết bị', 'error');
    }
  } catch (err) {
    showToast('Lỗi API reset HWID: ' + err.message, 'error');
  }
}

// Secure Single-Use Download Flow
async function handleDownloadClick() {
  if (!currentUser) {
    showToast('Vui lòng đăng nhập/đăng ký tài khoản để tải file cài đặt!', 'error');
    openAuthModal('login');
    return;
  }
  await downloadWithToken();
}

async function downloadWithToken() {
  if (!currentUser) return;
  try {
    const res = await fetch('/api/user/generate-download-token', { method: 'POST' });
    const data = await res.json();
    
    if (data.success && data.token) {
      showToast('Bắt đầu tải file cài đặt phần mềm...');
      window.location.href = `/download?token=${data.token}`;
    } else {
      showToast(data.error || 'Không tạo được mã tải file cài đặt!', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối tải phần mềm: ' + err.message, 'error');
  }
}
