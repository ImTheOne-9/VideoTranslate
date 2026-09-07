# Adapted from the user-provided ViralCrawl snapshot; no sessions or credentials bundled.
import os
import re
BROWSER_DATA_DIR = os.environ.get('MC_BROWSER_DATA_DIR') or os.path.join(os.path.dirname(__file__), 'MediaCrawler', 'browser_data')

_JS_CHON_O_PHIM = """() => {
  const els = [...document.querySelectorAll('*')]
      .filter(e => /\\d+\\s+Episodes/.test(e.textContent) && e.children.length <= 3);
  if (!els.length) return false;
  let n = els[els.length - 1];
  for (let i = 0; i < 6 && n; i++) { if (n.getBoundingClientRect().width > 150) break; n = n.parentElement; }
  n.setAttribute('data-vc-pick', '1');
  return true;
}"""


_RE_TEN_XAU = re.compile(r'[\\/:*?"<>|]')   # ky tu Windows cam trong ten file


def _tt_udd():
    """Thư mục profile TikTok (đã đăng nhập). Không có → profile trống (vẫn chạy, ít video hơn)."""
    d = os.path.join(BROWSER_DATA_DIR, "tt_user_data_dir")
    return d if os.path.isdir(d) else os.path.join(BROWSER_DATA_DIR, "_tt_tmp")


def _tt_mo(pw, udd):
    """Mở Chromium CÓ CỬA SỔ. 🔴 headless=True KHÔNG DÙNG ĐƯỢC cho TikTok — ĐO 28/08/2026 trên
    cùng cookie, cùng URL kênh:
        headless=True  → 121.740 byte, KHÔNG có secUid, trang ra tường đăng nhập
        headless=False → 592.192 byte, CÓ secUid, quét được video
    Cookie `sessionid`/`sid_tt` CÒN HẠN ở cả hai ca ⇒ không phải mất đăng nhập, mà TikTok NHẬN DIỆN
    headless. (`_tiktok_search` vẫn đang headless=True ⇒ nhiều khả năng cũng đang hỏng cùng lý do.)"""
    return pw.chromium.launch_persistent_context(
        udd, headless=False, viewport={"width": 1400, "height": 900},
        args=["--disable-blink-features=AutomationControlled"])


def _tiktok_kenh_browser(chan_url, count, log=print):
    """(A) LIỆT KÊ VIDEO KÊNH bằng trình duyệt — dùng khi yt-dlp trả 0.

    VÌ SAO CẦN: yt-dlp lấy trang kênh bằng HTTP thường → TikTok trả vỏ rỗng → 'Unable to extract
    secondary user ID' → 0 video. ĐO 28/08: requests thường chỉ nhận **1.462 byte**.
    Lối yt-dlp tự khuyên (`tiktokuser:<secUid>`) ĐÃ THỬ: lấy được secUid thật vẫn ra **0 video** —
    đừng đi lại đường đó.
    HIỆU QUẢ ĐO ĐƯỢC: `@tiktok` → **162 video / 13 giây** (12,8 video/s).
    Tắt: TT_KENH_BROWSER=0."""
    if os.environ.get("TT_KENH_BROWSER") == "0":
        return []
    # 🔴 PHAI LOC THEO DUNG KENH (vap that 28/08): quet `a[href*=/video/]` tren CA TRANG thi vo luon
    # video GOI Y o thanh ben — chay thu @tiktok ra 100 URL nhung la `@7651887445076755476/video/...`
    # cua NGUOI KHAC. Cao ve se lan video la vao thu muc kenh mà khong ai biet.
    _nick = ""
    _m = re.search(r"/@([\w.\-]+)", chan_url or "")
    if _m:
        _nick = _m.group(1).lower()
    urls = []
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            ctx = _tt_mo(pw, _tt_udd())
            try:
                pg = ctx.pages[0] if ctx.pages else ctx.new_page()
                pg.goto(chan_url, wait_until="domcontentloaded", timeout=60000)
                pg.wait_for_timeout(6000)
                truoc, im = -1, 0
                for _ in range(80):
                    try:
                        hr = pg.eval_on_selector_all("a[href*=\'/video/\']", "e=>e.map(a=>a.href)")
                    except Exception:
                        hr = []
                    urls = list(dict.fromkeys(
                        u for u in hr
                        if re.search(r"/video/\d{15,}", u)
                        and (not _nick or ("/@%s/" % _nick) in u.lower())))
                    if len(urls) >= count:
                        break
                    if len(urls) == truoc:
                        im += 1
                        if im >= 6:          # 6 vòng không tăng = hết, đừng cuộn vô ích
                            break
                    else:
                        im = 0
                    truoc = len(urls)
                    pg.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    pg.wait_for_timeout(1500)
            finally:
                ctx.close()
    except Exception as e:
        log("⚠ Liệt kê kênh TikTok bằng trình duyệt lỗi: %s" % str(e)[:120])
        return []
    return urls[:count]


