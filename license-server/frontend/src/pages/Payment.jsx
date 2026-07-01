import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Loader2, CreditCard, ArrowLeft, CheckCircle, ShieldAlert, AlertCircle, Copy, QrCode, Zap } from 'lucide-react';

export default function Payment({ isDevMode, showToast }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const licenseKey = searchParams.get('key');

  const [loading, setLoading] = useState(true);
  const [keyDetails, setKeyDetails] = useState(null);
  const [errorState, setErrorState] = useState(null); // { title, desc }
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    if (!licenseKey) {
      setErrorState({
        title: 'Không tìm thấy License Key!',
        desc: 'Đường dẫn thanh toán thiếu mã bản quyền. Vui lòng quay lại trang chủ.'
      });
      setLoading(false);
      return;
    }

    fetchKeyDetails();
  }, [licenseKey]);

  const fetchKeyDetails = async () => {
    try {
      const res = await fetch(`/api/plans/status?key=${encodeURIComponent(licenseKey)}`);
      if (res.status === 404) {
        setErrorState({
          title: 'Không tìm thấy bản quyền này!',
          desc: 'Mã bản quyền không tồn tại hoặc đã bị xóa.'
        });
        return;
      }

      const data = await res.json();
      if (data.success && data.key) {
        setKeyDetails(data);
        if (data.status === 'suspended') {
          localStorage.removeItem('pending_payment_key');
        }
      } else {
        setErrorState({
          title: 'Lỗi máy chủ!',
          desc: data.error || 'Không thể tải thông tin bản quyền từ server.'
        });
      }
    } catch (err) {
      setErrorState({
        title: 'Lỗi kết nối!',
        desc: 'Không thể kết nối tới máy chủ. Vui lòng kiểm tra lại đường truyền mạng.'
      });
    } finally {
      setLoading(false);
    }
  };

  const copyText = (val, successMsg) => {
    navigator.clipboard.writeText(val);
    showToast(successMsg);
  };

  const activateLicense = async () => {
    setActivating(true);
    try {
      const res = await fetch('/api/user/simulate-payment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: licenseKey })
      });
      const data = await res.json();

      if (data.success) {
        showToast('Kích hoạt bản quyền thành công! Đang quay lại trang chủ...');
        
        // Clear any stored redirect keys
        localStorage.removeItem('pending_payment_key');

        setTimeout(() => {
          navigate('/');
        }, 2000);
      } else {
        showToast(data.error || 'Duyệt thanh toán thất bại!', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối khi gửi yêu cầu kích hoạt bản quyền.', 'error');
    } finally {
      setActivating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col justify-center items-center p-4 min-h-[60vh]">
        <div className="w-full max-w-lg p-8 rounded-2xl glass-card text-center space-y-6 shadow-2xl">
          <div className="flex justify-center py-6">
            <Loader2 className="h-12 w-12 text-indigo-500 animate-spin" />
          </div>
          <h2 className="text-xl font-bold font-display text-white">Đang tải thông tin thanh toán...</h2>
          <p className="text-xs text-zinc-400">Vui lòng đợi giây lát trong khi chúng tôi đối soát thông tin bản quyền.</p>
        </div>
      </div>
    );
  }

  // Error state display
  if (errorState) {
    return (
      <div className="flex-1 flex flex-col justify-center items-center p-4 min-h-[60vh]">
        <div className="w-full max-w-lg p-8 rounded-2xl glass-card relative overflow-hidden shadow-2xl space-y-6">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-400 mb-2">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-bold font-display text-white text-center">{errorState.title}</h2>
          <p className="text-xs text-zinc-400 text-center">{errorState.desc}</p>
          <div className="pt-2 text-center">
            <button 
              onClick={() => navigate('/')} 
              className="px-5 py-2.5 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 rounded-lg text-xs font-semibold inline-block text-white transition-all cursor-pointer"
            >
              Về Trang Chủ
            </button>
          </div>
        </div>
      </div>
    );
  }

  const planName = keyDetails.planType === 'trial' ? 'Gói Dùng Thử' : (keyDetails.planType === 'monthly' ? 'Gói Tháng' : 'Gói Năm');
  const amount = keyDetails.planType === 'monthly' ? 199000 : 1499000;
  const priceText = keyDetails.planType === 'monthly' ? '199.000đ' : '1.499.000đ';
  const keyRef = licenseKey.split('-')[1];
  const memo = `VST ${keyRef}`;
  const qrUrl = `https://img.vietqr.io/image/MB-0352516480-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=HOANG%20DEVS`;

  return (
    <div className="flex-1 flex flex-col justify-center items-center p-4 min-h-[80vh] relative">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="w-full max-w-lg p-8 rounded-2xl glass-card relative overflow-hidden shadow-2xl space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 shadow-md">
              <CreditCard className="text-white h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white font-display">Thanh Toán Kích Hoạt</h2>
              <p className="text-[10px] text-zinc-400">Hệ thống cấp bản quyền tự động</p>
            </div>
          </div>
          <button 
            onClick={() => navigate('/')} 
            className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Quay lại</span>
          </button>
        </div>

        {/* Notices */}
        {keyDetails.paymentStatus === 'active' ? (
          <div className="p-4 rounded-xl text-center space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 mb-2">
              <CheckCircle className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white">Bản Quyền Đã Kích Hoạt!</h3>
            <p className="text-xs text-zinc-400">Mã key {licenseKey} đã được kích hoạt thanh toán thành công và hiện đang hoạt động bình thường.</p>
            <div className="pt-2">
              <button 
                onClick={() => navigate('/')} 
                className="px-5 py-2.5 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 rounded-lg text-xs font-semibold inline-block text-white transition-all cursor-pointer"
              >
                Về Dashboard của tôi
              </button>
            </div>
          </div>
        ) : keyDetails.status === 'suspended' ? (
          <div className="p-4 rounded-xl text-center space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-400 mb-2">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white">Bản Quyền Bị Khóa!</h3>
            <p className="text-xs text-zinc-400">Mã key này đã bị đình chỉ hoạt động bởi quản trị viên. Vui lòng liên hệ hỗ trợ.</p>
            <div className="pt-2">
              <button 
                onClick={() => navigate('/')} 
                className="px-5 py-2.5 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 rounded-lg text-xs font-semibold inline-block text-white transition-all cursor-pointer"
              >
                Về Trang Chủ
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            
            {/* Plan Card info */}
            <div className="bg-zinc-950/80 border border-zinc-900 rounded-xl p-4 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Gói Bản Quyền</span>
                <h4 className="text-base font-bold text-white">{planName}</h4>
                <p className="text-[10px] text-indigo-400 font-mono mt-0.5">{licenseKey}</p>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Số tiền cần thanh toán</span>
                <p className="text-lg font-extrabold text-emerald-400">{priceText}</p>
              </div>
            </div>

            {/* Instruction and QR layout */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
              
              <div className="space-y-3.5 text-xs text-zinc-300">
                <p className="text-zinc-400 leading-relaxed">Vui lòng chuyển khoản đúng tài khoản ngân hàng và nhập chính xác <strong>Nội dung chuyển khoản</strong> dưới đây:</p>
                
                <div className="space-y-2">
                  <div>
                    <span className="text-[10px] text-zinc-500">Ngân hàng</span>
                    <p className="font-bold text-white">MB Bank (Quân Đội)</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500">Số tài khoản (Click để copy)</span>
                    <div 
                      className="flex items-center gap-1.5 cursor-pointer hover:text-white" 
                      onClick={() => copyText('0352516480', 'Đã copy số tài khoản!')}
                    >
                      <p className="font-mono font-bold text-white select-all text-sm">0352516480</p>
                      <Copy className="h-3.5 w-3.5 text-zinc-500" />
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500">Chủ tài khoản</span>
                    <p className="font-bold text-white">NGUYEN SY HOANG</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500">Nội dung chuyển khoản (Click để copy)</span>
                    <div 
                      className="flex items-center gap-1.5 cursor-pointer bg-indigo-950/40 border border-indigo-900/50 p-2 rounded-lg hover:border-indigo-850 mt-1" 
                      onClick={() => copyText(memo, 'Đã copy nội dung chuyển khoản!')}
                    >
                      <span className="font-mono text-indigo-400 font-bold select-all text-sm">{memo}</span>
                      <Copy className="h-3.5 w-3.5 text-indigo-400" />
                    </div>
                  </div>
                </div>
              </div>

              {/* QR Image Visual */}
              <div className="flex flex-col items-center justify-center space-y-2">
                <div className="bg-white p-3 rounded-2xl shadow-lg max-w-[200px] border border-zinc-200">
                  <img src={qrUrl} alt="VietQR Code" className="w-full h-auto" />
                </div>
                <span className="text-[9px] text-zinc-500 font-medium">Quét mã QR để tự điền thông tin</span>
              </div>

            </div>

            {/* Activating Simulation Button */}
            <div className="border-t border-zinc-900 pt-5 space-y-4">
              <button 
                onClick={activateLicense}
                disabled={activating}
                className="w-full py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-xl shadow-lg shadow-indigo-500/10 hover:shadow-indigo-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {activating ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span>Đang xử lý đối soát...</span>
                  </>
                ) : (
                  <>
                    <Zap className="h-5 w-5" />
                    <span>Xác nhận đã chuyển khoản (Thử nghiệm)</span>
                  </>
                )}
              </button>
              <p className="text-[10px] text-center text-zinc-500">Sau khi bấm nút, hệ thống sẽ mô phỏng đối soát chuyển khoản và kích hoạt key của bạn ngay lập tức.</p>
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
