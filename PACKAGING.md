# Hướng dẫn Phát triển & Đóng gói Video Studio Tools (Cho Developer)

Tài liệu này hướng dẫn cách thiết lập môi trường và tự đóng gói (build) ứng dụng đối với các lập trình viên khác khi nhận code từ Git.

Do các thư mục chứa binary và AI models nặng (`tools/` và `models/`) có dung lượng rất lớn và đã được đưa vào [.gitignore](file:///.gitignore) để tránh đẩy lên GitHub, các lập trình viên khác khi clone code về sẽ cần tải bổ sung các thư mục này để có thể chạy và build được ứng dụng.

---

## 🛠️ Quy trình thiết lập môi trường phát triển (Developer Setup)

### Bước 1: Clone mã nguồn từ Git
Tải mã nguồn dự án về máy và chuyển sang nhánh phát triển mới nhất:
```bash
git clone https://github.com/ImTheOne-9/VideoTranslate.git
cd VideoTranslate
git checkout optimize-installer
```

### Bước 2: Tải và giải nén các thư mục phụ thuộc (Dependencies)
Bạn (chủ dự án) chỉ cần nén thư mục **`tools/`** thành một file `.zip` (ví dụ: `tools.zip`) và upload lên Google Drive hoặc OneDrive để chia sẻ cho các nhà phát triển khác (không cần nén thư mục `models/` vì hệ thống sẽ tự động tải các model AI khi chạy).

Nhà phát triển mới cần:
1. Tải file `tools.zip` từ đường dẫn bạn chia sẻ.
2. Giải nén trực tiếp vào thư mục gốc của dự án. Đảm bảo cấu trúc thư mục sau khi giải nén trông như thế này:
   ```text
   VideoTranslate/
   ├── lib/
   ├── public/
   ├── tools/              <-- Giải nén ở đây (chứa ffmpeg.exe, yt-dlp.exe, whisper_onnx.exe...)
   ├── main.js
   ├── server.js
   └── package.json
   ```
*Lưu ý: Khi khởi chạy ứng dụng lần đầu tiên, hệ thống sẽ tự động hiển thị màn hình tải xuống các model AI cần thiết (như Omnivoice và Whisper) từ HuggingFace vào thư mục `models/`.*

### Bước 3: Cài đặt các thư viện Node.js
Chạy lệnh sau tại thư mục gốc của dự án để cài đặt các node modules:
```bash
npm install
```

---

## 🚀 Các lệnh phát triển và đóng gói (Commands)

### Chạy chế độ Phát triển (Development Mode)
Để khởi chạy ứng dụng Electron ở chế độ phát triển (hỗ trợ Live Reload và mở sẵn Chrome Developer Tools để debug):
```bash
npm run electron-dev
```

### Đóng gói ứng dụng ra bộ cài Installer (.exe)
Để nén toàn bộ mã nguồn, tài nguyên và đóng gói thành tệp cài đặt `.exe` bằng `electron-builder` và `NSIS`:
```bash
npm run electron-dist
```
*Sau khi chạy xong, bộ cài `.exe` mới sẽ được xuất ra trong thư mục `dist/`.*

