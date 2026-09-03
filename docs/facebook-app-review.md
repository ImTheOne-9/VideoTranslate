# Hồ sơ D — Meta App Review / E — Phát hành

Cập nhật kiểm tra: 03/09/2026. Đây là hồ sơ chuẩn bị, không phải xác nhận Meta đã phê duyệt.

## Trạng thái có bằng chứng

- App trên Dashboard: **Video Studio**, ID `1837023007457224`.
- Danh mục doanh nghiệp: **Hoang Business**, ID `2138162720389813`. Tên này chưa xác minh là tên pháp lý.
- Người vận hành do chủ sản phẩm cung cấp: **Đoàn Việt Hoàng**. Đã bổ sung tên này vào các trang công khai trong source; đây không phải xác nhận doanh nghiệp của Meta.
- Danh sách app hiển thị **Đang phát triển**; Dashboard mới hiển thị **Đã hủy đăng**.
- Dashboard yêu cầu trở thành **Nhà cung cấp công nghệ**, hoàn tất xác minh quyền truy cập để gửi xét duyệt và dùng dữ liệu của doanh nghiệp khác.
- Mục **Đăng** đang khóa nút phát hành và yêu cầu URL chính sách riêng tư. Trong **Thông tin cơ bản**, URL này và email liên hệ đang trống; Terms và Data Deletion đang là `https://www.facebook.com/`, không phải chính sách của Editnhanh. Giao diện chưa hiển thị icon đã tải hoặc hạng mục được chọn. Chưa sửa/lưu các giá trị này vì URL mới chưa được triển khai.
- `https://editnhanh.com/api/facebook/oauth/config` trả HTTP 200, `configured: true`, `mode: backend`.
- Email hỗ trợ/xóa dữ liệu do chủ sản phẩm chọn: **doanhoang1910@gmail.com**. Đã cập nhật trong bốn trang chuẩn bị phát hành. Cấu hình website đang chạy vẫn là `support@editnhanh.com` tại lần kiểm tra trước; cần cập nhật cấu hình liên hệ của website khi triển khai để đồng nhất. Chưa gửi email thử.
- Bốn trang bên dưới đã có trong source và được build cục bộ. Chưa triển khai chúng lên Render; chưa gán URL vào Meta, chưa gửi App Review, chưa phát hành.
- Build frontend thành công. Đã mở cả bốn trang build bằng HTTP cục bộ ở chiều rộng 1280 và 390 px: trả 200, có tiêu đề, không tràn ngang, không nhúng script theo dõi. Chưa kiểm tra bộ cài Windows cuối cùng hoặc quay video bằng chứng thật.

## Các URL chuẩn bị cho Meta

| Mục | URL sau khi triển khai |
| --- | --- |
| Website sản phẩm | https://editnhanh.com/facebook.html |
| Privacy Policy | https://editnhanh.com/privacy.html |
| Terms of Service | https://editnhanh.com/terms.html |
| Data Deletion Instructions | https://editnhanh.com/data-deletion.html |
| OAuth redirect URI | https://editnhanh.com/api/facebook/oauth/callback |

Chọn **URL hướng dẫn xóa dữ liệu** nếu Dashboard cung cấp lựa chọn này. Không điền trang HTML vào ô yêu cầu callback POST có chữ ký: đây chưa phải endpoint Data Deletion Callback tự động. Không dùng OAuth callback hoặc webhook nhận sự kiện làm callback xóa dữ liệu.

Tên người vận hành và email hỗ trợ đã được chủ sản phẩm cung cấp. Dùng **Đoàn Việt Hoàng** và **doanhoang1910@gmail.com** cho thông tin liên hệ tương ứng; không tự gán người vận hành làm Nhân viên bảo vệ dữ liệu (DPO). Trước khi công khai chính sách, chủ sản phẩm cần rà quy trình xác minh và xử lý yêu cầu xóa, bên xử lý dữ liệu và nội dung điều khoản. Các trang mô tả cách triển khai hiện tại; không hứa tự xóa lịch sử máy khách từ server.

## Quyền thực sự được code sử dụng

