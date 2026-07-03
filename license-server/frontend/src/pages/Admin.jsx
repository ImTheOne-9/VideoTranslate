import React, { useState, useEffect } from 'react';
import { Lock, Key, X, ShieldCheck, KeyRound, CheckCircle, AlertTriangle, Clock, Search, PlusCircle, Loader2, Copy, ArrowRight, Power, Plus, Users, UserCheck, UserX, Trash2, User, Settings, Layers } from 'lucide-react';

export default function Admin({ showToast }) {
  const [token, setToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  
  // Tab control state
  const [activeMainTab, setActiveMainTab] = useState('keys'); // 'keys' | 'users'

  // Keys database and filtering states
  const [rawKeys, setRawKeys] = useState([]);
  const [filteredKeys, setFilteredKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [currentFilterTab, setCurrentFilterTab] = useState('all');

  // Keys pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  // Users database and filtering states
  const [users, setUsers] = useState([]);
  const [filteredUsers, setFilteredUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userSearchText, setUserSearchText] = useState('');

  // Users pagination states
  const [userPage, setUserPage] = useState(1);
  const [totalUserPages, setTotalUserPages] = useState(1);
  const [totalUserItems, setTotalUserItems] = useState(0);

  // Stats overview states
  const [stats, setStats] = useState({ total: 0, active: 0, suspended: 0, expired: 0 });
  const [userStats, setUserStats] = useState({ total: 0, verified: 0, admins: 0, members: 0 });

  // Key generation form states
  const [customerName, setCustomerName] = useState('');
  const [licenseDays, setLicenseDays] = useState(30);
  const [generating, setGenerating] = useState(false);

  // Config states
  const [installerUrl, setInstallerUrl] = useState('');
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  // Plans Management states
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null);

  // Plan Form states
  const [planId, setPlanId] = useState('');
  const [planName, setPlanName] = useState('');
  const [planPrice, setPlanPrice] = useState(199000);
  const [planDurationDays, setPlanDurationDays] = useState(30);
  const [planDescription, setPlanDescription] = useState('');
  const [planFeatures, setPlanFeatures] = useState('');
  const [planIsPopular, setPlanIsPopular] = useState(false);
  const [planStatus, setPlanStatus] = useState('active');

  const getPageNumbers = (curr, total) => {
    const pages = [];
    const start = Math.max(1, curr - 2);
    const end = Math.min(total, curr + 2);
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  useEffect(() => {
    const storedToken = localStorage.getItem('license_admin_token') || '';
    if (!storedToken) {
      setIsAuthModalOpen(true);
    } else {
      setToken(storedToken);
    }
  }, []);

  // Fetch Keys when token, page, search, or status tab changes
  useEffect(() => {
    if (token) {
      loadKeys();
    }
  }, [token, currentPage, currentFilterTab]);

  // Reset keys page to 1 when search text changes
  useEffect(() => {
    if (token) {
      if (currentPage === 1) {
        loadKeys();
      } else {
        setCurrentPage(1);
      }
    }
  }, [searchText]);

  // Fetch Users when token or page changes
  useEffect(() => {
    if (token) {
      loadUsers();
    }
  }, [token, userPage]);

  // Reset users page to 1 when search text changes
  useEffect(() => {
    if (token) {
      if (userPage === 1) {
        loadUsers();
      } else {
        setUserPage(1);
      }
    }
  }, [userSearchText]);

  // Fetch config when token is set
  useEffect(() => {
    if (token) {
      loadConfig();
    }
  }, [token]);

  // Fetch Plans when token is set
  useEffect(() => {
    if (token) {
      loadPlans();
    }
  }, [token]);

  const loadPlans = async () => {
    setLoadingPlans(true);
    try {
      const res = await fetch('/api/admin/plans', {
        headers: { 'x-admin-token': token }
      });
      const data = await res.json();
      if (data.success) {
        setPlans(data.plans || []);
      } else {
        showToast(data.error || 'Lỗi khi tải gói dịch vụ!', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối tải gói dịch vụ: ' + err.message, 'error');
    } finally {
      setLoadingPlans(false);
    }
  };

  const handleOpenPlanModal = (plan = null) => {
    setSelectedPlan(plan);
    if (plan) {
      setPlanId(plan.id);
      setPlanName(plan.name);
      setPlanPrice(plan.price);
      setPlanDurationDays(plan.durationDays);
      setPlanDescription(plan.description || '');
      setPlanFeatures(Array.isArray(plan.features) ? plan.features.join('\n') : '');
      setPlanIsPopular(!!plan.isPopular);
      setPlanStatus(plan.status || 'active');
    } else {
      setPlanId('');
      setPlanName('');
      setPlanPrice(199000);
      setPlanDurationDays(30);
      setPlanDescription('');
      setPlanFeatures('Đầy đủ tính năng 100%\nSử dụng trên 1 máy tính');
      setPlanIsPopular(false);
      setPlanStatus('active');
    }
    setIsPlanModalOpen(true);
  };

  const handleSavePlan = async (e) => {
    e.preventDefault();
    if (!planId || !planName || planPrice === undefined || !planDurationDays) {
      showToast('Vui lòng nhập đầy đủ thông tin bắt buộc!', 'error');
      return;
    }

    const trimmedId = planId.trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(trimmedId)) {
      showToast('Mã ID gói chỉ được chứa chữ thường không dấu, số và dấu gạch dưới (không chứa dấu cách, ký tự đặc biệt)!', 'error');
      return;
    }

    const parsedPrice = parseFloat(planPrice);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      showToast('Giá bán của gói phải là số lớn hơn hoặc bằng 0!', 'error');
      return;
    }

    const parsedDuration = parseInt(planDurationDays);
    if (isNaN(parsedDuration) || parsedDuration <= 0) {
      showToast('Hạn sử dụng của gói phải là số ngày lớn hơn 0!', 'error');
      return;
    }

    const payload = {
      id: trimmedId,
      name: planName.trim(),
      price: parsedPrice,
      durationDays: parsedDuration,
      description: planDescription.trim(),
      features: planFeatures.split('\n').map(f => f.trim()).filter(Boolean),
      isPopular: planIsPopular,
      status: planStatus
    };

    try {
      const url = selectedPlan ? `/api/admin/plans/${selectedPlan.id}` : '/api/admin/plans';
      const method = selectedPlan ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: {
          'x-admin-token': token,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        showToast(selectedPlan ? 'Cập nhật gói thành công!' : 'Tạo gói mới thành công!');
        setIsPlanModalOpen(false);
        await loadPlans();
      } else {
        showToast(data.error || 'Lỗi khi lưu gói dịch vụ', 'error');
      }
    } catch (err) {
      showToast('Lỗi API lưu gói: ' + err.message, 'error');
    }
  };

  const handleDeletePlan = async (id) => {
    if (['trial', 'monthly', 'yearly'].includes(id)) {
      showToast('Không thể xóa các gói hệ thống cốt lõi (trial, monthly, yearly)!', 'error');
      return;
    }
    if (!confirm(`Bạn có chắc chắn muốn xóa gói dịch vụ "${id}"?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/plans/${id}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': token }
      });
      const data = await res.json();

      if (data.success) {
        showToast('Xóa gói dịch vụ thành công!');
        await loadPlans();
      } else {
        showToast(data.error || 'Lỗi khi xóa gói', 'error');
      }
    } catch (err) {
      showToast('Lỗi API xóa gói: ' + err.message, 'error');
    }
  };

  const loadKeys = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/keys?page=${currentPage}&limit=10&search=${encodeURIComponent(searchText)}&status=${currentFilterTab}`, {
        headers: { 'x-admin-token': token }
      });

      if (res.status === 401) {
        showToast('Token bảo mật không hợp lệ. Vui lòng nhập lại.', 'error');
        handleResetToken();
        return;
      }

      const data = await res.json();
      if (data.success) {
        setRawKeys(data.keys || []);
        setFilteredKeys(data.keys || []);
        if (data.stats) {
          setStats(data.stats);
        }
        if (data.pagination) {
          setTotalPages(data.pagination.totalPages || 1);
          setTotalItems(data.pagination.totalItems || 0);
        }
      } else {
        showToast(data.error || 'Lỗi khi tải dữ liệu từ máy chủ', 'error');
      }
    } catch (err) {
      showToast('Không kết nối được với License Server: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch(`/api/admin/users?page=${userPage}&limit=10&search=${encodeURIComponent(userSearchText)}`, {
        headers: { 'x-admin-token': token }
      });

      if (res.status === 401) {
        return; // Handled by loadKeys 401 check
      }

      const data = await res.json();
      if (data.success) {
        setUsers(data.users || []);
        setFilteredUsers(data.users || []);
        if (data.stats) {
          setUserStats(data.stats);
        }
        if (data.pagination) {
          setTotalUserPages(data.pagination.totalPages || 1);
          setTotalUserItems(data.pagination.totalItems || 0);
        }
      } else {
        showToast(data.error || 'Lỗi khi tải danh sách người dùng', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối khi tải danh sách user: ' + err.message, 'error');
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadConfig = async () => {
    setLoadingConfig(true);
    try {
      const res = await fetch('/api/admin/config', {
        headers: { 'x-admin-token': token }
      });
      const data = await res.json();
      if (data.success) {
        setInstallerUrl(data.installerUrl || '');
      }
    } catch (err) {
      showToast('Lỗi khi tải cấu hình link tải: ' + err.message, 'error');
    } finally {
      setLoadingConfig(false);
    }
  };

  const handleSaveConfig = async (e) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify({ installerUrl })
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || 'Lưu cấu hình thành công!');
      } else {
        showToast(data.error || 'Lỗi khi lưu cấu hình', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối: ' + err.message, 'error');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleResetToken = () => {
    localStorage.removeItem('license_admin_token');
    setToken('');
    setTokenInput('');
    setIsAuthModalOpen(true);
  };

  const handleTokenSubmit = (e) => {
    e.preventDefault();
    const val = tokenInput.trim();
    if (!val) {
      showToast('Vui lòng nhập token bảo mật!', 'error');
      return;
    }
    localStorage.setItem('license_admin_token', val);
    setToken(val);
    setIsAuthModalOpen(false);
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    showToast('Đã sao chép mã bản quyền vào clipboard!');
  };

  const handleGenerateKey = async (e) => {
    e.preventDefault();
    if (!licenseDays || licenseDays <= 0) {
      showToast('Vui lòng nhập số ngày sử dụng hợp lệ', 'error');
      return;
    }

    setGenerating(true);
    try {
      const res = await fetch('/api/admin/generate-key', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify({ days: Number(licenseDays), customerName: customerName.trim() })
      });

      const data = await res.json();
      if (data.success) {
        showToast(`Đã tạo key mới cho ${data.customerName || 'Khách lẻ'}!`);
        setIsGenerateModalOpen(false);
        setCustomerName('');
        setLicenseDays(30);
        await loadKeys();
      } else {
        showToast(data.error || 'Không thể tạo key mới', 'error');
      }
    } catch (err) {
      showToast('Lỗi khi gọi API tạo key: ' + err.message, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleResetHwid = async (key) => {
    if (!confirm(`Bạn có chắc chắn muốn giải phóng HWID cho key: ${key}?`)) {
      return;
    }

    try {
      const res = await fetch('/api/admin/reset-hwid', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify({ key })
      });

      const data = await res.json();
      if (data.success) {
        showToast('Đã giải phóng thiết bị liên kết với key thành công!');
        await loadKeys();
      } else {
        showToast(data.error || 'Không thể reset HWID', 'error');
      }
    } catch (err) {
      showToast('Lỗi khi gọi API reset HWID: ' + err.message, 'error');
    }
  };

  const handleToggleKeyStatus = async (key, currentStatus) => {
    const nextStatus = currentStatus === 'suspended' ? 'active' : 'suspended';
    const promptText = nextStatus === 'suspended' ? 'khóa' : 'mở khóa';
    
    if (!confirm(`Bạn có chắc chắn muốn ${promptText} key: ${key}?`)) {
      return;
    }

    try {
      const res = await fetch('/api/admin/toggle-status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify({ key, status: nextStatus })
      });

      const data = await res.json();
      if (data.success) {
        showToast(`Đã ${promptText} key thành công!`);
        await loadKeys();
      } else {
        showToast(data.error || 'Không thể cập nhật trạng thái key', 'error');
      }
    } catch (err) {
      showToast('Lỗi khi cập nhật trạng thái key: ' + err.message, 'error');
    }
  };

  const handleToggleUserRole = async (email, currentRole) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    const newRoleText = newRole === 'admin' ? 'Quản trị viên (Admin)' : 'Thành viên thường';
    
    if (!confirm(`Bạn có muốn đổi vai trò của người dùng ${email} thành ${newRoleText}?`)) {
      return;
    }

    try {
      const res = await fetch('/api/admin/update-user-role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': token
        },
        body: JSON.stringify({ email, role: newRole })
      });

      const data = await res.json();
      if (res.status === 200 && data.success) {
        showToast(data.message || 'Cập nhật vai trò người dùng thành công!');
        await loadUsers();
      } else {
        showToast(data.error || 'Lỗi khi cập nhật vai trò', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối: ' + err.message, 'error');
    }
  };

  const handleDeleteUser = async (email) => {
    if (!confirm(`Bạn có chắc chắn muốn xóa tài khoản người dùng: ${email}? Hành động này sẽ xóa vĩnh viễn tài khoản và KHÔNG THỂ HOÀN TÁC!`)) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': token }
      });

      const data = await res.json();
      if (res.status === 200 && data.success) {
        showToast(data.message || 'Xóa tài khoản thành công!');
        await loadUsers();
      } else {
        showToast(data.error || 'Lỗi khi xóa tài khoản', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối: ' + err.message, 'error');
    }
  };

  const getStatusBadge = (k) => {
    const isExpired = new Date(k.expiresAt) < new Date();
    if (k.status === 'suspended') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-900/30">
          Bị Khóa
        </span>
      );
    } else if (k.paymentStatus === 'pending') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-900/30">
          Chờ Thanh Toán
        </span>
      );
    } else if (isExpired) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-900/30">
          Hết Hạn
        </span>
      );
    } else if (k.hwid) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-900/30">
          Đang Hoạt Động
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-900/30">
          Chờ Kích Hoạt
        </span>
      );
    }
  };

  const getAvatarInitials = (name) => {
    if (!name) return 'U';
    const names = name.split(' ');
    return names.length > 1 ? (names[0][0] + names[names.length - 1][0]).toUpperCase() : names[0][0].toUpperCase();
  };

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100 pb-20">
      
      {/* Header */}
      <header className="border-b border-zinc-900 bg-zinc-900/50 backdrop-blur-lg sticky top-0 z-30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 shadow-md">
                <ShieldCheck className="text-white h-5 w-5" />
              </div>
              <div>
                <span className="text-lg font-bold tracking-tight text-white font-display">Editnhanh</span>
                <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">License Admin</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-sm text-zinc-500 hidden sm:block">
                Server URL: <span className="font-mono text-zinc-300">{window.location.origin}</span>
              </div>
              <button 
                onClick={handleResetToken} 
                className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Đổi Token</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        
        {/* Main Tab Controls */}
        <div className="flex border-b border-zinc-900 gap-6 text-sm font-semibold mb-6">
          <button 
            onClick={() => setActiveMainTab('keys')}
            className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              activeMainTab === 'keys' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <Key className="h-4 w-4" />
            <span>Quản lý Keys bản quyền</span>
          </button>
          <button 
            onClick={() => setActiveMainTab('users')}
            className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              activeMainTab === 'users' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <Users className="h-4 w-4" />
            <span>Quản lý Thành viên</span>
          </button>
          <button 
            onClick={() => setActiveMainTab('plans')}
            className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              activeMainTab === 'plans' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <Layers className="h-4 w-4" />
            <span>Quản lý Gói dịch vụ</span>
          </button>
          <button 
            onClick={() => setActiveMainTab('settings')}
            className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              activeMainTab === 'settings' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <Settings className="h-4 w-4" />
            <span>Cấu hình Link tải</span>
          </button>
        </div>

        {activeMainTab === 'keys' && (
          /* ================= KEY MANAGEMENT VIEW ================= */
          <>
            {/* Metrics Keys Overview */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Tổng Số Key</p>
                  <h3 className="text-2xl font-bold mt-1 text-white">{stats.total}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-zinc-850 flex items-center justify-center text-zinc-400">
                  <Key className="h-5 w-5" />
                </div>
              </div>

              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Đang hoạt động</p>
                  <h3 className="text-2xl font-bold mt-1 text-emerald-500">{stats.active}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-450">
                  <CheckCircle className="h-5 w-5" />
                </div>
              </div>

              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Bị Khóa</p>
                  <h3 className="text-2xl font-bold mt-1 text-rose-500">{stats.suspended}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-450">
                  <AlertTriangle className="h-5 w-5" />
                </div>
              </div>

              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Đã Hết Hạn</p>
                  <h3 className="text-2xl font-bold mt-1 text-amber-500">{stats.expired}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-450">
                  <Clock className="h-5 w-5" />
                </div>
              </div>
            </div>

            {/* Controls & Actions Keys */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex flex-1 flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-zinc-500" />
                  <input 
                    type="text" 
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    placeholder="Tìm kiếm theo Key, Tên khách hàng, HWID..." 
                    className="w-full rounded-lg bg-zinc-900 border border-zinc-800 pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                
                {/* Filter Tabs */}
                <div className="flex rounded-lg bg-zinc-900 p-1 border border-zinc-850 self-start sm:self-auto text-xs font-semibold">
                  {['all', 'active', 'inactive', 'suspended', 'expired'].map((tab) => {
                    const isSelected = currentFilterTab === tab;
                    const tabNames = {
                      all: 'Tất cả',
                      active: 'Hoạt động',
                      inactive: 'Chờ kích hoạt',
                      suspended: 'Bị khóa',
                      expired: 'Hết hạn'
                    };
                    return (
                      <button 
                        key={tab}
                        onClick={() => setCurrentFilterTab(tab)}
                        className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
                          isSelected ? 'bg-indigo-500 text-white shadow-sm' : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        {tabNames[tab]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <button 
                  onClick={() => setIsGenerateModalOpen(true)} 
                  className="w-full md:w-auto px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-sm font-semibold text-white rounded-lg shadow-lg flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  <PlusCircle className="h-4.5 w-4.5" />
                  <span>Tạo Key Bản Quyền</span>
                </button>
              </div>
            </div>

            {/* Keys Table */}
            <div className="overflow-x-auto rounded-xl border border-zinc-900 bg-zinc-900/30">
              <table className="min-w-full divide-y divide-zinc-900 text-left text-sm text-zinc-300">
                <thead className="bg-zinc-900/80 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th scope="col" className="px-6 py-4">Khách Hàng</th>
                    <th scope="col" className="px-6 py-4">Key Bản Quyền</th>
                    <th scope="col" className="px-6 py-4">Thiết Bị (HWID)</th>
                    <th scope="col" className="px-6 py-4">Ngày Tạo</th>
                    <th scope="col" className="px-6 py-4">Hạn Dùng</th>
                    <th scope="col" className="px-6 py-4 text-center">Trạng Thái</th>
                    <th scope="col" className="px-6 py-4 text-right">Thao Tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/50 bg-transparent">
                  {loading ? (
                    <tr>
                      <td colSpan="7" className="px-6 py-12 text-center text-zinc-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                          <span>Đang tải danh sách key bản quyền...</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredKeys.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="px-6 py-12 text-center text-zinc-500">
                        Không có mã bản quyền nào khớp với bộ lọc
                      </td>
                    </tr>
                  ) : (
                    filteredKeys.map((k) => {
                      const formattedCreated = new Date(k.createdAt).toLocaleDateString('vi-VN', {
                        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                      });
                      const formattedExpires = new Date(k.expiresAt).toLocaleDateString('vi-VN', {
                        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                      });

                      return (
                        <tr key={k.key} className="hover:bg-zinc-900/20 transition-colors">
                          <td className="px-6 py-4 font-semibold text-white">{k.customerName || 'Khách lẻ'}</td>
                          <td className="px-6 py-4 font-mono text-zinc-400 text-xs">
                            <div className="flex items-center gap-1.5">
                              <span className="bg-zinc-900 border border-zinc-800 px-2 py-1 rounded select-all">{k.key}</span>
                              <Copy 
                                className="h-3.5 w-3.5 cursor-pointer text-zinc-500 hover:text-white"
                                onClick={() => copyToClipboard(k.key)}
                              />
                            </div>
                          </td>
                          <td className="px-6 py-4 font-mono text-zinc-500 text-xs max-w-xs truncate" title={k.hwid || 'Chưa liên kết'}>
                            {k.hwid ? `${k.hwid.slice(0, 16)}...` : <span className="italic text-zinc-700">Chưa kích hoạt</span>}
                          </td>
                          <td className="px-6 py-4 text-xs text-zinc-500">{formattedCreated}</td>
                          <td className="px-6 py-4 text-xs text-zinc-400">{formattedExpires}</td>
                          <td className="px-6 py-4 text-center">{getStatusBadge(k)}</td>
                          <td className="px-6 py-4 text-right space-x-1.5 whitespace-nowrap">
                            <button 
                              onClick={() => handleResetHwid(k.key)}
                              disabled={!k.hwid}
                              className={`px-2.5 py-1 text-xs rounded font-medium transition-colors border ${
                                !k.hwid 
                                  ? 'bg-zinc-950 border-zinc-900 text-zinc-650 cursor-not-allowed opacity-30'
                                  : 'bg-zinc-900 border-zinc-800 hover:bg-zinc-800 text-zinc-300 cursor-pointer'
                              }`}
                            >
                              Reset HWID
                            </button>
                            <button 
                              onClick={() => handleToggleKeyStatus(k.key, k.status)}
                              className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors cursor-pointer border ${
                                k.status === 'suspended'
                                  ? 'bg-emerald-600 border-emerald-700 hover:bg-emerald-500 text-white'
                                  : 'bg-rose-950/40 border-rose-900/40 hover:bg-rose-900/40 text-rose-400'
                              }`}
                            >
                              {k.status === 'suspended' ? 'Mở khóa' : 'Khóa'}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>

              {/* Pagination controls for Keys */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-6 py-4 border-t border-zinc-900 bg-zinc-900/10">
                <div className="text-xs text-zinc-500">
                  Hiển thị <span className="font-semibold text-zinc-300">{totalItems === 0 ? 0 : (currentPage - 1) * 10 + 1} - {Math.min(currentPage * 10, totalItems)}</span> trong tổng số <span className="font-semibold text-zinc-300">{totalItems}</span> keys bản quyền
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <button 
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage(prev => prev - 1)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Trước
                    </button>
                    {getPageNumbers(currentPage, totalPages).map(num => (
                      <button
                        key={num}
                        onClick={() => setCurrentPage(num)}
                        className={`px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                          currentPage === num 
                            ? 'bg-indigo-500 border-indigo-500 text-white shadow-md shadow-indigo-500/10' 
                            : 'bg-zinc-900 border-zinc-850 text-zinc-400 hover:bg-zinc-800 hover:text-white'
                        }`}
                      >
                        {num}
                      </button>
                    ))}
                    <button 
                      disabled={currentPage === totalPages}
                      onClick={() => setCurrentPage(prev => prev + 1)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Sau
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {activeMainTab === 'users' && (
          /* ================= USER MANAGEMENT VIEW ================= */
          <>
            {/* Metrics Users Overview */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Tổng Thành Viên</p>
                  <h3 className="text-2xl font-bold mt-1 text-white">{userStats.total}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-zinc-850 flex items-center justify-center text-zinc-400">
                  <Users className="h-5 w-5" />
                </div>
              </div>

              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Đã Xác Minh Email</p>
                  <h3 className="text-2xl font-bold mt-1 text-emerald-500">{userStats.verified}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-450">
                  <UserCheck className="h-5 w-5" />
                </div>
              </div>

              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Quản Trị Viên (Admin)</p>
                  <h3 className="text-2xl font-bold mt-1 text-indigo-500">{userStats.admins}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                  <ShieldCheck className="h-5 w-5" />
                </div>
              </div>

              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Thành Viên Thường</p>
                  <h3 className="text-2xl font-bold mt-1 text-zinc-450">{userStats.members}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-zinc-850 flex items-center justify-center text-zinc-500">
                  <User className="h-5 w-5" />
                </div>
              </div>
            </div>

            {/* Controls & Actions Users */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 h-4 w-4 text-zinc-500" />
                <input 
                  type="text" 
                  value={userSearchText}
                  onChange={(e) => setUserSearchText(e.target.value)}
                  placeholder="Tìm kiếm theo Tên, Email, Số điện thoại..." 
                  className="w-full rounded-lg bg-zinc-900 border border-zinc-800 pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              
              <div className="text-xs text-zinc-500">
                Hiển thị <span className="font-bold text-zinc-350">{filteredUsers.length}</span> / {users.length} người dùng
              </div>
            </div>

            {/* Users Table */}
            <div className="overflow-x-auto rounded-xl border border-zinc-900 bg-zinc-900/30">
              <table className="min-w-full divide-y divide-zinc-900 text-left text-sm text-zinc-300">
                <thead className="bg-zinc-900/80 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th scope="col" className="px-6 py-4">Thành Viên</th>
                    <th scope="col" className="px-6 py-4">Số Điện Thoại</th>
                    <th scope="col" className="px-6 py-4 text-center">Vai Trò</th>
                    <th scope="col" className="px-6 py-4 text-center">Email Xác Minh</th>
                    <th scope="col" className="px-6 py-4">Ngày Tham Gia</th>
                    <th scope="col" className="px-6 py-4 text-right">Thao Tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/50 bg-transparent">
                  {loadingUsers ? (
                    <tr>
                      <td colSpan="6" className="px-6 py-12 text-center text-zinc-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                          <span>Đang tải danh sách thành viên...</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="px-6 py-12 text-center text-zinc-500">
                        Không có người dùng nào khớp với từ khóa tìm kiếm
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((u) => {
                      const formattedJoined = u.createdAt 
                        ? new Date(u.createdAt).toLocaleDateString('vi-VN', {
                            year: 'numeric', month: '2-digit', day: '2-digit'
                          })
                        : 'N/A';

                      return (
                        <tr key={u.email} className="hover:bg-zinc-900/20 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              {/* User Avatar Circle */}
                              <div className="h-9 w-9 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white text-xs shadow-sm overflow-hidden select-none shrink-0">
                                {u.avatar ? (
                                  <img src={u.avatar} alt="Avatar" className="h-full w-full object-cover" />
                                ) : (
                                  getAvatarInitials(u.fullName)
                                )}
                              </div>
                              <div className="truncate max-w-[180px] sm:max-w-xs">
                                <p className="font-semibold text-white truncate">{u.fullName}</p>
                                <p className="text-[10px] text-zinc-500 truncate">{u.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-xs font-mono text-zinc-400">
                            {u.phoneNumber || <span className="italic text-zinc-700">Chưa cập nhật</span>}
                          </td>
                          <td className="px-6 py-4 text-center">
                            {u.role === 'admin' ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                Admin
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-zinc-800 text-zinc-450">
                                Member
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-center">
                            {u.isVerified ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                Đã Xác Minh
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-500/10 text-rose-450 border border-rose-500/20">
                                Chưa Xác Minh
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-xs text-zinc-500">{formattedJoined}</td>
                          <td className="px-6 py-4 text-right space-x-1.5 whitespace-nowrap">
                            <button 
                              onClick={() => handleToggleUserRole(u.email, u.role)}
                              className={`px-2.5 py-1 text-xs rounded font-semibold transition-colors border cursor-pointer ${
                                u.role === 'admin'
                                  ? 'bg-zinc-950 border-zinc-900 hover:bg-zinc-900 text-zinc-450 hover:text-white'
                                  : 'bg-indigo-650/40 border-indigo-600/40 hover:bg-indigo-600 hover:text-white text-indigo-400'
                              }`}
                            >
                              {u.role === 'admin' ? 'Hạ xuống Member' : 'Lên Admin'}
                            </button>
                            <button 
                              onClick={() => handleDeleteUser(u.email)}
                              className="p-1 px-1.5 bg-rose-950/40 border border-rose-900/40 hover:bg-rose-900 hover:text-white text-rose-400 rounded transition-colors cursor-pointer"
                              title="Xóa tài khoản người dùng"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>

              {/* Pagination controls for Users */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-6 py-4 border-t border-zinc-900 bg-zinc-900/10">
                <div className="text-xs text-zinc-500">
                  Hiển thị <span className="font-semibold text-zinc-300">{totalUserItems === 0 ? 0 : (userPage - 1) * 10 + 1} - {Math.min(userPage * 10, totalUserItems)}</span> trong tổng số <span className="font-semibold text-zinc-300">{totalUserItems}</span> thành viên
                </div>
                {totalUserPages > 1 && (
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <button 
                      disabled={userPage === 1}
                      onClick={() => setUserPage(prev => prev - 1)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Trước
                    </button>
                    {getPageNumbers(userPage, totalUserPages).map(num => (
                      <button
                        key={num}
                        onClick={() => setUserPage(num)}
                        className={`px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                          userPage === num 
                            ? 'bg-indigo-500 border-indigo-500 text-white shadow-md shadow-indigo-500/10' 
                            : 'bg-zinc-900 border-zinc-850 text-zinc-400 hover:bg-zinc-800 hover:text-white'
                        }`}
                      >
                        {num}
                      </button>
                    ))}
                    <button 
                      disabled={userPage === totalUserPages}
                      onClick={() => setUserPage(prev => prev + 1)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Sau
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {activeMainTab === 'settings' && (
          /* ================= DOWNLOAD LINK SETTINGS VIEW ================= */
          <div className="max-w-2xl bg-zinc-900/60 border border-zinc-900 rounded-xl p-6 space-y-6">
            <div className="flex items-center gap-3 border-b border-zinc-800 pb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                <Settings className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Cấu hình Đường dẫn tải xuống</h3>
                <p className="text-xs text-zinc-500">Quản lý link tải phần mềm Editnhanh</p>
              </div>
            </div>

            <form onSubmit={handleSaveConfig} className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="installerUrl" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  URL bộ cài đặt (.exe / external link)
                </label>
                <input
                  id="installerUrl"
                  type="text"
                  value={installerUrl}
                  onChange={(e) => setInstallerUrl(e.target.value)}
                  placeholder="Ví dụ: https://drive.google.com/... hoặc để trống"
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                />
              </div>

              <div className="pt-2 flex items-center justify-between border-t border-zinc-800/50">
                <div className="text-xs text-zinc-500">
                  {loadingConfig ? 'Đang tải cấu hình hiện tại...' : ''}
                </div>
                <button
                  type="submit"
                  disabled={savingConfig || loadingConfig}
                  className="px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-sm font-semibold text-white rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingConfig ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Đang lưu...</span>
                    </>
                  ) : (
                    <span>Lưu cấu hình</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {activeMainTab === 'plans' && (
          /* ================= PLAN MANAGEMENT VIEW ================= */
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-white">Quản lý Gói dịch vụ</h3>
                <p className="text-xs text-zinc-550">Thêm, sửa, xóa các gói dịch vụ và cấu hình hạn dùng cho phần mềm</p>
              </div>
              <button 
                onClick={() => handleOpenPlanModal(null)} 
                className="px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-sm font-semibold text-white rounded-lg shadow-lg flex items-center gap-2 transition-all cursor-pointer"
              >
                <PlusCircle className="h-4.5 w-4.5" />
                <span>Thêm Gói Mới</span>
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-zinc-900 bg-zinc-900/30">
              <table className="min-w-full divide-y divide-zinc-900 text-left text-sm text-zinc-300">
                <thead className="bg-zinc-900/80 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th scope="col" className="px-6 py-4">ID Gói</th>
                    <th scope="col" className="px-6 py-4">Tên Gói</th>
                    <th scope="col" className="px-6 py-4">Giá Bán</th>
                    <th scope="col" className="px-6 py-4 text-center">Hạn Dùng</th>
                    <th scope="col" className="px-6 py-4">Đánh Dấu</th>
                    <th scope="col" className="px-6 py-4 text-center">Trạng Thái</th>
                    <th scope="col" className="px-6 py-4 text-right">Thao Tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/50 bg-transparent">
                  {loadingPlans ? (
                    <tr>
                      <td colSpan="7" className="px-6 py-12 text-center text-zinc-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                          <span>Đang tải danh sách gói dịch vụ...</span>
                        </div>
                      </td>
                    </tr>
                  ) : plans.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="px-6 py-12 text-center text-zinc-500">
                        Không có gói dịch vụ nào trong Database
                      </td>
                    </tr>
                  ) : (
                    plans.map((p) => {
                      const formattedPrice = p.price === 0 ? 'Miễn phí' : p.price.toLocaleString('vi-VN') + 'đ';
                      return (
                        <tr key={p.id} className="hover:bg-zinc-900/20 transition-colors">
                          <td className="px-6 py-4 font-mono font-bold text-indigo-400 text-xs">{p.id}</td>
                          <td className="px-6 py-4 font-semibold text-white">{p.name}</td>
                          <td className="px-6 py-4 font-semibold text-zinc-300">{formattedPrice}</td>
                          <td className="px-6 py-4 text-center text-zinc-400">{p.durationDays} ngày</td>
                          <td className="px-6 py-4">
                            {p.isPopular ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-900/30">
                                Khuyên dùng
                              </span>
                            ) : (
                              <span className="text-zinc-600 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-center">
                            {p.status === 'active' ? (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-450 border border-emerald-900/35">
                                Hoạt động
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-500 border border-zinc-900/30">
                                Tạm ẩn
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-right space-x-2.5 whitespace-nowrap">
                            <button 
                              onClick={() => handleOpenPlanModal(p)}
                              className="px-2.5 py-1 text-xs font-semibold rounded bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 transition-colors cursor-pointer"
                            >
                              Sửa
                            </button>
                            <button 
                              onClick={() => handleDeletePlan(p.id)}
                              disabled={['trial', 'monthly', 'yearly'].includes(p.id)}
                              className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors border ${
                                ['trial', 'monthly', 'yearly'].includes(p.id)
                                  ? 'bg-zinc-955 border-zinc-900 text-zinc-700 cursor-not-allowed opacity-30'
                                  : 'bg-rose-950/40 border-rose-900/40 hover:bg-rose-900/40 text-rose-400 cursor-pointer'
                              }`}
                            >
                              Xóa
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer Info */}
        <div className="text-center text-xs text-zinc-650 pt-4 flex items-center justify-center gap-2">
          <ShieldCheck className="h-4 w-4 text-zinc-600" />
          <span>Hệ thống bảo vệ bản quyền nâng cao Ed25519 & Local verification engine.</span>
        </div>

      </main>

      {/* Admin Authentication Token Modal */}
      {isAuthModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md transition-opacity duration-300">
          <div className="w-full max-w-md p-8 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl">
            <div className="text-center mb-6">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400 mb-4">
                <Lock className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold text-white">Yêu cầu xác thực Admin</h3>
              <p className="text-sm text-zinc-400 mt-2">Vui lòng nhập Token bảo mật để truy cập bảng quản trị.</p>
            </div>
            <form onSubmit={handleTokenSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Admin Security Token</label>
                <input 
                  type="password" 
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Nhập mã token..." 
                  required
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                />
              </div>
              <button 
                type="submit"
                className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>Xác nhận</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Generate Key Modal */}
      {isGenerateModalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300">
          <div className="w-full max-w-md p-6 rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl relative">
            <button 
              onClick={() => setIsGenerateModalOpen(false)} 
              className="absolute top-4 right-4 text-zinc-450 hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Key className="text-indigo-400 h-5 w-5" />
                <span>Tạo Mã Bản Quyền Mới</span>
              </h3>
            </div>
            <form onSubmit={handleGenerateKey} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1">Tên khách hàng</label>
                <input 
                  type="text" 
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Ví dụ: Nguyễn Văn A..." 
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1">Thời hạn sử dụng (Ngày)</label>
                <input 
                  type="number" 
                  value={licenseDays}
                  onChange={(e) => setLicenseDays(e.target.value)}
                  min="1" 
                  required
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div className="pt-2">
                <button 
                  type="submit"
                  disabled={generating}
                  className="w-full py-2.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-medium rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {generating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Đang tạo key...</span>
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      <span>Tạo Key Ngay</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add/Edit Plan Modal */}
      {isPlanModalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300">
          <div className="w-full max-w-lg p-6 rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button 
              onClick={() => setIsPlanModalOpen(false)} 
              className="absolute top-4 right-4 text-zinc-450 hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Layers className="text-indigo-400 h-5 w-5" />
                <span>{selectedPlan ? 'Cập Nhật Gói Dịch Vụ' : 'Thêm Gói Dịch Vụ Mới'}</span>
              </h3>
            </div>
            <form onSubmit={handleSavePlan} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Mã ID Gói (Viết liền không dấu)</label>
                  <input 
                    type="text" 
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                    placeholder="Ví dụ: monthly, lifetime..." 
                    disabled={!!selectedPlan}
                    required
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Tên Hiển Thị Gói</label>
                  <input 
                    type="text" 
                    value={planName}
                    onChange={(e) => setPlanName(e.target.value)}
                    placeholder="Ví dụ: Gói Tháng, Gói Trọn Đời..." 
                    required
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Giá Bán (đơn vị: VNĐ)</label>
                  <input 
                    type="number" 
                    value={planPrice}
                    onChange={(e) => setPlanPrice(e.target.value)}
                    placeholder="Ví dụ: 199000 (0 nếu là Dùng thử)" 
                    min="0"
                    required
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Hạn Sử Dụng (Ngày)</label>
                  <input 
                    type="number" 
                    value={planDurationDays}
                    onChange={(e) => setPlanDurationDays(e.target.value)}
                    placeholder="Ví dụ: 30, 365..." 
                    min="1"
                    required
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1">Mô tả ngắn của gói</label>
                <input 
                  type="text" 
                  value={planDescription}
                  onChange={(e) => setPlanDescription(e.target.value)}
                  placeholder="Ví dụ: Dành cho Creator sáng tạo thường xuyên..." 
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1">Tính năng đi kèm (Mỗi dòng một tính năng)</label>
                <textarea 
                  value={planFeatures}
                  onChange={(e) => setPlanFeatures(e.target.value)}
                  rows="4"
                  placeholder="Ví dụ:&#10;Đầy đủ tính năng 100%&#10;Sử dụng trên 1 máy tính&#10;Hỗ trợ kỹ thuật 24/7" 
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-medium"
                />
              </div>

              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox"
                    id="planIsPopular"
                    checked={planIsPopular}
                    onChange={(e) => setPlanIsPopular(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500"
                  />
                  <label htmlFor="planIsPopular" className="text-xs font-semibold text-zinc-400 cursor-pointer">Gói nổi bật (Khuyên dùng)</label>
                </div>
                <div className="flex items-center gap-2.5 justify-end">
                  <label className="text-xs font-semibold text-zinc-400">Trạng thái:</label>
                  <select 
                    value={planStatus}
                    onChange={(e) => setPlanStatus(e.target.value)}
                    className="rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1 text-xs text-white focus:outline-none focus:ring-indigo-500"
                  >
                    <option value="active">Hiển thị</option>
                    <option value="inactive">Tạm ẩn</option>
                  </select>
                </div>
              </div>

              <div className="pt-4 border-t border-zinc-800 flex justify-end gap-3">
                <button 
                  type="button"
                  onClick={() => setIsPlanModalOpen(false)}
                  className="px-4 py-2 bg-zinc-950 hover:bg-zinc-900 border border-zinc-850 text-xs font-semibold text-zinc-300 rounded-lg transition-colors cursor-pointer"
                >
                  Hủy
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-xs font-bold text-white rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all cursor-pointer"
                >
                  Lưu Lại
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
