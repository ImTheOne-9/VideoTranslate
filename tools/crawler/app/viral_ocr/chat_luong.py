# -*- coding: utf-8 -*-
"""Bộ đo CHẤT LƯỢNG một lần render — để khi khách báo "mất chữ / dịch chưa hay / câu cụt" thì ĐỌC SỐ,
không phải đoán.

Hai phần độc lập:
  1. BỘ ĐẾM (`dem`/`lay`) — các khâu OCR/ASR/dịch tự gọi để ghi nhận việc đã làm & lỗi đã nuốt.
     Cố ý KHÔNG đổi luồng: `dem()` chỉ cộng số, không bao giờ ném lỗi ra ngoài.
  2. ĐO PHỤ ĐỀ (`do_phu_de`) — chấm file .srt thành phẩm theo chuẩn ngành.

Chuẩn dùng làm MỐC (Netflix vi-VN + BBC), là MỤC TIÊU CHẤT LƯỢNG chứ KHÔNG phải luật cứng — vượt ngưỡng
là dấu hiệu để soi, không phải lỗi bắt buộc phải cắt cho vừa (ép cứng chính là thứ đẻ ra câu cụt):
  · ≤ 42 ô/dòng · tối đa 2 dòng · ≤ 17 ký tự/giây (người lớn) · cue ≥ 0,833s và ≤ 7s
  · ngắt dòng ở điểm ngữ pháp; KHÔNG bỏ lại từ bổ nghĩa ở cuối cue (BBC)

MỐC ĐO ĐƯỢC 11/08/2026 trên 18.048 cue / 247 file `.vi.srt` thật của khách — dùng để so hồi quy:
  CPS trung vị 17,0 · **51,4% cue >17 CPS** · 31,6% >20 · **13,8% cue <0,833s** · 13,5% dòng >42 ô ·
  0% quá 2 dòng · 3,14% cue kết thúc bằng từ bổ nghĩa.
"""
import os
import re
import threading
import unicodedata

# ---------------------------------------------------------------- bộ đếm
_khoa = threading.Lock()
_so = {}
_vi_du = {}          # key -> chuỗi lý do ĐẦU TIÊN (đủ để chẩn, khỏi spam log)


def dem(khoa, n=1, chi_tiet=None):
    """Cộng bộ đếm. KHÔNG BAO GIỜ ném lỗi — nó nằm trong except của người khác, ném ra là phá luồng họ."""
    try:
        with _khoa:
            _so[khoa] = _so.get(khoa, 0) + n
            if chi_tiet is not None and khoa not in _vi_du:
                _vi_du[khoa] = str(chi_tiet)[:200]
            return _so[khoa]
    except Exception:
        return 0


def lay(khoa=None):
    with _khoa:
        return dict(_so) if khoa is None else _so.get(khoa, 0)


def vi_du(khoa):
    with _khoa:
        return _vi_du.get(khoa, "")


_srt = [None]        # đường dẫn .vi.srt của video đang chạy


_tgt = [None]        # ngôn ngữ ĐÍCH của video đang chạy


def dat_tgt(t):
    """Nhớ ngôn ngữ đích. CẦN vì chỉ số 'ngắt xấu' dựa trên danh sách từ chức năng TIẾNG VIỆT — áp cho đích
    khác là vô nghĩa. Bản đầu không có tham số này nên video đích `pt`/`th` in ra 'ngắt xấu 0 (0,0%)', đọc
    như HOÀN HẢO trong khi sự thật là KHÔNG ĐO ĐƯỢC. Con số gây hiểu nhầm còn tệ hơn không có con số."""
    _tgt[0] = (t or "").strip().lower() or None


def dat_srt(p):
    """Nhớ file phụ đề đích để `bao_cao()` chấm được kể cả khi gọi từ tầng NGOÀI `chay()`.

    Vì sao cần: `chay()` có 36 lệnh `return`, phần lớn là đường THẤT BẠI (`return None`) — mà đó đúng là
    lúc cần số liệu nhất. Đặt báo cáo ở cuối thân hàm sẽ bỏ lọt hết. Nên báo cáo được in ở `finally` của
    tầng gọi, và đường dẫn srt truyền qua đây."""
    if p:
        _srt[0] = p


