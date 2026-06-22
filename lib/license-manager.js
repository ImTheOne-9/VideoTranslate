const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { machineIdSync } = require('node-machine-id');
const child_process = require('child_process');

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAB34xFmkwrGlpL16ePZTl9SScFHGjzCS50k/GN+PT0Dg=
-----END PUBLIC KEY-----`;

const APP_LOCAL_SECRET = 'v1d30_stud10_l0c4l_hvs_k3y_s3cr3t_2026';

function getVolumeSerial() {
  try {
    const stdout = child_process.execSync('vol c:', { encoding: 'utf8', timeout: 2000 });
    const match = stdout.match(/Volume Serial Number is\s+([A-Fa-f0-9-]+)/i);
    return match ? match[1].trim() : '';
  } catch (e) {
    return '';
  }
}

function getCpuInfo() {
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length > 0) {
      return cpus[0].model.trim() + '_' + cpus.length;
    }
  } catch (e) {}
  return '';
}

function getMachineId() {
  try {
    return machineIdSync({ original: true });
  } catch (e) {
    return '';
  }
}

function getCompositeHWID() {
  const parts = [
    getMachineId(),
    getCpuInfo(),
    getVolumeSerial()
  ].filter(Boolean);

  if (parts.length < 2) {
    throw new Error("Không đủ thông tin phần cứng để định danh thiết bị thiết lập bản quyền.");
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function getUserDataPath() {
  try {
    const { app } = require('electron');
    if (app) return app.getPath('userData');
  } catch (e) {}
  // Fallback for dev mode when electron app is not running yet
  const appDataRoot = path.join(os.homedir(), 'VideoStudio');
  if (!fs.existsSync(appDataRoot)) {
    fs.mkdirSync(appDataRoot, { recursive: true });
  }
  return appDataRoot;
}

function getLicenseFilePath() {
  return path.join(getUserDataPath(), 'license.json');
}

// Signs dynamic payload locally with HMAC-SHA256
function signLocal(payload) {
  // Sort keys of payload to ensure deterministic signature
  const sortedKeys = Object.keys(payload).sort();
  const sortedObj = {};
  sortedKeys.forEach(k => {
    sortedObj[k] = payload[k];
  });
  return crypto
    .createHmac('sha256', APP_LOCAL_SECRET)
    .update(JSON.stringify(sortedObj))
    .digest('hex');
}

// Saves local license file
function saveLicenseLocal(payload, signature) {
  const filePath = getLicenseFilePath();
  const data = {
    payload,
    signature, // Ed25519 signature from server
    localSig: signLocal(payload)
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Verifies the license file locally (3 conditions check + local HMAC integrity check)
function verifyLocalLicense() {
  const filePath = getLicenseFilePath();
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: 'Chưa kích hoạt bản quyền' };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const { payload, signature, localSig } = data;

    if (!payload || !signature || !localSig) {
      return { valid: false, error: 'Thông tin bản quyền bị lỗi hoặc không đầy đủ' };
    }

    // 1. Kiểm tra chữ ký HMAC cục bộ
    const computedLocalSig = signLocal(payload);
    if (computedLocalSig !== localSig) {
      return { valid: false, error: 'Tệp bản quyền cục bộ đã bị sửa đổi trái phép' };
    }

    // 2. Kiểm tra chữ ký số Ed25519 từ Server
    // Server ký payload Ed25519 chứa { key, hwid, expiresAt, issuedAt, nonce }
    const serverPayload = {
      key: payload.key,
      hwid: payload.hwid,
      expiresAt: payload.expiresAt,
      issuedAt: payload.issuedAt,
      nonce: payload.nonce
    };

    const isServerSigValid = crypto.verify(
      null,
      Buffer.from(JSON.stringify(serverPayload)),
      PUBLIC_KEY,
      Buffer.from(signature, 'hex')
    );

    if (!isServerSigValid) {
      return { valid: false, error: 'Chữ ký bản quyền máy chủ không hợp lệ' };
    }

    // 3. Đối chiếu HWID phần cứng hiện tại
    const currentHWID = getCompositeHWID();
    if (payload.hwid !== currentHWID) {
      return { valid: false, error: 'Bản quyền không khớp với thiết bị hiện tại' };
    }

    // 4. Kiểm tra thời hạn bản quyền
    const expiresDate = new Date(payload.expiresAt);
    if (expiresDate < new Date()) {
      return { valid: false, error: 'Bản quyền đã hết hạn sử dụng' };
    }

    // 5. Kiểm tra chống lùi thời gian hệ thống
    const now = Date.now();
    if (payload.lastRunTimestamp && now < payload.lastRunTimestamp) {
      return { valid: false, error: 'Phát hiện đồng hồ hệ thống bị lùi thời gian' };
    }

    return { valid: true, payload, signature };
  } catch (e) {
    return { valid: false, error: 'Lỗi khi đọc tệp bản quyền: ' + e.message };
  }
}

const axios = require('axios');
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'https://video-studio-license-server.onrender.com';

async function verifyOnline(key, hwid) {
  const response = await axios.post(`${LICENSE_SERVER_URL}/api/server/verify`, { key, hwid }, { timeout: 5000 });
  if (response.data && response.data.status === 'active') {
    return response.data;
  }
  const err = new Error((response.data && response.data.error) || 'Giấy phép không còn hoạt động');
  err.isLicenseInvalid = true;
  throw err;
}

async function checkLicenseStartup() {
  const result = verifyLocalLicense();
  if (!result.valid) {
    return result;
  }

  const payload = result.payload;
  const signature = result.signature;
  const now = Date.now();

  const needsOnlineCheck = (now - payload.lastOnlineCheck) > 6 * 60 * 60 * 1000; // 6 tiếng
  if (needsOnlineCheck) {
    try {
      await verifyOnline(payload.key, payload.hwid);
      payload.launchCountSinceOnlineCheck = 0;
      payload.lastOnlineCheck = now;
    } catch (err) {
      if (err.isLicenseInvalid) {
        return { valid: false, error: err.message };
      }
      // Server down hoặc mất mạng -> Fallback sang đếm offline
      payload.launchCountSinceOnlineCheck++;
      if (payload.launchCountSinceOnlineCheck > 30) {
        return { valid: false, error: 'Đã vượt quá giới hạn số lần mở ngoại tuyến. Vui lòng kết nối mạng.' };
      }
    }
  }

  // Cập nhật timestamp chạy gần nhất
  payload.lastRunTimestamp = now;
  saveLicenseLocal(payload, signature);

  return { valid: true, payload };
}

module.exports = {
  getCompositeHWID,
  saveLicenseLocal,
  verifyLocalLicense,
  checkLicenseStartup,
  verifyOnline,
  getLicenseFilePath,
  LICENSE_SERVER_URL
};
