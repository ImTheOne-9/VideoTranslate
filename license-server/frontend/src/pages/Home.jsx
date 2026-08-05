import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Youtube, Video, Download, Languages, Volume2, Cpu, Layers, Settings, Tv, Flame, ShieldCheck, Check, X, Zap, Sparkles, Share2, Music, HardDrive, Scissors, Mic2, Facebook, ZoomIn, Star, HelpCircle, ChevronDown, CheckCircle2, Play } from 'lucide-react';

import downloaderImg from '../assets/downloader_screenshot.png';
import studioImg from '../assets/studio_render_screenshot.png';
import bamcanhImg from '../assets/bamcanh_screenshot.png';
import libraryImg from '../assets/library_screenshot.png';
import managepageImg from '../assets/managepage_screenshot.png';

export default function Home({ currentUser, isDevMode, onOpenAuth, onSubscribePlan, showToast, appVersion }) {
  const [plans, setPlans] = useState([]);
  const [zoomImage, setZoomImage] = useState(null);
  const [openFaq, setOpenFaq] = useState(null);
  const [showStickyCta, setShowStickyCta] = useState(false);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [videoUrl, setVideoUrl] = useState('https://www.youtube.com/embed/U2WiOdjRMkU?autoplay=1');

  const faqs = [
    {
      q: "Thanh toán xong bao lâu thì nhận được Key bản quyền?",
      a: "Hệ thống Editnhanh hoạt động tự động 24/7. Ngay sau khi bạn hoàn tất chuyển khoản theo đúng nội dung, Key bản quyền sẽ tự động xuất hiện trên màn hình và gửi trực tiếp vào Email của bạn trong vòng 30 giây."
    },
    {
      q: "Một Key bản quyền có thể sử dụng được trên mấy máy tính?",
      a: "Mỗi License Key được gắn cố định với 01 mã phần cứng (HWID) máy tính để đảm bảo hiệu suất tốt nhất. Nếu bạn nâng cấp hoặc thay đổi máy tính, đội ngũ hỗ trợ kỹ thuật sẽ hỗ trợ chuyển đổi Key sang máy mới."
    },
    {
      q: "Hết 7 ngày dùng thử thì phần mềm xử lý thế nào?",
      a: "Sau 7 ngày dùng thử miễn phí, phần mềm sẽ thông báo hết hạn dùng thử. Bạn có thể chọn đăng ký Gói Tháng (299.000đ) hoặc Gói Năm (1.499.000đ) để tiếp tục sử dụng mà không bị mất bất kỳ dữ liệu hay dự án nào."
    },
    {
      q: "Cấu hình máy tính tối thiểu để chạy mượt là gì?",
      a: "Phần mềm chạy trên hệ điều hành Windows 10/11 (64-bit). Cấu hình đề xuất: CPU Core i3/i5 hoặc tương đương, RAM 8GB trở lên. Các tính năng AI Whisper & Omnivoice chạy mượt trực tiếp trên máy không bắt buộc có card đồ họa rời."
    },
    {
      q: "Tôi có được cập nhật các tính năng mới miễn phí không?",
      a: "Tất cả thành viên có bản quyền còn hạn (Gói Tháng & Gói Năm) đều được tự động cập nhật mọi tính năng mới, cải tiến AI và bản vá lỗi hoàn toàn miễn phí."
    }
  ];

  useEffect(() => {
    fetchPlans();

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setZoomImage(null);
        setShowVideoModal(false);
      }
    };

    const handleScroll = () => {
      if (window.scrollY > 500) {
        setShowStickyCta(true);
      } else {
        setShowStickyCta(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll);
    };
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
              <button 
                onClick={() => setShowVideoModal(true)} 
                className="w-full sm:w-auto px-7 py-4 bg-zinc-900 border border-zinc-700/80 hover:border-indigo-500/60 hover:bg-zinc-850 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2.5 cursor-pointer shadow-md group"
              >
                <div className="h-6 w-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Play className="h-3.5 w-3.5 fill-indigo-400" />
                </div>
                <span>Xem Demo Render & Thuyết Minh</span>
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

      {/* FEATURED DEMO VIDEO SHOWCASE SECTION */}
      <section className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 my-6">
        <div 
          onClick={() => setShowVideoModal(true)}
          className="relative rounded-3xl overflow-hidden border border-indigo-500/30 bg-zinc-950 shadow-2xl shadow-indigo-950/50 group cursor-pointer"
        >
          <img 
            src="https://img.youtube.com/vi/U2WiOdjRMkU/maxresdefault.jpg" 
            onError={(e) => { e.target.onerror = null; e.target.src = "https://img.youtube.com/vi/U2WiOdjRMkU/hqdefault.jpg"; }}
            alt="Demo Editnhanh Video" 
            className="w-full h-[280px] sm:h-[380px] object-cover opacity-60 group-hover:opacity-75 transition-all duration-500 group-hover:scale-[1.01]" 
          />
          
          <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent"></div>

          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
            <div className="h-16 w-16 sm:h-20 sm:w-20 rounded-full bg-indigo-600/90 text-white flex items-center justify-center shadow-2xl shadow-indigo-500/50 group-hover:scale-110 group-hover:bg-indigo-500 transition-all duration-300 border-4 border-indigo-400/40">
              <Play className="h-8 w-8 sm:h-9 sm:w-9 fill-white ml-1" />
            </div>
            <div className="mt-4 space-y-1">
              <span className="px-3 py-1 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[11px] font-semibold uppercase tracking-wider">
                Video Demo Thực Tế
              </span>
              <h3 className="text-lg sm:text-2xl font-bold text-white font-display pt-1">
                Demo Render Phụ Đề & Thuyết Minh AI
              </h3>
              <p className="text-xs text-zinc-400">Bấm để xem video thực tế cách phần mềm vận hành</p>
            </div>
          </div>
        </div>
      </section>

      {/* STATS BAR SECTION */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-sm p-6 sm:p-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 text-center divide-y sm:divide-y-0 lg:divide-x divide-zinc-800/60">
            <div className="space-y-1.5 p-2">
              <div className="text-3xl sm:text-4xl font-black text-white font-display flex items-center justify-center gap-0.5">
                <span>1.500</span><span className="text-indigo-400">+</span>
              </div>
              <p className="text-xs text-zinc-400 font-medium">Creator & Shop Tin Dùng</p>
            </div>
            <div className="space-y-1.5 p-2 pt-4 sm:pt-2">
              <div className="text-3xl sm:text-4xl font-black text-white font-display flex items-center justify-center gap-0.5">
                <span>2.5M</span><span className="text-purple-400">+</span>
              </div>
              <p className="text-xs text-zinc-400 font-medium">Video Render Thành Công</p>
            </div>
            <div className="space-y-1.5 p-2 pt-4 sm:pt-2">
              <div className="text-3xl sm:text-4xl font-black text-white font-display flex items-center justify-center gap-0.5">
                <span>99.8</span><span className="text-pink-400">%</span>
              </div>
              <p className="text-xs text-zinc-400 font-medium">Chính Xác Smart-Voice AI</p>
            </div>
            <div className="space-y-1.5 p-2 pt-4 sm:pt-2">
              <div className="text-3xl sm:text-4xl font-black text-white font-display flex items-center justify-center gap-0.5">
                <span>30</span><span className="text-emerald-400">Giây</span>
              </div>
              <p className="text-xs text-zinc-400 font-medium">Cấp Key Tự Động 24/7</p>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 2: SYSTEM CAPABILITIES (GIỚI THIỆU TOÀN BỘ CÔNG CỤ VỚI ẢNH MINH HỌA) */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
          <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">Hệ Sinh Thái Editnhanh</span>
          <h2 className="text-3xl sm:text-4xl font-bold font-display text-white">5 Tính Năng Giúp Xây Kênh Kiếm Tiền</h2>
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
              <div 
                onClick={() => setZoomImage({ src: downloaderImg, title: 'Tải Video Đa Nền Tảng' })}
                className="relative group cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 shadow-2xl hover:border-indigo-500/50 transition-all duration-300"
              >
                <img src={downloaderImg} alt="Cross-platform Downloader Screen" className="w-full h-auto group-hover:scale-[1.02] transition-transform duration-500" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-2 text-white text-xs font-semibold backdrop-blur-[2px]">
                  <ZoomIn className="h-4 w-4 text-indigo-400 animate-pulse" />
                  <span>Nhấn vào để phóng to xem rõ</span>
                </div>
              </div>
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
              <div 
                onClick={() => setZoomImage({ src: studioImg, title: 'Studio Biên Tập Render' })}
                className="relative group cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 shadow-2xl hover:border-purple-500/50 transition-all duration-300"
              >
                <img src={studioImg} alt="Studio Render Workspace" className="w-full h-auto group-hover:scale-[1.02] transition-transform duration-500" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-2 text-white text-xs font-semibold backdrop-blur-[2px]">
                  <ZoomIn className="h-4 w-4 text-purple-400 animate-pulse" />
                  <span>Nhấn vào để phóng to xem rõ</span>
                </div>
              </div>
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
              <div 
                onClick={() => setZoomImage({ src: bamcanhImg, title: 'Băm Cảnh Tự Động' })}
                className="relative group cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 shadow-2xl hover:border-orange-500/50 transition-all duration-300"
              >
                <img src={bamcanhImg} alt="Băm cảnh tự động" className="w-full h-auto group-hover:scale-[1.02] transition-transform duration-500" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-2 text-white text-xs font-semibold backdrop-blur-[2px]">
                  <ZoomIn className="h-4 w-4 text-orange-400 animate-pulse" />
                  <span>Nhấn vào để phóng to xem rõ</span>
                </div>
              </div>
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
              <div 
                onClick={() => setZoomImage({ src: libraryImg, title: 'Quản Lý Giọng & Nhạc Nền' })}
                className="relative group cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 shadow-2xl hover:border-cyan-500/50 transition-all duration-300"
              >
                <img src={libraryImg} alt="Quản lý giọng và nhạc nền" className="w-full h-auto group-hover:scale-[1.02] transition-transform duration-500" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-2 text-white text-xs font-semibold backdrop-blur-[2px]">
                  <ZoomIn className="h-4 w-4 text-cyan-400 animate-pulse" />
                  <span>Nhấn vào để phóng to xem rõ</span>
                </div>
              </div>
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
              <div 
                onClick={() => setZoomImage({ src: managepageImg, title: 'Quản Lý Đăng Video Facebook Page' })}
                className="relative group cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 shadow-2xl hover:border-blue-500/50 transition-all duration-300"
              >
                <img src={managepageImg} alt="Quản lý đăng video Facebook Page" className="w-full h-auto group-hover:scale-[1.02] transition-transform duration-500" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-2 text-white text-xs font-semibold backdrop-blur-[2px]">
                  <ZoomIn className="h-4 w-4 text-blue-400 animate-pulse" />
                  <span>Nhấn vào để phóng to xem rõ</span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* TESTIMONIALS SECTION (ĐÁNH GIÁ TỪ KHÁCH HÀNG) */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center max-w-3xl mx-auto mb-12 space-y-3">
          <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">Đánh Giá Từ Khách Hàng</span>
          <h2 className="text-3xl font-bold font-display text-white">Hơn 1.500+ Creator Nói Gì Về Editnhanh?</h2>
          <p className="text-zinc-400 text-sm">Trải nghiệm thực tế từ các nhà sáng tạo nội dung, chủ shop online và agency xây kênh.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 space-y-4 hover:border-indigo-500/40 transition-all flex flex-col justify-between shadow-xl">
            <div className="space-y-3">
              <div className="flex items-center gap-1 text-amber-400">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="h-4 w-4 fill-amber-400" />
                ))}
              </div>
              <p className="text-xs sm:text-sm text-zinc-300 italic leading-relaxed">
                "Tính năng băm cảnh tự động và sinh phụ đề AI cứu cánh cho kênh Reels của mình. Trước đây edit 1 video mất cả tiếng, giờ 10 phút băm được cả chuỗi clip ngắn!"
              </p>
            </div>
            <div className="flex items-center gap-3 pt-3 border-t border-zinc-800/60">
              <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white text-sm">
                N
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">Nguyễn Văn Nam</h4>
                <p className="text-[11px] text-zinc-400">TikTok Creator (380k followers)</p>
              </div>
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 space-y-4 hover:border-purple-500/40 transition-all flex flex-col justify-between shadow-xl">
            <div className="space-y-3">
              <div className="flex items-center gap-1 text-amber-400">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="h-4 w-4 fill-amber-400" />
                ))}
              </div>
              <p className="text-xs sm:text-sm text-zinc-300 italic leading-relaxed">
                "Giọng đọc AI lồng tiếng rất tự nhiên, biểu cảm không bị đơ như các tool khác. Quan trọng là chạy offline mượt mà không lo tốn chi phí API dịch."
              </p>
            </div>
            <div className="flex items-center gap-3 pt-3 border-t border-zinc-800/60">
              <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-purple-500 to-pink-600 flex items-center justify-center font-bold text-white text-sm">
                T
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">Trần Thu Thảo</h4>
                <p className="text-[11px] text-zinc-400">Chủ Shop Thời Trang Online</p>
              </div>
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 space-y-4 hover:border-emerald-500/40 transition-all flex flex-col justify-between shadow-xl">
            <div className="space-y-3">
              <div className="flex items-center gap-1 text-amber-400">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="h-4 w-4 fill-amber-400" />
                ))}
              </div>
              <p className="text-xs sm:text-sm text-zinc-300 italic leading-relaxed">
                "Đăng hàng loạt video lên nhiều Page Facebook cùng lúc cực tiện. Thanh toán xong nhận key tự động sau 30 giây rất uy tín!"
              </p>
            </div>
            <div className="flex items-center gap-3 pt-3 border-t border-zinc-800/60">
              <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-600 flex items-center justify-center font-bold text-white text-sm">
                H
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">Lê Hoàng Anh</h4>
                <p className="text-[11px] text-zinc-400">Quản lý Hệ Thống Fanpage</p>
              </div>
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
              <h4 className="text-lg font-bold text-white">Biên Tập & Render</h4>
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

      {/* FAQ ACCORDION SECTION (GIẢI ĐÁP THẮC MẮC) */}
      <section className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-16 border-t border-zinc-900">
        <div className="text-center mb-12 space-y-3">
          <span className="text-xs font-bold text-purple-400 uppercase tracking-widest">Giải Đáp Thắc Mắc</span>
          <h2 className="text-3xl font-bold font-display text-white">Câu Hỏi Thường Gặp (FAQ)</h2>
          <p className="text-zinc-400 text-sm">Mọi thông tin bạn cần biết trước khi sở hữu bản quyền phần mềm Editnhanh.</p>
        </div>

        <div className="space-y-3">
          {faqs.map((faq, index) => {
            const isOpen = openFaq === index;
            return (
              <div 
                key={index} 
                className="rounded-xl bg-zinc-900/50 border border-zinc-800/80 overflow-hidden transition-all shadow-md"
              >
                <button
                  onClick={() => setOpenFaq(isOpen ? null : index)}
                  className="w-full px-5 py-4 text-left flex items-center justify-between gap-4 text-sm font-semibold text-zinc-200 hover:text-white hover:bg-zinc-800/40 transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-2.5">
                    <HelpCircle className="h-4 w-4 text-indigo-400 flex-shrink-0" />
                    <span>{faq.q}</span>
                  </span>
                  <ChevronDown className={`h-4 w-4 text-zinc-400 transition-transform duration-300 flex-shrink-0 ${isOpen ? 'rotate-180 text-indigo-400' : ''}`} />
                </button>
                {isOpen && (
                  <div className="px-5 pb-4 pt-2 text-xs text-zinc-400 leading-relaxed border-t border-zinc-800/40 bg-zinc-950/40 animate-in fade-in duration-200">
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* LIGHTBOX MODAL PHÓNG TO HÌNH ẢNH */}
      {zoomImage && (
        <div 
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 md:p-8 animate-in fade-in duration-200"
          onClick={() => setZoomImage(null)}
        >
          <div 
            className="relative max-w-6xl w-full max-h-[92vh] flex flex-col bg-zinc-900 border border-zinc-700/70 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-950/80">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
                <ZoomIn className="h-4 w-4 text-indigo-400" />
                <span>{zoomImage.title}</span>
              </div>
              <button 
                onClick={() => setZoomImage(null)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Đóng (Esc)"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Image Body */}
            <div className="flex-1 overflow-auto p-2 sm:p-4 bg-zinc-950/50 flex items-center justify-center">
              <img 
                src={zoomImage.src} 
                alt={zoomImage.title} 
                className="max-w-full max-h-[80vh] w-auto h-auto object-contain rounded-lg shadow-2xl border border-zinc-800/80" 
              />
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-2 border-t border-zinc-800/60 bg-zinc-950/60 text-center text-xs text-zinc-400">
              <span>Nhấn phím <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[11px]">Esc</kbd> hoặc nhấp ra ngoài để đóng</span>
            </div>
          </div>
        </div>
      )}

      {/* DEMO VIDEO LIGHTBOX MODAL */}
      {showVideoModal && (
        <div 
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 md:p-8 animate-in fade-in duration-200"
          onClick={() => setShowVideoModal(false)}
        >
          <div 
            className="relative max-w-5xl w-full flex flex-col bg-zinc-900 border border-zinc-700/80 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-950/90">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
                <Play className="h-4 w-4 text-indigo-400 fill-indigo-400" />
                <span>Video Demo Render Phụ Đề & Thuyết Minh AI</span>
              </div>
              <button 
                onClick={() => setShowVideoModal(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Đóng (Esc)"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Video Player Container */}
            <div className="relative w-full aspect-video bg-black flex items-center justify-center overflow-hidden">
              {videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be') ? (
                <iframe 
                  src={videoUrl}
                  title="Editnhanh Demo Video"
                  className="w-full h-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                ></iframe>
              ) : (
                <video 
                  src={videoUrl} 
                  controls 
                  autoPlay 
                  className="w-full h-full object-contain"
                >
                  Trình duyệt của bạn không hỗ trợ thẻ video.
                </video>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-2.5 border-t border-zinc-800/80 bg-zinc-950/80 flex items-center justify-between text-xs text-zinc-400">
              <span>Bấm phím <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[11px]">Esc</kbd> hoặc nhấp ra ngoài để đóng</span>
              <button 
                onClick={handleDownloadClick}
                className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-lg transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Tải phần mềm ngay</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STICKY CTA BAR (Bottom fixed bar when scrolling) */}
      {showStickyCta && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-zinc-950/90 border-t border-zinc-800/80 backdrop-blur-lg px-4 py-3 shadow-2xl animate-in slide-in-from-bottom duration-300">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <div>
                <p className="text-xs font-bold text-white">Editnhanh v{appVersion || '1.0.6'} - Tự động hóa sản xuất Video AI</p>
                <p className="text-[11px] text-zinc-400">Dùng thử 7 ngày miễn phí 100% tính năng • Cấp key tự động 30s</p>
              </div>
            </div>
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <button
                onClick={handleDownloadClick}
                className="flex-1 sm:flex-none px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Tải dùng thử (0đ)</span>
              </button>
              <a
                href="#pricing"
                className="flex-1 sm:flex-none px-4 py-2 border border-zinc-700 hover:bg-zinc-800 text-zinc-200 font-semibold text-xs rounded-lg transition-all text-center"
              >
                Xem giá (299k)
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
