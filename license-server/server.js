const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

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
} catch (e) {
  console.error('[License Server] Lỗi khi load file .env:', e.message);
}

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/license_server';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'my_super_secret_admin_token_2026';

const app = express();
app.use(express.json());

// Serve static admin files
app.use('/admin-static', express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Khóa riêng tư Ed25519 để ký bản quyền (Trùng khớp với Public Key nhúng ở Client)
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINCSkH2ERf0+fEmOBZAFIHPJlihYwsLNf2g4o+QZxmdw
-----END PRIVATE KEY-----`;

// Mongoose Setup
const licenseSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  customerName: { type: String, default: 'Khách lẻ' },
  hwid: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  resetCount: { type: Number, default: 0 },
  lastResetAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const LicenseModel = mongoose.model('License', licenseSchema);

const DB_FILE = path.join(__dirname, 'database.json');
let useMongo = false;

// Fallback JSON-DB Helpers
function readJSON() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ licenses: [] }, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeJSON(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
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
  async find() {
    if (useMongo) {
      return await LicenseModel.find().sort({ createdAt: -1 });
    } else {
      const db = readJSON();
      return db.licenses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
  },

  async findOne({ key }) {
    if (useMongo) {
      return await LicenseModel.findOne({ key });
    } else {
      const db = readJSON();
      const license = db.licenses.find(l => l.key === key);
      if (!license) return null;
      
      // Return compat object with save() function
      return {
        key: license.key,
        customerName: license.customerName,
        hwid: license.hwid,
        expiresAt: license.expiresAt,
        status: license.status,
        resetCount: license.resetCount,
        lastResetAt: license.lastResetAt,
        createdAt: license.createdAt,
        save: async function() {
          const dbData = readJSON();
          const idx = dbData.licenses.findIndex(l => l.key === key);
          if (idx !== -1) {
            dbData.licenses[idx] = {
              key: this.key,
              customerName: this.customerName,
              hwid: this.hwid,
              expiresAt: this.expiresAt,
              status: this.status,
              resetCount: this.resetCount,
              lastResetAt: this.lastResetAt,
              createdAt: this.createdAt
            };
            writeJSON(dbData);
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
        hwid: data.hwid || null,
        expiresAt: data.expiresAt instanceof Date ? data.expiresAt.toISOString() : data.expiresAt,
        status: data.status || 'active',
        resetCount: data.resetCount || 0,
        lastResetAt: data.lastResetAt || null,
        createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : (data.createdAt || new Date().toISOString())
      };
      db.licenses.push(newLicense);
      writeJSON(db);
      return {
        ...newLicense,
        save: async function() { return this; }
      };
    }
  }
};

// 1. API Kích hoạt bản quyền từ Client
app.post('/api/server/activate', async (req, res) => {
  const { key, hwid } = req.body;
  if (!key || !hwid) {
    return res.status(400).json({ error: 'Mã key và HWID là bắt buộc' });
  }

  try {
    const license = await DB.findOne({ key });

    if (!license) {
      return res.status(404).json({ error: 'Mã bản quyền không tồn tại' });
    }

    if (license.status !== 'active') {
      return res.status(403).json({ error: 'Bản quyền đã bị đình chỉ hoặc thu hồi' });
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
    const license = await DB.findOne({ key });

    if (!license || license.status !== 'active' || new Date(license.expiresAt) < new Date() || license.hwid !== hwid) {
      return res.json({ status: 'inactive', error: 'Bản quyền không khả dụng hoặc bị đổi thiết bị' });
    }

    res.json({ status: 'active' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi máy chủ: ' + err.message });
  }
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
    const keys = await DB.find();
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
    const license = await DB.create({
      key,
      customerName: name,
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

// C. API Reset HWID (Hỗ trợ đổi máy/cài lại Win)
app.post('/api/admin/reset-hwid', adminAuth, async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Key bản quyền là bắt buộc' });
  }

  try {
    const license = await DB.findOne({ key });

    if (!license) {
      return res.status(404).json({ error: 'Không tìm thấy key bản quyền này' });
    }

    // Giới hạn reset tối đa 2 lần/năm
    const now = new Date();
    if (license.lastResetAt) {
      const lastReset = new Date(license.lastResetAt);
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      
      if (lastReset > oneYearAgo && license.resetCount >= 2) {
        return res.status(403).json({ error: 'Đã vượt quá số lần tự reset bản quyền tối đa (2 lần/năm)' });
      }
    }

    license.hwid = null;
    license.resetCount++;
    license.lastResetAt = now.toISOString();
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
    const license = await DB.findOne({ key });
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
