import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation, Navigate, Link } from 'react-router-dom';
import { CheckCircle, AlertTriangle, Video, Mail, Phone, Shield, Globe } from 'lucide-react';
import Navbar from './components/Navbar';
import AuthModal from './components/AuthModal';
import Home from './pages/Home';
import Payment from './pages/Payment';
import VerifyEmail from './pages/VerifyEmail';
import ResetPassword from './pages/ResetPassword';
import Admin from './pages/Admin';
import DashboardPage from './pages/DashboardPage';
import Profile from './pages/Profile';
import Pricing from './pages/Pricing';
import About from './pages/About';

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdminRoute = location.pathname === '/admin' || location.pathname === '/admin.html';

  const [currentUser, setCurrentUser] = useState(null);
  const [isDevMode, setIsDevMode] = useState(false);
  const [appVersion, setAppVersion] = useState('1.0.6');
  const [contact, setContact] = useState({ email: 'support@editnhanh.com', zalo: '', telegram: '' });
  const [authModal, setAuthModal] = useState({ isOpen: false, mode: 'login' });
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    checkConfig();
    checkSession();
  }, []);

  useEffect(() => {
    if (location.hash) {
      const id = location.hash.replace('#', '');
      const element = document.getElementById(id);
      if (element) {
        setTimeout(() => {
          element.scrollIntoView({ behavior: 'smooth' });
        }, 150);
      }
    }
  }, [location]);

  const showToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const checkConfig = async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      setIsDevMode(data.isDev);
      if (data.version) {
        setAppVersion(data.version);
      }
      if (data.contact) {
        setContact(data.contact);
      }
    } catch (err) {
      console.warn('Lỗi kiểm tra cấu hình:', err.message);
    }
  };

  const checkSession = async () => {
    try {
      const res = await fetch('/api/auth/me');
      const isPrivateRoute = location.pathname.includes('/dashboard') || location.pathname.includes('/profile');

      if (res.status === 200) {
        const data = await res.json();
        if (data.success && data.user) {
          setCurrentUser(data.user);
          localStorage.setItem('vst_user', JSON.stringify(data.user));
          
          // Chuyển hướng thanh toán nếu có key đang chờ
          const pendingKey = localStorage.getItem('pending_payment_key');
          if (pendingKey) {
            navigate(`/payment.html?key=${pendingKey}`);
          }
        } else {
          localStorage.removeItem('vst_user');
          setCurrentUser(null);
          if (isPrivateRoute) {
            navigate('/');
            openAuthModal('login');
          }
        }
      } else {
        localStorage.removeItem('vst_user');
        setCurrentUser(null);
        
        if (isPrivateRoute) {
          navigate('/');
          openAuthModal('login');
        } else {
          // Mở login modal nếu có key chờ thanh toán
          const pendingKey = localStorage.getItem('pending_payment_key');
          if (pendingKey) {
            openAuthModal('login');
          }
        }
      }
    } catch (err) {
      localStorage.removeItem('vst_user');
      setCurrentUser(null);
    }
  };

  const handleLogout = async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Đã đăng xuất tài khoản!');
        setCurrentUser(null);
        localStorage.removeItem('vst_user');
        navigate('/');
      }
    } catch (err) {
      showToast('Lỗi đăng xuất: ' + err.message, 'error');
    }
  };

  const handleSubscribePlan = async (planType) => {
    if (!currentUser) {
      showToast('Vui lòng đăng nhập tài khoản để thực hiện chức năng này!', 'error');
      openAuthModal('login', planType);
      return;
    }

    try {
      const res = await fetch('/api/plans/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planType })
      });
      const data = await res.json();

      if (res.status === 401) {
        showToast('Phiên làm việc hết hạn. Vui lòng đăng nhập lại.', 'error');
        setCurrentUser(null);
        localStorage.removeItem('vst_user');
        openAuthModal('login', planType);
        return;
      }

      if (data.success) {
        if (planType === 'trial') {
          showToast('Đăng ký gói Dùng thử thành công! Key đã kích hoạt & gửi qua Email.');
          // Reload keys in Home (implicitly done as currentUser state does not change, 
          // but we can trigger a state change or wait for dashboard refresh)
          window.location.reload();
        } else {
          showToast('Đăng ký thành công! Đang chuyển hướng sang trang thanh toán...');
          setTimeout(() => {
            navigate(`/payment.html?key=${data.key}`);
          }, 1200);
        }
      } else {
        if (data.pendingKey) {
          showToast('Bạn đang có một mã bản quyền chờ thanh toán! Đang chuyển hướng sang trang thanh toán...', 'error');
          setTimeout(() => {
            navigate(`/payment.html?key=${data.pendingKey}`);
          }, 1500);
        } else {
          showToast(data.error || 'Không thể đăng ký gói!', 'error');
        }
      }
    } catch (err) {
      showToast('Lỗi khi đăng ký gói: ' + err.message, 'error');
    }
  };

  const openAuthModal = (mode, redirectAction = null) => {
    setAuthModal({ isOpen: true, mode });
    if (redirectAction) {
      // Store redirect action if login is successful
      sessionStorage.setItem('redirect_action', redirectAction);
    }
  };

  const closeAuthModal = () => {
    setAuthModal((prev) => ({ ...prev, isOpen: false }));
  };

  const switchAuthMode = (mode) => {
    setAuthModal((prev) => ({ ...prev, mode }));
  };

  const handleAuthSuccess = async (user) => {
    setCurrentUser(user);
    localStorage.setItem('vst_user', JSON.stringify(user));
    
    // Check if there was a subscription redirect action
    const redirectAct = sessionStorage.getItem('redirect_action');
    if (redirectAct) {
      sessionStorage.removeItem('redirect_action');
      await handleSubscribePlan(redirectAct);
    } else {
      // Check if there is a pending payment key in storage
      const pendingKey = localStorage.getItem('pending_payment_key');
      if (pendingKey) {
        navigate(`/payment.html?key=${pendingKey}`);
      }
    }
  };

  const handleUpdateUser = (updatedUser) => {
    setCurrentUser(updatedUser);
    localStorage.setItem('vst_user', JSON.stringify(updatedUser));
  };

  const scrollToDashboard = () => {
    const el = document.getElementById('dashboard');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100 min-h-screen">
      {!isAdminRoute && (
        <Navbar 
          currentUser={currentUser} 
          onOpenAuth={(mode) => openAuthModal(mode)} 
          onLogout={handleLogout}
          onScrollToDashboard={scrollToDashboard}
        />
      )}
      
      <main className={`flex-1 ${isAdminRoute ? '' : 'pt-20'}`}>
        <Routes>
          <Route 
            path="/" 
            element={
              <Home 
                currentUser={currentUser} 
                isDevMode={isDevMode} 
                appVersion={appVersion}
                onOpenAuth={(mode) => openAuthModal(mode)}
                onSubscribePlan={handleSubscribePlan}
                showToast={showToast}
              />
            } 
          />
          <Route path="/index.html" element={<Home currentUser={currentUser} isDevMode={isDevMode} appVersion={appVersion} onOpenAuth={(mode) => openAuthModal(mode)} onSubscribePlan={handleSubscribePlan} showToast={showToast} />} />
          <Route path="/payment.html" element={<Payment isDevMode={isDevMode} showToast={showToast} />} />
          <Route path="/verify-email.html" element={<VerifyEmail />} />
          <Route path="/reset-password.html" element={<ResetPassword showToast={showToast} />} />
          <Route path="/admin" element={<Admin showToast={showToast} />} />
          <Route path="/admin.html" element={<Admin showToast={showToast} />} />
          
          {/* Standing Pricing routes */}
          <Route path="/pricing" element={<Pricing onSubscribePlan={handleSubscribePlan} />} />
          <Route path="/pricing.html" element={<Pricing onSubscribePlan={handleSubscribePlan} />} />
          
          {/* About us routes */}
          <Route path="/about" element={<About />} />
          <Route path="/about.html" element={<About />} />
          
          {/* New Dashboard & Profile standalone pages */}
          <Route 
            path="/dashboard" 
            element={
              currentUser ? (
                <DashboardPage currentUser={currentUser} isDevMode={isDevMode} showToast={showToast} />
              ) : (
                <Navigate to="/" replace />
              )
            } 
          />
          <Route 
            path="/dashboard.html" 
            element={
              currentUser ? (
                <DashboardPage currentUser={currentUser} isDevMode={isDevMode} showToast={showToast} />
              ) : (
                <Navigate to="/" replace />
              )
            } 
          />
          <Route 
            path="/profile" 
            element={
              currentUser ? (
                <Profile currentUser={currentUser} onUpdateUser={handleUpdateUser} showToast={showToast} />
              ) : (
                <Navigate to="/" replace />
              )
            } 
          />
          <Route 
            path="/profile.html" 
            element={
              currentUser ? (
                <Profile currentUser={currentUser} onUpdateUser={handleUpdateUser} showToast={showToast} />
              ) : (
                <Navigate to="/" replace />
              )
            } 
          />
        </Routes>
      </main>

      {/* Footer */}
      {!isAdminRoute && (
        <footer className="border-t border-zinc-900 bg-zinc-950 py-16 mt-20 relative overflow-hidden">
          {/* Background glow in footer */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[200px] bg-indigo-500/3 rounded-full blur-[120px] pointer-events-none"></div>

          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 relative z-10">
            
            <div className="grid grid-cols-1 md:grid-cols-4 gap-10 pb-12 border-b border-zinc-900">
              
              {/* Column 1: Brand details */}
              <div className="space-y-4 md:col-span-1">
                <Link to="/" className="flex items-center gap-3 cursor-pointer group w-fit">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 shadow-md shadow-indigo-500/10">
                    <Video className="text-white h-5 w-5" />
                  </div>
                  <span className="text-lg font-bold tracking-tight text-white font-display">
                    Editnhanh
                  </span>
                </Link>
                <p className="text-xs text-zinc-400 leading-relaxed max-w-xs">
                  Bộ công cụ tự động hóa sản xuất video ngắn offline tối ưu hàng đầu, hỗ trợ nhà sáng tạo nội dung reup, edit nhanh chóng, chuyên nghiệp và bảo mật tuyệt đối.
                </p>
              </div>

              {/* Column 2: Quick Links */}
              <div className="space-y-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider font-display">Liên kết nhanh</h4>
                <ul className="space-y-2.5 text-xs font-medium text-zinc-400">
                  <li>
                    <Link to="/" className="hover:text-white transition-colors">Trang chủ</Link>
                  </li>
                  <li>
                    <Link to="/pricing" className="hover:text-white transition-colors">Bảng giá dịch vụ</Link>
                  </li>
                  <li>
                    <Link to="/about" className="hover:text-white transition-colors">Về chúng tôi</Link>
                  </li>
                  <li>
                    <Link to="/#features" className="hover:text-white transition-colors">Tính năng chính</Link>
                  </li>
                </ul>
              </div>

              {/* Column 3: Proprietary Engines */}
              <div className="space-y-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider font-display">Động cơ công nghệ</h4>
                <ul className="space-y-2.5 text-xs text-zinc-400 font-medium">
                  <li className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>
                    <span>Smart-Voice AI (Nhận diện)</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>
                    <span>VST-Speech AI (Lồng tiếng)</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>
                    <span>VST-Core Fast Render (Biên tập)</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>
                    <span>High-Speed Crawler (Tải video)</span>
                  </li>
                </ul>
              </div>

              {/* Column 4: Contact Support */}
              <div className="space-y-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider font-display">Hỗ trợ & Liên hệ</h4>
                <ul className="space-y-3 text-xs text-zinc-400 font-medium">
                  <li className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-indigo-400 shrink-0" />
                    <a href={`mailto:${contact.email}`} className="hover:text-white transition-colors truncate">{contact.email}</a>
                  </li>
                  {contact.zalo && (
                    <li className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-indigo-400 shrink-0" />
                      <span className="select-text">Zalo: {contact.zalo}</span>
                    </li>
                  )}
                  {contact.telegram && (
                    <li className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-indigo-400 shrink-0" />
                      <span className="select-text">Telegram: {contact.telegram}</span>
                    </li>
                  )}
                </ul>
              </div>

            </div>

            {/* Bottom section */}
            <div className="pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
              <p className="text-[11px] text-zinc-500 font-display">
                &copy; {new Date().getFullYear()} Editnhanh. Bản quyền được bảo lưu.
              </p>
              <p className="text-[10px] text-zinc-650 flex items-center gap-1">
                <Shield className="h-3.5 w-3.5 text-indigo-500/50" />
                <span>Ed25519 & Local Verification Engine. Resume download và bảo mật phiên.</span>
              </p>
            </div>

          </div>
        </footer>
      )}

      {/* Auth Modal */}
      <AuthModal 
        isOpen={authModal.isOpen} 
        mode={authModal.mode} 
        onClose={closeAuthModal} 
        onSwitchMode={switchAuthMode}
        onAuthSuccess={handleAuthSuccess}
        showToast={showToast}
      />

      {/* Toast Alert System Container */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg transform translate-y-0 opacity-100 transition-all duration-300 bg-zinc-900 text-sm ${
              t.type === 'error' ? 'border-rose-900/50 text-rose-400' : 'border-emerald-900/50 text-emerald-400'
            }`}
          >
            {t.type === 'error' ? (
              <AlertTriangle className="h-5 w-5 shrink-0" />
            ) : (
              <CheckCircle className="h-5 w-5 shrink-0" />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    if (!window.location.hash) {
      window.scrollTo(0, 0);
    }
  }, [pathname]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <AppContent />
    </BrowserRouter>
  );
}
