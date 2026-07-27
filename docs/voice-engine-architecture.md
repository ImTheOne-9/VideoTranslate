# Voice Engine Adapter

Phần 3 chuẩn hóa hệ thống giọng nói để luồng render không phụ thuộc trực tiếp
vào OmniVoice CLI.

## Hợp đồng chung

Mọi engine giọng nói phải triển khai:

```js
VoiceEngine {
  checkStatus()
  loadModel()
  synthesize()
  cloneVoice()
  cancel()
  getCapabilities()
}
```

`VoiceEngineRegistry` quản lý engine theo `id`. Render chỉ lấy engine từ
registry và gọi hợp đồng chung, không tự tạo tham số CLI.

## Engine hiện tại

`CurrentOmniVoiceEngine` bọc OmniVoice CLI đang dùng và khai báo:

- Clone giọng: có.
- Ngôn ngữ: Việt, Anh, Trung.
- Thiết bị: CPU, Vulkan, CUDA.
- Sample rate đầu ra: 24 kHz.
- Điều khiển thời lượng: có.
- Điều khiển cảm xúc và tốc độ trực tiếp: chưa có.

Engine mặc định có id `current-omnivoice`.

## Fallback CPU

Fallback GPU sang CPU mặc định tắt. Nó chỉ được phép khi
`voiceAllowCpuFallback=true`. Kết quả thực thi lưu:

- Engine đã dùng.
- Thiết bị được yêu cầu.
- Thiết bị thực tế.
- Có fallback hay không.
- Lý do fallback.

Thông tin này được lưu trong manifest của tác vụ để còn sau khi mở lại ứng dụng.

## Thêm engine mới

1. Tạo adapter kế thừa `VoiceEngine`.
2. Khai báo đầy đủ capabilities.
3. Đăng ký adapter trong `createDefaultVoiceEngineRegistry()`.
4. Không thêm điều kiện engine riêng vào `studioController`.

Các adapter OmniVoice Studio API hoặc Sherpa ONNX sẽ được đăng ký khi runtime
tương ứng thực sự được tích hợp. Không hiển thị engine giả chưa thể chạy.
