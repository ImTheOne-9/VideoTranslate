const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');

// Load environment variables from .env if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const envLines = envContent.split(/\r?\n/);
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Loại bỏ comment ghi chú ở cuối dòng nếu có
      const hashIndex = trimmed.indexOf('#');
      let cleanLine = trimmed;
      if (hashIndex !== -1) {
        cleanLine = trimmed.substring(0, hashIndex).trim();
      }
      if (!cleanLine) continue;
      const parts = cleanLine.split('=');
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

let resendClient = null;
if (process.env.RESEND_API_KEY) {
  try {
    resendClient = new Resend(process.env.RESEND_API_KEY);
    console.log(`[License Server] Resend Config: Key=***, From=${process.env.RESEND_FROM || 'none'}`);
  } catch (err) {
    console.error('[License Server] Lỗi khi khởi tạo Resend SDK:', err.message);
  }
}

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('[License Server] Stripe Configured.');
  } catch (err) {
    console.error('[License Server] Lỗi khi khởi tạo Stripe SDK:', err.message);
  }
}

let payOS = null;
if (process.env.PAYOS_CLIENT_ID && process.env.PAYOS_API_KEY && process.env.PAYOS_CHECKSUM_KEY) {
  try {
    const { PayOS } = require('@payos/node');
    payOS = new PayOS({
      clientId: process.env.PAYOS_CLIENT_ID,
      apiKey: process.env.PAYOS_API_KEY,
      checksumKey: process.env.PAYOS_CHECKSUM_KEY
    });
    console.log('[License Server] PayOS Configured.');
  } catch (err) {
    console.error('[License Server] Lỗi khi khởi tạo PayOS SDK:', err.message);
  }
}

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/license_server';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'my_super_secret_admin_token_2026';

let stripeWebhookHandler = null;

const app = express();
app.set('trust proxy', true);

// Stripe Webhook Endpoint receives raw body before express.json() parses it
app.post('/api/payment/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (stripeWebhookHandler) {
    return stripeWebhookHandler(req, res);
  }
  res.status(404).json({ error: 'Stripe webhook handler not set' });
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

// Khóa riêng tư Ed25519 để ký bản quyền (Trùng khớp với Public Key nhúng ở Client)
// BẢO MẬT: Đọc từ biến môi trường thay vì hardcode trong source code
// Normalize: chuyển \\n literal (2 ký tự) thành newline thật, bỏ ngoặc kép dư
function normalizePem(pem) {
  if (!pem) return pem;
  let result = pem.trim();
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1);
  }
  result = result.replace(/\\\\n/g, '\n');
  return result;
}
const PRIVATE_KEY = normalizePem(process.env.LICENSE_PRIVATE_KEY) || `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINCSkH2ERf0+fEmOBZAFIHPJlihYwsLNf2g4o+QZxmdw
-----END PRIVATE KEY-----`;
if (!process.env.LICENSE_PRIVATE_KEY) {
  console.warn('[License Server] ⚠️ CẢNH BÁO: LICENSE_PRIVATE_KEY chưa được set trong .env. Đang dùng khóa fallback hardcoded - KHÔNG an toàn cho production!');
} else {
  console.log('[License Server] ✅ LICENSE_PRIVATE_KEY đã load từ biến môi trường.');
}

// Mongoose Setup
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  role: { type: String, default: 'user' },
  avatar: { type: String, default: null }, // Base64 avatar image string
  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String, default: null },
  verificationExpires: { type: Date, default: null },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },
  passwordChangedAt: { type: Date, default: null },
  registrationIp: { type: String, default: null },
  registrationHwid: { type: String, default: null },
  deviceHwid: { type: String, default: null }, // HWID that cua thiet bi (lay khi active key dau tien)
  createdAt: { type: Date, default: Date.now }
});
const UserModel = mongoose.model('User', userSchema);

const licenseSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  customerName: { type: String, default: 'Khách lẻ' },
  userEmail: { type: String, default: null },
  planType: { type: String, default: 'trial' },
  paymentStatus: { type: String, enum: ['active', 'pending', 'expired', 'suspended'], default: 'active' },
  hwid: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  resetCount: { type: Number, default: 0 },
  lastResetAt: { type: Date, default: null },
  priceAtPurchase: { type: Number, default: 0 },
  lastExpiryWarningSent: { type: Date, default: null }, // Lan cuoi gui email canh bao sap het han
  createdAt: { type: Date, default: Date.now }
});

// Setup DB indexes
licenseSchema.index({ userEmail: 1, planType: 1 });

const LicenseModel = mongoose.model('License', licenseSchema);

const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
});
const SettingModel = mongoose.model('Setting', settingSchema);

const planSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  durationDays: { type: Number, required: true },
  description: { type: String, default: '' },
  features: { type: [String], default: [] },
  isPopular: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now }
});
const PlanModel = mongoose.model('Plan', planSchema);

// Schema lưu lịch sử giao dịch thanh toán từ SePay/webhook
const paymentTransactionSchema = new mongoose.Schema({
  transactionId:  { type: String, unique: true, required: true }, // mã id/code từ SePay
  amount:         { type: Number, required: true },               // số tiền chuyển khoản
  content:        { type: String, default: '' },                  // nội dung chuyển khoản
  transferCode:   { type: String, default: '' },                  // mã SePay (field code)
  licenseKey:     { type: String, default: null },                // key bản quyền liên quan
  userEmail:      { type: String, default: null },
  customerName:   { type: String, default: null },
  phoneNumber:    { type: String, default: null },
  planType:       { type: String, default: null },
  status:         { type: String, enum: ['confirm', 'pending'], default: 'pending' }, // confirm = kích hoạt OK, pending = lỗi/chờ
  gateway:        { type: String, default: 'sepay' },             // sepay | casso | generic
  rawBody:        { type: mongoose.Schema.Types.Mixed, default: {} },
  paidAt:         { type: Date, default: Date.now }
});
const PaymentTransactionModel = mongoose.model('PaymentTransaction', paymentTransactionSchema);

const DB_FILE = path.join(__dirname, 'database.json');
let useMongo = false;

