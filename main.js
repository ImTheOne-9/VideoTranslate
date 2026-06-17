const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Cấu hình thư mục log
const logDir = app.getPath('userData');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'videostudio.log');

// Hàm ghi log có định dạng
function logToFile(message, level = 'INFO') {
  const time = new Date().toISOString();
  const formatted = `[${time}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, formatted, 'utf8');
  } catch (e) {
    // Bỏ qua lỗi ghi file
  }
}

// Ghi đè console.log và console.error của cả main process và các file require
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  originalLog(...args);
  logToFile(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'INFO');
};
console.error = (...args) => {
  originalError(...args);
  logToFile(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'ERROR');
};

console.log('====================================================');
console.log('--- Khởi động Video Studio Tools ---');
console.log(`Log File: ${logFile}`);
console.log(`Thư mục userData: ${logDir}`);
console.log('====================================================');

// Single Instance Lock: Ngăn mở nhiều cửa sổ phần mềm cùng lúc
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('Ứng dụng đã có một phiên bản khác đang chạy. Đang thoát...');
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let serverInstance = null;

// Require server.js để lấy hàm startServer và dọn dẹp tiến trình con
const { startServer, killAllActiveProcesses } = require('./server.js');

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Video Studio Tools',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Tắt menu bar mặc định (File, Edit, View...)
  Menu.setApplicationMenu(null);

  const url = `http://127.0.0.1:${port}`;
  console.log(`Đang tải trang giao diện: ${url}`);
  mainWindow.loadURL(url);

  // Chỉ bật tự động DevTools ở môi trường phát triển (chưa đóng gói)
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  } else {
    // Trong môi trường production, chặn các phím bật DevTools thông thường
    // nhưng giữ tổ hợp phím ẩn (Ctrl+Shift+I) để debug khi cần thiết.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Khởi chạy server và ứng dụng khi Electron sẵn sàng
app.whenReady().then(async () => {
  try {
    const preferredPort = 3456;
    console.log(`Đang dò port trống và khởi chạy Express server...`);
    const result = await startServer(preferredPort);
    
    serverInstance = result.server;
    global.runningPort = result.port;
    
    console.log(`Express server đã khởi chạy thành công trên 127.0.0.1:${global.runningPort}`);
    createWindow(global.runningPort);
  } catch (err) {
    console.error('Lỗi nghiêm trọng khi khởi động Express server:', err.message);
    app.quit();
  }
});

// Hàm dọn dẹp các tiến trình con tránh chạy ngầm khi đóng app
function cleanup() {
  console.log('Đang thoát ứng dụng. Bắt đầu dọn dẹp các tiến trình con...');
  try {
    killAllActiveProcesses();
  } catch (e) {
    console.error('Lỗi khi dọn dẹp tiến trình con:', e.message);
  }
}

app.on('before-quit', cleanup);
app.on('will-quit', cleanup);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && global.runningPort) {
    createWindow(global.runningPort);
  }
});
