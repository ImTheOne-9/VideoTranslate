import React, { useState, useEffect } from 'react';
import { Key, DownloadCloud, Download, CreditCard, QrCode, Copy, Trash, RotateCw, Zap } from 'lucide-react';

export default function Dashboard({ currentUser, isDevMode, showToast }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (currentUser) {
      loadUserKeys();
    }
  }, [currentUser]);

  const loadUserKeys = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/user/keys');
      const data = await res.json();
      if (data.success) {
        setKeys(data.keys || []);
      } else {
        showToast(data.error || 'Lỗi khi tải dữ liệu key!', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối tải keys: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (val, message = 'Đã sao chép vào clipboard!') => {
    navigator.clipboard.writeText(val);
    showToast(message);
  };

  const handleResetHwid = async (key) => {
    if (!confirm('Bạn có chắc chắn muốn giải phóng thiết bị liên kết (Reset HWID) cho key bản quyền này?')) {
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
  };

  const handleSimulatePayment = async (key) => {
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
  };

  const handleCancelKey = async (key) => {
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
  };

  const downloadWithToken = async () => {
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
  };

  const getProfileInitials = (name) => {
    if (!name) return 'U';
    const names = name.split(' ');
    return names.length > 1 ? (names[0][0] + names[names.length - 1][0]).toUpperCase() : names[0][0].toUpperCase();
  };

  const getStatusBadge = (k) => {
    const isExpired = new Date(k.expiresAt) < new Date();
    if (k.status === 'suspended') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950/80 text-rose-400 border border-rose-900/30">
          Bị Khóa
        </span>
      );
    } else if (k.paymentStatus === 'pending') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950/80 text-amber-400 border border-amber-900/30">
          Chờ Thanh Toán
        </span>
      );
    } else if (isExpired) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-zinc-900 text-zinc-500 border border-zinc-800">
          Hết Hạn
        </span>
      );
    } else if (k.hwid) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-955/80 text-emerald-400 border border-emerald-900/30">
          Kích Hoạt
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-955/80 text-blue-400 border border-blue-900/30">
          Chờ Kích Hoạt
        </span>
      );
    }
  };

  const pendingKey = keys.find(k => k.paymentStatus === 'pending' && k.status !== 'suspended');
  const amount = pendingKey ? (pendingKey.planType === 'monthly' ? 199000 : 1499000) : 0;
  const priceText = pendingKey ? (pendingKey.planType === 'monthly' ? '199.000đ' : '1.499.000đ') : '';
  const keyRef = pendingKey ? pendingKey.key.split('-')[1] : '';
  const memo = pendingKey ? `VST ${keyRef}` : '';
  const qrUrl = pendingKey ? `https://img.vietqr.io/image/MB-0352516480-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=HOANG%20DEVS` : '';

  return (
    <section id="dashboard" className="py-20 border-t border-zinc-900 bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        
        {/* Profile Card header */}
        <div className="flex flex-col lg:flex-row items-start justify-between gap-8 mb-12">
          <div>
            <h2 className="text-3xl font-bold font-display text-white flex items-center gap-2.5">
              <Key className="text-indigo-400 h-8 w-8" />
              <span>Dashboard Bản Quyền Thành Viên</span>
            </h2>
            <p className="text-zinc-400 mt-2">Quản lý các License Key đã đăng ký, tình trạng kích hoạt, và tải xuống công cụ.</p>
          </div>
          
          <div className="glass-card px-5 py-4 rounded-xl flex items-center gap-4 w-full lg:w-auto">
            <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white text-lg">
              {getProfileInitials(currentUser?.fullName)}
            </div>
            <div>
              <p className="text-sm font-semibold text-white">{currentUser?.fullName || 'Thành viên'}</p>
              <p className="text-xs text-zinc-400">{currentUser?.email}</p>
            </div>
          </div>
        </div>
        
        {/* Main Grid content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Left Area (Keys and Downloads) */}
          <div className="lg:col-span-2 space-y-6">
            
            <div className="glass-card p-6 rounded-2xl space-y-4">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Key className="text-indigo-400 h-5 w-5" />
                <span>Danh Sách License Key Của Bạn</span>
              </h3>
              
              <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/40">
                <table className="min-w-full divide-y divide-zinc-900 text-left text-xs text-zinc-300">
                  <thead className="bg-zinc-900/50 text-[10px] uppercase font-semibold text-zinc-400 tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Gói</th>
                      <th className="px-4 py-3">Key Bản Quyền</th>
                      <th className="px-4 py-3">Hạn Dùng</th>
                      <th className="px-4 py-3">Thiết Bị (HWID)</th>
                      <th className="px-4 py-3 text-center">Trạng Thái</th>
                      <th className="px-4 py-3 text-right">Thao Tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900/30">
                    {loading ? (
                      <tr>
                        <td colspan="6" className="px-4 py-8 text-center text-zinc-500">
                          <RotateCw className="h-5 w-5 animate-spin mx-auto mb-2 text-indigo-500" />
                          <span>Đang tải thông tin key...</span>
                        </td>
                      </tr>
                    ) : keys.length === 0 ? (
                      <tr>
                        <td colspan="6" className="px-4 py-8 text-center text-zinc-500">Chưa có License Key nào. Hãy chọn đăng ký một gói phía trên!</td>
                      </tr>
                    ) : (
                      keys.map((k) => {
                        const isExpired = new Date(k.expiresAt) < new Date();
                        const planName = k.planType === 'trial' ? 'Dùng thử' : (k.planType === 'monthly' ? 'Tháng' : 'Năm');
                        const formattedExpires = new Date(k.expiresAt).toLocaleDateString('vi-VN', {
                          year: 'numeric', month: '2-digit', day: '2-digit'
                        });

                        const lastReset = k.lastResetAt ? new Date(k.lastResetAt) : null;
                        const currentYear = new Date().getFullYear();
                        let activeResets = k.resetCount || 0;
                        if (lastReset && lastReset.getFullYear() !== currentYear) {
                          activeResets = 0;
                        }
                        const remainingResets = Math.max(0, 2 - activeResets);

                        let disableReset = false;
                        if (k.status === 'suspended' || k.paymentStatus === 'pending' || isExpired || !k.hwid) {
                          disableReset = true;
                        }

                        return (
                          <tr key={k.key} className="hover:bg-zinc-900/20 transition-colors">
                            <td className="px-4 py-4 font-bold text-white">{planName}</td>
                            <td className="px-4 py-4 font-mono text-zinc-400 text-xs">
                              <div className="flex items-center gap-1.5">
                                <span className="bg-zinc-950 border border-zinc-900 px-1.5 py-0.5 rounded select-all">{k.key}</span>
                                <Copy 
                                  className="h-3.5 w-3.5 text-zinc-500 hover:text-white cursor-pointer" 
                                  onClick={() => copyToClipboard(k.key, 'Đã sao chép mã bản quyền!')}
                                  title="Sao chép Key"
                                />
                              </div>
                            </td>
                            <td className="px-4 py-4 text-[11px] text-zinc-400">{formattedExpires}</td>
                            <td className="px-4 py-4 font-mono text-[10px] text-zinc-500 max-w-[120px] truncate" title={k.hwid || 'Chưa liên kết'}>
                              {k.hwid ? `${k.hwid.slice(0, 10)}...` : <span className="italic text-zinc-700">Chưa dùng</span>}
                            </td>
                            <td className="px-4 py-4 text-center">{getStatusBadge(k)}</td>
                            <td className="px-4 py-4 text-right">
                              <div className="inline-block text-left">
                                {k.paymentStatus === 'pending' && k.status !== 'suspended' ? (
                                  <div className="flex items-center gap-1.5 justify-end">
                                    <a 
                                      href={`/payment.html?key=${k.key}`} 
                                      className="px-2.5 py-1.5 text-[10px] font-bold bg-amber-600 hover:bg-amber-500 text-white rounded-md transition-all shadow-sm inline-block cursor-pointer"
                                    >
                                      Thanh Toán
                                    </a>
                                    <button 
                                      onClick={() => handleCancelKey(k.key)}
                                      className="px-2.5 py-1.5 text-[10px] font-bold bg-rose-955/40 border border-rose-900/40 hover:bg-rose-900/60 text-rose-400 rounded-md transition-all shadow-sm cursor-pointer"
                                    >
                                      Hủy
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <button 
                                      onClick={() => handleResetHwid(k.key)}
                                      disabled={disableReset}
                                      className={`px-2 py-1 text-[10px] font-semibold rounded-md transition-all shadow-sm border ${
                                        disableReset 
                                          ? 'bg-zinc-950 border-zinc-900 text-zinc-600 cursor-not-allowed opacity-30'
                                          : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-800 text-zinc-300 cursor-pointer'
                                      }`}
                                    >
                                      Reset HWID
                                    </button>
                                    {!disableReset && (
                                      <div className="text-[9px] text-zinc-500 mt-1">Còn {remainingResets} lần đổi máy/năm</div>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            
            {/* Download Instruction Card */}
            <div className="glass-card p-6 rounded-2xl flex flex-col md:flex-row items-center justify-between gap-6 border-indigo-500/20">
              <div className="space-y-2 text-center md:text-left">
                <h3 className="text-lg font-bold text-white flex items-center justify-center md:justify-start gap-2">
                  <DownloadCloud className="text-indigo-400 h-5 w-5" />
                  <span>Tải và cài đặt Video Studio Tools</span>
                </h3>
                <p className="text-sm text-zinc-400 leading-relaxed max-w-xl">
                  Để bắt đầu, hãy tải bộ cài đặt an toàn phía bên phải. Sau khi cài đặt, khởi chạy app và copy/paste License Key của bạn đang ở trạng thái <strong>Active</strong> để mở khóa sử dụng.
                </p>
              </div>
              <button 
                onClick={downloadWithToken}
                className="w-full md:w-auto px-6 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
              >
                <Download className="h-4.5 w-4.5" />
                <span>Tải bộ cài ngay</span>
              </button>
            </div>
            
          </div>
          
          {/* Right Area (QR Payment) */}
          <div className="space-y-6">
            {pendingKey ? (
              <div className="glass-card p-6 rounded-2xl space-y-4 glow-indigo border-indigo-500/30">
                <h3 className="text-base font-bold text-white flex items-center gap-2 border-b border-zinc-800 pb-3">
                  <QrCode className="text-indigo-400 h-5 w-5" />
                  <span>Thanh Toán Kích Hoạt Key</span>
                </h3>
                
                <div className="text-xs text-zinc-400 space-y-2 leading-relaxed">
                  <p>Vui lòng chuyển khoản đúng thông tin dưới đây để hệ thống tự động kiểm tra và kích hoạt mã bản quyền của bạn.</p>
                </div>
                
                {/* Bank Account Info */}
                <div className="bg-zinc-950/80 border border-zinc-900 rounded-xl p-4 space-y-2.5">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-zinc-500">Ngân hàng:</span>
                    <span class="font-bold text-white">MB Bank (Quân Đội)</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-zinc-500">Số tài khoản:</span>
                    <div className="flex items-center gap-1 cursor-pointer" onClick={() => copyToClipboard('0352516480', 'Đã copy số tài khoản!')}>
                      <span className="font-mono font-bold text-white select-all">0352516480</span>
                      <Copy className="h-3 w-3 text-zinc-500" />
                    </div>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-zinc-500">Chủ tài khoản:</span>
                    <span className="font-bold text-white">NGUYEN SY HOANG</span>
                  </div>
                  <div className="flex justify-between items-center text-xs border-t border-zinc-900 pt-2.5">
                    <span className="text-zinc-500">Số tiền:</span>
                    <span className="font-bold text-emerald-400 text-sm">{priceText}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-zinc-500">Nội dung CK:</span>
                    <div className="flex items-center gap-1 cursor-pointer bg-indigo-950/60 border border-indigo-850 px-2 py-1 rounded hover:border-indigo-800" onClick={() => copyToClipboard(memo, 'Đã copy nội dung chuyển khoản!')}>
                      <span className="font-mono text-indigo-400 font-bold select-all" id="memoText">{memo}</span>
                      <Copy className="h-3 w-3 text-indigo-400" />
                    </div>
                  </div>
                </div>
                
                {/* QR Code Display */}
                <div className="flex flex-col items-center justify-center p-3 bg-white rounded-xl shadow-inner max-w-[200px] mx-auto">
                  <img src={qrUrl} alt="VietQR Code" className="w-full h-auto" />
                  <p className="text-[9px] text-zinc-500 mt-1 font-semibold">Quét mã QR qua app ngân hàng</p>
                </div>

                {isDevMode && (
                  <div className="pt-2">
                    <button 
                      onClick={() => handleSimulatePayment(pendingKey.key)}
                      className="w-full py-2.5 bg-emerald-600/10 border border-emerald-500/30 hover:bg-emerald-600/20 text-emerald-400 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Zap className="h-4 w-4" />
                      <span>[Dev Only] Mô Phỏng Thanh Toán</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="glass-card p-6 rounded-2xl h-full flex flex-col items-center justify-center text-center text-zinc-500 py-12">
                <CreditCard className="h-10 w-10 text-zinc-600 mb-3" />
                <p className="text-sm">Khi có key ở trạng thái <strong className="text-zinc-400">Chờ thanh toán</strong>, thông tin chuyển khoản thanh toán động sẽ tự động xuất hiện tại đây.</p>
              </div>
            )}
          </div>
          
        </div>
        
      </div>
    </section>
  );
}
