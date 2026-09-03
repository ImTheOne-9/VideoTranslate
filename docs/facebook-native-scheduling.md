# Hẹn giờ xuất bản phía Facebook

## Cách sử dụng

1. Trong cửa sổ đăng video, chọn **Hẹn giờ trên Facebook**, Page và thời gian xuất bản.
2. Xác nhận hẹn giờ: phần mềm bắt đầu upload ngay khi đến lượt trong hàng đợi, không chờ đến giờ xuất bản.
3. Giữ máy chạy, có mạng và giữ file video cho đến khi tác vụ hiện **Facebook đã nhận lịch**. Phần trăm upload hoặc phản hồi finish thành công chưa đủ.
4. Sau trạng thái xác nhận này, Facebook đã lưu lịch và tự xuất bản khi đến giờ. Máy khách không cần chạy để Facebook thực hiện lịch.

Phần mềm dùng múi giờ của máy để chọn lịch, gửi Unix timestamp theo giây cho API. Để có khoảng đệm upload, phần mềm yêu cầu còn ít nhất **10 phút** trước lúc bắt đầu và ngay trước khi gửi finish. Đây là quy tắc bảo vệ của phần mềm, không phải kết luận về mọi giới hạn của Meta. Video dài hoặc mạng chậm nên chọn giờ xa hơn; nếu upload kéo dài vượt khoảng đệm, phần mềm báo lỗi và không tự đăng ngay. Meta vẫn có thể từ chối giới hạn thời gian, quyền hoặc loại nội dung; cần xử lý thông báo thực tế.

## Hợp đồng API đã đối chiếu

SDK chính thức Meta phiên bản 25.0.3 khai báo `scheduled_publish_time` cho cả ba đường đăng trong [Page SDK](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/page.py). [AdVideo SDK](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/advideo.py) khai báo trường đọc lại lịch và trạng thái video.

| Loại | Endpoint | Tham số finish khi hẹn giờ |
| --- | --- | --- |
| Video Post | `/{page-id}/videos` | `published=false`, `unpublished_content_type=SCHEDULED`, `scheduled_publish_time` |
| Reel | `/{page-id}/video_reels` | `video_state=SCHEDULED`, `scheduled_publish_time` |
| Story | `/{page-id}/video_stories` | `video_state=SCHEDULED`, `scheduled_publish_time` |

Tài liệu developer Meta trực tiếp trả HTTP 429 khi đối chiếu. Bộ SDK xác nhận bộ tham số; điều kiện chấp nhận thực tế trên từng Page cần kiểm tra qua API. Không thay đổi phiên bản Graph đang cấu hình và không thay đổi giới hạn media cục bộ.

## Xác nhận lịch, khôi phục và chống trùng

- Lịch mới lưu `scheduleMode=facebook`; `nextAttemptAt` đặt hiện tại để upload trước. Các tác vụ cũ không có mode này giữ nguyên cơ chế chờ trên máy, không tự chuyển sang lịch Facebook.
- Checkpoint lưu thời điểm xuất bản cùng phiên upload. Retry không được đổi thời gian hoặc đổi từ hẹn giờ sang đăng ngay.
- Sau finish, đọc video ID với `status,published,scheduled_publish_time`. Chỉ xác nhận lịch khi xử lý hoàn tất, chưa xuất bản và giờ Facebook trả về trùng chính xác giờ đã gửi.
- `ready` đơn lẻ, chưa có lịch, lịch khác giờ, finish thiếu xác nhận hoặc lỗi đều không được gắn nhãn thành công. Lịch khác giờ chuyển sang Cần kiểm tra kết quả.
- Mất phản hồi finish chỉ GET video đã tạo; không tự gửi finish hay tạo video mới. Nếu không xác minh được, giữ dữ liệu và yêu cầu kiểm tra trên Facebook.
- Sau khi lịch được xác nhận, tác vụ dùng trạng thái `facebook_scheduled`, lưu `scheduleConfirmedAt` và chờ đến giờ mới kiểm tra xuất bản. Việc chờ này không tiêu hao lượt retry. Khởi động lại vẫn dùng video ID đã lưu, kể cả file nguồn đã được xóa sau khi xác nhận.
- Nếu Facebook báo đã xuất bản sớm, phần mềm ghi trạng thái thực tế kèm cảnh báo để kiểm tra Page, không báo là đang chờ hẹn giờ.

## Bình luận và sửa/hủy lịch

Facebook giữ lịch video; **bình luận đầu vẫn do phần mềm trên máy gửi** sau khi xác nhận bài đã xuất bản. Nếu máy tắt lúc đến giờ, bình luận chỉ có thể gửi khi mở lại phần mềm và đọc được bài. Chưa có dịch vụ bình luận tự động trên Render.

Trước khi gửi finish, có thể hủy upload trên máy. Sau khi finish đã gửi hoặc kết quả gửi chưa rõ, phần mềm không cho nút hủy cục bộ giả báo hủy lịch Facebook thành công. Dùng **Lịch trên Facebook** để mở Meta Business Suite, chọn đúng Page rồi kiểm tra, sửa hoặc hủy lịch ở đó. Nút này mở Business Suite, không tự sửa/xóa nội dung. Phần mềm không đồng bộ tức thời thay đổi lịch thực hiện bên ngoài; sẽ kiểm tra lại khi tác vụ đến hạn.

## Kiểm chứng

```sh
node --test test/facebook-native-scheduling.test.js test/facebook-schedule-ui.test.js test/facebook-upload-regressions.test.js
```

Kiểm thử dùng phản hồi Graph giả và kho tác vụ tạm: upload trước, đúng tham số từng endpoint, đọc lại lịch, chờ không hết lượt, khôi phục, không bình luận sớm, mất phản hồi finish, từ chối lịch, thiếu/sai giờ, upload quá lâu và lịch cục bộ cũ.

Chưa tạo lịch thật trên Page trong lượt triển khai code này. Khi thử thực tế, chọn một video và giờ đủ xa, chờ **Facebook đã nhận lịch**, rồi kiểm tra lịch tương ứng trong Business Suite. Nếu API không cho đọc trường cần xác minh, phần mềm báo lỗi thay vì khẳng định lịch đã sẵn sàng. Không cần deploy lại OAuth backend trên Render cho thay đổi này; bản phần mềm chạy phải có các file mới.
