# -*- coding: utf-8 -*-
"""
Browser-first XHS / RedNote (xiaohongshu) — phục vụ học tập.

LÝ DO: API user_posted/feed của XHS gọi qua httpx bị CAPTCHA 461 (automation-detection + thiếu xsec_token
động), DÙ cookie + chữ ký GET hợp lệ (selfinfo/creator-info pass). Nhưng TRÌNH DUYỆT thật (Playwright,
cùng account/IP/profile) RENDER được trang kênh bình thường → account/IP KHÔNG bị chặn. Vì vậy chuyển nhánh
liệt-kê (và sau này tải) sang BROWSER-first: mở profile bằng Playwright (persistent context = profile đã
login), cuộn cho nạp hết card, parse DOM lấy note_id/title/cover — KHÔNG đụng endpoint bị 461.

Kiến trúc (sẵn cho phần B = tải video):
    XHSBrowser.open_profile(url)      -> mở trang kênh
    XHSBrowser.list_notes(max)        -> [A] cuộn-đến-ổn-định + parse DOM card  (DÙNG NGAY cho Xem-trước)
    XHSBrowser.open_note(note_id)     -> [B] mở trang note
    XHSBrowser.get_video_info()       -> [B] bắt URL video qua network (page.on response)

CLI (tim_anh.py gọi):
    python xhs_browser.py --action list --url <profile_url> --count 50 --intl 1 --profile <user_data_dir>
    -> in 1 dòng JSON: {"ok":true,"items":[{id,title,thumb,loai,video,so_anh,url,...}],"tong":N}
"""
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys

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


_NO_WIN = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW: app Electron KHÔNG có console →
                                                  # tiến trình con thiếu cờ tự BUNG cửa sổ đen (khách báo).

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# UA PHẢI khớp UA login (mo_dang_nhap = Windows Chrome 126) — XHS gắn phiên theo fingerprint UA.
WIN_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Regex note-id: XHS/RedNote đặt link note ở 3 dạng — /explore/<id>, /discovery/item/<id>, VÀ (mới, trên
# trang KÊNH) /user/profile/<uid>/<noteid>?xsec_token=... . Trước chỉ bắt 2 dạng đầu → trang kênh dạng mới
# ra 0 card (link video nằm dưới path /user/profile/<uid>/<noteid>). Segment 2 (noteid) ≥16 hex để KHÔNG
# nhầm link KÊNH /user/profile/<uid> (1 id). group1=explore/discovery, group2=note-in-profile.
_NOTE_RE = r"/(?:explore|discovery/item)/([0-9a-fA-F]+)|/user/profile/[0-9a-fA-F]+/([0-9a-fA-F]{16,})"


def _media_body_hop_le(response, body, video=True):
    """Không coi HTTP 200 là thành công nếu CDN trả HTML/JSON/rác mang đuôi MP4."""
    if not body or len(body) <= 10000:
        return False
    try:
        content_type = (response.headers.get("content-type") or "").lower()
    except Exception:
        content_type = ""
    if content_type.startswith(("text/", "application/json")):
        return False
    if video:
        return len(body) >= 12 and any(
            body[offset:offset + 4] in (b"ftyp", b"moov", b"free", b"skip", b"wide")
            for offset in (4, 8)
        )
    return True


def _ffbin(name):
    """Tìm ffmpeg/ffprobe: PATH trước, rồi winget (Gyan.FFmpeg) — máy khách hay cài qua winget."""
    p = shutil.which(name)
    if p:
        return p
    import glob
    for pat in (os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin\%s.exe" % name),):
        hit = glob.glob(pat)
        if hit:
            return hit[0]
    return name  # để subprocess tự báo lỗi nếu không có


def _sua_hevc_ve_h264(path, on_log=None):
    """Video XHS/RedNote cào theo KÊNH hay ở codec HEVC/H.265 → Chromium/Electron KHÔNG decode được →
    thumbnail + player trong app ra KHUNG ĐEN (chỉ có tiếng). File tải ĐÚNG, chỉ là codec app không hiện.
    Sau khi lưu: nếu là HEVC → transcode sang H.264 (ghi đè) để app hiện thumbnail/phát/render bình thường.
    H.264 giữ nguyên: bỏ qua. Lỗi transcode: giữ file gốc (KHÔNG mất video). Trả True nếu file dùng được."""
    _log = on_log or (lambda m: None)
    try:
        ffprobe = _ffbin("ffprobe")
        cp = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0",
                             "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
                            capture_output=True, text=True, timeout=30, creationflags=_NO_WIN)
        codec = (cp.stdout or "").strip().lower()
    except Exception:
        return True   # không probe được → cứ giữ file gốc
    if codec != "hevc":
        return True   # đã H.264 (hoặc khác) → không cần đụng
    ffmpeg = _ffbin("ffmpeg")
    tmp = path + ".h264.mp4"
    # nvenc (GPU) trước — nhanh (~10s/video 27s); máy không GPU → libx264 (CPU).
    for cv, extra in (("h264_nvenc", ["-preset", "p4", "-cq", "23"]),
                      ("libx264", ["-preset", "veryfast", "-crf", "20"])):
        try:
            r = subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", path,
                                "-c:v", cv] + extra + ["-c:a", "copy", "-movflags", "+faststart", tmp],
                               capture_output=True, text=True, timeout=600, creationflags=_NO_WIN)
            if r.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 10000:
                os.replace(tmp, path)   # ghi đè file gốc bằng bản H.264
                _log("  ↳ chuyển HEVC→H.264 (%s) để app hiện được" % cv)
                return True
        except Exception:
            pass
        finally:
            if os.path.isfile(tmp):
                try:
                    os.remove(tmp)
                except Exception:
                    pass
    _log("  ↳ (giữ bản HEVC — transcode H.264 thất bại)")
    return True   # transcode fail → giữ file HEVC gốc, KHÔNG mất video

