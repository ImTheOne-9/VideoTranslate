# -*- coding: utf-8 -*-
"""chan_doan_loi.py — CHẨN ĐOÁN lỗi máy khách → thông báo tiếng Việt RÕ + hướng sửa.

Máy khách đa dạng, hay gặp lỗi hệ thống mơ hồ (DLL fail, thiếu VC++, WDAC chặn, thiếu model, hết đĩa...)
khiến render "thất bại" không rõ nguyên nhân → khách loay hoay. Module này nhận 1 exception/chuỗi lỗi,
so với các MẪU lỗi thường gặp (đúc kết từ memory + support thật), trả chẩn đoán RÕ RÀNG.

Module RIÊNG (không phụ thuộc localize.py). Dùng: `d = chan_doan(exc); if d: log(d['thong_bao'])`.
Trả None nếu KHÔNG nhận diện được (caller xử lý mặc định — KHÔNG bịa chẩn đoán sai).
"""
import re

# Mỗi mẫu: (tên_nhóm, [regex khớp (lowercase)], thông_báo_VN, hướng_dẫn, tự_phục_hồi)
#   tự_phục_hồi = True: lỗi này thường có đường lùi tự động (vd GPU→CPU, ASR→OCR) → chỉ CẢNH BÁO, không chặn.
# THỨ TỰ QUAN TRỌNG: mẫu CỤ THỂ trước mẫu chung. WDAC phải TRƯỚC vcredist vì lỗi WDAC cũng chứa "DLL load
# failed" (nhưng nguyên nhân + cách sửa KHÁC hẳn — chặn-chữ-ký chứ không phải thiếu VC++).
_MAU = [
    ("wdac",
     [r"application control policy has blocked", r"blocked by.*policy", r"code integrity",
      r"did not meet the enterprise signing", r"0xc0000428"],
     "Chính sách bảo mật Windows (WDAC/Application Control) đang CHẶN một thư viện chưa-ký-số của tính năng này.",
     "Đây là chính sách máy doanh nghiệp/quản trị. Cách xử lý: (1) nhờ IT thêm ngoại lệ cho thư mục app; hoặc "
     "(2) dùng máy cá nhân không bật WDAC. App sẽ TỰ LÙI sang phương án khác nếu có (OCR/CPU).",
     True),

    # 🔴 KHÁCH BÁO 17/08/2026 (ảnh chụp màn hình): traceback Python đổ ra nguyên xi, khách hỏi
    # "như này là báo lỗi hả bạn ơi". Chuỗi thật: `DataFetchError: Expecting value: line 1 column 1
    # (char 0), Blocked by ArgusSecurity/Slardar Wasm Error`. Đây là CHỐNG BOT của Douyin: nó trả
    # HTML/JS thay vì JSON ⇒ `response.json()` vỡ ngay ký tự đầu ⇒ thông báo nói về "Expecting value"
    # (lỗi PARSE) trong khi nguyên nhân thật là BỊ CHẶN. Trước đây KHÔNG có mục nào bắt chuỗi này
    # nên khách chỉ thấy traceback và không biết phải làm gì.
    ("douyin_chan_bot",
     [r"argussecurity", r"slardar", r"wasm error",
      # `Expecting value: line 1 column 1` CHỈ tính khi đi kèm douyin/DataFetchError — một mình nó
      # là lỗi JSON chung chung, bắt rộng sẽ nuốt oan các ca khác.
      r"datafetcherror.*expecting value: line 1 column 1"],
     "Douyin CHẶN yêu cầu (hệ chống bot ArgusSecurity) — máy chủ trả về trang chặn thay vì dữ liệu, "
     "nên tải về 0 video. KHÔNG phải app hỏng, cũng KHÔNG phải mạng của bạn.",
     "Thử theo thứ tự: (1) bấm 'Đăng nhập' Douyin rồi cào lại — đã đăng nhập thì ít bị chặn hơn hẳn; "
     "(2) đợi 15–30 phút rồi thử lại (Douyin chặn theo IP trong một khoảng thời gian); "
     "(3) cào ÍT video hơn mỗi lần và tránh cào liên tục nhiều kênh; "
     "(4) đổi mạng (4G điện thoại) nếu IP nhà mạng đang bị đánh dấu.",
     False),

    ("vcredist",
     [r"could not find module", r"dll load failed", r"winerror 1114", r"dll initialization",
      r"c10\.dll", r"ctranslate2\.dll", r"onnxruntime.*\.dll", r"the specified module could not be found",
      r"vcruntime", r"msvcp\d+\.dll"],
     "Thiếu thư viện hệ thống (Microsoft Visual C++ Redistributable) — nhiều tính năng (nhận giọng nói, OCR, "
     "lồng tiếng) cần nó để nạp file .dll.",
     "CÀI 'Microsoft Visual C++ Redistributable x64': aka.ms/vs/17/release/vc_redist.x64.exe → mở lại app. "
     "(Video CÓ phụ đề cứng vẫn xử lý được bằng OCR nếu onnxruntime nạp được.)",
     False),

    ("het_dia",
     [r"no space left", r"khong con dung luong", r"disk.*full", r"errno 28", r"not enough space",
      r"there is not enough space on the disk"],
     "Ổ đĩa ĐẦY — không đủ chỗ để render/tải model (video tạm + model có thể vài GB).",
     "Dọn ổ đĩa (Recycle Bin, Downloads, temp) hoặc đổi thư mục lưu (data_root) sang ổ còn trống ≥5GB rồi thử lại.",
     False),

    # 🐛 fix (audit cải tiến #D/#H4): 2 nhóm này TRƯỚC ĐÂY chỉ có ở bộ pattern RIÊNG của
    # `web_app._loi_than_thien` (dùng cho lỗi hàng đợi render) — 3 call site khác dùng THẲNG `chan_doan()`
    # (localize.py, ocr_text.py) không nhận diện được, dù đây là 2 loại lỗi phổ biến NHẤT trên máy mục tiêu
    # (CPU-only 16GB chạy Whisper+demucs+TTS cùng lúc — dễ hết RAM nhất). Thêm vào đây để MỌI caller đều
    # hưởng lợi, không riêng đường render hàng đợi. Đặt CẠNH "het_dia" (cùng họ hết-tài-nguyên).
    ("het_ram",
     [r"memoryerror", r"paging file", r"bad allocation", r"cannot allocate", r"failed to allocate",
      r"mkl_malloc", r"winerror 1455", r"not enough memory", r"insufficient memory"],
     "Máy THIẾU RAM/bộ nhớ — không đủ để nạp model (nhận giọng/OCR/lồng tiếng) hoặc xử lý video.",
     "Đóng bớt trình duyệt & ứng dụng nặng, render TỪNG video một (đừng xếp nhiều cùng lúc). Nếu vẫn lỗi: "
     "TĂNG 'bộ nhớ ảo' (paging file) Windows — Cài đặt hệ thống → Advanced → Performance → Virtual memory → "
     "để Windows tự quản lý; hoặc nâng thêm RAM.",
     False),

    ("video_hong",
     [r"moov atom", r"invalid data", r"could not find codec"],
     "Video gốc bị hỏng hoặc tải chưa xong.",
     "Thử tải lại video đó rồi render lại. Nếu vẫn lỗi, video nguồn có thể thật sự bị hỏng (đổi nguồn khác).",
     False),

    ("thieu_model",
     [r"no such file.*\.onnx", r"no such file.*\.pt\b", r"model.*not found", r"khong tim thay model",
      r"failed to load model", r"cannot find.*model", r"is not registered"],
     "Thiếu/hỏng file MODEL (nhận giọng/OCR/lồng tiếng) — có thể tải dở giữa chừng (đứt mạng) hoặc bị AV xóa.",
     "Kiểm tra mạng rồi để app tải lại model (lần đầu vài trăm MB–2GB). Nếu vẫn lỗi: xóa thư mục model cache "
     "để tải sạch, hoặc tạm tắt phần mềm diệt virus khi tải.",
     False),

    ("mang",
     [r"connection.*(reset|refused|timed out|aborted)", r"max retries exceeded", r"failed to establish",
      r"temporary failure in name resolution", r"getaddrinfo failed", r"timeout", r"cloudfront",
      r"502 bad gateway", r"503 service", r"504 gateway"],
     "Lỗi MẠNG khi tải model/dịch (kết nối chập chờn hoặc máy chủ tải chậm/quá tải).",
     "Kiểm tra mạng (ưu tiên mạng ổn định, tránh VPN chậm) rồi thử lại. App sẽ tự tải tiếp phần còn thiếu "
     "(không tải lại từ đầu). Nếu máy chủ model quá tải, thử lại sau ít phút.",
     True),

    ("gpu",
     [r"cuda.*(error|out of memory|oom)", r"cudnn", r"cublas", r"cufft",
      r"no kernel image", r"device-side assert", r"cuda_error"],
     "GPU gặp lỗi (thiếu thư viện CUDA/cuDNN, hoặc HẾT VRAM khi model quá lớn cho card).",
     "App sẽ TỰ LÙI sang CPU (chậm hơn nhưng chạy được). Nếu muốn dùng GPU: cập nhật driver NVIDIA mới nhất. "
     "Card VRAM nhỏ (≤4GB) có thể OOM với model lớn — đây là bình thường, CPU vẫn xử lý được.",
     True),

    ("quyen",
     [r"permission denied", r"access is denied", r"errno 13", r"winerror 5", r"operation not permitted"],
     "Bị TỪ CHỐI QUYỀN ghi/đọc file (thư mục cần quyền admin, hoặc file đang bị chương trình khác/AV khóa).",
     "Đóng chương trình khác đang mở file đó; hoặc chuyển thư mục lưu sang nơi không cần quyền admin "
     "(vd Documents thay vì Program Files); hoặc thêm app vào ngoại lệ diệt virus.",
     False),

    ("uv_hong",
     [r"os error [23]\b.*uv", r"uv[\\/]python", r"failed to (hardlink|create|remove).*uv"],
     "Môi trường Python (uv) bị HỎNG DỞ (lần cài trước đứt mạng/bị AV dọn).",
     "App sẽ tự dọn & tải lại môi trường sạch. Nếu vẫn lỗi: xóa thủ công %APPDATA%\\uv và %LOCALAPPDATA%\\uv "
     "rồi mở lại app khi mạng ổn định.",
     False),
]