def lay_srt():
    return _srt[0]


def dat_lai():
    """Gọi ở ĐẦU mỗi video — module sống suốt tiến trình nên không xoá thì số cộng dồn qua nhiều video."""
    with _khoa:
        _so.clear()
        _vi_du.clear()
    _srt[0] = None


# ---------------------------------------------------------------- đo phụ đề
CPS_MUC_TIEU = 17.0
# 🔴 NGƯỠNG "KHÔNG ĐỌC KỊP" (12/08/2026) — thêm vì `% > CPS_MUC_TIEU` một mình là chỉ số CHẾT.
# ĐO THẬT 25.050 cue / 78 file `.vi.srt` của khách: **CPS trung vị đúng bằng 17,0** ⇒ "% >17" luôn ra
# ~50% ở MỌI video, mãi mãi. Một chỉ số luôn báo đỏ thì không ai đọc nữa — đúng thứ docstring `dat_tgt`
# đã cảnh báo ("con số gây hiểu nhầm còn tệ hơn không có con số").
#
# VÌ SAO KHÔNG hạ/nâng CPS_MUC_TIEU: 17 là mốc Netflix cho chữ Latin, giữ để so chuẩn ngành. Nhưng đường
# này KHÔNG THỂ đạt nó, và đó là SỐ HỌC chứ không phải lỗi — đã đo trên 12.090 cue ghép cặp zh↔vi:
#     nguồn zh  6,6 CPS (p90 9,0)  → ĐẠT chuẩn Trung (9), phụ đề gốc đọc kịp thoải mái
#     dịch vi  21,3 CPS (p90 32,8) → 6,6 × 3,25 = 21,4
#     tỉ lệ nở chữ vi/zh = 3,25×   (1 chữ Hán = 1 âm; 1 âm Việt viết ra ~4,2 ký tự ⇒ 3,25 đã là ĐANG NÉN)
# Mốc thời gian do hardsub gốc quyết (không giãn được: khe giữa cue trung vị 0,084s = 2 khung, 56,7% khe
# ≤0,10s). Đã ĐO và LOẠI 3 cách chữa: giãn cue vào khoảng lặng (chỉ 1% cue có chỗ) · siết prompt về trần
# cứng (trần cứng vốn đã bị vượt 1,17×) · cắt từ đệm bằng luật (giảm 1,1% ký tự). Muốn đạt 17 phải cắt
# ~21% NỘI DUNG — quyết định sản phẩm, không phải việc của bộ đo.
# ⇒ Báo cáo thêm nhóm ĐUÔI: đó mới là cue thật sự không đọc kịp và thật sự đáng sửa (đo được 14,2%).
CPS_KHONG_KIP = 25.0
O_MOI_DONG = 42
SO_DONG_TOI_DA = 2
CUE_TOI_THIEU = 5.0 / 6.0        # 0,833s
CUE_TOI_DA = 7.0

# Từ đứng TRƯỚC, bổ nghĩa cho từ SAU nó → kết thúc cue bằng chúng là cắt giữa cụm (BBC).
# CỐ Ý KHÔNG có "này/đó/ấy/nào/ra/lại/qua": tiếng Việt các từ này đứng SAU danh từ/động từ nên kết
# thúc cue bằng chúng là ĐÚNG ("trong việc này"). Bỏ sót điều đó làm tỉ lệ lỗi vống lên 13,8% thay vì 3,14%.
_TU_BO_NGHIA = set("""của và là một các những cái về cho với trong trên dưới từ đến bị đã sẽ đang rất
cũng vẫn thì mà nếu khi để hay hoặc nhưng vì do bởi tại theo cùng như mỗi mọi từng vài
phải nên cần muốn định thử càng hơi khá quá chưa""".split())