// Fallback JSON-DB Helpers with Write Queue to prevent race conditions
function readJSON() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ licenses: [], users: [], plans: [], paymentTransactions: [] }, null, 2), 'utf8');
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.licenses) data.licenses = [];
    if (!data.users) data.users = [];
    if (!data.plans) data.plans = [];
    if (!data.paymentTransactions) data.paymentTransactions = [];
    return data;
  } catch (err) {
    console.error('[License Server] Đọc file database.json thất bại, sử dụng cấu trúc rỗng:', err.message);
    return { licenses: [], users: [], plans: [], paymentTransactions: [] };
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
          priceAtPurchase: license.priceAtPurchase || 0,
          lastExpiryWarningSent: license.lastExpiryWarningSent || null,
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
                priceAtPurchase: this.priceAtPurchase,
                lastExpiryWarningSent: this.lastExpiryWarningSent || null,
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
          priceAtPurchase: data.priceAtPurchase || 0,
          lastExpiryWarningSent: data.lastExpiryWarningSent || null,
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
                priceAtPurchase: this.priceAtPurchase,
                lastExpiryWarningSent: this.lastExpiryWarningSent || null,
                createdAt: this.createdAt
              };
              await writeJSON(dbData);
            }
            return this;
          }
        };
      }
    },

    async findOneAndUpdate(query, update, options = {}) {
      if (useMongo) {
        return await LicenseModel.findOneAndUpdate(query, update, options);
      } else {
        const db = readJSON();
        const license = db.licenses.find(l => {
          for (const k in query) {
            if (k === 'paymentStatus' && query[k] && query[k].$in) {
              if (!query[k].$in.includes(l[k])) return false;
            } else if (l[k] !== query[k]) {
              return false;
            }
          }
          return true;
        });

        if (!license) return null;

        if (update.$set) {
          for (const k in update.$set) {
            license[k] = update.$set[k];
          }
        } else {
          for (const k in update) {
            license[k] = update[k];
          }
        }

        await writeJSON(db);

        return {
          ...license,
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
                priceAtPurchase: this.priceAtPurchase,
                lastExpiryWarningSent: this.lastExpiryWarningSent || null,
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
    async find(query = {}) {
      if (useMongo) {
        return await UserModel.find(query).sort({ createdAt: -1 });
      } else {
        const db = readJSON();
        let results = db.users;
        if (query.role) {
          results = results.filter(u => u.role === query.role);
        }
        return results.map(user => ({
          email: user.email,
          password: user.password,
          fullName: user.fullName,
          phoneNumber: user.phoneNumber,
          registrationIp: user.registrationIp || null,
          registrationHwid: user.registrationHwid || null,
          deviceHwid: user.deviceHwid || null,
          role: user.role || 'user',
          avatar: user.avatar || null,
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
                registrationIp: this.registrationIp || null,
                registrationHwid: this.registrationHwid || null,
                deviceHwid: this.deviceHwid || null,
                role: this.role,
                avatar: this.avatar || null,
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
        })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }
    },

    async deleteOne(query) {
      if (useMongo) {
        return await UserModel.deleteOne(query);
      } else {
        const db = readJSON();
        if (query.email) {
          const idx = db.users.findIndex(u => u.email.toLowerCase() === query.email.toLowerCase());
          if (idx !== -1) {
            db.users.splice(idx, 1);
            await writeJSON(db);
            return { deletedCount: 1 };
          }
        }
        return { deletedCount: 0 };
      }
    },

    async findOne(query) {
      if (useMongo) {
        return await UserModel.findOne(query);
      } else {
        const db = readJSON();
        let user = null;
        if (query.email) {
          user = db.users.find(u => u.email.toLowerCase() === query.email.toLowerCase());
        } else if (query.registrationIp) {
          user = db.users.find(u => u.registrationIp === query.registrationIp);
        } else if (query.registrationHwid) {
          user = db.users.find(u => u.registrationHwid === query.registrationHwid);
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
          registrationIp: user.registrationIp || null,
          registrationHwid: user.registrationHwid || null,
          deviceHwid: user.deviceHwid || null,
          role: user.role || 'user',
          avatar: user.avatar || null,
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
                registrationIp: this.registrationIp || null,
                registrationHwid: this.registrationHwid || null,
                deviceHwid: this.deviceHwid || null,
                role: this.role,
                avatar: this.avatar || null,
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
          registrationIp: data.registrationIp || null,
          registrationHwid: data.registrationHwid || null,
          deviceHwid: data.deviceHwid || null,
          role: data.role || 'user',
          avatar: data.avatar || null,
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
          registrationIp: data.registrationIp || null,
          registrationHwid: data.registrationHwid || null,
          deviceHwid: data.deviceHwid || null,
          role: data.role || 'user',
          avatar: data.avatar || null,
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
  },

  settings: {
    async get(key, defaultValue = null) {
      if (useMongo) {
        try {
          const doc = await SettingModel.findOne({ key });
          return doc ? doc.value : defaultValue;
        } catch (e) {
          console.error('[License Server] Lỗi get setting MongoDB:', e.message);
          return defaultValue;
        }
      } else {
        const db = readJSON();
        if (!db.settings) db.settings = {};
        return db.settings[key] !== undefined ? db.settings[key] : defaultValue;
      }
    },

    async set(key, value) {
      if (useMongo) {
        await SettingModel.findOneAndUpdate(
          { key },
          { key, value, updatedAt: new Date() },
          { upsert: true, new: true }
        );
      } else {
        const db = readJSON();
        if (!db.settings) db.settings = {};
        db.settings[key] = value;
        await writeJSON(db);
      }
    }
  },

  plans: {
    async find(query = {}) {
      if (useMongo) {
        return await PlanModel.find(query).sort({ price: 1 });
      } else {
        const db = readJSON();
        let results = db.plans || [];
        if (query.status) {
          results = results.filter(p => p.status === query.status);
        }
        if (query.id) {
          results = results.filter(p => p.id === query.id);
        }
        return results.sort((a, b) => a.price - b.price);
      }
    },

    async findOne(query) {
      if (useMongo) {
        return await PlanModel.findOne(query);
      } else {
        const db = readJSON();
        let plan = null;
        if (query.id) {
          plan = db.plans.find(p => p.id === query.id);
        }
        if (!plan) return null;
        return {
          id: plan.id,
          name: plan.name,
          price: plan.price,
          durationDays: plan.durationDays,
          description: plan.description || '',
          features: plan.features || [],
          isPopular: plan.isPopular !== undefined ? plan.isPopular : false,
          status: plan.status || 'active',
          createdAt: plan.createdAt,
          save: async function() {
            const dbData = readJSON();
            const idx = dbData.plans.findIndex(p => p.id === this.id);
            if (idx !== -1) {
              dbData.plans[idx] = {
                id: this.id,
                name: this.name,
                price: this.price,
                durationDays: this.durationDays,
                description: this.description,
                features: this.features,
                isPopular: this.isPopular,
                status: this.status,
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
        const plan = new PlanModel(data);
        return await plan.save();
      } else {
        const db = readJSON();
        const newPlan = {
          id: data.id,
          name: data.name,
          price: data.price,
          durationDays: data.durationDays,
          description: data.description || '',
          features: data.features || [],
          isPopular: data.isPopular !== undefined ? data.isPopular : false,
          status: data.status || 'active',
          createdAt: data.createdAt || new Date().toISOString()
        };
        db.plans.push(newPlan);
        await writeJSON(db);
        return {
          ...newPlan,
          save: async function() {
            const dbData = readJSON();
            const idx = dbData.plans.findIndex(p => p.id === this.id);
            if (idx !== -1) {
              dbData.plans[idx] = {
                id: this.id,
                name: this.name,
                price: this.price,
                durationDays: this.durationDays,
                description: this.description,
                features: this.features,
                isPopular: this.isPopular,
                status: this.status,
                createdAt: this.createdAt
              };
              await writeJSON(dbData);
            }
            return this;
          }
        };
      }
    },

    async deleteOne(query) {
      if (useMongo) {
        return await PlanModel.deleteOne(query);
      } else {
        const db = readJSON();
        const initialCount = db.plans.length;
        db.plans = db.plans.filter(p => p.id !== query.id);
        await writeJSON(db);
        return { deletedCount: initialCount - db.plans.length };
      }
    }
  },

  paymentTransactions: {
    async find(query = {}, opts = {}) {
      if (useMongo) {
        let q = PaymentTransactionModel.find(query).sort({ paidAt: -1 });
        if (opts.skip) q = q.skip(opts.skip);
        if (opts.limit) q = q.limit(opts.limit);
        return await q;
      } else {
        const db = readJSON();
        let results = [...(db.paymentTransactions || [])];
        // Filter by status
        if (query.status) results = results.filter(t => t.status === query.status);
        // Filter by search
        if (query.$search) {
          const s = query.$search.toLowerCase();
          results = results.filter(t =>
            (t.userEmail || '').toLowerCase().includes(s) ||
            (t.customerName || '').toLowerCase().includes(s) ||
            (t.content || '').toLowerCase().includes(s) ||
            (t.transferCode || '').toLowerCase().includes(s) ||
            (t.licenseKey || '').toLowerCase().includes(s)
          );
        }
        results.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
        const total = results.length;
        if (opts.skip) results = results.slice(opts.skip);
        if (opts.limit) results = results.slice(0, opts.limit);
        return { results, total };
      }
    },

    async countDocuments(query = {}) {
      if (useMongo) {
        return await PaymentTransactionModel.countDocuments(query);
      } else {
        const db = readJSON();
        let results = db.paymentTransactions || [];
        if (query.status) results = results.filter(t => t.status === query.status);
        return results.length;
      }
    },

    async create(data) {
      if (useMongo) {
        try {
          const tx = new PaymentTransactionModel(data);
          return await tx.save();
        } catch (e) {
          // Bỏ qua duplicate key (giao dịch đã lưu)
          if (e.code === 11000) return null;
          throw e;
        }
      } else {
        const db = readJSON();
        if (!db.paymentTransactions) db.paymentTransactions = [];
        // Tránh duplicate
        if (db.paymentTransactions.find(t => t.transactionId === data.transactionId)) return null;
        const newTx = {
          transactionId: data.transactionId,
          amount: data.amount,
          content: data.content || '',
          transferCode: data.transferCode || '',
          licenseKey: data.licenseKey || null,
          userEmail: data.userEmail || null,
          customerName: data.customerName || null,
          phoneNumber: data.phoneNumber || null,
          planType: data.planType || null,
          status: data.status || 'pending',
          gateway: data.gateway || 'sepay',
          rawBody: data.rawBody || {},
          paidAt: data.paidAt || new Date().toISOString()
        };
        db.paymentTransactions.push(newTx);
        await writeJSON(db);
        return newTx;
      }
    }
  }
};

// Function to seed default plans
async function seedDefaultPlans() {
  try {
    const plansCount = await DB.plans.find({});
    if (plansCount.length === 0) {
      console.log('[License Server] Đang khởi tạo các gói dịch vụ mặc định vào Database...');
      const defaultPlans = [
        {
          id: 'trial',
          name: 'Gói Dùng Thử',
          price: 0,
          durationDays: 7,
          description: 'Trải nghiệm đầy đủ tính năng công cụ',
          features: ['Đầy đủ tính năng 100%', 'Sử dụng trên 1 máy tính', 'Hỗ trợ kỹ thuật ưu tiên'],
          isPopular: false,
          status: 'active'
        },
        {
          id: 'monthly',
          name: 'Gói Tháng',
          price: 199000,
          durationDays: 30,
          description: 'Dành cho Creator sáng tạo thường xuyên',
          features: ['Đầy đủ tính năng 100%', 'Sử dụng trên 1 máy tính', 'Tự động nhận key qua email', 'Hỗ trợ kỹ thuật 24/7'],
          isPopular: true,
          status: 'active'
        },
        {
          id: 'yearly',
          name: 'Gói Năm',
          price: 1499000,
          durationDays: 365,
          description: 'Tiết kiệm tối đa chi phí dài hạn',
          features: ['Đầy đủ tính năng 100%', 'Sử dụng trên 1 máy tính', 'Cập nhật các tính năng mới miễn phí', 'Ưu tiên xử lý lỗi & Hỗ trợ VIP'],
          isPopular: false,
          status: 'active'
        }
      ];

      for (const p of defaultPlans) {
        await DB.plans.create(p);
      }
      console.log('[License Server] Đã khởi tạo xong các gói dịch vụ mặc định.');
    }
  } catch (err) {
    console.error('[License Server] Lỗi khởi tạo gói dịch vụ mặc định:', err.message);
  }
}

// Function to migrate legacy licenses (populate priceAtPurchase)
async function migrateLegacyLicenses() {
  try {
    const licenses = await DB.licenses.find({});
    let migratedCount = 0;
    for (const l of licenses) {
      if (l.priceAtPurchase === undefined || l.priceAtPurchase === null || (l.priceAtPurchase === 0 && l.planType !== 'trial')) {
        let price = 0;
        if (l.planType === 'monthly') {
          price = 199000;
        } else if (l.planType === 'yearly') {
          price = 1499000;
        }
        
        // Lấy đối tượng wrapper đầy đủ hỗ trợ save()
        const wrapped = await DB.licenses.findOne({ key: l.key });
        if (wrapped) {
          wrapped.priceAtPurchase = price;
          await wrapped.save();
          migratedCount++;
        }
      }
    }
    if (migratedCount > 0) {
      console.log(`[License Server] [Migration] Đã cập nhật giá trị priceAtPurchase cho ${migratedCount} khóa bản quyền cũ.`);
    }
  } catch (err) {
    console.error('[License Server] Lỗi khi chạy migration giấy phép cũ:', err.message);
  }
}

// Tự động chuyển đổi các license ở trạng thái pending quá 24h thành expired
// Và dọn dẹp (xóa cứng) các license expired quá 30 ngày
async function cleanupExpiredPendingLicenses() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let expiredCount = 0;
    let deletedCount = 0;

    if (useMongo) {
      // 1. Soft-expire pending keys > 24h
      const updateRes = await LicenseModel.updateMany(
        { paymentStatus: 'pending', createdAt: { $lt: oneDayAgo } },
        { paymentStatus: 'expired' }
      );
      expiredCount = updateRes.modifiedCount || 0;

      // 2. Hard-delete expired keys > 30 days
      const deleteRes = await LicenseModel.deleteMany({
        paymentStatus: 'expired',
        createdAt: { $lt: thirtyDaysAgo }
      });
      deletedCount = deleteRes.deletedCount || 0;
    } else {
      const db = readJSON();
      let changed = false;
      
      db.licenses = db.licenses.filter(l => {
        const age = Date.now() - new Date(l.createdAt).getTime();
        if (l.paymentStatus === 'pending' && age >= 24 * 60 * 60 * 1000) {
          l.paymentStatus = 'expired';
          expiredCount++;
          changed = true;
        }
        if (l.paymentStatus === 'expired' && age >= 30 * 24 * 60 * 60 * 1000) {
          deletedCount++;
          changed = true;
          return false; // Xóa khỏi mảng
        }
        return true;
      });

      if (changed) {
        await writeJSON(db);
      }
    }

    if (expiredCount > 0) {
      console.log(`[License Server] [Cleanup] Đã gắn nhãn hết hạn (expired) cho ${expiredCount} khóa bản quyền pending quá 24h.`);
    }
    if (deletedCount > 0) {
      console.log(`[License Server] [Cleanup] Đã dọn dẹp (xóa cứng) ${deletedCount} khóa bản quyền đã expired quá 30 ngày.`);
    }
  } catch (err) {
    console.error('[License Server] Lỗi khi dọn dẹp key pending quá hạn:', err.message);
  }
}

// Chạy định kỳ mỗi 1 giờ
setInterval(cleanupExpiredPendingLicenses, 60 * 60 * 1000);

// Trigger seeding after a short timeout to let MongoDB connect (if using MongoDB)
setTimeout(async () => {
  await seedDefaultPlans();
  await migrateLegacyLicenses();
  await cleanupExpiredPendingLicenses();
}, 2000);

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
  const expiry = Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 1000); // 7 days expiry in seconds
  const tokenPayload = { ...payload, iat: Math.floor(Date.now() / 1000), exp: expiry };
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
    if (decodedBody.exp && decodedBody.exp < Math.floor(Date.now() / 1000)) {
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
    const jwtIssuedAtMs = payload.iat * 1000;
    if (user.passwordChangedAt && jwtIssuedAtMs < new Date(user.passwordChangedAt).getTime()) {
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
      <title>Editnhanh</title>
    </head>
    <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 20px; border-bottom: 2px solid #6366f1; padding-bottom: 15px;">
        <h2 style="color: #6366f1; margin: 0;">Editnhanh</h2>
        <p style="font-size: 12px; color: #9ca3af; margin: 5px 0 0 0;">Hệ thống quản lý & cấp bản quyền tự động</p>
      </div>
      ${bodyContent}
      <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 30px 0 20px 0;" />
      <div style="font-size: 11px; color: #9ca3af; text-align: center;">
        <p>Đây là email tự động từ hệ thống Editnhanh License Server. Vui lòng không trả lời trực tiếp email này.</p>
        <p>© 2026 Editnhanh. All rights reserved.</p>
      </div>
    </body>
    </html>
  `;

  // Try sending via Resend SDK if configured
  if (resendClient) {
    try {
      const fromEmail = process.env.RESEND_FROM || 'Editnhanh <onboarding@resend.dev>';
      const response = await resendClient.emails.send({
        from: fromEmail,
        to: toEmail,
        subject,
        html: htmlTemplate
      });

      if (response.error) {
        console.error(`[License Server] [Email Error] Resend gửi mail lỗi: ${response.error.message}. Fallback sang SMTP/log...`);
      } else {
        console.log(`[License Server] [Email] Gửi thư thành công qua Resend tới: ${toEmail} (ID: ${response.data.id})`);
        return;
      }
    } catch (err) {
      console.error(`[License Server] [Email Error] Lỗi khi gọi API Resend (${err.message}). Fallback...`);
    }
  }

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
        from: `"Editnhanh" <${user}>`,
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
async function sendLicenseEmail({ toEmail, fullName, key, planType, expiresAt, status, price }) {
  const escapedName = escapeHtml(fullName);
  const escapedKey = escapeHtml(key);
  const escapedPlan = planType === 'trial' ? 'Dùng thử (7 ngày)' : (planType === 'monthly' ? 'Gói Tháng (30 ngày)' : 'Gói Năm (365 ngày)');
  const formattedExpires = new Date(expiresAt).toLocaleDateString('vi-VN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  
  const subject = `[Editnhanh] Mã bản quyền kích hoạt dịch vụ của bạn`;
  
  let bodyContent = '';
  if (status === 'pending') {
    const formattedPrice = price !== undefined ? (price === 0 ? '0đ' : price.toLocaleString('vi-VN') + 'đ') : (planType === 'monthly' ? '199.000đ' : '1.499.000đ');
    const keyRef = key.split('-')[1]; // VST STUDIO-XXXX-XXXX... => VST XXXX
    const memo = `VST ${keyRef}`;
    
    bodyContent = `
      <h3>Chào bạn ${escapedName},</h3>
      <p>Cảm ơn bạn đã đăng ký mua gói dịch vụ <strong>${escapedPlan}</strong> của Editnhanh!</p>
      <p>Yêu cầu mua gói của bạn đang ở trạng thái <strong>Chờ thanh toán (Pending)</strong>.</p>
      <hr style="border: 0; border-top: 1px solid #e5e7eb;" />
      <h4 style="color: #6366f1; margin-top: 15px;">Thông tin chuyển khoản thanh toán:</h4>
      <ul>
        <li><strong>Số tiền cần chuyển:</strong> <span style="font-weight: bold; color: #e11d48; font-size: 16px;">${formattedPrice}</span></li>
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
        <li>Tải và cài đặt phần mềm trên <a href="[https://editnhanh.com/](https://editnhanh.com/)" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline">Editnhanh</a>.</li>
        <li>Đăng nhập tài khoản và nhập mã key trên để kích hoạt phần mềm.</li>
      </ol>
      <p>Chúc bạn có những video tuyệt vời cùng Editnhanh!</p>
    `;
  }

  await sendMailHelper({ toEmail, subject, bodyContent });
}

// 2. Send Verification Link Email
async function sendVerificationEmail({ toEmail, fullName, token }) {
  const escapedName = escapeHtml(fullName);
  const domain = process.env.APP_URL || `http://localhost:${PORT}`;
  const verifyLink = `${domain}/verify-email.html?token=${token}`;
  
  const subject = `[Editnhanh] Kích hoạt tài khoản của bạn`;
  const bodyContent = `
    <h3>Chào bạn ${escapedName},</h3>
    <p>Cảm ơn bạn đã đăng ký tài khoản tại Editnhanh!</p>
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
  
  const subject = `[Editnhanh] Yêu cầu đặt lại mật khẩu`;
  const bodyContent = `
    <h3>Chào bạn ${escapedName},</h3>
    <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn tại Editnhanh.</p>
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

    if (license.paymentStatus !== 'active') {
      if (license.paymentStatus === 'pending') {
        return res.status(403).json({ error: 'Bản quyền này đang ở trạng thái chờ kích hoạt thanh toán!' });
      } else {
        return res.status(403).json({ error: 'Bản quyền này chưa được kích hoạt thanh toán hoặc đã hết hạn/bị hủy!' });
      }
    }

    const expiresDate = new Date(license.expiresAt);
    if (expiresDate < new Date()) {
      return res.status(403).json({ error: 'Bản quyền đã hết hạn sử dụng' });
    }

    // Khoa thiet bi theo tai khoan (Huong B): 1 tai khoan = 1 may
    if (license.userEmail) {
      const owner = await DB.users.findOne({ email: license.userEmail });
      if (owner) {
        if (!owner.deviceHwid) {
          // May dau tien active -> gan HWID that vao profile user
          owner.deviceHwid = hwid;
          await owner.save();
          console.log('[License Server] Tai khoan ' + license.userEmail + ' da lien ket thiet bi (HWID that): ' + hwid);
        } else if (owner.deviceHwid !== hwid) {
          // Da co may khac -> chan
          return res.status(403).json({ error: 'Tai khoan nay da duoc lien ket voi mot thiet bi khac. Vui long lien he admin de doi thiet bi.' });
        }
      }
    }

    // Khóa thiết bị (HWID Binding)
    if (license.hwid && license.hwid !== hwid) {
      return res.status(400).json({ error: 'Mã bản quyền đã được liên kết với thiết bị khác' });
    }

    if (!license.hwid) {
      // Chặn lạm dụng dùng thử (Trial abuse) theo thiết bị HWID
      if (license.planType === 'trial') {
        const existingTrial = await DB.licenses.findOne({ hwid, planType: 'trial' });
        if (existingTrial) {
          return res.status(403).json({ error: 'Thiết bị này đã từng kích hoạt sử dụng thử trước đó!' });
        }
      }

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

// Helper: tinh so ngay con lai cua key (null = vinh vien, am = da het han)
function computeDaysLeft(expiresAt) {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  if (exp.getFullYear() >= 9999) return null; // Vinh vien
  const ms = exp.getTime() - Date.now();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

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

    const daysLeft = computeDaysLeft(license.expiresAt);
    res.json({
      status: 'active',
      daysLeft,
      customerName: license.customerName || null,
      planType: license.planType || 'trial'
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi máy chủ: ' + err.message });
  }
});

// ==========================================
// API USER & AUTH
// ==========================================

// Endpoint check config mode
app.get('/api/config', async (req, res) => {
  try {
    const installerUrl = await DB.settings.get('installerUrl', process.env.INSTALLER_URL || '');
    let version = '1.0.6';
    if (installerUrl) {
      const match = installerUrl.match(/(\d+\.\d+\.\d+)/);
      if (match) {
        version = match[1];
      }
    }
    const supportEmail = await DB.settings.get('supportEmail', 'support@editnhanh.com');
    const supportZalo = await DB.settings.get('supportZalo', '');
    const supportTelegram = await DB.settings.get('supportTelegram', '');
    res.json({ 
      isDev: process.env.NODE_ENV !== 'production',
      version,
      contact: { email: supportEmail, zalo: supportZalo, telegram: supportTelegram }
    });
  } catch (err) {
    res.json({ isDev: process.env.NODE_ENV !== 'production', version: '1.0.6', contact: { email: 'support@editnhanh.com', zalo: '', telegram: '' } });
  }
});

// API Đăng ký
// Helper: lay IP that cua client (ho tro sau reverse proxy nginx/VPS)
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim().replace(/^::ffff:/, '');
  }
  const raw = (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
  return String(raw).replace(/^::ffff:/, '');
}

// Helper: validate so dien thoai (chi chu so, bat dau 0, 10-11 chu so)
function validatePhoneNumber(phone) {
  if (!phone) return 'Vui long nhap so dien thoai!';
  const digits = String(phone).replace(/\D/g, '');
  if (!/^0\d{9,10}$/.test(digits)) {
    return 'So dien thoai khong hop le! Chi nhan 10-11 chu so, bat dau bang 0 (VD: 0912345678).';
  }
  return null;
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, fullName, phoneNumber, hwid } = req.body;
  if (!email || !password || !fullName || !phoneNumber) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ các thông tin đăng ký!' });
  }

  // Password length validation
  if (password.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu phải dài tối thiểu 8 ký tự!' });
  }

  // Validate so dien thoai (chi chu so, bat dau 0, 10-11 chu so)
  const phoneDigitsReg = String(phoneNumber||'').replace(/\D/g, '');
  const phoneErr = validatePhoneNumber(phoneDigitsReg);
  if (phoneErr) {
    return res.status(400).json({ error: phoneErr });
  }

  try {
    const existing = await DB.users.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Địa chỉ email này đã được đăng ký hệ thống!' });
    }

    // Kiem tra trung lap theo IP va HWID thiet bi (chong dang ky nhieu tai khoan)
    const clientIp = getClientIp(req);
    const clientHwid = (hwid || '').trim();
    if (clientIp && clientIp !== 'unknown') {
      const existingByIp = await DB.users.findOne({ registrationIp: clientIp });
      if (existingByIp) {
        return res.status(403).json({ error: 'Địa chỉ IP này đã được sử dụng để đăng ký tài khoản khác! Mỗi thiết bị/mạng chỉ được đăng ký một tài khoản.' });
      }
    }
    if (clientHwid) {
      const existingByHwid = await DB.users.findOne({ registrationHwid: clientHwid });
      if (existingByHwid) {
        return res.status(403).json({ error: 'Thiết bị này đã được sử dụng để đăng ký tài khoản khác! Mỗi thiết bị chỉ được đăng ký một tài khoản.' });
      }
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
      phoneNumber: phoneDigitsReg,
      registrationIp: clientIp,
      registrationHwid: clientHwid,
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
        id: user._id || user.email,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role,
        avatar: user.avatar || null,
        createdAt: user.createdAt || new Date().toISOString()
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

// API Lấy thông tin user hiện tại (xác thực phiên)
app.get('/api/auth/me', userAuth, async (req, res) => {
  try {
    const user = await DB.users.findOne({ email: req.user.email });
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy thông tin tài khoản!' });
    }
    res.json({
      success: true,
      user: {
        id: user._id || user.email,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role,
        avatar: user.avatar || null,
        createdAt: user.createdAt || new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống: ' + err.message });
  }
});

// API Cập nhật thông tin cá nhân & Đổi avatar
app.post('/api/user/update-profile', userAuth, async (req, res) => {
  const { fullName, phoneNumber, avatar } = req.body;
  if (!fullName) {
    return res.status(400).json({ error: 'Họ tên không được để trống!' });
  }
  
  // Validate so dien thoai neu duoc cung cap (chi chu so, bat dau 0, 10-11 chu so)
  if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== "") {
    const digits = String(phoneNumber).replace(/\D/g, '');
    const phoneErr = validatePhoneNumber(digits);
    if (phoneErr) {
      return res.status(400).json({ error: phoneErr });
    }
  }

  try {
    const user = await DB.users.findOne({ email: req.user.email });
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy thông tin tài khoản!' });
    }
    
    // Cập nhật thông tin
    user.fullName = fullName.trim();
    if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== "") {
      user.phoneNumber = String(phoneNumber).replace(/\D/g, '');
    }
    if (avatar !== undefined) {
      user.avatar = avatar; // Chuỗi Base64
    }
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Cập nhật thông tin cá nhân thành công!',
      user: {
        id: user._id || user.email,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role,
        avatar: user.avatar || null,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi cập nhật hồ sơ: ' + err.message });
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
    const licenses = await DB.licenses.find({ userEmail: req.user.email });
    const plans = await DB.plans.find({});
    const planMap = plans.reduce((acc, p) => {
      acc[p.id] = { name: p.name, price: p.price };
      return acc;
    }, {});

    const bankCode = await DB.settings.get('bankCode', process.env.BANK_CODE || 'MB');
    const bankAccount = await DB.settings.get('bankAccount', process.env.BANK_ACCOUNT || '0385464403');
    const bankAccountName = await DB.settings.get('bankAccountName', process.env.BANK_ACCOUNT_NAME || 'DOAN VIET HOANG');

    const keys = licenses.map(k => {
      const plainObj = useMongo ? k.toObject() : k;
      const planInfo = planMap[plainObj.planType] || { name: plainObj.planType, price: 0 };
      return {
        ...plainObj,
        planName: planInfo.name,
        price: planInfo.price,
        daysLeft: computeDaysLeft(plainObj.expiresAt),
        bankCode,
        bankAccount,
        bankAccountName
      };
    });

    res.json({ success: true, keys });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi tải danh sách key: ' + err.message });
  }
});

// API Hủy key bản quyền đang chờ thanh toán
app.post('/api/user/keys/cancel', userAuth, async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Mã key bản quyền là bắt buộc!' });
  }

  try {
    const license = await DB.licenses.findOne({ key });
    if (!license) {
      return res.status(404).json({ error: 'Không tìm thấy key bản quyền này!' });
    }

    // Kiểm tra quyền sở hữu
    if (license.userEmail !== req.user.email) {
      return res.status(403).json({ error: 'Bạn không có quyền hủy key bản quyền này!' });
    }

    // Chỉ cho phép hủy key chưa thanh toán (pending)
    if (license.paymentStatus !== 'pending') {
      return res.status(400).json({ error: 'Chỉ có thể hủy key ở trạng thái chờ thanh toán!' });
    }

    // Đổi trạng thái sang expired thay vì xóa cứng để tránh mất dấu vết nếu webhook đến trễ
    license.paymentStatus = 'expired';
    await license.save();

    res.json({ success: true, message: 'Đã hủy đơn đăng ký gói thành công!' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi hủy key: ' + err.message });
  }
});

const inFlightSubscriptions = new Set();

// API Đăng ký gói bản quyền
app.post('/api/plans/subscribe', userAuth, async (req, res) => {
  const { planType } = req.body;
  if (!planType) {
    return res.status(400).json({ error: 'Thiếu thông tin gói dịch vụ đăng ký!' });
  }

  const userEmail = req.user.email.toLowerCase();
  if (inFlightSubscriptions.has(userEmail)) {
    return res.status(429).json({ error: 'Yêu cầu đăng ký gói của bạn đang được xử lý. Vui lòng không bấm liên tiếp!' });
  }
  inFlightSubscriptions.add(userEmail);

  try {
    const plan = await DB.plans.findOne({ id: planType, status: 'active' });
    if (!plan) {
      return res.status(400).json({ error: 'Gói dịch vụ đăng ký không hợp lệ hoặc đã ngừng hoạt động!' });
    }

    // 1. Chặn nếu đăng ký dùng thử > 1 lần
    if (plan.price === 0) {
      const keys = await DB.licenses.find({ userEmail: req.user.email });
      const hasUsedTrial = keys.some(k => k.planType === plan.id);
      if (hasUsedTrial) {
        return res.status(400).json({ error: 'Mỗi tài khoản chỉ được phép đăng ký sử dụng thử 1 lần duy nhất!' });
      }
    } else {
      // 1.5. Chặn nếu người dùng đang có bất kỳ key nào ở trạng thái pending còn hạn (trong vòng 24 giờ qua)
      const keys = await DB.licenses.find({ userEmail: req.user.email });
      const pendingKey = keys.find(k => {
        if (k.paymentStatus !== 'pending' || k.status === 'suspended') return false;
        const age = Date.now() - new Date(k.createdAt).getTime();
        return age < 24 * 60 * 60 * 1000; // Còn hạn 24h
      });
      if (pendingKey) {
        return res.status(400).json({ 
          error: 'Bạn đang có một mã bản quyền chờ thanh toán. Vui lòng thanh toán mã cũ hoặc hủy đơn trước!',
          pendingKey: pendingKey.key
        });
      }
    }

    // 2. Tạo License Key mới
    const key = `STUDIO-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    const days = plan.durationDays;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
    const expiresStr = expiresAt.toISOString();

    const paymentStatus = plan.price === 0 ? 'active' : 'pending';

    const license = await DB.licenses.create({
      key,
      customerName: req.user.fullName,
      userEmail: req.user.email,
      planType: plan.id,
      paymentStatus,
      hwid: null,
      expiresAt: expiresStr,
      status: 'active',
      resetCount: 0,
      lastResetAt: null,
      priceAtPurchase: plan.price,
      createdAt: new Date().toISOString()
    });

    // 3. Gửi Email thông báo (hoặc ghi log fallback)
    await sendLicenseEmail({
      toEmail: req.user.email,
      fullName: req.user.fullName,
      key,
      planType: plan.id,
      expiresAt: expiresStr,
      status: paymentStatus,
      price: plan.price
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
  } finally {
    inFlightSubscriptions.delete(userEmail);
  }
});

// API Lấy danh sách các gói dịch vụ đang hoạt động (Công khai)
app.get('/api/plans', async (req, res) => {
  try {
    const plans = await DB.plans.find({ status: 'active' });
    res.json({ success: true, plans });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi lấy danh sách gói dịch vụ: ' + err.message });
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

    const plan = await DB.plans.findOne({ id: license.planType });

    res.json({
      success: true,
      key: license.key,
      planType: license.planType,
      planName: plan ? plan.name : license.planType,
      price: license.priceAtPurchase !== undefined ? license.priceAtPurchase : (plan ? plan.price : 0),
      paymentStatus: license.paymentStatus,
      status: license.status,
      expiresAt: license.expiresAt,
      createdAt: license.createdAt,
      bankCode: await DB.settings.get('bankCode', process.env.BANK_CODE || 'MB'),
      bankAccount: await DB.settings.get('bankAccount', process.env.BANK_ACCOUNT || '0385464403'),
      bankAccountName: await DB.settings.get('bankAccountName', process.env.BANK_ACCOUNT_NAME || 'DOAN VIET HOANG')
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi lấy thông tin key: ' + err.message });
  }
});

const inFlightPaymentSessions = new Set();

// API Tạo phiên thanh toán Stripe Checkout
app.post('/api/payment/stripe/create-session', userAuth, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Mã key bản quyền là bắt buộc!' });

  const sessionLockKey = `${req.user.email}_stripe_${key}`;
  if (inFlightPaymentSessions.has(sessionLockKey)) {
    return res.status(429).json({ error: 'Yêu cầu thanh toán đang được xử lý, vui lòng đợi.' });
  }
  inFlightPaymentSessions.add(sessionLockKey);

  try {
    const license = await DB.licenses.findOne({ key });
    if (!license) return res.status(404).json({ error: 'Không tìm thấy key bản quyền này!' });

    // 1. Xác thực quyền sở hữu (Ownership Check)
    if (license.userEmail !== req.user.email) {
      return res.status(403).json({ error: 'Bạn không có quyền thanh toán cho key bản quyền của người khác!' });
    }

    // 2. Chỉ chấp nhận các License đang pending hoặc expired (Trễ hạn)
    if (license.paymentStatus !== 'pending' && license.paymentStatus !== 'expired') {
      return res.status(400).json({ error: 'Giao dịch không hợp lệ hoặc bản quyền đã được kích hoạt!' });
    }

    const plan = await DB.plans.findOne({ id: license.planType });
    if (!plan) return res.status(400).json({ error: 'Không tìm thấy thông tin gói dịch vụ!' });

    // Giá snapshot động
    const amount = license.priceAtPurchase !== undefined ? license.priceAtPurchase : plan.price;

    const domain = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    // Khóa Idempotency động theo 10 phút để tránh spam
    const idempotencyKey = `${license.key}_${Math.floor(Date.now() / 600000)}`;

    if (!stripe) {
      return res.status(500).json({ error: 'Cổng thanh toán Stripe chưa được cấu hình trên hệ thống!' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'vnd', // Stripe VND là zero-decimal (không nhân 100)
          product_data: {
            name: `Gia hạn bản quyền Editnhanh - ${plan.name}`,
            description: `Mã key: ${license.key}`,
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      client_reference_id: license.key,
      payment_intent_data: {
        metadata: {
          license_key: license.key // Bắt buộc để Stripe copy sang Charge Object
        }
      },
      success_url: `${domain}/payment.html?key=${license.key}&status=success`,
      cancel_url: `${domain}/payment.html?key=${license.key}&status=cancel`,
    }, {
      idempotencyKey
    });

    res.json({ success: true, url: session.url });

  } catch (err) {
    console.error('[Stripe Create Session Error]:', err.message);
    res.status(500).json({ error: 'Lỗi khởi tạo phiên thanh toán Stripe: ' + err.message });
  } finally {
    inFlightPaymentSessions.delete(sessionLockKey);
  }
});

// API Tạo liên kết thanh toán PayOS
app.post('/api/payment/payos/create-link', userAuth, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Mã key bản quyền là bắt buộc!' });

  const sessionLockKey = `${req.user.email}_payos_${key}`;
  if (inFlightPaymentSessions.has(sessionLockKey)) {
    return res.status(429).json({ error: 'Yêu cầu thanh toán đang được xử lý, vui lòng đợi.' });
  }
  inFlightPaymentSessions.add(sessionLockKey);

  try {
    const license = await DB.licenses.findOne({ key });
    if (!license) return res.status(404).json({ error: 'Không tìm thấy key bản quyền này!' });

    // 1. Xác thực quyền sở hữu (Ownership Check)
    if (license.userEmail !== req.user.email) {
      return res.status(403).json({ error: 'Bạn không có quyền thanh toán cho key bản quyền của người khác!' });
    }

    // 2. Chấp nhận pending hoặc expired
    if (license.paymentStatus !== 'pending' && license.paymentStatus !== 'expired') {
      return res.status(400).json({ error: 'Giao dịch không hợp lệ hoặc bản quyền đã được kích hoạt!' });
    }

    const plan = await DB.plans.findOne({ id: license.planType });
    if (!plan) return res.status(400).json({ error: 'Không tìm thấy thông tin gói dịch vụ!' });

    const amount = license.priceAtPurchase !== undefined ? license.priceAtPurchase : plan.price;
    const keyRef = license.key.split('-')[1].toUpperCase();

    const domain = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    if (!payOS) {
      return res.status(500).json({ error: 'Cổng thanh toán PayOS chưa được cấu hình trên hệ thống!' });
    }

    // Tránh đụng độ mã đơn hàng tuyệt đối 100%
    const orderCode = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    const paymentLinkData = {
      orderCode: orderCode,
      amount: amount,
      description: `VST ${keyRef}`,
      cancelUrl: `${domain}/payment.html?key=${license.key}&status=cancel`,
      returnUrl: `${domain}/payment.html?key=${license.key}&status=success`,
    };

    const paymentLink = await payOS.paymentRequests.create(paymentLinkData);
    res.json({ success: true, url: paymentLink.checkoutUrl });

  } catch (err) {
    console.error('[PayOS Create Link Error]:', err.message);
    res.status(500).json({ error: 'Lỗi khởi tạo liên kết thanh toán PayOS: ' + err.message });
  } finally {
    inFlightPaymentSessions.delete(sessionLockKey);
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

    const plan = await DB.plans.findOne({ id: license.planType });
    const days = plan ? plan.durationDays : 30;

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

// Định nghĩa Stripe Webhook Handler thực tế
stripeWebhookHandler = async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    if (!stripe) {
      console.error('[Stripe Webhook] Error: stripe SDK is not initialized.');
      return res.status(500).json({ error: 'Stripe SDK not configured' });
    }
    // XÁC THỰC CHỮ KÝ SỐ STRIPE BẮT BUỘC (RAW BODY)
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[Stripe Webhook] ❌ Lỗi xác thực chữ ký Stripe: ${err.message}`);
    return res.status(400).json({ error: 'Invalid stripe webhook signature' });
  }

  // 1. Nhánh KÍCH HOẠT: Thanh toán hoàn tất thành công
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const key = session.client_reference_id;
    if (!key) return res.status(400).json({ error: 'Missing client_reference_id' });

    const keyRef = key.split('-')[1].toUpperCase();

    if (inFlightWebhooks.has(keyRef)) {
      return res.json({ success: true, message: 'Processing concurrently...' });
    }
    inFlightWebhooks.add(keyRef);

    try {
      const license = await DB.licenses.findOne({ key });
      if (!license) {
        console.warn(`[Stripe Webhook] ⚠️ WARNING: Không tìm thấy License: "${key}".`);
        return res.status(404).json({ error: 'License not found' });
      }

      if (license.paymentStatus === 'active') {
        return res.json({ success: true, message: 'License already active' });
      }

      // Ngăn chặn tự động phục hồi đối với Key đã bị Admin đình chỉ thủ công hoặc do tranh chấp
      if (license.status === 'suspended') {
        console.warn(`[Stripe Webhook] 🛑 Từ chối tự kích hoạt Key đang bị đình chỉ (Suspended): ${key}`);
        return res.json({ success: true, message: 'Cannot auto-activate suspended license. Admin manual check required.' });
      }

      const plan = await DB.plans.findOne({ id: license.planType });
      const days = plan ? plan.durationDays : 30;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);

      // Cập nhật Atomic chống Race Condition
      const updatedLicense = await DB.licenses.findOneAndUpdate(
        { key, paymentStatus: { $in: ['pending', 'expired'] } },
        { $set: { paymentStatus: 'active', expiresAt: expiresAt.toISOString() } },
        { new: true }
      );

      if (!updatedLicense) {
        return res.json({ success: true, message: 'License activated concurrently' });
      }

      console.log(`[Stripe Webhook] 🎉 Kích hoạt thành công License Key: ${updatedLicense.key}.`);

      // Gửi Email kích hoạt (Cô lập lỗi)
      try {
        await sendLicenseEmail({
          toEmail: updatedLicense.userEmail,
          fullName: updatedLicense.customerName,
          key: updatedLicense.key,
          planType: updatedLicense.planType,
          expiresAt: updatedLicense.expiresAt,
          status: 'active'
        });
      } catch (emailErr) {
        console.error(`[Stripe Webhook] ⚠️ WARNING: Lỗi gửi email kích hoạt:`, emailErr.message);
      }

      return res.json({ success: true, message: 'Activated' });

    } catch (err) {
      console.error('[Stripe Webhook] Lỗi xử lý checkout.session.completed:', err);
      return res.status(500).json({ error: 'Internal error' });
    } finally {
      inFlightWebhooks.delete(keyRef);
    }
  }

  // 2. Nhánh ĐÌNH CHỈ 1: Khách hàng yêu cầu hoàn tiền (Refund)
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const isFullRefund = charge.amount_refunded >= charge.amount;

    if (isFullRefund) {
      const key = charge.metadata.license_key; 
      if (!key) {
        console.warn('[Stripe Webhook] WARNING: Không tìm thấy license_key trong metadata của charge.');
        return res.json({ received: true });
      }

      const keyRef = key.split('-')[1].toUpperCase();
      if (inFlightWebhooks.has(keyRef)) {
        return res.json({ success: true, message: 'Processing concurrently...' });
      }
      inFlightWebhooks.add(keyRef);

      try {
        const license = await DB.licenses.findOneAndUpdate(
          { key: key },
          { $set: { status: 'suspended', paymentStatus: 'suspended' } },
          { new: true }
        );
        if (license) {
          console.log(`[Stripe Webhook] 🛑 Đình chỉ thành công License Key do hoàn tiền: ${key}`);
        }
        return res.json({ success: true, message: 'License suspended' });
      } catch (err) {
        console.error('[Stripe Webhook] Lỗi khi xử lý đình chỉ key do hoàn tiền:', err.message);
        return res.status(500).json({ error: 'Internal error processing refund' });
      } finally {
        inFlightWebhooks.delete(keyRef);
      }
    } else {
      console.log(`[Stripe Webhook] INFO: Hoàn tiền một phần, bỏ qua không khóa key.`);
    }
  }

  // 3. Nhánh ĐÌNH CHỈ 2: Khách hàng tranh chấp thẻ (Chargeback/Dispute)
  if (event.type === 'charge.dispute.created') {
    const dispute = event.data.object;

    try {
      const charge = await stripe.charges.retrieve(dispute.charge);
      const key = charge.metadata.license_key;
      if (!key) {
        console.warn('[Stripe Webhook] WARNING: Không tìm thấy license_key trong charge dispute.');
        return res.json({ received: true });
      }

      const keyRef = key.split('-')[1].toUpperCase();
      if (inFlightWebhooks.has(keyRef)) {
        return res.json({ success: true, message: 'Processing concurrently...' });
      }
      inFlightWebhooks.add(keyRef);

      try {
        const license = await DB.licenses.findOneAndUpdate(
          { key: key },
          { $set: { status: 'suspended', paymentStatus: 'suspended' } },
          { new: true }
        );
        if (license) {
          console.log(`[Stripe Webhook] 🛑 Đình chỉ thành công Key do Chargeback: ${key}`);
        }
        return res.json({ success: true, message: 'License suspended' });
      } finally {
        inFlightWebhooks.delete(keyRef);
      }
    } catch (err) {
      console.error('[Stripe Webhook] Lỗi xử lý Dispute:', err.message);
      return res.status(500).json({ error: 'Internal error processing dispute' });
    }
  }

  return res.json({ received: true });
};

const inFlightWebhooks = new Set();

// Webhook tự động nhận thông tin thanh toán từ SePay / Casso để kích hoạt license key
app.post('/api/payment/webhook', async (req, res) => {
  console.log('[Payment Webhook] Nhận request thanh toán:', JSON.stringify(req.body));

  // 1. Xác thực request bằng webhook key (nếu được cấu hình trong .env)
  const webhookKey = process.env.PAYMENT_WEBHOOK_KEY;
  if (webhookKey) {
    const incomingKey = req.headers['x-api-key'] || req.headers['secure-token'] || req.headers['authorization'];
    if (!incomingKey || !incomingKey.includes(webhookKey)) {
      console.warn('[Payment Webhook] Cảnh báo: Token xác thực không hợp lệ hoặc thiếu!');
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing webhook key' });
    }
  }

  try {
    // Xác định gateway
    let gateway = 'generic';
    if (req.body.content && req.body.transferAmount !== undefined) gateway = 'sepay';
    else if (req.body.data && Array.isArray(req.body.data)) gateway = 'casso';

    let transactions = [];

    // Casso Format: { error: 0, data: [...] }
    if (req.body.data && Array.isArray(req.body.data)) {
      transactions = req.body.data.map(item => ({
        amount: Number(item.amount),
        content: item.description || '',
        transactionId: String(item.tid || item.id),
        transferCode: String(item.tid || item.id)
      }));
    }
    // SePay Format: { content: "...", transferAmount: 199000, ... }
    else if (req.body.content && req.body.transferAmount !== undefined) {
      transactions = [{
        amount: Number(req.body.transferAmount),
        content: req.body.content,
        transactionId: String(req.body.id || req.body.code || Date.now()),
        transferCode: String(req.body.code || '')
      }];
    }
    // Generic Format: { content: "...", amount: 199000 }
    else if (req.body.content && req.body.amount !== undefined) {
      transactions = [{
        amount: Number(req.body.amount),
        content: req.body.content,
        transactionId: String(req.body.id || Date.now()),
        transferCode: String(req.body.code || '')
      }];
    } else {
      console.warn('[Payment Webhook] Định dạng dữ liệu không được hỗ trợ:', req.body);
      return res.status(400).json({ error: 'Unsupported webhook body format' });
    }

    let processedCount = 0;
    let activatedKeys = [];

    for (const tx of transactions) {
      const { amount, content, transactionId, transferCode } = tx;
      console.log(`[Payment Webhook] Xử lý giao dịch #${transactionId}: Số tiền=${amount}, Nội dung="${content}"`);

      // Trích xuất mã keyRef từ nội dung chuyển khoản (Ví dụ: "VST A9B8C7D6" -> "A9B8C7D6")
      const match = content.match(/vst\s+([a-z0-9]+)/i);
      if (!match) {
        console.log(`[Payment Webhook] Giao dịch #${transactionId} bỏ qua: Không tìm thấy cú pháp 'VST <mã_key>'`);
        // Lưu lại giao dịch với trạng thái pending (không khớp key)
        await DB.paymentTransactions.create({
          transactionId,
          amount,
          content,
          transferCode: transferCode || '',
          status: 'pending',
          gateway,
          rawBody: req.body
        }).catch(() => {});
        continue;
      }

      const keyRef = match[1].toUpperCase();
      console.log(`[Payment Webhook] Tìm thấy keyRef: "${keyRef}"`);

      // Khóa Concurrency dựa trên keyRef ngay lập tức (Chống race condition trước khi gọi DB bất đồng bộ)
      if (inFlightWebhooks.has(keyRef)) {
        console.warn(`[Payment Webhook] Giao dịch #${transactionId} bị bỏ qua do đang có tiến trình xử lý song song cho keyRef ${keyRef}.`);
        continue;
      }
      inFlightWebhooks.add(keyRef);

      try {
        // Tìm license key tương ứng dựa trên DB mode (MongoDB hoặc JSON)
        let license = null;
        if (useMongo) {
          // Query regex để tìm key dạng: STUDIO-A9B8C7D6-xxxx-xxxx
          license = await LicenseModel.findOne({ key: { $regex: `^STUDIO-${keyRef}-`, $options: 'i' } });
        } else {
          const db = readJSON();
          const found = db.licenses.find(l => {
            const parts = l.key.split('-');
            return parts.length > 1 && parts[1].toUpperCase() === keyRef;
          });
          if (found) {
            license = await DB.licenses.findOne({ key: found.key });
          }
        }

        if (!license) {
          console.warn(`[Payment Webhook] Giao dịch #${transactionId}: Không tìm thấy License tương ứng với mã "${keyRef}" trong database.`);
          // Lưu pending: không tìm thấy key
          await DB.paymentTransactions.create({
            transactionId, amount, content,
            transferCode: transferCode || '',
            status: 'pending', gateway,
            rawBody: req.body
          }).catch(() => {});
          continue;
        }

        if (license.paymentStatus === 'active') {
          console.log(`[Payment Webhook] Giao dịch #${transactionId}: License "${license.key}" đã kích hoạt từ trước.`);
          processedCount++;
          // Vẫn lưu confirm vì đã thanh toán thành công (dù key đã active)
          try {
            const u = await DB.users.findOne({ email: license.userEmail });
            await DB.paymentTransactions.create({
              transactionId, amount, content,
              transferCode: transferCode || '',
              licenseKey: license.key,
              userEmail: license.userEmail,
              customerName: license.customerName || (u ? u.fullName : null),
              phoneNumber: u ? u.phoneNumber : null,
              planType: license.planType,
              status: 'confirm', gateway,
              rawBody: req.body
            }).catch(() => {});
          } catch(e) {}
          continue;
        }

        // Xác định số tiền yêu cầu và hạn dùng của gói bản quyền từ DB
        const plan = await DB.plans.findOne({ id: license.planType });
        const requiredAmount = license.priceAtPurchase !== undefined ? license.priceAtPurchase : (plan ? plan.price : 199000);
        const days = plan ? plan.durationDays : 30;

        if (amount < requiredAmount) {
          console.warn(`[Payment Webhook] Giao dịch #${transactionId}: Số tiền chuyển khoản (${amount}) nhỏ hơn số tiền yêu cầu (${requiredAmount}) cho gói ${license.planType}.`);
          // Lưu pending: số tiền không đủ
          try {
            const u = await DB.users.findOne({ email: license.userEmail });
            await DB.paymentTransactions.create({
              transactionId, amount, content,
              transferCode: transferCode || '',
              licenseKey: license.key,
              userEmail: license.userEmail,
              customerName: license.customerName || (u ? u.fullName : null),
              phoneNumber: u ? u.phoneNumber : null,
              planType: license.planType,
              status: 'pending', gateway,
              rawBody: req.body
            }).catch(() => {});
          } catch(e) {}
          continue;
        }

        if (license.paymentStatus === 'expired') {
          console.warn(`[Payment Webhook] ⚠️ Giao dịch #${transactionId}: Phát hiện thanh toán trễ hạn cho Key đã hết hạn đăng ký (${license.key}). Tiến hành tự động phục hồi kích hoạt.`);
        }

        // Cập nhật trạng thái bản quyền
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + days);

        license.expiresAt = expiresAt;
        license.paymentStatus = 'active';
        await license.save();

        console.log(`[Payment Webhook] 🎉 Kích hoạt thành công License Key: ${license.key}. Hạn dùng mới: ${expiresAt.toISOString()}`);
        activatedKeys.push(license.key);
        processedCount++;

        // Lưu giao dịch vào DB với trạng thái confirm
        try {
          const u = await DB.users.findOne({ email: license.userEmail });
          await DB.paymentTransactions.create({
            transactionId,
            amount,
            content,
            transferCode: transferCode || '',
            licenseKey: license.key,
            userEmail: license.userEmail,
            customerName: license.customerName || (u ? u.fullName : null),
            phoneNumber: u ? u.phoneNumber : null,
            planType: license.planType,
            status: 'confirm',
            gateway,
            rawBody: req.body
          }).catch(() => {});
        } catch(e) {}

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
            console.log(`[Payment Webhook] Đã gửi email kích hoạt thành công tới: ${license.userEmail}`);
          } catch (emailErr) {
            console.error('[Payment Webhook] Gửi email kích hoạt bị lỗi:', emailErr.message);
          }
        }
      } finally {
        inFlightWebhooks.delete(keyRef);
      }
    }

    res.json({
      success: true,
      message: `Đã xử lý xong ${processedCount}/${transactions.length} giao dịch.`,
      activatedKeys
    });

  } catch (err) {
    console.error('[Payment Webhook] Lỗi hệ thống khi xử lý webhook:', err);
    res.status(500).json({ error: 'Internal system error processing webhook: ' + err.message });
  }
});

// Webhook tự động nhận thông tin thanh toán từ PayOS
app.post('/api/payment/payos/webhook', async (req, res) => {
  try {
    if (!payOS) {
      console.error('[PayOS Webhook] Error: payOS SDK is not initialized.');
      return res.status(500).json({ error: 'PayOS SDK not configured' });
    }

    // XÁC THỰC CHỮ KÝ VÀ DỮ LIỆU BẢO MẬT PAYOS
    const webhookData = await payOS.webhooks.verify(req.body);
    
    // Webhook data chứa description/orderCode để tìm ra License
    const orderDescription = webhookData.description;
    const keyRefMatch = orderDescription.match(/vst\s+([a-z0-9]+)/i);
    if (!keyRefMatch) {
      console.log('[PayOS Webhook] Bỏ qua: Không tìm thấy cú pháp VST keyRef trong description.');
      return res.json({ success: true, message: 'Webhook ignored: no VST key reference found' });
    }
    
    const keyRef = keyRefMatch[1].toUpperCase();

    if (inFlightWebhooks.has(keyRef)) {
      return res.json({ success: true, message: 'Processing in parallel' });
    }
    inFlightWebhooks.add(keyRef);

    try {
      // Tìm License đầy đủ sử dụng regex động: ^[^-]+-keyRef-
      let license = null;
      if (useMongo) {
        license = await LicenseModel.findOne({ key: { $regex: `^[^\\-]+-${keyRef}-`, $options: 'i' } });
      } else {
        const db = readJSON();
        const found = db.licenses.find(l => {
          const parts = l.key.split('-');
          return parts.length > 1 && parts[1].toUpperCase() === keyRef;
        });
        if (found) license = await DB.licenses.findOne({ key: found.key });
      }

      if (!license) {
        console.warn(`[PayOS Webhook] ⚠️ WARNING: Không tìm thấy License tương ứng với keyRef "${keyRef}".`);
        return res.status(404).json({ error: 'License not found' });
      }

      if (license.paymentStatus === 'active') {
        return res.json({ success: true, message: 'Already active' });
      }

      // Ngăn chặn tự động phục hồi đối với Key đã bị Admin đình chỉ thủ công
      if (license.status === 'suspended') {
        console.warn(`[PayOS Webhook] 🛑 Từ chối tự kích hoạt Key đang bị đình chỉ (Suspended): ${license.key}`);
        return res.json({ success: true, message: 'Cannot auto-activate suspended license.' });
      }

      const plan = await DB.plans.findOne({ id: license.planType });
      const days = plan ? plan.durationDays : 30;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);

      // Cập nhật Atomic chống Race Condition
      const updatedLicense = await DB.licenses.findOneAndUpdate(
        { key: license.key, paymentStatus: { $in: ['pending', 'expired'] } },
        { $set: { paymentStatus: 'active', expiresAt: expiresAt.toISOString() } },
        { new: true }
      );

      if (updatedLicense) {
        console.log(`[PayOS Webhook] 🎉 Kích hoạt thành công License Key: ${updatedLicense.key}.`);
        try {
          await sendLicenseEmail({
            toEmail: updatedLicense.userEmail,
            fullName: updatedLicense.customerName,
            key: updatedLicense.key,
            planType: updatedLicense.planType,
            expiresAt: updatedLicense.expiresAt,
            status: 'active'
          });
        } catch (emailErr) {
          console.error(`[PayOS Webhook] Lỗi gửi email:`, emailErr.message);
        }
      }

      return res.json({ success: true });
    } finally {
      inFlightWebhooks.delete(keyRef);
    }

  } catch (err) {
    console.error(`[PayOS Webhook] Lỗi xác thực chữ ký PayOS hoặc lỗi xử lý:`, err.message);
    return res.status(400).json({ error: 'Invalid PayOS signature or process error' });
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
app.get('/download', async (req, res) => {
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

  // Nếu cấu hình link lưu trữ ngoài (ví dụ link Google Drive trên Render)
  const installerUrl = await DB.settings.get('installerUrl', process.env.INSTALLER_URL || '');
  if (installerUrl) {
    return res.redirect(installerUrl);
  }

  // Absolute path safe resolving (Fallback ở localhost)
  const filePath = path.resolve(__dirname, '..', 'dist', 'Editnhanh Setup 1.0.0.exe');
  
  res.attachment('Editnhanh Setup 1.0.0.exe');
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
// API ADMIN (Bảo vệ bằng phiên đăng nhập Admin hoặc X-Admin-Token legacy)
// ==========================================
// Helper: đọc JWT session token từ cookie (ưu tiên) hoặc header Authorization
function _readAdminSessionToken(req) {
  if (req.headers.cookie) {
    const cookies = {};
    req.headers.cookie.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      cookies[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    });
    if (cookies.token) return cookies.token;
  }
  if (req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
  }
  return null;
}

// Middleware bảo vệ các route /api/admin/*
//  1. Ưu tiên phiên đăng nhập Admin qua JWT cookie (email/password, role = admin)
//  2. Fallback: header X-Admin-Token (giữ tương thích với CLI generate-key.js / legacy)
async function adminAuth(req, res, next) {
  const sessionToken = _readAdminSessionToken(req);
  if (sessionToken) {
    const payload = verifyToken(sessionToken);
    if (payload && payload.email) {
      try {
        const user = await DB.users.findOne({ email: payload.email });
        if (user && user.role === 'admin') {
          const jwtIssuedAtMs = payload.iat * 1000;
          if (user.passwordChangedAt && jwtIssuedAtMs < new Date(user.passwordChangedAt).getTime()) {
            return res.status(401).json({ error: 'Mật khẩu đã được thay đổi. Vui lòng đăng nhập lại!' });
          }
          req.user = payload;
          req.adminUser = { email: user.email, fullName: user.fullName, role: user.role };
          return next();
        }
        return res.status(403).json({ error: 'Tài khoản không có quyền Quản trị viên (Admin)!' });
      } catch (err) {
        return res.status(500).json({ error: 'Lỗi hệ thống khi xác thực Admin: ' + err.message });
      }
    }
  }

  const adminTokenHeader = req.headers['x-admin-token'];
  if (adminTokenHeader && adminTokenHeader === ADMIN_TOKEN) {
    req.adminUser = null;
    return next();
  }

  return res.status(401).json({ error: 'Chưa đăng nhập Admin hoặc phiên đã hết hạn!' });
}

// API Đăng nhập Admin (email/password, yêu cầu role = admin)
app.post('/api/admin/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập email và mật khẩu!' });
  }

  try {
    const user = await DB.users.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác!' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Tài khoản không có quyền Quản trị viên (Admin)!' });
    }

    if (!user.isVerified) {
      return res.status(403).json({ error: 'Tài khoản chưa được xác thực email. Vui lòng kiểm tra hòm thư!' });
    }

    const isMatch = verifyPassword(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác!' });
    }

    const token = generateToken({ email: user.email, fullName: user.fullName, role: user.role });

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      user: {
        email: user.email,
        fullName: user.fullName,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi hệ thống khi đăng nhập Admin: ' + err.message });
  }
});

