# Dùng Facebook App của người dùng

Video Studio không dùng Facebook App chung để kết nối Page. Mỗi người dùng tự tạo App tại Meta for Developers, tự lấy token và tự chịu trách nhiệm về quyền của App.

## Nhập nhiều Page bằng User Access Token

1. Mở https://developers.facebook.com/apps/ và tạo App.
2. Khi Meta hỏi loại/nhóm ứng dụng, chọn lựa chọn hỗ trợ Facebook Login hoặc quản lý tài sản doanh nghiệp và hoàn tất thông tin cơ bản.
3. Mở https://developers.facebook.com/tools/explorer/, chọn đúng App và tài khoản quản lý Page.
4. Chọn Generate Access Token với các quyền: pages_show_list, pages_manage_posts, pages_read_engagement, pages_manage_engagement, read_insights.
5. Thử GET /me/accounts?fields=id,name,access_token,tasks. Chỉ tiếp tục khi phản hồi có Page và access_token.
6. Trong Video Studio, mở Quản lý Page → Hướng dẫn tạo App & lấy Token.
7. Chọn một trong hai cách:
   - Khuyên dùng: nhập App ID, App Secret và User Access Token ngắn hạn, sau đó chọn Đổi token & nhập Page.
   - Nếu đã có User Access Token phù hợp, dán token và chọn Nhập danh sách Page.
8. Với cách khuyên dùng, phần mềm gọi /oauth/access_token trực tiếp tới Meta để đổi sang User Token dài hạn rồi gọi /me/accounts.
9. Phần mềm lấy Page ID/Page Access Token, mã hóa Page Token và lưu trên máy. App Secret, User Token ngắn hạn và User Token dài hạn không được lưu hoặc trả về giao diện.

## Nhập trực tiếp

Nếu đã có Page Access Token, chọn Thêm Page mới rồi nhập tên gợi nhớ, Page ID và Page Access Token.

## Token hết hạn khi nào?

- User Access Token ngắn hạn thường có thời gian sử dụng ngắn.
- Khi Meta chấp nhận đổi, User Access Token dài hạn thường có thời hạn khoảng 60 ngày; Video Studio hiển thị ngày hết hạn thực tế Meta trả về.
- Page Access Token lấy từ User Token dài hạn có thể không có ngày hết hạn cố định, nhưng không phải vĩnh viễn tuyệt đối. Token vẫn có thể mất hiệu lực nếu đổi mật khẩu, gỡ quyền, thay đổi vai trò Page/App hoặc Meta thu hồi phiên.
- App Secret và cả hai User Token chỉ tồn tại trong bộ nhớ trong lúc xử lý. Chỉ Page Token được mã hóa và lưu cục bộ.

Meta quyết định quyền theo loại App, chế độ Development/Live, vai trò App và trạng thái xét duyệt. App ở Development Mode thường chỉ dùng được với tài khoản có vai trò trong App. Không nhập mật khẩu Facebook vào Video Studio.
