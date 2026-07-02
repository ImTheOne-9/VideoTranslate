const { app, BrowserWindow, Menu, ipcMain } = require('electron');
app.commandLine.appendSwitch('disable-http2');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ensureModelsExist } = require('./lib/model-downloader');
const { getAppDataRoot } = require('./lib/path-helper');
const { checkLicenseStartup } = require('./lib/license-manager');

// Cấu hình thư mục log
const logDir = app.getPath('userData');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'videostudio.log');

// Tạo mới/Xóa sạch file log cũ khi bắt đầu phiên chạy mới
try {
  fs.writeFileSync(logFile, '', 'utf8');
} catch (e) {
  // Bỏ qua lỗi
}

let logWindow = null;

// Hàm ghi log có định dạng
function logToFile(message, level = 'INFO') {
  const time = new Date().toISOString();
  const formatted = `[${time}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, formatted, 'utf8');
  } catch (e) {
    // Bỏ qua lỗi ghi file
  }

  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send('new-log-line', formatted);
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

// Khởi tạo trạng thái cập nhật mặc định
global.updateStatus = { status: 'idle', percent: 0, error: null };

let mainWindow = null;
let serverInstance = null;
let confirmWindow = null;
let isQuitting = false;

function createLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return;
  }

  logWindow = new BrowserWindow({
    width: 900,
    height: 500,
    title: 'Video Studio Tools - Logs Console',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  logWindow.setMenu(null);
  logWindow.loadFile(path.join(__dirname, 'public', 'log-viewer.html'));

  logWindow.on('closed', () => {
    logWindow = null;
  });
}

ipcMain.on('request-log-path', (event) => {
  event.reply('log-path-response', logFile);
});

ipcMain.on('confirm-close-choice', (event, choice) => {
  if (choice === 'quit') {
    isQuitting = true;
    if (confirmWindow && !confirmWindow.isDestroyed()) {
      confirmWindow.close();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  } else {
    if (confirmWindow && !confirmWindow.isDestroyed()) {
      confirmWindow.close();
    }
  }
});

// Require server.js để lấy hàm startServer và dọn dẹp tiến trình con
const { startServer, killAllActiveProcesses } = require('./server.js');

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow(port, isLicenseValid = true, licenseError = '') {
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

  let url;
  if (isLicenseValid) {
    url = `http://127.0.0.1:${port}`;
  } else {
    url = `http://127.0.0.1:${port}/license.html?error=${encodeURIComponent(licenseError)}`;
  }

  console.log(`Đang tải trang giao diện: ${url}`);
  mainWindow.loadURL(url);

  // Ghi log console từ render process vào file log chung
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const sourceFile = sourceId ? path.basename(sourceId) : 'unknown';
    const levelStr = level === 3 ? 'ERROR' : (level === 2 ? 'WARN' : 'INFO');
    logToFile(`[Web Console] ${message} (at ${sourceFile}:${line})`, levelStr);
  });

  // Chỉ bật tự động DevTools ở môi trường phát triển (chưa đóng gói)
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  // Đăng ký phím tắt Ctrl+R / F5 để tải lại trang và Ctrl+Shift+I để bật DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      mainWindow.reload();
      event.preventDefault();
    }
    if (app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    event.preventDefault();

    if (confirmWindow && !confirmWindow.isDestroyed()) {
      confirmWindow.focus();
      return;
    }

    // Làm mờ cửa sổ chính
    mainWindow.webContents.executeJavaScript("document.body.style.transition = 'filter 0.3s ease'; document.body.style.filter = 'blur(5px)';").catch(() => {});

    confirmWindow = new BrowserWindow({
      width: 380,
      height: 180,
      frame: false,
      transparent: true,
      parent: mainWindow,
      modal: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    confirmWindow.setMenu(null);
    confirmWindow.loadURL(`http://127.0.0.1:${global.runningPort}/close-confirm.html`);

    confirmWindow.on('closed', () => {
      confirmWindow = null;
      // Khôi phục độ nét cho cửa sổ chính
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript("document.body.style.filter = 'none';").catch(() => {});
      }
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.close();
    }
  });

  // Tự động mở cửa sổ Log Console song song
  createLogWindow();
}

