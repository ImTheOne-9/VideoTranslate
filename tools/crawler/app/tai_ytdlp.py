# -*- coding: utf-8 -*-
"""
Tải video YouTube / TikTok / Twitter(X) / Reddit / Instagram bằng yt-dlp (cho học tập).
Chế độ: search (YouTube + Reddit), creator (theo kênh/user/subreddit), detail (theo link).

Dùng:
  python tai_ytdlp.py --platform yt --type search  --input "tu khoa" --count 10
  python tai_ytdlp.py --platform rd --type search  --input "tu khoa" --count 10 --sort top --time week
  python tai_ytdlp.py --platform rd --type creator --input "r/funny" --count 10 --sort controversial
  python tai_ytdlp.py --platform tw --type creator --input "@elonmusk" --count 10 --cookies-browser chrome
  python tai_ytdlp.py --platform ig --type detail  --input "https://www.instagram.com/reel/..." --cookies-browser chrome

In ra các dòng "LOG:..." để web_app đọc và hiển thị tiến trình.
Lưu vào: MediaCrawler/data/{youtube|tiktok|twitter|reddit|instagram}/videos/{tu-khoa/<kw>|kenh/<ten>|link}/
"""
import argparse
import glob
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

# TU TRO Chromium ve runtime/ms-playwright khi app spawn THIEU env PLAYWRIGHT_BROWSERS_PATH.
# Da gap THAT tren may khach: cai ngoai o C / relaunch sau update truyen env toi thieu -> Playwright dung
# default %LOCALAPPDATA%/ms-playwright -> "Executable does not exist chrome.exe" -> moi tinh nang dung trinh
# duyet HONG AM THAM (dich Gemini web, kiem tra login, cua so Luot, cao XHS...). mo_dang_nhap.py da co doan
# nay tu lau, cac file con lai thi KHONG -> cua so dang nhap mo duoc ma dich/cao van hong.
# Suy tu sys.executable (.../runtime/venv/Scripts/python.exe) nen KHONG phu thuoc env truyen vao.
# Chi set khi env dang RONG va thu muc CO THAT -> khong dung may dev / cau hinh khac.
if not (os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip():
    try:
        _venv_dir = os.path.dirname(os.path.dirname(os.path.abspath(sys.executable)))
        _runtime_dir = os.path.dirname(_venv_dir)
        for _name in ("ms-playwright-python", "ms-playwright"):
            _bp = os.path.join(_runtime_dir, _name)
            if os.path.isdir(_bp):
                os.environ["PLAYWRIGHT_BROWSERS_PATH"] = _bp
                break
    except Exception:
        pass


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

THU_MUC_GOC = os.path.dirname(os.path.abspath(__file__))
THU_MUC_CRAWLER = os.path.join(THU_MUC_GOC, "MediaCrawler")
# Profile đăng nhập nền tảng (tt/tw/ig...): userData qua MC_BROWSER_DATA_DIR (web_app/mo_dang_nhap GHI ở đây,
# BỀN qua update). Dev (không env) = chỗ cũ MediaCrawler/browser_data. Trước đây hardcode THU_MUC_CRAWLER/
# browser_data -> ĐỌC NHẦM thư mục (login ghi userData, đây đọc app-src) -> cào báo "chưa đăng nhập" OAN.
BROWSER_DATA_DIR = os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join(THU_MUC_CRAWLER, "browser_data")

NEN = {
    "yt": {"thu_muc": "youtube", "search_prefix": "ytsearch"},
    "tt": {"thu_muc": "tiktok"},
    "tw": {"thu_muc": "twitter"},
    "rd": {"thu_muc": "reddit"},
    "ig": {"thu_muc": "instagram"},
    "fb": {"thu_muc": "facebook"},
    "bilitv": {"thu_muc": "bilitv"},
}
# Nền tảng cần cookie đăng nhập (đọc từ trình duyệt) mới tải được hầu hết video
NEN_CAN_COOKIE = ("ig", "tw")
# Sort hợp lệ khi liệt kê 1 subreddit (search có thêm 'relevance'/'comments')
REDDIT_SUB_SORT = ("hot", "new", "top", "rising", "controversial")

# Thư mục TẠM (per-process) cho cookie phiên xuất ra cho yt-dlp. Tạo lười, dọn khi thoát.
# Process này chạy 1-shot (subprocess), nên dọn ở finally/atexit là chắc chắn cho MỌI đường (kể cả crash).
_CK_TMP_DIR = None


def _ck_temp_dir():
    """Trả thư mục tạm dùng chung trong tiến trình để chứa cookie phiên (tạo lười + đăng ký dọn atexit)."""
    global _CK_TMP_DIR
    if _CK_TMP_DIR is None:
        _CK_TMP_DIR = tempfile.mkdtemp(prefix="ytck_")
        import atexit
        atexit.register(_don_cookie_temp)
    return _CK_TMP_DIR


def _don_cookie_temp():
    """Xóa thư mục cookie tạm (cookie phiên không tồn đọng plaintext trên đĩa). Best-effort."""
    global _CK_TMP_DIR
    if _CK_TMP_DIR:
        shutil.rmtree(_CK_TMP_DIR, ignore_errors=True)
        _CK_TMP_DIR = None


def log(msg):
    print("LOG:" + msg, flush=True)


_NODE_MIN_VER = (22, 0, 0)   # yt-dlp yt_dlp/utils/_jsruntime.py: NodeJsRuntime.MIN_SUPPORTED_VERSION


def _node_ver_du(path):
    """True nếu node tại `path` chạy được VÀ version >= _NODE_MIN_VER (yt-dlp coi 'supported')."""
    try:
        r = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", (r.stdout or "").strip())
        return bool(m) and tuple(int(x) for x in m.groups()) >= _NODE_MIN_VER
    except Exception:
        return False


def _tim_node():
    """Tìm node.exe ĐỦ VERSION (>= 22.0.0, yt-dlp coi dưới ngưỡng này là 'not supported' dù path đúng —
    đo thật: bundle desktop/vendor/node là v20.18.0, dưới ngưỡng, khiến yt-dlp vẫn báo warning "No
    supported JavaScript runtime" dù đã trỏ đúng path). Ưu tiên BUNDLE (vendor/node) nếu ĐỦ version,
    KHÔNG thì thử PATH hệ thống (máy khách có thể tự cài Node mới hơn bundle) — không mù quáng chọn
    bundle nếu nó cũ hơn PATH."""
    here = os.path.dirname(os.path.abspath(__file__))
    ung_vien = []
    for b in (os.path.join(here, "..", "vendor", "node"),        # app đóng gói (file ở app-src)
              os.path.join(here, "desktop", "vendor", "node")):  # dev (repo)
        c = os.path.join(b, "node.exe")
        if os.path.isfile(c):
            ung_vien.append(os.path.abspath(c))
    _pw = shutil.which("node")
    if _pw:
        ung_vien.append(_pw)
    for c in ung_vien:
        if _node_ver_du(c):
            return c
    return None   # có ứng viên nhưng KHÔNG đủ version -> None (đừng đưa path cũ, yt-dlp vẫn báo warning y hệt)


def an_toan(ten):
    """Làm sạch tên thư mục (bỏ ký tự cấm trên Windows)."""
    ten = re.sub(r'[<>:"/\\|?*\n\r\t]+', " ", ten or "").strip()
    ten = re.sub(r"\s+", " ", ten)
    return (ten[:60] or "khac").rstrip(". ")


def tach_dong(s):
    return [x.strip() for x in re.split(r"[\n,]+", s or "") if x.strip()]


def chuan_hoa_user(platform, s):
    """@handle hoặc link -> URL trang user (Twitter/Instagram)."""
    s = (s or "").strip()
    if s.lower().startswith("http"):
        if platform == "ig":
            try:
                parsed = urllib.parse.urlparse(s)
                host = (parsed.hostname or "").lower()
                parts = [urllib.parse.unquote(x) for x in parsed.path.split("/") if x]
                reserved = {"accounts", "direct", "explore", "p", "reel", "reels", "stories", "tv"}
                # URL tab /<user>/reels/ phải trở về URL profile mà yt-dlp nhận diện.
                if (host == "instagram.com" or host.endswith(".instagram.com")) and parts and parts[0].lower() not in reserved:
                    return "https://www.instagram.com/%s/" % parts[0]
            except Exception:
                pass
        return s
    h = s.lstrip("@/").strip()
    if platform == "tw":
        return f"https://x.com/{h}"
    if platform == "ig":
        return f"https://www.instagram.com/{h}/"
    return s


# Các tab hợp lệ của trang kênh YouTube (URL kết thúc bằng tab nào thì giữ nguyên)
_YT_TABS = ("videos", "shorts", "streams", "live", "featured", "playlists", "community", "posts")


def chuan_hoa_kenh_youtube(s):
    """Kênh YouTube -> URL tab '/videos'.
    URL kênh trần (youtube.com/@abc) resolve ra danh sách TAB (Videos/Live/Shorts),
    khiến playlistend giới hạn theo TAB chứ không theo VIDEO -> tải loạn cả kênh.
    Thêm '/videos' để liệt kê thẳng video. Giữ nguyên link 1 video hoặc tab đã chỉ định."""
    s = (s or "").strip()
    if not s:
        return s
    low = s.lower()
    # Link 1 video / 1 short cụ thể -> để nguyên
    if "watch?v=" in low or "youtu.be/" in low or re.search(r"/shorts/[\w-]+", low):
        return s
    # Handle trần: "@abc" hoặc "abc" (không phải URL)
    if not low.startswith("http") and "/" not in s:
        h = s if s.startswith("@") else "@" + s
        return f"https://www.youtube.com/{h}/videos"
    if not low.startswith("http"):
        s = "https://" + s
    base_url = s.split("?")[0].split("#")[0].rstrip("/")
    if base_url.rsplit("/", 1)[-1].lower() in _YT_TABS:
        return base_url                      # đã trỏ tab cụ thể
    return base_url + "/videos"


def _tai_tiktok_browser(nhiem_vu, log_fn=None):
    """FALLBACK khi yt-dlp KHÔNG lấy được VIDEO (chỉ ra audio-only / 'Requested format not available').
    LÝ DO (đo thật): TikTok trả cho yt-dlp một play_addr BỊ SUY GIẢM chỉ còn audio (host tiktokcdn.com),
    còn bản VIDEO đầy đủ (host v16/v19-webapp-prime.tiktok.com/video/tos/) chỉ lộ cho BROWSER THẬT. Mở
    trang bằng Playwright → ép <video> play → bắt URL /video/tos/ từ network → tải qua ctx.request (referer).
    DÙNG PROFILE SẠCH (không cookie login): cookie login TikTok làm trang KHÔNG render <video> (đã verify).
    nhiem_vu = list[(url_bai, out_path)]. Trả list id tải THÀNH CÔNG. Best-effort — lỗi 1 video không phá cả lô."""
    _log = log_fn or log
    if not nhiem_vu:
        return []
    import tempfile
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ok_ids = []
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        _log(f"⚠ Không dùng được trình duyệt để tải TikTok (thiếu Playwright): {str(e)[:80]}")
        return []
    # SONG SONG N THREAD, MỖI THREAD 1 sync_playwright()+context RIÊNG (KHÔNG chia sẻ 1 context qua nhiều
    # thread — đã thử và FAIL: Playwright sync API ràng buộc greenlet/event-loop với ĐÚNG thread đã gọi
    # sync_playwright(), gọi ctx.new_page()/ctx.request từ thread khác → 'cannot switch to a different
    # thread' + context bị đóng sớm giữa chừng, xem tienlog thật khi test). Mỗi thread tự có browser +
    # profile TEMP riêng (không chung profile/IP-session nhưng vẫn cùng máy/IP mạng, TikTok khó phân biệt
    # người dùng thật mở nhiều tab). TIKTOK_BROWSER_CONCUR (mặc định 4) giảm ~1/4 thời gian so với tuần tự
    # (tuần tự ~12s dò/video → 100 video ~20 phút). Lock quanh _log/ok_ids (không thread-safe khi ghi đồng thời).
    import threading as _th
    from concurrent.futures import ThreadPoolExecutor as _TPE
    try:
        _concur = max(1, int(os.environ.get("TIKTOK_BROWSER_CONCUR", "4") or 4))
    except ValueError:
        _concur = 4
    _lock = _th.Lock()

    def _tai_1(url_bai, out_path):
        m = re.search(r"/video/(\d+)", url_bai)
        vid = m.group(1) if m else ""
        _tmp1 = tempfile.mkdtemp(prefix="tt_dl_")   # profile SẠCH RIÊNG cho thread này (không cookie → trang render video)
        try:
            with sync_playwright() as pw:
                ctx = pw.chromium.launch_persistent_context(
                    _tmp1, headless=True, user_agent=ua,
                    args=["--disable-blink-features=AutomationControlled", "--mute-audio"])
                try:
                    cdn = []
                    pg = ctx.new_page()
                    pg.on("response", lambda r: cdn.append(r.url)
                          if ("/video/tos/" in r.url and ".m3u8" not in r.url) else None)
                    try:
                        pg.goto(url_bai, wait_until="load", timeout=45000)
                        got = False
                        # BUG khách (đo THẬT — verify bằng script cô lập, gọi thẳng trang TikTok thật, KHÔNG
                        # đoán): cdn[] thường bắt được NHIỀU URL /video/tos/ cho CÙNG 1 bài (đã quan sát 7 URL
                        # cho 1 video, gồm 2 file-hash khác nhau = các BITRATE/watermark-variant khác nhau của
                        # cùng nội dung, do TikTok trả sẵn qua nhiều CDN edge/độ phân giải). Code CŨ tải "URL
                        # ĐẦU TIÊN đạt >100KB" — nếu URL đầu là bản THẤP/preview nhỏ mà >100KB (đủ ngưỡng nhưng
                        # không phải bản đầy đủ), hoặc hiếm khi thật sự lẫn nội dung do carousel bên cạnh, sẽ
                        # LƯU NHẦM bản không mong muốn dưới tên file đúng ID ("3/11 video tải về sai với link
                        # nhập" — khách báo). Đã thử hướng currentSrc (đọc URL <video> đang phát) NHƯNG verify
                        # thật: TikTok headless video không tự play (paused/NaN suốt), currentSrc trả về
                        # endpoint proxy 'aweme/v1/play/...' KHÔNG khớp bất kỳ URL /video/tos/ nào → không dùng
                        # được. FIX THỰC DỤNG: tải TOÀN BỘ URL trong cdn[] mỗi vòng, giữ bản DUNG LƯỢNG LỚN
                        # NHẤT (>100KB) — bản lớn nhất gần như luôn là bản chất lượng cao nhất/đầy đủ nhất của
                        # ĐÚNG bài đang mở (không có cơ chế nào của TikTok trả video KHÁC nặng hơn bản đang xem
                        # trên cùng 1 trang); giảm rủi ro dính bản preview/thumbnail nhỏ so với "URL đầu tiên".
                        best_body, best_size = None, 0
                        for _ in range(6):
                            pg.wait_for_timeout(2000)
                            try:
                                pg.evaluate("()=>{const v=document.querySelector('video');"
                                            "if(v){v.muted=true;v.play().catch(()=>{});}}")
                            except Exception:
                                pass
                            for u in list(dict.fromkeys(cdn)):
                                try:
                                    resp = ctx.request.get(u, headers={"referer": "https://www.tiktok.com/"}, timeout=60000)
                                    if resp.ok:
                                        body = resp.body()
                                        if len(body) > 100000 and len(body) > best_size:   # >100KB = video thật (audio-only chỉ vài chục KB)
                                            best_body, best_size = body, len(body)
                                except Exception:
                                    continue
                            # ĐÃ có ứng viên đủ lớn (>1MB) và KHÔNG có URL mới xuất hiện thêm 1 vòng → coi như
                            # đủ (chờ thêm chỉ tốn thời gian, TikTok hiếm khi trả bản lớn hơn nhiều sau đó).
                            if best_size > 1_000_000:
                                break
                        if best_body is not None:
                            os.makedirs(os.path.dirname(out_path), exist_ok=True)
                            with open(out_path, "wb") as f:
                                f.write(best_body)
                            with _lock:
                                _log(f"✔ Tải qua trình duyệt (yt-dlp không lấy được video): {vid} ({best_size//1024}KB, bản lớn nhất/{len(set(cdn))} URL)")
                                ok_ids.append(vid)
                            got = True
                        if not got:
                            with _lock:
                                _log(f"  · {vid}: mở trang được nhưng KHÔNG bắt được video (TikTok chặn / video riêng tư).")
                    except Exception as e:
                        with _lock:
                            _log(f"  · {vid}: lỗi mở trang — {str(e)[:70]}")
                    finally:
                        try:
                            pg.close()
                        except Exception:
                            pass
                finally:
                    try:
                        ctx.close()
                    except Exception:
                        pass
        except Exception as e:
            with _lock:
                _log(f"  · {vid}: lỗi trình duyệt — {str(e)[:70]}")
        finally:
            try:
                import shutil as _sh
                _sh.rmtree(_tmp1, ignore_errors=True)
            except Exception:
                pass

    try:
        with _TPE(max_workers=_concur) as ex:
            list(ex.map(lambda t: _tai_1(t[0], t[1]), nhiem_vu))
    except Exception as e:
        _log(f"⚠ Lỗi trình duyệt khi tải TikTok: {str(e)[:100]}")
    return ok_ids


def chuan_hoa_kenh_tiktok(s):
    """@user / link profile TikTok -> URL kênh chuẩn 'https://www.tiktok.com/@<user>'. '' nếu không rõ.
    yt-dlp 2026+ xử lý THẲNG URL @username; dạng 'tiktokuser:<secUid>' kiểu CŨ đã bị yt-dlp từ chối
    ('Unable to extract secondary user ID') → 0 video. Nên dùng URL @username (đã verify liệt kê được)."""
    s = (s or "").strip()
    if s.lower().startswith("tiktokuser:"):
        return s   # user tự nhập channel_id mới của yt-dlp → giữ nguyên
    m = re.search(r"tiktok\.com/@([\w.\-]+)", s, re.I)
    handle = (m.group(1) if m else s).lstrip("@").strip()
    if not handle:
        log("✗ KHÔNG rõ kênh TikTok — dán @tên-kênh hoặc link kênh (vd https://www.tiktok.com/@tiktok).")
        return ""
    log(f"✔ Kênh TikTok: @{handle}")
    return "https://www.tiktok.com/@" + handle


class _TikTokChannelLogger:
    """Giữ lại ID video yt-dlp đã phát hiện trước khi extractor kênh lỗi ở bước secUid."""
    def __init__(self, handle="", log_fn=None):
        self.handle = (handle or "").lstrip("@")
        self.ids = []
        self._seen = set()
        self.records = []
        self._log = log_fn or log

    def set_url(self, url):
        match = re.search(r"tiktok\.com/@([\w.\-]+)", str(url or ""), re.I)
        if match:
            self.handle = match.group(1)

    def debug(self, msg):
        text = str(msg or "")
        for vid in re.findall(r"\[tiktok:user\]\s+(\d+):\s+Downloading webpage", text, re.I):
            if vid not in self._seen:
                self._seen.add(vid); self.ids.append(vid); self.records.append((self.handle, vid))

    def warning(self, msg):
        text = str(msg or "")
        if self.handle and "unexpected response from webpage request" in text.lower():
            return
        if text and "secondary user id" not in text.lower():
            self._log("⚠ yt-dlp TikTok: " + text[:180])

    def error(self, msg):
        text = str(msg or "")
        if "secondary user id" in text.lower():
            self._log("ℹ yt-dlp mất secUid của kênh; đang giữ lại các ID video đã phát hiện.")
        elif self.handle and "unexpected response from webpage request" in text.lower():
            return  # lỗi từng item của kênh; ID đã được giữ, không spam một dòng/video
        elif text:
            self._log("⚠ yt-dlp TikTok: " + text[:180])

    def items(self, limit):
        return [{"id": vid, "title": "Video %s" % vid, "thumb": "", "loai": "video",
                 "video": True, "so_anh": 0,
                 "url": "https://www.tiktok.com/@%s/video/%s" % (handle, vid),
                 "like": "", "nick": handle, "duration": 0}
                for handle, vid in self.records[:max(0, int(limit or 0))] if handle]


def chuan_hoa_link_tiktok(url):
    """Link 1 bài TikTok -> (url_chuan, la_photo).
    TikTok có 2 dạng bài: /video/<id> (video) và /photo/<id> (bài ẢNH slideshow).
    Extractor yt-dlp CHỈ khớp regex /video/<id> -> link /photo/ bị 'Unsupported URL'
    và bị ignoreerrors nuốt -> 'tải 0 video' không rõ lý do.
    Bài /photo/ và /video/ DÙNG CHUNG item id, nên rewrite /photo/->/video/ để yt-dlp
    resolve được item (bài chỉ có ảnh sẽ không có format video -> caller tự xử lý/báo)."""
    u = (url or "").strip()
    if re.search(r"tiktok\.com/@[\w.\-]+/photo/\d+", u, re.I):
        return re.sub(r"/photo/(\d+)", r"/video/\1", u, flags=re.I), True
    return u, False


def _tiktok_search(query, count, log=print):
    """SEARCH TikTok qua Playwright (yt-dlp KHÔNG search TT được). Dùng profile đăng nhập sẵn
    (browser_data/tt_user_data_dir) để né tường login. Trả list item {id,title,thumb,url,...}.
    FRAGILE: phụ thuộc DOM/anti-bot TikTok + cần đã đăng nhập TikTok."""
    udd = os.path.join(BROWSER_DATA_DIR,"tt_user_data_dir")
    if not os.path.isdir(udd):
        udd = os.path.join(BROWSER_DATA_DIR,"_tt_tmp")
    url = "https://www.tiktok.com/search?q=" + urllib.parse.quote(query)
    anchors = []
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(udd, headless=True)
            try:
                pg = ctx.pages[0] if ctx.pages else ctx.new_page()
                pg.goto(url, wait_until="domcontentloaded", timeout=40000)
                pg.wait_for_timeout(3500)
                js = ("els=>els.map(a=>{const im=a.querySelector('img');"
                      "return {href:a.href, img:im?im.src:'', alt:im?im.alt:''};})")
                for _ in range(4):
                    try:
                        anchors = pg.eval_on_selector_all("a[href*='/video/']", js)
                    except Exception:
                        anchors = []
                    if len(anchors) >= count:
                        break
                    pg.mouse.wheel(0, 3000)
                    pg.wait_for_timeout(1500)
            finally:
                ctx.close()
    except Exception as e:
        log("⚠ Search TikTok lỗi (%s) — đã đăng nhập TikTok chưa?" % str(e)[:120])
        return []
    items, seen = [], set()
    for a in anchors:
        m = re.search(r"tiktok\.com/@([\w.\-]+)/video/(\d+)", a.get("href", ""))
        if not m:
            continue
        nick, vid = m.group(1), m.group(2)
        if vid in seen:
            continue
        seen.add(vid)
        items.append({"id": vid, "title": (a.get("alt") or "").strip()[:160], "thumb": a.get("img") or "",
                      "loai": "video", "video": True, "so_anh": 0,
                      "url": "https://www.tiktok.com/@%s/video/%s" % (nick, vid), "like": "", "nick": nick})
        if len(items) >= count:
            break
    return items


# ---------------- Facebook: cào theo LINK (yt-dlp extractor sẵn, không cần code riêng) +
# theo KÊNH/Page (yt-dlp KHÔNG liệt kê được Page -> Playwright cuộn thu link, mirror TikTok) ----------------
def chuan_hoa_kenh_facebook(s):
    """Link Page / tên Page / '@ten' -> URL gốc Page 'https://www.facebook.com/<page>' (không kèm tab
    con). '' nếu không nhận diện được (link 1 video, /watch, /reel, /groups... không phải Page)."""
    s = (s or "").strip()
    if not s:
        return ""
    if not s.lower().startswith("http"):
        s = "https://www.facebook.com/" + s.lstrip("@/")
    m = re.search(r"facebook\.com/profile\.php\?id=(\d+)", s, re.I)
    if m:
        return "https://www.facebook.com/profile.php?id=%s" % m.group(1)
    m = re.search(r"facebook\.com/([^/?#]+)", s, re.I)
    if not m:
        return ""
    page = m.group(1)
    if page.lower() in ("watch", "share", "reel", "groups", "login", "help", "photo.php", "permalink.php"):
        return ""   # link 1 video/bài, không phải Page
    return "https://www.facebook.com/" + page


def _fb_scroll_links(pg, want, log=print):
    """Cuộn trang Facebook (tab /videos hoặc /reels đang mở), thu link video/reel DUY NHẤT tới khi đủ
    `want` hoặc 3 lần cuộn liên tiếp KHÔNG ra thêm (hết nội dung / anti-bot chặn). Trả list item
    {id,title,thumb,url,...} (định dạng như _item_yt/_item_tt để dùng chung downstream)."""
    items, seen = [], set()
    js_get = ("els=>els.map(a=>{const im=a.querySelector('img');"
              "const root=a.closest('[role=article]')||a.parentElement?.parentElement||a;"
              "const text=(root.innerText||a.innerText||'').trim();"
              "const aria=(a.getAttribute('aria-label')||a.getAttribute('title')||'').trim();"
              "const dm=text.match(/(?:^|\\s)(?:\\d{1,2}:)?\\d{1,2}:\\d{2}(?=\\s|$)/);"
              "return {href:a.href,img:im?im.src:'',alt:im?(im.alt||''):'',aria:aria,text:text,duration:dm?dm[0].trim():''};})")
    khong_moi = 0
    for _ in range(20):
        try:
            anchors = pg.eval_on_selector_all(
                "a[href*='/videos/'],a[href*='/reel/'],a[href*='/reels/'],"
                "a[href*='watch/?v='],a[href*='reel.php'],a[href*='video_id='],a[href*='/share/r/']", js_get)
        except Exception:
            anchors = []
        moi = 0
        for a in anchors:
            href = a.get("href", "")
            m = re.search(r"facebook\.com/(?:watch/\?v=(\d+)|[^/]+/videos/(\d+)|reels?/(\d+))", href)
            vid = (m.group(1) or m.group(2) or m.group(3)) if m else ""
            if not vid:
                qid = re.search(r"[?&](?:video_id|reel_id|v)=(\d+)", href)
                vid = qid.group(1) if qid else ""
            if not vid:
                shared = re.search(r"facebook\.com/share/r/([^/?#]+)", href)
                vid = ("share_" + shared.group(1)) if shared else ""
            if not vid:
                continue
            if vid in seen:
                continue
            seen.add(vid); moi += 1
            raw_title = (a.get("alt") or a.get("aria") or "").strip()
            if not raw_title:
                for line in (a.get("text") or "").splitlines():
                    line = line.strip()
                    if 3 <= len(line) <= 160 and not re.fullmatch(r"(?:\d{1,2}:)?\d{1,2}:\d{2}", line):
                        raw_title = line
                        break
            duration = 0
            duration_text = (a.get("duration") or "").strip()
            if duration_text:
                try:
                    parts = [int(x) for x in duration_text.split(":")]
                    duration = sum(value * (60 ** index) for index, value in enumerate(reversed(parts)))
                except (TypeError, ValueError):
                    duration = 0
            items.append({"id": vid, "title": raw_title[:160],
                          "thumb": a.get("img") or "", "loai": "video", "video": True, "so_anh": 0,
                          "url": href.split("&")[0] if "watch/?v=" not in href else href.split("&")[0],
                          "like": "", "nick": "", "duration": duration})
            if len(items) >= want:
                break
        if len(items) >= want:
            break
        khong_moi = khong_moi + 1 if moi == 0 else 0
        if khong_moi >= 5:
            break
        pg.mouse.wheel(0, 4500)
        pg.wait_for_timeout(2200)
    return items


def _fb_co_tuong_dang_nhap(pg):
    """Facebook chặn xem ẩn danh sau ~1 bài bằng dialog 'Xem thêm trên Facebook / Đăng nhập' (đã verify
    THẬT: trang login-wall có document.body cố định = viewport, KHÔNG cuộn thêm được dù gọi scrollTo/wheel).
    Dò dialog này để phân biệt '1 video vì Page thật chỉ có 1' (hiếm) với 'bị chặn login' (log hint đúng lúc)."""
    try:
        return bool(pg.evaluate(
            """() => Array.from(document.querySelectorAll('div[role="dialog"]')).some(
                d => /đăng nhập|log in|log into facebook|tạo tài khoản mới|create new account/i.test(d.innerText||''))"""))
    except Exception:
        return False


def _fb_liet_ke_kenh(page_input, count, log=print):
    """Liệt kê video 1 Page Facebook (metadata-only, KHÔNG tải) cho cả 'Xem trước & chọn' lẫn tải-theo-kênh.
    yt-dlp không liệt kê được Page FB -> Playwright mở '/videos' rồi '/reels' (nếu chưa đủ), cuộn thu link
    (mirror TikTok). Dùng profile đăng nhập fb NẾU CÓ (browser_data/fb_user_data_dir).
    ĐÃ VERIFY THẬT: Page công khai xem ẨN DANH bị Facebook CHẶN CỨNG sau ~1 video (dialog "Xem thêm trên
    Facebook — Đăng nhập", trang không cuộn thêm được) — KHÁC YouTube/TikTok (không chặn). UI (index.html
    _boQuaLogin) ÉP đăng nhập trước khi gọi hàm này qua "Theo kênh" (mode=creator) — "Theo link" thì
    không cần. Hàm này (gọi trực tiếp qua CLI/Task Queue, bỏ qua UI) vẫn KHÔNG tự chặn cứng — tự chạy hết
    khả năng rồi log HINT khi phát hiện đúng tường chặn (tránh chặn oan Page thật sự chỉ có 1 video, và
    vẫn hữu ích nếu đã đăng nhập ở máy chạy Task Queue). FRAGILE: phụ thuộc DOM Facebook. Retry context
    mới tối đa 3 lần nếu 0 kết quả."""
    base = chuan_hoa_kenh_facebook(page_input)
    if not base:
        log(f"⚠ Facebook: không nhận diện được Page từ '{str(page_input)[:60]}' (dán link Page, không phải link 1 video).")
        return []
    udd = os.path.join(BROWSER_DATA_DIR, "fb_user_data_dir")
    stealth = os.path.join(THU_MUC_CRAWLER, "libs", "stealth.min.js")
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    items, tuong_login = [], False
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            for attempt in range(3):
                try:
                    ctx = pw.chromium.launch_persistent_context(
                        udd, headless=True, user_agent=ua,
                        args=["--disable-blink-features=AutomationControlled"])
                except Exception as e:
                    log(f"⚠ Facebook lần {attempt + 1}/3 lỗi mở trình duyệt: {str(e)[:100]}")
                    continue
                try:
                    if os.path.isfile(stealth):
                        ctx.add_init_script(path=stealth)
                    pg = ctx.new_page()
                    # Page dạng TÊN (facebook.com/ten) -> tab nối bằng PATH ('/videos'). Page dạng
                    # profile.php?id=SỐ (không có tên, ĐÃ VERIFY THẬT) -> '/videos' bị nối SAU query-string
                    # ('profile.php?id=X/videos') = URL VỠ, Facebook redirect NHẦM sang trang cá nhân của
                    # TÀI KHOẢN ĐANG ĐĂNG NHẬP (không phải Page mục tiêu) -> luôn ra 0 video (đúng bug khách
                    # báo). profile.php phải nối tab qua query 'sk=' (vd '&sk=videos').
                    _fb_id = "profile.php?id=" in base
                    if _fb_id:
                        # Page ID số dùng tab Reels mới `sk=reels_tab`. Một số Page cũ vẫn phản hồi
                        # `sk=videos`/`sk=reels`, nên thử đủ nhưng ưu tiên đúng tab người dùng đã dán.
                        requested = re.search(r"[?&]sk=(reels_tab|reels|videos)(?:&|$)", page_input or "", re.I)
                        tab_candidates = [requested.group(1).lower()] if requested else []
                        tab_candidates.extend(["reels_tab", "videos", "reels"])
                    else:
                        requested_reels = bool(re.search(r"/reels?/?(?:[?#]|$)", page_input or "", re.I))
                        tab_candidates = ["reels", "videos"] if requested_reels else ["videos", "reels"]
                    tabs = list(dict.fromkeys(tab_candidates))
                    for tab in tabs:
                        if len(items) >= count:
                            break
                        try:
                            url_tab = f"{base}&sk={tab}" if _fb_id else f"{base}/{tab}"
                            log(f"  · Facebook: đang quét tab {url_tab}")
                            pg.goto(url_tab, wait_until="domcontentloaded", timeout=40000)
                            pg.wait_for_timeout(2500)
                        except Exception:
                            continue
                        if _fb_co_tuong_dang_nhap(pg):
                            tuong_login = True
                        seen_id = {it["id"] for it in items}
                        for it in _fb_scroll_links(pg, count - len(items), log=log):
                            if it["id"] not in seen_id:
                                seen_id.add(it["id"]); items.append(it)
                finally:
                    ctx.close()
                if items:
                    break
                log(f"  · Facebook lần {attempt + 1}/3: chưa lấy được video (anti-bot/Page trống/riêng tư) — thử lại...")
    except Exception as e:
        log(f"⚠ Không mở được Facebook: {str(e)[:120]}")
        return []
    if tuong_login and len(items) < count:
        log(f"ℹ Facebook giới hạn xem ẨN DANH — chỉ lấy được {len(items)} video (dialog đăng nhập chặn xem thêm). "
            "Đăng nhập Facebook (mục Đăng nhập nền tảng) rồi cào lại để lấy đầy đủ danh sách kênh.")
    return items[:count]


def _fb_bo_sung_metadata(items, log=print):
    """Bổ sung title/duration/Page cho link Facebook mà DOM chỉ trả ID hoặc thumbnail."""
    can_lay = [item for item in items if item.get("url") and (
        not item.get("title") or not item.get("duration") or not item.get("nick"))]
    if not can_lay:
        return items
    cookiefile = xuat_cookie_tu_phien("fb")
    try:
        from yt_dlp import YoutubeDL
        from concurrent.futures import ThreadPoolExecutor, as_completed
        try:
            workers = max(1, min(4, int(os.environ.get("FB_METADATA_CONCUR", "3") or 3)))
        except ValueError:
            workers = 3
        log("ℹ Facebook: đang lấy tên, thời lượng và tên Page cho %d video…" % len(can_lay))

        def _lay_mot(item):
            opts = {"skip_download": True, "quiet": True, "no_warnings": True,
                    "ignoreerrors": True, "nocheckcertificate": True,
                    "socket_timeout": 20, "retries": 1, "noplaylist": True}
            if cookiefile and os.path.isfile(cookiefile):
                # YoutubeDL có thể ghi cookie ngược lại khi đóng. Nhiều thread dùng chung một file sẽ
                # tranh ghi và làm hỏng Netscape header; mỗi video dùng một bản sao tạm độc lập.
                safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(item.get("id") or "video"))[:80]
                thread_cookie = os.path.join(_ck_temp_dir(), "fb_%s_%s.txt" % (safe_id, id(item)))
                shutil.copyfile(cookiefile, thread_cookie)
                opts["cookiefile"] = thread_cookie
            try:
                with YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(item["url"], download=False) or {}
            except Exception:
                return item, False
            raw_title = (info.get("title") or info.get("description") or "").strip()
            title = raw_title.splitlines()[0][:160] if raw_title else ""
            thumbs = info.get("thumbnails") or []
            thumb = info.get("thumbnail") or (thumbs[-1].get("url") if thumbs else "")
            enriched = dict(item)
            if title:
                enriched["title"] = title
            if info.get("duration"):
                enriched["duration"] = float(info["duration"])
            enriched["nick"] = (info.get("uploader") or info.get("channel") or
                                  info.get("creator") or enriched.get("nick") or "")
            if thumb:
                enriched["thumb"] = thumb
            return enriched, bool(title or info.get("duration"))

        positions = {id(item): index for index, item in enumerate(items)}
        ok = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_lay_mot, item) for item in can_lay]
            for future in as_completed(futures):
                original, enriched = None, None
                try:
                    enriched, success = future.result()
                    if success:
                        ok += 1
                    for source in can_lay:
                        if source.get("id") == enriched.get("id"):
                            original = source
                            break
                    if original is not None:
                        items[positions[id(original)]] = enriched
                except Exception:
                    continue
        log("✓ Facebook: đã bổ sung metadata cho %d/%d video." % (ok, len(can_lay)))
        return items
    finally:
        _don_cookie_temp()


