# Dùng Facebook App của người dùng

Video Studio không dùng Facebook App chung để kết nối Page. Mỗi người dùng tự tạo App tại Meta for Developers, tự lấy token và tự chịu trách nhiệm về quyền của App.

## Nhập nhiều Page bằng User Access Token

1. Mở https://developers.facebook.com/apps/ và tạo App.
2. Khi Meta hỏi loại/nhóm ứng dụng, chọn lựa chọn hỗ trợ Facebook Login hoặc quản lý tài sản doanh nghiệp và hoàn tất thông tin cơ bản.
3. Mở https://developers.facebook.com/tools/explorer/, chọn đúng App và tài khoản quản lý Page.
4. Chọn Generate Access Token với các quyền: pages_show_list, pages_manage_posts, pages_read_engagement, pages_manage_engagement, read_insights.
5. Thử GET /me/accounts?fields=id,name,access_token,tasks. Chỉ tiếp tục khi phản hồi có Page và access_token.
6. Trong Video Studio, mở Quản lý Page → Hướng dẫn tạo App & lấy Token.
7. Dán User Access Token và chọn Nhập danh sách Page.
8. Phần mềm gọi /me/accounts, lấy Page ID/Page Access Token, mã hóa Page Token và lưu trên máy. User Token không được lưu.

## Nhập trực tiếp

Nếu đã có Page Access Token, chọn Thêm Page mới rồi nhập tên gợi nhớ, Page ID và Page Access Token.

Meta quyết định quyền theo loại App, chế độ Development/Live, vai trò App và trạng thái xét duyệt. App ở Development Mode thường chỉ dùng được với tài khoản có vai trò trong App. Không nhập Facebook App Secret hoặc mật khẩu Facebook vào Video Studio.
