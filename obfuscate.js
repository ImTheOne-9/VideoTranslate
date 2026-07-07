const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');

// Thu thập toàn bộ file backend cần biên dịch sang bytecode .jsc
const backendFiles = [
  'main.js',
  'server.js',
  ...fs.readdirSync(path.join(__dirname, 'lib'))
    .filter(f => f.endsWith('.js'))
    .map(f => `lib/${f}`),
  ...fs.readdirSync(path.join(__dirname, 'controllers'))
    .filter(f => f.endsWith('.js'))
    .map(f => `controllers/${f}`)
];

// File frontend làm rối bằng javascript-obfuscator
const frontendFiles = [
  'public/app.js'
];

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  whiteSpace: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 5,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.8,
  transformObjectKeys: false,
  unicodeEscapeSequence: false
};

const BACKUP_DIR = path.join(__dirname, 'backup_src');
let isRestored = false;

function backupFiles() {
  console.log('📦 Đang tạo bản sao lưu bảo vệ mã nguồn gốc tại backup_src...');
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Backup backend
  for (const relPath of backendFiles) {
    const fullPath = path.join(__dirname, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const backupPath = path.join(BACKUP_DIR, relPath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(fullPath, backupPath);
  }

  // Backup frontend
  for (const relPath of frontendFiles) {
    const fullPath = path.join(__dirname, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const backupPath = path.join(BACKUP_DIR, relPath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(fullPath, backupPath);
  }
  console.log('✅ Đã sao lưu thành công.');
}

function restoreFiles() {
  if (isRestored) return;
  console.log('🔄 Đang khôi phục lại mã nguồn gốc sạch từ backup_src...');
  if (!fs.existsSync(BACKUP_DIR)) {
    console.warn('⚠️ Cảnh báo: Không tìm thấy thư mục sao lưu!');
    return;
  }

  // Khôi phục backend & Xóa các file .jsc
  for (const relPath of backendFiles) {
    const backupPath = path.join(BACKUP_DIR, relPath);
    const fullPath = path.join(__dirname, relPath);
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, fullPath);
    }
    const jscPath = fullPath.replace(/\.js$/, '.jsc');
    if (fs.existsSync(jscPath)) {
      try {
        fs.unlinkSync(jscPath);
      } catch (e) {}
    }
  }

  // Khôi phục frontend
  for (const relPath of frontendFiles) {
    const backupPath = path.join(BACKUP_DIR, relPath);
    const fullPath = path.join(__dirname, relPath);
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, fullPath);
    }
  }

  // Dọn dẹp thư mục backup
  try {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  } catch (e) {}

  isRestored = true;
  console.log('✨ Khôi phục mã nguồn và dọn dẹp tệp tạm hoàn tất!');
}

async function prepareBuildCode() {
  console.log('🛡️  Bắt đầu mã hóa và biên dịch mã nguồn...');
  const electronPath = require('electron');
  const bytenode = require('bytenode');
  
  // 1. Biên dịch Backend sang Bytecode .jsc
  for (const relPath of backendFiles) {
    const fullPath = path.join(__dirname, relPath);
    if (!fs.existsSync(fullPath)) continue;
    
    console.log(`  [Bytenode] Biên dịch: ${relPath}`);
    // Biên dịch sử dụng tiến trình Electron Main (bắt buộc cho Electron >= 42)
    await bytenode.compileFile({
      filename: fullPath,
      electronPath: electronPath,
      electronMain: true,
      compileAsModule: true
    });
    
    // Xóa tệp .js gốc để tránh đóng gói nhầm vào asar
    fs.unlinkSync(fullPath);
  }

  // 2. Làm rối Frontend app.js
  for (const relPath of frontendFiles) {
    const fullPath = path.join(__dirname, relPath);
    if (!fs.existsSync(fullPath)) continue;
    
    console.log(`  [Obfuscator] Làm rối: ${relPath}`);
    const sourceCode = fs.readFileSync(fullPath, 'utf8');
    const obfuscationResult = JavaScriptObfuscator.obfuscate(sourceCode, OBFUSCATOR_OPTIONS);
    fs.writeFileSync(fullPath, obfuscationResult.getObfuscatedCode(), 'utf8');
  }
}

// Xử lý các sự kiện tắt hoặc lỗi tiến trình đột ngột để đảm bảo LUÔN khôi phục lại code gốc
const cleanupExit = () => {
  restoreFiles();
};
process.on('exit', cleanupExit);
process.on('SIGINT', () => {
  console.log('\n⚠️ Người dùng ngắt tiến trình! Khôi phục lại code gốc ngay...');
  process.exit(2);
});
process.on('uncaughtException', (err) => {
  console.error('\n❌ Lỗi hệ thống chưa được xử lý:', err.message);
  process.exit(99);
});

// Chạy script dựa trên các tham số
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--restore')) {
    restoreFiles();
  } else if (args.includes('--build')) {
    let buildSuccess = false;
    try {
      backupFiles();
      await prepareBuildCode();
      
      console.log('\n🚀 Đang khởi chạy quy trình đóng gói Electron Builder...');
      
      let buildCmd = 'npx electron-builder build --win --x64';
      if (args.includes('--no-update')) {
        console.log('💡 Cấu hình build: KHÔNG có tự động cập nhật (--publish never)');
        buildCmd += ' --publish never';
      } else {
        console.log('💡 Cấu hình build: CÓ tự động cập nhật (HuggingFace)');
      }
      
      child_process.execSync(buildCmd, { stdio: 'inherit', cwd: __dirname });
      buildSuccess = true;
    } catch (err) {
      console.error('\n❌ Lỗi trong quá trình build/đóng gói:', err.message);
    } finally {
      // Luôn khôi phục lại mã nguồn sạch khi kết thúc (dù thành công hay thất bại)
      restoreFiles();
      if (buildSuccess) {
        console.log('\n🎉 Quá trình đóng gói bảo mật hoàn tất và thành công!');
      } else {
        console.log('\n⚠️ Đã khôi phục lại code gốc sau lỗi build.');
      }
    }
  } else {
    // Mặc định chạy thử nghiệm làm rối/biên dịch (có tạo backup)
    try {
      backupFiles();
      await prepareBuildCode();
      console.log('\n✨ Đã chạy thử biên dịch và làm rối mã nguồn local!');
      console.log('👉 Chạy lệnh sau để khôi phục lại code gốc: node obfuscate.js --restore');
    } catch (err) {
      console.error('Lỗi khi chạy thử:', err.message);
      restoreFiles();
    }
  }
}

main();
