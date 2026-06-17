# Hướng dẫn Phát triển & Đóng gói Video Studio Tools (Cho Developer)

Tài liệu này hướng dẫn cách thiết lập môi trường và tự đóng gói (build) ứng dụng đối với các lập trình viên khác khi nhận code từ Git.

Do các thư mục chứa binary nặng (`tools/` và `python_engine/`) có dung lượng lớn (~3GB) và đã được đưa vào [.gitignore](file:///e:/tai%20video/tai%20video/.gitignore), các lập trình viên khác khi clone code về sẽ cần tải bổ sung các tệp tin này để có thể chạy và build được ứng dụng.

---

## 🛠️ Quy trình thiết lập môi trường phát triển (Developer Setup)

### Bước 1: Clone mã nguồn từ Git
Tải mã nguồn dự án về máy:
```bash
git clone <URL_REPO_CỦA_BẠN>
cd "tai video"
```

### Bước 2: Tải và giải nén các thư mục phụ thuộc (Dependencies)
Bạn (chủ dự án) cần nén hai thư mục `tools/` và `python_engine/` thành một file `.zip` (ví dụ: `dependencies.zip`) và upload lên Google Drive hoặc OneDrive để chia sẻ cho các nhà phát triển khác.

Nhà phát triển mới cần:
1. Tải file `dependencies.zip` từ đường dẫn bạn chia sẻ.
2. Giải nén trực tiếp vào thư mục gốc của dự án. Đảm bảo cấu trúc thư mục sau khi giải nén trông như thế này:
   ```text
   tai video/
   ├── lib/
   ├── public/
   ├── python_engine/      <-- Giải nén ở đây (chứa python.exe)
   ├── tools/              <-- Giải nén ở đây (chứa ffmpeg.exe, yt-dlp.exe...)
   ├── main.js
   ├── server.js
   └── package.json
   ```

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
