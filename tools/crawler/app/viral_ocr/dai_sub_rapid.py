# -*- coding: utf-8 -*-
"""Dò DẢI sub gốc bằng RapidOCR (PP-OCRv5 det) + CLUSTERING — chuẩn như phần mềm lớn (OCR → tracking →
subtitle region → blur), KHÔNG gộp mọi box thành 1 dải (sẽ dính username/watermark/title).

Cách làm: lấy mẫu N frame → det-only (chỉ cần box, nhanh) trên ~38% đáy → gom TẤT CẢ box.
CLUSTER box theo y (1D) → mỗi cluster = 1 phần tử text lặp qua các frame (username / watermark / SUBTITLE).
Chọn cluster phụ đề = XUẤT HIỆN NHIỀU FRAME + RỘNG (loại box hẹp góc) + THẤP → dải y của nó = dải che.
None → caller (detect_blur_band) TIN video không có chữ (KHÔNG che). LoiKyThuat (raise) → caller lùi
Tesseract → OpenCV (không kết luận được, khác "quét thật không thấy chữ"). Tắt: env CHE_RAPID=0.
"""
import os


def _dem_loi_ocr(khoa, e=None):
    """Ghi nhận cho bộ đo chất lượng (11/08/2026). CHỈ đếm — KHÔNG đổi luồng, KHÔNG ném lại: hàm này nằm
    TRONG/CẠNH except của người khác, ném ra là phá luồng họ. Đọc số ở khối 'CHẤT LƯỢNG' cuối render.

    `e=None` ⇒ đếm LƯỢT GỌI. Cần vế này vì đếm-mỗi-lỗi KHÔNG ĐỦ: khối telemetry thật đầu tiên (job
    11/08 18:14) không có dòng OCR nào — mà "0 lỗi" và "OCR KHÔNG HỀ CHẠY" (ca cache-hit) nhìn giống hệt
    nhau. Có số lượt gọi thì phân biệt được ngay, khỏi đoán."""
    try:
        import chat_luong
        chat_luong.dem(khoa, chi_tiet=(None if e is None else "%s: %s" % (type(e).__name__, e)))
    except Exception:
        pass


class LoiKyThuat(Exception):
    """Lỗi KỸ THUẬT (chưa cài RapidOCR, không mở được file...) — KHÁC 'quét thật không thấy chữ' (None).
    Không bị nuốt bởi except Exception cuối phat_hien_dai_rapid — caller cần phân biệt 2 case."""
    pass


def _tinh_rowcov(fr, cv2, np):
    """Tính rowcov (projection profile) 1 frame — TÁCH RIÊNG khỏi bước tìm-đỉnh (_tim_dinh) để
    `phat_hien_hop_dong` có thể LƯU LẠI rowcov (mảng 1D nhẹ, ~10KB/mẫu) song song với box đã dò, dùng
    cho bước "cứu mẫu yếu trong track đã xác nhận" (pha 2) mà KHÔNG cần giữ mask 2D nặng (đo: mask 2D
    cho 4000 mẫu video 1440×2560 ≈ 11.6GB RAM, không khả thi; rowcov 1D cho cùng số mẫu chỉ ≈ 40MB).
    Trả (rowcov, y_lo, H, W)."""
    H, W = fr.shape[:2]
    # 🐛 FIX (verify ảnh thật: 2 title-card "奴才该死"/"谢仙尊点化" ở y~15-22%, gần ĐỈNH khung, HOÀN TOÀN
    # không được che vì nằm ngoài vùng quét): hạ 0.22→0.10 để bắt title-card meme-style đặt cao (phổ biến
    # không kém đặt giữa/đáy). Rủi ro dò nhầm logo/watermark/status-bar TĨNH ở đỉnh khung được các guard
    # KHÁC chặn (không phải guard y_lo này): track phụ cần ≥2 mẫu qua ngưỡng gốc 0.035 ở NHIỀU thời điểm
    # (logo tĩnh vẫn có thể qua — nhưng thêm guard span-ngang≥85% + OCR-xác-nhận nội dung ở localize.py
    # _loc_track_phu, và guard tổng SEG_MAX_PCT/SEG_AREA_MAX_PCT chặn che quá nhiều). Tắt: CHE_DONG_YLO=22
    # (khôi phục hành vi cũ) hoặc giá trị % khác tuỳ video.
    try:
        _ylo_pct = float(os.environ.get("CHE_DONG_YLO", "10") or 10) / 100.0
    except ValueError:
        _ylo_pct = 0.10
    y_lo, y_hi = int(H * _ylo_pct), int(H * 0.995)   # quét TỚI 99.5% (hardsub Douyin hay sát ĐÁY 92-99%; trước 93% bỏ sót → fail OCR)
    # CROP vùng đáy [y_lo:y_hi] TRƯỚC khi cvtColor/Laplacian → chỉ xử lý ~78% frame (bỏ 22% trên không dùng)
    # → cvtColor+Laplacian nhanh hơn, KẾT QUẢ Y HỆT (rowcov/cols vẫn lấy đúng các hàng cũ). mask giờ index từ y_lo.
    g = cv2.cvtColor(fr[y_lo:y_hi, :], cv2.COLOR_BGR2GRAY)
    mask = (g > 190) & (np.abs(cv2.Laplacian(g, cv2.CV_32F, ksize=3)) > 40)   # chữ trắng CÓ nét (loại nền phẳng sáng)
    rowcov = mask.sum(axis=1).astype(np.float32) / W
    k = max(3, (int(H * 0.012) | 1))
    rowcov = cv2.GaussianBlur(rowcov.reshape(-1, 1), (1, k), 0).ravel()
    return rowcov, mask, y_lo, H, W


def _tim_dinh(rowcov, mask, y_lo, H, W, np, cv2, max_peaks=3):
    """Tìm đỉnh + dựng box từ rowcov/mask ĐÃ TÍNH SẴN (xem `_tinh_rowcov`) — NGƯỠNG NGHIÊM NGẶT GỐC
    (0.035, không hạ/không connected-component check — ĐÃ THỬ hướng hạ-ngưỡng+CC hôm nay để bắt câu
    NGẮN, verify ảnh thật phát hiện false-positive nghiêm trọng: khuôn mặt/sọc quần áo bị nhận nhầm
    thành chữ vì cửa sổ đỉnh yếu mở-rộng mất kiểm soát. Cách ĐÚNG bắt câu ngắn không phải sửa ở đây —
    xem `phat_hien_hop_dong` bước "cứu mẫu yếu" dùng track đã XÁC NHẬN qua ngưỡng gốc làm bằng chứng,
    KHÔNG hạ ngưỡng phát-hiện-đơn-lẻ per-frame vì per-frame không có ngữ cảnh để phân biệt chữ thật
    với texture tự nhiên giống chữ). Trả LIST (y0,y1,x0,x1), rỗng nếu không có chữ."""
    if rowcov.size == 0 or float(rowcov.max()) < 0.035:        # không đủ "chữ" rộng → không có sub
        return []
    # MULTI-ĐỈNH (user: "che-động siêu fit" khi có ≥2 dải chữ song song, vd tiêu đề giữa + sub đáy): quét
    # TẤT CẢ đỉnh cục bộ theo thứ tự cao→thấp, mỗi đỉnh mở-2-phía tới 35% CHÍNH nó (không phải 35% max toàn
    # cục — dải yếu/mờ hơn vẫn cần mở đủ rộng), rồi LOẠI vùng [a,b] đã dùng khỏi ứng viên kế tiếp (tránh 1
    # dải chữ bị tách đôi thành 2 "đỉnh"). Giới hạn max_peaks để không phình chi phí khi ảnh nhiễu.
    _cand = sorted(range(len(rowcov)), key=lambda i: -rowcov[i])
    _used = np.zeros(len(rowcov), dtype=bool)
    boxes = []
    for pk in _cand:
        if _used[pk] or rowcov[pk] < 0.035 or len(boxes) >= max_peaks:
            continue
        thr = float(rowcov[pk]) * 0.35
        a = pk
        while a > 0 and rowcov[a - 1] > thr and not _used[a - 1]:
            a -= 1
        b = pk
        while b < len(rowcov) - 1 and rowcov[b + 1] > thr and not _used[b + 1]:
            b += 1
        _used[a:b + 1] = True
        y0, y1 = (y_lo + a) / H, (y_lo + b) / H
        if (y1 - y0) > 0.22:                                    # quá cao = nhiễu (không phải hàng chữ)
            continue
        cols = np.where(mask[a:b + 1, :].sum(axis=0) > 0)[0]   # mask đã crop từ y_lo → index a,b trực tiếp
        if len(cols) < W * 0.1:
            continue
        # 🐛 FIX (verify ảnh thật: box "学生会查寝" mép TRÁI lệch 22.8% khung, mép phải khớp gần hoàn hảo):
        # percentile(2/98) trên TOÀN BỘ cột có pixel trong cửa sổ đỉnh bị kéo lệch khi có 1 CỤM NHIỄU NHỎ
        # TÁCH RỜI khỏi cụm chữ chính (đo thật: cụm nhiễu rộng 4.1% ở x=[0.097,0.138] — viền tay áo/cửa —
        # cách cụm chữ chính rộng 34.7% một khoảng trống 13% không pixel nào) — percentile 2% vẫn tính cả
        # cụm nhiễu nên bị kéo về phía đó dù nó rất nhỏ so cụm chính. Fix: nhóm `cols` thành các CỤM LIÊN
        # TỤC (khoảng trống giữa 2 cột kề nhau > 3% bề rộng khung coi là 2 cụm khác nhau — đủ để tách nhiễu
        # rời khỏi chữ liền mạch, nhưng không tách rời 2 chữ Hán cạnh nhau trong cùng 1 câu). Chỉ đo
        # percentile TRONG cụm LỚN NHẤT (nhiều cột nhất — chữ thật luôn chiếm đa số cột so với nhiễu nhỏ).
        # 🐛 FIX #2 (verify ảnh thật: "我不念了" — cụm NHIỄU (viền/quần áo, 473 cột=32.8% khung) LỚN HƠN
        # cụm CHỮ THẬT (384 cột=26.6%) chỉ 6.2 điểm % — "cụm rộng nhất" chọn NHẦM cụm nhiễu vì độ rộng đơn
        # thuần không phải tín hiệu đáng tin khi 2 cụm gần bằng nhau). Research (Stroke Width Transform —
        # Epshtein/Ofek/Wexler CVPR2010): chữ thật có NÉT ĐỘ RỘNG ĐỒNG ĐỀU (hệ số biến thiên CV thấp) và
        # TÁCH thành NHIỀU connected-component riêng biệt (mỗi ký tự Hán ≥1 CC); texture/viền/vải thường
        # DÍNH LIỀN thành 1-2 CC lớn với bề rộng "nét" không đều. Lọc mỗi cụm qua 2 tiêu chí RẺ (chỉ dùng
        # connectedComponentsWithStats + distanceTransform, đã có sẵn OpenCV, không train/không OCR) TRƯỚC
        # khi xét độ rộng — cụm nào không qua lọc (dù rộng hơn) vẫn bị loại, tránh lặp lại sai lầm "rộng
        # nhất luôn thắng".
        _khoang_trong = max(3, int(W * 0.03))
        _cum_list, _cum_cur = [], [cols[0]]
        for _c in cols[1:]:
            if _c - _cum_cur[-1] > _khoang_trong:
                _cum_list.append(_cum_cur); _cum_cur = [_c]
            else:
                _cum_cur.append(_c)
        _cum_list.append(_cum_cur)

        def _diem_chu_that(_cum):
            _cx0, _cx1 = _cum[0], _cum[-1]
            _win = (mask[a:b + 1, _cx0:_cx1 + 1] * 255).astype(np.uint8)
            _n_cc, _, _stats, _ = cv2.connectedComponentsWithStats(_win, connectivity=8)
            _n_cc_that = _n_cc - 1                              # trừ background (label 0)
            if _n_cc_that < 3:                                  # texture liền mạch thường dính 1-2 blob lớn
                return (False, _n_cc_that, 0.0)
            _dt = cv2.distanceTransform(_win, cv2.DIST_L2, 5)
            _sw = 2.0 * _dt[_win > 0]                           # xấp xỉ bề rộng nét tại trục giữa (medial axis)
            if _sw.size == 0 or float(_sw.mean()) <= 1e-6:
                return (False, _n_cc_that, 0.0)
            _cv_stroke = float(_sw.std()) / float(_sw.mean())
            return (_cv_stroke <= 0.6, _n_cc_that, _cv_stroke)  # ngưỡng nới hơn gốc SWT (0.4-0.5) vì DT xấp xỉ thô hơn ray-cast thật

        # 🐛 FIX #3 (user chỉ ra: 2 cụm ĐỀU LÀ CHỮ THẬT về hình học — "PROUD" in trên áo hoodie VÀ phụ đề
        # "我不念了" cùng rơi vào 1 dải Y, cả 2 đều qua được lọc SWT/CC-count ở trên vì cả 2 đều CÓ nét chữ
        # đồng đều — không phải nhiễu texture. Không có cách "ảnh rẻ" nào đọc NỘI DUNG để biết cụm nào là
        # phụ đề. Nhưng có tín hiệu VỊ-TRÍ đáng tin: phụ đề luôn được thiết kế CĂN GIỮA khung theo chiều
        # ngang (đo thật: tâm cụm phụ đề = 0.500, tâm cụm chữ áo = 0.167 — lệch hẳn khỏi giữa vì áo di
        # chuyển tự do theo cơ thể). Trong các cụm ĐÃ QUA lọc SWT/CC (đều là "chữ thật" hình học), ưu tiên
        # cụm có TÂM GẦN 0.5 (giữa khung) NHẤT — không dùng độ rộng (đã gây sai lầm "rộng nhất" trước đó,
        # cả câu ngắn lẫn câu dài đều nên căn giữa như nhau, không phải câu rộng hơn mới "đúng hơn").
        _diem = [(_diem_chu_that(_c), len(_c), _c) for _c in _cum_list]
        _qua_loc = [(_d, _n, _c) for _d, _n, _c in _diem if _d[0]]
        _ung_vien = _qua_loc if _qua_loc else _diem
        _cum_chinh = min(_ung_vien, key=lambda t: abs((t[2][0] + t[2][-1]) / 2.0 / W - 0.5))[2]
        x0, x1 = float(np.percentile(_cum_chinh, 2)) / W, float(np.percentile(_cum_chinh, 98)) / W
        boxes.append((max(0.0, y0 - 0.005), min(1.0, y1 + 0.006), max(0.0, x0 - 0.008), min(1.0, x1 + 0.008)))
    boxes.sort(key=lambda bx: bx[0])   # theo Y tăng dần → thứ tự ổn định cho bước gom track
    return boxes


def _dem_han(txt):
    """Đếm ký tự Hán (CJK Unified Ideographs U+4E00..U+9FFF). Dùng lọc box OCR: chỉ giữ box CÓ chữ Hán —
    tự loại chữ Latin trên áo ('PROUD'), số điện thoại, ký hiệu, nhiễu OCR (đọc rỗng/không-Hán)."""
    return sum(1 for c in (txt or "") if "一" <= c <= "鿿")


def _dem_latin(txt):
    """Đếm ký tự Latin (a-zA-Z, kèm ký tự Việt có dấu). Dùng cho SONG NGỮ (dòng Anh kề Hán) + nguồn en/vi
    (che chữ Latin khi src≠zh — user: "bỏ gate Hán, che theo ngôn ngữ nguồn")."""
    return sum(1 for c in (txt or "")
               if ("a" <= c <= "z") or ("A" <= c <= "Z")
               or ("À" <= c <= "ỹ" and c.isalpha()))   # Latin-1/Extended + Việt có dấu (À..ỹ)


def _dem_hangul(txt):
    """Đếm ký tự Hangul (tiếng Hàn, U+AC00..U+D7A3). Dùng khi src=ko — che chữ Hàn thay vì Hán."""
    return sum(1 for c in (txt or "") if "가" <= c <= "힣")


def _he_chu_nguon(src_lang):
    """Chọn HỆ CHỮ nguồn để gate box OCR theo NGÔN NGỮ NGUỒN (user: "bỏ gate Hán, xác định ngôn ngữ rồi che
    theo nguồn"). Trả (ham_dem, ten) — ham_dem(txt) đếm ký tự thuộc hệ chữ đó. Mặc định (None/zh) = Hán (giữ
    hành vi cũ cho video Trung — đa số khách). Env CHE_HE_CHU ép cứng: han/latin/hangul."""
    _ep = (os.environ.get("CHE_HE_CHU", "") or "").strip().lower()
    s = (src_lang or "").strip().lower()
    if _ep in ("han", "zh") or (not _ep and (not s or s.startswith("zh") or s in ("yue", "wuu", "nan", "hak", "gan", "chinese", "cn"))):
        return (_dem_han, "Hán")
    if _ep == "hangul" or s in ("ko", "kor", "korean"):
        return (_dem_hangul, "Hangul")
    if _ep == "latin" or s in ("en", "eng", "english", "vi", "vie", "vietnamese"):
        return (_dem_latin, "Latin")
    # ngôn ngữ khác (ja/th/...) chưa hỗ trợ riêng → mặc định Hán (an toàn, giữ cũ)
    return (_dem_han, "Hán")


def _norm_txt(txt, dem=None):
    """Chuẩn hoá text OCR để SO SÁNH câu (tách segment theo text-đổi + temporal). Giữ ký tự thuộc HỆ CHỮ nguồn
    + số. dem=hàm đếm hệ chữ (mặc định Hán — giữ cũ). src≠zh truyền dem tương ứng để temporal không rỗng oan
    (nếu chỉ giữ Hán thì câu Latin normalize thành rỗng → coi như 1 nội dung → hỏng temporal/tách-segment)."""
    if dem is _dem_latin:
        return "".join(c for c in (txt or "") if (("a" <= c <= "z") or ("A" <= c <= "Z")
                       or ("À" <= c <= "ỹ" and c.isalpha()) or c.isdigit())).lower()
    if dem is _dem_hangul:
        return "".join(c for c in (txt or "") if ("가" <= c <= "힣") or c.isdigit())
    return "".join(c for c in (txt or "") if ("一" <= c <= "鿿") or c.isdigit())


def _txt_giong(a, b):
    """2 text OCR (đã _norm) có phải CÙNG 1 câu? True nếu 1 là tiền/hậu tố của kia (OCR đọc dần/rác đuôi) hoặc
    tỉ lệ ký tự chung cao. Dùng tách segment: text ĐỔI HẲN (không giống) → câu mới → tách box riêng."""
    if not a or not b:
        return not a and not b        # cả 2 rỗng = giống; 1 rỗng 1 có = khác
    if a == b:
        return True
    s, l = (a, b) if len(a) <= len(b) else (b, a)
    if len(s) >= 2 and (l.startswith(s) or l.endswith(s)):   # câu ngắn là đầu/cuối câu dài (OCR đọc dần) = cùng câu
        return True
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.6   # ≥60% ký tự chung = cùng câu (OCR lệch nhẹ)


class _HybridDo:
    """KHOÁ-ROI cho PHA DÒ THỜI ĐIỂM — chuyển cơ chế `OCR_HYBRID` (vốn chỉ chạy ở PHA ĐỌC, `ocr_text` ~:1415)
    sang pha dò, nơi thật sự tốn tiền.

    VÌ SAO: pha dò gọi `det+rec` ở MỌI mẫu (~600 lần/video 600s). Đo trên dải 1280×123 (video 720p):
        SMALL det-only 233,9ms · det+rec 272,3ms  ⇒ det = 86%
        TINY  det-only  64,9ms · det+rec  77,1ms  ⇒ det = 84%
        rec-only trên dải  6,1ms                  ⇒ rẻ hơn det+rec 12,6×
    Mà pha dò chỉ cần biết "khung này CÓ chữ không / chữ có ĐỔI không" — không cần det tìm lại hộp mỗi lần.
    Đo 60 khung: rec-only BỎ SÓT 0/46 khung có chữ (phát hiện chuẩn), chỉ đọc lem hơn.

    CÁCH: `_hy_mau` mẫu đầu chạy det THẬT → khoá dải Y (trung vị) → các mẫu sau crop khít theo Y đó,
    dò X bằng `ocr_text._khit_x` (thuật toán pixel, không phải mạng) → rec-only.
    LÙI VỀ det+rec khi: chưa khoá · tới kỳ re-det (`_hy_redet`) · `_khit_x` không thấy cột chữ ·
    rec ra rỗng · score < `_hy_score`. Mọi lần det thật đều CẬP NHẬT lại ROI ⇒ bám được sub trôi dần.

    ⚠ Đọc lem là CÓ THẬT (đo: giống det ≥95% chỉ 16/46, trung vị 0,89 khi rec cả bề ngang) — nên BẮT BUỘC
    đi qua `_khit_x` để thu hẹp X trước khi rec, đúng như pha đọc đang làm. Text ở pha dò chỉ dùng để lọc
    (`_dem_chinh >= han_min`) và phân biệt sub thoại với nhãn tĩnh; TEXT CUỐI vẫn do pha đọc (SMALL) sinh ra.

    ⚠️ ĐO LẠI 14/08/2026 — HAI KẾT LUẬN CŨ DƯỚI ĐÂY **KHÔNG CÒN TÁI HIỆN ĐƯỢC**. Giữ nguyên văn để đối
    chiếu, nhưng ĐỪNG dùng chúng làm căn cứ quyết định nữa:
        (cũ 13/08) "đường thật: TỔNG 76,8s → 79,3s = 0,97× (KHÔNG nhanh hơn)" — 15s tiết kiệm ở pha dò bị
        nuốt ở chặng sau, nghi do HỘP hybrid kém khít nên pha đọc phải làm bù.
        (cũ 13/08) "vẫn mất chữ: bản an toàn (score 0,90) mất 2 câu (`哭够了没`, `女儿`)".
    ĐO MỚI (cùng clip 600s, render TRỌN ĐƯỜNG, code 14/08):
        pha dò   : 73,9s → **34,2s** (2,16×) · số dải **292 = 292**, KHỚP TUYỆT ĐỐI với bản tắt
        cả render: 372,4s → **255,6s** (1,46×) · cue **293 = 293**, KHÔNG MẤT CÂU NÀO
        chữ      : khớp 283/293 = 96,6%; 10 chỗ lệch thì HOÀ (hybrid đúng hơn 4, thua 4, hỗn hợp 2)
    Vì sao đảo chiều: từ 13/08 tới nay nền đã đổi (tắt CHE_DONG_GATE_LIST + CHE_DONG_BO_DINH, Pha 1 chỉ quét
    1/3 dưới…) nên "chặng sau nuốt mất phần tiết kiệm" không còn đúng. BÀI HỌC: số đo gắn chặt với phiên bản
    nền — đổi nền thì kết luận cũ phải ĐO LẠI, không được dẫn lại.

    🔴 VẪN MẶC ĐỊNH TẮT — nhưng vì lý do KHÁC hẳn lý do cũ: `GỘP DẢI` (xem khối `_thu_mau` trong
    `phat_hien_sub_ocr`) đạt gần y hệt về tốc độ (264,7s so với 255,6s = chênh 3,4%) mà cho HỘP KHÍT HƠN.
    Đo tận mắt trên khung t=4s: chữ thật nằm x 35%–65%; hybrid trả x 14%–97% (y hệt bản cũ, tức quét THỪA
    gần cả bề ngang), gộp dải trả x 36%–75%. Hộp thừa ⇒ che rộng hơn cần thiết ⇒ vệt mờ to, xấu hình.
    ⇒ Đổi 3,4% tốc độ lấy hộp khít hơn là đáng. Ai cần tối đa tốc độ: OCR_DO_HYBRID=1 (loại trừ với gộp dải —
    khoá-ROI cần det theo TỪNG khung nên không xếp chồng được).
    Muốn làm tiếp: sửa chỗ HỘP (trả hộp khít hơn) — KHÔNG phải chỉnh thêm ngưỡng ở đây; đã thử 0,75 và 0,90,
    cả hai đều cho cùng kết cục."""

    def __init__(self, eng):
        self.eng = eng
        self.bat = os.environ.get("OCR_DO_HYBRID", "0") != "0"
        try:
            self.n_mau = int(os.environ.get("OCR_DO_HY_MAU", "") or 3)
            self.redet = int(os.environ.get("OCR_DO_HY_REDET", "") or 15)
            self.score = float(os.environ.get("OCR_DO_HY_SCORE", "") or 0.90)
            self.pad = int(os.environ.get("OCR_DO_HY_PAD", "") or 8)
            self.n_rong_ep = int(os.environ.get("OCR_DO_HY_RONG", "") or 6)
        except ValueError:
            self.n_mau, self.redet, self.score, self.pad, self.n_rong_ep = 3, 15, 0.90, 8, 6
        self.roi = None          # (y0,y1) pixel TRONG cim
        self.mau = []            # mẫu ROI từ det thật
        self.dem = 0             # số lượt rec-only từ lần det gần nhất
        self.rong = 0            # số lượt rỗng LIÊN TIẾP (đủ nhiều → nghi ROI sai, mở khoá)
        self.n_det = 0
        self.n_rec = 0

    def _det(self, cim):
        """det+rec thật + cập nhật ROI khoá."""
        self.n_det += 1
        self.dem = 0
        try:
            res, _ = self.eng(cim, use_cls=False)
        except TypeError:
            _r = self.eng(cim)
            res = _r[0] if isinstance(_r, tuple) else _r
        ys = []
        for it in (res or []):
            if it and len(it) >= 3:
                try:
                    ys.append((min(float(p[1]) for p in it[0]), max(float(p[1]) for p in it[0])))
                except Exception:
                    pass
        if ys:
            self.mau.append((min(a for a, _ in ys), max(b for _, b in ys)))
            if len(self.mau) >= self.n_mau:
                self.mau = self.mau[-self.n_mau:]
                _a = sorted(a for a, _ in self.mau)
                _b = sorted(b for _, b in self.mau)
                m = len(_a) // 2
                self.roi = (_a[m], _b[m])
        return res

    def __call__(self, cim):
        """Trả res ĐÚNG format det+rec: [(box_4_diem, txt, score), ...] — downstream không phải đổi."""
        if not self.bat or self.roi is None or self.dem >= self.redet:
            return self._det(cim)
        import numpy as _np
        import cv2 as _cv2
        import ocr_text as _ot     # dai_sub_rapid KHÔNG import ocr_text ở cấp module (chỉ cục bộ trong hàm) —
        #                            thiếu dòng này là NameError LÚC CHẠY mà ast.parse/import đều báo OK
        h = cim.shape[0]
        y0 = max(0, int(self.roi[0]) - self.pad)
        y1 = min(h, int(self.roi[1]) + self.pad)
        if y1 - y0 < 8:
            return self._det(cim)
        sub = cim[y0:y1, :]
        # 🔴 KHÔNG lùi det khi "không thấy chữ" — ĐO THẬT mới sửa được chỗ này:
        #   · rec-only BỎ SÓT 0/46 khung có chữ ⇒ rec ra rỗng nghĩa là dải TRỐNG THẬT, det xác nhận lại là phí.
        #   · `_khit_x` là cổng ÂM TÍNH KÉM: 13/14 khung TRỐNG nó vẫn báo "có cột" ⇒ không dùng để loại trống.
        # Bản đầu tôi lùi det ở cả hai chỗ ⇒ 28/60 lượt phải det, ra 123,6 ms/lần — CHẬM HƠN det+rec thuần
        # (76,7 ms). Trả tiền hai lần: rec xong rồi vẫn det. Nay "không thấy chữ" → trả rỗng luôn.
        # Lưới bắt SUB TRÔI KHỎI ROI: (a) det định kỳ mỗi `redet` mẫu, (b) rỗng LIÊN TIẾP `n_rong_ep` mẫu →
        # ép det ngay (đoạn trống dài bất thường là dấu hiệu ROI đã sai chỗ, không phải video hết thoại).
        self.dem += 1
        _rong = []
        try:
            xx = _ot._khit_x(sub, _np, _cv2)
        except Exception:
            xx = None
        if not xx or (xx[1] - xx[0]) < 12:
            return self._rong()
        x0, x1 = xx
        try:
            rr, _ = self.eng(sub[:, x0:x1], use_det=False, use_cls=False)
        except Exception:
            return self._det(cim)          # LỖI engine (khác với "không có chữ") → det lại cho chắc
        txt, sco = "", 0.0
        for it in (rr or []):
            if isinstance(it, (list, tuple)) and it:
                txt = str(it[0]).strip()
                try:
                    sco = float(it[1]) if len(it) > 1 else 0.0
                except (TypeError, ValueError):
                    sco = 0.0
                break
        # 🔴 KHÔNG đặt ngưỡng ĐIỂM ở đây — vòng gọi ĐÃ có bộ lọc riêng (`_dem_chinh(txt) >= han_min` +
        # `score >= conf_min`). Bản đầu tôi thêm `sco < 0.90 → coi như rỗng`: nó CHẶN TRƯỚC khi bộ lọc sẵn
        # có kịp làm việc ⇒ một mình nó loại 13/46 khung có chữ. Đo phân bố điểm rec-only trên khung CÓ chữ:
        #     ngưỡng 0,90 giữ 33/46 · 0,70 giữ 39/46 · BỎ ngưỡng giữ 46/46.
        # Khung TRỐNG thì rec ra rác Latin ('C:', 'MMNOIM', '7') — `han_min` của vòng gọi loại sạch, 0/14 lọt.
        # ⇒ Chỉ coi là RỖNG khi rec KHÔNG ra chữ nào. Đo lại với chuẩn đúng (≥2 chữ Hán, tức thứ vòng gọi
        # thật sự dùng): hybrid 40/60 vs det+rec 39/60 — MẤT 0 khung, 5,2 ms/lần vs 88,4 ms (nhanh 17×).
        if not txt:
            return self._rong()
        # 🔴 CÓ chữ nhưng ĐIỂM THẤP → LÙI det (KHÔNG vứt câu). Phân biệt với nhánh `not txt` ở trên:
        #   · rec ra RỖNG  = dải trống thật → trả rỗng, KHÔNG det (đây là chỗ tiết kiệm chính).
        #   · rec ra CHỮ nhưng điểm thấp = đọc được nhưng lẫn rác → det lại cho chắc.
        # Vì sao cần: `_khit_x` vốn viết cho PHA ĐỌC (ảnh đã được det cắt khít). Ở ROI lỏng của pha dò, với
        # câu NGẮN nó trả khoảng X quá rộng và vơ cả nền. ĐO THẬT 5 câu bị mất:
        #     啊     _khit_x=(29,1191)  → rec 'S啊T'       sco 0,46
        #     啊     _khit_x=(164,1278) → rec 'NM啊OU'     sco 0,37
        #     走开    _khit_x=(342,691)  → rec '开'         sco 0,86   (mất chữ 走)
        #     专心学学 _khit_x=(357,1280) → rec '专心学学a一日' sco 0,71
        #     女儿    _khit_x=(329,1239) → rec '实儿'       sco 0,60   (đọc nhầm 女→实)
        # Chữ thật VẪN CÓ trong kết quả, chỉ lẫn rác — rồi bị bộ lọc `≥2 chữ Hán` của vòng gọi loại cả câu.
        # Điểm tách hai nhóm rất rõ: câu đọc đúng trung vị 0,98 · 5 ca hỏng đều 0,37–0,86.
        # ⚠ Bản trước tôi để ngưỡng 0,90 và VỨT câu (không det) → mất 5 câu thật. Ngưỡng phải đi kèm LÙI DET.
        if sco < self.score:
            return self._det(cim)
        self.n_rec += 1
        # đếm "rỗng" theo chuẩn của vòng gọi: <2 chữ Hán coi như không có sub → dùng để bắt ROI trôi
        self.rong = 0 if _dem_han(txt) >= 2 else (self.rong + 1)
        if self.rong >= self.n_rong_ep:
            self.roi = None
            self.rong = 0
        box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        return [(box, txt, sco)]

    def _rong(self):
        """Dải TRỐNG (rec không ra chữ). Trả rỗng — KHÔNG det. Nhưng đếm: rỗng liên tiếp quá nhiều là dấu
        hiệu ROI khoá đã sai chỗ (sub trôi) chứ không phải video hết thoại ⇒ lần sau ép det lại."""
        self.n_rec += 1
        self.rong += 1
        if self.rong >= self.n_rong_ep:
            self.roi = None                # mở khoá → lượt sau đi nhánh det, tự khoá lại ROI mới
            self.rong = 0
        return []


