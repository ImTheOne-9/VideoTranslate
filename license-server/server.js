const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

// Load environment variables from .env if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const envLines = envContent.split(/\r?\n/);
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        let val = parts.slice(1).join('=').trim();
        // Remove quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  }
  console.log(`[License Server] Email Config: Host=${process.env.EMAIL_HOST || 'none'}, Port=${process.env.EMAIL_PORT || 'none'}, User=${process.env.EMAIL_USER || 'none'}, Pass=${process.env.EMAIL_PASS ? '***' : 'none'}`);
} catch (e) {
  console.error('[License Server] Lỗi khi load file .env:', e.message);
}

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/license_server';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'my_super_secret_admin_token_2026';

const app = express();
app.use(express.json());

// Serve static public files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin-static', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Khóa riêng tư Ed25519 để ký bản quyền (Trùng khớp với Public Key nhúng ở Client)
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINCSkH2ERf0+fEmOBZAFIHPJlihYwsLNf2g4o+QZxmdw
-----END PRIVATE KEY-----`;

// Mongoose Setup
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  role: { type: String, default: 'user' },
  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String, default: null },
  verificationExpires: { type: Date, default: null },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
const UserModel = mongoose.model('User', userSchema);

const licenseSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  customerName: { type: String, default: 'Khách lẻ' },
  userEmail: { type: String, default: null },
  planType: { type: String, enum: ['trial', 'monthly', 'yearly'], default: 'trial' },
  paymentStatus: { type: String, enum: ['active', 'pending'], default: 'active' },
  hwid: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  resetCount: { type: Number, default: 0 },
  lastResetAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

// Setup DB indexes
licenseSchema.index({ userEmail: 1, planType: 1 });

const LicenseModel = mongoose.model('License', licenseSchema);

const DB_FILE = path.join(__dirname, 'database.json');
let useMongo = false;

// Fallback JSON-DB Helpers with Write Queue to prevent race conditions
function readJSON() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ licenses: [], users: [] }, null, 2), 'utf8');
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.licenses) data.licenses = [];
    if (!data.users) data.users = [];
    return data;
  } catch (err) {
    console.error('[License Server] Đọc file database.json thất bại, sử dụng cấu trúc rỗng:', err.message);
    return { licenses: [], users: [] };
  }
}

let isWriting = false;
const writeQueue = [];
function writeJSON(data) {
  return new Promise((resolve, reject) => {
    writeQueue.push({ data, resolve, reject });
    processWriteQueue();
  });
}

async function processWriteQueue() {
  if (isWriting || writeQueue.length === 0) return;
  isWriting = true;
  const { data, resolve, reject } = writeQueue.shift();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    resolve();
  } catch (err) {
    console.error('[License Server] Ghi file database.json thất bại:', err.message);
    reject(err);
  } finally {
    isWriting = false;
    processWriteQueue();
  }
}

// Connect to MongoDB with JSON fallback
mongoose.connect(MONGODB_URI)
  .then(() => {
    useMongo = true;
    console.log(`[License Server] [MongoDB Mode] Kết nối thành công tới MongoDB: ${MONGODB_URI}`);
  })
  .catch((err) => {
    useMongo = false;
    console.warn(`[License Server] [JSON Fallback Mode] Kết nối MongoDB thất bại (${err.message}).`);
    console.warn(`[License Server] Tự động chuyển sang sử dụng database file cục bộ: ${DB_FILE}`);
  });

// Unified Database Adapter Layer
const DB = {
  licenses: {
    async find(query = {}) {
      if (useMongo) {
        return await LicenseModel.find(query).sort({ createdAt: -1 });
      } else {
        const db = readJSON();
        let results = db.licenses;
        if (query.userEmail) {
          results = results.filter(l => l.userEmail === query.userEmail);
        }
        if (query.key) {
          results = results.filter(l => l.key === query.key);
        }
        return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }
    },

    async findOne(query) {
      if (useMongo) {
        return await LicenseModel.findOne(query);
      } else {
        const db = readJSON();
        let license = null;
        if (query.key) {
          license = db.licenses.find(l => l.key === query.key);
        } else if (query.userEmail) {
          license = db.licenses.find(l => l.userEmail === query.userEmail);
        }
        if (!license) return null;
        
        // Return object with compatible save() method
        return {
          key: license.key,
          customerName: license.customerName,
          userEmail: license.userEmail,
          planType: license.planType || 'trial',
          paymentStatus: license.paymentStatus || 'active',
          hwid: license.hwid,
          expiresAt: license.expiresAt,
          status: license.status,
          resetCount: license.resetCount || 0,
          lastResetAt: license.lastResetAt,
          createdAt: license.createdAt,
          save: async function() {
            const dbData = readJSON();
            const idx = dbData.licenses.findIndex(l => l.key === this.key);
            if (idx !== -1) {
              dbData.licenses[idx] = {
                key: this.key,
                customerName: this.customerName,
                userEmail: this.userEmail,
                planType: this.planType,
                paymentStatus: this.paymentStatus,
                hwid: this.hwid,
                expiresAt: this.expiresAt,
                status: this.status,
                resetCount: this.resetCount,
                lastResetAt: this.lastResetAt,
                createdAt: this.createdAt
              };
              await writeJSON(dbData);
            }
            return this;
          }
        };
      }
    },

    async create(data) {
      if (useMongo) {
        const license = new LicenseModel(data);
        return await license.save();
      } else {
        const db = readJSON();
        const newLicense = {
          key: data.key,
          customerName: data.customerName || 'Khách lẻ',
          userEmail: data.userEmail || null,
          planType: data.planType || 'trial',
          paymentStatus: data.paymentStatus || 'active',
          hwid: data.hwid || null,
          expiresAt: data.expiresAt instanceof Date ? data.expiresAt.toISOString() : data.expiresAt,
          status: data.status || 'active',
          resetCount: data.resetCount || 0,
          lastResetAt: data.lastResetAt || null,
          createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : (data.createdAt || new Date().toISOString())
        };
        db.licenses.push(newLicense);
        await writeJSON(db);
        
        return {
          ...newLicense,
          save: async function() {
            const dbData = readJSON();
            const idx = dbData.licenses.findIndex(l => l.key === this.key);
            if (idx !== -1) {
              dbData.licenses[idx] = {
                key: this.key,
                customerName: this.customerName,
                userEmail: this.userEmail,
                planType: this.planType,
                paymentStatus: this.paymentStatus,
                hwid: this.hwid,
                expiresAt: this.expiresAt,
                status: this.status,
                resetCount: this.resetCount,
                lastResetAt: this.lastResetAt,
                createdAt: this.createdAt
              };
              await writeJSON(dbData);
            }
            return this;
          }
        };
      }
    }
  },

  users: {
    async findOne(query) {
      if (useMongo) {
        return await UserModel.findOne(query);
      } else {
        const db = readJSON();
        let user = null;
        if (query.email) {
          user = db.users.find(u => u.email.toLowerCase() === query.email.toLowerCase());
        } else if (query.verificationToken) {
          user = db.users.find(u => u.verificationToken === query.verificationToken);
        } else if (query.resetPasswordToken) {
          user = db.users.find(u => u.resetPasswordToken === query.resetPasswordToken);
        }
        if (!user) return null;
        
        return {
          email: user.email,
          password: user.password,
          fullName: user.fullName,
          phoneNumber: user.phoneNumber,
          role: user.role || 'user',
          isVerified: user.isVerified !== undefined ? user.isVerified : false,
          verificationToken: user.verificationToken || null,
          verificationExpires: user.verificationExpires || null,
          resetPasswordToken: user.resetPasswordToken || null,
          resetPasswordExpires: user.resetPasswordExpires || null,
          passwordChangedAt: user.passwordChangedAt || null,
          createdAt: user.createdAt,
          save: async function() {
            const dbData = readJSON();
            const idx = dbData.users.findIndex(u => u.email.toLowerCase() === this.email.toLowerCase());
            if (idx !== -1) {
              dbData.users[idx] = {
                email: this.email,
                password: this.password,
                fullName: this.fullName,
                phoneNumber: this.phoneNumber,
                role: this.role,
                isVerified: this.isVerified,
                verificationToken: this.verificationToken,
                verificationExpires: this.verificationExpires,
                resetPasswordToken: this.resetPasswordToken,
                resetPasswordExpires: this.resetPasswordExpires,
                passwordChangedAt: this.passwordChangedAt,
                createdAt: this.createdAt
              };
              await writeJSON(dbData);
            }
            return this;
          }
        };
      }
    },

    async create(data) {
      const email = data.email.toLowerCase();
      if (useMongo) {
        const user = new UserModel({
          email,
          password: data.password,
          fullName: data.fullName,
          phoneNumber: data.phoneNumber,
          role: data.role || 'user',
          isVerified: data.isVerified !== undefined ? data.isVerified : false,
          verificationToken: data.verificationToken || null,
          verificationExpires: data.verificationExpires || null
        });
        return await user.save();
      } else {
        const db = readJSON();
        const newUser = {
          email,
          password: data.password,
          fullName: data.fullName,
          phoneNumber: data.phoneNumber,
          role: data.role || 'user',
          isVerified: data.isVerified !== undefined ? data.isVerified : false,
          verificationToken: data.verificationToken || null,
          verificationExpires: data.verificationExpires || null,
          createdAt: new Date().toISOString()
        };
        db.users.push(newUser);
        await writeJSON(db);
        return newUser;
      }
    }
  }
};

// Cryptography Utilities (Zero External dependencies, safe for Windows builds)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  try {
    const [salt, hash] = storedPassword.split(':');
    if (!salt || !hash) return false;
    const verifyHash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
  } catch (err) {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(payload) {
  const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days expiry
  const tokenPayload = { ...payload, iat: Date.now(), exp: expiry };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_TOKEN).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', ADMIN_TOKEN).update(`${header}.${body}`).digest('base64url');
    if (signature !== expectedSig) return null;
    const decodedBody = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (decodedBody.exp && decodedBody.exp < Date.now()) {
      return null; // Expired
    }
    return decodedBody;
  } catch (err) {
    return null;
  }
}

// In-Memory map to store short-lived single-use download tokens.
const downloadTokens = new Map();

// Background job to clean up expired download tokens every 30 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  let cleanCount = 0;
  for (const [token, data] of downloadTokens.entries()) {
    if (data.expiresAt < now) {
      downloadTokens.delete(token);
      cleanCount++;
    }
  }
  if (cleanCount > 0) {
    console.log(`[License Server] Đã dọn dẹp ${cleanCount} download token hết hạn khỏi memory.`);
  }
}, 30 * 60 * 1000);

// Rate Limit Implementation
const requestStore = {};
function createRateLimiter(maxRequests, windowMs, message) {
  return function(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    
    if (!requestStore[ip]) requestStore[ip] = [];
    requestStore[ip] = requestStore[ip].filter(timestamp => now - timestamp < windowMs);
    
    if (requestStore[ip].length >= maxRequests) {
      return res.status(429).json({ error: message || 'Quá nhiều yêu cầu. Vui lòng thử lại sau!' });
    }
    
    requestStore[ip].push(now);
    next();
  };
}

const authLimiter = createRateLimiter(10, 60 * 1000, 'Quá nhiều yêu cầu đăng nhập hoặc đăng ký. Vui lòng thử lại sau 1 phút!');
const hwidResetLimiter = createRateLimiter(5, 60 * 60 * 1000, 'Bạn đã thực hiện reset quá nhiều lần trong 1 giờ. Vui lòng thử lại sau!');

// Authentication Middleware
async function userAuth(req, res, next) {
  let token = null;
  
  // 1. Try to read from cookie
  if (req.headers.cookie) {
    const cookies = {};
    req.headers.cookie.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      cookies[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    });
    if (cookies.token) token = cookies.token;
  }
  
  // 2. Fallback to Authorization Header
  if (!token && req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Chưa đăng nhập, vui lòng đăng nhập trước!' });
  }

  const payload = verifyToken(token);
  if (!payload || !payload.email) {
    return res.status(401).json({ error: 'Phiên làm việc hết hạn hoặc không hợp lệ!' });
  }

  try {
    const user = await DB.users.findOne({ email: payload.email });
    if (!user) {
      return res.status(401).json({ error: 'Không tìm thấy thông tin tài khoản!' });
    }
    
    // Consistent millisecond comparison to prevent compromised sessions after password change
    if (user.passwordChangedAt && payload.iat < new Date(user.passwordChangedAt).getTime()) {
      return res.status(401).json({ error: 'Mật khẩu đã được thay đổi. Vui lòng đăng nhập lại!' });
    }

    req.user = payload;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi xác thực: ' + err.message });
  }
}

// HTML Escaping Utility for Email Safety
function escapeHtml(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Consolidated Email Sender Helper
async function sendMailHelper({ toEmail, subject, bodyContent }) {
  const htmlTemplate = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Video Studio Tools</title>
    </head>
    <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 20px; border-bottom: 2px solid #6366f1; padding-bottom: 15px;">
        <h2 style="color: #6366f1; margin: 0;">Video Studio Tools</h2>
        <p style="font-size: 12px; color: #9ca3af; margin: 5px 0 0 0;">Hệ thống quản lý & cấp bản quyền tự động</p>
      </div>
      ${bodyContent}
      <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 30px 0 20px 0;" />
      <div style="font-size: 11px; color: #9ca3af; text-align: center;">
        <p>Đây là email tự động từ hệ thống Video Studio License Server. Vui lòng không trả lời trực tiếp email này.</p>
        <p>© 2026 Video Studio Tools. All rights reserved.</p>
      </div>
    </body>
    </html>
  `;

  const host = process.env.EMAIL_HOST;
  const port = process.env.EMAIL_PORT;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (host && port && user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: Number(port) === 465,
        auth: { user, pass }
      });
      await transporter.sendMail({
        from: `"Video Studio Tools" <${user}>`,
        to: toEmail,
        subject,
        html: htmlTemplate
      });
      console.log(`[License Server] [Email] Gửi thư thành công tới: ${toEmail}`);
      return;
    } catch (err) {
      console.error(`[License Server] [Email Error] Gửi mail SMTP lỗi (${err.message}). Fallback ghi log...`);
    }
  }

  // Fallback to writing in emails.log and console
  const logFile = path.join(__dirname, 'emails.log');
  const logEntry = `
======================================================================
[EMAIL LOG] ${new Date().toISOString()}
TO: ${toEmail}
SUBJECT: ${subject}
----------------------------------------------------------------------
${bodyContent.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()}
======================================================================
`;
  try {
    fs.appendFileSync(logFile, logEntry, 'utf8');
    console.log(`[License Server] [Email Fallback] Đã ghi log email gửi tới ${toEmail} vào file emails.log`);
  } catch (err) {
    console.error(`[License Server] Lỗi khi ghi file log email:`, err.message);
  }
}

