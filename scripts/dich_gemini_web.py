# -*- coding: utf-8 -*-
"""Tự động dịch zh.srt -> vi.srt qua GEMINI WEB (Playwright, profile đăng nhập sẵn).
Ý chính: KHÔNG bắt Gemini xuất SRT (nó hay làm hỏng format). Gửi CÁC DÒNG CHỮ đánh số → lấy bản dịch
→ TOOL tự GHÉP lại timestamp GỐC + chữ dịch thành vi.srt. Profile persistent: login Gemini 1 lần.
Dùng: python dich_gemini_web.py --srt video.zh.srt --out video.vi.srt --show
"""
import os, sys, time, argparse, re, contextlib

# Windows console mặc định cp1258 (locale VN) → print() log chứa chữ Trung/emoji/ký tự lạ do Gemini trả về
# gây UnicodeEncodeError (charmap_encode) → subprocess DỊCH CHẾT giữa chừng → 0 câu → mất phụ đề+lồng tiếng.
# Ép stdout/stderr UTF-8 errors=replace để log KHÔNG BAO GIỜ làm sập tiến trình dịch.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 🐛 TỰ TRỎ Chromium về runtime/ms-playwright khi app spawn THIẾU env PLAYWRIGHT_BROWSERS_PATH.
# ĐÂY LÀ NGUYÊN NHÂN SỐ 1 KHIẾN "DỊCH LỖI" TRÊN MÁY KHÁCH (đã ghi nhận thật, xem memory
# khach-che-sub-sai-va-khong-dich-viet): app cài ngoài ổ C / relaunch sau update truyền env tối thiểu →
# Playwright dùng default %LOCALAPPDATA%\ms-playwright → "Executable doesn't exist chrome.exe" → Gemini
# KHÔNG mở được trình duyệt → 0 câu dịch → phụ đề trống (hoặc giữ chữ Trung).
# `mo_dang_nhap.py` ĐÃ có đoạn này từ lâu; file DỊCH thì KHÔNG — nên cửa sổ đăng nhập mở được mà dịch vẫn
# hỏng. (Memory ghi fix đã áp cho file này, nhưng kiểm tra lại thấy 0 lần xuất hiện → fix bị mất/chưa từng
# vào. Nay khôi phục.) venv chạy ở userData\viralcrawl-desktop\runtime\venv → ms-playwright nằm CẠNH venv
# (…\runtime\ms-playwright); suy từ sys.executable nên KHÔNG phụ thuộc env truyền vào.
if not (os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip():
    try:
        _venv_dir = os.path.dirname(os.path.dirname(os.path.abspath(sys.executable)))  # …\runtime\venv
        _bp = os.path.join(os.path.dirname(_venv_dir), "ms-playwright")                # …\runtime\ms-playwright
        if os.path.isdir(_bp):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = _bp
    except Exception:
        pass


def doc_srt(path):
    """[(timestamp_line, text)] theo thứ tự."""
    segs = []
    for b in re.split(r"\n\s*\n", open(path, encoding="utf-8").read().strip()):
        lines = [x for x in b.strip().split("\n") if x.strip()]
        if len(lines) >= 3 and "-->" in lines[1]:
            segs.append((lines[1].strip(), " ".join(lines[2:]).strip()))
    return segs


def _ty_le_han(s):
    """Tỉ lệ ký tự chữ HÁN (CJK) trong chuỗi (0..1). Dùng phát hiện dòng CHƯA DỊCH (Gemini trả gần-nguyên
    văn Hán, chỉ khác dấu câu/khoảng trắng nên né được so sánh tuyệt đối == zh gốc). Bản sao _ty_le_han
    trong localize.py (không import chéo — file này gọi độc lập qua subprocess)."""
    s = (s or "").strip()
    if not s:
        return 0.0
    han = sum(1 for c in s if "一" <= c <= "鿿" or "㐀" <= c <= "䶿")
    tong = sum(1 for c in s if not c.isspace())
    return (han / tong) if tong else 0.0


_RE_AM = re.compile(r"[一-鿿㐀-䶿぀-ヿ]")   # 1 ký tự CJK/kana ≈ 1 ÂM TIẾT khi đọc


def tran_tu_dich(giay, nguon, wps_max=5.0, ti_le=0.75):
    """TRẦN SỐ TỪ cho bản dịch tiếng Việt của 1 cue = min(trần VẬT LÝ, trần THEO NGUỒN).

    Vì sao KHÔNG dùng hằng số từ/giây (bản trước đặt cứng 3.5 — ĐO THẬT cho thấy sai):
        SRT anime (thoại ngắn)      : nguồn 4.1 âm/giây → dịch 2.8 từ/giây → chỉ 21% cue vượt trần
        SRT thuyết minh phim Trung  : nguồn 7.5 âm/giây → dịch 5.9 từ/giây → 88% cue vượt trần
    Mật độ nói của 2 loại video chênh gần GẤP ĐÔI, nên một ngưỡng cứng áp cho mọi video chắc chắn sai một
    trong hai phía: lỏng quá với video thưa, hoặc siết quá với video dày (ép cắt mất nội dung — phạm đúng
    yêu cầu "ít chữ nhưng ĐỦ NGHĨA").

    Hai trần:
      • VẬT LÝ  `giây × wps_max` — mức TTS tiếng Việt đọc được mà chưa phải tăng tốc nhiều (~5 âm tiết/giây).
        Vượt mức này thì dù dịch hay cỡ nào, giọng vẫn bị ép nhanh → méo (đúng lỗi khách báo).
      • THEO NGUỒN `số_âm_tiết_gốc × ti_le` — bám chính mật độ của video đó. ti_le=0.75 lấy từ ĐO THẬT: Gemini
        đang tự nén còn 0.70–0.79× số âm gốc ở CẢ HAI loại video ⇒ 0.75 là mức nó GIỮ ĐƯỢC nghĩa, không bịa ra.
    Lấy `min` → video thưa thì trần-theo-nguồn siết (giữ bản dịch gọn), video dày thì trần-vật-lý chặn
    (không đòi hỏi bất khả thi nhưng vẫn buộc nén). Sàn 3 từ để cue rất ngắn không ra trần vô lý.
    """
    n_am = len(_RE_AM.findall(nguon or "")) or max(1, len((nguon or "").split()))
    return max(3, int(min(giay * wps_max, n_am * ti_le)))


def _slot_giay(ts):
    """'00:00:01,000 --> 00:00:03,000' → số giây khe (en-st), cho ngân sách ký tự khớp lồng tiếng. Lỗi → 0."""
    try:
        a, b = ts.split("-->")
        def _s(x):
            x = x.strip().replace(",", "."); h, m, s = x.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
        return max(0.0, _s(b) - _s(a))
    except Exception:
        return 0.0


def doc_tm(tm_dir):
    """Nạp QUY TẮC + TỪ ĐIỂN TÊN RIÊNG do người dùng nhập (translation_memory/*.md) để đấu vào prompt.
    Gemini đã dịch tốt → KHÔNG cần luật rườm rà; chỉ cần tên riêng nhất quán + quy tắc user thêm."""
    import glob
    if not tm_dir or not os.path.isdir(tm_dir):
        return ""
    parts = []
    for f in sorted(glob.glob(os.path.join(tm_dir, "*.md"))):
        try:
            t = open(f, encoding="utf-8").read().strip()
            if t:
                parts.append(t)
        except Exception:
            pass
    return "\n\n".join(parts)


def _tim_o_nhap(page, wait_login, log_fn):
    """Chờ ô nhập Gemini (Quill editor) hiện ra → trả element hoặc None (chưa login / đổi UI)."""
    for _ in range(wait_login):
        ed = page.query_selector("div.ql-editor[contenteditable='true']") or \
             page.query_selector("div[contenteditable='true'][role='textbox']") or \
             page.query_selector("div[contenteditable='true']")
        if ed:
            return ed
        time.sleep(1)
    return None


def _doi_phan_hoi(page, min_len, log_fn, done_check=None):
    """Chờ Gemini trả lời trên page đang mở (cuộn load hết element) → text raw.
    done_check(text)->bool: response ĐÃ đủ câu (caller biết số dòng mong đợi, ngưỡng ~90% — xem _du()).
    🐛 FIX (đo thật: lô 400 câu sót ĐÚNG ~6-8 câu ĐUÔI, lặp lại 2/2 lô — khớp regression test_gemini_srt,
    KHÔNG PHẢI Gemini giới hạn output như nghi ngờ cũ): done_check đủ 2 lần liên tiếp (~3s) → BREAK NGAY —
    nhưng response VẪN đang STREAM (Gemini gõ tiếp phần đuôi) nên `cl` (độ dài) vẫn tăng giữa 2 lần đó; ngưỡng
    thoát-sớm (90%) trùng đúng ngưỡng coi-là-đủ của done_check → không có margin phát hiện "còn đang gõ". Fix:
    ngoài đủ-câu, đòi hỏi ĐỘ DÀI cũng NGỪNG TĂNG (giống stable ở fallback bên dưới) trước khi tin là dừng thật —
    lô đã in ĐỦ 100% (length ổn định ngay từ đầu) vẫn thoát nhanh như cũ; chỉ lô mới chạm ngưỡng (đang stream dở)
    mới bị giữ lại chờ thêm vài lần đến khi length hết tăng. KHÔNG chờ length ổn định → fix cold-flaky
    `wait`~500s (length cứ dao động dù câu trả lời đã tới → loop hết 160×3s). Không có done_check → fallback cũ:
    đủ dài + length ổn định 3 lần."""
    resp, cur, last_len, stable, done_stable, _empty0, done_len = "", "", 0, 0, 0, 0, -1
    for k in range(320):
        time.sleep(1.5)    # poll 3→1.5s: bắt 'xong' nhanh hơn (slack sau khi Gemini sinh xong 6s→3s/lô); range×2 giữ cap ~480s
        try:
            page.mouse.wheel(0, 6000)
            page.evaluate("window.scrollTo(0, document.body.scrollHeight);"
                          "document.querySelectorAll('.markdown,message-content')"
                          ".forEach(e=>e.scrollIntoView({block:'end'}))")
        except Exception:
            pass
        els = page.query_selector_all("message-content .markdown, .model-response-text, .markdown")
        # EARLY-ABORT (fix cold-start 'wait~500s'): 0 element trả lời kéo dài = prompt GỬI HỤT (trang chưa
        # sẵn sàng lúc Chrome vừa mở) → Gemini không sinh gì. Thoát SỚM (~60s) để _translate_loop GỬI LẠI
        # (retry trên page đã ấm ăn ngay ~6s) thay vì chờ hết cap 480s. Có element rồi (đang nghĩ/stream) → reset.
        if not els:
            _empty0 += 1
            if _empty0 >= 40:              # 40×1.5s = 60s Gemini 0 phản hồi → chắc gửi hụt → break để gửi lại
                log_fn("   ⚠ Gemini 0 element trả lời ~%ds → nghi GỬI HỤT (cold-start) → thoát sớm, gửi lại." % int(_empty0 * 1.5))
                break
        else:
            _empty0 = 0
        cur = els[-1].inner_text() if els else ""
        cl = len(cur)
        if k % 6 == 0:
            log_fn("   ...resp len=%d (els=%d, stable=%d, done=%d)" % (cl, len(els), stable, done_stable))
        # ĐỦ CÂU (done_check) 2 lần liên tiếp — nhưng CHỈ break khi độ dài cũng NGỪNG TĂNG kể từ lúc bắt đầu
        # đếm đủ-câu (cl == done_len): lô đã in TRỌN vẹn (length ổn định ngay) → thoát ngay, không chậm hơn cũ;
        # lô còn đang stream đuôi (cl vẫn > done_len) → reset đếm, chờ vòng sau (length đuổi kịp sẽ tự thoát).
        if done_check is not None and done_check(cur):
            if cl == done_len:
                done_stable += 1
            else:
                done_stable = 1
                done_len = cl
            if done_stable >= 2:
                resp = cur
                break
        else:
            done_stable = 0
            done_len = -1
        # fallback (không có done_check / CHƯA đủ câu): đủ dài + NGỪNG tăng 3 lần → xong.
        if cl > min_len and cl == last_len:
            stable += 1
            if stable >= 3:
                resp = cur
                break
        else:
            stable = 0
        last_len = cl
    return resp or cur


_GEM = None   # phiên Gemini BỀN: {"pw","ctx","page"} — giữ Chrome+SPA NÓNG qua render (render_worker, Step 3)
# 🐛 fix (audit BAO-CAO-BUG-2 #B7): TRƯỚC ĐÂY chỉ bọc đoạn mở/tái-dùng phiên trong _gem_open() — thao tác
# THẬT trên `page` (gõ prompt/đọc response trong _translate_loop*) chạy NGOÀI lock. Nếu 2 luồng cùng process
# gọi dịch (keep=True) gần như đồng thời, cả 2 dùng CHUNG `page` (biến global _GEM) → thao tác xen kẽ không
# đồng bộ, có thể lẫn dữ liệu dịch giữa 2 job. Nay hoi_gemini_web_nhieu/hoi_gemini_batch_cung_chat giữ
# _GEM_LOCK suốt cả quá trình (mở + dịch) khi keep=True — chấp nhận dịch SERIAL hoàn toàn qua browser bền
# (đường keep vốn chỉ có Ý NGHĨA khi dùng đúng 1 phiên tại 1 thời điểm). Đổi Lock→RLock vì _gem_open() vẫn tự
# `with _GEM_LOCK` bên trong — cùng luồng gọi lồng nhau phải không tự deadlock.
_GEM_LOCK = __import__("threading").RLock()


def _gem_close():
    """Đóng phiên Gemini bền (atexit khi worker thoát, hoặc phiên chết → mở lại)."""
    global _GEM
    g = _GEM; _GEM = None
    if g:
        try: g["ctx"].close()
        except Exception: pass
        try: g["pw"].stop()
        except Exception: pass


def _gem_open(show, profile, log_fn=print):
    """Mở/REUSE phiên Gemini bền. Trả (pw, ctx, page, warm) — warm=True nếu tái dùng phiên đang sống."""
    global _GEM
    import atexit
    from playwright.sync_api import sync_playwright
    with _GEM_LOCK:
        g = _GEM
        if g is not None:
            try:
                if not g["page"].is_closed():
                    return g["pw"], g["ctx"], g["page"], True   # còn nóng → tái dùng
            except Exception:
                pass
            _gem_close()    # phiên chết → dọn rồi mở lại
        os.makedirs(profile, exist_ok=True)
        pw = sync_playwright().start()
        ctx = pw.chromium.launch_persistent_context(
            profile, headless=not show,
            args=["--disable-blink-features=AutomationControlled",
                  "--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox",
                  "--disable-features=IsolateOrigins,site-per-process"],
            viewport={"width": 1200, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        _GEM = {"pw": pw, "ctx": ctx, "page": page}
        atexit.register(_gem_close)
        log_fn("🔥 Gemini mở phiên BỀN (giữ Chrome+SPA nóng qua render).")
        return pw, ctx, page, False


def _translate_loop(page, prompts, wait_login, min_len, log_fn, on_resp, validate, tries):
    """Vòng dịch trên 1 page (mỗi prompt = 1 chat mới /app). Trả (outs, t_load, t_wait).
    DÙNG CHUNG cho đường subprocess (browser mới) lẫn in-process BỀN (browser giữ nóng)."""
    outs = []; n = len(prompts); t_load = 0.0; t_wait = 0.0
    for idx, prompt in enumerate(prompts, 1):
        if n > 1:
            log_fn("[Gemini] Lô %d/%d (chat mới)..." % (idx, n))
        resp = ""
        for attempt in range(1, max(1, tries) + 1):
            # CHAT MỚI mỗi lô (reload /app) → KHÔNG tích luỹ context, mỗi lô dịch độc lập gọn nhẹ.
            _tg = time.time()
            try:
                page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=60000)
            except Exception:
                pass
            t_load += time.time() - _tg       # = load/hydrate Gemini SPA (lần 1 kèm login-check)
            ed = _tim_o_nhap(page, wait_login if (idx == 1 and attempt == 1) else 40, log_fn)
            if not ed:
                log_fn("[X] Không thấy ô nhập (chưa đăng nhập / Gemini đổi giao diện).")
                time.sleep(3)
                continue
            log_fn("[4] Gõ prompt + gửi (lần %d)..." % attempt)
            ed.click()
            page.keyboard.insert_text(prompt)
            time.sleep(0.6)
            page.keyboard.press("Enter")
            log_fn("[5] Chờ Gemini trả lời...")
            _tw = time.time()
            # done_check = "lô này đã đủ câu chưa" (validate caller) → break NGAY khi đủ, đỡ loop hết timeout.
            resp = _doi_phan_hoi(page, min_len, log_fn,
                                 done_check=(lambda r: validate(idx - 1, r)) if validate else None)
            t_wait += time.time() - _tw       # = thời gian MODEL nghĩ (network/model thật)
            if validate is None or validate(idx - 1, resp):
                break
            log_fn("[!] Lô %d THIẾU câu/lỗi (lần %d/%d) → GỬI LẠI (Gemini tự bù, đỡ rớt Google)..."
                   % (idx, attempt, max(1, tries)))
            time.sleep(4)   # nghỉ trước khi thử lại → giảm throttle
        outs.append(resp)
        if on_resp:
            try: on_resp(idx - 1, resp)   # ghi LŨY TIẾN: timeout vẫn giữ các lô đã xong
            except Exception: pass
        if idx < n:
            time.sleep(2)   # delay giữa lô → giảm throttle Gemini khi dịch NHIỀU lô
    return outs, t_load, t_wait


def _translate_loop_cung_chat(page, prefix, los_text, wait_login, log_fn, on_resp, validate, tries):
    """CÙNG CHAT (batch marker): lô 1 gửi FULL prompt (prefix rules + câu); lô SAU chỉ gửi CÂU (Gemini nhớ rules từ
    lô 1) → KHỎI reload trang + KHỎI gửi lại prompt dài = NHANH hơn nhiều (tiết ~8s load SPA + gõ prompt/lô).
    An toàn CHỈ với marker <<<SEG:vid:idx>>> (ID TUYỆT ĐỐI, không lẫn giữa các lô như đánh-số-local).
    prefix = phần rules/hướng dẫn (chỉ gửi lô 1). los_text = [text_câu_lô_1, text_câu_lô_2, ...]. Trả list resp."""
    outs = []; n = len(los_text)
    # goto CHAT MỚI 1 LẦN ở đầu (lô 1) — các lô sau ở CÙNG trang
    try:
        page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=60000)
    except Exception:
        pass
    for idx, cau_text in enumerate(los_text, 1):
        # lô 1 = prefix + câu; lô sau = nhắc ngắn "dịch tiếp theo quy tắc trên" + câu (KHÔNG lặp prefix)
        if idx == 1:
            msg = prefix + cau_text
        else:
            msg = ("TIẾP TỤC dịch theo ĐÚNG quy tắc + marker <<<SEG:...>>> ở trên (giữ nguyên marker, mỗi marker "
                   "1 câu dịch). Đây là phần tiếp theo:\n\n" + cau_text)
        resp = ""
        for attempt in range(1, max(1, tries) + 1):
            ed = _tim_o_nhap(page, wait_login if (idx == 1 and attempt == 1) else 40, log_fn)
            if not ed:
                log_fn("[X] Không thấy ô nhập (chưa đăng nhập / Gemini đổi giao diện).")
                time.sleep(3); continue
            log_fn("[BATCH-chat] Lô %d/%d gửi (%s, lần %d)..." % (idx, n, "full prompt" if idx == 1 else "chỉ câu", attempt))
            ed.click()
            page.keyboard.insert_text(msg)
            time.sleep(0.6)
            page.keyboard.press("Enter")
            resp = _doi_phan_hoi(page, 20, log_fn,
                                 done_check=(lambda r: validate(idx - 1, r)) if validate else None)
            if validate is None or validate(idx - 1, resp):
                break
            log_fn("[!] Lô %d thiếu câu (lần %d/%d) → gửi lại." % (idx, attempt, max(1, tries)))
            time.sleep(3)
        outs.append(resp)
        if on_resp:
            try: on_resp(idx - 1, resp)
            except Exception: pass
        if idx < n:
            time.sleep(1.5)
    return outs


def hoi_gemini_batch_cung_chat(prefix, los_text, show=False, wait_login=180, log_fn=print,
                               on_resp=None, validate=None, tries=2, keep=False):
    """BATCH marker CÙNG CHAT: lô 1 full prompt, lô sau chỉ câu (Gemini nhớ rules) → nhanh hơn. Trả list resp.
    prefix = rules (gửi lô 1); los_text = [text câu mỗi lô]. Chỉ dùng cho dich_batch (marker ID)."""
    # 🐛 fix (audit BAO-CAO-BUG-2 #B16): đọc GEMINI_PROFILE_DIR dưới _GEM_LOCK dù keep=False (không share
    # `page`, nhưng os.environ THÌ CÓ share toàn tiến trình) — nếu đọc đúng lúc caller khác (vd
    # _batch_dich_worker/prefetch) đang TẠM ghi đè biến này, sẽ lấy nhầm profile → SingletonLock. Chỉ khoá
    # đúng lúc ĐỌC (rất nhanh), KHÔNG khoá phần mở-browser/dịch phía dưới cho nhánh keep=False → vẫn chạy
    # song song thật giữa các browser độc lập, chỉ đồng bộ đúng chỗ có tài nguyên dùng chung.
    with _GEM_LOCK:
        profile = os.environ.get("GEMINI_PROFILE_DIR") or os.path.join(
            os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join("MediaCrawler", "browser_data"),
            "gemini_user_data_dir")
    os.makedirs(profile, exist_ok=True)
    # #B7: keep=True dùng CHUNG phiên/`page` toàn tiến trình → giữ _GEM_LOCK suốt cả mở+dịch (không chỉ lúc
    # mở) để 2 luồng gọi đồng thời không xen thao tác trên cùng page. keep=False mở browser RIÊNG, không
    # tranh chấp gì → không cần khoá.
    with (_GEM_LOCK if keep else contextlib.nullcontext()):
        if keep:
            pw, ctx, page, _warm = _gem_open(show, profile, log_fn)
            _own = False
        else:
            from playwright.sync_api import sync_playwright
            pw = sync_playwright().start()
            ctx = pw.chromium.launch_persistent_context(
                profile, headless=not show,
                args=["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage",
                      "--disable-gpu", "--no-sandbox", "--disable-features=IsolateOrigins,site-per-process"],
                viewport={"width": 1200, "height": 900})
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            _own = True
        try:
            return _translate_loop_cung_chat(page, prefix, los_text, wait_login, log_fn, on_resp, validate, tries)
        finally:
            if _own:
                try: ctx.close()
                except Exception: pass
                try: pw.stop()
                except Exception: pass


def hoi_gemini_web_nhieu(prompts, show=False, wait_login=180, min_len=50, log_fn=print,
                         on_resp=None, validate=None, tries=2, keep=False):
    """Gửi NHIỀU prompt vào Gemini web trong CÙNG 1 browser (mỗi prompt = 1 CHAT MỚI, độc lập) → list
    response. Dùng cho CHUNK video dài (mỗi lô ~150-200 câu) — tránh 1 prompt khổng lồ bị Gemini CẮT output.
    on_resp(idx0, resp): gọi NGAY sau mỗi lô (idx0 = 0-based) → caller ghi LŨY TIẾN (timeout vẫn giữ lô đã xong).
    validate(idx0, resp)->bool: lô ĐỦ câu chưa; SAI → GỬI LẠI lô đó (tới `tries` lần) để Gemini tự bù,
    đỡ phải rớt Google. tries = số lần thử mỗi lô."""
    # Fallback profile PHẢI theo MC_BROWSER_DATA_DIR (web_app set = userData khi đóng gói) — KHÔNG dùng
    # đường dẫn tương đối 'MediaCrawler/browser_data/...' trần: khi hàm này chạy TRONG TIẾN TRÌNH web_app
    # (vd _phan_loai_sau_render gọi thẳng, không qua subprocess) và CWD = app-src trong Program Files
    # (READ-ONLY, không admin) → makedirs/Chromium ghi lock file vào đó FAIL WinError 5 Access denied →
    # phân loại AI luôn lỗi → mọi video rớt về thư mục mặc định (không bao giờ vào đúng thể loại).
    # 🐛 fix (audit BAO-CAO-BUG-2 #B16): đọc GEMINI_PROFILE_DIR dưới _GEM_LOCK dù keep=False (không share
    # `page`, nhưng os.environ THÌ CÓ share toàn tiến trình) — nếu đọc đúng lúc caller khác (vd
    # _batch_dich_worker/prefetch) đang TẠM ghi đè biến này, sẽ lấy nhầm profile → SingletonLock. Chỉ khoá
    # đúng lúc ĐỌC (rất nhanh), KHÔNG khoá phần mở-browser/dịch phía dưới cho nhánh keep=False → vẫn chạy
    # song song thật giữa các browser độc lập, chỉ đồng bộ đúng chỗ có tài nguyên dùng chung.
    with _GEM_LOCK:
        profile = os.environ.get("GEMINI_PROFILE_DIR") or os.path.join(
            os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join("MediaCrawler", "browser_data"),
            "gemini_user_data_dir")
    os.makedirs(profile, exist_ok=True)
    n = len(prompts)
    _t_open = 0.0   # PROFILE: startup(browser) / load(SPA goto) / wait(model)
    _to = time.time()
    # #B7: keep=True dùng CHUNG phiên/`page` toàn tiến trình → giữ _GEM_LOCK suốt cả mở+dịch (xem lý do đầy
    # đủ ở khai báo _GEM_LOCK). keep=False mở browser RIÊNG, không tranh chấp gì → không cần khoá.
    with (_GEM_LOCK if keep else contextlib.nullcontext()):
        if keep:        # phiên BỀN: tái dùng Chrome đang nóng (warm=True → open=0); KHÔNG đóng cuối hàm
            pw, ctx, page, _warm = _gem_open(show, profile, log_fn)
            if not _warm:
                _t_open = time.time() - _to
            _own = False
        else:           # CLI/subprocess: mở browser MỚI, đóng khi xong (hành vi cũ)
            from playwright.sync_api import sync_playwright
            # Gemini SPA RẤT NẶNG → headless hay "Target crashed" thiếu cờ → thêm cờ chống crash.
            pw = sync_playwright().start()
            ctx = pw.chromium.launch_persistent_context(
                profile, headless=not show,
                args=["--disable-blink-features=AutomationControlled",
                      "--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox",
                      "--disable-features=IsolateOrigins,site-per-process"],
                viewport={"width": 1200, "height": 900},
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            _t_open = time.time() - _to                # = chi phí khởi động Chrome
            _own = True
        try:
            outs, _t_load, _t_wait = _translate_loop(page, prompts, wait_login, min_len, log_fn,
                                                     on_resp, validate, tries)
            if show or os.environ.get("GEMINI_DEBUG"):   # screenshot debug — không ở production headless
                try:
                    page.screenshot(path="_gemini_debug.png", full_page=True)
                except Exception:
                    pass
        finally:
            if _own:    # phiên bền (keep) KHÔNG đóng → giữ nóng cho render sau
                try: ctx.close()
                except Exception: pass
                try: pw.stop()
                except Exception: pass
    # PROFILE: open=khởi động Chrome (0 nếu warm), load=goto/hydrate SPA, wait=model nghĩ.
    log_fn("GEMPROF|open=%.1f load=%.1f wait=%.1f chunks=%d" % (_t_open, _t_load, _t_wait, n))
    try:        # tích luỹ vào CÙNG jsonl với PROFILE render (localize set VC_PROFILE_LOG)
        _pl = os.environ.get("VC_PROFILE_LOG")
        if _pl:
            import json as _j
            with open(_pl, "a", encoding="utf-8") as _f:
                _f.write(_j.dumps({"t": int(time.time()), "gemini": {
                    "open": round(_t_open, 1), "load": round(_t_load, 1),
                    "wait": round(_t_wait, 1), "chunks": n}}, ensure_ascii=False) + "\n")
    except Exception:
        pass
    return outs


def hoi_gemini_web(prompt, show=False, wait_login=180, min_len=50, log_fn=print):
    """Gửi 1 prompt vào Gemini web → trả CHỮ trả lời (raw). Dùng chung: dịch SRT + phân loại video.
    (Bọc hoi_gemini_web_nhieu với 1 prompt — giữ tương thích ngược cho mọi caller cũ.)"""
    log_fn("[2] Mở Gemini...")
    outs = hoi_gemini_web_nhieu([prompt], show=show, wait_login=wait_login, min_len=min_len, log_fn=log_fn)
    return outs[0] if outs else ""


_RE_SO_CO_DAU = re.compile(r"^\s*\d+\s*[\.\):\-]\s*")               # "3. " / "3) " / "3- "
_RE_SO_KHONG_DAU = re.compile(r"^\s*\d+\s+(?=@\d{1,2}:\d{2}:\d{2}|\[)")   # "3 @00:10:59" / "3 [0.8s"
_RE_MOC_GIO = re.compile(r"^\s*@\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\s*")
_RE_NEO = re.compile(r"^\s*\[[^\]]*\]\s*")


def _bo_echo_dau_dong(x):
    r"""Cắt phần ĐẦU DÒNG mà Gemini chép lại từ input: số thứ tự · @HH:MM:SS · [Ts ≤N từ].

    🐛 BUG MÁY KHÁCH 03/08/2026 (ảnh chụp): video 15 phút, **từ phút 10 trở đi** phụ đề burn ra
    `3 @00:10:59 [0.8s ≤3] Ngay lúc đó` — nguyên si dòng prompt gửi Gemini, cháy thẳng vào video.
    Vì sao chỉ 1 đoạn: dịch chạy theo LÔ; đúng lô đó Gemini trả `3 @00:10:59 …` — số thứ tự KHÔNG
    có dấu chấm. Chuỗi 3 regex cũ đều NEO ĐẦU DÒNG và chạy theo thứ tự cố định nên đổ dây chuyền:
    `^\d+[.):-]` trượt (thiếu dấu) → còn `3 @…` ⇒ `^@HH:MM:SS` trượt (đầu dòng là `3`) ⇒ `^\[` trượt.
    Cả lô mất sạch bộ lọc. Các lô khác Gemini trả có dấu chấm nên sạch — đúng "chỉ từ phút 10".

    Nay cắt LẶP tới khi không cắt thêm được, và số-thứ-tự-KHÔNG-dấu chỉ cắt khi ngay sau nó là
    `@mốc` hoặc `[` — nếu cắt vô điều kiện thì bản dịch thật "3 người đã đến" mất luôn số 3.
    """
    # 🐛 fix (audit BAO-CAO-BUG-2 #B27): `_RE_SO_CO_DAU`/`_RE_SO_KHONG_DAU` (cắt số thứ tự) KHÔNG có lookahead
    # bắt buộc như `_RE_MOC_GIO`/`_RE_NEO` — nếu bản dịch THẬT SỰ mở đầu bằng số+dấu câu (vd "Chương 3. Bắt
    # đầu từ đây" hoặc liệt kê "5. Tầng thứ năm là..."), lặp cắt-số NHIỀU LẦN qua vòng lặp có thể ăn mất phần
    # đầu câu dịch thật. Chỉ cắt SỐ THỨ TỰ ở LẦN LẶP ĐẦU (đủ cho cả 2 ca dùng thật: numbered-branch của
    # _parse_lo chỉ còn tối đa 1 lớp số-echo sau khi outer regex đã bóc lớp số CHÍNH; seq-branch cần đúng 1
    # lần cắt số CHÍNH). Mốc giờ/[Ts≤N] vẫn cắt lặp bình thường — định dạng của chúng đủ đặc trưng, không lẫn
    # với văn bản dịch thật.
    x = (x or "")
    for _i in range(4):
        y = x
        if _i == 0:
            y = _RE_SO_CO_DAU.sub("", y, count=1)
            y = _RE_SO_KHONG_DAU.sub("", y, count=1)
        y = _RE_MOC_GIO.sub("", y, count=1)
        y = _RE_NEO.sub("", y, count=1)
        if y == x:
            break
        x = y
    return x


def _nghi_gop_cau(kq, do_dai_toi_thieu=8, boi_so=3.0, san_tuyet_doi=60):
    """Nghi ngờ Gemini GỘP nhiều dòng ngắn liên tiếp thành 1 câu văn xuôi (audit BAO-CAO-BUG-2 #B11) — dấu
    hiệu: 1 giá trị dài BẤT THƯỜNG so với các giá trị còn lại trong CÙNG lô `kq` ({số: bản_dịch}). Trước đây
    `_du()` chỉ đếm SỐ LƯỢNG key (≥90%) nên nếu các câu khác trong lô bù đủ số lượng, việc gộp lọt qua — các
    key bị gộp-mất giữ nguyên chữ Hán gốc xen giữa phụ đề đã dịch (_ghep). Ngưỡng bảo thủ (median đủ dài,
    gấp ≥3× median, sàn tuyệt đối 60 ký tự) để giảm báo nhầm với câu dài tự nhiên — hậu quả sai (nếu có) chỉ
    là gửi lại lô, rẻ hơn nhiều so với mất câu."""
    if len(kq) < 4:
        return False
    do_dai = sorted(len(v) for v in kq.values())
    median = do_dai[len(do_dai) // 2]
    return median >= do_dai_toi_thieu and do_dai[-1] > max(san_tuyet_doi, median * boi_so)


def _parse_lo(resp, clen):
    """Phân tích 1 lô → {số_local(1..clen): bản_dịch}. Map theo SỐ; lô không đánh số → map theo THỨ TỰ."""
    d = {}
    if not resp:
        return d
    for l in resp.split("\n"):
        # Nhận CẢ "3. text" LẪN "3 @00:10:59 …" (Gemini quên dấu chấm) — giữ map THEO SỐ, đừng để
        # rơi xuống nhánh map-theo-thứ-tự (dễ lệch câu) chỉ vì thiếu một dấu chấm.
        m = re.match(r"^\s*(\d+)\s*[\.\):\-]\s*(.+?)\s*$", l) or \
            re.match(r"^\s*(\d+)\s+(@\d{1,2}:\d{2}:\d{2}.*?|\[.*?)\s*$", l)
        if m:
            k = int(m.group(1))
            if 1 <= k <= clen:
                v = _bo_echo_dau_dong(m.group(2).strip().strip('"')).strip().strip('"')
                d[k] = v
    if len(d) < clen * 0.6:     # lô KHÔNG đánh số → map theo THỨ TỰ
        seq = [x.strip() for x in resp.split("\n") if x.strip() and not x.strip().endswith(":")]
        seq = [_bo_echo_dau_dong(x) for x in seq]   # cắt số thứ tự + @mốc + [Ts ≤N] nếu Gemini echo (xem hàm)
        # 🐛 fix (audit BAO-CAO-BUG-2 #B6): TRƯỚC ĐÂY map thẳng THEO VỊ TRÍ bất kể `seq` có đúng `clen` dòng
        # hay không — nếu Gemini lỡ chèn 1 dòng mở đầu không kết thúc bằng ":" (dù prompt đã cấm), TOÀN BỘ
        # bản dịch dịch chuyển lùi 1 vị trí: câu gốc 1 nhận rác, câu 2 nhận bản dịch câu 1... câu CUỐI mất
        # hẳn (rơi khỏi mảng) — mà `_du()` vẫn đếm đủ ~clen dòng nên KHÔNG phát hiện được (sai NGHĨA từng
        # dòng, không thiếu SỐ LƯỢNG dòng). Nay: CHỈ map thẳng khi seq khớp ĐÚNG clen dòng (chắc chắn không
        # lệch); thừa ĐÚNG 1 dòng (đúng ca preamble phổ biến nhất) → bỏ dòng ĐẦU rồi map; lệch khác (không đủ
        # chắc để đoán dòng nào là rác) → KHÔNG map mò, để nguyên `d` (thiếu) cho `_du()` phát hiện và retry.
        if len(seq) == clen:
            d = {j + 1: seq[j] for j in range(clen)}
        elif len(seq) == clen + 1:
            d = {j + 1: seq[j + 1] for j in range(clen)}
    return d


# ===== BATCH DỊCH NHIỀU VIDEO (marker ID) — bên cạnh dich_srt, KHÔNG đụng đường chính =====
# Marker <<<SEG:vid:idx>>> gắn video_id + segment_id vào TỪNG câu → gom câu NHIỀU video 1 lô Gemini → tách về
# đúng video theo ID (KHÔNG dựa thứ tự). An toàn khi Gemini gộp/bỏ dòng trống: parse theo marker, không vị trí.
# NỚI regex: 1-3 dấu <> mỗi bên — ĐO THẬT Gemini "chuẩn hóa" <<<SEG>>> → <<SEG>> (bớt 1 dấu) → parse 0 câu.
# 🐛 fix (audit BAO-CAO-BUG-2 #B23): nới thêm 1-6 dấu (phòng Gemini THÊM dấu thay vì bớt) + IGNORECASE (phòng
# đổi hoa/thường "SEG"→"seg") — marker không match làm nội dung câu đó bị NUỐT vào câu TRƯỚC (_parse_marker
# cắt text = mọi dòng SAU marker này TỚI TRƯỚC marker kế), key của câu đó vắng mặt hoàn toàn, mất câu ÂM THẦM.
_MARKER_RE = re.compile(r"<{1,6}\s*SEG\s*:\s*([A-Za-z0-9_]+)\s*:\s*(\d+)\s*>{1,6}", re.IGNORECASE)


def _marker(vid, idx):
    return "<<<SEG:%s:%05d>>>" % (vid, idx)


def _parse_marker(resp):
    """Parse output có marker <<<SEG:vid:idx>>>\\n<text> → {(vid, idx): text}. Tách theo marker (KHÔNG vị trí):
    text của 1 câu = mọi dòng SAU marker tới TRƯỚC marker kế. Gemini thêm/bớt dòng trống không ảnh hưởng."""
    out = {}
    if not resp:
        return out
    # tìm mọi marker + vị trí → cắt text giữa 2 marker liên tiếp
    ms = list(_MARKER_RE.finditer(resp))
    for i, m in enumerate(ms):
        vid, idx = m.group(1), int(m.group(2))
        beg = m.end()
        end = ms[i + 1].start() if i + 1 < len(ms) else len(resp)
        txt = resp[beg:end].strip()
        # gột dòng rỗng + echo mốc/anchor lỡ lọt (như _parse_lo)
        txt = re.sub(r"^\s*@\d{1,2}:\d{2}:\d{2}\s*", "", txt)
        txt = re.sub(r"^\s*\[[^\]]*\]\s*", "", txt)
        txt = " ".join(x.strip() for x in txt.split("\n") if x.strip()).strip().strip('"')
        if txt:
            out[(vid, idx)] = txt
    return out


def _ghep(segs, lo, CHUNK, resps, loc_ban_han=False):
    """resps (có thể thiếu lô cuối) → (out_lines, vi_dict). Câu thiếu → giữ zh (localize Google bù).
    loc_ban_han=True (CHỈ dùng ở bước GHÉP CUỐI, sau khi hết mọi retry — KHÔNG dùng ở _ghi lũy tiến giữa
    chừng, kẻo mất hiển thị tạm thời): câu VẪN còn ≥HAN_NET_NGUONG Hán (dù khác byte với zh, né được so
    sánh == tuyệt đối) → BỎ TRỐNG thay vì giữ zh — khớp LUẬT CỨNG "không lọt chữ Trung" ở localize.py."""
    vi = {}
    for ci, resp in enumerate(resps):
        if ci >= len(lo):
            break
        for k, v in _parse_lo(resp, len(lo[ci])).items():
            vi[ci * CHUNK + k] = v
    if loc_ban_han:
        try:
            _ng = float(os.environ.get("HAN_NET_NGUONG", "0.35") or 0.35)
        except ValueError:
            _ng = 0.35
        if _ng > 0:
            # BỎ TRỐNG (KHÔNG pop khỏi dict — vi.get(i,zh) sẽ fallback về zh, đúng chữ Hán mà ta đang muốn
            # loại) → set "" tường minh để out ghi dòng rỗng, giữ nguyên len(vi) cho caller tính tỉ lệ đúng.
            #
            # 🔴 SỬA GỐC (01/08/2026 — TEST THẬT bắt được): ngưỡng TỈ LỆ chỉ bắt câu GẦN NGUYÊN VĂN Hán, KHÔNG
            # bắt được chữ Hán LẺ dính trong câu Việt. Ca thật đo được khi dịch 136 câu:
            #     cue 50: "Cả kiếm技 tuyệt đỉnh này nữa"  → tỉ lệ Hán chỉ ~4% ⇒ LỌT qua ngưỡng 0.35 ⇒ ra video.
            # Lộ chữ Hán là lỗi TUYỆT ĐỐI (chủ dự án chốt), không phải lỗi theo tỉ lệ ⇒ CÓ là loại, bất kể ít nhiều.
            # Giữ env `HAN_NET_NGUONG` để tắt hẳn (=0) hoặc quay lại kiểu ngưỡng cũ nếu cần, nhưng mặc định nay
            # là "0 khoan dung": `_ty_le_han(v) > 0`.
            for k in list(vi.keys()):
                if _ty_le_han(vi[k]) > 0:
                    vi[k] = ""
    _KHONG_CO = object()   # sentinel phân biệt "câu chưa dịch (dùng zh)" vs "câu ĐÃ bị lọc-Hán về rỗng"
    out = ["%d\n%s\n%s\n" % (i, ts, zh if vi.get(i, _KHONG_CO) is _KHONG_CO else vi[i])
           for i, (ts, zh) in enumerate(segs, 1)]
    return out, vi


# QUY TẮC CHUNG luôn đấu vào prompt dịch tiếng Việt (chủ dự án soạn 29/07/2026 — 3 điểm yếu thật của bản cũ).
# KHÁC `tm` (từ điển tên riêng + phong cách user chọn trong UI): `tm` có thể RỖNG và đổi theo video, còn khối
# này là luật NỀN áp cho MỌI video nên hard-code.
#  1. LỖI OCR: nguồn chữ đến từ OCR video nên có chữ sai/vô nghĩa — bản cũ không hề dặn, Gemini cứ thế dịch
#     bám chữ sai ra câu vô nghĩa. Nay bắt ĐOÁN lại theo ngữ cảnh.
#  2. THỂ LOẠI: bản cũ không nêu thể loại ⇒ giọng văn trung tính, phẳng cho mọi video. Cổ trang/tu tiên bị
#     dịch thuần Việt ('Trúc Cơ' → 'Kỳ xây nền') là lỗi khách phàn nàn thật.
#  3. VĂN DỊCH MÁY: cấm thẳng các cụm rập khuôn ('một cách…', 'sự…', 'việc mà…', 'điều đó…') — bản cũ chỉ nói
#     chung chung "tự nhiên" nên LLM vẫn sinh ra đầy.
_QUY_TAC_CHUNG = (
    "=== QUY TẮC DỊCH THUẬT & PHONG CÁCH (BẮT BUỘC) ===\n"
    # 🔴 THÊM 03/08/2026 — bộ quy tắc này bị VÁ CHỒNG VÁ qua nhiều đợt, sinh ra 3 tuyên bố "THẮNG" rải rác
    # (phong cách thắng mục 2 · 2b thắng ngắn-gọn · ngắn-gọn là "TRẦN") mà KHÔNG có thứ tự tổng thể ⇒ model tự
    # chọn, và nó chọn sai (xem ca phiên âm Hán-Việt 02/08). Nêu MỘT thang ưu tiên duy nhất ngay đầu để mọi
    # xung đột về sau có trọng tài, thay vì mỗi mục tự xưng mình thắng.
    "0. THỨ TỰ ƯU TIÊN KHI CÁC QUY TẮC XUNG ĐỘT (áp dụng cho TOÀN BỘ tài liệu này, kể cả các mục ghi "
    "'BẮT BUỘC'/'TUYỆT ĐỐI'/'THẮNG'):\n"
    "   ① ĐÚNG NGHĨA + NGƯỜI VIỆT ĐỌC LÀ HIỂU NGAY  →  ② ĐÚNG SỐ DÒNG (1 dòng gốc = 1 dòng dịch)  →  "
    "③ NGẮN vừa khe thời gian  →  ④ PHONG CÁCH/GIỌNG VĂN.\n"
    "   Nghĩa là: thà DÀI hơn trần một chút còn hơn viết ra câu người Việt không hiểu; và KHÔNG BAO GIỜ "
    "hy sinh ① để đạt ③.\n"
    "1. XỬ LÝ LỖI OCR BẢN GỐC: Dữ liệu đầu vào quét từ video nên sẽ có lỗi OCR (sai mặt chữ, sinh ra từ vô "
    "nghĩa, sai ngữ cảnh). Nếu thấy một từ phá vỡ ngữ pháp, BẮT BUỘC phải dựa vào ngữ cảnh cả đoạn để ĐOÁN "
    "chữ đúng và dịch theo ý đúng, TUYỆT ĐỐI KHÔNG dịch bám vào chữ sai đó.\n"
    "2. TỰ ĐỘNG NHẬN DIỆN & THÍCH ỨNG THỂ LOẠI (RẤT QUAN TRỌNG): Dựa vào nội dung đoạn thoại, tự xác định "
    "thể loại video và áp dụng quy tắc xưng hô, văn phong tương ứng.\n"
    "   ⚠ ƯU TIÊN: nếu BÊN DƯỚI có khối \"QUY TẮC + TỪ ĐIỂN TÊN RIÊNG\" (phong cách do NGƯỜI DÙNG tự chọn) "
    "thì PHONG CÁCH ĐÓ THẮNG mục 2 này — mục 2 chỉ dùng khi người dùng KHÔNG chọn phong cách riêng. Người "
    "dùng chọn giọng gì thì viết đúng giọng đó, KHÔNG tự đổi sang giọng theo thể loại bạn đoán được.\n"
    # ⚠ ĐÃ THỬ & GỠ (29/07): thêm chốt "phong cách KHÔNG được biến thành phiên âm Hán-Việt". Lý do gỡ:
    # (a) KHÔNG ăn — test lại vẫn ra 'Nhĩ tưởng thiêu ngô gia ma?'; (b) ca đó do TÔI tự bịa chuỗi phong cách
    # ('dùng từ Hán-Việt, xưng hô cổ') chứ KHÁCH KHÔNG nhập được: UI chỉ cho chọn 7 cụm CỐ ĐỊNH do tool kiểm
    # soát (hài hước/viral/kịch tính/cảm xúc/đời thường/văn học/ngắn gọn — web_app.py:5104), free-text đã bị
    # bỏ có chủ đích. Đừng thêm lại nếu không tái hiện được bằng thao tác THẬT trên UI.
    "   - Nếu là CỔ TRANG / TU TIÊN: BẮT BUỘC dùng từ Hán-Việt cho danh từ đặc thù (chiêu thức, đan dược, "
    "tông môn, pháp bảo, cảnh giới...). VD: 'Ngự Kiếm Thuật', 'Trúc Cơ' (Cấm dịch thuần Việt như 'Kỳ xây "
    "nền'). Xưng hô: tại hạ, các hạ, sư tôn, đồ đệ, đạo hữu, vãn bối, lão phu...\n"
    "   - Nếu là HIỆN ĐẠI / DRAMA / ĐỜI SỐNG: Lời thoại phải là KHẨU NGỮ đời thường, mượt mà. Xưng hô linh "
    "hoạt theo quan hệ (anh/em, ông/tôi, mày/tao, vợ/chồng...). Có thể dùng từ lóng, nói giảm, nói tắt của "
    "người Việt hiện đại.\n"
    "   - Nếu là REVIEW / TIN TỨC / KIẾN THỨC: Giọng kể khách quan, rõ ràng, gãy gọn. Chú trọng dịch chuẩn "
    "xác các thông số, con số và thuật ngữ chuyên ngành.\n"
    # 🔴 THÊM 01/08/2026 — do CHÍNH GEMINI tự khai khi bị hỏi "vì sao để sót chữ 技?" (test thật, 136 câu,
    # lọt 1 ca: 「この剣技も」 → "Cả kiếm技 tuyệt đỉnh này nữa"). Nó trả lời: (a) khi gặp từ ghép Hán-Nhật/Hán-Trung
    # nó kích hoạt sẵn gốc Hán-Việt rồi SÓT bước lọc ký tự cuối lúc ghép chuỗi; (b) ràng buộc "giữ sát nghĩa +
    # ngắn gọn" XUNG ĐỘT với lệnh cấm-Hán, và nó ưu tiên giữ thuật ngữ gốc ngắn. ⇒ Bài học: prompt cũ chỉ nói
    # CẤM GÌ mà không nói PHẢI LÀM GÌ khi gặp từ ghép Hán — thiếu lệnh DƯƠNG nên model chọn đường ngắn nhất.
    # Câu dưới là do chính nó đề xuất, thêm vào để bịt đúng lỗ đó.
    "2b. KHÔNG ĐỂ LỌT CHỮ HÁN — NHƯNG CŨNG KHÔNG PHIÊN ÂM: bản dịch không được còn BẤT KỲ ký tự chữ Hán nào "
    "(kể cả 1 chữ lẻ dính trong từ, vd 技, 剣) hay pinyin. Từ gốc Hán phải được dịch sang NGHĨA tiếng Việt "
    "(vd 剣技 → 'kiếm thuật' / 'kỹ năng').\n"
    "   ⛔ NGHIÊM CẤM PHIÊN ÂM HÁN-VIỆT MÁY MÓC TỪNG CHỮ. Phiên âm KHÔNG phải là dịch. Đối chiếu SAI → ĐÚNG: "
    "'这是一种' → SAI 'giá thị nhất loại' / ĐÚNG 'Đây là một loại'; "
    "'流浪行星' → SAI 'lưu láng hành tinh' / ĐÚNG 'hành tinh lang thang'; "
    "'公转' → SAI 'công chuyển' / ĐÚNG 'quay quanh'; "
    "'虽然…不太现实' → SAI 'tuy tuyển… bất thái hiện thực' / ĐÚNG 'tuy… không thực tế lắm'. "
    "Hư từ (这是, 虽然, 但是, 因此…) LUÔN dịch thành hư từ tiếng Việt thường ngày, TUYỆT ĐỐI không phiên âm.\n"
    "3. KHỬ VĂN DỊCH MÁY: Áp dụng cho MỌI thể loại. Cấm dùng các cụm từ rập khuôn, thừa thãi như "
    "\"một cách...\", \"sự...\", \"việc mà...\", \"điều đó...\". Lời thoại phải mượt như người Việt thật sự nói.\n"
    "=== HẾT QUY TẮC ===\n\n")


def dich_srt(srt_path, out_path, show=False, wait_login=180, tm_dir="translation_memory", log_fn=print, keep=False, che_do="dich"):
    """Dịch zh.srt → vi.srt IN-PROCESS (cho render_worker bền). keep=True: dùng phiên Gemini bền (giữ nóng
    qua render). Trả code: 0 đủ, 1 srt rỗng, 3 thiếu (<80%). Caller (localize) Google bù câu sót.
    Logic == CLI cũ (tách ra để localize gọi thẳng, KHÔNG spawn subprocess → bỏ overhead + giữ browser).
    che_do='suachinhta': nguồn=đích (vd video Việt reup) → KHÔNG dịch, chỉ Gemini SỬA LỖI CHÍNH TẢ/dấu câu
    lời Whisper nhận dạng (giữ nguyên ý + số dòng). Tái dùng toàn bộ chunk/loop/parse của luồng dịch."""
    segs = doc_srt(srt_path)
    log_fn("[1] Đọc %d câu từ %s" % (len(segs), os.path.basename(srt_path)))
    if not segs:
        log_fn("SRT rỗng"); return 1

    # Ngôn ngữ ĐÍCH: TARGET_LANG do web_app truyền (mirror phu_de._dich_vi) — TRƯỚC ĐÂY prompt cứng "TIẾNG VIỆT"
    # bất kể đích gì → chọn đích=en (lồng tiếng Kokoro/edge-en) vẫn ra bản dịch TIẾNG VIỆT (sai hoàn toàn, TTS
    # tiếng Anh đọc phải văn bản Việt). Giờ đọc đích thật → dựng prompt tiếng Anh khi cần.
    tgt = (os.environ.get("TARGET_LANG") or "vi").strip().lower()
    try:                                   # cho MỌI ngôn ngữ đích trong bảng ngon_ngu.LANGS (mirror phu_de._dich_vi)
        import ngon_ngu
        if tgt not in ngon_ngu.HO_TRO:
            tgt = "vi"
    except Exception:
        if tgt not in ("vi", "en", "ko"):
            tgt = "vi"
    if tgt != "vi":
        log_fn("[1a] Đích dịch = %s (không phải Việt) → dùng prompt tiếng Anh." % tgt)

    # Từ điển tên riêng/quy tắc (translation_memory/*.md) BẢN CHẤT là Hán→VIỆT (tên Hán-Việt, thuật ngữ
    # Việt, luật độ-dài tiếng Việt) → CHỈ nạp khi đích=vi. Đích=en nạp vào sẽ ép tên kiểu "Triệu Lộ Tư" vào
    # câu tiếng Anh (đáng lẽ "Zhao Lusi") → BỎ. (Phong cách vẫn giữ vì là lựa chọn văn phong của user.)
    _glossary = doc_tm(tm_dir) if tgt == "vi" else ""
    # Quy tắc dịch: env DICH_QUY_TAC = phong cách ĐÃ CHỌN (web_app, nút chọn-nhiều) → GHÉP THÊM vào từ điển
    # thay vì THAY THẾ — trước đây thay thế làm mất nhất quán Hán-Việt (tên nhân vật...) mỗi khi chọn phong
    # cách. Rỗng ("" tường minh, dùng cho CLI cũ) → không viết lại, cũng không nạp glossary. Không đặt biến →
    # quét thư mục (cách cũ, chỉ vi).
    if "DICH_QUY_TAC" in os.environ:
        _pc = (os.environ.get("DICH_QUY_TAC") or "").strip()
        if _pc:
            tm = (_pc + "\n\n" + _glossary) if _glossary else _pc
            log_fn("[1b] Nạp phong cách đã chọn (%d ký tự) + từ điển tên riêng (%d ký tự) → đấu vào prompt"
                   % (len(_pc), len(_glossary)))
        else:
            tm = ""
    else:
        tm = _glossary
        if tm:
            log_fn("[1b] Nạp quy tắc + từ điển tên riêng (%s, %d ký tự) → đấu vào prompt" % (tm_dir, len(tm)))

    # CHUNK: video DÀI (1 tiếng ~1000+ câu) → 1 prompt khổng lồ làm Gemini CẮT output (rớt Google). Chia LÔ
    # ~CHUNK câu (đánh số LOCAL 1..N mỗi lô — Gemini giữ số nhỏ chuẩn hơn), gửi từng lô (chat riêng) rồi GHÉP.
    # 180→450→400: ĐO THẬT (2026-07-07) Gemini web nuốt 600 câu/lô KHÔNG cắt output (câu ZH ~11 ký tự → 600 câu
    # chỉ ~6.6K ký tự input, output vi vẫn đủ). 180 quá thận trọng gấp ~3× → nhiều lô nối đuôi. Hạ 450→400 (user:
    # nghi lô quá dài gây lỗi/chậm) — vẫn giảm mạnh số lô mà an toàn hơn cho câu dài/output vi dài. Chỉnh: GEMINI_CHUNK.
    try:
        CHUNK = int(os.environ.get("GEMINI_CHUNK", "400") or 400)
    except ValueError:
        CHUNK = 400
    if CHUNK < 20:
        CHUNK = 20
    # KHỚP LỒNG TIẾNG (length-control): câu Việt thường DÀI hơn khe sub → giọng đọc chậm hơn hình (đo thật:
    # median over-length 1.35×, 52% câu >1.3×). Gắn [≤N]/dòng → Gemini dịch NGẮN khớp sẵn → đỡ nén/đuổi.
    # Tắt: DUB_FIT_LEN=0.
    #
    # 🔴 SỬA GỐC (01/08/2026 — chủ dự án: "lồng tiếng đọc quá nhanh vì chữ Trung ít âm hơn tiếng Việt"):
    # neo cũ đo bằng KÝ TỰ (N = giây × DUB_CPS=16) — SAI ĐƠN VỊ. Thời lượng đọc phụ thuộc SỐ ÂM TIẾT chứ
    # không phải số ký tự, mà tỉ lệ ký-tự/âm-tiết của 2 thứ tiếng lệch nhau rất xa:
    #     '中文' = 2 âm tiết / 2 ký tự      |  'Chúng ta đi thôi' = 4 âm tiết / 16 ký tự
    # ⇒ với tiếng Việt, neo-theo-ký-tự LỎNG hơn thực tế nhiều lần: model viết đủ 16 ký tự/giây tưởng đạt,
    # thật ra đã vượt xa số âm tiết đọc kịp ⇒ TTS phải tăng tốc ⇒ đọc nhanh, méo giọng (đúng lỗi khách gặp).
    # MAY: tiếng Việt mỗi ÂM TIẾT = 1 TỪ cách nhau bởi dấu cách ⇒ đếm âm tiết = `len(s.split())`, chính xác
    # và rẻ. Nay neo theo TỪ/giây (DUB_WPS). Đích KHÁC (en/ko/ja…) KHÔNG có quan hệ 1 từ = 1 âm tiết ⇒ giữ
    # neo ký tự cũ cho an toàn.
    #
    # ⚠ CÁCH CHỌN GIÁ TRỊ 5.5 → 3.5 (suýt sai, bắt được lúc ĐO trước khi chốt): "nhịp nói tiếng Việt 5-6 âm
    # tiết/giây" là con số ĐÚNG về ngôn ngữ học NHƯNG SAI làm mặc định ở đây. Phải neo vào HÀNH VI CŨ mới đúng:
    # neo cũ 16 ký tự/giây ÷ ~4.2 ký-tự-mỗi-từ (kể dấu cách) ≈ **3.8 từ/giây** — mà chủ dự án nói mức đó VẪN
    # đọc quá nhanh ⇒ mức mới BẮT BUỘC phải ≤3.8, không phải 5.5. Đặt 3.5 (chặt hơn hành vi cũ một chút).
    # Nếu lấy 5.5 thì khe 3s cho tới 16 từ trong khi neo cũ chỉ ~11 từ ⇒ LỎNG HƠN ⇒ làm bệnh nặng thêm.
    # BÀI HỌC: đổi đơn vị đo thì phải QUY ĐỔI và so với hành vi cũ, đừng lấy con số "chuẩn sách vở" làm mặc định.
    # 🔴 LẦN 2 (cùng ngày, sau khi TEST 2 SRT): hằng số 3.5 CŨNG SAI — mật độ nói 2 loại video chênh gần gấp
    # đôi (anime 4.1 vs thuyết minh 7.5 âm/giây) ⇒ mọi hằng số đều sai một phía. Nay trần tính ĐỘNG theo từng
    # cue: `tran_tu_dich()` = min(giây×WPS, số_âm_gốc×TILE). WPS nay là trần VẬT LÝ (5.0 — mức TTS đọc chưa
    # phải ép nhanh), KHÔNG còn là "tốc độ mục tiêu". Xem docstring `tran_tu_dich` để biết vì sao 0.75.
    FIT = os.environ.get("DUB_FIT_LEN", "1") != "0"
    try:
        CPS = float(os.environ.get("DUB_CPS", "16") or 16)
    except ValueError:
        CPS = 16.0
    try:
        WPS = float(os.environ.get("DUB_WPS", "5.0") or 5.0)      # trần VẬT LÝ (từ/giây) — TTS đọc kịp
    except ValueError:
        WPS = 5.0
    try:
        TILE = float(os.environ.get("DUB_TILE_AM", "0.75") or 0.75)   # trần THEO NGUỒN (× số âm tiết gốc)
    except ValueError:
        TILE = 0.75
    prefix = ""
    if tgt == "vi":
        prefix += _QUY_TAC_CHUNG   # luật NỀN (lỗi OCR / thể loại / khử văn dịch máy) — luôn có, xem hằng ở trên
        if tm:   # đấu TỪ ĐIỂN tên riêng + thuật ngữ vào MỖI lô (giữ nhất quán Hán-Việt giữa các lô)
            prefix += ("QUY TẮC + TỪ ĐIỂN TÊN RIÊNG (BẮT BUỘC, nhất quán Hán-Việt):\n"
                       "=== QUY TẮC ===\n" + tm + "\n=== HẾT ===\n\n")
        prefix += ("Bạn là NGƯỜI BẢN NGỮ đang KỂ LẠI câu chuyện dưới đây bằng tiếng Việt — KHÔNG PHẢI máy dịch từng "
                   "chữ. Áp dụng các quy tắc ở trên.\n"
                   "CÁCH LÀM (theo đúng thứ tự):\n"
                   "1) ĐỌC HẾT cả đoạn dưới trước — đây là 1 ĐOẠN LIÊN TỤC (hội thoại/thuyết minh của CÙNG người "
                   "nói), KHÔNG phải câu rời rạc.\n"
                   "2) HIỂU tình huống: chuyện gì đang xảy ra, ai nói với ai, họ đang muốn truyền đạt điều gì "
                   "(thông tin/cảm xúc/ý định) — không chỉ dịch nghĩa đen từng chữ.\n"
                   "3) Chốt xưng hô + đại từ (tôi/mình/bạn/anh/chị...) và GIỮ NHẤT QUÁN xuyên suốt cả đoạn.\n"
                   "4) VIẾT LẠI từng câu bằng tiếng Việt tự nhiên — NHƯ NGƯỜI VIỆT THẬT SỰ SẼ NÓI trong tình huống "
                   "đó. Mục tiêu là ĐÚNG Ý NGHĨA + CẢM XÚC + TÌNH TIẾT của cả câu chuyện, KHÔNG PHẢI đúng câu chữ "
                   "gốc. ĐƯỢC PHÉP đổi cấu trúc câu, đổi cách diễn đạt, viết lại hoàn toàn khác — miễn giữ đủ thông "
                   "tin và tình tiết. Câu cụt/thiếu chủ ngữ → suy đúng nghĩa từ ngữ cảnh xung quanh.\n"
                   "QUY TẮC PHỤ ĐỀ — bạn LÀM PHỤ ĐỀ cho LỒNG TIẾNG, giọng phải đọc kịp trong khe thời gian mỗi câu "
                   "nên CÀNG NGẮN CÀNG TỐT miễn giữ đủ ý — NGẮN phải là KẾT QUẢ TỰ NHIÊN của việc kể lại theo cách "
                   "người Việt nói, KHÔNG PHẢI dịch sát nghĩa xong rồi mới cắt bớt chữ:\n"
                   "- Nếu Ở TRÊN có yêu cầu VIẾT LẠI theo phong cách → phong cách đó quyết GIỌNG VĂN, nhưng các quy tắc ngắn-gọn/thời-lượng ở đây vẫn là TRẦN độ dài.\n"
                   "- GIỮ ý CỐT LÕI + MỌI chi tiết mô tả (đặc điểm, con số, tính chất được kể) — KHÔNG bỏ tình tiết + KHÔNG bịa. Câu LIỆT KÊ nhiều đặc điểm (vd đặc tính đồ vật) → GIỮ ĐỦ mọi đặc điểm, chỉ rút gọn CÁCH NÓI.\n"
                   "- Thêm DẤU PHẨY / DẤU CHẤM ở chỗ NGẮT NHỊP tự nhiên (tool cắt dòng phụ đề theo các dấu này).\n"
                   "- KHÔNG viết tắt (KHÔNG 'TQ','HN','ko'…) — phụ đề này còn dùng để LỒNG TIẾNG đọc thành tiếng.\n"
                   "- DỊCH 1:1 (RÀNG BUỘC CỨNG, KHÔNG ĐƯỢC PHÁ dù viết lại tự do về CÁCH NÓI): MỖI dòng gốc VẪN → "
                   "ĐÚNG 1 dòng dịch, đúng thứ tự, TUYỆT ĐỐI KHÔNG gộp/tách/bỏ dòng — mỗi dòng gốc gắn 1 khe thời "
                   "gian cố định trong video, gộp/tách sẽ làm LỆCH đồng bộ hình-tiếng (tool dedupe câu trùng TRƯỚC "
                   "khi gửi — bạn KHÔNG cần lo lặp).\n"
                   "  ⚠ KỂ CẢ dòng RẤT NGẮN hay câu DẪN/NỐI ('tóm lại', 'tức là', 'nói cách khác', 'và', 'thì', "
                   "'nó là'…) VẪN phải có 1 dòng dịch RIÊNG mang ĐÚNG số đó — TUYỆT ĐỐI KHÔNG dồn câu dẫn ngắn "
                   "vào dòng kế rồi đánh số lại. Bỏ 1 dòng sẽ làm LỆCH SỐ toàn bộ phụ đề phía sau (chữ hiện sai "
                   "thời điểm, sub gốc dài mà bản dịch ngắn). SỐ DÒNG OUTPUT PHẢI BẰNG SỐ DÒNG INPUT.\n"
                   # 🐛 FIX (đo thật: outro/lời bình nhiều câu 3-6 chữ liên tiếp cùng ý — Gemini "kể lại tự
                   # nhiên như 1 khối" (đúng ý mục 1-4 ở trên) rồi GỘP các câu ngắn liền mạch thành 1 câu văn
                   # xuôi, dù bị cấm 3 lần ở trên → THIẾU dòng cuối HOẶC (nguy hiểm hơn) nội dung TRÔI/LỆCH
                   # sang số khác — verify test 669 câu thật: dòng 660-663 "ăn" luôn ý của 661-669, 6 dòng cuối
                   # rỗng/lệch). "Kể tự nhiên" (mục 1-4) và "1:1 cứng" ở trên ĐANG MÂU THUẪN khi câu quá ngắn —
                   # nhắc lại RÕ RÀNG là "1:1 cứng" LUÔN THẮNG, kể cả khi kết quả nghe rời rạc hơn:
                   "  ⚠ ĐOẠN CUỐI/LỜI BÌNH có NHIỀU DÒNG NGẮN LIÊN TIẾP (3-6 chữ, cùng 1 mạch ý — vd lời bình "
                   "kết phim) là nơi DỄ PHẠM LUẬT 1:1 NHẤT: bạn sẽ có xu hướng gộp chúng thành 1 câu văn xuôi "
                   "trôi chảy cho tự nhiên — TUYỆT ĐỐI KHÔNG LÀM VẬY. VD 3 dòng gốc '却又在最高潮处' / '无情撕碎了人定"
                   "胜天的幻想' / '电影安东败给闯红灯的路人' PHẢI ra ĐÚNG 3 dòng dịch riêng (mỗi dòng ý ngắn/cụt cũng "
                   "được, KHÔNG được nối chúng thành 1 câu dài rồi bỏ 2 dòng kia). Nghe rời rạc hơn văn xuôi "
                   "KHÔNG SAO — đây là PHỤ ĐỀ đồng bộ theo khung hình, không phải văn bản đọc liền mạch.\n")
        if FIT:
            # THEO CHÍNH GEMINI TỰ KHAI (2026-07): (1) "giữ nghĩa > ngắn" mơ hồ làm nó LUÔN chọn dài → đổi thành
            # "giữ THÔNG TIN CỐT LÕI, ĐƯỢC PHÉP cắt từ đệm/đại từ/từ nối"; (2) ĐỪNG bắt đếm ký tự (LLM đếm theo
            # token, đoán mò) → [≤N] chỉ là NEO độ dài; (3) few-shot 3 mẫu Gốc→Sai(dài)→Đúng(ngắn); (4) mẹo Việt:
            # ưu tiên Hán-Việt (ngắn hơn), bỏ chủ ngữ khi ngữ cảnh rõ, bỏ 'thì/mà/là/rằng'.
            prefix += ("- KHỚP LỒNG TIẾNG (QUAN TRỌNG — đọc kỹ): đầu mỗi dòng có [Ts ≤N từ] = câu này có T GIÂY để TTS "
                       "đọc, và ĐỌC KỊP thì bản dịch KHÔNG ĐƯỢC QUÁ N TỪ. Đếm rất dễ: mỗi từ cách nhau 1 dấu cách "
                       "('Anh ấy tới rồi' = 4 từ). ĐÂY LÀ TRẦN CỨNG — vượt N từ là giọng đọc bị ép nhanh, méo tiếng.\n"
                       "  Vì sao dễ vượt: tiếng Trung 1 chữ = 1 âm, tiếng Việt cùng ý thường TỐN NHIỀU ÂM HƠN — nên "
                       "dịch sát chữ gần như luôn tràn. Phải CHỦ ĐỘNG nén ngay từ lúc viết, không phải viết dài rồi cắt.\n"
                       "  ĐỊNH NGHĨA 'giữ nghĩa' Ở ĐÂY = giữ THÔNG TIN CỐT LÕI (AI làm GÌ, cái GÌ, con số, tình tiết) — "
                       "và ĐƯỢC PHÉP CẮT BỎ: từ đệm (thật sự, rất rất, một cách, đấy, ấy mà, vô cùng), từ nối (thì, mà, "
                       "là, rằng), đại từ/chủ ngữ khi ngữ cảnh đã rõ. Được dùng từ Hán-Việt THÔNG DỤNG khi nó "
                       "ngắn hơn mà người Việt vẫn hiểu ngay ('phát biểu' 2 từ thay 'đưa ra ý kiến' 4 từ) — "
                       "NHƯNG TUYỆT ĐỐI KHÔNG vì ngắn mà PHIÊN ÂM Hán-Việt những từ người Việt không dùng đời "
                       "thường (SAI: 'giá thị', 'công chuyển', 'bất thái', 'lưu láng'). Ngắn mà người nghe KHÔNG "
                       "HIỂU thì còn tệ hơn dài. TUYỆT ĐỐI KHÔNG in [Ts ≤N từ] vào bản dịch.\n"
                       "  VÍ DỤ (Gốc → SAI dài → ĐÚNG ngắn), để ý số TỪ: "
                       "'他来了' → 'Anh ấy đã đến nơi đây rồi đấy' (8 từ, SAI) → 'Anh ấy tới rồi' (4 từ, ĐÚNG); "
                       "'太美了' → 'Cái này thực sự là quá đẹp đi mà' (8 từ, SAI) → 'Đẹp quá' (2 từ, ĐÚNG); "
                       "'我不知道该怎么办' → 'Tôi thực sự không biết mình nên phải làm thế nào' (11 từ, SAI) → "
                       "'Không biết làm sao' (4 từ, ĐÚNG).\n")
        prefix += ("LƯU Ý INPUT: '@HH:MM:SS' đầu mỗi dòng = MỐC GIỜ câu xuất hiện trong video — CHỈ để bạn hiểu "
                   "TIMING + nhận ra câu TRÙNG kề nhau (2 dòng sát giờ + cùng ý = phụ đề song ngữ). TUYỆT ĐỐI "
                   "KHÔNG in '@HH:MM:SS' vào bản dịch.\n")
        if FIT:   # NHẮC LẠI ràng buộc NGẮN ở CUỐI prompt (Gemini tự khai: AI chú ý nhất ĐẦU + CUỐI)
            prefix += ("★ NHẮC LẠI (quan trọng nhất): mỗi dòng KHÔNG ĐƯỢC VƯỢT số từ ghi ở [Ts ≤N từ] — đếm theo "
                       "dấu cách. Giữ THÔNG TIN CỐT LÕI, cắt từ đệm/nối/đại từ thừa, ưu tiên Hán-Việt.\n")
        prefix += ("CHỈ trả về BẢN DỊCH: mỗi dòng MỘT câu, GIỮ NGUYÊN số thứ tự '1.' '2.'… đầu mỗi dòng, đúng "
                   "thứ tự, KHÔNG gộp/tách dòng. TUYỆT ĐỐI KHÔNG thêm chữ nào khác — không lời dẫn, không xác "
                   "nhận, không giải thích, không markdown:\n\n")
    else:   # tgt != vi: dich sang NGON NGU DICH bat ky (parametric theo ten tieng Anh) — GOP en/ko/fr/es/th/de...
        try:
            import ngon_ngu
            _LN = (ngon_ngu.LANGS.get(tgt) or {}).get("ten_en") or tgt.upper()
        except Exception:
            _LN = {"en": "English", "ko": "Korean", "fr": "French", "es": "Spanish", "pt": "Portuguese",
                   "th": "Thai", "de": "German", "it": "Italian", "ja": "Japanese", "ru": "Russian",
                   "id": "Indonesian", "hi": "Hindi", "ar": "Arabic"}.get(tgt, tgt.upper())
        _NL = chr(10)
        if tm:
            prefix += "RULES + STYLE (MANDATORY, keep consistent):" + _NL + "=== RULES ===" + _NL + tm + _NL + "=== END ===" + _NL + _NL
        _pl = [
            "You are a NATIVE {L} SPEAKER retelling the story below in {L} - you are NOT a word-for-word translation machine. Write in the native script of {L} - do NOT romanize (e.g. Hangul for Korean, Thai script for Thai).",
            "HOW TO DO THIS (follow in order):",
            "1) READ THE WHOLE PASSAGE below first - it is ONE CONTINUOUS passage (dialogue/narration by the SAME speaker), NOT isolated sentences.",
            "2) UNDERSTAND the situation: what is happening, who is speaking to whom, what are they trying to convey (information/emotion/intent) - not just the literal words.",
            "3) Decide the register/pronouns and keep them CONSISTENT throughout the whole passage.",
            "4) REWRITE each line in natural {L}, the way a real {L} speaker would actually say it in that situation. Your goal is to preserve the MEANING, EMOTION and STORY of the whole conversation, NOT the exact wording of the source. You MAY restructure sentences, change phrasing, or rewrite it completely differently - as long as no information or plot detail is lost. A fragment or subject-less line -> infer the real meaning from context.",
            "SUBTITLE RULES - you are a professional SUBTITLE LOCALIZER for DUBBING; the voice must finish within each line's time slot, so SHORTER IS BETTER as long as meaning survives - brevity must come NATURALLY from retelling it the way a native speaker would, NOT from translating literally first and then trimming words:",
            "- If a STYLE rewrite is requested above, that style controls the TONE - but these timing/brevity rules still cap the LENGTH.",
            "- Keep the CORE meaning + ALL descriptive facts (attributes, numbers, qualities being described) - NEVER drop a plot detail and NEVER invent anything. If a line LISTS several attributes, keep EVERY attribute - only shorten the wording, never the list.",
            "- Add natural punctuation at pauses (the tool splits subtitle lines on these marks).",
            "- Do NOT abbreviate and do NOT romanize - this subtitle is also read aloud for DUBBING.",
            "- 1:1 TRANSLATION (HARD CONSTRAINT, DO NOT BREAK even though you rewrite freely in WORDING): EACH source line MUST STILL map to EXACTLY 1 translated line, same order - NEVER merge/split/drop lines (each source line is tied to a fixed time slot in the video; merging/splitting breaks audio-video sync). OUTPUT LINE COUNT MUST EQUAL INPUT LINE COUNT.",
            "  EVEN very short filler or connector lines MUST still get their OWN line with the EXACT SAME number - never merge a short line into the next one and renumber.",
            # 🐛 FIX (measured live: outro/commentary with many 3-6 word lines in a row — model "retells as one
            # continuous passage" (correctly following instruction 1-4 above) then MERGES the short consecutive
            # lines into one flowing sentence, despite being forbidden twice above -> missing tail lines OR
            # (worse) content DRIFTS onto the wrong line number. "Retell naturally" (1-4) and "hard 1:1" above
            # ACTIVELY CONFLICT when lines are very short — restate that 1:1 ALWAYS wins even if it reads choppy:
            "  ⚠ A RUN OF MANY SHORT CONSECUTIVE LINES (3-6 words, same train of thought - e.g. closing "
            "commentary) is where you are MOST LIKELY to break the 1:1 rule: you will be tempted to merge them "
            "into one flowing sentence for naturalness - DO NOT. Each of those short lines still gets its OWN "
            "translated line, even if it reads choppy/fragmented — this is a TIME-SYNCED SUBTITLE, not prose "
            "meant to be read as one paragraph.",
        ]
        prefix += (_NL.join(_pl) + _NL).replace("{L}", _LN)
        if FIT:
            # THEO GEMINI tự khai: 'keep meaning' mơ hồ → nó luôn chọn dài. Đổi thành 'keep CORE INFO, ALLOWED to
            # drop fillers/pronouns/honorifics'. [<=N] chỉ là length ANCHOR (đừng bắt đếm ký tự). + mẹo riêng ngôn ngữ.
            prefix += "- DUB TIMING (CRITICAL): each line starts with [Ts <=N] = this line has T SECONDS for the TTS voice. Keep it SHORT to fit — [<=N] is a length ANCHOR (don't literally count characters, just write it tight). 'Keep meaning' HERE = keep the CORE INFO (who does what, the facts/numbers) and you ARE ALLOWED to DROP: filler words, connectors, and pronouns/subjects when context is clear. Do NOT write long out of caution — trimming filler does NOT lose plot. NEVER print [Ts <=N] in the translation." + _NL
            # Mẹo rút gọn NGỮ PHÁP RIÊNG từng ngôn ngữ (HỎI CHÍNH GEMINI 2026-07 — nó biết ngữ pháp + biết mình
            # sinh dài ở đâu). Chỉ chèn đúng đích đang dịch. Ngôn ngữ ngoài danh sách → lệnh chung (fallback).
            _MEO = {
                "en": "- {L} BREVITY: use contractions (don't, it's, I'm), reduced clauses (V-ing/V-ed), drop 'that' in relative clauses, cut redundant articles/pronouns.",
                "ko": "- {L} BREVITY: Korean bloats from honorific endings — use short informal/plain endings (해요체/반말: -어/-아) or noun-style endings (-음/-기); DROP particles 은/는/이/가/을/를 where clear.",
                "th": "- {L} BREVITY: Thai bloats from sentence-final politeness words — DROP ครับ/ค่ะ and unnecessary pronouns; use short compound words instead of descriptive phrases.",
                "ja": "- {L} BREVITY: use plain form (だ/-る) instead of です/ます, DROP topic/subject/object particles は/が/を where clear.",
                "es": "- {L} BREVITY: Spanish is pro-drop — DROP subject pronouns (yo/tú/él); use gerund (-ando/-iendo) instead of 'que' relative clauses (el hombre que corre -> el hombre corriendo).",
                "pt": "- {L} BREVITY: Portuguese is pro-drop — DROP subject pronouns; contract estar (está -> tá in casual), turn 'de + pronoun' possessives into short possessive adjectives.",
                "fr": "- {L} BREVITY: replace 'est-ce que' with inversion/intonation; use pronouns en/y to collapse long prepositional phrases; drop redundant subject repetition.",
                "de": "- {L} BREVITY: contract preposition+article (in dem -> im, zu dem -> zum); turn relative clauses into pre-nominal participle phrases; drop optional pronouns.",
                "it": "- {L} BREVITY: Italian is pro-drop — DROP subject pronouns; attach object pronouns to the verb (mancarlo, not mancare a lui).",
                "ru": "- {L} BREVITY: DROP the present-tense 'to be' (быть); use case endings to omit non-essential prepositions; drop optional subject pronouns.",
                "id": "- {L} BREVITY: drop formal verb prefixes (me-, ber-) where natural; use short suffix -ku instead of 'punya saya'; cut the connector 'yang' when possible.",
                "ms": "- {L} BREVITY: drop prefixes (meng-, ber-), drop the connector 'yang', use short casual forms (dah for sudah).",
                "ar": "- {L} BREVITY: DROP subject pronouns (already in the verb ending); use Idhafa (direct noun-noun genitive) instead of prepositional possessive.",
                "hi": "- {L} BREVITY: drop the copula होना (to be) at the end when the tense is clear from context; use the -कर conjunctive participle to join two actions.",
                "tr": "- {L} BREVITY: DROP subject pronouns (verb ending already marks person); collapse subordinate clauses into a single verbal noun via suffixes (-dığı, -en).",
            }.get(tgt, "- {L} BREVITY: drop filler words, honorifics and optional pronouns; pick the shortest natural wording.")
            prefix += _MEO.replace("{L}", _LN) + _NL
            # Few-shot 3 mẫu (Gốc → SAI dài → ĐÚNG ngắn), tiếng Anh minh họa nguyên tắc cho mọi đích
            prefix += ("- BREVITY EXAMPLES (English shown; keep this tightness in {L}, Source -> WRONG long -> RIGHT short): "
                       "'他来了' -> 'He has finally arrived here now' (WRONG) -> \"He's here\" (RIGHT); "
                       "'太美了' -> 'This is really way too beautiful' (WRONG) -> 'So beautiful' (RIGHT); "
                       "'我不知道该怎么办' -> 'I really have no idea what I am supposed to do now' (WRONG) -> \"I don't know what to do\" (RIGHT).").replace("{L}", _LN) + _NL
        prefix += ("INPUT NOTE: '@HH:MM:SS' at the start of each line = the TIME MARK the line appears in the video - ONLY for you to understand TIMING + spot ADJACENT DUPLICATE lines. NEVER print '@HH:MM:SS' in the translation." + _NL)
        if FIT:   # NHẮC LẠI ràng buộc NGẮN ở CUỐI (Gemini tự khai: AI chú ý nhất ĐẦU + CUỐI prompt)
            prefix += ("★ REMINDER (most important): every line must be SHORT to fit its [Ts <=N] slot - keep CORE INFO, cut fillers/connectors/optional pronouns, use the language's short forms. A long-winded line = ERROR." + _NL)
        prefix += ("RETURN ONLY THE TRANSLATION in " + _LN + ": one line per sentence, KEEP the exact numbering 1. 2. at the start of each line, same order, do NOT merge or split lines. NEVER add anything else - no preamble, no confirmation, no explanation, no markdown:" + _NL + _NL)
    if che_do == "suachinhta":
        # NGUỒN = ĐÍCH (reup cùng ngôn ngữ) → KHÔNG DỊCH. Lời do Whisper nhận dạng hay SAI CHÍNH TẢ/đồng âm/thiếu
        # dấu ('hòa ra'→'hóa ra', 'chữ cháy'→'chữa cháy'). Gemini CHỈ sửa chính tả + dấu câu, GIỮ NGUYÊN Ý + SỐ DÒNG.
        prefix = ("Dưới đây là phụ đề do phần mềm nhận dạng giọng nói (Whisper) tạo ra nên có LỖI CHÍNH TẢ, sai "
                  "dấu thanh, sai từ đồng âm và thiếu dấu câu. Nhiệm vụ của bạn: KIỂM TRA và SỬA LỖI CHÍNH TẢ + "
                  "dấu câu cho từng dòng.\n"
                  "- CHỈ sửa chính tả/dấu — GIỮ NGUYÊN Ý, KHÔNG dịch, KHÔNG viết lại, KHÔNG thêm/bớt/gộp/tách câu.\n"
                  "- Dòng nào đã đúng → chép lại y nguyên.\n"
                  "CHỈ trả về kết quả: mỗi dòng MỘT câu, GIỮ NGUYÊN số thứ tự '1.' '2.'… đầu mỗi dòng, đúng thứ tự, "
                  "KHÔNG gộp/tách dòng. TUYỆT ĐỐI KHÔNG thêm gì khác — không lời dẫn, không giải thích, không markdown:\n\n")
        FIT = False   # sửa chính tả KHÔNG ép ngắn câu ([Ts ≤N] chỉ dành cho dịch/lồng tiếng) → _pline bỏ anchor
        log_fn("[1c] Chế độ SỬA CHÍNH TẢ (nguồn = đích, không dịch) — Gemini chỉ sửa lỗi Whisper.")
    lo = [segs[i:i + CHUNK] for i in range(0, len(segs), CHUNK)]

    def _pline(j, ts, zh):
        tg = ts.split("-->")[0].strip().split(",")[0] if ("-->" in (ts or "")) else ""   # mốc giờ BẮT ĐẦU HH:MM:SS
        tg = ("@%s " % tg) if tg else ""
        if FIT:
            s = _slot_giay(ts)
            if s > 0:
                if tgt == "vi":     # tiếng Việt: 1 TỪ = 1 ÂM TIẾT → neo theo TỪ, khớp thời lượng đọc thật
                    return "%d. %s[%.1fs ≤%d từ] %s" % (
                        j + 1, tg, s, tran_tu_dich(s, zh, wps_max=WPS, ti_le=TILE), zh)
                return "%d. %s[%.1fs ≤%d] %s" % (j + 1, tg, s, max(10, round(s * CPS)), zh)
        return "%d. %s%s" % (j + 1, tg, zh)
    prompts = [prefix + "\n".join(_pline(j, ts, zh) for j, (ts, zh) in enumerate(chunk))
               for chunk in lo]
    if len(lo) > 1:
        log_fn("[2] Video DÀI %d câu → chia %d lô (~%d câu/lô) gửi Gemini (tránh cắt output)" % (
            len(segs), len(lo), CHUNK))

    # validate: lô ĐỦ câu chưa (≥90%) → thiếu thì hoi_gemini_web_nhieu GỬI LẠI lô đó (Gemini tự bù).
    # 🐛 fix: TRƯỚC ĐÂY chỉ đếm SỐ LƯỢNG dòng parse được — Gemini lười/lỗi trả GẦN NGUYÊN VĂN chữ Hán (chỉ
    # khác dấu câu/khoảng trắng với zh gốc, ví dụ model tự thêm '？') vẫn đếm đủ 90% → KHÔNG gửi lại lô, câu
    # đó lọt thẳng ra phụ đề vì mọi guard ở localize.py chỉ so sánh tuyệt đối vi==zh (không bắt được khác-byte
    # nhưng vẫn Hán). Đo THÊM tỉ lệ Hán mỗi dòng: dòng nào ≥HAN_NET_NGUONG (mặc định 0.35, cùng ngưỡng với
    # localize._chuan_hoa_tts để nhất quán) coi là "chưa dịch thật" dù có match được số thứ tự. CHỈ áp dụng
    # cho che_do='dich' (đích khác nguồn) — 'suachinhta' (nguồn=đích) không dịch nên giữ nguyên ngôn ngữ gốc
    # là ĐÚNG, không phải bug.
    try:
        _han_nguong = float(os.environ.get("HAN_NET_NGUONG", "0.35") or 0.35)
    except ValueError:
        _han_nguong = 0.35
    def _du(ci, resp):
        _kq = _parse_lo(resp, len(lo[ci]))
        if len(_kq) < len(lo[ci]) * 0.9:
            return False
        if che_do == "dich" and _han_nguong > 0:
            for _v in _kq.values():
                if _ty_le_han(_v) >= _han_nguong:
                    return False
        if _nghi_gop_cau(_kq):
            return False
        return True

    resps_acc = [""] * len(prompts)
    def _ghi(ci, resp):           # ghi LŨY TIẾN sau mỗi lô → timeout/crash vẫn giữ các lô đã xong
        resps_acc[ci] = resp
        # SỐ CÂU GỬI vs SỐ CÂU DỊCH ĐƯỢC của ĐÚNG lô này (không phải tổng toàn video) — trước đây chỉ log
        # khoảng câu (vd "655–669"), không biết lô ĐÓ thiếu bao nhiêu → khi khách báo "đôi lúc mất sub" phải
        # tự viết script phân tích thủ công mới lần ra được đúng vị-trí sót. Log rõ ngay tại đây để chẩn đoán
        # nhanh từ log render thật, không cần dựng lại môi trường test.
        try:
            _gui = len(lo[ci])
            _dich_duoc = len(_parse_lo(resp, _gui))
            if _dich_duoc < _gui:
                log_fn("📝 Dịch xong lô %d/%d (câu %d–%d) — ⚠ CHỈ %d/%d câu (thiếu %d, sẽ retry câu sót ở bước sau)"
                       % (ci + 1, len(lo), ci * CHUNK + 1, min(len(segs), (ci + 1) * CHUNK),
                          _dich_duoc, _gui, _gui - _dich_duoc))
            else:
                log_fn("📝 Dịch xong lô %d/%d (câu %d–%d) — đủ %d/%d câu"
                       % (ci + 1, len(lo), ci * CHUNK + 1, min(len(segs), (ci + 1) * CHUNK), _dich_duoc, _gui))
        except Exception:
            pass
        try:
            out_l, _ = _ghep(segs, lo, CHUNK, resps_acc)
            open(out_path, "w", encoding="utf-8").write("\n".join(out_l))
        except Exception as _e:
            # 🐛 fix (audit cải tiến #E, #H8): đây CHÍNH LÀ cơ chế ghi LŨY TIẾN để "timeout/crash vẫn giữ lô đã
            # xong" — nếu chính việc ghi này lỗi (đĩa đầy/quyền/đường dẫn), đúng lúc cần cơ chế an toàn này nhất
            # (subprocess bị kill/crash) lại không có gì để phục hồi, mà không ai biết vì sao. Log để còn manh mối.
            try:
                log_fn("⚠ [dich_gemini] Ghi lũy tiến lô %d lỗi: %s" % (ci + 1, str(_e)[:120]))
            except Exception:
                pass

    _tries = 3 if len(lo) > 1 else 2     # video dài: thử lại tới 3 lần/lô để Gemini đủ câu, đỡ rớt Google
    resps = hoi_gemini_web_nhieu(prompts, show=show, wait_login=wait_login,
                                 on_resp=_ghi, validate=_du, tries=_tries, log_fn=log_fn, keep=keep)
    log_fn("[6] Ghép theo SỐ thứ tự trong từng lô (bền với lệch)...")
    # loc_ban_han CHỈ bật cho che_do='dich' (đích khác nguồn) — 'suachinhta' giữ nguyên ngôn ngữ gốc là ĐÚNG.
    out, vi = _ghep(segs, lo, CHUNK, resps, loc_ban_han=(che_do == "dich"))
    open(out_path, "w", encoding="utf-8").write("\n".join(out))
    log_fn("[7] GHÉP xong: %s — %d/%d câu (%d lô)" % (out_path, len(vi), len(segs), len(lo)))
    return 0 if len(vi) >= len(segs) * 0.8 else 3


def dich_batch(items, tgt=None, show=False, wait_login=180, tm_dir="translation_memory",
               log_fn=print, keep=False):
    """BATCH DỊCH nhiều video: items = [{'vid','idx','ts','zh'}...] gom câu TỪ NHIỀU video → 1 lô Gemini →
    tách về từng video theo (vid, idx). Trả {(vid, idx): text_dich}. Câu thiếu KHÔNG có trong dict (caller giữ zh).

    KHÁC dich_srt: gắn MARKER <<<SEG:vid:idx>>> mỗi câu (không đánh số vị-trí) → gom NHIỀU video an toàn, Gemini
    gộp/bỏ dòng cũng tách đúng. Chia lô theo SỐ CÂU + KÝ TỰ (BATCH_MAX_SEG / BATCH_MAX_CHARS), KHÔNG theo video.
    dich_srt cũ GIỮ NGUYÊN — hàm này chỉ chạy khi web_app gọi tường minh (gate ở web_app)."""
    if not items:
        return {}
    tgt = (tgt or os.environ.get("TARGET_LANG") or "vi").strip().lower()
    try:
        import ngon_ngu
        if tgt not in ngon_ngu.HO_TRO:
            tgt = "vi"
    except Exception:
        if tgt not in ("vi", "en", "ko"):
            tgt = "vi"

    # PREFIX: tái dùng style/glossary/FIT như dich_srt (dựng gọn, cùng tinh thần). Chi tiết prompt dài giữ ở
    # dich_srt; batch chỉ cần lệnh cốt lõi + LỆNH GIỮ MARKER (điểm khác biệt bắt buộc).
    _glossary = doc_tm(tm_dir) if tgt == "vi" else ""
    _pc = (os.environ.get("DICH_QUY_TAC") or "").strip() if "DICH_QUY_TAC" in os.environ else ""
    tm = ((_pc + "\n\n" + _glossary) if (_pc and _glossary) else (_pc or _glossary))
    FIT = os.environ.get("DUB_FIT_LEN", "1") != "0"
    try:
        CPS = float(os.environ.get("DUB_CPS", "16") or 16)
    except ValueError:
        CPS = 16.0
    try:
        _Lname = ngon_ngu.LANGS.get(tgt, {}).get("ten_en", tgt.upper())
    except Exception:
        _Lname = "Vietnamese" if tgt == "vi" else tgt.upper()

    prefix = ""
    if tm:
        prefix += "RULES + GLOSSARY (mandatory, keep consistent):\n=== RULES ===\n" + tm + "\n=== END ===\n\n"
    prefix += (
        "Dịch các câu dưới đây sang %s tự nhiên (người bản ngữ nói), giữ đủ ý + cảm xúc, KHÔNG dịch máy từng chữ.\n"
        "MỖI câu bắt đầu bằng 1 DÒNG MARKER dạng <<<SEG:xxx:00000>>> rồi tới nội dung.\n"
        "RÀNG BUỘC CỨNG:\n"
        "1. GIỮ NGUYÊN mọi dòng marker <<<SEG:...>>> — CHÉP LẠI Y HỆT, KHÔNG dịch/sửa/xóa/thêm marker.\n"
        "2. Dưới mỗi marker viết ĐÚNG 1 câu dịch của nội dung câu đó (giữ thứ tự marker).\n"
        "3. KHÔNG gộp/tách/bỏ câu. KHÔNG thêm lời dẫn/giải thích/markdown.\n"
        % _Lname)
    if FIT:
        # ĐẾM TỪ thay KÝ TỰ: LLM đếm token → "mù" số ký tự (test thật: ≤N ký tự → tràn 4/4). Đếm TỪ (khoảng trắng)
        # LLM nhạy hơn HẲN (test: ≤W từ → 3/5 OK, 2 câu tràn 1 từ). + CẨM NANG NÉN tiếng Việt (bỏ chủ ngữ/từ đệm,
        # Hán-Việt gom nghĩa) + few-shot phạt câu dài → Gemini học cách cô đọng. Giảm tải tầng nén atempo (chỉ ~2-5%
        # thay vì tua giật). Chỉ áp cho đích Việt (mẹo nén Hán-Việt riêng tiếng Việt).
        if tgt == "vi":
            prefix += (
                "- KHỚP LỒNG TIẾNG (QUAN TRỌNG): [Ts ≤W từ] = câu có T giây để đọc → dịch tối đa W TỪ (âm tiết), "
                "vượt thì giọng đọc CHÁY timeline. KHÔNG in lại [Ts ≤W từ].\n"
                "  QUY TẮC NÉN (BẮT BUỘC): 1) Bỏ chủ ngữ/đại từ (con người/họ/anh ấy) khi ngữ cảnh rõ. "
                "2) KHÔNG từ đệm/nối: để, thì, là, mà, đang, đã, sau đó, nhằm. 3) Dùng Hán-Việt gom nghĩa.\n"
                "  VÍ DỤ (phạt câu dài): 人类为了提取图鲲体内的抗衰老物质 [2.0s ≤7 từ] → SAI dài: "
                "\"Con người săn lùng chất chống lão hóa từ Tulkun\" (10 từ) → ĐÚNG: \"Săn chất chống lão hóa Tulkun\" (6 từ).\n")
        else:
            prefix += ("- DUB TIMING: [Ts ≤W words] = this line has T seconds → translate in AT MOST W WORDS, cut "
                       "fillers/pronouns/articles. Do NOT print [Ts ≤W words].\n")
    prefix += "\nBẮT ĐẦU:\n\n"

    # 1 dòng input cho 1 câu: marker + [Ts ≤W từ] + zh. ĐẾM TỪ: max_words = giây × ~3.5 (tốc độ đọc lồng tiếng
    # tiếng Việt ~3-4 từ/giây). LLM tuân thủ số TỪ tốt hơn số ký tự nhiều (test thật).
    def _line(it):
        s = _slot_giay(it.get("ts") or "")
        if FIT and s > 0:
            _w = max(3, round(s * 3.5))
            anchor = "[%.1fs ≤%d từ] " % (s, _w) if tgt == "vi" else "[%.1fs ≤%d words] " % (s, _w)
        else:
            anchor = ""
        return "%s\n%s%s" % (_marker(it["vid"], it["idx"]), anchor, it["zh"])

    try:
        # 600 câu/lô: TÍNH THẬT (câu Trung ~10.5 token) → input+output ~23K/32K (context window Free) → dư margin
        # cho bản dịch vi + tránh Gemini bóp output. 2400 câu (80 video) → 4 request (an toàn ngưỡng ~20-25 msg/giờ).
        # KHÔNG lên 800+ (token sát 32K → rủi ro cắt output). Chỉnh: BATCH_MAX_SEG.
        MAX_SEG = int(os.environ.get("BATCH_MAX_SEG", "600") or 600)
    except ValueError:
        MAX_SEG = 600
    try:
        # 28000 ký tự: khớp MAX_SEG=600 (600 câu × ~45 ký tự/câu gồm marker+anchor+zh ≈ 27K). MAX_CHARS thấp
        # (16K cũ) sẽ CHẶN lô ở ~350 câu → MAX_SEG=600 vô hiệu. Vẫn dưới trần token 32K (ký tự < token cho Hán tự).
        MAX_CHARS = int(os.environ.get("BATCH_MAX_CHARS", "28000") or 28000)
    except ValueError:
        MAX_CHARS = 28000

    # Chia lô theo SỐ CÂU + KÝ TỰ (không theo video). 1 câu = 1 đơn vị mang ID → lô nào cũng tách đúng.
    los, cur, cur_ch = [], [], 0
    for it in items:
        _ln = len(it.get("zh") or "") + 30   # +marker overhead
        if cur and (len(cur) >= MAX_SEG or cur_ch + _ln > MAX_CHARS):
            los.append(cur); cur, cur_ch = [], 0
        cur.append(it); cur_ch += _ln
    if cur:
        los.append(cur)

    los_text = ["\n".join(_line(it) for it in lo) for lo in los]   # chỉ CÂU mỗi lô (không prefix)
    log_fn("[BATCH] %d câu (%d video) → %d lô (max %d câu/%d ký tự)" % (
        len(items), len(set(it["vid"] for it in items)), len(los), MAX_SEG, MAX_CHARS))

    ket = {}

    def _du_b(ci, resp):   # lô đủ ≥90% marker chưa
        return len(_parse_marker(resp)) >= len(los[ci]) * 0.9

    def _ghi_b(ci, resp):
        ket.update(_parse_marker(resp))
        log_fn("📝 Dịch batch xong lô %d/%d (%d câu)" % (ci + 1, len(los), len(los[ci])))

    _tries = 3 if len(los) > 1 else 2

    # 🗑 ĐÃ GỠ nhánh "ưu tiên API key" (31/07/2026, chủ dự án chốt): trước đây nếu kho key có key hợp lệ thì batch
    # đi bằng `ai_dich.goi_ai` (Groq/Ollama/Gemini-key) thay vì Gemini web. Module `ai_dich` đã gỡ HẲN khỏi dự án
    # — dịch giờ CHỈ chạy Gemini web headless (không cần key). Env BATCH_API không còn tác dụng.
    # GEMINI WEB. CÙNG-CHAT mặc định TẮT (đo thật: context tích lũy làm CHẬM HƠN chat-mới
    # 123s vs 95s; số request bằng nhau). Bật thử: BATCH_CUNG_CHAT=1.
    if os.environ.get("BATCH_CUNG_CHAT", "0") == "1" and len(los) > 1:
        resps = hoi_gemini_batch_cung_chat(prefix, los_text, show=show, wait_login=wait_login,
                                           on_resp=_ghi_b, validate=_du_b, tries=_tries, log_fn=log_fn, keep=keep)
    else:
        prompts = [prefix + t for t in los_text]   # mỗi lô = full prompt (chat mới)
        resps = hoi_gemini_web_nhieu(prompts, show=show, wait_login=wait_login,
                                     on_resp=_ghi_b, validate=_du_b, tries=_tries, log_fn=log_fn, keep=keep)
    for ci, resp in enumerate(resps):
        if ci < len(los):
            ket.update(_parse_marker(resp))
    log_fn("[BATCH] Xong: %d/%d câu dịch được." % (len(ket), len(items)))
    return ket


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--srt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--show", action="store_true", help="hiện cửa sổ (để login lần đầu)")
    ap.add_argument("--wait-login", type=int, default=180, help="giây chờ đăng nhập")
    ap.add_argument("--tm", default="translation_memory", help="thư mục quy tắc + từ điển tên riêng")
    a = ap.parse_args()
    # CLI = một lần (subprocess fallback): keep=False → mở browser mới, đóng khi xong (hành vi cũ y nguyên).
    return dich_srt(a.srt, a.out, show=a.show, wait_login=a.wait_login, tm_dir=a.tm,
                    log_fn=lambda m: print(m, flush=True), keep=False)


if __name__ == "__main__":
    sys.exit(main())
