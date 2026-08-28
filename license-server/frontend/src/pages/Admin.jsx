import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Key, X, ShieldCheck, KeyRound, CheckCircle, AlertTriangle, Clock, Search, PlusCircle, Loader2, Copy, ArrowRight, Power, Plus, Users, UserCheck, UserX, Trash2, User, Settings, Layers, Edit2, CreditCard, Banknote, TrendingUp, Home, Eye, EyeOff, Link2, ToggleLeft, ToggleRight, BarChart3, ShoppingBag, BadgePercent, ExternalLink, ChevronUp, ChevronDown, RefreshCcw, Shield, Unlock, Filter } from 'lucide-react';

export default function Admin({ showToast }) {
  const [adminUser, setAdminUser] = useState(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
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
  const [supportEmail, setSupportEmail] = useState('');
  const [supportZalo, setSupportZalo] = useState('');
  const [supportTelegram, setSupportTelegram] = useState('');
  const [bankCode, setBankCode] = useState('MB');
  const [bankAccount, setBankAccount] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [metaPixelId, setMetaPixelId] = useState('');
  const [metaCapiConfigured, setMetaCapiConfigured] = useState(false);
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
  const [planPrice, setPlanPrice] = useState(299000);
  const [planDurationDays, setPlanDurationDays] = useState(30);
  const [planDescription, setPlanDescription] = useState('');
  const [planFeatures, setPlanFeatures] = useState('');
  const [planIsPopular, setPlanIsPopular] = useState(false);
  const [planStatus, setPlanStatus] = useState('active');

  // User Edit Modal states
  const [isUserEditModalOpen, setIsUserEditModalOpen] = useState(false);
  const [editUserEmail, setEditUserEmail] = useState('');
  const [editFullName, setEditFullName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editIsVerified, setEditIsVerified] = useState(false);
  const [editRole, setEditRole] = useState('user');
  const [editIp, setEditIp] = useState('');
  const [editHwid, setEditHwid] = useState('');
  const [editDeviceHwid, setEditDeviceHwid] = useState('');
  const [savingUser, setSavingUser] = useState(false);

  // Password fields inside edit user modal
  const [editNewPassword, setEditNewPassword] = useState('');
  const [editConfirmPassword, setEditConfirmPassword] = useState('');
  const [showEditNewPassword, setShowEditNewPassword] = useState(false);
  const [showEditConfirmPassword, setShowEditConfirmPassword] = useState(false);

  // Payment Transactions states
  const [payments, setPayments] = useState([]);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [paymentPage, setPaymentPage] = useState(1);
  const [totalPaymentPages, setTotalPaymentPages] = useState(1);
  const [totalPaymentItems, setTotalPaymentItems] = useState(0);
  const [paymentSearchText, setPaymentSearchText] = useState('');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('all');
  const [paymentStats, setPaymentStats] = useState({ total: 0, confirmed: 0, pending: 0, totalAmount: 0 });

  // Affiliate states
  const [affStats, setAffStats] = useState(null);
  const [affLinks, setAffLinks] = useState([]);
  const [affOrders, setAffOrders] = useState([]);
  const [affOrdersTotal, setAffOrdersTotal] = useState(0);
  const [affOrdersPage, setAffOrdersPage] = useState(1);
  const [affOrdersTotalPages, setAffOrdersTotalPages] = useState(1);
  const [loadingAff, setLoadingAff] = useState(false);
  const [commissionTiers, setCommissionTiers] = useState([]);
  const [editingTiers, setEditingTiers] = useState(false);
  const [tiersForm, setTiersForm] = useState([]);
  const [savingTiers, setSavingTiers] = useState(false);
  const [isCreateLinkModalOpen, setIsCreateLinkModalOpen] = useState(false);
  const [newLinkEmail, setNewLinkEmail] = useState('');
  const [creatingLink, setCreatingLink] = useState(false);

  // Security / Auth Logs states
  const [authLogs, setAuthLogs] = useState([]);
  const [authLogTotal, setAuthLogTotal] = useState(0);
  const [authLogPage, setAuthLogPage] = useState(1);
  const [authLogLimit, setAuthLogLimit] = useState(20);
  const [authLogTotalPages, setAuthLogTotalPages] = useState(1);
  const [loadingAuthLogs, setLoadingAuthLogs] = useState(false);
  const [authLogFilter, setAuthLogFilter] = useState({ type: '', email: '', ip: '' });
  const [authStats, setAuthStats] = useState(null);
  const [loadingAuthStats, setLoadingAuthStats] = useState(false);

  const getPageNumbers = (curr, total) => {
    const pages = [];
    const start = Math.max(1, curr - 2);
    const end = Math.min(total, curr + 2);
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  // Helper: gọi API Admin kèm cookie phiên, tự mở lại modal đăng nhập khi 401
  const apiFetch = async (url, options = {}) => {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401) {
      setAdminUser(null);
      setIsAuthModalOpen(true);
      const err = new Error('Phiên đăng nhập Admin hết hạn. Vui lòng đăng nhập lại!');
      err.sessionExpired = true;
      throw err;
    }
    return res;
  };

  // Kiểm tra phiên đăng nhập Admin qua cookie JWT
  useEffect(() => {
    const checkAdminSession = async () => {
      try {
        const res = await fetch('/api/admin/me');
        if (res.status === 200) {
          const data = await res.json();
          if (data.success && data.user) {
            setAdminUser(data.user);
          } else {
            setIsAuthModalOpen(true);
          }
        } else {
          setIsAuthModalOpen(true);
        }
      } catch (err) {
        setIsAuthModalOpen(true);
      }
    };
    checkAdminSession();
    localStorage.removeItem('license_admin_token');
  }, []);

  // Fetch Keys when adminUser, page, search, or status tab changes
  useEffect(() => {
    if (adminUser) {
      loadKeys();
    }
  }, [adminUser, currentPage, currentFilterTab]);

  // Reset keys page to 1 when search text changes
  useEffect(() => {
    if (adminUser) {
      if (currentPage === 1) {
        loadKeys();
      } else {
        setCurrentPage(1);
      }
    }
  }, [searchText]);

  // Fetch Users when adminUser or page changes
  useEffect(() => {
    if (adminUser) {
      loadUsers();
    }
  }, [adminUser, userPage]);

  // Reset users page to 1 when search text changes
  useEffect(() => {
    if (adminUser) {
      if (userPage === 1) {
        loadUsers();
      } else {
        setUserPage(1);
      }
    }
  }, [userSearchText]);

  // Fetch config when adminUser is set
  useEffect(() => {
    if (adminUser) {
      loadConfig();
    }
  }, [adminUser]);

  // Fetch Plans when adminUser is set
  useEffect(() => {
    if (adminUser) {
      loadPlans();
    }
  }, [adminUser]);

  // Fetch Payments khi chuyển sang tab payments
  useEffect(() => {
    if (adminUser && activeMainTab === 'payments') {
      loadPayments();
    }
  }, [adminUser, paymentPage, paymentStatusFilter, activeMainTab]);

  useEffect(() => {
    if (adminUser && activeMainTab === 'payments') {
      if (paymentPage === 1) loadPayments();
      else setPaymentPage(1);
    }
  }, [paymentSearchText]);

  // Load affiliate data when switching to affiliate tab
  useEffect(() => {
    if (adminUser && activeMainTab === 'affiliate') {
      loadAffiliateData();
    }
  }, [adminUser, activeMainTab, affOrdersPage]);

  // Load security data when switching to security tab or page/limit changes
  useEffect(() => {
    if (adminUser && activeMainTab === 'security') {
      loadAuthStats();
      loadAuthLogs();
    }
  }, [adminUser, activeMainTab, authLogPage, authLogLimit]);

  // Reload auth logs when filters or limit change (reset to page 1)
  useEffect(() => {
    if (adminUser && activeMainTab === 'security') {
      if (authLogPage === 1) loadAuthLogs();
      else setAuthLogPage(1);
    }
  }, [authLogFilter, authLogLimit]);

  const loadAffiliateData = async () => {
    setLoadingAff(true);
    let hasError = false;

    // Helper: safe fetch + parse JSON
    const safeFetch = async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.status === 401) {
          setAdminUser(null);
          setIsAuthModalOpen(true);
          hasError = true;
          return null;
        }
        const text = await res.text();
        try { return JSON.parse(text); }
        catch { console.error('[AFF] JSON parse error for', url, text.slice(0, 200)); hasError = true; return null; }
      } catch (err) {
        console.error('[AFF] Fetch error for', url, err.message);
        hasError = true;
        return null;
      }
    };

    // Load song song nhưng mỗi cái xử lý độc lập
    const [statsData, linksData, ordersData, tiersData] = await Promise.all([
      safeFetch('/api/admin/affiliate/stats'),
      safeFetch('/api/admin/affiliate/links'),
      safeFetch(`/api/admin/affiliate/orders?page=${affOrdersPage}&limit=15`),
      safeFetch('/api/admin/affiliate/commission-tiers'),
    ]);

    if (statsData?.success) setAffStats(statsData.stats);
    else if (statsData !== null) { console.error('[AFF] stats:', statsData); hasError = true; }

    if (linksData?.success) setAffLinks(linksData.links || []);
    else if (linksData !== null) { console.error('[AFF] links:', linksData); hasError = true; }

    if (ordersData?.success) {
      setAffOrders(ordersData.orders || []);
      setAffOrdersTotal(ordersData.total || 0);
      setAffOrdersTotalPages(ordersData.totalPages || 1);
    } else if (ordersData !== null) { console.error('[AFF] orders:', ordersData); hasError = true; }

    if (tiersData?.success) {
      setCommissionTiers(tiersData.tiers || []);
      setTiersForm(tiersData.tiers ? tiersData.tiers.map(t => ({ ...t })) : []);
    } else if (tiersData !== null) { console.error('[AFF] tiers:', tiersData); hasError = true; }

    if (hasError) showToast('Một số dữ liệu Affiliate tải thất bại. Xem Console để biết chi tiết.', 'error');
    setLoadingAff(false);
  };

  const handleCreateLink = async (e) => {
    e.preventDefault();
    // Sale tự tạo cho mình không cần email, admin mới cần nhập
    if (!isSale && !newLinkEmail.trim()) return;
    setCreatingLink(true);
    try {
      const body = isSale ? {} : { saleEmail: newLinkEmail.trim() };
      const res = await apiFetch('/api/admin/affiliate/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Đã tạo link affiliate thành công!');
        setIsCreateLinkModalOpen(false);
        setNewLinkEmail('');
        loadAffiliateData();
      } else {
        showToast(data.error || 'Lỗi tạo link!', 'error');
      }
    } catch (err) { if (!err.sessionExpired) showToast('Lỗi kết nối!', 'error'); }
    finally { setCreatingLink(false); }
  };

  const handleToggleLink = async (code) => {
    try {
      const res = await apiFetch(`/api/admin/affiliate/links/${code}/toggle`, { method: 'PATCH' });
      const data = await res.json();
      if (data.success) {
        showToast(data.isActive ? 'Đã bật link!' : 'Đã tắt link!');
        loadAffiliateData();
      } else showToast(data.error || 'Lỗi!', 'error');
    } catch (err) { if (!err.sessionExpired) showToast('Lỗi kết nối!', 'error'); }
  };

  const handleDeleteLink = async (code) => {
    if (!window.confirm(`Xóa link affiliate ${code}? Các đơn hàng liên kết sẽ không bị xóa.`)) return;
    try {
      const res = await apiFetch(`/api/admin/affiliate/links/${code}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) { showToast('Đã xóa link!'); loadAffiliateData(); }
      else showToast(data.error || 'Lỗi!', 'error');
    } catch (err) { if (!err.sessionExpired) showToast('Lỗi kết nối!', 'error'); }
  };

  const handleSaveTiers = async () => {
    setSavingTiers(true);
    try {
      const res = await apiFetch('/api/admin/affiliate/commission-tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiers: tiersForm })
      });
      const data = await res.json();
      if (data.success) { showToast('Đã cập nhật bảng hoa hồng!'); setEditingTiers(false); loadAffiliateData(); }
      else showToast(data.error || 'Lỗi!', 'error');
    } catch (err) { if (!err.sessionExpired) showToast('Lỗi kết nối!', 'error'); }
    finally { setSavingTiers(false); }
  };

  const loadPayments = async () => {

    setLoadingPayments(true);
    try {
      const params = new URLSearchParams({ page: paymentPage, limit: 15, search: paymentSearchText, status: paymentStatusFilter });
      const res = await apiFetch(`/api/admin/payment-transactions?${params}`);
      const data = await res.json();
      if (data.success) {
        setPayments(data.transactions || []);
        setTotalPaymentPages(data.totalPages || 1);
        setTotalPaymentItems(data.totalItems || 0);
        if (data.stats) setPaymentStats(data.stats);
      } else {
        showToast(data.error || 'Lỗi khi tải giao dịch!', 'error');
      }
    } catch (err) {
      if (!err.sessionExpired) showToast('Lỗi kết nối: ' + err.message, 'error');
    } finally {
      setLoadingPayments(false);
    }
  };

  const loadPlans = async () => {
    setLoadingPlans(true);
    try {
      const res = await apiFetch('/api/admin/plans');
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
      setPlanPrice(299000);
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

      const res = await apiFetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
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
      const res = await apiFetch(`/api/admin/plans/${id}`, {
        method: 'DELETE'
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
      const res = await apiFetch(`/api/admin/keys?page=${currentPage}&limit=10&search=${encodeURIComponent(searchText)}&status=${currentFilterTab}`);

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
      const res = await apiFetch(`/api/admin/users?page=${userPage}&limit=10&search=${encodeURIComponent(userSearchText)}`);

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
      const res = await apiFetch('/api/admin/config');
      const data = await res.json();
      if (data.success) {
        setInstallerUrl(data.installerUrl || '');
        setSupportEmail(data.supportEmail || '');
        setSupportZalo(data.supportZalo || '');
        setSupportTelegram(data.supportTelegram || '');
        setBankCode(data.bankCode || 'MB');
        setBankAccount(data.bankAccount || '');
        setBankAccountName(data.bankAccountName || '');
        setMetaPixelId(data.metaPixelId || '1048557318333738');
        setMetaCapiConfigured(Boolean(data.metaCapiConfigured));
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
      const res = await apiFetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installerUrl, supportEmail, supportZalo, supportTelegram, bankCode, bankAccount, bankAccountName, metaPixelId })
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

  const handleLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
    } catch (e) { /* bỏ qua lỗi mạng khi đăng xuất */ }
    setAdminUser(null);
    setLoginEmail('');
    setLoginPassword('');
    setRawKeys([]);
    setFilteredKeys([]);
    setUsers([]);
    setFilteredUsers([]);
    setPlans([]);
    setIsAuthModalOpen(true);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    const email = loginEmail.trim().toLowerCase();
    const pwd = loginPassword;
    if (!email || !pwd) {
      showToast('Vui lòng nhập email và mật khẩu!', 'error');
      return;
    }
    setLoginLoading(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: pwd })
      });
      const data = await res.json();
      if (data.success && data.user) {
        setAdminUser(data.user);
        setIsAuthModalOpen(false);
        setLoginPassword('');
        showToast(`Chào mừng ${data.user.fullName || data.user.email}!`);
      } else {
        showToast(data.error || 'Đăng nhập Admin thất bại!', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối khi đăng nhập: ' + err.message, 'error');
    } finally {
      setLoginLoading(false);
    }
  };

  const copyToClipboard = (text, message) => {
    navigator.clipboard.writeText(text).then(() => showToast(message || 'Đã sao chép vào clipboard!')).catch(() => showToast('Lỗi copy!', 'error'));
  };

  const fmtMoney = (n) => n ? n.toLocaleString('vi-VN') + 'đ' : '0đ';

  const handleGenerateKey = async (e) => {
    e.preventDefault();
    if (licenseDays && (isNaN(Number(licenseDays)) || Number(licenseDays) < 0)) {
      showToast('Vui lòng nhập số ngày sử dụng hợp lệ', 'error');
      return;
    }

    setGenerating(true);
    try {
      const res = await apiFetch('/api/admin/generate-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: licenseDays ? Number(licenseDays) : 0, customerName: customerName.trim() })
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
      const res = await apiFetch('/api/admin/reset-hwid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
      const res = await apiFetch('/api/admin/toggle-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
      const res = await apiFetch('/api/admin/update-user-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(email)}`, {
        method: 'DELETE'
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

  const handleOpenUserEdit = (u) => {
    setEditUserEmail(u.email);
    setEditFullName(u.fullName || '');
    setEditPhone(u.phoneNumber || '');
    setEditIsVerified(!!u.isVerified);
    setEditRole(u.role || 'user');
    setEditIp(u.registrationIp && u.registrationIp !== 'unknown' ? (u.registrationIp || '') : '');
    setEditHwid(u.registrationHwid || '');
    setEditDeviceHwid(u.deviceHwid || '');
    // Reset password fields
    setEditNewPassword('');
    setEditConfirmPassword('');
    setShowEditNewPassword(false);
    setShowEditConfirmPassword(false);
    setIsUserEditModalOpen(true);
  };

  const handleSaveUserEdit = async (e) => {
    e.preventDefault();
    if (!editFullName.trim()) {
      showToast('Họ và tên không được để trống!', 'error');
      return;
    }
    // Validate phone neu co nhap
    const phoneDigits = editPhone.replace(/\D/g, '');
    if (phoneDigits) {
      const phoneRegex = /^0\d{9,10}$/;
      if (!phoneRegex.test(phoneDigits)) {
        showToast('Số điện thoại không hợp lệ! Chỉ nhận 10-11 chữ số, bắt đầu bằng 0.', 'error');
        return;
      }
    }
    // Validate password nếu có nhập
    if (editNewPassword) {
      if (editNewPassword.length < 8) {
        showToast('Mật khẩu mới phải có ít nhất 8 ký tự!', 'error');
        return;
      }
      if (editNewPassword !== editConfirmPassword) {
        showToast('Mật khẩu xác nhận không khớp!', 'error');
        return;
      }
    }
    setSavingUser(true);
    try {
      // 1. Cập nhật thông tin thành viên
      const res = await apiFetch('/api/admin/update-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: editUserEmail,
          fullName: editFullName.trim(),
          phoneNumber: phoneDigits,
          isVerified: editIsVerified,
          role: editRole,
          registrationIp: editIp.trim(),
          registrationHwid: editHwid.trim(),
          deviceHwid: editDeviceHwid.trim()
        })
      });
      const data = await res.json();
      if (!(res.status === 200 && data.success)) {
        showToast(data.error || 'Lỗi khi cập nhật thành viên', 'error');
        return;
      }

      // 2. Đổi mật khẩu nếu có nhập
      if (editNewPassword) {
        const pwRes = await apiFetch('/api/admin/change-user-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: editUserEmail, newPassword: editNewPassword })
        });
        const pwData = await pwRes.json();
        if (!(pwRes.status === 200 && pwData.success)) {
          showToast((pwData.error || 'Lỗi khi đổi mật khẩu') + ' (thông tin khác đã lưu)', 'error');
          setIsUserEditModalOpen(false);
          await loadUsers();
          return;
        }
        showToast('Đã cập nhật thành viên và đổi mật khẩu thành công!');
      } else {
        showToast(data.message || 'Cập nhật thành viên thành công!');
      }

      setIsUserEditModalOpen(false);
      await loadUsers();
    } catch (err) {
      showToast('Lỗi kết nối: ' + err.message, 'error');
    } finally {
      setSavingUser(false);
    }
  };



  const getStatusBadge = (k) => {
    const isExpired = k.expiresAt && new Date(k.expiresAt) < new Date();
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
    } else if (k.paymentStatus === 'expired') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-900/30">
          Đã Hủy
        </span>
      );
    } else if (isExpired) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-900/30">
          Hết Hạn
        </span>
      );
    } else if (typeof k.daysLeft === 'number' && k.daysLeft >= 0 && k.daysLeft <= 7) {
      const urgent = k.daysLeft <= 1;
      return (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${urgent ? 'bg-rose-500/10 text-rose-400 border-rose-900/30' : 'bg-amber-500/10 text-amber-500 border-amber-900/30'}`}>
          Sắp Hết Hạn (còn {k.daysLeft} ngày)
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

  // ==========================================
  // Security / Auth Logs Functions
  // ==========================================
  const loadAuthStats = async () => {
    setLoadingAuthStats(true);
    try {
      const res = await fetch('/api/admin/auth-logs/stats', { credentials: 'include' });
      if (res.status === 401) { setAdminUser(null); setIsAuthModalOpen(true); return; }
      const data = await res.json();
      if (data.success) setAuthStats(data);
    } catch (err) {
      console.error('Lỗi load auth stats:', err);
    } finally {
      setLoadingAuthStats(false);
    }
  };

  const loadAuthLogs = async () => {
    setLoadingAuthLogs(true);
    try {
      const params = new URLSearchParams({ page: authLogPage, limit: authLogLimit });
      if (authLogFilter.type) params.set('type', authLogFilter.type);
      if (authLogFilter.email) params.set('email', authLogFilter.email);
      if (authLogFilter.ip) params.set('ip', authLogFilter.ip);
      const res = await fetch(`/api/admin/auth-logs?${params}`, { credentials: 'include' });
      if (res.status === 401) { setAdminUser(null); setIsAuthModalOpen(true); return; }
      const data = await res.json();
      if (data.success) {
        setAuthLogs(data.logs);
        setAuthLogTotal(data.total);
        setAuthLogTotalPages(data.totalPages);
      }
    } catch (err) {
      console.error('Lỗi load auth logs:', err);
    } finally {
      setLoadingAuthLogs(false);
    }
  };

  const handleUnlockAccount = async (email) => {
    if (!confirm(`Mở khóa tài khoản ${email}?`)) return;
    try {
      const res = await fetch('/api/admin/unlock-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (data.success) {
        showToast?.('Đã mở khóa tài khoản ' + email, 'success');
        loadAuthStats();
      } else {
        showToast?.(data.error || 'Lỗi', 'error');
      }
    } catch (err) {
      showToast?.('Lỗi mở khóa: ' + err.message, 'error');
    }
  };

  // Auth log type display helpers
  const authLogTypeLabels = {
    register_success: { label: 'Đăng ký OK', color: 'bg-emerald-500/20 text-emerald-400' },
    register_blocked_email: { label: 'ĐK chặn Email', color: 'bg-red-500/20 text-red-400' },
    register_blocked_ip: { label: 'ĐK chặn IP', color: 'bg-red-500/20 text-red-400' },
    register_blocked_hwid: { label: 'ĐK chặn HWID', color: 'bg-red-500/20 text-red-400' },
    login_success: { label: 'Đăng nhập OK', color: 'bg-emerald-500/20 text-emerald-400' },
    login_failed: { label: 'Sai mật khẩu', color: 'bg-amber-500/20 text-amber-400' },
    login_locked: { label: 'Khóa TK', color: 'bg-red-500/20 text-red-400' },
    admin_login_success: { label: 'Admin OK', color: 'bg-blue-500/20 text-blue-400' },
    admin_login_failed: { label: 'Admin sai', color: 'bg-amber-500/20 text-amber-400' },
    admin_login_locked: { label: 'Admin khóa', color: 'bg-red-500/20 text-red-400' },
  };

  // Role check helpers
  const isSale = adminUser?.role === 'sale';
  const isAdminFull = adminUser?.role === 'admin' || !adminUser; // legacy token also treated as admin

  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100 pb-20">
      
      {/* Header */}
      <header className="border-b border-zinc-900 bg-zinc-900/50 backdrop-blur-lg sticky top-0 z-30">
        <div className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8">
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
              {adminUser && (
                <span className="text-xs text-zinc-400 hidden sm:flex items-center gap-1.5">
                  <UserCheck className="h-3.5 w-3.5 text-indigo-400" />
                  <span className="font-semibold text-zinc-200">{adminUser.fullName || adminUser.email}</span>
                  {adminUser.role === 'sale' ? (
                    <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">Sale</span>
                  ) : adminUser.role === 'admin' ? (
                    <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">Admin</span>
                  ) : null}
                </span>
              )}
              <Link 
                to="/"
                className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 transition-colors flex items-center gap-1.5"
                title="Quay về trang chủ"
              >
                <Home className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Trang chủ</span>
              </Link>
              <button 
                onClick={handleLogout} 
                className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Đăng xuất</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-screen-2xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-4">
        
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
            onClick={() => setActiveMainTab('payments')}
            className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              activeMainTab === 'payments' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <CreditCard className="h-4 w-4" />
            <span>Quản lý Thanh Toán</span>
          </button>
          <button
            onClick={() => setActiveMainTab('affiliate')}
            className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
              activeMainTab === 'affiliate' ? 'border-amber-500 text-amber-400' : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <BadgePercent className="h-4 w-4" />
            <span>Affiliate</span>
          </button>
          {!isSale && (
            <button 
              onClick={() => setActiveMainTab('plans')}
              className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
                activeMainTab === 'plans' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
              }`}
            >
              <Layers className="h-4 w-4" />
              <span>Quản lý Gói dịch vụ</span>
            </button>
          )}
          {!isSale && (
            <button 
              onClick={() => setActiveMainTab('settings')}
              className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
                activeMainTab === 'settings' ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-white'
              }`}
            >
              <Settings className="h-4 w-4" />
              <span>Cấu hình Link tải</span>
            </button>
          )}
          {!isSale && (
            <button 
              onClick={() => setActiveMainTab('security')}
              className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
                activeMainTab === 'security' ? 'border-rose-500 text-rose-400' : 'border-transparent text-zinc-400 hover:text-white'
              }`}
            >
              <Shield className="h-4 w-4" />
              <span>Kiểm soát</span>
            </button>
          )}
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
                <div className="flex flex-wrap rounded-lg bg-zinc-900 p-1 border border-zinc-850 self-start sm:self-auto text-xs font-semibold gap-0.5">
                  {['all', 'active', 'inactive', 'pending_payment', 'suspended', 'expired'].map((tab) => {
                    const isSelected = currentFilterTab === tab;
                    const tabNames = {
                      all: 'Tất cả',
                      active: 'Hoạt động',
                      inactive: 'Chờ kích hoạt',
                      pending_payment: 'Chờ thanh toán',
                      suspended: 'Bị khóa',
                      expired: 'Hết hạn'
                    };
                    return (
                      <button 
                        key={tab}
                        onClick={() => setCurrentFilterTab(tab)}
                        className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
                          isSelected
                            ? tab === 'pending_payment'
                              ? 'bg-yellow-500 text-black shadow-sm'
                              : 'bg-indigo-500 text-white shadow-sm'
                            : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        {tabNames[tab]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                {!isSale && (
                  <button 
                    onClick={() => setIsGenerateModalOpen(true)} 
                    className="w-full md:w-auto px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-sm font-semibold text-white rounded-lg shadow-lg flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <PlusCircle className="h-4.5 w-4.5" />
                    <span>Tạo Key Bản Quyền</span>
                  </button>
                )}
              </div>
            </div>

            {/* Keys Table */}
            <div className="overflow-x-auto rounded-xl border border-zinc-900 bg-zinc-900/30">
              <table className="min-w-full divide-y divide-zinc-900 text-left text-sm text-zinc-300">
                <thead className="bg-zinc-900/80 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th scope="col" className="px-6 py-4">Khách Hàng</th>
                    <th scope="col" className="px-6 py-4 text-center">Gói Dịch Vụ</th>
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
                      <td colSpan="8" className="px-6 py-12 text-center text-zinc-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                          <span>Đang tải danh sách key bản quyền...</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredKeys.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="px-6 py-12 text-center text-zinc-500">
                        Không có mã bản quyền nào khớp với bộ lọc
                      </td>
                    </tr>
                  ) : (
                    filteredKeys.map((k) => {
                      const formattedCreated = new Date(k.createdAt).toLocaleDateString('vi-VN', {
                        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                      });
                      const isPermanent = !k.expiresAt || new Date(k.expiresAt).getFullYear() >= 9999;
                      const formattedExpires = isPermanent ? 'Vĩnh viễn' : new Date(k.expiresAt).toLocaleDateString('vi-VN', {
                        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                      });
                      const isExpired = (k.expiresAt && new Date(k.expiresAt) < new Date()) || k.paymentStatus === 'expired';

                      return (
                        <tr key={k.key} className="hover:bg-zinc-900/20 transition-colors">
                          <td className="px-6 py-4">
                            <div className="font-semibold text-white">{k.customerName || 'Khách lẻ'}</div>
                            {k.userEmail && (
                              <div className="text-xs text-zinc-500 mt-0.5">{k.userEmail}</div>
                            )}
                            {k.userPhone && (
                              <div className="text-xs text-zinc-500">{k.userPhone}</div>
                            )}
                          </td>
                          <td className="px-6 py-4 text-center">
                            {(() => {
                              const isPerm = !k.expiresAt || new Date(k.expiresAt).getFullYear() >= 9999;
                              if (isPerm) {
                                return (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border bg-emerald-955/60 text-emerald-300 border-emerald-900/40">
                                    Vĩnh viễn
                                  </span>
                                );
                              }
                              const pt = (k.planType || '').toLowerCase();
                              const name = k.planName || (pt === 'trial' ? 'Dùng thử' : (pt === 'monthly' ? 'Tháng' : (pt === 'yearly' || pt === 'annual' ? 'Năm' : pt)));
                              let cls = 'bg-zinc-800 text-zinc-300 border-zinc-700';
                              if (pt === 'trial') cls = 'bg-amber-955/60 text-amber-300 border-amber-900/40';
                              else if (pt === 'monthly') cls = 'bg-indigo-955/60 text-indigo-300 border-indigo-900/40';
                              else if (pt === 'yearly' || pt === 'annual') cls = 'bg-purple-955/60 text-purple-300 border-purple-900/40';
                              else if (pt === 'lifetime') cls = 'bg-emerald-955/60 text-emerald-300 border-emerald-900/40';
                              return (
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${cls}`}>
                                  {name}
                                </span>
                              );
                            })()}
                          </td>
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
                            {!isSale ? (
                              <>
                                <button 
                                  onClick={() => handleResetHwid(k.key)}
                                  disabled={!k.hwid || isExpired}
                                  className={`px-2.5 py-1 text-xs rounded font-medium transition-colors border ${
                                    (!k.hwid || isExpired)
                                      ? 'bg-zinc-950 border-zinc-900 text-zinc-650 cursor-not-allowed opacity-30'
                                      : 'bg-zinc-900 border-zinc-800 hover:bg-zinc-800 text-zinc-300 cursor-pointer'
                                  }`}
                                >
                                  Reset HWID
                                </button>
                                <button 
                                  onClick={() => handleToggleKeyStatus(k.key, k.status)}
                                  disabled={isExpired}
                                  className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors border ${
                                    isExpired 
                                      ? 'bg-zinc-950 border-zinc-900 text-zinc-650 cursor-not-allowed opacity-30'
                                      : k.status === 'suspended'
                                        ? 'bg-emerald-600 border-emerald-700 hover:bg-emerald-500 text-white cursor-pointer'
                                        : 'bg-rose-950/40 border-rose-900/40 hover:bg-rose-900/60 text-rose-400 cursor-pointer'
                                  }`}
                                >
                                  {k.status === 'suspended' ? 'Mở khóa' : 'Khóa'}
                                </button>
                              </>
                            ) : (
                              <span className="text-xs italic text-zinc-600">Chỉ xem</span>
                            )}
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
                      onClick={() => setCurrentPage(1)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                      title="Về trang đầu"
                    >
                      Đầu
                    </button>
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
                    <button 
                      disabled={currentPage === totalPages}
                      onClick={() => setCurrentPage(totalPages)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                      title="Đến trang cuối"
                    >
                      Cuối
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
                  placeholder="Tìm kiếm theo Tên, Email, Số điện thoại, IP, HWID..." 
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
                    <th scope="col" className="px-6 py-4">IP Đăng Ký</th>
                    <th scope="col" className="px-6 py-4">HWID Thiết Bị</th>
                    <th scope="col" className="px-6 py-4">Ngày Tham Gia</th>
                    <th scope="col" className="px-6 py-4 text-right">Thao Tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/50 bg-transparent">
                  {loadingUsers ? (
                    <tr>
                      <td colSpan="8" className="px-6 py-12 text-center text-zinc-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                          <span>Đang tải danh sách thành viên...</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="px-6 py-12 text-center text-zinc-500">
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
                            ) : u.role === 'sale' ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                Sale
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
                          <td className="px-6 py-4 text-[11px] font-mono text-zinc-400" title={u.registrationIp || ''}>
                            {u.registrationIp && u.registrationIp !== 'unknown' ? u.registrationIp : <span className="italic text-zinc-700">N/A</span>}
                          </td>
                          <td className="px-6 py-4 text-[10px] font-mono text-zinc-500 max-w-[120px] truncate" title={(u.deviceHwid || u.registrationHwid) || ''}>
                            {(u.deviceHwid || u.registrationHwid) ? (u.deviceHwid || u.registrationHwid).slice(0, 12) + '...' : <span className="italic text-zinc-700">N/A</span>}
                          </td>
                          <td className="px-6 py-4 text-xs text-zinc-500">{formattedJoined}</td>
                          <td className="px-6 py-4 text-right space-x-1.5 whitespace-nowrap">
                            {!isSale ? (
                              <>
                                <button
                                  onClick={() => handleOpenUserEdit(u)}
                                  className="p-1 px-1.5 bg-indigo-950/40 border border-indigo-900/40 hover:bg-indigo-900 hover:text-white text-indigo-400 rounded transition-colors cursor-pointer"
                                  title="Sửa thông tin thành viên"
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </button>
                                <button 
                                  onClick={() => handleDeleteUser(u.email)}
                                  className="p-1 px-1.5 bg-rose-950/40 border border-rose-900/40 hover:bg-rose-900 hover:text-white text-rose-400 rounded transition-colors cursor-pointer"
                                  title="Xóa tài khoản người dùng"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <span className="text-xs italic text-zinc-600">Chỉ xem</span>
                            )}
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
                      onClick={() => setUserPage(1)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                      title="Về trang đầu"
                    >
                      Đầu
                    </button>
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
                    <button 
                      disabled={userPage === totalUserPages}
                      onClick={() => setUserPage(totalUserPages)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-850 hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all disabled:opacity-30 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-400 disabled:cursor-not-allowed cursor-pointer"
                      title="Đến trang cuối"
                    >
                      Cuối
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

              <div className="border-t border-zinc-800/50 pt-4 space-y-4">
                <p className="text-xs font-bold text-white uppercase tracking-wider">Thông tin liên hệ & Hỗ trợ</p>
                <div className="space-y-2">
                  <label htmlFor="supportEmail" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">Email hỗ trợ</label>
                  <input
                    id="supportEmail"
                    type="text"
                    value={supportEmail}
                    onChange={(e) => setSupportEmail(e.target.value)}
                    placeholder="support@editnhanh.com"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="supportZalo" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">Số điện thoại Zalo</label>
                  <input
                    id="supportZalo"
                    type="text"
                    value={supportZalo}
                    onChange={(e) => setSupportZalo(e.target.value)}
                    placeholder="Ví dụ: 0988.xxx.xxx"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="supportTelegram" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">Telegram (username)</label>
                  <input
                    id="supportTelegram"
                    type="text"
                    value={supportTelegram}
                    onChange={(e) => setSupportTelegram(e.target.value)}
                    placeholder="Ví dụ: @editnhanh_support"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                  />
                </div>
              </div>

              <div className="border-t border-zinc-800/50 pt-4 space-y-4">
                <p className="text-xs font-bold text-white uppercase tracking-wider">Thông tin tài khoản ngân hàng (VietQR)</p>
                <div className="space-y-2">
                  <label htmlFor="bankCode" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">Mã ngân hàng (Bank Code)</label>
                  <input
                    id="bankCode"
                    type="text"
                    value={bankCode}
                    onChange={(e) => setBankCode(e.target.value)}
                    placeholder="Ví dụ: MB, TCB, VCB, ACB..."
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="bankAccount" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">Số tài khoản</label>
                  <input
                    id="bankAccount"
                    type="text"
                    value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value)}
                    placeholder="Ví dụ: 0385464403"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="bankAccountName" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">Tên chủ tài khoản (IN HOA)</label>
                  <input
                    id="bankAccountName"
                    type="text"
                    value={bankAccountName}
                    onChange={(e) => setBankAccountName(e.target.value.toUpperCase())}
                    placeholder="Ví dụ: NGUYEN VAN A"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-mono uppercase"
                  />
                </div>
              </div>

              <div className="border-t border-zinc-800/50 pt-4 space-y-4">
                <p className="text-xs font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-2">
                  <span>Cấu hình Meta Ads Pixel & CAPI</span>
                </p>
                <div className="space-y-2">
                  <label htmlFor="metaPixelId" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">Meta Pixel ID</label>
                  <input
                    id="metaPixelId"
                    type="text"
                    value={metaPixelId}
                    onChange={(e) => setMetaPixelId(e.target.value)}
                    placeholder="Ví dụ: 1048557318333738"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-850 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-mono"
                  />
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-4 py-3">
                  <p className="text-xs font-semibold text-zinc-300">Meta CAPI Token</p>
                  <p className={`mt-1 text-[11px] ${metaCapiConfigured ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {metaCapiConfigured ? 'Đã cấu hình an toàn bằng biến môi trường trên server.' : 'Chưa cấu hình META_CAPI_ACCESS_TOKEN trên server.'}
                  </p>
                </div>
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

        {activeMainTab === 'payments' && (
          <div className="space-y-6">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Tổng Giao Dịch</p>
                  <h3 className="text-2xl font-bold mt-1 text-white">{paymentStats.total}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-400">
                  <CreditCard className="h-5 w-5" />
                </div>
              </div>
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Tổng Tiền Nhận</p>
                  <h3 className="text-xl font-bold mt-1 text-emerald-400">{paymentStats.totalAmount.toLocaleString('vi-VN')}đ</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                  <Banknote className="h-5 w-5" />
                </div>
              </div>
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Đã Xác Nhận</p>
                  <h3 className="text-2xl font-bold mt-1 text-emerald-500">{paymentStats.confirmed}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                  <CheckCircle className="h-5 w-5" />
                </div>
              </div>
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Đang Chờ</p>
                  <h3 className="text-2xl font-bold mt-1 text-amber-500">{paymentStats.pending}</h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
                  <Clock className="h-5 w-5" />
                </div>
              </div>
            </div>

            {/* Controls Bar */}
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 h-4 w-4 text-zinc-500" />
                <input
                  type="text"
                  value={paymentSearchText}
                  onChange={(e) => setPaymentSearchText(e.target.value)}
                  placeholder="Tìm theo email, tên khách, nội dung chuyển khoản, mã SePay..."
                  className="w-full rounded-lg bg-zinc-900 border border-zinc-800 pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div className="flex rounded-lg bg-zinc-900 p-1 border border-zinc-800 self-start sm:self-auto text-xs font-semibold">
                {[['all', 'Tất cả'], ['confirm', 'Xác nhận'], ['pending', 'Chờ xử lý']].map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => { setPaymentStatusFilter(val); setPaymentPage(1); }}
                    className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
                      paymentStatusFilter === val ? 'bg-indigo-500 text-white shadow-sm' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={loadPayments}
                disabled={loadingPayments}
                className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs font-semibold text-zinc-300 transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                {loadingPayments ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />}
                <span>Làm mới</span>
              </button>
            </div>

            {/* Transactions Table */}
            <div className="overflow-x-auto rounded-xl border border-zinc-900 bg-zinc-900/30">
              <table className="min-w-full divide-y divide-zinc-900 text-left text-sm text-zinc-300">
                <thead className="bg-zinc-900/80 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <tr>
                    <th scope="col" className="px-4 py-4 w-8">#</th>
                    <th scope="col" className="px-4 py-4">Khách Hàng</th>
                    <th scope="col" className="px-4 py-4">Email</th>
                    <th scope="col" className="px-4 py-4">SĐT</th>
                    <th scope="col" className="px-4 py-4">Gói DV</th>
                    <th scope="col" className="px-4 py-4 text-right">Số Tiền</th>
                    <th scope="col" className="px-5 py-4">Nội Dung CK</th>
                    <th scope="col" className="px-4 py-4">Mã SePay</th>
                    <th scope="col" className="px-4 py-4">Thời Gian</th>
                    <th scope="col" className="px-4 py-4 text-center">Trạng Thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/50 bg-transparent">
                  {loadingPayments ? (
                    <tr>
                      <td colSpan="10" className="px-6 py-12 text-center text-zinc-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                          <span>Đang tải danh sách giao dịch...</span>
                        </div>
                      </td>
                    </tr>
                  ) : payments.length === 0 ? (
                    <tr>
                      <td colSpan="10" className="px-6 py-16 text-center">
                        <div className="flex flex-col items-center gap-3 text-zinc-500">
                          <CreditCard className="h-10 w-10 text-zinc-700" />
                          <p className="text-sm">Chưa có giao dịch nào được ghi nhận</p>
                          <p className="text-xs text-zinc-600">Giao dịch xuất hiện khi SePay postback về sau khi khách chuyển khoản</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    payments.map((tx, idx) => {
                      const paidDate = tx.paidAt ? new Date(tx.paidAt) : null;
                      const dateStr = paidDate ? paidDate.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—';
                      const timeStr = paidDate ? paidDate.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '';
                      const isConfirm = tx.status === 'confirm';
                      return (
                        <tr key={tx._id || tx.transactionId || idx} className="hover:bg-zinc-900/40 transition-colors">
                          <td className="px-4 py-4 text-xs text-zinc-600">{(paymentPage - 1) * 15 + idx + 1}</td>
                          <td className="px-4 py-4">
                            <span className="font-medium text-white text-xs">{tx.customerName || <span className="italic text-zinc-600">Ẩn danh</span>}</span>
                            {tx.licenseKey && (
                              <p className="text-[10px] font-mono text-zinc-600 truncate max-w-[130px]" title={tx.licenseKey}>{tx.licenseKey}</p>
                            )}
                          </td>
                          <td className="px-4 py-4 text-xs text-zinc-400">{tx.userEmail || <span className="italic text-zinc-700">—</span>}</td>
                          <td className="px-4 py-4 text-xs font-mono text-zinc-400">{tx.phoneNumber || <span className="italic text-zinc-700">—</span>}</td>
                          <td className="px-4 py-4">
                            {tx.planType ? (
                              <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                {tx.planType}
                              </span>
                            ) : <span className="text-zinc-700 italic text-xs">—</span>}
                          </td>
                          <td className="px-4 py-4 text-right">
                            <span className={`font-mono font-bold text-sm ${isConfirm ? 'text-emerald-400' : 'text-zinc-300'}`}>
                              {tx.amount.toLocaleString('vi-VN')}đ
                            </span>
                          </td>
                          <td className="px-5 py-4 max-w-[200px]">
                            <p className="text-xs text-zinc-400 truncate" title={tx.content}>{tx.content || '—'}</p>
                          </td>
                          <td className="px-4 py-4">
                            <span className="text-xs font-mono text-zinc-500">{tx.transferCode || tx.transactionId || '—'}</span>
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap">
                            <p className="text-xs text-zinc-300">{dateStr}</p>
                            <p className="text-[10px] text-zinc-600">{timeStr}</p>
                          </td>
                          <td className="px-4 py-4 text-center">
                            {isConfirm ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-900/30">
                                <CheckCircle className="h-3 w-3" />
                                Confirm
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-900/30">
                                <Clock className="h-3 w-3" />
                                Pending
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPaymentPages > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">
                  Hiển thị {Math.min((paymentPage - 1) * 15 + 1, totalPaymentItems)}–{Math.min(paymentPage * 15, totalPaymentItems)} / {totalPaymentItems} giao dịch
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPaymentPage(p => Math.max(1, p - 1))} disabled={paymentPage === 1} className="px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors">←</button>
                  {getPageNumbers(paymentPage, totalPaymentPages).map(p => (
                    <button key={p} onClick={() => setPaymentPage(p)} className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer ${p === paymentPage ? 'bg-indigo-500 text-white' : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'}`}>{p}</button>
                  ))}
                  <button onClick={() => setPaymentPage(p => Math.min(totalPaymentPages, p + 1))} disabled={paymentPage === totalPaymentPages} className="px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors">→</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========== AFFILIATE TAB ========== */}
        {activeMainTab === 'affiliate' && (
          <div className="space-y-6">
            {loadingAff ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
                <span className="ml-3 text-zinc-400">Đang tải dữ liệu Affiliate...</span>
              </div>
            ) : (
              <>
              {/* Stats Cards */}
              {affStats && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-5 bg-zinc-900/60 border border-amber-900/30 rounded-xl flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Link hoạt động</p>
                      <h3 className="text-2xl font-bold mt-1 text-white">{affStats.activeLinks}<span className="text-sm text-zinc-500 font-normal">/{affStats.totalLinks}</span></h3>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
                      <Link2 className="h-5 w-5" />
                    </div>
                  </div>
                  <div className="p-5 bg-zinc-900/60 border border-amber-900/30 rounded-xl flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Đơn hàng (năm)</p>
                      <h3 className="text-2xl font-bold mt-1 text-white">{affStats.yearOrders}<span className="text-sm text-zinc-500 font-normal"> đơn</span></h3>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                      <ShoppingBag className="h-5 w-5" />
                    </div>
                  </div>
                  <div className="p-5 bg-zinc-900/60 border border-amber-900/30 rounded-xl flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Doanh số (năm)</p>
                      <h3 className="text-xl font-bold mt-1 text-emerald-400">{fmtMoney(affStats.yearRevenue)}</h3>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                      <TrendingUp className="h-5 w-5" />
                    </div>
                  </div>
                  <div className="p-5 bg-zinc-900/60 border border-amber-900/30 rounded-xl flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Hoa hồng (năm)</p>
                      <h3 className="text-xl font-bold mt-1 text-amber-400">{fmtMoney(affStats.yearCommission)}</h3>
                    </div>
                    <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
                      <BadgePercent className="h-5 w-5" />
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Commission Tiers */}
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-amber-400" />
                      Bảng Bậc Hoa Hồng
                    </h3>
                    {!isSale && (
                      <button
                        onClick={() => { setEditingTiers(!editingTiers); setTiersForm(commissionTiers.map(t => ({ ...t }))); }}
                        className="text-xs text-amber-400 hover:text-amber-300 font-semibold cursor-pointer transition-colors flex items-center gap-1"
                      >
                        <Edit2 className="h-3 w-3" />
                        {editingTiers ? 'Hủy' : 'Chỉnh sửa'}
                      </button>
                    )}
                  </div>
                  <div className="space-y-2">
                    {(editingTiers ? tiersForm : commissionTiers).map((tier, idx) => (
                      <div key={idx} className="flex items-center justify-between text-xs rounded-lg px-3 py-2 bg-zinc-950/50 border border-zinc-800/60">
                        <span className="text-zinc-400 font-medium">
                          {tier.minRevenue >= 1000000
                            ? (tier.minRevenue / 1000000).toFixed(0) + 'tr'
                            : '0'} – {tier.maxRevenue === Infinity || tier.maxRevenue >= 10000000000
                            ? '∞'
                            : (tier.maxRevenue / 1000000).toFixed(0) + 'tr'}đ
                        </span>
                        {editingTiers ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.5"
                              value={tier.rate}
                              onChange={e => {
                                const f = [...tiersForm];
                                f[idx] = { ...f[idx], rate: parseFloat(e.target.value) || 0 };
                                setTiersForm(f);
                              }}
                              className="w-14 rounded bg-zinc-900 border border-amber-600/40 px-2 py-0.5 text-amber-400 font-bold text-center focus:outline-none"
                            />
                            <span className="text-zinc-500">%</span>
                          </div>
                        ) : (
                          <span className="font-bold text-amber-400">{tier.rate}%</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {editingTiers && (
                    <button
                      onClick={handleSaveTiers}
                      disabled={savingTiers}
                      className="mt-4 w-full py-2 bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1"
                    >
                      {savingTiers ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Lưu bảng hoa hồng
                    </button>
                  )}
                </div>

                {/* Links List */}
                <div className="lg:col-span-2 bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-amber-400" />
                      Danh sách Link Affiliate
                    </h3>
                    <div className="flex gap-2">
                      <button
                        onClick={loadAffiliateData}
                        className="text-zinc-500 hover:text-white transition-colors cursor-pointer p-1 rounded"
                      >
                        <RefreshCcw className="h-3.5 w-3.5" />
                      </button>
                      {!isSale && (
                        <button
                          onClick={() => setIsCreateLinkModalOpen(true)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold rounded-lg transition-colors cursor-pointer"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Tạo Link Mới
                        </button>
                      )}
                      {isSale && (
                        <button
                          onClick={() => setIsCreateLinkModalOpen(true)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold rounded-lg transition-colors cursor-pointer"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Tạo Link Của Tôi
                        </button>
                      )}
                    </div>
                  </div>
                  {affLinks.length === 0 ? (
                    <div className="text-center py-10 text-zinc-600 text-sm">Chưa có link affiliate nào.</div>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {affLinks.map(link => (
                        <div key={link.code} className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border ${link.isActive ? 'border-zinc-800 bg-zinc-950/40' : 'border-zinc-900/50 bg-zinc-950/20 opacity-60'}`}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">{link.code}</span>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${link.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-700/30 text-zinc-500'}`}>
                                {link.isActive ? 'Hoạt động' : 'Tắt'}
                              </span>
                            </div>
                            <p className="text-xs text-zinc-400 mt-1 truncate">{link.saleName} — <span className="text-zinc-500">{link.saleEmail}</span></p>
                            <div className="flex items-center gap-3 mt-1 text-[10px] text-zinc-500">
                              <span>👆 {link.clickCount} click</span>
                              <span>📦 {link.orderCount} đơn</span>
                              <span>💰 {fmtMoney(link.totalRevenue)}</span>
                              <span>🏆 {fmtMoney(link.totalCommission)}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => copyToClipboard(link.url)}
                              title="Copy link"
                              className="p-1.5 rounded-md bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            {!isSale && (
                              <>
                                <button
                                  onClick={() => handleToggleLink(link.code)}
                                  title={link.isActive ? 'Tắt link' : 'Bật link'}
                                  className="p-1.5 rounded-md bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-amber-400 transition-colors cursor-pointer"
                                >
                                  {link.isActive ? <ToggleRight className="h-3.5 w-3.5 text-emerald-400" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                                </button>
                                <button
                                  onClick={() => handleDeleteLink(link.code)}
                                  title="Xóa link"
                                  className="p-1.5 rounded-md bg-zinc-900 hover:bg-rose-900/30 text-zinc-400 hover:text-rose-400 transition-colors cursor-pointer"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Orders Table */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <ShoppingBag className="h-4 w-4 text-indigo-400" />
                    Đơn Hàng qua Affiliate
                    <span className="text-xs font-normal text-zinc-500">({affOrdersTotal} đơn)</span>
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-zinc-900 text-left text-sm text-zinc-300">
                    <thead className="bg-zinc-900/80 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      <tr>
                        <th className="px-4 py-3">Khách hàng</th>
                        <th className="px-4 py-3">Email / SĐT</th>
                        <th className="px-4 py-3">Gói mua</th>
                        <th className="px-4 py-3 text-right">Số tiền</th>
                        {!isSale && <th className="px-4 py-3">Sale phụ trách</th>}
                        <th className="px-4 py-3 text-center">Hoa hồng</th>
                        <th className="px-4 py-3">Ngày giờ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900/50 bg-transparent">
                      {affOrders.length === 0 ? (
                        <tr>
                          <td colSpan="7" className="px-4 py-10 text-center text-zinc-600 text-sm">
                            Chưa có đơn hàng nào qua affiliate.
                          </td>
                        </tr>
                      ) : (
                        affOrders.map((order, idx) => (
                          <tr key={idx} className="hover:bg-zinc-900/40 transition-colors">
                            <td className="px-4 py-3 font-medium text-white text-xs">{order.customerName || '—'}</td>
                            <td className="px-4 py-3 text-xs">
                              <div className="text-zinc-300">{order.customerEmail}</div>
                              {order.customerPhone && <div className="text-zinc-500 text-[10px]">{order.customerPhone}</div>}
                            </td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-900/50">
                                {order.planType || '—'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-emerald-400 text-xs">{fmtMoney(order.amount)}</td>
                            {!isSale && (
                              <td className="px-4 py-3 text-xs">
                                <div className="text-zinc-300">{order.saleName}</div>
                                <div className="text-zinc-500 text-[10px]">{order.saleEmail}</div>
                              </td>
                            )}
                            <td className="px-4 py-3 text-center">
                              <span className="text-amber-400 font-bold text-xs">{fmtMoney(order.commissionAmount)}</span>
                              <div className="text-zinc-500 text-[10px]">{order.commissionRate}%</div>
                            </td>
                            <td className="px-4 py-3 text-zinc-500 text-xs">
                              {new Date(order.paidAt).toLocaleDateString('vi-VN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {affOrdersTotalPages > 1 && (
                  <div className="px-5 py-3 border-t border-zinc-900 flex items-center justify-between">
                    <p className="text-xs text-zinc-500">Trang {affOrdersPage}/{affOrdersTotalPages}</p>
                    <div className="flex gap-1.5">
                      <button onClick={() => setAffOrdersPage(p => Math.max(1, p - 1))} disabled={affOrdersPage === 1}
                        className="px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-white disabled:opacity-40 cursor-pointer">←</button>
                      <button onClick={() => setAffOrdersPage(p => Math.min(affOrdersTotalPages, p + 1))} disabled={affOrdersPage === affOrdersTotalPages}
                        className="px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-white disabled:opacity-40 cursor-pointer">→</button>
                    </div>
                  </div>
                )}
              </div>
              </>
            )}
          </div>
        )}

        {/* ========== SECURITY / AUTH LOGS TAB ========== */}
        {activeMainTab === 'security' && (
          <div className="space-y-6">
            {/* Stats Cards — 4 main cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {/* ĐK bị chặn */}
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between group hover:border-red-500/20 transition-colors">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">ĐK bị chặn (24h)</p>
                  <h3 className="text-2xl font-bold mt-1 text-red-400">
                    {authStats ? ((authStats.stats24h?.register_blocked_email || 0) + (authStats.stats24h?.register_blocked_ip || 0) + (authStats.stats24h?.register_blocked_hwid || 0)) : '—'}
                  </h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-red-500/10 flex items-center justify-center text-red-400 group-hover:bg-red-500/20 transition-colors">
                  <UserX className="h-5 w-5" />
                </div>
              </div>

              {/* Login thất bại */}
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between group hover:border-amber-500/20 transition-colors">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Login thất bại (24h)</p>
                  <h3 className="text-2xl font-bold mt-1 text-amber-400">
                    {authStats ? (authStats.stats24h?.login_failed || 0) : '—'}
                  </h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 group-hover:bg-amber-500/20 transition-colors">
                  <AlertTriangle className="h-5 w-5" />
                </div>
              </div>

              {/* Admin thất bại */}
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between group hover:border-orange-500/20 transition-colors">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Admin thất bại (24h)</p>
                  <h3 className="text-2xl font-bold mt-1 text-orange-400">
                    {authStats ? (authStats.stats24h?.admin_login_failed || 0) : '—'}
                  </h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-400 group-hover:bg-orange-500/20 transition-colors">
                  <ShieldCheck className="h-5 w-5" />
                </div>
              </div>

              {/* TK đang bị khóa */}
              <div className="p-5 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center justify-between group hover:border-rose-500/20 transition-colors">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">TK đang bị khóa</p>
                  <h3 className="text-2xl font-bold mt-1 text-rose-400">
                    {authStats ? authStats.lockedCount : '—'}
                  </h3>
                </div>
                <div className="h-10 w-10 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400 group-hover:bg-rose-500/20 transition-colors">
                  <Lock className="h-5 w-5" />
                </div>
              </div>
            </div>

            {/* Row 2: Top IP + Đăng ký/Đăng nhập thành công */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Đăng ký thành công */}
              <div className="p-4 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center gap-4">
                <div className="h-9 w-9 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                  <UserCheck className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Đăng ký thành công (24h)</p>
                  <div className="mt-0.5">
                    <span className="text-2xl font-bold text-emerald-400">{authStats?.stats24h?.register_success || 0}</span>
                  </div>
                </div>
              </div>

              {/* Đăng nhập thành công */}
              <div className="p-4 bg-zinc-900/60 border border-zinc-900 rounded-xl flex items-center gap-4">
                <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                  <CheckCircle className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Login thành công (24h)</p>
                  <div className="mt-0.5">
                    <span className="text-2xl font-bold text-blue-400">{authStats?.stats24h?.login_success || 0}</span>
                  </div>
                </div>
              </div>

              {/* Top IP vi phạm */}
              <div className="p-4 bg-zinc-900/60 border border-zinc-900 rounded-xl">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2.5 flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3 text-red-400" /> Top IP vi phạm (24h)
                </p>
                {authStats?.topIPs24h?.length > 0 ? (
                  <div className="space-y-1.5">
                    {authStats.topIPs24h.slice(0, 3).map((item, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${i === 0 ? 'bg-red-400' : i === 1 ? 'bg-orange-400' : 'bg-amber-400'}`} />
                          <span className="text-xs text-zinc-300 font-mono truncate max-w-[140px]">{item.ip}</span>
                        </div>
                        <span className="text-xs text-red-400 font-bold bg-red-500/10 px-2 py-0.5 rounded-full">{item.count}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-600 italic">Không có vi phạm</p>
                )}
              </div>
            </div>

            {/* Locked Accounts Alert Section */}
            {authStats?.lockedAccounts?.length > 0 && (
              <div className="bg-gradient-to-r from-red-500/5 to-orange-500/5 border border-red-500/15 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-red-500/10 flex items-center gap-3">
                  <div className="h-7 w-7 rounded-lg bg-red-500/15 flex items-center justify-center">
                    <Lock className="h-3.5 w-3.5 text-red-400" />
                  </div>
                  <h3 className="text-sm font-bold text-red-400">
                    Tài khoản đang bị khóa tạm
                    <span className="ml-2 text-xs font-normal bg-red-500/20 text-red-300 px-2 py-0.5 rounded-full">{authStats.lockedAccounts.length}</span>
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm text-zinc-300">
                    <thead>
                      <tr className="text-[10px] text-zinc-500 uppercase tracking-wider">
                        <th className="px-5 py-2.5">Email</th>
                        <th className="px-5 py-2.5">Tên</th>
                        <th className="px-5 py-2.5">Role</th>
                        <th className="px-5 py-2.5">Sai lần</th>
                        <th className="px-5 py-2.5">Khóa đến</th>
                        <th className="px-5 py-2.5 text-right">Hành động</th>
                      </tr>
                    </thead>
                    <tbody>
                      {authStats.lockedAccounts.map((acc, i) => (
                        <tr key={i} className="border-t border-red-500/5 hover:bg-red-500/5 transition-colors">
                          <td className="px-5 py-2.5 font-mono text-xs text-zinc-200">{acc.email}</td>
                          <td className="px-5 py-2.5 text-xs">{acc.fullName}</td>
                          <td className="px-5 py-2.5">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${acc.role === 'admin' ? 'bg-purple-500/20 text-purple-400' : acc.role === 'sale' ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-700 text-zinc-400'}`}>
                              {acc.role}
                            </span>
                          </td>
                          <td className="px-5 py-2.5">
                            <span className="text-xs text-red-400 font-bold bg-red-500/10 px-2 py-0.5 rounded-full">{acc.failedLoginAttempts}/{5}</span>
                          </td>
                          <td className="px-5 py-2.5 text-xs text-zinc-400">
                            <Clock className="h-3 w-3 inline mr-1 -mt-0.5" />
                            {new Date(acc.lockUntil).toLocaleString('vi-VN')}
                          </td>
                          <td className="px-5 py-2.5 text-right">
                            <button onClick={() => handleUnlockAccount(acc.email)} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 rounded-lg text-xs font-semibold transition-all cursor-pointer">
                              <Unlock className="h-3 w-3" /> Mở khóa
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Filter Bar — wrapped in card */}
            <div className="bg-zinc-900/40 border border-zinc-900 rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-zinc-400">
                  <Filter className="h-3.5 w-3.5" /> Bộ lọc
                </div>
                <div className="h-4 w-px bg-zinc-800" />
                <select
                  value={authLogFilter.type}
                  onChange={(e) => setAuthLogFilter(prev => ({ ...prev, type: e.target.value }))}
                  className="bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-rose-500/50 cursor-pointer hover:bg-zinc-800 transition-colors"
                >
                  <option value="">Tất cả loại</option>
                  <optgroup label="— Đăng ký —">
                    <option value="register_success">✅ Đăng ký thành công</option>
                    <option value="register_blocked_email">🔴 Chặn: Email trùng</option>
                    <option value="register_blocked_ip">🔴 Chặn: IP trùng</option>
                    <option value="register_blocked_hwid">🔴 Chặn: HWID trùng</option>
                  </optgroup>
                  <optgroup label="— Đăng nhập —">
                    <option value="login_success">✅ Đăng nhập OK</option>
                    <option value="login_failed">🟡 Sai mật khẩu</option>
                    <option value="login_locked">🔴 Khóa tài khoản</option>
                  </optgroup>
                  <optgroup label="— Admin —">
                    <option value="admin_login_success">🔵 Admin đăng nhập OK</option>
                    <option value="admin_login_failed">🟡 Admin sai mật khẩu</option>
                    <option value="admin_login_locked">🔴 Admin bị khóa</option>
                  </optgroup>
                </select>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3 w-3 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="Tìm theo email..."
                    value={authLogFilter.email}
                    onChange={(e) => setAuthLogFilter(prev => ({ ...prev, email: e.target.value }))}
                    className="bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 text-xs rounded-lg pl-7 pr-3 py-2 w-44 focus:outline-none focus:ring-1 focus:ring-rose-500/50 hover:bg-zinc-800 transition-colors"
                  />
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3 w-3 text-zinc-500" />
                  <input
                    type="text"
                    placeholder="Tìm theo IP..."
                    value={authLogFilter.ip}
                    onChange={(e) => setAuthLogFilter(prev => ({ ...prev, ip: e.target.value }))}
                    className="bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 text-xs rounded-lg pl-7 pr-3 py-2 w-36 focus:outline-none focus:ring-1 focus:ring-rose-500/50 hover:bg-zinc-800 transition-colors"
                  />
                </div>
                {(authLogFilter.type || authLogFilter.email || authLogFilter.ip) && (
                  <button
                    onClick={() => { setAuthLogFilter({ type: '', email: '', ip: '' }); }}
                    className="flex items-center gap-1 text-xs text-zinc-500 hover:text-rose-400 transition-colors cursor-pointer"
                  >
                    <X className="h-3 w-3" /> Xóa bộ lọc
                  </button>
                )}
                <button
                  onClick={() => { loadAuthStats(); loadAuthLogs(); }}
                  className="ml-auto flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 rounded-lg transition-all cursor-pointer"
                >
                  <RefreshCcw className={`h-3 w-3 ${loadingAuthLogs || loadingAuthStats ? 'animate-spin' : ''}`} /> Làm mới
                </button>
              </div>
            </div>

            {/* Auth Logs Table */}
            <div className="bg-zinc-900/40 border border-zinc-900 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-zinc-900 flex justify-between items-center">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-rose-400" />
                  Nhật ký kiểm soát truy cập
                </h3>
                <span className="text-xs text-zinc-500 bg-zinc-800 px-3 py-1 rounded-full">{authLogTotal} bản ghi</span>
              </div>
              {loadingAuthLogs ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                  <Loader2 className="h-6 w-6 animate-spin text-rose-400" />
                  <span className="text-xs text-zinc-500">Đang tải dữ liệu...</span>
                </div>
              ) : authLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 gap-2">
                  <Shield className="h-8 w-8 text-zinc-700" />
                  <p className="text-sm text-zinc-500">Không có bản ghi nào</p>
                  <p className="text-xs text-zinc-600">Các sự kiện đăng nhập/đăng ký sẽ hiển thị ở đây</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm text-zinc-300">
                    <thead className="bg-zinc-900/80 sticky top-0">
                      <tr className="text-[10px] text-zinc-500 uppercase tracking-wider">
                        <th className="px-5 py-3 w-[130px]">Sự kiện</th>
                        <th className="px-5 py-3">Email</th>
                        <th className="px-5 py-3">IP</th>
                        <th className="px-5 py-3">HWID</th>
                        <th className="px-5 py-3">Chi tiết</th>
                        <th className="px-5 py-3">TK liên quan</th>
                        <th className="px-5 py-3 text-right">Thời gian</th>
                      </tr>
                    </thead>
                    <tbody>
                      {authLogs.map((log, i) => {
                        const typeInfo = authLogTypeLabels[log.type] || { label: log.type, color: 'bg-zinc-700 text-zinc-400' };
                        const isError = log.type.includes('blocked') || log.type.includes('locked');
                        const isWarning = log.type.includes('failed');
                        const borderColor = isError ? 'border-l-red-500/60' : isWarning ? 'border-l-amber-500/60' : 'border-l-emerald-500/40';
                        return (
                          <tr key={i} className={`border-t border-zinc-900/40 border-l-2 ${borderColor} hover:bg-zinc-800/30 transition-colors`}>
                            <td className="px-5 py-3">
                              <span className={`text-[10px] px-2.5 py-1 rounded-full font-semibold whitespace-nowrap ${typeInfo.color}`}>
                                {typeInfo.label}
                              </span>
                            </td>
                            <td className="px-5 py-3 font-mono text-xs text-zinc-300 max-w-[180px] truncate">{log.email || '—'}</td>
                            <td className="px-5 py-3 font-mono text-xs text-zinc-400">{log.ip || '—'}</td>
                            <td className="px-5 py-3 font-mono text-[10px] text-zinc-500 max-w-[100px] truncate" title={log.hwid || ''}>
                              {log.hwid ? log.hwid.substring(0, 10) + '…' : '—'}
                            </td>
                            <td className="px-5 py-3 text-xs text-zinc-400 max-w-[220px]">
                              <span className="truncate block" title={log.reason || ''}>{log.reason || '—'}</span>
                            </td>
                            <td className="px-5 py-3 text-xs">
                              {log.existingEmail ? (
                                <span className="inline-flex items-center gap-1 text-amber-400 font-mono bg-amber-500/10 px-2 py-0.5 rounded-full">
                                  <ArrowRight className="h-2.5 w-2.5" /> {log.existingEmail}
                                </span>
                              ) : <span className="text-zinc-600">—</span>}
                            </td>
                            <td className="px-5 py-3 text-[11px] text-zinc-500 whitespace-nowrap text-right">{new Date(log.createdAt).toLocaleString('vi-VN')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Pagination Footer */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3 border-t border-zinc-900 bg-zinc-900/40 text-xs">
                <div className="flex items-center gap-3 text-zinc-400">
                  <span>
                    Hiển thị <span className="font-semibold text-zinc-200">{authLogs.length > 0 ? (authLogPage - 1) * authLogLimit + 1 : 0}</span> - <span className="font-semibold text-zinc-200">{Math.min(authLogPage * authLogLimit, authLogTotal)}</span> trong tổng số <span className="font-semibold text-zinc-200">{authLogTotal}</span> bản ghi
                  </span>
                  <div className="flex items-center gap-1.5 ml-2">
                    <span className="text-zinc-500">Xem:</span>
                    <select
                      value={authLogLimit}
                      onChange={(e) => {
                        setAuthLogLimit(Number(e.target.value));
                        setAuthLogPage(1);
                      }}
                      className="bg-zinc-800 border border-zinc-700/60 text-zinc-300 text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-rose-500 cursor-pointer"
                    >
                      <option value={10}>10 / trang</option>
                      <option value={20}>20 / trang</option>
                      <option value={50}>50 / trang</option>
                      <option value={100}>100 / trang</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setAuthLogPage(1)}
                    disabled={authLogPage <= 1}
                    className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 cursor-pointer transition-colors"
                    title="Trang đầu"
                  >
                    Đầu
                  </button>
                  <button
                    onClick={() => setAuthLogPage(p => Math.max(1, p - 1))}
                    disabled={authLogPage <= 1}
                    className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 cursor-pointer transition-colors"
                  >
                    Trước
                  </button>
                  {getPageNumbers(authLogPage, authLogTotalPages).map((p, i) =>
                    p === '...' ? <span key={i} className="text-zinc-600 text-xs px-1">…</span> : (
                      <button
                        key={i}
                        onClick={() => setAuthLogPage(p)}
                        className={`px-3 py-1.5 text-xs rounded-lg cursor-pointer transition-colors ${authLogPage === p ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30 font-semibold' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}
                      >
                        {p}
                      </button>
                    )
                  )}
                  <button
                    onClick={() => setAuthLogPage(p => Math.min(authLogTotalPages, p + 1))}
                    disabled={authLogPage >= authLogTotalPages}
                    className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 cursor-pointer transition-colors"
                  >
                    Sau
                  </button>
                  <button
                    onClick={() => setAuthLogPage(authLogTotalPages)}
                    disabled={authLogPage >= authLogTotalPages}
                    className="px-2.5 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 cursor-pointer transition-colors"
                    title="Trang cuối"
                  >
                    Cuối
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer Info */}
        <div className="text-center text-xs text-zinc-650 pt-4 flex items-center justify-center gap-2">
          <ShieldCheck className="h-4 w-4 text-zinc-600" />
          <span>Hệ thống bảo vệ bản quyền nâng cao Ed25519 &amp; Local verification engine.</span>
        </div>

      </main>

      {/* Create Affiliate Link Modal */}
      {isCreateLinkModalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Link2 className="text-amber-400 h-5 w-5" />
                Tạo Link Affiliate Mới
              </h3>
              <button onClick={() => setIsCreateLinkModalOpen(false)} className="text-zinc-500 hover:text-white cursor-pointer transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreateLink} className="space-y-4">
              {isSale ? (
                <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <div className="flex items-start gap-3">
                    <BadgePercent className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-white">Tạo link affiliate cho tài khoản của bạn</p>
                      <p className="text-xs text-zinc-400 mt-1">Một link với mã code 8 ký tự ngẫu nhiên sẽ được tạo. Khi khách hàng click vào link và mua hàng, hoa hồng sẽ được tính cho bạn.</p>
                      <p className="text-xs text-amber-400 mt-2 font-medium">🔗 Link sẽ redirect về: editnhanh.com/pricing</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Email Sale phụ trách</label>
                  <input
                    type="email"
                    value={newLinkEmail}
                    onChange={e => setNewLinkEmail(e.target.value)}
                    placeholder="vd: sale@example.com"
                    required
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <p className="mt-1 text-[11px] text-zinc-500">Sale phải có tài khoản trong hệ thống. Một code 8 ký tự ngẫu nhiên sẽ được tạo tự động.</p>
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setIsCreateLinkModalOpen(false)}
                  className="px-4 py-2 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-xs font-semibold text-zinc-300 rounded-lg cursor-pointer">
                  Hủy
                </button>
                <button type="submit" disabled={creatingLink}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
                  {creatingLink ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Tạo Link
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {/* Admin Login Modal (email/password) */}
      {isAuthModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md transition-opacity duration-300">
          <div className="w-full max-w-md p-8 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl">
            <div className="text-center mb-6">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400 mb-4">
                <Lock className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold text-white">Đăng nhập Quản trị viên</h3>
              <p className="text-sm text-zinc-400 mt-2">Vui lòng nhập email và mật khẩu tài khoản Admin để truy cập bảng quản trị.</p>
            </div>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Email</label>
                <input 
                  type="email" 
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="admin@example.com" 
                  required
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">Mật khẩu</label>
                <input 
                  type="password" 
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••" 
                  required
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                />
              </div>
              <button 
                type="submit"
                disabled={loginLoading}
                className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loginLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Đang đăng nhập...</span>
                  </>
                ) : (
                  <>
                    <span>Đăng nhập</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
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
                  placeholder="VD: 30 (để trống = vĩnh viễn)"
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <p className="mt-1.5 text-[11px] text-zinc-500">💡 Để trống ô số ngày nếu muốn tạo <span className="text-emerald-400 font-semibold">Key vĩnh viễn</span> (không giới hạn thời gian).</p>
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

      {/* Edit User Modal */}
      {isUserEditModalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300">
          <div className="w-full max-w-lg p-6 rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button
              onClick={() => setIsUserEditModalOpen(false)}
              className="absolute top-4 right-4 text-zinc-450 hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <User className="text-indigo-400 h-5 w-5" />
                <span>Sửa Thông Tin Thành Viên</span>
              </h3>
            </div>
            <form onSubmit={handleSaveUserEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1">Email (Không đổi được)</label>
                <input
                  type="text"
                  value={editUserEmail}
                  disabled
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-zinc-500 cursor-not-allowed font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Họ và tên</label>
                  <input
                    type="text"
                    value={editFullName}
                    onChange={(e) => setEditFullName(e.target.value)}
                    required
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Số điện thoại</label>
                  <input
                    type="text"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value.replace(/\D/g, ''))}
                    placeholder="0912345678"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">Vai trò</label>
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="user">Thành viên (Member)</option>
                    <option value="sale">Nhân viên Sale</option>
                    <option value="admin">Quản trị viên (Admin)</option>
                  </select>
                </div>
                <div className="flex items-center gap-2.5 pt-6">
                  <input
                    type="checkbox"
                    id="editIsVerified"
                    checked={editIsVerified}
                    onChange={(e) => setEditIsVerified(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500"
                  />
                  <label htmlFor="editIsVerified" className="text-xs font-semibold text-zinc-400 cursor-pointer">Đã xác thực email</label>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">IP đăng ký</label>
                  <input
                    type="text"
                    value={editIp}
                    onChange={(e) => setEditIp(e.target.value)}
                    placeholder="Để trống nếu không có"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">HWID thiết bị (fingerprint đăng ký)</label>
                  <input
                    type="text"
                    value={editHwid}
                    onChange={(e) => setEditHwid(e.target.value)}
                    placeholder="Để trống nếu không có"
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1">HWID thiết bị thật (từ active key)</label>
                  <input
                    type="text"
                    value={editDeviceHwid}
                    onChange={(e) => setEditDeviceHwid(e.target.value)}
                    placeholder="Tự sinh khi active key đầu tiên. Xóa trống để cho phép đổi máy."
                    className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
              </div>
              {/* Password Change Section */}
              <div className="pt-3 border-t border-zinc-800/60 space-y-3">
                <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-amber-500" />
                  Đổi Mật Khẩu <span className="font-normal text-zinc-600 normal-case tracking-normal">(tuỳ chọn &mdash; để trống nếu không muốn đổi)</span>
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 mb-1">Mật khẩu mới</label>
                    <div className="relative">
                      <input
                        type={showEditNewPassword ? 'text' : 'password'}
                        value={editNewPassword}
                        onChange={(e) => setEditNewPassword(e.target.value)}
                        placeholder="Tối thiểu 8 ký tự"
                        autoComplete="new-password"
                        className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 pr-9 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                      <button
                        type="button"
                        onClick={() => setShowEditNewPassword(v => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
                        tabIndex={-1}
                      >
                        {showEditNewPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-500 mb-1">Xác nhận mật khẩu</label>
                    <div className="relative">
                      <input
                        type={showEditConfirmPassword ? 'text' : 'password'}
                        value={editConfirmPassword}
                        onChange={(e) => setEditConfirmPassword(e.target.value)}
                        placeholder="Nhập lại"
                        autoComplete="new-password"
                        className={`w-full rounded-lg bg-zinc-950 border px-3 py-2 pr-9 text-sm text-white focus:outline-none focus:ring-1 transition-colors ${
                          editConfirmPassword && editConfirmPassword !== editNewPassword
                            ? 'border-rose-700 focus:ring-rose-500'
                            : editConfirmPassword && editConfirmPassword === editNewPassword
                            ? 'border-emerald-700 focus:ring-emerald-500'
                            : 'border-zinc-800 focus:ring-amber-500'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowEditConfirmPassword(v => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
                        tabIndex={-1}
                      >
                        {showEditConfirmPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {editConfirmPassword && editConfirmPassword !== editNewPassword && (
                      <p className="mt-1 text-[10px] text-rose-400">⚠ Chưa khớp</p>
                    )}
                    {editConfirmPassword && editConfirmPassword === editNewPassword && (
                      <p className="mt-1 text-[10px] text-emerald-400">✓ Khớp</p>
                    )}
                  </div>
                </div>
              </div>
              <div className="pt-4 border-t border-zinc-800 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsUserEditModalOpen(false)}
                  className="px-4 py-2 bg-zinc-950 hover:bg-zinc-900 border border-zinc-850 text-xs font-semibold text-zinc-300 rounded-lg transition-colors cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={savingUser}
                  className="px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-xs font-bold text-white rounded-lg shadow-lg hover:shadow-indigo-500/10 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingUser ? 'Đang lưu...' : 'Lưu Lại'}
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