def _ig_mo_context(pw):
    """Mở Instagram bằng profile riêng nếu có; profile lỗi/đang bận thì dùng phiên ẩn danh."""
    udd = os.path.join(BROWSER_DATA_DIR, "ig_user_data_dir")
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    if os.path.isdir(udd):
        try:
            return pw.chromium.launch_persistent_context(
                udd, headless=True, user_agent=ua,
                args=["--disable-blink-features=AutomationControlled"]), None
        except Exception as e:
            log("⚠ Instagram: không mở được profile đăng nhập, thử phiên công khai: %s" % str(e)[:100])
    browser = pw.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
    return browser.new_context(user_agent=ua), browser


def _ig_liet_ke_kenh(profile_input, count, log=print):
    """Fallback khi Instagram user extractor lỗi: mở profile thật, cuộn và thu permalink Reel/post."""
    base = chuan_hoa_user("ig", profile_input)
    if not base or not re.match(r"https?://(?:www\.)?instagram\.com/[^/]+/?$", base, re.I):
        return []
    items, seen = [], set()
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx, browser = _ig_mo_context(pw)
            try:
                pg = ctx.new_page()
                pg.goto(base, wait_until="domcontentloaded", timeout=40000)
                pg.wait_for_timeout(3500)
                khong_moi = 0
                while len(items) < count and khong_moi < 5:
                    rows = pg.eval_on_selector_all("a", """els => els.map(a => {
                      const img = a.querySelector('img');
                      return {href:a.href || '', title:(img && img.alt) || a.innerText || '',
                              thumb:(img && (img.currentSrc || img.src)) || ''};
                    }).filter(x => /instagram\\.com\\/(reel|p)\\//i.test(x.href))""")
                    # Instagram ẩn danh có thể không render grid nhưng vẫn nhúng permalink
                    # trong JSON/HTML hydration. Tận dụng chúng thay vì trả danh sách rỗng.
                    html = pg.content()
                    for kind, shortcode in re.findall(r"/(reel|p)/([A-Za-z0-9_-]+)", html, re.I):
                        rows.append({"href": "https://www.instagram.com/%s/%s/" % (kind.lower(), shortcode),
                                     "title": "", "thumb": ""})
                    moi = 0
                    for row in rows:
                        href = (row.get("href") or "").split("?")[0]
                        match = re.search(r"instagram\.com/(?:reel|p)/([^/?#]+)", href, re.I)
                        vid = match.group(1) if match else ""
                        if not vid or vid in seen:
                            continue
                        seen.add(vid); moi += 1
                        items.append({"id": vid, "title": (row.get("title") or "").strip()[:160],
                                      "thumb": row.get("thumb") or "", "url": href,
                                      "like": "", "nick": base.rstrip("/").rsplit("/", 1)[-1],
                                      "duration": 0, "loai": "video", "video": True, "so_anh": 0})
                        if len(items) >= count:
                            break
                    khong_moi = khong_moi + 1 if moi == 0 else 0
                    if len(items) >= count:
                        break
                    pg.mouse.wheel(0, 4200)
                    pg.wait_for_timeout(1800)
            finally:
                ctx.close()
                if browser:
                    browser.close()
    except Exception as e:
        log("⚠ Instagram: fallback trình duyệt không lấy được danh sách: %s" % str(e)[:140])
    return items[:count]