def _tiktok_phim_bo(chan_url, count, log=print):
    """(B) KÊNH PHIM NGẮN (Short dramas) — trả list {url,id,ten,bo,ck}, `url` là ĐỊA CHỈ MEDIA THẲNG.

    🔴 VÌ SAO CÓ: khách cào `@stardusttv_canada` ra 0 video. Kênh đó KHÔNG phải kênh video thường —
    nội dung là **bộ phim 38–84 tập** ở tab `Short dramas`; tab `Videos` chỉ có 9 video lẻ. Nên
    yt-dlp báo "không có gì" là ĐÚNG với tab Videos; thông báo cũ của app ("anti-bot / kênh trống")
    dẫn sai hướng và làm mất cả buổi truy.

    ĐƯỜNG ĐI (ĐO THẬT 28/08/2026, không suy):
        bấm ô phim → https://www.tiktok.com/shortdrama/episode/<dramaID>/<số tập>
        /api/drama/recommend/drama_list/  → dramaList: dramaID · dramaName · numVideos
        /api/drama/episode/item_list/     → itemList + cursor + hasMore + totalEpisodeCount
                                            lật 3 lần ra 70/70 tập (khớp totalEpisodeCount)
        mỗi tập có video.playAddr → tải thẳng: HTTP 200 / 17.295.340 byte,
                                    ffprobe: mp4 hợp lệ 137,17s (khớp duration API trả)

    ⚠ BA NGÕ CỤT ĐÃ THỬ — ĐỪNG LẶP:
      · yt-dlp KHÔNG có extractor `shortdrama` → "Unsupported URL".
      · Tập KHÔNG mở được qua `/@user/video/<id>` — lỗi HTTP NGAY CẢ trong trình duyệt.
      · Đưa cookie cho yt-dlp → **403** (đúng ca đã ghi trong memory tiktok-cookie-login-gay-403).
    ⚠ MẮT XÍCH QUAN TRỌNG NHẤT: gọi API bằng `fetch()` **TỪ TRONG TRANG** để dùng luôn chữ ký
      `X-Bogus` + cookie của TikTok. Tự ký chữ ký ở ngoài là ngõ cụt.
    Tắt: TT_PHIM_BO=0."""
    if os.environ.get("TT_PHIM_BO") == "0":
        return []
    bat, ra = {}, []
    try:
        from playwright.sync_api import sync_playwright
        import urllib.parse as _up

        def _ghi(r):
            # 🔴 03/09/2026 — THÊM `user/drama_list`. Trang kênh nay bắn ra endpoint NÀY khi mở
            #   (đo thật: 20 bộ, kèm dramaID/dramaName/numVideos/hasMore). Hai endpoint cũ giữ lại
            #   làm dự phòng: `recommend/drama_list` không còn thấy bắn, `episode/item_list` chỉ
            #   bắn sau khi BẤM vào ô phim — mà chính cú bấm đó là chỗ đang treo.
            for k, d in (("ep", "/api/drama/episode/item_list/"),
                         ("ds", "/api/drama/recommend/drama_list/"),
                         ("ud", "/api/drama/user/drama_list/")):
                if d in r.url:
                    bat.setdefault(k, r.url)

        with sync_playwright() as pw:
            ctx = _tt_mo(pw, _tt_udd())
            try:
                pg = ctx.pages[0] if ctx.pages else ctx.new_page()
                pg.on("response", _ghi)
                pg.goto(chan_url, wait_until="domcontentloaded", timeout=60000)
                pg.wait_for_timeout(7000)
                # 🔴 ĐỪNG THOÁT ÂM THẦM (vấp thật 28/08): lần chạy đầu ra 30 bộ, lần sau ra 0 mà
                # KHÔNG một dòng log nào — vì hai `return []` ở đây câm. Trang TikTok tải chậm bất
                # thường là hụt. Nay: CHỜ LẠI vài nhịp, và thoát thì phải NÓI LÝ DO.
                # 🔴 03/09/2026 — BỎ HẲN HAI CÚ BẤM (tab "Short dramas" + ô phim).
                #   Ca thật: `e.click()` trên `[data-e2e="drama-tab"]` treo đủ 30s rồi ném
                #   `ElementHandle.click: Timeout` ⇒ kênh phim bộ ra 0 video. Đã soi trang lúc đó:
                #   tab CÓ và bình thường (202x44, visible, pointer-events auto) — nghĩa là bấm
                #   được hay không phụ thuộc lúc trang dựng xong tới đâu, tức là MAY RỦI.
                #   Mà bấm vốn KHÔNG cần: trang tự gọi `/api/drama/user/drama_list/` ngay khi mở,
                #   và lời gọi đó đã mang đủ mọi tham số ký/định danh phiên (đo được 38 khoá:
                #   msToken, verifyFp, WebIdLastTime…). Mượn khuôn tham số ấy rồi đổi ĐƯỜNG DẪN là
                #   gọi thẳng được API tập. Bỏ cú bấm = bỏ luôn điểm gãy, và nhanh hơn ~13s/kênh.
                #   Đo sau khi vá: kênh @yccdrama_id ra 20 bộ; bộ đầu gom đủ 66/66 tập.
                for _ in range(8):
                    if "ud" in bat or "ep" in bat:
                        break
                    pg.wait_for_timeout(2000)
                if "ud" not in bat and "ep" not in bat:
                    # ĐỪNG thoát câm (vấp thật 28/08). Phân biệt "không phải kênh phim bộ" với
                    # "là kênh phim bộ nhưng trang hụt" — hai thứ này cần hai cách xử lý khác nhau.
                    if pg.query_selector('[data-e2e="drama-tab"]'):
                        log("⚠ TikTok phim bộ: kênh CÓ tab phim nhưng trang không gọi API danh "
                            "sách bộ (mạng chậm / TikTok đổi endpoint?).")
                    else:
                        log("ℹ TikTok: kênh này không có tab 'Short dramas' → không phải kênh phim bộ.")
                    return []
                # khuôn tham số: ưu tiên lời gọi trang TỰ bắn; `ep` (nếu có) cũng dùng được
                q_ep = dict(_up.parse_qsl(_up.urlsplit(bat.get("ud") or bat["ep"]).query))
                for _k in ("dramaID", "cursor", "count"):
                    q_ep.pop(_k, None)          # ba khoá này tự đặt lại theo từng bộ

                def _goi(u):
                    return pg.evaluate(
                        "async u=>{const r=await fetch(u,{credentials:\'include\'});return await r.json();}", u)

                def _url(path, q):
                    return _up.urlunsplit(("https", "www.tiktok.com", path, _up.urlencode(q), ""))

                bos = []
                # `user/drama_list` phân trang (hasMore/cursor) — kênh nhiều bộ thì trang đầu chỉ
                # có 20. Không lật trang là mất bộ mà KHÔNG lỗi nào ném ra.
                for _nguon in ("ud", "ds"):
                    if _nguon not in bat:
                        continue
                    try:
                        _u, _cur = bat[_nguon], None
                        for _ in range(20):
                            if _cur is not None:
                                _q = dict(_up.parse_qsl(_up.urlsplit(bat[_nguon]).query))
                                _q["cursor"] = str(_cur)
                                _u = _url(_up.urlsplit(bat[_nguon]).path, _q)
                            j = _goi(_u)
                            _ds = j.get("dramaList") or []
                            bos += [(d.get("dramaID"), d.get("dramaName") or "",
                                     d.get("numVideos") or 0) for d in _ds if d.get("dramaID")]
                            if not j.get("hasMore") or not _ds:
                                break
                            _cur = j.get("cursor")
                    except Exception:
                        pass
                    if bos:
                        break
                _thay = set()
                bos = [b for b in bos if not (b[0] in _thay or _thay.add(b[0]))]
                _q_did = dict(_up.parse_qsl(_up.urlsplit(bat.get("ep") or "").query)).get("dramaID")
                if not bos and _q_did:
                    bos = [(_q_did, "", 0)]
                log("🎬 TikTok phim bộ: thấy %d bộ → gom tập…" % len(bos))

                for did, ten_bo, _nv in bos:
                    if len(ra) >= count:
                        break
                    cur, n_bo = "0", 0
                    for _ in range(60):
                        q = dict(q_ep)
                        q["dramaID"] = str(did)
                        q["cursor"] = str(cur)
                        # 🔴 `count` BẮT BUỘC. Trước đây khuôn tham số mượn từ chính lời gọi
                        #   `episode/item_list` (đã có sẵn `count`), nay mượn từ `user/drama_list`
                        #   nên KHÔNG có ⇒ API trả rỗng ⇒ MỌI bộ ra "0 tập" mà không lỗi nào ném
                        #   ra. Đúng lớp hỏng câm dự án hay dính: log vẫn chạy đủ, số vẫn in ra,
                        #   chỉ có điều số nào cũng bằng 0.
                        q["count"] = "20"
                        try:
                            j = _goi(_url("/api/drama/episode/item_list/", q))
                        except Exception:
                            break
                        it = j.get("itemList") or []
                        if not it:
                            break
                        for m in it:
                            v = m.get("video") or {}
                            u = v.get("playAddr") or v.get("downloadAddr") or ""
                            if not u:
                                continue
                            episode = ((m.get("dramaInfo") or {}).get("DramaVideoData") or {}).get("EpisodeNumber")
                            ra.append({"url": u, "id": str(m.get("id") or ""), "series_id": str(did), "expected_count": _nv, "so_tap": episode,
                                       "ten": ("Tap %s - %s" % (episode, m.get("desc") or "") if episode else m.get("desc") or "").strip()[:120], "bo": ten_bo})
                            n_bo += 1
                            if len(ra) >= count:
                                break
                        if len(ra) >= count or not j.get("hasMore"):
                            break
                        cur = j.get("cursor")
                    log("   · %-36s %d tập (đã gom %d)" % ((ten_bo or str(did))[:36], n_bo, len(ra)))
                ck = {c["name"]: c["value"] for c in ctx.cookies() if "tiktok" in (c.get("domain") or "")}
                for m in ra:
                    m["ck"] = ck
            finally:
                ctx.close()
    except Exception as e:
        log("⚠ TikTok phim bộ lỗi: %s" % str(e)[:140])
        return []
    return ra[:count]



