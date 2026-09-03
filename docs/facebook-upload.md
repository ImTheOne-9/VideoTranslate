# Facebook upload: vận hành và kiểm thử

Phạm vi bản sửa upload: adapter, hàng đợi, kiểm tra media, trạng thái trên giao diện và chống gửi trùng yêu cầu tạo tác vụ. Bản cập nhật tiếp theo chuyển OAuth và App Secret sang backend; xem [cấu hình OAuth trên Render](facebook-oauth-backend.md). Token Page đã lưu và phiên bản API đang cấu hình được giữ nguyên.

## Luồng xử lý

- Post dùng `/videos` qua `graph-video.facebook.com`, tải từng chunk theo offset Facebook xác nhận. Reel và Story giữ endpoint riêng và dùng URL upload Facebook trả về.
- Không dùng `content_category` để chọn Post/Reel/Story. Khi đăng ngay, Post gửi `published=true`; Reel gửi `video_state=PUBLISHED` khi finish. Khi hẹn giờ phía Facebook, dùng [luồng hẹn giờ mới](facebook-native-scheduling.md).
- Lưu `upload` trong kho tác vụ: loại nội dung, phiên bản API, kích thước/mtime file, ID video, ID phiên hoặc URL upload, offset đã xác nhận và giai đoạn hiện tại.
- Ghi checkpoint trước request tạo phiên/transfer/finish và sau phản hồi. Không phát request tiếp nếu lưu checkpoint thất bại.
- Chỉ chấp nhận finish có `success: true`. Phản hồi không rõ hoặc mất mạng ở finish chuyển sang GET trạng thái ID cũ, không tự gửi finish hay tạo video mới.
- Post cần trạng thái xử lý xong và `published=true`; nếu có publishing phase thì phase đó cũng phải hoàn tất. Reel/Story cần xử lý xong và publishing phase hoàn tất. `ready` một mình không đủ.
- Mỗi lượt worker kiểm tra trạng thái một lần rồi nhường hàng đợi. Số lần kiểm tra trạng thái được tính riêng với số lần thử upload.
- Bình luận đầu chỉ chạy sau khi xác nhận bài đã xuất bản. Bình luận bị gián đoạn không tự gửi lại.

## Khi tác vụ gián đoạn

| Trường hợp | Hành vi |
| --- | --- |
| Post lỗi giữa các chunk | Dùng lại phiên và offset đã lưu; xử lý offset correction `1363037` của Facebook, không tạo phiên khác |
| Reel/Story mất phản hồi transfer | GET video cũ; chỉ finish khi Facebook xác nhận uploading phase complete |
| Reel/Story mới nhận một phần file | Dừng ở “Cần kiểm tra kết quả”; không giả định hỗ trợ tiếp tục binary upload từ một offset tùy ý |
| Mất phản hồi finish | Tiếp tục kiểm tra video cũ, kể cả khi file nguồn đã bị xóa |
| Finish bị từ chối rõ ràng | Báo lỗi; thử lại dùng phiên đã tải xong |
| Mất phản hồi start hoặc thiếu thông tin phiên | Yêu cầu kiểm tra thủ công, không tự tạo phiên mới |
| Tác vụ upload từ bản cũ không có ID phiên | Không thể khôi phục ID đã mất; yêu cầu kiểm tra Page trước khi tạo tác vụ mới |
| Hết lượt kiểm tra | “Cần kiểm tra kết quả”; nút “Kiểm tra lại” dùng ID cũ |
| Hủy | Abort HTTP và đóng stream; không gửi thêm finish/bình luận. Yêu cầu xuất bản đã đến Facebook có thể vẫn hoàn tất |

Kho tác vụ bị hỏng sẽ báo lỗi thay vì âm thầm tạo kho rỗng. Dọn lịch sử không xóa tác vụ chưa hoàn tất. Idempotency key vẫn nhận diện tác vụ thất bại; dùng nút thử lại cho tác vụ đó. Giao diện giữ key qua lần mất phản hồi tạo tác vụ trong cùng tab.

## Kiểm tra video

Yêu cầu ffprobe đọc được luồng video, kích thước và thời lượng. Thiếu ffprobe hoặc thời lượng không rõ sẽ báo lỗi trước khi upload.

Các ngưỡng sau là cấu hình kiểm tra cục bộ, chưa phải tuyên bố giới hạn chung của Facebook:

- `FACEBOOK_MAX_VIDEO_BYTES`: mặc định 4294967296.
- `FACEBOOK_REEL_MAX_SECONDS`: mặc định 90.
- `FACEBOOK_STORY_MAX_SECONDS`: mặc định 60.
- `FACEBOOK_STATUS_POLL_MS`: mặc định 10000.
- `FACEBOOK_STATUS_POLL_ATTEMPTS`: mặc định 60.

Video khoảng 315 giây: chọn **Post** để thử luồng video dài. Chỉ tăng ngưỡng Reel/Story khi đã xác minh khả năng API cho Page và phiên bản đang dùng. Bản sửa này không đổi mặc định phiên bản v25.0 và không tự đổi loại bài.

## Quản lý bài sau khi đăng

- Giữ riêng Video ID (để kiểm tra xử lý) và Page Post ID (để đọc bài, bình luận, thống kê).
- Khi Graph trả `post_id` dạng số riêng lẻ, chuẩn hóa thành `PageID_PostID`. Không tự thêm Page ID vào ID video hoặc ID bình luận.
- Các tác vụ cũ được chuẩn hóa khi trả danh sách và khi gọi API quản lý; không cần sửa file hàng đợi đang chạy hoặc đăng lại bài.
- `finish.id` chưa chắc là Post ID; chỉ dùng `finish.post_id` hoặc `post_id` đọc từ video làm căn cứ cho Post ID.
- Dùng `post_media_view,post_clicks` cho thống kê mặc định. Đã kiểm chứng trực tiếp ngày 03/09/2026 trên bài gặp lỗi: ID số riêng lẻ trả lỗi #12, ID đầy đủ đọc được bài/bình luận; `post_impressions` và `post_engaged_users` bị API từ chối, hai chỉ số mới trả dữ liệu.
- Link `/reel/...` được chuyển thành URL HTTPS đầy đủ của Facebook.

Kiểm chứng chỉ đọc lại bằng adapter hiện tại, không in token hay nội dung bình luận:

```sh
node scripts/diagnose-facebook-manager.js JOB_ID --verify
```

## Kiểm chứng

Chạy kiểm thử không dùng token thật, không gọi Facebook:

```sh
node --test test/facebook-publishing.test.js test/facebook-upload-regressions.test.js test/facebook-post-manager.test.js
```

Các ca kiểm tra gồm: Post/Reel/Story, chunk offsets, mất phản hồi finish, tiếp tục sau khởi động lại, stream/HTTP cancellation, media không đọc được, lỗi kho tác vụ, chống bình luận trùng và idempotency khi tạo tác vụ. Kết quả giả lập không chứng minh Page thực tế có đủ quyền hoặc Facebook sẽ nhận video cụ thể. Chưa đăng thử trực tiếp trong bản sửa này.

Nguồn đối chiếu: [SDK Page v25.0.3](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/page.py), [SDK Video](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/advideo.py), [Meta uploader và offset correction](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/video_uploader.py), [bộ ví dụ Reel chính thức của Meta](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api). Trang tài liệu video trực tiếp của Meta không truy cập được trong lượt đối chiếu này; không suy diễn giới hạn độ dài mới từ thông báo sản phẩm.
