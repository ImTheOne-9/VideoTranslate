# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/douyin/core.py
# GitHub: https://github.com/NanmiCoder
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1
#

# 声明：本代码仅供学习和研究目的使用。使用者应遵守以下原则：
# 1. 不得用于任何商业用途。
# 2. 使用时应遵守目标平台的使用条款和robots.txt规则。
# 3. 不得进行大规模爬取或对平台造成运营干扰。
# 4. 应合理控制请求频率，避免给目标平台带来不必要的负担。
# 5. 不得用于任何非法或不当的用途。
#
# 详细许可条款请参阅项目根目录下的LICENSE文件。
# 使用本代码即表示您同意遵守上述原则和LICENSE中的所有条款。

import asyncio
import glob
import json
import os
import random
import re
import urllib.parse
import urllib.request
from asyncio import Task
from typing import Any, Dict, List, Optional, Tuple

from playwright.async_api import (
    BrowserContext,
    BrowserType,
    Error as PlaywrightError,
    Page,
    Playwright,
    async_playwright,
)

import config
from base.base_crawler import AbstractCrawler
from proxy.proxy_ip_pool import IpInfoModel, create_ip_pool
from store import douyin as douyin_store
from tools import utils
from tools import dich_ten
from tools.cdp_browser import CDPBrowserManager
from var import crawler_type_var, source_keyword_var

from .client import DouYinClient
from .exception import DataFetchError
from .field import PublishTimeType, SearchSortType
from .help import parse_video_info_from_url, parse_creator_info_from_url
from .login import DouYinLogin


# Tên thiết bị dành riêng của Windows — không được dùng làm tên file/thư mục
_WIN_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}


def _safe_name(s: str, maxlen: int = 60) -> str:
    """Làm sạch tên thư mục/tệp: bỏ ký tự cấm trên Windows, rút gọn."""
    s = (s or "").strip()
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    s = s[:maxlen].strip() or "video"
    if s.upper() in _WIN_RESERVED:
        s += "_"
    return s


# Douyin KHÔNG có API hợp tuyển chính thức đáng tin (khác Bilibili "pages") → suy luận series từ TIÊU ĐỀ.
# Bắt "Tập N"/"Phần N"/"P.N"/"P N"/"EPN"/"EP N"/"#N" (không phân biệt hoa/thường, có/không dấu cách/chấm
# trước số) — chấp nhận bỏ sót định dạng lạ chưa gặp, đổi lại đơn giản/không cần ví dụ mẫu riêng từng kênh.
_RE_TAP = re.compile(
    # 🔴 (24/08) THÊM \b: trước đây tag lẻ `p` khớp GIỮA từ ("To**p** 5" → nhận nhầm 'To' Tập 5). \b buộc
    # nhãn tập phải đứng ở RANH GIỚI TỪ (Top/Shop… hết bị nhận nhầm), mọi ca thật (Tập/Phần/P.7/EP05) vẫn khớp.
    r"\b(?P<tag>t[aậ]p|ph[aầ]n|ep(?:isode)?|p)\s*[.\-]?\s*(?P<so>\d+)",
    re.IGNORECASE,
)
# 🔴 (24/08) DOUYIN LÀ NỀN TRUNG — series Trung dùng `第N集/第N话/第N期/第N部` (PHỔ BIẾN NHẤT), mà regex Latin
# trên KHÔNG bắt ⇒ "theo bộ" TRƯỚC ĐÂY vô dụng cho đa số series Douyin thật. Thêm mẫu Trung riêng.
_RE_TAP_TQ = re.compile(r"第\s*(?P<so>\d+)\s*[集话話期部回]")
_RE_HASH_TAP = re.compile(r"#\s*(?P<so>\d+)\b")


def tach_ten_goc_tap(title: str):
    """Tách (tên_goc, so_tap) từ tiêu đề video — dùng để "đuổi theo bộ" (tìm mọi tập cùng series trên
    kênh). tên_goc = phần tiêu đề TRƯỚC nhãn tập (đã strip/chuẩn hoá khoảng trắng), so_tap = int.
    Trả (None, None) nếu tiêu đề không khớp mẫu nào (không phải video có đánh số tập)."""
    title = (title or "").strip()
    if not title:
        return None, None
    m = _RE_TAP.search(title)
    if not m:
        m = _RE_TAP_TQ.search(title)     # Trung: 第N集/话/期/部 (Douyin phần lớn là series Trung)
    if not m:
        m = _RE_HASH_TAP.search(title)
    if not m:
        return None, None
    try:
        so_tap = int(m.group("so"))
    except (ValueError, IndexError):
        return None, None
    ten_goc = title[:m.start()].strip().rstrip("-–—:|,.").strip()
    if not ten_goc:
        return None, None
    return ten_goc, so_tap


def cung_series(title: str, ten_goc: str) -> bool:
    """True nếu `title` khớp CÙNG series với `ten_goc` (tiền tố, không phân biệt hoa/thường/khoảng trắng
    thừa) — dùng lọc video kênh khi "đuổi theo bộ". So sánh THEO TIỀN TỐ (không phải full-match) vì tên
    gốc đã cắt bỏ phần "Tập N" phía sau, còn lại phải khớp y hệt phần đầu tiêu đề video khác trong bộ."""
    if not ten_goc:
        return False
    t = re.sub(r"\s+", " ", (title or "").strip()).lower()
    g = re.sub(r"\s+", " ", ten_goc.strip()).lower()
    return bool(g) and t.startswith(g)


_VI_CACHE = None


def _vi_cache_path() -> str:
    base = config.SAVE_DATA_PATH if config.SAVE_DATA_PATH else "data"
    return os.path.join(base, "douyin", "_kenh_vi.json")