def _fps_ocr_adaptive(dur_s):
    """FPS lấy mẫu OCR TỰ GIÃN theo độ dài video. QUAN TRỌNG: 'đè' (dải che phình ở chuyển câu) ≈ 1/fps vì để
    ĐẢM BẢO 0-lộ, biên phải phủ 1 khoảng-mẫu (chữ hiện sớm tối đa 1 khoảng-mẫu giữa 2 mẫu).
    🐛 TỐI ƯU (đo thật: fps 2→1 nhanh 1.9× — 32s→17s — mà GIỮ đủ box (38→38) + che KÍN sub đáy; box lộ y hệt
    fps=2 đều là chữ-góc/cảnh ngoài dải sub, KHÔNG do fps): HẠ default video ngắn 2.0→1.0 fps (đè ~1s, feather
    biên đã lo). Dò-che là bottleneck nặng nhất (~1/3 tổng render). fps=0.75 bắt đầu sót box → giữ 1.0 làm sàn.
    <10ph→1.0 · 10-30ph→1.0 · 30-60ph→0.5 · >60ph→0.33 fps. Ép cứng: env CHE_DONG_FPS. Cần chính xác biên hơn
    (đè nhỏ hơn, chậm hơn) → CHE_DONG_FPS=2."""
    if dur_s < 1800:
        return 1.0
    if dur_s < 3600:
        return 0.5
    return 0.33


_WM_TINH = []          # [(y0,y1,x0,x1)] ô chữ TĨNH (watermark/logo) Pha 1 tìm được — pha đọc tô phẳng
                       # trước khi OCR nhìn, để khỏi quét rồi bỏ. KHÔNG dùng để xoá trên video xuất.