def _tiktok_bo_tu_video(video_url, count, log=print):
    """LINK 1 TẬP → toàn bộ tập của BỘ chứa nó. Trả list item như `_tiktok_phim_bo` ([] nếu chịu).

    VÌ SAO LÀM ĐƯỢC (dò thật 03/09/2026 — trước đó code báo "nền tảng không cho biết 1 video thuộc
    bộ nào", và câu đó SAI): trang xem 1 tập TỰ KHAI bộ ngay trong HTML —
        "dramaID":"7680108063248339976"   "dramaName":"Lord of a Myriad Beasts"
    và trang cũng TỰ GỌI `/api/drama/episode/item_list/` khi mở. Nghĩa là chỉ cần mở ĐÚNG MỘT trang
    là có cả mã bộ lẫn khuôn tham số đã ký để gọi tiếp. KHÔNG phải quét từng bộ của kênh để dò —
    hướng đó tốn N lời gọi mà cho cùng kết quả.

    🔴 PHẢI mở bằng `_tt_mo` (headless=False, hồ sơ đăng nhập của khách). Hồ sơ rỗng/headless thì
       TikTok trả tường đăng nhập, HTML không có `dramaID` — đã vấp: chạy script trần không set
       `MC_BROWSER_DATA_DIR` nên rơi về hồ sơ rỗng trong repo rồi tưởng bị chặn IP.
    """
    import urllib.parse as _up
    bat, ra = {}, []
    try:
        from playwright.sync_api import sync_playwright

        def _ghi(r):
            if "/api/drama/episode/item_list/" in r.url:
                bat.setdefault("ep", r.url)
            elif "/api/drama/recommend/drama_list/" in r.url:
                # trang xem tập TỰ gọi API này (đo: 30 bộ, có `dramaID`+`dramaName`) ⇒ dùng làm
                # nguồn TÊN BỘ thứ hai khi HTML hụt
                bat.setdefault("ds", r.url)

        with sync_playwright() as pw:
            ctx = _tt_mo(pw, _tt_udd())
            try:
                pg = ctx.pages[0] if ctx.pages else ctx.new_page()
                pg.on("response", _ghi)
                # 🔴 CHỜ `ep` (API danh sách tập) — và HỤT THÌ NẠP LẠI TRANG.
                #   ĐỪNG đổi sang khuôn của `ds` (`recommend/drama_list`): ĐO THẬT 3 lượt, lượt nào
                #   chỉ có `ds` là gọi API tập ra RỖNG ⇒ "0 tập". Hai endpoint tuy cùng bộ tham số
                #   ký nhưng KHÔNG tương đương — `ds` thiếu thứ mà API tập cần. (Tôi đã vá sai theo
                #   hướng "khuôn nào cũng được" và nó biến lỗi hiếm thành lỗi 2/3 lượt.)
                #   Nạp lại trang rẻ hơn nhiều so với hỏng cả lượt cào.
                h, m = "", None
                for _lan in range(3):
                    if _lan:
                        try:
                            pg.reload(wait_until="domcontentloaded", timeout=90000)
                        except Exception:
                            pass
                    else:
                        pg.goto(video_url, wait_until="domcontentloaded", timeout=90000)
                    for _ in range(10):
                        h = pg.content()
                        if not m:
                            _mh = re.search(r'"dramaID"\s*:\s*"?(\d{10,22})"?', h)
                            if _mh:
                                m = _mh
                        if not m and "ep" in bat:
                            _qd = dict(_up.parse_qsl(
                                _up.urlsplit(bat["ep"]).query)).get("dramaID") or ""
                            if _qd.isdigit():
                                m = re.match(r"(\d+)", _qd)
                        if m and "ep" in bat:
                            break
                        pg.wait_for_timeout(2000)
                    if m and "ep" in bat:
                        break
                    if _lan < 2:
                        log("   ↻ TikTok chưa nhả API danh sách tập — nạp lại trang (lượt %d/3)…"
                            % (_lan + 2))
                if not m:
                    # ĐỪNG thoát câm: phân biệt "không phải phim bộ" với "trang không mở được"
                    if "Log in to TikTok" in h or len(h) < 60000:
                        log("⚠ TikTok: mở trang tập không lên (chưa đăng nhập TikTok trong app, "
                            "hoặc mạng chặn). Vào bước 1 đăng nhập TikTok rồi thử lại.")
                    else:
                        log("ℹ TikTok: video này KHÔNG thuộc phim bộ nào (chỉ là video lẻ) → "
                            "dùng nút 'Theo link'.")
                    return []
                did = m.group(1)
                mt = re.search(r'"dramaName"\s*:\s*"([^"]{1,80})"', h)
                ten_bo = (mt.group(1) if mt else "").strip()
                # 🔴 ĐỪNG ĐÒI ĐÚNG API TẬP PHẢI BẮN RA. Đo 2 lượt liên tiếp cùng link, kết quả
                #   NGƯỢC NHAU: lượt A có API tập (gom đủ 66) nhưng HTML hụt tên bộ · lượt B có tên
                #   bộ nhưng API tập không bắn ⇒ 0 tập. Tức là trang TikTok giao thứ gì trước là
                #   MAY RỦI, mà hàm này lại cần CẢ HAI cùng lúc ⇒ tự tạo ra lỗi chập chờn.
                #   Thật ra MỌI endpoint `/api/drama/*` dùng CHUNG bộ tham số ký/phiên (msToken,
                #   verifyFp, WebIdLastTime…) — nên khuôn lấy từ cái nào cũng gọi được cái kia.
                _khuon = bat.get("ep")      # CHỈ `ep` — xem chú thích vòng chờ ở trên
                if not _khuon:
                    log("⚠ TikTok: biết bộ '%s' nhưng trang không gọi API drama nào "
                        "(mạng chậm / TikTok đổi endpoint?)." % (ten_bo or did)[:40])
                    return []
                q0 = dict(_up.parse_qsl(_up.urlsplit(_khuon).query))
                for _k in ("dramaID", "cursor", "count"):
                    q0.pop(_k, None)

                def _goi(u):
                    return pg.evaluate(
                        "async u=>{const r=await fetch(u,{credentials:\'include\'});"
                        "return await r.json();}", u)

                if not ten_bo and "ds" in bat:
                    # 🔴 ĐỪNG để tên bộ rơi về MÃ 19 SỐ. Hai hậu quả, cả hai đều im lặng:
                    #   · thư mục thành `bo/7680108063248339976/` — khách không biết bộ nào
                    #   · `_tai_phim_bo` cắt tiền tố tên bộ khỏi `desc` bằng chính `bo`; `bo` là số
                    #     thì không cắt được ⇒ tên file lặp tên bộ.
                    #   (Vấp thật: HTML hụt `dramaName` đúng lượt mà `dramaID` cũng phải lấy từ API.)
                    try:
                        _j = _goi(bat["ds"])
                        for _d in (_j.get("dramaList") or []):
                            if str(_d.get("dramaID")) == str(did):
                                ten_bo = (_d.get("dramaName") or "").strip()
                                break
                    except Exception:
                        pass
                cur, tong = "0", None
                for _ in range(200):
                    q = dict(q0)
                    q["dramaID"] = str(did)
                    q["cursor"] = str(cur)
                    q["count"] = "20"          # thiếu `count` là API trả RỖNG — xem `_tiktok_phim_bo`
                    try:
                        j = _goi(_up.urlunsplit(("https", "www.tiktok.com",
                                                 "/api/drama/episode/item_list/",
                                                 _up.urlencode(q), "")))
                    except Exception as e:
                        log("⚠ TikTok: lỗi gọi danh sách tập — %s" % str(e)[:70])
                        break
                    if tong is None:
                        tong = j.get("totalEpisodeCount")
                    it = j.get("itemList") or []
                    if not it:
                        break
                    # 🔴 TÊN BỘ LẤY TỪ ĐÂY, không lấy từ HTML. Mỗi tập mang sẵn `dramaInfo`
                    #   (dramaName / dramaID / numVideos) NGAY TRONG phản hồi này ⇒ không phụ thuộc
                    #   trang dựng xong tới đâu. Đo 3 lượt liên tiếp khi còn dò HTML: tên bộ chỉ
                    #   đúng 1/3 lượt, 2 lượt kia rơi về mã 19 số ⇒ thư mục thành
                    #   `bo/7680108063248339976/` và `_tai_phim_bo` không cắt nổi tiền tố tên bộ.
                    _di = (it[0].get("dramaInfo") or {})
                    if not ten_bo and (_di.get("dramaName") or "").strip():
                        ten_bo = _di["dramaName"].strip()
                    if not tong and _di.get("numVideos"):
                        tong = _di["numVideos"]
                    for _m in it:
                        v = _m.get("video") or {}
                        u = v.get("playAddr") or v.get("downloadAddr") or ""
                        if not u:
                            continue
                        # SỐ TẬP: `dramaInfo.DramaVideoData.EpisodeNumber`. Không có số thì tên file
                        # chỉ là mô tả tập ("Kebangkitan sistem…") ⇒ 66 file KHÔNG xếp được thứ tự,
                        # mà phim bộ thì thứ tự là thứ quan trọng nhất khi reup.
                        _dvd = ((_m.get("dramaInfo") or {}).get("DramaVideoData") or {})
                        try:
                            _stap = int(_dvd.get("EpisodeNumber") or 0)
                        except (TypeError, ValueError):
                            _stap = 0
                        _mo_ta = (_m.get("desc") or "").strip()[:100]
                        _ten = ("Tap %02d - %s" % (_stap, _mo_ta)).strip(" -") if _stap else _mo_ta
                        ra.append({"url": u, "id": str(_m.get("id") or ""), "series_id": str(did),
                                   "ten": _ten[:120], "bo": ten_bo, "so_tap": _stap})
                    if count and len(ra) >= count:
                        break
                    if not j.get("hasMore"):
                        break
                    cur = j.get("cursor")
                # (ĐÃ BỎ nguồn "tiền tố chung của `desc`": ĐO THẬT thì `desc` của tập KHÔNG
                #  chứa tên bộ — nó chỉ là tên tập, kiểu "Kebangkitan sistem sumber segala
                #  siluman" ⇒ tiền tố chung ra RỖNG. Giữ lại chỉ làm tưởng có đường cứu.)
                ten_bo = ten_bo or str(did)
                log("🎬 TikTok bộ '%s': gom %d/%s tập." % (ten_bo[:40], len(ra), tong or "?"))
                ck = {c["name"]: c["value"] for c in ctx.cookies()
                      if "tiktok" in (c.get("domain") or "")}
                for _m in ra:
                    _m["ck"] = ck
                    _m["bo"] = ten_bo
                    _m["expected_count"] = tong
            finally:
                ctx.close()
    except Exception as e:
        log("⚠ TikTok bộ-từ-video lỗi: %s" % str(e)[:140])
        return []
    return ra[:count] if count else ra


