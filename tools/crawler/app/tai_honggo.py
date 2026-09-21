# -*- coding: utf-8 -*-
"""TẢI PHIM NGẮN TỪ HONGGO (红果短剧) — HAI TRANG, hai đường bóc khác hẳn nhau.

  · `hongguoduanju.com` — CHÍNH CHỦ (ByteDance). mp4 thẳng, không chặn IP, **chỉ 3 tập/bộ**.
  · `hongguoapp.cn`     — trang GƯƠNG 苹果CMS. m3u8, TRỌN BỘ, nhưng CDN chặn IP data center.
  Phần dưới đây nói về trang GƯƠNG; trang chính chủ nằm ở khối “NỀN THỨ HAI” gần cuối file.

VÌ SAO CÓ FILE RIÊNG (02/09/2026):
  · yt-dlp **KHÔNG có extractor** cho nền này ⇒ không đi ké `tai_ytdlp.py` được.
  · MediaCrawler cũng không có ⇒ không đi ké `main.py --platform` được.
  ⇒ Đây là đường thứ BA, tự chứa: bóc m3u8 từ trang web rồi để **ffmpeg** tải.

ĐƯỜNG ĐI (đã tự dò 02/09, không suy đoán):
  1. `/voddetail/<id>.html`            → trang BỘ, chứa danh sách tập `/vodplay/<id>-<nguon>-<tập>.html`
  2. `/vodplay/<id>-<nguon>-<tập>.html`→ trang XEM, chứa URL m3u8 (bị escape kiểu JSON: `https:\\/\\/...`)
  3. m3u8 (VOD, ~97 segment .ts cho 1 tập) → ffmpeg `-i <m3u8> -c copy out.mp4`
  Số đo lượt dò: trang bộ 97 KB / 75 tập · m3u8 2,4 KB · 1 segment 441 KB (~166 KB/s), MPEG-TS hợp lệ.

⚠ ĐÃ BIẾT TRƯỚC (đừng ngạc nhiên rồi kết luận "hỏng"):
  · **CDN đổi tên miền theo từng bộ** (lượt dò ra `s2.bfllvip.com`; nơi khác báo `wwzycdn.10cong.com`,
    `wangwangzyvod.com`). ⇒ TUYỆT ĐỐI không hardcode host, luôn bóc từ trang.
  · CDN **chặn IP trung tâm dữ liệu**, chỉ cho IP dân dụng ⇒ chạy trên máy khách thì được, chạy trên
    server/CI sẽ 502. Không phải lỗi code.
  · Endpoint TÌM KIẾM dính Cloudflare ⇒ file này CỐ Ý **không làm search**, chỉ theo LINK/ID.
  · Phải NGHỈ giữa các request (`--delay`, mặc định 1.5s) kẻo dính 502/403.

Dùng:
  python tai_honggo.py --list --input <link hoặc id>              # liệt kê tập (xem trước)
  python tai_honggo.py --input <link/id> --count 5                # tải 5 tập đầu
  python tai_honggo.py --input <link/id> --tap 3-7                # tải tập 3..7
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html import unescape as _go_thuc_the

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

THU_MUC_GOC = os.path.dirname(os.path.abspath(__file__))
THU_MUC_CRAWLER = os.path.join(THU_MUC_GOC, "MediaCrawler")
GOC = "https://www.hongguoapp.cn"
THU_MUC_NEN = "honggo"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def log(msg):
    """1 dòng cho web_app đọc. `flush` bắt buộc — không có thì UI đứng im tới lúc xong."""
    print("LOG:" + str(msg), flush=True)


def _data_dir():
    return (os.environ.get("MC_DATA_DIR") or "").strip() or os.path.join(THU_MUC_CRAWLER, "data")


def _ten_an_toan(s, n=80):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", str(s or "")).strip()
    s = re.sub(r"\s+", " ", s)
    return (s[:n] or "video").rstrip(" .")


def _tim_ffmpeg():
    """Dùng CHUNG bộ tìm ffmpeg của dự án (bundle → PATH → winget) thay vì gọi 'ffmpeg' trần:
    máy khách rất hay không có ffmpeg trong PATH (xem `xu_ly_video.tim_exe`)."""
    try:
        sys.path.insert(0, THU_MUC_GOC)
        from xu_ly_video import tim_exe
        return tim_exe("ffmpeg") or "ffmpeg"
    except Exception:
        return "ffmpeg"


def _get(url, referer=GOC, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": referer,
        "Accept-Language": "zh-CN,zh;q=0.9,vi;q=0.8,en;q=0.7"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def tach_id(s):
    """Lấy ID BỘ từ link hoặc từ chuỗi số trần. "" nếu không nhận ra.

    Nhận: https://www.hongguoapp.cn/voddetail/3490.html · /voddetail/3490 · /vodplay/3490-1-1.html · 3490
    """
    s = str(s or "").strip()
    m = re.search(r"/vod(?:detail|play)/(\d+)", s)
    if m:
        return m.group(1)
    return s if re.fullmatch(r"\d{1,9}", s) else ""


def _tieu_de(html):
    """Tên BỘ. Trang KHÔNG có <h1>; <title> là chuỗi SEO dài (tên + "短剧高清完整版在线观看_…").
    Tên thật nằm trong ngoặc kép Trung 《》 ⇒ lấy đúng phần đó, không thì tên thư mục và tiêu đề
    từng tập đều dài loằng ngoằng mà lại giống hệt nhau."""
    m = re.search(r"<title>(.*?)</title>", html, re.S)
    if not m:
        return ""
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip()
    trong = re.search(r"《([^》]{1,60})》", t)
    if trong:
        return trong.group(1).strip()
    return re.split(r"[_|]|\s-\s", t)[0].strip()


def _anh_bia(html):
    """Ảnh bìa. Nền này KHÔNG có og:image; ảnh đi qua lazyload nên nằm ở `data-original`
    (đã dò: `https://img.picbf.com/upload/vod/...jpg`). Ảnh ĐẦU TIÊN = bìa của chính bộ này."""
    m = re.search(r'data-original=["\']([^"\']+\.(?:jpg|jpeg|png|webp)[^"\']*)', html) \
        or re.search(r'<meta[^>]+og:image[^>]+content=["\']([^"\']+)', html)
    if not m:
        return ""
    _u = m.group(1).strip()
    # 🔴 03/09 — MỘT SỐ BỘ trả đường dẫn TƯƠNG ĐỐI (`/upload/vod/…jpg`, đo ở bộ 33015) trong khi bộ
    #   khác trả tuyệt đối (`https://img.picbf.com/upload/vod/…`, bộ 3490/16558). Trả nguyên đường
    #   tương đối thì giao diện dựng thẻ <img src="/upload/…"> trỏ vào CHÍNH máy chủ của app ⇒ ảnh
    #   bìa vỡ, không lỗi nào ném ra.
    if _u.startswith("//"):
        return "https:" + _u
    if _u.startswith("/"):
        return GOC + _u
    return _u


def liet_ke_bo(vid, delay=1.5):
    """Trang BỘ → (tiêu đề, ảnh bìa, [(nguồn, tập, đường dẫn play)]) — CHƯA đụng tới m3u8.

    Trang liệt kê MỌI nguồn phát (`<id>-1-N`, `<id>-2-N`…) — chỉ lấy MỘT nguồn, kẻo tải trùng n lần.
    🔴 SỬA 02/09/2026 — LẤY NGUỒN NHIỀU TẬP NHẤT, KHÔNG lấy nguồn có SỐ HIỆU NHỎ NHẤT.
      Giả định cũ của tôi ("nhiều nguồn = cùng nội dung, khác CDN") là SAI. Đo thật bộ 1393:
          nguồn 1 → 2 tập  ·  nguồn 2 → 65 tập
      Lấy `min(nguồn)` ra đúng 2 tập ⇒ khách xin cả bộ mà nhận về 2 tập, KHÔNG một dòng lỗi.
      (Bộ 3490/15297 chỉ có nguồn 1 nên lượt thử đầu không lộ ra — một mẫu thử là chưa đủ.)
    """
    html = _get("%s/voddetail/%s.html" % (GOC, vid))
    ten = _tieu_de(html)
    bia = _anh_bia(html)
    thay = []
    for m in re.finditer(r"/vodplay/(\d+)-(\d+)-(\d+)", html):
        if m.group(1) != str(vid):
            continue
        thay.append((int(m.group(2)), int(m.group(3))))
    if not thay:
        return ten, bia, []
    _dem = {}
    for _n, _t in thay:
        _dem.setdefault(_n, set()).add(_t)
    # nhiều tập nhất thắng; hoà thì lấy số hiệu nhỏ hơn cho ổn định giữa các lần chạy
    nguon = sorted(_dem, key=lambda k: (-len(_dem[k]), k))[0]
    taps = sorted(_dem[nguon])
    return ten, bia, [(nguon, t, "%s/vodplay/%s-%d-%d.html" % (GOC, vid, nguon, t)) for t in taps]


def m3u8_cua_tap(url_play):
    """Trang XEM → URL m3u8. "" nếu không thấy.

    URL nằm trong JSON của player nên dấu `/` bị escape thành `\\/` — phải gỡ, không thì ffmpeg
    nhận chuỗi rác rồi báo lỗi khó hiểu.
    """
    html = _get(url_play, referer=GOC)
    # 🐛 GỠ ESCAPE TRƯỚC, ĐỪNG dò trên chuỗi còn escape. Bản đầu của tôi dò thẳng và TRƯỢT: lớp ký tự
    #   loại trừ `\` nên không span nổi `s2.bfllvip.com\/video\/...` — trong khi trang RÕ RÀNG có m3u8
    #   (đã grep tay thấy). Kết quả là báo "nguồn phát đã đổi" cho một trang hoàn toàn bình thường.
    #   Thay `\/` → `/` một lần cho cả trang thì regex chỉ còn là URL thường.
    # 🔴 03/09/2026 — LẦN THỨ HAI cùng một bệnh, ở CÙNG dòng này. Bản vá 02/09 gỡ `\/` nên chạy
    #   được với CDN đặt tên thư mục bằng chữ Latin (`s2.bfllvip.com/video/renqianbushurenhoushutou/`).
    #   Nhưng CDN khác đặt tên bằng CHỮ HÁN: `v.fengbao8.com/video/…/第1集/index.m3u8` — trong HTML nó
    #   là `\u7b2c1\u96c6`, mà lớp ký tự dưới LOẠI TRỪ dấu gạch chéo ngược ⇒ không span nổi URL ⇒
    #   báo "trang xem KHÔNG có m3u8" cho một trang RÕ RÀNG có m3u8 (đếm được 2 lần chuỗi `.m3u8`).
    #   Đo thật: bộ 16558 (63 tập) cách cũ KHÔNG thấy · cách mới thấy; bộ 3490 (71 tập) cả hai đều
    #   thấy — nên bệnh này ẩn mình cho tới khi gặp đúng CDN dùng chữ Hán.
    #   ⇒ Gỡ `\uXXXX` TRƯỚC, rồi mới dò. Gỡ xong URL không còn dấu gạch chéo ngược nào nên GIỮ
    #   NGUYÊN lớp ký tự cũ (nới ra sẽ có nguy cơ nuốt lem sang chuỗi bên cạnh).
    _h = html.replace("\\/", "/")
    _h = re.sub(r"\\u([0-9a-fA-F]{4})", lambda _m: chr(int(_m.group(1), 16)), _h)
    m = re.search(r"https?://[^\"'<>\s\\]+\.m3u8[^\"'<>\s\\]*", _h)
    return m.group(0) if m else ""



# ══════════════════════════════════════════════════════════════════════════════════════════════
# NỀN THỨ HAI — hongguoduanju.com (trang CHÍNH CHỦ 红果短剧 của ByteDance)      [thêm 03/09/2026]
# ══════════════════════════════════════════════════════════════════════════════════════════════
# VÌ SAO GỘP VÀO FILE NÀY chứ không tạo nền tảng mới: cùng thương hiệu, cùng thư mục `data/honggo`,
# khách chỉ thấy MỘT nút "Honggo". Thêm nền mới sẽ kéo theo mục `NEN_TANG` + thư mục + thẻ UI riêng
# cho đúng một khác biệt là TÊN MIỀN.
#
# KHÁC HẲN hongguoapp.cn — đừng lẫn hai đường:
#   hongguoapp.cn     = trang GƯƠNG dựng bằng 苹果CMS · `/voddetail/<id>.html` · ID vài chữ số · m3u8
#   hongguoduanju.com = CHÍNH CHỦ · `/player/<series_id>[/<vid>]` · ID 19 chữ số · **mp4 thẳng**
#
# ĐƯỜNG ĐI (tự dò 03/09, KHÔNG suy đoán — số đo ghi kèm):
#   1. `/player/<sid>` → HTML dựng sẵn ở máy chủ (449 KB), KHÔNG phải SPA rỗng ⇒ khỏi trình duyệt.
#   2. Dải tập nằm ở `<a href="/player/<sid>/<vid>">…<div>N</div>`; tập ĐANG mở không có trong dải
#      mà ở `"series_id":"…","vid":"…"` ⇒ số tập thiếu trong dải chính là nó.
#   3. Trang tập chứa URL mp4 trên `v<N>-hgweb.qznovelvod.com`, tải thẳng bằng HTTP.
#   Đo 5 bộ (暖冬 63 tập · 八零团宠 80 · 掌生2 100 · 三子敬母 68 · 绿茶滚蛋吧 82): 5/5 bóc ĐỦ và
#   ĐÚNG SỐ TẬP. Tải thử: tập 1 = 43.174.805 B · tập 2 = 45.410.848 B, HTTP 206, `ftyp` hợp lệ.
#
# ⚠ ĐÃ BIẾT TRƯỚC — đừng ngạc nhiên rồi kết luận "hỏng":
#   · **WEB CHỈ CHO 3 TẬP/BỘ** (`accessible_episode_cnt`), dù bộ có 63–100 tập. Đây là TRẦN CỦA
#     TRANG, không phải tool tải thiếu. 5/5 bộ đo được đều đúng 3. PHẢI NÓI RA cho khách.
#   · URL mp4 có **CHỮ KÝ KÈM HẠN** ⇒ nạp trang tập ngay trước khi tải, không cache lại được.
#   · Trang này KHÔNG chặn IP trung tâm dữ liệu và KHÔNG cần Referer (thử bỏ Referer: vẫn 206) —
#     khác hẳn CDN của trang gương. Vẫn gửi Referer cho lành.
GOC_DJ = "https://hongguoduanju.com"


def _la_duanju(s):
    return "hongguoduanju.com" in str(s or "").lower()


def tach_sid_dj(s):
    """Link chính chủ → (series_id, vid). `vid` rỗng nghĩa là link trỏ tới BỘ, không chỉ ra tập nào.

    Nhận: /player/<sid> · /player/<sid>/<vid> · /detail?series_id=<sid>
    """
    s = str(s or "").strip()
    m = re.search(r"/player/(\d{10,22})(?:/(\d{10,22}))?", s)
    if m:
        return m.group(1), (m.group(2) or "")
    m = re.search(r"[?&]series_id=(\d{10,22})", s)
    if m:
        return m.group(1), ""
    return "", ""


def _trang_dj(url):
    r"""Tải trang rồi GỠ HAI LỚP MÃ HOÁ. Thiếu bước này hỏng câm, mà hỏng theo kiểu đổ oan:
      · `\u002F` (JSON trong `_ROUTER_DATA`) ⇒ regex URL không span nổi ⇒ tưởng "trang không có video"
      · `&amp;` (thực thể HTML) ⇒ link CDN sai tham số ký ⇒ CDN trả **403** cho link hoàn toàn đúng
    Lượt dò 03/09 vấp đúng phát 403 này, mất một vòng vì tưởng bị chặn.
    """
    return _go_thuc_the(_get(url, referer=GOC_DJ + "/").replace("\\u002F", "/"))


def liet_ke_bo_dj(sid):
    """Trang BỘ → (tên, bìa, tổng tập, số tập xem được, [(tập, vid)]) — CHƯA đụng tới mp4.

    🔴 KHÔNG bám tên class. Class của trang bị BĂM (`pc-episode-UHokP2`, `pc-episode-text-YGm8lD`),
       đổi mỗi lần họ build lại. Neo vào `href="/player/<sid>/<vid>"` — thứ mang ý nghĩa thật.
    🔴 KHÔNG suy số tập theo THỨ TỰ XUẤT HIỆN trong HTML. Đã đo: thứ tự ra là [tập 2, tập 1] —
       ngược. Phải đọc con số in trong thẻ.
    """
    h = _trang_dj("%s/player/%s" % (GOC_DJ, sid))
    ds = {}
    for m in re.finditer(r'href="/player/%s/(\d{10,22})"(.{0,300}?)>(\d{1,4})</div>' % sid, h, re.S):
        ds.setdefault(int(m.group(3)), m.group(1))
    m = (re.search(r'"accessible_episode_cnt":\{"val":(\d+)\}', h)
         or re.search(r'"accessible_episode_cnt":(\d+)', h))
    mo = int(m.group(1)) if m else 0
    m = (re.search(r'"episode_cnt":\{"val":(\d+)\}', h)
         or re.search(r'"episode_cnt":(\d+)', h))
    tong = int(m.group(1)) if m else 0
    # tập đang mở KHÔNG nằm trong dải <a> ⇒ số nào thiếu trong 1..mo chính là nó
    m = (re.search(r'"series_id":"%s","vid":"(\d{10,22})"' % sid, h)
         or re.search(r'"vid":"(\d{10,22})"', h))
    if m and mo:
        thieu = [i for i in range(1, mo + 1) if i not in ds]
        if len(thieu) == 1:
            ds[thieu[0]] = m.group(1)
    ten, bia = "", ""
    m = re.search(r'<script[^>]*ld\+json[^>]*>(.*?)</script>', h, re.S)
    if m:
        try:
            d = json.loads(m.group(1))
            ten = d.get("name") or ""
            _tn = d.get("thumbnailUrl") or []
            bia = (_tn[0] if isinstance(_tn, list) and _tn else (d.get("image") or ""))
        except (ValueError, TypeError):
            pass
    # JSON-LD trả tên TẬP ("暖冬 第1集") — cắt đuôi lấy tên BỘ, không thì mọi tập trùng một tên dài
    ten = re.sub(r"\s*第\d+集\s*$", "", ten).strip()
    return ten, bia, tong, mo, sorted(ds.items())


def mp4_cua_tap_dj(sid, vid):
    """Trang XEM → URL mp4. "" nếu không thấy. Host `v<N>-hgweb` đổi số theo lượt ⇒ KHÔNG ghim host."""
    h = _trang_dj("%s/player/%s/%s" % (GOC_DJ, sid, vid))
    m = re.search(r"https?://v\d+-hgweb\.qznovelvod\.com/[^\"'<>\s\\]{40,}", h)
    return m.group(0) if m else ""


def tai_mp4(url, dich):
    """Tải thẳng bằng HTTP — KHÔNG qua ffmpeg.

    Vì sao khác `tai_tap` (m3u8 → ffmpeg): file bên này đã là mp4 liền khối và ĐÃ faststart sẵn
    (đo box đầu: `ftyp(32) moov(164239)` ⇒ `moov` nằm ở ĐẦU). Cho ffmpeg remux chỉ tốn thêm một
    lượt đọc-ghi 43 MB mà không được gì.
    """
    tmp = dich + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": GOC_DJ + "/"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
            while True:
                buf = r.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False, str(e)[:200]
    _co = os.path.getsize(tmp)
    if _co < 100_000:
        os.remove(tmp)
        return False, "file tải về quá nhỏ (%d B) — chữ ký link có thể đã hết hạn" % _co
    os.replace(tmp, dich)
    return True, ""


def _main_dj(a):
    """Đường chạy riêng cho trang chính chủ. Tách hẳn khỏi `main()` của trang gương: hai trang khác
    nhau từ cách đánh ID tới cách lấy video — nhét chung sẽ thành mớ `if` chằng chịt."""
    sid, vid = tach_sid_dj(a.input)
    if not sid:
        print(json.dumps({"ok": False, "loi": "link_khong_hop", "msg":
            "Không đọc được mã bộ từ link hongguoduanju.com. Cần dạng "
            "hongguoduanju.com/player/<mã bộ> — mở bộ phim rồi copy link trên thanh địa chỉ."},
            ensure_ascii=False))
        return 1
    try:
        ten, bia, tong, mo, taps = liet_ke_bo_dj(sid)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        print(json.dumps({"ok": False, "msg": "Không mở được trang bộ (%s). Kiểm tra mạng/link."
                                              % str(e)[:80]}, ensure_ascii=False))
        return 1
    if not taps:
        print(json.dumps({"ok": False, "msg":
            "Không thấy tập nào ở trang này — link có đúng là 1 BỘ trên hongguoduanju.com không? "
            "(dạng /player/<mã bộ>)"}, ensure_ascii=False))
        return 1
    # 🔴 NÓI RA cái trần 3 tập. Im lặng ở đây là để khách tự đoán tool hỏng.
    _thieu = ""
    if tong and len(taps) < tong:
        _thieu = (" ⚠ Trang web chỉ cho xem %d/%d tập (bản web của 红果 giới hạn vậy, KHÔNG phải "
                  "tool tải thiếu) — muốn trọn bộ phải xem trong app 红果." % (len(taps), tong))

    if a.list:
        items = [{"id": "%s/%s" % (sid, v),
                  "title": "%s — Tập %d" % (ten or sid, t),
                  "thumb": bia, "url": "%s/player/%s/%s" % (GOC_DJ, sid, v),
                  "loai": "video", "video": True,
                  "so_anh": 0, "like": "", "nick": ten or ""}
                 for t, v in taps]
        log("📺 Honggo '%s': %d tập xem được.%s" % (ten or sid, len(items), _thieu))
        print(json.dumps({"ok": True, "items": items, "tong": len(items)}, ensure_ascii=False))
        return 0

    chon = list(taps)
    if a.mot_tap and not a.tap.strip():
        if not vid:
            print(json.dumps({"ok": False, "msg":
                "Link này là link BỘ (/player/<mã bộ>), không chỉ ra tập nào. Muốn tải 1 tập: bấm "
                "vào tập đó rồi copy link (có thêm mã tập ở cuối). Muốn cả bộ: chọn 'Theo bộ'."},
                ensure_ascii=False))
            return 1
        chon = [x for x in taps if x[1] == vid]
        if not chon:
            print(json.dumps({"ok": False, "msg":
                "Tập trong link không nằm trong %d tập xem được của bộ này.%s" % (len(taps), _thieu)},
                ensure_ascii=False))
            return 1
    if a.tap.strip():
        m = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*", a.tap)
        if not m:
            print(json.dumps({"ok": False, "msg": "--tap phải dạng '5' hoặc '3-7'."}, ensure_ascii=False))
            return 1
        lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
        chon = [x for x in chon if lo <= x[0] <= hi]
    try:
        n = int(a.count or 0)
    except ValueError:
        n = 0
    if n > 0:
        chon = chon[:n]
    if not chon:
        print(json.dumps({"ok": False, "msg": "Khoảng tập không khớp tập nào (xem được %d tập).%s"
                                              % (len(taps), _thieu)}, ensure_ascii=False))
        return 1

    ra = _thu_muc_ra('%s [%s]' % (ten or sid, sid))
    log("📥 Honggo '%s': tải %d/%d tập → %s%s" % (ten or sid, len(chon), len(taps), ra, _thieu))
    xong, bo_qua, loi = 0, 0, []
    for tp, v in chon:
        episode_id = '%s-%s' % (sid, v)
        dich = os.path.join(ra, "%s - Tap %02d [%s].mp4" % (_ten_an_toan(ten or sid, 60), tp, episode_id))
        _record_episode(episode_id, '%s - Tap %02d' % (ten or sid, tp), '%s/player/%s/%s' % (GOC_DJ, sid, v), ten or sid)
        if os.path.isfile(dich) and os.path.getsize(dich) > 100_000:
            bo_qua += 1
            log("⏭ Tập %d đã có, bỏ qua." % tp)
            continue
        try:
            u = mp4_cua_tap_dj(sid, v)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            loi.append("tập %d: %s" % (tp, str(e)[:60]))
            log("⚠ Tập %d: không mở được trang xem." % tp)
            continue
        if not u:
            loi.append("tập %d: không thấy mp4" % tp)
            log("⚠ Tập %d: trang xem KHÔNG có link mp4 (trang có thể đã đổi cách phát)." % tp)
            continue
        log("▶ Tập %d/%d — đang tải…" % (tp, len(taps)))
        ok, err = tai_mp4(u, dich)
        if ok:
            xong += 1
            log("📥 đã tải %d/%d — %s" % (xong, len(chon), os.path.basename(dich)))
        else:
            loi.append("tập %d: %s" % (tp, err or "tải hỏng"))
            log("⚠ Tập %d tải hỏng: %s" % (tp, (err or "tải hỏng")[:120]))

    kq = {"ok": xong > 0 or bo_qua > 0, "tai": xong, "bo_qua": bo_qua, "tong": len(chon),
          "thu_muc": ra, "ten": ten or sid}
    if loi:
        kq["loi"] = loi[:10]
    if kq["ok"] and _thieu:
        kq["msg"] = _thieu.strip()
    if not kq["ok"]:
        kq["msg"] = "Không tải được tập nào. " + ("Lỗi đầu: " + loi[0] if loi else "") + _thieu
    print(json.dumps(kq, ensure_ascii=False))
    return 0 if kq["ok"] else 1


def _record_episode(episode_id, title, url, series):
    directory = os.path.join(_data_dir(), THU_MUC_NEN, 'jsonl')
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, 'chase_contents.jsonl'), 'a', encoding='utf-8') as fh:
        fh.write(json.dumps({'video_id': episode_id, 'title': title, 'video_url': url,
            'source_mode': 'chase', 'source_input': series, 'last_modify_ts': int(time.time())}, ensure_ascii=False) + '\n')


def _thu_muc_ra(ten_bo):
    d = os.path.join(_data_dir(), THU_MUC_NEN, "videos", 'bo', _ten_an_toan(ten_bo, 100) or "link")
    os.makedirs(d, exist_ok=True)
    return d


def tai_tap(m3u8, dich, ffmpeg):
    """m3u8 → mp4 bằng ffmpeg (`-c copy`, KHÔNG encode lại — segment vốn đã là H.264/AAC).

    `-referer`/`-user_agent` BẮT BUỘC: thiếu là CDN trả 403 (đã dò: segment chỉ tải được khi có Referer).
    """
    tmp = dich + ".part"
    # `-f mp4` BẮT BUỘC: file tạm có đuôi `.part` nên ffmpeg KHÔNG đoán được container và bỏ ngay
    # ("Unable to choose an output format") — không phải lỗi mạng/CDN, dễ đổ oan.
    # `-movflags +faststart` để video xem/seek được ngay (pipeline render sau đó cũng seek nhiều).
    lenh = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-user_agent", UA, "-referer", GOC + "/",
            "-i", m3u8, "-c", "copy", "-bsf:a", "aac_adtstoasc",
            "-movflags", "+faststart", "-f", "mp4", tmp]
    kq = subprocess.run(lenh, capture_output=True, text=True, encoding="utf-8",
                        errors="replace", creationflags=_NO_WINDOW, timeout=1800)
    if kq.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 100_000:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False, (kq.stderr or "").strip()[:200]
    os.replace(tmp, dich)
    return True, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="link /voddetail/<id> hoặc /vodplay/<id>-<n>-<tập>, hoặc ID trần")
    ap.add_argument("--list", action="store_true", help="CHỈ liệt kê tập (xem trước), KHÔNG tải")
    ap.add_argument("--count", default="0", help="số tập tải (0 = hết)")
    ap.add_argument("--tap", default="", help="khoảng tập, vd 3-7 hoặc 5")
    ap.add_argument("--mot-tap", dest="mot_tap", action="store_true",
                    help="CHỈ tải đúng tập có trong link (/vodplay/<id>-<n>-<tập>) — dùng cho chế độ 'Theo link'")
    ap.add_argument("--delay", default="1.5", help="nghỉ giữa các request (giây) — chống 502/403")
    a = ap.parse_args()

    # ═══ RẼ THEO TRANG — đặt TRƯỚC `tach_id` ═══════════════════════════════════════════
    # `tach_id` viết cho hongguoapp.cn (ID vài chữ số). Link chính chủ có ID 19 chữ số và
    # đường dẫn `/player/…` ⇒ để nó chạy trước sẽ trả "" rồi rơi vào nhánh báo lỗi, dù nay
    # trang đó ĐÃ tải được.
    if _la_duanju(a.input):
        return _main_dj(a)

    vid = tach_id(a.input)
    if not vid:
        # 🔴 03/09/2026 — NÓI ĐÚNG BỆNH. Câu cũ ("cần link /voddetail/<id> hoặc số ID") đúng về
        #    hình thức nhưng KHÔNG nói ra nguyên nhân thật hay gặp nhất: khách dán link của một
        #    TRANG KHÁC. Ca thật của chủ dự án: `hongguoduanju.com/detail?series_id=767780149292…`
        #    — cùng thương hiệu 红果 nhưng là nền khác hẳn (ID 17 chữ số kiểu Douyin, đường dẫn
        #    `/detail?series_id=`), trong khi file này bóc HTML của `hongguoapp.cn` dạng
        #    `/voddetail/<id>.html`. Bảo khách "đổi sang /voddetail/<id>" là bảo họ đi tìm thứ
        #    không tồn tại trên trang họ đang mở.
        _s = str(a.input or "").strip()
        _mien = ""
        _mm = re.search(r"https?://([^/]+)", _s)
        if _mm:
            _mien = _mm.group(1).lower().replace("www.", "")
        if _mien and "hongguoapp.cn" not in _mien:
            # 03/09 (lượt sau): `hongguoduanju.com` NAY ĐÃ CHẠY ĐƯỢC (xem `_main_dj`) nên
            # không rơi tới đây nữa. Câu này giờ dành cho các trang CÒN LẠI, và phải kể ra
            # ĐỦ HAI trang đang hỗ trợ — kể thiếu là đẩy khách đi tìm đường vòng vô ích.
            _msg = ("Link này thuộc %s — tool đọc được 2 trang: hongguoduanju.com "
                    "(chính chủ, dạng /player/<mã bộ>) và hongguoapp.cn (dạng "
                    "/voddetail/<id>.html). Mở bộ phim ở một trong hai trang đó rồi dán "
                    "link ở đấy." % _mien)
        elif re.fullmatch(r"\d{10,}", _s):
            # Số 19 chữ số = mã bộ của trang CHÍNH CHỦ. Dán số trần thì không biết nó thuộc
            # trang nào ⇒ chỉ luôn đường ghép lại thành link đầy đủ, đừng bắt khách tự đoán.
            _msg = ("ID “%s” dài %d chữ số — ID của hongguoapp.cn chỉ vài chữ số. Số dài kiểu "
                    "này là mã bộ của trang chính chủ: dán nguyên link "
                    "hongguoduanju.com/player/%s là chạy được." % (_s[:24], len(_s), _s[:24]))
        else:
            _msg = ("Không nhận ra ID bộ phim từ: %s — cần link dạng hongguoapp.cn/voddetail/<id> "
                    "hoặc số ID của trang đó." % _s[:60])
        print(json.dumps({"ok": False, "msg": _msg, "loi": "link_khong_hop"},
                         ensure_ascii=False)); return 1
    try:
        delay = max(0.0, float(a.delay))
    except ValueError:
        delay = 1.5

    try:
        ten, bia, taps = liet_ke_bo(vid, delay)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        print(json.dumps({"ok": False, "msg": "Không mở được trang bộ (%s). Kiểm tra mạng/link."
                                              % str(e)[:80]}, ensure_ascii=False)); return 1
    if not taps:
        print(json.dumps({"ok": False, "msg": "Không thấy tập nào ở trang này — link có đúng là 1 BỘ trên "
                                              "hongguoapp.cn không?"}, ensure_ascii=False)); return 1

    # --- LIỆT KÊ (xem trước) ---
    if a.list:
        # ⚠ `video`/`loai` BẮT BUỘC: lưới Xem trước lọc `it.video`, thiếu là item bị lọc SẠCH và khách
        #   thấy "không có video nào" dù backend trả đủ (đúng ca Instagram đã vá 02/09).
        items = [{"id": "%s-%d-%d" % (vid, ng, tp),
                  "title": "%s — Tập %d" % (ten or vid, tp),
                  "thumb": bia, "url": u, "loai": "video", "video": True,
                  "so_anh": 0, "like": "", "nick": ten or ""}
                 for ng, tp, u in taps]
        log("📺 Honggo '%s': %d tập." % (ten or vid, len(items)))
        print(json.dumps({"ok": True, "items": items, "tong": len(items)}, ensure_ascii=False))
        return 0

    # --- CHỌN TẬP ---
    chon = taps
    # 🔴 02/09/2026 — "Theo link" vs "Theo bộ" PHẢI KHÁC NHAU.
    #   Trước đó web_app dựng lệnh y hệt cho cả hai chế độ ⇒ hai nút ra cùng một thứ (cả bộ).
    #   Nay: "Theo link" = đúng TẬP nằm trong link. Link `/voddetail/<id>` không có số tập nên
    #   KHÔNG suy được — nói thẳng thay vì lặng lẽ tải cả bộ (đó chính là lỗi đang chữa).
    if a.mot_tap and not a.tap.strip():
        _m_tap = re.search(r"/vodplay/\d+-\d+-(\d+)", str(a.input or ""))
        if not _m_tap:
            print(json.dumps({"ok": False, "msg":
                "Link này là link BỘ (/voddetail/…), không chỉ ra tập nào. Muốn tải 1 tập: mở tập đó "
                "rồi copy link dạng /vodplay/<id>-1-<số tập>. Muốn tải cả bộ: chọn chế độ 'Theo bộ'."},
                ensure_ascii=False)); return 1
        _t = int(_m_tap.group(1))
        chon = [x for x in taps if x[1] == _t]
        if not chon:
            print(json.dumps({"ok": False, "msg": "Bộ này không có tập %d (chỉ có %d tập)."
                                                  % (_t, len(taps))}, ensure_ascii=False)); return 1
    if a.tap.strip():
        m = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*", a.tap)
        if not m:
            print(json.dumps({"ok": False, "msg": "--tap phải dạng '5' hoặc '3-7'."}, ensure_ascii=False)); return 1
        lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
        chon = [x for x in taps if lo <= x[1] <= hi]
    try:
        n = int(a.count or 0)
    except ValueError:
        n = 0
    if n > 0:
        chon = chon[:n]
    if not chon:
        print(json.dumps({"ok": False, "msg": "Khoảng tập không khớp tập nào (bộ có %d tập)." % len(taps)},
                         ensure_ascii=False)); return 1

    ff = _tim_ffmpeg()
    ra = _thu_muc_ra('%s [%s]' % (ten or vid, vid))
    log("📥 Honggo '%s': tải %d/%d tập → %s" % (ten or vid, len(chon), len(taps), ra))
    xong, bo_qua, loi = 0, 0, []
    for i, (ng, tp, u) in enumerate(chon, 1):
        episode_id = '%s-%d-%d' % (vid, ng, tp)
        dich = os.path.join(ra, "%s - Tap %02d [%s].mp4" % (_ten_an_toan(ten or vid, 60), tp, episode_id))
        _record_episode(episode_id, '%s - Tap %02d' % (ten or vid, tp), u, ten or vid)
        if os.path.isfile(dich) and os.path.getsize(dich) > 100_000:
            bo_qua += 1
            log("⏭ Tập %d đã có, bỏ qua." % tp)
            continue
        if i > 1 and delay:
            time.sleep(delay)
        try:
            m3 = m3u8_cua_tap(u)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            loi.append("tập %d: %s" % (tp, str(e)[:60])); log("⚠ Tập %d: không mở được trang xem." % tp); continue
        if not m3:
            loi.append("tập %d: không thấy m3u8" % tp)
            log("⚠ Tập %d: trang xem KHÔNG có m3u8 (nguồn phát có thể đã đổi)." % tp); continue
        log("▶ Tập %d/%d — đang tải…" % (tp, len(taps)))
        ok, err = tai_tap(m3, dich, ff)
        if ok:
            xong += 1
            log("📥 đã tải %d/%d — %s" % (xong, len(chon), os.path.basename(dich)))
        else:
            loi.append("tập %d: %s" % (tp, err or "ffmpeg lỗi"))
            log("⚠ Tập %d tải hỏng: %s" % (tp, (err or "ffmpeg lỗi")[:120]))

    kq = {"ok": xong > 0 or bo_qua > 0, "tai": xong, "bo_qua": bo_qua, "tong": len(chon),
          "thu_muc": ra, "ten": ten or vid}
    if loi:
        kq["loi"] = loi[:10]
    if not kq["ok"]:
        kq["msg"] = ("Không tải được tập nào. " +
                     ("Lỗi đầu: " + loi[0] if loi else "") +
                     " (CDN Honggo chặn IP trung tâm dữ liệu — phải chạy từ mạng nhà.)")
    print(json.dumps(kq, ensure_ascii=False))
    return 0 if kq["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