# Đếm số card hiện có (để biết cuộn đã nạp thêm chưa). Regex TRUYỀN QUA THAM SỐ (new RegExp) — KHÔNG
# nhúng vào /.../ literal (dấu '/' trong 'discovery/item' + '{16,}' phá literal → SyntaxError, ra 0 card).
_CNT_JS = r"""(re) => { const R=new RegExp(re); return new Set([...document.querySelectorAll('a')]
    .map(a => { const m=(a.href||'').match(R); return m ? (m[1]||m[2]) : null; })
    .filter(Boolean)).size; }"""

# Parse card -> item theo SHAPE preview của tim_anh (_item_xhs): id,title,thumb,loai,video,so_anh,url,...
_PARSE_JS = r"""(re) => {
  const NOTE_RE = new RegExp(re);
  const out = [], seen = new Map();   // id -> index trong out (để NÂNG CẤP link nếu gặp bản CÓ token sau)
  const links = [...document.querySelectorAll('a')].filter(a => NOTE_RE.test(a.href||''));
  for (const a of links) {
    const m = (a.href||'').match(NOTE_RE);
    if (!m) continue;
    const id = m[1] || m[2]; if (!id) continue;
    // RedNote render link card token LƯỜI: cùng 1 note có nhiều <a>, ĐA SỐ href THIẾU ?xsec_token, chỉ vài
    // cái CÓ. Lấy cái đầu (dòng cũ) → hay dính bản THIẾU token → tải video fail (300017). → nếu note đã thấy
    // MÀ href cũ thiếu token, href mới CÓ token → NÂNG CẤP link (giữ token, bắt buộc để mở note + tải).
    if (seen.has(id)) {
      const idx = seen.get(id);
      const cur = out[idx];
      if (cur && !/xsec_token=/.test(cur.link || '') && /xsec_token=/.test(a.href || '')) {
        cur.link = a.href;   // nâng cấp: bản có token thắng
        cur.url = (a.href || '').split('?')[0];
      }
      continue;
    }
    seen.set(id, out.length);
    const card = a.closest('section, div') || a;
    const img = card.querySelector('img');
    let title = '';
    const tEl = card.querySelector('.title, [class*="title"], footer span, footer');
    if (tEl) title = (tEl.textContent || '').trim();
    if (!title) { const im = card.querySelector('img[alt]'); if (im) title = im.alt || ''; }
    const isVid = !!card.querySelector('[class*="play"], .play-icon, video');
    out.push({
      id: id,
      title: (title || '').slice(0, 160),
      thumb: (img && (img.src || img.getAttribute('data-src'))) || '',
      loai: isVid ? 'video' : 'anh',
      video: isVid,
      so_anh: 0,
      url: (a.href || '').split('?')[0],
      link: (a.href || ''),     // GIỮ ?xsec_token — BẮT BUỘC để mở note + tải video (né 461)
      like: '', time: 0, nick: '', user_id: '', avatar: ''
    });
  }
  return out;
}"""