_MOC = re.compile(r"(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)")


def _giay(g, o):
    return int(g[o]) * 3600 + int(g[o + 1]) * 60 + int(g[o + 2]) + int(g[o + 3]) / 1000.0


def do_rong(s):
    """Số Ô CHIẾM TRÊN KHUNG, không phải len(): chữ Hán/Kana/Hangul rộng 2 ô. Cùng nguyên tắc
    `localize._do_dai_hien` — một hằng số dùng đúng cho mọi ngôn ngữ đích, khỏi bịa bảng số riêng."""
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in str(s or ""))


def do_phu_de(srt_path, tgt=None):
    """Chấm 1 file .srt → dict số liệu. Trả {} nếu không đọc được (không ném lỗi).
    `ngat_xau` = None khi đích KHÔNG phải tiếng Việt (chỉ số đó chỉ đúng cho tiếng Việt) — người gọi phải
    in ra là "chưa đo", TUYỆT ĐỐI không in 0."""
    if tgt is None:
        tgt = _tgt[0]
    _do_ngat = (tgt or "vi") == "vi"
    try:
        with open(srt_path, encoding="utf-8-sig", errors="ignore") as f:
            noi_dung = f.read()
    except OSError:
        return {}
    tong = 0
    qua_nhanh = qua_ngan = qua_dai = dong_dai = qua_nhieu_dong = khong_kip = 0
    ngat_xau = trong = 0
    cps_ds = []
    vi_du_xau = []
    for khoi in re.split(r"\n\s*\n", noi_dung):
        m = _MOC.search(khoi)
        if not m:
            continue
        g = m.groups()
        st, en = _giay(g, 0), _giay(g, 4)
        d = en - st
        dong = [x for x in khoi.strip().split("\n")
                if x.strip() and "-->" not in x and not x.strip().isdigit()]
        if d <= 0:
            continue
        tong += 1
        if not dong:
            trong += 1
            continue
        cau = " ".join(dong).strip()
        rong = do_rong(cau)
        cps = rong / d
        cps_ds.append(cps)
        if cps > CPS_MUC_TIEU:
            qua_nhanh += 1
        if cps > CPS_KHONG_KIP:
            khong_kip += 1
        if d < CUE_TOI_THIEU:
            qua_ngan += 1
        if d > CUE_TOI_DA:
            qua_dai += 1
        if max(do_rong(x) for x in dong) > O_MOI_DONG:
            dong_dai += 1
        if len(dong) > SO_DONG_TOI_DA:
            qua_nhieu_dong += 1
        # ngắt xấu: cue KHÔNG kết thúc bằng dấu câu VÀ từ cuối là từ bổ nghĩa cho từ sau.
        # CHỈ đo khi đích là tiếng Việt — `_TU_BO_NGHIA` là danh sách từ chức năng TIẾNG VIỆT.
        if _do_ngat and not re.search(r"[.!?…,;:]$", cau):
            tu = re.sub(r"[^\wÀ-ỹ]+$", "", cau).split()
            if tu and tu[-1].lower() in _TU_BO_NGHIA:
                ngat_xau += 1
                if len(vi_du_xau) < 3:
                    vi_du_xau.append(cau[-46:])
    if not tong:
        return {}
    cps_ds.sort()
    return {"cue": tong, "trong": trong,
            "cps_trung_vi": round(cps_ds[len(cps_ds) // 2], 1) if cps_ds else 0,
            "cps_p90": round(cps_ds[int(len(cps_ds) * 0.9)], 1) if cps_ds else 0,
            "cps_max": round(cps_ds[-1], 1) if cps_ds else 0,
            "qua_nhanh": qua_nhanh, "khong_kip": khong_kip,
            "qua_ngan": qua_ngan, "qua_dai": qua_dai,
            "dong_dai": dong_dai, "qua_nhieu_dong": qua_nhieu_dong,
            "tgt": tgt or "?",
            "ngat_xau": (ngat_xau if _do_ngat else None), "vi_du_ngat_xau": vi_du_xau}


def _pc(n, tong):
    return (100.0 * n / tong) if tong else 0.0


def bao_cao(log_fn, srt_path=None):
    """In khối số liệu cuối render. Chỉ ĐỌC + IN, không đụng gì khác. Tắt: env CHAT_LUONG_LOG=0."""
    if os.environ.get("CHAT_LUONG_LOG") == "0":
        return
    if not srt_path:
        srt_path = _srt[0]
    try:
        s = lay()
        dong = ["── CHẤT LƯỢNG (số liệu để chẩn khi khách báo lỗi) ──"]

        def _khoi(ten, tien_to):
            muc = {k[len(tien_to):]: v for k, v in s.items() if k.startswith(tien_to)}
            if muc:
                dong.append("  %-6s %s" % (ten, " · ".join("%s=%d" % (k, v) for k, v in sorted(muc.items()))))
                for k in sorted(muc):
                    vd = vi_du(tien_to + k)
                    if vd and ("loi" in k or "hong" in k):
                        dong.append("         ↳ %s (lý do đầu): %s" % (k, vd))

        _khoi("OCR", "ocr.")
        _khoi("ASR", "asr.")
        _khoi("DỊCH", "dich.")
        if srt_path and os.path.isfile(srt_path):
            m = do_phu_de(srt_path)
            if m:
                t = m["cue"]
                # ĐUÔI đứng TRƯỚC: `% >17` gần như luôn ~50% trên đường này (trung vị đúng bằng 17,0) nên
                # đọc nó không biết được gì; `>25` mới phân biệt được video tốt/xấu. Xem `CPS_KHONG_KIP`.
                dong.append("  PHỤ ĐỀ %d cue · KHÔNG ĐỌC KỊP (>%.0f CPS) %d (%.1f%%) ← xem cái này trước"
                            % (t, CPS_KHONG_KIP, m.get("khong_kip", 0), _pc(m.get("khong_kip", 0), t)))
                dong.append("         CPS trung vị %.1f / p90 %.1f / max %.1f · mốc ngành ≤%.0f "
                            "(đường này KHÔNG đạt được: nguồn 6,6 CPS × nở chữ 3,25 = 21,4 — xem CPS_KHONG_KIP)"
                            % (m["cps_trung_vi"], m["cps_p90"], m["cps_max"], CPS_MUC_TIEU))
                # ⚠ 'ngắt xấu' CHỈ đo được cho tiếng Việt ⇒ đích khác in "chưa đo", KHÔNG in 0.
                # In 0 cho đích pt/th (như bản đầu) làm người đọc tưởng hoàn hảo — sai lệch hơn là bỏ trống.
                _nx = ("%d (%.1f%%)" % (m["ngat_xau"], _pc(m["ngat_xau"], t))) if m.get("ngat_xau") is not None \
                    else ("chưa đo cho đích '%s'" % m.get("tgt", "?"))
                dong.append("         >17 CPS %d (%.1f%%) · quá ngắn %d (%.1f%%) · quá dài %d · "
                            "dòng >%d ô %d (%.1f%%) · >%d dòng %d · ngắt xấu %s · rỗng %d"
                            % (m["qua_nhanh"], _pc(m["qua_nhanh"], t), m["qua_ngan"], _pc(m["qua_ngan"], t),
                               m["qua_dai"], O_MOI_DONG, m["dong_dai"], _pc(m["dong_dai"], t),
                               SO_DONG_TOI_DA, m["qua_nhieu_dong"], _nx, m["trong"]))
                for v in m.get("vi_du_ngat_xau", []):
                    dong.append("         ↳ ngắt xấu: …%s ⏎" % v)
        if len(dong) > 1:
            for d in dong:
                log_fn(d)
    except Exception:
        pass        # bộ ĐO không bao giờ được làm hỏng render — mất số liệu còn hơn mất video


