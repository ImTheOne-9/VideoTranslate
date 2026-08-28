import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { MailCheck, Loader2, ArrowRight, BadgeCheck, AlertCircle, AlertTriangle, WifiOff } from 'lucide-react';
import { trackRegistration } from '../utils/pixelTracker';

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('loading'); // 'loading' | 'success' | 'failed' | 'network-error'
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('failed');
      setMessage('Thiếu mã token xác nhận. Vui lòng kiểm tra lại liên kết trong hòm thư.');
      setLoading(false);
      return;
    }

    performVerification();
  }, [token]);

  const performVerification = async () => {
    try {
      const res = await fetch(`/api/auth/verify-email?token=${token}`);
      const data = await res.json();

      if (res.status === 200 && data.success) {
        trackRegistration(data.metaEventId);
        setStatus('success');
        setMessage(data.message || 'Tài khoản của bạn đã được xác thực email. Bây giờ bạn có thể đăng nhập để bắt đầu sử dụng!');
      } else {
        setStatus('failed');
        setMessage(data.error || 'Token không hợp lệ, đã hết hạn, hoặc đã được sử dụng từ trước.');
      }
    } catch (err) {
      setStatus('network-error');
      setMessage('Không thể kết nối tới máy chủ. Vui lòng kiểm tra lại kết nối mạng.');
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = () => {
    if (status === 'success') {
      return (
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400 mb-6">
          <BadgeCheck className="h-7 w-7" />
        </div>
      );
    }
    if (status === 'failed') {
      return (
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-400 mb-6">
          <AlertTriangle className="h-7 w-7" />
        </div>
      );
    }
    if (status === 'network-error') {
      return (
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-850 text-zinc-400 mb-6">
          <WifiOff className="h-7 w-7" />
        </div>
      );
    }
    return (
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-600 text-white mb-6">
        <MailCheck className="h-7 w-7 animate-pulse" />
      </div>
    );
  };

  const getTitleText = () => {
    if (status === 'success') return 'Kích hoạt thành công!';
    if (status === 'failed') return 'Kích hoạt thất bại!';
    if (status === 'network-error') return 'Lỗi hệ thống!';
    return 'Đang xác thực email...';
  };

  const getSubText = () => {
    if (status === 'loading') return 'Vui lòng chờ trong giây lát trong khi hệ thống xác nhận tài khoản.';
    return message;
  };

  return (
    <div className="flex-1 flex flex-col justify-center items-center p-4 min-h-[70vh] relative">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none"></div>

      <div className="w-full max-w-md p-8 rounded-2xl glass-card text-center relative overflow-hidden shadow-2xl">
        {getStatusIcon()}

        <h2 className="text-2xl font-bold font-display text-white mb-2">{getTitleText()}</h2>
        <p className="text-sm text-zinc-400 mb-6">{getSubText()}</p>

        {status === 'loading' && (
          <div className="flex flex-col items-center justify-center gap-3 py-6">
            <Loader2 className="h-10 w-10 text-indigo-500 animate-spin" />
            <span className="text-xs text-zinc-500">Đang giao tiếp với máy chủ...</span>
          </div>
        )}

        {status !== 'loading' && (
          <div className="space-y-4">
            <button 
              onClick={() => navigate('/')}
              className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>Quay lại Trang Chủ</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