def _hoc_dai_sub_thua(video, eng, conf_min, han_min, log_fn=print, n_probe=12, src_lang=None):
    """PHA 1 (user: "quét toàn màn nhiều frame → xác định chỗ sub hay xuất hiện, người đăng thường để sub 1
    hàng → chỉ OCR dải đấy"): OCR THƯA ~n_probe frame rải đều TOÀN KHUNG → gom chữ Hán theo dải-Y → chọn dải
    XUẤT HIỆN ở NHIỀU FRAME NHẤT = sub thật (sub đổi nội dung nhưng cùng chỗ qua nhiều frame). Chữ nền (nhãn
    kệ/biển hiệu) rải rác nhiều Y khác nhau hoặc chỉ 1-2 frame → KHÔNG tạo dải ổn định → loại.
    Trả (y0f, y1f) dải sub ước lượng, hoặc None (không dải nào đủ ổn định → caller quét cả khung như cũ).
    Env: CHE_DONG_PROBE (số frame pha 1), CHE_DONG_MIN_FRAME (tối thiểu số frame 1 dải phải xuất hiện = 3)."""
    import cv2
    cap = cv2.VideoCapture(os.path.abspath(video))
    if not cap.isOpened():
        return None
    nfr = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if nfr <= 0 or W <= 0 or H <= 0:
        cap.release()
        return None
    try:
        n_probe = int(os.environ.get("CHE_DONG_PROBE", "") or n_probe)
    except ValueError:
        pass
    n_probe = max(4, n_probe)
    sc = 1280.0 / W if W > 1280 else 1.0
    _dem_chinh, _ten_he = _he_chu_nguon(src_lang)   # hệ chữ NGUỒN: zh→Hán, en/vi→Latin, ko→Hangul (gate mỏ neo)
    _la_han_src = _dem_chinh is _dem_han            # src Trung → còn dùng nhánh song ngữ (Latin kề Hán); khác → sub NGUỒN đã là Latin
    hits = []                                    # (yc_frac, frame_k, txt) — mỗi chữ NGUỒN đọc được (txt để đếm nội-dung-đổi)
    # BẢN ĐỒ TẦN SUẤT (frequency map) — cộng dồn mặt-nạ CHỮ của chính n_probe khung đang quét, KHÔNG đọc thêm
    # khung nào, KHÔNG gọi thêm OCR. Watermark/logo đứng YÊN nên pixel chữ của nó trùng nhau qua hầu hết khung
    # → cộng lại sáng rực; phụ đề đổi câu đổi độ dài nên cùng một pixel chỉ trúng vài khung → mờ.
    # Dùng để loại watermark KHÔNG phụ thuộc OCR đọc được nó hay không — đó đúng là chỗ cách cũ (bề ngang biến)
    # thất bại: watermark bán trong suốt làm OCR đọc ra bề ngang lệch mỗi khung.
    import numpy as np
    _acc = _acc2 = None
    _n_acc = 0
    for k in range(n_probe):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(nfr * (k + 0.5) / n_probe))
        ok, fr = cap.read()
        if not ok or fr is None:
            continue
        # TÔ PHẲNG vùng khách khoanh TRƯỚC khi OCR nhìn (xem `ocr_text._to_phang_vung_tay`). Pha 1 quét TOÀN
        # MÀN nên đây là chỗ logo/banner thật sự lọt vào — tô ở đây ngăn chúng tạo "dải-Y ổn định" giả, thứ
        # có thể đẩy `_p1_main` sang sai chỗ hoặc sinh thêm dải rời làm trượt cổng bỏ-pha-dò.
        # ⚠ `ocr_text` KHÔNG có ở cấp module của file này (chỉ import cục bộ trong hàm) → phải import tại chỗ,
        #   nếu không là NameError LÚC CHẠY mà ast.parse/import đều báo OK.
        # ⚠ t=None CỐ Ý: hàm này KHÔNG có `fps`, và Pha 1 chỉ đi tìm DẢI-Y nên áp mọi vùng cho mọi khung thăm
        #   dò là đúng hơn — vùng chỉ hiện vài giây vẫn không được phép tạo dải giả.
        try:
            import ocr_text as _ot_pm, numpy as _np_pm    # import TẠI CHỖ: không dựa vào tên `np`/`_np` của
            _ot_pm._to_phang_vung_tay(fr, None, _np_pm, cv2)   # scope ngoài (file có cả hai cách đặt tên)
        except Exception:
            pass          # tô phẳng là PHỤ — lỗi ở đây không được phép làm hỏng Pha 1
        # 🔻 PHA 1 CHỈ QUÉT 1/3 DƯỚI (chủ dự án chốt 14/08/2026). Trước đây quét CẢ KHUNG rồi mới ưu tiên
        # dải ở 1/3 dưới lúc CHỌN (xem khối "ƯU TIÊN 1/3 DƯỚI KHUNG" bên dưới) — tức trả tiền OCR cho 2/3
        # khung trên rồi vứt kết quả đi. Cắt ngay từ đầu: bớt ~2/3 diện tích ảnh mỗi khung thăm dò.
        # ⚠ Toạ độ hộp OCR sau khi cắt là TƯƠNG ĐỐI với phần cắt ⇒ PHẢI cộng bù `_off_y` (xem 3 dòng `_yc/_y0/_y1`).
        # ⚠ Video đặt sub Ở TRÊN: không dải nào trong 1/3 dưới ⇒ hàm trả None ⇒ caller quét cả khung như cũ
        #   (đúng hành vi ghi trong docstring). Mất phần tăng tốc cho ca đó, KHÔNG mất tính năng.
        # Tắt (về quét cả khung): CHE_DONG_P1_DUOI=0. Đổi tỉ lệ: CHE_DONG_P1_DUOI_TY (mặc định 0.34).
        _off_y = 0
        if os.environ.get("CHE_DONG_P1_DUOI", "1") != "0":
            try:
                _ty_duoi = float(os.environ.get("CHE_DONG_P1_DUOI_TY", "") or 0.34)
            except ValueError:
                _ty_duoi = 0.34
            _ty_duoi = min(1.0, max(0.05, _ty_duoi))
            _off_y = int(H * (1.0 - _ty_duoi))
            if _off_y > 0:
                fr = fr[_off_y:, :]
        _hc = fr.shape[0] if getattr(fr, "shape", None) else H
        cim = cv2.resize(fr, (max(1, int(W * sc)), max(1, int(_hc * sc)))) if sc != 1.0 else fr
        try:
            if os.environ.get("CHE_DONG_WM_TINH", "0") != "1":
                raise StopIteration                    # tắt → KHÔNG cộng gì, 0 chi phí
            # Cộng TỔNG và TỔNG BÌNH PHƯƠNG độ xám → tính ĐỘ BIẾN THIÊN từng pixel qua các khung.
            # ⚠ ĐÃ THỬ & LOẠI cách "cộng mặt-nạ chữ trắng>195 có viền đen": ra RỖNG trên video khách vì
            # watermark BÁN TRONG SUỐT (xám, không đạt ngưỡng trắng) — mặt-nạ đó tuned cho hardsub, không cho logo.
            _g1 = cv2.cvtColor(cim, cv2.COLOR_BGR2GRAY).astype(np.float32)
            if _acc is None:
                _acc = _g1.copy(); _acc2 = _g1 * _g1
            else:
                _acc += _g1; _acc2 += _g1 * _g1
            _n_acc += 1
        except Exception:
            pass
        try:
            res, _ = eng(cim, use_cls=False)
        except TypeError:
            _r = eng(cim); res = _r[0] if isinstance(_r, tuple) else _r
        except Exception as _e_ocr:
            # 🔴 MỞ NUỐT LỖI (11/08/2026) — GIỮ NGUYÊN hành vi (`res = None`), CHỈ đếm thêm.
            # Vì sao cần: lỗi lặp mọi khung (CUDA OOM khi 2 lane, ORT gãy) ⇒ `mau` rỗng ⇒ pipeline in
            # "OCR không thấy hardsub → ASR" ⇒ LỖI HỆ THỐNG bị báo thành VIDEO KHÔNG CÓ CHỮ, mất cả chữ
            # lẫn box che. Trước đây không một dòng log nên không ai chẩn được. (Việc TÁCH hẳn trạng thái
            # OCR_FAILED ≠ NO_TEXT để Đợt 3, sau khi telemetry này cho thấy nó có xảy ra thật hay không.)
            _dem_loi_ocr("ocr.loi_goi_pha1", _e_ocr)
            res = None
        # Đếm LƯỢT GỌI (kể cả lượt vừa lỗi) — ĐẶT NGOÀI try để không có gì mới lọt vào except ở trên.
        _dem_loi_ocr("ocr.goi_pha1")
        # SONG NGỮ (user: che cả dòng Anh): thu box Hán + box Latin kề Hán → dải-Y (y_gate) bao CẢ 2 dòng
        # (Trung trên + Anh dưới) → Pha 2 crop đủ vùng cả 2. Latin đơn lẻ không neo Hán → bỏ (an toàn).
        #
        # 🔴 ĐỔI MẶC ĐỊNH "1" → "0" (12/08/2026, chủ dự án chốt): **ƯU TIÊN DẢI TIẾNG TRUNG.** Có 2 dải thì
        # CHỈ che dải Hán; khách vẫn muốn che dòng Latin thì TỰ KHOANH dải thủ công ở phần Xem trước.
        # Lý do: gộp cả dòng Latin vào dải làm dải CAO GẤP ĐÔI (che lấn hình), và dòng Latin còn sinh ra
        # cue OCR gần-trùng với cue Hán — mà `dich_gemini_web` từng được dặn "nhận ra câu TRÙNG kề nhau"
        # nên Gemini GỘP hai dòng đó rồi đánh số lại ⇒ LỆCH SỐ (đo thật 12/08: 6/10 ca mất là lệch cục bộ,
        # và mọi cổng kiểm đều MÙ vì bộ số ra vẫn đủ). Vế prompt đó đã bỏ cùng ngày; đây là vế còn lại ở
        # tầng DÒ DẢI.
        # ⚠ Đánh đổi đã biết: video hardsub SONG NGỮ mà khách KHÔNG tự khoanh sẽ để LỘ dòng tiếng Anh.
        # Đó là lỗi THẤY ĐƯỢC ngay trên video (khách tự xử lý được bằng dải thủ công); đổi lấy việc bỏ một
        # nguồn gây lệch số — lỗi KHÔNG ai thấy. Bật lại như cũ: CHE_SONGNGU=1.
        _songngu_p1 = os.environ.get("CHE_SONGNGU", "0") != "0"
        _han_f, _lat_f = [], []                        # (yc, y0, y1, x0, x1) trong frame k
        for item in (res or []):
            if not item or len(item) < 3:
                continue
            box, txt, score = item[0], item[1], item[2]
            try:
                score = float(score)
            except Exception:
                score = 0.0
            ys = [float(p[1]) for p in box]; xs = [float(p[0]) for p in box]
            # `+ _off_y`: hộp OCR đo trên ẢNH ĐÃ CẮT 1/3 dưới ⇒ cộng lại số pixel đã cắt để về toạ độ
            # TOÀN KHUNG. Thiếu dòng này là mọi dải bị đẩy lên ~66% màn — sai toàn bộ vùng che.
            _yc = ((min(ys) + max(ys)) / 2.0 / sc + _off_y) / H
            _y0 = (min(ys) / sc + _off_y) / H; _y1 = (max(ys) / sc + _off_y) / H
            _x0 = min(xs) / sc / W; _x1 = max(xs) / sc / W
            if _dem_chinh(txt) >= han_min and score >= conf_min:
                hits.append((_yc, k, _norm_txt(txt, _dem_chinh), _x0, _x1, _y0, _y1))
                _han_f.append((_yc, _y0, _y1, _x0, _x1))
            elif _la_han_src and _songngu_p1 and _dem_latin(txt) >= 4 and score >= conf_min:
                _lat_f.append((_yc, _y0, _y1, _x0, _x1))
        # Latin kề 1 box Hán cùng frame (|Δtâm-y| ≤ 1.6× cao-dòng + chồng ngang ≥30%) → dòng Anh song ngữ
        for _lyc, _ly0, _ly1, _lx0, _lx1 in _lat_f:
            _lh = _ly1 - _ly0
            for _hyc, _hy0, _hy1, _hx0, _hx1 in _han_f:
                _ox = min(_lx1, _hx1) - max(_lx0, _hx0); _wmin = min(_lx1 - _lx0, _hx1 - _hx0)
                if abs(_lyc - _hyc) <= max(_lh, _hy1 - _hy0) * 2.2 and _wmin > 0 and _ox / _wmin >= 0.30:
                    hits.append((_lyc, k, "", _lx0, _lx1, _ly0, _ly1))     # dòng Anh song ngữ (txt rỗng — không tính vào nội-dung-đổi Hán)
                    break
    cap.release()
    if not hits:
        return None
    # GOM theo dải-Y (bin 0.05 = 5% khung ≈ 1 hàng chữ). Mỗi dải: đếm SỐ FRAME KHÁC NHAU xuất hiện (ổn định) +
    # y-range. Sub 1 hàng cố định → 1 dải nhiều frame; chữ nền rải rác → nhiều dải mỏng, mỗi dải ít frame.
    BIN = 0.05
    dai = {}                                     # bin_idx -> {"frames": set, "ys": [yc...], "txts": set}
    for yc, k, _tx, _hx0, _hx1, _hy0, _hy1 in hits:
        bi = int(yc / BIN)
        d = dai.setdefault(bi, {"frames": set(), "ys": [], "txts": set(), "xs": [], "hs": []})
        d["frames"].add(k); d["ys"].append(yc); d["xs"].append((_hx0, _hx1)); d["hs"].append((_hy0, _hy1))
        if _tx:
            d["txts"].add(_tx)                   # NỘI DUNG khác nhau ở dải: sub thoại ĐỔI (nhiều txt); nhãn/danh sách CỐ ĐỊNH (1 txt)
    try:
        min_frame = int(os.environ.get("CHE_DONG_MIN_FRAME", "") or 3)
    except ValueError:
        min_frame = 3
    # chọn dải xuất hiện ở NHIỀU FRAME NHẤT, phải ≥ min_frame (đủ ổn định = sub thật, không phải nhiễu 1-2 frame)
    best = max(dai.values(), key=lambda d: len(d["frames"]))
    if len(best["frames"]) < min_frame:
        log_fn("ℹ Pha 1: không dải-Y nào đủ ổn định (max %d/%d frame < %d) → OCR cả khung."
               % (len(best["frames"]), n_probe, min_frame))
        return None
    # 🐛 FIX (audit #1 + user "che chữ cao NẾU phụ đề gốc ở trên"): TRƯỚC đây chỉ giữ dải MẠNH NHẤT + bin kề ±1
    # → video có ≥2 dải hardsub ĐỒNG THỜI khác vị-trí (vd danh sách nguyên liệu y~0.20 + sub thoại y~0.90, cả 2
    # ổn định) thì dải KIA bị BỎ → chữ Trung LỘ (không che, không dịch). GIỜ: giữ MỌI bin đủ ổn định (≥min_frame),
    # kể cả cách xa dải mạnh nhất → y_gate BAO TRÙM tất cả dải chữ thật. Pha 2 OCR cả vùng đó (chỉ giữ chữ Hán →
    # khoảng giữa 2 dải không có chữ thì không che nhầm). CHE_DONG_1DAI=1 = hành vi cũ (chỉ 1 dải, nếu cần).
    _bins_od = sorted(bi for bi, d in dai.items() if len(d["frames"]) >= min_frame)   # MỌI dải ĐỦ ỔN ĐỊNH (không chỉ best)
    # 🐛 FIX (user "bỏ danh sách đi, khó" — video đậu-xanh: sub-thoại + danh-sách-nguyên-liệu + nhãn-máy cận-cảnh
    # lẫn lộn): dải nhãn-máy/danh-sách sống ĐỦ frame (≥min_frame) nên lọt _bins_od → bị che oan. Phân biệt bằng
    # MẬT ĐỘ dải/frame (đo THẬT trên video này: sub-thoại xuất-hiện ở frame khung THƯA ~2.5-3.2 dải; nhãn/cảnh cận
    # xuất-hiện ở frame khung ĐÔNG 4.5-9 dải — lúc quay cận-cảnh máy/bàn nguyên-liệu chữ rải khắp khung). Với mỗi
    # dải ổn định, tính TB số-dải-đồng-thời tại các frame nó xuất hiện; dải TB ≥ CHE_DONG_DENSITY_MAX = cảnh cận →
    # BỎ. CHỈ áp khi có >1 dải cạnh-tranh (video thường 1-dải giữ nguyên); KHÔNG bỏ hết (giữ ≥1 dải THƯA nhất).
    if len(_bins_od) > 1 and os.environ.get("CHE_DONG_DENSITY") != "0":
        try:
            _dens_max = float(os.environ.get("CHE_DONG_DENSITY_MAX", "") or 4.0)
        except ValueError:
            _dens_max = 4.0
        _nbin_frame = {}                         # k -> số bin (dải-Y) khác nhau tại frame k
        for _yc, _k, _tx, _hx0, _hx1, _hy0, _hy1 in hits:
            _nbin_frame.setdefault(_k, set()).add(int(_yc / BIN))
        _nbin_frame = {_k: len(_s) for _k, _s in _nbin_frame.items()}
        _dens = {}                               # bi -> TB số-dải khi bi xuất hiện
        for _bi in _bins_od:
            _fs = dai[_bi]["frames"]
            _dens[_bi] = sum(_nbin_frame.get(_k, 1) for _k in _fs) / max(1, len(_fs))
        # 🐛 FIX (user gửi frame: câu sub-thoại '通过内在调理…' y0.50 t7-8s bị BỎ OAN — nó xuất-hiện đúng lúc khung
        # ĐÔNG chữ 7 dải (đang đổ nguyên-liệu) nên mật-độ cao → lọc bỏ nhầm). CỨU bằng TEMPORAL (user chọn "cứu sub
        # bằng đổi nội dung"): sub thoại thật ĐỔI NỘI DUNG theo thời gian ở cùng dải-Y (nhiều txt khác nhau); nhãn
        # máy/danh-sách nội-dung CỐ ĐỊNH (1 txt suốt). → CHỈ bỏ dải mật-độ-cao VÀ nội-dung-cố-định (≤ ngưỡng txt);
        # dải ĐỔI nội dung (≥2 txt khác) GIỮ dù khung đông = sub thoại. Ngưỡng: CHE_DONG_TXT_MIN (mặc định 2).
        # Ngưỡng 3 (không 2): OCR đọc CHẬP CHỜN nhãn máy/danh-sách cũng tạo 2 txt "khác" giả (nhiễu) → ngưỡng 2 giữ
        # oan cả nhãn. Sub thoại thật đổi ≥3-13 nội dung trong ~24 frame; nhãn/danh-sách ≤2 (nhiễu). 3 tách sạch hơn.
        try:
            _txt_min = int(os.environ.get("CHE_DONG_TXT_MIN", "") or 3)
        except ValueError:
            _txt_min = 3
        # 🐛 FIX (khách video 52' "Thỏ cảnh sát": Pha 1 học ra dải y2% (watermark 'bilibili漫屋' góc trên, ĐỨNG
        # YÊN suốt video) LẪN vào dải sub-thoại thật y90% → gate Pha 2 phải trùm 2%-93% (gần FULL khung) thay vì
        # dải hẹp ~10-20% → mỗi mẫu OCR quét ảnh khổng lồ → 1483 mẫu × ảnh to = >1 GIỜ cho video 52'. Watermark
        # ĐƠN ĐỘC (không cùng khung với chữ khác) có mật-độ THẤP → lọt qua test mật-độ ở trên (chỉ bắt watermark
        # LẪN trong cảnh-đông). Thêm test ĐỘC LẬP: dải xuất hiện ở HẦU HẾT mẫu Pha-1 (≥80%, y hệt watermark cố
        # định vị-trí suốt video) NHƯNG chỉ 1 NỘI-DUNG DUY NHẤT (0-1 txt, tuyệt đối không đổi — sub thoại thật
        # dù ngắn cũng hiếm khi đứng yên y hệt suốt >80% mẫu rải-đều-toàn-video) → loại (watermark tĩnh).
        # Tắt: CHE_DONG_WM_STATIC=0.
        _wm_static_frac = 0.0
        try:
            _wm_static_frac = float(os.environ.get("CHE_DONG_WM_STATIC", "") or 0.8)
        except ValueError:
            _wm_static_frac = 0.8
        # 🐛 FIX (khách "cùng 1 dải vẫn mất sub" — video có ≥2 dải hardsub đồng thời, vd sub-thoại + watermark
        # góc khác): test "watermark tĩnh" ở dưới chỉ dựa vào 12 mẫu Pha 1 RẤT THƯA (n_probe mặc định) — nếu OCR
        # tại các mẫu đó tình cờ đọc TRÙNG nội dung dải sub-thoại thật (do câu thoại dài trải nhiều mẫu, hoặc OCR
        # đọc lệch nhẹ về cùng 1 kết quả), dải SUB THẬT bị hiểu lầm là watermark tĩnh → LOẠI OAN, chỉ giữ oan
        # dải khác (watermark/label thật) → mất sub hoàn toàn dù dải không đổi vị-trí. Dải CÓ NHIỀU FRAME NHẤT
        # (_bi_chinh) hầu như luôn là sub-thoại thật (watermark góc thường xuất hiện ít mẫu hơn dải chính do
        # kích thước nhỏ/dễ trượt mẫu) → KHÔNG bao giờ loại dải chính bằng test tĩnh, chỉ áp dụng cho dải KHÁC.
        _bi_chinh = max(_bins_od, key=lambda _bi: len(dai[_bi]["frames"]))
        _giu = [_bi for _bi in _bins_od
                if (_dens[_bi] < _dens_max or len(dai[_bi].get("txts", set())) >= _txt_min)
                and (_bi == _bi_chinh or not (_wm_static_frac > 0 and len(dai[_bi]["frames"]) >= n_probe * _wm_static_frac
                         and len(dai[_bi].get("txts", set())) <= 1))]
        if _giu and len(_giu) < len(_bins_od):   # có bỏ bớt nhưng không bỏ hết → áp dụng
            _bo = [_bi for _bi in _bins_od if _bi not in _giu]
            log_fn("🎯 Pha 1: lọc mật-độ+temporal → bỏ %d dải cảnh-cận (đông+nội-dung-cố-định) giữ %d dải sub-thoại (thưa HOẶC đổi nội-dung)."
                   % (len(_bo), len(_giu)))
            _bins_od = sorted(_giu)
            # best (dải mạnh nhất) có thể vừa bị lọc bỏ → rebind về dải giữ-lại nhiều frame nhất (nhánh 1-dải bên dưới dùng best)
            best = max((dai[_bi] for _bi in _bins_od), key=lambda d: len(d["frames"]))
    if os.environ.get("CHE_DONG_1DAI") == "1" or len(_bins_od) <= 1:
        # 1 dải (hoặc ép cũ): gộp best + bin kề ±1 (sub 2 dòng)
        _bb = int(sum(best["ys"]) / len(best["ys"]) / BIN)
        _keep = {_bb} | {bi for bi, d in dai.items() if len(d["frames"]) >= max(2, min_frame - 1) and abs(bi - _bb) <= 1}
    else:
        # NHIỀU dải ổn định cách xa → GIỮ HẾT + bin kề mỗi dải (bao trọn sub 2 dòng ở mỗi vị-trí)
        _keep = set()
        for _b in _bins_od:
            _keep |= {bi for bi in dai if abs(bi - _b) <= 1 and len(dai[bi]["frames"]) >= max(2, min_frame - 1)}
            _keep.add(_b)
        log_fn("🎯 Pha 1: %d dải-Y hardsub ổn định (khác vị-trí) → che+quét CẢ (che chữ cao lẫn thấp)." % len(_bins_od))
    _ys = [y for bi in _keep for y in dai.get(bi, {"ys": []})["ys"]]
    if not _ys:
        _ys = best["ys"]
    y0f, y1f = min(_ys), max(_ys)
    # 🐛 FIX (tổng kiểm tra: fix#1 tác-dụng-phụ): 2 dải cách xa → (y0f,y1f) trùm cả KHOẢNG GIỮA → Pha 2 crop cả
    # giữa → che nhầm chữ Hán CẢNH (biển hiệu/kệ chợ/phố) nằm giữa 2 dải. Trả thêm DANH SÁCH DẢI GIỮ (mỗi dải =
    # khoảng y các bin liền kề) → Pha 2 lọc BỎ box có tâm-y NGOÀI các dải này (vùng giữa) → hết che nhầm. Dải đơn
    # (bao gồm sub 2 dòng liền) không đổi hành vi. Tắt lọc: CHE_DONG_GATE_LIST=0.
    _keep_s = sorted(_keep)
    _dai_list = []                       # [(y0, y1)] mỗi cụm bin LIỀN KỀ = 1 dải riêng
    _dai_bins = []                       # song song _dai_list: các bin thuộc từng dải (để tính dải CHÍNH bên dưới)
    _cum = None
    _cum_b = None
    for _bi in _keep_s:
        _bys = dai.get(_bi, {"ys": []})["ys"]
        if not _bys:
            continue
        if _cum is None or _bi - _cum[2] > 1:      # cách >1 bin = dải MỚI
            if _cum:
                _dai_list.append((_cum[0], _cum[1])); _dai_bins.append(_cum_b)
            _cum = [min(_bys), max(_bys), _bi]; _cum_b = [_bi]
        else:
            _cum[0] = min(_cum[0], min(_bys)); _cum[1] = max(_cum[1], max(_bys)); _cum[2] = _bi
            _cum_b.append(_bi)
    if _cum:
        _dai_list.append((_cum[0], _cum[1])); _dai_bins.append(_cum_b)
    # 🐛 FIX (user test video nhiều chữ: sub đáy bị BỎ): dải học từ ít mẫu (sub đổi nội dung → bin thưa) → range
    # y RẤT HẸP (vd 0.9026-0.9028) → Pha 2 lọc box tâm-y ngoài dải hẹp → BỎ OAN sub. Nới mỗi dải tối thiểu ±1 BIN
    # (5%) → bao trọn hàng chữ (cao ~5-7%) dù học được ít mẫu. Chỉ để LỌC (vùng giữa 2 dải xa), không đổi crop/y_gate.
    _dai_list = [(max(0.0, _d0 - BIN), min(1.0, _d1 + BIN)) for _d0, _d1 in _dai_list]
    log_fn("🎯 Pha 1 (quét %d frame toàn màn): dải sub y %.0f%%–%.0f%% (%d dải rời, dải mạnh %d/%d frame)."
           % (n_probe, y0f * 100, y1f * 100, len(_dai_list), len(best["frames"]), n_probe))
    # PHẦN TỬ 4 = DẢI CHÍNH (y0, y1, x0, x1) — CHỈ MỘT dải, không phải hợp nhất.
    # Cách chuẩn ngành (tra tài liệu trích hardsub: patent "Subtitle extraction method" US11367282 dùng
    # **mode method** để chốt vị-trí dải phụ đề; videocr/VideOCR mặc định chỉ lấy 1/3 DƯỚI khung): lấy dải xuất
    # hiện NHIỀU NHẤT, KHÔNG lấy min/max của mọi dải.
    # 🐛 Chính chỗ này đã sai và làm hỏng chế độ bỏ-Pha-2: `(y0f,y1f)` là min/max TÂM-Y của MỌI bin giữ lại nên
    # video 3 dải rời cho ra y 24%–100% (76% khung); còn `best` (bin nhiều FRAME nhất) lại trúng WATERMARK mép
    # phải (x 93%–100%) vì watermark có mặt ở MỌI khung. Tài liệu nói đúng dấu hiệu để tách: phụ đề giữ vị-trí
    # >1s NHƯNG ĐỔI NỘI DUNG, còn watermark/nhãn thì nội-dung CỐ ĐỊNH → dùng số text KHÁC NHAU (`txts`) làm
    # trọng số, không dùng số frame trần.
    _main = None
    try:
        _bi_best, _sc_best = -1, -1.0
        for _i, _bins in enumerate(_dai_bins or []):
            _fr = set(); _tx = set(); _n = 0
            for _b in (_bins or []):
                _d = dai.get(_b)
                if not _d:
                    continue
                _fr |= _d["frames"]; _tx |= _d["txts"]; _n += len(_d["ys"])
            if not _fr:
                continue
            _sc = len(_fr) * (1.0 + min(len(_tx), 20))   # nhiều frame VÀ nội dung đổi nhiều = phụ đề thật
            # ƯU TIÊN 1/3 DƯỚI KHUNG (chủ dự án chốt; cũng là mặc định của videocr/VideOCR: không xác định
            # được thì lấy 1/3 dưới). Dải nằm trong 1/3 dưới được ưu tiên TUYỆT ĐỐI so với dải ở trên —
            # chỉ khi KHÔNG dải nào ở 1/3 dưới mới xét tới dải trên (video đặt sub ở trên vẫn chạy được).
            _ycb = sum(_ys3 for _b in (_bins or []) for _ys3 in dai.get(_b, {"ys": []})["ys"])
            _ycb = _ycb / max(1, _n)
            if _ycb >= (2.0 / 3.0):
                _sc *= 1000.0
            if _sc > _sc_best:
                _sc_best, _bi_best = _sc, _i
        if _bi_best >= 0:
            _bins = _dai_bins[_bi_best]
            # THU DẢI VỀ ĐÚNG HÀNG PHỤ ĐỀ: dải là cụm bin LIỀN KỀ, nên watermark/logo nằm sát ngay trên (hoặc
            # dưới) phụ đề bị GỘP CHUNG vào — ảnh thật video khách: `@木元森影剧` ở bin y85-90%, phụ đề ở bin
            # y90-95%, 2 bin liền nhau ⇒ dải thành 86%-100% và bề ngang bị kéo sang trái tới 17%.
            # Hệ quả: crop cao hơn cần thiết (rec đọc kém) + det bắt luôn watermark ghép vào câu
            # ('@木元林彩刷 再看那道身影已经不见了' — 28/631 cue dính rác).
            # Dấu hiệu tách đã có sẵn trong pipeline (`_loc_dai_sub_that`): phụ đề mỗi câu một ĐỘ DÀI khác nhau
            # nên BỀ NGANG BIẾN THIÊN lớn; watermark/logo bề ngang gần như KHÔNG đổi. Dùng đúng ngưỡng đó
            # (OCR_SUB_W_BIEN, mặc định 0.05) để loại bin tĩnh ở MÉP dải — chỉ loại khi còn bin động, và chỉ
            # ở mép (không đục lỗ giữa dải). Tắt: CHE_DONG_BO_BIN_TINH=0.
            if os.environ.get("CHE_DONG_BO_BIN_TINH", "1") != "0" and len(_bins) > 1:
                try:
                    _bien_min = float(os.environ.get("OCR_SUB_W_BIEN", "") or 0.05)
                except ValueError:
                    _bien_min = 0.05
                def _bien(_b):
                    _ws = [v[1] - v[0] for v in dai.get(_b, {}).get("xs", [])]
                    return (max(_ws) - min(_ws)) if len(_ws) > 1 else 0.0
                _dong = [_b for _b in _bins if _bien(_b) > _bien_min]
                if _dong:
                    _lo, _hi = min(_dong), max(_dong)
                    _bo = [_b for _b in _bins if _b < _lo or _b > _hi]
                    if _bo:
                        log_fn("🧹 Thu dải: bỏ %d hàng chữ TĨNH ở mép (bề ngang không đổi = watermark/logo), "
                               "giữ hàng phụ đề (bề ngang đổi theo từng câu)." % len(_bo))
                        _bins = [_b for _b in _bins if _lo <= _b <= _hi]
            _ys2 = [y for _b in _bins for y in dai[_b]["ys"]]
            _xs2 = [x for _b in _bins for x in dai[_b]["xs"]]
            # ⚠ TRƯỚC dùng tâm-y ± BIN(5%) → dải cao 13-14% khung trong khi 1 DÒNG chữ chỉ ~3%. Pha đọc
            # dùng recognizer MỘT DÒNG, crop cao gấp 4-5 lần dòng chữ thì đọc ra rác: đo thật 003.mp4 chỉ ra
            # 3 cue, mỗi cue ĐÚNG 1 KÝ TỰ ('一','小','潮'), 001.mp4 44→21 cue khớp 0/44.
            # Phải lấy CHIỀU CAO HỘP THẬT (percentile 10/90 để bỏ hộp lệch) + đệm 1%.
            _hs2 = [h for _b in _bins for h in dai[_b].get("hs", [])]
            if len(_hs2) >= 5:
                _t = sorted(v[0] for v in _hs2); _u = sorted(v[1] for v in _hs2)
                _my0 = max(0.0, _t[int(len(_t) * 0.10)] - 0.01)
                _my1 = min(1.0, _u[min(len(_u) - 1, int(len(_u) * 0.90))] + 0.01)
            elif _hs2:
                _my0 = max(0.0, min(v[0] for v in _hs2) - 0.01); _my1 = min(1.0, max(v[1] for v in _hs2) + 0.01)
            else:
                _my0 = max(0.0, min(_ys2) - BIN); _my1 = min(1.0, max(_ys2) + BIN)
            # BỀ NGANG = MIN/MAX trong dải (đã khoá Y nên mọi hộp ở đây là chữ phụ đề — câu DÀI NHẤT quyết
            # bề ngang). ⚠ ĐÃ THỬ percentile 5/95 và BỊ LOẠI: ra x 19%–81% → CẮT MẤT chữ đầu/cuối câu dài
            # (đo thật: '走开！'→'开!', '今天轮到哥哥'→'…今天轮到哥'). Chỉ bỏ 1 hộp lệch nhất mỗi phía
            # (percentile 1/99) để một watermark cùng dòng không kéo dải rộng ra vô lý.
            _mx0, _mx1 = 0.0, 1.0
            if len(_xs2) >= 10:
                _l = sorted(v[0] for v in _xs2); _r = sorted(v[1] for v in _xs2)
                _mx0 = _l[int(len(_l) * 0.01)]; _mx1 = _r[min(len(_r) - 1, int(len(_r) * 0.99))]
            elif _xs2:
                _mx0 = min(v[0] for v in _xs2); _mx1 = max(v[1] for v in _xs2)
            # CHỐT: chỉ nhận DẢI CHÍNH khi nó KHÍT ~1 DÒNG chữ. Sub ĐỨNG YÊN 1 chỗ → dải ≈ chiều cao dòng.
            # Sub DI CHUYỂN theo chiều dọc → dải phải trùm cả khoảng chạy ⇒ cao gấp nhiều lần dòng chữ ⇒ pha đọc
            # (recognizer MỘT DÒNG) đọc ra rác. ĐO THẬT: video khách dải/dòng = 1.24 (đọc đúng 629 cue);
            # 4 video sub-di-chuyển tỉ lệ 2.4-2.7 → cue khớp chỉ 0-19%. Ngưỡng 1.8 tách sạch 2 nhóm.
            # Không đạt → _main = None → chạy pha dò đầy đủ như cũ (đúng nhưng chậm hơn).
            _lh = 0.0
            if _hs2:
                _hh = sorted(max(0.0, v[1] - v[0]) for v in _hs2)
                _lh = _hh[len(_hh) // 2]                  # trung vị chiều cao dòng
            _ty = (_my1 - _my0) / _lh if _lh > 0.002 else 99.0
            if _my1 > _my0 and _mx1 > _mx0 and _ty <= 1.8:
                _main = (_my0, _my1, _mx0, _mx1)
            elif _my1 > _my0:
                log_fn("ℹ Dải sub cao gấp %.1f lần dòng chữ (sub DI CHUYỂN dọc) → phải dò từng đoạn, chậm hơn."
                       % _ty)
    except Exception as _e_main:
        # KHÔNG im lặng: _main=None làm MẤT chế độ bỏ-pha-dò + mất chốt "đừng bỏ dải mạnh" mà không dấu vết.
        log_fn("⚠️ Tính DẢI CHÍNH lỗi (%s: %s) → mất chốt bảo vệ dải mạnh, quét theo hợp nhất như cũ."
               % (type(_e_main).__name__, str(_e_main)[:100]))
        _main = None
    # Ô CHỮ TĨNH (watermark/logo) đọc từ BẢN ĐỒ TẦN SUẤT đã cộng ở vòng thăm dò trên.
    # Pixel chữ xuất hiện ở ≥ CHE_DONG_WM_TY (mặc định 0.8 = 80%) số khung thăm dò ⇒ đứng YÊN ⇒ watermark/logo.
    # Phụ đề đổi câu nên cùng pixel hiếm khi đạt tỉ lệ đó.
    # ⚠ ĐÃ THỬ & LOẠI cách cũ (bin có "bề ngang KHÔNG đổi"): đo trên video khách ra RỖNG — watermark bán trong
    # suốt làm OCR đọc bề ngang lệch mỗi khung, nên tín hiệu bề-ngang-ổn-định không bắt được nó.
    # Chốt an toàn: KHÔNG bao giờ nhận ô chồng dải chính >30%, và bỏ ô quá to (>15% diện tích khung — đó là
    # cảnh/nền chứ không phải logo). Sai lầm tệ nhất là bỏ sót watermark = quay về hiện trạng. Tắt: CHE_DONG_WM_TINH=0.
    global _WM_TINH
    _WM_TINH = []
    # ⚠ MẶC ĐỊNH TẮT — ĐÃ ĐO TRÊN CA THẬT VÀ KHÔNG ĂN THUA. Clip 5 phút video khách:
    #     TẮT 69.2s · 150 cue · 2 cue dính '@'   |   BẬT 72.8s · 150 cue · 2 cue dính '@'
    # Lý do: watermark ở y 84.0-90.6% CHỒNG LÊN dải sub (88.3-98.2%). Che hết thì ăn vào chữ; che phần nằm
    # trên dải thì chỉ còn 0.8% bề dày, vô nghĩa. KHÔNG có đường cắt NGANG nào tách được 2 thứ này —
    # dấu hiệu đúng phải là chiều NGANG (watermark x 14-33%, phụ đề căn giữa ~x 50%).
    # Giữ code vì bản đồ tần suất CÓ bắt đúng vùng đứng yên (đã verify: 3 vệt logo mép phải x 96-99%),
    # dùng được cho video watermark nằm TÁCH KHỎI dải sub. Bật: CHE_DONG_WM_TINH=1.
    if os.environ.get("CHE_DONG_WM_TINH", "0") == "1" and _acc is not None and _n_acc >= 6:
        try:
            _ty_wm = float(os.environ.get("CHE_DONG_WM_TY", "") or 0.4)   # ×30 = ngưỡng std (mặc định 12)
        except ValueError:
            _ty_wm = 0.4
        try:
            _mean = _acc / float(_n_acc)
            _std = np.sqrt(np.maximum(0.0, _acc2 / float(_n_acc) - _mean * _mean))
            _net = np.abs(cv2.Laplacian(_mean, cv2.CV_32F, ksize=3))
            # ĐỨNG YÊN (std thấp) VÀ CÓ NÉT (laplacian cao) = chữ/logo dán đè cố định.
            # Nền phẳng (trời, tường) cũng std thấp nhưng KHÔNG có nét → loại. Phụ đề đổi chữ → std cao → loại.
            _hot = ((_std < (_ty_wm * 30.0)) & (_net > 18.0)).astype(np.uint8)
            if _hot.any():
                _ah, _aw = _hot.shape[:2]
                # nối các nét chữ cùng dòng thành 1 khối (kernel dẹt: rộng ngang, mỏng dọc)
                _hot = cv2.morphologyEx(_hot, cv2.MORPH_CLOSE, np.ones((3, 25), np.uint8))
                _nc, _lb, _st, _ = cv2.connectedComponentsWithStats(_hot, connectivity=8)
                for _i in range(1, _nc):
                    _x, _y, _w2, _h2, _ar = _st[_i]
                    if _ar < 40:
                        continue                          # đốm nhiễu
                    if (_w2 * _h2) > (_aw * _ah * 0.15) or _h2 > _ah * 0.15:
                        continue                          # quá to → cảnh/nền, không phải logo
                    _r = (max(0.0, _y / float(_ah) - 0.004), min(1.0, (_y + _h2) / float(_ah) + 0.004),
                          max(0.0, _x / float(_aw) - 0.004), min(1.0, (_x + _w2) / float(_aw) + 0.004))
                    if _r[3] - _r[2] > 0.90:
                        continue                          # phủ ngang gần hết khung = mép letterbox, không phải logo
                    # CẮT ô cho nằm HẲN NGOÀI dải phụ đề (thay vì bỏ cả ô): watermark hay nằm sát ngay trên
                    # hàng sub, bỏ cả ô thì không che được gì. Tô nhầm vào dải sub là mất chữ nên chừa 1%.
                    if _main:
                        _c0, _c1 = _r[0], _r[1]
                        if _c1 > _main[0] - 0.01:
                            _c1 = _main[0] - 0.01
                        if _c1 - _c0 < 0.008:
                            continue                      # cắt xong còn quá mỏng → bỏ
                        _r = (_c0, _c1, _r[2], _r[3])
                    _WM_TINH.append(_r)
        except Exception as _e_wm:
            log_fn("⚠️ Bản đồ tần suất lỗi (%s: %s) → không che ô chữ tĩnh."
                   % (type(_e_wm).__name__, str(_e_wm)[:100]))
            _WM_TINH = []
        if _WM_TINH:
            log_fn("🩹 Bản đồ tần suất: %d ô chữ ĐỨNG YÊN (watermark/logo) → che khỏi OCR: %s"
                   % (len(_WM_TINH), ", ".join("y%.0f-%.0f%% x%.0f-%.0f%%"
                                               % (w[0] * 100, w[1] * 100, w[2] * 100, w[3] * 100)
                                               for w in _WM_TINH[:3])))
    if _main:
        log_fn("🎯 Pha 1 DẢI CHÍNH: y %.1f%%–%.1f%% (cao %.3f), x %.0f%%–%.0f%% | dòng %.3f | tỉ lệ %.2f"
               % (_main[0] * 100, _main[1] * 100, _main[1] - _main[0], _main[2] * 100, _main[3] * 100,
                  _lh, _ty))
    # phần tử 5 = TỈ LỆ khung thăm dò mà dải mạnh XUẤT HIỆN. Đây là tín hiệu quyết định có bỏ được pha dò
    # hay không (xem `_bo_do` ở phat_hien_sub_ocr): dải có mặt ở gần như MỌI khung ⇒ phụ đề một dải ổn định
    # ⇒ một dải cố định là đủ. Rời rạc ⇒ video nhiều vùng chữ (khung chat, sub nhảy chỗ) ⇒ phải dò từng đoạn.
    return (y0f, y1f, _dai_list, _main, (len(best["frames"]) / float(max(1, n_probe))))


def phat_hien_sub_ocr(video, log_fn=print, fps_sample=None, n_max=1500, y_gate=None, loc_title=True, src_lang=None):
    """HƯỚNG B — dò dải chữ Trung bằng OCR THƯA + ỔN ĐỊNH (thay 'ảnh-rẻ' sáng+gradient — feature low-level
    không mã hoá được 'đây là chữ', false-positive kinh niên trên giường/zipper/chữ-in-áo/texture).
    Lấy mẫu ~1 fps → RapidOCR det+rec trên crop CẢ KHUNG (bắt cả title-card đỉnh + phụ đề đáy) → CHỈ giữ box
    có ≥N ký tự Hán + conf ≥ ngưỡng (OCR ĐỌC hình dạng ký tự → texture/Latin/số bị loại tự nhiên) → gom theo
    Y thành track → ổn định band qua thời gian (hysteresis: box mới lệch nhỏ → giữ band cũ union; mất mẫu
    ngắn → giữ; mất lâu → tách segment mới). Trả list (t_on,t_off,y0,y1,x0,x1) — CÙNG format
    phat_hien_hop_dong (drop-in), None nếu KHÔNG thấy chữ Hán nào (video không hardsub Trung).
    FPS lấy mẫu: tham số fps_sample > env CHE_DONG_FPS đặt tường minh > ADAPTIVE theo độ dài video (video dài
    tự dò thưa, bound chi phí — xem _fps_ocr_adaptive). n_max = trần cứng số mẫu (giãn thêm stride nếu video
    quá dài) để không kẹt/treo dù ước lượng độ dài sai.
    y_gate=(y0f,y1f) fraction (user: "blur động chỉ quét phần chắc có sub — như blur tĩnh, chỉ fit hơn"): GIỚI
    HẠN vùng crop OCR vào ĐÚNG dải-Y mà blur TĨNH (phat_hien_dai_rapid) đã khoanh + đệm → (1) LOẠI false-positive
    ngoài dải (biển hiệu/kệ hàng/title-card đỉnh không bị OCR nhầm thành sub), (2) NHANH hơn (OCR vùng hẹp), (3)
    vẫn FIT KHÍT từng câu bên trong dải. y_gate=None (mặc định) = quét cả khung như cũ (không đổi caller khác).
    Env: CHE_DONG_FPS (ép cứng fps), CHE_DONG_OCR_CONF (0.55), CHE_DONG_OCR_HAN (2), CHE_DONG_YLO (10 = quét từ
    10% khung → bắt title-card đặt cao; BỎ QUA khi có y_gate), CHE_DONG_GATE_PAD (0.03 = đệm trên/dưới y_gate)."""
    import cv2
    import numpy as np
    import ocr_text
    from collections import defaultdict
    import time as _t2
    # fps ÉP CỨNG (tham số hoặc env) — nếu None cả 2 → quyết ADAPTIVE sau khi biết độ dài video (dưới)
    _fps_ep = fps_sample
    if _fps_ep is None:
        _fps_env = os.environ.get("CHE_DONG_FPS", "")
        if _fps_env:
            try:
                _fps_ep = float(_fps_env)
            except ValueError:
                _fps_ep = None
    try:
        conf_min = float(os.environ.get("CHE_DONG_OCR_CONF", "") or 0.55)
    except ValueError:
        conf_min = 0.55
    try:
        han_min = int(os.environ.get("CHE_DONG_OCR_HAN", "") or 2)
    except ValueError:
        han_min = 2
    _dem_chinh, _ten_he = _he_chu_nguon(src_lang)   # hệ chữ NGUỒN (gate box theo ngôn ngữ, không cứng Hán)
    _la_han_src = _dem_chinh is _dem_han
    try:
        ylo_pct = float(os.environ.get("CHE_DONG_YLO", "10") or 10) / 100.0
    except ValueError:
        ylo_pct = 0.10

    cap = cv2.VideoCapture(os.path.abspath(video))
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    nfr = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if nfr <= 0 or W <= 0 or H <= 0:
        cap.release()
        return None
    # ⚡ PHA DÒ THỜI ĐIỂM dùng engine TINY (chủ dự án chốt 13/08/2026). Đây là chặng ngốn ~92% thời gian OCR
    # (đo: detect 216s / tổng 234s), và `det` chiếm 92% mỗi lời gọi (đo trên dải 1280x123, video 720p:
    # det+rec 238,3ms · rec-only 19,6ms). Tiny rẻ hơn hẳn ở đúng chặng đó:
    #     SMALL 232,7 ms/lần  ·  TINY 73,9 ms/lần  → nhanh 3,15×, cùng bắt 12 hộp chữ / 15 lần.
    # ⚠ KHÁC Pha 1: pha 1 chỉ cần VỊ TRÍ Y nên tiny đọc lem không sao. Vòng này CÓ dùng text — để phân biệt
    # sub thoại (nội dung ĐỔI qua các khung) với nhãn tĩnh (một text lặp), và để lọc box qua
    # `_dem_chinh(txt) >= han_min`. Tiny đọc lem ⇒ RỦI RO rơi box. Vì vậy có cổng để A/B và lùi được ngay.
    # Pha ĐỌC CHỮ (ocr_text.ocr_dong) VẪN dùng SMALL — không đụng, chất lượng text không đổi.
    # Tắt (về SMALL như cũ): OCR_DO_TINY=0.
    eng = ocr_text._engine_dinh_vi() if os.environ.get("OCR_DO_TINY", "1") != "0" else ocr_text._engine()
    sc = 1280.0 / W if W > 1280 else 1.0
    # TỰ HỌC DẢI SUB (PHA 1) khi caller KHÔNG ép y_gate: quét THƯA toàn màn → tìm dải-Y sub hay xuất hiện (user:
    # "quét toàn màn nhiều frame → xác định chỗ sub → chỉ OCR dải đấy, vừa nhanh vừa không nhầm"). Tự học TRONG
    # blur động (không mượn blur tĩnh) → không dính lỗi tĩnh dò nhầm kệ/biển. None → lùi quét cả khung (an toàn).
    # Tắt tự-học: CHE_DONG_TUHOC=0. Ép cứng y_gate (tham số) BỎ QUA pha 1 (đã biết dải, khỏi quét lại).
    _dai_giu = None      # [(y0,y1)] dải rời từ Pha 1 → lọc box NGOÀI dải (bỏ vùng giữa 2 dải xa). None = không lọc.
    _p1_main = None      # (y0,y1,x0,x1) DẢI CHÍNH từ Pha 1 — dùng cho chế độ BỎ PHA 2
    _p1_on = None        # tỉ lệ khung thăm dò có dải mạnh — tín hiệu quyết định bỏ pha dò
    n_probe_used = 0
    if not y_gate:
        # DẢI NGƯỜI DÙNG TỰ KHOANH trong preview (localize đặt từ `che_band_manual`) — dùng luôn, khỏi dò.
        # Đi bằng env vì `ocr_dong`/`asr_segments` ở giữa không có tham số này; luồn qua 3 chữ ký hàm chỉ để
        # chuyển 2 con số là thừa, và env là cách file này vốn nhận mọi tham số khác.
        try:
            _mg = (os.environ.get("OCR_Y_GATE", "") or "").split(",")
            if len(_mg) >= 2:
                _g0, _g1 = float(_mg[0]), float(_mg[1])
                if 0.0 <= _g0 < _g1 <= 1.0 and (_g1 - _g0) >= 0.02:
                    y_gate = (_g0, _g1)
                    log_fn("🎯 Dùng DẢI NGƯỜI DÙNG khoanh: y %.0f%%–%.0f%% → bỏ hẳn khâu dò dải." % (_g0 * 100, _g1 * 100))
        except Exception as _e_g:
            # Im lặng ở đây = người dùng khoanh dải xong mà tool vẫn dò lại từ đầu (~300s) không rõ lý do.
            log_fn("⚠️ Đọc dải người dùng khoanh lỗi (%s: %s) → bỏ qua, tự dò lại từ đầu."
                   % (type(_e_g).__name__, str(_e_g)[:100]))
    # 🔴 (07/08/2026) RESET `_WM_TINH` Ở ĐÂY, VÔ ĐIỀU KIỆN. Trước đây nó chỉ được dọn BÊN TRONG
    # `_hoc_dai_sub_thua` (dòng ~555) — mà hàm đó chỉ chạy khi `not y_gate` (dòng dưới). Hệ quả:
    # video A chạy Pha 1 và điền `_WM_TINH` = toạ độ watermark CỦA A; video B tiếp theo CÓ `y_gate`
    # (người dùng tự khoanh dải trong editor, hoặc đã có dải blur tĩnh) ⇒ Pha 1 BỊ BỎ QUA ⇒ `_WM_TINH`
    # KHÔNG BAO GIỜ được dọn ⇒ `ocr_text.ocr_dong` (:910) **tô phẳng các ô của video A lên MỌI khung của
    # video B** trước khi OCR nhìn ⇒ mất câu phụ đề nằm trúng vùng đó, TUYỆT ĐỐI không có log.
    # Đây đúng lỗi §55.2 dạng khó thấy nhất: khối reset SỐNG TRONG MỘT NHÁNH ĐIỀU KIỆN của hàm khác.
    # (Tính năng mặc định TẮT — `CHE_DONG_WM_TINH=0` — nên đây là mìn chưa nổ, nhưng nổ thì im lặng.)
    global _WM_TINH
    _WM_TINH = []
    if y_gate and len(y_gate) >= 2:
        # CALLER ĐÃ CHO DẢI (người dùng tự khoanh trong preview / dải blur tĩnh đã dò) → KHỎI DÒ GÌ NỮA.
        # 🐛 XUNG ĐỘT trước đây: y_gate ép làm Pha 1 bị BỎ QUA ⇒ `_p1_main` rỗng ⇒ nhánh nhanh KHÔNG kích hoạt
        # ⇒ rơi vào quét Pha 2 ĐẦY ĐỦ. Tức người dùng khoanh sẵn dải hẹp lại còn CHẬM HƠN để tool tự dò.
        _p1_main = (max(0.0, float(y_gate[0])), min(1.0, float(y_gate[1])),
                    float(y_gate[2]) if len(y_gate) >= 4 else 0.0,
                    float(y_gate[3]) if len(y_gate) >= 4 else 1.0)
    if not y_gate and os.environ.get("CHE_DONG_TUHOC", "1") != "0":
        try:
            # PHA 1 dùng engine ĐỊNH VỊ (tiny — nhanh ~24%, đủ để định vị dải-Y; pha 2 dưới dùng eng small đọc text)
            _eng_dv = ocr_text._engine_dinh_vi()
            # SỐ KHUNG THĂM DÒ THEO THỜI LƯỢNG (chủ dự án: "thêm nhiều khung hơn cũng được, tầm 30 với video
            # 5p trở lên, vì đôi lúc khung không thấy sub làm tool không nhận diện được sub/ngôn ngữ").
            # Càng đúng khi Pha 2 đã bỏ: Pha 1 là tầng DUY NHẤT xác định dải — 12 khung rơi trúng đoạn không có
            # sub là hỏng cả video. 30 khung dùng engine tiny nên chỉ tốn thêm vài giây. Ép cứng: CHE_DONG_PROBE.
            _np = 30 if (nfr / (fps or 25.0)) >= 300 else 12
            n_probe_used = _np
            _p1 = _hoc_dai_sub_thua(video, _eng_dv, conf_min, han_min, log_fn=log_fn, n_probe=_np,
                                    src_lang=src_lang)
            if _p1 and len(_p1) >= 3:
                y_gate = (_p1[0], _p1[1])
                # 🔻 TẮT MẶC ĐỊNH 14/08/2026 (chủ dự án: "bỏ cái này vì chỉ hỗ trợ 1 dòng, sub tĩnh").
                # Cơ chế này lọc box nằm GIỮA 2 dải rời — chỉ có nghĩa khi video có nhiều dải chữ ở nhiều
                # độ cao. Nghiệp vụ nay chốt: **chỉ hỗ trợ sub TĨNH, MỘT dòng, ở 1/3 dưới** (`NGHIEP-VU.md` §2.1);
                # sub 2 dòng / nhiều vị trí ⇒ khách tự khoanh hoặc chuyển Whisper. Cộng thêm Pha 1 nay CHỈ quét
                # 1/3 dưới nên "≥2 dải rời" càng hiếm. Bật lại: CHE_DONG_GATE_LIST=1.
                if os.environ.get("CHE_DONG_GATE_LIST", "0") != "0" and len(_p1[2]) >= 2:
                    _dai_giu = _p1[2]        # ≥2 dải rời → lọc box giữa; 1 dải → None (không lọc, giữ như cũ)
                # BỎ DẢI TITLE-CARD ĐỈNH KHỎI VÙNG QUÉT PHA 2 — (y0,y1) trên là HỢP NHẤT mọi dải rời, nên video
                # có chữ đỉnh + sub đáy thì vùng quét trùm gần cả khung: ĐO THẬT video khách → Pha 1 ra "2 dải
                # rời" mà cổng thành y 3%–98% (95% chiều cao) ⇒ Pha 2 OCR gần nguyên khung cho MỌI mẫu.
                # ĐO (video 1356s, OCR GPU): vùng 89% khung 256.3s · vùng 10% khung 158.8s ⇒ hẹp vùng −38%.
                # ⚠ ĐÃ THỬ "OCR từng dải rời" (2 crop nhỏ, bớt 73% diện tích) và BỊ LOẠI — CHẬM HƠN 22%
                # (265.5s → 324.6s): tách vùng = 2 lời gọi engine/mẫu, chi phí cố định mỗi lời gọi lớn hơn phần
                # diện tích tiết kiệm. Phải giữ ĐÚNG 1 lời gọi, chỉ thu hẹp vùng.
                # LUẬT: bỏ dải có tâm-y < CHE_DONG_YMIN (= ngưỡng title-card mà chính pipeline dùng để loại
                # chúng khỏi lời thoại) — NHƯNG KHÔNG BAO GIỜ bỏ dải chứa DẢI MẠNH NHẤT của Pha 1, để video
                # "sub đặt ở TRÊN" (loc_title=False sinh ra vì ca này) không bị cắt mất chính phụ đề của nó.
                # Tắt: CHE_DONG_BO_DINH=0.
                _p1_main = _p1[3] if len(_p1) >= 4 else None      # (y0,y1,x0,x1) DẢI CHÍNH — chỉ 1 dải
                _p1_on = _p1[4] if len(_p1) >= 5 else None        # tỉ lệ khung có dải mạnh
                _yc_b = ((_p1_main[0] + _p1_main[1]) / 2.0) if _p1_main else None
                # 🔻 TẮT MẶC ĐỊNH 14/08/2026 (chủ dự án: "giờ chỉ scan đúng 1/3 dải dưới thôi nên không cần nữa").
                # Cơ chế này bỏ dải title-card ở ĐỈNH khỏi vùng quét — sinh ra khi Pha 1 còn quét CẢ KHUNG và
                # (y0,y1) là hợp nhất mọi dải rời nên trùm gần hết màn. Nay Pha 1 chỉ quét 1/3 DƯỚI
                # (`CHE_DONG_P1_DUOI`) ⇒ không có dải đỉnh nào để mà bỏ. Bật lại: CHE_DONG_BO_DINH=1.
                if os.environ.get("CHE_DONG_BO_DINH", "0") != "0" and _p1[2] and len(_p1[2]) >= 2:
                    try:
                        _ym = float(os.environ.get("CHE_DONG_YMIN", "0.18") or 0.18)
                    except ValueError:
                        _ym = 0.18
                    if _ym > 0:
                        _gi = [(_d0, _d1) for _d0, _d1 in _p1[2]
                               if (_d0 + _d1) / 2.0 >= _ym
                               or (_yc_b is not None and _d0 <= _yc_b <= _d1)]   # dải mạnh: giữ bằng mọi giá
                        if _gi and len(_gi) < len(_p1[2]):
                            y_gate = (min(d[0] for d in _gi), max(d[1] for d in _gi))
                            if _dai_giu is not None:
                                _dai_giu = _gi if len(_gi) >= 2 else None
                            log_fn("🎯 Bỏ %d dải chữ đỉnh khỏi vùng quét (y<%.0f%%, title-card) → quét y "
                                   "%.0f%%–%.0f%% thay vì %.0f%%–%.0f%%."
                                   % (len(_p1[2]) - len(_gi), _ym * 100, y_gate[0] * 100, y_gate[1] * 100,
                                      _p1[0] * 100, _p1[1] * 100))
            else:
                y_gate = _p1
        except Exception as _e1:
            # 🐛 TỪNG NUỐT LỖI Ở ĐÂY: sửa `hits` thành 5-tuple mà sót 1 chỗ giải nén 3-tuple → ValueError →
            # except này nuốt sạch → Pha 1 KHÔNG chạy, tụt về quét cả khung 338.5s, log KHÔNG hề báo gì.
            # Từ nay lỗi Pha 1 phải KÊU TO (kèm trace khi VC_DEBUG_TRACE=1) vì nó là tầng DUY NHẤT xác định dải.
            if os.environ.get("VC_DEBUG_TRACE") == "1":
                import traceback
                traceback.print_exc()
            log_fn("⚠️ PHA 1 LỖI (%s: %s) → phải quét CẢ KHUNG, chậm hơn nhiều. Báo lỗi này để sửa."
                   % (type(_e1).__name__, str(_e1)[:120]))
            y_gate = None
    # VÙNG CROP OCR: mặc định ylo_pct%..99.5% (cả khung dưới). y_gate (dải sub PHA 1 tự học, hoặc caller ép) →
    # THU HẸP vào đúng dải sub thật + đệm → PHA 2 chỉ OCR dải đó (nhanh + không nhầm chữ nền ngoài dải).
    if y_gate and len(y_gate) >= 2:
        try:
            _gp = float(os.environ.get("CHE_DONG_GATE_PAD", "0.03") or 0.03)
        except ValueError:
            _gp = 0.03
        _gy0 = max(0.0, float(y_gate[0]) - _gp)
        _gy1 = min(1.0, float(y_gate[1]) + _gp)
        y0c = int(_gy0 * H)
        y1c = int(_gy1 * H)
        log_fn("🎯 OCR động GIỚI HẠN vùng theo dải tĩnh: y %.0f%%–%.0f%% (đệm %.0f%%)" % (_gy0 * 100, _gy1 * 100, _gp * 100))
    else:
        y0c = int(ylo_pct * H)
        y1c = int(0.995 * H)
    if y1c <= y0c:                       # dải gate rỗng/đảo (phòng thủ) → lùi quét cả khung dưới
        y0c = int(ylo_pct * H); y1c = int(0.995 * H)
    # DẢI SUB ĐÃ XÁC NHẬN (chủ dự án chốt: "chỉ chấp nhận khi đã bắt được dải sub") — dùng để nới ngưỡng số
    # ký tự BÊN TRONG dải, xem chỗ lọc `_han_can` ở vòng lấy mẫu. Nguồn đáng tin vì đã qua bằng chứng NGHIÊM:
    # Pha 1 `_hoc_dai_sub_thua` quét TOÀN KHUNG ~12 mẫu, vẫn đòi han_min đủ (2) và dải phải xuất hiện ở
    # ≥ CHE_DONG_MIN_FRAME (3) khung khác nhau; hoặc caller ép y_gate (dải blur TĨNH đã dò). Không có dải xác
    # nhận → để None → mọi nơi giữ nguyên ngưỡng cũ.
    _han1_dai = os.environ.get("CHE_DONG_HAN1_DAI", "1") != "0"
    _dai_xn = None
    if y_gate and len(y_gate) >= 2:
        try:
            _dai_xn = (float(y_gate[0]), float(y_gate[1]))
        except Exception:
            _dai_xn = None
    dur = nfr / fps if fps else 0.0
    fps_sample = _fps_ep if _fps_ep is not None else _fps_ocr_adaptive(dur)   # ADAPTIVE nếu không ép cứng
    # stride: dày theo fps_sample NHƯNG giãn thêm nếu vẫn vượt trần n_max (ceil(nfr/n_max)) → không bao giờ
    # quá n_max mẫu (bound cứng thời gian dò cho video cực dài, kể cả khi adaptive chưa đủ thưa).
    stride = max(1, int(round(fps / fps_sample)), -(-nfr // n_max))
    samp_dt = stride / fps                                # khoảng thời gian giữa 2 mẫu (giây)
    # ⚡ BỎ HẲN PHA 2 (chủ dự án chốt: "kệ không cần 2 dòng, đúng dải là được").
    # Pha 1 đã xác định ĐÚNG DẢI sub (y + bề ngang) chỉ với ~12 khung. Pha 2 vốn chỉ để tìm THỜI ĐIỂM có chữ —
    # nhưng pha ĐỌC (ocr_text.ocr_dong) tự làm được việc đó bằng mặt-nạ chữ-trắng rẻ + hysteresis SẴN CÓ, mà nó
    # phải giải mã video thêm một lượt nữa. ⇒ trả 1 đoạn phủ CẢ video tại đúng dải: bỏ trọn 1 lượt giải mã +
    # toàn bộ lời gọi OCR của pha dò.
    # ĐO THẬT video khách (1356s, OCR GPU): dò 301.6s + đọc 79.7s = 381.3s → CHỈ đọc 112.3s (nhanh 3.4×).
    # Chất lượng (so 629 cue bản có pha dò): 611 cue trùng khớp · 2 cue bản mới đọc ĐỦ HƠN (pha dò cắt đoạn
    # giữa câu nên đọc thiếu: '一刹那阿梅还是喜' → '但开窗的那一刹那阿梅还是喜欢上了这里') · MẤT 1 cue 0.2s.
    # ĐÁNH ĐỔI ĐÃ CHỐT: video có sub DI CHUYỂN vị-trí sẽ đọc theo dải cố định của Pha 1 → có thể hụt.
    # Bật lại pha dò: CHE_DONG_PHA2=1.
    # BỎ PHA DÒ chỉ khi NGƯỜI DÙNG đã tự khoanh dải (họ chịu trách nhiệm dải đó đúng), hoặc bật tay
    # CHE_DONG_BO_DO=1. MẶC ĐỊNH VẪN DÒ ĐẦY ĐỦ.
    # 🐛 LÝ DO KHÔNG BẬT MẶC ĐỊNH — đo thật, KHÔNG suy đoán: bỏ pha dò cho video khách RẤT tốt (381s → ~78s,
    # 629 cue y nguyên, 96% text trùng khớp), NHƯNG 4 video khác lại ĐỌC SAI CHỮ: 003 '蔚部长'→'防证',
    # '您坐这'→'您出达'; 001 44 cue → 30, chỉ 4 cue khớp. Nguyên nhân: recognizer đọc theo DÒNG, crop khít
    # từng câu (pha dò cho) thì chữ chiếm gần hết ảnh, còn dải cố định thì chữ chỉ chiếm một phần → mất nét.
    # ĐÃ THỬ chốt "dải/chiều-cao-dòng ≤ 1.8" để tự nhận diện ca an toàn và BỊ LOẠI: video khách 1.24 còn 4 video
    # hỏng là 1.38-1.48 — quá sát, không ngưỡng nào tách được. Chưa có tín hiệu đáng tin ⇒ KHÔNG bật mặc định.
    # TỰ ĐỘNG bỏ pha dò khi dải sub có mặt ở ≥ CHE_DONG_BO_DO_TY (85%) số khung thăm dò.
    # ĐO THẬT (5 video, so với bản còn pha dò): 100% khung → khớp 97% · 58% → 75-92% · 42% → 84% · 25% → 39%.
    # Khe 93-100 vs ≤58 rộng 35 điểm nên ngưỡng 0.85 tách sạch, KHÁC hẳn ngưỡng dải/chiều-cao-dòng từng thử
    # (1.24 vs 1.38, sát nhau, đã trượt). Ép tay: CHE_DONG_BO_DO=1 (bật) / =0 (tắt hẳn).
    try:
        _ty_bo = float(os.environ.get("CHE_DONG_BO_DO_TY", "") or 0.85)
    except ValueError:
        _ty_bo = 0.85
    _ep = os.environ.get("CHE_DONG_BO_DO", "")
    # 🔴 SỬA GỐC (07/08/2026 — khách báo 2 dòng log ngược nhau, xem giải thích ngay dưới):
    # `_p1_on` đo **SỰ HIỆN DIỆN** (tỉ lệ khung có dải mạnh), `_p1_main` đo **TÍNH ỔN ĐỊNH VỊ TRÍ** (có
    # đúng MỘT dải chiếm đa số không). Cổng cũ chỉ nhìn `_p1_on` rồi kết luận "phụ đề MỘT DẢI ổn định" —
    # dùng SAI đại lượng cho kết luận đó.
    # CA THẬT (video khách): `dải mạnh 29/30 frame` = 97% ⇒ cổng bật; nhưng cùng lúc log ghi `11 dải-Y
    # hardsub ổn định (khác vị-trí)`, `4 dải rời`, `sub cao gấp 3.8 lần dòng chữ (DI CHUYỂN dọc)` ⇒ không
    # dải nào chiếm đa số ⇒ `_p1_main` rỗng ⇒ khối "dùng dải chính" bên dưới KHÔNG chạy ⇒ vẫn phải dò đầy
    # đủ. Hai sự thật đó không mâu thuẫn (video CÓ sub gần như mọi khung VÀ sub rải nhiều vị trí); cái sai
    # là NỐI chúng: lấy "khung nào cũng có sub" để suy ra "sub nằm một chỗ".
    # Nay yêu cầu CẢ HAI. Thiếu dải chính → không bật cổng, đi thẳng pha dò.
    # (Comment cũ ở trên cho thấy đã từng thử ngưỡng `dải/chiều-cao-dòng ≤ 1.8` để bắt sub-di-chuyển và bỏ
    #  vì 1.24 vs 1.38 quá sát — `_p1_main` chính là tín hiệu đáng tin thay cho nó, vốn đã có sẵn.)
    # `_du_hien_dien` giữ RIÊNG vế hiện-diện: cổng không cần nó, nhưng dòng ⚠️ bên dưới cần — nếu gộp
    # thẳng vào `_bo_do` thì ca "có sub khắp nơi mà rải nhiều vị trí" sẽ IM LẶNG hoàn toàn, khách chỉ thấy
    # render chậm 4× mà không biết vì sao.
    _du_hien_dien = (_ep != "0" and _p1_on is not None and _p1_on >= _ty_bo)
    _bo_do = (bool((os.environ.get("OCR_Y_GATE", "") or "").strip()) or _ep == "1"
              or (_du_hien_dien and bool(_p1_main)))
    # 🐛 KHÁCH BÁO 07/08/2026: hai dòng log liền nhau NÓI NGƯỢC NHAU —
    #     "⚡ ... phụ đề MỘT DẢI ổn định, bỏ pha dò."
    #     "⚠️ Không xác định được DẢI CHÍNH → chạy pha dò đầy đủ (chậm hơn ~4×)."   ← số ~4× SAI, xem dưới
    # Gốc: dòng ⚡ in dựa vào MỖI `_bo_do`, TRƯỚC khi kiểm `_p1_main`. Không có dải chính thì khối
    # `if _bo_do and _p1_main` bên dưới không chạy ⇒ quyết định bị LẬT, nhưng lời tuyên bố đã in rồi.
    # Thêm `_p1_main` vào điều kiện: chỉ báo "bỏ pha dò" khi THẬT SỰ bỏ được.
    # (Cùng họ với loạt thông báo sai đã vá: khẳng định một việc TRƯỚC khi biết nó có xảy ra không.)
    if _bo_do and _p1_main and _p1_on is not None and _ep != "1":
        log_fn("⚡ Dải sub có mặt ở %.0f%% khung thăm dò (≥%.0f%%) → phụ đề MỘT DẢI ổn định, bỏ pha dò."
               % (_p1_on * 100, _ty_bo * 100))
    if (_bo_do or _du_hien_dien) and not _p1_main and os.environ.get("CHE_DONG_TUHOC", "1") != "0":
        # Tách 2 lý do: KHÔNG THẤY SUB vs THẤY SUB NHƯNG RẢI NHIỀU CHỖ. Câu cũ chỉ có vế đầu nên khi khách
        # gặp vế sau (video 29/30 khung có sub) thì đọc xong càng khó hiểu — nói ngược với thực tế họ thấy.
        if _du_hien_dien and _p1_on is not None:
            log_fn("⚠️ Sub có mặt ở %.0f%% khung thăm dò nhưng KHÔNG dải nào chiếm đa số (sub đổi vị trí / "
                   "nhiều dòng rời) → chạy pha dò đầy đủ. ĐO THẬT: chặng dò 251s cho video 699s, "
                   "so với 8-10s khi bỏ được pha dò = **CHẬM HƠN ~30×**, không phải 4×." % (_p1_on * 100))
        else:
            log_fn("⚠️ Không xác định được DẢI CHÍNH → chạy pha dò đầy đủ (ĐO THẬT chậm hơn ~30×, không phải 4×). "
                   "Thường do video không có hardsub, hoặc %d khung thăm dò đều rơi vào đoạn không có sub." % n_probe_used)
    if _bo_do and _p1_main and dur > 0:
        # dùng DẢI CHÍNH (1 dải, mode) — KHÔNG dùng y0c/y1c vì đó là HỢP NHẤT mọi dải (đo: 3 dải rời → 24%-100%)
        _sy0 = max(0.0, float(_p1_main[0]) - 0.02); _sy1 = min(1.0, float(_p1_main[1]) + 0.02)
        # NỚI BỀ NGANG: dải lấy từ ~30 khung thăm dò nên rất dễ CHƯA GẶP câu dài nhất ⇒ hụt 2 đầu ⇒ mất chữ.
        # ĐO THẬT (clip3p): câu dài nhất trải x 18.9%-80.8% mà dải Pha 1 chỉ x 26%-74%.
        # Từ khi pha đọc TỰ chạy det, crop rộng hơn chỉ tốn chút tốc độ (det tự khoanh lại đúng chữ), còn
        # crop hẹp thì MẤT KÝ TỰ — nên có sẵn phép nới đối xứng quanh tâm. Chỉnh: CHE_DONG_BO_DO_XPAD.
        # ⚠ ĐÃ THỬ nới 1.35× và BỎ (mặc định về 1.0): ĐO THẬT không bắt thêm được chữ nào mà chỉ tốn thời gian —
        #   clip3p 25.0s→21.1s, cue 87→87 KHỚP 87/87 · test6p 85.7s→69.8s, cue 169→169.
        #   Lý do đoán sai: tôi thấy dải Pha 1 hẹp hơn câu dài nhất nên tưởng hụt, nhưng vòng đọc VỐN đã đệm
        #   ±0.04 bề ngang, và det tự khoanh lại nên crop rộng thêm chỉ làm ảnh to ra vô ích. Trên test6p phép
        #   nới còn đẩy dải thành FULL-WIDTH (x 0-100%).
        try:
            _xp = float(os.environ.get("CHE_DONG_BO_DO_XPAD", "") or 1.0)
        except ValueError:
            _xp = 1.0
        _cx = (float(_p1_main[2]) + float(_p1_main[3])) / 2.0
        _hw = (float(_p1_main[3]) - float(_p1_main[2])) / 2.0 * max(1.0, _xp)
        _sx0 = max(0.0, _cx - _hw); _sx1 = min(1.0, _cx + _hw)
        cap.release()
        log_fn("⚡ Bỏ pha dò thời điểm — pha đọc tự dò trong dải y %.0f%%–%.0f%%, x %.0f%%–%.0f%%."
               % (_sy0 * 100, _sy1 * 100, _sx0 * 100, _sx1 * 100))
        return [(0.0, dur, _sy0, _sy1, _sx0, _sx1)]
    log_fn("🔎 OCR dò-dải: %.0fs video · %.2g fps · ~%d mẫu" % (dur, fps / stride, nfr // stride))

    _hy_do = _HybridDo(eng)                              # khoá-ROI cho vòng dò (xem _HybridDo)

    # ══ GỘP DẢI (14/08/2026) — xếp chồng K dải vào MỘT ảnh, gọi engine 1 LẦN, rồi tách kết quả về từng dải.
    #
    # CƠ CHẾ (đây KHÔNG phải "gộp lô batch tensor" đã bị loại 27/07 — xem bảng đối chiếu ở NGHIEP-VU §7.3):
    #   rapidocr đặt `Det.limit_type='min'` + `limit_side_len=320` (ocr_text.py:445) = "ảnh nào có CẠNH NGẮN
    #   < 320 thì PHÓNG TO cho đủ". Dải sub điển hình cao ~50px ⇒ bị phóng **6,4× MỖI CHIỀU = 41× số điểm
    #   ảnh**, mỗi mẫu một lần. Xếp chồng 10 dải ⇒ ảnh cao ~500px ≥ 320 ⇒ **thôi phóng to**.
    #   ⇒ Cái tiết kiệm được là PHÉP PHÓNG TO THỪA, không phải "song song hoá". Vì thế nó không đụng kết luận
    #   "GPU đã bão hoà, gộp lô chỉ gây tràn" — ở đây OCR chạy CPU và ảnh gộp NHỎ HƠN ảnh cũ.
    # ĐO (40 dải video thật): gộp 10 → **4,16×** · gộp 20 → 4,49× (bão hoà). Phát hiện khớp **34/34 dải**;
    #   4 chỗ chữ lệch thì gộp ĐÚNG HƠN 2, thua 1, hoà 1 (dải 50px quá mỏng làm chữ sát mép bị cắt cụt —
    #   xếp chồng cho detector thêm ngữ cảnh).
    # ⚠ DẢI CÁCH: chèn vài dòng đen giữa 2 dải để det KHÔNG nối chữ của 2 khung liền nhau (cùng câu, cùng y)
    #   thành MỘT hộp vắt ngang — hộp đó sẽ bị gán về 1 dải và dải kia MẤT mẫu ⇒ lệch mốc vào/ra ~1s.
    #   Phép đo 4,16× ở trên làm KHÔNG có dải cách; đặt OCR_GOP_SEP=0 để tái hiện đúng số đó.
    # Tắt hẳn: OCR_GOP_DAI=0 (hoặc =1). Loại trừ với OCR_DO_HYBRID (khoá-ROI cần det từng khung riêng).
    try:
        _gop_k = int(os.environ.get("OCR_GOP_DAI", "") or 10)
    except ValueError:
        _gop_k = 10
    try:
        _gop_sep = max(0, int(os.environ.get("OCR_GOP_SEP", "") or 8))
    except ValueError:
        _gop_sep = 8
    if _hy_do.bat:
        _gop_k = 0          # hybrid khoá-ROI dò ROI theo TỪNG khung ⇒ không gộp được
    # OCR_DEM_320=1 → đệm đen thay vì để rapidocr phóng to (xem `_dem_320`). Mặc định TẮT: đây là công cụ
    # ĐO để tách biến, chưa phải tính năng. Lấy đúng ngưỡng của `Det.limit_side_len` để hai bên không lệch.
    _dem_side = 0
    if os.environ.get("OCR_DEM_320", "0") != "0":
        try:
            _dem_side = int(os.environ.get("OCR_DET_SIDE", "") or 320)
        except ValueError:
            _dem_side = 320
    _buf = []               # [(t, cim)] chờ xếp chồng

    def _goi_eng(im):
        """1 lời gọi engine, nuốt-lỗi-CÓ-ĐẾM y như đường đơn (xem _dem_loi_ocr)."""
        try:
            try:
                _r = eng(im, use_cls=False)
            except TypeError:
                _r = eng(im)
            return _r[0] if isinstance(_r, tuple) else _r
        except Exception as _e:
            _dem_loi_ocr("ocr.loi_goi_pha2", _e)
            return None

    def _xep_chong(lo):
        """[(t,cim)] → [(t, res)] bằng ĐÚNG 1 lời gọi. Toạ độ y trả về đã trừ offset dải ⇒ y HỆT đường đơn."""
        _hd = lo[0][1].shape[0]
        _buoc = _hd + _gop_sep
        if _gop_sep:
            _dem_cach = np.zeros((_gop_sep, lo[0][1].shape[1], lo[0][1].shape[2]), dtype=lo[0][1].dtype)
            _anh = np.vstack([x for _, c in lo for x in (c, _dem_cach)][:-1])
        else:
            _anh = np.vstack([c for _, c in lo])
        _res = _goi_eng(_anh)
        _tach = [[] for _ in lo]
        for item in (_res or []):
            if not item or len(item) < 3:
                continue
            _bx = item[0]
            _j = int((sum(float(p[1]) for p in _bx) / len(_bx)) // _buoc)
            if _j < 0 or _j >= len(lo):
                continue                      # hộp vắt ra ngoài (không nên xảy ra) → bỏ, KHÔNG gán bừa
            _dy = _j * _buoc
            _tach[_j].append(([[float(p[0]), float(p[1]) - _dy] for p in _bx], item[1], item[2]))
        return [(lo[_i][0], _tach[_i]) for _i in range(len(lo))]

    def _thu_mau(t=None, cim=None):
        """Gom mẫu; trả [(t,res)] khi TỚI LƯỢT XẢ (hoặc khi ép xả lúc hết video: gọi không đối số)."""
        if cim is not None:
            if _buf and cim.shape != _buf[0][1].shape:
                _lo, _buf[:] = list(_buf), [(t, cim)]     # đổi kích thước giữa chừng → xả lô cũ trước
                return _xep_chong(_lo) if len(_lo) > 1 else [(_lo[0][0], _goi_eng(_lo[0][1]))]
            _buf.append((t, cim))
            if len(_buf) < _gop_k:
                return []
        if not _buf:
            return []
        _lo, _buf[:] = list(_buf), []
        if len(_lo) == 1:
            return [(_lo[0][0], _goi_eng(_lo[0][1]))]
        return _xep_chong(_lo)

    def _dem_320(im):
        """ĐỆM ĐEN cho đủ cạnh ngắn `OCR_DET_SIDE` thay vì để rapidocr TỰ PHÓNG TO.
        `Det.limit_type='min'` phóng ảnh cạnh-ngắn<320 lên ĐỦ 320 — phóng CẢ HAI chiều (dải 1280×94 →
        4352×320 = 1,39 triệu điểm ảnh). Đệm đen thì cạnh ngắn đạt 320 mà chiều rộng GIỮ NGUYÊN
        (1280×320 = 0,41 triệu) ⇒ ít hơn 3,4× **mà KHÔNG đổi số lời gọi**.
        🔬 PHÉP ĐO PHÂN XỬ (14/08/2026) — ĐÃ CHẠY, KẾT QUẢ: **THỦ PHẠM LÀ SỐ LỜI GỌI, KHÔNG PHẢI DIỆN
        TÍCH.** Gộp dải đổi CÙNG LÚC hai biến (lời gọi ÷10 và diện tích ÷10,7) nên phải tách ra mới biết.
        Đệm chỉ đổi DIỆN TÍCH, giữ nguyên 600 lời gọi. Đo (clip 600s, CPU, chạy MỘT MÌNH, có khởi động):
            600 gọi + phóng to  78,0s  |  600 gọi + ĐỆM  73,8s  (chỉ **5%**)
             60 gọi (gộp 10)    32,2s                            (**2,4×**)
             60 gọi + đệm       37,2s  ← đệm còn LÀM TỆ ĐI khi đã hết phóng to
        ⇒ Luật gốc `ocr-phi-co-dinh-moi-loi-goi-khong-phai-dien-tich` ĐÚNG. Bỏ phóng to gần như vô ích
        nếu không giảm được SỐ lời gọi. **GIỮ hàm này chỉ để chặn người sau thử lại ý tưởng "đệm cho khỏi
        phóng to" — đã đo, chỉ 5%.** Muốn nhanh ở pha nào thì phải GIẢM SỐ LỜI GỌI ở pha đó."""
        _c = im.shape[0]
        if _c >= _dem_side or _dem_side <= 0:
            return im
        _pad = np.zeros((_dem_side - _c, im.shape[1], im.shape[2]), dtype=im.dtype)
        return np.vstack([im, _pad])

    def _goi_don(cim):
        """Đường ĐƠN (không gộp): giữ NGUYÊN chuỗi try/except cũ, kể cả nhánh _HybridDo."""
        if _dem_side > 0:
            cim = _dem_320(cim)
        try:
            return _hy_do(cim)       # KHOÁ-ROI: det thật vài mẫu đầu rồi rec-only (xem _HybridDo)
        except TypeError:
            try:
                _r = eng(cim)
                return _r[0] if isinstance(_r, tuple) else _r
            except Exception as _e2:
                _dem_loi_ocr("ocr.loi_goi_pha2", _e2)
        except Exception as _e3:
            # 🔴 MỞ NUỐT LỖI (11/08/2026) — xem chú thích ở Pha 1. GIỮ NGUYÊN trả None.
            _dem_loi_ocr("ocr.loi_goi_pha2", _e3)
        return None

    def _xu_ly(t, res):
        """Lọc box của MỘT mẫu → nạp vào `mau`. Tách khỏi vòng lặp (14/08) để đường GỘP và đường ĐƠN dùng
        CHUNG đúng một bản logic — sửa một chỗ, hai đường cùng đổi. Nội dung giữ nguyên như trước khi tách."""
        # 🐛 THÊM LOGIC CHE SONG NGỮ (user: "video có 2 phụ đề Trung+Anh thì che cả 2"): dòng Anh
        # (Latin thuần, 0 Hán) KHÔNG qua _dem_han → bị bỏ → khách thấy tiếng Anh LỘ. Fix: giữ box
        # Latin CHỈ KHI nó KỀ 1 box Hán đã xác nhận CÙNG FRAME (mỏ neo — |Δy tâm| ≤ ngưỡng dòng +
        # x chồng ≥30%) → đó là dòng-Anh-của-sub-song-ngữ, không phải Latin lung tung (áo/biển).
        # Latin đơn lẻ KHÔNG neo → vẫn bỏ (an toàn, tránh false-positive).
        # 🔴 MẶC ĐỊNH NAY LÀ TẮT ("0") — xem khối lý do đầy đủ ở Pha 1 (`_songngu_p1`, ~:305).
        # PHẢI khớp default với Pha 1 và với `ocr_text` + khoá cache `e_songngu` (§55.1: default
        # trong khoá cache phải TRÙNG default ở chỗ đọc thật, kẻo đổi mặc định mà cache cũ vẫn HIT).
        _han_boxes = []      # (yc, y0f, y1f, x0f, x1f, txt) — box Hán đã qua filter
        _latin_cand = []     # (yc, y0f, y1f, x0f, x1f) — box Latin ứng viên (chờ neo Hán)
        _songngu = os.environ.get("CHE_SONGNGU", "0") != "0"
        for item in res:
            if not item or len(item) < 3:
                continue
            box, txt, score = item[0], item[1], item[2]
            try:
                score = float(score)
            except Exception:
                score = 0.0
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            x0f = min(xs) / sc / W
            x1f = max(xs) / sc / W
            y0f = (min(ys) / sc + y0c) / H
            y1f = (max(ys) / sc + y0c) / H
            _yc = (y0f + y1f) / 2.0
            # LỌC BOX NGOÀI DẢI GIỮ (fix che-nhầm-giữa-2-dải): box Hán có tâm-y NGOÀI mọi dải Pha 1 học
            # (= vùng giữa 2 dải xa, nơi chữ CẢNH lọt vào do crop trùm) → BỎ. Đệm 3% mỗi dải cho an toàn.
            if _dai_giu is not None:
                _trong = any(_d0 - 0.03 <= _yc <= _d1 + 0.03 for _d0, _d1 in _dai_giu)
                if not _trong:
                    continue
            # NGƯỠNG SỐ KÝ TỰ: mặc định han_min=2 để chặn nhiễu. Nhưng câu sub NGẮN/đang hiện dở
            # chỉ đọc ra 1 chữ tại đúng khoảnh khắc lấy mẫu → bị vứt → MẤT NGUYÊN CÂU. Đo thật
            # (video 45s): câu '你什么你' hiện 10.6-11.6s, mẫu 1 fps rơi vào t=11.0 lúc mới hiện
            # '你' (1 chữ, score 1.00) → loại → khe 10.27-12.27s TRỐNG, phải nhờ Whisper bù.
            # Nới xuống 1 chữ NHƯNG CHỈ BÊN TRONG dải sub ĐÃ XÁC NHẬN (_dai_xn — xem chỗ đặt biến):
            # chữ 1 ký tự nằm đúng dải mà Pha 1 đã chứng minh là hardsub thì gần như chắc là sub
            # thật; ngoài dải vẫn đòi đủ han_min như cũ nên không mở cửa cho nhiễu/watermark/chữ
            # cảnh. Tắt: CHE_DONG_HAN1_DAI=0. Đo: bắt thêm đúng câu sót, chi phí +6% thời gian.
            _han_can = han_min
            if _dai_xn is not None and _dai_xn[0] <= _yc <= _dai_xn[1] and _han1_dai:
                _han_can = 1
            if _dem_chinh(txt) >= _han_can and score >= conf_min:
                _han_boxes.append((_yc, y0f, y1f, x0f, x1f, txt))
                mau.append((t, _yc, y0f, y1f, x0f, x1f, _norm_txt(txt, _dem_chinh)))
            elif _la_han_src and _songngu and _dem_latin(txt) >= 4 and score >= conf_min:
                _latin_cand.append((_yc, y0f, y1f, x0f, x1f))   # chờ neo Hán (dưới) — chỉ khi src=zh
        # SONG NGỮ (chỉ src=zh): giữ box Latin KỀ 1 box Hán (cùng frame) → che cả dòng Anh
        if _la_han_src and _songngu and _han_boxes and _latin_cand:
            for _lyc, _ly0, _ly1, _lx0, _lx1 in _latin_cand:
                _lh = _ly1 - _ly0                                   # cao dòng Latin
                for _hyc, _hy0, _hy1, _hx0, _hx1, _ in _han_boxes:
                    _dy = abs(_lyc - _hyc)
                    _ox = min(_lx1, _hx1) - max(_lx0, _hx0)        # chồng ngang
                    _wmin = min(_lx1 - _lx0, _hx1 - _hx0)
                    # kề = |Δtâm-y| ≤ 1.6× cao-dòng (dòng liền kề) + chồng ngang ≥30% (cùng cột sub)
                    if _dy <= max(_lh, _hy1 - _hy0) * 2.2 and _wmin > 0 and _ox / _wmin >= 0.30:
                        mau.append((t, _lyc, _ly0, _ly1, _lx0, _lx1, ""))   # dòng Anh song ngữ → che
                        break
    # ĐỌC TUẦN TỰ grab/read (KHÔNG cap.set per-mốc → tránh giải-mã-lại GOP nhiều lần treo video dài)
    mau = []                                             # (t, yc, y0f, y1f, x0f, x1f)
    fidx = 0
    _lp = _t2.perf_counter()
    _run0 = _lp
    log_fn("🔎 Đang dò dải phụ đề (OCR)…")
    try:
        while fidx < nfr:
            if fidx % stride == 0:
                ok, fr = cap.read()
                if not ok or fr is None:
                    break
                t = fidx / fps
                crop = fr[y0c:y1c, :]
                if sc != 1.0:
                    cim = cv2.resize(crop, (max(1, int(crop.shape[1] * sc)), max(1, int(crop.shape[0] * sc))),
                                     interpolation=cv2.INTER_AREA)
                else:
                    cim = crop
                # ĐÃ ĐO, ĐỪNG thêm "cổng mặt-nạ rẻ" để bỏ bớt lời gọi det ở đây. Ý tưởng: dùng đúng mặt-nạ
                # chữ-trắng-viền-đen của pha đọc để đoán dải TRỐNG rồi khỏi gọi engine. Đo thật 3 video
                # (đếm trên CHÍNH ảnh engine nhận):
                #     t.mp4  57 lời gọi, 0 phí (0%)  — cổng chỉ gây BỎ SÓT 3-9 câu, không tiết kiệm gì
                #     rv1    73 lời gọi, 24 phí (33%) — ngưỡng thấp nhất vẫn BỎ SÓT 1 câu thật
                #     rv3    72 lời gọi, 5 phí (7%)   — bỏ sót 0
                # Quy ra thời gian chỉ ~0.6s trên video lợi nhất (det ~30ms/lời gọi sau khi đã hạ
                # OCR_DET_SIDE), tức 0-4% tổng — KHÔNG đáng đánh đổi với việc mất câu phụ đề thật.
                # GỘP DẢI bật ⇒ gom mẫu, tới lô mới gọi engine 1 lần rồi xả ra nhiều (t,res) cùng lúc.
                # Tắt ⇒ `_goi_don` giữ NGUYÊN hành vi cũ (kể cả nhánh _HybridDo). Cả hai đường đi CHUNG
                # `_xu_ly` nên logic lọc box chỉ có MỘT bản.
                for _t_m, _res_m in (_thu_mau(t, cim) if _gop_k >= 2 else [(t, _goi_don(cim))]):
                    _dem_loi_ocr("ocr.goi_pha2")   # lượt MẪU — xem lý do ở docstring _dem_loi_ocr
                    if _res_m:
                        _xu_ly(_t_m, _res_m)
                if fidx % 512 == 0 and (_t2.perf_counter() - _lp) > 15.0:
                    _lp = _t2.perf_counter()
                    log_fn("🔎 Dò OCR %d/%d khung…" % (fidx, nfr))
            else:
                if not cap.grab():
                    break
            fidx += 1
    finally:
        # XẢ NỐT lô dở — video hiếm khi chia hết cho K, và mọi `break` ở trên (hết khung/đọc lỗi) đều
        # nhảy thẳng vào đây. Quên bước này = mất tới K-1 mẫu CUỐI video, đúng lớp lỗi
        # `ocr-mat-cau-cuoi-video-thieu-buoc-xa` đã ghi trong memory.
        try:
            for _t_m, _res_m in _thu_mau():
                _dem_loi_ocr("ocr.goi_pha2")
                if _res_m:
                    _xu_ly(_t_m, _res_m)
        except Exception as _e_xa:
            _dem_loi_ocr("ocr.loi_goi_pha2", _e_xa)
        cap.release()

    if not mau:
        return None

    # (1) GỘP box CÙNG mẫu có Y CHỒNG nhau → 1 box (1 dòng sub bị det tách 2 đoạn không thành 2 track sai)
    by_t = defaultdict(list)
    for m in mau:
        by_t[m[0]].append(m)
    merged = []                                          # (t, yc, y0, y1, x0, x1, txt)
    for t, items in by_t.items():
        items.sort(key=lambda m: m[2])                   # theo y0
        used = [False] * len(items)
        for i in range(len(items)):
            if used[i]:
                continue
            y0, y1, x0, x1 = items[i][2], items[i][3], items[i][4], items[i][5]
            _txt = items[i][6] if len(items[i]) > 6 else ""
            for j in range(i + 1, len(items)):
                if used[j]:
                    continue
                if min(y1, items[j][3]) - max(y0, items[j][2]) > 0:   # 2 box CHỒNG Y → cùng dòng, union
                    y0 = min(y0, items[j][2]); y1 = max(y1, items[j][3])
                    x0 = min(x0, items[j][4]); x1 = max(x1, items[j][5])
                    _txt = _txt + (items[j][6] if len(items[j]) > 6 else "")   # nối text (cùng dòng bị det tách)
                    used[j] = True
            used[i] = True
            merged.append((t, (y0 + y1) / 2.0, y0, y1, x0, x1, _txt))
    merged.sort(key=lambda m: (m[0], m[1]))

    # (2) GOM theo Y-center thành track (subtitle 1 vị-trí = 1 track ổn định; title-card đỉnh = track khác)
    TRACK_Y_TOL = 0.05
    # 🐛 FIX (user test video nhiều chữ: title + danh sách 4 dòng + sub đáy = 6 vị-trí Y, MAX_TRACK=3 → sub đáy
    # BỊ BỎ). Nâng 3→6 (đủ cho video công thức/danh sách nhiều dòng ở nhiều vị-trí). Lớp lọc sau (_loc_track_phu +
    # min_frame + gate LIST) vẫn chặn nhiễu. Chỉnh: CHE_DONG_MAX_TRACK.
    try:
        MAX_TRACK = int(os.environ.get("CHE_DONG_MAX_TRACK", "6") or 6)
    except ValueError:
        MAX_TRACK = 6
    tracks = []                                          # mỗi track = {"yc": mean, "n": int, "ms": [samples]}
    for m in merged:
        yc = m[1]
        best = None; bd = 1e9
        for tr in tracks:
            d = abs(tr["yc"] - yc)
            if d < bd:
                bd = d; best = tr
        if best is not None and bd <= TRACK_Y_TOL:
            best["ms"].append(m)
            best["yc"] = (best["yc"] * best["n"] + yc) / (best["n"] + 1)
            best["n"] += 1
        elif len(tracks) < MAX_TRACK:
            tracks.append({"yc": yc, "n": 1, "ms": [m]})
        elif best is not None and bd <= TRACK_Y_TOL * 2.2:   # đầy track → gán vào gần nhất nếu còn tạm gần
            best["ms"].append(m)
            best["yc"] = (best["yc"] * best["n"] + yc) / (best["n"] + 1)
            best["n"] += 1

    # (3) TÁCH segment + ỔN ĐỊNH band: trong 1 track, nối mẫu thành segment khi (gap ≤ HOLD) VÀ (Y lệch nhỏ);
    #     ngược lại chốt segment cũ + mở mới. Band = union box trong segment (fixed band, không nháy theo frame).
    # 🐛 FIX (user báo che HỤT 2 MÉP câu dài, vd '以后请假不用去办公室了'): OCR dò BỀ RỘNG X cùng 1 câu DAO ĐỘNG
    # mạnh qua frame (motion/mờ: x-range 0.83 → 0.44). MOVE_X cũ 0.06 (6%) QUÁ NHẠY → cùng câu bị TÁCH thành nhiều
    # segment, đoạn HẸP che hụt mép. NHƯNG bỏ hẳn tách-x lại GỘP quá nhiều câu khác nhau (cùng Y đáy) → che thừa
    # 90% video. CÂN BẰNG: nâng MOVE_X lên 0.35 — cùng câu (x dao động <35% do motion) → GỘP + union bề rộng MAX
    # (hết hụt mép); câu MỚI (x khác HẲN >35% hoặc có gap/Y lệch) → tách (không che thừa). Chỉnh: CHE_DONG_MOVE_X.
    try:
        MOVE_X = float(os.environ.get("CHE_DONG_MOVE_X", "0.35") or 0.35)
    except ValueError:
        MOVE_X = 0.35
    _tach_x = True                                       # vẫn tách theo x nhưng ngưỡng RỘNG (0.35) — chỉ tách câu MỚI thật
    MOVE_Y = 0.05
    HOLD = samp_dt * 2.4                                 # BẮC CẦU qua 1 mẫu OCR-miss (chữ vẫn hiện nhưng mẫu đó
                                                          # đọc rỗng do motion/frame-chuyển): 2 mẫu lành cách 2×dt
                                                          # → HOLD>2×dt mới gộp, không tạo lỗ hổng không-che
    _M = samp_dt                                         # biên đối xứng = 1 khoảng-mẫu MỖI đầu → ĐẢM BẢO 0-lộ (chữ
                                                          # hiện sớm tối đa 1 khoảng-mẫu giữa 2 mẫu). Đè (dải phình ở
                                                          # chuyển câu) = 2M - khoảng-mẫu = 1/fps (2fps→~0.5s). KHÔNG
                                                          # clamp điểm-giữa (ranh giới thật ≠ điểm-giữa → clamp gây lộ).
                                                          # Đè↔tốc-độ: fps cao hơn = đè nhỏ hơn (env CHE_DONG_FPS).
    _p = 0.004                                           # pad box cực nhỏ tránh hở 1-2px mép (GIỮ FIT khít)
    blur_segs = []
    for tr in tracks:
        ms = sorted(tr["ms"], key=lambda m: m[0])
        # (3a) gom mẫu → segment THÔ [t_first, t_last, y0,y1,x0,x1, txt] (chưa nới biên)
        raw = []
        seg = None
        for m in ms:
            t, _yc, y0, y1, x0, x1 = m[0], m[1], m[2], m[3], m[4], m[5]
            txt = m[6] if len(m) > 6 else ""
            if seg is None:
                seg = [t, t, y0, y1, x0, x1, txt]
                continue
            gap = t - seg[1]
            dy = max(abs(y0 - seg[2]), abs(y1 - seg[3]))
            # 🐛 TÁCH THEO TEXT-ĐỔI (fix user báo blur DÀI 13.5s = 6 câu khác nhau bị gộp 1 box do x đều căn giữa
            # không phân biệt được câu): OCR pha 2 ĐÃ ĐỌC text mỗi câu → text ĐỔI HẲN (không _txt_giong) = CÂU MỚI
            # → tách segment (mỗi câu 1 box fit riêng). Cùng câu (text giống, OCR đọc dần/lệch nhẹ) → GỘP + union
            # bề rộng (hết hụt mép). Bỏ tách-theo-x (x không đáng tin — câu căn giữa x tương tự). Tắt: CHE_DONG_TACH_TXT=0.
            _txt_doi = (os.environ.get("CHE_DONG_TACH_TXT", "1") != "0") and txt and seg[6] and not _txt_giong(txt, seg[6])
            if gap > HOLD or dy > MOVE_Y or _txt_doi:
                raw.append(seg)
                seg = [t, t, y0, y1, x0, x1, txt]
            else:
                seg[1] = t
                seg[2] = min(seg[2], y0); seg[3] = max(seg[3], y1)
                seg[4] = min(seg[4], x0); seg[5] = max(seg[5], x1)   # union bề rộng MAX (đoạn hẹp phủ như rộng nhất)
                if txt and len(txt) > len(seg[6]):                  # giữ text ĐẦY ĐỦ nhất của câu (OCR đọc dần)
                    seg[6] = txt
        if seg is not None:
            raw.append(seg)
        # (3b) NỚI BIÊN + CLAMP ĐIỂM-GIỮA 2 câu kề (cùng-track): 2 câu GẶP NHAU đúng điểm-giữa → KHÔNG chồng
        #      thời gian = 0 ĐÈ (dải không phình ở chuyển câu — quan trọng khi burn phụ đề Việt lên). Ở 2fps sai
        #      lệch ranh giới ≤0.25s. Env CHE_DONG_CLAMP=0 → nới đối xứng (0-lộ tuyệt đối, chấp nhận đè).
        _clamp = os.environ.get("CHE_DONG_CLAMP", "1") == "1"
        for k, s in enumerate(raw):
            t_first, t_last, y0, y1, x0, x1 = s[0], s[1], s[2], s[3], s[4], s[5]   # s[6]=txt (không dùng ở nới biên)
            t_on = max(0.0, t_first - _M)
            t_off = t_last + _M
            if _clamp and k > 0:                              # gặp câu TRƯỚC ở điểm-giữa (không lùi quá → hết đè)
                t_on = max(t_on, (raw[k - 1][1] + t_first) / 2.0)
            if _clamp and k < len(raw) - 1:                   # gặp câu SAU ở điểm-giữa (không tràn quá → hết đè)
                t_off = min(t_off, (t_last + raw[k + 1][0]) / 2.0)
            elif dur > 0.0 and t_last >= dur - samp_dt * 1.5:  # câu cuối sát cuối video → phủ tới hết (không lộ đuôi)
                t_off = dur
            blur_segs.append((t_on, t_off,
                              max(0.0, y0 - _p), min(1.0, y1 + _p),
                              max(0.0, x0 - _p), min(1.0, x1 + _p)))

    # LỌC TITLE-CARD/BIỂN vùng TRÊN (yc < CHE_DONG_YMIN): title-card/biển KHÔNG phải thoại → nếu đọc vào sẽ bị
    # LỒNG TIẾNG thành lời-thoại-giả (giọng "ma") + rối ngữ-cảnh dịch.
    # 🐛 FIX (user: "che chữ cao NẾU phụ đề gốc ở trên" — bug video công thức đậu xanh: danh sách nguyên liệu
    # 绿豆30g/黄豆20g... ở y0.19-0.35 bị lọc oan như title-card → không che → chữ Trung LỘ). TÁCH 2 đường:
    #   • loc_title=False (gọi cho CHE-blur): GIỮ HẾT, che cả chữ cao (sub công thức/danh sách đặt cao vẫn che).
    #   • loc_title=True (mặc định, gọi cho DUB/SRT qua ocr_dong): lọc title khỏi LỜI THOẠI (tránh thoại giả).
    # → CHE sạch mọi chữ Hán + DUB không bị title-card đọc thành thoại. Đặt CHE_DONG_YMIN=0 tắt lọc hẳn.
    try:
        _ymin = float(os.environ.get("CHE_DONG_YMIN", "0.18") or 0.18)   # 0.30→0.18: title đỉnh lọc, sub giữa-trên giữ
    except ValueError:
        _ymin = 0.18
    if loc_title and _ymin > 0:
        _n0 = len(blur_segs)
        blur_segs = [s for s in blur_segs if (s[2] + s[3]) / 2.0 >= _ymin]
        if len(blur_segs) < _n0:
            log_fn("ℹ Bỏ %d dải title-card/biển vùng trên (yc<%.2f) khỏi LỜI THOẠI (vẫn che nếu là blur)." % (_n0 - len(blur_segs), _ymin))
    blur_segs.sort(key=lambda s: s[0])
    _el_all = _t2.perf_counter() - _run0
    log_fn("✅ Dò OCR xong: %d segment / %d mẫu-chữ (%.0fs)" % (len(blur_segs), len(mau), _el_all))
    return blur_segs or None


def phat_hien_hop_dong(video, log_fn=print, fps_sample=4.0, n_max=4000, y_gate=None, loc_title=True, src_lang=None):
    """Dò HỘP sub ĐỘNG theo thời gian (sub DI CHUYỂN trong clip) → list (t_on, t_off, y0, y1, x0, x1) mỗi
    ĐOẠN vị-trí. Sample ~fps_sample fps (đọc tuần tự grab/read), dò box RẺ mỗi mẫu, GOM mẫu liên tiếp cùng
    vị-trí (tâm y gần ≤0.045, gap ≤0.8s) thành đoạn → blur/phụ đề bám theo. None nếu < 1 đoạn tin cậy.
    Tốc độ: fps_sample chỉnh qua env CHE_DONG_FPS (giãn THƯA = nhanh, hợp video hardsub ổn định); video DÀI
    tự GIÃN stride để ≤ n_max mẫu phủ HẾT (không kẹt/sót đuôi video dài).
    HƯỚNG B (mặc định): DISPATCH sang phat_hien_sub_ocr (OCR thưa + ổn định — chỉ che nơi CÓ chữ Hán).
    y_gate=(y0f,y1f): giới hạn OCR vào dải-Y blur tĩnh khoanh (truyền thẳng xuống phat_hien_sub_ocr — xem đó).
    loc_title=True (mặc định): LỌC dải vùng trên (yc<CHE_DONG_YMIN) như title-card. False (dùng cho CHE-blur):
    GIỮ HẾT kể cả chữ cao (user: "che chữ cao nếu phụ đề gốc ở trên") — video công thức/danh sách sub đặt cao.
    Lùi 'ảnh-rẻ' cũ: env CHE_DONG_OCR=0 (hoặc khi OCR ném lỗi → fallback tự động, không mất tính năng che)."""
    if os.environ.get("CHE_DONG_OCR", "1") == "1":
        try:
            return phat_hien_sub_ocr(video, log_fn=log_fn, fps_sample=None, y_gate=y_gate, loc_title=loc_title, src_lang=src_lang)
        except Exception as _e_ocr:
            if os.environ.get("VC_DEBUG_TRACE") == "1":
                import traceback
                traceback.print_exc()
            # PHẢI nói RÕ lỗi gì: đây là đường lùi NẶNG NHẤT (bỏ toàn bộ dò-dải OCR, quay về ảnh-rẻ ra
            # nhiều dải nhiễu hơn ~8×). Trước chỉ ghi "có lỗi" nên không ai biết vá gốc ở đâu.
            log_fn("⚠️ OCR dò-dải lỗi (%s: %s) → lùi ảnh-rẻ (dò kém chắc hơn). BÁO LỖI NÀY ĐỂ VÁ GỐC."
                   % (type(_e_ocr).__name__, str(_e_ocr)[:150]))   # an toàn: vẫn che được (dù có thể kém chính xác hơn)
    try:
        import cv2
        import numpy as np
        try:
            fps_sample = float(os.environ.get("CHE_DONG_FPS", "") or fps_sample)
        except ValueError:
            pass
        cap = cv2.VideoCapture(os.path.abspath(video))
        if not cap.isOpened():
            return None
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        nfr = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if nfr <= 0:
            cap.release()
            return None
        # GIÃN sampling: stride đủ thưa để TỔNG mẫu ≤ n_max phủ HẾT video dài (tăng tốc, không kẹt), nhưng
        # không dày hơn fps_sample yêu cầu. ceil(nfr/n_max) = số frame/mẫu tối thiểu để ≤ n_max mẫu.
        stride = max(1, int(round(fps / fps_sample)), -(-nfr // n_max))
        # Khe GỘP đoạn phải theo MẬT-ĐỘ-mẫu thực: video DÀI → stride lớn → mẫu cách nhau stride/fps giây.
        # Cố định 0.8s mà mẫu cách >0.8s (video >~8' do cap n_max) → KHÔNG mẫu nào gộp → mọi đoạn n=1 → BỎ
        # HẾT → 0 đoạn → lùi ASR oan (đã đo: video 72' mẫu cách 7.2s). Nới khe = max(0.8, mẫu×2.2).
        gap = max(0.8, stride / fps * 2.2)
        samples = []                                # (t, box|None)
        sample_strides = []                         # stride THỰC dùng cho mẫu[i] cùng — cần để tính half ĐÚNG
                                                      # riêng từng mẫu (đầu video dùng head_stride dày hơn stride
                                                      # thường → half SAI nếu dùng 1 giá trị chung, xem dòng dưới)
        # rowcovs LƯU SONG SONG samples (nhẹ, ~10KB/mẫu — KHÔNG lưu mask 2D vì nặng, xem _tinh_rowcov) —
        # dùng ở PHA 2 dưới đây để "cứu" mẫu yếu TẠI ĐÚNG vị-trí track đã XÁC NHẬN qua ngưỡng gốc, không
        # cần đọc lại video. rowcov_meta lưu (y_lo, H, W) — CỐ ĐỊNH cho cả video (cùng kích thước khung).
        rowcovs = []
        rowcov_meta = None
        # GRAB tuần tự (KHÔNG seek per-frame: với sampling dày stride<GOP, cap.set phải giải-mã-lại GOP
        # nhiều lần → CHẬM hơn). Grab tuần tự là tối ưu cho giải mã; chỉ read frame được lấy mẫu.
        fidx = 0
        import time as _t2
        _lp = _t2.perf_counter()
        log_fn("🔎 Đang dò dải phụ đề…")   # video dài: báo tiến độ để thanh % không "đứng 1%"
        # DÒ DÀY ĐẦU VIDEO (user: "dò sub động lâu hơn ~10-15s đầu cho chắc"): sub gần như LUÔN xuất hiện sớm +
        # vị-trí đầu quyết định dải cho cả clip → quét DÀY (stride nhỏ) trong CHE_DONG_HEAD_S giây đầu để KHÔNG
        # sót câu ngắn đầu + xác định vị-trí chắc. Sau mốc đó về stride thường (nhanh). head_stride ~½ stride
        # thường (dày gấp đôi), tối thiểu 1. Tắt: CHE_DONG_HEAD_S=0.
        try:
            _head_s = float(os.environ.get("CHE_DONG_HEAD_S", "12") or 12)
        except ValueError:
            _head_s = 12.0
        _head_fr = int(_head_s * fps)
        _head_stride = max(1, stride // 2)
        while fidx < nfr and len(samples) < n_max:
            if fidx % 512 == 0 and (_t2.perf_counter() - _lp) > 15.0:
                _lp = _t2.perf_counter()
                log_fn("🔎 Dò dải %d/%d khung…" % (fidx, nfr))
            _st = _head_stride if (fidx < _head_fr) else stride   # ĐẦU video dò dày → chắc vị-trí + đủ câu sớm
            if fidx % _st == 0:
                ok, fr = cap.read()
                if not ok or fr is None:
                    break
                rowcov, mask, y_lo, H, W = _tinh_rowcov(fr, cv2, np)
                boxes_1f = _tim_dinh(rowcov, mask, y_lo, H, W, np, cv2) or None
                samples.append((fidx / fps, boxes_1f))
                sample_strides.append(_st)   # stride THỰC DÙNG cho mẫu này (head_stride hay stride thường)
                rowcovs.append(rowcov)
                if rowcov_meta is None:
                    rowcov_meta = (y_lo, H, W)
            else:
                if not cap.grab():
                    break
            fidx += 1
        cap.release()
        if not samples:
            return None
        # GOM mẫu thành N TRACK song song (user: "che-động siêu fit" — video có ≥2 dải chữ ĐỒNG THỜI khác
        # vị-trí, vd tiêu đề giữa màn + phụ đề đáy cùng lúc). Mỗi mẫu (nay có thể NHIỀU box/frame) khớp với
        # track "sống" gần nhất theo tâm Y (≤0.045); track vượt khe gap so mẫu hiện tại bị ĐÓNG (chuyển sang
        # segs) trước khi matching mẫu đó. Giới hạn track sống tối đa (MAX_TRACK) tránh phình chi phí nếu
        # ảnh nhiễu ra nhiều đỉnh giả.
        MAX_TRACK = 3
        tracks, segs = [], []                       # track: [t_on, t_last, [boxes], n, yc]
        for t, boxes in samples:
            # đóng (chuyển sang segs) MỌI track đã vượt khe gap tính TỚI mẫu này — kể cả khi mẫu này
            # không có box nào (khe trống dài giữa 2 lần thấy chữ = hết đoạn, giống hành vi gốc 1-track).
            _pool, _dead = [], []
            for tr in tracks:
                (_dead if (t - tr[1]) > gap else _pool).append(tr)
            segs.extend(_dead)
            tracks = _pool
            if not boxes:
                continue
            _updated = []                            # track đã nhận box TRONG mẫu này (rút khỏi _pool)
            for box in boxes:
                yc = (box[0] + box[1]) / 2.0
                # track sống (chưa dùng trong mẫu này) gần Y nhất trong ngưỡng — mỗi track chỉ nhận TỐI ĐA
                # 1 box/mẫu (tránh 1 track nuốt 2 box cùng frame nếu ngưỡng Y trùng nhau hiếm gặp)
                _cands = [tr for tr in _pool if abs(yc - tr[4]) <= 0.045]
                if _cands:
                    tr = min(_cands, key=lambda x: abs(yc - x[4]))
                    tr[1] = t; tr[2].append((t, box))   # LƯU KÈM timestamp — cần để trả về box RIÊNG (fit ngang)
                    tr[3] += 1; tr[4] += (yc - tr[4]) / tr[3]    # yc trung bình động (đỡ trôi)
                    _pool.remove(tr)
                    _updated.append(tr)
                elif len(_pool) + len(_updated) < MAX_TRACK:
                    _updated.append([t, t, [(t, box)], 1, yc])
                # đủ MAX_TRACK track sống mà box không khớp track nào → bỏ box (nhiễu/track dư yếu nhất)
            tracks = _pool + _updated                 # track không dùng trong mẫu này + track vừa cập nhật/mới
        # 🐛 FIX (verify ảnh thật: chữ ở ĐUÔI VIDEO hoàn toàn không được che dù _tim_dinh dò đúng): vòng lặp
        # trên chỉ đóng track (chuyển sang segs) khi GẶP mẫu SAU vượt khe gap — track vẫn "sống" tại mẫu CUỐI
        # CÙNG của video không bao giờ gặp mẫu sau để kích hoạt điều kiện đó, nên KHÔNG BAO GIỜ vào segs, mất
        # trắng dù có đủ dữ liệu (đo thật: video mẫu 52.9s, đoạn t=50.0-52.75s biến mất hoàn toàn khỏi output
        # dù sampling độc lập xác nhận có box đúng suốt đoạn này). Đóng NỐT mọi track còn sống sau khi hết mẫu.
        segs.extend(tracks)
        # PHA 2 — "CỨU" mẫu YẾU + NỐI track liền kề CÙNG vị-trí (user: "tăng tín hiệu để không OCR nhầm,
        # ưu tiên phần dải chữ trước đang ở vì sub thường đứng"). Track đã có n>=2 mẫu THẬT qua NGƯỠNG GỐC
        # nghiêm ngặt (0.035, không CC-check — xem _tim_dinh) tại NHIỀU thời điểm khác nhau = bằng chứng
        # CHẮC CHẮN đây là sub thật (đứng yên xuyên suốt).
        # 🐛 FIX (verify thật video mẫu): lấp khe-hở BÊN TRONG 1 track KHÔNG ĐỦ — câu ngắn "扣5分" (t≈26s)
        # nằm giữa 2 track ĐÃ TÁCH RỜI (track 1 đóng tại 25.9s vì khe hở 3.7s > gap 0.8s gốc, TRƯỚC khi tới
        # track 2 mở lại tại 29.6s) — khe hở chính là NGUYÊN NHÂN track bị tách, nên nó luôn nằm NGOÀI phạm
        # vi [t_on,t_last] của cả 2 track, "lấp bên trong" không bao giờ với tới. Fix: trước khi lấp khe hở,
        # NỐI các track ĐÃ XÁC NHẬN (n>=2) LIỀN KỀ NHAU theo thời gian nếu CÙNG vị-trí Y (|Δyc|≤0.05) và
        # cách nhau không quá xa (≤NOI_MAXGAP giây — rộng hơn gap gốc 0.8s nhưng vẫn có trần, tránh nối
        # xuyên suốt cả video 2 track ngẫu nhiên trùng Y ở 2 thời điểm cách xa vô lý).
        NOI_MAXGAP = 15.0
        # 🐛 FIX (verify ảnh thật user gửi: khung che PHÍA TRÊN xuất hiện ở khoảng KHÔNG có chữ, t≈5.7-13s):
        # NOI_MAXGAP=15s (đủ rộng để nối câu ngắn "扣5分" cách 3.7s) VÔ TÌNH cũng nối được banner tiêu đề
        # THẬT (t=[0,5.72], 50 mẫu) với biển số phòng "613" TĨNH (vật thể khác hẳn, t=[13.25,15.00]) chỉ vì
        # 2 vật tình cờ gần Y (|Δyc|≤0.05) — thời gian đơn thuần không đủ để phân biệt "câu bị ngắt quãng"
        # (nên nối) với "2 nội dung khác nhau tình cờ gần Y" (không nên nối) — ĐÚNG bài học đã research cho
        # bug "cứu mẫu yếu": cần thêm GATING HÌNH HỌC (chênh lệch x0/x1 giữa 2 track) bên cạnh khoảng cách
        # thời gian. Track CÙNG câu/nội dung giữ bề rộng tương đối ổn định qua thời gian; 2 track KHÁC nội
        # dung (banner dài "当辅导员来你寝借宿" span~0.6 vs biển "613" span hẹp hơn nhiều) chênh lệch rõ.
        _NOI_GATING_MAXDIFF = 0.15
        def _lech_hinh_hoc(tr_a, tr_b):
            _bx_a = tr_a[2][-1][1]   # box CUỐI của track a (gần thời điểm nối nhất)
            _bx_b = tr_b[2][0][1]    # box ĐẦU của track b
            return max(abs(_bx_a[2] - _bx_b[2]), abs(_bx_a[3] - _bx_b[3]))
        _tr_xacnhan = sorted((tr for tr in segs if tr[3] >= 2), key=lambda tr: tr[0])
        _da_noi = set()
        segs_moi = []
        for tr in segs:
            if id(tr) in _da_noi:
                continue
            if tr[3] < 2:
                segs_moi.append(tr)
                continue
            _cur = tr
            while True:
                _ung_vien = [o for o in _tr_xacnhan
                             if id(o) not in _da_noi and o is not _cur
                             and o[0] > _cur[1] and (o[0] - _cur[1]) <= NOI_MAXGAP
                             and abs(o[4] - _cur[4]) <= 0.05
                             and _lech_hinh_hoc(_cur, o) <= _NOI_GATING_MAXDIFF]
                if not _ung_vien:
                    break
                _ke = min(_ung_vien, key=lambda o: o[0])
                _cur[1] = _ke[1]; _cur[2].extend(_ke[2])
                _cur[3] += _ke[3]; _cur[4] = (_cur[4] + _ke[4]) / 2.0
                _da_noi.add(id(_ke))
            segs_moi.append(_cur)
        segs = segs_moi
        half = stride / fps / 2.0
        # Với bằng chứng track đã XÁC NHẬN (+ NỐI liền kề ở trên), quét lại rowcovs ĐÃ LƯU (không đọc lại
        # video) tại các mẫu-khe-hở TRONG track (giữa t_on..t_last, nơi _tim_dinh gốc không ra box) — nếu
        # rowcov TẠI ĐÚNG dải Y của track vượt floor thấp (0.008, bắt được câu ngắn như "扣5分" 3 ký tự mà
        # ngưỡng gốc 0.035 bỏ sót — đo thật rowcov.max()≈0.022 tại đúng câu này) thì "cứu" thêm 1 box dùng
        # x0/x1 CỦA TRACK (không tự đo lại vì không giữ mask 2D để tính cols theo cột — track đã ổn định
        # vị-trí X nên dùng x0/x1 trung bình track là hợp lý). KHÔNG cần CC-check: bằng chứng "trùng vị-trí
        # track qua nhiều thời điểm KHÁC NHAU đã qua ngưỡng gốc" mạnh hơn CC-check per-frame nhiều —
        # false-positive tĩnh (mặt người, hoa văn quần áo) chỉ tồn tại trong 1 SHOT/cảnh ngắn, khó tự đạt
        # n>=2 qua ngưỡng gốc ở NHIỀU thời điểm cách xa nhau.
        if rowcov_meta is not None:
            _y_lo_m, _H_m, _W_m = rowcov_meta
            _ts = [t for t, _ in samples]
            import bisect
            # 🐛 FIX (verify ảnh thật t=0s): "导员好" nằm ĐÚNG vị-trí track chính nhưng xuất hiện TRƯỚC
            # mốc đầu tiên track được XÁC NHẬN (t_on=0.7s, mẫu đầu track) — chữ bị vật cản che 1 phần
            # (giường tầng) nên rowcov yếu hơn thường lệ, y hệt bug câu-ngắn nhưng xảy ra Ở ĐẦU đoạn,
            # NGOÀI phạm vi [t_on,t_last] hiện có. Mở rộng vùng quét ra NGOÀI track 1 khoảng giới hạn
            # (RIA_MO_RONG_S giây) cả 2 đầu — không chỉ bên trong — để bắt câu yếu ngay trước/sau khi
            # track đủ mạnh để tự xác nhận.
            RIA_MO_RONG_S = 5.0
            # 🐛 FIX (verify video overlay: "1 đoạn text có NHIỀU khung" — 2 khung LỒNG NHAU tại cùng mẫu,
            # vd t=28.03s có 2 box y gần trùng x khác hẳn): khi 2 track KHÁC NHAU (không được nối — đúng vì
            # đã thêm gating hình học chặn nối-nhầm nội dung khác) có vùng quét-cứu RIA_MO_RONG_S=5.0s MỖI
            # ĐẦU chồng lấn nhau (track A kết thúc gần track B bắt đầu, khoảng cách < 2×RIA), CẢ 2 track ĐỘC
            # LẬP "cứu" cho CÙNG 1 mẫu-khe-hở — mỗi track dùng ước lượng x0/x1 riêng của nó → 2 box chồng tại
            # đúng 1 thời điểm. Fix: thu thập MỌI đề xuất cứu vào `_cuu_de_xuat` trước, chỉ xử lý (append vào
            # tboxes) sau khi đã chọn ra, với MỖI mẫu-khe-hở, track có t_on/t_last GẦN mẫu đó NHẤT (khoảng
            # cách nhỏ nhất tới biên track) — loại các đề xuất từ track xa hơn cho cùng mẫu đó.
            _cuu_de_xuat = {}   # _i (index mẫu) -> list (khoang_cach, tr, y0_tr, y1_tr, x0_cuu, x1_cuu)
            for tr in segs:
                t_on, t_last, tboxes, n, _yc = tr
                if n < 2:
                    continue                        # chỉ cứu track ĐÃ XÁC NHẬN (khớp điều kiện lọc dưới)
                # 🐛 FIX (verify ảnh thật: "导员好" hẹp ~35% khung bị che RỘNG 92.7% — dải "quá to"/"quá dài"):
                # bản CŨ dùng percentile(x0,10)/(x1,90) CỦA CẢ TRACK (có thể dài hàng chục giây, nhiều câu
                # ĐỘ RỘNG khác nhau tuỳ nội dung — đã đo thật: cùng track có câu span 0.61 lẫn câu span 0.93)
                # làm x0/x1 CHUNG cho MỌI mẫu cứu bất kể mẫu đó ở đâu trong track → câu ngắn/hẹp bị "cứu" lại
                # mang kích thước của câu KHÁC hẳn (dài/rộng) tình cờ nằm trong cùng track. Fix ĐÚNG: mỗi mẫu
                # cứu dùng x0/x1 của BOX THẬT GẦN NÓ NHẤT theo thời gian (trong tboxes GỐC, trước khi thêm
                # box cứu nào) — câu ngắn liền kề câu nào thì mượn đúng bối cảnh câu đó, không lấy trung bình
                # mù cả track. y0/y1 vẫn dùng percentile CẢ TRACK (chiều cao 1 dòng chữ ổn định hơn nhiều so
                # bề rộng — các câu cùng cỡ chữ/vị trí dọc, khác nhau chủ yếu ở ĐỘ DÀI câu tức bề NGANG).
                _y0_tr = float(np.percentile([b[1][0] for b in tboxes], 25))
                _y1_tr = float(np.percentile([b[1][1] for b in tboxes], 75))
                _a_idx = max(0, int(round((_y0_tr * _H_m - _y_lo_m))))
                _b_idx = max(_a_idx, int(round((_y1_tr * _H_m - _y_lo_m))))
                _tboxes_goc = sorted(tboxes, key=lambda b: b[0])   # box THẬT trước khi cứu, dùng làm 2 mốc nội suy
                _ts_goc = [b[0] for b in _tboxes_goc]
                # 🐛 FIX (research: track/tracklet interpolation — chuẩn IOU-Tracker/SORT-family cho "gap
                # filling" giữa 2 detection quanh 1 lỗ hổng — KHÔNG "mượn nguyên 1 box gần nhất" (nearest-hold),
                # vì verify ảnh thật phát hiện: mẫu cứu có thể nằm giữa 2 TRACK RIÊNG BIỆT (2 câu thoại khác
                # hẳn nội dung, tình cờ nối vào cùng track qua bước NỐI phía trên) — "坚决不行" (t=7.82s, giữa
                # track kết thúc t=7.00 và track bắt đầu t=8.63) bị mượn x0/x1 của câu track SAU (hoàn toàn
                # khác nội dung) → dải che sai kích thước. Nội suy TUYẾN TÍNH giữa box TRƯỚC + box SAU liền kề
                # (theo tỷ lệ thời gian) đúng hơn "mượn 1 bên" khi có CẢ 2 mốc.
                # 🐛 FIX #2 (verify lại sau khi thêm nội suy: vẫn SAI vì gating theo THỜI GIAN không đúng tiêu
                # chí — "坚决不行" cách 2 mốc chỉ 1.63s (dưới ngưỡng ban đầu 4.0s) nhưng 2 mốc vẫn là 2 CÂU
                # HOÀN TOÀN KHÁC NHAU, nội suy tuyến tính giữa chúng vẫn ra kết quả không khớp chữ thật nào cả
                # — "liền câu" không tương quan với khoảng cách THỜI GIAN mà với mức ĐỘ GIỐNG NHAU vị-trí/kích
                # thước (validation gating đúng nghĩa dùng khoảng cách trong KHÔNG GIAN TRẠNG THÁI, không phải
                # thời gian). Đổi tiêu chí gating: nếu 2 mốc chênh lệch HÌNH HỌC lớn (span hoặc x0/x1 lệch
                # nhiều — dấu hiệu 2 câu khác độ dài/vị-trí) → không đáng tin nội suy hẹp.
                # 🐛 FIX #3 (user verify ảnh thật: khung "坚决不行" v.v. RÕ RÀNG rộng hơn nhiều so 4 ký tự chữ
                # thật): UNION (min(x0)/max(x1) của CẢ 2 track) luôn lấy đúng bằng track RỘNG NHẤT trong 2 —
                # nếu 1 trong 2 track láng giềng vốn đã rất rộng (câu dài), mọi câu-cứu-ở-giữa dù ngắn cỡ nào
                # cũng bị che theo đúng bề rộng track dài đó. Đổi sang TRUNG BÌNH CỘNG x0/x1 của 2 track — vẫn
                # AN TOÀN hơn "lấy hẹp nhất" (không rủi ro lộ chữ kiểu cũ), nhưng không còn luôn bằng mức RỘNG
                # NHẤT có thể — giảm ~1/2 độ rộng-thừa trung bình so với union, đổi lấy che khít hơn.
                _GATING_MAXDIFF = 0.15                  # lệch x0 HOẶC x1 giữa 2 mốc > 15% khung → không tin nội suy
                def _box_cuu(_t_can_cuu):
                    _j = bisect.bisect_left(_ts_goc, _t_can_cuu)
                    _truoc = _tboxes_goc[_j - 1] if _j > 0 else None
                    _sau = _tboxes_goc[_j] if _j < len(_ts_goc) else None
                    if _truoc is None:
                        return _sau[1][2], _sau[1][3]
                    if _sau is None:
                        return _truoc[1][2], _truoc[1][3]
                    _lech = max(abs(_sau[1][2] - _truoc[1][2]), abs(_sau[1][3] - _truoc[1][3]))
                    if _lech > _GATING_MAXDIFF:         # 2 mốc lệch hình học nhiều → khác câu, không nội suy hẹp
                        return ((_truoc[1][2] + _sau[1][2]) / 2.0, (_truoc[1][3] + _sau[1][3]) / 2.0)  # trung bình
                    _dt = _sau[0] - _truoc[0]
                    _frac = 0.5 if _dt <= 1e-9 else (_t_can_cuu - _truoc[0]) / _dt
                    _x0 = _truoc[1][2] + (_sau[1][2] - _truoc[1][2]) * _frac
                    _x1 = _truoc[1][3] + (_sau[1][3] - _truoc[1][3]) * _frac
                    return (_x0, _x1)
                _i0 = bisect.bisect_left(_ts, max(0.0, t_on - RIA_MO_RONG_S))
                _i1 = bisect.bisect_right(_ts, t_last + RIA_MO_RONG_S)
                for _i in range(_i0, _i1):
                    _t_i, _boxes_i = samples[_i]
                    # 🐛 FIX (verify ảnh thật: "导员好" đầu video LẠI mất che sau khi hạ y_lo bắt title-card
                    # đỉnh khung — regression MỚI): mẫu multi-track có thể có box ở NHIỀU vị-trí Y khác nhau
                    # cùng lúc (vd banner tiêu đề y~0.10 VÀ track đang xét y~0.61) — "mẫu này ĐÃ có box" (bất
                    # kỳ Y nào) KHÔNG có nghĩa "track ĐANG XÉT đã có box" — trước khi hạ y_lo, mẫu đầu video
                    # luôn RỖNG (banner bị y_lo=0.22 cắt mất) nên check cũ tình cờ đúng; sau khi hạ y_lo, mẫu
                    # có box banner → bị hiểu nhầm "đã đủ, khỏi cứu" → track khác (y~0.61) bị BỎ SÓT cứu dù
                    # thật sự cần. Chỉ skip khi có box TRÙNG dải Y track đang xét (yc trong [y0_tr,y1_tr] nới
                    # nhẹ), không phải bất kỳ box nào ở bất kỳ Y nào.
                    if _boxes_i and any(_y0_tr - 0.02 <= (_bx[0] + _bx[1]) / 2.0 <= _y1_tr + 0.02 for _bx in _boxes_i):
                        continue
                    _rc = rowcovs[_i]
                    _seg_len = _b_idx - _a_idx + 1
                    if _seg_len <= 0 or _b_idx >= len(_rc):
                        continue
                    if float(_rc[_a_idx:_b_idx + 1].max()) >= 0.008:
                        _x0_cuu, _x1_cuu = _box_cuu(_t_i)
                        # khoảng cách từ mẫu tới biên track (0 nếu mẫu nằm TRONG [t_on,t_last] gốc)
                        _khoang_cach = max(0.0, t_on - _t_i, _t_i - t_last)
                        _cuu_de_xuat.setdefault(_i, []).append(
                            (_khoang_cach, tr, _y0_tr, _y1_tr, _x0_cuu, _x1_cuu))
            # phân xử: mỗi mẫu-khe-hở chỉ 1 track (gần nhất) được cứu — loại đề xuất từ track xa hơn
            for _i, _de_xuat in _cuu_de_xuat.items():
                _khoang_cach, tr, _y0_tr, _y1_tr, _x0_cuu, _x1_cuu = min(_de_xuat, key=lambda d: d[0])
                _t_i = samples[_i][0]
                tr[2].append((_t_i, (_y0_tr, _y1_tr, _x0_cuu, _x1_cuu)))
                tr[3] += 1
                tr[0] = min(tr[0], _t_i); tr[1] = max(tr[1], _t_i)
        # 🐛 FIX (verify ảnh thật: "vẫn chưa fit ngang" dù BLUR_GOM ở localize.py đã sửa KHÔNG gộp x0/x1):
        # gốc rễ thật ở CHÍNH ĐÂY — TRƯỚC ĐÂY toàn bộ box trong 1 track bị GỘP THÀNH 1 TUPLE DUY NHẤT
        # bằng percentile(x0,10)/percentile(x1,90) CỦA CẢ TRACK trước khi trả về, nên `blur_segs` truyền
        # xuống burn_phude CHỈ CÓ 1 BOX/TRACK ngay từ đầu — fix "không gộp" ở BLUR_GOM (localize.py)
        # không có gì để phát huy vì input đã bị gộp mất từ TRƯỚC ĐÓ. Fix ĐÚNG GỐC: trả về TỪNG box con
        # NGUYÊN VẸN (t_on_box, t_off_box, y0,y1,x0,x1) — KHÔNG percentile-gộp x0/x1 nữa. `_le`/nối/enable
        # liên tục giờ do BLUR_GOM (localize.py, đã sửa đúng trước đó) xử lý dựa trên list box con thật.
        # 🐛 FIX (verify video overlay: "1 đoạn text có NHIỀU khung" — 2 khung gần trùng nhau tại cùng vị-trí):
        # `half` HẰNG SỐ = stride/fps/2.0 (stride THƯỜNG) — nhưng 12s ĐẦU video dùng head_stride = stride//2
        # (dò dày gấp đôi) nên khoảng cách mẫu THẬT ở đó chỉ ~half/2 giây. Áp `half` (tính theo stride thường)
        # cho box của mẫu-head khiến mỗi box RỘNG HƠN khoảng cách tới mẫu kế tiếp → 2 box liên tiếp CHỒNG LẤN
        # ~50% thời gian → hiện 2 khung gần trùng thay vì 1 chuỗi liên tục mượt. Tính `half` RIÊNG cho từng
        # box theo đúng stride đã dùng khi lấy mẫu đó (tra `sample_strides` qua index nhị phân trên `_ts`).
        _ts_all = [t for t, _ in samples]
        def _half_cho(_t_b):
            _idx = bisect.bisect_left(_ts_all, _t_b)
            if _idx < len(_ts_all) and _ts_all[_idx] == _t_b:
                return sample_strides[_idx] / fps / 2.0
            return half   # fallback (không tìm thấy mốc khớp — không nên xảy ra, giữ hành vi cũ an toàn)
        out = []
        for t_on, t_last, tboxes, n, _ in segs:
            if n < 2:
                continue                            # đoạn 1 mẫu = nhiễu → bỏ
            tboxes.sort(key=lambda b: b[0])          # theo thời gian, đảm bảo thứ tự ổn định
            for _t_b, (by0, by1, bx0, bx1) in tboxes:
                _half_i = _half_cho(_t_b)
                out.append((max(0.0, _t_b - _half_i), _t_b + _half_i, by0, by1, bx0, bx1))
        if not out:
            return None
        log_fn("🎯 Dò HỘP sub ĐỘNG (ảnh rẻ): %d đoạn vị-trí — blur + phụ đề bám theo sub di chuyển." % len(out))
        return out
    except Exception:
        import traceback as _tb, os as _os
        if _os.environ.get("VC_DEBUG_TRACE") == "1":
            _tb.print_exc()
        return None


def phat_hien_dai_rapid(video, log_fn=print, n_frames=8):
    """Trả (y0_frac, y1_frac, H) dải sub, hoặc None nếu QUÉT ĐƯỢC mà không đủ tin cậy (video không hardsub).
    RAISE (không return None) khi LỖI KỸ THUẬT (chưa cài RapidOCR, không mở được file — vd path Unicode/emoji
    OpenCV lỗi) — caller (dai_sub.detect_blur_band) cần phân biệt 2 case để quyết có lùi OpenCV hay không:
    None = tin cậy video không có chữ (KHÔNG che); exception = không kết luận được (mới lùi OpenCV).
    n_frames=8 là SỐ MẪU TỐI THIỂU — video DÀI tự tăng số mẫu (xem bên dưới), không còn cố định 8 cho mọi
    video (BUG THẬT: video 806s có hardsub THƯA — chỉ vài câu ngắn rải rác, cách nhau hàng phút — 8 mẫu cách
    nhau ~100s/mẫu bỏ lỡ TOÀN BỘ câu chữ thật → không blur cả video dù có hardsub. Video ngắn/sub liên tục vẫn
    đủ 8 mẫu như cũ, không đổi hành vi)."""
    try:
        import cv2
        import numpy as np
        import ocr_text
        if not ocr_text.co_rapidocr():
            raise LoiKyThuat("RapidOCR chưa cài")
        eng = ocr_text._engine()
        cap = cv2.VideoCapture(os.path.abspath(video))
        if not cap.isOpened():
            raise LoiKyThuat("Không mở được video (OpenCV VideoCapture fail — path lỗi?)")
        nfr = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        if H <= 0 or nfr <= 0 or W <= 0:
            cap.release()
            # 🔴 01/08/2026 — CÙNG HỌ LỖI với khối `except` cuối hàm: đọc METADATA thất bại là lỗi KỸ THUẬT,
            # nhưng `return None` lại có nghĩa XÁC ĐỊNH với caller là "đã quét xong, video KHÔNG có sub cứng"
            # ⇒ file mp4 hỏng header/codec lạ bị KHẲNG ĐỊNH là "không có phụ đề" ⇒ không che gì, cũng không lùi
            # tầng OpenCV. Hai trạng thái khác hẳn nhau KHÔNG được dùng chung 1 giá trị trả về.
            raise LoiKyThuat("Không đọc được kích thước/số khung video (H=%s W=%s n=%s) — file hỏng hoặc codec lạ."
                             % (H, W, nfr))
        # TĂNG SỐ MẪU theo ĐỘ DÀI video (giây) — 1 mẫu mỗi ~25s, tối thiểu n_frames (mặc định 8, video ngắn
        # giữ nguyên), TRẦN 40 mẫu (video rất dài — vd phim 1-2h — khỏi quét quá lâu, 25s/mẫu vẫn đủ dày để
        # bắt câu chữ thưa mà không tốn thời gian vô hạn). CHE_RAPID_NFRAMES override thủ công nếu cần.
        if fps > 0:
            _dur_s = nfr / fps
            _auto_n = int(_dur_s / 25.0) + 1
            n_frames = max(n_frames, min(40, _auto_n))
        try:
            n_frames = int(os.environ.get("CHE_RAPID_NFRAMES") or n_frames)
        except ValueError:
            pass
        # OCR QUÉT VÙNG: MẶC ĐỊNH QUÉT CẢ MÀN (user chốt 2026-07-23 "không thiên vị đáy — đỉnh/đáy blur tĩnh, giữa
        # động"): video REFRAME (đổi khung 9:16) ĐẨY chữ gốc lên CAO (y0.13, rednote đậu nước ép) → quét-55%-dưới cũ
        # BỎ SÓT hoàn toàn → chữ Trung cao LỘ. Quét cả màn BẮT được mọi vị-trí; rủi ro chọn nhầm logo/header đỉnh
        # được chặn bằng: (a) bỏ bottom-bias (CHE_DAY_BIAS=0 mặc định — chọn theo nf×rộng, không thiên đáy), (b) VERIFY
        # chữ HÁN thật ở dải chọn (loại logo/watermark Latin — xem _co_han dưới). Quét-55%-dưới cũ: CHE_HEADER=0.
        try:
            if os.environ.get("CHE_HEADER", "1") != "0":
                y_off = int(H * (float(os.environ.get("CHE_YOFF_PCT", "0") or 0) / 100.0))
            else:
                y_off = int(H * (float(os.environ.get("CHE_YOFF_PCT", "45") or 45) / 100.0))
        except ValueError:
            y_off = int(H * 0.0)
        sc = 1280.0 / W if W > 1280 else 1.0   # thu nhỏ cho det nhanh
        boxes = []   # mỗi box: (yc_frac, y0_frac, y1_frac, w_frac, xc_frac, frame_k)
        crops = []   # (k, crop_bgr) — GIỮ để dò CHỮ-ĐỔI (phân biệt SUB vs biển-hiệu-TĨNH) ở bước chọn cluster
        _n_thu, _n_loi, _loi_cuoi = 0, 0, ""   # đếm lời gọi engine THÀNH/BẠI để phân biệt "không có chữ" vs "engine chết"
        for k in range(n_frames):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(nfr * (k + 0.5) / n_frames))
            ok, fr = cap.read()
            if not ok or fr is None:
                continue
            crop = fr[y_off:, :]
            crops.append((k, crop))
            cim = cv2.resize(crop, (int(crop.shape[1] * sc), int(crop.shape[0] * sc))) if sc != 1.0 else crop
            _n_thu += 1
            try:
                out = eng(cim, use_cls=False, use_rec=False)   # DET-ONLY (chỉ box)
            except Exception as _ef:
                # 🔴 01/08/2026 — `continue` CÂM ở đây là lỗ hổng LỚN NHẤT còn sót của họ bug "lỗi kỹ thuật bị
                # dịch thành sự thật nội dung": engine chết ở MỌI frame (CUDA OOM, onnxruntime hỏng, DLL lỗi)
                # ⇒ boxes rỗng ⇒ `return None` bên dưới ⇒ caller hiểu là "video KHÔNG có phụ đề cứng" ⇒ không
                # che gì. Vì nó nằm TRONG vòng lặp nên `except` cuối hàm KHÔNG BAO GIỜ bắt được. Nay ĐẾM lại:
                # sai lẻ tẻ (1-2 frame) vẫn bỏ qua như cũ, nhưng sai TOÀN BỘ thì raise LoiKyThuat (dòng ~1531).
                _n_loi += 1
                _loi_cuoi = "%s: %s" % (type(_ef).__name__, str(_ef)[:120])
                continue
            bxs = out[0] if isinstance(out, tuple) else out
            ch, cw = cim.shape[0], cim.shape[1]
            for box in (bxs or []):
                ys = [p[1] for p in box]
                xs = [p[0] for p in box]
                a = (min(ys) / ch * (H - y_off) + y_off) / H
                b = (max(ys) / ch * (H - y_off) + y_off) / H
                w = (max(xs) - min(xs)) / cw
                xc = (max(xs) + min(xs)) / 2.0 / cw
                boxes.append(((a + b) / 2, a, b, w, xc, k))
        cap.release()
        # Engine hỏng ở MỌI khung đã thử ⇒ KHÔNG có quyền kết luận gì về nội dung video (xem ghi chú trong
        # vòng lặp). Phải báo lỗi KỸ THUẬT để caller lùi tầng khác, thay vì im lặng nói "video không có sub".
        if _n_thu > 0 and _n_loi == _n_thu:
            raise LoiKyThuat("OCR chết ở TẤT CẢ %d khung đã quét — %s" % (_n_thu, _loi_cuoi or "không rõ"))
        if _n_loi:
            log_fn("⚠ OCR lỗi ở %d/%d khung khi dò dải (vẫn dùng %d khung đọc được)." % (_n_loi, _n_thu, _n_thu - _n_loi))
        if len(boxes) < max(3, n_frames // 3):
            return None
        # CLUSTER 1D theo y-center: sort rồi gom các box cách nhau ≤ 0.03 (cùng 1 hàng text lặp qua frame).
        boxes.sort(key=lambda z: z[0])
        clusters, cur = [], [boxes[0]]
        for bx in boxes[1:]:
            if bx[0] - cur[-1][0] <= 0.03:
                cur.append(bx)
            else:
                clusters.append(cur)
                cur = [bx]
        clusters.append(cur)
        # Chọn cluster SUBTITLE. Ứng viên: nhiều frame (ổn định) × rộng (loại watermark/username hẹp góc).
        # LOẠI "NHIỀU NHÃN KHÁC NHAU CÙNG DẢI Y" (đo thật: video đồ hoạ khoa học động — nhãn hành tinh
        # "Jupiter"/"Mars"/"10P/Tempel" bay ở nhiều vị trí ngang khác nhau, VÔ TÌNH rơi cùng dải y-1D →
        # cluster gộp nhầm thành "1 dải chữ đổi liên tục" → tưởng sub, che nhầm cả dải rộng). Sub THẬT (kể
        # cả 2 dòng/lệch trái-phải theo độ dài câu) có tâm ngang (xc) các box DAO ĐỘNG ÍT quanh 1 vị trí;
        # nhiều-đối-tượng-khác-nhau có xc TRẢI RỘNG gần hết khung. Ngưỡng rộng (0.55) tránh loại oan sub
        # lệch nhiều do câu dài/ngắn xen kẽ. Tắt: CHE_XC_SPAN=0.
        cand = []
        for cl in clusters:
            nf = len(set(z[5] for z in cl))                    # số frame khác nhau cluster xuất hiện
            avg_w = sum(z[3] for z in cl) / len(cl)            # bề rộng trung bình (sub rộng, watermark hẹp)
            yc = sum(z[0] for z in cl) / len(cl)              # vị trí dọc (thấp = gần đáy)
            if nf < 2 or avg_w < 0.12:                         # bỏ cluster thoáng qua / quá hẹp (góc)
                continue
            if os.environ.get("CHE_XC_SPAN", "1") != "0":
                _xcs = [z[4] for z in cl]
                if (max(_xcs) - min(_xcs)) > 0.55:
                    # KHÔNG loại thẳng cả cụm: cluster-1D theo Y có thể BẮC CẦU gộp nhầm sub THẬT (xc ổn định)
                    # với chữ trang trí/nhãn khác gần đó về y (đo thật: "SKYWATCHING HIGHLIGHTS" mờ dính liền
                    # cụm y-1D với hardsub "That's What's Up..." bên dưới → cả cụm bị loại oan, sub thật mất
                    # theo). Tách lại theo XC (ngưỡng 0.15 — sub 1 dòng dao động ít quanh tâm) → phần con
                    # thật sự "1 dòng ổn định" vẫn được xét bình thường, chỉ phần rác (nhãn rải rác) bị loại.
                    _sub = sorted(cl, key=lambda z: z[4])
                    _groups, _g = [], [_sub[0]]
                    for z in _sub[1:]:
                        if z[4] - _g[-1][4] <= 0.15:
                            _g.append(z)
                        else:
                            _groups.append(_g); _g = [z]
                    _groups.append(_g)
                    _tach_ok = False
                    for _g in _groups:
                        _gxcs = [z[4] for z in _g]
                        if (max(_gxcs) - min(_gxcs)) > 0.55:      # nhóm con vẫn rải rác → bỏ (đúng là rác)
                            continue
                        _gnf = len(set(z[5] for z in _g))
                        _gw = sum(z[3] for z in _g) / len(_g)
                        if _gnf < 2 or _gw < 0.12:
                            continue
                        _gyc = sum(z[0] for z in _g) / len(_g)
                        cand.append((_g, _gnf, _gw, _gyc))
                        _tach_ok = True
                    if _tach_ok:
                        log_fn("ℹ Cụm y=%.0f%% tâm ngang trải %.0f%% (lẫn nhãn/đối tượng khác) → tách theo "
                               "vị-trí ngang, giữ phần ổn định làm ứng viên sub." % (yc * 100, (max(_xcs) - min(_xcs)) * 100))
                    else:
                        log_fn("ℹ Bỏ cụm y=%.0f%% (tâm ngang trải %.0f%% khung — nhiều nhãn/đối tượng khác "
                               "nhau, không phải 1 dòng sub)." % (yc * 100, (max(_xcs) - min(_xcs)) * 100))
                    continue
            cand.append((cl, nf, avg_w, yc))
        if not cand:
            return None
        # KHÔI PHỤC che-sub GIỮA khung (regression: det-only + bottom-bias (0.6+yc) nuốt sub giữa split-screen
        # Douyin "2 ảnh chồng"). Phân biệt SUB (nội dung ĐỔI qua frame, MỌI vị trí kể cả giữa) vs biển-hiệu/logo/
        # watermark TĨNH (không đổi) bằng CHÊNH-LỆCH ẢNH giữa các frame (rẻ, KHÔNG OCR — rec quá chậm ~70s). Dải
        # đổi-ảnh nhiều = SUB. Có cluster đổi → chọn theo nhiều-frame×rộng (BỎ bottom-bias → sub giữa thắng).
        # KHÔNG cluster nào đổi (mọi cluster tĩnh / lỗi) → GIỮ logic cũ bottom-biased (0 regression). Tắt: CHE_GIUA=0.
        _crop_h = H - y_off
        # 🐛 FIX (video truyện AI disclaimer TĨNH nhưng NỀN ĐỘNG phía sau — comment gốc dòng dưới đã tự cảnh
        # báo "_doi_anh (absdiff) KHÔNG lọc được vì nền động sau disclaimer cũng 'đổi'"): absdiff trên CẢ VÙNG
        # ẢNH THÔ (bands, bao gồm cả nền/animation phía sau chữ) khiến disclaimer tĩnh vẫn ra điểm đổi CAO —
        # đo thật video "萌娃结伴寻至亲": disclaimer đỉnh score=56.08, sub thoại thật đáy score=69.38, cả 2 đều
        # vượt xa ngưỡng CHE_GIUA_THR=4.0 → disclaimer lọt vào 'changing' rồi thắng điểm nf×rộng. Fix: đo
        # absdiff trên MASK CHỮ (pixel trắng>195 VÀ gần viền đen<70, dilate 7×7 — CÙNG công thức ocr_text.
        # ocr_dong dòng ~542-547 dùng để cô lập nét chữ khỏi nền) thay vì cả vùng ảnh thô — cô lập được đúng
        # NÉT CHỮ, loại animation/ánh sáng nền biến thiên phía sau. Disclaimer tĩnh → mask gần như không đổi
        # (điểm ~0); sub thoại thật đổi câu mỗi lần → mask đổi rõ rệt (điểm cao). Không đụng ngưỡng
        # CHE_GIUA_THR (đã hiệu chỉnh theo thang mask nhị phân 0/1, không phải thang xám 0-255 nữa — env vẫn
        # override được nếu cần tinh chỉnh riêng).
        def _mask_chu(gray):
            _w = gray > 195
            _dk = cv2.dilate((gray < 70).astype(np.uint8), np.ones((7, 7), np.uint8))
            return (_w & (_dk > 0)).astype(np.float32)
        def _doi_anh(cl):
            y0c = min(z[1] for z in cl); y1c = max(z[2] for z in cl)
            r0 = max(0, int(y0c * H - y_off) - 4); r1 = min(_crop_h, int(y1c * H - y_off) + 4)
            if r1 - r0 < 6:
                return 0.0
            ks = set(z[5] for z in cl); bands = []
            for _k, _crop in crops:
                if _k in ks:
                    _gray = cv2.cvtColor(_crop[r0:r1, :], cv2.COLOR_BGR2GRAY)
                    bands.append(_mask_chu(_gray))
            if len(bands) < 2:
                return 0.0
            difs = [float(np.mean(np.abs(bands[i] - bands[i - 1]))) for i in range(1, len(bands))]
            return sum(difs) / len(difs)                       # mask nhị phân 0/1; sub ĐỔI chữ → cao, banner tĩnh → ~0
        # LOẠI DÒNG CỐ ĐỊNH (disclaimer AI "AI演绎情节 仅供娱乐 无不良引导" / watermark chữ / credit): REC text ở
        # 2-3 frame → nếu GIỐNG HỆT nhau qua thời gian = KHÔNG phải phụ đề (sub chính ĐỔI text mỗi câu). BUG THẬT
        # (video truyện AI Trung): disclaimer đáy RỘNG + MỌI frame + sát đáy → thắng điểm nf×w×yc → tool che
        # disclaimer, ĐỂ LỘ sub chính ở giữa (~68%). _doi_anh (absdiff) KHÔNG lọc được vì nền động sau disclaimer
        # cũng "đổi". Chỉ REC-text phân biệt CHẮC. Tắt: CHE_LOC_CODINH=0. (verify thật: sub đổi 你弟拿.../妈/你还想...;
        # disclaimer 3 mốc CÙNG "AI演绎情节...".)
        if os.environ.get("CHE_LOC_CODINH", "1") != "0" and len(cand) >= 2:
            def _rec_text(cl, kset):
                y0c = min(z[1] for z in cl); y1c = max(z[2] for z in cl)
                r0 = max(0, int(y0c * H - y_off) - 4); r1 = min(H - y_off, int(y1c * H - y_off) + 4)
                if r1 - r0 < 6:
                    return None
                import ocr_text as _ot
                for _k, _crop in crops:
                    if _k in kset:
                        try:
                            t = _ot._doc_rec(_crop[r0:r1, :], eng)
                        except Exception:
                            t = ""
                        if t and len(t.strip()) >= 2:
                            return t.strip()
                return None
            def _co_dinh(cl):
                ks = sorted(set(z[5] for z in cl))
                if len(ks) < 3:                       # <3 frame → không đủ mẫu để chắc "cố định" → GIỮ (an toàn)
                    return False
                # đọc text ở frame ĐẦU, GIỮA, CUỐI của cluster
                t0 = _rec_text(cl, {ks[0]}); t1 = _rec_text(cl, {ks[len(ks)//2]}); t2 = _rec_text(cl, {ks[-1]})
                got = [t for t in (t0, t1, t2) if t]
                if len(got) < 2:
                    return False                      # đọc không ra → GIỮ (đừng loại oan)
                import ocr_text as _ot
                # 🐛 FIX (video truyện AI disclaimer 2 DÒNG: dòng 2 OCR đọc THIẾU CHỮ khác nhau mỗi mốc — đo
                # thật "请勿带入现实"(đủ)/"请带入现实"(thiếu 1 chữ giữa)/"请现"(chỉ còn 2 chữ ĐẦU+GẦN-CUỐI, bỏ
                # 3 chữ giữa) — KHÔNG phải lỗi lác đác 1-2 ký tự mà _giong nhắm tới (mất chữ RẢI RÁC giữa câu,
                # không liền mạch → substring liên tục KHÔNG khớp: "请现" không phải substring của "请勿带入现实"
                # dù chỉ là bỏ bớt chữ giữa), nên _giong trả False, disclaimer không bị coi cố định, vẫn thắng
                # điểm dải sub thật ở đáy. Fix ĐÚNG: kiểm tra SUBSEQUENCE (dãy con — mọi ký tự chuỗi ngắn xuất
                # hiện trong chuỗi dài ĐÚNG THỨ TỰ, được phép bỏ qua ký tự ở giữa) thay vì substring liên tục —
                # khớp đúng bản chất lỗi OCR "rớt chữ" (fade-in/nhiễu làm rec bỏ sót ký tự rải rác, không phải
                # đọc nhầm 1 đoạn liên tục). Sub thoại THẬT đổi hẳn nội dung mỗi câu → hiếm khi là subsequence
                # của câu khác hoàn toàn không liên quan (rủi ro false-positive thấp, chỉ áp cho bước lọc-cố-
                # định này, KHÔNG đụng _giong dùng chung nơi khác — dedup cue/gộp câu vẫn giữ ngưỡng cũ).
                def _la_day_con(ngan, dai):
                    it = iter(dai)
                    return all(c in it for c in ngan)
                def _cung_cau(a, b):
                    if _ot._norm_cmp(a) == _ot._norm_cmp(b) or _ot._giong(a, b):
                        return True
                    na, nb = _ot._norm_cmp(a), _ot._norm_cmp(b)
                    if len(na) >= 2 and len(nb) >= 2:
                        ngan, dai = (na, nb) if len(na) <= len(nb) else (nb, na)
                        if _la_day_con(ngan, dai):
                            return True
                    return False
                # 2 mốc cách xa mà CÙNG câu (norm-equal / _giong / substring-do-đọc-thiếu) → cố định = disclaimer/watermark
                return all(_cung_cau(got[0], g) for g in got[1:])
            # 🐛 FIX (khách "cùng 1 dải vẫn mất sub"/"video không sub luôn" — cùng họ bug với guard watermark-tĩnh
            # ở _hoc_dai_sub_thua): _co_dinh() chỉ đọc 3 frame (đầu/giữa/cuối cluster) — nếu tình cờ trùng nội
            # dung (câu thoại dài trải cả 3 mốc, hoặc OCR đọc lệch về cùng kết quả), cluster sub THẬT bị coi
            # "cố định" và bị loại, chỉ còn cluster khác (watermark thật) → chọn nhầm watermark làm dải che, mất
            # sub hoàn toàn dù dải không đổi vị-trí.
            # 🐛 FIX #2 (video truyện AI: disclaimer TĨNH ở ĐỈNH xuất hiện 40/40 frame — CAO HƠN cả sub thoại
            # thật ở đáy 37/40, vì sub có khoảng-lặng giữa câu): giả định cũ "cluster nf lớn nhất luôn là sub
            # thật, miễn trừ khỏi test cố-định" bị ĐẢO NGƯỢC ở đây — disclaimer đứng yên MỌI frame nghiễm nhiên
            # có nf cao nhất, được miễn trừ oan, sub thật đáy (nf thấp hơn 1 chút vì khoảng lặng) mới bị đem
            # test _co_dinh (dù nó ĐỔI câu liên tục, KHÔNG cố định). Verify bằng thực nghiệm (video 💥萌娃结伴寻
            # 至亲): disclaimer "ai生成内容，未成年人切勿模仿" nf=40 avg_w=0.375 (điểm 15.0) thắng sub thoại thật
            # nf=37 avg_w=0.310 (điểm 11.47) ở bước chọn best theo nf×rộng — che nhầm disclaimer, sub thoại
            # ĐÁY lộ nguyên suốt video. Fix ĐÚNG: bỏ hẳn miễn-trừ theo nf — test _co_dinh cho MỌI cluster
            # trong cand (kể cả cluster nf lớn nhất). An toàn: nếu TẤT CẢ đều bị coi cố định (đọc lỗi/edge-case
            # hiếm) → _giu rỗng, GIỮ NGUYÊN cand gốc (không loại gì, hành vi cũ) thay vì che rỗng.
            _giu = [(cl, nf, avg_w, yc) for (cl, nf, avg_w, yc) in cand if not _co_dinh(cl)]
            if _giu:                                  # còn ít nhất 1 cluster đổi-text → bỏ các cluster cố định
                if len(_giu) < len(cand):
                    log_fn("ℹ Loại %d dòng chữ CỐ ĐỊNH (disclaimer AI/watermark — không đổi qua frame) khỏi dò sub."
                           % (len(cand) - len(_giu)))
                cand = _giu
        best = None
        if os.environ.get("CHE_GIUA", "1") != "0":
            try:
                # 🐛 FIX (đổi _doi_anh từ absdiff thang-xám 0-255 sang mask-chữ nhị phân 0/1 — xem comment ở
                # _doi_anh): ngưỡng cũ 4.0 hợp thang cũ, HOÀN TOÀN KHÔNG hợp thang mới (mask-diff tối đa lý
                # thuyết ~1.0). Hiệu chỉnh bằng ĐO THẬT 3 video disclaimer-2-dòng khác nhau: disclaimer tĩnh
                # mask-diff 0.006-0.032 (biến thiên do nền sau chữ), sub thoại thật 0.012-0.069 — chọn 0.011
                # (giữa 2 dải, tách đúng đa số case; v1-đỉnh 0.032 > 0.011 vẫn qua được ngưỡng riêng lẻ NHƯNG
                # đã bị _co_dinh (REC-text, lớp phòng thủ độc lập ở trên) loại khỏi cand từ trước nên không
                # còn ảnh hưởng bước này — 2 lớp lọc bổ trợ nhau, không lớp nào phải hoàn hảo một mình).
                _thr = float(os.environ.get("CHE_GIUA_THR", "0.011") or 0.011)
            except ValueError:
                _thr = 0.011
            # SUB thật = cluster ĐỔI-CHỮ (dynamic). Nhưng khi quét CẢ màn, chữ HEADER/logo (vd "@user", tiêu đề)
            # cũng có thể đổi nhẹ → dễ THẮNG sub đáy (bug: blur header, chữ Trung ĐÁY lộ). Sub gốc HARDSUB hầu như
            # LUÔN ở ĐÁY → ưu tiên cluster THẤP (yc lớn) trong nhóm đổi-chữ, không chỉ nf×rộng. yc≥0.55 (nửa dưới)
            # được cộng điểm mạnh; header (yc<0.35) chỉ thắng khi KHÔNG có cluster đáy nào đổi. Tắt bias: CHE_DAY_BIAS=0.
            changing = [(cl, nf, avg_w, yc) for (cl, nf, avg_w, yc) in cand if _doi_anh(cl) >= _thr]
            if changing:
                # BỎ bottom-bias mặc định (user: "không thiên vị đáy") → chọn theo nf×rộng thuần (chữ thật = nhiều
                # frame + rộng, MỌI vị-trí). CHE_DAY_BIAS=1 khôi phục bias-đáy cũ (nếu video nào cần).
                if os.environ.get("CHE_DAY_BIAS", "0") == "1":
                    best = max(changing, key=lambda x: x[1] * x[2] * (0.4 + x[3]))[0]   # +yc → sub ĐÁY thắng logo trên
                else:
                    best = max(changing, key=lambda x: x[1] * x[2])[0]                  # position-agnostic
        if best is None:                                       # fallback
            if os.environ.get("CHE_DAY_BIAS", "0") == "1":
                best = max(cand, key=lambda c: c[1] * c[2] * (0.6 + c[3]))[0]           # bottom-biased cũ
            else:
                best = max(cand, key=lambda c: c[1] * c[2])[0]                          # nf×rộng thuần
        # VERIFY chữ HÁN ở dải chọn (quét cả màn → best có thể là logo/watermark Latin đỉnh, KHÔNG phải sub Hán).
        # Đọc rec best; nếu 0 Hán mà có cluster KHÁC đủ Hán → chọn cluster Hán mạnh nhất (nf×rộng). Loại logo Latin.
        # Tắt: CHE_VERIFY_HAN=0. Chỉ chạy khi ≥2 cand (1 cand thì không có lựa chọn khác — giữ nguyên).
        if os.environ.get("CHE_VERIFY_HAN", "1") != "0" and len(cand) >= 2:
            import ocr_text as _ot_v
            # 🔴 01/08/2026 — CÙNG HỌ LỖI: bản cũ `except: return ""` ⇒ rec CHẾT bị `_han_cl` hiểu là "cụm này
            # KHÔNG có chữ Hán" ⇒ bỏ dải sub THẬT, đổi sang cụm khác (thường là watermark) ⇒ che sai chỗ, chữ
            # Hán vẫn lộ. Nay tách: "" = đọc được nhưng RỖNG (kết luận nội dung được), None = LỖI KỸ THUẬT
            # (không có quyền kết luận gì).
            def _rec_1(cl, _k):                       # đọc rec 1 frame của cluster (độc lập _rec_text — có thể chưa def)
                y0c = min(z[1] for z in cl); y1c = max(z[2] for z in cl)
                r0 = max(0, int(y0c * H - y_off) - 4); r1 = min(H - y_off, int(y1c * H - y_off) + 4)
                if r1 - r0 < 6:
                    return ""
                for _kk, _crop in crops:
                    if _kk == _k:
                        try:
                            return _ot_v._doc_rec(_crop[r0:r1, :], eng) or ""
                        except Exception:
                            return None       # LỖI rec — KHÁC hẳn "đọc ra chuỗi rỗng"
                return ""
            def _han_cl(cl):
                """True = chắc chắn CÓ chữ Hán · False = đọc được nhưng không thấy Hán · None = rec HỎNG, chưa biết."""
                ks = sorted(set(z[5] for z in cl))
                _hong = 0
                for _k in (ks[0], ks[len(ks) // 2], ks[-1]):
                    _t = _rec_1(cl, _k)
                    if _t is None:
                        _hong += 1
                        continue
                    if _t and _dem_han(_t) >= 2:
                        return True
                return None if _hong == 3 else False   # hỏng CẢ 3 lần đọc ⇒ không kết luận
            _han_best = _han_cl(best)
            if _han_best is None:
                # Không đọc được gì để verify ⇒ GIỮ NGUYÊN dải mạnh nhất (đừng đổi sang cụm khác dựa trên
                # thông tin không có thật). Log để chẩn đoán được, thay vì âm thầm chọn sai.
                log_fn("⚠ Không verify được chữ Hán (rec lỗi cả 3 lần đọc) → GIỮ dải mạnh nhất, không đổi cụm.")
            elif _han_best is False:
                _han_cand = [(cl, nf, w, yc) for (cl, nf, w, yc) in cand if cl is not best and _han_cl(cl) is True]
                if _han_cand:
                    best = max(_han_cand, key=lambda x: x[1] * x[2])[0]
                    log_fn("ℹ Dải mạnh nhất KHÔNG có chữ Hán (logo/watermark?) → chọn dải CÓ chữ Hán thật.")
        # SIẾT DẢI BÁM SÁT HÀNG CHỮ: cluster gộp box nhiều frame với vị-trí HƠI LỆCH (OCR bắt nhiễu/bóng ở frame
        # khác) → percentile 10/90 cũ BAO cả outlier → dải phình (dò 20% cho 1 dòng chữ 3%). Dùng MEDIAN top/bottom
        # (vị-trí ĐIỂN HÌNH của hàng chữ) + padding nhỏ cố định → bám đúng chữ, không che cả chân người/đất.
        _tops = sorted(z[1] for z in best)
        _bots = sorted(z[2] for z in best)
        # SIẾT chiều cao dải bám hàng chữ chính (env CHE_BAND_PCT — mặc định 25 giữ hành vi cũ; tăng → khít hơn,
        # bỏ box lệch trên/dưới + câu 2-dòng lẻ; nhưng câu 2-dòng THẬT có thể hụt dòng trên → chỉ tăng khi cần).
        try:
            _bpct = float(os.environ.get("CHE_BAND_PCT", "25") or 25)
        except ValueError:
            _bpct = 25.0
        _bpct = min(49.0, max(5.0, _bpct))
        y0 = float(np.percentile(_tops, _bpct))                # mép trên điển hình (bỏ box trồi lên bất thường)
        y1 = float(np.percentile(_bots, 100 - _bpct))          # mép dưới điển hình (bỏ box tụt xuống bất thường)
        _pad = float(os.environ.get("CHE_BAND_PAD", "0.012") or 0.012)   # padding ~1.2% mỗi mép (đủ phủ nét, không dư)
        y0 = max(0.0, y0 - _pad); y1 = min(1.0, y1 + _pad)
        if y1 <= y0 or (y1 - y0) < 0.01:
            return None
        # BỀ NGANG text: union x của MỌI box nằm trong dải y (cả 2 dòng sub, không chỉ cluster tốt nhất) →
        # blur ĐÚNG HỘP text (không full-width đè 2 mép). box: z[4]=xc, z[3]=w (đều phần trăm bề rộng khung).
        inb = [z for z in boxes if (y0 - 0.02) <= z[0] <= (y1 + 0.02)]
        lf = [z[4] - z[3] / 2 for z in inb] or [0.0]
        rt = [z[4] + z[3] / 2 for z in inb] or [1.0]
        x0 = max(0.0, float(np.percentile(lf, 5)) - 0.01)     # margin NHỎ 1% mỗi mép (đủ phủ nét chữ, không dư)
        x1 = min(1.0, float(np.percentile(rt, 95)) + 0.01)
        nf = len(set(z[5] for z in best))
        # GUARD "video KHÔNG hardsub" (user báo: video không sub mà blur GIỮA màn to đùng che cả cảnh). Cảnh động
        # (nấu ăn/tay cắt) + vài box OCR ngẫu nhiên (nhãn/logo) → cluster 'đổi ảnh nhiều' → tưởng sub → dải rộng.
        # Hàng chữ sub THẬT 1-3 dòng cao ~5-18% + xuất hiện ĐỀU nhiều frame. Loại: (a) dải quá CAO >22% = diffuse
        # nội-dung-đổi chứ không phải hàng chữ (giống guard OpenCV 0.20); (b) chỉ thấy <½ số frame quét = chập chờn
        # (sub thật gần như frame nào cũng có). Tắt guard: env CHE_RAPID_LOOSE=1.
        if os.environ.get("CHE_RAPID_LOOSE") != "1":
            _cao = y1 - y0
            if _cao > 0.22:
                log_fn("ℹ Dải RapidOCR quá RỘNG (%.0f%% > 22%%) — video có thể KHÔNG có phụ đề cứng → KHÔNG blur "
                       "(tránh che cả cảnh)." % (_cao * 100))
                return None
            # BUG THẬT (user báo lộ chữ Trung video dài sub THƯA): ngưỡng cũ nf*2<n_frames (đòi ≥50% frame) LOẠI
            # OAN hardsub THƯA — mâu thuẫn với auto-tăng n_frames (dòng ~178-181) vốn để BẮT sub thưa trên video
            # dài. Sub thưa (câu ngắn rải rác cách nhau hàng phút) chỉ hiện ở vài/nhiều frame quét → nf/n_frames
            # thấp là BÌNH THƯỜNG, không phải chập chờn. Hạ ngưỡng: chỉ loại khi CỰC hiếm (≤2 frame tuyệt đối
            # HOẶC <12% — đủ loại logo/nhiễu 1-2 frame, KHÔNG loại sub thưa thật). Chỉnh: env CHE_RAPID_MINPCT.
            try:
                _minpct = float(os.environ.get("CHE_RAPID_MINPCT", "") or 0.12)
            except ValueError:
                _minpct = 0.12
            if nf <= 2 and nf < n_frames * _minpct:
                log_fn("ℹ Chữ chỉ thấy %d/%d khung (quá hiếm) — không chắc phụ đề cứng → KHÔNG blur." % (nf, n_frames))
                return None
        log_fn("🎯 Dò HỘP sub RapidOCR+clustering: y %.0f–%.0f%%, x %.0f–%.0f%% (%d/%d frame)."
               % (y0 * 100, y1 * 100, x0 * 100, x1 * 100, nf, n_frames))
        return (max(0.0, y0 - 0.006), min(1.0, y1 + 0.008), H, x0, x1)   # TIGHT: chỉ phủ nét chữ, không phình
    except LoiKyThuat:
        raise
    except Exception as _e:
        # 🔴 SỬA GỐC (31/07/2026 — khách bản release: "không che được", "lộ chữ Hán"): bản cũ nuốt MỌI lỗi rồi
        # `return None`, mà None có NGHĨA XÁC ĐỊNH với caller là "đã quét xong, video KHÔNG có phụ đề cứng"
        # (xem dai_sub.detect_blur_band: nó set _da_quet_that=True rồi kết luận source='none', KHÔNG che gì và
        # cũng KHÔNG lùi OpenCV). Tức 1 lần crash CUDA/OOM/cv2 bị DỊCH SAI thành sự thật về nội dung video →
        # tool khẳng định chắc nịch "video không có sub cứng" trong khi thực ra nó vừa chết giữa chừng.
        # Đây là LOGIC SAI, không phải thiếu lưới đỡ: hai trạng thái khác hẳn nhau ("không có chữ" vs "không
        # đọc được") bị gộp vào cùng một giá trị trả về. Nay tách đúng: lỗi kỹ thuật → LoiKyThuat, để caller
        # phân biệt được. `None` từ nay CHỈ có 1 nghĩa duy nhất: quét xong, thật sự không thấy chữ.
        raise LoiKyThuat("Dò dải RapidOCR lỗi kỹ thuật: %s: %s" % (type(_e).__name__, str(_e)[:150]))
