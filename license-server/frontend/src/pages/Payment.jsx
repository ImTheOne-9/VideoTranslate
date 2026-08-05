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
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('bank'); // 'bank', 'stripe', 'payos'
  const [checkoutLoading, setCheckoutLoading] = useState(false);

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

  useEffect(() => {
    if (!licenseKey || !keyDetails || keyDetails.paymentStatus !== 'pending') return;

    let pollCount = 0;
    const maxPolls = 600; // 600 lần * 3 giây = 30 phút

    const interval = setInterval(async () => {
      pollCount++;
      if (pollCount >= maxPolls) {
        clearInterval(interval);
        showToast('Đã hết thời gian chờ thanh toán tự động. Vui lòng tải lại trang nếu đã chuyển khoản!', 'warning');
        return;
      }

      try {
        const res = await fetch(`/api/plans/status?key=${encodeURIComponent(licenseKey)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.key) {
            if (data.paymentStatus === 'active') {
              clearInterval(interval);
              setIsVerifyingPayment(true);
              setTimeout(() => {
                setKeyDetails(data);
                setIsVerifyingPayment(false);
                showToast('Thanh toán thành công! Bản quyền đã được kích hoạt.');
              }, 2500);
            }
          }
        }
      } catch (err) {
        console.error('Lỗi khi polling trạng thái thanh toán:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [licenseKey, keyDetails]);

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

  const handleCheckoutRedirect = async (gateway) => {
    setCheckoutLoading(true);
    try {
      const endpoint = gateway === 'stripe' ? '/api/payment/stripe/create-session' : '/api/payment/payos/create-link';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: licenseKey })
      });
      const data = await res.json();
      if (res.ok && data.success && data.url) {
        window.location.href = data.url; // Redirect to the secure checkout page!
      } else {
        showToast(data.error || 'Lỗi khởi tạo cổng thanh toán.', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối khi khởi tạo cổng thanh toán.', 'error');
    } finally {
      setCheckoutLoading(false);
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

  if (isVerifyingPayment) {
    return (
      <div className="flex-1 flex flex-col justify-center items-center p-4 min-h-[60vh]">
        <div className="w-full max-w-lg p-8 rounded-2xl glass-card text-center space-y-6 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 animate-pulse"></div>
          <div className="flex justify-center py-6">
            <div className="relative">
              <div className="h-16 w-16 rounded-full border-t-2 border-b-2 border-indigo-500 animate-spin"></div>
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-indigo-500/20 animate-ping"></div>
            </div>
          </div>
          <h2 className="text-xl font-bold font-display text-white">Đã Phát Hiện Giao Dịch!</h2>
          <p className="text-xs text-zinc-400 max-w-sm mx-auto leading-relaxed">
            Hệ thống đang đối soát số tiền chuyển khoản và tiến hành khởi tạo chữ ký số Ed25519 kích hoạt bản quyền. Vui lòng giữ nguyên trang web...
          </p>
        </div>
      </div>
    );
  }

  const planName = keyDetails.planName || (keyDetails.planType === 'trial' ? 'Gói Dùng Thử' : (keyDetails.planType === 'monthly' ? 'Gói Tháng' : 'Gói Năm'));
  const amount = keyDetails.price !== undefined ? keyDetails.price : (keyDetails.planType === 'monthly' ? 299000 : 1499000);
  const priceText = amount === 0 ? '0đ' : amount.toLocaleString('vi-VN') + 'đ';
  const keyRef = licenseKey.split('-')[1];
  const memo = `VST ${keyRef}`;
  const bankCode = keyDetails.bankCode || 'MB';
  const bankAccount = keyDetails.bankAccount || '0385464403';
  const bankAccountName = keyDetails.bankAccountName || 'DOAN VIET HOANG';
  const qrUrl = `https://img.vietqr.io/image/${bankCode}-${bankAccount}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(bankAccountName)}`;

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

            {/* Payment Method Selector */}
            <div className="grid grid-cols-3 gap-2 p-1.5 bg-zinc-950/85 border border-zinc-900 rounded-xl">
              <button
                onClick={() => setPaymentMethod('bank')}
                className={`py-2 px-3 text-[10px] sm:text-xs font-semibold rounded-lg transition-all cursor-pointer text-center ${
                  paymentMethod === 'bank'
                    ? 'bg-zinc-900 border border-zinc-800 text-white shadow-md'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Chuyển khoản (VietQR)
              </button>
              <button
                onClick={() => setPaymentMethod('stripe')}
                className={`py-2 px-3 text-[10px] sm:text-xs font-semibold rounded-lg transition-all cursor-pointer text-center ${
                  paymentMethod === 'stripe'
                    ? 'bg-zinc-900 border border-zinc-800 text-white shadow-md'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Thẻ quốc tế (Stripe)
              </button>
              <button
                onClick={() => setPaymentMethod('payos')}
                className={`py-2 px-3 text-[10px] sm:text-xs font-semibold rounded-lg transition-all cursor-pointer text-center ${
                  paymentMethod === 'payos'
                    ? 'bg-zinc-900 border border-zinc-800 text-white shadow-md'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Thẻ nội địa (PayOS)
              </button>
            </div>

            {paymentMethod === 'bank' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                <div className="space-y-3.5 text-xs text-zinc-300">
                  <p className="text-zinc-400 leading-relaxed">Vui lòng chuyển khoản đúng tài khoản ngân hàng và nhập chính xác <strong>Nội dung chuyển khoản</strong> dưới đây:</p>
                  <div className="space-y-2">
                    <div>
                      <span className="text-[10px] text-zinc-500">Ngân hàng</span>
                      <p className="font-bold text-white">{bankCode} Bank</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-500">Số tài khoản (Click để copy)</span>
                      <div 
                        className="flex items-center gap-1.5 cursor-pointer hover:text-white" 
                        onClick={() => copyText(bankAccount, 'Đã copy số tài khoản!')}
                      >
                        <p className="font-mono font-bold text-white select-all text-sm">{bankAccount}</p>
                        <Copy className="h-3.5 w-3.5 text-zinc-500" />
                      </div>
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-500">Chủ tài khoản</span>
                      <p className="font-bold text-white">{bankAccountName}</p>
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
            )}

            {paymentMethod === 'stripe' && (
              <div className="bg-zinc-950/50 border border-zinc-900/60 rounded-2xl p-6 text-center space-y-4">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400 mb-2">
                  <CreditCard className="h-6 w-6" />
                </div>
                <h4 className="text-sm font-bold text-white">Thanh toán qua cổng thẻ Stripe</h4>
                <p className="text-xs text-zinc-400 max-w-sm mx-auto leading-relaxed">
                  Hỗ trợ các loại thẻ Visa, Mastercard, JCB và Apple Pay. Cổng thanh toán bảo mật tiêu chuẩn quốc tế.
                </p>
                <button
                  onClick={() => handleCheckoutRedirect('stripe')}
                  disabled={checkoutLoading}
                  className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-650 hover:to-purple-700 disabled:opacity-50 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  {checkoutLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Đang kết nối cổng Stripe...</span>
                    </>
                  ) : (
                    <span>Thanh toán ngay qua Stripe</span>
                  )}
                </button>
              </div>
            )}

            {paymentMethod === 'payos' && (
              <div className="bg-zinc-950/50 border border-zinc-900/60 rounded-2xl p-6 text-center space-y-4">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400 mb-2">
                  <QrCode className="h-6 w-6" />
                </div>
                <h4 className="text-sm font-bold text-white">Thanh toán qua cổng PayOS</h4>
                <p className="text-xs text-zinc-400 max-w-sm mx-auto leading-relaxed">
                  Quét mã QR hoặc nhập thẻ ATM nội địa Việt Nam. Cổng thanh toán quốc gia tiện lợi, bảo mật.
                </p>
                <button
                  onClick={() => handleCheckoutRedirect('payos')}
                  disabled={checkoutLoading}
                  className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-650 hover:to-purple-700 disabled:opacity-50 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  {checkoutLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Đang kết nối cổng PayOS...</span>
                    </>
                  ) : (
                    <span>Thanh toán ngay qua PayOS</span>
                  )}
                </button>
              </div>
            )}



          </div>
        )}

      </div>
    </div>
  );
}