def _valid_video(file):
    try:
        if os.path.getsize(file) < 100000:
            return False
        with open(file, 'rb') as fh:
            return b'ftyp' in fh.read(64)
    except OSError:
        return False


def _tai_phim_bo(items, thu_muc, log=print):
    """Tải thẳng `playAddr` (yt-dlp KHÔNG làm được — xem `_tiktok_phim_bo`). BẮT BUỘC có Referer,
    thiếu nó TikTok chặn. Bỏ qua tập đã có file >100KB (chạy lại không tải trùng)."""
    import threading as _th
    import time as _tm
    import requests as _rq
    os.makedirs(thu_muc, exist_ok=True)
    H = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
         "Referer": "https://www.tiktok.com/"}
    # 🔴 01/09/2026 — LOG KHÁCH: "gom 100 tập" xong rồi IM 30 PHÚT, tiến trình 0/100.
    #   Vòng cũ chỉ in khi HỎNG (`⚠ tập …`) hoặc khi ĐÃ XONG (`⬇ đã tải N/M`, mỗi 5 tập). Tập ĐẦU
    #   treo giữa chừng ⇒ KHÔNG một dòng nào ⇒ khách không phân biệt được "đang chạy" với "treo".
    #   Gốc: `timeout=180` của requests là hạn MỖI THAO TÁC SOCKET, KHÔNG phải hạn cả lượt tải.
    #   Máy chủ nhỏ giọt vài byte là vòng `iter_content` chạy vô hạn mà không bao giờ ném timeout.
    #   (Khách nói tập chỉ 30 giây–1 phút ⇒ lẽ ra vài giây/tập, không thể 30 phút "đang chạy".)
    #   ⚠ CHƯA TÁI HIỆN ĐƯỢC trên máy dev: TikTok chặn máy này ở chặng LIỆT KÊ (`ElementHandle.click:
    #     Timeout 30000ms`, đo 01/09) nên không lấy được `playAddr` thật để thử tải. Bản vá này dựa
    #     trên ĐỌC CODE + chữ ký log của khách, KHÔNG phải trên một lần tái hiện. Ghi rõ để người sau
    #     biết mức độ chắc chắn.
    #   Chữa 3 việc: (a) hạn cả lượt tải mỗi tập — `TT_BO_HAN_GIAY`, mặc định 120s;
    #   (b) nhịp tim mỗi 15s khi tập tải lâu, để log KHÔNG BAO GIỜ im;
    #   (c) `timeout=(10,30)` thay 180 — chờ kết nối/đọc header 3 phút là vô nghĩa.
    try:
        _han = max(15.0, float(os.environ.get("TT_BO_HAN_GIAY", "120") or 120))
    except ValueError:
        _han = 120.0
    ok = 0
    _tong = len(items)
    for _stt, m in enumerate(items, 1):
        # `desc` cua tap thuong LAP LAI ten bo => ghep thang ra "X X". Bo phan trung o dau.
        _bo, _t = (m.get("bo") or "").strip(), (m.get("ten") or "").strip()
        if _bo and _t.lower().startswith(_bo.lower()):
            _t = _t[len(_bo):].strip(" -–—:|")
        ten = re.sub(_RE_TEN_XAU, "_", ("%s %s" % (_bo, _t)).strip())[:80]
        p = os.path.join(thu_muc, "%s [%s].mp4" % (ten or "tap", m["id"]))
        if _valid_video(p):
            ok += 1
            continue
        try:
            _t0 = _tm.time()
            r = _rq.get(m["url"], headers=H, cookies=m.get("ck") or {}, timeout=(10, 30), stream=True)
            if r.status_code >= 400:
                log("   ⚠ tập %d/%d (%s): HTTP %s" % (_stt, _tong, m["id"], r.status_code))
                continue
            tmp = p + ".part"
            # 🔴 BẢN VÁ ĐẦU CỦA TÔI SAI — TEST BẮT ĐƯỢC, ghi lại để không ai viết lại kiểu đó:
            #   đặt phép kiểm hạn giờ BÊN TRONG `for chunk in r.iter_content(1<<20)` thì VÔ DỤNG, vì
            #   `iter_content` CHẶN cho tới khi gom đủ 1 MB. Máy chủ nhỏ giọt 1 KB/0,5s ⇒ thân vòng lặp
            #   KHÔNG BAO GIỜ chạy ⇒ hạn giờ không bao giờ được kiểm. Test máy chủ giả: python bị giết
            #   ở 300s (mã 124) thay vì bỏ ở 20s.
            #   `timeout=(10,30)` cũng KHÔNG cứu: socket vẫn có byte về đều nên chẳng bao giờ "stall".
            #   ⇒ phải CẮT TỪ BÊN NGOÀI: hẹn giờ đóng response, `iter_content` ném lỗi, bắt ở except.
            #   Chunk hạ xuống 64 KB để nhịp tim còn cơ hội in ra.
            _qua = {"v": False}

            def _cat_ket_noi(_r=r, _c=_qua):
                _c["v"] = True
                try:
                    _r.close()
                except Exception:
                    pass

            _dh = _th.Timer(_han, _cat_ket_noi)
            _dh.daemon = True
            _dh.start()
            _nhip = _t0
            try:
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 16):
                        if chunk:
                            f.write(chunk)
                        _gio = _tm.time()
                        if _gio - _nhip >= 15.0:   # nhịp tim: log KHÔNG BAO GIỜ im quá 15s
                            _nhip = _gio
                            log("   ⏳ tập %d/%d đang tải chậm — %.1f MB sau %.0fs…"
                                % (_stt, _tong, f.tell() / 1e6, _gio - _t0))
            except Exception:
                if not _qua["v"]:
                    raise                          # lỗi THẬT (mạng đứt…) → để except ngoài xử lý
            finally:
                _dh.cancel()
                r.close()
            if _qua["v"]:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                log("   ⚠ tập %d/%d (%s): quá %.0fs chưa xong → bỏ, sang tập kế."
                    % (_stt, _tong, m["id"], _han))
                continue
            if not _valid_video(tmp):
                os.remove(tmp)
                log("   ⚠ tập %s: file quá nhỏ, bỏ" % m["id"])
                continue
            os.replace(tmp, p)
            ok += 1
            if ok == 1 or ok % 5 == 0:
                log("   ⬇ đã tải %d/%d tập…" % (ok, len(items)))
        except Exception as e:
            log("   ⚠ tập %s lỗi: %s" % (m["id"], str(e)[:90]))
    log("✔ Phim bộ TikTok: tải xong %d/%d tập → %s" % (ok, len(items), thu_muc))
    return ok