// API Đăng xuất Admin (xoá phiên cookie)
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Đã đăng xuất Admin!' });
});

// API Lấy thông tin phiên Admin hiện tại (frontend dùng để kiểm tra đăng nhập)
app.get('/api/admin/me', adminAuth, async (req, res) => {
  if (req.adminUser) {
    return res.json({ success: true, user: req.adminUser });
  }
  return res.json({ success: true, user: null, via: 'token' });
});


// API lấy cấu hình hệ thống (Admin)
app.get('/api/admin/config', adminAuth, async (req, res) => {
  try {
    const installerUrl = await DB.settings.get('installerUrl', process.env.INSTALLER_URL || '');
    const supportEmail = await DB.settings.get('supportEmail', 'support@editnhanh.com');
    const supportZalo = await DB.settings.get('supportZalo', '');
    const supportTelegram = await DB.settings.get('supportTelegram', '');
    const bankCode = await DB.settings.get('bankCode', process.env.BANK_CODE || 'MB');
    const bankAccount = await DB.settings.get('bankAccount', process.env.BANK_ACCOUNT || '');
    const bankAccountName = await DB.settings.get('bankAccountName', process.env.BANK_ACCOUNT_NAME || '');
    res.json({ success: true, installerUrl, supportEmail, supportZalo, supportTelegram, bankCode, bankAccount, bankAccountName });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi lấy cấu hình: ' + err.message });
  }
});

