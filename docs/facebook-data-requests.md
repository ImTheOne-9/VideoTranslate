# Tiếp nhận và xử lý yêu cầu xóa dữ liệu

Người vận hành: **Đoàn Việt Hoàng**. Hộp thư: **doanhoang1910@gmail.com**.

Chủ sản phẩm đã xác nhận thời hạn: phản hồi trong **5 ngày làm việc kể từ khi nhận email**; xử lý trong **30 ngày sau khi xác minh đủ thông tin**. Nếu cần thêm thời gian, thông báo lý do và mốc dự kiến trước khi hết hạn. Đây là quy trình hỗ trợ do người vận hành thực hiện, không phải hệ thống gửi email/xóa dữ liệu tự động đã được triển khai.

## 1. Ghi nhận và phản hồi

Ghi ngày nhận, ngày phải phản hồi, email liên hệ, phạm vi yêu cầu và trạng thái vào sổ theo dõi riêng có kiểm soát truy cập. Không lưu hồ sơ khách trong Git hoặc video App Review. Kiểm tra cả thư rác để tránh bỏ sót yêu cầu.

Phản hồi xác nhận đã nhận yêu cầu; nếu thiếu, hỏi email tài khoản, Page ID/tên Page và phạm vi xóa. Không yêu cầu mật khẩu, OTP, Page Token hoặc App Secret. Không dùng việc biết Page ID công khai làm bằng chứng duy nhất của quyền yêu cầu.

## 2. Xác minh và phân loại dữ liệu

Xác minh người yêu cầu có quyền với tài khoản và dữ liệu liên quan qua thông tin tài khoản/kênh đã xác thực. Ghi ngày đủ thông tin để tính mốc 30 ngày. Tách yêu cầu về Facebook khỏi yêu cầu xóa toàn bộ tài khoản/bản quyền/giao dịch.

| Nơi lưu | Cách xử lý |
| --- | --- |
| Page/token trên máy | Hướng dẫn tắt tự đăng, xử lý tác vụ còn chờ và xóa Page trên từng máy. Không yêu cầu khách gửi toàn bộ kho token qua email. |
| Video, dự án, lịch sử tác vụ và bản sao lưu | Xác nhận đúng phạm vi trước khi hướng dẫn xóa. Xóa Page không xóa các file này. Không cung cấp lệnh xóa đệ quy một thư mục lớn khi chưa xác định đường dẫn và tác vụ đang chạy. |
| Phiên OAuth backend | Kết quả mã hóa hết hạn truy cập sau 10 phút, token tạm được xóa khỏi phiên khi ACK; MongoDB dọn theo TTL. Không tuyên bố backend đã xóa toàn bộ dữ liệu tài khoản vì phiên đã hết hạn. |
| Tài khoản, bản quyền, giao dịch và nhật ký | Rà dữ liệu liên quan trước khi xóa, gồm các bản ghi liên kết. Endpoint xóa user không phải bằng chứng tự động xóa mọi dữ liệu liên quan. Nếu cần giữ một phần, ghi loại dữ liệu, lý do và thời hạn/điều kiện kết thúc lưu giữ. |
| Email hỗ trợ và bản sao lưu do bên vận hành quản lý | Rà cả hộp thư và bản sao đã tạo trong phạm vi yêu cầu; xác nhận chính sách lưu/xóa của hạ tầng thực tế. Không hứa xóa tức thời mọi bản sao lưu của nhà cung cấp. |
| Bài và lịch đã gửi đến Meta | Hướng dẫn khách quản lý trên Facebook/Meta Business Suite. Không xóa nội dung Page chỉ vì khách yêu cầu ngừng kết nối. |

## 3. Thông báo kết quả

Nêu rõ phần đã xử lý, phần cần khách thao tác, phần còn giữ và lý do. Nếu không thể hoàn tất đúng mốc, gửi thông báo trước hạn với thời gian dự kiến cụ thể. Không báo "đã xóa toàn bộ" khi còn dữ liệu thuộc phạm vi chưa xử lý hoặc chưa kiểm tra được.

## Thông tin đã đối chiếu từ code

- Backend website/OAuth đang triển khai qua Render theo cấu hình vận hành hiện tại.
- Phiên OAuth dùng MongoDB; MongoDB là hệ quản trị dữ liệu, chưa đủ để xác định tên nhà cung cấp hosting cơ sở dữ liệu hoặc vùng lưu trữ thực tế.
- Mail hỗ trợ là Gmail do chủ sản phẩm cung cấp. Code website có hỗ trợ Resend và SMTP cho email giao dịch; chưa xác minh nhà cung cấp đang hoạt động trên Render, không tự chọn một tên để công khai.
- Tác vụ dọn nhật ký xác thực chạy mỗi 24 giờ và nhắm các bản ghi cũ hơn 90 ngày. Không áp dụng mốc này cho toàn bộ server/provider logs.
- Hiện không có cơ chế tự động xóa chung toàn bộ tài khoản, giao dịch và thư hỗ trợ sau một thời hạn cố định. Nội dung công khai đã nêu rõ điều này.

Trước khi trả lời câu hỏi Data Handling của Meta, cần kiểm tra tên dịch vụ hosting MongoDB, nhà cung cấp email giao dịch, vùng dữ liệu và chính sách backup thực tế. Không suy ra các thông tin đó từ tên thư viện hoặc mẫu biến môi trường.
