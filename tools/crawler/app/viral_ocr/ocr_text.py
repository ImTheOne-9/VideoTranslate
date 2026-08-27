# -*- coding: utf-8 -*-
"""Đọc TEXT phụ đề CỨNG bằng OCR — mặc định RapidOCR 3.x + PP-OCRv6 small (env OCR_MODEL); lùi
PP-OCRv4 mobile ONNX (rapidocr_onnxruntime, gói cũ) nếu thiếu v6. Thay cho ASR audio.

Dùng CHUNG band (dai_sub) + intervals (ocr_timing) như nhánh funasr_ocr: mỗi khoảng sub đổi → lấy 1 frame
giữa khoảng → crop DẢI sub → OCR → text. Lợi: chữ trên video = NGUYÊN VĂN (hơn ASR nghe nhầm/ảo giác),
không cần FunASR, RapidOCR khởi động nhanh. CHỈ chạy khi có hardsub (caller đã dò band + đủ khoảng);
không hardsub → caller tự lùi ASR (giọng nói thành văn bản).
"""
import os
import re as _re
import sys
import unicodedata as _ud

# Cờ "đã thử tự sửa onnxruntime trong TIẾN TRÌNH này" — xem `onnx_nap_duoc`. Chỉ thử MỘT lần: gói hỏng
# thật thì lần 2 cũng hỏng, mà mỗi lần thử tốn cả phút × 22 video trong hàng đợi.
_DA_THU_SUA_ORT = [False]
try:                                   # phồn→giản cho SO-SÁNH gộp cue (vendored zhconv ở app-src); thiếu → no-op
    from zhconv import convert as _zhc
except Exception:
    _zhc = None

_CMP_PUNCT = _re.compile(r"[·、，。！？：；…\s\"'“”‘’（）()《》〈〉「」『』\-—,.!?:;~•]")

# LỌC RÁC KÝ TỰ OCR: hardsub Trung nhưng rec đôi lúc nhả latin/số LẺ ở rìa chữ mờ ('你以后要多运动K', '5EE', 'E').
# Bỏ: (a) cụm latin/số ≤3 ký tự KỀ chữ Hán (đuôi/giữa) — nhiễu mép; (b) dòng THUẦN latin/số ngắn (≤4) — nhiễu hẳn.
# CHỈ áp khi câu có chữ Hán (video Trung) → KHÔNG đụng phụ đề tiếng Anh/Latin thật. Rẻ, chạy mỗi text rec.
_HAN = "一-鿿㐀-䶿"
_RAC_DUOI = _re.compile("(?<=[" + _HAN + "])[A-Za-z0-9]{1,3}$")             # đuôi latin/số kề Hán
_RAC_GIUA = _re.compile("(?<=[" + _HAN + "])[A-Za-z0-9]{1,2}(?=[" + _HAN + "])")  # kẹp giữa 2 chữ Hán
def _loc_rac_ocr(t):
    if not t:
        return t
    s = t.strip()
    if not _re.search("[" + _HAN + "]", s):                 # thuần latin/số → ngắn = nhiễu (K/E/5EE), dài = giữ (có thể chữ thật)
        return "" if len(_re.sub(r"\s", "", s)) <= 4 else s
    s = _RAC_GIUA.sub("", s)
    s = _RAC_DUOI.sub("", s)
    return s.strip()

def _norm_cmp(s):
    """Chuẩn-hoá để SO-SÁNH cue (KHÔNG đổi text gốc): NFKC → phồn→giản → bỏ dấu câu/khoảng trắng/ký tự trang trí.
    → '你好啊' == '你好啊！' == '你好啊。' khi gộp tại nguồn (hết cue lặp do OCR thêm/bớt 1 dấu câu)."""
    s = _ud.normalize("NFKC", s or "")
    if _zhc:
        try:
            s = _zhc(s, "zh-hans")
        except Exception:
            pass
    s = _CMP_PUNCT.sub("", s).strip()
    # bỏ RÁC Latin/số ĐẦU-ĐUÔI ngắn (≤2 ký tự) do OCR đọc viền/hiệu-ứng (vd '价值W', '好好ww', '4分量') — chỉ
    # để SO-SÁNH (không đổi text gốc); cap ≤2 để KHÔNG nuốt từ Latin thật (MVP, 4K...).
    s = _re.sub(r"^[A-Za-z0-9]{1,2}(?=[一-鿿])", "", s)
    s = _re.sub(r"(?<=[一-鿿])[A-Za-z0-9]{1,2}$", "", s)
    return s.strip()

_ENGINE = None


def _score_min():
    """Ngưỡng score OCR tối thiểu để GIỮ câu (mặc định 0.5 — CÂN BẰNG). Hạ thấp (vd 0.35) bắt thêm câu MỜ nhưng
    KÈM RÁC (chữ lặp 西西西/香香香 do OCR đọc nhiễu chữ mờ) + trùng-drift → mất công dedup. Giữ 0.5 an toàn; khách
    video sub mờ cụ thể có thể tự hạ qua env OCR_SCORE_MIN."""
    try:
        return float(os.environ.get("OCR_SCORE_MIN", "0.5") or 0.5)
    except (ValueError, TypeError):
        return 0.5


def onnx_nap_duoc(log_fn=None):
    """onnxruntime nạp được DLL không? RapidOCR + Piper đều CẦN onnxruntime → nếu DLL init fail (máy khách
    THIẾU Visual C++ Redistributable MỚI) thì cả OCR lẫn Piper chết → render 'thất bại' mơ hồ. Kiểm SỚM +
    báo tiếng Việt RÕ (kèm link tải VC++ Redist) để khách tự sửa. Trả True/False."""
    # 🔴 (06/08/2026) KHÔNG chỉ `import` — phải GỌI THỬ. Bài học đã ghi sẵn ở `cai_gpu._ort_nap_duoc` nhưng
    # chỉ áp cho đường CÀI ĐẶT; hàm này (chạy lúc RENDER) vẫn là import trần ⇒ hai nơi kiểm CÙNG MỘT THỨ bằng
    # HAI tiêu chuẩn khác nhau (§55.5). Kiểu hỏng thật hay gặp: gỡ nửa chừng làm mất `__init__.py` mà còn
    # `capi/*.dll` ⇒ Python coi là NAMESPACE PACKAGE ⇒ `import` THÀNH CÔNG trên module RỖNG (`__file__=None`).
    # `__version__` chứng minh có `__init__.py` thật; `SessionOptions()` chứng minh phần NATIVE nạp được
    # (đúng thứ hỏng ở ca 05/08: `cannot import name 'GraphOptimizationLevel'`).
    # Không có bước này thì cổng đầu báo "lành" rồi OCR/LaMa/Piper chết GIỮA render với lỗi khó hiểu.
    try:
        import onnxruntime as _o
        _o.__version__
        _o.SessionOptions()
        return True
    except Exception as e:
        _m = str(e)
        if log_fn and ("DLL load failed" in _m or "_pybind11_state" in _m or "initialization routine" in _m):
            # KHÔNG đổ lỗi VC++ khi CHƯA kiểm: bộ cài app đã tự chạy vc_redist nên máy khách gần như luôn có
            # sẵn (xem chan_doan_loi.co_vc_runtime) → bảo họ đi cài lại là dắt đi sai đường. Dùng CHUNG bộ
            # chẩn đoán để mọi nơi nói cùng một điều.
            try:
                import chan_doan_loi
                log_fn("%s (Chi tiết kỹ thuật: %s)" % (chan_doan_loi.thong_bao_day_du(e), _m[:100]))
            except Exception:
                log_fn("⚠ onnxruntime không nạp được (%s)." % _m[:100])
        elif log_fn:
            log_fn("⚠ onnxruntime không nạp được (%s)." % _m[:100])
        # 🔴 TỰ CHỮA GÓI GỠ-DỞ-DANG (5 khách cùng lỗi trong một buổi, 07/08/2026 sau đợt update v1.6.2):
        #   AttributeError: module 'onnxruntime' has no attribute '__version__' / 'SessionOptions'
        # `import` THÀNH CÔNG nhưng ra namespace RỖNG — mất `__init__.py`+`capi/`, còn `quantization/`+`tools/`
        # (onnxruntime CPU và -gpu dùng CHUNG thư mục module; cái cài sau đè cái trước, gỡ dở thì mất file).
        # TRƯỚC ĐÂY khách chỉ nhận thông báo "Lỗi tải/chạy mô hình nhận dạng giọng — kiểm tra mạng rồi thử
        # lại" ⇒ đi kiểm mạng vô ích; còn gợi ý "bấm ⚡ Cài/sửa tăng tốc GPU" thì KHÔNG CỨU vì `.dist-info`
        # còn nguyên nên uv/pip tưởng gói đã đủ và bỏ qua. Một khách có hàng đợi 22 video hỏng sạch.
        # Nay: nhận diện ĐÚNG chữ ký này rồi gọi `cai_gpu.py --sua-ort` (chỉ đụng 1 gói, KHÔNG cài lại
        # torch/CUDA nên không kéo dài hàng phút). CHỈ THỬ MỘT LẦN mỗi tiến trình — hỏng thật thì lần 2 cũng
        # hỏng, thử lại chỉ làm mỗi video chậm thêm. Tắt: VC_TU_SUA_ORT=0.
        # 🔴 MỞ RỘNG ĐIỀU KIỆN (07/08/2026 — 3 khách nữa trong buổi, bản **1.6.3**): chỉ bắt "has no attribute"
        # là BỎ SÓT mức hỏng NẶNG HƠN. Đo thật trên máy khách `AT Gamjng`: thư mục `onnxruntime` MẤT HẲN mà
        # `onnxruntime_gpu-1.22.0.dist-info` VẪN CÒN ⇒ lỗi là `ModuleNotFoundError: No module named
        # 'onnxruntime'`, KHÔNG chứa "has no attribute" ⇒ cổng này im lặng ⇒ đúng máy cần tự chữa nhất thì
        # KHÔNG chữa. Thêm cả `cannot import name … from 'onnxruntime'` (namespace rỗng, ca 05/08).
        _dang_hong_ort = ("has no attribute" in _m
                          or "no module named 'onnxruntime'" in _m.lower()
                          or ("cannot import name" in _m and "onnxruntime" in _m))
        if (_dang_hong_ort and not _DA_THU_SUA_ORT[0]
                and os.environ.get("VC_TU_SUA_ORT", "1") != "0"):
            _DA_THU_SUA_ORT[0] = True
            if log_fn:
                log_fn("🔧 Gói onnxruntime bị GỠ DỞ DANG (không phải lỗi mạng) → đang tự dọn và cài lại…")
            try:
                import subprocess as _sp
                _r = _sp.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                           "cai_gpu.py"), "--sua-ort"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace",
                             timeout=1800, creationflags=(0x08000000 if sys.platform == "win32" else 0))
                for _ln in (_r.stdout or "").splitlines()[-6:]:
                    if _ln.strip() and log_fn:
                        log_fn("   " + _ln.strip()[:150])
                if _r.returncode == 0:
                    # 🔴 BẮT BUỘC PURGE `sys.modules` TRƯỚC KHI KIỂM LẠI (07/08/2026). ĐO THẬT ngữ nghĩa
                    # import của Python: khi gói hỏng kiểu MẤT `__init__.py` (còn `quantization/`+`tools/`),
                    # `import onnxruntime` VẪN THÀNH CÔNG ra namespace RỖNG — và namespace đó **được cache**.
                    # Chữa file trên đĩa xong mà import lại thì Python TRẢ VỀ BẢN HỎNG TRONG CACHE ⇒
                    # `onnx_nap_duoc()` báo "chưa sửa được" DÙ ĐÃ SỬA XONG ⇒ khách mất thêm một vòng.
                    # (Đo: lần 2 vẫn hỏng · pop `sys.modules` + `invalidate_caches()` rồi lần 3 mới thấy.)
                    # Mức hỏng "mất hẳn thư mục" thì import THẤT BẠI nên KHÔNG bị cache — chỉ cần
                    # `invalidate_caches()` để Python đọc lại danh sách thư mục. Làm cả hai cho đủ 2 ca.
                    try:
                        import importlib as _il
                        for _n in [x for x in list(sys.modules)
                                   if x == "onnxruntime" or x.startswith("onnxruntime.")]:
                            sys.modules.pop(_n, None)
                        _il.invalidate_caches()
                    except Exception:
                        pass
                    _lanh = onnx_nap_duoc(log_fn=None)     # kiểm LẠI THẬT, không tin mã thoát
                    if log_fn:
                        log_fn("✅ Đã sửa xong onnxruntime — chạy tiếp bình thường." if _lanh else
                               "⚠ Cài lại xong nhưng onnxruntime VẪN hỏng — đóng HẲN app rồi mở lại.")
                    return _lanh
                if log_fn:
                    log_fn("⚠ Chưa tự sửa được onnxruntime — ĐÓNG HẲN app (kể cả pythonw.exe nền) rồi mở lại.")
            except Exception as _e_sua:
                if log_fn:
                    log_fn("⚠ Không chạy được bước tự sửa (%s: %s)." % (type(_e_sua).__name__, str(_e_sua)[:90]))
        return False


def _im_rapidocr():
    """TẮT log INFO của RapidOCR — CHỐNG NUỐT MẤT LỖI THẬT (khách vicxuky 30/07).

    RapidOCR in INFO cho MỖI lần nạp model ("File exists and is valid...", "Using ...onnx", "engine_name:
    onnxruntime") — hàng chục dòng mỗi lần render. App bắt N dòng CUỐI của output làm "chi tiết kỹ thuật" khi
    render lỗi ⇒ đám INFO này ĐẨY TRACEBACK THẬT ra khỏi cửa sổ ⇒ phần chi tiết chỉ còn toàn dòng THÀNH CÔNG,
    không còn manh mối nào. Đo thật trên máy khách: cả khối "chi tiết kỹ thuật" 12 dòng đều là INFO của
    RapidOCR, KHÔNG có lấy 1 dòng lỗi. Tệ hơn: chuỗi "...\\models\\...onnx" trong đám INFO đó từng khớp từ
    khoá "model" của bộ dịch lỗi → app phán "lỗi tải mô hình giọng nói, kiểm tra mạng" trong khi máy khách
    HOÀN TOÀN KHOẺ (đã đo: 8/8 gói OK, nạp model OK, vào HuggingFace OK) → khách đi sửa mạng vô ích.
    Chỉ hạ mức log, KHÔNG đụng chức năng OCR. Muốn xem lại INFO để debug: OCR_LOG=1.

    ⚠ PHẢI GỌI **SAU** KHI KHỞI TẠO RapidOCR(): thư viện tự set level=INFO cho logger 'RapidOCR' LÚC KHỞI
    TẠO, lại dùng handler RIÊNG + propagate=False — gọi TRƯỚC thì bị nó ghi đè, VÔ TÁC DỤNG (đã đo: hạ trước
    vẫn ra 9 dòng INFO; hạ SAU còn 0). Vì handler riêng nên phải hạ level CẢ handler, không chỉ logger.
    """
    if os.environ.get("OCR_LOG", "") == "1":
        return
    try:
        import logging as _lg
        for _t in ("RapidOCR", "rapidocr", "rapidocr_onnxruntime"):
            _l = _lg.getLogger(_t)
            _l.setLevel(_lg.WARNING)
            for _h in _l.handlers:      # handler riêng, propagate=False → set logger KHÔNG đủ
                _h.setLevel(_lg.WARNING)
    except Exception:
        pass          # tắt log là việc PHỤ — hỏng thì thôi, không được cản OCR chạy


def co_rapidocr(log_fn=None):
    """RapidOCR có sẵn + onnxruntime nạp được? (chưa cài / DLL fail → caller lùi ASR). Nhận CẢ rapidocr(v6, 3.x)
    LẪN rapidocr_onnxruntime(v5, 1.4.x). onnxruntime DLL fail (thiếu VC++ Redist) → False (kẻo RapidOCR khởi
    tạo mới chết giữa render). log_fn (tuỳ chọn): log RÕ lý do fail (VC++ Redist thiếu) thay vì im lặng —
    caller trước đây không truyền → guard 'máy không GPU + hardsub → ép OCR' fail âm thầm, khách thấy Whisper
    chạy dù video có hardsub mà không hiểu tại sao (không log nào giải thích)."""
    if not onnx_nap_duoc(log_fn):    # onnxruntime DLL hỏng → RapidOCR sẽ chết lúc chạy → coi như không có
        return False
    _im_rapidocr()
    try:
        import rapidocr  # noqa: F401  (PP-OCRv6, bản mới)
        return True
    except Exception:
        pass
    try:
        import rapidocr_onnxruntime  # noqa: F401  (PP-OCRv4 mobile, gói cũ — KHÔNG phải v5)
        return True
    except Exception:
        return False


def _add_cuda_dlls():
    """Thêm MỌI nvidia/*/bin (pip) vào DLL search path. onnxruntime-gpu cần cuFFT/cuRAND/cuSPARSE...
    NGOÀI bộ cuBLAS/cuDNN của whisper (phu_de._add_cuda_dll_dirs chỉ thêm 4 gói cho whisper) → glob HẾT
    để không thiếu DLL phụ thuộc (vd cufft64_11.dll). Idempotent."""
    import sys
    import glob as _g
    if sys.platform != "win32":
        return
    try:
        import importlib.util
        spec = importlib.util.find_spec("nvidia")
        if not spec or not spec.submodule_search_locations:
            return
        # 🔴 BỎ `nvidia/cudnn/bin` khi torch đã mang cuDNN riêng (08/08/2026). Vòng lặp này quét
        # `nvidia/*/bin` nên vơ trúng CẢ cudnn — và OCR chạy TRƯỚC ASR, nên ĐÂY chính là nơi kéo bộ cuDNN
        # thứ hai vào tiến trình, làm `torch\lib\cudnn_cnn64_9.dll` của ASR bind nhầm bản khác ⇒ WinError 127
        # ⇒ MẤT PHỤ ĐỀ. Luật để ở `phu_de.bo_qua_cudnn_nvidia()` — MỘT chỗ cho cả 3 nơi thêm DLL dir.
        # OCR không thiệt gì: đo thật, `_ort_cuda_chay_that()` vẫn True khi chỉ có bộ cuDNN của torch.
        try:
            import phu_de as _pd
            _bo_cudnn = _pd.bo_qua_cudnn_nvidia()
        except Exception:
            _bo_cudnn = False
        for root in spec.submodule_search_locations:
            for b in _g.glob(os.path.join(root, "*", "bin")):
                if not os.path.isdir(b):
                    continue
                if _bo_cudnn and os.path.basename(os.path.dirname(b)).lower() == "cudnn":
                    continue
                try:
                    os.add_dll_directory(b)
                except Exception:
                    pass
                if b.lower() not in os.environ.get("PATH", "").lower():
                    os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")
        # 🔴 SỬA GỐC 10/08/2026 — BỎ bộ cuDNN nvidia mà KHÔNG THÊM BÙ bộ thay thế = OCR MẤT GPU IM LẶNG.
        # Vòng lặp trên bỏ `nvidia/cudnn/bin` (đúng — tránh trộn 2 bộ cuDNN → WinError 127 mất phụ đề), và
        # dựa vào giả định "torch mang cuDNN riêng nên vẫn đủ". Giả định đó chỉ đúng KHI tiến trình có
        # `import torch` (torch tự phơi `torch\lib`) — mà tiến trình render CỐ Ý KHÔNG import torch: nó làm
        # onnxruntime chậm 5.8× (xem `localize._wh_run`). ⇒ trong đúng tiến trình chạy OCR, `cudnn64_9.dll`
        # KHÔNG ai phơi ra ⇒ `onnxruntime_providers_cuda.dll` nạp hỏng (Error 126) ⇒ ORT lùi
        # CPUExecutionProvider **không ném lỗi**, chỉ log warning của rapidocr mà app không đọc.
        # ĐO THẬT (RTX 3050, det+rec 1 khung 1080p, cùng ảnh): CPU **1.15s** ↔ GPU **0.18s** = CHẬM 6.4×.
        # ⚠ `os.add_dll_directory` KHÔNG đủ — ĐO THẬT: thêm bằng add_dll_directory vẫn ra CPU, chỉ khi thư
        # mục nằm trên **PATH** thì ORT mới resolve được phụ thuộc bắc cầu (ORT là C++, dùng LoadLibrary →
        # tra PATH; cùng lý do đã ghi ở vòng lặp nvidia ngay trên). Nên phải làm CẢ HAI.
        # Dùng `find_spec` nên KHÔNG import torch ⇒ giữ nguyên tốc độ ORT. Cùng thư mục + cùng thứ tự
        # (chen lên đầu) với `phu_de._add_cuda_dll_dirs` ⇒ 2 nơi đồng bộ, không sinh trộn bộ mới.
        if _bo_cudnn:
            _ts = importlib.util.find_spec("torch")
            for _l in (_ts.submodule_search_locations if (_ts and _ts.submodule_search_locations) else []):
                _tl = os.path.join(_l, "lib")
                if not os.path.isdir(_tl):
                    continue
                try:
                    os.add_dll_directory(_tl)
                except Exception:
                    pass
                _con = [x for x in os.environ.get("PATH", "").split(os.pathsep)
                        if x.strip().lower().rstrip("\\") != _tl.lower().rstrip("\\")]
                os.environ["PATH"] = os.pathsep.join([_tl] + _con)
    except Exception:
        pass


_ENGINE_LOCK = __import__("threading").Lock()


_OCR_GPU_CACHE = [None]


def ocr_se_dung_gpu():
    """OCR có chạy được trên GPU không — chỉ DÒ, KHÔNG dựng engine, KHÔNG import torch.
    Gọi được sớm (trước khi OCR chạy) để bên ngoài quyết định có cần khoá VRAM hay không —
    xem localize._gate_ocr_gpu. Cache vì get_available_providers() phải nạp DLL CUDA (~1s lần đầu)."""
    if _OCR_GPU_CACHE[0] is None:
        _kq = False
        _dang_tin = True
        # 🔴 MẶC ĐỊNH = CPU (11/08/2026). Trước đây mặc định GPU (commit 97c8bcb, tên *"OCR âm thầm chạy CPU
        # dù máy có GPU — chậm 6.4×"*). ĐO LẠI trên chính máy dev (RTX 3050 4GB + i5-12500H 12 nhân), cùng
        # video, 10 lượt, đọc thẳng `ocr=` trong dòng PROFILE (cùng script, hàng đợi app rỗng):
        #     CPU .................... 24s · 23s   ← NHANH NHẤT (tổng chặng 54,4s · cpu77% gpu12%)
        #     GPU + vá `_letterbox_rec` 63s · 63s  (tổng 86,5s)
        #     GPU như commit 97c8bcb .. 162s        ← chậm hơn CPU **6,8×**
        # Chi tiết/lần: rec-only CPU 0,039s vs GPU 0,181s · det+rec CPU 0,699s vs GPU 1,301s.
        # CHỮ: 97/108 dòng giống hệt (89,8%). Khác biệt đi CẢ HAI CHIỀU, không bên nào thắng rõ — CPU gỡ
        # được watermark dính vào sub ('白姐扇风奶奶'→'奶奶') nhưng gộp mất 2 dòng thoại. Chọn CPU vì TỐC ĐỘ,
        # không phải vì chữ tốt hơn.
        # VÌ SAO: workload này là RẤT NHIỀU MẢNH TÍ HON (176 lời gọi, dải sub ~400×80px). ONNX Runtime vét
        # được cả 12 nhân CPU cho một ảnh nhỏ (đo: cpu 81%); GPU thì mỗi lần chỉ nhét một mảnh rồi đứng đợi
        # (đo: gpu 7-14% suốt chặng OCR — hơn 85% card nằm không). Không phải card yếu, là SAI VIỆC.
        # Thêm: OCR chạy CPU thì KHỎI tranh VRAM/GPU với Whisper-bù chạy song song ⇒ 2 việc, 2 phần cứng.
        # ⚠ CHỈ ĐO ĐƯỢC 1 MÁY. Máy khách CPU yếu + card to có thể ngược lại ⇒ để đường bật lại: OCR_DUNG_GPU=1.
        # Đừng đổi mặc định này nếu chưa có số trên >= 2 cấu hình khác nhau (bài học của chính commit 97c8bcb).
        if (os.environ.get("OCR_DUNG_GPU", "") == "1"
                and os.environ.get("OCR_NO_CUDA", "") != "1" and not _gpu_bi_chan_ocr()):
            try:
                _add_cuda_dlls()
                import onnxruntime as _ort
                _kq = "CUDAExecutionProvider" in _ort.get_available_providers()
            except Exception:
                # 🔴 (07/08/2026) MỘT lần nạp DLL CUDA vấp (RAM cao, AV quét file .dll, ổ bận) TRƯỚC ĐÂY bị
                # đóng băng thành False cho CẢ tiến trình (worker sống 30 job) ⇒ `localize._gate_ocr_gpu` trả
                # `nullcontext()` ⇒ **khoá VRAM liên-process bị vô hiệu IM LẶNG**, đúng lúc máy VRAM nhỏ cần
                # nó nhất (2 lane cùng nạp model GPU → crash cuDNN). Cùng họ `_NVENC`/`_DEV_NHE`.
                # Nay: ném lỗi = CHƯA kết luận → không cache, lần gọi sau dò lại.
                _kq = False
                _dang_tin = False
        if _dang_tin:
            _OCR_GPU_CACHE[0] = _kq
        else:
            return _kq          # dùng tạm cho lượt này, KHÔNG ghi nhớ
    return _OCR_GPU_CACHE[0]


def _gpu_bi_chan_ocr():
    """Chặn card đã XÁC NHẬN crash CUDA native (vd Quadro M1000M — xem phu_de._GPU_CHAN_TEN, ca khách 30/07:
    Faulting module nvcuda64.dll, 0xC0000005, cùng offset lặp lại 3 lần) — dùng CHUNG danh sách với Whisper
    vì cùng 1 driver CUDA của máy, card lỗi thì lỗi cho MỌI thứ gọi CUDA, không riêng Whisper."""
    try:
        import phu_de
        import subprocess as _sp3
        r = _sp3.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                     capture_output=True, text=True, timeout=8)
        return r.returncode == 0 and phu_de._gpu_bi_chan((r.stdout or "").strip())
    except Exception:
        return False