// Khởi chạy server và ứng dụng khi Electron sẵn sàng
app.whenReady().then(async () => {
  try {
    // Tự động dọn dẹp bộ nhớ đệm (cache) khi khởi động để tránh lỗi Invalid cache size của Chromium
    try {
      const { session } = require('electron');
      if (session && session.defaultSession) {
        await session.defaultSession.clearCache();
        console.log('[Init] Đã tự động dọn dẹp cache của Electron.');
      }
    } catch (cacheErr) {
      console.error('Không thể dọn dẹp cache:', cacheErr.message);
    }

    // 1. Hiển thị màn hình Loading tải dữ liệu AI
    let loadingWin = new BrowserWindow({
      width: 450,
      height: 250,
      frame: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    
    loadingWin.loadFile(path.join(__dirname, 'public', 'loading.html'));
    
    // 2. Định tuyến thư mục chứa model
    const appDataRoot = getAppDataRoot(__dirname);
    const MODELS_DIR = path.join(appDataRoot, 'models');

    // 3. Tiến hành tải ngầm nếu model chưa tồn tại
    try {
      await ensureModelsExist(MODELS_DIR, (progress) => {
        if (loadingWin && !loadingWin.isDestroyed()) {
          loadingWin.webContents.send('download-progress', progress);
        }
      });
    } catch (downloadErr) {
      console.error('Lỗi khi tải Model AI:', downloadErr.message);
      // Có thể hiển thị alert cho người dùng ở đây, hiện tại bỏ qua để tiếp tục chạy app
    }

    // 4. Khởi chạy Server và màn hình chính
    const preferredPort = 3456;
    console.log(`Đang dò port trống và khởi chạy Express server...`);
    const result = await startServer(preferredPort);
    
    serverInstance = result.server;
    global.runningPort = result.port;
    console.log(`Express server đã khởi chạy thành công trên 127.0.0.1:${global.runningPort}`);

    // 5. Kiểm tra bản quyền bản cài đặt
    const licenseCheck = await checkLicenseStartup();
    if (licenseCheck.valid) {
      console.log('Xác thực bản quyền thành công!');
      createWindow(global.runningPort, true);
    } else {
      console.warn(`Xác thực bản quyền thất bại: ${licenseCheck.error}`);
      createWindow(global.runningPort, false, licenseCheck.error);
    }

    // 6. Đóng màn hình Loading (Chỉ đóng sau khi đã khởi tạo cửa sổ chính để tránh Electron tự động thoát khi không còn cửa sổ nào mở)
    if (loadingWin && !loadingWin.isDestroyed()) {
      loadingWin.close();
      loadingWin = null;
    }

    // 7. Tự động kiểm tra cập nhật (chỉ chạy khi ứng dụng đã đóng gói)
    if (app.isPackaged) {
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.logger = console;

        // Vô hiệu hóa tính năng tự động tải ngầm mặc định để kiểm soát và hiển thị tiến trình
        autoUpdater.autoDownload = false;

        autoUpdater.on('checking-for-update', () => {
          global.updateStatus = { status: 'checking', percent: 0, error: null };
        });

        autoUpdater.on('update-available', (info) => {
          global.updateStatus = { status: 'available', percent: 0, error: null };
          // Bắt đầu tải bản cập nhật sau khi phát hiện có bản mới
          autoUpdater.downloadUpdate().catch(err => {
            console.error('Lỗi khi tải bản cập nhật:', err.message);
          });
        });

        autoUpdater.on('update-not-available', (info) => {
          global.updateStatus = { status: 'idle', percent: 0, error: null };
        });

        autoUpdater.on('error', (err) => {
          global.updateStatus = { status: 'error', percent: 0, error: err.message || 'Lỗi không xác định' };
        });

        autoUpdater.on('download-progress', (progressObj) => {
          global.updateStatus = { 
            status: 'downloading', 
            percent: Math.round(progressObj.percent), 
            error: null 
          };
        });

        autoUpdater.on('update-downloaded', (info) => {
          global.updateStatus = { status: 'downloaded', percent: 100, error: null };
        });

        autoUpdater.checkForUpdates().catch(err => {
          console.error('Lỗi khi kiểm tra bản cập nhật:', err.message);
        });
      } catch (updateErr) {
        console.error('Không thể kiểm tra bản cập nhật:', updateErr.message);
      }
    }
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

app.on('before-quit', () => {
  isQuitting = true;
  cleanup();
});
app.on('will-quit', cleanup);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0 && global.runningPort) {
    const licenseCheck = await checkLicenseStartup();
    createWindow(global.runningPort, licenseCheck.valid, licenseCheck.error || '');
  }
});
