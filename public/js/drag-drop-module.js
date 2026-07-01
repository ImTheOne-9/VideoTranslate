function toggleSidebar() {
  const shell = document.querySelector('.app-shell');
  const icon = $('sidebar-toggle-icon');
  if (shell) {
    const isCollapsed = shell.classList.toggle('sidebar-collapsed');
    
    // Save state in localStorage
    localStorage.setItem('sidebar_collapsed', isCollapsed ? 'true' : 'false');
    
    if (icon) {
      icon.textContent = isCollapsed ? '▶' : '◀';
    }
  }
}

function initSidebarState() {
  const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
  if (isCollapsed) {
    const shell = document.querySelector('.app-shell');
    const icon = $('sidebar-toggle-icon');
    if (shell) {
      shell.classList.add('sidebar-collapsed');
    }
    if (icon) {
      icon.textContent = '▶';
    }
  }
}

// Initialize sidebar state on startup
// Initialize sidebar state on startup
initSidebarState();

window.toggleSidebar = toggleSidebar;

/* ==========================================================================
   HỆ THỐNG TẢI ĐỘNG CÁC THƯ VIỆN AI NẶNG (CUDA, WHISPER)
   ========================================================================== */
// Globals are declared in globals.js

async function checkLocalDependencies() {
  try {
    const res = await fetch('/api/check-dependencies-status');
    if (res.ok) {
      dependencyStatus = await res.json();
      updateDependencyUI();
    }
  } catch (err) {
    console.error('Lỗi khi kiểm tra thư viện AI:', err);
  }
}