def _ep_that(rapid):
    """Provider THẬT SỰ của các session ONNX bên trong RapidOCR: True = CUDA hết · False = có session rơi
    về CPU · None = không dò được (bản rapidocr đổi cấu trúc → KHÔNG kết luận, giữ nguyên dự đoán cũ).

    Vì sao cần: `ocr_se_dung_gpu()` chỉ hỏi `get_available_providers()` = danh sách provider BIÊN DỊCH SẴN
    trong onnxruntime-gpu ⇒ LUÔN có CUDA, kể cả khi tạo session CUDA thất bại. Hai ca thất bại ĐO ĐƯỢC:
    thiếu `cudnn64_9.dll` (Error 126) và driver quá cũ (CUDA error 35 — máy khách GTX 1660 SUPER, driver
    457.51). Cả hai đều lùi CPU IM LẶNG, app vẫn khoe 'OCR chạy trên GPU' ⇒ chẩn từ xa đi sai hoàn toàn."""
    try:
        import onnxruntime as _ort
    except Exception:
        return None
    _seen, _eps = set(), []

    def _di(x, d=0):
        if id(x) in _seen or d > 6:
            return
        _seen.add(id(x))
        if isinstance(x, _ort.InferenceSession):
            _eps.append(x.get_providers())
            return
        for _n in dir(x):
            if _n.startswith("__"):
                continue
            try:
                _v = getattr(x, _n)
            except Exception:
                continue          # thuộc tính là property ném lỗi → bỏ qua, không được làm chết OCR
            if hasattr(_v, "__dict__") or isinstance(_v, _ort.InferenceSession):
                _di(_v, d + 1)

    try:
        _di(rapid)
    except Exception:
        return None
    if not _eps:
        return None
    return all("CUDAExecutionProvider" in _p for _p in _eps)


class _RapidV6:
    """Wrapper RapidOCR 3.x (PP-OCRv6 tiny/small/medium) → TRẢ ĐÚNG format rapidocr_onnxruntime 1.4.x để MỌI
    downstream (_doc/_doc_rec_sc + dai_sub_rapid) KHÔNG phải đổi. Mỗi call = per-call use_det/use_rec/use_cls:
      use_rec=False (det-only) → ([box,box,...], 0.0)          box = 4 điểm (dai_sub dò dải)
      use_det=False (rec-only) → ([(text,score),...], 0.0)
      det+rec (mặc định)       → ([(box,txt,score),...], 0.0)
    v6 rec nhanh ~10-18× v5-mobile trên CPU; đọc đúng cả sub nhỏ/mờ/nén (đã benchmark)."""

    def __init__(self, tier):
        from rapidocr import RapidOCR, OCRVersion, ModelType, EngineType
        mt = {"tiny": ModelType.TINY, "small": ModelType.SMALL, "medium": ModelType.MEDIUM}.get(tier, ModelType.TINY)
        params = {
            "Det.engine_type": EngineType.ONNXRUNTIME, "Det.ocr_version": OCRVersion.PPOCRV6, "Det.model_type": mt,
            "Rec.engine_type": EngineType.ONNXRUNTIME, "Rec.ocr_version": OCRVersion.PPOCRV6, "Rec.model_type": mt,
        }
        # OCR_THREADS: giới hạn luồng ORT/instance. 1 render đơn → -1 (tất cả core, nhanh nhất/video). Pool OCR song
        # song (ocr_bulk) đặt OCR_THREADS=2-4 → K instance × ít luồng ≈ tổng core, TRÁNH oversubscription (đo: limit
        # luồng → K=4 scale 2.6×; all-core → 0×). 0/rỗng = mặc định -1.
        try:
            _th = int(os.environ.get("OCR_THREADS", "") or 0)
        except ValueError:
            _th = 0
        # 🐛 MẶC ĐỊNH NỬA SỐ LUỒNG (khách báo "trước OCR đâu có 100%, chỉ mấy hôm gần đây bị" — ĐÚNG, và là
        # REGRESSION gián tiếp của tôi): dòng hạ `OCR_THREADS = ncpu//2` vốn nằm BÊN TRONG nhánh
        # `ASR_OCR_WHISPER_FILL`; LÚC ĐÓ tôi đổi cờ đó mặc định "1"→"0" nên nhánh không chạy nữa ⇒ OCR_THREADS
        # không được đặt ⇒ RapidOCR về -1 = DÙNG HẾT MỌI NHÂN ⇒ CPU 100%, máy khách đứng hình.
        # ⚠ ĐỌC KỸ — đoạn trên là LỊCH SỬ, không phải trạng thái hiện tại (đính chính 07/08/2026): cờ
        # `ASR_OCR_WHISPER_FILL` **nay mặc định lại "1"** (`localize.py`, tìm chuỗi `ASR_OCR_WHISPER_FILL`)
        # nhưng CÒN bị chặn thêm bởi điều kiện `_wh_co_gpu` — máy không có GPU Whisper dùng được thì
        # Whisper-bù KHÔNG chạy và KHÔNG in dòng nào, nên nhìn log không phân biệt được "đã bù" với "bỏ qua".
        # Chữ "hôm nay" ở câu trên từng làm chính tôi tưởng cờ đang tắt. Việc hạ OCR_THREADS nay đã nằm
        # NGOÀI nhánh đó (ngay dưới đây) nên không còn phụ thuộc cờ nữa.
        # ĐO THẬT (CPU, máy 16 luồng logic ~8 nhân vật lý, cùng 1 video): hết luồng 21.5s · 14 luồng 24.4s ·
        # **8 luồng (nửa) 20.5s ← NHANH NHẤT**. Trên GPU cũng vậy (đo trước đó: 8 luồng 19.1s vs mặc định ~21s).
        # Oversubscription kinh điển: nhồi hết luồng logic thì tranh băng thông bộ nhớ + siêu phân luồng, CHẬM
        # hơn. Nên giới hạn nửa nhân là ĐƯỢC CẢ ĐÔI: CPU giảm một nửa mà không mất tốc độ.
        # User tự set OCR_THREADS → tôn trọng, không đè. Muốn dùng hết nhân như vừa rồi: OCR_THREADS=-1.
        # ⚠ KHÔNG chia đôi mù trên MÁY YẾU — chia đôi chỉ đúng khi máy có SIÊU PHÂN LUỒNG (nhiều luồng logic
        # trên ít nhân vật lý). ĐO THẬT cùng 1 video (máy 16 luồng): 2 luồng 66.3s · 4 luồng 46.8s ·
        # **8 luồng 30.3s** · 16 luồng 43.9s. Đường cong hình chữ V: quá ít cũng chậm, quá nhiều cũng chậm.
        # Máy 4 nhân mà chia đôi còn 2 luồng ⇒ CHẬM 41% so với dùng cả 4 — hại đúng nhóm máy yếu cần nhất.
        # Luật: ≤4 nhân → dùng HẾT; nhiều hơn → nửa số luồng nhưng KHÔNG bao giờ dưới 4.
        if _th == 0:
            try:
                _nc = os.cpu_count() or 4
                _th = _nc if _nc <= 4 else max(4, _nc // 2)
            except Exception:
                _th = 4
        if _th > 0:
            params["EngineConfig.onnxruntime.intra_op_num_threads"] = _th
        # 🐛 BỎ PHÓNG TO THỪA trước khi dò hộp — nguồn lãng phí lớn nhất của pha OCR.
        # rapidocr mặc định `Det.limit_type=min` + `limit_side_len=736`: ảnh nào có CẠNH NGẮN < 736 thì PHÓNG
        # TO cho đủ 736. Ta OCR trên DẢI SUB đã cắt (điển hình cao ~450px) ⇒ bị kéo ×1.62 mỗi chiều = 2.6× số
        # điểm ảnh, mà chữ hardsub vốn đã to sẵn (cao 40-60px) nên phóng to KHÔNG giúp đọc tốt hơn.
        # Hạ ngưỡng xuống 320 = dải sub thường KHÔNG bị phóng nữa. Vẫn giữ limit_type='min' (chỉ phóng to,
        # KHÔNG BAO GIỜ thu nhỏ) nên video độ phân giải cao vẫn an toàn, khác với đổi sang 'max' (sẽ thu nhỏ).
        # ĐO THẬT 4 video (clip 45-60s, RTX 3050):
        #     t   17.6s→10.9s (1.61×)  cue 25=25 giống hệt
        #     rv1 23.5s→13.4s (1.75×)  cue 25=25 giống hệt
        #     rv2 22.5s→14.3s (1.57×)  cue 23=23, đọc CHUẨN HƠN: '1.快跑吧'→'快跑吧', '一貔体'→'貔貅'
        #     rv3 26.3s→17.1s (1.54×)  cue 33=33 giống hệt
        # (Đã thử GỘP LÔ nhiều khung vào 1 lần ort.run — TỆ HƠN HẲN: 72ms/ảnh → 89 (lô 2) → 120 (lô 4) →
        #  1397 (lô 8). Ảnh dò hộp vốn rất lớn nên GPU đã bão hoà, gộp lô chỉ gây tràn. ĐỪNG thử lại.)
        # Chỉnh/khôi phục cũ: OCR_DET_SIDE=736. Đặt 0 = để rapidocr tự quyết như mặc định.
        try:
            _side = int(os.environ.get("OCR_DET_SIDE", "") or 320)
        except ValueError:
            _side = 320
        if _side > 0:
            params["Det.limit_side_len"] = _side
        # GPU: rapidocr 3.x mặc định use_cuda=false → OCR chạy CPU (~510ms/frame) DÙ có onnxruntime-gpu. Bật CUDA khi
        # máy có CUDAExecutionProvider (laptop RTX) → GPU ~90ms/frame (~5-6× nhanh hơn). Cần onnxruntime-gpu + cudart
        # (nvidia-cuda-runtime-cu12) + cuDNN/cuBLAS; _add_cuda_dlls() đã nạp DLL. Thiếu gói → provider vắng → giữ CPU.
        # Tắt tay: OCR_NO_CUDA=1. Máy khách (onnxruntime CPU) không có provider → tự CPU, vô hại.
        _dung_gpu = ocr_se_dung_gpu()
        if _dung_gpu:
            params["EngineConfig.onnxruntime.use_cuda"] = True
            # NÚM DÒ THUẬT TOÁN cuDNN (11/08/2026) — `rapidocr/config.yaml` mặc định
            # `cudnn_conv_algo_search: "EXHAUSTIVE"`: với MỖI hình dạng đầu vào mới, cuDNN chạy thử hết
            # các thuật toán rồi bấm giờ chọn cái nhanh nhất. Lãi khi ảnh cùng cỡ chạy vạn lần; ở đây mỗi
            # khung dò ra số ô chữ khác nhau ⇒ hình dạng batch đổi liên tục ⇒ nghi là phải trả phí dò lại
            # nhiều lần. "HEURISTIC" = đoán bằng công thức, bỏ hẳn bước chạy thử.
            # ⚠ MẶC ĐỊNH KHÔNG ĐẶT — tức giữ nguyên hành vi cũ. Vì sao không bật sẵn: đo thử 20 khung ra
            # HEURISTIC 2,77 s/lần vs EXHAUSTIVE 1,24 s/lần, tức NGƯỢC với giả thuyết. Nhưng cả 2 lượt đo
            # đều dính nhiễu tải máy (thời gian nhảy bậc theo THỨ TỰ CHẠY chứ không theo khung) nên chưa
            # kết luận được chiều nào. Cắm núm để ĐO ĐƯỢC mà không phải sửa code; ai đo ra số sạch thì
            # đổi mặc định và ghi số vào đây.
            # Dùng: OCR_CUDNN_ALGO=HEURISTIC | DEFAULT | EXHAUSTIVE
            _algo = (os.environ.get("OCR_CUDNN_ALGO", "") or "").strip().upper()
            if _algo in ("HEURISTIC", "DEFAULT", "EXHAUSTIVE"):
                params["EngineConfig.onnxruntime.cuda_ep_cfg.cudnn_conv_algo_search"] = _algo
            # ⚡ NẤC 1 — TENSORRT (15/08/2026, env OCR_TRT=1, MẶC ĐỊNH TẮT). CHỈ đổi backend inference,
            # KHÔNG đụng temporal-filter / cache vân tay / _HybridDo / _khit_x / merge cue / decode.
            # ĐO Ở TẦNG DƯỚI (crop THẬT, shape 3x48x320, chạy một mình, warm-up, lấy min):
            #     rec small  batch8 : CPU 7,18 → CUDA 1,76 → **TRT FP16 0,868** ms/ROI  (8,3× so CPU)
            #     det small  gộp10  : CPU 26,58 → CUDA 1,773 → **TRT FP16 0,945** ms/dải (28× so CPU)
            # CỬA CHẶN ĐỘ CHÍNH XÁC (64 crop thật, so ARGMAX với CPU): CUDA 0/2560 lệch · TRT FP16
            #     **1/2560 = 0,04%** (1/64 crop) · TRT FP32 0/2560. Lệch logit lớn nhất của FP16 (0,0949)
            #     còn NHỎ HƠN của CUDA (0,1358) ⇒ cảnh báo `layernorm overflow` KHÔNG thành hiện thực
            #     (TensorRT tự ép Reduce/Pow về FP32). ⚠ Nhưng FP16 **KHÔNG bit-exact** — mới "vượt cửa
            #     chặn trên bộ test hiện tại", PHẢI verify lại chữ trên video thật khi tích hợp.
            #     Cần tuyệt đối không lệch: OCR_TRT_FP16=0 (FP32, argmax khớp 100%, chậm hơn FP16).
            # ⚠ GIÁ: build engine ~155s (rec) + ~420s (det) **MỘT LẦN cho MỘT MÁY** (không phải mỗi video,
            #     không phải mỗi shape — engine dynamic-shape, batch 5 chạy ngay trên engine của batch 8);
            #     +~12s mỗi lần mở app; engine khoá theo kiến trúc GPU (tên file có `sm86`) nên KHÔNG đóng
            #     gói sẵn được, máy khách phải tự build lần đầu. Vì thế là TUỲ CHỌN, không phải mặc định.
            # ⚠ CHƯA ĐO: đường THẬT có TRT. Mọi con số tổng chặng OCR hiện chỉ là GIẢ THUYẾT ghép từ
            #     tầng rời — đừng trích dẫn như benchmark cho tới khi chạy video thật.
            # 🔴🔴 TRẠNG THÁI 15/08/2026: **KHỐI NÀY CHƯA ĂN — ĐỪNG TIN LOG CỦA NÓ.**
            # Kiểm thật với OCR_TRT=1: `type(sess.text_rec.session).__name__` vẫn ra **`OrtInferSession`**,
            # tức rapidocr vẫn chạy onnxruntime. Log "⚡ OCR thử TensorRT" VẪN IN ⇒ **log đang nói dối**.
            # ĐÃ LOẠI TRỪ được (đừng mất công tìm lại):
            #   · cổng GPU KHÔNG phải nguyên nhân — `ocr_se_dung_gpu()` trả True, block CÓ chạy
            #   · `engine_type` PHẢI là Enum `EngineType.TENSORRT`, truyền chuỗi "tensorrt" thì
            #     `parse_parameters.py:59` ném TypeError — ĐÃ SỬA, vẫn chưa ăn
            #   · thư viện native đã có: `tensorrt_libs` (nvinfer_10.dll) + bindings đã cài
            #   · ORT thấy đủ provider: TensorrtExecutionProvider/CUDA/CPU
            # ✅ ĐÃ CHỨNG MINH BỘ THAM SỐ NÀY ĐÚNG — thử TÁCH RIÊNG (không qua `_engine()`):
            #     RapidOCR(params={'Det.engine_type':EngineType.TENSORRT, 'Rec.engine_type':...,
            #                      'EngineConfig.tensorrt.use_fp16':True, '...cache_dir':...})
            #   → rapidocr in `Using engine_name: tensorrt` (base.py:23) ⇒ params TỚI NƠI.
            #   → rồi chết: `ModuleNotFoundError: No module named 'cuda'` — phiên TRT của rapidocr cần
            #     **cuda-python bindings**, KHÔNG chỉ `tensorrt_libs`.
            #   → đã cài `cuda-python==12.6.0` (BẢN 13.x KHÔNG DÙNG ĐƯỢC: từ v13 API dời `cuda.cudart`
            #     → `cuda.bindings.runtime`, mà rapidocr gọi kiểu cũ `from cuda import cudart`).
            #     Sau khi cài: `from cuda import cudart` OK, và stack cũ vẫn nguyên (torch cuda=True, ct2 gpu=1).
            # ❌ NHƯNG QUA `_engine()` THÌ VẪN RA `OrtInferSession`, dựng engine chỉ 2s (TRT phải build vài
            #   phút) ⇒ **khối này KHÔNG được thực thi**, dù `ocr_se_dung_gpu()` trả True khi kiểm riêng và
            #   chỉ có DUY NHẤT một chỗ `RapidOCR(params=params)` (dòng ~535, chính là đây).
            # ⇒ VIỆC CÒN LẠI: đặt breakpoint/print ngay đầu khối `if os.environ.get("OCR_TRT"...)` để xem nó
            #   có vào không, và `_dung_gpu` lúc CHẠY THẬT bằng bao nhiêu. Đừng suy — in ra.
            # ⇒ GIỮ MẶC ĐỊNH TẮT. Ai làm tiếp: verify bằng `type(sess.text_rec.session).__name__` phải ra
            # `TRTInferSession`. **ĐỪNG tin dòng log** — nó in vô điều kiện.
            # ⚡ CHỈ BẬT TRT CHO `small` (15/08/2026 — chủ dự án chốt). Pipeline dùng 4 model ⇒ 4 engine:
            #     _engine_dinh_vi() → det_tiny + rec_tiny   (Pha 1 chỉ 30 khung · pha dò CÓ THỂ bị bỏ hẳn)
            #     _engine()         → det_small + rec_small (pha đọc — nơi thật sự tốn)
            # ĐO THẬT: nạp 4 engine tốn **12,5s** mỗi lần khởi động tiến trình (không phải build — build đã
            # xong một lần cho một máy). Hai engine `tiny` gần như không đáng: Pha 1 quét đúng 30 khung, còn
            # pha dò thì trên video khách (dải sub hiện ≥85% khung) bị cổng `_bo_do` BỎ HẲN ⇒ `det_tiny` nạp
            # xong nằm không. ⇒ Bỏ tiny khỏi TRT: cắt >½ của 12,5s + bớt ~23 MB VRAM, mà mất gần như 0 tốc độ.
            # Muốn bật cho MỌI tier (để đo lại): OCR_TRT_MOI_TIER=1.
            _trt_tier_ok = (str(tier).lower() == "small") or os.environ.get("OCR_TRT_MOI_TIER") == "1"
            if os.environ.get("OCR_TRT", "0") == "1" and _trt_tier_ok:
                try:
                    import tensorrt_libs as _trtlib
                    _dtrt = os.path.dirname(_trtlib.__file__)
                    os.add_dll_directory(_dtrt)
                    os.environ["PATH"] = _dtrt + os.pathsep + os.environ.get("PATH", "")
                except Exception as _e_trt:
                    print("LOG:⚠ OCR_TRT=1 nhưng KHÔNG nạp được thư viện TensorRT (%s) → giữ CUDA/CPU."
                          % str(_e_trt)[:70], flush=True)
                else:
                    _kho = os.environ.get("OCR_TRT_CACHE", "") or os.path.join(
                        os.path.expanduser("~"), ".viralcrawl_trt")
                    try:
                        os.makedirs(_kho, exist_ok=True)
                    except OSError:
                        pass
                    # ⚠ rapidocr KHÔNG đi qua provider TensorRT của onnxruntime — nó có ENGINE RIÊNG
                    # (`EngineType.TENSORRT` → `TRTInferSession`, xem `rapidocr/inference_engine/base.py:57`)
                    # với nhánh cấu hình `tensorrt:` riêng trong `config.yaml:99`. Viết theo kiểu
                    # `EngineConfig.onnxruntime.use_tensorrt` là SAI KHOÁ ⇒ rapidocr **nuốt im lặng**, chạy
                    # CPU/CUDA mà vẫn báo đã bật TRT. Đã suýt mắc đúng lỗi đó — phải đọc config.yaml mới biết.
                    # ⚠ `engine_type` PHẢI là Enum, KHÔNG phải chuỗi — `parse_parameters.py:59` ném
                    # TypeError("must be Enum Type") nếu truyền "tensorrt". Đây là chỗ đã làm bản trước
                    # của tôi im lặng không ăn.
                    from rapidocr.utils.typings import EngineType as _ET
                    params["Det.engine_type"] = _ET.TENSORRT
                    params["Rec.engine_type"] = _ET.TENSORRT
                    params["EngineConfig.tensorrt.use_fp16"] = (os.environ.get("OCR_TRT_FP16", "1") != "0")
                    params["EngineConfig.tensorrt.cache_dir"] = _kho
                    # ⚠ DÙNG `print`, KHÔNG dùng `log` — module này KHÔNG có hàm `log` (trong `ocr_dong`
                    # thì `log` là THAM SỐ hàm). Bản trước gọi `log(...)` ⇒ NameError ⇒ bị `try/except`
                    # ngoài NUỐT ⇒ lùi im lặng về onnxruntime mà không một dòng báo. Mất nửa buổi vì chỗ này.
                    print("LOG:⚡ OCR thử TensorRT (FP16=%s, cache %s) — LẦN ĐẦU phải BUILD engine, vài phút."
                          % (os.environ.get("OCR_TRT_FP16", "1") != "0", _kho), flush=True)
        self._e = RapidOCR(params=params)
        # LOG RÕ OCR đang chạy GPU hay CPU — trước đây KHÔNG có log nào, khách/dev không biết máy có GPU
        # nhưng OCR vẫn lùi CPU (thiếu onnxruntime-gpu/CUDA DLL) hay không, gây khó chẩn đoán ca "2 lane
        # tranh CPU" (video 1 encode CPU-nặng + video 2 OCR CPU-nặng cộng dồn, dù máy có GPU rảnh).
        # 🔴 10/08/2026 — LOG SAU KHI DỰNG ENGINE, và hỏi SESSION THẬT (`_ep_that`) chứ không tin `_dung_gpu`
        # (chỉ là DỰ ĐOÁN từ get_available_providers). Trước đây in TRƯỚC khi dựng engine nên về nguyên tắc
        # không thể biết session rơi về CPU hay không ⇒ khoe GPU trong khi đang chạy CPU (ca thật: khách báo
        # render lâu, log nói GPU, Task Manager GPU 9% / CPU 60%).
        _that = _ep_that(self._e)
        _vi_sao = "onnxruntime-gpu + CUDA sẵn sàng"
        if _dung_gpu and _that is False:
            _dung_gpu = False
            _vi_sao = ("tạo session CUDA THẤT BẠI nên onnxruntime đã lùi CPU — thường do driver NVIDIA quá "
                       "cũ (cần >= 527.41) hoặc thiếu DLL cuDNN. Chạy KIEM-GPU.bat để biết chính xác")
            _OCR_GPU_CACHE[0] = False   # sửa luôn DỰ ĐOÁN: _gate_ocr_gpu khỏi khoá VRAM cho việc chạy CPU
        elif not _dung_gpu and os.environ.get("OCR_DUNG_GPU", "") != "1":
            # PHÂN BIỆT "chọn CPU" với "không chạy được GPU" — trước đây gộp làm một nên log báo thiếu
            # driver trong khi CUDA vẫn sẵn sàng, ta chỉ đang chọn CPU cố ý (đúng lớp lỗi log-nói-dối mà
            # chính hàm này đã vá 10/08 ở chiều ngược lại).
            # ⚠ ĐỪNG "sửa" về GPU vì thấy memory/commit cũ ghi "OCR GPU nhanh 4×". Số đó đo TRƯỚC commit f337488
            # (27/07) — hồi đó ảnh dò-hộp còn bị phóng lên 2.6× điểm ảnh (454x1920 → 736x3104) nên GPU bão hoà và
            # thắng. Từ khi có OCR_DET_SIDE=320, ảnh nhỏ đi 2.6× ⇒ mỗi lời gọi tính quá ít, chi phí đẩy ảnh qua
            # PCIe + khởi chạy kernel nuốt sạch phần lợi. Đo lại 13/08 CẢ ĐƯỜNG ocr_dong (clip 600s hardsub,
            # 3050 4GB): CPU 247.1s vs GPU 707.8s — GPU CHẬM 2.86×, cùng 279 cue, text giống 96% (trung vị 1.00).
            _vi_sao = ("MẶC ĐỊNH — đo cả đường ocr_dong (clip 600s, 3050 4GB): CPU 247s vs GPU 708s, "
                       "GPU CHẬM 2.86× (text ra y hệt). Muốn thử GPU: OCR_DUNG_GPU=1")
        elif not _dung_gpu:
            _vi_sao = "không thấy CUDAExecutionProvider — thiếu onnxruntime-gpu hoặc driver/DLL CUDA"
        try:
            print("LOG:👁 OCR chạy trên %s (%s)" % ("GPU" if _dung_gpu else "CPU", _vi_sao), flush=True)
        except Exception:
            pass
        _im_rapidocr()      # PHAI sau khoi tao (xem docstring)

    def __call__(self, img, use_det=True, use_rec=True, use_cls=False):
        r = self._e(img, use_det=use_det, use_rec=use_rec, use_cls=use_cls)
        boxes = getattr(r, "boxes", None)
        if not use_rec:                                    # DET-ONLY → chỉ box (v5 use_rec=False)
            return (list(boxes) if boxes is not None else []), 0.0
        txts = list(getattr(r, "txts", None) or [])
        scores = list(getattr(r, "scores", None) or [])
        if not use_det:                                    # REC-ONLY → [(text, score)]
            return [(t, float(s)) for t, s in zip(txts, scores)], 0.0
        bx = list(boxes) if boxes is not None else [None] * len(txts)   # DET+REC → [(box, txt, score)]
        return [(b, t, float(s)) for b, t, s in zip(bx, txts, scores)], 0.0


def _engine():
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE
    # LOCK: warm-on-start (luồng nền) có thể song song job đầu → tránh tạo RapidOCR 2 lần.
    with _ENGINE_LOCK:
        if _ENGINE is not None:
            return _ENGINE
        # OCR_MODEL: 'v6-small'(MẶC ĐỊNH — điểm ngọt)|'v6-tiny'(nhanh nhưng SÓT/rác)|'v6-medium'(chuẩn nhất, chậm 2×)|'v5-mobile'.
        # Benchmark THẬT (user, video hardsub Trung khó): small ĐỌC ĐỦ + chính xác ≈ medium (14s) NHƯNG nhanh ≈ tiny
        # (13s) — tiny dò yếu SÓT ~1/3 câu + rác (厉/E/5EE), medium chuẩn nhất nhưng ~2× (29s). → small là default.
        # v6 (rapidocr 3.x) lỗi/thiếu gói → tự LÙI PP-OCRv4 mobile (rapidocr_onnxruntime; nhãn env 'v5-mobile'
        # là gọi theo thói quen — MODEL THẬT đi kèm gói cũ là ch_PP-OCRv4_det/rec) → KHÔNG bao giờ chết OCR.
        _model = (os.environ.get("OCR_MODEL", "v6-small") or "v6-small").strip().lower()
        if _model.startswith("v6"):
            try:
                _tier = _model.split("-", 1)[1] if "-" in _model else "small"
                _ENGINE = _RapidV6(_tier)
                return _ENGINE
            except Exception as _e:
                try:
                    print("LOG:⚠ PP-OCRv6 không dùng được (%s) → lùi PP-OCRv4 mobile." % str(_e)[:70], flush=True)
                except Exception:
                    pass
        _add_cuda_dlls()   # nạp HẾT DLL CUDA (pip nvidia-*) cho onnxruntime-gpu thấy (cuFFT/cuRAND/cuSPARSE...)
        from rapidocr_onnxruntime import RapidOCR
        cuda = False
        try:
            import onnxruntime as ort
            cuda = "CUDAExecutionProvider" in ort.get_available_providers()   # cần onnxruntime-gpu (laptop)
        except Exception:
            pass
        if cuda:
            try:
                _ENGINE = RapidOCR(det_use_cuda=True, rec_use_cuda=True, cls_use_cuda=True)   # GPU → ~5-10× CPU
            except Exception:
                _ENGINE = RapidOCR()
        else:
            _ENGINE = RapidOCR()   # CPU (model PP-OCR ONNX đi kèm)
        _im_rapidocr()      # PHAI sau khoi tao (xem docstring)
    return _ENGINE


_ENGINE_DV = None
def _engine_dinh_vi():
    """Engine ĐỊNH VỊ (pha 1 che-động: quét thưa toàn màn tìm DẢI-Y sub) — dùng PP-OCRv6 TINY (benchmark thật:
    tiny nhanh ~24% small trên hardsub rõ, ĐỌC ĐỦ để định vị dải; text lem/sót của tiny KHÔNG sao vì pha 1 chỉ
    cần VỊ TRÍ Y, không cần text chính xác — pha 2 dùng engine small mặc định đọc text). Tách engine riêng (cache
    riêng) để không đổi engine chính. Tiny lỗi/tắt (OCR_DINHVI=0 hoặc OCR_MODEL không phải v6) → lùi _engine()."""
    global _ENGINE_DV
    if os.environ.get("OCR_DINHVI", "1") == "0":
        return _engine()
    if _ENGINE_DV is not None:
        return _ENGINE_DV
    with _ENGINE_LOCK:
        if _ENGINE_DV is not None:
            return _ENGINE_DV
        try:
            _ENGINE_DV = _RapidV6("tiny")
            return _ENGINE_DV
        except Exception:
            return _engine()   # tiny lỗi → dùng engine chính (an toàn, không mất tính năng)


def _tien_xu_ly(img):
    """Tiền xử lý ảnh TRƯỚC khi đưa vào OCR: CLAHE · nhị phân thích ứng · phóng to. MẶC ĐỊNH TẮT.

    VÌ SAO CÓ: đối thủ (SonAuto) có sẵn `Cân bằng sáng + Nhị phân thích ứng (CLAHE + Adaptive)`,
    `Sharpen`, `Upscale ×2` làm tuỳ chọn trong UI; ta KHÔNG có tầng tiền xử lý nào (grep `clahe|
    adaptiveThreshold`: 0 kết quả). Đây là kiểu hỏng ta chưa từng nhắm tới — không phải chữ NHỎ
    (đã đo và loại: phóng to là thừa sau khi gộp dải) mà chữ **TƯƠNG PHẢN THẤP**: chữ trắng trên
    nền sáng, viền nhoè, nền chuyển màu.

    🔴 ĐÃ A/B TRÊN VIDEO THẬT (22/08/2026) — KẾT LUẬN: **ĐỂ TẮT CẢ BA**.
    Chân lý = `.zh.srt` sẵn có, 50 khung lấy giữa mỗi cue của video Minion (1024×576, 184 cue):
        GỐC 99,0%  ·  CLAHE 99,2%  ·  NHỊ PHÂN 97,4%  ·  CLAHE+NHỊ PHÂN 95,3%  ·  UPSCALE×2 98,5%
    Rồi bôi bẩn chính những khung đó đúng 3 kiểu hỏng mà CLAHE nhắm tới (30 khung), chênh so với GỐC:
        kiểu hỏng          CLAHE   NHỊ PHÂN   C+N     UPSCALE×2
        không bôi bẩn      +0,0     −0,9    −2,2      −1,7
        tương phản THẤP    −0,1     −1,8    −0,9      −0,2
        viền NHÒE         +0,9     −5,3   −15,8      −0,0
        nền CHUYỂN MÀU    +0,2     +0,4    −8,3      −0,5
        THẤP + NHÒE       +0,0     −1,8    −2,3      +0,0

    • `OCR_NHIPHAN` — **HẠI THẬT, không phải lo suông.** Âm ở 4/5 điều kiện; trên video sạch nó
      làm **MẤT HẲN 1 cue** (khung #3 “而这一幕” → đọc ra RỖNG) và nuốt đuôi câu (“…谁倒霉” →
      “…谁”). Đúng lớp “thà chậm còn hơn mất cue” — cấm bật mặc định.
    • `OCR_NHIPHAN` đi cùng CLAHE thì **thảm họa**: −15,8 điểm trên ảnh nhòe.
    • `OCR_UPSCALE` — **KHÔNG LỢI ĐIỂM NÀO** ở mọi điều kiện, lại còn **bịa thêm chữ**: sinh ra
      “100”, “417”, “y外08 58” đứng trước câu — phóng to làm nhiễu nền vượt ngưỡng thành “chữ”.
      ⚠ **SỐ CHI PHÍ CŨ Ở ĐÂY (“1,35ms / 0,2%”) LÀ SAI** — nó chỉ đo **riêng lệnh resize**, bỏ qua
      việc chính lời gọi OCR đắt lên theo diện tích ảnh. Đo lại trọn vẹn 50 khung: **15,3s → 37,5s,
      CHẬM 2,45×**. Bài học: đo phần mình thêm vào mà không đo phần nó làm đắt lên = số vô nghĩa.
    • `OCR_CLAHE` — duy nhất **không bao giờ hại** (xấu nhất −0,1; tốt nhất +0,9 trên ảnh nhòe),
      chỉ tốn +2,6% thời gian. Nhưng +0,2 điểm trên video sạch **nằm trong nhiễu** ⇒ vẫn để TẮT
      mặc định. Đây là công tắc cứu hộ cho video thật sự nhòe, không phải mặc định.
    ⚠ MÔ HÌNH BỀN HƠN TƯỞNG: bôi bẩn đến mức bét dải động (hệ số 0,30) + nhòe sigma 1,6 mà bản
      GỐC vẫn giữ 97,9–98,2%. Muốn bàn tiếp về tiền xử lý thì phải có **video khách đang đọc sai
      thật**, đừng bôi bẩn thêm — đã thử và không tái hiện được vùng gãy.

    Bật: OCR_CLAHE=1 (nhẹ nhất, giữ thang xám) · OCR_NHIPHAN=1 · OCR_UPSCALE=2 (hệ số).
    Chỉnh: OCR_CLAHE_CLIP (2.0) · OCR_CLAHE_TILE (8) · OCR_NHIPHAN_BLOCK (31) · OCR_NHIPHAN_C (5).
    """
    _cl = os.environ.get("OCR_CLAHE", "0") == "1"
    _np2 = os.environ.get("OCR_NHIPHAN", "0") == "1"
    try:
        _up = float(os.environ.get("OCR_UPSCALE", "") or 0)
    except ValueError:
        _up = 0.0
    if not (_cl or _np2 or _up > 1.0):
        return img                      # không bật gì → trả NGUYÊN ảnh, zero chi phí
    try:
        import cv2
        import numpy as _npy
        out = img
        if _cl or _np2:
            g = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY) if out.ndim == 3 else out
            if _cl:
                try:
                    _clip = float(os.environ.get("OCR_CLAHE_CLIP", "") or 2.0)
                    _tile = int(os.environ.get("OCR_CLAHE_TILE", "") or 8)
                except ValueError:
                    _clip, _tile = 2.0, 8
                g = cv2.createCLAHE(clipLimit=_clip, tileGridSize=(_tile, _tile)).apply(g)
            if _np2:
                try:
                    _blk = int(os.environ.get("OCR_NHIPHAN_BLOCK", "") or 31)
                    _c = int(os.environ.get("OCR_NHIPHAN_C", "") or 5)
                except ValueError:
                    _blk, _c = 31, 5
                if _blk % 2 == 0:
                    _blk += 1           # OpenCV đòi blockSize LẺ, chẵn là ném lỗi
                g = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                          cv2.THRESH_BINARY, max(3, _blk), _c)
            # trả về 3 kênh: engine nhận BGR ở mọi chỗ gọi khác, đổi shape ở đây là đổi ngầm hợp đồng
            out = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
        if _up > 1.0:
            out = cv2.resize(out, None, fx=_up, fy=_up, interpolation=cv2.INTER_CUBIC)
        return out
    except Exception:
        return img                      # lỗi bất kỳ → ảnh GỐC, không bao giờ làm chết OCR


