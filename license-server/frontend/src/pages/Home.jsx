import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Youtube, Video, Download, Languages, Volume2, Cpu, Layers, Settings, Tv, Flame, ShieldCheck, Check, X, Zap, Sparkles, Share2, Music, HardDrive, Scissors, Mic2, Facebook } from 'lucide-react';

import downloaderImg from '../assets/downloader_screenshot.png';
import studioImg from '../assets/studio_render_screenshot.png';
import bamcanhImg from '../assets/bamcanh_screenshot.png';
import libraryImg from '../assets/library_screenshot.png';
import managepageImg from '../assets/managepage_screenshot.png';

export default function Home({ currentUser, isDevMode, onOpenAuth, onSubscribePlan, showToast, appVersion }) {
  const [plans, setPlans] = useState([]);

  useEffect(() => {
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

  const handleDownloadClick = () => {
    if (!currentUser) {
      showToast('Vui lòng đăng nhập/đăng ký tài khoản để tải file cài đặt!', 'error');
      onOpenAuth('login');
      return;
    }
    downloadWithToken();
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

  return (
    <div className="flex-1 space-y-24 pb-20">
      
      {/* SECTION 1: HERO */}
      <section className="relative overflow-hidden pt-12 pb-16 md:pt-20 md:pb-24 lg:pt-28">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>
        <div className="absolute top-1/3 left-1/4 -translate-y-1/2 w-[350px] h-[350px] bg-purple-500/10 rounded-full blur-[90px] pointer-events-none"></div>
        
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative">
          <div className="text-center max-w-5xl mx-auto space-y-6">
            <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300">
              <span className="flex h-2 w-2 rounded-full bg-indigo-500 animate-pulse"></span>
              Phiên bản Editnhanh v{appVersion || '1.0.6'} đã sẵn sàng
            </div>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold font-display leading-[1.1] tracking-tight text-white">
              Tự động hóa sản xuất Video ngắn <br/>
              <span className="text-gradient">Chỉ với 1 cú click chuột</span>
            </h1>
            <p className="text-base sm:text-lg text-zinc-400 max-w-2.5xl mx-auto leading-relaxed">
              Hệ thống all-in-one giúp bạn tự động tải video đa nền tảng, trích xuất âm thanh, sinh phụ đề chuẩn bằng Smart-Voice AI offline, lồng tiếng giọng đọc AI biểu cảm và biên tập render tốc độ cao.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
              <button 
                onClick={handleDownloadClick} 
                className="w-full sm:w-auto px-8 py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-xl shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/35 transition-all flex items-center justify-center gap-2.5 cursor-pointer"
              >
                <Download className="h-5 w-5" />
                <span>Tải xuống cho Windows</span>
              </button>
              <Link to="/pricing" className="w-full sm:w-auto px-8 py-4 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/60 font-semibold text-zinc-200 rounded-xl transition-all flex items-center justify-center">
                Xem bảng giá
              </Link>
            </div>
            
            <div className="pt-2 text-xs text-zinc-500 flex items-center justify-center gap-1.5">
              <ShieldCheck className="h-4.5 w-4.5 text-indigo-400" />
              <span>Bản quyền tích hợp Text to Speed Offline</span>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 2: SYSTEM CAPABILITIES (GIỚI THIỆU TOÀN BỘ CÔNG CỤ VỚI ẢNH MINH HỌA) */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
          <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">Hệ Sinh Thái Editnhanh</span>
          <h2 className="text-3xl sm:text-4xl font-bold font-display text-white">5 Phân Hệ Công Cụ Chuyên Nghiệp</h2>
          <p className="text-zinc-400">Tích hợp đầy đủ các giải pháp tải video, biên tập, băm cảnh, quản lý giọng & nhạc nền và đăng video lên Facebook — tất cả trên máy tính.</p>
        </div>

        <div className="space-y-24">
          
          {/* Downloader Section */}
          <div className="flex flex-col lg:flex-row items-center gap-12">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                  <Download className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-white font-display">Tải Video Đa Nền Tảng</h3>
                  <p className="text-xs text-zinc-500 font-semibold">Mạnh mẽ, tự động và không giới hạn</p>
                </div>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Phân hệ tải video thông minh cho phép dán liên kết để tải về máy tính tức thì. Hỗ trợ tải đơn lẻ hoặc quét tải toàn bộ kênh, playlist với tốc độ cao nhất.
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs text-zinc-350 bg-zinc-950/40 p-4 rounded-xl border border-zinc-900/60 font-medium">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                  <span>YouTube, Shorts & Playlists</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                  <span>TikTok, Douyin (Không logo)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                  <span>Facebook, Reels, Instagram</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                  <span>Xiaohongshu (Tiểu Hồng Thư)</span>
                </div>
              </div>
            </div>
            <div className="flex-1 w-full">
              <img src={downloaderImg} alt="Cross-platform Downloader Screen" className="w-full h-auto rounded-2xl border border-zinc-800 shadow-2xl hover:border-zinc-700 transition-all duration-300" />
            </div>
          </div>

          {/* Studio Section */}
          <div className="flex flex-col lg:flex-row-reverse items-center gap-12">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-purple-500/10 text-purple-400 flex items-center justify-center">
                  <Layers className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-white font-display">Studio Biên Tập Render</h3>
                  <p className="text-xs text-zinc-500 font-semibold">Biên tập, phụ đề dịch thuật & lồng tiếng AI trong một nơi</p>
                </div>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Giao diện làm việc chuyên nghiệp, quản lý từng dự án biên tập riêng biệt. Tích hợp nhận diện giọng nói, dịch phụ đề tự động và lồng tiếng AI offline — kết xuất tốc độ cao chỉ trong vài click.
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs text-zinc-350 bg-zinc-950/40 p-4 rounded-xl border border-zinc-900/60 font-medium">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400"></span>
                  <span>Quản lý dự án (Project Manager)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400"></span>
                  <span>Phụ đề tự động & dịch thuật AI</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400"></span>
                  <span>Lồng tiếng AI offline biểu cảm</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-400"></span>
                  <span>Render tốc độ cao, watermark</span>
                </div>
              </div>
            </div>
            <div className="flex-1 w-full">
              <img src={studioImg} alt="Studio Render Workspace" className="w-full h-auto rounded-2xl border border-zinc-800 shadow-2xl hover:border-zinc-700 transition-all duration-300" />
            </div>
          </div>

          {/* Băm cảnh Section */}
          <div className="flex flex-col lg:flex-row items-center gap-12">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-orange-500/10 text-orange-400 flex items-center justify-center">
                  <Scissors className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-white font-display">Băm Cảnh Tự Động</h3>
                  <p className="text-xs text-zinc-500 font-semibold">Cắt video đài thành các ngắn cảnh Reels/Shorts</p>
                </div>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Tự động phân tích và cắt video dài thành hàng loạt clip ngắn theo cảnh. Tùy chỉnh số bản, độ nhạy cắt cảnh và tỉ lệ khung hình đầu ra — lý tưởng để sản xuất hàng loạt Reels & Shorts.
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs text-zinc-350 bg-zinc-950/40 p-4 rounded-xl border border-zinc-900/60 font-medium">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400"></span>
                  <span>Băm tự động theo cảnh AI</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400"></span>
                  <span>Tùy chỉnh số bản chia đều</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400"></span>
                  <span>Xuất 9:16 Reels/Shorts tự động</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400"></span>
                  <span>Điều chỉnh độ nhạy cắt cảnh</span>
                </div>
              </div>
            </div>
            <div className="flex-1 w-full">
              <img src={bamcanhImg} alt="Băm cảnh tự động" className="w-full h-auto rounded-2xl border border-zinc-800 shadow-2xl hover:border-zinc-700 transition-all duration-300" />
            </div>
          </div>

          {/* Thư viện giọng & nhạc nền Section */}
          <div className="flex flex-col lg:flex-row-reverse items-center gap-12">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
                  <Mic2 className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-white font-display">Quản Lý Giọng & Nhạc Nền</h3>
                  <p className="text-xs text-zinc-500 font-semibold">Clone & quản lý kho tài nguyên âm thanh cá nhân</p>
                </div>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Thư viện tập trung để quản lý toàn bộ giọng đọc AI và nhạc nền. Hỗ trợ clone giọng nói của bản thân hoặc bất kỳ ai chỉ với file ghi âm ngắn, tạo ra giọng đọc AI hoàn toàn riêng tư.
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs text-zinc-350 bg-zinc-950/40 p-4 rounded-xl border border-zinc-900/60 font-medium">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                  <span>Clone giọng nói bằng Omni Cloner</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                  <span>Thư viện nhạc nền tùy chỉnh</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                  <span>Giọng đọc AI offline cá nhân hóa</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                  <span>Quản lý & tái sử dụng dễ dàng</span>
                </div>
              </div>
            </div>
            <div className="flex-1 w-full">
              <img src={libraryImg} alt="Quản lý giọng và nhạc nền" className="w-full h-auto rounded-2xl border border-zinc-800 shadow-2xl hover:border-zinc-700 transition-all duration-300" />
            </div>
          </div>

          {/* Quản lý Page Facebook Section */}
          <div className="flex flex-col lg:flex-row items-center gap-12">
            <div className="flex-1 space-y-6">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-blue-500/10 text-blue-400 flex items-center justify-center">
                  <Facebook className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-2xl font-bold text-white font-display">Quản Lý Đăng Video Facebook</h3>
                  <p className="text-xs text-zinc-500 font-semibold">Đăng hàng loạt video lên Page Facebook tự động</p>
                </div>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Quản lý danh sách tất cả các Facebook Fanpage của bạn tập trung tại một nơi. Lên lịch và đăng hàng loạt video lên nhiều Page cùng lúc — tối ưu hiệu suất vận hành kênh.
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs text-zinc-350 bg-zinc-950/40 p-4 rounded-xl border border-zinc-900/60 font-medium">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400"></span>
                  <span>Quản lý nhiều Fanpage cùng lúc</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400"></span>
                  <span>Đăng video hàng loạt tự động</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400"></span>
                  <span>Thêm, sửa, xóa Page dễ dàng</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400"></span>
                  <span>Tìm kiếm & lọc Page nhanh chóng</span>
                </div>
              </div>
            </div>
            <div className="flex-1 w-full">
              <img src={managepageImg} alt="Quản lý đăng video Facebook Page" className="w-full h-auto rounded-2xl border border-zinc-800 shadow-2xl hover:border-zinc-700 transition-all duration-300" />
            </div>
          </div>

        </div>
      </section>

      {/* SECTION 3: WORKFLOW SHOWCASE (QUY TRÌNH SẢN XUẤT VIDEO TỰ ĐỘNG) */}
      <section className="py-20 bg-zinc-900/20 border-t border-b border-zinc-900 relative">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[350px] bg-indigo-500/5 rounded-full blur-[120px] pointer-events-none"></div>
        
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative">
          <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
            <span className="text-xs font-bold text-purple-400 uppercase tracking-widest">Quy Trình Siêu Tốc</span>
            <h2 className="text-3xl sm:text-4xl font-bold font-display text-white">Xây Dựng Kênh Triệu View Với 4 Bước</h2>
            <p className="text-zinc-400">Tối ưu hóa thời gian sản xuất video của bạn từ 2 tiếng xuống còn chưa đầy 2 phút.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            
            <div className="space-y-4 text-center md:text-left relative">
              <div className="h-10 w-10 rounded-full bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold text-sm border border-indigo-500/20">
                01
              </div>
              <h4 className="text-lg font-bold text-white">Tải Video Gốc</h4>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Sao chép link TikTok, YouTube Shorts dán vào app để tải video không logo chất lượng cao nhất.
              </p>
            </div>

            <div className="space-y-4 text-center md:text-left">
              <div className="h-10 w-10 rounded-full bg-purple-500/10 text-purple-400 flex items-center justify-center font-bold text-sm border border-purple-500/20">
                02
              </div>
              <h4 className="text-lg font-bold text-white">Dịch & Phụ Đề AI</h4>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Chạy nhận diện AI để tự động sinh phụ đề, dịch ngôn ngữ chuẩn xác và căn chỉnh khớp timeline.
              </p>
            </div>

            <div className="space-y-4 text-center md:text-left">
              <div className="h-10 w-10 rounded-full bg-pink-500/10 text-pink-400 flex items-center justify-center font-bold text-sm border border-pink-500/20">
                03
              </div>
              <h4 className="text-lg font-bold text-white">Sinh Giọng Lồng Tiếng</h4>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Nhập văn bản hoặc lấy từ phụ đề dịch để sinh giọng lồng tiếng bằng AI chân thực, sống động.
              </p>
            </div>

            <div className="space-y-4 text-center md:text-left">
              <div className="h-10 w-10 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold text-sm border border-emerald-500/20">
                04
              </div>
              <h4 className="text-lg font-bold text-white">Trộn BGM & Render</h4>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Ghép nhạc nền, chèn logo thương hiệu của bạn và nhấn Render tự động lắp ráp và xuất video.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* SECTION 4: OFFLINE CAPABILITY HIGHLIGHT (SỨC MẠNH OFFLINE) */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="glass-card p-8 md:p-12 rounded-3xl grid grid-cols-1 lg:grid-cols-2 gap-8 items-center border-indigo-500/15">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-950/30 border border-emerald-900/40 text-xs font-semibold text-emerald-400">
              <Cpu className="h-4 w-4 animate-spin-slow" />
              <span>Chạy Local 100% trên PC</span>
            </div>
            <h2 className="text-3xl font-bold font-display text-white leading-tight">
              Sức Mạnh AI Offline <br/>
              <span className="text-gradient">Không Lo Giới Hạn Chi Phí</span>
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Các mô hình AI nhận diện giọng nói và lồng tiếng được lưu trữ và tính toán trực tiếp trên phần cứng máy tính của bạn.
            </p>
            <ul className="space-y-3.5 text-xs text-zinc-300 font-medium">
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-400" />
                <span>Không giới hạn số lượng ký tự hay số phút chuyển đổi</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-400" />
                <span>Bảo mật tuyệt đối thông tin, không gửi dữ liệu ra bên ngoài</span>
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="h-4 w-4 text-emerald-400" />
                <span>Không phát sinh thêm chi phí API hàng tháng</span>
              </li>
            </ul>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="p-5 bg-zinc-950/80 rounded-2xl border border-zinc-900 text-center space-y-2">
              <HardDrive className="h-8 w-8 text-indigo-400 mx-auto" />
              <h4 className="text-sm font-bold text-white">Chạy Độc Lập</h4>
              <p className="text-[10px] text-zinc-500">Chỉ cần tải phần mềm, chạy offline không cần Internet để biên tập.</p>
            </div>
            <div className="p-5 bg-zinc-950/80 rounded-2xl border border-zinc-900 text-center space-y-2">
              <Music className="h-8 w-8 text-purple-400 mx-auto" />
              <h4 className="text-sm font-bold text-white">Nhạc Nền Sạch</h4>
              <p className="text-[10px] text-zinc-500">Hệ thống gợi ý nhạc nền miễn phí bản quyền tích hợp sẵn trong thư viện.</p>
            </div>
            <div className="p-5 bg-zinc-950/80 rounded-2xl border border-zinc-900 text-center space-y-2">
              <Share2 className="h-8 w-8 text-pink-400 mx-auto" />
              <h4 className="text-sm font-bold text-white">Quản Lý Trang</h4>
              <p className="text-[10px] text-zinc-500">Quản lý đồng thời nhiều tài khoản, theo dõi chiến dịch đăng bài.</p>
            </div>
            <div className="p-5 bg-zinc-950/80 rounded-2xl border border-zinc-900 text-center space-y-2">
              <Sparkles className="h-8 w-8 text-emerald-400 mx-auto" />
              <h4 className="text-sm font-bold text-white">Cập Nhật Free</h4>
              <p className="text-[10px] text-zinc-500">Tự động kiểm tra bản cập nhật mới, vá lỗi và tối ưu hiệu suất.</p>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 5: PRICING */}
      <section id="pricing" className="py-20 border-t border-zinc-900 relative">
        <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-purple-500/5 rounded-full blur-[100px] pointer-events-none"></div>
        
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative">
          <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
            <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">Bảng Giá Dịch Vụ</span>
            <h2 className="text-3xl font-bold font-display text-white">Chọn gói bản quyền của bạn</h2>
            <p className="text-zinc-400">Đăng ký tài khoản để kích hoạt dùng thử miễn phí hoặc nâng cấp lên gói trả phí để có License sử dụng lâu dài.</p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
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
                        onClick={() => onSubscribePlan(p.id)} 
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
        </div>
      </section>
    </div>
  );
}