# Chẩn đoán THAY THẾ khi lỗi "DLL load failed" xảy ra NHƯNG máy ĐÃ CÓ VC++ Redistributable.
_CHAN_DOAN_ORT_HONG = {
    "nhom": "goi_python_hong",
    # Nhóm này bắt CẢ onnxruntime (OCR), ctranslate2 (Whisper) LẪN torch — nêu đủ tên để khách không hoang
    # mang khi log ghi 'ctranslate2.dll' mà thông báo chỉ nói 'onnxruntime' (đã gặp 09/08/2026).
    "thong_bao": "Gói Python nhận-dạng (onnxruntime / ctranslate2 / PyTorch) trong app KHÔNG nạp được, dù máy "
                 "ĐÃ CÓ đủ thư viện hệ thống (Visual C++). Thường do lần cài/cập nhật trước dừng giữa chừng, "
                 "hoặc gói tăng-tốc-GPU được cài nhưng máy thiếu driver CUDA đi kèm.",
    "huong_dan": "Chạy lại bộ CÀI ĐẶT/CẬP NHẬT của app (nó tự sửa môi trường) — KHÔNG cần cài Visual C++ nữa "
                 "vì máy bạn đã có. Nếu vừa bật 'Tăng tốc GPU' mà lỗi mới xuất hiện thì tắt nó đi rồi chạy lại.",
    "tu_phuc_hoi": False,
}

