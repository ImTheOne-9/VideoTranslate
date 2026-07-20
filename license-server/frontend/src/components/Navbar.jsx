import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Video, LayoutDashboard, LogOut, User, ShieldCheck } from 'lucide-react';

export default function Navbar({ currentUser, onOpenAuth, onLogout, onScrollToDashboard }) {
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = React.useState(false);

  const getInitials = (name) => {
    if (!name) return 'U';
    const names = name.split(' ');
    return names.length > 1 ? (names[0][0] + names[names.length - 1][0]).toUpperCase() : names[0][0].toUpperCase();
  };

  return (
    <header className="border-b border-zinc-900/80 bg-zinc-950/75 backdrop-blur-xl fixed top-0 left-0 right-0 z-40">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-20 items-center justify-between">
          
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3 cursor-pointer group">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/20 group-hover:shadow-indigo-500/30 transition-all">
              <Video className="text-white h-5.5 w-5.5" />
            </div>
            <div>
              <span className="text-xl font-bold tracking-tight text-white font-display">
                Editnhanh
              </span>
            </div>
          </Link>
          
          {/* Navigation Links */}
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-zinc-400">
            <Link to="/" className="hover:text-white transition-colors">Trang chủ</Link>
            <Link to="/instructions" className="hover:text-white transition-colors">Hướng dẫn</Link>
            <Link to="/pricing" className="hover:text-white transition-colors">Bảng giá</Link>
            <Link to="/about" className="hover:text-white transition-colors">Về chúng tôi</Link>
          </nav>
          
          {/* Auth Buttons / User Profile */}
          <div className="flex items-center gap-4">
            {!currentUser ? (
              <div id="unauthHeader" className="flex items-center gap-3">
                <button 
                  onClick={() => onOpenAuth('login')} 
                  className="text-sm font-semibold hover:text-white text-zinc-400 px-3 py-1.5 transition-colors cursor-pointer"
                >
                  Đăng nhập
                </button>
                <button 
                  onClick={() => onOpenAuth('register')} 
                  className="px-4 py-2 text-sm font-semibold text-white rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20 transition-all cursor-pointer"
                >
                  Đăng ký dùng thử
                </button>
              </div>
            ) : (
              <div className="relative">
                {/* Avatar Button */}
                <button 
                  onClick={() => setDropdownOpen(!dropdownOpen)}
                  className="flex items-center gap-2.5 focus:outline-none cursor-pointer group"
                >
                  <div className="h-9 w-9 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white text-xs shadow-md shadow-indigo-500/10 group-hover:shadow-indigo-500/20 transition-all overflow-hidden select-none">
                    {currentUser.avatar ? (
                      <img src={currentUser.avatar} alt="Avatar" className="h-full w-full object-cover" />
                    ) : (
                      getInitials(currentUser.fullName)
                    )}
                  </div>
                  <span className="text-xs font-semibold text-zinc-350 group-hover:text-white hidden sm:block transition-colors">
                    {currentUser.fullName || 'Thành viên'}
                  </span>
                </button>

                {/* Dropdown Menu */}
                {dropdownOpen && (
                  <>
                    {/* Backdrop to close dropdown */}
                    <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)}></div>
                    
                    <div className="absolute right-0 mt-3 w-56 rounded-xl bg-zinc-900 border border-zinc-800 p-2 shadow-2xl z-50 transform origin-top-right transition-all">
                      <div className="px-3 py-2 border-b border-zinc-850 mb-1.5">
                        <p className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Tài khoản</p>
                        <p className="text-xs font-bold text-white truncate mt-0.5">{currentUser.fullName}</p>
                        <p className="text-[10px] text-zinc-400 truncate">{currentUser.email}</p>
                      </div>
                      
                      <button
                        onClick={() => {
                          setDropdownOpen(false);
                          navigate('/profile');
                        }}
                        className="w-full text-left px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-800/50 rounded-lg flex items-center gap-2 transition-all cursor-pointer"
                      >
                        <User className="h-3.5 w-3.5 text-indigo-400" />
                        <span>Trang cá nhân</span>
                      </button>

                      {['admin', 'sale'].includes(currentUser.role) && (
                        <button
                          onClick={() => {
                            setDropdownOpen(false);
                            navigate('/admin');
                          }}
                          className="w-full text-left px-3 py-2 text-xs font-semibold text-amber-300 hover:text-amber-200 hover:bg-amber-955/30 rounded-lg flex items-center gap-2 transition-all cursor-pointer"
                        >
                          <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
                          <span>Quản trị Admin</span>
                        </button>
                      )}

                      <button
                        onClick={() => {
                          setDropdownOpen(false);
                          navigate('/dashboard');
                        }}
                        className="w-full text-left px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-800/50 rounded-lg flex items-center gap-2 mt-1 transition-all cursor-pointer"
                      >
                        <LayoutDashboard className="h-3.5 w-3.5 text-indigo-400" />
                        <span>Dashboard</span>
                      </button>
                      
                      <button
                        onClick={() => {
                          setDropdownOpen(false);
                          onLogout();
                        }}
                        className="w-full text-left px-3 py-2 text-xs font-semibold text-rose-450 hover:text-rose-400 hover:bg-rose-955/20 rounded-lg flex items-center gap-2 mt-1 transition-all cursor-pointer"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        <span>Đăng xuất</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          
        </div>
      </div>
    </header>
  );
}