// API cập nhật cấu hình hệ thống (Admin)
app.post('/api/admin/config', adminAuth, async (req, res) => {
  const { installerUrl, supportEmail, supportZalo, supportTelegram, bankCode, bankAccount, bankAccountName } = req.body;
  try {
    await DB.settings.set('installerUrl', (installerUrl || '').trim());
    if (supportEmail !== undefined) await DB.settings.set('supportEmail', (supportEmail || '').trim());
    if (supportZalo !== undefined) await DB.settings.set('supportZalo', (supportZalo || '').trim());
    if (supportTelegram !== undefined) await DB.settings.set('supportTelegram', (supportTelegram || '').trim());
    if (bankCode !== undefined) await DB.settings.set('bankCode', (bankCode || '').trim());
    if (bankAccount !== undefined) await DB.settings.set('bankAccount', (bankAccount || '').trim());
    if (bankAccountName !== undefined) await DB.settings.set('bankAccountName', (bankAccountName || '').trim());
    res.json({ success: true, message: 'Cập nhật cấu hình thành công!' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi cập nhật cấu hình: ' + err.message });
  }
});

// API lấy toàn bộ danh sách các gói dịch vụ (Admin)
app.get('/api/admin/plans', adminAuth, async (req, res) => {
  try {
    const plans = await DB.plans.find({});
    res.json({ success: true, plans });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi lấy danh sách gói dịch vụ: ' + err.message });
  }
});

// API tạo gói dịch vụ mới (Admin)
app.post('/api/admin/plans', adminAuth, async (req, res) => {
  const { id, name, price, durationDays, description, features, isPopular, status } = req.body;
  if (!id || !name || price === undefined || !durationDays) {
    return res.status(400).json({ error: 'ID, tên, giá bán và hạn dùng là bắt buộc!' });
  }

  const trimmedId = id.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(trimmedId)) {
    return res.status(400).json({ error: 'Mã ID gói chỉ được chứa chữ thường không dấu, số và dấu gạch dưới (không chứa dấu cách, ký tự đặc biệt)!' });
  }

  const parsedPrice = parseFloat(price);
  if (isNaN(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ error: 'Giá bán của gói phải là số lớn hơn hoặc bằng 0!' });
  }

  const parsedDuration = parseInt(durationDays);
  if (isNaN(parsedDuration) || parsedDuration <= 0) {
    return res.status(400).json({ error: 'Hạn sử dụng của gói phải là số ngày lớn hơn 0!' });
  }

  try {
    const existing = await DB.plans.findOne({ id: trimmedId });
    if (existing) {
      return res.status(400).json({ error: `Gói dịch vụ với ID "${trimmedId}" đã tồn tại!` });
    }

    const newPlan = await DB.plans.create({
      id: trimmedId,
      name: name.trim(),
      price: parsedPrice,
      durationDays: parsedDuration,
      description: (description || '').trim(),
      features: Array.isArray(features) ? features : [],
      isPopular: !!isPopular,
      status: status === 'inactive' ? 'inactive' : 'active',
      createdAt: new Date().toISOString()
    });

    res.json({ success: true, plan: newPlan, message: 'Tạo gói dịch vụ thành công!' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi tạo gói dịch vụ: ' + err.message });
  }
});

// API cập nhật gói dịch vụ (Admin)
app.put('/api/admin/plans/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, price, durationDays, description, features, isPopular, status } = req.body;

  try {
    const plan = await DB.plans.findOne({ id });
    if (!plan) {
      return res.status(404).json({ error: 'Không tìm thấy gói dịch vụ!' });
    }

    if (name !== undefined) plan.name = name.trim();
    if (price !== undefined) {
      const parsedPrice = parseFloat(price);
      if (isNaN(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json({ error: 'Giá bán của gói phải là số lớn hơn hoặc bằng 0!' });
      }
      plan.price = parsedPrice;
    }
    if (durationDays !== undefined) {
      const parsedDuration = parseInt(durationDays);
      if (isNaN(parsedDuration) || parsedDuration <= 0) {
        return res.status(400).json({ error: 'Hạn sử dụng của gói phải là số ngày lớn hơn 0!' });
      }
      plan.durationDays = parsedDuration;
    }
    if (description !== undefined) plan.description = (description || '').trim();
    if (features !== undefined) plan.features = Array.isArray(features) ? features : [];
    if (isPopular !== undefined) plan.isPopular = !!isPopular;
    if (status !== undefined) plan.status = status === 'inactive' ? 'inactive' : 'active';

    await plan.save();
    res.json({ success: true, plan, message: 'Cập nhật gói dịch vụ thành công!' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi cập nhật gói dịch vụ: ' + err.message });
  }
});

// API xóa gói dịch vụ (Admin)
app.delete('/api/admin/plans/:id', adminAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const plan = await DB.plans.findOne({ id });
    if (!plan) {
      return res.status(404).json({ error: 'Không tìm thấy gói dịch vụ!' });
    }

    // Không cho phép xóa các gói mặc định đang chạy để tránh lỗi hệ thống nghiêm trọng
    if (['trial', 'monthly', 'yearly'].includes(id)) {
      return res.status(400).json({ error: 'Không thể xóa các gói dịch vụ hệ thống cốt lõi (trial, monthly, yearly)!' });
    }

    // Kiểm tra xem có license nào đang sử dụng gói này không (Chỉ đếm gói active hoặc pending còn hạn dưới 24h)
    const licenses = await DB.licenses.find({ planType: id });
    const activeOrFreshPending = licenses.filter(l => {
      if (l.paymentStatus === 'active') return true;
      if (l.paymentStatus === 'pending') {
        const age = Date.now() - new Date(l.createdAt).getTime();
        return age < 24 * 60 * 60 * 1000; // Còn hiệu lực thanh toán
      }
      return false;
    });

    if (activeOrFreshPending.length > 0) {
      return res.status(400).json({ 
        error: `Không thể xóa gói này vì hiện tại có ${activeOrFreshPending.length} khóa bản quyền đang hoạt động hoặc chờ thanh toán còn hạn! Bạn vui lòng chuyển trạng thái gói sang "Tạm ẩn" thay vì xóa cứng.` 
      });
    }

    await DB.plans.deleteOne({ id });
    res.json({ success: true, message: 'Xóa gói dịch vụ thành công!' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi xóa gói dịch vụ: ' + err.message });
  }
});

// API lấy danh sách giao dịch thanh toán (Admin)
app.get('/api/admin/payment-transactions', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const search = (req.query.search || '').trim();
    const statusFilter = req.query.status || 'all';

    const skip = (page - 1) * limit;

    let totalItems = 0;
    let totalConfirmed = 0;
    let totalPending = 0;
    let totalAmount = 0;
    let transactions = [];

    if (useMongo) {
      // Build query
      let query = {};
      if (statusFilter !== 'all') query.status = statusFilter;
      if (search) {
        const re = new RegExp(search, 'i');
        query.$or = [
          { userEmail: re },
          { customerName: re },
          { content: re },
          { transferCode: re },
          { licenseKey: re }
        ];
      }

      totalItems = await PaymentTransactionModel.countDocuments(query);
      totalConfirmed = await PaymentTransactionModel.countDocuments({ ...(!search ? query : {}), status: 'confirm' });
      totalPending = await PaymentTransactionModel.countDocuments({ ...(!search ? query : {}), status: 'pending' });

      // Tổng tiền confirm
      const amountAgg = await PaymentTransactionModel.aggregate([
        { $match: { status: 'confirm' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      totalAmount = amountAgg.length > 0 ? amountAgg[0].total : 0;

      transactions = await PaymentTransactionModel.find(query)
        .sort({ paidAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
    } else {
      // JSON fallback
      const db = readJSON();
      let all = db.paymentTransactions || [];

      // Tính tổng tất cả
      totalConfirmed = all.filter(t => t.status === 'confirm').length;
      totalPending = all.filter(t => t.status === 'pending').length;
      totalAmount = all.filter(t => t.status === 'confirm').reduce((s, t) => s + (t.amount || 0), 0);

      // Filter
      if (statusFilter !== 'all') all = all.filter(t => t.status === statusFilter);
      if (search) {
        const s = search.toLowerCase();
        all = all.filter(t =>
          (t.userEmail || '').toLowerCase().includes(s) ||
          (t.customerName || '').toLowerCase().includes(s) ||
          (t.content || '').toLowerCase().includes(s) ||
          (t.transferCode || '').toLowerCase().includes(s) ||
          (t.licenseKey || '').toLowerCase().includes(s)
        );
      }
      all.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
      totalItems = all.length;
      transactions = all.slice(skip, skip + limit);
    }

    const totalPages = Math.ceil(totalItems / limit) || 1;

    res.json({
      success: true,
      transactions,
      totalItems,
      totalPages,
      currentPage: page,
      stats: {
        total: totalConfirmed + totalPending,
        confirmed: totalConfirmed,
        pending: totalPending,
        totalAmount
      }
    });
  } catch (err) {
    console.error('[Admin] Lỗi lấy danh sách giao dịch thanh toán:', err);
    res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
});

// A. API lấy toàn bộ danh sách Keys
app.get('/api/admin/keys', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const status = req.query.status || 'all';

    let keys = [];
    let totalItems = 0;
    let activeStats = 0;
    let suspendedStats = 0;
    let expiredStats = 0;
    let totalStats = 0;
    const now = new Date();

    if (useMongo) {
      // Calculate Stats
      totalStats = await LicenseModel.countDocuments();
      suspendedStats = await LicenseModel.countDocuments({ status: 'suspended' });
      expiredStats = await LicenseModel.countDocuments({
        status: { $ne: 'suspended' },
        expiresAt: { $lt: now }
      });
      activeStats = await LicenseModel.countDocuments({
        status: 'active',
        expiresAt: { $gte: now },
        hwid: { $ne: null }
      });

      // Build Query
      const query = {};
      if (status === 'suspended') {
        query.status = 'suspended';
      } else if (status === 'active') {
        query.status = 'active';
        query.expiresAt = { $gte: now };
        query.hwid = { $ne: null };
      } else if (status === 'inactive') {
        query.status = 'active';
        query.paymentStatus = { $ne: 'pending' };
        query.$or = [{ hwid: null }, { hwid: '' }];
      } else if (status === 'expired') {
        query.status = { $ne: 'suspended' };
        query.expiresAt = { $lt: now };
      } else if (status === 'pending_payment') {
        query.paymentStatus = 'pending';
        query.status = { $ne: 'suspended' };
      }

      if (search) {
        const searchRegex = new RegExp(search.trim(), 'i');
        query.$or = [
          { key: searchRegex },
          { customerName: searchRegex },
          { hwid: searchRegex }
        ];
      }

      totalItems = await LicenseModel.countDocuments(query);
      keys = await LicenseModel.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);
    } else {
      const db = readJSON();
      const allLicenses = db.licenses || [];
      totalStats = allLicenses.length;

      // Calculate Stats
      allLicenses.forEach((k) => {
        if (k.status === 'suspended') {
          suspendedStats++;
        } else if (new Date(k.expiresAt) < now) {
          expiredStats++;
        } else if (k.status === 'active') {
          activeStats++;
        }
      });

      // Build Filtered list
      let filtered = allLicenses;
      if (status === 'suspended') {
        filtered = filtered.filter(k => k.status === 'suspended');
      } else if (status === 'active') {
        filtered = filtered.filter(k => k.status === 'active' && new Date(k.expiresAt) >= now && k.hwid);
      } else if (status === 'inactive') {
        filtered = filtered.filter(k => k.status === 'active' && !k.hwid && k.paymentStatus !== 'pending');
      } else if (status === 'expired') {
        filtered = filtered.filter(k => k.status !== 'suspended' && new Date(k.expiresAt) < now);
      } else if (status === 'pending_payment') {
        filtered = filtered.filter(k => k.paymentStatus === 'pending' && k.status !== 'suspended');
      }

      if (search) {
        const lowerSearch = search.toLowerCase().trim();
        filtered = filtered.filter(k => {
          return (k.key || '').toLowerCase().includes(lowerSearch) ||
                 (k.customerName || '').toLowerCase().includes(lowerSearch) ||
                 (k.hwid || '').toLowerCase().includes(lowerSearch);
        });
      }

      filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      totalItems = filtered.length;
      keys = filtered.slice((page - 1) * limit, page * limit);
    }

    // Enrich keys with user phone via userEmail lookup
    const keysWithDaysLeft = await Promise.all(keys.map(async (k) => {
      const obj = useMongo ? (k.toObject ? k.toObject() : k) : k;
      let userPhone = null;
      if (obj.userEmail) {
        try {
          if (useMongo) {
            const user = await UserModel.findOne({ email: obj.userEmail }, 'phoneNumber').lean();
            userPhone = user ? user.phoneNumber : null;
          } else {
            const db = readJSON();
            const user = (db.users || []).find(u => u.email === obj.userEmail);
            userPhone = user ? (user.phoneNumber || user.phone || null) : null;
          }
        } catch (_) {}
      }
      return { ...obj, daysLeft: computeDaysLeft(obj.expiresAt), userPhone };
    }));

    res.json({
      success: true,
      keys: keysWithDaysLeft,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit)
      },
      stats: {
        total: totalStats,
        active: activeStats,
        suspended: suspendedStats,
        expired: expiredStats
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi lấy danh sách keys: ' + err.message });
  }
});

// API lấy danh sách Users có phân trang & tìm kiếm (Admin)
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';

    let users = [];
    let totalItems = 0;
    let totalUsers = 0;
    let verifiedCount = 0;
    let adminCount = 0;
    let memberCount = 0;

    if (useMongo) {
      // Calculate Stats
      totalUsers = await UserModel.countDocuments();
      verifiedCount = await UserModel.countDocuments({ isVerified: true });
      adminCount = await UserModel.countDocuments({ role: 'admin' });
      memberCount = totalUsers - adminCount;

      // Build Query
      const query = {};
      if (search) {
        const searchRegex = new RegExp(search.trim(), 'i');
        query.$or = [
          { fullName: searchRegex },
          { email: searchRegex },
          { phoneNumber: searchRegex }
        ];
      }

      totalItems = await UserModel.countDocuments(query);
      users = await UserModel.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);
    } else {
      const db = readJSON();
      const allUsers = db.users || [];
      totalUsers = allUsers.length;

      // Calculate Stats
      allUsers.forEach((u) => {
        if (u.isVerified) verifiedCount++;
        if (u.role === 'admin') adminCount++;
        else memberCount++;
      });

      // Build Filtered list
      let filtered = allUsers;
      if (search) {
        const lowerSearch = search.toLowerCase().trim();
        filtered = filtered.filter(u => {
          return (u.fullName || '').toLowerCase().includes(lowerSearch) ||
                 (u.email || '').toLowerCase().includes(lowerSearch) ||
                 (u.phoneNumber || '').toLowerCase().includes(lowerSearch);
        });
      }

      filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      totalItems = filtered.length;
      users = filtered.slice((page - 1) * limit, page * limit);
    }

    const safeUsers = users.map(u => ({
      id: u._id || u.email,
      email: u.email,
      fullName: u.fullName,
      phoneNumber: u.phoneNumber,
      registrationIp: u.registrationIp || null,
      registrationHwid: u.registrationHwid || null,
      deviceHwid: u.deviceHwid || null,
      role: u.role || 'user',
      avatar: u.avatar || null,
      isVerified: u.isVerified || false,
      createdAt: u.createdAt || null
    }));

    res.json({
      success: true,
      users: safeUsers,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit)
      },
      stats: {
        total: totalUsers,
        verified: verifiedCount,
        admins: adminCount,
        members: memberCount
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi lấy danh sách người dùng: ' + err.message });
  }
});

// API cập nhật thông tin người dùng (Admin - Sửa thành viên)
app.post('/api/admin/update-user', adminAuth, async (req, res) => {
  const { email, fullName, phoneNumber, isVerified, role, registrationIp, registrationHwid, deviceHwid } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Thiếu email người dùng cần cập nhật!' });
  }
  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Vai trò không hợp lệ (chỉ user/admin)!' });
  }

  try {
    const user = await DB.users.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng này!' });
    }

    // Cap nhat cac field neu duoc cung cap
    if (fullName !== undefined) user.fullName = String(fullName).trim();
    if (phoneNumber !== undefined) {
      const digits = String(phoneNumber).replace(/\D/g, '');
      if (digits) {
        const phoneErr = validatePhoneNumber(digits);
        if (phoneErr) return res.status(400).json({ error: phoneErr });
        user.phoneNumber = digits;
      }
    }
    if (isVerified !== undefined) user.isVerified = !!isVerified;
    if (role !== undefined) user.role = role;
    if (registrationIp !== undefined) user.registrationIp = String(registrationIp).trim() || null;
    if (registrationHwid !== undefined) user.registrationHwid = String(registrationHwid).trim() || null;
    if (deviceHwid !== undefined) user.deviceHwid = String(deviceHwid).trim() || null;

    await user.save();

    res.json({
      success: true,
      message: 'Đã cập nhật thông tin người dùng thành công!',
      user: {
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role || 'user',
        isVerified: user.isVerified || false,
        registrationIp: user.registrationIp || null,
        registrationHwid: user.registrationHwid || null,
        deviceHwid: user.deviceHwid || null
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi cập nhật người dùng: ' + err.message });
  }
});

// API cập nhật vai trò người dùng (Admin)
app.post('/api/admin/update-user-role', adminAuth, async (req, res) => {
  const { email, role } = req.body;
  if (!email || !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Email và vai trò (user/admin) không hợp lệ!' });
  }
  
  try {
    const user = await DB.users.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng này!' });
    }
    
    user.role = role;
    await user.save();
    
    res.json({ success: true, message: `Đã cập nhật vai trò người dùng sang: ${role}`, role });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi cập nhật vai trò: ' + err.message });
  }
});

// API xóa tài khoản người dùng (Admin)
app.delete('/api/admin/users/:email', adminAuth, async (req, res) => {
  const { email } = req.params;
  try {
    const user = await DB.users.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng này!' });
    }
    
    await DB.users.deleteOne({ email });
    res.json({ success: true, message: `Đã xóa tài khoản người dùng: ${email}` });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi xóa người dùng: ' + err.message });
  }
});

// B. API tạo mới Key bản quyền
app.post('/api/admin/generate-key', adminAuth, async (req, res) => {
  const { days, customerName } = req.body;
  const name = customerName && customerName.trim() ? customerName.trim() : 'Khách lẻ';
  const key = 'STUDIO-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  // Quyết định hạn dùng: để trống / 0 / null => Vĩnh viễn (sentinel 9999), số dương => theo số ngày
  const rawDays = (days === '' || days === null || days === undefined) ? null : days;
  let expiresStr;
  if (rawDays === null || rawDays === 0) {
    expiresStr = '9999-12-31T23:59:59.000Z';
  } else {
    const numDays = Number(rawDays);
    if (isNaN(numDays) || numDays <= 0) {
      return res.status(400).json({ error: 'Số ngày sử dụng không hợp lệ (để trống hoặc nhập 0 để tạo key vĩnh viễn)' });
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + numDays);
    expiresStr = expiresAt.toISOString();
  }

  try {
    const license = await DB.licenses.create({
      key,
      customerName: name,
      userEmail: null,
      planType: (expiresStr === '9999-12-31T23:59:59.000Z') ? 'lifetime' : 'monthly',
      paymentStatus: 'active',
      hwid: null,
      expiresAt: expiresStr,
      status: 'active',
      resetCount: 0,
      lastResetAt: null,
      createdAt: new Date().toISOString()
    });

    const isPerm = expiresStr === '9999-12-31T23:59:59.000Z';
    const daysLabel = isPerm ? 'VĨNH VIỄN' : (Number(rawDays) + ' ngày');
    console.log('[Admin Audit] Admin đã sinh Key tùy biến thủ công: "' + key + '" cấp cho khách hàng "' + name + '" với hạn dùng ' + daysLabel + '.');

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

// SPA Fallback Route
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'frontend', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({ status: 'ok', message: 'License Server đang chạy. Frontend chưa được build.' });
  }
});

// ==========================================
// CANH BAO SAP HET HAN KEY (EMAIL)
// ==========================================

// Email template: canh bao sap het han key
async function sendExpiryWarningEmail({ toEmail, fullName, key, planName, daysLeft, expiresAt }) {
  const escapedName = escapeHtml(fullName || 'Ban');
  const escapedKey = escapeHtml(key);
  const expStr = new Date(expiresAt).toLocaleDateString('vi-VN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const dayText = daysLeft <= 0 ? 'hom nay' : (daysLeft + ' ngay');
  const subject = '[Canh bao] Key ban quyen cua ban sap het han con ' + dayText;
  const bodyContent = `
    <h3>Xin chao ${escapedName},</h3>
    <p>Day la email tu dong canh bao tu he thong ban quyen <strong>Editnhanh</strong>.</p>
    <p>Key ban quuyen cua ban <strong>sap het han</strong> con lai <strong style="color:#e11d48;">${dayText}</strong>.</p>
    <div style="background:#fef2f2;padding:18px;border-radius:8px;border:1px solid #fecaca;margin:15px 0;">
      <p style="margin:4px 0;"><strong>Ma key:</strong> <span style="font-family:monospace;background:#fff;padding:2px 6px;border-radius:4px;">${escapedKey}</span></p>
      <p style="margin:4px 0;"><strong>Goi dich vu:</strong> ${escapeHtml(planName || '')}</p>
      <p style="margin:4px 0;"><strong>Ngay het han:</strong> ${expStr}</p>
    </div>
    <p>Vui long <strong>gia han</strong> hoac <strong>mua key moi</strong> truoc khi het han de tiep tuc su dung phan mem khong bi gian doan.</p>
    <p style="font-size:12px;color:#6b7280;">Day la email tu dong, vui long khong tra loi email nay.</p>
  `;
  await sendMailHelper({ toEmail, subject, bodyContent });
}

// Background job: scan key sap het han va gui email canh bao (1 email/ngay/key)
async function sendExpiryWarnings() {
  try {
    const now = new Date();
    const warningWindowMs = 7 * 24 * 60 * 60 * 1000; // 7 ngay
    let mongoQuery, jsonFilter;
    if (useMongo) {
      mongoQuery = {
        status: 'active',
        paymentStatus: 'active',
        expiresAt: { $gte: now, $lte: new Date(now.getTime() + warningWindowMs) }
      };
    }

    let licenses;
    if (useMongo) {
      licenses = await LicenseModel.find(mongoQuery);
    } else {
      const db = readJSON();
      const all = db.licenses || [];
      const matchedKeys = all.filter(l => {
        if (l.status !== 'active' || l.paymentStatus !== 'active') return false;
        const exp = new Date(l.expiresAt);
        if (exp.getFullYear() >= 9999) return false; // bo qua vinh vien
        const ms = exp.getTime() - now.getTime();
        return ms >= 0 && ms <= warningWindowMs;
      }).map(l => l.key);
      // Dung findOne de co save() method
      licenses = [];
      for (const k of matchedKeys) {
        const lic = await DB.licenses.findOne({ key: k });
        if (lic) licenses.push(lic);
      }
    }

    let sentCount = 0;
    for (const license of licenses) {
      const daysLeft = computeDaysLeft(license.expiresAt);
      if (daysLeft === null || daysLeft < 0) continue;

      // Chi gui 1 email/ngay/key (tranh spam)
      const lastSent = license.lastExpiryWarningSent ? new Date(license.lastExpiryWarningSent) : null;
      if (lastSent) {
        const hoursSinceLast = (now.getTime() - lastSent.getTime()) / (60 * 60 * 1000);
        if (hoursSinceLast < 20) continue; // chua du 20h -> chua gui lai
      }

      // Chi gui email neu key co userEmail (key cua user dang ky)
      if (!license.userEmail) continue;

      let fullName = 'Ban';
      try {
        const user = await DB.users.findOne({ email: license.userEmail });
        if (user && user.fullName) fullName = user.fullName;
      } catch (e) {}

      const planName = (license.planType === 'trial') ? 'Dung thu'
        : (license.planType === 'monthly') ? 'Thang'
        : (license.planType === 'yearly' || license.planType === 'annual') ? 'Nam'
        : (license.planType === 'lifetime') ? 'Tron doi'
        : (license.planType || 'Goi dich vu');

      try {
        await sendExpiryWarningEmail({
          toEmail: license.userEmail,
          fullName,
          key: license.key,
          planName,
          daysLeft,
          expiresAt: license.expiresAt
        });
        license.lastExpiryWarningSent = now.toISOString();
        await license.save();
        sentCount++;
        console.log('[Expiry Warning] Da gui email canh bao cho ' + license.userEmail + ' (key ' + license.key + ', con ' + daysLeft + ' ngay)');
      } catch (err) {
        console.error('[Expiry Warning] Loi gui email cho ' + license.userEmail + ': ' + err.message);
      }
    }

    if (sentCount > 0) {
      console.log('[Expiry Warning] Tong cong da gui ' + sentCount + ' email canh bao sap het han.');
    }
  } catch (err) {
    console.error('[Expiry Warning] Loi job canh bao: ' + err.message);
  }
}

// Chay job canh bao moi 1 gio
setInterval(sendExpiryWarnings, 60 * 60 * 1000);
// Trigger lan dau sau 60s de MongoDB connect xong
setTimeout(sendExpiryWarnings, 60 * 1000);

app.listen(PORT, () => {
  console.log(`[License Server] Máy chủ bản quyền đang chạy tại http://127.0.0.1:${PORT}`);
  console.log(`[License Server] Trang quản trị Admin khả dụng tại http://127.0.0.1:${PORT}/admin`);
});