_VC_CACHE = []   # cache 1 lần/tiến trình: kiểm DLL là lời gọi hệ điều hành, đừng lặp mỗi lần log lỗi


def co_vc_runtime():
    """Máy CÓ Visual C++ Redistributable (x64) dùng được không? — KIỂM THẬT bằng cách NẠP chính các DLL đó.

    Vì sao phải kiểm thay vì suy từ chuỗi lỗi: bộ cài của app ĐÃ tự chạy `vc_redist.x64.exe /install /quiet`
    (NSIS `installer.nsh`) và `setup.js` còn chạy lại mỗi lần mở app ⇒ gần như MỌI máy khách đều đã có sẵn.
    Trong khi mẫu regex "vcredist" khớp rất rộng (`dll load failed`, `could not find module`...) — mà lỗi nạp
    onnxruntime còn do NHIỀU nguyên nhân khác (venv cài dở, gói GPU thiếu CUDA, AV xoá .dll). Kết quả: khách
    được bảo đi cài thứ HỌ ĐÃ CÓ → cài xong không đổi gì → tưởng app hỏng và báo lại. Đây là kiểm bằng SỰ
    THẬT trên máy, không phải đoán từ chữ trong exception.
    Không phải Windows / không kiểm được → trả False (giữ nguyên chẩn đoán cũ, không tự tin thái quá)."""
    if _VC_CACHE:
        return _VC_CACHE[0]
    ok = False
    try:
        import ctypes
        if hasattr(ctypes, "WinDLL"):
            for _t in ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"):
                ctypes.WinDLL(_t)      # nạp được cả 3 = runtime VC++ x64 đầy đủ
            ok = True
    except Exception:
        ok = False
    _VC_CACHE.append(ok)
    return ok