def _doc(img, eng):
    """OCR 1 ảnh BGR (numpy) → text gộp các dòng (gom theo HÀNG ~ y, trong hàng trái→phải)."""
    img = _tien_xu_ly(img)
    try:
        res, _ = eng(img, use_cls=False)   # sub không xoay → tắt direction classifier cho nhanh
    except TypeError:
        try:
            res, _ = eng(img)
        except Exception:
            return ""
    except Exception:
        return ""
    if not res:
        return ""
    its = []
    for box, txt, score in res:
        if not txt or (score is not None and score < _score_min()):
            continue
        ys = sum(p[1] for p in box) / 4.0
        xs = sum(p[0] for p in box) / 4.0
        its.append((round(ys / 14.0), xs, txt.strip()))   # gom hàng (~14px) rồi trái→phải
    its.sort()
    return " ".join(t for _, _, t in its if t).strip()


def _khoang_cach(a, b):
    """Khoảng cách sửa (Levenshtein) thuần Python — CJK chuỗi ngắn nên rẻ. Số ký tự cần thêm/xoá/đổi."""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if not la:
        return lb
    if not lb:
        return la
    prev = list(range(lb + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[lb]


def _giong(a, b):
    """CÙNG câu? Trùng tuyệt đối → True. Khác → coi cùng câu nếu CHỈ sai 1-2 ký tự (lỗi OCR lác đác: 我们/我门)
    TRÊN câu đủ dài (≥4 ký tự) → tránh tách câu mới giả. Câu NGẮN (<4) phải trùng tuyệt đối (không gộp nhầm
    上山/下山). Câu khác nghĩa = nhiều ký tự sai → KHÔNG gộp (ratio difflib SAI cho CJK, đo thật). Tắt: env OCR_FUZZY_MERGE=0."""
    if a == b:
        return True
    if not a or not b or os.environ.get("OCR_FUZZY_MERGE", "1") == "0":
        return False
    na, nb = _norm_cmp(a), _norm_cmp(b)        # so trên bản CHUẨN-HOÁ: bỏ dấu câu/phồn-giản → 1 khác biệt nhỏ = cùng câu
    if na and na == nb:
        return True
    m = min(len(na), len(nb))
    if m < 4:
        return False
    return _khoang_cach(na, nb) <= max(1, m // 8)


def _iv_merge(a, b):
    """CÙNG ĐOẠN cand (= cùng subtitle theo dò vị-trí) → gộp re-read kể cả lệch NHIỀU chữ (OCR drift nặng:
    周浦齐/用满齐). LOOSER hơn _giong vì cùng đoạn = gần chắc chắn cùng 1 câu. An toàn: sub KHÁC trong đoạn thô
    (nội dung khác hẳn) → không norm-equal/prefix/ratio≥0.72 → KHÔNG gộp → giữ nguyên (không mất sub)."""
    na, nb = _norm_cmp(a), _norm_cmp(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    s, l = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(s) >= 2 and (l.startswith(s) or l.endswith(s)):     # build dần: 谁在用 ⊂ 谁在用琵琶 (1 bản là tiền/hậu tố bản kia)
        return True
    if len(s) <= 5 and len(l) >= 2 * len(s) and s[:2] == l[:2]:  # mảnh fade-in misread (成为个 vs 成为一个…): chung 2 đầu + ngắn hẳn
        return True
    import difflib
    return difflib.SequenceMatcher(None, na, nb).ratio() >= 0.72


def _doc_det_rec(img, eng):
    """det+rec trên dải: engine tự khoanh từng DÒNG chữ rồi đọc → khỏi cần Pha 2 cắt hộp khít sẵn.
    Gộp các dòng theo thứ tự trên→dưới, trái→phải. Trả "" nếu không thấy chữ."""
    img = _tien_xu_ly(img)
    try:
        res, _ = eng(img, use_cls=False)
    except TypeError:
        _r = eng(img)
        res = _r[0] if isinstance(_r, tuple) else _r
    except Exception:
        return "", None
    if not res:
        return "", None
    try:
        _W = float(img.shape[1])
    except Exception:
        _W = 0.0
    items = []
    for it in res:
        if not it or len(it) < 2:
            continue
        try:
            ys = [float(pt[1]) for pt in it[0]]; xs = [float(pt[0]) for pt in it[0]]
            items.append((min(ys), min(xs), max(xs), str(it[1] or ""), max(ys)))
        except Exception:
            continue
    if not items:
        return "", None
    # LOẠI WATERMARK/LOGO nằm ở MÉP: phụ đề luôn CĂN GIỮA nên hộp của nó phải cắt qua vùng giữa dải;
    # watermark kênh nằm sát mép trái/phải thì không. ĐO THẬT (video khách): không lọc thì 28/631 cue bị
    # ghép rác kiểu '@木元林彩刷 再看那道身影已经不见了'. Chỉ lọc khi CÒN hộp nào cắt giữa (không thì giữ hết,
    # tránh làm mất câu ở video phụ đề căn trái).
    if _W > 0:
        _lo, _hi = _W * 0.40, _W * 0.60
        _giua = [z for z in items if z[1] <= _hi and z[2] >= _lo]
        if _giua:
            items = _giua
    items.sort(key=lambda z: (round(z[0] / 12.0), z[1]))     # gom theo hàng (12px) rồi trái→phải
    _txt = " ".join(z[3] for z in items if z[3]).strip()
    # TRẢ KÈM HỘP BAO các dòng đã nhận (toạ độ PIXEL trong crop). Dải che TĨNH ở localize fit theo min/max
    # hộp cue (`_ux0`/`_uy0`), nên có hộp det thì dải vẫn bám sát chữ thật DÙ ĐÃ BỎ PHA DÒ — pha dò trước
    # đây tồn tại CHỈ để cấp hộp khít này.
    # 🐛 CHỈ tính trên DÒNG ĐƯỢC DÙNG LÀM CHỮ, không phải mọi kết quả det. Trước lấy cả `res` nên hộp trùm
    # luôn dòng watermark tuy text của nó đã bị loại ⇒ hộp cue cao lên tới hàng watermark ⇒ dải che (localize
    # lấy min/max hộp) bị kéo cao. ĐO THẬT clip3p: hộp trung vị y 0.893-0.973 nhưng min/max ra y 0.849-1.000,
    # trong khi mực chữ thật chỉ y 0.910-0.956.
    _hop = None
    try:
        # CHỈ nhận hộp HỢP LÝ: một DÒNG chữ không thể cao gần bằng cả dải crop. det thỉnh thoảng trả hộp
        # trùm (dính nhiễu/viền/vệt nền); chỉ MỘT hộp như vậy là dải che hỏng vì localize lấy min/max.
        # ĐO THẬT clip3p: hộp bình thường cao ~50% crop, hộp hỏng ('好的') cao 90% ⇒ chặn ở 70%.
        # Không lọc `items` (sẽ mất CHỮ nếu mọi dòng đều phi lý) — chỉ không nhận HỘP, để caller lùi hộp đoạn.
        _hc = float(img.shape[0]) if img is not None else 0.0
        _cd = [z for z in items if z[3] and (_hc <= 0 or (z[4] - z[0]) <= _hc * 0.70)]
        if _cd:
            _hop = (min(z[0] for z in _cd), max(z[4] for z in _cd),
                    min(z[1] for z in _cd), max(z[2] for z in _cd))
    except Exception:
        _hop = None
    return _txt, _hop


def _doc_rec(img, eng):
    """REC-ONLY (use_det=False): dải ĐÃ là 1 dòng sub → BỎ Detection. Đo thật: det+rec ~2.1s vs rec-only
    ~0.74s/call (~3× nhanh) + ĐÚNG HƠN (det hay crop lệch vài pixel → rec đoán nhầm; rec-only đọc nguyên dòng)."""
    return _doc_rec_sc(img, eng)[0]


_TY_REC = 320.0 / 48.0        # tỉ lệ rộng/cao mà rec mong đợi (`rapidocr/config.yaml: rec_img_shape [3,48,320]`)


def _letterbox_rec(img):
    """Đệm TRẮNG cho ảnh về ĐÚNG tỉ lệ 320:48 mà rec mong đợi — KHÔNG co giãn chữ (giữ nguyên nét).

    🔴 VÌ SAO (11/08/2026, sau khi đo từng session ONNX): recognizer co ảnh về CAO 48px, bề rộng lấy THEO
    TỈ LỆ ảnh vào ⇒ câu dài ngắn khác nhau ra bề rộng khác nhau. ĐO THẬT trên 1 video: `text_rec` chạy
    **201 lần với 66 SHAPE khác nhau** (1x3x48x320 ×110, x556, x458…). ONNX Runtime CUDA phải lập lại kế
    hoạch cho mỗi shape mới ⇒ **139,6s / 156s = 89% toàn chặng OCR** rơi vào đúng session này.
    Đệm về đúng tỉ lệ ⇒ rec luôn ra 48x320 ⇒ shape lặp lại ⇒ dùng lại kế hoạch cũ.

    ĐO THẬT (40 crop thật, cùng máy, GPU):
        như cũ     : 0,365 s/lần · 32 loại shape
        letterbox  : **0,010 s/lần** · 8 loại shape   → nhanh **36×**
        chữ đọc ra : cùng 28/40 câu có chữ · **37/40 câu giống hệt**
    Ước cả chặng: rec 139,6s → ~2s.

    ⚠ CHỈ áp khi chạy GPU. CPU không có chi phí lập-kế-hoạch-theo-shape, đệm thêm pixel chỉ làm nó CHẬM đi
    (đo: 0,017 → 0,027 s/lần). Tắt: OCR_GHIM_SHAPE=0."""
    import numpy as _np
    _ty = _TY_REC
    h, w = img.shape[:2]
    if h < 4 or w < 4:
        return img
    _can = int(round(h * _ty))
    if w >= _can:                                   # ảnh DÀI hơn tỉ lệ → đệm THÊM CHIỀU CAO
        _nh = int(round(w / _ty))
        if _nh <= h:
            return img
        out = _np.full((_nh, w) + img.shape[2:], 255, img.dtype); out[:h] = img
        return out
    out = _np.full((h, _can) + img.shape[2:], 255, img.dtype); out[:, :w] = img
    return out


def _doc_rec_sc(img, eng):
    """Như _doc_rec nhưng TRẢ THÊM score (min các dòng) → cho fallback theo độ tin cậy (mask-clean vs raw)."""
    if _ghim_shape():
        try:
            img = _letterbox_rec(img)
        except Exception:
            pass                  # đệm hỏng → dùng ảnh gốc, chỉ chậm chứ không sai
    try:
        res, _ = eng(img, use_det=False, use_cls=False)
    except TypeError:
        try:
            res, _ = eng(img, use_det=False)
        except Exception:
            return "", 0.0
    except Exception:
        return "", 0.0
    if not res:
        return "", 0.0
    out, scs = [], []
    for item in res:                          # use_det=False → item = (text, score)
        txt = item[0] if item else ""
        score = item[1] if len(item) > 1 else 1.0
        if txt and (score is None or score >= _score_min()):
            out.append(str(txt).strip())
            scs.append(float(score) if score is not None else 1.0)
    # lọc rác OCR rìa: bỏ '#' (rec ra # cho ký tự mờ → 1 dòng thành 4 biến thể không merge) + nhiễu mép —…·
    text = " ".join(t for t in out if t).strip().replace("#", "").strip("—…·.•~ ")
    text = _loc_rac_ocr(text)          # + bỏ latin/số LẺ kề chữ Hán ('...运动K'→'...运动') / dòng nhiễu 'E','5EE'
    return text, (min(scs) if scs else 0.0)


def _ocr_clean(band, mk, eng, np, cv2):
    """OCR trên dải ĐÃ LÀM-SẠCH-NỀN nhưng GIỮ XÁM (anti-alias) — không nhị-phân-thuần (recognizer đọc kém).
    Dilate mask chữ (3×3) để phủ cả viền + cạnh anti-alias → whiten NỀN XA, giữ nguyên nét chữ. Trả (text, score)."""
    try:
        dm = cv2.dilate(mk.astype(np.uint8), np.ones((3, 3), np.uint8))
        gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
        gray[dm == 0] = 255                                       # bỏ nền (lửa/nước/tóc/texture) → nền trắng sạch
        tb = _trim_band(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), np, cv2)
        return _doc_rec_sc(tb, eng)
    except Exception:
        return "", 0.0


def _ghim_shape():
    """Có đang cần đệm ảnh về tỉ lệ cố định trước rec không (= đang chạy GPU)? Xem `_letterbox_rec`.

    ⚠ ĐƯỜNG ĐI TỚI BẢN VÁ NÀY — ghi lại để đừng ai lặp: tôi đã vá SAI HAI LẦN trước khi đúng.
      · Lần 1: bỏ xén ở `_trim_band` (ghim bề rộng DẢI). Đo lẻ nhanh 51×, chạy thật **199s vs 197s** = 0.
      · Lần 2: đưa cả dòng thay hộp khít ở nhánh hybrid. Cũng 0.
      Cả hai sai vì ghim NHẦM TẦNG: thứ quyết định shape của ONNX không phải bề rộng ảnh ta đưa vào, mà là
      bề rộng SAU KHI rec tự co về cao 48px — tức TỈ LỆ rộng/cao. Chỉ khi đo THẲNG từng session ONNX
      (`text_rec` 201 lần / 66 shape / 139,6s = 89% chặng) mới thấy đúng chỗ.
      Bài học: đo một MẢNH rồi suy cho cả cỗ máy là sai; phải đo tại chính lớp đang chậm."""
    try:
        return os.environ.get("OCR_GHIM_SHAPE", "1") != "0" and bool(ocr_se_dung_gpu())
    except Exception:
        return False             # không biết chắc → cứ xén như cũ (hành vi an toàn, giống trước bản vá)


def _trim_band(band, np, cv2):
    """Cắt mép TRẮNG trái/phải trước rec (sub thật ~700-900px nhưng dải ~1920px) → rec xử lý ảnh HẸP hơn →
    nhanh thêm ~20-40%. Dò cột CÓ chữ (trắng+nét); hẹp bất thường / nền sáng không rõ → giữ NGUYÊN dải (an toàn).

    ⚠️ HÀM NÀY XÉN VÔ ĐIỀU KIỆN — không có nhánh nào theo GPU/CPU. Đọc tiếp trước khi kết luận.

    🔴 SỬA CHÚ THÍCH SAI (12/08/2026). Bản trước ghi *"KHÔNG XÉN KHI CHẠY GPU"* và *"Tắt bản vá:
    OCR_GHIM_SHAPE=0"* — **cả hai đều KHÔNG có trong code**: thân hàm luôn `return band[:, x0:x1]`, còn
    `OCR_GHIM_SHAPE` chỉ gác `_letterbox_rec` bên trong `_doc_rec_sc`, không liên quan hàm này. Chú thích
    đó tả bản vá "lần 1" ĐÃ BỊ GỠ (đo ra 199s vs 197s = 0) nhưng chữ thì ở lại. Hậu quả thật: 11/08 tôi
    trích đúng dòng đó để kết luận "trim bật ở CPU, tắt ở GPU" và **báo sai cho chủ dự án** — đúng cái bẫy
    CLAUDE.md §4 dặn ("ĐỌC COMMENT TRƯỚC KHI KẾT LUẬN"), chỉ khác là lần này chính comment mới là thứ dối.
    Ai định thêm nhánh theo thiết bị vào đây: xén CÓ lãi cho CPU (số đo dưới) và OCR nay MẶC ĐỊNH chạy CPU
    (xem `ocr_se_dung_gpu`), nên nhánh đó gần như không bao giờ chạy — cân nhắc trước khi bỏ công.

    ĐO THẬT, 30 crop, rec-only, cùng máy:
        GPU · shape thay đổi (như cũ) : 0,363 s/lần
        GPU · shape CỐ ĐỊNH          : **0,012 s/lần**  ← nhanh hơn 30×, và nhanh hơn cả CPU
        CPU · shape thay đổi (như cũ) : 0,017 s/lần      ← xén ĐÚNG là lãi cho CPU (đúng như comment trên)
        CPU · shape cố định           : 0,027 s/lần
    ⇒ Xén là LÃI cho CPU (0,017 vs 0,027) — và CPU nay là mặc định, nên giữ nguyên xén vô điều kiện.
    Con số "GPU · shape cố định 0,012" ở trên là phép đo LẺ ngoài pipeline; chạy cả chặng thì không tái
    hiện được (xem `_ghim_shape` và mục ghim-shape trong SESSIONS.md 11-12/08)."""
    try:
        g = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
        mask = (g > 190) & (np.abs(cv2.Laplacian(g, cv2.CV_32F, ksize=3)) > 40)
        cols = np.where(mask.sum(axis=0) > max(1.0, band.shape[0] * 0.04))[0]
        if len(cols) < 5:
            return band
        x0 = max(0, int(cols.min()) - 10); x1 = min(band.shape[1], int(cols.max()) + 10)
        if x1 <= x0 or (x1 - x0) < band.shape[1] * 0.25:
            return band
        return band[:, x0:x1]
    except Exception:
        return band


_VUNG_TAY_CACHE = [None]        # [(y0,y1,x0,x1,t0,t1)] đã parse — parse 1 lần, dùng cho MỌI khung


def _vung_tay_doc():
    """Đọc+parse `OCR_LOAI_VUNG` MỘT LẦN (cache). Trả [(y0,y1,x0,x1,t0,t1)] tỉ lệ khung, giây.
    Cùng nguồn dữ liệu với `_loai_vung_tay` (lọc SAU) — ở đây dùng để tô phẳng TRƯỚC."""
    if _VUNG_TAY_CACHE[0] is not None:
        return _VUNG_TAY_CACHE[0]
    _ra = []
    _raw = (os.environ.get("OCR_LOAI_VUNG", "") or "").strip()
    if _raw:
        try:
            import json as _js
            for _v in (_js.loads(_raw) or []):
                try:
                    _y0 = max(0.0, min(1.0, float(_v.get("y0", 0))))
                    _y1 = max(0.0, min(1.0, float(_v.get("y1", 0))))
                    _x0 = max(0.0, min(1.0, float(_v.get("x0", 0))))
                    _x1 = max(0.0, min(1.0, float(_v.get("x1", 0))))
                    _t0 = float(_v.get("t0", 0) or 0)
                    _t1 = float(_v.get("t1", 0) or 0)
                except (TypeError, ValueError):
                    continue
                if _y1 > _y0 and _x1 > _x0:
                    _ra.append((_y0, _y1, _x0, _x1, _t0, _t1))
        except Exception:
            _ra = []          # JSON hỏng → `_loai_vung_tay` (lọc SAU) đã có log cảnh báo, không log lặp ở đây
    _VUNG_TAY_CACHE[0] = _ra
    return _ra


def _to_phang_vung_tay(fr, t, np, cv2):
    """TÔ PHẲNG vùng KHÁCH TỰ KHOANH ngay trên khung, TRƯỚC khi OCR nhìn.

    VÌ SAO tô-TRƯỚC thay vì chỉ lọc-SAU (`_loai_vung_tay`): lọc sau vẫn phải TRẢ TIỀN OCR cho vùng đó, và
    tệ hơn — khi watermark DÍNH LIỀN câu thoại (`雕虫小技！即梦`) thì luật 3 phải GỠ chuỗi ra khỏi text, một
    phép so chuỗi có thể cắt nhầm. Tô trước thì OCR đọc thẳng `雕虫小技！`, không có gì để gỡ.
    GIỮ NGUYÊN `_loai_vung_tay` chạy sau — hai lớp bù nhau, tô trước hụt vài pixel thì lớp sau vẫn bắt.
    Tô bằng MÀU TRUNG VỊ của chính vùng đó (không phải đen): mép phẳng, không tạo biên tương phản mạnh mà
    bộ dò hộp lại tưởng là chữ.
    `fr` bị sửa TẠI CHỖ. Trả số vùng đã tô (0 = không có gì để làm). Tắt: OCR_VUNG_TAY_PREMASK=0."""
    if os.environ.get("OCR_VUNG_TAY_PREMASK", "1") == "0":
        return 0
    _vg = _vung_tay_doc()
    if not _vg:
        return 0
    H, W = fr.shape[:2]
    _n = 0
    for _y0, _y1, _x0, _x1, _t0, _t1 in _vg:
        if t is not None:
            if t < _t0:
                continue
            if _t1 > 0 and t > _t1:      # t1<=0 = tới hết video (cùng quy ước với _loai_vung_tay)
                continue
        _a, _b = int(_y0 * H), int(_y1 * H)
        _c, _d = int(_x0 * W), int(_x1 * W)
        _a, _b = max(0, _a), min(H, _b)
        _c, _d = max(0, _c), min(W, _d)
        if _b - _a < 2 or _d - _c < 2:
            continue
        _o = fr[_a:_b, _c:_d]
        try:
            _mau = np.median(_o.reshape(-1, _o.shape[-1]), axis=0) if _o.ndim == 3 else np.median(_o)
        except Exception:
            _mau = 0
        _o[:] = _mau
        _n += 1
    return _n


def _khit_x(sub, np, cv2):
    """Dò khoảng CỘT có chữ trong ảnh `sub` → (x0, x1) pixel, hoặc None nếu không thấy chữ.
    Khác `_trim_band` ở 2 điểm: (1) TRẢ TOẠ ĐỘ (caller vừa crop khít vừa dùng làm hộp CHE, không phải
    đoán lại), (2) KHÔNG có luật "hẹp quá thì bỏ cuộc" — luật đó sinh ra để an toàn khi crop là CẢ DẢI
    nhiều dòng, nhưng ở đường hybrid ta ĐÃ khoá đúng 1 dòng theo Y nên hẹp là BÌNH THƯỜNG (câu 3-4 chữ).
    None = tín hiệu BẤT THƯỜNG (dải trống/chữ quá mờ) → caller lùi det+rec."""
    try:
        g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
        mask = (g > 190) & (np.abs(cv2.Laplacian(g, cv2.CV_32F, ksize=3)) > 40)
        cols = np.where(mask.sum(axis=0) > max(1.0, sub.shape[0] * 0.04))[0]
        if len(cols) < 5:
            return None
        x0 = max(0, int(cols.min()) - 10); x1 = min(sub.shape[1], int(cols.max()) + 10)
        return (x0, x1) if x1 > x0 else None
    except Exception:
        return None


def _loc_dai_sub_that(cand, log=print):
    """Giữ dải trông như PHỤ ĐỀ THẬT, bỏ watermark / logo / chữ tĩnh (disclaimer, tên kênh).

    Ý tưởng (chủ dự án chốt): 1 video thường chỉ có 1 hardsub. Dấu hiệu nhận ra nó KHÔNG cần đọc nội dung —
    chỉ nhìn HÌNH DẠNG THỐNG KÊ của track:
      • đổi nội dung liên tục → NHIỀU cue rời rạc  (watermark chỉ ra 1 cue kéo dài cả video)
      • giữ nguyên vị trí     → gom theo dải Y đã đảm bảo
      • ĐỘ DÀI CÂU THAY ĐỔI  → bề ngang BIẾN THIÊN mạnh (watermark luôn cùng độ dài ⇒ biến ≈ 0)
    Rẻ: dùng đúng dữ liệu đã có (bề ngang + số cue), KHÔNG tốn thêm lần OCR nào — khác `_loc_track_phu`
    (đọc lại text để xác nhận, tốn OCR và từng dính bug "OCR hỏng = đọc rỗng → bỏ oan cả track").

    ĐO THẬT 4 video Douyin: sub thật có 11–16 cue, biến bề ngang 0.262–0.420; watermark 1 cue, biến 0.000
    → ngưỡng 0.05 có biên an toàn 5×.

    LỢI ÍCH KÉP: bỏ được dải watermark thì thường chỉ còn 1 dải ⇒ không còn dải chồng thời gian ⇒ KHÔNG phải
    chia làn ⇒ OCR về lại 1 lượt giải mã (thay vì 2-3 lượt).

    AN TOÀN (fail-open): chỉ lọc khi CÓ ÍT NHẤT 1 dải đạt chuẩn VÀ việc lọc không xoá sạch. Không đủ bằng
    chứng (video ngắn, ít câu) → GIỮ NGUYÊN hết. Tắt hẳn: OCR_LOC_SUB=0.
    """
    if os.environ.get("OCR_LOC_SUB", "1") == "0" or not cand or len(cand) < 2:
        return cand
    try:
        _min_cue = int(os.environ.get("OCR_SUB_MIN_CUE", "") or 3)
    except ValueError:
        _min_cue = 3
    try:
        _min_bien = float(os.environ.get("OCR_SUB_W_BIEN", "") or 0.05)
    except ValueError:
        _min_bien = 0.05
    try:
        nhom = {}
        for s in cand:
            if len(s) < 6:
                return cand                      # thiếu toạ độ x → không đủ dữ liệu, giữ nguyên
            nhom.setdefault(round(((s[2] + s[3]) / 2.0) / 0.05), []).append(s)
        if len(nhom) < 2:
            return cand                          # chỉ 1 dải → không có gì để lọc
        # LỆCH MÉP = watermark. Phụ đề CĂN GIỮA nên hộp của nó luôn cắt qua trục giữa khung; watermark/logo
        # kênh nằm nép một bên. ĐO THẬT (video khách): watermark `@木元森影剧` ở x 14-33% — không chạm 50%,
        # trong khi mọi câu phụ đề đều bắc qua. Đây là dấu hiệu tách ĐÚNG cho ca watermark nằm NGAY TRÊN hàng
        # phụ đề: cắt theo chiều DỌC không tách được (y watermark 84.0-90.6% chồng dải sub 88.3-98.2%).
        # ⚠ Vì sao tiêu chí "bề ngang không đổi" sẵn có KHÔNG bắt được nó: watermark bán trong suốt nên OCR
        # đọc ra bề rộng lệch mỗi lần ⇒ biến thiên vẫn lớn ⇒ lọt qua.
        # AN TOÀN: chỉ áp khi CÓ dải cắt-giữa (video phụ đề căn trái/phải thì mọi dải đều lệch → giữ nguyên hết).
        # ⚠ MẶC ĐỊNH TẮT — luật này SAI với cả một THỂ LOẠI. Ảnh thật 003.mp4 lúc 36s: video dạng KHUNG CHAT,
        # bong bóng tin nhắn cố ý nằm lệch trái/phải (trắng bên trái `汐汐姐！！什么情况？！`, xanh bên phải
        # `我不知道啊`), KHÔNG bao giờ căn giữa ⇒ bật luật này là xoá sạch một nửa hội thoại. Phim ngắn Trung
        # reup dùng dạng chat rất nhiều. Thay bằng lọc theo NỘI DUNG LẶP ở cuối `ocr_dong` (xem `_loc_wm_lap`).
        # Bật lại (chỉ cho video chắc chắn phụ đề căn giữa): OCR_SUB_LECH_MEP=1.
        _giua_on = os.environ.get("OCR_SUB_LECH_MEP", "0") == "1"
        _co_giua = any(min(float(a[5]) for a in v) <= 0.5 <= max(float(a[4]) for a in v) or
                       any(float(a[4]) <= 0.5 <= float(a[5]) for a in v) for v in nhom.values())
        _giu, _bo = [], []
        for _k, v in nhom.items():
            ws = [float(a[5]) - float(a[4]) for a in v]
            bien = (max(ws) - min(ws)) if len(ws) > 1 else 0.0
            _dat = (len(v) >= _min_cue and bien > _min_bien)
            # đòi ĐỦ NHIỀU cue mới coi là watermark: logo bám suốt video nên cụm của nó dày; còn câu thoại
            # lệch mép lẻ tẻ (sub di chuyển) chỉ có 1-2 cue → giữ lại. ĐO THẬT: video khách cụm watermark 8
            # cue → bỏ đúng; 003.mp4 câu '我不知遵明' (x 64-83%, sub di chuyển) chỉ 1 cue → trước bị giết oan.
            # ⚠ ĐÃ THỬ thêm điều kiện "logo đứng yên theo chiều ngang (tâm-x ít biến)" và BỎ — hai ca KHÔNG
            # tách được: đo thật tâm-x biến của cụm watermark = 0.107 vs cụm sub-di-chuyển = 0.148. Đặt ngưỡng
            # vào khe đó là over-fit (đúng vết xe ngưỡng 1.24-vs-1.38 đã trượt trước đó). Giữ luật ĐƠN GIẢN.
            _lech = (_giua_on and _co_giua and len(v) >= _min_cue
                     and not any(float(a[4]) <= 0.5 <= float(a[5]) for a in v))
            (_bo if (_lech or not _dat) else _giu).append((_k, v, len(v), bien, _lech))
        if not _giu or not _bo:
            return cand                          # không dải nào đạt / không dải nào bị loại → giữ nguyên
        for _k, v, n, bien, _lech in _bo:
            yc = sum((a[2] + a[3]) / 2.0 for a in v) / len(v)
            if _lech:
                _x0 = min(float(a[4]) for a in v); _x1 = max(float(a[5]) for a in v)
                log("🧹 Bỏ dải y~%.2f (%d cue, x %.0f%%-%.0f%% KHÔNG chạm giữa khung) — chữ nép mép "
                    "(watermark/logo), phụ đề luôn căn giữa." % (yc, n, _x0 * 100, _x1 * 100))
            else:
                log("🧹 Bỏ dải y~%.2f (%d cue, bề ngang biến %.3f) — chữ TĨNH (watermark/logo), không phải phụ đề."
                    % (yc, n, bien))
        return [s for _k, v, _n, _b, _l in _giu for s in v]
    except Exception:
        return cand                              # lỗi bất kỳ → giữ nguyên, không bao giờ làm hỏng dò dải


# Tên NỀN TẢNG hay in trong watermark. Chỉ dùng để nhận ra cue TOÀN LÀ watermark — KHÔNG dùng để
# cắt chuỗi khỏi câu thoại (việc đó là của `_go_chu_nen_tang`, có ngưỡng tần suất riêng).
_NEN_TANG_WM = (
    "bilibili", "哔哩哔哩", "b站", "抖音", "douyin", "快手", "kuaishou", "小红书", "xiaohongshu",
    "rednote", "微博", "weibo", "tiktok", "西瓜视频", "好看视频", "腾讯视频", "爱奇艺", "优酷",
    "youtube", "facebook", "instagram", "皮皮虾", "火山",
)
# `抖音号：123`, `快手号 abc`, `ID: xyz`, `微信号：…` — khuôn ĐỊNH DANH, không phải lời thoại.
_ID_NEN_TANG = _re.compile(
    r"(?:抖音|快手|微博|小红书|微信|视频|作者)?\s*(?:号|ID|Id|id)\s*[:：]?\s*[\w.\-@]{2,}")
# Tay cầm kênh: `@术先森影剧`, `@user_name`. Tối thiểu 2 ký tự sau @ để khỏi ăn nhầm `@` lẻ do OCR nhiễu.
_TAY_KENH = _re.compile(r"@\s*[\w\u4e00-\u9fffA-Za-z0-9._\-]{2,}")
# Ký tự trang trí OCR hay nhả quanh watermark (khung, chấm, gạch, biểu tượng).
_TRANG_TRI = _re.compile(r"[\s\|/\\\-–—_.·•∙,，、:：;；!！?？'\"“”‘’()（）\[\]【】<>《》*#~^`+=]+")


def _la_ten_kenh(t):
    """Cue này có phải CHỈ LÀ tên kênh / tên nền tảng (watermark) không? Trả True = nên BỎ CẢ CUE.

    🔴 VÌ SAO CẦN, DÙ ĐÃ CÓ HAI TẦNG WATERMARK KHÁC (22/08/2026):
      · `_loc_wm_lap` (tự dò cụm lặp theo Y) — **mặc định TẮT từ 13/08**, vì nó là tầng TOÀN CỤC duy nhất
        và chặn kiến trúc chạy song song (cue bắn ra phút 2 có thể bị xoá ở phút 40). Chú thích tại đó đã
        ghi sẵn CÁI MẤT: *"khách KHÔNG khoanh vùng thì watermark lặp sẽ lọt vào phụ đề (ca đã gặp
        `@术先森影剧` lặp 8 cue)"*. Đây chính là lỗ hổng đó.
      · `_go_chu_nen_tang` — bắt theo TẦN SUẤT ≥20% số cue. Watermark bán trong suốt chỉ đọc được LÁC ĐÁC:
        8 cue trên video 1516 cue = **0,5%**, thấp hơn ngưỡng 40 lần ⇒ lọt sạch.
    ⇒ Hàm này bắt theo HÌNH DẠNG, không theo tần suất, nên chỉ cần MỘT cue cũng bắt được, và vì xét TỪNG
      CUE nên KHÔNG cần trạng thái toàn cục ⇒ **không chặn kiến trúc song song** (đúng lý do tầng kia bị tắt).

    🔴 CỐ Ý HẸP — chỉ bỏ khi cue **KHÔNG CÒN GÌ** ngoài tay-cầm/tên-nền-tảng/khuôn-ID.
    KHÔNG cắt `@tên` ra khỏi câu có thoại thật, vì video khung CHAT có `@tên` là NỘI DUNG thật
    (`_loc_wm_lap` đã ghi: bật lọc hình học lên là "xoá nửa hội thoại" ở ảnh 003.mp4 t=36s).
    Ca watermark DÍNH trong câu thoại vẫn là việc của `_go_chu_nen_tang`.
    Tắt: OCR_GO_TEN_KENH=0."""
    s = (t or "").strip()
    if not s:
        return False
    con = _ID_NEN_TANG.sub("", s)
    con = _TAY_KENH.sub("", con)
    _th = con.lower()
    for _p in _NEN_TANG_WM:
        _th = _th.replace(_p, "")
    con = _TRANG_TRI.sub("", _th)
    if con == _TRANG_TRI.sub("", s.lower()):
        return False              # không gỡ được gì ⇒ đây là câu thoại bình thường
    # Còn sót ≤1 ký tự có nghĩa ⇒ coi như cue chỉ có watermark. Ngưỡng 1 (không phải 0) vì OCR hay
    # nhả thêm một ký tự nhiễu dính vào watermark (`@术先森影剧` đọc thành `@术先森影剧口`).
    return len(con) <= 1


def _go_ten_kenh(segs, boxes, log=print):
    """Bỏ các cue CHỈ chứa tên kênh / tên nền tảng. Trả (segs, boxes) đã lọc. Xem `_la_ten_kenh`."""
    if os.environ.get("OCR_GO_TEN_KENH", "1") == "0" or not segs or len(segs) != len(boxes):
        return segs, boxes
    try:
        _giu_s, _giu_b, _bo = [], [], []
        for s, b in zip(segs, boxes):
            if _la_ten_kenh(str(s[2])):
                _bo.append(str(s[2]).strip())
            else:
                _giu_s.append(s); _giu_b.append(b)
        if not _bo:
            return segs, boxes
        # KHÔNG bao giờ bỏ quá nửa số cue — nếu tới mức đó thì luật đang hiểu sai video này (vd phụ đề
        # thật toàn dạng `@ai đó`), thà giữ nguyên còn hơn xoá trắng phụ đề.
        if len(_bo) * 2 >= len(segs):
            log("⚠ Luật 'cue toàn tên kênh' khớp %d/%d cue — QUÁ NỬA nên BỎ QUA luật này (nghi hiểu sai "
                "video). Giữ nguyên toàn bộ phụ đề." % (len(_bo), len(segs)))
            return segs, boxes
        _vd = " · ".join(dict.fromkeys(_bo))[:70]
        log("🏷 Bỏ %d cue chỉ chứa TÊN KÊNH/NỀN TẢNG (watermark OCR đọc phải, không phải lời thoại): %s"
            % (len(_bo), _vd))
        return _giu_s, _giu_b
    except Exception:
        return segs, boxes            # lỗi bất kỳ → giữ nguyên, không bao giờ làm mất phụ đề


def _go_dau_duoi_lap(segs, boxes, log=print):
    """GỠ đoạn ĐẦU hoặc CUỐI giống nhau lặp ở PHẦN LỚN cue — ca "2 dòng Trung, 1 dòng là cảnh báo".

    🔴 LỖ HỔNG ĐƯỢC VÁ (22/08/2026, chủ dự án nêu: *"chữ trung 2 dòng nhưng sub thật chỉ 1, chữ còn
    lại là cảnh báo"*). `_go_chu_nen_tang` ngay dưới CHỈ học chuỗi watermark từ những cue mà nó ĐỨNG
    MỘT MÌNH (chú thích tại đó ghi rõ, và đó là chủ ý — bản đầu quét MỌI chuỗi con thì gỡ nhầm cả
    khuôn chữ trong THOẠI). Nhưng khi OCR gộp 2 dòng vào MỘT hộp thì dòng cảnh báo KHÔNG BAO GIỜ
    đứng riêng ⇒ không có ứng viên ⇒ lọt sạch.
    ĐO THẬT (120 cue giả lập, chạy đúng chuỗi 3 tầng hiện có):
        cảnh báo là cue RIÊNG ở Y khác     → SẠCH   (tầng `_go_chu_nen_tang` lo được)
        cảnh báo DÍNH vào mọi cue (100%)   → **SÓT 120/120**   ← chỗ này
        cảnh báo DÍNH ở 8/120 cue (6,7%)   → SÓT 8

    DẤU HIỆU DÙNG — hẹp có chủ ý: thứ tự dòng trên/dưới trong khung là CỐ ĐỊNH, nên khi OCR gộp,
    dòng cảnh báo luôn rơi về CÙNG MỘT PHÍA của chuỗi ⇒ nó là TIỀN TỐ hoặc HẬU TỐ chung.
    KHÔNG quét chuỗi con giữa câu — đó đúng là thứ đã gỡ nhầm thoại ở bản đầu của `_go_chu_nen_tang`.

    HAI CHẶN chống gỡ nhầm:
      · dài ≥ `OCR_DD_LMIN` (6 ký tự) — nhãn người nói kiểu `小明：` chỉ 3 ký tự nên KHÔNG dính;
      · có mặt ở ≥ `OCR_DD_TY` (50%) số cue — cao hơn hẳn ngưỡng 20% của tầng dưới, vì tiền/hậu tố
        là dấu hiệu YẾU hơn "đứng một mình";
      · và phần CÒN LẠI của cue phải ≥2 ký tự, nếu không thì đây là cue chỉ-có-cảnh-báo, để tầng
        `_go_chu_nen_tang`/`_loc_wm_lap` xử theo luật của chúng.
    Tắt: OCR_GO_DAU_DUOI=0."""
    import re
    if os.environ.get("OCR_GO_DAU_DUOI", "1") == "0" or not segs or len(segs) != len(boxes):
        return segs, boxes
    try:
        _ty = float(os.environ.get("OCR_DD_TY", "") or 0.50)
        _lmin = int(os.environ.get("OCR_DD_LMIN", "") or 6)
    except ValueError:
        _ty, _lmin = 0.50, 6
    try:
        _t = [" ".join(str(s[2]).split()) for s in segs]
        _co = [x for x in _t if len(x) >= _lmin + 2]
        if len(_co) < 8:
            return segs, boxes
        _nguong = max(4, int(len(_co) * _ty))

        def _chung(lay):
            """Chuỗi dài nhất mà ≥_nguong cue cùng có ở vị trí đó. `lay(s, k)` cắt k ký tự."""
            _tot = ""
            for _k in range(_lmin, 41):
                from collections import Counter
                _c = Counter(lay(x, _k) for x in _co if len(x) >= _k + 2)
                if not _c:
                    break
                _s, _n = _c.most_common(1)[0]
                if _n >= _nguong and _s.strip():
                    _tot = _s
                else:
                    break
            return _tot

        _dau = _chung(lambda s, k: s[:k])
        _duoi = _chung(lambda s, k: s[-k:])
        # chọn phía dài hơn; hoà thì ưu tiên ĐUÔI (dòng cảnh báo hay nằm DƯỚI sub)
        _mau, _la_dau = ((_dau, True) if len(_dau) > len(_duoi) else (_duoi, False))
        if len(_mau) < _lmin:
            return segs, boxes
        _ds, _n = [list(x) for x in segs], 0
        for i in range(len(_ds)):
            _x = " ".join(str(_ds[i][2]).split())
            if not _x:
                continue
            if _la_dau and _x.startswith(_mau):
                _con = _x[len(_mau):].strip()
            elif (not _la_dau) and _x.endswith(_mau):
                _con = _x[:len(_x) - len(_mau)].strip()
            else:
                continue
            if len(re.sub(r"\s", "", _con)) < 2:
                continue                     # cue chỉ có cảnh báo → để tầng khác xử
            _ds[i][2] = _con
            _n += 1
        if not _n:
            return segs, boxes
        log("\U0001f9fd Gỡ dòng lặp ở %s mọi cue (%d cue) — nghi CẢNH BÁO/banner bị OCR gộp chung "
            "với phụ đề: %r" % ("ĐẦU" if _la_dau else "CUỐI", _n, _mau[:40]))
        return [tuple(x) for x in _ds], boxes
    except Exception:
        return segs, boxes          # lỗi bất kỳ → giữ nguyên, không bao giờ làm mất phụ đề


def _go_chu_nen_tang(segs, boxes, log=print):
    """GỠ chuỗi WATERMARK/TÊN NỀN-TẢNG ra khỏi NỘI DUNG cue (bilibili, 紫轩漫屋, @tên_kênh…).

    KHÁC `_loc_wm_lap` ngay bên dưới — hàm đó bỏ **CẢ CUE** theo cụm-Y và **cố ý không đụng cụm đông nhất**
    (dải phụ đề). Nên nó chịu thua đúng ca khách kienpvtsr1 (07/08/2026): OCR đọc watermark DÍNH CHUNG vào
    cue thoại (`紫轩漫屋bilibi啊`) — bỏ cả cue thì mất luôn chữ thoại, giữ thì chữ Trung đi thẳng vào bản dịch.

    HẬU QUẢ THẬT nếu không gỡ (đo từ log khách, video 1516 câu):
      · watermark còn trong text ⇒ Gemini trả về vẫn còn chữ Hán ⇒ `_con_sot` ở `localize.py` gắn cờ SÓT
        ⇒ **dịch lại tới 3 vòng, mỗi vòng ~15 phút, cho câu vốn đã dịch xong** ⇒ khách thấy "kẹt 61%".
      · lọt xuống video thì phạm luật cứng của chủ dự án: KHÔNG để chữ Trung ra sản phẩm.

    DẤU HIỆU DÙNG (chủ dự án chốt): *"câu nào cũng có"* — watermark là chuỗi xuất hiện ở RẤT NHIỀU cue, còn
    thoại thì mỗi câu một khác. Đây là dấu hiệu NỘI DUNG, độc lập hoàn toàn với hình học, nên bắt được cả ca
    watermark nằm ĐÈ dải sub mà `_loc_wm_lap` phải bó tay.

    Ngưỡng: `OCR_WM_CHU_TY` (0.20 = có mặt ở ≥20% số cue) và `OCR_WM_CHU_LMIN` (4 ký tự). Chuỗi NGẮN 2-3 ký
    tự (watermark AI đời mới: `即梦`) đi CỬA RIÊNG chặt hơn — xem khối `_lmin_ngan` bên dưới.
    Vì sao 4 ký tự: cụm 1-3 ký tự Hán là từ thoại thường gặp (什么/我们/一个) — gỡ là phá câu. Tên kênh/nền
    tảng thực tế đều ≥4 (紫轩漫屋, bilibili, 抖音, @tên). Vì sao 20%: watermark thật có mặt gần như mọi cue;
    một CÂU THOẠI lặp lại ở 20% số cue của cả video là chuyện không xảy ra ngoài watermark.
    Chỉ GỠ chuỗi đó khỏi câu — phần thoại còn lại GIỮ NGUYÊN. Cue rỗng sau khi gỡ mới bị bỏ.
    Tắt: OCR_GO_WM_CHU=0."""
    if os.environ.get("OCR_GO_WM_CHU", "1") == "0" or not segs or len(segs) != len(boxes) or len(segs) < 8:
        return segs, boxes
    try:
        _ty = float(os.environ.get("OCR_WM_CHU_TY", "") or 0.20)
    except ValueError:
        _ty = 0.20
    try:
        _lmin = int(os.environ.get("OCR_WM_CHU_LMIN", "") or 4)
    except ValueError:
        _lmin = 4
    try:
        # Chuẩn hoá khoảng trắng (OCR nhả space thất thường) — dùng CHUNG cho cả dò lẫn gỡ để không lệch.
        _txt = [" ".join(str(s[2]).split()) for s in segs]
        _co = [t for t in _txt if t]
        if len(_co) < 8:
            return segs, boxes
        _nguong = max(3, int(len(_co) * _ty))
        from collections import Counter
        # 🔴 ỨNG VIÊN CHỈ LẤY TỪ CÁC CUE ĐỨNG MỘT MÌNH. Bản đầu tiên của hàm này quét MỌI chuỗi con phổ
        # biến — và test bắt ngay: nó gỡ luôn `'@KenhABC câu thoại số '` (khuôn chữ lặp trong THOẠI) làm
        # **rỗng sạch 16/16 cue**. Chuỗi chung phổ biến KHÔNG đủ để kết luận là watermark; phụ đề thật có
        # rất nhiều khuôn lặp.
        # Dấu hiệu ĐỦ CHẶT (đúng ý chủ dự án "câu nào cũng có"): chuỗi đó phải TỪNG ĐỨNG MỘT MÌNH thành
        # trọn một cue ít nhất `OCR_WM_CHU_RIENG` (2) lần — watermark bao giờ cũng có lúc hiện lẻ (ca khách:
        # 531 cue chỉ có watermark), còn khuôn chữ trong thoại thì KHÔNG BAO GIỜ đứng một mình.
        # Rẻ hơn hẳn bản cũ: ứng viên chỉ vài chuỗi thay vì hàng trăm nghìn n-gram.
        try:
            _rieng_min = int(os.environ.get("OCR_WM_CHU_RIENG", "") or 2)
        except ValueError:
            _rieng_min = 2
        # CỬA HẸP CHO WATERMARK NGẮN (2-3 ký tự). Ngưỡng dài ≥4 ở trên bỏ lọt watermark AI đời mới — ĐO THẬT
        # trên video Jimeng: `即梦` chỉ 2 ký tự nên bị loại ⇒ 22/25 cue dính watermark đi thẳng vào bản dịch,
        # burn ra "CHILD'S PLAY! DREAMINA". Nhưng KHÔNG được hạ ngưỡng chung xuống 2: cụm 2 ký tự Hán rất hay
        # là từ thoại, và `什么？`("Cái gì?") ĐỨNG MỘT MÌNH trọn 1 cue là chuyện thường trong phim ⇒ hai điều
        # kiện cũ (≥20% cue, đứng-một-mình ≥2 lần) KHÔNG đủ chặt cho chuỗi ngắn.
        # ⇒ Chuỗi ngắn phải qua cửa CHẶT HƠN NHIỀU: có mặt ở ≥60% cue VÀ từng đứng một mình ≥5 lần. Một TỪ
        # THOẠI có mặt ở 60% số cue của cả video là chuyện không xảy ra; watermark thì gần như 100%
        # (đo: `即梦` 22/25 = 88%, đứng một mình 13 lần).
        try:
            _lmin_ngan = int(os.environ.get("OCR_WM_CHU_LMIN_NGAN", "") or 2)
        except ValueError:
            _lmin_ngan = 2
        try:
            _ty_ngan = float(os.environ.get("OCR_WM_CHU_TY_NGAN", "") or 0.60)
        except ValueError:
            _ty_ngan = 0.60
        try:
            _rieng_ngan = int(os.environ.get("OCR_WM_CHU_RIENG_NGAN", "") or 5)
        except ValueError:
            _rieng_ngan = 5
        _nguong_ngan = max(_nguong, int(len(_co) * _ty_ngan))
        _rieng = Counter(_co)
        _cand = []
        for s, n in _rieng.items():
            if not any(ch.isalnum() for ch in s):
                continue
            _dai = len(s)
            if _dai >= _lmin:
                _can_n, _can_df = _rieng_min, _nguong                 # luật CŨ, không đổi
            elif _dai >= _lmin_ngan and _lmin_ngan > 0:
                _can_n, _can_df = _rieng_ngan, _nguong_ngan           # cửa hẹp cho chuỗi ngắn
            else:
                continue
            if n >= _can_n:
                _df = sum(1 for t in _co if s in t)
                if _df >= _can_df:
                    _cand.append((s, _df))
        if not _cand:
            return segs, boxes
        # Gỡ chuỗi DÀI trước (tránh gỡ mảnh rồi phần còn lại không khớp nữa).
        _cand.sort(key=lambda x: (-len(x[0]), -x[1]))
        _giu = _cand
        _bo, _sua = set(), 0
        for _i, t in enumerate(_txt):
            if not t:
                continue
            _moi = t
            for s, _c in _giu:
                if s in _moi:
                    _moi = _moi.replace(s, " ")
            _moi = " ".join(_moi.split())
            if _moi == t:
                continue
            _sua += 1
            if len(_moi) < 2:            # gỡ xong chẳng còn gì = cue đó VỐN chỉ là watermark
                _bo.add(_i)
            else:
                _s = list(segs[_i]); _s[2] = _moi; segs[_i] = tuple(_s)
        if _sua:
            log("🧽 Gỡ chữ NỀN TẢNG/watermark khỏi %d cue: %s"
                % (_sua, " · ".join("%r (%d/%d cue)" % (s, c, len(_co)) for s, c in _giu[:4])))
        if _bo:
            log("🧽 Bỏ thêm %d cue chỉ còn watermark sau khi gỡ." % len(_bo))
            segs = [x for _i, x in enumerate(segs) if _i not in _bo]
            boxes = [x for _i, x in enumerate(boxes) if _i not in _bo]
    except Exception as _e:
        # KHÔNG nuốt im lặng — cùng lý do đã ghi ở `_loc_wm_lap`.
        log("⚠ Gỡ chữ nền-tảng lỗi (%s: %s) → giữ nguyên cue." % (type(_e).__name__, str(_e)[:100]))
    return segs, boxes


def _loc_wm_lap(segs, boxes, log=print):
    """Bỏ cụm cue là WATERMARK/LOGO: cùng vùng-Y và LẶP LẠI CÙNG MỘT NỘI DUNG suốt video.

    Vì sao dấu hiệu này đúng còn các dấu hiệu hình học thì không (đều đã đo và trượt):
      • theo chiều DỌC  — watermark khách ở y 84.0-90.6% CHỒNG dải sub 88.3-98.2%, cắt ngang không tách được.
      • theo "lệch mép" — SAI cả một thể loại: video khung CHAT có bong bóng cố ý nằm lệch trái/phải
        (ảnh 003.mp4 t=36s), bật lên là xoá nửa hội thoại.
      • theo bề-ngang-không-đổi — watermark bán trong suốt nên OCR đọc lệch mỗi lần, bề ngang vẫn biến.
      • theo tâm-x-ít-biến — đo: watermark 0.107 vs sub-di-chuyển 0.148, quá sát, over-fit.
    Còn NỘI DUNG thì tách sạch: watermark là MỘT chuỗi lặp lại (OCR đọc lệch vài ký tự nên phải so GẦN ĐÚNG),
    trong khi thoại/bong-bóng-chat mỗi câu một nội dung khác hẳn.

    An toàn: chỉ bỏ khi cụm có ≥ OCR_WM_LAP_MIN (3) cue VÀ đa số đôi một giống nhau ≥ OCR_WM_LAP_TY (0.5) — ĐO THẬT: OCR đọc watermark lệch nhiều (@术先森影剧 vs
    @末先释影潤 chỉ giống 0.50) nên 0.6 KHÔNG bắt được (chỉ 3/8 cue có bản sao),
    và KHÔNG bao giờ bỏ cụm đông cue nhất (đó là dải phụ đề). Tắt: OCR_WM_LAP=0.

    🔴 MẶC ĐỊNH "1" → "0" (13/08/2026, chủ dự án chốt). HAI lý do, lý do thứ hai mới là chính:
      1. Khách nay CHỦ ĐỘNG khoanh vùng watermark, và vùng đó được **TÔ PHẲNG TRƯỚC KHI OCR NHÌN**
         (`_to_phang_vung_tay`, thêm cùng ngày) — sạch hơn hẳn việc đọc rồi mới bỏ. Đo thật: tô vùng đỉnh
         làm Pha 1 từ "2 dải rời" còn "1 dải", dải chính KHÔNG đổi.
      2. 🔑 Đây là tầng lọc TOÀN CỤC DUY NHẤT trong chuỗi hậu-xử-lý OCR — nó phải nhìn HẾT video mới biết
         một cụm có "lặp xuyên video" hay không. Chính nó chặn kiến trúc CHẠY SONG SONG (OCR → dịch → TTS):
         cue bắn ra ở phút 2 có thể bị xoá ở phút 40, nên không thể dịch/đọc sớm. Ba tầng còn lại
         (`_loai_vung_tay`, `_go_chu_nen_tang`, lọc title-card theo Y) đều xét TỪNG CUE ⇒ stream được.
         Tắt tầng này ⇒ pipeline song song thành bài toán scheduler thuần, KHÔNG cần trạng thái REJECTED /
         buffer chưa-commit / xoá artifact muộn.
    ⚠ CÁI MẤT: hết lớp TỰ DÒ watermark lặp. Khách KHÔNG khoanh vùng thì watermark lặp sẽ lọt vào phụ đề
    (ca đã gặp: `@术先森影剧` lặp 8 cue). Bật lại: **OCR_WM_LAP=1**.
    ⚠ `_go_chu_nen_tang` (ngay TRÊN) VẪN BẬT và KHÔNG được tắt theo — nó gỡ tên nền-tảng DÍNH TRONG câu
    thoại (`紫轩漫屋bilibi啊`), thứ không khoanh vùng được vì nằm lẫn trong dải sub. Bỏ nó là tái hiện ca
    khách kienpvtsr1: chữ Hán còn trong bản dịch → `_con_sot` gắn cờ → dịch lại 3 vòng × ~15 phút."""
    # 🟢 BẬT LẠI MẶC ĐỊ**NH "0" → "1" (22/08/2026) — LÝ DO TẮT ĐÃ HẾT HIỆU LỰC.
    # Lý do (2) ở trên — *"chặn kiến trúc CHẠY SONG SONG (OCR → dịch → TTS)"* — **kiến trúc đó chưa
    # từng được xây**: `OCR_SONG_SONG` xuất hiện **0 lần trong mọi file .py**, chỉ còn trong file plan
    # `plans/260812-p0-.../phase-04-ocr-song-song-dich.md`. Và hướng đó sau này đo ra là **trò chơi tổng bằng
    # không** (Chromium ăn hết CPU mà OCR vừa nhả). ⇒ Đang trả giá cho một lợi ích KHÔNG TỒN TẠI.
    # Lý do (1) — *"khách nay chủ động khoanh vùng"* — vẫn đúng, nhưng chỉ với khách CÓ khoanh.
    #
    # ĐO ĐỘ PHỦ THẬT (200 cue giả lập, chạy đúng chuỗi 3 tầng theo thứ tự thật):
    #     ca                                        TẮT       BẬT
    #     `@tên_kênh` đứng riêng 8/200            SẠCH     SẠCH   ← `_go_ten_kenh` lo
    #     `bilibili` / `拖音号：8899` riêng         SẠCH     SẠCH   ← `_go_ten_kenh` lo
    #     watermark đứng riêng ≥20% số cue          SẠCH     SẠCH   ← `_go_chu_nen_tang` lo
    #     **`紫轩漫屋` (tên kênh, KHÔNG @) 8/200**   **SÓT 8**  SẠCH   ← CHỈ tầng này bắt được
    # Tên kênh không có `@`, không phải tên nền tảng, lại dưới 20% số cue ⇒ hai tầng kia đều mù.
    # Đúng ca chú thích ngay trên đã cảnh báo: *"khách KHÔNG khoanh vùng thì watermark lặp sẽ lọt"*.
    #
    # VÌ SAO AN TOÀN: tầng này **KHÔNG BAO GIỜ đụng cụm đông cue nhất** (= dải phụ đề), cần ≥3 cue
    # cùng cụm-Y VÀ đa số đôi một giống nhau ≥50%. Tắt lại: OCR_WM_LAP=0.
    if os.environ.get("OCR_WM_LAP", "1") == "0" or not segs or len(segs) != len(boxes) or len(segs) < 4:
        return segs, boxes
    try:
        _min_n = int(os.environ.get("OCR_WM_LAP_MIN", "") or 3)
    except ValueError:
        _min_n = 3
    try:
        _ty = float(os.environ.get("OCR_WM_LAP_TY", "") or 0.5)
    except ValueError:
        _ty = 0.5
    try:
        import difflib
        nhom = {}
        for i, b in enumerate(boxes):
            nhom.setdefault(round(((b[2] + b[3]) / 2.0) / 0.05), []).append(i)
        if len(nhom) < 2:
            return segs, boxes
        _chinh = max(nhom, key=lambda k: len(nhom[k]))       # cụm đông nhất = dải phụ đề, KHÔNG đụng
        _bo = set()
        for k, idxs in nhom.items():
            if k == _chinh or len(idxs) < _min_n:
                continue
            _t = ["".join(str(segs[i][2]).split()) for i in idxs]
            # đếm số cue CÓ BẢN SAO (ít nhất 1 cue khác cùng cụm giống ≥_ty). Đếm theo CẶP thì mảnh đọc hụt
            # ('影剧', '心牌' — cũng là watermark) kéo tụt tỉ lệ xuống dưới 50% ⇒ không bắt được (đã đo).
            _co_ban_sao = 0
            for _a in range(len(_t)):
                if not _t[_a]:
                    continue
                if any(_b2 != _a and _t[_b2] and
                       difflib.SequenceMatcher(None, _t[_a], _t[_b2]).ratio() >= _ty
                       for _b2 in range(len(_t))):
                    _co_ban_sao += 1
            if _co_ban_sao >= max(_min_n, len(_t) * 0.5):
                _bo.update(idxs)
                _yc = sum((boxes[i][2] + boxes[i][3]) / 2.0 for i in idxs) / len(idxs)
                log("🧹 Bỏ %d cue ở y~%.2f — LẶP CÙNG NỘI DUNG suốt video (%d/%d cue có bản sao giống ≥%.0f%%) "
                    "= watermark/logo, không phải thoại. Ví dụ: %s"
                    % (len(idxs), _yc, _co_ban_sao, len(_t), _ty * 100, str(segs[idxs[0]][2])[:20]))
        if _bo:
            segs = [x for i, x in enumerate(segs) if i not in _bo]
            boxes = [x for i, x in enumerate(boxes) if i not in _bo]
    except Exception as _e:
        # KHÔNG nuốt im lặng — chính tôi vừa mất nhiều vòng đo vì một `except: pass` ở đây.
        log("⚠ Lọc watermark-lặp lỗi (%s: %s) → giữ nguyên cue." % (type(_e).__name__, str(_e)[:100]))
    return segs, boxes


def _loai_vung_tay(segs, boxes, log=print):
    """Bỏ cue nằm trong vùng KHÁCH TỰ KHOANH (banner/watermark) — đọc env `OCR_LOAI_VUNG`.

    Khác `_loc_wm_lap` (tự dò, đòi bằng chứng LẶP NỘI DUNG ≥3 cue): ở đây khách CHỈ THẲNG vào vùng nên bỏ
    luôn, không cần bằng chứng. Ca thật cần tầng này — watermark AI (`即梦`/Dreamina trên video Jimeng) và
    banner tiêu đề: cả hai chỉ hiện vài giây, KHÔNG lặp đủ ngưỡng nên `_loc_wm_lap` không bắt, mà vẫn lọt vào
    phụ đề khách nhận (đo thật: 2/3 cue đầu của 1 video là tên watermark, burn ra "CHILD'S PLAY! DREAMINA").

    `OCR_LOAI_VUNG` = JSON `[{y0,y1,x0,x1,t0,t1,chu}]` — y/x là TỈ LỆ khung (0-1) như `boxes`; t0/t1 GIÂY
    (t1<=0 = tới hết video); `chu` = chữ gốc khách đã đọc được trong ô (có thể trống).

    Ba luật, theo đúng 3 hình dạng ĐO ĐƯỢC trên video thật (Jimeng 25 cue):
      1. HỘP BÁM SÁT chữ → chồng vùng ≥ `OCR_LOAI_TY` (0.5 diện tích HỘP) ⇒ BỎ cả cue.
      2. HỘP BỊ NỚI (cue watermark nhưng `ocr_dong` nới hộp ra gần trọn dải phụ đề — đo thật: cue `即梦` có
         hộp x 0.037→1.000, chồng chỉ 12% nên luật 1 KHÔNG bắt) ⇒ so NỘI DUNG với `chu`: giống ≥60% thì BỎ.
      3. CUE LẪN (`雕虫小技！即梦` = thoại DÍNH watermark) ⇒ GỠ đúng đoạn trùng `chu` ra khỏi text, GIỮ phần
         thoại. Bỏ cả cue ở đây là mất thoại thật.
    Luật 2 và 3 đều đòi hộp có chồng lấn vùng (dù ít) — chặn ca chữ trùng tên nằm hẳn chỗ khác trong khung."""
    _raw = (os.environ.get("OCR_LOAI_VUNG", "") or "").strip()
    if not _raw or not segs or len(segs) != len(boxes):
        return segs, boxes
    try:
        import json as _js
        vung = _js.loads(_raw) or []
    except Exception as _e:
        # KHÔNG nuốt im lặng: vùng hỏng mà lặng thinh thì khách thấy watermark vẫn lọt sub, không hiểu vì sao.
        log("⚠ Vùng loại-khỏi-phụ-đề đọc không được (%s: %s) → không loại vùng nào."
            % (type(_e).__name__, str(_e)[:80]))
        return segs, boxes
    if not vung:
        return segs, boxes
    try:
        _ty = float(os.environ.get("OCR_LOAI_TY", "") or 0.5)
    except ValueError:
        _ty = 0.5
    try:
        _ty_chu = float(os.environ.get("OCR_LOAI_TY_CHU", "") or 0.6)
    except ValueError:
        _ty_chu = 0.6
    import difflib
    import re as _re

    def _chuan(s):
        return "".join(str(s or "").split())

    _bo, _sua, _go_n = set(), {}, 0
    for i, b in enumerate(boxes):
        try:
            _ton, _toff, _y0, _y1, _x0, _x1 = float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(b[4]), float(b[5])
        except (TypeError, ValueError, IndexError):
            continue
        _dt = max(1e-9, (_y1 - _y0) * (_x1 - _x0))
        _txt = _sua.get(i, str(segs[i][2] if len(segs[i]) > 2 else ""))
        for v in vung:
            try:
                vy0, vy1 = float(v.get("y0", 0)), float(v.get("y1", 1))
                vx0, vx1 = float(v.get("x0", 0)), float(v.get("x1", 1))
                vt0, vt1 = float(v.get("t0", 0) or 0), float(v.get("t1", 0) or 0)
                vchu = _chuan(v.get("chu"))
            except (TypeError, ValueError, AttributeError):
                continue
            if _toff <= vt0 or (vt1 > 0 and _ton >= vt1):
                continue                       # không chồng thời gian (t1<=0 = vùng kéo tới hết video)
            _ph = (max(0.0, min(_y1, vy1) - max(_y0, vy0))
                   * max(0.0, min(_x1, vx1) - max(_x0, vx0)))
            if _ph / _dt >= _ty:
                _bo.add(i)                     # LUẬT 1 — hộp bám sát chữ, nằm gọn trong vùng
                break
            if _ph <= 0 or not vchu:
                continue                       # luật 2/3 đòi có chồng lấn hình học + biết chữ trong ô
            _tn = _chuan(_txt)
            if not _tn:
                continue
            if difflib.SequenceMatcher(None, _tn, vchu).ratio() >= _ty_chu:
                _bo.add(i)                     # LUẬT 2 — cả cue chính là watermark (hộp bị nới nên luật 1 trượt)
                break
            # LUẬT 3 — cue LẪN thoại + watermark: gỡ đúng đoạn trùng, giữ thoại. Đòi đoạn trùng dài ≥2 ký tự
            # VÀ ≥40% chữ trong ô, để chuỗi 2 ký tự trùng ngẫu nhiên với banner DÀI không cắt bậy vào thoại.
            _m = difflib.SequenceMatcher(None, _tn, vchu).find_longest_match(0, len(_tn), 0, len(vchu))
            if _m.size >= max(2, int(round(0.4 * len(vchu)))):
                _con = (_tn[:_m.a] + _tn[_m.a + _m.size:]).strip()
                _con = _re.sub(r"^[\s!！?？,，。.、:：;；~～-]+|[\s!！?？,，。.、:：;；~～-]+$", "", _con)
                _go_n += 1
                if _con:
                    _sua[i] = _con
                    _txt = _con
                else:
                    _bo.add(i)                 # gỡ xong không còn gì = cue vốn chỉ là watermark
                    break
    if _sua:
        segs = [((s[0], s[1], _sua[i]) if (i in _sua and len(s) > 2) else s) for i, s in enumerate(segs)]
    if _bo or _sua:
        log("🚫 Vùng bạn tự khoanh: bỏ %d cue, gỡ chữ trong %d cue — dịch riêng, KHÔNG đưa vào phụ đề.%s"
            % (len(_bo), _go_n, ("" if not _bo else " Ví dụ: " + str(segs[sorted(_bo)[0]][2])[:30])))
    if _bo:
        segs = [x for i, x in enumerate(segs) if i not in _bo]
        boxes = [x for i, x in enumerate(boxes) if i not in _bo]
    return segs, boxes


def _chot_bo_phieu(ds):
    """BỎ PHIẾU THEO THỜI GIAN: nhiều bản đọc của CÙNG một dòng hardsub → chốt 1 bản.

    Thay heuristic cũ "giữ bản đọc DÀI hơn". Vì sao: lỗi OCR hay gặp là CHÈN THÊM ký tự rác
    (`快跑吧` → `1.快跑吧`, `貔貅` → `一貔体`) ⇒ bản RÁC lại DÀI HƠN nên heuristic cũ chọn đúng cái sai.
    Cùng 1 dòng sub thường được đọc 2-6 lần, lỗi chèn thường chỉ xảy ra ở 1 lần ⇒ đa số chọn đúng.

    Thứ tự quyết định:
      1. ĐA SỐ theo CHUỖI: bản xuất hiện nhiều nhất và NHIỀU HƠN HẲN á quân → lấy.
      2. Không ngã ngũ → GIỮ NGUYÊN hành vi cũ (bản dài nhất).

    ⚠ CỐ Ý KHÔNG bỏ phiếu TỪNG KÝ TỰ (đã làm rồi GỠ sau khi đo). Vote ký tự có thể ghép ra chuỗi
    CHƯA TỪNG được đọc lần nào ⇒ bịa chữ. Đo thật video khách 256 cue: vote-ký-tự sửa 4 cue nhưng
    1 trong 4 là SAI ĐI (`不是一般人😍` → `不是一般见`, đúng phải là `一般人`), trong khi cả 3 ca
    ĐÚNG (`貌貅`→`貔貅`, `本領`→`本领`, bỏ emoji rác) đều do đa-số-chuỗi quyết. ⇒ Chỉ chọn trong
    những bản THẬT SỰ đọc được, không tổng hợp chuỗi mới.
    Tắt: OCR_VOTE=0."""
    ds = [x for x in (ds or []) if x]
    if not ds:
        return ""
    if len(ds) == 1 or os.environ.get("OCR_VOTE", "1") == "0":
        return max(ds, key=len)
    from collections import Counter
    _dem = Counter(ds)
    _top = _dem.most_common()
    if len(_top) == 1:
        return _top[0][0]                       # mọi lần đọc y hệt nhau (ca phổ biến nhất) → 0 thay đổi
    if _top[0][1] > _top[1][1]:
        return _top[0][0]                       # (1) đa số rõ ràng — CHỈ chọn bản đã thật sự đọc được
    # (2) HOÀ PHIẾU. 🐛 12/08/2026 — nhánh này TRƯỚC ĐÂY là `max(ds, key=len)` và nó THẤT BẠI Ở ĐÚNG VÍ DỤ
    # docstring trên nói nó sinh ra để diệt: chạy thật `(['快跑吧','1.快跑吧'])` → `'1.快跑吧'`. Hoà phiếu
    # KHÔNG hiếm — nó là ca THƯỜNG GẶP: cue ngắn chỉ được đọc đúng 2 lần thì không đời nào có đa số, nên
    # cơ chế bỏ phiếu chỉ thật sự bảo vệ từ 3 bản đọc trở lên. Ca thật đã đo (video 718665): watermark
    # `白姐扇风` dính vào đầu câu ⇒ bản bẩn dài hơn ⇒ thắng ⇒ đọc lên cả tên kênh.
    #
    # PHÂN BIỆT BẰNG VỊ TRÍ PHẦN THỪA, không bằng độ dài — chữ hardsub mọc TRÁI→PHẢI:
    #     谁在用  ⊂ 谁在用琵琶    thừa ở ĐUÔI → phụ đề HIỆN DẦN, bản dài đầy đủ hơn → giữ DÀI (như cũ)
    #     奶奶    ⊂ 白姐扇风奶奶  thừa ở ĐẦU  → watermark/logo dính vào       → giữ NGẮN
    #     快跑吧  ⊂ 1.快跑吧      thừa ở ĐẦU  → ký tự nhiễu                   → giữ NGẮN
    # Chỉ nhận khi bản ngắn ≥2 ký tự (1 ký tự trùng đuôi là ngẫu nhiên, không phải bằng chứng).
    # Vẫn CHỈ chọn trong các bản THẬT SỰ đọc được — không ghép chuỗi mới (xem cảnh báo vote-ký-tự trên).
    _dai = max(ds, key=len)
    _sach = [x for x in ds if x != _dai and len(x) >= 2 and _dai.endswith(x)]
    if _sach:
        return max(_sach, key=len)              # bản dài nhất trong số các bản KHÔNG dính phần đầu
    return _dai


def ocr_dong(video, log=print, on_seg=None, on_chot=None):
    """HỢP NHẤT (1 lần): dò ĐOẠN vị-trí (dai_sub_rapid, RẺ) → mỗi đoạn crop hộp + RapidOCR det+rec cho TEXT
    + box CHÍNH XÁC. Đoạn KHÔNG đọc được chữ → LOẠI (lọc nhiễu). Gộp đoạn liền kề CÙNG text. Trả (segs, boxes):
      segs  = [(t_on, t_off, text)]            — drop-in cho asr_segments → dịch (timing đã KHỚP box).
      boxes = [(t_on, t_off, y0,y1,x0,x1)]     — blur ĐỘNG + đặt phụ đề bám đúng chỗ chữ DI CHUYỂN.
    Vị trí chuẩn (RapidOCR) + timing khớp text + đọc chữ ĐÚNG nơi nó di chuyển (fix 'mất câu'). [] nếu không hardsub."""
    import cv2
    import dai_sub_rapid
    import time as _tm
    _PROF = os.environ.get("OCR_PROFILE") == "1"
    pr = {"read": 0, "grab": 0, "skip": 0, "ocr": 0, "merged": 0, "new": 0, "hit": 0, "t_detect": 0.0,
          "t_dec": 0.0, "t_diff": 0.0, "t_trim": 0.0, "t_ocr": 0.0,
          # TÁCH `t_ocr` (11/08/2026): `t_ocr` bao CẢ KHỐI 1363-1429 (mặt nạ, cache, _khit_x, rec, det+rec)
          # nên "175 lần / 199s = 1,14 s/lần" KHÔNG phải giá của một lời gọi OCR — tôi đã suy nhầm đúng chỗ
          # này. Hai mốc dưới đo RIÊNG hai lời gọi thật sự, để biết 199s rơi vào đâu.
          "t_hyrec": 0.0, "t_detrec": 0.0,
          # 🐛 ĐẾM RIÊNG SỐ LƯỢT GỌI (12/08/2026). Trước đây dòng PROFILE-OCR chia `t_hyrec` cho `hy_rec` —
          # nhưng `t_hyrec` cộng ở MỌI lượt gọi còn `hy_rec` chỉ cộng khi bản đọc ĐƯỢC NHẬN
          # (`_t_hy and _sc_hy >= _hy_score`); `t_detrec` cộng mọi lượt còn `hy_det` chỉ cộng khi `_hybrid`.
          # ⇒ số "s/lần" in ra bị THỔI PHỒNG, và với hybrid tắt thì in ra "det+rec 0 lần=63s (0.000s/lần)".
          # Đây là hỏng ở DỤNG CỤ ĐO nên nó không sai một lần mà làm sai MỌI kết luận tốc độ về sau — chính
          # tôi đã trích số sai từ dòng này hôm 11/08. `hy_rec`/`hy_det` GIỮ NGUYÊN ý nghĩa cũ (số lượt được
          # NHẬN / số lượt re-det) vì chỗ khác còn dùng; thêm 2 bộ đếm LƯỢT GỌI để chia cho đúng.
          "n_hyrec": 0, "n_detrec": 0}
    _td = _tm.perf_counter()
    # loc_title=False: cand BAO TRỌN chữ Hán mọi vị-trí (kể cả cao) → box CHE đầy đủ (user: "che chữ cao nếu
    # phụ đề gốc ở trên"). Title-card lọc khỏi TEXT/dub Ở DƯỚI (trước return), giữ trong boxes → CHE sạch + DUB
    # không đọc title thành thoại giả.
    cand = dai_sub_rapid.phat_hien_hop_dong(video, log_fn=log, loc_title=False)   # truyền log THẬT → tiến độ dò-dải hiện lên (video dài không "đứng 1%")
    pr["t_detect"] = _tm.perf_counter() - _td
    if not cand:
        return [], []
    cand = _loc_dai_sub_that(cand, log=log)
    # cand = ĐÚNG 1 đoạn phủ gần hết video (chế độ bỏ pha dò của dai_sub_rapid) → chỉ số đoạn `si` vô nghĩa,
    # xem chỗ dùng ở _ocr_va_ghi.
    try:
        _dur_v = (cand[-1][1] - cand[0][0]) if cand else 0.0
        _1_doan_ca_video = (len(cand) == 1 and _dur_v >= 30.0)
    except Exception:
        _1_doan_ca_video = False
    eng = _engine()
    # Ô CHỮ TĨNH (watermark/logo) Pha 1 tìm được → TÔ PHẲNG trên khung TRƯỚC khi mặt-nạ/OCR nhìn tới.
    # Rẻ: 1 phép gán slice mỗi khung ĐỌC (không phải mỗi khung giải mã). Chỉ để OCR khỏi quét rồi bỏ và
    # khỏi ghép rác vào câu ('@木元林彩刷 再看那道身影已经不见了') — KHÔNG đụng gì tới video xuất.
    _wm_px = []
    try:
        for _w in (getattr(dai_sub_rapid, "_WM_TINH", None) or []):
            _wm_px.append((float(_w[0]), float(_w[1]), float(_w[2]), float(_w[3])))
    except Exception:
        _wm_px = []
    cap = cv2.VideoCapture(os.path.abspath(video))
    if not cap.isOpened():
        return [], []
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    nfr = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    import numpy as np
    segs, boxes, cue_si = [], [], []          # cue_si[i] = chỉ số đoạn cand của cue i (để gộp re-read CÙNG đoạn)
    _run0 = _last_log = _tm.perf_counter()
    # ĐO CPU% (chẩn đoán tranh tài nguyên — khách báo "mất câu giữa video" nhưng máy dev rảnh không tái hiện
    # được: nghi ngờ máy khách bận CPU lúc OCR chạy làm giảm độ tin cậy đọc chữ, chưa xác nhận được vì không
    # có log CPU% thật lúc lỗi xảy ra). Soft-dependency: lỗi/thiếu module → _cpu_mon=None, log bỏ qua phần %CPU.
    try:
        import thong_tin_may
        _cpu_mon = thong_tin_may.TheoDoiCpu()
        _cpu_mon.phan_tram()   # mồi delta (lần đầu luôn None)
    except Exception:
        _cpu_mon = None
    # ĐỌC TUẦN TỰ + FRAME-DIFF: kiểm dải mỗi ~OCR_CHK giây; CHỈ OCR khi NỘI DUNG dải ĐỔI (mean absdiff > ngưỡng)
    # → mỗi câu OCR ~1 lần (sub đứng yên nhiều frame → skip, chi phí diff ≈0). OCR = REC-ONLY trên dải (bỏ det:
    # dải ĐÃ là 1 dòng → ~3× nhanh + đúng hơn) + cắt mép trắng. KHÔNG seek per-mốc (cap.set O(n) → O(n²) treo);
    # grab tuần tự = O(n). (Chỉnh: OCR_CHK nhịp kiểm, OCR_DIFF ngưỡng đổi-chữ.)
    chk = max(1, int(round(float(os.environ.get("OCR_CHK", "0.25") or 0.25) * fps)))
    xthr = float(os.environ.get("OCR_XOR", "0.012") or 0.012)   # mask chữ đổi > xthr (so câu ĐANG hiện) = đổi
    wmin = float(os.environ.get("OCR_WMIN", "0.004") or 0.004)  # white_ratio < wmin = dải TRỐNG (không chữ) → skip
    # HYSTERESIS: mask đổi phải GIỮ ≥hyst nhịp (mỗi nhịp OCR_CHK=0.25s) mới OCR. Mặc định 2 (0.5s) — CÂN BẰNG:
    # lọc nền-rung/cắt-cảnh thoáng qua. Hạ 1 bắt thêm câu ngắn <0.5s NHƯNG tăng trùng-drift (cùng câu OCR đọc
    # nhiều lần khác nhau qua frame) + cue rác. Giữ 2 an toàn; video sub rất nhanh chỉnh env OCR_HYST=1.
    hyst = int(os.environ.get("OCR_HYST", "2") or 2)
    # CỨU CÂU NGẮN: hysteresis ở trên đòi mask giữ ≥hyst nhịp mới OCR ⇒ câu tồn tại NGẮN HƠN (hyst-1)×OCR_CHK
    # (~0.25-0.5s) KHÔNG BAO GIỜ được đọc — mất hẳn cả câu. Đo thật: câu '我什么我' chỉ hiện 12.8→13.0s = 0.2s,
    # bắt được hay không hoàn toàn tuỳ PHA của nhịp kiểm (thêm 1 đoạn phía trước là lệch pha → mất).
    # Hạ OCR_HYST=1 ĐÃ THỬ và KHÔNG DÙNG ĐƯỢC: OCR ngay mọi thay đổi kể cả khung đang fade-in → đọc ra rác
    # ('我'→'一我') + cue dài 0 giây.
    # Cách này khác hẳn: vẫn chờ đủ hyst như cũ, nhưng GIỮ LẠI khung tại nhịp đầu (pend==1); nếu tới nhịp sau
    # mà ứng viên đã BIẾN MẤT (mask đổi tiếp / dải trống) thì mới OCR NGƯỢC LẠI khung đã giữ. Câu bình thường
    # (giữ đủ nhịp) chạy y hệt cũ, KHÔNG thêm lời gọi OCR nào. Tắt: OCR_CUU_NGAN=0.
    _cuu_ngan = os.environ.get("OCR_CUU_NGAN", "1") != "0"
    # Pha đọc TỰ DÒ HỘP KHÍT: bắt buộc khi cand chỉ là 1 dải phủ cả video (đã bỏ pha dò) — rec-only cần crop
    # khít quanh 1 dòng, đưa cả dải vào thì đọc sai chữ (đo: 蔚部长→防证). Ép tay: OCR_DOC_DET=1/0.
    _dd_env = os.environ.get("OCR_DOC_DET", "")
    _doc_det = (_dd_env == "1") or (_dd_env != "0" and _1_doan_ca_video)
    _uv = None            # ứng viên đang chờ xác nhận: dict(band, m, t_new, si, xy)
    fidx, si, next_chk, pend = 0, 0, 0, 0                       # (lọc nền-rung/cháy-nổ thoáng qua 1 frame)
    prev_mask = None
    t_new = 0.0                                # mốc frame ĐẦU thấy mask câu mới = t_on THẬT (bỏ trễ hysteresis ~0.5s)
    iou_on = os.environ.get("OCR_IOU", "0") == "1"             # #6 dò-đổi IoU: test clip sạch +4 cue (ngưỡng 0.80 nhạy hơn absdiff) → MẶC ĐỊNH TẮT, opt-in + tune OCR_IOU_THR cho video glow/karaoke
    iou_same = float(os.environ.get("OCR_IOU_THR", "0.80") or 0.80)   # IoU ≥ ngưỡng = CÙNG câu
    cache_on = os.environ.get("OCR_CACHE", "1") == "1"        # #3 cache text theo fingerprint mask (IoU≥0.97 → khỏi OCR lại)
    _ocr_cache = []                                            # [(mask_bin 200×24, text)] gần đây, cap 12
    _det_lich = []                                             # [(ry0,ry1)] hộp det ĐÃ NHẬN — để ước lượng khi det hụt
    # HYBRID det-khoá-ROI (opt-in OCR_HYBRID=1): phạm vi sản phẩm = phim/recap, phụ đề 1 DÒNG, 1/3 dưới màn
    # hình (video 2 dòng khách tự che) ⇒ sau khi det đã chốt CHIỀU CAO dòng, detector chỉ lặp lại việc đã biết.
    # Khoá dải Y từ det (trung vị vài mẫu đầu) → các lần sau CROP KHÍT theo Y đó + dò X bằng `_khit_x` (rẻ) →
    # rec-only. ĐO THẬT: det+rec 42s vs rec-only-hộp-khít 4s cho cùng 88 cue (video 3').
    # ⚠ Chỉ khoá Y, KHÔNG khoá X: bề ngang đổi theo ĐỘ DÀI CÂU, khoá X sẽ lặp đúng lỗi "chữ bị ép nhỏ".
    # FALLBACK về det+rec khi có BẤT KỲ dấu hiệu bất thường (rỗng / score thấp / không dò được cột chữ) +
    # định kỳ re-det để bắt trôi vị-trí. Mọi lần det thật đều cập nhật lại ROI khoá.
    # MẶC ĐỊNH BẬT (user chốt 29/07). Tắt: OCR_HYBRID=0.
    # Vì sao dám bật: (a) nhánh này CHỈ chạy ở chế độ "bỏ pha dò" — vốn đã bị gate bởi "dải sub có mặt ở
    # ≥85% khung thăm dò" ⇒ chỉ đúng nhóm phim/recap 1 dòng dải cố định, KHÔNG đụng anime sub nhảy chỗ /
    # variety / karaoke; (b) mọi bất thường đều lùi det+rec nên xấu nhất = HÀNH VI CŨ; (c) đo 3 video:
    # 94% bỏ được detector, nhanh 2.8-3.6×, 0 lỗi chữ (2 ca hybrid còn đọc ĐÚNG HƠN det+rec).
    # ĐÃ KIỂM CHỨNG nghi vấn "câu nhiều chữ có bị mất nét không": KHÔNG — rapidocr tính
    # `img_width = img_height * max_wh_ratio` với max_wh_ratio LẤY THEO ảnh thật (ch_ppocr_rec/main.py:110-159)
    # ⇒ bề ngang co giãn tự do, không bị chặn ở 320px ⇒ thêm chữ KHÔNG làm mỗi chữ nhỏ đi. Thứ quyết định
    # độ nét là CHIỀU CAO crop (chuẩn hoá về 48px) — mà hybrid crop KHÍT theo ROI det nên chữ luôn gần đủ
    # 48px, tức NÉT HƠN đường rec-only cũ (crop cả dải cao → chữ co còn ~1/3). Đối chiếu thực nghiệm: câu
    # dài nhất 21 ký tự đọc đúng, và chính ở câu đó det+rec mới là bên đọc SAI (thừa chữ '刻').
    _hybrid = os.environ.get("OCR_HYBRID", "1") == "1"
    # OCR_DET_TINY=1 → đường LÙI dùng TINY để dò hộp rồi SMALL đọc chữ (xem khối dùng nó). MẶC ĐỊNH TẮT:
    # mới là thử nghiệm, chưa có số end-to-end. Chất lượng CHỮ không đổi (rec vẫn SMALL), chỉ đổi model dò hộp.
    _det_tiny = os.environ.get("OCR_DET_TINY", "0") == "1"
    try:
        _hy_score = float(os.environ.get("OCR_HYBRID_SCORE", "0.90") or 0.90)   # score rec tối thiểu để TIN
        _hy_mau = int(os.environ.get("OCR_HYBRID_MAU", "3") or 3)               # số mẫu det trước khi khoá ROI
        # 40 → 15: det lại DÀY HƠN 2.7×. Lý do: score cao KHÔNG đảm bảo đọc đúng ("tự tin nhưng sai", vd
        # 踹倒→黯倒) nên lưới score một mình không đủ; det định kỳ là lớp chặn độc lập, bắt cả ca trôi vị-trí
        # lẫn ca đọc-sai-mà-tự-tin. Đổi lại chỉ bớt ~7% mức tăng tốc (bỏ ~87% detector thay vì 94%).
        _hy_redet = int(os.environ.get("OCR_HYBRID_REDET", "15") or 15)         # cứ N lần rec-only → det lại 1 lần
        _hy_pad = int(os.environ.get("OCR_HYBRID_PAD", "8") or 8)               # đệm trên/dưới quanh ROI khoá (px)
    except ValueError:
        _hy_score, _hy_mau, _hy_redet, _hy_pad = 0.90, 3, 40, 8
    _roi_y = [None, None]      # dải Y (pixel TRONG crop `band`) đã khoá; None = chưa khoá
    _roi_mau = []              # [(py0,py1)] mẫu det thật gần đây → lấy trung vị khoá ROI
    _roi_dem = [0]             # đếm số lần rec-only liên tiếp kể từ lần det gần nhất (để re-det định kỳ)

    def _iou(a_bin, b_bin):
        inter = float(np.logical_and(a_bin, b_bin).sum())
        uni = float(np.logical_or(a_bin, b_bin).sum())
        return 1.0 if uni == 0 else inter / uni

    def _mask_giong(a, b):
        """2 mask có phải CÙNG 1 câu không — dùng ĐÚNG tiêu chí mà vòng đọc đang dùng cho `same`."""
        if a is None or b is None:
            return False
        if iou_on:
            return _iou(a > 0.4, b > 0.4) >= iou_same
        return float(np.abs(a - b).mean()) < xthr

    _phieu = {}   # (id(segs), chỉ số cue) → [mọi bản đọc của cue đó]; dùng cho _chot_bo_phieu

    def _ocr_va_ghi(band, m, t_new, t, si, y0, y1, x0, x1, nghiem=False):
        """OCR 1 khung dải + ghi cue (gộp vào câu trước hoặc mở câu mới). Trả True nếu ra chữ.

        Tách ra từ thân vòng đọc để dùng được ở HAI chỗ: (a) đường thường — ứng viên đã giữ đủ `hyst`
        nhịp; (b) CỨU CÂU NGẮN — ứng viên biến mất TRƯỚC khi đủ `hyst`, gọi lại với khung đã giữ.
        KHÔNG đổi một dòng logic nào bên trong so với bản cũ; chỉ `continue` → `return False` và để
        caller tự đặt `pend`/`prev_mask` (2 biến vòng lặp, không thuộc phần OCR).

        nghiem=True (chỉ dùng cho đường CỨU CÂU NGẮN): khung được cứu là khung tại nhịp ĐẦU mask đổi —
        rất hay rơi đúng lúc chữ đang HIỆN DỞ nên đọc ra rác (đo thật: `DUSOL人的咸`, `南瓜磁`,
        `拉背景赶车人的枝条直`). Ở chế độ này đọc kèm ĐIỂM TIN CẬY và chỉ nhận khi ≥ OCR_CUU_SCORE
        (mặc định 0.90) — đường thường KHÔNG bị siết, giữ nguyên hành vi cũ."""
        _s = _tm.perf_counter()
        _mb = m > 0.4
        txt = None
        _detbox = None        # hộp det (pixel trong crop) nếu nhánh det+rec chạy — xem chỗ dùng ở dưới
        if cache_on:                                         # #3 mask ~trùng câu OCR gần đây → DÙNG LẠI text (khỏi OCR + hết drift)
            for _cm, _ct in _ocr_cache:
                if _iou(_mb, _cm) >= 0.97:
                    txt = _ct; pr["hit"] += 1; break
        if txt is None:
            if os.environ.get("OCR_WHITE", "0") == "1":      # OPT-IN: test thật cho thấy mask-clean HẠI accuracy
                # (recognizer đọc ảnh xám-whiten kém hơn ảnh gốc) → mặc định TẮT; chỉ bật cho video nền-nhiễu-nặng.
                txt, _sc = _ocr_clean(band, _mk, eng, np, cv2)
                if (not txt) or _sc < 0.80:                   # mờ/kém → fallback dải MÀU thô, chọn bản tin-cậy hơn
                    _t2, _s2 = _doc_rec_sc(_trim_band(band, np, cv2), eng)
                    if _s2 > _sc:
                        txt = _t2
            elif nghiem:
                txt, _sc_cuu = _doc_rec_sc(_trim_band(band, np, cv2), eng)
                try:
                    _nguong_cuu = float(os.environ.get("OCR_CUU_SCORE", "0.90") or 0.90)
                except ValueError:
                    _nguong_cuu = 0.90
                if _sc_cuu < _nguong_cuu:
                    pr["cuu_bo"] = pr.get("cuu_bo", 0) + 1
                    return False                                # đọc không chắc → THÀ BỎ còn hơn sinh cue rác
            elif _doc_det:
                # DÒ HỘP KHÍT NGAY TRONG PHA ĐỌC (thử nghiệm cho chế độ bỏ Pha 2): pha đọc vốn dùng rec-only vì
                # TIN Pha 2 đã cắt sẵn khít 1 dòng. Bỏ Pha 2 thì crop là cả DẢI → recognizer đọc sai chữ.
                # Ở đây chạy det+rec ngay trên dải: det tự khoanh đúng dòng rồi rec đọc từng dòng khít.
                # Chỉ chạy ~800 lần (khi mặt-nạ báo chữ ĐỔI), không phải mỗi khung.
                _xong_nhanh = False
                # 🔬 ĐẾM LÝ DO PHẢI LÙI VỀ det+rec (14/08/2026). Đường lùi đắt ~14× (0,411s vs 0,029s) và
                # ĐO THẬT trên video 29': 670 rec-only + **321 det** ⇒ 321 lời gọi đó ăn ~87% pha đọc.
                # Nhưng `_hy_redet=15` nghĩa là re-det THEO LỊCH chỉ ~670/15 ≈ 45 lượt ⇒ **~276 lượt (86%)
                # là BỊ LOẠI**, không phải theo lịch. Muốn tối ưu đúng chỗ thì phải biết bị loại VÌ SAO.
                # Thuần ĐẾM, không đổi một byte hành vi nào.
                _ly_do = ("hybrid_tat" if not _hybrid else
                          "chua_khoa_roi" if _roi_y[0] is None else
                          "toi_lich_redet" if _roi_dem[0] >= _hy_redet else "?")
                if _hybrid and _roi_y[0] is not None and _roi_dem[0] < _hy_redet:
                    # ĐƯỜNG NHANH: ROI (chiều cao dòng) đã khoá từ det → chỉ cần dò X rồi rec-only trên hộp khít.
                    _cy0, _cy1 = _roi_y
                    if 0 <= _cy0 < _cy1 <= band.shape[0] and (_cy1 - _cy0) >= 12:
                        _sub = band[_cy0:_cy1, :]
                        _xx = _khit_x(_sub, np, cv2)
                        if _xx is not None:
                            # ⚠️ SỬA CHÚ THÍCH SAI (12/08/2026). Bản trước ghi *"GPU: đưa CẢ dòng vào rec
                            # thay vì hộp khít"* — code chưa bao giờ làm thế, nó LUÔN cắt khít `_xx`. Đó là
                            # bản vá "lần 2" đã bị gỡ (cũng đo ra lãi = 0) mà chữ thì ở lại. Cùng lớp với
                            # chú thích sai ở `_trim_band`; xem docstring hàm đó.
                            # Cắt khít vì hộp `_xx` vừa cho ảnh hẹp (rec nhanh hơn) vừa LÀ hộp CHE (`_detbox`
                            # ngay dưới) — một phép dò dùng cho hai việc.
                            _anh_hy = _sub[:, _xx[0]:_xx[1]]
                            _s_hy = _tm.perf_counter()
                            _t_hy, _sc_hy = _doc_rec_sc(_anh_hy, eng)
                            _d_hy = _tm.perf_counter() - _s_hy
                            pr["t_hyrec"] += _d_hy
                            pr["n_hyrec"] += 1          # ĐI CẶP với t_hyrec (xem chú thích chỗ khai báo)
                            # GHI KÍCH THƯỚC THẬT + giờ từng lần: đo hàm này NGOÀI pipeline ra 0,013 s/lần
                            # nhưng TRONG pipeline 1,394 s/lần (100×). Đã loại 8 giả thuyết bằng đo; giờ phải
                            # nhìn chính đầu vào thật thay vì dựng lại nó bằng tay. Chỉ ghi khi OCR_PROFILE=1.
                            if _PROF:
                                # ghi KÈM số ký tự đọc được: nghi cụm 0,01s là những lần rec KHÔNG thấy chữ
                                # (thoát sớm), cụm 1,0s là lần CÓ chữ thật. Đây là giả thuyết cuối còn lại.
                                # + SCORE (12/08/2026): đo 4 video thật thấy tỉ lệ bản đọc ĐƯỢC NHẬN dao động
                                # 43-95%; video nào tỉ lệ thấp thì mỗi lần bị loại lại lùi sang `det+rec` đắt
                                # gấp ~14× (0,411s vs 0,029s) ⇒ 89% thời gian OCR của video đó là HẬU QUẢ của
                                # việc rec bị loại, không phải rec chậm. Muốn biết ngưỡng `_hy_score`=0,90 có
                                # quá gắt không thì phải nhìn CHÍNH phân bố score, chứ không suy.
                                pr.setdefault("hy_mau", []).append(
                                    (_anh_hy.shape[0], _anh_hy.shape[1], round(_d_hy, 3),
                                     len((_t_hy or "").strip()), round(float(_sc_hy or 0.0), 3)))
                            if _t_hy and _sc_hy >= _hy_score:
                                txt = _t_hy
                                _detbox = (_cy0, _cy1, _xx[0], _xx[1])   # hộp CHE vẫn khít như det
                                _roi_dem[0] += 1
                                pr["hy_rec"] = pr.get("hy_rec", 0) + 1
                                _xong_nhanh = True
                            else:
                                _ly_do = "rec_rong" if not _t_hy else "score_thap"
                        else:
                            _ly_do = "khit_x_khong_thay_chu"
                    else:
                        _ly_do = "roi_khong_hop_le"
                if not _xong_nhanh:                      # bất thường (rỗng/score thấp/không thấy chữ) hoặc tới hạn re-det
                    pr["ly_do"] = pr.get("ly_do") or {}
                    pr["ly_do"][_ly_do] = pr["ly_do"].get(_ly_do, 0) + 1
                    _s_dr = _tm.perf_counter()
                    if _det_tiny:
                        # 🔬 TINY DET → SMALL REC (14/08/2026, thử nghiệm — env OCR_DET_TINY=1).
                        # Ý: `det` chỉ cần TÌM HỘP, không cần đọc chữ ⇒ để TINY làm; `rec` mới quyết chất
                        # lượng CHỮ ⇒ giữ SMALL. Giá lý thuyết 0,411s → ~0,12+0,029. ⚠ NHƯNG nó biến 1 lời
                        # gọi thành 2, mà phép đo phân xử 14/08 đã chứng minh SỐ LỜI GỌI mới là biến lớn
                        # ⇒ phép cộng trên KHÔNG đủ để kết luận, BẮT BUỘC đo end-to-end.
                        # ⚠ Bẫy thứ hai: tiny khoanh hộp kém hơn ⇒ có thể làm TĂNG số lượt lùi ở các khung
                        # sau (ROI khoá bị cập nhật bằng hộp xấu). Vì thế `pr["ly_do"]` ở trên phải được so
                        # giữa hai bản, KHÔNG chỉ nhìn tổng thời gian.
                        _tx_t, _detbox = _doc_det_rec(band, _engine_dinh_vi())
                        txt = ""
                        if _detbox:
                            _b0, _b1, _b2, _b3 = (int(_detbox[0]), int(_detbox[1]),
                                                  int(_detbox[2]), int(_detbox[3]))
                            if 0 <= _b0 < _b1 <= band.shape[0] and 0 <= _b2 < _b3 <= band.shape[1]:
                                txt, _ = _doc_rec_sc(band[_b0:_b1, _b2:_b3], eng)
                        if not txt:
                            txt = _tx_t     # small rec không ra chữ → giữ bản tiny (thà lem còn hơn MẤT CÂU)
                            pr["tiny_giu"] = pr.get("tiny_giu", 0) + 1
                    else:
                        txt, _detbox = _doc_det_rec(band, eng)
                    pr["t_detrec"] += _tm.perf_counter() - _s_dr
                    pr["n_detrec"] += 1                 # ĐI CẶP với t_detrec (xem chú thích chỗ khai báo)
                    if _hybrid:
                        pr["hy_det"] = pr.get("hy_det", 0) + 1
                        _roi_dem[0] = 0
                        if _detbox:                       # mỗi lần det THẬT → cập nhật lại ROI khoá (bắt trôi vị-trí)
                            _roi_mau.append((int(_detbox[0]), int(_detbox[1])))
                            if len(_roi_mau) >= _hy_mau:
                                _m0 = sorted(z[0] for z in _roi_mau[-10:]); _m1 = sorted(z[1] for z in _roi_mau[-10:])
                                _roi_y[0] = max(0, _m0[len(_m0) // 2] - _hy_pad)
                                _roi_y[1] = min(band.shape[0], _m1[len(_m1) // 2] + _hy_pad)
            else:
                txt = _doc_rec(_trim_band(band, np, cv2), eng)   # MẶC ĐỊNH: dải màu thô (raw đọc tốt hơn)
            pr["ocr"] += 1
            if txt and cache_on:                             # lưu fingerprint mask → text
                _ocr_cache.append((_mb, txt))
                if len(_ocr_cache) > 12:
                    _ocr_cache.pop(0)
        pr["t_ocr"] += _tm.perf_counter() - _s
        txt = _loc_rac_ocr(txt)                       # lọc rác latin/số lẻ (phủ MỌI nhánh rec: _doc_rec + _doc_rec_sc)
        if nghiem and txt and segs:
            # CHẶN TRÙNG cho đường CỨU: khung được cứu hay rơi đúng lúc câu TRƯỚC đang tắt dần → đọc ra MẢNH
            # ĐUÔI của chính câu đó (đo thật: '拉背景赶车人的枝条直' ⊂ '镜头转到了薇拉 背景赶车人的枝条 直插薇拉
            # 的脑袋'). Thành cue riêng thì phụ đề hiện lặp + lồng tiếng đọc 2 lần. Bỏ dấu cách rồi kiểm bao hàm
            # 2 chiều — mảnh này lọt qua `_giong` vì tỉ lệ ký tự chung chỉ ~0.59, dưới ngưỡng 0.6.
            _a = "".join(str(txt).split())
            _b = "".join(str(segs[-1][2]).split())
            # 🐛 FIX (verify hợp nhất): kiểm bao hàm 2 CHIỀU vô điều kiện GIẾT OAN mẫu LẶP TU TỪ rất phổ biến
            # trong phụ đề Trung — `我` rồi `我什么我`, `你` rồi `你什么你`. Chiều `_b in _a` (cue trước NGẮN nằm
            # trong ứng viên DÀI hơn) khớp đúng mẫu đó → câu thật bị bỏ. Đo thật t.mp4: 9 ứng viên bị loại,
            # cơ chế cứu ra +0 câu, và `我什么我` (hiện 12.8-13.0s) MẤT dù đã trích khung xác nhận trên màn
            # hình đó là 2 câu KHÁC NHAU (t=12.60 hiện `我`, t=12.80 hiện `我什么我`), không phải OCR đọc dần.
            # Giữ NGUYÊN chiều `_a in _b` (ứng viên là MẢNH ĐUÔI của câu trước — đúng thứ luật này sinh ra để
            # chặn, vd `拉背景赶车人的枝条直` ⊂ câu dài). Chiều ngược lại chỉ chặn khi cue trước đủ DÀI để là
            # câu thật (≥ OCR_CUU_TRUM_MIN, mặc định 4 ký tự) — cue trước 1-3 ký tự không được quyền giết một
            # câu dài hơn nó.
            try:
                _min_trum = int(os.environ.get("OCR_CUU_TRUM_MIN", "4") or 4)
            except ValueError:
                _min_trum = 4
            if _a and _b and (_a in _b or (_b in _a and len(_b) >= _min_trum)):
                pr["cuu_trung"] = pr.get("cuu_trung", 0) + 1
                return False
        if not txt:
            # REC RỖNG (chữ đang fade-in / 1 frame nhiễu) → KHÔNG chốt prev_mask/pend → nhịp SAU OCR LẠI.
            # (Trước: chốt prev_mask TRƯỚC khi check txt → OCR rỗng 1 lần là MẤT câu vĩnh viễn — sót sub đầu.)
            return False
        # (prev_mask/pend do caller đặt theo giá trị trả về)                                 # chỉ chốt câu KHI OCR RA CHỮ
        ry0 = max(0.0, y0 - 0.006); ry1 = min(1.0, y1 + 0.008)   # box = dải đoạn (rec-only không trả box)
        rx0 = max(0.0, x0 - 0.01); rx1 = min(1.0, x1 + 0.01)
        # NẾU nhánh det+rec chạy → dùng HỘP DET (khít quanh chữ THẬT của chính câu này) thay cho hộp đoạn.
        # Quan trọng khi bỏ pha dò: `cand` khi đó chỉ là 1 dải phủ cả video nên hộp đoạn = cả dải, dải che
        # TĨNH (localize fit theo min/max hộp) sẽ bị rộng oan. Có hộp det thì fit vẫn sát như khi còn pha dò.
        if _detbox:
            try:
                _py0 = max(0, int((y0 - 0.025) * H)); _px0 = max(0, int((x0 - 0.04) * W))
                ry0 = max(0.0, (_py0 + _detbox[0]) / float(H) - 0.006)
                ry1 = min(1.0, (_py0 + _detbox[1]) / float(H) + 0.008)
                rx0 = max(0.0, (_px0 + _detbox[2]) / float(W) - 0.01)
                rx1 = min(1.0, (_px0 + _detbox[3]) / float(W) + 0.01)
                _det_lich.append((ry0, ry1))
            except Exception as _e_db:
                log("⚠ Đổi toạ độ hộp det lỗi (%s) → dùng hộp đoạn." % type(_e_db).__name__)
        elif len(_det_lich) >= 3:
            # det KHÔNG cho hộp hợp lệ (hộp trùm bị loại) → ĐỪNG lùi về hộp đoạn: khi đã bỏ pha dò, hộp đoạn
            # chính là CẢ DẢI phủ video ⇒ chỉ một cue như vậy là kéo dải che cao lên (localize lấy min/max).
            # Dùng CHIỀU CAO TRUNG VỊ của các cue đã nhận, đặt quanh tâm dải — phụ đề đứng yên theo chiều dọc
            # nên trung vị là ước lượng tốt. ĐO clip3p: 1 cue ('好的') kéo dải từ y0.892-0.978 thành 0.857-1.000.
            _l0 = sorted(z[0] for z in _det_lich); _l1 = sorted(z[1] for z in _det_lich)
            ry0, ry1 = _l0[len(_l0) // 2], _l1[len(_l1) // 2]
        # GỘP re-read cùng 1 hardsub: (1) CÙNG ĐOẠN cand → looser _iv_merge (kể cả drift nặng), KHÔNG cần gap;
        # (2) khác đoạn nhưng _giong + gap≤2.0 (re-read FSM-cách-quãng). → fix regression e4e02b6 (gap≤1.2 +
        # re-OCR-giữa-câu tách cùng-sub thành nhiều cue = TRÙNG). Cũ: 1 OCR/đoạn → không trùng.
        ivm = os.environ.get("OCR_IVMERGE", "1") == "1"
        # 🐛 "CÙNG ĐOẠN cand" chỉ có nghĩa khi cand chia THEO CÂU. Từ khi dò-dải trả MỘT đoạn phủ cả video
        # (chế độ bỏ pha dò), `si` LUÔN = 0 ⇒ same_iv LUÔN đúng ⇒ nhánh gộp bỏ qua ràng buộc khoảng cách và
        # gộp nhầm các câu CÁCH XA NHAU suốt video. ĐO THẬT: 001.mp4 44 cue → 21, khớp 0/44; 003.mp4 18 → 3.
        # Đoạn phủ ~cả video thì KHÔNG được coi là "cùng câu" — quay về đúng luật gap như đoạn khác.
        same_iv = ivm and bool(segs) and bool(cue_si) and cue_si[-1] == si and not _1_doan_ca_video
        gap = (t - boxes[-1][1]) if segs else 999.0
        # gộp re-read/HIỆN-DẦN cùng 1 dòng: _iv_merge khi CÙNG đoạn (mọi gap) HOẶC khác đoạn nhưng SÁT (gap≤1.5
        # — phụ đề hiện dần từng chữ làm ảnh đổi nhiều → dai_sub tách đoạn, nhưng vẫn cùng 1 câu); + _giong gap≤2.0
        if segs and ((ivm and _iv_merge(txt, segs[-1][2]) and (same_iv or gap <= 1.5))
                     or (_giong(txt, segs[-1][2]) and gap <= 2.0)):
            pr["merged"] += 1
            # BỎ PHIẾU THEO THỜI GIAN: cùng 1 dòng hardsub được đọc nhiều lần (2-6 lần là bình thường) →
            # gom MỌI bản đọc rồi chốt ở cuối bằng đa số, thay vì heuristic cũ "giữ bản DÀI hơn".
            # Vì sao đổi: "dài hơn" chọn SAI đúng kiểu lỗi OCR hay gặp — đọc '快跑吧' 2 lần + '1.快跑吧' 1 lần
            # (nhiễu thành ký tự thừa ở đầu) thì bản RÁC lại dài hơn nên thắng. Đa số thì chọn đúng.
            # Bản đọc vẫn được giữ đủ trong `variants` để _chot_bo_phieu() quyết ở cuối (xem hàm đó).
            _kv = (id(segs), len(segs) - 1)          # mỗi làn có list segs RIÊNG → khoá theo id(list)+chỉ số
            _ds = _phieu.setdefault(_kv, [segs[-1][2]])
            _ds.append(txt)
            keep = _chot_bo_phieu(_ds)
            segs[-1] = (segs[-1][0], t, keep)
            pb = boxes[-1]
            # HỘP = BAO TRÙM cả vòng đời dòng (min/max) → phụ đề hiện-dần rộng dần thì che (blur động CHE_DONG=1)
            # phủ ĐỦ bề rộng chữ, không hụt. Vị-trí xác định 1 lần/dòng dùng cho cả timing lẫn che.
            boxes[-1] = (pb[0], t, min(pb[2], ry0), max(pb[3], ry1), min(pb[4], rx0), max(pb[5], rx1))
        else:
            pr["new"] += 1
            # t_on = t_new (lúc chữ vừa HIỆN) thay vì t (sau trễ hysteresis ~0.5s) → phụ đề Việt hiện SỚM đúng
            # nhịp gốc. Cho phép t_new=0.0 (chữ có từ FRAME ĐẦU): trước dùng '0.0<' (lớn hơn nghiêm) loại t_new=0.0
            # → cue ĐẦU rơi về t = trễ 1 nhịp kiểm (~0.25s) so với chữ Trung. '0.0<=' để cue đầu hiện đúng 0.0.
            # BACKDATE có GIỚI HẠN: t_new = frame ĐẦU mask đổi = lúc chữ VỪA fade-in (còn MỜ), CÁCH t (lúc OCR
            # đọc RÕ) đúng bằng thời-gian-fade-in. Video truyện AI Trung fade-in ~0.6-0.8s → backdate NGUYÊN về
            # t_new làm sub Việt hiện SỚM 0.6-0.8s so với chữ Trung gốc trên hình (đo thật 3 video: 0.60/0.66/0.80s).
            # → CHẶN lùi tối đa OCR_BACKDATE_MAX giây (mặc định 0.3 = ~1 nhịp chk, đủ bù trễ hysteresis/granularity
            # mà KHÔNG ăn cả khoảng fade-in dài). t_new gần t (chữ hiện dứt khoát) → giữ nguyên; t_new xa (fade-in
            # dài) → chỉ lùi 0.3s. OCR_BACKDATE=0 tắt hẳn (dùng t = muộn nhất, không bao giờ sớm).
            try:
                _bd_max = float(os.environ.get("OCR_BACKDATE_MAX", "0.3") or 0.3)
            except ValueError:
                _bd_max = 0.3
            if os.environ.get("OCR_BACKDATE", "1") == "1" and 0.0 <= t_new <= t:
                t0 = max(t_new, t - _bd_max)      # lùi về t_new nhưng KHÔNG quá _bd_max giây trước t
            else:
                t0 = t
            # BÙ TRỄ granularity — XÁC ĐỊNH độ trễ, không đoán: onset chỉ bắt được tại mốc KIỂM (mỗi chk frame =
            # OCR_CHK giây). Chữ thật hiện ở đâu đó trong (mốc-kiểm-trước, t_new] → độ trễ ~PHÂN BỐ ĐỀU, kỳ vọng
            # = ½ khoảng-kiểm = chk/(2·fps). Lùi t_on đúng bằng ĐÓ (tính từ fps+chk THẬT của video) → sub Việt
            # hiện đúng nhịp chữ Trung. Hệ số OCR_SUB_LEAD (mặc định 0 = tắt — trước 0.5 nhưng cộng dồn với
            # backdate làm sớm thêm; giờ backdate đã chặn nên KHÔNG cần lead nữa). 1.0 = lùi cả nhịp.
            # CHỈ lùi khi KHÔNG chồng câu trước. Áp cho CẢ box (blur) bên dưới → blur+sub vẫn đồng bộ.
            _lead = (chk / fps) * float(os.environ.get("OCR_SUB_LEAD", "0") or 0)
            if _lead > 0 and (t0 - _lead) >= (segs[-1][1] if segs else 0.0):
                t0 = max(0.0, t0 - _lead)
            if segs and t0 < segs[-1][1]:
                t0 = t
            # ⚡ CHỐT cue TRƯỚC ĐÓ. Vì sao AN TOÀN — cả hai phép sửa-sau đều CHỈ đụng phần tử CUỐI:
            #   · gộp re-read/hiện-dần : chỉ xét `segs[-1]` (`cue_si[-1] == si`, `boxes[-1][1]`)
            #   · nới mốc kết           : `segs[-1] = (segs[-1][0], t, segs[-1][2])`
            # ⇒ Khi cue MỚI được thêm, cue liền trước KHÔNG THỂ bị đụng nữa — chốt cả TEXT lẫn MỐC KẾT.
            # Trễ đúng MỘT cue, không phải chờ hết đoạn/hết video ⇒ đủ để dịch chạy chồng lên OCR.
            # ⚠ Cue chốt ở đây VẪN có thể bị các tầng lọc SAU vòng đọc bỏ (title-card / `_loai_vung_tay`) hoặc
            #   ĐỔI TEXT (`_go_chu_nen_tang` gỡ tên nền-tảng). Bên nhận phải chịu được điều đó: dịch/đọc dư
            #   một cue rồi bỏ thì chỉ phí công, KHÔNG ra sai — đừng dùng `on_chot` làm nguồn sự thật cuối.
            if on_chot and segs:
                try:
                    _pt0, _pt1, _ptx = segs[-1]
                    on_chot(len(segs), _pt0, _pt1, _ptx)
                except Exception:
                    pass          # bên nhận hỏng KHÔNG được phép làm hỏng vòng đọc OCR
            segs.append((t0, t, txt))                 # câu MỚI
            boxes.append((t0, t, ry0, ry1, rx0, rx1))
            cue_si.append(si)
            if on_seg:
                on_seg(len(segs), t0, t, txt)
            if len(segs) % 100 == 0:               # mỗi 100 câu → log mốc (người dùng dễ theo dõi + thanh % nhích)
                _elc = _tm.perf_counter() - _run0
                _etc = (_elc * nfr / fidx - _elc) if (fidx > 0 and nfr > 0) else 0.0
                log("📖 Đã đọc %d câu · %d/%d khung · ETA~%.0f phút" % (len(segs), fidx, nfr, _etc / 60.0))
        return True

    # 🐛 FIX (audit — tái hiện bằng mô phỏng chính vòng đọc dưới): vòng đọc dùng CON TRỎ `si` CHỈ TIẾN và
    # `fidx` chỉ tăng (cố ý: KHÔNG seek per-mốc vì cap.set là O(n) → O(n²) treo). Hệ quả: 2 đoạn cand CHỒNG
    # THỜI GIAN thì đoạn sau bị BỎ SẠCH, 0 lần OCR — vì khi `fidx > fb` của đoạn trước, con trỏ nhảy sang đoạn
    # kế mà mốc thời gian đã trôi qua nó rồi. Đo thật: sub 2 DÒNG → đọc 2/4 đoạn (mất dòng dưới); title-card
    # (0-8s) + thoại (1-3s, 3.5-6s) → title-card NUỐT cả 2 cue thoại. Đây là nguyên nhân mất sub mang tính hệ
    # thống nhất (che cũng mất theo vì boxes sinh từ chính vòng này).
    # CÁCH SỬA (giữ NGUYÊN 100% logic vòng đã kiểm chứng): chia cand thành các LÀN không chồng nhau, quét lại
    # mỗi làn (tua cap về 0 giữa các làn — 2-3 lần seek, KHÔNG phải per-mốc nên không dính bug O(n²)). Video
    # thường chỉ 1 làn → chạy y hệt trước, 0 thay đổi hành vi/chi phí. Tắt: OCR_DA_LAN=0.
    # 🐛 FIX (regression do CHÍNH fix đa-làn gây ra, audit bắt được): vòng làn dưới gán `cand = _cand_lan`
    # → GHI ĐÈ biến `cand` của cả hàm. Sau vòng, khối CHE SONG NGỮ (cuối hàm) vẫn đọc `cand` nhưng lúc đó
    # nó chỉ còn LÀN CUỐI, không phải toàn bộ dải dò được → box dòng tiếng Anh KHÔNG được bổ sung → chữ Anh
    # LỘ NGUYÊN dù dịch đúng. Giữ bản gốc để khối đó dùng.
    _cand_goc = list(cand)
    # KHÔNG OCR DẢI TITLE-CARD (vùng ĐỈNH khung) — chúng chồng thời gian với sub chính nên ép vòng đọc mở thêm
    # LÀN, mà mỗi làn = 1 lượt giải mã TOÀN VIDEO. Trong khi text của chúng bị CHÍNH hàm này loại khỏi lời thoại
    # ở dưới bằng đúng ngưỡng `CHE_DONG_YMIN` → đọc xong vứt đi.
    # DÙNG LẠI ĐÚNG NGƯỠNG ĐÓ (không đặt ngưỡng mới) ⇒ CHỨNG MINH ĐƯỢC không mất chữ: chỉ bỏ OCR những dải mà
    # cue của chúng chắc chắn bị tầng dưới xoá. Box vẫn được cấp cho CHE (thêm vào `boxes` sau tầng lọc đó).
    # ĐO THẬT video khách (678s/20349 khung): 633 dải → 4 làn (574/32/22/5) = giải mã 4 LƯỢT; 220/224 cặp chồng
    # là chữ-đỉnh (yc 0.08-0.16) đè sub-đáy (y~0.93); SỐ CẶP SUB-2-DÒNG = 0. Bỏ 13 dải đỉnh → 620 dải, ĐÚNG 1 LÀN.
    # ⚠ ĐÃ THỬ ngưỡng TƯƠNG ĐỐI "lệch >2.2× cao-dòng so với sub chính" và BỊ LOẠI: video 003.mp4 có cao-dòng chỉ
    # 0.036 nên ngưỡng thành 0.078, cắt nhầm THOẠI THẬT ở y~0.55 ('沙沙如！！什么情况？！') → mất 1 cue. Ngưỡng
    # TUYỆT ĐỐI theo đỉnh khung mới an toàn. Tắt: OCR_DAI_PHU_CHE=0 (hoặc CHE_DONG_YMIN=0 — cùng tắt cả 2 tầng).
    try:
        _ymin = float(os.environ.get("CHE_DONG_YMIN", "0.18") or 0.18)
    except ValueError:
        _ymin = 0.18
    _dai_phu = []
    if os.environ.get("OCR_DAI_PHU_CHE", "1") != "0" and _ymin > 0 and len(cand) > 1:
        _giu = []
        for _x in cand:
            (_dai_phu if (_x[2] + _x[3]) / 2.0 < _ymin else _giu).append(_x)
        if _dai_phu and _giu:                             # phải còn dải để đọc, không thì giữ nguyên
            log("👁 %d dải chữ vùng đỉnh (y<%.2f = title-card) → CHE thôi, không OCR: text của chúng vốn bị "
                "loại khỏi lời thoại, đọc chỉ tốn thêm lượt quét." % (len(_dai_phu), _ymin))
            cand = _giu
        else:
            _dai_phu = []
    _lanes = [cand]
    if os.environ.get("OCR_DA_LAN", "1") != "0" and len(cand) > 1:
        _lanes = []
        for _s in cand:                                   # cand đã sort theo t_on
            for _ln in _lanes:
                if _ln[-1][1] <= _s[0]:                   # làn này đã kết thúc trước khi đoạn mới bắt đầu
                    _ln.append(_s); break
            else:
                _lanes.append([_s])                       # không làn nào nhận → mở làn mới
        if len(_lanes) > 1:
            log("👁 %d dải chữ CHỒNG thời gian (sub nhiều dòng) → %d làn, đọc chung 1 lượt giải mã."
                % (len(cand), len(_lanes)))
    _segs_all, _boxes_all = [], []
    log("📖 Đang đọc phụ đề (OCR)…")   # để thanh % RỜI 1% ngay + video dài không "đứng"
    try:
        # 1 LƯỢT GIẢI MÃ CHO MỌI LÀN (trước: làn 2+ tua video về khung 0 rồi quét LẠI TỪ ĐẦU). Mỗi làn giữ
        # trạng thái RIÊNG (con trỏ đoạn, mask câu đang hiện, hysteresis, cache, segs/boxes); vòng ngoài chỉ đi
        # TIẾN theo khung: khung nào có ≥1 làn tới nhịp kiểm thì read() ĐÚNG 1 lần rồi đưa cho các làn đó,
        # không làn nào cần thì grab() (rẻ). Video 1 làn → chuỗi grab/read/OCR y HỆT bản cũ, 0 thay đổi.
        # Video 2 làn (sub 2 dòng/title-card) → giải mã 1 lần thay vì 2, số lần OCR KHÔNG đổi.
        # Đo trên máy khách (video 678s/20349 khung, 2 làn): pha đọc chạy hết lượt 1 tới 19272/20349 rồi NHẢY
        # VỀ 3001/20349, ETA từ ~0 vọt lên 14 phút — đúng lượt giải mã thứ 2.
        # KHÔNG gộp 2 làn thành 1 hộp cao hơn được: `_doc_rec` là recognizer đọc theo DÒNG, crop chứa 2 dòng
        # chồng nhau ra chữ rác.
        _st = [{"cand": _cl, "si": 0, "next_chk": 0, "pend": 0, "prev_mask": None, "t_new": 0.0,
                "uv": None, "segs": [], "boxes": [], "cue_si": [], "cache": []} for _cl in _lanes]
        fidx = 0
        while True:
            if (_tm.perf_counter() - _last_log) > 20.0:   # log tiến độ mỗi 20s (LUÔN bật — video dài không "đứng 1%")
                _last_log = _tm.perf_counter()
                _el = _last_log - _run0
                _eta = (_el * nfr / fidx - _el) if fidx > 0 and nfr > 0 else 0.0
                _cpu_txt = ""
                if _cpu_mon is not None:
                    try:
                        _cpu_pct = _cpu_mon.phan_tram()
                        if _cpu_pct is not None:
                            _cpu_txt = " · CPU%d%%" % _cpu_pct
                    except Exception:
                        pass
                log("⏳ %d/%d khung · OCR=%d skip=%d new=%d · loop %.0fs · ETA~%.0f phút%s"
                    % (fidx, nfr, pr["ocr"], pr["skip"], pr["new"], _el, _eta / 60.0, _cpu_txt))
            _can, _con = [], False
            for _ln in _st:
                _c = _ln["cand"]
                while _ln["si"] < len(_c) and fidx > int(_c[_ln["si"]][1] * fps):
                    _ln["si"] += 1                            # qua đoạn → đoạn kế (reset so-sánh dải)
                    _ln["prev_mask"] = None; _ln["pend"] = 0; _ln["uv"] = None
                if _ln["si"] >= len(_c):
                    continue                                  # làn này đã đọc hết đoạn
                _con = True
                if fidx >= int(_c[_ln["si"]][0] * fps) and fidx >= _ln["next_chk"]:
                    _can.append(_ln)
            if not _con:
                break                                         # mọi làn đã hết đoạn
            # ĐÃ ĐO, ĐỪNG đổi sang cap.set(POS_FRAMES) để "nhảy thẳng": seek trên H.264 ĐẮT HƠN NHIỀU so
            # với grab tuần tự (clip 60s/1837 khung, cùng số điểm đọc):
            #     mốc mỗi  7 khung (263 điểm): grab 2.24s | seek 21.94s  (chậm 9.8×)
            #     mốc mỗi 15 khung (123 điểm): grab 1.70s | seek 10.15s  (chậm 6.0×)
            #     mốc mỗi 30 khung ( 62 điểm): grab 1.47s | seek  4.67s  (chậm 3.2×)
            # Lý do: mỗi seek phải quay về keyframe rồi giải mã lại tới đúng khung; grab chỉ giải mã tiếp.
            if not _can:                                      # chưa làn nào tới nhịp kiểm → grab tuần tự (rẻ)
                _s = _tm.perf_counter()
                g = cap.grab()
                pr["t_dec"] += _tm.perf_counter() - _s; pr["grab"] += 1
                if not g:
                    break
                fidx += 1
                continue
            _s = _tm.perf_counter()
            ok, fr = cap.read()
            pr["t_dec"] += _tm.perf_counter() - _s; pr["read"] += 1
            if not ok or fr is None:
                break
            for _w in _wm_px:                          # tô phẳng ô chữ TĨNH → mặt-nạ/OCR không thấy gì ở đó
                _a0 = max(0, int(_w[0] * H)); _a1 = min(H, int(_w[1] * H))
                _b0 = max(0, int(_w[2] * W)); _b1 = min(W, int(_w[3] * W))
                if _a1 > _a0 and _b1 > _b0:
                    fr[_a0:_a1, _b0:_b1] = 0
            t = fidx / fps
            for _ln in _can:
                _ln["next_chk"] = fidx + chk
            fidx += 1
            for _ln in _can:
                # rebind tên trong scope hàm → closure `_ocr_va_ghi` ghi vào ĐÚNG làn đang xử lý.
                # cache RIÊNG từng làn: 2 làn = 2 dòng chữ KHÁC nhau, dùng chung cache có thể trả text làn kia.
                segs, boxes, cue_si, _ocr_cache = _ln["segs"], _ln["boxes"], _ln["cue_si"], _ln["cache"]
                si = _ln["si"]
                a, b, y0, y1, x0, x1 = _ln["cand"][si]
                py0 = max(0, int((y0 - 0.025) * H)); py1 = min(H, int((y1 + 0.025) * H))
                px0 = max(0, int((x0 - 0.04) * W)); px1 = min(W, int((x1 + 0.04) * W))
                if py1 - py0 < 8 or px1 - px0 < 20:
                    continue
                band = fr[py0:py1, px0:px1]
                _s = _tm.perf_counter()
                # MẶT-NẠ CHỮ-TRẮNG (g>195): (1) white_ratio < wmin = KHÔNG có chữ ở dải → skip, KHÔNG OCR (khe câu);
                # (2) so mask với mask câu ĐANG HIỂN THỊ (KHÔNG phải frame-trước → không trôi tích lũy theo nền): đổi
                # > xthr = câu MỚI mới OCR. Mask cô lập chữ → nền ACTION động bị bỏ qua → "1 câu OCR ~1 lần".
                _g = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
                # mask = chữ TRẮNG CÓ VIỀN ĐEN (hardsub Trung) → loại nhiễu trắng KHÔNG viền (tia nước/cháy nổ/trời sáng):
                # pixel trắng (>195) mà GẦN pixel đen (<70 = viền) mới tính chữ → nền action sáng bị loại khỏi mask.
                _w = _g > 195
                if os.environ.get("OCR_NOUTLINE") == "1":
                    _mk = _w                                  # tắt viền → mask trắng thuần (A/B test)
                else:
                    _dk = cv2.dilate((_g < 70).astype(np.uint8), np.ones((7, 7), np.uint8))
                    _mk = _w & (_dk > 0)
                wr = float(_mk.mean())
                if wr < wmin:                                 # dải TRỐNG (không chữ) → khe câu → KHÔNG OCR
                    pr["t_diff"] += _tm.perf_counter() - _s
                    pr["skip"] += 1
                    if _ln["uv"] is not None:                 # CỨU: ứng viên vừa hiện đã tắt ngay → đọc lại khung đã giữ
                        _u = _ln["uv"]
                        if _ocr_va_ghi(_u["band"], _u["m"], _u["t_new"], t, _u["si"], *_u["xy"], nghiem=True):
                            pr["cuu"] = pr.get("cuu", 0) + 1
                        _ln["uv"] = None
                    _ln["pend"] = 0
                    _ln["prev_mask"] = None                   # sub kết thúc → câu kế là MỚI
                    continue
                m = cv2.resize(_mk.astype(np.float32), (200, 24), interpolation=cv2.INTER_AREA)
                if _ln["prev_mask"] is None:
                    same = False
                elif iou_on:
                    same = _iou(m > 0.4, _ln["prev_mask"] > 0.4) >= iou_same   # IoU ỔN ĐỊNH với viền/glow/anti-alias (mean-absdiff nhạy → re-OCR thừa)
                else:
                    same = float(np.abs(m - _ln["prev_mask"]).mean()) < xthr   # luồng cũ (mean absdiff)
                pr["t_diff"] += _tm.perf_counter() - _s
                if same:
                    _ln["pend"] = 0                           # về câu cũ → huỷ "đang đổi" (nền-rung thoáng qua)
                    _ln["uv"] = None                          # ứng viên chỉ là rung thoáng qua → bỏ, KHÔNG cứu
                    pr["skip"] += 1
                    if segs and boxes[-1][1] < t:             # mask chữ y nguyên → cùng câu, kéo dài t_off
                        segs[-1] = (segs[-1][0], t, segs[-1][2])
                        pb = boxes[-1]; boxes[-1] = (pb[0], t, pb[2], pb[3], pb[4], pb[5])
                    continue
                # CỨU CÂU NGẮN — ứng viên đang chờ mà khung này đã sang mask KHÁC HẲN nó ⇒ câu đó chỉ tồn tại
                # đúng 1 nhịp rồi tắt, chờ thêm là mất hẳn. Đọc NGƯỢC LẠI khung đã giữ (t_off = mốc hiện tại).
                if _cuu_ngan and _ln["uv"] is not None and not _mask_giong(m, _ln["uv"]["m"]):
                    _u = _ln["uv"]
                    if _ocr_va_ghi(_u["band"], _u["m"], _u["t_new"], t, _u["si"], *_u["xy"], nghiem=True):
                        pr["cuu"] = pr.get("cuu", 0) + 1
                        _ln["prev_mask"] = _u["m"]            # câu vừa cứu trở thành "câu đang hiện"
                        _ln["pend"] = 0                       # khung này là ứng viên MỚI so với câu vừa cứu
                    # 🐛 CỨU THẤT BẠI (đọc không đủ tin cậy) thì TUYỆT ĐỐI KHÔNG đụng `pend`: reset ở đây làm
                    # câu ĐANG tới mất lượt OCR của chính nhịp này (đáng ra pend đã đủ hyst) → mất cue thật.
                    # Đo được đúng lỗi này: c3 tụt 57→52 cue trước khi sửa.
                    _ln["uv"] = None
                _ln["pend"] += 1                              # mask KHÁC câu cũ → HYSTERESIS đợi ≥hyst nhịp xác nhận
                if _ln["pend"] == 1:
                    _ln["t_new"] = t                          # frame ĐẦU thấy mask mới = lúc chữ vừa HIỆN → t_on thật (trước trễ hysteresis + OCR-retry fade-in)
                    if _cuu_ngan:                             # GIỮ khung này lại phòng khi câu tắt trước khi đủ hyst
                        _ln["uv"] = {"band": band.copy(), "m": m, "t_new": t, "si": si, "xy": (y0, y1, x0, x1)}
                if _ln["pend"] < hyst:                        # mới 1 nhịp = nghi nền-rung thoáng qua → CHƯA OCR
                    pr["skip"] += 1
                    continue
                if not _ocr_va_ghi(band, m, _ln["t_new"], t, si, y0, y1, x0, x1):
                    continue
                _ln["pend"] = 0
                _ln["uv"] = None                              # ứng viên đã được đọc ở đường thường → khỏi cứu
                _ln["prev_mask"] = m                          # chỉ chốt câu KHI OCR RA CHỮ
        # 🐛 XẢ ỨNG VIÊN CÒN GIỮ KHI HẾT VIDEO — CÂU CUỐI BỊ MẤT ÂM THẦM (đo thật 01/08/2026).
        # "Cứu câu ngắn" (~:1230) chỉ chạy Ở NHỊP SAU: giữ khung tại pend==1, tới nhịp kế mới OCR ngược nếu
        # ứng viên đã biến mất. Hết video thì KHÔNG CÒN nhịp kế → khung đang giữ bị vứt, không ai đọc.
        # ⇒ Câu xuất hiện trong ~(hyst-1)×OCR_CHK giây CUỐI (mặc định 0.25s) KHÔNG BAO GIỜ vào .zh.srt.
        # Đo được: video 34s, quét mặc định 15 cue vs quét dễ dãi 16 — cue thiếu là "等墨菲迷迷糊糊的走下车"
        # tại 33.44s/33.7s = ĐÚNG câu cuối. Không phải lỗi ngưỡng (nới cả 3 cổng vẫn thiếu ở đường thường)
        # mà là THIẾU BƯỚC XẢ. Dùng `nghiem=True` y hệt đường cứu giữa chừng (đọc kỹ hơn, tránh rước rác).
        for _ln in _st:
            _u = _ln.get("uv")
            if _u:
                try:
                    _ocr_va_ghi(_u["band"], _u["m"], _u["t_new"], _u["t_new"], _u["si"], *_u["xy"], nghiem=True)
                except Exception:
                    pass
                _ln["uv"] = None
        # XẢ cue CUỐI của mỗi làn: luật chốt là "cue N chốt khi cue N+1 tới", nên cue cuối cùng KHÔNG BAO GIỜ
        # được chốt trong vòng lặp. Đo thật: 281/282 cue khớp, thiếu đúng 1 — chính là cue cuối.
        if on_chot:
            for _ln in _st:
                _sg = _ln.get("segs") or []
                if _sg:
                    try:
                        on_chot(len(_sg), _sg[-1][0], _sg[-1][1], _sg[-1][2])
                    except Exception:
                        pass
        for _ln in _st:                                       # gộp kết quả mọi làn (thứ tự làn giữ như cũ)
            _segs_all += _ln["segs"]; _boxes_all += _ln["boxes"]
    finally:
        cap.release()
    # gộp kết quả mọi làn rồi sắp lại theo thời gian (làn quét riêng nên thứ tự bị xen kẽ).
    # Giữ segs/boxes SONG SONG cùng thứ tự (boxes[i] ứng segs[i]) — tầng lọc title-card dưới dựa vào điều này.
    if len(_lanes) > 1 and _segs_all:
        _ghep = sorted(zip(_segs_all, _boxes_all), key=lambda z: z[0][0])
        segs = [z[0] for z in _ghep]; boxes = [z[1] for z in _ghep]
    else:
        segs, boxes = _segs_all, _boxes_all
    if _PROF:
        # CHIA CHO SỐ LƯỢT GỌI (n_*), KHÔNG phải số lượt được-nhận (hy_*) — xem chú thích chỗ khai báo `n_hyrec`.
        _n_hr = pr.get("n_hyrec", 0); _n_hd = pr.get("n_detrec", 0)
        _nhan_hr = pr.get("hy_rec", 0); _nhan_hd = pr.get("hy_det", 0)
        log("📊 PROFILE: detect=%.0fs | read=%d grab=%d skip(diff)=%d | OCR-call=%d new=%d cached=%d | "
            "decode=%.0fs diff=%.0fs trim=%.0fs ocr=%.0fs"
            % (pr["t_detect"], pr["read"], pr["grab"], pr["skip"], pr["ocr"], pr["new"], pr["merged"],
               pr["t_dec"], pr["t_diff"], pr["t_trim"], pr["t_ocr"]))
        # TÁCH `ocr=`: nó bao CẢ khối xử lý (mặt nạ, cache, dò X…), KHÔNG chỉ 2 lời gọi model. Không tách thì
        # rất dễ chia `ocr/OCR-call` rồi tưởng đó là giá một lời gọi — tôi đã suy nhầm đúng kiểu đó 11/08.
        log("📊 PROFILE-OCR: rec-only %d gọi (%d nhận)=%.0fs (%.3fs/gọi) · det+rec %d gọi (%d re-det)=%.0fs "
            "(%.3fs/gọi) · phần CÒN LẠI trong ocr=%.0fs"
            % (_n_hr, _nhan_hr, pr["t_hyrec"], (pr["t_hyrec"] / _n_hr if _n_hr else 0),
               _n_hd, _nhan_hd, pr["t_detrec"], (pr["t_detrec"] / _n_hd if _n_hd else 0),
               max(0.0, pr["t_ocr"] - pr["t_hyrec"] - pr["t_detrec"])))
        # 🔬 VÌ SAO phải lùi về det+rec — đường lùi đắt ~14× nên biết nó SINH TỪ ĐÂU mới tối ưu đúng chỗ.
        # `toi_lich_redet` = re-det theo lịch (`_hy_redet`, không tránh được); mọi lý do KHÁC là BỊ LOẠI
        # (có thể giảm bằng ngưỡng/thuật toán). So bảng này giữa 2 bản A/B, ĐỪNG chỉ nhìn tổng thời gian:
        # model dò hộp kém hơn có thể nhanh hơn mỗi lượt mà làm TĂNG số lượt lùi ⇒ lãi bị ăn hết.
        _ld = pr.get("ly_do") or {}
        if _ld:
            _tong_ld = sum(_ld.values()) or 1
            log("📊 PROFILE-LÙI: %d lượt · %s"
                % (_tong_ld, " · ".join("%s %d (%.0f%%)" % (k, v, 100.0 * v / _tong_ld)
                                        for k, v in sorted(_ld.items(), key=lambda z: -z[1]))))
        if pr.get("tiny_giu"):
            log("📊 TINY-DET: %d lượt small-rec KHÔNG ra chữ → giữ bản tiny (thà lem còn hơn mất câu)"
                % pr["tiny_giu"])
        _mau = pr.get("hy_mau") or []
        if _mau:
            _co = [z for z in _mau if z[3] > 0]          # lần rec RA CHỮ
            _kh = [z for z in _mau if z[3] == 0]         # lần rec KHÔNG ra chữ
            _tb = lambda L: (sum(z[2] for z in L) / len(L)) if L else 0.0
            _rg = lambda L: (sum(z[1] for z in L) / len(L)) if L else 0.0
            log("📊 PROFILE-ANH: CÓ chữ %d lần → %.3fs/lần (rộng TB %.0fpx) · KHÔNG chữ %d lần → %.3fs/lần "
                "(rộng TB %.0fpx)" % (len(_co), _tb(_co), _rg(_co), len(_kh), _tb(_kh), _rg(_kh)))
            log("📊 PROFILE-ANH 12 lần đầu (rộng=giây/sốkýtự): %s"
                % " ".join("%d=%.2f/%d" % (z[1], z[2], z[3]) for z in _mau[:12]))
            # PHÂN BỐ SCORE của bản đọc CÓ CHỮ — để biết `_hy_score` (mặc định 0,90) gắt hay vừa. Mỗi lần
            # bị loại là một lần lùi `det+rec`, đắt gấp ~14×; nếu phần lớn bản bị loại nằm sát ngưỡng
            # (0,80-0,90) thì hạ ngưỡng lấy lại được rất nhiều thời gian, còn nếu chúng nằm thấp hẳn thì
            # loại là ĐÚNG và đừng đụng vào. Không đoán — nhìn số.
            _sc = sorted(z[4] for z in _co if len(z) > 4)
            if _sc:
                _bucket = [("<0.50", 0.0, 0.50), ("0.50-0.80", 0.50, 0.80), ("0.80-0.90", 0.80, 0.90),
                           ("≥0.90 (nhận)", 0.90, 1.01)]
                log("📊 PROFILE-SCORE (ngưỡng nhận %.2f): %s · trung vị %.3f"
                    % (_hy_score,
                       " · ".join("%s %d (%.0f%%)" % (t, sum(1 for s in _sc if a <= s < b),
                                                      100.0 * sum(1 for s in _sc if a <= s < b) / len(_sc))
                                  for t, a, b in _bucket),
                       _sc[len(_sc) // 2]))
    # CỨU CÂU NGẮN: báo số câu cứu được + số lần bị 2 lưới lọc chặn — để chẩn đoán được trên máy khách mà
    # không cần bật PROFILE (chỉ in khi cơ chế thật sự có hoạt động, video thường không có dòng này).
    if pr.get("cuu") or pr.get("cuu_bo") or pr.get("cuu_trung"):
        log("🩹 Cứu câu ngắn: +%d câu (bỏ %d vì đọc không chắc, %d vì trùng câu trước)"
            % (pr.get("cuu", 0), pr.get("cuu_bo", 0), pr.get("cuu_trung", 0)))
    # HYBRID: tỉ lệ đường-nhanh vs lùi-det — số cần theo dõi để quyết có nên bật mặc định hay không.
    if pr.get("hy_rec") or pr.get("hy_det"):
        _hr, _hd = pr.get("hy_rec", 0), pr.get("hy_det", 0)
        log("⚡ OCR hybrid: %d rec-only + %d det (%.0f%% bỏ được detector)"
            % (_hr, _hd, 100.0 * _hr / max(1, _hr + _hd)))
    # BỎ CỤM CUE LẶP CÙNG NỘI DUNG (watermark/logo) — phải chạy TRƯỚC tầng lọc title-card bên dưới, vì tầng đó
    # cắt `segs` mà giữ nguyên `boxes` (cố ý, để vẫn che) nên sau nó 2 mảng không còn song song chỉ số nữa.
    # GỠ CHỮ NỀN-TẢNG khỏi NỘI DUNG cue — chạy TRƯỚC `_loc_wm_lap`: gỡ xong thì cue vốn chỉ-là-watermark tự
    # rỗng và bị bỏ ngay tại đó, còn cue thoại DÍNH watermark giữ lại được phần thoại (thứ mà `_loc_wm_lap`
    # bỏ cả cue sẽ làm mất). Hai tầng bù nhau: tầng này theo NỘI DUNG, tầng dưới theo CỤM-Y.
    # VÙNG KHÁCH TỰ KHOANH chạy TRƯỚC 2 tầng tự-dò: khách đã chỉ thẳng thì không cần bằng chứng nội-dung, và
    # bỏ sớm giúp 2 tầng dưới khỏi phải cân nhắc cue mà khách vốn đã loại (vd banner bị `_loc_wm_lap` coi là
    # "cụm đông nhất = dải phụ đề" rồi tha oan).
    segs, boxes = _loai_vung_tay(segs, boxes, log=log)
    # ĐỨNG TRƯỚC `_go_chu_nen_tang`: bỏ hẳn cue-toàn-watermark trước thì tầng đếm tần suất bên dưới
    # không còn bị mấy cue đó kéo lệch thống kê.
    segs, boxes = _go_ten_kenh(segs, boxes, log=log)
    # ĐỨNG TRƯỚC `_go_chu_nen_tang`: gỡ dòng cảnh báo dính-chung ra khỏi text trước, thì tầng đếm tần
    # suất bên dưới mới nhìn thấy đúng nội dung thoại (và cue chỉ-còn-watermark mới lộ ra cho nó xử).
    segs, boxes = _go_dau_duoi_lap(segs, boxes, log=log)
    segs, boxes = _go_chu_nen_tang(segs, boxes, log=log)
    segs, boxes = _loc_wm_lap(segs, boxes, log=log)
    # LỌC TITLE khỏi TEXT/DUB (boxes CHE giữ nguyên): cand dò với loc_title=False nên boxes bao TRỌN chữ cao
    # (che sạch). Nhưng text vùng TRÊN (yc<CHE_DONG_YMIN) KHÔNG nên vào lời thoại/dub (title-card/biển → giọng
    # "ma" đọc tiêu đề — bug phim cũ). segs[i] cùng index boxes[i] → dùng y-center box lọc segs. Tắt: CHE_DONG_YMIN=0.
    # 🐛 FIX (bug video công thức đậu xanh): ngưỡng 0.30 QUÁ CAO → lọc oan SUB THẬT ở giữa-trên (y~0.26 sub thoại
    # video công thức/dọc) như title-card → 0 câu text → không dịch. Title-card THẬT ở ĐỈNH (y<0.18: tiêu đề cảnh
    # phim/banner). Hạ default 0.30→0.18: title đỉnh vẫn lọc, sub giữa-trên GIỮ (dịch được). Chỉnh: CHE_DONG_YMIN.
    # (_ymin đã đọc ở đầu hàm — dùng CHUNG với tầng bỏ-OCR-dải-đỉnh để 2 tầng không bao giờ lệch ngưỡng)
    if _ymin > 0 and len(segs) == len(boxes):
        _seg2 = [s for s, b in zip(segs, boxes) if (b[2] + b[3]) / 2.0 >= _ymin]
        if len(_seg2) < len(segs):
            log("ℹ Bỏ %d câu title-card/biển vùng trên khỏi LỜI THOẠI (vẫn CHE — box giữ nguyên)." % (len(segs) - len(_seg2)))
            segs = _seg2
    # CẤP BOX CHE cho dải phụ đã tách khỏi vòng đọc ở trên: không OCR (text của chúng vốn bị loại khỏi lời
    # thoại) nhưng chữ Trung vẫn phải bị che. Đặt SAU tầng lọc title-card vì tầng đó đòi segs/boxes song song
    # cùng chỉ số; từ đây trở đi boxes chỉ dùng cho CHE nên thêm được.
    if _dai_phu:
        boxes = list(boxes) + [tuple(_x) for _x in _dai_phu]
    # 🐛 CHE SONG NGỮ (user: "ảnh khách dịch được mà không che" — sub Trung+Anh 2 dòng): ocr_dong đọc TEXT theo
    # mask chữ-trắng chỉ bắt dòng HÁN → boxes CHE thiếu dòng ANH (Latin) → khách thấy tiếng Anh LỘ dù dịch OK.
    # cand (phat_hien_hop_dong, đã bao box dòng Anh kề Hán nhờ fix _dem_latin) → bổ sung box cand KỀ DƯỚI mỗi
    # box che (|Δy|~1 dòng, x chồng ≥30%, timing giao) mà CHƯA có trong boxes → che cả dòng Anh.
    # 🔴 MẶC ĐỊNH NAY LÀ TẮT ("0") — chủ dự án chốt 12/08/2026: ưu tiên dải tiếng Trung, dòng Latin để khách
    # tự khoanh thủ công. Lý do đầy đủ ở `dai_sub_rapid._songngu_p1` (~:305). PHẢI khớp default với 2 chỗ đọc
    # ở đó và với khoá cache `localize.e_songngu` (§55.1). Bật lại như cũ: CHE_SONGNGU=1.
    if os.environ.get("CHE_SONGNGU", "0") != "0" and boxes and _cand_goc:   # _cand_goc: TOÀN BỘ dải (xem fix ghi-đè cand)
        _them = []
        for _bt0, _bt1, _by0, _by1, _bx0, _bx1 in boxes:
            _bh = _by1 - _by0
            for _ct0, _ct1, _cy0, _cy1, _cx0, _cx1 in _cand_goc:
                if _ct1 <= _bt0 or _ct0 >= _bt1:                 # timing KHÔNG giao → bỏ
                    continue
                _cyc = (_cy0 + _cy1) / 2.0; _byc = (_by0 + _by1) / 2.0
                if _cyc <= _byc:                                 # chỉ lấy dòng KỀ DƯỚI (dòng Anh dưới dòng Trung)
                    continue
                _ox = min(_bx1, _cx1) - max(_bx0, _cx0); _wmin = min(_bx1 - _bx0, _cx1 - _cx0)
                _dy = _cyc - _byc
                # dòng kề dưới: 0 < Δy ≤ 2.2× cao-dòng + chồng ngang ≥30% + chưa nằm trong box che nào
                if 0 < _dy <= max(_bh, _cy1 - _cy0) * 2.2 and _wmin > 0 and _ox / _wmin >= 0.30:
                    _da_co = any(_eb[2] <= _cyc <= _eb[3] and not (_eb[1] <= _ct0 or _eb[0] >= _ct1)
                                 for _eb in boxes)
                    if not _da_co:
                        _them.append((_bt0, _bt1, _cy0, _cy1, _cx0, _cx1))   # box dòng Anh, CÙNG timing box Hán
                        break
        if _them:
            log("👁 Che SONG NGỮ: +%d dải dòng-Anh (Latin) kề dòng-Hán (che cả 2 dòng sub)." % len(_them))
            boxes = list(boxes) + _them
    return segs, boxes