// 1. Send Email for License Keys
async function sendLicenseEmail({ toEmail, fullName, key, planType, expiresAt, status }) {
  const escapedName = escapeHtml(fullName);
  const escapedKey = escapeHtml(key);
  const escapedPlan = planType === 'trial' ? 'Dùng thử (7 ngày)' : (planType === 'monthly' ? 'Gói Tháng (30 ngày)' : 'Gói Năm (365 ngày)');
  const formattedExpires = new Date(expiresAt).toLocaleDateString('vi-VN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  
  const subject = `[Video Studio Tools] Mã bản quyền kích hoạt dịch vụ của bạn`;
  
  let bodyContent = '';
  if (status === 'pending') {
    const price = planType === 'monthly' ? '199.000đ' : '1.499.000đ';
    const keyRef = key.split('-')[1]; // VST STUDIO-XXXX-XXXX... => VST XXXX
    const memo = `VST ${keyRef}`;
    
    bodyContent = `
      <h3>Chào bạn ${escapedName},</h3>
      <p>Cảm ơn bạn đã đăng ký mua gói dịch vụ <strong>${escapedPlan}</strong> của Video Studio Tools!</p>
      <p>Yêu cầu mua gói của bạn đang ở trạng thái <strong>Chờ thanh toán (Pending)</strong>.</p>
      <hr style="border: 0; border-top: 1px solid #e5e7eb;" />
      <h4 style="color: #6366f1; margin-top: 15px;">Thông tin chuyển khoản thanh toán:</h4>
      <ul>
        <li><strong>Số tiền cần chuyển:</strong> <span style="font-weight: bold; color: #e11d48; font-size: 16px;">${price}</span></li>
        <li><strong>Nội dung chuyển khoản (Bắt buộc đúng):</strong> <span style="font-family: monospace; font-size: 16px; background: #fee2e2; color: #991b1b; padding: 4px 8px; border-radius: 4px; font-weight: bold; border: 1px solid #fca5a5;">${memo}</span></li>
      </ul>
      <p style="color: #4b5563; font-size: 13px;">* Hệ thống sử dụng nội dung chuyển khoản trên để đối soát và tự động duyệt kích hoạt key bản quyền của bạn.</p>
      <p>Mã bản quyền chờ kích hoạt của bạn (chưa hoạt động): <strong>${escapedKey}</strong></p>
    `;
  } else {
    bodyContent = `
      <h3>Chào bạn ${escapedName},</h3>
      <p>Mã bản quyền cho gói dịch vụ <strong>${escapedPlan}</strong> của bạn đã được kích hoạt thành công!</p>
      <hr style="border: 0; border-top: 1px solid #e5e7eb;" />
      <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; border: 1px solid #bbf7d0; margin: 15px 0;">
        <p style="margin: 0 0 10px 0; color: #166534; font-weight: 600;">🔑 Mã bản quyền (License Key):</p>
        <p style="font-family: monospace; font-size: 18px; font-weight: bold; color: #15803d; margin: 0; background: #fff; padding: 8px 12px; border-radius: 4px; border: 1px solid #86efac; display: inline-block; letter-spacing: 1px;">${escapedKey}</p>
        <p style="margin: 15px 0 0 0; font-size: 13px; color: #166534;">📅 Hạn sử dụng: <strong>${formattedExpires}</strong></p>
      </div>
      <h4 style="margin-top: 15px;">Hướng dẫn sử dụng:</h4>
      <ol>
        <li>Tải và cài đặt phần mềm Video Studio Tools.</li>
        <li>Đăng nhập tài khoản và nhập mã key trên để kích hoạt phần mềm.</li>
      </ol>
      <p>Chúc bạn có những video tuyệt vời cùng Video Studio Tools!</p>
    `;
  }

  await sendMailHelper({ toEmail, subject, bodyContent });
}

// 2. Send Verification Link Email
async function sendVerificationEmail({ toEmail, fullName, token }) {
  const escapedName = escapeHtml(fullName);
  const domain = process.env.APP_URL || `http://localhost:${PORT}`;
  const verifyLink = `${domain}/verify-email.html?token=${token}`;
  
  const subject = `[Video Studio Tools] Kích hoạt tài khoản của bạn`;
  const bodyContent = `
    <h3>Chào bạn ${escapedName},</h3>
    <p>Cảm ơn bạn đã đăng ký tài khoản tại Video Studio Tools!</p>
    <p>Vui lòng nhấp vào liên kết dưới đây để kích hoạt tài khoản của bạn và đăng nhập sử dụng hệ thống:</p>
    <div style="margin: 20px 0;">
      <a href="${verifyLink}" style="background-color: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Kích hoạt tài khoản</a>
    </div>
    <p style="font-size: 12px; color: #4b5563;">* Đường liên kết này sẽ hết hạn sau 24 giờ kể từ thời điểm đăng ký.</p>
    <p style="font-size: 12px; color: #4b5563;">Nếu nút trên không hoạt động, bạn có thể copy link sau dán vào trình duyệt: <br/> ${verifyLink}</p>
  `;
  
  await sendMailHelper({ toEmail, subject, bodyContent });
}

// 3. Send Password Reset Link Email
async function sendResetPasswordEmail({ toEmail, fullName, token }) {
  const escapedName = escapeHtml(fullName);
  const domain = process.env.APP_URL || `http://localhost:${PORT}`;
  const resetLink = `${domain}/reset-password.html?token=${token}`;
  
  const subject = `[Video Studio Tools] Yêu cầu đặt lại mật khẩu`;
  const bodyContent = `
    <h3>Chào bạn ${escapedName},</h3>
    <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn tại Video Studio Tools.</p>
    <p>Nếu bạn thực hiện yêu cầu này, vui lòng nhấp vào nút dưới đây để đổi mật khẩu mới:</p>
    <div style="margin: 20px 0;">
      <a href="${resetLink}" style="background-color: #e11d48; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Đặt lại mật khẩu</a>
    </div>
    <p style="font-size: 12px; color: #4b5563;">* Đường liên kết này sẽ hết hạn sau 1 giờ kể từ thời điểm yêu cầu.</p>
    <p style="font-size: 12px; color: #4b5563;">Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.</p>
    <p style="font-size: 12px; color: #4b5563;">Nếu nút trên không hoạt động, bạn có thể copy link sau dán vào trình duyệt: <br/> ${resetLink}</p>
  `;
  
  await sendMailHelper({ toEmail, subject, bodyContent });
}

// 1. API Kích hoạt bản quyền từ Client
app.post('/api/server/activate', async (req, res) => {
  const { key, hwid } = req.body;
  if (!key || !hwid) {
    return res.status(400).json({ error: 'Mã key và HWID là bắt buộc' });
  }

  try {
    const license = await DB.licenses.findOne({ key });

    if (!license) {
      return res.status(404).json({ error: 'Mã bản quyền không tồn tại' });
    }

    if (license.status !== 'active') {
      return res.status(403).json({ error: 'Bản quyền đã bị đình chỉ hoặc thu hồi' });
    }

    if (license.paymentStatus === 'pending') {
      return res.status(403).json({ error: 'Bản quyền này đang ở trạng thái chờ kích hoạt thanh toán!' });
    }

    const expiresDate = new Date(license.expiresAt);
    if (expiresDate < new Date()) {
      return res.status(403).json({ error: 'Bản quyền đã hết hạn sử dụng' });
    }

    // Khóa thiết bị (HWID Binding)
    if (license.hwid && license.hwid !== hwid) {
      return res.status(400).json({ error: 'Mã bản quyền đã được liên kết với thiết bị khác' });
    }

    if (!license.hwid) {
      license.hwid = hwid;
      await license.save();
      console.log(`[License Server] Key ${key} đã kích hoạt cho thiết bị: ${hwid}`);
    }

    // Tạo signature Ed25519
    const expiresStr = expiresDate instanceof Date ? expiresDate.toISOString() : expiresDate;
    const payload = {
      key: license.key,
      hwid: license.hwid,
      expiresAt: expiresStr,
      issuedAt: Date.now(),
      nonce: crypto.randomUUID()
    };

    const signature = crypto.sign(
      null,
      Buffer.from(JSON.stringify(payload)),
      PRIVATE_KEY
    ).toString('hex');

    res.json({
      status: 'success',
      expiresAt: expiresStr,
      issuedAt: payload.issuedAt,
      nonce: payload.nonce,
      signature
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi máy chủ: ' + err.message });
  }
});

// 2. API Tái xác thực bản quyền trực tuyến (Heartbeat Check)
app.post('/api/server/verify', async (req, res) => {
  const { key, hwid } = req.body;
  if (!key || !hwid) {
    return res.status(400).json({ error: 'Mã key và HWID là bắt buộc' });
  }

  try {
    const license = await DB.licenses.findOne({ key });

    if (!license || license.status !== 'active' || license.paymentStatus !== 'active' || new Date(license.expiresAt) < new Date() || license.hwid !== hwid) {
      return res.json({ status: 'inactive', error: 'Bản quyền không khả dụng hoặc bị đổi thiết bị' });
    }

    res.json({ status: 'active' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi máy chủ: ' + err.message });
  }
});

// ==========================================
// API USER & AUTH
// ==========================================

// Endpoint check config mode
app.get('/api/config', (req, res) => {
  res.json({ isDev: process.env.NODE_ENV !== 'production' });
});

// API Đăng ký
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, fullName, phoneNumber } = req.body;
  if (!email || !password || !fullName || !phoneNumber) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ các thông tin đăng ký!' });
  }

  // Password length validation
  if (password.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu phải dài tối thiểu 8 ký tự!' });
  }

  try {
    const existing = await DB.users.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Địa chỉ email này đã được đăng ký hệ thống!' });
    }

    // Generate random verification token
    const token = crypto.randomBytes(32).toString('hex');
    const hashed = hashToken(token);
    const expires = new Date();
    expires.setHours(expires.getHours() + 24); // 24 hours expiry

    const hashedPassword = hashPassword(password);
    await DB.users.create({
      email,
      password: hashedPassword,
      fullName,
      phoneNumber,
      role: 'user',
      isVerified: false, // Must verify email first
      verificationToken: hashed,
      verificationExpires: expires
    });

    // Send verification link via email
    await sendVerificationEmail({ toEmail: email, fullName, token });

    res.status(201).json({ success: true, message: 'Đăng ký tài khoản thành công! Vui lòng kiểm tra email của bạn để xác thực tài khoản.' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi đăng ký: ' + err.message });
  }
});

// API Đăng nhập
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập email và mật khẩu!' });
  }

  try {
    const user = await DB.users.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác!' });
    }

    // Check email verification status
    if (!user.isVerified) {
      return res.status(403).json({ error: 'Tài khoản chưa được xác thực email. Vui lòng kiểm tra hòm thư hoặc bấm vào "Gửi lại email xác thực"!' });
    }

    const isMatch = verifyPassword(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác!' });
    }

    const token = generateToken({ email: user.email, fullName: user.fullName, role: user.role });
    
    // Cookie security rules
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({
      success: true,
      user: {
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi đăng nhập: ' + err.message });
  }
});

// API Gửi lại email xác nhận
app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Địa chỉ email là bắt buộc!' });
  }

  try {
    const user = await DB.users.findOne({ email });
    if (!user) {
      // Return 200 OK generic response to prevent user enumeration
      return res.json({ success: true, message: 'Nếu tài khoản tồn tại và chưa được xác thực, email kích hoạt mới đã được gửi đi.' });
    }

    // Check if already verified
    if (user.isVerified) {
      return res.status(400).json({ error: 'Tài khoản này đã được xác thực từ trước. Vui lòng quay lại đăng nhập!' });
    }

    // Generate new token to overwrite old ones
    const token = crypto.randomBytes(32).toString('hex');
    const hashed = hashToken(token);
    const expires = new Date();
    expires.setHours(expires.getHours() + 24);

    user.verificationToken = hashed;
    user.verificationExpires = expires;
    await user.save();

    await sendVerificationEmail({ toEmail: user.email, fullName: user.fullName, token });

    res.json({ success: true, message: 'Đã gửi lại link xác thực thành công. Vui lòng kiểm tra email!' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi gửi lại xác thực: ' + err.message });
  }
});