# Trang đòi đăng nhập / chặn (để báo RÕ thay vì "0 bài").
# GỒM CẢ tiếng Anh của rednote.com (quốc tế) — trước đây chỉ dò tiếng Trung nên rednote.com hiện
# "Log in to view this user's notes" mà can_login() KHÔNG bắt được → list ra 0 card → báo NHẦM
# "vẫn đăng nhập, 0 video do anti-bot". Chuỗi tiếng Anh lấy từ DOM thật trang kênh rednote khi cookie hết hạn.
_LOGIN_HINT = ("请登录", "登录后查看", "扫码登录", "登录小红书",
               "Log in to view", "to view this user's notes", "Scan QR code with rednote",
               "Log in with phone")


class XHSBrowser:
    """Phiên trình duyệt tái dùng cho XHS/RedNote (persistent context = profile đã login)."""

    def __init__(self, profile_dir, intl=True, headless=True, ua=WIN_UA):
        self.profile_dir = profile_dir
        self.intl = intl
        self.headless = headless
        self.ua = ua
        self.domain = "https://www.rednote.com" if intl else "https://www.xiaohongshu.com"
        self._pw = None
        self.ctx = None
        self.page = None

    async def __aenter__(self):
        from playwright.async_api import async_playwright
        self._pw = await async_playwright().start()
        self.ctx = await self._pw.chromium.launch_persistent_context(
            self.profile_dir,
            headless=self.headless,
            user_agent=self.ua,
            viewport={"width": 1280, "height": 900},
            args=["--hide-crash-restore-bubble", "--no-first-run",
                  "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
        )
        # STEALTH: nạp libs/stealth.min.js (che dấu vết automation: navigator.webdriver, plugins, chrome runtime…)
        # GIỐNG MediaCrawler bản gốc (core.py add_init_script stealth) — thiếu bước này XHS/RedNote phát hiện
        # automation → note GATED (300017) / 0 video dù list được. Đây là KHÁC BIỆT khiến bản ta cào 0 video.
        try:
            _stealth = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "MediaCrawler", "libs", "stealth.min.js")
            if os.path.isfile(_stealth):
                await self.ctx.add_init_script(path=_stealth)
        except Exception:
            pass
        self.page = self.ctx.pages[0] if self.ctx.pages else await self.ctx.new_page()
        return self

    async def __aexit__(self, *a):
        for fn in (lambda: self.ctx.close(), lambda: self._pw.stop()):
            try:
                await fn()
            except Exception:
                pass

    async def open_profile(self, url):
        # XHS TÁCH 2 nền: intl=1 (RedNote quốc tế, profile rednote) → mở rednote.com; intl=0 (Xiaohongshu nội
        # địa, profile xhs) → GIỮ xiaohongshu.com. Khi RedNote: link xiaohongshu.com phải đổi domain sang
        # rednote.com để khớp profile đã login (goto xiaohongshu bằng profile rednote → đòi login → 0 note).
        if self.intl and "xiaohongshu.com" in (url or ""):
            url = url.replace("xiaohongshu.com", "rednote.com")
        elif (not self.intl) and "rednote.com" in (url or ""):
            url = url.replace("rednote.com", "xiaohongshu.com")   # Xiaohongshu nội địa: link rednote → xiaohongshu
        await self.page.goto(url, wait_until="domcontentloaded", timeout=60000)
        await self.page.wait_for_timeout(3000)

    async def can_login(self):
        """Trang có đang đòi đăng nhập không (cookie hết hạn)."""
        try:
            body = (await self.page.inner_text("body"))[:4000]
        except Exception:
            return False
        return any(h in body for h in _LOGIN_HINT)

    async def list_notes(self, max_count=50, max_rounds=40, on_log=None):
        """[A] Cuộn-đến-cạn rồi trả note. XHS VIRTUALIZE feed (card ngoài viewport bị UNMOUNT khỏi DOM —
        đã đo: in_dom tụt 21→10 trong khi union tăng) → PHẢI GOM item qua TỪNG vòng cuộn (union theo id),
        KHÔNG parse-1-lần (chỉ được ~10 card đang mount). Dừng khi union KHÔNG tăng `idle` vòng liên tiếp.

        🐛 on_log (user báo "phần xem trước lấy token bị TREO"): hàm này cuộn tới `max_rounds`=40 vòng, mỗi
        vòng `wait_for_timeout(2000)` ⇒ tối thiểu ~80 GIÂY, cộng thời gian nạp trang — mà TRƯỚC ĐÂY nó không
        phát một dòng nào (khác `cao_lien_mach`/`tai_links` vốn đã có on_log). Người dùng thấy app đứng im
        hàng phút và tưởng hỏng. Nay báo tiến trình mỗi vòng."""
        _log = on_log or (lambda m: None)
        acc = {}          # id -> item (tích lũy xuyên suốt, chống virtualization)
        idle = 0
        for _vong in range(max_rounds):
            try:
                items = await self.page.evaluate(_PARSE_JS, _NOTE_RE)
            except Exception:
                items = []
            before = len(acc)
            for it in items:
                _id = it.get("id")
                if _id and _id not in acc:
                    acc[_id] = it
            if len(acc) != before or _vong % 4 == 0:   # có thêm video, hoặc mỗi 4 vòng → báo còn sống
                _log("  … đang cuộn trang kênh: thấy %d video (vòng %d/%d)" % (len(acc), _vong + 1, max_rounds))
            if len(acc) >= max_count:
                break
            if len(acc) == before:
                idle += 1
                if idle >= 4:          # union không tăng 4 vòng = đã cạn (hết phân trang)
                    _log("  … không thêm video mới 4 vòng liên tiếp → coi như đã hết trang.")
                    break
            else:
                idle = 0
            # Trigger nạp trang kế: kéo CARD CUỐI vào viewport (IntersectionObserver) + window bottom + End.
            # Card cuối = link note khớp _NOTE_RE (KHÔNG hardcode '/explore/' — trang KÊNH dùng /user/profile/<uid>/<nid>
            # → selector cũ tìm 0 phần tử → không cuộn được → chỉ parse trang đầu).
            try:
                await self.page.evaluate(
                    "(re) => { const R=new RegExp(re);"
                    " const ls=[...document.querySelectorAll('a')].filter(a=>R.test(a.href||''));"
                    " if(ls.length) ls[ls.length-1].scrollIntoView({block:'end'});"
                    " window.scrollTo(0, document.documentElement.scrollHeight); }", _NOTE_RE)
                await self.page.keyboard.press("End")
            except Exception:
                pass
            await self.page.wait_for_timeout(2000)
        return list(acc.values())[:max_count]

    # ---------- B-ready (chưa wire vào UI) ----------
    async def open_note(self, note_id):
        """[B] Mở trang chi tiết note (để trích URL video). Chưa dùng ở Commit A."""
        await self.page.goto(f"{self.domain}/explore/{note_id}", wait_until="domcontentloaded", timeout=60000)
        await self.page.wait_for_timeout(2500)

    async def get_video_info(self, timeout_ms=8000):
        """[B] Bắt URL video/m3u8 qua network sau open_note (browser đã giải challenge → request đủ token).
        Chưa dùng ở Commit A — để sẵn cho phần tải."""
        hits = []
        self.page.on("response", lambda r: hits.append(r.url)
                     if any(k in r.url for k in (".mp4", ".m3u8", "sns-video", "/stream/")) else None)
        await self.page.wait_for_timeout(timeout_ms)
        return hits

    async def download_note(self, note_id, out_path, url=None, wait_ms=8000):
        """[B] TẢI video 1 note QUA BROWSER: mở /explore/<id> → bắt URL .mp4 từ network (listener đăng
        TRƯỚC goto) → tải bằng `ctx.request` (mang cookie/headers của browser thật → né 461 như preview).
        Trả True nếu lưu được file > 10KB. KHÔNG đụng API ký (x-s/x-t) → không vi phạm 'no reverse-signature'."""
        vids = []

        def _on(r):
            u = r.url
            if (".mp4" in u or "sns-video" in u) and ".m3u8" not in u:
                vids.append(u)

        self.page.on("response", _on)
        try:
            await self.page.goto(url or f"{self.domain}/explore/{note_id}", wait_until="domcontentloaded", timeout=60000)
            await self.page.wait_for_timeout(wait_ms)
            try:   # ép phát (muted) → 1 số note chỉ tải video khi play
                await self.page.evaluate(
                    "() => { const v=document.querySelector('video'); if(v){v.muted=true; v.play().catch(()=>{});} }")
                await self.page.wait_for_timeout(3500)
            except Exception:
                pass
        finally:
            try:
                self.page.remove_listener("response", _on)
            except Exception:
                pass
        urls = [u for u in vids if ".mp4" in u] or vids
        for u in dict.fromkeys(urls):   # khử trùng giữ thứ tự; thử tới khi tải được
            try:
                resp = await self.ctx.request.get(u, timeout=120000)
                if not resp.ok:
                    continue
                body = await resp.body()
                if _media_body_hop_le(resp, body):
                    with open(out_path, "wb") as f:
                        f.write(body)
                    _sua_hevc_ve_h264(out_path)   # HEVC→H.264 để app hiện thumbnail/phát được
                    return True
            except Exception:
                continue
        return False

    async def _save_mp4(self, vids, out_path):
        """Từ danh sách URL bắt được → tải qua ctx.request (cookie/headers browser thật) → lưu file >10KB."""
        urls = [u for u in vids if ".mp4" in u] or list(vids)
        for u in dict.fromkeys(urls):
            try:
                resp = await self.ctx.request.get(u, timeout=120000)
                if not resp.ok:
                    continue
                body = await resp.body()
                if _media_body_hop_le(resp, body):
                    with open(out_path, "wb") as f:
                        f.write(body)
                    _sua_hevc_ve_h264(out_path)   # HEVC→H.264 để app hiện thumbnail/phát được
                    return True
            except Exception:
                continue
        return False

    # Selector link CARD có SẴN xsec_token trên trang kênh (KHÔNG phải cover img, KHÔNG phải link nid trần).
    # Session gốc đã tải được ĐÚNG bằng cách click thẻ này: /user/profile/<uid>/<nid>?...xsec_token=... hoặc
    # /explore/<id>?...xsec_token=... . Click chuột thật → SPA nav → /explore/?xsec_token=<MỚI> → bắt mp4.
    _CARD_SEL = 'a[href*="xsec_token"]'

    async def _explore_url_cua_card(self, idx):
        """Click card thứ idx (chuột thật) → trả /explore/<id>?xsec_token=<MỚI> (token note hợp lệ) hoặc ''.
        Card virtualized → scroll tới. KHÔNG JS click. Sau lấy URL, quay lại trang kênh (caller lo)."""
        cards = self.page.locator(self._CARD_SEL)
        if idx >= await cards.count():
            return ""
        try:
            card = cards.nth(idx)
            await card.scroll_into_view_if_needed(timeout=10000)
            await self.page.wait_for_timeout(400)
            await card.click(timeout=10000)   # CHUỘT THẬT (không JS) — mở note SPA đúng cách
        except Exception:
            return ""
        for _ in range(15):
            if "/explore/" in self.page.url and "xsec_token=" in self.page.url:
                return self.page.url
            await self.page.wait_for_timeout(600)
        return ""

    async def _tai_explore_url(self, explore_url, out_path):
        """Mở /explore/?xsec_token ở TAB MỚI (token note hợp lệ → mở lại được) → bắt .mp4 → tải. Đóng tab.
        Tách tab riêng → KHÔNG phá DOM trang kênh (tránh re-index khi click card kế)."""
        vids = []
        p2 = await self.ctx.new_page()
        p2.on("response", lambda r: vids.append(r.url)
              if ((".mp4" in r.url or "sns-video" in r.url) and ".m3u8" not in r.url) else None)
        try:
            await p2.goto(explore_url, wait_until="domcontentloaded", timeout=60000)
            await p2.wait_for_timeout(3500)
            try:
                await p2.evaluate("()=>{const v=document.querySelector('video');if(v){v.muted=true;"
                                  "v.play().catch(()=>{});if(v.currentSrc)window.__vsrc=v.currentSrc;}}")
                await p2.wait_for_timeout(3500)
            except Exception:
                pass
            try:
                _cs = await p2.evaluate("()=>window.__vsrc||''")
                if _cs and ".mp4" in _cs:
                    vids.append(_cs)
            except Exception:
                pass
            # tải bằng ctx.request (mang cookie/headers browser thật)
            urls = [u for u in vids if ".mp4" in u] or list(vids)
            for u in dict.fromkeys(urls):
                try:
                    resp = await self.ctx.request.get(u, timeout=120000)
                    if resp.ok:
                        body = await resp.body()
                        if _media_body_hop_le(resp, body):
                            with open(out_path, "wb") as f:
                                f.write(body)
                            _sua_hevc_ve_h264(out_path)   # HEVC→H.264 để app hiện thumbnail/phát được
                            return True
                except Exception:
                    continue
            return False
        finally:
            try:
                await p2.close()
            except Exception:
                pass

    async def cho_login(self, cho_giay=180):
        """Chờ user QUÉT QR đăng nhập NGAY trong phiên đang mở (poll body tới khi hết đòi login).
        Trả True nếu login xong. MẤU CHỐT (session gốc): token note chỉ 'nóng' khi login trong CÙNG phiên
        rồi click NGAY — mở phiên mới từ profile lưu = token 'nguội' → click note ra 300017/404."""
        for _ in range(int(cho_giay / 2)):
            if not await self.can_login():
                await self.page.wait_for_timeout(1500)   # settle sau login
                return True
            await self.page.wait_for_timeout(2000)
        return not await self.can_login()

    async def tai_theo_links(self, links, out_dir, on_log=None):
        """[B4] TẢI các note theo DANH SÁCH LINK (href card có xsec_token, từ preview). Mở TỪNG href ở TAB MỚI
        → RedNote tự redirect /explore/<id>?xsec_token → bắt .mp4 → tải. KHÔNG list lại kênh (đã có link từ
        bước 'xem trước & chọn'). Trả {ok, tai:[nid], loi:[...]}. Phải gọi SAU khi profile đã login."""
        import re as _re
        _log = on_log or (lambda m: None)
        os.makedirs(out_dir, exist_ok=True)
        tai, loi = [], []
        for href in links:
            m = _re.search(r"/(?:explore|discovery/item)/([0-9a-fA-F]+)|/user/profile/[0-9a-fA-F]+/([0-9a-fA-F]{16,})", href or "")
            nid = (m.group(1) or m.group(2)) if m else ""
            if not nid:
                loi.append(href[:30]); _log("  ✗ (link không hợp lệ)"); continue
            out = os.path.join(out_dir, nid + ".mp4")
            try:
                ok = await self._tai_explore_url(href, out)
            except Exception:
                ok = False
            (tai if ok else loi).append(nid)
            _log("  %s %s" % ("✔" if ok else "✗", nid))
        return {"ok": len(tai) > 0, "tai": tai, "loi": loi,
                "msg": "Tải %d/%d video XHS/RedNote (theo link đã chọn)" % (len(tai), len(links))}

    async def cao_lien_mach(self, url, out_dir, max_count=50, cho_login_giay=180, on_log=None):
        """[B3] Cào creator XHS/RedNote — CÁCH BỀN NHẤT (0 click, 0 re-index):
        1) mở kênh → (đòi login → chờ QR) → list (cuộn nạp card) → GOM HẾT href card /user/profile/<uid>/<nid>?xsec_token
           (link kênh CÓ token, lấy 1 lượt từ DOM — KHÔNG click nên KHÔNG re-index).
        2) mở TỪNG href ở TAB MỚI → RedNote TỰ redirect sang /explore/<id>?xsec_token=<hợp lệ> → bắt .mp4 → tải.
        (Test thật: href kênh mở tab mới → /explore/ + 14 mp4 request. KHÁC goto /explore/ ghép-token-kênh → 300017.)
        Trả {ok, tai:[note_id], loi:[...]}. on_log(str) báo tiến trình."""
        import re as _re
        _log = on_log or (lambda m: None)
        await self.open_profile(url)
        if await self.can_login():
            _log("Cần đăng nhập — hãy QUÉT MÃ QR trong cửa sổ vừa mở.")
            if not await self.cho_login(cho_login_giay):
                return {"ok": False, "tai": [], "loi": [], "msg": "Chưa đăng nhập (hết giờ chờ quét QR)."}
            _log("Đăng nhập OK — bắt đầu cào.")
        # BUG THẬT (user báo cào creator chỉ được ~10/50 video): trước đây gọi list_notes() rồi VỨT kết quả,
        # sau đó re-query DOM SỐNG (document.querySelectorAll) — nhưng XHS VIRTUALIZE feed (card ngoài viewport
        # bị UNMOUNT) nên DOM chỉ còn ~10 card → mất phần lớn video ÂM THẦM. list_notes ĐÃ tích lũy union đầy đủ
        # xuyên các vòng cuộn (chống virtualize) — DÙNG kết quả đó, KHÔNG re-query DOM.
        _notes = await self.list_notes(max_count=max_count)   # cuộn nạp + GOM union (chống virtualize)
        os.makedirs(out_dir, exist_ok=True)
        # GOM (id, link) từ union — chỉ giữ note CÓ xsec_token (link tải được). Giữ THỨ TỰ + khử trùng theo id.
        pairs, _seen = [], set()
        for _it in _notes:
            _id = _it.get("id"); _link = _it.get("link") or ""
            if not _id or _id in _seen or "xsec_token=" not in _link:
                continue
            _seen.add(_id)
            pairs.append([_id, _link])
        _n = min(len(pairs), max_count)
        _log("Thấy %d bài có video (link+token) — đang tải…" % _n)
        tai, loi = [], []
        for i in range(_n):
            nid, href = pairs[i]
            out = os.path.join(out_dir, nid + ".mp4")
            try:
                ok = await self._tai_explore_url(href, out)   # mở href ở TAB MỚI → /explore/ → tải
            except Exception:
                ok = False
            (tai if ok else loi).append(nid)
            _log("  %s %s" % ("✔" if ok else "✗", nid))
        return {"ok": len(tai) > 0, "tai": tai, "loi": loi,
                "msg": "Tải %d/%d video XHS/RedNote" % (len(tai), _n)}


