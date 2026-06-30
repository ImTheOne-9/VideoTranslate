import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Mail, Phone, Calendar, ShieldCheck, Award, ArrowLeft, Camera, Edit2, Check, X, Loader2 } from 'lucide-react';

export default function Profile({ currentUser, onUpdateUser, showToast }) {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [isEditing, setIsEditing] = useState(false);
  const [fullName, setFullName] = useState(currentUser?.fullName || '');
  const [phoneNumber, setPhoneNumber] = useState(currentUser?.phoneNumber || '');
  const [avatar, setAvatar] = useState(currentUser?.avatar || null);
  const [isSaving, setIsSaving] = useState(false);

  if (!currentUser) {
    return null; // Handle via App.jsx redirect
  }

  const getAvatarInitials = (name) => {
    if (!name) return 'U';
    const names = name.split(' ');
    return names.length > 1 ? (names[0][0] + names[names.length - 1][0]).toUpperCase() : names[0][0].toUpperCase();
  };

  const handleAvatarClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        showToast('Ảnh đại diện không được vượt quá 2MB!', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setAvatar(reader.result); // Base64 string
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCancel = () => {
    setFullName(currentUser.fullName || '');
    setPhoneNumber(currentUser.phoneNumber || '');
    setAvatar(currentUser.avatar || null);
    setIsEditing(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!fullName.trim()) {
      showToast('Họ và tên không được để trống!', 'error');
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch('/api/user/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: fullName.trim(),
          phoneNumber: phoneNumber.trim(),
          avatar
        })
      });

      const data = await res.json();
      if (res.status === 200 && data.success) {
        showToast(data.message || 'Cập nhật hồ sơ thành công!');
        if (onUpdateUser) {
          onUpdateUser(data.user);
        }
        setIsEditing(false);
      } else {
        showToast(data.error || 'Không thể cập nhật hồ sơ!', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối máy chủ: ' + err.message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const formattedDate = currentUser.createdAt 
    ? new Date(currentUser.createdAt).toLocaleDateString('vi-VN', {
        year: 'numeric', month: 'long', day: 'numeric'
      })
    : 'Chưa cập nhật';

  const roleText = currentUser.role === 'admin' ? 'Quản trị viên (Admin)' : 'Thành viên chính thức (Member)';

  return (
    <div className="flex-1 min-h-[80vh] flex flex-col justify-center items-center p-4 sm:p-6 lg:p-8 relative">
      {/* Background neon glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      
      <div className="w-full max-w-2xl rounded-2xl glass-card overflow-hidden shadow-2xl relative">
        
        {/* Header decoration */}
        <div className="h-32 bg-gradient-to-r from-indigo-500/20 via-purple-500/20 to-pink-500/20 border-b border-zinc-800/40 relative">
          <button 
            onClick={() => navigate('/dashboard')} 
            className="absolute top-4 left-4 px-3 py-1.5 rounded-lg bg-zinc-950/80 border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white transition-all flex items-center gap-1.5 cursor-pointer z-10"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Về Dashboard</span>
          </button>

          {!isEditing && (
            <button 
              onClick={() => setIsEditing(true)} 
              className="absolute top-4 right-4 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white shadow-lg transition-all flex items-center gap-1.5 cursor-pointer z-10"
            >
              <Edit2 className="h-3.5 w-3.5" />
              <span>Chỉnh sửa hồ sơ</span>
            </button>
          )}
        </div>

        {/* Profile Details Content */}
        <div className="px-6 pb-8 sm:px-8 sm:pb-10 relative">
          
          {/* Large Avatar container */}
          <div className="absolute -top-14 left-6 sm:left-8">
            <div className="relative group/avatar">
              <div className="h-24 w-24 rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-600 border-4 border-zinc-950 flex items-center justify-center font-bold text-white text-3xl shadow-xl shadow-indigo-500/10 overflow-hidden select-none">
                {avatar ? (
                  <img src={avatar} alt="Avatar" className="h-full w-full object-cover" />
                ) : (
                  getAvatarInitials(fullName || currentUser.fullName)
                )}
              </div>

              {isEditing && (
                <div 
                  onClick={handleAvatarClick}
                  className="absolute inset-0 rounded-2xl bg-black/60 opacity-0 group-hover/avatar:opacity-100 transition-all flex flex-col items-center justify-center cursor-pointer text-white border-4 border-transparent"
                >
                  <Camera className="h-5 w-5" />
                  <span className="text-[10px] font-bold mt-1">Đổi ảnh</span>
                </div>
              )}
            </div>
            
            {/* Hidden File Input */}
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileChange} 
              accept="image/*" 
              className="hidden" 
            />
          </div>

          {/* User Meta info */}
          <div className="pt-14 mt-4 space-y-1 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-zinc-900 pb-6">
            <div>
              <h2 className="text-2xl font-bold text-white font-display flex items-center gap-2">
                <span>{fullName || currentUser.fullName}</span>
                {currentUser.role === 'admin' && (
                  <span className="text-[10px] bg-indigo-500/25 border border-indigo-500/35 text-indigo-300 px-2 py-0.5 rounded font-bold uppercase tracking-wider font-sans">
                    Admin
                  </span>
                )}
              </h2>
              <p className="text-sm text-zinc-400 mt-1">Quản lý và cập nhật hồ sơ cá nhân thành viên</p>
            </div>
            
            <div className="text-[11px] text-zinc-500 font-medium">
              ID Tài khoản: <span className="font-mono text-zinc-400 select-all">{currentUser._id || currentUser.id || 'N/A'}</span>
            </div>
          </div>

          {isEditing ? (
            /* ================= EDITING FORM ================= */
            <form onSubmit={handleSave} className="space-y-6 py-6 border-b border-zinc-900">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                
                <div className="space-y-2">
                  <label className="text-[10px] text-zinc-400 uppercase font-semibold tracking-wider flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 text-indigo-400" />
                    <span>Họ và tên</span>
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Nhập họ và tên"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-all placeholder-zinc-700"
                    disabled={isSaving}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] text-zinc-400 uppercase font-semibold tracking-wider flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-indigo-400" />
                    <span>Số điện thoại</span>
                  </label>
                  <input
                    type="text"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="Nhập số điện thoại"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-all placeholder-zinc-700"
                    disabled={isSaving}
                  />
                </div>

                <div className="space-y-2 md:col-span-2">
                  <label className="text-[10px] text-zinc-400 uppercase font-semibold tracking-wider flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-zinc-650" />
                    <span>Địa chỉ Email (Không được thay đổi)</span>
                  </label>
                  <input
                    type="email"
                    value={currentUser.email}
                    className="w-full bg-zinc-950/40 border border-zinc-900/60 rounded-xl px-4 py-3 text-sm text-zinc-550 select-none cursor-not-allowed"
                    disabled
                  />
                </div>

              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-4 py-2 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/40 text-xs font-semibold text-zinc-300 rounded-xl transition-all cursor-pointer flex items-center gap-1.5"
                  disabled={isSaving}
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Hủy bỏ</span>
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-xs font-bold text-white rounded-xl shadow-lg shadow-indigo-500/10 transition-all cursor-pointer flex items-center gap-1.5"
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Đang lưu...</span>
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>Lưu thay đổi</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            /* ================= VIEW MODE ================= */
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-6 border-b border-zinc-900">
              
              <div className="flex items-start gap-3.5">
                <div className="h-9 w-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-center justify-center shrink-0">
                  <User className="h-4.5 w-4.5" />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Họ và tên</span>
                  <p className="text-sm font-semibold text-white">{currentUser.fullName}</p>
                </div>
              </div>

              <div className="flex items-start gap-3.5">
                <div className="h-9 w-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-center justify-center shrink-0">
                  <Mail className="h-4.5 w-4.5" />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Địa chỉ Email</span>
                  <p className="text-sm font-semibold text-white truncate select-all">{currentUser.email}</p>
                </div>
              </div>

              <div className="flex items-start gap-3.5">
                <div className="h-9 w-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-center justify-center shrink-0">
                  <Phone className="h-4.5 w-4.5" />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Số điện thoại</span>
                  <p className="text-sm font-semibold text-white select-all">{currentUser.phoneNumber || 'Chưa cập nhật'}</p>
                </div>
              </div>

              <div className="flex items-start gap-3.5">
                <div className="h-9 w-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-center justify-center shrink-0">
                  <Award className="h-4.5 w-4.5" />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Vai trò tài khoản</span>
                  <p className="text-sm font-semibold text-white">{roleText}</p>
                </div>
              </div>

              <div className="flex items-start gap-3.5 md:col-span-2">
                <div className="h-9 w-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 flex items-center justify-center shrink-0">
                  <Calendar className="h-4.5 w-4.5" />
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Ngày tham gia hệ thống</span>
                  <p className="text-sm font-semibold text-white">Đã gia nhập từ {formattedDate}</p>
                </div>
              </div>

            </div>
          )}

          {/* Safety Notice Card */}
          <div className="mt-6 p-4 rounded-xl border border-zinc-900 bg-zinc-950/40 space-y-3">
            <h4 className="text-xs font-bold text-white flex items-center gap-1.5 uppercase tracking-wider">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span>Khuyến cáo bảo mật tài khoản</span>
            </h4>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Mỗi License Key của bạn được liên kết trực tiếp với mã phần cứng (HWID) máy tính để tránh chia sẻ trái phép. Vui lòng bảo quản key cẩn thiện và không tiết lộ token phiên đăng nhập. Bạn có tối đa 2 lần tự giải phóng thiết bị (Reset HWID) mỗi năm dương lịch.
            </p>
          </div>

        </div>

      </div>
    </div>
  );
}
