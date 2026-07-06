import React, { useState, useEffect, useRef } from 'react';
import { X, Lock, UserPlus, KeyRound, Info, AlertTriangle, ArrowRight, Send, LogIn } from 'lucide-react';

// Tao fingerprint thiet bi on dinh (hash thong tin trinh duyet + persist localStorage)
function getDeviceFingerprint() {
  try {
    const stored = localStorage.getItem('vst_device_fp');
    if (stored && stored.length > 0) return stored;
    const parts = [
      navigator.userAgent || '',
      navigator.language || '',
      (navigator.languages || []).join(','),
      String(screen.width || 0) + 'x' + String(screen.height || 0),
      String(screen.colorDepth || 0),
      String(screen.availWidth || 0) + 'x' + String(screen.availHeight || 0),
      String(new Date().getTimezoneOffset()),
      String(navigator.hardwareConcurrency || 0),
      String(navigator.deviceMemory || 0),
      String(navigator.platform || ''),
      String(navigator.maxTouchPoints || 0)
    ];
    let h = 2166136261 >>> 0;
    const str = parts.join('|');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const fp = h.toString(16).padStart(8, '0') + Date.now().toString(16).slice(-6);
    localStorage.setItem('vst_device_fp', fp);
    return fp;
  } catch (e) {
    return 'fp-' + Math.random().toString(36).slice(2, 12);
  }
}
export default function AuthModal({ isOpen, mode, onClose, onSwitchMode, onAuthSuccess, showToast }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [notice, setNotice] = useState(null); // { text, isError }
  const [loading, setLoading] = useState(false);
  const skipNoticeClearRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      if (!skipNoticeClearRef.current) {
        setNotice(null);
      }
      skipNoticeClearRef.current = false;
      // Don't reset email, but reset passwords and errors
      setPassword('');
      setFullName('');
      setPhoneNumber('');
    }
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const triggerResendVerification = async (targetEmail) => {
    if (!targetEmail) return;
    showToast('Đang gửi lại email xác thực...');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: targetEmail })
      });
      const data = await res.json();
      if (res.status === 200 && data.success) {
        showToast('Đã gửi lại email xác thực thành công!');
        setNotice({
          text: 'Đã gửi lại thư kích hoạt tài khoản mới. Vui lòng kiểm tra email của bạn.',
          isError: false
        });
      } else {
        showToast(data.error || 'Gửi lại xác thực thất bại!', 'error');
        setNotice({ text: data.error || 'Không thể gửi lại email xác thực.', isError: true });
      }
    } catch (err) {
      showToast('Lỗi kết nối máy chủ.', 'error');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setNotice(null);

    if (!email) {
      setNotice({ text: 'Vui lòng điền Email!', isError: true });
      return;
    }

    setLoading(true);

    if (mode === 'forgot') {
      try {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        
        if (data.success) {
          showToast('Yêu cầu quên mật khẩu đã được tiếp nhận!');
          setNotice({
            text: 'Nếu địa chỉ email tồn tại trên hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu trong vài phút.',
            isError: false
          });
        } else {
          setNotice({ text: data.error || 'Có lỗi xảy ra, vui lòng thử lại.', isError: true });
        }
      } catch (err) {
        setNotice({ text: 'Lỗi hệ thống: Không kết nối được tới máy chủ.', isError: true });
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!password) {
      setNotice({ text: 'Vui lòng điền Mật khẩu!', isError: true });
      setLoading(false);
      return;
    }

    if (mode === 'register') {
      if (!fullName || !phoneNumber) {
        setNotice({ text: 'Vui lòng điền Họ tên và Số điện thoại!', isError: true });
        setLoading(false);
        return;
      }

      if (password.length < 8) {
        setNotice({ text: 'Mật khẩu phải dài tối thiểu 8 ký tự!', isError: true });
        setLoading(false);
        return;
      }

      try {
        // Validate so dien thoai (chi chu so, bat dau 0, 10-11 chu so)
      const phoneRegex = /^0\d{9,10}$/;
      if (!phoneRegex.test(phoneNumber)) {
        setNotice({ text: 'So dien thoai khong hop le! Chi nhan 10-11 chu so, bat dau bang 0 (VD: 0912345678).', isError: true });
        setLoading(false);
        return;
      }

      const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, fullName, phoneNumber, hwid: getDeviceFingerprint() })
        });
        const data = await res.json();
        
        if (res.status === 429) {
          setNotice({ text: data.error, isError: true });
          return;
        }

        if (data.success) {
          showToast('Đăng ký tài khoản thành công!');
          setNotice({
            text: `
              <strong>Đăng ký thành công!</strong><br/>
              Chúng tôi đã gửi email kích hoạt đến <strong>${email}</strong>.<br/>
              Vui lòng kiểm tra email của bạn để xác thực trước khi đăng nhập.<br/>
              <span class="underline cursor-pointer font-bold text-indigo-400" id="resend-link">Bấm vào đây để gửi lại email xác thực</span>
            `,
            isError: false,
            emailForResend: email
          });
          skipNoticeClearRef.current = true;
          onSwitchMode('login');
        } else {
          setNotice({ text: data.error || 'Đăng ký thất bại!', isError: true });
        }
      } catch (err) {
        setNotice({ text: 'Lỗi hệ thống: ' + err.message, isError: true });
      } finally {
        setLoading(false);
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
          setNotice({ text: data.error, isError: true });
          return;
        }

        if (res.status === 403) {
          setNotice({
            text: `
              ${data.error}<br/>
              <span class="underline cursor-pointer font-bold text-indigo-400" id="resend-link">Bấm vào đây để gửi lại email xác thực</span>
            `,
            isError: true,
            emailForResend: email
          });
          return;
        }

        if (data.success) {
          showToast('Đăng nhập thành công!');
          onAuthSuccess(data.user);
          onClose();
        } else {
          setNotice({ text: data.error || 'Email hoặc mật khẩu không chính xác!', isError: true });
        }
      } catch (err) {
        setNotice({ text: 'Lỗi hệ thống: ' + err.message, isError: true });
      } finally {
        setLoading(false);
      }
    }
  };

  const getModalTitle = () => {
    if (mode === 'register') return 'Đăng ký tài khoản mới';
    if (mode === 'forgot') return 'Khôi phục mật khẩu';
    return 'Đăng nhập tài khoản';
  };

  const getModalSub = () => {
    if (mode === 'register') return 'Nhận ngay License Key dùng thử 7 ngày miễn phí';
    if (mode === 'forgot') return 'Nhập email của bạn để nhận liên kết khôi phục';
    return 'Nhập email và mật khẩu của bạn';
  };

  const getModalIcon = () => {
    if (mode === 'register') return <UserPlus className="h-6 w-6" />;
    if (mode === 'forgot') return <KeyRound className="h-6 w-6" />;
    return <Lock className="h-6 w-6" />;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md transition-opacity duration-300">
      <div className="w-full max-w-md p-8 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl relative">
        
        {/* Close button */}
        <button 
          onClick={onClose} 
          className="absolute top-4 right-4 text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>
        
        {/* Logo in Modal */}
        <div className="text-center mb-6">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 text-white mb-3">
            {getModalIcon()}
          </div>
          <h3 className="text-2xl font-bold text-white font-display">{getModalTitle()}</h3>
          <p className="text-sm text-zinc-400 mt-1">{getModalSub()}</p>
        </div>
        
        {/* Notice Area */}
        {notice && (
          <div 
            className={`mb-4 p-3 rounded-lg border text-xs flex items-start gap-2 ${
              notice.isError 
                ? 'border-rose-950/60 bg-rose-950/20 text-rose-400' 
                : 'border-indigo-950/60 bg-indigo-950/20 text-indigo-400'
            }`}
          >
            {notice.isError ? (
              <AlertTriangle className="h-4.5 w-4.5 shrink-0 mt-0.5" />
            ) : (
              <Info className="h-4.5 w-4.5 shrink-0 mt-0.5" />
            )}
            <div className="flex-1">
              {notice.emailForResend ? (
                <div onClick={(e) => {
                  if (e.target.id === 'resend-link') {
                    triggerResendVerification(notice.emailForResend);
                  }
                }}>
                  <span dangerouslySetInnerHTML={{ __html: notice.text }} />
                </div>
              ) : (
                <span dangerouslySetInnerHTML={{ __html: notice.text }} />
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* Full Name (Only for Register) */}
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">Họ và tên</label>
              <input 
                type="text" 
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Ví dụ: Nguyễn Văn A" 
                required
                className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
              />
            </div>
          )}
          
          {/* Phone Number (Only for Register) */}
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">Số điện thoại</label>
              <input 
                type="text" 
                value={phoneNumber}
                onChange={(e) => { setPhoneNumber(e.target.value.replace(/\D/g, '')); }}
                placeholder="Ví dụ: 0912345678" 
                required
                className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
              />
            </div>
          )}
          
          {/* Email */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">Địa chỉ Email</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="yourname@gmail.com" 
              required
              className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
            />
          </div>
          
          {/* Password (Only for Login & Register) */}
          {mode !== 'forgot' && (
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">Mật khẩu</label>
                {mode === 'login' && (
                  <button 
                    type="button"
                    onClick={() => onSwitchMode('forgot')} 
                    className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold transition-colors cursor-pointer"
                  >
                    Quên mật khẩu?
                  </button>
                )}
              </div>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" 
                required
                className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
              />
            </div>
          )}
          
          {/* Submit Button */}
          <button 
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span>Đang xử lý...</span>
            ) : (
              <>
                <span>
                  {mode === 'register' ? 'Đăng ký ngay' : mode === 'forgot' ? 'Gửi liên kết khôi phục' : 'Xác nhận đăng nhập'}
                </span>
                {mode === 'forgot' ? <Send className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
              </>
            )}
          </button>
          
          {/* Toggle Link */}
          <div className="text-center pt-2 text-xs text-zinc-500 font-medium">
            <span>
              {mode === 'register' ? 'Đã có tài khoản?' : mode === 'forgot' ? 'Quay lại' : 'Chưa có tài khoản?'}
            </span>
            <button 
              type="button"
              onClick={() => onSwitchMode(mode === 'register' || mode === 'forgot' ? 'login' : 'register')} 
              className="text-indigo-400 hover:text-indigo-300 font-semibold underline transition-colors ml-1 cursor-pointer"
            >
              {mode === 'register' || mode === 'forgot' ? 'Đăng nhập' : 'Đăng ký ngay'}
            </button>
          </div>
          
        </form>
      </div>
    </div>
  );
}
