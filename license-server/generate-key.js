const axios = require('axios');
const fs = require('fs');
const path = require('path');

function loadAdminToken() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      if (t.substring(0, idx).trim() === 'ADMIN_TOKEN') {
        let v = t.substring(idx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        return v;
      }
    }
  }
  return process.env.ADMIN_TOKEN || 'my_super_secret_admin_token_2026';
}

const ADMIN_TOKEN = loadAdminToken();
const SERVER_URL = process.argv[3] || 'https://editnhanh.com';
const days = process.argv[2] ? Number(process.argv[2]) : 30;

if (isNaN(days) || days <= 0) {
  console.error('Vui lòng nhập số ngày hợp lệ!');
  console.log('Sử dụng: node generate-key.js <số_ngày> [server_url]');
  process.exit(1);
}

async function run() {
  try {
    console.log('Đang tạo key ' + days + ' ngày trên ' + SERVER_URL + '...');
    const res = await axios.post(
      SERVER_URL + '/api/admin/generate-key',
      { days },
      { headers: { 'x-admin-token': ADMIN_TOKEN } }
    );
    if (res.data && res.data.success) {
      console.log('\n=============================================');
      console.log('🎉 TẠO MÃ BẢN QUYỀN THÀNH CÔNG!');
      console.log('---------------------------------------------');
      console.log('🔑 Key:', res.data.key);
      console.log('📅 Hạn dùng:', res.data.expiresAt);
      console.log('⏳ Số ngày:', days, 'ngày');
      console.log('=============================================\n');
    } else {
      console.error('Không thể tạo key:', res.data);
    }
  } catch (err) {
    console.error('Lỗi khi kết nối tới License Server!');
    if (err.response) {
      console.error('HTTP ' + err.response.status + ':', (err.response.data && err.response.data.error) || err.response.data);
      if (err.response.status === 401 || err.response.status === 403) {
        console.error('\n→ ADMIN_TOKEN không hợp lệ. Kiểm tra ADMIN_TOKEN trong .env có khớp với server không.');
      }
    } else {
      console.error('Chi tiết:', err.message);
    }
  }
}

run();
