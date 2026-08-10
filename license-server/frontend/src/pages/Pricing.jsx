import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X, ArrowLeft, ShieldCheck } from 'lucide-react';
import { trackViewContent, trackInitiateCheckout } from '../utils/pixelTracker';

export default function Pricing({ onSubscribePlan }) {
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);

  useEffect(() => {
    trackViewContent('Bảng giá Editnhanh');
    fetchPlans();
  }, []);


  const fetchPlans = async () => {
    try {
      const res = await fetch('/api/plans');
      const data = await res.json();
      if (data.success) {
        setPlans(data.plans || []);
      }
    } catch (err) {
      console.error('Lỗi khi tải gói dịch vụ:', err);
    }
  };

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
          {plans.length === 0 ? (
            <div className="col-span-3 text-center py-12 text-zinc-500">
              Đang tải danh sách các gói dịch vụ...
            </div>
          ) : (
            plans.map((p) => {
              const formattedPrice = p.price === 0 ? '0đ' : p.price.toLocaleString('vi-VN') + 'đ';
              return (
                <div 
                  key={p.id}
                  className={`glass-card p-8 rounded-2xl flex flex-col justify-between transition-all relative overflow-hidden ${
                    p.isPopular 
                      ? 'border-gradient transform md:scale-105 shadow-xl shadow-indigo-950/20' 
                      : 'hover:border-indigo-500/40'
                  }`}
                >
                  {p.isPopular && (
                    <div className="absolute top-3 right-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-[10px] font-bold text-white px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                      Khuyên Dùng
                    </div>
                  )}
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-xl font-bold text-white">{p.name}</h3>
                      {p.description && <p className="text-xs text-zinc-400 mt-1">{p.description}</p>}
                    </div>
                    <div className="flex items-baseline">
                      <span className="text-4xl font-extrabold text-white">{formattedPrice}</span>
                      <span className="text-sm text-zinc-500 ml-1">/ {p.durationDays} ngày</span>
                    </div>
                    {p.features && p.features.length > 0 && (
                      <ul className="space-y-3.5 text-sm text-zinc-300 font-medium">
                        {p.features.map((feature, idx) => (
                          <li key={idx} className="flex items-center gap-2.5">
                            <Check className="h-4.5 w-4.5 text-indigo-400" />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="pt-8">
                    <button 
                      onClick={() => {
                        trackInitiateCheckout(p.name, p.price, p.id);
                        onSubscribePlan(p.id);
                      }}
                      className={`w-full py-3 font-bold rounded-xl shadow-md transition-all cursor-pointer text-xs ${
                        p.isPopular
                          ? 'bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white'
                          : 'border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/60 text-zinc-200'
                      }`}
                    >
                      Đăng ký {p.name}
                    </button>
                  </div>
                </div>
              );
            })
          )}
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
