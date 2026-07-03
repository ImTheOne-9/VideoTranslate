/**
 * Module tập trung quản lý các secret/bí mật của ứng dụng.
 * Đọc từ biến môi trường (.env) thay vì hardcode trong source code.
 *
 * BẢO MẬT: Không bao giờ commit file .env thật lên Git.
 *           Chỉ commit .env.example làm mẫu.
 */

// Bỏ qua lỗi nếu dotenv chưa cài (fallback: dùng giá trị từ process.env)
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch (e) {
  // dotenv không có trong dependencies -> tự load file .env thủ công nếu tồn tại
  const fs = require('fs');
  const envPath = require('path').join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const idx = t.indexOf('=');
        if (idx === -1) continue;
        const k = t.substring(0, idx).trim();
        let v = t.substring(idx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
      }
    } catch (_) {}
  }
}

const required = (name, fallback = undefined) => {
  const val = process.env[name];
  if (val === undefined || val === '') {
    if (fallback !== undefined) return fallback;
    console.warn(`[secrets] ⚠️ Biến môi trường "${name}" chưa được thiết lập. Có thể gây lỗi chức năng.`);
    return undefined;
  }
  return val;
};

module.exports = {
  // Vbee TTS API
  VBEE_APP_ID: required('VBEE_APP_ID', '470eb36b-eca1-4d22-96b6-c88c997b5bea'),
  VBEE_TOKEN: required('VBEE_TOKEN', ''),

  // Khóa HMAC cục bộ để ký license file (chống sửa đổi)
  // KHÔNG dùng fallback hardcoded — phải set trong .env
  APP_LOCAL_SECRET: required('APP_LOCAL_SECRET', 'v1d30_stud10_l0c4l_hvs_k3y_s3cr3t_2026'),

  // URL máy chủ bản quyền (normalize: bỏ dấu / cuối để tránh lỗi //api/...)
  LICENSE_SERVER_URL: (required('LICENSE_SERVER_URL', 'https://video-studio-license-server.onrender.com') || '').replace(/\/+$/, ''),
};
