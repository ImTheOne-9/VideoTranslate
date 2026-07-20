import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  BookOpen, ArrowLeft, UserPlus, LogIn, CreditCard, Download, Key, 
  Video, Play, Cpu, Layers, Scissors, Mic2, Facebook, AlertTriangle, 
  HelpCircle, CheckCircle, Zap, Shield, Sparkles, Music, Settings
} from 'lucide-react';

export default function Guide() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState('getting-started');
  const [contact, setContact] = useState({ email: 'support@editnhanh.com', zalo: '', telegram: '' });
  const [emailCopied, setEmailCopied] = useState(false);

  const handleEmailClick = (e) => {
    e.preventDefault();
    const email = contact.email || 'support@editnhanh.com';
    navigator.clipboard.writeText(email).then(() => {
      setEmailCopied(true);
      setTimeout(() => setEmailCopied(false), 3000);
    }).catch(() => {});
    // Mở mailto làm dự phòng
    window.location.href = `mailto:${email}`;
  };

  useEffect(() => {
    // Cho phép chuyển tab nhanh bằng query param: ?tab=xxx
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab) {
      setActiveTab(tab);
    }

    // Tải cấu hình liên hệ từ backend
    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        if (data.contact) {
          setContact(data.contact);
        }
      })
      .catch(err => console.warn('Lỗi tải cấu hình liên hệ:', err));
  }, [location]);

  const tabs = [
    { id: 'getting-started', label: 'Khởi động nhanh', icon: BookOpen },
    { id: 'account-license', label: 'Tài khoản & Bản quyền', icon: Key },
    { id: 'download-install', label: 'Tải & Cài đặt', icon: Download },
    { id: 'features-guide', label: '5 Phân hệ Tính năng', icon: Layers },
    { id: 'troubleshooting', label: 'Khắc phục lỗi & FAQs', icon: HelpCircle },
  ];

  return (
    <div className="flex-1 min-h-[85vh] py-12 px-4 sm:px-6 lg:px-8 relative bg-zinc-950 text-zinc-100">
      {/* Background neon glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 left-1/3 w-[450px] h-[450px] bg-purple-500/5 rounded-full blur-[100px] pointer-events-none"></div>

      <div className="w-full max-w-6xl mx-auto relative z-10 space-y-10">
        
        {/* Back button */}
        <div className="flex justify-start">
          <button 
            onClick={() => navigate('/')} 
            className="px-4 py-2 rounded-lg bg-zinc-900 border border-zinc-900 text-xs font-semibold text-zinc-200 hover:text-white hover:bg-zinc-800 transition-all flex items-center gap-1.5 cursor-pointer shadow-md"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Quay lại trang chủ</span>
          </button>
        </div>

        {/* Hero title */}
        <div className="text-center space-y-4 max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-900 border border-zinc-900 text-xs font-semibold text-indigo-400">
            <Sparkles className="h-4 w-4 text-indigo-400" />
            <span>Tài liệu hướng dẫn sử dụng</span>
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold font-display leading-tight text-white">
            Trung tâm hỗ trợ <span className="text-gradient">Editnhanh AI</span>
          </h1>
          <p className="text-sm sm:text-base text-zinc-350 leading-relaxed pt-2">
            Hướng dẫn đầy đủ từ các bước tạo tài khoản, đăng ký bản quyền, cài đặt cho đến hướng dẫn chi tiết cách vận hành các công cụ lồng tiếng & biên tập video.
          </p>
        </div>

        {/* Layout Grid */}
        <div className="flex flex-col lg:flex-row gap-8 items-start pt-4">
          
          {/* Left Sidebar Navigation (Desktop) & Select Dropdown (Mobile) */}
          <div className="w-full lg:w-64 shrink-0 space-y-2">
            {/* Mobile Dropdown Select */}
            <div className="block lg:hidden w-full">
              <label className="text-xs font-semibold text-zinc-400 mb-1.5 block">Chọn mục hướng dẫn</label>
              <select 
                value={activeTab} 
                onChange={(e) => setActiveTab(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-900 rounded-xl px-4 py-3 text-sm font-semibold text-white focus:outline-none focus:border-indigo-500/80"
              >
                {tabs.map((tab) => (
                  <option key={tab.id} value={tab.id}>{tab.label}</option>
                ))}
              </select>
            </div>

            {/* Desktop Sidebar Buttons */}
            <div className="hidden lg:flex flex-col gap-1.5 p-2 rounded-2xl bg-zinc-900/60 border border-zinc-900">
              <p className="px-3 py-2 text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Danh mục tài liệu</p>
              {tabs.map((tab) => {
                const IconComponent = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full text-left px-3.5 py-3.5 text-xs font-semibold rounded-xl flex items-center gap-3 transition-all cursor-pointer ${
                      isActive 
                        ? 'bg-gradient-to-r from-indigo-500/20 to-purple-500/20 text-white border-l-4 border-indigo-500 bg-zinc-800 shadow-inner' 
                        : 'text-zinc-300 hover:text-white hover:bg-zinc-800/40'
                    }`}
                  >
                    <IconComponent className={`h-4.5 w-4.5 ${isActive ? 'text-indigo-400' : 'text-zinc-400'}`} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Main Content Panel */}
          <div className="flex-1 w-full min-h-[60vh] bg-zinc-900/80 p-6 sm:p-8 rounded-2xl border border-zinc-900 relative overflow-hidden shadow-2xl">
            
            {/* 1. GETTING STARTED */}
            {activeTab === 'getting-started' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-zinc-800 pb-4">
                  <h2 className="text-2xl font-bold text-white font-display flex items-center gap-2.5">
                    <BookOpen className="h-6 w-6 text-indigo-400" />
                    <span>Khởi động nhanh trong 4 bước</span>
                  </h2>
                  <p className="text-xs text-zinc-350 mt-1">Các bước cơ bản để bắt đầu làm quen với Editnhanh</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                  {/* Step 1 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/80 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                        <UserPlus className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-zinc-400">Bước 1</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Đăng ký tài khoản</h4>
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      Đăng ký miễn phí trên website của chúng tôi bằng Email và Số điện thoại để gia nhập hệ thống. Sau đó, nhấp vào link kích hoạt được gửi tự động qua email để xác thực.
                    </p>
                  </div>

                  {/* Step 2 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/80 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                        <CreditCard className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-purple-400">Bước 2</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Đăng ký gói & Nhận Key</h4>
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      Chọn gói dịch vụ phù hợp với nhu cầu (gói dùng thử miễn phí hoặc gói tháng/năm). Hệ thống sẽ tự động gửi mã <strong>License Key</strong> về Email của bạn, đồng thời cấp Key tương ứng ngay trên Dashboard.
                    </p>
                  </div>

                  {/* Step 3 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/80 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
                        <Download className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-cyan-400">Bước 3</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Tải xuống & Cài đặt</h4>
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      Nhấp nút tải xuống tại trang chủ để tải phần mềm Editnhanh cho Windows. Giải nén tệp tin ra máy tính và nhấp chạy file ứng dụng mà không cần cài đặt phức tạp.
                    </p>
                  </div>

                  {/* Step 4 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/80 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-pink-500/10 text-pink-400 flex items-center justify-center">
                        <Key className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-pink-400">Bước 4</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Kích hoạt & Lên clip</h4>
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      Dán License Key đã copy từ web vào phần mềm khi mở lên. Phần mềm sẽ kích hoạt bản quyền, tự động tải các model AI Offline về máy và bạn có thể bắt đầu sản xuất video ngay lập tức.
                    </p>
                  </div>
                </div>

                <div className="bg-gradient-to-r from-indigo-500/10 to-purple-500/10 p-5 rounded-xl border border-indigo-950/50 text-xs text-zinc-300 flex items-start gap-3 mt-4">
                  <Zap className="h-5 w-5 text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-white block mb-1">Mẹo nhỏ cho người mới bắt đầu:</span>
                    Để trải nghiệm tốt nhất các tính năng tự động hóa bằng AI, hãy đảm bảo máy tính của bạn có kết nối Internet ổn định trong lần khởi động đầu tiên để phần mềm tải xuống mô hình lồng tiếng và nhận diện phụ đề.
                  </div>
                </div>
              </div>
            )}

            {/* 2. ACCOUNT AND LICENSE */}
            {activeTab === 'account-license' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-zinc-800 pb-4">
                  <h2 className="text-2xl font-bold text-white font-display flex items-center gap-2.5">
                    <Key className="h-6 w-6 text-indigo-400" />
                    <span>Đăng ký tài khoản & Bản quyền</span>
                  </h2>
                  <p className="text-xs text-zinc-350 mt-1">Các bước để sở hữu tài khoản và License Key kích hoạt phần mềm</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                  {/* Step 1 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                        <UserPlus className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-zinc-400">Bước 1</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Tạo tài khoản</h4>
                    <ul className="list-disc pl-4 text-xs text-zinc-300 space-y-1.5 leading-relaxed">
                      <li>Bấm <strong>Đăng ký dùng thử</strong> ở góc phải trang chủ.</li>
                      <li>Điền các thông tin: Họ tên, Email, Số điện thoại, Mật khẩu.</li>
                      <li>Nhấp liên kết xác nhận trong hộp thư Email để kích hoạt tài khoản.</li>
                    </ul>
                  </div>

                  {/* Step 2 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                        <CreditCard className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-purple-400">Bước 2</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Đăng ký gói dịch vụ</h4>
                    <ul className="list-disc pl-4 text-xs text-zinc-300 space-y-1.5 leading-relaxed">
                      <li>Đăng nhập và truy cập trang <strong>Bảng giá</strong>.</li>
                      <li><strong>Gói Dùng Thử</strong>: Miễn phí 7 ngày.</li>
                      <li><strong>Gói Pro (Tháng/Năm)</strong>: Bản quyền Pro lâu dài, không giới hạn tính năng.</li>
                    </ul>
                  </div>

                  {/* Step 3 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center">
                        <AlertTriangle className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-amber-400">Bước 3</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Thanh toán & Duyệt tự động</h4>
                    <ul className="list-disc pl-4 text-xs text-zinc-300 space-y-1.5 leading-relaxed">
                      <li>Quét mã thanh toán <strong>VietQR tự động</strong> trên màn hình hóa đơn.</li>
                      <li><span className="text-amber-400 font-semibold">Lưu ý:</span> Nhập <strong>chính xác 100% nội dung chuyển khoản (Memo)</strong>.</li>
                      <li>Key bản quyền được kích hoạt tự động sau 30 giây đối soát.</li>
                    </ul>
                  </div>

                  {/* Step 4 */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-pink-500/10 text-pink-400 flex items-center justify-center">
                        <Key className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-pink-400">Bước 4</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Lấy License Key</h4>
                    <ul className="list-disc pl-4 text-xs text-zinc-300 space-y-1.5 leading-relaxed">
                      <li>Hệ thống gửi mã Key tự động về <strong>Email đăng ký</strong> của bạn.</li>
                      <li>Hoặc bạn có thể truy cập mục <strong>Dashboard</strong> trên web để sao chép Key.</li>
                      <li>Dùng License Key để kích hoạt khi mở phần mềm trên máy tính.</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* 3. DOWNLOAD AND INSTALL */}
            {activeTab === 'download-install' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-zinc-800 pb-4">
                  <h2 className="text-2xl font-bold text-white font-display flex items-center gap-2.5">
                    <Download className="h-6 w-6 text-indigo-400" />
                    <span>Tải xuống & Thiết lập phần cứng</span>
                  </h2>
                  <p className="text-xs text-zinc-350 mt-1">Hướng dẫn cài đặt ứng dụng và yêu cầu phần cứng thiết bị</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                  {/* Card 1: Quy trình cài đặt */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                        <Download className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-zinc-400">Các bước cài đặt</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Tải & Khởi chạy ứng dụng</h4>
                    <ul className="list-decimal pl-4 text-xs text-zinc-300 space-y-2 leading-relaxed">
                      <li>Tải file cài đặt chính thức tại Trang chủ (nút <strong>Tải xuống cho Windows</strong>).</li>
                      <li>Nhấp đúp chuột vào file cài đặt <code>.exe</code> vừa tải về để tiến hành cài đặt phần mềm lên máy tính.</li>
                      <li>Khởi chạy ứng dụng <strong>Video Studio Tools</strong> từ màn hình Desktop hoặc menu Start.</li>
                      <li>Dán mã <strong>License Key</strong> để xác thực bản quyền và bắt đầu.</li>
                    </ul>
                  </div>

                  {/* Card 2: Tải Mô hình AI */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                        <Cpu className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-purple-400">Khởi chạy lần đầu</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-2 font-display">Tải xuống tài nguyên AI Offline</h4>
                    <p className="text-xs text-zinc-300 leading-relaxed mb-3">
                      Trong lần khởi chạy đầu tiên, phần mềm cần tải các mô hình trí tuệ nhân tạo với dung lượng khoảng <strong>2.5 GB</strong> về máy tính.
                    </p>
                    <div className="bg-zinc-900/50 p-3 rounded-lg border border-zinc-900/40 text-[11px] text-zinc-450">
                      <span className="text-amber-500 font-semibold">⚠️ Chú ý:</span> Vui lòng giữ kết nối Internet ổn định và <strong>không đóng phần mềm</strong> cho đến khi tiến trình tải hoàn tất 100%.
                    </div>
                  </div>

                  {/* Card 3: Cấu hình phần cứng (Col span 2) */}
                  <div className="p-6 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200 md:col-span-2">
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-9 w-9 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
                        <Settings className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold bg-zinc-900 px-2.5 py-1 rounded-full text-cyan-400">Yêu cầu hệ thống</span>
                    </div>
                    <h4 className="text-sm font-bold text-white mb-4 font-display">Thiết lập cấu hình thiết bị</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs text-zinc-300">
                      <div className="space-y-2 p-4 bg-zinc-900/40 rounded-lg border border-zinc-900/60">
                        <span className="font-bold text-white block border-b border-zinc-800 pb-1.5 mb-2">Cấu hình tối thiểu:</span>
                        <ul className="list-disc pl-4 space-y-1">
                          <li><strong>OS:</strong> Windows 10/11 64-bit</li>
                          <li><strong>CPU:</strong> Intel Core i3 / AMD Ryzen 3 trở lên</li>
                          <li><strong>RAM:</strong> Tối thiểu 8 GB</li>
                          <li><strong>GPU:</strong> Card đồ họa tích hợp có hỗ trợ Vulkan</li>
                          <li><strong>Disk:</strong> Ổ cứng trống 5 GB (SSD)</li>
                        </ul>
                      </div>
                      <div className="space-y-2 p-4 bg-zinc-900/40 rounded-lg border border-zinc-900/60">
                        <span className="font-bold text-indigo-400 block border-b border-zinc-800 pb-1.5 mb-2">Cấu hình đề xuất (Tối ưu AI):</span>
                        <ul className="list-disc pl-4 space-y-1">
                          <li><strong>OS:</strong> Windows 10/11 64-bit</li>
                          <li><strong>CPU:</strong> Intel Core i5 / i7 hoặc Ryzen 5 / 7 trở lên</li>
                          <li><strong>RAM:</strong> 16 GB trở lên</li>
                          <li><strong>GPU:</strong> Card đồ họa rời (NVIDIA, AMD, Intel) có hỗ trợ <strong>Vulkan</strong> tốt</li>
                          <li><strong>Tăng tốc:</strong> Chạy <strong>Vulkan</strong> để lồng tiếng AI (OmniVoice) và dùng <strong>CUDA/NVENC</strong> (trên card NVIDIA) để render video siêu tốc</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 4. FEATURES GUIDE */}
            {activeTab === 'features-guide' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-zinc-800 pb-4">
                  <h2 className="text-2xl font-bold text-white font-display flex items-center gap-2.5">
                    <Layers className="h-6 w-6 text-indigo-400" />
                    <span>Hướng dẫn sử dụng 5 Phân hệ Tính năng</span>
                  </h2>
                  <p className="text-xs text-zinc-350 mt-1">Cách vận hành các công cụ tích hợp trong phần mềm</p>
                </div>

                <div className="flex flex-col gap-5 pt-2">
                  {/* Module 1: Tải Video */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-8.5 w-8.5 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
                        <Download className="h-4.5 w-4.5" />
                      </div>
                      <h3 className="text-sm font-bold text-white font-display">1. Tải Video Đa Nền Tảng</h3>
                    </div>
                    <ul className="list-disc pl-4 text-xs text-zinc-350 space-y-1 leading-relaxed mb-3">
                      <li>Tải video lẻ hoặc hàng loạt danh sách phát/toàn bộ Kênh video của đối thủ.</li>
                      <li>Tải video sạch, không dính logo/watermark của các nền tảng (đặc biệt là TikTok, Douyin).</li>
                    </ul>
                    <div className="flex flex-wrap gap-2.5 pt-1.5">
                      {/* YouTube */}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 text-[11px] font-semibold">
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                          <path d="M23.498 6.163c-.272-1.016-1.07-1.815-2.085-2.087C19.578 3.5 12 3.5 12 3.5s-7.578 0-9.413.576C1.573 4.348.775 5.147.503 6.163 0 8.008 0 12 0 12s0 3.992.503 5.837c.272 1.016 1.07 1.815 2.085 2.087 1.835.576 9.413.576 9.413.576s7.578 0 9.413-.576c1.015-.272 1.813-1.071 2.085-2.087.502-1.845.502-5.837.502-5.837s0-3.992-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                        </svg>
                        <span>YouTube</span>
                      </span>

                      {/* TikTok */}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-zinc-900 text-zinc-100 border border-zinc-800 text-[11px] font-semibold">
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                          <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.17-2.86-.74-3.97-1.74-1.07-1.03-1.63-2.52-1.78-4.01V15.5c0 1.93-.65 3.86-1.91 5.17-1.57 1.69-4.09 2.51-6.31 2.03-2.31-.46-4.32-2.17-4.99-4.43-.88-2.88.22-6.22 2.72-7.69.9-.53 1.93-.8 2.97-.8v4.03c-.66.01-1.32.17-1.91.49-1.08.57-1.7 1.81-1.5 3.02.16 1.06 1 1.96 2.05 2.11 1.25.17 2.5-.54 2.92-1.68.22-.57.29-1.2.28-1.81V.02z"/>
                        </svg>
                        <span>TikTok</span>
                      </span>

                      {/* Douyin */}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-pink-500/10 text-pink-400 border border-pink-500/20 text-[11px] font-semibold">
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                          <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.17-2.86-.74-3.97-1.74-1.07-1.03-1.63-2.52-1.78-4.01V15.5c0 1.93-.65 3.86-1.91 5.17-1.57 1.69-4.09 2.51-6.31 2.03-2.31-.46-4.32-2.17-4.99-4.43-.88-2.88.22-6.22 2.72-7.69.9-.53 1.93-.8 2.97-.8v4.03c-.66.01-1.32.17-1.91.49-1.08.57-1.7 1.81-1.5 3.02.16 1.06 1 1.96 2.05 2.11 1.25.17 2.5-.54 2.92-1.68.22-.57.29-1.2.28-1.81V.02z"/>
                        </svg>
                        <span>Douyin</span>
                      </span>

                      {/* Facebook */}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-600/10 text-blue-400 border border-blue-500/20 text-[11px] font-semibold">
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                        </svg>
                        <span>Facebook</span>
                      </span>

                      {/* Instagram */}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-gradient-to-r from-purple-500/10 to-pink-500/10 text-pink-400 border border-pink-500/20 text-[11px] font-semibold">
                        <svg className="w-3.5 h-3.5 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
                          <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
                          <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
                          <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
                        </svg>
                        <span>Instagram</span>
                      </span>

                      {/* Xiaohongshu */}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-red-600/10 text-red-400 border border-red-500/20 text-[11px] font-semibold">
                        <svg className="w-3.5 h-3.5 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
                          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                        </svg>
                        <span>Xiaohongshu</span>
                      </span>
                    </div>
                  </div>

                  {/* Module 2: Studio Biên Tập */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-8.5 w-8.5 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                        <Video className="h-4.5 w-4.5" />
                      </div>
                      <h3 className="text-sm font-bold text-white font-display">2. Studio Biên Tập & Lồng Tiếng AI</h3>
                    </div>
                    <ul className="list-disc pl-4 text-xs text-zinc-350 space-y-1.5 leading-relaxed">
                      <li><strong>Tạo nhạc & giọng sạch:</strong> Tách nhạc nền & giọng nói bằng mô hình AI.</li>
                      <li><strong>Nhận diện phụ đề:</strong> Quét chữ trực tiếp trên khung hình video hoặc dịch giọng nói thành văn bản offline (Whisper AI).</li>
                      <li><strong>Dịch thuật thông minh:</strong> Chuyển ngữ chuẩn ngữ cảnh Tiếng Việt qua mô hình AI.</li>
                      <li><strong>Lồng tiếng AI:</strong> Thuyết minh biểu cảm. Tự động tăng tốc độ đọc để vừa khớp khung hình.</li>
                      <li><strong>Render hoàn chỉnh:</strong> Trộn nhạc nền gốc, chèn sub nghệ thuật, mờ viền Shorts, xuất video bằng tăng tốc GPU.</li>
                    </ul>
                  </div>

                  {/* Module 3: Băm Cảnh */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-8.5 w-8.5 rounded-lg bg-orange-500/10 text-orange-400 flex items-center justify-center">
                        <Scissors className="h-4.5 w-4.5" />
                      </div>
                      <h3 className="text-sm font-bold text-white font-display">3. Băm Cảnh Tự Động (Scene Splitter)</h3>
                    </div>
                    <ul className="list-disc pl-4 text-xs text-zinc-350 space-y-1 leading-relaxed">
                      <li>Tự động quét phân cảnh và cắt video dài thành nhiều clip ngắn (15s - 60s) theo phân cảnh hợp lý.</li>
                      <li>Hỗ trợ thiết lập xuất nhanh định dạng dọc chuẩn kích thước <strong>9:16</strong> (TikTok, Shorts, Reels).</li>
                    </ul>
                  </div>

                  {/* Module 4: Clone Giọng */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-8.5 w-8.5 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
                        <Mic2 className="h-4.5 w-4.5" />
                      </div>
                      <h3 className="text-sm font-bold text-white font-display">4. Clone Giọng Nói & Thư Viện Nhạc Nền</h3>
                    </div>
                    <ul className="list-disc pl-4 text-xs text-zinc-350 space-y-1 leading-relaxed">
                      <li><strong>Nhân bản giọng nói AI:</strong> Upload file ghi âm mẫu 15 giây để clone giọng đọc lồng tiếng bất kỳ ai.</li>
                      <li><strong>Quản lý nhạc:</strong> Nhập kho nhạc nền yêu thích của bạn để tự động trộn ngẫu nhiên khi render video.</li>
                    </ul>
                  </div>

                  {/* Module 5: Auto Post */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 relative overflow-hidden group hover:border-zinc-800/85 hover:bg-zinc-950/80 transition-all duration-200">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-8.5 w-8.5 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center">
                        <Facebook className="h-4.5 w-4.5" />
                      </div>
                      <h3 className="text-sm font-bold text-white font-display">5. Đăng Video Fanpage Hàng Loạt</h3>
                    </div>
                    <ul className="list-disc pl-4 text-xs text-zinc-350 space-y-1 leading-relaxed">
                      <li>Kết nối và quản lý danh sách nhiều Fanpage vệ tinh thông qua Facebook Access Token.</li>
                      <li>Thiết lập nội dung mô tả, tiêu đề và lên lịch đăng tải video tự động hàng loạt cùng lúc cho hệ thống.</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* 5. TROUBLESHOOTING */}
            {activeTab === 'troubleshooting' && (
              <div className="space-y-6 animate-fadeIn">
                <div className="border-b border-zinc-800 pb-4">
                  <h2 className="text-2xl font-bold text-white font-display flex items-center gap-2.5">
                    <HelpCircle className="h-6 w-6 text-indigo-400" />
                    <span>Giải đáp Thắc mắc & Sửa lỗi</span>
                  </h2>
                  <p className="text-xs text-zinc-350 mt-1">Các vấn đề thường gặp và hướng xử lý nhanh</p>
                </div>

                <div className="flex flex-col gap-4 pt-2">
                  {/* FAQ 1 */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 space-y-2">
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                      <span>Tại sao câu lồng tiếng đầu tiên chạy rất lâu (20 - 30 giây)?</span>
                    </h4>
                    <div className="text-xs text-zinc-300 pl-3.5 space-y-1">
                      <p>• <strong>Nguyên nhân:</strong> Card đồ họa tiến hành biên dịch Shader cho mô hình AI Vulkan lần đầu.</p>
                      <p>• <strong>Khắc phục:</strong> Đây là hiện tượng bình thường. Từ câu thứ 2 trở đi tốc độ sinh giọng sẽ rất nhanh (chỉ mất vài giây).</p>
                    </div>
                  </div>

                  {/* FAQ 2 */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 space-y-2">
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                      <span>Lỗi crash ứng dụng hoặc báo lỗi GPU Vulkan?</span>
                    </h4>
                    <div className="text-xs text-zinc-300 pl-3.5 space-y-1">
                      <p>• <strong>Nguyên nhân:</strong> Card onboard cũ (như Intel Iris Xe) driver lỗi thời, xung đột thư viện Vulkan.</p>
                      <p>• <strong>Khắc phục:</strong> Vào Cài đặt phần mềm, chuyển mục <strong>Thiết bị xử lý (Processing Device)</strong> sang <strong>CPU</strong>. Cập nhật driver GPU lên bản mới nhất.</p>
                    </div>
                  </div>

                  {/* FAQ 3 */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 space-y-2">
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                      <span>Tại sao video lồng tiếng ra giọng đọc bị nói nhanh?</span>
                    </h4>
                    <div className="text-xs text-zinc-300 pl-3.5 space-y-1">
                      <p>• <strong>Nguyên nhân:</strong> Tính năng tự đồng bộ (Auto Time Sync) tăng tốc giọng đọc để vừa khớp khung hình khi nội dung chữ dịch quá dài.</p>
                      <p>• <strong>Khắc phục:</strong> Rút ngắn bớt từ ngữ của câu dịch tại bảng chỉnh sửa phụ đề trước khi xuất video để giọng đọc bình thường, truyền cảm.</p>
                    </div>
                  </div>

                  {/* FAQ 4 */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 space-y-2">
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                      <span>Làm thế nào để tăng tốc độ lồng tiếng và render tối đa?</span>
                    </h4>
                    <div className="text-xs text-zinc-300 pl-3.5 space-y-1">
                      <p>• <strong>Khắc phục:</strong> Cài đặt driver <strong>NVIDIA CUDA Toolkit</strong> đầy đủ (đối với card NVIDIA) để chạy render video tăng tốc qua nhân GPU NVENC.</p>
                    </div>
                  </div>

                  {/* FAQ 5 */}
                  <div className="p-5 bg-zinc-950 rounded-xl border border-zinc-900/40 space-y-2">
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
                      <span>Lỗi License Key đã được kích hoạt trên thiết bị khác?</span>
                    </h4>
                    <div className="text-xs text-zinc-300 pl-3.5 space-y-1">
                      <p>• <strong>Nguyên nhân:</strong> Mỗi Key chỉ được dùng trên 1 máy duy nhất (lưu mã phần cứng HWID).</p>
                      <p>• <strong>Khắc phục:</strong> Liên hệ đội ngũ kỹ thuật qua Zalo/Telegram trên web để được reset lại HWID thiết bị.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>

        </div>

        {/* Support Section */}
        <div className="bg-zinc-900/60 p-6 rounded-2xl border border-zinc-900 flex flex-col md:flex-row items-center justify-between gap-6 shadow-md">
          <div className="space-y-2">
            <h3 className="text-lg font-bold text-white font-display flex items-center gap-2">
              <HelpCircle className="h-5 w-5 text-indigo-400" />
              <span>Cần thêm trợ giúp?</span>
            </h3>
            <p className="text-xs text-zinc-350 leading-relaxed max-w-xl">
              Nếu bạn gặp các sự cố khác hoặc cần tư vấn sâu hơn về các tính năng biên tập, hãy liên hệ trực tiếp với bộ phận chăm sóc khách hàng của Editnhanh.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto shrink-0">
            <div className="relative">
              <button 
                onClick={handleEmailClick} 
                className="px-4 py-2.5 rounded-xl border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900 text-xs font-semibold text-zinc-200 flex items-center justify-center gap-2 transition-all cursor-pointer w-full"
              >
                <span>{emailCopied ? 'Đã copy Email!' : 'Gửi Email hỗ trợ'}</span>
              </button>
              {emailCopied && (
                <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-zinc-800 text-[10px] text-zinc-200 px-2 py-1 rounded shadow-md border border-zinc-700 whitespace-nowrap animate-fadeIn">
                  Đã sao chép: {contact.email || 'support@editnhanh.com'}
                </span>
              )}
            </div>
            {contact.zalo && (
              <a 
                href={`https://zalo.me/${contact.zalo.replace(/[^0-9]/g, '')}`} 
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-xs font-bold text-white flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <span>Chat Zalo kỹ thuật ({contact.zalo})</span>
              </a>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
