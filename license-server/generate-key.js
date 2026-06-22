const axios = require('axios');

const ADMIN_TOKEN = 'my_super_secret_admin_token_2026';
const SERVER_URL = 'https://video-studio-license-server.onrender.com';

const days = process.argv[2] ? Number(process.argv[2]) : 30;

if (isNaN(days) || days <= 0) {
  console.error("Vui lòng nhập số ngày sử dụng hợp lệ!");
  console.log("Sử dụng: node generate-key.js <số_ngày>");
  process.exit(1);
}

async function run() {
  try {
    const res = await axios.post(`${SERVER_URL}/api/admin/generate-key`, { days }, {
      headers: { 'x-admin-token': ADMIN_TOKEN }
    });
    
    if (res.data && res.data.success) {
      console.log("\n=============================================");
      console.log("🎉 TẠO MÃ BẢN QUYỀN THÀNH CÔNG!");
      console.log("---------------------------------------------");
      console.log(`🔑 Key: ${res.data.key}`);
      console.log(`📅 Hạn dùng: ${res.data.expiresAt}`);
      console.log(`⏳ Số ngày: ${days} ngày`);
      console.log("=============================================\n");
    } else {
      console.error("Không thể tạo key:", res.data);
    }
  } catch (err) {
    console.error("Lỗi khi kết nối tới License Server. Hãy chắc chắn Server đang chạy trên port 4000!");
    console.error("Chi tiết:", err.message);
  }
}

run();
