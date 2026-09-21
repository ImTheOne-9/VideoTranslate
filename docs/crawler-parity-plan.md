# Crawler parity implementation

Reference: user-provided ViralCrawl resources/app-src; local implementation only.
No live account, download or publication is performed by the implementation tests.

## Work packages

- [x] Input normalization, accurate metrics, shared filtering and preview parity.
- [x] Douyin/Bilibili series and TikTok short dramas.
- [x] Kuaishou and Honggo adapters and UI capability wiring.
- [x] Channel discovery, retained catalog, baseline/unseen, saved lists/destinations.
- [x] Schedule retry/non-overlap, queue outcomes, reason-based retry, watchdog.
- [x] Media validation, source history, runtime/package checks.
- [x] Regression tests, syntax checks, manual acceptance checklist.
- [ ] Live acceptance using authorized platform accounts and representative source links.
- [ ] Packaged Windows installer acceptance (source preflight is not an EXE build).

## Acceptance boundaries

Keep existing architecture and user data; never copy reference sessions, credentials,
download history or runtime binaries. Unknown statistics are not zero or inferred likes.
No claims of cloud/off-machine execution. Platform access requires live acceptance with
the user's own authorized account and content; static tests cannot establish success rates.

## Kiểm tra đã chạy

- `npm test`: 811/811 ca đạt ở lượt toàn bộ; gồm kiểm thử giao diện trong Chromium
  cô lập, không gọi tài khoản/API thật.
- `npm run package-preflight`: OK (source).
- `node --check`: server, JavaScript giao diện và các adapter đã sửa.
- `python -m py_compile`: các script Python đã sửa/thêm.
- Python offline tests: metadata không chứa cookie/CDN token, tải lại bỏ qua file
  hợp lệ, loại HTML giả video, tải đúng một tập, ghi lịch sử Honggo.

## Cách dùng

1. Mở lại ứng dụng chạy từ source đã cập nhật.
2. Ở Cào video có thêm Kuaishou, Honggo; TikTok/Douyin mở chế độ Theo bộ.
3. Chọn Theo bộ là ứng dụng tự tải trọn series (trần bảo vệ 5.000 tập), giống
   ViralCrawl; không cần bật thêm checkbox. Riêng Honggo vẫn cho nhập số tập tải.
4. Mở Khám phá và quản lý kênh nguồn để tìm kênh, lưu nguồn và xem danh mục.
5. Trong danh mục: quét lại, chọn video, tải mục chọn, lưu danh sách, đổi tiêu đề
   trong danh mục, cấu hình đích và lịch cào. Đổi tiêu đề không đổi file đã tải.
6. Dùng thử lại theo nguyên nhân lỗi hoặc thử lại một tác vụ thành công một phần.

## Phạm vi và các giới hạn được giữ rõ

- TikTok tìm từ khóa không được mở như một chế độ ổn định; phim ngắn có luồng
  riêng. Kênh dùng fallback phim ngắn khi không liệt kê được video thường.
- XHS/RedNote tìm từ khóa vẫn là nhánh phụ thuộc phiên và kiểm soát truy cập của
  nền tảng; không có bảo đảm thành công hay cơ chế vượt captcha.
- Khám phá YouTube/Bilibili lấy tác giả từ tìm video rồi kiểm tra kênh; không phải
  API tìm người dùng thuần. Douyin dùng userlist.
- Bộ lọc cào trực tiếp xem trước trong phạm vi giới hạn rồi chỉ tải các URL khớp.
  Metadata thiếu không thỏa điều kiện dương. Không cam kết tìm đủ N video phù hợp
  trên toàn nền tảng. Series không nhận bộ lọc like/view/ngày.
- Giới hạn 5.000 tập là trần an toàn, không khẳng định nền tảng cho truy cập đủ bộ.
  Douyin ghép series theo tác giả và tiêu đề/tập; cần kiểm tra mẫu thật.
- Honggo phân biệt website chính chủ và website gương. Trang chính chủ có thể chỉ
  cung cấp một phần số tập. Không suy diễn thành khả năng mở nội dung bị hạn chế.
- Chống trùng ngữ nghĩa chỉ là dấu hiệu trong cùng kênh; không tự xóa hoặc bỏ tải
  theo dấu hiệu này. Không dùng nhận diện hình ảnh/video perceptual hashing.
- File validation là kích thước và chữ ký container, không giải mã toàn video.
- Danh mục giữ 1.000 mục gần đây cộng các mục thuộc danh sách đã lưu (tối đa 30
  danh sách). Có thể quét lại để tìm mục ngoài cửa sổ lưu.
- Đích nguồn là cấu hình bàn giao; không tự đăng bài hay đổi hệ thống render.
- Lịch chạy cần ứng dụng/tiến trình và máy đang hoạt động. Không có cloud/offline.
- Trạng thái `no_output` nghĩa là không xác minh được file mới; khác `no_new`
  khi adapter đã báo có mục được bỏ qua. Không cộng hai trạng thái này vào số video.

## Nguồn mã và phát hành

`tai_honggo.py`, `yt_goi_y.py`, `bili_goi_y.py` và các hàm trong
`tiktok_series.py` được lấy từ snapshot ViralCrawl do người dùng cung cấp rồi
tích hợp/thay đổi tại đây. Các số đo trong comment gốc không phải số đo của lần
triển khai này. Không sao chép cookie, profile, lịch sử, giấy phép tài khoản hoặc binary.

Các file MediaCrawler hiện có ghi nhãn `NON-COMMERCIAL LEARNING LICENSE 1.1`.
Giữ nguyên thông báo nguồn; quyền sử dụng/phân phối thương mại chưa được xác minh.
Chưa tạo installer, chưa publish, chưa tăng version phát hành.

## Nghiệm thu thật cần thực hiện trước phát hành

| Nhóm | Kiểm tra |
| --- | --- |
| YouTube/TikTok/Facebook/Instagram | Link đơn, kênh, phiên hết hạn, nội dung không truy cập được |
| TikTok phim ngắn | Link một tập, cả bộ, thiếu tập, tải lại, hủy giữa chừng |
| Douyin/Bilibili | Link rút gọn, modal_id, nhiều link, series giới hạn/cả bộ, thứ tự tập |
| XHS/RedNote | Token link hợp lệ/hết hạn, xác minh, một phần tải thất bại |
| Kuaishou | Hồ sơ đăng nhập mới, tìm/kênh/link, URL media và lượt xem/lượt thích |
| Honggo | Cả hai host, phân biệt link bộ/link tập, giới hạn tập của website |
| Nguồn và lịch | Quét đầu, phát hiện mới, xóa file, lịch trùng, thất bại rồi thử lại |
| Đóng gói | Máy sạch không có Python/Chrome trên PATH, cài runtime, chạy từ thư mục có dấu |