def chan_doan(loi):
    """Nhận exception HOẶC chuỗi lỗi → trả dict {nhom, thong_bao, huong_dan, tu_phuc_hoi} nếu khớp mẫu;
    None nếu không nhận diện (caller dùng thông báo mặc định — KHÔNG bịa)."""
    msg = str(loi or "")
    low = msg.lower()
    if not low.strip():
        return None
    for nhom, pats, tb, hd, tph in _MAU:
        for p in pats:
            if re.search(p, low):
                if nhom == "vcredist" and co_vc_runtime():
                    # KIỂM THẬT trước khi đổ lỗi (xem co_vc_runtime): thư viện VC++ CÓ SẴN mà DLL vẫn không
                    # nạp được ⇒ nguyên nhân KHÁC, bảo khách đi cài VC++ là dắt họ đi sai đường.
                    return dict(_CHAN_DOAN_ORT_HONG)
                return {"nhom": nhom, "thong_bao": tb, "huong_dan": hd, "tu_phuc_hoi": tph}
    return None


def thong_bao_day_du(loi, mac_dinh=None):
    """Trả chuỗi thông báo HOÀN CHỈNH (thông_báo + hướng_dẫn) để hiện cho user.
    Không nhận diện được → trả `mac_dinh` (hoặc rút gọn chuỗi lỗi gốc)."""
    d = chan_doan(loi)
    if d:
        return "⚠ %s\n👉 %s" % (d["thong_bao"], d["huong_dan"])
    if mac_dinh:
        return mac_dinh
    return "⚠ Lỗi: %s" % str(loi)[:200]


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    # tự kiểm nhanh các mẫu
    _test = [
        "ImportError: DLL load failed while importing _box: An Application Control policy has blocked this file.",
        "Could not find module 'ctranslate2.dll' (or one of its dependencies).",
        "OSError: [Errno 28] No space left on device",
        "RuntimeError: model 'paraformer-zh' is not registered.",
        "requests.exceptions.ConnectionError: Max retries exceeded ... CloudFront 504",
        "cuda out of memory",
        "PermissionError: [WinError 5] Access is denied",
        "một lỗi lạ không có trong mẫu",
    ]
    for t in _test:
        d = chan_doan(t)
        print("•", (d["nhom"] if d else "KHÔNG NHẬN DIỆN"), "|", t[:55])