def _resolve_profile(args):
    if args.profile:
        return args.profile
    bd = os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "MediaCrawler", "browser_data")
    leaf = os.environ.get("MC_XHS_PROFILE") or ("rednote_user_data_dir" if args.intl == "1" else "xhs_user_data_dir")
    return os.path.join(bd, leaf)


async def _run(args):
    profile = _resolve_profile(args)
    if not os.path.isdir(profile):
        return {"ok": False, "msg": "Chưa có hồ sơ đăng nhập (profile) cho nền tảng này — hãy ĐĂNG NHẬP trước."}
    try:
        async with XHSBrowser(profile, intl=(args.intl == "1"), headless=(args.headless != "no")) as b:
            if args.action == "download":   # TẢI video qua browser (mỗi id 1 file) — KHÔNG cần open_profile
                ids = [x.strip() for x in (args.ids or "").split(",") if x.strip()]
                os.makedirs(args.out_dir, exist_ok=True)
                tai, loi = [], []
                for nid in ids:
                    out = os.path.join(args.out_dir, nid + ".mp4")
                    try:
                        ok = await b.download_note(nid, out)
                    except Exception:
                        ok = False
                    (tai if ok else loi).append(nid)
                return {"ok": len(tai) > 0, "tai": tai, "loi": loi,
                        "msg": "Tải %d/%d video qua browser" % (len(tai), len(ids))}
            if args.action == "cao_lien_mach":
                # Cào creator: mở kênh → (chờ QR) → gom href card → mở tab mới tải hết.
                return await b.cao_lien_mach(args.url, args.out_dir, max_count=int(args.count or 50),
                                             on_log=lambda m: print("LOG:" + m, flush=True))
            if args.action == "tai_links":
                # TẢI các note theo LINK đã chọn (từ 'xem trước & chọn'). --links = href phân tách bằng '|'.
                links = [x.strip() for x in (args.links or "").split("|") if x.strip()]
                if not links:
                    return {"ok": False, "msg": "Không có link nào."}
                return await b.tai_theo_links(links, args.out_dir,
                                              on_log=lambda m: print("LOG:" + m, flush=True))
            # 2 bước dưới (nạp trang kênh + kiểm đăng nhập) cũng tốn vài giây tới vài chục giây và TRƯỚC ĐÂY
            # im lặng — góp vào cảm giác "treo". Báo rõ từng bước.
            _plog = lambda m: print("LOG:" + m, flush=True)   # noqa: E731
            _plog("  … đang mở trang kênh trong trình duyệt…")
            await b.open_profile(args.url)
            _plog("  … đã mở trang, đang kiểm tra phiên đăng nhập…")
            # 🔴 01/08/2026 (khách: "tôi đăng nhập rồi vẫn bị"): TRƯỚC ĐÂY hễ `can_login()` thấy dấu hiệu
            # tường-đăng-nhập là KẾT LUẬN LUÔN "phiên hết hạn" rồi thoát — CHƯA HỀ thử lấy dữ liệu. Nhưng
            # RedNote/XHS thường bật popup mời đăng nhập ĐÈ LÊN trang dù phiên VẪN SỐNG (xem
            # [[rednote-login-wall-tieng-anh-canlogin-mu]]) ⇒ khách bị đuổi đi đăng nhập lại, làm xong
            # KHÔNG đổi gì, mất niềm tin vào tool. Cùng họ lỗi "đoán nguyên nhân thay vì kiểm thật" đã sửa
            # ở chan_doan_loi.co_vc_runtime hôm nay.
            # NAY: thấy tường thì GHI NHẬN thôi, cứ THỬ LẤY DỮ LIỆU trước — lấy được = phiên còn sống.
            # Chỉ khi lấy về RỖNG mới kết luận hết hạn (và nói rõ đã thử).
            _tuong_login = await b.can_login()
            if _tuong_login:
                _plog("  ⚠ Thấy popup/tường đăng nhập — vẫn THỬ lấy dữ liệu trước khi kết luận…")
            if args.action == "list":
                items = await b.list_notes(max_count=int(args.count or 50), on_log=_plog)
                if _tuong_login and not items:
                    return {"ok": False, "msg": "Phiên đăng nhập đã hết hạn — hãy ĐĂNG NHẬP LẠI nền tảng rồi "
                                                "thử lại. (Đã thử đọc danh sách bài nhưng không lấy được bài nào.)"}
                # TÊN KÊNH: để web_app đặt folder `<nick>_<uid 8 cuối>` GIỐNG HỆT đường API (`_xhs_media_parts`).
                # Không lấy được nick thì web_app tự lùi về uid — xem `_xhs_tai_links_worker`.
                _nick = ""
                try:
                    _nick = (await b.page.evaluate(
                        "() => (document.querySelector('.user-name, .user-nickname, [class*=nickname]')"
                        " || {}).textContent || ''") or "").strip()[:40]
                except Exception:
                    _nick = ""
                return {"ok": True, "items": items, "tong": len(items), "nick": _nick}
            if args.action == "download_profile":
                # TẢI video từ trang kênh: mở link note (có xsec_token) ở tab mới → /explore/ → tải (né 300017).
                # BUG THẬT: trước đây gọi b.download_from_profile(nid, out) — method KHÔNG TỒN TẠI trong class →
                # mọi note rơi vào except → 0 video, báo "Tải 0/N". Fix: list_notes trả item có 'link' (đã token-
                # hóa) → dùng _tai_explore_url(link, out) (method CÓ THẬT, dòng ~358). ids lọc theo id nếu chỉ định.
                _want = set(x.strip() for x in (args.ids or "").split(",") if x.strip())
                items = await b.list_notes(max_count=int(args.count or 50))
                _cands = [it for it in items if it.get("id") and it.get("link")
                          and (not _want or it.get("id") in _want)]
                os.makedirs(args.out_dir, exist_ok=True)
                tai, loi = [], []
                for it in _cands:
                    nid, link = it["id"], it["link"]
                    out = os.path.join(args.out_dir, nid + ".mp4")
                    try:
                        ok = await b._tai_explore_url(link, out)
                    except Exception:
                        ok = False
                    (tai if ok else loi).append(nid)
                return {"ok": len(tai) > 0, "tai": tai, "loi": loi,
                        "msg": "Tải %d/%d video (trang kênh)" % (len(tai), len(_cands))}
            return {"ok": False, "msg": "Hành động chưa hỗ trợ: " + str(args.action)}
    except Exception as e:
        return {"ok": False, "msg": "Lỗi mở trình duyệt: " + str(e)[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--action", default="list")     # list (A) | download (B: tải video qua browser)
    ap.add_argument("--url", default="")             # link trang kênh (creator) — cho action=list
    ap.add_argument("--count", default="50")
    ap.add_argument("--intl", default="1")           # 1=rednote.com, 0=xiaohongshu.com
    ap.add_argument("--headless", default="yes")
    ap.add_argument("--profile", default="")         # user_data_dir; rỗng -> suy từ env
    ap.add_argument("--ids", default="")             # action=download: note_id phân tách dấu phẩy
    ap.add_argument("--links", default="")           # action=tai_links: href note (có token) phân tách bằng '|'
    ap.add_argument("--out-dir", dest="out_dir", default="")  # thư mục lưu .mp4
    args = ap.parse_args()
    if args.action == "download":
        if not args.ids.strip() or not args.out_dir.strip():
            print(json.dumps({"ok": False, "msg": "download cần --ids và --out-dir."}, ensure_ascii=False)); return
    elif args.action == "tai_links":
        if not args.links.strip() or not args.out_dir.strip():
            print(json.dumps({"ok": False, "msg": "tai_links cần --links và --out-dir."}, ensure_ascii=False)); return
    elif not args.url.strip():
        print(json.dumps({"ok": False, "msg": "Chưa nhập link kênh."}, ensure_ascii=False))
        return
    try:
        res = asyncio.run(_run(args))
    except Exception as e:
        res = {"ok": False, "msg": "Lỗi: " + str(e)[:200]}
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
