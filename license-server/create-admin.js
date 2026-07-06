/*
 * create-admin.js — Tạo / nâng cấp tài khoản Quản trị viên (Admin) cho License Server.
 *
 * Cách dùng:
 *   node create-admin.js <email> <password> [fullName] [phoneNumber]
 *
 * Ví dụ:
 *   node create-admin.js admin@editnhanh.com MyStrongPass123 "Nguyễn Quản Trị" 0901234567
 *
 * - Tự đọc MONGODB_URI từ file .env (giống server.js).
 * - Nếu email chưa tồn tại: tạo tài khoản mới với role='admin', isVerified=true.
 * - Nếu email đã tồn tại: nâng cấp lên role='admin', isVerified=true (và đổi mật khẩu nếu cung cấp).
 * - Dùng cùng thuật toán scrypt hash password như server.js nên đăng nhập hoạt động ngay.
 * - Chạy được cho cả MongoDB (production) và JSON fallback (local không có MongoDB).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

// ---------- Load .env (cùng logic như server.js) ----------
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const envLines = envContent.split(/\r?\n/);
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const hashIndex = trimmed.indexOf('#');
      let cleanLine = trimmed;
      if (hashIndex !== -1) cleanLine = trimmed.substring(0, hashIndex).trim();
      if (!cleanLine) continue;
      const parts = cleanLine.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        let val = parts.slice(1).join('=').trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  }
} catch (e) {
  console.error('[create-admin] Lỗi khi load file .env:', e.message);
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/license_server';
const DB_FILE = path.join(__dirname, 'database.json');

// ---------- password hashing (giống hệt server.js) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `${salt}:${hash}`;
}

// ---------- args ----------
const [emailArg, passwordArg, fullNameArg, phoneNumberArg] = process.argv.slice(2);
if (!emailArg || !passwordArg) {
  console.error('==============================================');
  console.error(' Cách dùng: node create-admin.js <email> <password> [fullName] [phoneNumber]');
  console.error(' Ví dụ:    node create-admin.js admin@editnhanh.com MyPass123 "Nguyễn Quản Trị" 0901234567');
  console.error('==============================================');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();
const password = passwordArg;
const fullName = (fullNameArg || 'Quản trị viên').trim();
const phoneNumber = (phoneNumberArg || '0000000000').trim();

const hashedPassword = hashPassword(password);

// ---------- Schema (giống server.js) ----------
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  role: { type: String, default: 'user' },
  avatar: { type: String, default: null },
  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String, default: null },
  verificationExpires: { type: Date, default: null },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
const UserModel = mongoose.model('User', userSchema);


// ---------- JSON helpers (fallback) ----------
function readJSON() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return { users: [], licenses: [], plans: [], settings: {} };
}
function writeJSON(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

async function runMongo() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  console.log(`[create-admin] Đã kết nối MongoDB: ${MONGODB_URI}`);
  const existing = await UserModel.findOne({ email });
  if (existing) {
    existing.role = 'admin';
    existing.isVerified = true;
    existing.password = hashedPassword;
    existing.passwordChangedAt = new Date();
    await existing.save();
    console.log(`[create-admin] ĐÃ NÂNG CẤP tài khoản có sẵn lên Admin & đổi mật khẩu:`);
    console.log(`  Email      : ${existing.email}`);
    console.log(`  Họ tên     : ${existing.fullName}`);
    console.log(`  Vai trò    : ${existing.role}`);
    console.log(`  Đã xác thực: ${existing.isVerified}`);
  } else {
    const user = new UserModel({
      email, password: hashedPassword, fullName, phoneNumber,
      role: 'admin', isVerified: true
    });
    await user.save();
    console.log(`[create-admin] ĐÃ TẠO MỚI tài khoản Admin:`);
    console.log(`  Email      : ${user.email}`);
    console.log(`  Họ tên     : ${user.fullName}`);
    console.log(`  SĐT        : ${user.phoneNumber}`);
    console.log(`  Vai trò    : ${user.role}`);
    console.log(`  Đã xác thực: ${user.isVerified}`);
  }
}

function runJSON() {
  const db = readJSON();
  if (!db.users) db.users = [];
  const idx = db.users.findIndex(u => u.email.toLowerCase() === email);
  if (idx !== -1) {
    db.users[idx].role = 'admin';
    db.users[idx].isVerified = true;
    db.users[idx].password = hashedPassword;
    db.users[idx].passwordChangedAt = new Date().toISOString();
    console.log(`[create-admin] [JSON] ĐÃ NÂNG CẤP tài khoản có sẵn lên Admin & đổi mật khẩu:`);
    console.log(`  Email      : ${db.users[idx].email}`);
    console.log(`  Họ tên     : ${db.users[idx].fullName}`);
  } else {
    db.users.push({
      email, password: hashedPassword, fullName, phoneNumber,
      role: 'admin', avatar: null, isVerified: true,
      verificationToken: null, verificationExpires: null,
      resetPasswordToken: null, resetPasswordExpires: null,
      passwordChangedAt: null, createdAt: new Date().toISOString()
    });
    console.log(`[create-admin] [JSON] ĐÃ TẠO MỚI tài khoản Admin:`);
    console.log(`  Email      : ${email}`);
    console.log(`  Họ tên     : ${fullName}`);
    console.log(`  SĐT        : ${phoneNumber}`);
  }
  writeJSON(db);
}

(async () => {
  try {
    await runMongo();
  } catch (err) {
    console.warn(`[create-admin] Không kết nối được MongoDB (${err.message}).`);
    console.warn(`[create-admin] Chuyển sang tạo/cập nhật trong file JSON cục bộ: ${DB_FILE}`);
    runJSON();
  } finally {
    try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  }
})();