// API xác thực email (xử lý link người dùng click)
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Mã token xác thực là bắt buộc!' });
  }

  try {
    const hashed = hashToken(token);
    const user = await DB.users.findOne({ verificationToken: hashed });

    if (!user) {
      return res.status(400).json({ error: 'Mã token xác thực không hợp lệ hoặc đã được sử dụng!' });
    }

    if (user.verificationExpires && new Date(user.verificationExpires) < new Date()) {
      return res.status(400).json({ error: 'Liên kết xác thực đã hết hạn! Vui lòng yêu cầu gửi lại liên kết mới.' });
    }

    // Verify user and clean token (Single-use token lifecycle)
    user.isVerified = true;
    user.verificationToken = null;
    user.verificationExpires = null;
    await user.save();

    res.json({ success: true, message: 'Kích hoạt tài khoản thành công! Bạn có thể quay lại đăng nhập.' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi xác thực email: ' + err.message });
  }
});

// API Yêu cầu quên mật khẩu
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Địa chỉ email là bắt buộc!' });
  }

  const genericResponse = { success: true, message: 'Nếu địa chỉ email tồn tại trên hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu trong vài phút.' };

  try {
    const user = await DB.users.findOne({ email });
    if (!user) {
      // Return 200 OK generic to prevent user enumeration
      return res.json(genericResponse);
    }

    // Generate reset password token (valid 1 hour)
    const token = crypto.randomBytes(32).toString('hex');
    const hashed = hashToken(token);
    const expires = new Date();
    expires.setHours(expires.getHours() + 1);

    user.resetPasswordToken = hashed;
    user.resetPasswordExpires = expires;
    await user.save();

    await sendResetPasswordEmail({ toEmail: user.email, fullName: user.fullName, token });

    res.json(genericResponse);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi yêu cầu đặt lại mật khẩu: ' + err.message });
  }
});