def _ig_bo_sung_metadata(items, log=print):
    """Đọc duration/title còn thiếu từ thẻ video của trang Instagram thật."""
    missing = [item for item in items if item.get("url") and not item.get("duration")]
    if not missing:
        return items
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx, browser = _ig_mo_context(pw)
            try:
                pg = ctx.new_page()
                for item in missing:
                    try:
                        pg.goto(item["url"], wait_until="domcontentloaded", timeout=40000)
                        pg.wait_for_timeout(2500)
                        meta = pg.evaluate("""async () => {
                          const v = document.querySelector('video');
                          const get = p => document.querySelector(`meta[property="${p}"]`)?.content || '';
                          const result = {duration: v && Number.isFinite(v.duration) ? v.duration : 0,
                                          title:get('og:title'), description:get('og:description'),
                                          thumb:get('og:image')};
                          const src = get('og:video') || get('og:video:url') || get('og:video:secure_url');
                          if (!result.duration && src) {
                            result.duration = await new Promise(resolve => {
                              const probe = document.createElement('video');
                              const done = value => { probe.removeAttribute('src'); resolve(value || 0); };
                              probe.preload = 'metadata';
                              probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : 0);
                              probe.onerror = () => done(0);
                              probe.src = src;
                              setTimeout(() => done(0), 7000);
                            });
                          }
                          return result;
                        }""") or {}
                        if meta.get("duration"):
                            item["duration"] = float(meta["duration"])
                        if not item.get("title"):
                            item["title"] = (meta.get("title") or meta.get("description") or "").strip()[:160]
                        if not item.get("thumb") and meta.get("thumb"):
                            item["thumb"] = meta["thumb"]
                    except Exception as e:
                        log("⚠ Instagram: chưa bổ sung được metadata %s: %s" % (item.get("id", ""), str(e)[:90]))
            finally:
                ctx.close()
                if browser:
                    browser.close()
    except Exception as e:
        log("⚠ Instagram: không mở được trình duyệt bổ sung metadata: %s" % str(e)[:120])
    return items