def ten_kenh_vi(safe_nick: str) -> str:
    """Dịch tên kênh (đã làm sạch) sang tiếng Việt cho người Việt dễ đọc; cache lại. '' nếu không cần/không được."""
    global _VI_CACHE
    if not safe_nick:
        return ""
    if _VI_CACHE is None:
        _VI_CACHE = {}
        p = _vi_cache_path()
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    _VI_CACHE = json.load(f)
            except Exception:
                _VI_CACHE = {}
    if safe_nick in _VI_CACHE:
        return _VI_CACHE[safe_nick]
    # Nếu tên đã chủ yếu là chữ Latin thì khỏi dịch
    ascii_letters = sum(1 for c in safe_nick if ord(c) < 128 and c.isalpha())
    vi = ""
    if ascii_letters < max(3, len(safe_nick.replace(" ", "")) * 0.5):
        try:
            _tl = (os.environ.get("TARGET_LANG") or "vi").strip().lower()
            if _tl not in ("vi", "en"):
                _tl = "vi"
            url = ("https://translate.googleapis.com/translate_a/single"
                   "?client=gtx&sl=auto&tl=" + _tl + "&dt=t&q=" + urllib.parse.quote(safe_nick))
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                d = json.loads(r.read().decode("utf-8"))
            vi = "".join(s[0] for s in d[0] if s and s[0]).strip()
            vi = re.sub(r'[\\/:*?"<>|]+', " ", vi).strip()[:40].strip()
        except Exception:
            # 🔴 (07/08/2026) LỖI MẠNG ⇒ KHÔNG GHI NHỚ (xem giải thích đầy đủ ở `doi_ten_kenh.py`).
            # `_kenh_vi.json` dùng CHUNG với file đó — cache "" ở đây làm hỏng cả hai đường.
            return ""
    _VI_CACHE[safe_nick] = vi
    try:
        p = _vi_cache_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(_VI_CACHE, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return vi


async def _media_path_parts(aweme_item: Dict) -> Tuple[str, str]:
    """Tạo (thư mục con, tên tệp gốc) theo kiểu cào: tu-khoa / kenh / link.

    🔴 ASYNC (rà 30/08/2026) — vì `dich_tieu_de` ĐI MẠNG. Nó thử 3 endpoint NỐI TIẾP, mỗi cái một timeout
    riêng ⇒ tới ~45 GIÂY cho MỘT tiêu đề. Gọi thẳng trong coroutine là chặn CỨNG event loop ⇒ **mọi task
    tải nền đông cứng theo**, mà URL CDN Douyin có hạn dùng ngắn ⇒ chờ xong thì link hết hạn ⇒ tải lỗi.
    Cùng file/khuôn đã làm đúng cho `sua_hevc` (`store/douyin/douyin_store_media.py:180`:
    `await _aio.to_thread(_sh.sua, …)`) — nay áp cùng cách cho chỗ này."""
    ctype = (os.environ.get("MC_SOURCE_MODE") or crawler_type_var.get()).strip()
    aweme_id = aweme_item.get("aweme_id", "") or ""
    # Tên file = tiêu đề ĐÃ DỊCH sang ngôn ngữ đích (không chỉ dịch trên màn hình)
    title = _safe_name(
        await asyncio.to_thread(dich_ten.dich_tieu_de, aweme_item.get("desc", ""), "douyin"), 60)
    # Suffix id NHẬN DIỆN: cũ dùng 6 số cuối → nghịch lý sinh nhật (2 video khác 6-số-cuối trùng → glob dedup
    # khớp NHẦM → BỎ + đánh dấu seen video 2 → MẤT VĨNH VIỄN; P~39% ở 1000 video/folder). Đổi sang FULL aweme_id
    # (Douyin ~19 số, duy nhất) → không còn trùng. glob dedup (dòng ~946) khớp cả tên cũ (*_<6số>) LẪN mới (*_<fullid>).
    # 🔒 07/09/2026 — BỌC `_safe_name`: `aweme_id` đến từ PHẢN HỒI API, không phải hằng của mình. Thực tế
    #   Douyin trả id toàn số nên chưa dựng được ca thoát thư mục, nhưng nó đi THẲNG vào tên file — phản hồi
    #   bị giả mạo/MITM có `/` hay `..` là ra ngoài thư mục đích. Bọc lại rẻ hơn nhiều so với đi chứng minh
    #   "API không bao giờ trả ký tự lạ".
    idsuf = _safe_name(str(aweme_id), 32) if aweme_id else ""
    file_base = f"{title}_{idsuf}" if idsuf else title
    if ctype == "search":
        grp = _safe_name(os.environ.get("MC_SOURCE_INPUT") or source_keyword_var.get() or "khac", 40)
        sub_dir = f"tu-khoa/{grp}"
    elif ctype == "creator":
        _author = aweme_item.get("author", {}) or {}
        nickname = _author.get("nickname", "") or ""
        _sec = (_author.get("sec_uid", "") or "").strip()
        # TÊN FOLDER = nickname GỐC + hậu tố sec_uid. KHÔNG dùng tên-DỊCH (ten_kenh_vi) làm folder: dịch KHÔNG ổn
        # định (lúc cào dịch được → 'Nhà thơ Pixel', lúc cache/mạng lỗi → giữ gốc '像素诗人') → CÙNG 1 kênh ra 2
        # folder khác tên = "tách/sáp nhập kênh". Nickname gốc LUÔN có + ổn định. Hậu tố sec_uid (định danh duy
        # nhất) chống: nickname RỖNG (2 kênh → cùng "kenh"), nickname TRÙNG (2 người cùng tên). → mỗi kênh 1 folder.
        safe_nick = _safe_name(nickname, 40) if nickname else "kenh"
        folder = f"{safe_nick}_{_safe_name(_sec[-8:], 16)}" if _sec else safe_nick   # sec_uid: cùng lý do như aweme_id
        sub_dir = f"kenh/{folder}"
    else:
        sub_dir = "link"
    return sub_dir, file_base



def _la_ban_khoa(content) -> bool:
    """MP4 này có phải bản KHOÁ BẢN QUYỀN (CENC) không — tải về NGUYÊN VẸN nhưng không giải mã được.

    CA THẬT 03/09/2026: 27/258 video trong máy chủ dự án mở ra ĐEN SÌ. Đã pháp y kỹ, và mấy dấu
    hiệu quen thuộc đều ĐÁNH LẠC HƯỚNG — ghi ra đây để lần sau khỏi đi lại đường vòng:
      · độ dài file khớp TỪNG BYTE với `mdat` khai trong chính nó ⇒ KHÔNG cụt, không phải tải dở
      · khung NAL khớp hoàn hảo (1438/1647/1492 mẫu, tiền tố độ dài cộng đúng cỡ mẫu) ⇒ KHÔNG
        phải nối byte sai chỗ khi resume — chuẩn CENC CỐ Ý để nguyên tiền tố, chỉ mã hoá phần ruột
      · `ftyp moov` đẹp, ffprobe đọc ra đủ thời lượng + độ phân giải ⇒ giao diện vẫn vẽ được thẻ
        video, chỉ ảnh ra đen ⇒ RẤT dễ đổ oan cho lớp hiển thị
    Thứ THỰC SỰ phân biệt nằm ở `stsd`: bản khoá dùng `encv`/`enca` (+ `sinf`/`schm`=cenc/`tenc`/
    `senc`) thay cho `avc1`/`mp4a`. ffmpeg gặp bản này báo `non-existing PPS N referenced` và
    `A non-intra slice in an IDR NAL unit` — đó là HÌNH DẠNG CỦA DỮ LIỆU ĐÃ MÃ HOÁ khi bị đọc như
    video thường, KHÔNG phải lỗi codec.

    🔴 CHỈ soi TRONG box `moov`. `encv`/`enca` chỉ là 4 byte thường, gặp ngẫu nhiên giữa `mdat`
       (hàng chục MB) là chuyện bình thường — quét cả file sẽ cho dương tính giả, mà dương tính
       giả ở đây nghĩa là VỨT NHẦM video lành.
    """
    if not content or len(content) < 16:
        return False
    b = bytes(content)
    n = len(b)
    off = 0
    while off + 8 <= n:
        sz = int.from_bytes(b[off:off + 4], "big")
        ty = b[off + 4:off + 8]
        hdr = 8
        if sz == 1:                       # box cỡ 64-bit
            if off + 16 > n:
                return False
            sz = int.from_bytes(b[off + 8:off + 16], "big")
            hdr = 16
        elif sz == 0:                     # box cuối, chạy tới hết file
            sz = n - off
        if sz < hdr:
            return False
        if ty == b"moov":
            than = b[off + hdr:min(off + sz, n)]
            return (b"encv" in than or b"enca" in than
                    or (b"schm" in than and b"cenc" in than))
        off += sz
    return False


class DouYinCrawler(AbstractCrawler):
    context_page: Page
    dy_client: DouYinClient
    browser_context: BrowserContext
    cdp_manager: Optional[CDPBrowserManager]

    def __init__(self) -> None:
        self.index_url = "https://www.douyin.com"
        self.cookie_urls = [
            "https://douyin.com",
            self.index_url,
            "https://creator.douyin.com",
            "https://douhot.douyin.com",
            "https://live.douyin.com",
        ]
        self.cdp_manager = None
        self.ip_proxy_pool = None  # Proxy IP pool for automatic proxy refresh
        self._seen_ids = None  # sổ ID đã tải (để không tải lại dù file gốc đã bị xóa sau rerender)
        self._dl_tasks = []    # tải media chạy NỀN (song song có giới hạn) — crawl/API VẪN tuần tự
        self._dl_sem = None    # asyncio.Semaphore(MC_DL_CONCURRENCY) — tạo lazy trong event loop

    def _tai_nen(self, coro_fn, *a):
        """Lên lịch TẢI MEDIA chạy NỀN, giới hạn MC_DL_CONCURRENCY (mặc định 2). Fetch-detail/API VẪN tuần
        tự (semaphore cũ không đổi) → chỉ phần tải video chồng lấp = nhanh hơn mà nhẹ nhàng với anti-bot."""
        if self._dl_sem is None:
            self._dl_sem = asyncio.Semaphore(max(1, int(os.environ.get("MC_DL_CONCURRENCY", "2"))))
        async def _w():
            async with self._dl_sem:
                try:
                    await coro_fn(*a)
                except Exception as _e:
                    utils.logger.error(f"[tai-nen] {_e}")
                    # 🔴 (23/08) lỗi tải 1 video chạy nền trước chỉ vào FILE log → khách không biết video nào
                    # rớt. In LOG: để hiện UI (1 video lỗi KHÔNG dừng cả lượt, các video khác vẫn tải).
                    print("LOG:✗ Một video tải lỗi (bỏ qua, tải tiếp video khác): %s" % str(_e)[:120], flush=True)
        self._dl_tasks.append(asyncio.create_task(_w()))

    async def _drain_tai(self):
        """Đợi MỌI tải nền hoàn tất (gọi cuối mỗi hàm cào, trước khi return)."""
        if self._dl_tasks:
            await asyncio.gather(*self._dl_tasks, return_exceptions=True)
            self._dl_tasks = []

    def _ledger_path(self) -> str:
        base = config.SAVE_DATA_PATH if config.SAVE_DATA_PATH else "data"
        return os.path.join(base, "douyin", "_da_tai_ids.txt")

    def _load_seen(self):
        if self._seen_ids is None:
            self._seen_ids = set()
            p = self._ledger_path()
            if os.path.exists(p):
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        self._seen_ids = {line.strip() for line in f if line.strip()}
                except Exception:
                    pass
        return self._seen_ids

    def _mark_seen(self, aweme_id: str):
        if not aweme_id:
            return
        self._load_seen().add(aweme_id)
        p = self._ledger_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        try:
            with open(p, "a", encoding="utf-8") as f:
                f.write(aweme_id + "\n")
        except Exception:
            pass

    def _video_moi_path(self) -> str:
        base = config.SAVE_DATA_PATH if config.SAVE_DATA_PATH else "data"
        return os.path.join(base, "douyin", "_video_moi.jsonl")

    def _ghi_video_moi(self, aweme_item: Dict, sub_dir: str, file_base: str):
        """Ghi 1 dòng 'video MỚI theo kênh' vào sổ phụ _video_moi.jsonl (sidecar — KHÔNG đụng ledger).
        Chỉ cho cào theo KÊNH (sub_dir 'kenh/...'); giữ sec_uid + create_time để truy ngược kênh + ngày đăng.
        Bọc try/except: lỗi ghi sổ KHÔNG được làm hỏng việc tải (giống _mark_seen)."""
        try:
            if not sub_dir.startswith("kenh/"):
                return
            # 🔴 09/09/2026 — ĐI QUA `tools/so_video_moi` (bộ ghi DÙNG CHUNG cho mọi nền). Khuôn bản
            #   ghi GIỮ NGUYÊN từng khoá; đây là đổi chỗ chứ không đổi dữ liệu. Trước đây bộ ghi chỉ
            #   có ở đây ⇒ Bilibili/XHS không bao giờ có sổ ⇒ tab "Video mới" trống với khách theo dõi
            #   hai nền đó (xem docstring `so_video_moi`).
            author = aweme_item.get("author", {}) or {}
            from tools import so_video_moi as _svm
            _svm.ghi("douyin", sub_dir, f"{file_base}.mp4",
                     vid=aweme_item.get("aweme_id", "") or "",
                     uid=author.get("sec_uid", "") or "",
                     nickname=author.get("nickname", "") or "",
                     create_time=aweme_item.get("create_time", 0) or 0)
        except Exception:
            pass

    async def start(self) -> None:
        playwright_proxy_format, httpx_proxy_format = None, None
        if config.ENABLE_IP_PROXY:
            self.ip_proxy_pool = await create_ip_pool(config.IP_PROXY_POOL_COUNT, enable_validate_ip=True)
            ip_proxy_info: IpInfoModel = await self.ip_proxy_pool.get_proxy()
            playwright_proxy_format, httpx_proxy_format = utils.format_proxy_info(ip_proxy_info)

        # NO-BROWSER (mặc định ON): cookie giải mã từ profile Chromium (DPAPI) + httpx + a_bogus qua execjs
        # — KHÔNG mở Playwright headless. Tránh douyin anti-bot flag "nhiều phiên browser lạ liên tiếp" →
        # hết throttle khi cào nhiều lần (giống bili no-browser). Kill-switch: DY_NO_BROWSER=0 → quay browser.
        # macOS: cookie Chromium mã hoá App-Bound (key KHÔNG ở Keychain chuẩn) → cookie_decrypt ra RÁC →
        # sessionid rác → API 用户未登录 dù đã login. Nên MẶC ĐỊNH browser mode trên Mac (Chromium tự đọc
        # cookie nội bộ). Ép no-browser bằng DY_NO_BROWSER=1 (không khuyến nghị trên Mac).
        import sys as _sys
        _nb_mac_def = "0" if _sys.platform == "darwin" else "1"
        if os.environ.get("DY_NO_BROWSER", _nb_mac_def) != "0":
            self.dy_client = self._create_douyin_client_no_browser(httpx_proxy_format)
            pong_ok = await self.dy_client.pong()
            if not pong_ok:
                utils.logger.warning("[DouYinCrawler] Cảnh báo: Không đăng nhập / cookie hết hạn — cào công khai sẽ gặp rate-limit. Hãy đăng nhập nếu muốn cào nhiều hơn.")
            await self._run_crawl()
            # 🔴 10/09/2026 — LEO SANG TRÌNH DUYỆT KHI ARGUS CHẶN. Đường hứng-qua-trang chỉ chạy
            #   được khi CÓ `playwright_page`; no-browser thì không có, nên dù đã vá `get_video_by_id`
            #   vẫn bó tay. Ca khách pvluo 10/09: mọi lượt "Theo link" ra 0 video, 4 lần thử, 39s.
            #   Không `return` nữa mà rơi xuống nhánh trình duyệt bên dưới để chạy lại LƯỢT ĐÓ.
            #   Chỉ leo khi THẬT SỰ bị Argus — hết quota/không có video vẫn thoát gọn như cũ.
            #   ⚠ Video đã tải xong ở lượt no-browser sẽ được xét lại; ledger `_da_tai_ids.txt` lo
            #     phần trùng, nên chấp nhận được (thà chậm còn hơn mất trắng cả lượt cào).
            if not getattr(self.dy_client, "argus_chan", False):
                return
            # 🔴 10/09/2026 — PHẢI MỞ CÓ GIAO DIỆN. ĐO TRÊN MÁY KHÁCH: chạy headless thì Douyin ĐÁ
            #   `/video/<id>` về `/jingxuan` (trang feed) ⇒ trang video không bao giờ render ⇒ không
            #   có `/aweme/detail/` để hứng ⇒ `_thd_lay` về tay không sau 24s. Cùng máy, cùng phiên,
            #   chỉ đổi `--headless no`: **16 giây, 1 file, cào được**. (Máy dev không bị đá nên
            #   KHÔNG tái hiện được — phải đo trên máy đang lỗi mới ra.)
            #   ⚠ Mở rộng bộ hứng sang mọi endpoint KHÔNG cứu được: đã đo, modal `jingxuan` lấy dữ
            #     liệu qua `mix/aweme/` và không mang aweme cần tìm. Gốc là cú ĐÁ, không phải chỗ hứng.
            #   Chỉ ép ở ĐÂY (nhánh leo vì Argus) — lượt cào bình thường vẫn headless như cũ.
            config.HEADLESS = False
            config.CDP_HEADLESS = False
            self._an_cua_so = True     # headful nhưng ĐẨY RA NGOÀI MÀN HÌNH — xem `launch_browser`
            utils.logger.warning(
                "[DouYinCrawler] Douyin chặn đường HTTP thuần (đòi chữ ký Argus, HOẶC trả thân "
                "RỖNG — 10/09 gặp CẢ HAI) → CHẠY LẠI bằng TRÌNH DUYỆT THẬT. Đây KHÔNG phải lỗi tài "
                "khoản hay IP.")

        async with async_playwright() as playwright:
            # Select startup mode based on configuration
            if config.ENABLE_CDP_MODE:
                utils.logger.info("[DouYinCrawler] 使用CDP模式启动浏览器")
                self.browser_context = await self.launch_browser_with_cdp(
                    playwright,
                    playwright_proxy_format,
                    None,
                    headless=config.CDP_HEADLESS,
                )
            else:
                utils.logger.info("[DouYinCrawler] 使用标准模式启动浏览器")
                # Launch a browser context.
                chromium = playwright.chromium
                self.browser_context = await self.launch_browser(
                    chromium,
                    playwright_proxy_format,
                    user_agent=None,
                    headless=config.HEADLESS,
                )
                # stealth.min.js is a js script to prevent the website from detecting the crawler.
                await self.browser_context.add_init_script(path="libs/stealth.min.js")

            self.context_page = await self.browser_context.new_page()
            # Dùng domcontentloaded + timeout: trang chủ Douyin nặng, chờ "load" có thể TREO vô hạn.
            try:
                await self.context_page.goto(self.index_url, wait_until="domcontentloaded", timeout=30000)
            except Exception as e:
                utils.logger.warning(f"[DouYinCrawler] goto index bỏ qua (timeout/err): {e}")

            self.dy_client = await self.create_douyin_client(httpx_proxy_format)
            pong_ok = await self.dy_client.pong(browser_context=self.browser_context)
            if not pong_ok:
                utils.logger.warning("[DouYinCrawler] Cảnh báo: Không đăng nhập — cào công khai sẽ gặp rate-limit IP. Dùng --proxy nếu bị block.")
                await self.dy_client.update_cookies(
                    browser_context=self.browser_context,
                    urls=self.cookie_urls,
                )
            await self._run_crawl()

    async def _run_crawl(self) -> None:
        """Dispatch theo CRAWLER_TYPE — dùng CHUNG cho cả no-browser lẫn browser mode."""
        crawler_type_var.set((os.environ.get("MC_SOURCE_MODE") or config.CRAWLER_TYPE).strip())
        if os.environ.get("MC_SOURCE_INPUT"):
            source_keyword_var.set(os.environ["MC_SOURCE_INPUT"])
        if config.CRAWLER_TYPE == "search":
            await self.search()
        elif config.CRAWLER_TYPE == "detail":
            await self.get_specified_awemes()
        elif config.CRAWLER_TYPE == "creator":
            await self.get_creators_and_videos()
        elif config.CRAWLER_TYPE == "userlist":
            await self.search_creators_to_file()
        elif config.CRAWLER_TYPE == "chase":
            await self.get_chase_series()
        utils.logger.info("[DouYinCrawler.start] Douyin Crawler finished ...")

    async def get_chase_series(self) -> None:
        """"ĐUỔI THEO BỘ": nhận LINK VIDEO cụ thể (config.DY_SPECIFIED_ID_LIST, tái dùng field mode detail)
        thay vì link kênh. Với MỖI link: lấy chi tiết video → tách (tên_goc, so_tap) từ tiêu đề (desc) →
        nếu KHÔNG tách được (video không đánh số tập) → bỏ qua, báo lỗi rõ. Tách được → quét kênh CỦA
        TÁC GIẢ video đó (sec_uid từ author), lọc video cùng tên gốc, dừng khi thấy Tập 1 (xem
        _collect_user_posts nhánh CHASE). Nhiều link cùng lúc → xử lý TUẦN TỰ (mỗi link 1 bộ khác nhau)."""
        utils.logger.info("[DouYinCrawler.get_chase_series] Bắt đầu đuổi theo bộ...")
        for video_url in config.DY_SPECIFIED_ID_LIST:
            try:
                video_info = parse_video_info_from_url(video_url)
                if video_info.url_type == "short":
                    resolved_url = await self.dy_client.resolve_short_url(video_url)
                    if not resolved_url:
                        utils.logger.error(f"[get_chase_series] Không resolve được short link: {video_url}")
                        continue
                    video_info = parse_video_info_from_url(resolved_url)
            except ValueError as e:
                utils.logger.error(f"[get_chase_series] Link video không hợp lệ: {video_url} ({e})")
                continue

            aweme_detail = await self.get_aweme_detail(aweme_id=video_info.aweme_id, semaphore=asyncio.Semaphore(1))
            if not aweme_detail:
                utils.logger.error(f"[get_chase_series] Không lấy được chi tiết video {video_info.aweme_id} — bỏ qua.")
                continue

            # 🔴 (24/08) OFFICIAL 合集 TRƯỚC: nếu video thuộc HỢP TUYỂN do tác giả tạo (mix_info.mix_id) →
            # lấy TRỌN bộ qua API mix (chính xác 100%, như Bilibili ugc_season / TikTok collection). Không có
            # mix / mix API lỗi-rỗng → LÙI về đoán-tiêu-đề bên dưới (lưới cứu, đã fix nhận 第N集).
            _mix = aweme_detail.get("mix_info") or {}
            _mix_id = str(_mix.get("mix_id") or "").strip()
            # 🔴 15/09/2026 — CHỌN ĐÚNG CỬA NGAY, đừng để pha thử-lại-rỗng nuốt ~12s rồi mới sang cửa kia.
            #   PHIM NGẮN (短剧) khai `series_info`/`series_basic_info` trong `aweme_detail` và phục vụ danh
            #   sách tập ở `/series/aweme/`; HỢP TUYỂN thường thì không có hai trường đó và đi `/mix/aweme/`.
            #   CẢ HAI dùng CÙNG id `mix_info.mix_id` (đã đo: series_id == mix_id), nên chỉ khác endpoint.
            #   Vẫn thử KIỂU CÒN LẠI làm đường lùi — Douyin đổi cách khai thì mình không chết theo.
            #   Tắt hẳn đường 短剧 (quay về hành vi trước 15/09): DY_SERIES=0.
            _la_series = bool(aweme_detail.get("series_info") or aweme_detail.get("series_basic_info"))
            _thu_tu = ["series", "mix"] if _la_series else ["mix", "series"]
            if os.environ.get("DY_SERIES", "1") != "1":
                _thu_tu = ["mix"]
            try:
                _tong_tap = int(((_mix.get("statis") or {}).get("total_episode")) or 0)
            except (TypeError, ValueError):
                _tong_tap = 0
            _lay_duoc = False
            for _kieu in _thu_tu:
                if _mix_id and await self._tai_mix_official(
                        _mix_id, _mix.get("mix_name", ""), seed_aweme_id=video_info.aweme_id,
                        kieu=_kieu, tong_tap=_tong_tap):
                    _lay_duoc = True
                    break
            if _lay_duoc:
                continue

            # 🔴 14/09/2026 — CHỈ DÙNG API 合集 CHÍNH THỨC (chủ dự án chốt). ĐÃ BỎ đường 'đoán theo tiêu đề'
            #   (quét cả kênh tác giả · bỏ video không đánh số tập · thua lối số Hán 壹/贰/叁). `_tai_mix_official`
            #   kèm đường lùi 'lấy 合集 QUA TRANG' (khi Argus chặn HTTP) là nguồn tin cậy — xem client._thmix_lay.
            if _mix_id and getattr(self.dy_client, "playwright_page", None) is None:
                # LƯỢT NO-BROWSER: mix đòi chữ ký Argus qua trang → start() sẽ TỰ LEO sang trình duyệt và
                # chạy lại lượt này. Không phải lỗi ⇒ đừng hét ERROR ở đây.
                utils.logger.info(f"[get_chase_series] 合集 '{_mix.get('mix_name') or _mix_id}' cần trình duyệt "
                                  f"(Argus) — sẽ chạy lại bằng trình duyệt thật.")
            elif _mix_id:
                utils.logger.error(f"[get_chase_series] 合集 '{_mix.get('mix_name') or _mix_id}': API chính thức "
                                   f"lấy 0 video (kể cả đường qua trang) — bỏ qua video {video_info.aweme_id}.")
            else:
                utils.logger.error(f"[get_chase_series] Video {video_info.aweme_id} KHÔNG thuộc 合集 (hợp tuyển) "
                                   f"nào → 'Theo bộ' chỉ tải được video nằm trong 1 合集. Bỏ qua.")
            continue

    async def _tai_mix_official(self, mix_id: str, mix_name: str = "", seed_aweme_id: str = "",
                                kieu: str = "mix", tong_tap: int = 0) -> bool:
        """🔴 (24/08) Tải TRỌN BỘ CHÍNH THỨC theo id (phân trang API — chuẩn xác như Bilibili ugc_season).
        Trả True nếu lấy được ≥1 video (đã tải/ghi); False nếu rỗng/lỗi ⇒ caller thử KIỂU CÒN LẠI.
        In LOG: tiến độ như các nhánh khác. Trần 500 trang chống loop vô hạn.

        🔴 15/09/2026 — `kieu`: **`mix`** = 合集 hợp tuyển (`/mix/aweme/`) · **`series`** = 短剧 phim ngắn
        (`/series/aweme/`). HAI LOẠI DÙNG ENDPOINT KHÁC NHAU nhưng CÙNG một id (`mix_info.mix_id`) và
        cùng vòng phân trang này. Vì sao phải tách: xem số đo ở `client.get_series_aweme_list`.
        `tong_tap` = `statis.total_episode` nền tảng khai — chỉ dùng để NÓI THẬT khi lấy được thiếu tập."""
        _nhan = "合集" if kieu == "mix" else "短剧"
        _ten = (mix_name or mix_id)[:40]
        print("LOG:📦 Douyin %s chính thức: '%s' — đang lấy danh sách cả bộ…" % (_nhan, _ten), flush=True)
        collected: List[Dict] = []
        seen_ids = set()
        cursor = 0
        # 🔴 14/09/2026 — LỜI GỌI ĐẦU RỖNG/LỖI: PHẢI THỬ LẠI, đừng bỏ cuộc.
        #   Douyin RẤT hay trả RỖNG ở lần gọi ĐẦU (风控 / giới hạn tần suất) rồi OK khi thử lại — mỗi
        #   lần gọi client tự sinh msToken + a_bogus MỚI nên retry là một CHỮ KÝ MỚI, không phải lặp
        #   vô ích. Chính file này đã ghi đúng câu đó ở `search_creators_to_file`, và:
        #     · đường TỪ KHOÁ  có retry (`DY_SEARCH_RETRY`, mặc định 4)
        #     · đường KÊNH     có retry (`DY_KENH_RONG_THU`, thêm 14/09)
        #     · đường 合集     KHÔNG có  ← chỗ đang vá
        #   Hậu quả cũ: trang đầu rỗng ⇒ `return False` ⇒ lùi về đường ĐOÁN TIÊU ĐỀ (kém hơn hẳn: bỏ
        #   qua mọi video không đánh số tập trong tiêu đề — `web_app.py:5669` ghi là "RẤT PHỔ BIẾN").
        #   Khách thấy "Theo bộ" lúc được lúc không, không rõ vì sao. Đúng lớp "một luật, ba đường,
        #   một đường quên". Tắt thử lại: DY_BO_RONG_THU=0.
        try:
            _RONG_THU = int(os.environ.get("DY_BO_RONG_THU", "3") or 3)
        except ValueError:
            _RONG_THU = 3
        # NO-BROWSER: mix ĐÒI chữ ký Argus qua trang (không có page ⇒ chắc chắn fail). Đừng retry 4×
        # (~21s phí) — fail nhanh để start() LEO sang trình duyệt ngay, nơi `_thmix_lay` lấy được.
        if getattr(self.dy_client, "playwright_page", None) is None:
            _RONG_THU = 0
        _rong_dau = 0
        for _trang in range(1, 501):
            try:
                if kieu == "series":
                    res = await self.dy_client.get_series_aweme_list(mix_id, cursor, seed_aweme_id=seed_aweme_id)
                else:
                    res = await self.dy_client.get_mix_aweme_list(mix_id, cursor, seed_aweme_id=seed_aweme_id)
            except Exception as _e:
                utils.logger.error(f"[chase-mix] mix {mix_id} lỗi trang {_trang}: {_e}")
                if not collected and _rong_dau < _RONG_THU:
                    _rong_dau += 1
                    _cho = 2 * _rong_dau
                    print("LOG:⏳ %s '%s': lời gọi ĐẦU lỗi (%s) — thử lại %d/%d sau %ds với chữ ký mới."
                          % (_nhan, _ten, str(_e)[:60], _rong_dau, _RONG_THU, _cho), flush=True)
                    cursor = 0
                    await asyncio.sleep(_cho)
                    continue
                print("LOG:⏳ %s lỗi/chậm ở trang %d — lùi sang TRÌNH DUYỆT (start tự leo khi Argus)."
                      % (_nhan, _trang), flush=True)
                break
            lst = (res or {}).get("aweme_list") or []
            for _aw in lst:
                _aid = str((_aw or {}).get("aweme_id") or "")
                if _aid and _aid not in seen_ids:
                    seen_ids.add(_aid)
                    collected.append(_aw)
            # TRANG ĐẦU RỖNG (chưa gom được gì) → thử lại thay vì bỏ cuộc. Trang GIỮA rỗng vẫn `break`
            # như cũ: ở đó rỗng nghĩa là HẾT danh sách, không phải bị chặn.
            if not lst and not collected and _rong_dau < _RONG_THU:
                _rong_dau += 1
                _cho = 2 * _rong_dau
                print("LOG:⏳ %s '%s': danh sách trang ĐẦU RỖNG — thử lại %d/%d sau %ds với chữ ký mới "
                      "(Douyin hay trả rỗng lần đầu do 风控)." % (_nhan, _ten, _rong_dau, _RONG_THU, _cho), flush=True)
                cursor = 0
                await asyncio.sleep(_cho)
                continue
            print("LOG:📄 %s '%s': đã thấy %d video…" % (_nhan, _ten, len(collected)), flush=True)
            if not (res or {}).get("has_more") or not lst:
                break
            # 🔴 15/09/2026 — `series` KHÔNG trả khoá `cursor` (chỉ `max_cursor`/`min_cursor`), nên
            #   `.get("cursor")` ra None ⇒ tin vào nó thì con trỏ ĐỨNG YÊN = lặp lại trang đầu tới khi
            #   chạm trần 500. Với `series` luôn tiến theo SỐ TẬP đã lấy (cursor là chỉ số tập 0-based —
            #   đo được: request cursor=2 trong khi statis.current_episode=3).
            cursor = (cursor + len(lst)) if kieu == "series" else ((res or {}).get("cursor") or (cursor + len(lst)))
            await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
        if not collected:
            print("LOG:⚠ %s '%s': đường HTTP lấy 0 video (Argus) — %s."
                  % (_nhan, _ten, ("sẽ leo sang TRÌNH DUYỆT" if getattr(self.dy_client, "playwright_page", None) is None
                                   else "kể cả đường qua trang cũng rỗng")), flush=True)
            return False
        # 🔴 15/09/2026 — NÓI THẬT KHI THIẾU TẬP. 短剧 hay bị KHOÁ TRẢ PHÍ: bộ `我穿成了校花的恶毒老爹`
        #   khai `total_episode=80` nhưng `charge_info.sku_free_status_map` chỉ 9 sku mở. Im lặng trả 9 tập
        #   thì khách tưởng tool tải thiếu — đúng lớp "làm âm thầm" mà NGHIEP-VU §3 xếp mức nặng.
        if tong_tap and len(collected) < tong_tap:
            print("LOG:💰 %s '%s': lấy được %d/%d tập. Phần còn lại Douyin KHÔNG mở cho web (tập trả phí "
                  "hoặc chưa phát hành) — KHÔNG phải lỗi tool." % (_nhan, _ten, len(collected), tong_tap), flush=True)
        utils.logger.info(f"[chase-mix] {_nhan} '{_ten}': {len(collected)} video — đang tải…")
        if os.environ.get("MC_GET_MEDIAS", "1") == "0":
            for _aw in collected:
                try:
                    await douyin_store.update_douyin_aweme(aweme_item=_aw)
                except Exception as _e:
                    utils.logger.warning(f"[chase-mix] preview ghi item lỗi: {_e}")
        else:
            await self.fetch_creator_video_detail(collected)
        try:
            await self.batch_get_note_comments([v.get("aweme_id") for v in collected])
        except Exception:
            pass
        return True

    async def search_creators_to_file(self) -> None:
        """Tìm KÊNH theo từ khóa: tìm video → lấy tác giả → tra số follow → xếp hạng → ghi JSON."""
        keyword = (config.KEYWORDS.split(",")[0] if config.KEYWORDS else "").strip()
        out_path = os.environ.get("GOI_Y_OUT") or os.path.join("data", "douyin", "_goi_y_kenh.json")
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        utils.logger.info(f"[search_creators_to_file] Tìm kênh theo từ khóa: {keyword}")

        # 1) Tìm video, gom tác giả duy nhất (qua vài trang để có nhiều kênh)
        authors: Dict[str, Dict] = {}
        dy_search_id = ""
        # ANTI-BOT RETRY (như search() cào-video): Douyin RẤT hay trả RỖNG lần gọi ĐẦU (风控/giới hạn tần suất)
        # rồi OK khi thử lại (mỗi lần client tự sinh msToken+a_bogus MỚI = chữ ký mới). Trước đây gợi-ý-kênh
        # BỎ CUỘC ngay khi trang đầu rỗng → "không tìm được kênh dù đã login". Chỉ retry TRANG ĐẦU (rỗng).
        dy_max_retry = int(os.environ.get("DY_SEARCH_RETRY", 4))
        for page in range(2):
            data = []
            for _attempt in range(dy_max_retry + 1):
                try:
                    res = await self.dy_client.search_info_by_keyword(
                        keyword=keyword, offset=page * 10, search_id=dy_search_id)
                except Exception as e:
                    utils.logger.error(f"[search_creators_to_file] search page {page} error: {e}")
                    res = {}
                data = res.get("data") or []
                dy_search_id = res.get("extra", {}).get("logid", "") or dy_search_id
                if data or page > 0 or _attempt >= dy_max_retry:
                    break    # có kết quả / trang sau (rỗng=hết thật) / hết lượt thử → dừng retry
                wait = config.CRAWLER_MAX_SLEEP_SEC + 3 * (_attempt + 1)   # backoff tăng dần
                utils.logger.info(f"[search_creators_to_file] Douyin tra RONG (co the 风控/gioi han tan suat) - nghi {wait}s thu lai voi chu ky moi ({_attempt+1}/{dy_max_retry})...")
                await asyncio.sleep(wait)
            if not data:
                if page == 0:
                    utils.logger.error(f"[search_creators_to_file] DOUYIN_EMPTY: keyword '{keyword}' tra 0 sau {dy_max_retry} lan thu (anti-bot/gioi han tan suat - KHONG phai loi tool, thu lai sau)")
                break
            for item in data:
                cands = []
                if item.get("aweme_info"):
                    cands.append(item["aweme_info"])
                cands += item.get("aweme_list") or []
                for a in cands:
                    au = (a or {}).get("author") or {}
                    sec = au.get("sec_uid")
                    if not sec or sec in authors:
                        continue
                    avatar = ""
                    v = au.get("avatar_thumb") or {}
                    if v.get("url_list"):
                        avatar = v["url_list"][0]
                    authors[sec] = {"nickname": au.get("nickname", ""), "avatar": avatar}
            await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)

        # 2) Tra follow/like/video từng kênh — chạy SONG SONG (semaphore) cho nhanh.
        #    GOI_Y_FANS=0 để tắt (chỉ lấy tên/avatar, cực nhanh). GOI_Y_LIMIT giới hạn số kênh.
        lay_fans = os.environ.get("GOI_Y_FANS", "1") == "1"
        gioi_han_kenh = int(os.environ.get("GOI_Y_LIMIT", "12"))
        items = list(authors.items())[:gioi_han_kenh]
        sem = asyncio.Semaphore(5)

        async def _lay_1_kenh(sec, base):
            avatar = base["avatar"]
            fans = total = videos = 0
            sig = ""
            if lay_fans:
                async with sem:
                    try:
                        info = await self.dy_client.get_user_info(sec)
                        u = info.get("user", {}) if isinstance(info, dict) else {}
                        fans = u.get("max_follower_count") or u.get("follower_count") or 0
                        total = u.get("total_favorited") or 0
                        videos = u.get("aweme_count") or 0
                        sig = u.get("signature", "")
                        if not avatar:
                            uri = (u.get("avatar_300x300", {}) or {}).get("uri")
                            if uri:
                                avatar = f"https://p3-pc.douyinpic.com/img/{uri}~c5_300x300.jpeg?from=2956013662"
                    except Exception as e:
                        utils.logger.error(f"[search_creators_to_file] get_user_info error: {e}")
            return {
                "nickname": base["nickname"], "sec_uid": sec,
                "link": f"https://www.douyin.com/user/{sec}", "avatar": avatar,
                "fans": fans, "total_favorited": total, "videos_count": videos, "signature": sig,
            }

        creators = list(await asyncio.gather(*[_lay_1_kenh(s, b) for s, b in items]))
        if lay_fans:
            creators.sort(key=lambda c: c.get("fans") or 0, reverse=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(creators, f, ensure_ascii=False, indent=2)
        utils.logger.info(f"[search_creators_to_file] Đã lưu {len(creators)} kênh -> {out_path}")

    async def search(self) -> None:
        utils.logger.info("[DouYinCrawler.search] Begin search douyin keywords")
        dy_limit_count = 10  # douyin limit page fixed value
        # 🔴 14/09/2026 — “Số lượng” KHÁCH GÕ BỊ ÉP LÊN 10.
        #   `CRAWLER_MAX_NOTES_COUNT` gánh HAI NGHĨA: vừa là “số video muốn tải” vừa là “mốc PHÂN TRANG”.
        #   API Douyin trả CỐ ĐỊNH 10 bài/trang nên dòng dưới nâng nó lên 10 để vòng lặp lấy đủ MỘT trang
        #   — rồi CẢ HAI nhánh tải lại dùng chính biến ĐÃ BỊ NÂNG làm TRẦN TẢI.
        #   ĐO THẬT (14/09, bấm qua giao diện, `count=2`): tải về **10 video / 467 MB**, log tự in
        #   “Đã tải 10/2 video” — tức app BIẾT là vượt mà vẫn tải tiếp.
        #   Với gói có hạn mức, một yêu cầu 2 video bị TÍNH 10 lượt (hạn mức đếm theo video TẢI THỌC).
        #   Cùng họ với bài học đã ghi: *“«Số lượng» là số MỖI KÊNH, không phải tổng”* — lần này ở đường TỪ KHÓA.
        #   ⇒ Tách hẳn: `_muon` = số khách xin (TRẦN TẢI) · `CRAWLER_MAX_NOTES_COUNT` giữ nguyên vai
        #   trò mốc PHÂN TRANG. Về hành vi cũ: `DY_KHONG_CAT_SO=1`.
        _muon = max(1, int(config.CRAWLER_MAX_NOTES_COUNT or 1))
        _cat_so = os.environ.get("DY_KHONG_CAT_SO", "0") != "1"
        if config.CRAWLER_MAX_NOTES_COUNT < dy_limit_count:
            config.CRAWLER_MAX_NOTES_COUNT = dy_limit_count
        start_page = config.START_PAGE  # start page number
        # "Cào KHÔNG TRÙNG" (đào sâu): MC_DEEP_NEW=1 → cào tới khi đủ N video CHƯA TẢI (bỏ qua video đã tải,
        # đào trang SÂU hơn) thay vì chỉ N/10 trang → "tải hết rồi vẫn ra video mới". Trần MC_DEEP_PAGE_CAP
        # chống đào vô hạn kênh không còn gì mới (đào sâu = nhiều request hơn = tăng rủi ro anti-bot).
        DEEP = os.environ.get("MC_DEEP_NEW", "0") == "1"
        try:
            DEEP_PAGE_CAP = int(os.environ.get("MC_DEEP_PAGE_CAP", "40") or 40)
        except ValueError:
            DEEP_PAGE_CAP = 40
        seen_ref = self._load_seen()   # set ID đã tải (cached) — đếm "mới" = aid vừa được get_aweme_media mark_seen
        for keyword in config.KEYWORDS.split(","):
            source_keyword_var.set(keyword)
            utils.logger.info(f"[DouYinCrawler.search] Current keyword: {keyword}")
            aweme_list: List[str] = []
            new_count = 0   # số video MỚI (chưa tải) đã tải được trong lần này — dùng cho chế độ đào sâu DEEP
            page = 0
            dy_search_id = ""
            while ((not DEEP and (page - start_page + 1) * dy_limit_count <= config.CRAWLER_MAX_NOTES_COUNT)
                   or (DEEP and new_count < (_muon if _cat_so else config.CRAWLER_MAX_NOTES_COUNT) and (page - start_page) < DEEP_PAGE_CAP)):
                if page < start_page:
                    utils.logger.info(f"[DouYinCrawler.search] Skip {page}")
                    page += 1
                    continue
                # Cho phép GUI ghi đè kiểu sắp xếp / lọc thời gian qua biến môi trường
                sort_val = int(os.environ.get("DY_SORT_TYPE", getattr(config, "DY_SEARCH_SORT_TYPE", 0)))
                time_val = int(os.environ.get("DY_PUBLISH_TIME", config.PUBLISH_TIME_TYPE))
                # ANTI-BOT RETRY: Douyin RẤT hay trả data RỖNG (风控 / giới hạn tần suất) ở lần gọi ĐẦU rồi
                # thành công khi thử lại — khác Bilibili (đã ổn) ở chỗ trước đây Douyin BỎ CUỘC ngay, không retry.
                # Mỗi lần gọi client tự sinh msToken + a_bogus MỚI nên retry là một chữ ký mới (cơ hội qua 风控).
                # Chỉ retry khi CHƯA lấy được bài nào (trang ĐẦU); trang sau rỗng = đã hết kết quả thật → dừng.
                dy_max_retry = int(os.environ.get("DY_SEARCH_RETRY", 4))
                posts_res = None
                _need_login = False   # 🐛 FIX (đo thật RAW response): status_code=2483 "请先登录，再继续搜索吧"
                for _attempt in range(dy_max_retry + 1):
                    try:
                        utils.logger.info(f"[DouYinCrawler.search] search douyin keyword: {keyword}, page: {page}, sort={sort_val}, time={time_val}" + (f" (thu lai {_attempt}/{dy_max_retry})" if _attempt else ""))
                        posts_res = await self.dy_client.search_info_by_keyword(
                            keyword=keyword,
                            offset=page * dy_limit_count - dy_limit_count,
                            sort_type=SearchSortType(sort_val),
                            publish_time=PublishTimeType(time_val),
                            search_id=dy_search_id,
                        )
                    except DataFetchError:
                        posts_res = None   # bị chặn (text rỗng / "blocked") → coi như rỗng, sẽ retry
                    if posts_res and posts_res.get("data"):
                        break              # có kết quả → thoát retry
                    # 🐛 FIX (bắt được RAW response thật khi debug: Douyin trả JSON hợp lệ status_code=2483
                    # status_msg="请先登录，再继续搜索吧" — API search BẮT BUỘC đăng nhập, KHÔNG PHẢI 风控/anti-bot
                    # tạm thời như code cũ giả định). Trước đây coi MỌI trường hợp rỗng như nhau → retry MÙ 4
                    # lần (tốn ~34s: 4+7+10+13s) VÔ ÍCH vì đây là lỗi CỐ ĐỊNH (không tự khỏi giữa các lần thử,
                    # khác 风控 thật sự có cơ hội qua khi ký lại). Đọc status_code → dừng NGAY, không retry thêm.
                    _sc = (posts_res or {}).get("status_code")
                    if _sc == 2483:
                        _need_login = True
                        utils.logger.error(
                            f"[DouYinCrawler.search] DOUYIN_NEED_LOGIN keyword:{keyword} status_code={_sc} "
                            f"msg={(posts_res or {}).get('status_msg', '')!r} — Douyin YÊU CẦU ĐĂNG NHẬP để "
                            f"tìm kiếm theo từ khóa (không phải anti-bot/giới hạn tần suất tạm thời — đăng nhập "
                            f"lại rồi cào lại, KHÔNG cần đợi).")
                        # 🔴 (23/08) utils.logger chỉ vào FILE → khách KHÔNG thấy. In LOG: thẳng để hiện ngay UI:
                        # đây là lỗi CỐ ĐỊNH (cần đăng nhập), KHÔNG phải treo/anti-bot — dặn khách rõ khỏi ngồi đợi.
                        print("LOG:🔑 Douyin YÊU CẦU đăng nhập để tìm theo từ khoá — bấm 'Đăng nhập' Douyin rồi "
                              "cào lại. Đây KHÔNG phải treo/anti-bot tạm thời, KHÔNG cần đợi.", flush=True)
                        print("DOUYIN_NEED_LOGIN", flush=True)   # marker cho web_app map loi_fetch (khi bỏ chặn web_app)
                        posts_res = None
                        break
                    # Rỗng GIỮA CHỪNG thường là 风控 TẠM (trang 1 cũng từng rỗng rồi hồi phục sau retry) → RETRY
                    # CẢ trang sau (mỗi lần msToken/a_bogus mới = cơ hội qua 风控). Hết lượt vẫn rỗng = hết thật → dừng.
                    # (Trước đây: trang-sau rỗng → break NGAY, không retry → kẹt ~20 video dù keyword còn nhiều.)
                    if _attempt >= dy_max_retry:
                        break
                    wait = config.CRAWLER_MAX_SLEEP_SEC + 3 * (_attempt + 1)   # backoff tăng dần
                    utils.logger.info(f"[DouYinCrawler.search] Douyin tra RONG (co the 风控/gioi han tan suat) - nghi {wait}s roi thu lai voi chu ky moi...")
                    await asyncio.sleep(wait)

                if not posts_res or posts_res.get("data") is None or posts_res.get("data") == []:
                    if not aweme_list and not _need_login:
                        # Rỗng NGAY sau khi đã retry (chưa lấy được bài nào) = NỀN TẢNG từ chối:
                        # Douyin trả data rỗng (KHÔNG báo lỗi) khi phiên hết hạn / anti-bot / 风控 / giới hạn tần suất.
                        # (_need_login=True → đã log DOUYIN_NEED_LOGIN rõ ràng ở trên, KHỎI in thêm log mơ hồ này.)
                        utils.logger.error(f"[DouYinCrawler.search] DOUYIN_EMPTY_RESULT keyword:{keyword} (Douyin tra 0 ket qua sau {dy_max_retry} lan thu - thuong do phien het han / anti-bot / gioi han tan suat, KHONG phai loi tool)")
                    elif not _need_login:
                        utils.logger.info(f"[DouYinCrawler.search] search douyin keyword: {keyword}, page: {page} is empty")
                    break

                page += 1
                if "data" not in posts_res:
                    utils.logger.error(f"[DouYinCrawler.search] search douyin keyword: {keyword} failed，账号也许被风控了。")
                    break
                dy_search_id = posts_res.get("extra", {}).get("logid", "")
                page_aweme_list = []
                _da_xep = 0            # số video ĐÃ xếp tải trong trang này (nhánh thường — xem `_muon`)
                for post_item in posts_res.get("data"):
                    if _cat_so and not DEEP and _da_xep >= _muon:
                        utils.logger.info(f"[DouYinCrawler.search] Đủ {_da_xep}/{_muon} video khách xin — thôi tải tiếp trang này")
                        break
                    try:
                        aweme_info: Dict = (post_item.get("aweme_info") or post_item.get("aweme_mix_info", {}).get("mix_items")[0])
                    except TypeError:
                        continue
                    aid = aweme_info.get("aweme_id", "")
                    was_new = bool(aid) and aid not in seen_ref   # chưa tải TRƯỚC khi gọi
                    aweme_list.append(aid)
                    page_aweme_list.append(aid)
                    await douyin_store.update_douyin_aweme(aweme_item=aweme_info)
                    if DEEP:                                   # đào sâu: cần tải XONG để đếm video mới → TUẦN TỰ
                        await self.get_aweme_media(aweme_item=aweme_info)
                        if was_new and aid in seen_ref:        # get_aweme_media đã mark_seen ⇒ tải MỚI thành công
                            new_count += 1
                            if new_count >= (_muon if _cat_so else config.CRAWLER_MAX_NOTES_COUNT):
                                utils.logger.info(f"[DouYinCrawler.search] Đủ {new_count} video MỚI (đào sâu) — dừng keyword {keyword}")
                                break
                    else:
                        self._tai_nen(self.get_aweme_media, aweme_info)   # tải NỀN song song (≤MC_DL_CONCURRENCY)
                        # ĐẾM THEO VIDEO **MỚI**, không theo số đã xếp: video đã tải trước đó sẽ bị bỏ qua
                        # bên trong `get_aweme_media` ⇒ nếu tính nó vào suất thì khách xin 2 chỉ nhận 1
                        # (đo thật 14/09: xin 2 → `Đã tải 1/2`). `was_new` đã tính sẵn ngay trên.
                        if was_new:
                            _da_xep += 1

                # Batch get note comments for the current page
                await self.batch_get_note_comments(page_aweme_list)
                if _cat_so and not DEEP and _da_xep >= _muon:
                    break              # đủ số khách xin ⇒ không sang trang nữa (khỏi tốn request + rủi ro anti-bot)

                # Sleep after each page navigation
                await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                utils.logger.info(f"[DouYinCrawler.search] Sleeping for {config.CRAWLER_MAX_SLEEP_SEC} seconds after page {page-1}")
            utils.logger.info(f"[DouYinCrawler.search] keyword:{keyword}, aweme_list:{aweme_list}")
        await self._drain_tai()    # đợi tải nền (non-deep) xong trước khi kết thúc search

    async def get_specified_awemes(self):
        """Get the information and comments of the specified post from URLs or IDs"""
        utils.logger.info("[DouYinCrawler.get_specified_awemes] Parsing video URLs...")
        aweme_id_list = []
        for video_url in config.DY_SPECIFIED_ID_LIST:
            try:
                video_info = parse_video_info_from_url(video_url)

                # Handling short links
                if video_info.url_type == "short":
                    utils.logger.info(f"[DouYinCrawler.get_specified_awemes] Resolving short link: {video_url}")
                    resolved_url = await self.dy_client.resolve_short_url(video_url)
                    if resolved_url:
                        # Extract video ID from parsed URL
                        video_info = parse_video_info_from_url(resolved_url)
                        utils.logger.info(f"[DouYinCrawler.get_specified_awemes] Short link resolved to aweme ID: {video_info.aweme_id}")
                    else:
                        utils.logger.error(f"[DouYinCrawler.get_specified_awemes] Failed to resolve short link: {video_url}")
                        continue

                aweme_id_list.append(video_info.aweme_id)
                utils.logger.info(f"[DouYinCrawler.get_specified_awemes] Parsed aweme ID: {video_info.aweme_id} from {video_url}")
            except ValueError as e:
                utils.logger.error(f"[DouYinCrawler.get_specified_awemes] Failed to parse video URL: {e}")
                continue

        semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)
        task_list = [self.get_aweme_detail(aweme_id=aweme_id, semaphore=semaphore) for aweme_id in aweme_id_list]
        aweme_details = await asyncio.gather(*task_list)
        for aweme_detail in aweme_details:
            if aweme_detail is not None:
                await douyin_store.update_douyin_aweme(aweme_item=aweme_detail)
                self._tai_nen(self.get_aweme_media, aweme_detail)   # tải NỀN song song
        await self._drain_tai()
        await self.batch_get_note_comments(aweme_id_list)

    async def get_aweme_detail(self, aweme_id: str, semaphore: asyncio.Semaphore) -> Any:
        """Get note detail"""
        async with semaphore:
            # ANTI-BOT RETRY: detail API Douyin cũng hay rỗng/风控 (nhất là khi cào dồn / IP bị giới hạn tần
            # suất) → thử lại với CHỮ KÝ MỚI (mỗi get_video_by_id sinh msToken/a_bogus mới = cơ hội qua 风控),
            # như search/creator. Trước: lỗi 1 lần → None → "tải lại từ lịch sử ra 0 video" dù chỉ là 风控 TẠM.
            dy_max_retry = int(os.environ.get("DY_SEARCH_RETRY", 4))
            for _attempt in range(dy_max_retry + 1):
                try:
                    result = await self.dy_client.get_video_by_id(aweme_id)
                    if result:
                        await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                        return result
                except DataFetchError:
                    result = None
                except KeyError as ex:
                    utils.logger.error(f"[DouYinCrawler.get_aweme_detail] have not fund note detail aweme_id:{aweme_id}, err: {ex}")
                    return None
                except PlaywrightError as ex:
                    # 🔴 15/09/2026 — MỘT LINK HỎNG KHÔNG ĐƯỢC GIẾT CẢ LƯỢT. Lỗi TRÌNH DUYỆT
                    #   (`Page.goto: net::ERR_ABORTED`, trang bị đóng, hết giờ điều hướng…) trước đây
                    #   KHÔNG có `except` nào đỡ ⇒ thoát khỏi `get_aweme_detail` ⇒ `asyncio.gather` ở
                    #   `get_specified_awemes` ném tiếp ⇒ tiến trình chết mã 1. Khách dán 8 link thì
                    #   MẤT CẢ 8, kể cả link đã lấy xong — app chỉ nói "DỪNG BẤT THƯỜNG" và đổ oan
                    #   cho đăng nhập. Gốc (goto chồng nhau) đã vá bằng khoá ở `client._thd_lay`;
                    #   đây là LƯỚI: bỏ đúng link hỏng, các link còn lại vẫn về.
                    utils.logger.error(
                        f"[DouYinCrawler.get_aweme_detail] aweme {aweme_id}: lỗi TRÌNH DUYỆT khi lấy qua "
                        f"trang ({str(ex).splitlines()[0][:120]}) — BỎ QUA link này, các link khác vẫn chạy.")
                    return None
                # 🔴 10/09/2026 — ARGUS THÌ THOÁT NGAY. Hai BỆNH khác nhau trước đây gộp chung một
                #   câu "风控/rỗng": 风控 nghỉ rồi thử lại là qua, còn Argus là THIẾU CHỮ KÝ —
                #   thử lại bao nhiêu cũng vô ích (chính khối "THU HOẠCH BẰNG TRANG" ở client.py đã
                #   ghi vậy sau khi đo 4 đường vòng). Ngồi hết 4+7+10+13 = 34 GIÂY rồi mới bỏ cuộc là
                #   phí trắng, mà `start()` còn phải chạy lại cả lượt bằng trình duyệt. Thoát ngay để
                #   nhường cho đường trình duyệt — đo: 56s → 22s cho 1 video.
                #   Cả buổi 10/09 đi sai hướng cũng vì câu log cũ không phân biệt hai bệnh này.
                if getattr(self.dy_client, "argus_chan", False):
                    utils.logger.error(
                        f"[DouYinCrawler.get_aweme_detail] aweme {aweme_id}: Douyin chan duong HTTP "
                        f"(chu ky Argus HOAC tra RONG) - KHONG phai loi tai khoan/IP. Thu lai vo ich, "
                        f"can chay bang TRINH DUYET.")
                    return None
                if _attempt >= dy_max_retry:
                    utils.logger.error(f"[DouYinCrawler.get_aweme_detail] aweme {aweme_id} rong/风控 sau {dy_max_retry} lan thu")
                    return None
                wait = config.CRAWLER_MAX_SLEEP_SEC + 3 * (_attempt + 1)
                utils.logger.info(f"[DouYinCrawler.get_aweme_detail] aweme {aweme_id} 风控/rong - nghi {wait}s thu lai voi chu ky moi...")
                await asyncio.sleep(wait)
            return None

    async def batch_get_note_comments(self, aweme_list: List[str]) -> None:
        """
        Batch get note comments
        """
        if not config.ENABLE_GET_COMMENTS:
            utils.logger.info(f"[DouYinCrawler.batch_get_note_comments] Crawling comment mode is not enabled")
            return

        task_list: List[Task] = []
        semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)
        for aweme_id in aweme_list:
            task = asyncio.create_task(self.get_comments(aweme_id, semaphore), name=aweme_id)
            task_list.append(task)
        if len(task_list) > 0:
            await asyncio.wait(task_list)

    async def get_comments(self, aweme_id: str, semaphore: asyncio.Semaphore) -> None:
        async with semaphore:
            try:
                # Pass the list of keywords to the get_aweme_all_comments method
                # Use fixed crawling interval
                crawl_interval = config.CRAWLER_MAX_SLEEP_SEC
                await self.dy_client.get_aweme_all_comments(
                    aweme_id=aweme_id,
                    crawl_interval=crawl_interval,
                    is_fetch_sub_comments=config.ENABLE_GET_SUB_COMMENTS,
                    callback=douyin_store.batch_update_dy_aweme_comments,
                    max_count=config.CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES,
                )
                # Sleep after fetching comments
                await asyncio.sleep(crawl_interval)
                utils.logger.info(f"[DouYinCrawler.get_comments] Sleeping for {crawl_interval} seconds after fetching comments for aweme {aweme_id}")
                utils.logger.info(f"[DouYinCrawler.get_comments] aweme_id: {aweme_id} comments have all been obtained and filtered ...")
            except DataFetchError as e:
                utils.logger.error(f"[DouYinCrawler.get_comments] aweme_id: {aweme_id} get comments failed, error: {e}")

    async def get_creators_and_videos(self) -> None:
        """
        Get the information and videos of the specified creator from URLs or IDs
        """
        utils.logger.info("[DouYinCrawler.get_creators_and_videos] Begin get douyin creators")
        utils.logger.info("[DouYinCrawler.get_creators_and_videos] Parsing creator URLs...")

        for creator_url in config.DY_CREATOR_ID_LIST:
            try:
                creator_info_parsed = parse_creator_info_from_url(creator_url)
                user_id = creator_info_parsed.sec_user_id
                utils.logger.info(f"[DouYinCrawler.get_creators_and_videos] Parsed sec_user_id: {user_id} from {creator_url}")
            except ValueError as e:
                utils.logger.error(f"[DouYinCrawler.get_creators_and_videos] Failed to parse creator URL: {e}")
                continue

            # 🔴 PATCH 18/08/2026 (toolcaovideo) — 2 KHÁCH CÙNG BÁO: cào kênh chết ngay đầu với
            # `DataFetchError: account blocked,` (chú ý dấu phẩy rồi TRỐNG = `response.text` RỖNG, đi vào
            # nhánh `response.text == ""` ở client.py:155, KHÔNG phải chuỗi "blocked" ⇒ chữ "account
            # blocked" là CHỮ GÂY HIỂU NHẦM của MediaCrawler gốc, không có nghĩa tài khoản bị khoá).
            # Tái hiện tại chỗ: traceback dừng đúng dòng này — `get_user_info` là lời gọi mạng ĐẦU TIÊN
            # của cào-kênh, nó ném ⇒ CHẾT CẢ LƯỢT trước khi chạm tới video nào.
            # Vô lý ở chỗ: `creator_info` CHỈ dùng để lưu METADATA kênh (`save_creator`) ngay dưới. Danh
            # sách video lấy từ `_collect_user_posts` → `/aweme/v1/web/aweme/post/` — endpoint KHÁC HẲN
            # với `/aweme/v1/web/user/profile/other/` mà hàm này gọi. Tức một lời gọi PHỤ (thông tin kênh,
            # mất cũng không sao) đang giết chặng CHÍNH (tải video).
            # Khớp upstream issue NanmiCoder/MediaCrawler#594: creator mode ném "account blocked" trong
            # khi search/detail vẫn chạy, đổi tài khoản mới + đổi IP + hạ luồng đều KHÔNG hết — issue vẫn
            # ĐANG MỞ, chưa có fix. Nên đây là vá phía mình, không chờ upstream.
            # ⚠ CHƯA KIỂM CHỨNG trên đúng điều kiện của khách (máy dev không tái hiện được response rỗng).
            # Nếu Douyin chặn CẢ endpoint `/aweme/post/` thì lượt cào vẫn chết, chỉ khác là chết ở bước
            # sau với thông báo đúng bản chất hơn — không xấu đi so với hiện tại.
            creator_info: Dict = {}
            try:
                creator_info = await self.dy_client.get_user_info(user_id)
            except Exception as e:
                utils.logger.warning(
                    f"[DouYinCrawler.get_creators_and_videos] Không lấy được THÔNG TIN kênh {user_id} "
                    f"({type(e).__name__}: {str(e)[:120]}) — BỎ QUA bước này và vẫn tải video như thường. "
                    f"(Thông tin kênh chỉ để hiển thị; video lấy từ API khác.)")
            if creator_info:
                await douyin_store.save_creator(user_id, creator=creator_info)

            # Chọn video theo: mới nhất (newest) hoặc nhiều like nhất (most_liked) + số lượng
            sort_mode = os.environ.get("DY_CREATOR_SORT", "newest")
            limit = config.CRAWLER_MAX_NOTES_COUNT
            selected = await self._collect_user_posts(user_id, sort_mode, limit)
            utils.logger.info(f"[DouYinCrawler.get_creators_and_videos] sort={sort_mode}, lấy {len(selected)} video")
            # XEM TRƯỚC (MC_GET_MEDIAS=0): list item ĐÃ có đủ cover/title/like/url → GHI THẲNG, KHỎI fetch detail
            # từng video (get_aweme_detail + sleep chống-bot = CHẬM, khách báo tới 10 phút). Preview chỉ cần
            # cover/title → nhanh hẳn (chỉ tốn thời gian phân trang list). Cào THẬT (tải) vẫn fetch detail đầy đủ.
            if os.environ.get("MC_GET_MEDIAS", "1") == "0":
                for _aw in selected:
                    try:
                        await douyin_store.update_douyin_aweme(aweme_item=_aw)
                    except Exception as _e:
                        utils.logger.warning(f"[get_creators_and_videos] preview ghi list item lỗi: {_e}")
            else:
                await self.fetch_creator_video_detail(selected)

            video_ids = [video_item.get("aweme_id") for video_item in selected]
            await self.batch_get_note_comments(video_ids)

    async def _collect_user_posts(self, sec_user_id: str, sort_mode: str, limit: int) -> List[Dict]:
        """Thu thập danh sách bài của kênh rồi chọn theo mới nhất / nhiều like nhất.
        LỌC THEO NGÀY ĐĂNG: DY_PUBLISH_TIME (1=1 ngày, 7=1 tuần, 180=6 tháng; 0=không lọc) — áp cho
        cào KÊNH bằng create_time (search đã có sẵn filter của Douyin; kênh thì tự lọc ở đây)."""
        import time as _t
        try:
            days = int(os.environ.get("DY_PUBLISH_TIME", "0"))
        except ValueError:
            days = 0
        cutoff = (_t.time() - days * 86400) if days > 0 else 0
        # "ĐUỔI THEO BỘ" (user chốt): từ 1 video "<tên gốc> Tập N", quét kênh tìm MỌI video cùng tên gốc,
        # dừng khi đã thấy Tập 1 (không cần biết tổng số tập trước). DY_CHASE_TITLE = tên gốc (đã tách sẵn
        # từ core gọi vào — xem tach_ten_goc_tap); không giới hạn theo `limit`/pool_cap thường.
        CHASE = os.environ.get("DY_CHASE_SERIES", "0") == "1"
        chase_title = os.environ.get("DY_CHASE_TITLE", "").strip()
        chase_found_tap1 = False
        try:
            CHASE_PAGE_CAP = int(os.environ.get("DY_CHASE_PAGE_CAP", "60") or 60)   # trần an toàn — kênh không có Tập 1 thật (đăng thiếu/xoá) khỏi quét vô hạn
        except ValueError:
            CHASE_PAGE_CAP = 60
        # Lọc ngày → lấy NHIỀU hơn (tới khi quá mốc) rồi mới cắt; most_liked vẫn cần pool để xếp like.
        pool_cap = limit if sort_mode == "newest" else max(limit, 120)
        if cutoff:
            pool_cap = max(pool_cap, 600)
        # "Cào KHÔNG TRÙNG" (đào sâu) cho KÊNH: bỏ video đã tải, gom trang tới khi đủ N video CHƯA tải.
        DEEP = os.environ.get("MC_DEEP_NEW", "0") == "1"
        seen = self._load_seen() if DEEP else set()
        try:
            DEEP_PAGE_CAP = int(os.environ.get("MC_DEEP_PAGE_CAP", "40") or 40)
        except ValueError:
            DEEP_PAGE_CAP = 40
        collected: List[Dict] = []
        max_cursor = ""
        has_more = 1
        pages = 0
        _empty = 0                                        # số trang RỖNG liên tiếp (khoảng-trống/风控 giữa danh sách)
        _rong_dau = 0                                     # số lần THỬ LẠI khi trang ĐẦU rỗng (xem khối 🔴 dưới)
        try:
            _RONG_THU = int(os.environ.get("DY_KENH_RONG_THU", "3") or 3)
        except ValueError:
            _RONG_THU = 3
        while has_more == 1:
            if CHASE:
                if chase_found_tap1 or pages >= CHASE_PAGE_CAP:
                    break
            elif DEEP:
                n_new = sum(1 for a in collected if a.get("aweme_id") not in seen)
                if n_new >= limit or pages >= DEEP_PAGE_CAP:
                    break
            elif len(collected) >= pool_cap:
                break
            _cursor_truoc = max_cursor
            # 🔴 03/09/2026 — GIỮ LẠI những trang ĐÃ lấy được khi một trang giữa chừng lỗi.
            #   Trước đây lời gọi này để TRẦN: Douyin chặn (ArgusSecurityPlugin) ở trang 3 là ngoại lệ
            #   ném thẳng qua `_collect_user_posts` → `get_creators_and_videos` → CHẾT CẢ LƯỢT, vứt sạch
            #   36 video của 2 trang đầu. ĐO THẬT (kênh khách, 3 lượt liên tiếp, xin 40 video):
            #       lượt 1 → 40 video (3 trang trót lọt)   ·   lượt 2 → 0 video   ·   lượt 3 → 0 video
            #   Hai lượt "0 video" ĐỀU đã có 36 video trong tay. Tức phần lớn thiệt hại KHÔNG do bị chặn
            #   mà do cách xử lý lỗi: chặn ở trang N chỉ nên mất TỪ trang N, không mất N-1 trang trước.
            #   Dừng vòng (break) chứ không đi tiếp: đã bị chặn thì trang sau gần như chắc chắn cũng chặn,
            #   cố thêm chỉ tổ ăn thêm rate-limit.
            # THỬ LẠI trước khi bỏ cuộc. ĐO THẬT 03/09/2026 (5 lượt, đường sản phẩm no-browser):
            #   5/5 lần bị Argus chặn đều QUA ở lần thử lại ĐẦU TIÊN, chờ 0s, tốn thêm ~1,2s.
            #   ⇒ Argus chặn theo TỪNG REQUEST, KHÔNG phải cấm cửa một khoảng thời gian. Nên thử lại
            #     NGAY là đúng, và KHÔNG được đặt hạn chờ dài: chờ lâu chỉ làm chậm mà không thêm cơ hội.
            #   3 lần (1 gọi + 2 thử lại), lần 2 chờ 2s phòng khi Douyin siết nhịp trong tương lai.
            #   Trần 3 lần là có chủ ý: thử vô hạn thì một kênh chặn thật sẽ treo lượt cào mãi mãi.
            # ⚠ `_loi = None` là BẮT BUỘC, không phải cho đẹp: `client.request()` trả thẳng
            #   `response.json()`, nên Douyin trả JSON `null` là ra None mà KHÔNG ném lỗi ⇒ vòng dưới
            #   `break` với res=None mà `_loi` CHƯA TỪNG được gán ⇒ `NameError` làm sập cả lượt cào,
            #   mất sạch video đã lấy — đúng cái bản vá này sinh ra để tránh, chui vào bằng cửa khác.
            res, _loi = None, None
            for _lan in range(3):
                try:
                    _r = await self.dy_client.get_user_aweme_posts(sec_user_id, max_cursor)
                    # Phản hồi không phải dict (null / list / chuỗi) thì mọi `res.get(...)` bên dưới sẽ
                    # ném AttributeError ở tận nơi khác. Bắt NGAY đây và coi như một lần lỗi để còn THỬ LẠI.
                    if not isinstance(_r, dict):
                        raise DataFetchError("phản hồi không phải JSON object (%s)" % type(_r).__name__)
                    res = _r
                    if _lan:
                        utils.logger.info(
                            f"[DouYinCrawler._collect_user_posts] trang {pages + 1} qua được ở lần "
                            f"thử lại thứ {_lan}")
                    break
                except Exception as _e:
                    _loi = _e
                    if _lan < 2:
                        await asyncio.sleep(2 * _lan)      # lần 1 thử NGAY (0s) · lần 2 chờ 2s
            if res is None:
                utils.logger.warning(
                    f"[DouYinCrawler._collect_user_posts] trang {pages + 1} LỖI sau 3 lần thử "
                    f"({(type(_loi).__name__ + ': ' + str(_loi)[:110]) if _loi else 'phản hồi rỗng'}) — DỪNG phân trang, "
                    f"GIỮ {len(collected)} video đã lấy được.")
                break
            pages += 1
            has_more = res.get("has_more", 0)
            has_more_goc = has_more          # giữ nguyên để báo cáo đúng (dưới có chỗ đặt lại has_more=1)
            max_cursor = res.get("max_cursor")
            lst = res.get("aweme_list") or []
            if not lst:
                # Douyin trả trang RỖNG nhưng has_more=1 + cursor VẪN TIẾN → "khoảng trống" giữa danh sách (KHÔNG
                # phải hết). ĐI TIẾP cursor MỚI để VƯỢT gap (đo thật: kênh 222 video có 2 trang rỗng ở giữa rồi
                # video trở lại). KHÔNG break ngay (bug cũ kẹt ở 14). Bỏ khi: has_more=0 / cursor kẹt / quá nhiều rỗng.
                _empty += 1
                if has_more == 1 and _empty <= 8 and max_cursor and max_cursor != _cursor_truoc:
                    utils.logger.info(f"[DouYinCrawler._collect_user_posts] trang {pages} RỖNG (gap {_empty}) "
                                      f"→ đi tiếp cursor {str(max_cursor)[:16]}")
                    await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                    continue
                # 🔴 14/09/2026 — TRANG ĐẦU RỖNG: THỬ LẠI, và dù gì cũng PHẢI NÓI RA.
                #   ĐO THẬT (14/09, bấm qua giao diện, 3 kênh Douyin): **2/3 kênh trả 0 video**, trong khi
                #   cào TỪ KHÓA và cào THEO LINK của cùng phiên đều chạy tốt. `save_creator` cho thấy cả
                #   `nickname` cũng None ⇒ Douyin trả RỖNG cho riêng kênh đó tại thời điểm đó.
                #   HAI thiếu sót ở đây, cả hai đều sửa được:
                #   ① KHÔNG THỬ LẠI. Đường TỪ KHÓA ngay cạnh đã có retry và chú thích ở đó ghi rõ:
                #      *“Douyin RẤT hay trả data RỖNG (风控 / giới hạn tần suất) ở lần gọi ĐẦU rồi thành công
                #      khi thử lại”* — mỗi lần gọi tự sinh msToken + a_bogus MỚI nên retry là một chữ ký mới.
                #      Đường KÊNH thì bỏ cuộc ngay từ lần đầu — đúng lớp lỗi “một luật, hai đường, một đường quên”.
                #   ② `break` Ở ĐÂY KHÔNG GHI MỘT DÒNG NÀO ⇒ lượt cào kết thúc “bình thường” với 0 video và
                #      app phải nói “Chưa xác định được nguyên nhân” — vì thật sự không có gì để nói.
                #      Đúng bài học đã ghi: nhánh bỏ-qua phải ĐẾM và GIỮ LÝ DO.
                #   Tắt thử lại: DY_KENH_RONG_THU=0.
                if not collected and _rong_dau < _RONG_THU:
                    _rong_dau += 1
                    max_cursor, has_more, _empty = "", 1, 0      # về đầu danh sách, chữ ký mới
                    _cho = 2 * _rong_dau
                    utils.logger.warning(
                        f"[DouYinCrawler._collect_user_posts] kênh {sec_user_id[:20]}… trả DANH SÁCH RỖNG "
                        f"ở trang đầu (has_more={has_more_goc}) — thử lại {_rong_dau}/{_RONG_THU} sau {_cho}s "
                        f"với chữ ký mới (Douyin hay trả rỗng lần đầu do 风控/giới hạn tần suất).")
                    await asyncio.sleep(_cho)
                    continue
                if not collected:
                    utils.logger.error(
                        f"[DouYinCrawler._collect_user_posts] DOUYIN_KENH_RONG {sec_user_id[:24]}… — Douyin trả "
                        f"0 bài sau {_rong_dau + 1} lần thử (has_more={has_more_goc}, cursor={str(max_cursor)[:14]}). "
                        f"Thường do giới hạn tần suất theo KÊNH hoặc kênh ẩn/không còn bài — KHÔNG phải sai link "
                        f"(link đã tách đúng sec_user_id).")
                    print("LOG:⚠ Kênh này Douyin trả DANH SÁCH RỖNG sau %d lần thử — thường là giới hạn tần "
                          "suất theo KÊNH (cào kênh khác vẫn chạy). Đợi vài phút rồi cào lại chính kênh này."
                          % (_rong_dau + 1), flush=True)
                break
            _empty = 0
            if CHASE:
                # LỌC theo cùng series NGAY khi nhận trang — video khác series bị bỏ, không cộng dồn vô ích.
                lst = [a for a in lst if cung_series(a.get("desc", "") or "", chase_title)]
                if any(tach_ten_goc_tap(a.get("desc", "") or "")[1] == 1 for a in lst):
                    chase_found_tap1 = True
            collected.extend(lst)
            utils.logger.info(f"[DouYinCrawler._collect_user_posts] trang {pages}: +{len(lst)} video, "
                              f"has_more={has_more}, max_cursor={str(max_cursor)[:20]}, tổng={len(collected)}")
            if CHASE:
                await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                continue
            # Posts trả theo MỚI NHẤT trước → gặp bài cũ hơn mốc thì các bài sau cũng cũ → DỪNG sớm.
            if cutoff and min((a.get("create_time", 0) or 0) for a in lst) < cutoff:
                break
            await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
        if CHASE:
            collected.sort(key=lambda a: tach_ten_goc_tap(a.get("desc", "") or "")[1] or 0)
            utils.logger.info(f"[DouYinCrawler._collect_user_posts] Đuổi theo bộ '{chase_title}': "
                              f"tìm được {len(collected)} tập sau {pages} trang"
                              f"{' (đã thấy Tập 1)' if chase_found_tap1 else ' (KHÔNG thấy Tập 1 — có thể đã xoá/đăng thiếu, hoặc kênh quá lớn/CHASE_PAGE_CAP thấp)'}")
            return collected
        if cutoff:
            truoc = len(collected)
            collected = [a for a in collected if (a.get("create_time", 0) or 0) >= cutoff]
            utils.logger.info(f"[DouYinCrawler._collect_user_posts] lọc ngày {days}d: {truoc} → {len(collected)} video")
        if DEEP:   # bỏ video ĐÃ TẢI → chỉ giữ MỚI (đào sâu cho đủ N mới)
            truoc = len(collected)
            collected = [a for a in collected if a.get("aweme_id") not in seen]
            utils.logger.info(f"[DouYinCrawler._collect_user_posts] đào sâu (DEEP): {truoc} → {len(collected)} video CHƯA tải")
        if sort_mode == "most_liked":
            collected.sort(key=lambda a: (a.get("statistics", {}) or {}).get("digg_count", 0), reverse=True)
        return collected[:limit] if limit and limit > 0 else collected

    async def fetch_creator_video_detail(self, video_list: List[Dict]):
        """
        Concurrently obtain the specified post list and save the data
        """
        semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)

        # BUG CŨ (khách cào kênh 5000 → fetch tới video 2835 rồi ra 0 FILE, tool đổ oan "anti-bot"):
        #   1. `_item = await _fut` KHÔNG try/except → 1 video ném lỗi (httpx.ReadTimeout... KHÔNG phải
        #      DataFetchError nên get_aweme_detail không bắt) là THOÁT CẢ HÀM.
        #   2. Vòng lưu/tải nằm SAU vòng fetch → chỉ chạy khi fetch xong 100%. Với 5000 video
        #      (MAX_CONCURRENCY_NUM=1 + sleep 2s ≈ 3,4 GIỜ) mà đứt giữa chừng = VỨT SẠCH công đã làm, 0 file.
        #   3. detail rỗng/风控 → bỏ luôn video, DÙ post_item của API danh sách ĐÃ có sẵn play_addr.
        # ĐO THẬT (2026-07-17, API /aweme/v1/web/aweme/post/): 21/21 item danh sách CÓ url_list tải được
        # → post_item đủ để tải, detail chỉ là bonus. (Chính nhánh preview MC_GET_MEDIAS=0 ở :654 cũng
        # ghi thẳng list item.) Bilibili đã vá đúng khuôn này rồi — xem bilibili/core.py:484-495.
        # FIX: mỗi video xong là LƯU + XẾP TẢI NGAY (lưu-dần như search() :508-517), lỗi 1 video KHÔNG giết
        # cả lô, detail hỏng thì lùi về post_item, và _drain_tai đặt trong `finally` để dù bị hủy/ném lỗi
        # vẫn tải nốt phần đã lấy được.
        async def _lay_1(post_item: Dict):
            """Trả (post_item, detail|None). KHÔNG BAO GIỜ ném — lỗi 1 video là chuyện thường, không phải
            lý do giết cả mẻ vài nghìn video."""
            # VC_NO_DETAIL=1: BỎ get_aweme_detail (1 API call/video) → dùng THẲNG post_item của list API.
            # get_aweme_detail là chỗ bắn REQUEST DÀY NHẤT (100 video = 100 call detail) → dễ 风控/封号
            # nhất. post_item (list /aweme/post/) ĐÃ có url_list/play_addr (ĐO THẬT 21/21 tải được, xem :739)
            # → đủ download + reup. Search mode vốn download thẳng từ list KHÔNG detail (đã chứng minh 45 video).
            # Bỏ detail = giảm ~50% API call → ÍT 风控 hơn + NHANH hơn. Mất metadata phụ (music/stats) mà
            # reup KHÔNG cần. Tắt (mặc định): vẫn lấy detail đầy đủ như cũ.
            if os.environ.get("VC_NO_DETAIL") == "1":
                return post_item, None
            try:
                return post_item, await self.get_aweme_detail(post_item.get("aweme_id"), semaphore)
            except Exception as _e:
                utils.logger.error(
                    f"[DouYinCrawler.fetch_creator_video_detail] aweme {post_item.get('aweme_id')} loi "
                    f"({type(_e).__name__}: {_e}) - BO QUA video nay, KHONG dung ca lo."
                )
                return post_item, None

        task_list = [_lay_1(post_item) for post_item in video_list]

        # LOG TIẾN ĐỘ khi lấy chi tiết TỪNG video (concurrency=1 + sleep chống bot → 100 video mất VÀI PHÚT im
        # lặng ở bước này → khách cào 100 tưởng LỖI/TREO). as_completed thay gather → in mốc mỗi vài video.
        _tong = len(task_list)
        _xong = 0
        _lui_post = 0
        try:
            for _fut in asyncio.as_completed(task_list):
                _post, _item = await _fut
                _xong += 1
                if _xong == 1 or _xong % 5 == 0 or _xong == _tong:
                    utils.logger.info(f"[DouYinCrawler.fetch_creator_video_detail] Đang lấy chi tiết video {_xong}/{_tong}...")
                # detail hỏng → dùng post_item (đã có play_addr) thay vì mất trắng video.
                _aw = _item if _item is not None else _post
                if _item is None and _post:
                    _lui_post += 1
                if not _aw:
                    continue
                await douyin_store.update_douyin_aweme(aweme_item=_aw)
                self._tai_nen(self.get_aweme_media, _aw)   # tải NỀN song song (deep đã đếm ở _collect_user_posts)
        finally:
            if _lui_post:
                utils.logger.info(
                    f"[DouYinCrawler.fetch_creator_video_detail] {_lui_post}/{_tong} video khong lay duoc chi tiet "
                    f"-> DUNG data tu danh sach kenh (van tai duoc)."
                )
            await self._drain_tai()

    async def create_douyin_client(self, httpx_proxy: Optional[str]) -> DouYinClient:
        """Create douyin client"""
        cookie_str, cookie_dict = await utils.convert_browser_context_cookies(
            self.browser_context,
            urls=self.cookie_urls,
        )  # type: ignore
        douyin_client = DouYinClient(
            proxy=httpx_proxy,
            headers={
                "User-Agent": await self.context_page.evaluate("() => navigator.userAgent"),
                "Cookie": cookie_str,
                "Host": "www.douyin.com",
                "Origin": "https://www.douyin.com/",
                "Referer": "https://www.douyin.com/",
                "Content-Type": "application/json;charset=UTF-8",
            },
            playwright_page=self.context_page,
            cookie_dict=cookie_dict,
            proxy_ip_pool=self.ip_proxy_pool,  # Pass proxy pool for automatic refresh
        )
        return douyin_client

    def _create_douyin_client_no_browser(self, httpx_proxy: Optional[str]) -> DouYinClient:
        """Tạo DouYinClient KHÔNG mở browser: cookie giải mã trực tiếp từ profile Chromium (DPAPI v10 +
        AES-GCM) qua cookie_decrypt; ký a_bogus qua execjs (libs/douyin.js). Tránh fingerprint Playwright
        headless → douyin anti-bot không flag 'nhiều phiên lạ liên tiếp' khi cào nhiều (giống bili no-browser)."""
        import sys as _sys
        _root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        import cookie_decrypt
        ua = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        udd = os.path.join(
            os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join(os.getcwd(), "browser_data"),
            config.USER_DATA_DIR % config.PLATFORM,
        )
        cookie_str = cookie_decrypt.cookie_header(udd, "douyin.com")
        cookie_dict = {}
        for _part in cookie_str.split("; "):
            if "=" in _part:
                _k, _v = _part.split("=", 1)
                cookie_dict[_k] = _v
        if cookie_str:
            utils.logger.info("[DouYinCrawler] no-browser: đọc %d cookie từ profile (httpx thuần, a_bogus execjs)" % len(cookie_dict))
        else:
            utils.logger.warning("[DouYinCrawler] no-browser: KHÔNG đọc được cookie douyin (chưa đăng nhập?)")
        return DouYinClient(
            proxy=httpx_proxy,
            headers={
                "User-Agent": ua,
                "Cookie": cookie_str,
                "Host": "www.douyin.com",
                "Origin": "https://www.douyin.com/",
                "Referer": "https://www.douyin.com/",
                "Content-Type": "application/json;charset=UTF-8",
            },
            playwright_page=None,
            cookie_dict=cookie_dict,
            proxy_ip_pool=self.ip_proxy_pool,
        )

    async def launch_browser(
        self,
        chromium: BrowserType,
        playwright_proxy: Optional[Dict],
        user_agent: Optional[str],
        headless: bool = True,
    ) -> BrowserContext:
        """Launch browser and create browser context"""
        # 🔴 10/09/2026 — HEADFUL NHƯNG VÔ HÌNH. Nhánh leo vì Argus buộc phải chạy có giao diện
        #   (headless bị Douyin đá `/video/<id>` về `/jingxuan` — đo trên máy khách). Nhưng bật một
        #   cửa sổ Chromium giữa lượt Automation chạy đêm thì khách hoảng, mà bấm nhầm vào là hỏng
        #   lượt cào. `--window-position` âm đẩy nó ra ngoài vùng nhìn thấy: tiến trình vẫn là
        #   Chrome ĐẦY ĐỦ (không phải `chrome-headless-shell` — thứ Douyin nhận ra), chỉ là không
        #   ai thấy. KHÔNG dùng `--headless=new`: chưa đo được nó có qua được cú đá hay không.
        #   Chỉ bật khi `_an_cua_so` — lượt cào thường và lúc quét QR đăng nhập KHÔNG bị đụng.
        # 🔴 10/09/2026 — VÔ HÌNH MÀ KHÔNG BỊ NHẬN RA. Chủ dự án: *"tải được rồi nhưng mất headless"*.
        #   Thứ Douyin nhận ra KHÔNG phải "headless" nói chung mà là **`chrome-headless-shell`** —
        #   binary riêng, thiếu hàng loạt API của Chrome thật. `--headless=new` chạy CHÍNH Chrome đầy
        #   đủ ở chế độ không vẽ cửa sổ ⇒ vô hình hoàn toàn mà vân tay vẫn như Chrome bình thường.
        #   Playwright `headless=True` mới là thứ gọi `chrome-headless-shell`, nên phải giữ
        #   `config.HEADLESS = False` rồi tự truyền cờ.
        #   ĐƯỜNG LUI: đặt env `VC_DY_CUA_SO=1` ⇒ quay về cửa sổ thật đẩy ra ngoài màn hình (cách đã
        #   ĐO LÀ CHẠY ĐƯỢC trên máy khách). Để env chứ không phải bản vá mới, phòng khi Douyin
        #   siết tiếp thì khách chỉ đổi một biến.
        _args = None
        if getattr(self, "_an_cua_so", False) and not headless:
            _args = (["--window-position=-32000,-32000"]
                     if os.environ.get("VC_DY_CUA_SO") == "1" else ["--headless=new"])
        if config.SAVE_LOGIN_STATE:
            user_data_dir = os.path.join(os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join(os.getcwd(), "browser_data"), config.USER_DATA_DIR % config.PLATFORM)  # type: ignore
            browser_context = await chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                accept_downloads=True,
                headless=headless,
                proxy=playwright_proxy,  # type: ignore
                viewport={
                    "width": 1920,
                    "height": 1080
                },
                user_agent=user_agent,
                args=_args,
            )  # type: ignore
            return browser_context
        else:
            browser = await chromium.launch(headless=headless, proxy=playwright_proxy)  # type: ignore
            browser_context = await browser.new_context(viewport={"width": 1920, "height": 1080}, user_agent=user_agent)
            return browser_context

    async def launch_browser_with_cdp(
        self,
        playwright: Playwright,
        playwright_proxy: Optional[Dict],
        user_agent: Optional[str],
        headless: bool = True,
    ) -> BrowserContext:
        """
        使用CDP模式启动浏览器
        """
        try:
            self.cdp_manager = CDPBrowserManager()
            browser_context = await self.cdp_manager.launch_and_connect(
                playwright=playwright,
                playwright_proxy=playwright_proxy,
                user_agent=user_agent,
                headless=headless,
            )

            # Add anti-detection script
            await self.cdp_manager.add_stealth_script()

            # Show browser information
            browser_info = await self.cdp_manager.get_browser_info()
            utils.logger.info(f"[DouYinCrawler] CDP浏览器信息: {browser_info}")

            return browser_context

        except Exception as e:
            utils.logger.error(f"[DouYinCrawler] CDP模式启动失败，回退到标准模式: {e}")
            # Fall back to standard mode
            chromium = playwright.chromium
            return await self.launch_browser(chromium, playwright_proxy, user_agent, headless)

    async def close(self) -> None:
        """Close browser context"""
        # If you use CDP mode, special processing is required
        if self.cdp_manager:
            await self.cdp_manager.cleanup()
            self.cdp_manager = None
        else:
            await self.browser_context.close()
        utils.logger.info("[DouYinCrawler.close] Browser context closed ...")

    async def get_aweme_media(self, aweme_item: Dict):
        """
        获取抖音媒体，自动判断媒体类型是短视频还是帖子图片并下载

        Args:
            aweme_item (Dict): 抖音作品详情
        """
        if not config.ENABLE_GET_MEIDAS:
            utils.logger.info(f"[DouYinCrawler.get_aweme_media] Crawling image mode is not enabled")
            return
        # List of note urls. If it is a short video type, an empty list will be returned.
        note_download_url: List[str] = douyin_store._extract_note_image_list(aweme_item)
        # The video URL will always exist, but when it is a short video type, the file is actually an audio file.
        video_download_url: str = douyin_store._extract_video_download_url(aweme_item)
        # TODO: Douyin does not adopt the audio and video separation strategy, so the audio can be separated from the original video and will not be extracted for the time being.
        # ƯU TIÊN VIDEO: _extract_video_download_url trả "" cho post ẢNH thuần (không có video.play_addr),
        # nên có video_download_url = CHẮC CHẮN có video thật. Nếu check note-ảnh TRƯỚC, post vừa-video-vừa-kèm-ảnh
        # sẽ tải nhầm ẢNH -> render LỖI (preview _item_dy gắn "video" theo video_download_url -> hiện là video ->
        # user chọn -> tải ra ảnh). Check video_download_url trước cho KHỚP _item_dy.
        if video_download_url:
            await self.get_aweme_video(aweme_item)
        elif note_download_url:
            await self.get_aweme_images(aweme_item)

    async def get_aweme_images(self, aweme_item: Dict):
        """
        get aweme images. please use get_aweme_media

        Args:
            aweme_item (Dict): 抖音作品详情
        """
        if not config.ENABLE_GET_MEIDAS:
            return
        aweme_id = aweme_item.get("aweme_id")
        # List of note urls. If it is a short video type, an empty list will be returned.
        note_download_url: List[str] = douyin_store._extract_note_image_list(aweme_item)

        if not note_download_url:
            return
        sub_dir, file_base = await _media_path_parts(aweme_item)
        img_sub_dir = f"{sub_dir}/{file_base}"  # mỗi bài ảnh 1 thư mục riêng
        picNum = 0
        for url in note_download_url:
            if not url:
                continue
            content = await self.dy_client.get_aweme_media(url)
            await asyncio.sleep(random.random())
            if content is None:
                continue
            extension_file_name = f"{picNum:>03d}.jpeg"
            picNum += 1
            await douyin_store.update_dy_aweme_image(aweme_id, content, extension_file_name, sub_dir=img_sub_dir)

    async def get_aweme_video(self, aweme_item: Dict):
        """
        get aweme videos. please use get_aweme_media

        Args:
            aweme_item (Dict): 抖音作品详情
        """
        if not config.ENABLE_GET_MEIDAS:
            return
        aweme_id = aweme_item.get("aweme_id")

        # Danh sách link tải dự phòng (nhiều CDN) — thử lần lượt nếu 1 link bị 403/lỗi
        url_candidates: List[str] = douyin_store._extract_video_download_url_list(aweme_item)
        if not url_candidates:
            one = douyin_store._extract_video_download_url(aweme_item)
            url_candidates = [one] if one else []
        if not url_candidates:
            return
        sub_dir, file_base = await _media_path_parts(aweme_item)
        # Bỏ qua nếu đã tải rồi: theo SỔ LEDGER (id) hoặc file còn tồn tại.
        # Ledger giúp không tải lại kể cả khi video gốc đã bị xóa sau khi rerender.
        base_videos = f"{config.SAVE_DATA_PATH}/douyin/videos" if config.SAVE_DATA_PATH else "data/douyin/videos"
        target_dir = os.path.join(base_videos, *sub_dir.split("/"))
        # DEDUP file CHỈ khớp FULL aweme_id (*_<full id>.mp4) — duy nhất, HẾT trùng-nhầm. BỎ fallback 6-số (nó
        # khớp NHẦM 2 video khác cùng 6-số-cuối → mất video). Chống-trùng video CŨ (tên 6-số, tải trước bản vá)
        # do LEDGER _load_seen lo (theo FULL id, nguồn chân lý) → an toàn, tối đa chỉ tải lại 1 lần rồi ledger chặn.
        da_co_file = aweme_id and glob.glob(os.path.join(target_dir, f"*_{aweme_id}.mp4"))
        # "Cào đã chọn" (CRAWLER_TYPE=detail) = user CHỦ ĐỘNG chọn video -> CHỈ bỏ qua nếu file gốc CÒN tồn
        # tại; file đã bị xóa/rerender thì TẢI LẠI (đừng để sổ ledger chặn lựa chọn của user → "tải không
        # được" oan). Cào TỰ ĐỘNG (search/creator/userlist) vẫn dùng ledger để không ôm lại video cũ.
        la_chon_tay = getattr(config, "CRAWLER_TYPE", "") == "detail"
        da_bo_qua = bool(da_co_file) if la_chon_tay else (aweme_id in self._load_seen() or bool(da_co_file))
        if aweme_id and da_bo_qua:
            utils.logger.info(f"[DouYinCrawler.get_aweme_video] Đã tải trước đó, bỏ qua {aweme_id}")
            self._mark_seen(aweme_id)
            return
        content = None
        # 🔴 03/09/2026 — VÒNG NÀY TRƯỚC ĐÂY CHỈ ĐỔI LINK KHI `content is None`. Bản KHOÁ BẢN QUYỀN
        #   tải về THÀNH CÔNG (đủ byte, không lỗi mạng) nên nó nhận luôn link ĐẦU rồi dừng — dù
        #   `url_candidates` còn nhiều CDN khác có thể trả bản thường. Hậu quả đo được: 27/258 video
        #   của chủ dự án là bản khoá, ghi ra đĩa + VÀO SỔ `_da_tai_ids.txt` ⇒ chặn tải lại VĨNH VIỄN,
        #   không một dòng lỗi nào ném ra, khách chỉ thấy ô đen.
        _so_khoa = 0
        for i, url in enumerate(url_candidates):
            content = await self.dy_client.get_aweme_media(url)
            if content is not None and _la_ban_khoa(content):
                _so_khoa += 1
                utils.logger.info(
                    f"[DouYinCrawler.get_aweme_video] link {i+1}/{len(url_candidates)} trả bản KHOÁ "
                    f"BẢN QUYỀN (DRM/CENC) cho {aweme_id} — bỏ, thử CDN khác...")
                content = None
                await asyncio.sleep(0.5)
                continue
            if content is not None:
                break
            utils.logger.info(f"[DouYinCrawler.get_aweme_video] link {i+1}/{len(url_candidates)} lỗi, thử link khác...")
            await asyncio.sleep(0.5)
        await asyncio.sleep(random.random())
        if content is None:
            if _so_khoa:
                # KHÔNG lưu file, KHÔNG `_mark_seen` ⇒ lần cào sau còn thử lại (Douyin có thể mở khoá
                # hoặc gear khác trả bản thường). Ghi rác + ghi sổ mới là thứ không cứu lại được.
                utils.logger.error(
                    f"[DouYinCrawler.get_aweme_video] {aweme_id}: TẤT CẢ {_so_khoa} link đều trả bản "
                    f"KHOÁ BẢN QUYỀN (DRM) — Douyin chặn tải video này. Không lưu, không ghi sổ.")
            else:
                utils.logger.error(f"[DouYinCrawler.get_aweme_video] Tải thất bại tất cả link cho {aweme_id} (sẽ thử lại lần sau)")
            return
        extension_file_name = f"{file_base}.mp4"
        await douyin_store.update_dy_aweme_video(aweme_id, content, extension_file_name, sub_dir=sub_dir)
        self._mark_seen(aweme_id)
        self._ghi_video_moi(aweme_item, sub_dir, file_base)