// API Thực hiện đặt lại mật khẩu mới
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token và mật khẩu mới là bắt buộc!' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu phải dài tối thiểu 8 ký tự!' });
  }

  try {
    const hashed = hashToken(token);
    const user = await DB.users.findOne({ resetPasswordToken: hashed });

    if (!user) {
      return res.status(400).json({ error: 'Mã token khôi phục mật khẩu không hợp lệ hoặc đã qua sử dụng!' });
    }

    if (user.resetPasswordExpires && new Date(user.resetPasswordExpires) < new Date()) {
      return res.status(400).json({ error: 'Liên kết đặt lại mật khẩu đã hết hạn!' });
    }

    const hashedPassword = hashPassword(newPassword);
    
    // Invalidate old sessions by updating passwordChangedAt
    user.password = hashedPassword;
    user.passwordChangedAt = new Date();
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    res.json({ success: true, message: 'Đặt lại mật khẩu thành công! Bạn có thể sử dụng mật khẩu mới để đăng nhập.' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi đặt lại mật khẩu: ' + err.message });
  }
});

// API Đăng xuất
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Đăng xuất thành công!' });
});

// API Lấy danh sách keys của user
app.get('/api/user/keys', userAuth, async (req, res) => {
  try {
    const keys = await DB.licenses.find({ userEmail: req.user.email });
    res.json({ success: true, keys });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi tải danh sách key: ' + err.message });
  }
});