def _tiktok_liet_ke_kenh_browser(profile_url, count, log=print):
    """Fallback liệt kê kênh TikTok bằng DOM khi yt-dlp đã thấy video nhưng thất bại ở bước lấy secUid.

    TikTok vẫn render các liên kết /@user/video/<id> trên trang profile trong trường hợp API kênh của
    yt-dlp không lấy được ``secondary user ID``. Ta chỉ thu đúng link thuộc handle đang yêu cầu, cuộn
    đến khi đủ ``count`` hoặc 5 vòng liên tiếp không có video mới. Không tải media ở bước này.
    """
    canonical = chuan_hoa_kenh_tiktok(profile_url)
    match = re.search(r"tiktok\.com/@([\w.\-]+)", canonical or "", re.I)
    if not match:
        return []
    handle = match.group(1)
    udd = os.path.join(BROWSER_DATA_DIR, "tt_user_data_dir")
    if not os.path.isdir(udd):
        udd = os.path.join(BROWSER_DATA_DIR, "_tt_tmp")
    os.makedirs(udd, exist_ok=True)
    anchors = []
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                udd, headless=True,
                args=["--disable-blink-features=AutomationControlled", "--mute-audio"])
            try:
                pg = ctx.pages[0] if ctx.pages else ctx.new_page()
                pg.goto(canonical, wait_until="domcontentloaded", timeout=45000)
                pg.wait_for_timeout(3500)
                js = ("els=>els.map(a=>{const im=a.querySelector('img');"
                      "return {href:a.href,title:(a.innerText||'').trim(),"
                      "img:im?(im.currentSrc||im.src):'',alt:im?(im.alt||''):''};})")
                seen_count, no_new = 0, 0
                for _ in range(20):
                    try:
                        anchors = pg.eval_on_selector_all("a[href*='/video/']", js)
                    except Exception:
                        anchors = []
                    current = len({re.search(r"/video/(\d+)", a.get("href", "")).group(1)
                                   for a in anchors if re.search(r"/video/(\d+)", a.get("href", ""))})
                    if current >= count:
                        break
                    no_new = no_new + 1 if current <= seen_count else 0
                    seen_count = max(seen_count, current)
                    if no_new >= 5:
                        break
                    pg.mouse.wheel(0, 3500)
                    pg.wait_for_timeout(1400)
            finally:
                ctx.close()
    except Exception as exc:
        log("⚠ TikTok: fallback trình duyệt không mở được kênh (%s)." % str(exc)[:120])
        return []

    items, seen = [], set()
    for anchor in anchors:
        href = anchor.get("href", "")
        m = re.search(r"tiktok\.com/@([\w.\-]+)/video/(\d+)", href, re.I)
        if not m or m.group(1).lower() != handle.lower() or m.group(2) in seen:
            continue
        nick, vid = m.group(1), m.group(2)
        seen.add(vid)
        title = (anchor.get("alt") or anchor.get("title") or "").strip()[:160]
        items.append({"id": vid, "title": title, "thumb": anchor.get("img") or "",
                      "loai": "video", "video": True, "so_anh": 0,
                      "url": "https://www.tiktok.com/@%s/video/%s" % (nick, vid),
                      "like": "", "nick": nick, "duration": 0})
        if len(items) >= count:
            break
    if items:
        log("✔ TikTok: fallback trình duyệt lấy được %d video từ @%s." % (len(items), handle))
    return items


def _tiktok_xem_truoc_link_browser(urls, count, log=print):
    """Đọc metadata link TikTok bằng browser; luôn giữ URL/ID để người dùng vẫn chọn được.

    yt-dlp có thể lỗi ``Unexpected response from webpage request`` dù browser vẫn phát/tải được video.
    Browser ở đây chỉ đọc title/thumbnail/duration, không tải media. Nếu TikTok cũng che metadata thì trả
    item tối thiểu theo ID; bước tải sau đó tiếp tục dùng ``_tai_tiktok_browser``.
    """
    sources = []
    for raw in urls:
        normalized, _ = chuan_hoa_link_tiktok(raw)
        match = re.search(r"tiktok\.com/@([\w.\-]+)/video/(\d+)", normalized, re.I)
        if match and _url_an_toan(normalized):
            sources.append((normalized, match.group(1), match.group(2)))
        if len(sources) >= count:
            break
    if not sources:
        return []

    metadata = {}
    temp_profile = tempfile.mkdtemp(prefix="tt_preview_")
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                temp_profile, headless=True,
                args=["--disable-blink-features=AutomationControlled", "--mute-audio"])
            try:
                for source, _handle, vid in sources:
                    page = ctx.new_page()
                    try:
                        page.goto(source, wait_until="domcontentloaded", timeout=35000)
                        page.wait_for_timeout(1800)
                        metadata[vid] = page.evaluate("""() => {
                            const meta = (key) => document.querySelector(
                              `meta[property='${key}'],meta[name='${key}']`)?.content || '';
                            const video = document.querySelector('video');
                            return {
                              title: meta('og:title') || meta('twitter:title') || document.title || '',
                              thumb: meta('og:image') || meta('twitter:image') || '',
                              duration: Number(video?.duration) > 0 ? Number(video.duration) : 0
                            };
                        }""")
                    except Exception:
                        metadata[vid] = {}
                    finally:
                        try:
                            page.close()
                        except Exception:
                            pass
            finally:
                ctx.close()
    except Exception as exc:
        log("⚠ TikTok: browser chưa đọc được metadata link (%s); vẫn giữ ID để tải." % str(exc)[:100])
    finally:
        shutil.rmtree(temp_profile, ignore_errors=True)

    items, rich = [], 0
    for source, handle, vid in sources:
        data = metadata.get(vid) or {}
        title = re.sub(r"\s*\|\s*TikTok\s*$", "", str(data.get("title") or ""), flags=re.I).strip()
        if not title or re.search(r"access denied|log in|tiktok - make your day", title, re.I):
            title = "Video %s" % vid
        else:
            rich += 1
        items.append({"id": vid, "title": title[:160], "thumb": data.get("thumb") or "",
                      "loai": "video", "video": True, "so_anh": 0, "url": source,
                      "like": "", "nick": handle, "duration": data.get("duration") or 0})
    log("✔ TikTok: fallback link trả %d video%s." %
        (len(items), " · có metadata %d" % rich if rich else " · dùng ID vì TikTok che metadata"))
    return items


def reddit_sub(s):
    """'funny' | 'r/funny' | link subreddit -> tên subreddit sạch."""
    s = (s or "").strip()
    m = re.search(r"reddit\.com/r/([^/?#]+)", s, re.I)
    if m:
        return m.group(1)
    return re.sub(r"[^A-Za-z0-9_]", "", s.lstrip("/").split("?")[0].removeprefix("r/").removeprefix("R/"))


def _reddit_get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "reupo-tool/1.0 (video reup, hoc tap)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _co_video(d):
    """Post Reddit này có video không (để yt-dlp tải được)?"""
    if d.get("is_video"):
        return True
    if d.get("post_hint") in ("hosted:video", "rich:video"):
        return True
    dom = (d.get("domain") or "").lower()
    return any(h in dom for h in ("v.redd.it", "youtube.com", "youtu.be",
                                  "redgifs.com", "gfycat.com", "streamable.com"))


def reddit_lay_links(che_do, kw_hoac_sub, sort, time_window, count):
    """Gọi Reddit JSON -> trả list link post (có video), đã giới hạn count.
    che_do='search' (tìm từ khóa toàn Reddit) | 'creator' (1 subreddit)."""
    sort = (sort or "").strip().lower()
    t = (time_window or "").strip().lower()
    links, after, vong = [], None, 0
    while len(links) < count and vong < 6:
        vong += 1
        params = {"limit": 100, "raw_json": 1}
        if after:
            params["after"] = after
        if che_do == "search":
            params["q"] = kw_hoac_sub
            params["type"] = "link"
            params["include_over_18"] = "on"
            params["sort"] = sort if sort in ("relevance", "hot", "top", "new", "comments") else "top"
            if params["sort"] == "top" and t:
                params["t"] = t
            url = "https://www.reddit.com/search.json?" + urllib.parse.urlencode(params)
        else:  # creator = 1 subreddit
            sub = reddit_sub(kw_hoac_sub)
            s = sort if sort in REDDIT_SUB_SORT else "hot"
            if s in ("top", "controversial") and t:
                params["t"] = t
            url = f"https://www.reddit.com/r/{sub}/{s}.json?" + urllib.parse.urlencode(params)
        try:
            data = _reddit_get_json(url)
        except Exception as e:
            log(f"⚠ Lỗi gọi Reddit: {str(e)[:160]}")
            break
        children = (data.get("data") or {}).get("children") or []
        if not children:
            break
        for c in children:
            d = c.get("data") or {}
            if _co_video(d) and d.get("permalink"):
                links.append("https://www.reddit.com" + d["permalink"])
                if len(links) >= count:
                    break
        after = (data.get("data") or {}).get("after")
        if not after:
            break
    return links


def xuat_cookie_tu_phien(platform, temp_dir=None):
    """X/IG: mở profile đăng nhập (browser_data/<plat>_user_data_dir) bằng Playwright,
    xuất cookie ra cookies.txt (Netscape) cho yt-dlp. Trả đường dẫn hoặc ''.
    (yt-dlp không giải mã trực tiếp được cookie Chromium của Playwright nên phải xuất qua Playwright.)

    Cookie phiên (auth token) KHÔNG còn ghi cố định vào browser_data nữa: ghi vào THƯ MỤC TẠM
    per-job rồi caller xóa trong `finally` (giảm bề mặt lộ phiên trên đĩa). browser_data/
    <plat>_user_data_dir (phiên login Playwright) GIỮ NGUYÊN — chỉ file *_cookies.txt mới chuyển temp.
    temp_dir vắng -> tự tạo (giữ tương thích chữ ký cũ; caller nên truyền dir để gom + dọn)."""
    udd = os.path.join(BROWSER_DATA_DIR, f"{platform}_user_data_dir")
    if not os.path.isdir(udd):
        return ""
    d = temp_dir or _ck_temp_dir()
    out = os.path.join(d, f"{platform}_cookies.txt")
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(udd, headless=True)
            try:
                cks = ctx.cookies()
            finally:
                ctx.close()
    except Exception as e:
        log(f"⚠ Không đọc được phiên đăng nhập {platform}: {str(e)[:120]}")
        return ""
    if not cks:
        return ""
    try:
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write("# Netscape HTTP Cookie File\n")
            for c in cks:
                dom = c.get("domain", "")
                exp = int(c.get("expires") or 0)
                f.write("\t".join([dom, "TRUE" if dom.startswith(".") else "FALSE",
                                   c.get("path", "/"), "TRUE" if c.get("secure") else "FALSE",
                                   str(exp if exp > 0 else 0), c.get("name", ""),
                                   c.get("value", "")]) + "\n")
        try:
            os.chmod(out, stat.S_IRUSR | stat.S_IWUSR)   # chỉ chủ sở hữu đọc/ghi (best-effort)
        except Exception:
            pass
        return out
    except Exception:
        return ""


# ---------------- XEM TRƯỚC (liệt kê metadata, KHÔNG tải) — cho nút "Xem trước & chọn" ----------------
def _item_yt(e):
    vid = e.get("id") or ""
    return {
        "id": vid,
        "title": (e.get("title") or "").strip()[:160],
        "thumb": "https://i.ytimg.com/vi/%s/hqdefault.jpg" % vid if vid else "",  # suy từ ID (flat không có thumb)
        "loai": "video", "video": True, "so_anh": 0,
        "url": e.get("url") or ("https://www.youtube.com/watch?v=%s" % vid if vid else ""),
        "like": str(e.get("view_count") or ""),
        "nick": e.get("channel") or e.get("uploader") or "",
        "duration": e.get("duration") or 0,
        "creator_url": e.get("channel_url") or e.get("uploader_url") or "",
    }


def _item_tt(e):
    vid = str(e.get("id") or "")
    thumbs = e.get("thumbnails") or []
    thumb = e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else "")
    return {
        "id": vid,
        "title": (e.get("title") or e.get("description") or "").strip()[:160],
        "thumb": thumb,
        "loai": "video", "video": True, "so_anh": 0,
        "url": e.get("url") or "",
        "like": str(e.get("view_count") or e.get("like_count") or ""),
        "nick": e.get("uploader") or e.get("channel") or "",
        "duration": e.get("duration") or 0,
        "creator_url": e.get("channel_url") or e.get("uploader_url") or "",
    }


def _item_ig(e):
    vid = str(e.get("id") or "")
    thumbs = e.get("thumbnails") or []
    thumb = e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else "")
    url = e.get("webpage_url") or e.get("original_url") or e.get("url") or ""
    if (not url or not str(url).lower().startswith(("http://", "https://"))) and vid:
        url = "https://www.instagram.com/reel/%s/" % vid
    return {
        "id": vid,
        "title": (e.get("title") or e.get("description") or "").strip()[:160],
        "thumb": thumb,
        "loai": "video", "video": True, "so_anh": 0,
        "url": url,
        "like": str(e.get("view_count") or e.get("like_count") or ""),
        "nick": e.get("uploader") or e.get("channel") or e.get("creator") or "",
        "duration": e.get("duration") or 0,
        "creator_url": e.get("channel_url") or e.get("uploader_url") or "",
    }


