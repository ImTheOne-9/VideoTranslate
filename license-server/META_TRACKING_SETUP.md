# Meta Pixel & Conversions API

## Biến môi trường production

```env
META_PIXEL_ID=1048557318333738
META_CAPI_ACCESS_TOKEN=your_server_access_token
META_GRAPH_API_VERSION=v26.0
META_CAPI_TIMEOUT_MS=8000
META_CAPI_MAX_ATTEMPTS=3
META_TEST_EVENT_CODE=
```

`META_CAPI_ACCESS_TOKEN` chỉ được đặt trên server (ví dụ Render Environment). Không nhập token trong Admin UI hoặc đưa vào frontend.

## Luồng sự kiện

- `PageView`: Pixel khi ứng dụng khởi tạo.
- `ViewContent`: Pixel khi mở bảng giá.
- `InitiateCheckout`: Pixel khi chọn gói.
- `CompleteRegistration`: Pixel + CAPI sau khi xác minh email, dùng chung event ID.
- `Purchase`: Pixel + CAPI sau khi webhook VietQR kích hoạt license, dùng chung event ID.
- `DownloadApp`, `Login`, `CopyLicenseKey`: custom events phía Pixel.
- `Contact`: Pixel khi nhấn Email, Zalo hoặc Telegram.

Email, số điện thoại và external ID được chuẩn hóa rồi SHA-256 trước khi gửi. License Key không được dùng làm `event_id` hoặc `order_id`.

## Kiểm thử trước deploy

1. Lấy Test Event Code trong Meta Events Manager và đặt tạm vào `META_TEST_EVENT_CODE`.
2. Build/deploy bản test.
3. Xác minh email một tài khoản mới: phải thấy một cặp browser/server `CompleteRegistration` được dedup.
4. Tạo đơn và mô phỏng/webhook một giao dịch VietQR: phải thấy một cặp browser/server `Purchase` được dedup, đúng giá và `VND`.
5. Kiểm tra `DownloadApp`, `Contact`, `Login`, `ViewContent`, `InitiateCheckout` trong Test Events.
6. Xóa `META_TEST_EVENT_CODE` trước khi chạy production.

## Lệnh kiểm tra local

```bash
npm test
npm run build --prefix frontend
node --check server.js
```