Backend hiện khai báo `public_profile`, `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `read_insights` tại `license-server/lib/facebook-oauth.js`.

Nếu có `FACEBOOK_LOGIN_CONFIG_ID`, phạm vi OAuth do Login Configuration trên Meta quyết định. Cần đối chiếu cấu hình đó với bảng dưới; không suy ra quyền đã được cấp chỉ từ `/oauth/config`.

| Quyền | Chức năng và bằng chứng cần quay |
| --- | --- |
| public_profile | Đăng nhập Facebook; không mô tả là quyền dùng để đăng Page. Kiểm tra Dashboard có yêu cầu nộp riêng hay không. |
| pages_show_list | Sau OAuth, danh sách Page được cấp quyền xuất hiện trong Quản lý Page và người dùng chọn Page đích. |
| pages_manage_posts | Chọn video có quyền sử dụng, caption và Page; xuất bản, chờ xác nhận, mở bài thực tế trên Facebook. |
| pages_read_engagement | Đọc thông tin bài/Page và tương tác mà giao diện quản lý hiển thị. |
| pages_read_user_content | Đọc bình luận do một người dùng khác viết trên bài của Page. Không chỉ quay bình luận do chính Page tạo. |
| pages_manage_engagement | Trả lời và thích/bỏ thích bình luận; có thể minh họa xóa bình luận thử nếu được phép. |
| read_insights | Mở Quản lý và hiển thị `post_media_view` / `post_clicks` thật do API trả về. Không thay bằng số giả. |

Không thêm quyền không dùng chỉ để hoàn thành biểu mẫu. Quyền nào chưa có bằng chứng hoạt động thì xử lý chức năng/bằng chứng trước khi xin; nếu bỏ khỏi phạm vi sản phẩm phải điều chỉnh cả code OAuth và Login Configuration.

## Nội dung tiếng Anh để điền hồ sơ

### App purpose

Video Studio is the Facebook integration used by Editnhanh / Video Studio Tools, a Windows application for video creation and Page content management. A user connects Facebook through our hosted OAuth service, grants access to Pages they manage, and selects a Page in the desktop app. The app uploads user-selected videos, optionally schedules publication, displays publishing status, and lets the user read and manage comments and view supported post insights. Users can also explicitly enable publishing after a render finishes.

OAuth code exchange and the app secret stay on our backend. Page credentials are temporarily encrypted for delivery to the authenticated licensed device, and Page tokens are stored encrypted on that device. Video upload and Page management requests are made from the desktop application to Meta. The integration does not ask users to provide their Facebook password to Editnhanh.

### pages_show_list

We use pages_show_list to retrieve the Pages the authenticated user has authorized for our app and display them in the Page Management screen. The user selects one of these Pages as the destination for a video. This prevents the user from having to manually enter Page identifiers or access tokens.

### pages_manage_posts

We use pages_manage_posts to publish user-selected video content to the selected authorized Facebook Page. The user chooses the Page, caption, post type, and immediate or scheduled publication before submitting. When automatic publishing after rendering is enabled, the app uses the user's saved Page and publishing settings. Our job list displays upload, processing, and publication status and provides a link to the resulting Facebook content.

### pages_read_engagement

We use pages_read_engagement to read information and engagement associated with content on the authorized Page for our post management view. Users open a published item from the Facebook job history to inspect the post and its engagement in context. This permission supports the read operations needed by our Page management and insights features alongside the relevant additional permissions.

### pages_read_user_content

We use pages_read_user_content to display comments that other people leave on posts belonging to the connected Page. A Page manager opens the post management dialog, reads these comments, and chooses whether to respond. Access is limited to the authorized Page; the app does not browse unrelated people's profiles or feeds.

### pages_manage_engagement

We use pages_manage_engagement so an authorized Page manager can send a comment, reply to an existing comment, like or unlike it, and delete a comment where permitted. Replies are entered in an inline editor and are submitted by the user. A first comment may also be supplied in advance when creating a publishing job; the app sends it only after it confirms that the post is published.

### read_insights

We use read_insights to show supported post insight metrics in the post management dialog, currently post_media_view and post_clicks. This lets the manager inspect the performance of content they published to the connected Page. Values are displayed from Meta API responses; the application does not create or estimate missing insight values.

## Reviewer instructions — cần điền thông tin thật trước khi nộp

Không nộp nguyên phần này khi còn chỗ trống. Cung cấp bộ cài Windows đúng phiên bản và giấy phép thử hợp lệ qua trường riêng dành cho reviewer. Không chia sẻ tài khoản Facebook cá nhân, mật khẩu, OTP, App Secret hoặc Page Token.

1. Download and install Video Studio Tools for Windows from **[verified installer URL]**, version **[tested version]**.
2. Activate the application using **[review-only access instructions supplied privately]**. State the actual OS requirements and license/device constraints. Do not require a purchase or an unannounced manual approval during review.
3. Open **Quản lý Page (Page Management)**, then **KẾT NỐI FACEBOOK (Connect Facebook)**.
4. Sign in through Facebook, authorize the required Page access, and return to the desktop app. The selected Pages appear in the list.
5. Open **[exact video-selection screen used in the recording]**, select **[review media supplied with usage permission]**, and choose **Đăng lên Fanpage**.
6. Select a Page, enter a caption, choose Video Post, and publish. Wait until the history shows **Đã đăng**. Use **Mở bài** to verify the resulting post on Facebook.
7. Use a Page post with an existing comment written by another person. Open **Quản lý**, read the comment, use **Trả lời**, type a reply and submit, then use **Thích/Bỏ thích**. Show the corresponding result on Facebook.
8. In the same dialog, show the supported insight cards populated from Meta. Explain any metric genuinely unavailable for the chosen post; do not claim a missing metric works.
9. To disconnect locally, open Quản lý Page and remove the Page. The public data-deletion instructions explain how to revoke the Facebook integration and request assistance with remaining data.

## Kịch bản video bằng chứng

Quay bản thực, không dùng ảnh mock hoặc video từ test tự động để trình Meta. Có thể chia thành ba video rõ chữ; mỗi video chỉ rõ tên quyền trong phần mô tả nộp kèm.

- **01-connect-publish.mp4:** hiện tên ứng dụng → mở kết nối → màn hình cấp quyền → Page được tải → chọn Page/video/caption → gửi → trạng thái Đã đăng → mở bài thật.
- **02-comments.mp4:** bài thuộc Page có bình luận của người khác → đọc bình luận → trả lời ngay trong ứng dụng → thích/bỏ thích → đối chiếu trên Facebook.
- **03-insights.mp4:** chọn bài đã có dữ liệu → mở Quản lý → chỉ rõ hai thẻ số liệu và cách người dùng xem kết quả.

Ẩn thông tin bản quyền, token, cookie, App Secret và các dữ liệu không liên quan trước khi quay. Chỉ sử dụng Page/nội dung được chủ sở hữu cho phép dùng để demo. Không gửi nhiều bình luận hoặc đăng lại chỉ để làm video đẹp hơn.

## D — Trình tự chuẩn bị và nộp

1. Đã nhận thông tin người vận hành và email liên hệ. Rà quy trình hỗ trợ/xóa dữ liệu và nội dung các trang chính sách trước khi triển khai.
2. Triển khai frontend mới lên service Render đang phục vụ editnhanh.com, theo quy trình triển khai hiện có. Không thay biến môi trường hoặc deploy key khác.
3. Mở bốn URL bằng phiên không đăng nhập; xác nhận đúng nội dung, HTTPS và không bị chuyển về trang chủ. Build Vite tự sao chép các file `frontend/public` vào `frontend/dist`.
4. Trong Meta App Video Studio, điền URL chính sách, điều khoản, hướng dẫn xóa dữ liệu; giữ callback OAuth đã hoạt động. Kiểm tra icon, liên hệ và website.
5. Theo yêu cầu Dashboard, hoàn tất bước Nhà cung cấp công nghệ, xác minh quyền truy cập/doanh nghiệp và câu hỏi xử lý dữ liệu. Các thông tin pháp lý, giấy tờ, bên xử lý dữ liệu phải do chủ sản phẩm xác nhận. Không đánh dấu đã xác minh khi Meta chưa xác nhận.
6. Rà từng quyền trong use case Quản lý mọi thứ trên Trang. Chuẩn bị video, nội dung mô tả ở trên và điều kiện reviewer truy cập được bộ cài.
7. Điền hồ sơ bằng thông tin thực tế, kiểm tra lại bản xem trước và gửi xét duyệt. Ghi trạng thái/phản hồi của Meta; sửa đúng mục bị yêu cầu bổ sung.

## E — Phát hành khi Dashboard cho phép

Giao diện app này có mục **Đăng** và trạng thái đăng ứng dụng; không mặc định mọi Dashboard đều có nút chuyển Development → Live như hướng dẫn cũ.

Chỉ phát hành sau khi Meta xác nhận các yêu cầu cần thiết, quyền truy cập cho dữ liệu khách hàng đã sẵn sàng, URL chính sách hoạt động và bộ cài thực tế đã được kiểm thử.

Trước phát hành, xác nhận:

- Không có App Secret hoặc backend `.env` trong bộ cài; dùng kiểm tra `node scripts/package-preflight.js` và kiểm tra artifact phát hành.
- URL OAuth trong bản đóng gói trỏ đúng backend đang hoạt động, không phụ thuộc `.env` chỉ có trên máy phát triển.
- Reviewer/khách có bản quyền hợp lệ, có thể tự mở kết nối, nhận Page và đăng.
- Quyền đã được phê duyệt tương ứng đúng scopes/Login Configuration đang sử dụng.
- Có cách hỗ trợ token hết hạn, thu hồi quyền, yêu cầu xóa dữ liệu và tác vụ chưa rõ kết quả.

Sau phát hành, kiểm thử với một tài khoản được chủ sở hữu cho phép, **không thuộc App Roles**, có quyền quản lý Page dùng thử. Kiểm tra đăng nhập mới, nhận Page, đăng một nội dung thử được duyệt, quản lý bình luận, ngắt kết nối và không tự gửi lại tác vụ đã thành công. Đây là kiểm chứng còn thiếu; tài khoản Admin đăng được không thay thế được bước này.

## Tài liệu đối chiếu

- Dashboard thực tế: https://developers.facebook.com/apps/1837023007457224/dashboard/
- Quy trình xét duyệt: https://developers.facebook.com/docs/app-review/
- Data deletion: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/
- OAuth backend của dự án: `docs/facebook-oauth-backend.md`.

Các trang tài liệu Meta trực tiếp trả lỗi 429 trong phiên kiểm tra. Những yêu cầu riêng của app ở trên lấy từ Dashboard đăng nhập; các trường và điều kiện chưa xem được cần kiểm tra thực tế, không coi hướng dẫn cũ là bằng chứng đã đáp ứng.