def _item_video_generic(e):
    vid = str(e.get("id") or "")
    thumbs = e.get("thumbnails") or []
    thumb = e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else "")
    return {
        "id": vid,
        "title": (e.get("title") or e.get("description") or "").strip()[:160],
        "thumb": thumb,
        "loai": "video", "video": True, "so_anh": 0,
        "url": e.get("webpage_url") or e.get("original_url") or e.get("url") or "",
        "like": str(e.get("view_count") or e.get("like_count") or ""),
        "nick": e.get("uploader") or e.get("channel") or "",
        "duration": e.get("duration") or 0,
        "creator_url": e.get("channel_url") or e.get("uploader_url") or "",
    }


def liet_ke(a, count):
    """Liệt kê video (metadata-only, extract_flat) cho XEM TRƯỚC — in 1 dòng JSON {ok, items}.
    YouTube: search (ytsearchN) + creator (kênh /videos).
    TikTok: search = HASHTAG (tiktok.com/tag/<từ khoá>) qua yt-dlp + cookie đăng nhập, dự phòng scrape
            trang search; creator = kênh.
    Facebook: CHỈ creator (Page) qua Playwright (_fb_liet_ke_kenh) — không hỗ trợ search từ khóa.
    Instagram: creator (profile) hoặc detail (reel/post), dùng cookie từ profile riêng của dự án."""
    plat = a.platform
    if plat not in ("yt", "tt", "fb", "ig", "bilitv"):
        print(json.dumps({"ok": False, "msg": "Nền tảng chưa hỗ trợ xem trước: " + plat})); return
    if plat == "fb":
        if a.type != "creator":
            print(json.dumps({"ok": False, "msg": "Facebook: chỉ hỗ trợ xem trước theo KÊNH (Page) — dùng 'Theo link' để tải trực tiếp 1 video."})); return
        items, seen = [], set()
        for x in tach_dong(a.input):
            for it in _fb_liet_ke_kenh(x, count, log=log):
                if it["id"] not in seen:
                    seen.add(it["id"]); items.append(it)
                if len(items) >= count:
                    break
            if len(items) >= count:
                break
        items = _fb_bo_sung_metadata(items, log=log)
        print(json.dumps({"ok": True, "items": items, "tong": len(items)}, ensure_ascii=False)); return
    from yt_dlp import YoutubeDL
    cookiefile = ""
    if a.type == "creator":
        if plat == "yt":
            urls = [chuan_hoa_kenh_youtube(x) for x in tach_dong(a.input)]
        elif plat == "ig":
            cookiefile = xuat_cookie_tu_phien("ig")
            urls = [chuan_hoa_user("ig", x) for x in tach_dong(a.input)]
        else:
            # KHÔNG dùng cookie login: yt-dlp 2026.06+ tự giải JS challenge TikTok; cookie login làm TikTok
            # trả 403 (xem giải thích chi tiết trong main()). Liệt kê kênh @user không cần login.
            cookiefile = ""
            urls = [u for u in (chuan_hoa_kenh_tiktok(x) for x in tach_dong(a.input)) if u]
        if not urls:
            print(json.dumps({"ok": False, "msg": "Không lấy được kênh (thử dán link 1 video của kênh)."})); return
    elif plat == "ig" and a.type == "detail":
        cookiefile = xuat_cookie_tu_phien("ig")
        urls = [u for u in tach_dong(a.input) if _url_an_toan(u)]
        if not urls:
            print(json.dumps({"ok": False, "msg": "Instagram: link video không hợp lệ."}, ensure_ascii=False)); return
    elif plat == "tt" and a.type == "detail":
        urls = [chuan_hoa_link_tiktok(u)[0] for u in tach_dong(a.input) if _url_an_toan(u)]
        if not urls:
            print(json.dumps({"ok": False, "msg": "TikTok: link video không hợp lệ."}, ensure_ascii=False)); return
    elif plat == "bilitv" and a.type == "detail":
        urls = [u for u in tach_dong(a.input) if _url_an_toan(u)]
        if not urls:
            print(json.dumps({"ok": False, "msg": "BiliTV: link video không hợp lệ."}, ensure_ascii=False)); return
    elif plat == "tt":  # TikTok search: từ khoá = HASHTAG (tag) — cần cookie đăng nhập TikTok
        cookiefile = xuat_cookie_tu_phien("tt")
        if not cookiefile:
            print(json.dumps({"ok": False, "msg": "Chưa đăng nhập TikTok — bấm thẻ TikTok ở mục Đăng nhập nền tảng rồi thử lại."})); return
        urls = ["https://www.tiktok.com/tag/%s" % urllib.parse.quote(kw.lstrip("#").replace(" ", "").strip())
                for kw in tach_dong(a.input) if kw.strip()]
        if not urls:
            print(json.dumps({"ok": False, "msg": "Chưa nhập từ khóa."})); return
    else:  # search YouTube
        urls = ["ytsearch%d:%s" % (count, kw) for kw in tach_dong(a.input)]
        if not urls:
            print(json.dumps({"ok": False, "msg": "Chưa nhập từ khóa."})); return

    opts = {"extract_flat": False if a.type == "detail" else "in_playlist",
            "skip_download": True, "playlistend": count,
            "quiet": True, "no_warnings": True, "ignoreerrors": True, "nocheckcertificate": True}
    tt_channel_logger = None
    if plat == "tt" and a.type == "creator":
        tt_channel_logger = _TikTokChannelLogger(log_fn=log)
        opts["logger"] = tt_channel_logger
    elif plat == "tt" and a.type == "detail":
        tt_detail_logger = _TikTokChannelLogger(log_fn=log)
        if urls:
            tt_detail_logger.set_url(urls[0])
        opts["logger"] = tt_detail_logger  # không in ERROR trung gian; fallback bên dưới mới là kết quả
    if a.type == "detail":
        opts["noplaylist"] = True
    if cookiefile and os.path.isfile(cookiefile):
        opts["cookiefile"] = cookiefile
    parser = _item_yt if plat == "yt" else (_item_ig if plat == "ig" else (_item_tt if plat == "tt" else _item_video_generic))
    items, seen = [], set()
    kenh_nick, kenh_avatar = "", ""   # metadata KÊNH (creator) — cho Theo dõi/Kênh nguồn lấy tên + avatar THẬT
    try:
        with YoutubeDL(opts) as ydl:
            for u in urls:
                if tt_channel_logger:
                    tt_channel_logger.set_url(u)
                try:
                    info = ydl.extract_info(u, download=False)
                except Exception as e:
                    log("⚠ Lỗi liệt kê %s: %s" % (u[:40], str(e)[:120])); continue
                if a.type == "creator" and isinstance(info, dict) and not kenh_nick:
                    # info cấp playlist (trang kênh) có channel/uploader + thumbnails = AVATAR kênh (yt).
                    kenh_nick = (info.get("channel") or info.get("uploader") or "").strip()
                    _ths = info.get("thumbnails") or []
                    if _ths:
                        kenh_avatar = _ths[-1].get("url") or (_ths[0].get("url") or "")
                entries = info.get("entries") if isinstance(info, dict) else None
                for e in (entries or ([info] if info else [])):
                    if not e:
                        continue
                    it = parser(e)
                    if it["id"] and it["id"] not in seen:
                        seen.add(it["id"]); items.append(it)
                    if len(items) >= count:
                        break
                if len(items) >= count:
                    break
    except Exception as e:
        print(json.dumps({"ok": False, "msg": "Lỗi xem trước: " + str(e)[:160]})); return
    # TikTok: hashtag qua yt-dlp đôi khi lỗi 'No app info' -> dự phòng scrape trang search (cùng phiên login)
    if plat == "tt" and a.type == "search" and not items:
        log("ℹ Hashtag TikTok không ra video — thử scrape trang search.")
        for kw in tach_dong(a.input):
            for it in _tiktok_search(kw, count):
                if it["id"] and it["id"] not in seen:
                    seen.add(it["id"]); items.append(it)
                if len(items) >= count:
                    break
            if len(items) >= count:
                break
    if plat == "tt" and a.type == "detail" and len(items) < min(count, len(urls)):
        log("ℹ yt-dlp không đọc được metadata link TikTok — chuyển sang fallback trình duyệt.")
        for it in _tiktok_xem_truoc_link_browser(urls, count, log=log):
            if it["id"] and it["id"] not in seen:
                seen.add(it["id"]); items.append(it)
            if len(items) >= count:
                break
    if plat == "ig" and a.type == "creator" and not items:
        log("ℹ Instagram extractor không liệt kê được kênh — thử qua trình duyệt.")
        for source in tach_dong(a.input):
            for it in _ig_liet_ke_kenh(source, count - len(items), log=log):
                if it["id"] and it["id"] not in seen:
                    seen.add(it["id"]); items.append(it)
                if len(items) >= count:
                    break
            if len(items) >= count:
                break
    if plat == "tt" and a.type == "creator" and len(items) < count and tt_channel_logger:
        recovered = tt_channel_logger.items(count)
        for it in recovered:
            if it["id"] and it["id"] not in seen:
                seen.add(it["id"]); items.append(it)
            if len(items) >= count:
                break
        if recovered:
            log("✔ TikTok: giữ lại %d video yt-dlp đã phát hiện trước khi lỗi secUid." % len(recovered))
    if plat == "tt" and a.type == "creator" and len(items) < count:
        log("ℹ Danh sách TikTok chưa đủ — chuyển sang fallback trình duyệt.")
        for source in tach_dong(a.input):
            for it in _tiktok_liet_ke_kenh_browser(source, count - len(items), log=log):
                if it["id"] and it["id"] not in seen:
                    seen.add(it["id"]); items.append(it)
                if len(items) >= count:
                    break
            if len(items) >= count:
                break
    if plat == "ig" and items:
        items = _ig_bo_sung_metadata(items, log=log)
    _don_cookie_temp()   # dọn cookie phiên tạm (các đường return sớm vẫn được atexit dọn)
    # nick/avatar item (nếu parser có) làm dự phòng khi thiếu metadata kênh cấp playlist
    if not kenh_nick:
        for it in items:
            if it.get("nick"):
                kenh_nick = it["nick"]; break
    print(json.dumps({"ok": True, "items": items, "tong": len(items),
                      "kenh_nick": kenh_nick, "kenh_avatar": kenh_avatar}, ensure_ascii=False))


