import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X, ArrowLeft, ShieldCheck } from 'lucide-react';

export default function Pricing({ onSubscribePlan }) {
  const navigate = useNavigate();

  return (
    <div className="flex-1 min-h-[80vh] flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8 relative">
      {/* Background glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      
      <div className="w-full max-w-6xl relative z-10 space-y-8">
        
        {/* Back button */}
        <div className="flex justify-start">
          <button 
            onClick={() => navigate('/')} 
            className="px-3 py-1.5 rounded-lg bg-zinc-950/80 border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Quay lại trang chủ</span>
          </button>
        </div>

        {/* Pricing header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">Bảng Giá Dịch Vụ</span>
          <h2 className="text-3xl sm:text-4xl font-bold font-display text-white">Chọn gói bản quyền của bạn</h2>
          <p className="text-zinc-400">Đăng ký tài khoản để kích hoạt dùng thử miễn phí hoặc nâng cấp lên gói trả phí để có License sử dụng lâu dài.</p>
        </div>

        {/* Pricing Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto pt-6">
          
          {/* Trial Card */}
          <div className="glass-card p-8 rounded-2xl flex flex-col justify-between hover:border-indigo-500/40 transition-all relative overflow-hidden">
            <div className="space-y-6">
              <div>
                <h3 className="text-xl font-bold text-white">Gói Dùng thử</h3>
                <p className="text-xs text-zinc-400 mt-1">Trải nghiệm đầy đủ tính năng công cụ</p>
              </div>
              <div className="flex items-baseline">
                <span className="text-4xl font-extrabold text-white">0đ</span>
                <span className="text-sm text-zinc-500 ml-1">/ 7 ngày</span>
              </div>
              <ul className="space-y-3.5 text-sm text-zinc-300 font-medium">
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Đầy đủ tính năng 100%</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Sử dụng trên 1 máy tính</span>
                </li>
                <li className="flex items-center gap-2.5 text-zinc-500">
                  <X className="h-4.5 w-4.5 text-zinc-650" />
                  <span>Hỗ trợ kỹ thuật ưu tiên</span>
                </li>
              </ul>
            </div>
            <div className="pt-8">
              <button 
                onClick={() => onSubscribePlan('trial')} 
                className="w-full py-3 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/60 font-semibold rounded-xl text-zinc-200 transition-all cursor-pointer text-xs"
              >
                Đăng ký dùng thử
              </button>
            </div>
          </div>
          
          {/* Monthly Card */}
          <div className="glass-card p-8 rounded-2xl flex flex-col justify-between border-gradient transition-all relative overflow-hidden transform md:scale-105 shadow-xl shadow-indigo-950/20">
            <div className="absolute top-3 right-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-[10px] font-bold text-white px-2.5 py-0.5 rounded-full uppercase tracking-wider">
              Khuyên Dùng
            </div>
            <div className="space-y-6">
              <div>
                <h3 className="text-xl font-bold text-white">Gói Tháng</h3>
                <p className="text-xs text-zinc-400 mt-1">Dành cho Creator sáng tạo thường xuyên</p>
              </div>
              <div className="flex items-baseline">
                <span className="text-4xl font-extrabold text-white">199.000đ</span>
                <span className="text-sm text-zinc-500 ml-1">/ 30 ngày</span>
              </div>
              <ul className="space-y-3.5 text-sm text-zinc-300 font-medium">
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Đầy đủ tính năng 100%</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Sử dụng trên 1 máy tính</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Tự động nhận key qua email</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Hỗ trợ kỹ thuật 24/7</span>
                </li>
              </ul>
            </div>
            <div className="pt-8">
              <button 
                onClick={() => onSubscribePlan('monthly')} 
                className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-xl shadow-md transition-all cursor-pointer text-xs"
              >
                Đăng ký Gói Tháng
              </button>
            </div>
          </div>
          
          {/* Yearly Card */}
          <div className="glass-card p-8 rounded-2xl flex flex-col justify-between hover:border-purple-500/40 transition-all relative overflow-hidden">
            <div className="space-y-6">
              <div>
                <h3 className="text-xl font-bold text-white">Gói Năm</h3>
                <p className="text-xs text-zinc-400 mt-1">Tiết kiệm tối đa chi phí dài hạn</p>
              </div>
              <div className="flex items-baseline">
                <span className="text-4xl font-extrabold text-white">1.499.000đ</span>
                <span className="text-sm text-zinc-500 ml-1">/ 365 ngày</span>
              </div>
              <ul className="space-y-3.5 text-sm text-zinc-300 font-medium">
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Đầy đủ tính năng 100%</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Sử dụng trên 1 máy tính</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Cập nhật các tính năng mới miễn phí</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="h-4.5 w-4.5 text-indigo-400" />
                  <span>Ưu tiên xử lý lỗi & Hỗ trợ VIP</span>
                </li>
              </ul>
            </div>
            <div className="pt-8">
              <button 
                onClick={() => onSubscribePlan('yearly')} 
                className="w-full py-3 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/60 font-semibold rounded-xl text-zinc-200 transition-all cursor-pointer text-xs"
              >
                Đăng ký Gói Năm
              </button>
            </div>
          </div>
          
        </div>

        {/* Security / FAQ bottom note */}
        <div className="text-center pt-8 flex items-center justify-center gap-2 text-xs text-zinc-500">
          <ShieldCheck className="h-4.5 w-4.5 text-indigo-400" />
          <span>Giao dịch an toàn, bảo mật thông tin tuyệt đối qua cổng VietQR tự động.</span>
        </div>

      </div>
    </div>
  );
}