// API Đăng ký gói bản quyền
app.post('/api/plans/subscribe', userAuth, async (req, res) => {
  const { planType } = req.body;
  if (!['trial', 'monthly', 'yearly'].includes(planType)) {
    return res.status(400).json({ error: 'Gói dịch vụ đăng ký không hợp lệ!' });
  }

  try {
    // 1. Chặn nếu đăng ký dùng thử > 1 lần
    if (planType === 'trial') {
      const keys = await DB.licenses.find({ userEmail: req.user.email });
      const hasUsedTrial = keys.some(k => k.planType === 'trial');
      if (hasUsedTrial) {
        return res.status(400).json({ error: 'Mỗi tài khoản chỉ được phép đăng ký sử dụng thử 1 lần duy nhất!' });
      }
    } else {
      // 1.5. Chặn nếu người dùng đang có bất kỳ key nào ở trạng thái pending (Giải pháp 1)
      const keys = await DB.licenses.find({ userEmail: req.user.email });
      const pendingKey = keys.find(k => k.paymentStatus === 'pending');
      if (pendingKey) {
        return res.status(400).json({ 
          error: 'Bạn đang có một mã bản quyền chờ thanh toán. Vui lòng thanh toán mã cũ trước!',
          pendingKey: pendingKey.key
        });
      }
    }

    // 2. Tạo License Key mới
    const key = `STUDIO-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    let days = 7;
    if (planType === 'monthly') days = 30;
    if (planType === 'yearly') days = 365;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
    const expiresStr = expiresAt.toISOString();

    const paymentStatus = planType === 'trial' ? 'active' : 'pending';

    const license = await DB.licenses.create({
      key,
      customerName: req.user.fullName,
      userEmail: req.user.email,
      planType,
      paymentStatus,
      hwid: null,
      expiresAt: expiresStr,
      status: 'active',
      resetCount: 0,
      lastResetAt: null,
      createdAt: new Date().toISOString()
    });

    // 3. Gửi Email thông báo (hoặc ghi log fallback)
    await sendLicenseEmail({
      toEmail: req.user.email,
      fullName: req.user.fullName,
      key,
      planType,
      expiresAt: expiresStr,
      status: paymentStatus
    });

    res.json({
      success: true,
      key: license.key,
      planType: license.planType,
      paymentStatus: license.paymentStatus,
      expiresAt: expiresStr
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi đăng ký gói dịch vụ: ' + err.message });
  }
});

// API Lấy thông tin key công khai (Không cần Auth, dùng cho trang thanh toán)
app.get('/api/plans/status', async (req, res) => {
  const { key } = req.query;
  if (!key) {
    return res.status(400).json({ error: 'Mã key bản quyền là bắt buộc!' });
  }

  try {
    const license = await DB.licenses.findOne({ key });
    if (!license) {
      return res.status(404).json({ error: 'Không tìm thấy key bản quyền này!' });
    }

    res.json({
      success: true,
      key: license.key,
      planType: license.planType,
      paymentStatus: license.paymentStatus,
      status: license.status,
      expiresAt: license.expiresAt,
      createdAt: license.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi lấy thông tin key: ' + err.message });
  }
});

// API Mô phỏng duyệt thanh toán (chỉ chạy ở dev/test, không cần auth để dễ kiểm thử)
app.post('/api/user/simulate-payment', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not Found');
  }

  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Mã key thanh toán là bắt buộc!' });
  }

  try {
    const license = await DB.licenses.findOne({ key });
    if (!license) {
      return res.status(404).json({ error: 'Không tìm thấy key bản quyền này!' });
    }

    if (license.paymentStatus === 'active') {
      return res.status(400).json({ error: 'Key bản quyền này đã ở trạng thái được kích hoạt thanh toán!' });
    }

    // Reset lại hạn sử dụng bắt đầu tính từ lúc thanh toán thành công
    let days = 30; // Mặc định gói tháng
    if (license.planType === 'yearly') days = 365;
    if (license.planType === 'trial') days = 7;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    license.expiresAt = expiresAt;
    license.paymentStatus = 'active';
    await license.save();

    // Gửi email báo kích hoạt thành công (nếu key có email liên kết)
    if (license.userEmail) {
      try {
        const user = await DB.users.findOne({ email: license.userEmail });
        const fullName = user ? user.fullName : 'Khách hàng';
        await sendLicenseEmail({
          toEmail: license.userEmail,
          fullName,
          key: license.key,
          planType: license.planType,
          expiresAt: license.expiresAt,
          status: 'active'
        });
      } catch (emailErr) {
        console.error('[License Server] Gửi email kích hoạt lỗi:', emailErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Mô phỏng thanh toán thành công, Key đã được kích hoạt!',
      key: license.key,
      paymentStatus: license.paymentStatus
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi duyệt thanh toán: ' + err.message });
  }
});

// API tạo download token ngắn hạn (15 phút, dùng 1 lần)
app.post('/api/user/generate-download-token', userAuth, (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000;
    
    downloadTokens.set(token, {
      userEmail: req.user.email,
      expiresAt
    });

    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: 'Không tạo được mã tải file: ' + err.message });
  }
});

// API Reset HWID thiết bị của User (Giới hạn rate limit 5 lần/giờ)
app.post('/api/user/reset-hwid', userAuth, hwidResetLimiter, async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Mã key bản quyền là bắt buộc!' });
  }

  try {
    const license = await DB.licenses.findOne({ key });
    if (!license) {
      return res.status(404).json({ error: 'Không tìm thấy key bản quyền này!' });
    }

    if (license.userEmail !== req.user.email) {
      return res.status(403).json({ error: 'Bạn không sở hữu key bản quyền này!' });
    }

    if (!license.hwid) {
      return res.status(400).json({ error: 'Key bản quyền này chưa kích hoạt liên kết thiết bị!' });
    }

    // Quota check: tối đa 2 lần/năm
    const now = new Date();
    const currentYear = now.getFullYear();
    
    if (license.lastResetAt) {
      const lastReset = new Date(license.lastResetAt);
      const lastResetYear = lastReset.getFullYear();
      
      if (lastResetYear === currentYear) {
        if (license.resetCount >= 2) {
          return res.status(403).json({ error: 'Bạn đã vượt quá số lần tự reset thiết bị tối đa cho key này (2 lần/năm).' });
        }
        license.resetCount++;
      } else {
        // Reset quota cho năm mới
        license.resetCount = 1;
      }
    } else {
      license.resetCount = 1;
    }

    license.hwid = null;
    license.lastResetAt = now.toISOString();
    await license.save();

    res.json({
      success: true,
      message: 'Giải phóng thiết bị thành công! Bạn có thể kích hoạt lại trên máy mới.',
      resetCount: license.resetCount,
      lastResetAt: license.lastResetAt
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi reset thiết bị: ' + err.message });
  }
});

// Endpoint tải bộ cài installer an toàn
app.get('/download', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('Thiếu Download Token xác thực!');
  }

  const tokenData = downloadTokens.get(token);
  if (!tokenData) {
    return res.status(403).send('Download Token không hợp lệ hoặc đã hết hạn!');
  }

  if (tokenData.expiresAt < Date.now()) {
    downloadTokens.delete(token);
    return res.status(403).send('Download Token đã hết hạn!');
  }

  // Delete to make it single-use
  downloadTokens.delete(token);

  // Absolute path safe resolving
  const filePath = path.resolve(__dirname, '..', 'dist', 'Video Studio Tools Setup 1.0.0.exe');
  
  res.attachment('Video Studio Tools Setup 1.0.0.exe');
  res.sendFile(filePath, { acceptRanges: true }, (err) => {
    if (err) {
      console.error('[License Server] Lỗi truyền file bộ cài:', err.message);
      if (!res.headersSent) {
        res.status(404).send('Tệp cài đặt phần mềm chưa sẵn sàng hoặc đã bị xóa. Vui lòng thử lại sau!');
      }
    }
  });
});

// ==========================================
// API ADMIN (Bảo vệ bằng X-Admin-Token)
// ==========================================
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Không có quyền truy cập API Admin' });
  }
  next();
}

// A. API lấy toàn bộ danh sách Keys
app.get('/api/admin/keys', adminAuth, async (req, res) => {
  try {
    const keys = await DB.licenses.find();
    res.json({ success: true, keys });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi lấy danh sách keys: ' + err.message });
  }
});

// B. API tạo mới Key bản quyền
app.post('/api/admin/generate-key', adminAuth, async (req, res) => {
  const { days, customerName } = req.body;
  if (!days || isNaN(days)) {
    return res.status(400).json({ error: 'Số ngày sử dụng không hợp lệ' });
  }

  const name = customerName && customerName.trim() ? customerName.trim() : 'Khách lẻ';
  const key = `STUDIO-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + Number(days));

  try {
    const expiresStr = expiresAt.toISOString();
    const license = await DB.licenses.create({
      key,
      customerName: name,
      userEmail: null,
      planType: 'monthly',
      paymentStatus: 'active',
      hwid: null,
      expiresAt: expiresStr,
      status: 'active',
      resetCount: 0,
      lastResetAt: null,
      createdAt: new Date().toISOString()
    });

    res.json({ success: true, key, expiresAt: expiresStr, customerName: name });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi tạo key: ' + err.message });
  }
});

