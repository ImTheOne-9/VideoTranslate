const { app } = require('electron');
const path = require('path');

// Xác định xem ứng dụng đang chạy ở chế độ dev hay production (đã đóng gói)
const isPackaged = app.isPackaged;

if (isPackaged) {
  // Chế độ Production: Đăng ký bytenode và nạp file nhị phân main.jsc
  require('bytenode');
  require(path.join(__dirname, 'main.jsc'));
} else {
  // Chế độ Development: Nạp trực tiếp file Javascript gốc
  require(path.join(__dirname, 'main.js'));
}
