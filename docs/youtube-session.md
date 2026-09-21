# YouTube: phiên đăng nhập và tiêu đề

Bấm Đăng nhập YouTube để mở Google Chrome bằng hồ sơ riêng của tool. Đăng nhập xong, đóng cửa sổ Chrome trước khi cào hoặc xuất cookie.

Xuất cookie để tool dùng lại (chạy PowerShell trong thư mục dự án):

```powershell
./scripts/export-youtube-cookies.ps1
```

File được lưu tại `%APPDATA%/Video Studio Tools/crawler/youtube-cookies.txt` (hoặc thư mục `VIDEO_STUDIO_CRAWLER_HOME`). Cookie có thể hết hạn; đăng nhập và xuất lại khi cần. Không có API HTTP trả về cookie. Script chỉ in số cookie và trạng thái, không in nội dung cookie.

Tool dùng bản sao tạm của file đã xuất để xem trước/tải. Nếu chưa có file, bước tải thử lấy cookie từ Chrome/CDP rồi dự phòng bản sao dữ liệu cookie và profile Playwright cũ. Không lấy được cookie tùy chọn thì tiếp tục thử tải công khai. Cookie người dùng cung cấp qua cấu hình vẫn được ưu tiên.

Tiêu đề có chữ Trung được dịch trước khi đặt tên file, dùng bộ dịch/cache MediaCrawler hiện có. Lỗi dịch giữ nguyên tiêu đề; ID video không thay đổi. Đặt `YT_TRANSLATE_TITLES=0` để tắt. Đây là dịch tên file, không dịch nội dung video.
