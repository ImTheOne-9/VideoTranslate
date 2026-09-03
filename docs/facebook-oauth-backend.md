# Facebook OAuth trên backend Render

Code OAuth nằm trong `license-server`, dùng service hiện tại của `https://editnhanh.com`. Desktop vẫn đăng video và bình luận trực tiếp bằng Page Token được mã hóa trên máy. App Secret chỉ dùng trong backend.

## Luồng kết nối

1. Desktop xác minh bản quyền, tạo mã bí mật ngẫu nhiên và gửi bản băm để mở phiên backend.
2. Trình duyệt mở backend rồi chuyển tới Facebook. Backend gắn phiên với cookie HttpOnly, Secure, SameSite=Lax và OAuth state.
3. Facebook trả code về `https://editnhanh.com/api/facebook/oauth/callback`. Backend kiểm tra phiên, đổi code và lấy danh sách Page.
4. Danh sách cùng token được mã hóa AES-256-GCM trong MongoDB. Phiên hết hạn sau 10 phút; API kiểm tra hạn ngay cả khi Mongo chưa dọn TTL.
5. Desktop dùng bản quyền thiết bị và mã bí mật để nhận kết quả. Chỉ sau khi lưu Page Token vào kho mã hóa cục bộ thành công, desktop gửi ACK để xóa bản token tạm trên backend. Mất phản hồi có thể nhận lại bằng cùng phiên trước ACK.

Frontend không nhận Page Token từ luồng này. Callback không nhận địa chỉ chuyển hướng do client cung cấp. Webhook backend kiểm tra chữ ký; hàng đợi desktop tiếp tục tự kiểm tra trạng thái Graph API.

## Cấu hình đã chuẩn bị trên máy

Chạy tại thư mục gốc dự án nếu cần di chuyển cấu hình từ phiên bản cũ:

```sh
node scripts/migrate-facebook-oauth-env.js
```

Script chuyển cấu hình Facebook từ `.env` gốc sang `license-server/.env`, tạo khóa mã hóa nếu chưa có, rồi xóa App Secret và callback cũ khỏi `.env` desktop. Script không gọi mạng, không thay Page Token và không tự cập nhật Render. Chạy lại không đổi khóa đã tạo; cấu hình App khác nhau giữa hai file sẽ dừng để tránh ghi đè.

`.env` desktop chỉ cần `FACEBOOK_OAUTH_BACKEND_URL=https://editnhanh.com` cho kết nối. Nếu bỏ trống, ứng dụng dùng `LICENSE_SERVER_URL`. Bộ cài loại trừ backend cùng các file `.env`; kiểm tra trước build sẽ chặn nếu App Secret vẫn nằm ở `.env` desktop.

## Đưa lên Render

Chưa xác minh trực tiếp cấu hình service trên Render. Thực hiện trên **service đang phục vụ editnhanh.com**, giữ các thiết lập MongoDB, email, bản quyền và domain hiện có.

1. Đưa code cập nhật lên nguồn triển khai của service. Phải có `license-server/server.js`, `license-server/lib/facebook-oauth.js` và `license-server/lib/facebook-oauth-store.js`. Không đưa `.env` lên Git.
2. Trong Render → service → **Environment**, thêm các biến dưới đây. Lấy giá trị từ `license-server/.env` trên máy, không gửi secret qua chat. Chỉ chuyển các biến Facebook; không nhập toàn bộ file để tránh ghi đè cấu hình khác của server.

| Biến | Giá trị |
| --- | --- |
| `FACEBOOK_APP_ID` | App ID hiện tại |
| `FACEBOOK_APP_SECRET` | App Secret hiện tại |
| `FACEBOOK_GRAPH_API_VERSION` | Phiên bản đang dùng, hiện mặc định `v25.0` |
| `FACEBOOK_OAUTH_REDIRECT_URI` | `https://editnhanh.com/api/facebook/oauth/callback` |
| `FACEBOOK_OAUTH_ENCRYPTION_KEY` | Khóa Base64 32 byte do script tạo |
| `FACEBOOK_LOGIN_CONFIG_ID` | Chỉ đặt nếu ứng dụng Meta dùng Login Configuration |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | Chỉ cần khi cấu hình webhook |

3. Backend cần kết nối MongoDB hoạt động và runtime Node tương thích các dependency hiện có. Phiên OAuth không dùng database JSON dự phòng. Dùng cùng khóa mã hóa trên mọi instance; đổi khóa sẽ làm mất khả năng nhận các phiên đang chờ.
4. Lưu biến và triển khai **code mới**. Chỉ redeploy bản build cũ với biến mới sẽ chưa có endpoint OAuth. Các lựa chọn lưu/triển khai được mô tả trong [tài liệu Render](https://render.com/docs/configure-environment-variables).
5. Trong cấu hình Facebook Login của Meta App, thêm chính xác **Valid OAuth Redirect URI**: `https://editnhanh.com/api/facebook/oauth/callback`. Domain dùng cho luồng mới là `editnhanh.com`. Không cần tunnel tới cổng ứng dụng desktop.
6. Nếu dùng webhook, callback mới là `https://editnhanh.com/api/facebook/webhook`, cùng verify token đã đặt. Webhook là tùy chọn cho hàng đợi hiện tại.

## Kiểm tra sau triển khai

- Mở `https://editnhanh.com/api/facebook/oauth/config`: cần trả JSON `configured: true`, `mode: "backend"`. Nếu false, kiểm tra các biến trên và kết nối MongoDB.
- Khởi động lại ứng dụng desktop để nạp code/cấu hình mới. Nhấn Kết nối Facebook, đăng nhập và kiểm tra danh sách Page được nhận. Trình duyệt phải quay về domain backend, không về tunnel cũ.
- Page đã lưu vẫn dùng để đăng/bình luận nếu token còn hiệu lực. Trong lúc chưa deploy backend, kết nối OAuth mới sẽ báo backend chưa sẵn sàng; không cần xóa các Page cũ.
- Nếu desktop tắt giữa phiên, kết nối lại từ đầu. Token tạm còn trên backend hết hạn theo phiên.

## Kiểm thử cục bộ

```sh
node --test test/facebook-oauth-migration.test.js license-server/test/facebook-oauth.test.js
```

Test dùng HTTP cục bộ, dữ liệu bản quyền/Meta giả và kho phiên trong bộ nhớ; kiểm tra bảo vệ phiên, hết hạn, replay, mã hóa, retry nhận token, ACK sau khi lưu, webhook và di chuyển `.env`. Đây không phải kiểm chứng đăng nhập thật qua Render hoặc MongoDB thật.
