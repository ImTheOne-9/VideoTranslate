const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Xác định xem ứng dụng đang chạy ở chế độ dev hay production (đã đóng gói)
const isPackaged = app.isPackaged;

if (isPackaged) {
  // BẢO MẬT: Chống chèn đè tệp .js thô để bypass mã nhị phân .jsc
  const targetDirs = ['lib', 'controllers'];
  const rootFiles = ['main.js', 'server.js'];
  
  for (const file of rootFiles) {
    if (fs.existsSync(path.join(__dirname, file))) {
      app.quit();
      process.exit(1);
    }
  }
  
  for (const dir of targetDirs) {
    const dirPath = path.join(__dirname, dir);
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (file.endsWith('.js')) {
          app.quit();
          process.exit(1);
        }
      }
    }
  }

  // Chế độ Production: Đăng ký bytenode và nạp file nhị phân main.jsc
  require('bytenode');
  require(path.join(__dirname, 'main.jsc'));
} else {
  // Chế độ Development: Nạp trực tiếp file Javascript gốc
  require(path.join(__dirname, 'main.js'));
}