// C. API Reset HWID (Admin bypass quota)
app.post('/api/admin/reset-hwid', adminAuth, async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Key bản quyền là bắt buộc' });
  }

  try {
    const license = await DB.licenses.findOne({ key });

    if (!license) {
      return res.status(404).json({ error: 'Không tìm thấy key bản quyền này' });
    }

    license.hwid = null;
    license.resetCount++;
    license.lastResetAt = new Date().toISOString();
    await license.save();

    res.json({ success: true, message: 'Đã giải phóng thiết bị liên kết với mã bản quyền này', resetCount: license.resetCount });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi reset HWID: ' + err.message });
  }
});

// D. API đình chỉ/kích hoạt trạng thái Key (Suspend/Activate)
app.post('/api/admin/toggle-status', adminAuth, async (req, res) => {
  const { key, status } = req.body;
  if (!key || !['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Mã key và trạng thái (active/suspended) là bắt buộc' });
  }

  try {
    const license = await DB.licenses.findOne({ key });
    if (!license) {
      return res.status(404).json({ error: 'Không tìm thấy key bản quyền này' });
    }

    license.status = status;
    await license.save();

    res.json({ success: true, message: `Đã thay đổi trạng thái key sang: ${status}`, status });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi cập nhật trạng thái: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[License Server] Máy chủ bản quyền đang chạy tại http://127.0.0.1:${PORT}`);
  console.log(`[License Server] Trang quản trị Admin khả dụng tại http://127.0.0.1:${PORT}/admin`);
});
