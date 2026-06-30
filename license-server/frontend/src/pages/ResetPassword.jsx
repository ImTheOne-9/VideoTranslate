import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { KeyRound, ArrowRight, BadgeCheck, AlertCircle, AlertTriangle, Check, Loader2 } from 'lucide-react';

export default function ResetPassword({ showToast }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const resetToken = searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState('form'); // 'form' | 'success'
  const [errorNotice, setErrorNotice] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!resetToken) {
      setErrorNotice('Mã token khôi phục mật khẩu không hợp lệ hoặc thiếu. Vui lòng kiểm tra lại liên kết trong hòm thư!');
    }
  }, [resetToken]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorNotice('');

    if (!newPassword || !confirmPassword) {
      setErrorNotice('Vui lòng nhập đầy đủ các trường thông tin!');
      return;
    }

    if (newPassword.length < 8) {
      setErrorNotice('Mật khẩu phải dài tối thiểu 8 ký tự!');
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorNotice('Mật khẩu xác nhận không khớp! Vui lòng nhập lại.');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword })
      });
      const data = await res.json();

      if (res.status === 200 && data.success) {
        setStatus('success');
        showToast('Đặt lại mật khẩu thành công!');
      } else {
        setErrorNotice(data.error || 'Đặt lại mật khẩu thất bại. Token có thể đã hết hạn hoặc không hợp lệ.');
      }
    } catch (err) {
      setErrorNotice('Lỗi hệ thống: Không thể kết nối tới máy chủ.');
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
    return (
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-600 text-white mb-6">
        <KeyRound className="h-7 w-7" />
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col justify-center items-center p-4 min-h-[70vh] relative">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none"></div>

      <div className="w-full max-w-md p-8 rounded-2xl glass-card relative overflow-hidden shadow-2xl">
        {getStatusIcon()}

        {/* Header info */}
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold font-display text-white mb-2">
            {status === 'success' ? 'Thay đổi thành công!' : 'Đặt lại mật khẩu'}
          </h2>
          <p className="text-sm text-zinc-400">
            {status === 'success' ? 'Đặt lại mật khẩu thành công.' : 'Nhập mật khẩu mới dài tối thiểu 8 ký tự.'}
          </p>
        </div>

        {/* Error notice */}
        {errorNotice && (
          <div className="mb-5 p-3 rounded-lg border border-rose-955/60 bg-rose-955/20 text-xs text-rose-400 flex items-start gap-2">
            <AlertCircle className="h-4.5 w-4.5 shrink-0 mt-0.5" />
            <span>{errorNotice}</span>
          </div>
        )}

        {status === 'form' ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">Mật khẩu mới</label>
              <input 
                type="password" 
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Tối thiểu 8 ký tự" 
                disabled={!resetToken || loading}
                className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all disabled:opacity-50"
              />
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">Xác nhận mật khẩu</label>
              <input 
                type="password" 
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Nhập lại mật khẩu mới" 
                disabled={!resetToken || loading}
                className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all disabled:opacity-50"
              />
            </div>
            
            <button 
              type="submit"
              disabled={!resetToken || loading}
              className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang cập nhật...</span>
                </>
              ) : (
                <>
                  <span>Cập nhật mật khẩu</span>
                  <Check className="h-4 w-4" />
                </>
              )}
            </button>
          </form>
        ) : (
          <div className="text-center space-y-6">
            <p className="text-sm text-zinc-300">Mật khẩu của bạn đã được thay đổi thành công! Mọi phiên đăng nhập cũ trên thiết bị khác đều đã bị vô hiệu hóa để bảo mật.</p>
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