def run_series(source, count, output, creator=False, log=print, episode_only=False):
    """Persist public metadata only; signed media URLs/cookies stay in memory."""
    import json
    items = (_tiktok_phim_bo if creator else _tiktok_bo_tu_video)(source, 5000 if episode_only else count, log=log)
    if episode_only:
        match = re.search(r'/shortdrama/episode/\d+/(\d+)', source)
        if not match:
            return {'ok': False, 'total': 0, 'found': 0, 'failed': 1, 'msg': 'Link không chỉ ra số tập.'}
        items = [item for item in items if str(item.get('so_tap') or '') == match.group(1)]
    items = list({m['id']: m for m in items if m.get('id')}.values())[:count]
    root = os.path.join(output, 'tiktok')
    catalog = os.path.join(root, 'jsonl')
    os.makedirs(catalog, exist_ok=True)
    with open(os.path.join(catalog, 'series_contents.jsonl'), 'a', encoding='utf-8') as fh:
        for m in items:
            fh.write(json.dumps({'video_id': m['id'], 'title': m.get('ten'), 'series_id': m.get('series_id'),
                'series_title': m.get('bo'), 'episode_number': m.get('so_tap'),
                'video_url': ('https://www.tiktok.com/shortdrama/episode/%s/%s' % (m.get('series_id'), m.get('so_tap')) if m.get('series_id') and m.get('so_tap') else source),
                'source_mode': 'chase', 'source_input': source}, ensure_ascii=False) + '\n')
    completed = 0
    groups = {}
    for item in items:
        groups.setdefault((item.get('series_id') or '', item.get('bo') or 'series'), []).append(item)
    for (sid, title), episodes in groups.items():
        safe = re.sub(_RE_TEN_XAU, '_', title).strip(' .')[:60] or 'series'
        folder = os.path.join(root, 'videos', 'bo', safe + (' [' + re.sub(r'[^0-9]', '', sid) + ']' if sid else ''))
        completed += _tai_phim_bo(episodes, folder, log=log)
    expected = len(items) if episode_only else min(count, sum(max(len(episodes), int(episodes[0].get('expected_count') or 0)) for episodes in groups.values()))
    return {'ok': bool(items) and completed > 0, 'total': expected, 'found': len(items), 'failed': max(0, expected - completed)}


if __name__ == '__main__':
    import argparse
    import json
    import sys
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--count', type=int, default=100)
    parser.add_argument('--creator', action='store_true')
    parser.add_argument('--episode-only', action='store_true')
    args = parser.parse_args()
    result = run_series(args.input, max(1, min(5000, args.count)), os.environ['MC_DATA_DIR'], args.creator,
                        log=lambda line: print('LOG:' + str(line), flush=True), episode_only=args.episode_only)
    if not result['ok']:
        result['msg'] = 'Không xác định/tải được tập nào. Kiểm tra link series, phiên TikTok và log.'
    print(json.dumps(result, ensure_ascii=False), flush=True)
    sys.exit(0 if result['ok'] else 1)
