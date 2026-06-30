import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Cpu, ShieldCheck, Zap, Heart, Mail, MessageSquare, Code } from 'lucide-react';

export default function About() {
  const navigate = useNavigate();

  return (
    <div className="flex-1 min-h-[85vh] py-12 px-4 sm:px-6 lg:px-8 relative">
      {/* Background neon glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 left-1/3 w-[450px] h-[450px] bg-purple-500/5 rounded-full blur-[100px] pointer-events-none"></div>

      <div className="w-full max-w-4xl mx-auto relative z-10 space-y-10">
        
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

        {/* Hero title */}
        <div className="text-center space-y-4 max-w-2.5xl mx-auto">
          <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-semibold text-indigo-400">
            <Heart className="h-4 w-4 fill-indigo-400/25 animate-pulse" />
            <span>Sứ mệnh của chúng tôi</span>
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold font-display leading-tight text-white">
            Giải pháp Tự động hóa <br/>
            <span className="text-gradient">Sản xuất Video AI Offline</span>
          </h1>
          <p className="text-sm sm:text-base text-zinc-400 leading-relaxed pt-2">
            Video Studio Tools ra đời nhằm giúp các nhà sáng tạo nội dung (Content Creators) giải phóng sức lao động thủ công, tối ưu hóa 90% quy trình sản xuất video ngắn (Reup/Edit) thông qua sức mạnh trí tuệ nhân tạo chạy trực tiếp trên máy tính cá nhân.
          </p>
        </div>

        {/* Section 1: Core Values */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6">
          
          <div className="glass-card p-6 rounded-2xl border border-zinc-900 hover:border-indigo-500/30 transition-all space-y-4">
            <div className="h-10 w-10 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold text-white font-display">Bảo mật tuyệt đối</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Mọi tác vụ tải, trích xuất phụ đề, lồng tiếng và kết xuất video diễn ra 100% trên PC của bạn. Không tải dữ liệu cá nhân lên cloud, bảo mật dữ liệu nguồn tuyệt đối.
            </p>
          </div>

          <div className="glass-card p-6 rounded-2xl border border-zinc-900 hover:border-purple-500/30 transition-all space-y-4">
            <div className="h-10 w-10 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center">
              <Zap className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold text-white font-display">Không giới hạn</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Do các mô hình AI chạy offline hoàn toàn bằng tài nguyên phần cứng local, bạn không cần lo ngại giới hạn ký tự thuyết minh hay thời lượng video dịch thuật hàng tháng.
            </p>
          </div>

          <div className="glass-card p-6 rounded-2xl border border-zinc-900 hover:border-emerald-500/30 transition-all space-y-4">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <Cpu className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold text-white font-display">Tối ưu hiệu suất</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Phần mềm được tích hợp tăng tốc phần cứng thông qua thư viện GPU NVIDIA CUDA kết hợp cùng nhân xử lý đồ họa độc quyền tăng tốc VST-Core, cho tốc độ render video nhanh gấp 5 lần thông thường.
            </p>
          </div>

        </div>

        {/* Section 2: Core Technologies */}
        <div className="glass-card p-8 rounded-2xl border border-zinc-900 space-y-6">
          <div className="flex items-center gap-2.5">
            <Code className="h-5 w-5 text-indigo-400" />
            <h2 className="text-xl font-bold text-white font-display">Động cơ công nghệ cốt lõi</h2>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Chúng tôi phát triển và tích hợp các động cơ AI cùng nhân xử lý đa phương tiện chuyên biệt, được tinh chỉnh độc quyền nhằm tối ưu hóa hiệu năng tối đa cho thiết bị PC của người dùng:
          </p>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2">
            <div className="space-y-1.5 p-4 bg-zinc-950/60 rounded-xl border border-zinc-900/60">
              <h4 className="text-sm font-bold text-white">Động cơ Nhận diện Smart-Voice AI</h4>
              <p className="text-xs text-zinc-505 leading-relaxed">
                Hệ thống AI xử lý âm thanh tự động phân tích và chuyển đổi giọng nói trong video thành văn bản (Subtitle) với mốc thời gian (Timestamps) chuẩn xác đến 99%.
              </p>
            </div>
            <div className="space-y-1.5 p-4 bg-zinc-950/60 rounded-xl border border-zinc-900/60">
              <h4 className="text-sm font-bold text-white">Động cơ Tổng hợp Giọng đọc VST-Speech AI</h4>
              <p className="text-xs text-zinc-505 leading-relaxed">
                Mô hình tổng hợp giọng đọc AI offline truyền cảm tự nhiên, hỗ trợ nhiều tùy chỉnh giọng đọc nam/nữ nhiều vùng miền và tự động căn khớp tốc độ theo video gốc.
              </p>
            </div>
            <div className="space-y-1.5 p-4 bg-zinc-950/60 rounded-xl border border-zinc-900/60">
              <h4 className="text-sm font-bold text-white">Động cơ Render Video VST-Core Rendering</h4>
              <p className="text-xs text-zinc-505 leading-relaxed">
                Hệ thống biên dịch và xử lý đồ họa đa luồng siêu mạnh mẽ, giúp cắt ghép video, đồng bộ âm thanh, đè phụ đề cứng và chèn watermark bản quyền tốc độ cực hạn.
              </p>
            </div>
            <div className="space-y-1.5 p-4 bg-zinc-950/60 rounded-xl border border-zinc-900/60">
              <h4 className="text-sm font-bold text-white">Hệ thống Quét và Tải Đa Kênh High-Speed Crawler</h4>
              <p className="text-xs text-zinc-505 leading-relaxed">
                Cơ chế thu thập dữ liệu video tự động, cho phép tải toàn bộ danh sách phát hoặc kênh từ YouTube, TikTok, Facebook Reels, Douyin, Xiaohongshu với băng thông tối đa.
              </p>
            </div>
          </div>
        </div>

        {/* Section 3: Contact Details */}
        <div className="glass-card p-6 rounded-2xl border border-zinc-900 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="space-y-2">
            <h3 className="text-lg font-bold text-white font-display flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-indigo-400" />
              <span>Liên hệ & Hỗ trợ kỹ thuật</span>
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed max-w-xl">
              Bạn có bất kỳ góp ý, yêu cầu tính năng mới hoặc cần hỗ trợ kích hoạt license? Hãy liên hệ ngay với đội ngũ hỗ trợ của chúng tôi để được giải quyết nhanh nhất.
            </p>
          </div>
          
          <div className="flex flex-col gap-2 shrink-0 w-full md:w-auto">
            <a 
              href="mailto:support@videostudiotools.com" 
              className="px-4 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900 text-xs font-semibold text-zinc-300 flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              <Mail className="h-4.5 w-4.5" />
              <span>support@videostudiotools.com</span>
            </a>
            <div className="px-4 py-2.5 rounded-xl bg-zinc-950 border border-zinc-900 text-xs font-semibold text-zinc-400 flex items-center justify-center gap-2 select-text">
              <span>💬 Zalo / Telegram hỗ trợ: 0988.xxx.xxx</span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