def _url_an_toan(u):
    """H11 chống SSRF: chỉ cho URL scheme http(s) + host KHÔNG loopback/private/reserved/link-local.
    Chặn file://, ftp://, http://127.0.0.1, http://192.168.x... (yt-dlp đọc file cục bộ / gọi dịch vụ nội bộ)."""
    try:
        p = urllib.parse.urlparse((u or "").strip())
    except Exception:
        return False
    if p.scheme not in ("http", "https"):
        return False
    host = (p.hostname or "").lower()
    if not host or host == "localhost":
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_loopback or ip.is_private or ip.is_reserved or ip.is_link_local:
            return False
    except ValueError:
        pass   # host là tên miền → để yt-dlp resolve (CDN/nền tảng hợp lệ)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", required=True, choices=list(NEN.keys()))
    ap.add_argument("--type", required=True, choices=["search", "creator", "detail", "bo"])
    ap.add_argument("--input", required=True)
    ap.add_argument("--count", default="10")
    ap.add_argument("--source-type", dest="source_type", choices=["search", "creator", "detail", "bo"], default="")
    ap.add_argument("--source-input", dest="source_input", default="")
    ap.add_argument("--source-name", dest="source_name", default="")
    ap.add_argument("--sort", default="")            # Reddit: relevance/top/comments/hot/new/controversial
    ap.add_argument("--time", default="")            # Reddit: hour/day/week/month/year/all
    ap.add_argument("--cookies-browser", dest="cookies_browser", default="")  # chrome/edge/firefox...
    ap.add_argument("--cookies", default="")          # đường dẫn cookies.txt (Netscape) — X/IG
    ap.add_argument("--list", action="store_true")    # CHỈ liệt kê metadata (xem trước), KHÔNG tải
    a = ap.parse_args()

    if a.platform == "bilitv" and a.type != "detail":
        ap.error("Bilibili quốc tế hiện chỉ hỗ trợ tải theo link video/tập.")

    try:
        count = max(1, int(a.count))
    except ValueError:
        count = 10

    if a.list:                       # xem trước (metadata-only) -> in JSON rồi thoát, KHÔNG tải
        liet_ke(a, count)
        return

    from yt_dlp import YoutubeDL

    plat = NEN[a.platform]
    # Gốc data = env MC_DATA_DIR (web_app đặt = userData / user-chọn → BỀN qua update);
    # không có env (chạy tay trong dev) = chỗ cũ MediaCrawler/data.
    _data_goc = (os.environ.get("MC_DATA_DIR") or "").strip() or os.path.join(THU_MUC_CRAWLER, "data")
    base = os.path.join(_data_goc, plat["thu_muc"], "videos")
    archive = os.path.join(_data_goc, plat["thu_muc"], "_da_tai.txt")
    os.makedirs(base, exist_ok=True)
    # Khi người dùng xem trước rồi chọn từng video, tải vẫn chạy bằng detail để giữ đúng URL đã chọn,
    # nhưng source_type/source_input giữ nguồn ban đầu để xếp đúng thư mục từ-khóa/kênh/link.
    storage_type = a.source_type or a.type
    storage_input = (a.source_input or a.input).strip()
    storage_name = (a.source_name or "").strip()

    def selected_storage_dir():
        if storage_type == "search":
            return os.path.join(base, "tu-khoa", an_toan(storage_input or "khac"))
        if storage_type == "creator":
            return os.path.join(base, "kenh", an_toan(storage_name or storage_input or "kenh"))
        if storage_type == "bo":
            return os.path.join(base, "bo", an_toan(storage_name or storage_input or "bo"))
        return os.path.join(base, "link")

    # ƯU TIÊN ffmpeg BUNDLE (tim_exe) — máy khách thường KHÔNG có ffmpeg PATH → shutil.which=None → yt-dlp không
    # ghép được video+audio (YouTube độ cao luôn tách stream, cần merge) → tải ra thiếu tiếng/hình hoặc fail.
    try:
        import xu_ly_video as _xlv
        ffmpeg = _xlv.tim_exe("ffmpeg")
        if ffmpeg == "ffmpeg":   # tim_exe trả tên trần = không thấy bundle/PATH
            ffmpeg = shutil.which("ffmpeg")
    except Exception:
        ffmpeg = shutil.which("ffmpeg")
    cookies_browser = (a.cookies_browser or "").strip().lower()
    cookies_file = (a.cookies or "").strip()
    _co_cookie = lambda: cookies_browser or (cookies_file and os.path.isfile(cookies_file))
    # X/IG: chưa truyền cookie thủ công -> lấy từ phiên đăng nhập (mo_dang_nhap)
    if a.platform in NEN_CAN_COOKIE and not _co_cookie():
        cf = xuat_cookie_tu_phien(a.platform)
        if cf:
            cookies_file = cf
            log(f"🔑 Dùng cookie phiên đăng nhập {a.platform.upper()}.")
    if a.platform in NEN_CAN_COOKIE and not _co_cookie():
        log(f"⚠ {a.platform.upper()} cần đăng nhập — chưa có phiên. Bấm 'Đăng nhập {a.platform.upper()}' trước khi cào.")
    # YouTube cho phép ẩn danh, nhưng nếu người dùng đã mở phiên đăng nhập thì xuất cookie qua Playwright
    # sang file tạm riêng. Cách này không giao trực tiếp Cookie DB đang bị Chromium khóa cho yt-dlp.
    if a.platform == "yt" and not _co_cookie():
        cf = xuat_cookie_tu_phien("yt")
        if cf:
            cookies_file = cf
            log("🔑 Dùng cookie YouTube tùy chọn từ bản sao tạm an toàn.")
    # TikTok: KHÔNG tự nhét cookie login vào yt-dlp download/liệt-kê. yt-dlp 2026.06+ tự GIẢI JS challenge
    # của TikTok để né anti-bot — nhưng khi CÓ cookie login thì TikTok trả HTTP 403 Forbidden ngay bước
    # "Downloading webpage" (cookie phiên xung đột với cookie-challenge yt-dlp tự sinh). Tái hiện THẬT: cùng 1
    # link video công khai, KHÔNG cookie → tải OK 3.27MB; CÓ cookie → 403 → 0 video (log đổ nhầm "anti-bot").
    # Video công khai (đại đa số) không cần login. Nếu user CHỦ ĐỘNG truyền --cookies (video riêng tư) thì vẫn
    # tôn trọng (block này chỉ chặn auto-lấy). Search TikTok qua Playwright (hàm riêng) vẫn dùng cookie như cũ.
    if a.platform == "tt" and cookies_file:
        log("🔑 Dùng cookie TikTok bạn cung cấp (video riêng tư).")
    # (bỏ auto-xuất cookie phiên cho TikTok — cookie làm yt-dlp 403; xem giải thích ở trên)
    # Facebook: cookie phiên đăng nhập nếu có (giúp tải ổn định hơn) — KHÔNG bắt buộc (Page công khai vẫn tải được)
    if a.platform == "fb" and not _co_cookie():
        cf = xuat_cookie_tu_phien("fb")
        if cf:
            cookies_file = cf
            log("🔑 Dùng cookie phiên đăng nhập Facebook.")

    # Đếm số video tải được trong phiên (theo id để không đếm trùng stream video+audio)
    da_xong = set()
    da_bo_qua = set()   # video BỎ QUA vì đã có file [id] sẵn (match_filter) → báo TRUNG THỰC "đã tải trước đó"
                        # thay vì để web_app tưởng 0 video = anti-bot (nguyên nhân chính bug "TikTok 0 video").

    # LỊCH SỬ CÀO: yt-dlp (yt/tt/fb...) ghi *_contents_*.jsonl cạnh videos (như MediaCrawler) -> video ĐÃ TẢI
    # hiện trong tab "Lịch sử cào" (lich_su_cao chỉ đọc jsonl; trước đây yt-dlp chỉ tải file nên bị bỏ sót).
    import datetime as _dt
    _ls_dir = os.path.join(os.path.dirname(base), "jsonl")   # base=.../<nền>/videos -> jsonl cạnh đó
    _ls_loai = "chase" if storage_type == "bo" else (storage_type if storage_type in ("search", "creator", "detail") else "detail")
    _ls_file = os.path.join(_ls_dir, f"{_ls_loai}_contents_{_dt.date.today().isoformat()}.jsonl")
    _ls_da_ghi = set()
    _cho_kiem_tra = {}

    def _ghi_lich_su(info):
        vid = str(info.get("id") or "")
        if not vid or vid in _ls_da_ghi:
            return
        _ls_da_ghi.add(vid)
        try:
            url = info.get("webpage_url") or info.get("original_url") or ""
            ts = int(info.get("timestamp") or 0)
            if not ts:
                ud = str(info.get("upload_date") or "")
                if len(ud) == 8:
                    try:
                        ts = int(_dt.datetime.strptime(ud, "%Y%m%d").timestamp())
                    except Exception:
                        ts = 0
            rec = {"video_id": vid, "id": vid, "title": info.get("title") or "",
                   "nickname": info.get("uploader") or info.get("channel") or "",
                   "video_url": url, "url": url, "create_time": ts, "last_modify_ts": ts,
                   "source_keyword": (storage_input if storage_type == "search" else "")}
            os.makedirs(_ls_dir, exist_ok=True)
            with open(_ls_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            try:   # ĐÁNH DẤU đã-tải (index_metadata SQLite) -> badge "✓ đã tải" đúng ở Lịch sử cào + Xem trước
                import index_metadata   # noqa: cùng repo, cwd=THU_MUC_GOC
                index_metadata.danh_dau(a.platform, [x for x in (url, vid) if x])
            except Exception:
                pass
        except Exception:
            pass

    def _media_hop_le(file_path):
        try:
            if not os.path.isfile(file_path) or os.path.getsize(file_path) < 100 * 1024:
                return False
            ext = os.path.splitext(file_path)[1].lower()
            with open(file_path, "rb") as media_file:
                head = media_file.read(64)
            if ext in (".mp4", ".mov", ".m4v"):
                return any(sig in head for sig in (b"ftyp", b"moov", b"free", b"skip", b"wide", b"mdat"))
            if ext in (".webm", ".mkv"):
                return head.startswith(b"\x1a\x45\xdf\xa3")
            return False
        except OSError:
            return False

    def _tim_media_theo_id(vid):
        marker = "[%s]" % vid
        for root, _dirs, files in os.walk(base):
            for name in files:
                if marker in name and _media_hop_le(os.path.join(root, name)):
                    return os.path.join(root, name)
        return ""

    def _xoa_archive_id(vid):
        if not archive or not os.path.isfile(archive):
            return
        try:
            with open(archive, "r", encoding="utf-8") as archive_file:
                lines = archive_file.readlines()
            kept = [line for line in lines if not re.search(r"(?:^|\s)%s\s*$" % re.escape(vid), line)]
            if len(kept) != len(lines):
                with open(archive, "w", encoding="utf-8") as archive_file:
                    archive_file.writelines(kept)
        except OSError:
            pass

    _tien_do = {"pct": -1}   # % ĐÃ log gần nhất — chỉ log mỗi mốc ~10% (tránh spam từng fragment)

    def hook(d):
        st = d.get("status")
        if st == "downloading":
            # Video DÀI/NẶNG (phim, live vài giờ = cả GB) tải MẤT VÀI PHÚT → không có log thì khách tưởng
            # treo/0 video. Log % + dung lượng + tốc độ mỗi mốc ~10% để thấy ĐANG TẢI.
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total > 0:
                pct = int(done * 100 / total)
                if pct >= _tien_do["pct"] + 10 or (pct >= 99 and _tien_do["pct"] < 99):
                    _tien_do["pct"] = pct
                    mb = total / 1048576
                    spd = (d.get("speed") or 0) / 1048576
                    log(f"📥 Đang tải video: {pct}% của {mb:.0f}MB" + (f" ({spd:.1f}MB/s)" if spd > 0 else ""))
            return
        if st == "finished":
            _tien_do["pct"] = -1   # reset cho video kế
            info = d.get("info_dict") or {}
            vid = info.get("id") or d.get("filename", "")
            if vid in da_xong:
                return
            da_xong.add(vid)
            _cho_kiem_tra[str(vid)] = dict(info)  # chỉ ghi ledger sau khi file cuối đã được xác minh
            ten = info.get("title") or os.path.basename(d.get("filename", ""))
            log(f"✔ Đã tải {len(da_xong)}: {ten[:80]}")

    _ids_co_san = {"set": None}   # cache id có sẵn — quét 1 LẦN đầu (bug: os.walk toàn cây MỖI video = O(N×M)
                                  # chậm nghiêm trọng với thư mục nghìn file → cào "đứng" vài phút). File mới tải
                                  # xong trong phiên này đã có `da_xong` chặn trùng riêng nên cache tĩnh là đủ.

    def _da_co_file(vid):
        """File video có [<id>] ĐÃ tồn tại trong data (bất kỳ folder link/kênh/tu-khoa)? → chống trùng ĐỘC LẬP
        download_archive. yt-dlp ghi id vào _da_tai.txt CHỈ SAU khi tải XONG → video LỚN (3GB) tải 10-30 phút,
        trong lúc đó id CHƯA vào archive → bấm cào lại / job lặp / cào link+kênh cùng video = tải BẢN TRÙNG.
        Kiểm file [id] sẵn có chặn trùng NGAY kể cả khi archive chưa kịp ghi."""
        if not vid:
            return False
        if _ids_co_san["set"] is None:   # quét TOÀN CÂY đúng 1 lần → set các id có sẵn (rẻ hơn walk mỗi video)
            _s = set()
            try:
                for _root, _dirs, _files in os.walk(base):
                    for _f in _files:
                        if _f.lower().endswith((".mp4", ".mkv", ".webm")):
                            import re as _re
                            for _m in _re.findall(r"\[([^\[\]]+)\]", _f):
                                _s.add(_m)
            except Exception:
                pass
            _ids_co_san["set"] = _s
        return vid in _ids_co_san["set"]

    def _match_bo_trung(info):
        """yt-dlp match_filter: bỏ qua video đã có file [id] trên đĩa. Trả None = tải; str = lý do skip."""
        vid = str(info.get("id") or "")
        if vid and _da_co_file(vid):
            da_bo_qua.add(vid)
            log(f"↩ Bỏ qua (đã tải trước đó): {(info.get('title') or vid)[:60]}")
            return "da co file [%s]" % vid
        return None

    # Logger tùy chỉnh: bắt lỗi yt-dlp (quiet=True nuốt warnings) và ghi ra LOG cho UI thấy.
    # Đặc biệt quan trọng cho TikTok: HTTP 403 (anti-bot) bị quiet+ignoreerrors nuốt hoàn toàn ->
    # tool báo "0 video" không rõ lý do. Logger này chuyển ERROR/WARNING 403 -> log() để user biết.
    class _YDLLogger:
        _TT_IGNORE = frozenset(["Extracting URL", "Downloading webpage", "Downloading page",
                                "Solving JS challenge", "challenge cookie"])
        def debug(self, msg): pass   # debug quá nhiều, bỏ
        def warning(self, msg):
            m = str(msg or "")
            # TikTok: lọc cảnh báo impersonation (chỉ log 1 lần/phiên, không spam mỗi video)
            if "impersonat" in m.lower():
                if not getattr(_YDLLogger, "_impersonation_warned", False):
                    _YDLLogger._impersonation_warned = True
                    if a.platform == "tt":
                        log("⚠ curl_cffi chưa cài — TikTok có thể chặn (HTTP 403). "
                            "Nếu tải 0 video: chạy lại cài đặt để cập nhật curl_cffi.")
                return
            log("⚠ " + m[:200])
        def error(self, msg):
            m = str(msg or "")
            # Bỏ qua lỗi "has already been recorded" (download_archive duplicate — bình thường)
            if "already been recorded" in m or "already been downloaded" in m:
                return
            log("✗ " + m[:200])

    def opts_cho(outtmpl, playlistend=None):
        o = {
            "outtmpl": outtmpl,
            "match_filter": _match_bo_trung,   # chống trùng theo FILE [id] sẵn có (độc lập download_archive)
            # Ưu tiên H.264 (avc1/h264) để phát được mọi nơi. TikTok trả bytevc1/bytevc2 (H.265/H.266) KHÔNG
            # PHÁT ĐƯỢC (VLC/trình duyệt đen hình, CHỈ CÓ TIẾNG → khách tưởng "tải ra mp3"). Fix (khớp yt-dlp
            # issue #9567): fallback LUÔN yêu cầu CÓ VIDEO (bv*/b có vcodec) — KHÔNG để '/b' trần rơi vào
            # audio-only. Nếu buộc dùng bytevc1/2 → recode_video mp4 (h264) ở dưới → phát được.
            "format": ("bv*[vcodec~='^(avc1|h264)']+ba[ext=m4a]/"
                       "b[vcodec~='^(avc1|h264)']/"
                       "bv*+ba/b[vcodec!=none]"),   # bv*+ba (bất kỳ video codec) hoặc best CÓ video — KHÔNG audio-only
            "format_sort": ["vcodec:h264"],
            "merge_output_format": "mp4",
            "ignoreerrors": True,
            "nocheckcertificate": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "retries": 3,
            "progress_hooks": [hook],
            "concurrent_fragment_downloads": 4,
            "enable_file_urls": False,   # H11: tường minh KHÔNG cho yt-dlp đọc file:// (chống SSRF/đọc file cục bộ)
            "logger": _YDLLogger(),      # bắt error/warning yt-dlp (quiet nuốt) -> hiển thị cho user
        }
        # download_archive: CHỈ dùng cho creator/search ("cào không trùng" khi kéo cả kênh/từ khóa nhiều trang).
        # KHÔNG dùng cho "Theo link" (detail): user CHỦ ĐỘNG chọn link → phải tải nếu file đã mất; archive ghi
        # id sau khi tải xong 1 lần → lần sau file bị xóa vẫn bị SKIP ÂM THẦM (quiet nuốt) → "0 video" khó hiểu
        # (bị tưởng nhầm anti-bot). Chống trùng ở detail đã có match_filter=_match_bo_trung (soi FILE [id] thật).
        # A selected preview item is executed as detail even when it is stored under
        # its original keyword/channel/group folder. Do not let a stale archive block
        # an explicit re-download after the media file has been deleted.
        if a.type != "detail":
            o["download_archive"] = archive
        if ffmpeg:
            o["ffmpeg_location"] = ffmpeg
        if cookies_file and os.path.isfile(cookies_file):
            o["cookiefile"] = cookies_file
        elif cookies_browser:
            o["cookiesfrombrowser"] = (cookies_browser,)
        # YouTube (yt-dlp 2026.06+): TẢI cần JS runtime + EJS challenge solver để giải nsig/signature.
        # Thiếu -> yt-dlp lùi client android_vr -> 0 format -> "This video is not available" (XEM TRƯỚC
        # vẫn chạy vì extract_flat không cần JS, nên dễ tưởng cào OK).
        # 🐛 FIX (khách báo log thật: "No supported JavaScript runtime could be found" dù app CÓ bundle node):
        # comment cũ "Installer bundle node đã ở PATH" là GIẢ ĐỊNH SAI — không có đoạn code nào thực sự thêm
        # vendor/node vào PATH của tiến trình con trước khi spawn tai_ytdlp.py; shutil.which("node") chỉ tìm
        # trong PATH hệ thống, máy khách không cài Node.js hệ thống thì luôn None. Fix theo ĐÚNG pattern
        # tim_exe() (xu_ly_video.py) đã dùng cho ffmpeg: ưu tiên bundle (vendor/node/node.exe) trước PATH.
        if a.platform == "yt":
            _node = _tim_node()
            o["js_runtimes"] = {"node": {"path": _node}} if _node else {"node": {"path": None}}
            o["remote_components"] = ["ejs:github"]
            # RATE-LIMIT chống bot-check ("Sign in to confirm you're not a bot"): theo maintainer yt-dlp (issue
            # #10128) bot-check gốc rễ là IP bị YouTube gắn cờ — tải QUÁ NHIỀU/NHANH là 1 tác nhân chính (guest
            # session ~300 video/giờ là ngưỡng an toàn). App chạy IP nhà khách (residential) đã là lợi thế; thêm
            # nghỉ để không bị cờ. sleep_requests = nghỉ giữa HTTP request (nhẹ, LUÔN áp — 1 video vẫn nhiều request
            # metadata/fragment). sleep_interval = nghỉ giữa các VIDEO: CHỈ khi cào LÔ (creator/search) vì detail
            # (1 link) không có "giữa video". Cho chỉnh/tắt qua env YT_SLEEP_REQ / YT_SLEEP_MIN / YT_SLEEP_MAX (=0 tắt).
            try:
                _sq = float(os.environ.get("YT_SLEEP_REQ", "") or 1.0)
            except ValueError:
                _sq = 1.0
            if _sq > 0:
                o["sleep_interval_requests"] = _sq
            if a.type != "detail":     # cào lô kênh/từ khóa → nghỉ giữa video, giữ dưới ~300 video/giờ
                try:
                    _smin = float(os.environ.get("YT_SLEEP_MIN", "") or 3.0)
                    _smax = float(os.environ.get("YT_SLEEP_MAX", "") or 8.0)
                except ValueError:
                    _smin, _smax = 3.0, 8.0
                if _smin > 0:
                    o["sleep_interval"] = _smin
                    o["max_sleep_interval"] = max(_smin, _smax)
        # TikTok: khi curl_cffi đã cài (pyproject.toml), yt-dlp tự dùng để impersonate Chrome TLS fingerprint
        # -> vượt anti-bot 403. Không cần set "impersonate" tường minh vì extractor TikTok tự yêu cầu.
        # user_agent giúp header-level (bổ sung curl_cffi ở TLS-level).
        if a.platform == "tt":
            o["user_agent"] = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/131.0.0.0 Safari/537.36")
            o["http_headers"] = dict(o.get("http_headers") or {}, Referer="https://www.tiktok.com/")
        # Facebook: KHÁC TikTok — extractor Facebook KHÔNG tự yêu cầu impersonate (đã soi source, không có
        # từ khóa "impersonat"), phải set TƯỜNG MINH mới hết lỗi "[facebook] Cannot parse data" (yt-dlp
        # issue #15161 "impersonation needed"). ĐÃ VERIFY THẬT (extract_info video lỗi thật, curl_cffi
        # 0.15.0 sẵn máy dev): không impersonate -> lỗi y hệt log; impersonate=chrome -> hết lỗi + 13
        # format thật (có 720p). Guard try/except: máy khách thiếu curl_cffi thì ImpersonateTarget vẫn
        # set được nhưng YoutubeDL.__init__ RAISE luôn (không phải warning nhẹ như TikTok) -> phải tự dò
        # trước, thiếu thì bỏ qua (giữ hành vi cũ, không crash job).
        if a.platform in ("fb", "bilitv"):
            try:
                import curl_cffi  # noqa: F401  (chỉ để dò có cài chưa)
                from yt_dlp.networking.impersonate import ImpersonateTarget
                o["impersonate"] = ImpersonateTarget.from_str("chrome")
            except Exception:
                log("⚠ curl_cffi chưa cài — Facebook có thể báo lỗi 'Cannot parse data'. "
                    "Nếu tải 0 video: chạy lại cài đặt để cập nhật curl_cffi.")
        if playlistend:
            o["playlistend"] = playlistend
        # "Theo link" (detail): CHỈ tải ĐÚNG video được dán — KHÔNG kéo cả playlist/radio-mix khi URL có &list=
        # (vd watch?v=X&list=RDxxx = radio 60 video). creator/search dùng URL playlist THẬT nên KHÔNG set.
        if a.type == "detail":
            o["noplaylist"] = True
        # XOÁ HASHTAG khỏi %(title)s TRƯỚC khi yt-dlp dựng tên file. Tiêu đề TikTok gần như luôn là cả 'rừng'
        # hashtag ⇒ tên file dài lê thê; cộng thư mục sâu là vượt MAX_PATH 260 của Windows (đã gây WinError 3
        # THẬT ở bước lồng tiếng trên máy khách). `when="pre_process"` = chạy TRƯỚC khi dựng outtmpl.
        # Đặt ở opts_cho nên phủ CẢ 8 chỗ outtmpl (search/creator/detail của mọi nền) — khỏi sửa từng chỗ.
        # Bọc try: bản yt-dlp khác đổi API thì bỏ qua, giữ hành vi cũ chứ không làm chết job cào.
        # ⚠ Tiêu đề TikTok RẤT hay là 100% hashtag ⇒ bỏ xong còn RỖNG ⇒ outtmpl cũ '%(title).80B' cho ra
        # 'NA [id].mp4' (vô nghĩa với khách). Vì vậy outtmpl đã đổi thành '%(title,uploader,id).80B' —
        # yt-dlp coi chuỗi RỖNG là không có và rơi xuống tên KÊNH ('zenergy.pro [id].mp4'), cuối cùng mới tới id.
        try:
            from yt_dlp.postprocessor.metadataparser import MetadataParserPP
            o.setdefault("postprocessors", []).append({
                "key": "MetadataParser", "when": "pre_process",
                "actions": [(MetadataParserPP.Actions.REPLACE, "title", r"\s*[#＃][^\s#＃]+", "")],
            })
        except Exception:
            pass
        return o

    # ---- Dựng danh sách (URL, outtmpl) theo chế độ ----
    cong_viec = []  # mỗi phần tử: (list_url, outtmpl, playlistend)

    if a.type == "search":
        if a.platform == "yt":
            for kw in tach_dong(a.input):
                thu_muc = os.path.join(base, "tu-khoa", an_toan(kw))
                outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
                cong_viec.append(([f"{plat['search_prefix']}{count}:{kw}"], outtmpl, count))
                log(f"🔎 Tìm YouTube: {kw} (tối đa {count})")
        elif a.platform == "rd":
            for kw in tach_dong(a.input):
                links = reddit_lay_links("search", kw, a.sort, a.time, count)
                if not links:
                    log(f"⚠ Reddit: không thấy post có video cho '{kw}'.")
                    continue
                thu_muc = os.path.join(base, "tu-khoa", an_toan(kw))
                outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
                cong_viec.append((links, outtmpl, None))
                log(f"🔎 Reddit '{kw}' (sort={a.sort or 'top'}): {len(links)} post có video")
        else:
            log(f"⚠ {a.platform.upper()} không hỗ trợ tìm theo từ khóa. Dùng link hoặc theo kênh/user.")
            print("YTDLP_DONE 0", flush=True)
            return

    elif a.type == "bo":
        # 🆕 CÀO THEO BỘ (02/08/2026) — tải TRỌN một bộ sưu tập / playlist.
        # ⚠ ĐO THẬT trước khi làm: metadata MỘT video TikTok KHÔNG chứa thông tin bộ (`playlist`,
        # `playlist_index` đều rỗng, `_type=None`) ⇒ KHÔNG suy ra được bộ từ link video như Bilibili làm với
        # `ugc_season`. Vậy nên chế độ này nhận **LINK BỘ**; dán link video thì BÁO RÕ chứ không đoán mò
        # (cùng nguyên tắc với nhánh "đuổi theo bộ" của Bilibili).
        # yt-dlp có sẵn extractor `tiktok:collection` cho URL .../@user/collection/<tên>-<id>.
        # KHÔNG đặt `noplaylist` ở đây (chỉ `detail` mới đặt) — có đặt là bung đúng 1 video, hỏng cả tính năng.
        urls = []
        for x in tach_dong(a.input):
            _x = (x or "").strip()
            if not _x:
                continue
            if ("/collection/" in _x) or ("/playlist/" in _x) or ("list=" in _x):
                urls.append(_x)
            else:
                log("⚠ KHÔNG phải link BỘ: %s" % _x[:90])
                log("   Nền tảng không cho biết 1 video thuộc bộ nào. Hãy MỞ bộ sưu tập/playlist rồi copy link "
                    "(TikTok: .../@user/collection/<tên>-<số>) — dán link video lẻ thì dùng nút 'Theo link'.")
        if not urls:
            log("⚠ Không có link bộ hợp lệ → không tải gì.")
        else:
            thu_muc = os.path.join(base, "bo", "%(playlist_title,playlist_id,playlist)s")
            outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
            cong_viec.append((urls, outtmpl, count))
            log(f"📚 Tải theo BỘ: {len(urls)} bộ (tối đa {count} video/bộ)")
    elif a.type == "creator":
        if a.platform == "rd":
            for sub_in in tach_dong(a.input):
                sub = reddit_sub(sub_in)
                links = reddit_lay_links("creator", sub_in, a.sort, a.time, count)
                if not links:
                    log(f"⚠ Reddit r/{sub}: không thấy post có video.")
                    continue
                thu_muc = os.path.join(base, "kenh", an_toan(sub))
                outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
                cong_viec.append((links, outtmpl, None))
                log(f"📺 Reddit r/{sub} (sort={a.sort or 'hot'}): {len(links)} post có video")
        elif a.platform in ("tw", "ig"):
            urls = [chuan_hoa_user(a.platform, x) for x in tach_dong(a.input)]
            thu_muc = os.path.join(base, "kenh", "%(uploader,channel,uploader_id)s")
            outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
            cong_viec.append((urls, outtmpl, count))
            log(f"📺 Tải theo user: {len(urls)} user (tối đa {count} video/user)")
        elif a.platform == "yt":
            urls = [chuan_hoa_kenh_youtube(x) for x in tach_dong(a.input)]
            thu_muc = os.path.join(base, "kenh", "%(channel,uploader,uploader_id)s")
            outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
            cong_viec.append((urls, outtmpl, count))
            log(f"📺 Tải theo kênh YouTube: {len(urls)} kênh (tối đa {count} video/kênh)")
        elif a.platform == "fb":
            # yt-dlp không liệt kê được Page FB -> liệt kê bằng Playwright rồi tải TỪNG link (mirror TikTok)
            items, seen = [], set()
            for x in tach_dong(a.input):
                for it in _fb_liet_ke_kenh(x, count, log=log):
                    if it["id"] not in seen:
                        seen.add(it["id"]); items.append(it)
            if not items:
                log("⚠ Facebook: không lấy được video nào từ Page (thử đăng nhập Facebook để ổn định hơn, hoặc thử lại sau).")
                print("YTDLP_DONE 0", flush=True)
                return
            urls = [it["url"] for it in items]
            thu_muc = os.path.join(base, "kenh", "%(uploader,channel,uploader_id)s")
            outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
            cong_viec.append((urls, outtmpl, None))   # đã giới hạn count khi liệt kê -> playlistend None
            log(f"📺 Tải theo kênh Facebook: {len(urls)} video")
        else:  # tt
            chan_urls = []
            for x in tach_dong(a.input):
                u = chuan_hoa_kenh_tiktok(x)
                if u:
                    chan_urls.append(u)
                else:
                    log(f"⚠ TikTok: không lấy được kênh từ '{x[:50]}' (thử lại, hoặc dán link 1 video của kênh).")
            if not chan_urls:
                log("⚠ TikTok: không có kênh hợp lệ để tải.")
                print("YTDLP_DONE 0", flush=True)
                return
            # TikTok: tải THẲNG url kênh (extract playlist non-flat) hay 0 video (anti-bot). Thay vì vậy:
            # LIỆT KÊ flat ra URL TỪNG VIDEO (đã chứng minh chạy) RỒI tải từng video như link (cũng đã chạy).
            from yt_dlp import YoutubeDL as _YDLf
            _tt_channel_logger = _TikTokChannelLogger(log_fn=log)
            _fo = {"extract_flat": "in_playlist", "skip_download": True, "playlistend": count,
                   "quiet": True, "no_warnings": True, "ignoreerrors": True, "nocheckcertificate": True,
                   "logger": _tt_channel_logger,   # đồng thời giữ ID trước khi yt-dlp lỗi secUid
                   "user_agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                                  "Chrome/131.0.0.0 Safari/537.36")}
            if cookies_file and os.path.isfile(cookies_file):
                _fo["cookiefile"] = cookies_file
            urls = []
            with _YDLf(_fo) as _yf:
                for cu in chan_urls:
                    _tt_channel_logger.set_url(cu)
                    try:
                        _info = _yf.extract_info(cu, download=False)
                    except Exception as e:
                        log(f"⚠ Liệt kê kênh TikTok lỗi: {str(e)[:100]}"); continue
                    for _e in ((_info or {}).get("entries") or []):
                        _vu = (_e or {}).get("url") or (_e or {}).get("webpage_url")
                        if _vu:
                            urls.append(_vu)
                        if len(urls) >= count:
                            break
            _seen_urls = set(urls)
            for _it in _tt_channel_logger.items(count):
                _vu = _it.get("url") or ""
                if _vu and _vu not in _seen_urls:
                    _seen_urls.add(_vu); urls.append(_vu)
                if len(urls) >= count:
                    break
            if _tt_channel_logger.ids:
                log("✔ TikTok: giữ lại %d video yt-dlp đã phát hiện trước khi lỗi secUid." %
                    min(len(_tt_channel_logger.ids), count))
            if not urls:
                log("ℹ yt-dlp không hoàn tất được thông tin kênh TikTok — chuyển sang fallback trình duyệt.")
                _seen_urls = set()
                for cu in chan_urls:
                    for _it in _tiktok_liet_ke_kenh_browser(cu, count - len(urls), log=log):
                        _vu = _it.get("url") or ""
                        if _vu and _vu not in _seen_urls:
                            _seen_urls.add(_vu); urls.append(_vu)
                        if len(urls) >= count:
                            break
                    if len(urls) >= count:
                        break
            if not urls:
                log("⚠ TikTok: cả yt-dlp và trình duyệt đều không liệt kê được video (kênh trống, riêng tư hoặc bị chặn).")
                print("YTDLP_DONE 0", flush=True)
                return
            thu_muc = os.path.join(base, "kenh", "%(channel,uploader,uploader_id)s")
            outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
            cong_viec.append((urls, outtmpl, None))   # đã giới hạn count khi liệt kê → playlistend None
            log(f"📺 Tải theo kênh TikTok: {len(urls)} video")

    else:  # detail
        # H11 SSRF: URL người dùng DÁN THÔ → lọc scheme http(s) + chặn loopback/private (file://, 127.0.0.1...).
        urls = [u for u in tach_dong(a.input) if _url_an_toan(u)]
        if not urls:
            log("⚠ Không có URL hợp lệ (chỉ nhận link http/https công khai; bỏ file:// và địa chỉ nội bộ).")
            print("YTDLP_DONE 0", flush=True)
            return
        # TikTok: rewrite /photo/->/video/ (extractor chỉ nhận /video/), và pre-check bài ẢNH
        # slideshow (không có format video) -> bỏ qua + báo rõ thay vì tải nhầm audio / "0 video" mơ hồ.
        if a.platform == "tt":
            from yt_dlp import YoutubeDL as _YDL
            pre_opts = {"skip_download": True, "quiet": True, "no_warnings": True,
                        "nocheckcertificate": True, "ignoreerrors": True,
                        "logger": _TikTokChannelLogger(log_fn=log),
                        "user_agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                                       "Chrome/131.0.0.0 Safari/537.36")}
            if cookies_file and os.path.isfile(cookies_file):
                pre_opts["cookiefile"] = cookies_file
            loc = []
            _tt_browser_bosot = []   # video yt-dlp CHỈ thấy audio (nhưng có duration = video THẬT) → fallback browser
            for u in urls:
                nu, la_photo = chuan_hoa_link_tiktok(u)
                # PRE-CHECK MỌI link (kể cả /video/): bài SLIDESHOW ẢNH của TikTok cũng có URL /video/<id>
                # (không chỉ /photo/) → KHÔNG có video stream → yt-dlp tải ra MP3/M4A (chỉ nhạc nền).
                # PHÂN BIỆT 2 ca "co_video=False": (a) SLIDESHOW ẢNH thật = KHÔNG có duration → bỏ; (b) VIDEO
                # THẬT mà TikTok chỉ trả audio cho yt-dlp (chống bot) = CÓ duration → fallback BROWSER (browser
                # lấy được bản video từ host webapp-prime; đã đo thật).
                co_video = False
                _dur = 0
                try:
                    with _YDL(pre_opts) as _y:
                        _info = _y.extract_info(nu, download=False)
                    co_video = bool(_info) and any(
                        (f.get("vcodec") or "none") != "none" for f in (_info.get("formats") or []))
                    _dur = (_info or {}).get("duration") or 0
                except Exception:
                    co_video = True   # pre-check lỗi (mạng/anti-bot) → THỬ tải (đừng bỏ oan video thật)
                if co_video:
                    loc.append(nu)
                else:
                    # co_video=False: THƯỜNG có 2 ca — (a) video thật bị TikTok chặn yt-dlp (hay có duration),
                    # (b) ảnh slideshow thật (hay KHÔNG duration). NHƯNG đo thật (khách báo "ảnh slideshow"
                    # oan cho link CÓ video thật, không tái hiện được từ máy dev — khác biệt theo IP/mạng máy
                    # khách): pre-check đôi khi KHÔNG thấy duration dù video thật. AN TOÀN HƠN: thử browser-
                    # fallback cho CẢ 2 ca thay vì bỏ hẳn khi thiếu duration — ảnh thật tự fail gọn ở
                    # _tai_tiktok_browser (không bắt được <video>, log rõ), video thật oan được cứu.
                    _mid = re.search(r"/video/(\d+)", nu)
                    _vid = _mid.group(1) if _mid else ""
                    _out = os.path.join(selected_storage_dir(), f"TikTok {_vid} [{_vid}].mp4")
                    _tt_browser_bosot.append((nu, _out))
            if not loc and not _tt_browser_bosot:
                log("⚠ Link TikTok là bài ẢNH (slideshow) — không có video để tải. "
                    "Tool chỉ tải VIDEO; hãy dùng link bài /video/.")
                print("YTDLP_DONE 0", flush=True)
                return
            # Video yt-dlp chỉ lấy được tiếng → tải VIDEO qua trình duyệt (chậm hơn nhưng lấy được bản video thật).
            if _tt_browser_bosot:
                log(f"🌐 {len(_tt_browser_bosot)} video TikTok yt-dlp chỉ lấy được tiếng — thử tải VIDEO qua trình duyệt (chậm hơn)…")
                _tt_url_by_id = {
                    (re.search(r"/video/(\d+)", _url).group(1) if re.search(r"/video/(\d+)", _url) else ""): _url
                    for _url, _out in _tt_browser_bosot
                }
                for _vid in _tai_tiktok_browser(_tt_browser_bosot, log_fn=log):
                    if _vid:
                        da_xong.add(_vid)
                        _ghi_lich_su({"id": _vid, "title": f"TikTok {_vid}",
                                      "webpage_url": _tt_url_by_id.get(_vid, "")})
            urls = loc
        if storage_type == "search":
            thu_muc = os.path.join(base, "tu-khoa", an_toan(storage_input or "khac"))
        elif storage_type == "creator":
            thu_muc = os.path.join(base, "kenh", "%(uploader,channel,uploader_id)s")
        elif storage_type == "bo":
            thu_muc = os.path.join(base, "bo", "%(playlist_title,playlist_id,playlist)s")
        else:
            thu_muc = os.path.join(base, "link")
        outtmpl = os.path.join(thu_muc, "%(title,uploader,id).80B [%(id)s].%(ext)s")
        cong_viec.append((urls, outtmpl, None))
        log(f"🔗 Tải theo link: {len(urls)} video")

    # ---- Thực thi ---- (finally: luôn dọn cookie phiên tạm, kể cả khi yt-dlp throw giữa chừng)
    try:
        for urls, outtmpl, pe in cong_viec:
            try:
                with YoutubeDL(opts_cho(outtmpl, pe)) as ydl:
                    ydl.download(urls)
            except Exception as e:
                log(f"⚠ Lỗi: {str(e)[:160]}")
            # FALLBACK BROWSER cho TikTok: video mà yt-dlp KHÔNG lấy được bản VIDEO (TikTok chỉ trả audio cho
            # yt-dlp → 'Requested format not available' → không vào da_xong). Rút id từ url, id nào CHƯA tải →
            # mở trình duyệt bắt URL video thật rồi tải. (Chỉ TikTok; các nền khác yt-dlp lấy đủ nên bỏ qua.)
            if a.platform == "tt":
                # FIX B3: fallback CŨ hardcode base/link cho MỌI mode → creator (video audio-only) lưu nhầm 'link'
                # thay vì base/kenh/<channel> → mất nhóm kênh + dedup glob soi 'link' không khớp bản trong kenh/ →
                # tải trùng. Creator → dùng ĐÚNG folder kênh yt-dlp vừa tạo (creator=1 kênh/lần → mtime mới nhất);
                # chưa có (mọi video audio-only) → lùi base/link. detail → base/link như cũ.
                if a.type == "creator":
                    _kd = os.path.join(base, "kenh")
                    try:
                        _subs = [os.path.join(_kd, d) for d in os.listdir(_kd) if os.path.isdir(os.path.join(_kd, d))] if os.path.isdir(_kd) else []
                        thu_muc_link = max(_subs, key=os.path.getmtime) if _subs else os.path.join(base, "link")
                    except OSError:
                        thu_muc_link = os.path.join(base, "link")
                else:
                    thu_muc_link = os.path.join(base, "link")
                os.makedirs(thu_muc_link, exist_ok=True)
                _bo_sot = []
                for _u in urls:
                    _mid = re.search(r"/video/(\d+)", _u)
                    _vid = _mid.group(1) if _mid else ""
                    if not _vid or _vid in da_xong or _vid in da_bo_qua:
                        continue
                    # đã có file [id] sẵn trên đĩa? → coi như xong (chống trùng, khỏi tải lại)
                    if glob.glob(os.path.join(thu_muc_link, f"*[[]{_vid}].mp4")) or glob.glob(os.path.join(thu_muc_link, f"*_{_vid}.mp4")):
                        continue
                    _out = os.path.join(thu_muc_link, f"TikTok {_vid} [{_vid}].mp4")
                    _bo_sot.append((_u, _out))
                if _bo_sot:
                    log(f"🌐 {len(_bo_sot)} video TikTok yt-dlp chỉ lấy được tiếng — thử tải VIDEO qua trình duyệt (chậm hơn)…")
                    _tt_url_by_id = {
                        (re.search(r"/video/(\d+)", _url).group(1) if re.search(r"/video/(\d+)", _url) else ""): _url
                        for _url, _out in _bo_sot
                    }
                    for _vid in _tai_tiktok_browser(_bo_sot, log_fn=log):
                        if _vid and _vid not in da_xong:
                            da_xong.add(_vid)
                            _ghi_lich_su({"id": _vid, "title": f"TikTok {_vid}",
                                          "webpage_url": _tt_url_by_id.get(_vid, "")})
    finally:
        _don_cookie_temp()

    # yt-dlp báo "finished" trước một số bước merge/post-process. Chỉ công nhận video khi file cuối
    # thực sự tồn tại, đủ lớn và có chữ ký container hợp lệ; nếu không thì gỡ archive để lần sau còn tải lại.
    for _vid, _info in list(_cho_kiem_tra.items()):
        if _tim_media_theo_id(_vid):
            _ghi_lich_su(_info)
        else:
            da_xong.discard(_vid)
            _xoa_archive_id(_vid)
            log(f"⚠ Không ghi nhận {_vid}: file media cuối không hợp lệ hoặc chưa được tạo xong.")

    # Báo TRUNG THỰC: nếu 0 video tải MỚI nhưng có video bị bỏ qua vì đã tải trước đó -> nói rõ (KHÔNG để
    # web_app tưởng nhầm anti-bot). YTDLP_DONE nhận thêm tham số thứ 2 = số video bỏ-qua (web_app cũ đọc [1] vẫn OK).
    if len(da_xong) == 0 and len(da_bo_qua) > 0:
        log(f"↩ Các video này ĐÃ TẢI TRƯỚC ĐÓ rồi ({len(da_bo_qua)} video) — không tải lại. "
            f"Muốn tải lại: xóa file cũ trong 'File đã tải' rồi cào lại.")
    else:
        log(f"✔ Hoàn tất. Tải được {len(da_xong)} video.")
    print(f"YTDLP_DONE {len(da_xong)} {len(da_bo_qua)}", flush=True)


if __name__ == "__main__":
    main()
