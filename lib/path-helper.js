const path = require('path');
const os = require('os');

/**
 * Lấy đường dẫn thư mục gốc lưu trữ dữ liệu của ứng dụng.
 * @param {string} devFallback Đường dẫn fallback sử dụng khi chạy ở môi trường phát triển (development).
 * @returns {string} Đường dẫn thư mục lưu trữ dữ liệu.
 */
function getAppDataRoot(devFallback) {
  const isPackaged = __dirname.includes('app.asar');
  if (!isPackaged) {
    return devFallback;
  }

  // Trong môi trường đóng gói (Production):
  const execDir = path.dirname(process.execPath);
  const execDrive = path.parse(execDir).root.toLowerCase();

  if (execDrive.startsWith('c:')) {
    // Cài ở ổ C -> Lưu ở thư mục người dùng cá nhân %USERPROFILE%/VideoStudio để tránh lỗi phân quyền
    return path.join(os.homedir(), 'VideoStudio');
  } else {
    // Cài ở ổ khác (D, E, F...) -> Tạo thư mục dữ liệu song song với thư mục cài đặt
    const parentDir = path.dirname(execDir);
    return path.join(parentDir, 'VideoStudioData');
  }
}

module.exports = { getAppDataRoot };
