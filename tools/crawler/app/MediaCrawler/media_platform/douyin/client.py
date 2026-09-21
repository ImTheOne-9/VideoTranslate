# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/douyin/client.py
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
import copy
import json
import os
import urllib.parse
from typing import TYPE_CHECKING, Any, Callable, Dict, Union, Optional

import httpx
from playwright.async_api import BrowserContext

from base.base_crawler import AbstractApiClient
from proxy.proxy_mixin import ProxyRefreshMixin
from tools import utils
from tools.httpx_util import make_async_client
from tools.tien_do_tai import TienDo as _TienDo   # tiến độ tải video (19/08/2026) — xem file đó
from var import request_keyword_var

if TYPE_CHECKING:
    from proxy.proxy_ip_pool import ProxyIpPool

from .exception import *
from .field import *
from .help import *


def _gen_ms_token(length: int = 107) -> str:
    """Sinh msToken ngẫu nhiên cho chế độ NO-BROWSER (không có localStorage['xmst']). a_bogus mới là chữ
    ký chống bot chính; msToken phụ — random độ dài chuẩn (107) đủ cho web API douyin."""
    import random as _r
    import string as _s
    alphabet = _s.ascii_letters + _s.digits + "-_"
    return "".join(_r.choice(alphabet) for _ in range(length))


class DouYinClient(AbstractApiClient, ProxyRefreshMixin):

    def __init__(
        self,
        timeout=60,  # If the crawl media option is turned on, Douyin’s short videos will require a longer timeout.
        proxy=None,
        *,
        headers: Dict,
        playwright_page: Optional[Page],
        cookie_dict: Dict,
        proxy_ip_pool: Optional["ProxyIpPool"] = None,
    ):
        self.proxy = proxy
        self.timeout = timeout
        self.headers = headers
        self._host = "https://www.douyin.com"
        self.cookie_urls = [
            "https://douyin.com",
            self._host,
            "https://creator.douyin.com",
            "https://douhot.douyin.com",
            "https://live.douyin.com",
        ]
        self.playwright_page = playwright_page
        self.cookie_dict = cookie_dict
        # Initialize proxy pool (from ProxyRefreshMixin)
        self.init_proxy_pool(proxy_ip_pool)

    async def __process_req_params(
        self,
        uri: str,
        params: Optional[Dict] = None,
        headers: Optional[Dict] = None,
        request_method="GET",
    ):

        if not params:
            return
        headers = headers or self.headers
        # NO-BROWSER (playwright_page=None): msToken sinh ngẫu nhiên (a_bogus mới là chữ ký chính, msToken
        # phụ); browser mode cũ: lấy từ localStorage['xmst'].
        if self.playwright_page is not None:
            local_storage: Dict = await self.playwright_page.evaluate("() => window.localStorage")  # type: ignore
            ms_token = local_storage.get("xmst")
        else:
            ms_token = self.cookie_dict.get("msToken") or _gen_ms_token()
        common_params = {
            "device_platform": "webapp",
            "aid": "6383",
            "channel": "channel_pc_web",
            "version_code": "190600",
            "version_name": "19.6.0",
            "update_version_code": "170400",
            "pc_client_type": "1",
            "cookie_enabled": "true",
            "browser_language": "zh-CN",
            "browser_platform": "MacIntel",
            "browser_name": "Chrome",
            "browser_version": "125.0.0.0",
            "browser_online": "true",
            "engine_name": "Blink",
            "os_name": "Mac OS",
            "os_version": "10.15.7",
            "cpu_core_num": "8",
            "device_memory": "8",
            "engine_version": "109.0",
            "platform": "PC",
            "screen_width": "2560",
            "screen_height": "1440",
            'effective_type': '4g',
            "round_trip_time": "50",
            "webid": get_web_id(),
            "msToken": ms_token,
        }
        # 🔴 uifid (03/09/2026) — ArgusSecurityPlugin của Douyin NAY ĐÒI giá trị này. Thiếu thì API trả
        #   `Blocked by ArgusSecurityPlugin Uifid Not Found` (log khách 02/09: cào creator lấy được
        #   trang 1 = 18 video rồi chết; KHÔNG phải hết phiên đăng nhập — app đã tự xác minh dy vẫn "in").
        #   ĐO THẬT (bắt request của chính trình duyệt trên douyin.com, không suy đoán):
        #     · Douyin gửi ở CẢ HAI chỗ: request header `uifid` VÀ query param `uifid`, giá trị y hệt.
        #     · KHÔNG nằm trong Cookie header (đã kiểm: cookie header không chứa UIFID).
        #     · Giá trị = cookie `UIFID` (phiên đã đăng nhập) hoặc `UIFID_TEMP` (ẩn danh) — 160 ký tự,
        #       so trong CÙNG một phiên thì khớp NGUYÊN VĂN ⇒ đọc thẳng từ cookie được, KHÔNG phải JS tính.
        #   ⚠ PHẢI chèn vào `params` TRƯỚC khi dựng `query_string`: `a_bogus` ký lên chính chuỗi đó —
        #     thêm sau chữ ký thì chữ ký sai, hỏng theo kiểu khác còn khó lần hơn.
        #   ⚠ Không có cookie thì BỎ QUA, đừng gửi `uifid=` rỗng: thà để Douyin báo thiếu (thông điệp rõ)
        #     còn hơn gửi giá trị rỗng rồi bị chặn với lý do khác.
        _uifid = (self.cookie_dict.get("UIFID") or self.cookie_dict.get("UIFID_TEMP") or "").strip()
        if _uifid:
            common_params["uifid"] = _uifid
            headers["uifid"] = _uifid
            self.headers["uifid"] = _uifid
        # verifyFp / fp — CÙNG một giá trị, và ĐO ĐƯỢC là bằng ĐÚNG cookie `s_v_web_id` (52 ký tự, khớp
        # nguyên văn trong cùng một phiên). Fork trước nay KHÔNG gửi cả hai (grep = 0). Douyin dùng chúng
        # làm dấu vân tay phiên; thiếu thì Argus xếp vào nhóm request không ký.
        _vfp = (self.cookie_dict.get("s_v_web_id") or "").strip()
        if _vfp:
            common_params["verifyFp"] = _vfp
            common_params["fp"] = _vfp
        params.update(common_params)
        query_string = urllib.parse.urlencode(params)

        # 20240927 a-bogus update (JS version)
        post_data = {}
        if request_method == "POST":
            post_data = params

        if "/v1/web/general/search" not in uri:
            a_bogus = await get_a_bogus(uri, query_string, post_data, headers["User-Agent"], self.playwright_page)
            params["a_bogus"] = a_bogus

    async def request(self, method, url, **kwargs):
        # BUG CŨ: lời gọi mạng nằm NGOÀI try (chỉ bọc response.json()) → httpx.ReadTimeout/ConnectError/
        # RemoteProtocolError (rất hay gặp khi cào vài nghìn video liên tiếp: douyin rớt kết nối/chậm) thoát
        # RA NGUYÊN DẠNG. get_aweme_detail chỉ bắt DataFetchError/KeyError nên KHÔNG bắt được → lỗi lan lên
        # tận asyncio.run → CHẾT CẢ TIẾN TRÌNH CÀO giữa chừng (khách cào 5000 mất trắng ở video 2835).
        # FIX: gói lỗi mạng thành DataFetchError → rơi đúng vào vòng retry-chữ-ký-mới đã có sẵn ở
        # get_aweme_detail/search (DY_SEARCH_RETRY), thay vì giết cả lô.
        try:
            # Check whether the proxy has expired before each request
            await self._refresh_proxy_if_expired()

            async with make_async_client(proxy=self.proxy) as client:
                response = await client.request(method, url, timeout=self.timeout, **kwargs)
        except Exception as e:
            raise DataFetchError(f"loi mang/ky: {type(e).__name__}: {e}")
        try:
            if response.text == "" or response.text == "blocked":
                utils.logger.error(f"request params incrr, response.text: {response.text}")
                raise Exception("account blocked")
            return response.json()
        except Exception as e:
            # 🔴 10/09/2026 — GHI NHẬN Argus. `request()` gói MỌI lỗi thành DataFetchError nên tầng
            #   trên không phân biệt nổi "mạng lỗi" với "Douyin đòi chữ ký mới". Cắm cờ ở đây để
            #   `core.start()` biết mà LEO sang trình duyệt thay vì thử lại 4 lần rồi bỏ cuộc.
            #   🔴 10/09/2026 (lượt 3) — ĐỪNG NEO VÀO CHUỖI CHỮ CỦA ĐỐI PHƯƠNG. Bản vá sáng nay
            #   chỉ cắm cờ khi thân chứa "ArgusSecurityPlugin"; chiều Douyin đổi sang trả
            #   HTTP 200 · content-length: 0 · thân RỖNG TUYỆT ĐỐI (đo trên máy dev, 2/2 id,
            #   server Tengine, 0 set-cookie) ⇒ cờ không bật ⇒ không leo sang trình duyệt ⇒ 0
            #   video, ĐÚNG LẠI triệu chứng cũ. Cùng MỘT bệnh, chỉ khác lời nhắn.
            #   LUẬT ĐÚNG: tới đây là ĐÃ CÓ phản hồi HTTP mà DÙNG KHÔNG ĐƯỢC (rỗng / "blocked" /
            #   không phải JSON) ⇒ đường httpx thuần bó tay, phải để TRANG đi lấy. Lỗi MẠNG không
            #   rơi vào đây (khối trên đã ném DataFetchError "loi mang/ky:") nên không leo oan.
            self.argus_chan = True
            raise DataFetchError(f"{e}, {response.text}")

    async def get(self, uri: str, params: Optional[Dict] = None, headers: Optional[Dict] = None):
        """
        GET请求
        """
        await self.__process_req_params(uri, params, headers)
        headers = headers or self.headers
        return await self.request(method="GET", url=f"{self._host}{uri}", params=params, headers=headers)

    async def post(self, uri: str, data: dict, headers: Optional[Dict] = None):
        await self.__process_req_params(uri, data, headers)
        headers = headers or self.headers
        return await self.request(method="POST", url=f"{self._host}{uri}", data=data, headers=headers)

    async def pong(self, browser_context: BrowserContext = None) -> bool:
        # NO-BROWSER (playwright_page=None): phiên xác định qua cookie sessionid (đã decrypt từ đĩa). Hết hạn
        # thì server từ chối → crawl ra 0, fail gọn (không treo). LOGIN_STATUS/HasUserLogin chỉ có khi browser.
        if self.playwright_page is None:
            return bool(self.cookie_dict.get("sessionid") or self.cookie_dict.get("sessionid_ss"))
        local_storage = await self.playwright_page.evaluate("() => window.localStorage")
        if local_storage.get("HasUserLogin", "") == "1":
            return True

        _, cookie_dict = await utils.convert_browser_context_cookies(
            browser_context,
            urls=self.cookie_urls,
        )
        return cookie_dict.get("LOGIN_STATUS") == "1"

    async def update_cookies(self, browser_context: BrowserContext, urls: Optional[list[str]] = None):
        cookie_str, cookie_dict = await utils.convert_browser_context_cookies(
            browser_context,
            urls=urls or self.cookie_urls,
        )
        self.headers["Cookie"] = cookie_str
        self.cookie_dict = cookie_dict

    async def search_info_by_keyword(
        self,
        keyword: str,
        offset: int = 0,
        search_channel: SearchChannelType = SearchChannelType.GENERAL,
        sort_type: SearchSortType = SearchSortType.GENERAL,
        publish_time: PublishTimeType = PublishTimeType.UNLIMITED,
        search_id: str = "",
    ):
        """
        DouYin Web Search API
        :param keyword:
        :param offset:
        :param search_channel:
        :param sort_type:
        :param publish_time: ·
        :param search_id: ·
        :return:
        """
        query_params = {
            'search_channel': search_channel.value,
            'enable_history': '1',
            'keyword': keyword,
            'search_source': 'tab_search',
            'query_correct_type': '1',
            'is_filter_search': '0',
            'from_group_id': '7378810571505847586',
            'offset': offset,
            'count': '15',
            'need_filter_settings': '1',
            'list_type': 'multi',
            'search_id': search_id,
        }
        if sort_type.value != SearchSortType.GENERAL.value or publish_time.value != PublishTimeType.UNLIMITED.value:
            query_params["filter_selected"] = json.dumps({"sort_type": str(sort_type.value), "publish_time": str(publish_time.value)})
            query_params["is_filter_search"] = 1
            query_params["search_source"] = "tab_search"
        referer_url = f"https://www.douyin.com/search/{keyword}?aid=f594bbd9-a0e2-4651-9319-ebe3cb6298c1&type=general"
        headers = copy.copy(self.headers)
        headers["Referer"] = urllib.parse.quote(referer_url, safe=':/')
        return await self.get("/aweme/v1/web/general/search/single/", query_params, headers=headers)

    async def get_video_by_id(self, aweme_id: str) -> Any:
        """
        DouYin Video Detail API
        :param aweme_id:
        :return:
        """
        params = {"aweme_id": aweme_id}
        headers = copy.copy(self.headers)
        del headers["Origin"]
        try:
            res = await self.get("/aweme/v1/web/aweme/detail/", params, headers)
        except Exception as e:
            # 🔴 10/09/2026 — Douyin MỞ RỘNG Argus sang `/aweme/detail/` (trước chỉ `/aweme/post/`).
            #   Ca thật khách pvluo: 4/4 lần `Blocked by ArgusSecurityPlugin Signature Not Found`,
            #   0 video, TRONG KHI cookie đủ (4472 ký tự, có sessionid) và a_bogus + msToken đều CÓ.
            #   Dùng LẠI đúng lời giải đã có cho `/aweme/post/` (khối "THU HOẠCH BẰNG TRANG" bên dưới):
            #   để CHÍNH TRANG phát request rồi hứng phản hồi. 4 đường vòng khác đã ĐO và CHẾT —
            #   đừng thử lại (phát lại URL / fetch / XHR / phát lại nguyên văn trong page).
            #   Chỉ lùi khi ĐÚNG Argus và CÓ trang; lỗi mạng vẫn ném như cũ, kẻo che mất sự cố thật.
            # ⚠ 10/09 lượt 3: cổng này TỪNG neo `"ArgusSecurityPlugin" in str(e)` — Douyin đổi
            #   sang trả thân RỖNG là câm ngay. Nay dùng CHUNG cờ với `request()` (xem chú thích
            #   ở đó): cứ "có phản hồi mà dùng không được" + CÓ trang thì lấy qua trang.
            if getattr(self, "argus_chan", False) and self.playwright_page is not None:
                utils.logger.warning(
                    "[DouYinClient.get_video_by_id] Douyin chặn HTTP (Argus / trả RỖNG) → LẤY CHI TIẾT "
                    "QUA TRANG. Chậm hơn nhưng không mất video.")
                res = await self._thd_lay(aweme_id)
            else:
                raise
        return res.get("aweme_detail", {})

    # ── HỨNG CHI TIẾT BẰNG TRANG (10/09/2026) — song sinh với `_th_trang` của /aweme/post/ ──────
    _thd_hang = None       # asyncio.Queue chứa phản hồi detail hứng được
    _thd_gan = False       # đã gắn bộ hứng chưa (gắn 2 lần ⇒ mỗi phản hồi vào hàng nhiều lần)
    _trang_khoa = None     # asyncio.Lock: CHỈ MỘT thao tác trang tại một thời điểm (xem `_thd_lay`)

    async def _thd_lay(self, aweme_id: str) -> Dict:
        """Mở trang video rồi hứng phản hồi `/aweme/detail/` do CHÍNH TRANG phát ra.

        🔴 15/09/2026 — PHẢI KHOÁ. `get_specified_awemes` chạy các link SONG SONG
        (`asyncio.gather` + `Semaphore(MAX_CONCURRENCY_NUM=2)`), mà cả lượt chỉ có MỘT
        `playwright_page`. Hai `pg.goto` chồng nhau ⇒ cú sau HUỶ cú trước ⇒
        `Page.goto: net::ERR_ABORTED` ⇒ `gather` không bắt ⇒ **chết cả lượt, mất sạch link**.
        ĐO THẬT (khách dán 8 link `/user/...?modal_id=`, và tôi tái hiện với 2 link):
        1 link chạy ngon, 2 link là nổ — vì 1 link thì không có cú goto thứ hai.
        Khoá là CÙNG MỘT cái với `_thmix_lay`: chúng dùng CHUNG một trang, không phải hai."""
        if self._trang_khoa is None:
            self._trang_khoa = asyncio.Lock()
        async with self._trang_khoa:
            return await self._thd_lay_trong(aweme_id)

    async def _thd_lay_trong(self, aweme_id: str) -> Dict:
        """Thân thật của `_thd_lay` — LUÔN gọi khi đang giữ `_trang_khoa`."""
        pg = self.playwright_page
        if self._thd_hang is None:
            self._thd_hang = asyncio.Queue()
        if not self._thd_gan:
            async def _hung(resp):
                if "/aweme/v1/web/aweme/detail/" not in resp.url:
                    return
                try:
                    d = await resp.json()
                except Exception:
                    return          # 403/HTML/thân đã mất — bỏ qua, vòng chờ sẽ thử tiếp
                if isinstance(d, dict) and d.get("aweme_detail"):
                    self._thd_hang.put_nowait(d)

            pg.on("response", _hung)
            self._thd_gan = True
        while not self._thd_hang.empty():      # dọn phản hồi của video TRƯỚC
            self._thd_hang.get_nowait()
        await pg.goto("https://www.douyin.com/video/" + aweme_id,
                      wait_until="domcontentloaded", timeout=60000)
        # 20 vòng × 1,2s = 24s: trang phải tải xong JS mới phát request chi tiết. Hết vòng thì trả
        # {} chứ KHÔNG ném — `get_aweme_detail` còn vòng retry riêng, ném ở đây là cắt mất nó.
        for _ in range(20):
            if not self._thd_hang.empty():
                return self._thd_hang.get_nowait()
            await asyncio.sleep(1.2)
        # Thất bại CÂM là thứ làm cả buổi 10/09 đi sai hướng — nên nói RÕ trang cuối cùng là gì.
        # Douyin đá `/video/<id>` sang `/jingxuan` (trang feed) khi nó nghi trình duyệt tự động:
        # URL cuối mất `aweme_id` chính là dấu hiệu đó, và cách chữa đã đo được là đổi kiểu cửa sổ.
        _u = ""
        try:
            _u = pg.url or ""
        except Exception:
            pass
        if aweme_id not in _u:
            utils.logger.warning(
                "[DouYinClient._thd_lay] Douyin ĐÁ trang video sang %s (không phải trang video) nên "
                "không có dữ liệu để hứng. Cách chữa: đặt biến môi trường VC_DY_CUA_SO=1 rồi chạy "
                "lại — nó mở cửa sổ Chrome thật (đẩy ra ngoài màn hình) thay cho headless." % _u[:60])
        else:
            utils.logger.warning("[DouYinClient._thd_lay] mở trang video %s mà không hứng được phản hồi "
                                 "chi tiết sau 24s (trang mở đúng nhưng không phát API)" % aweme_id)
        return {}

    async def get_mix_aweme_list(self, mix_id: str, cursor: int = 0, count: int = 20, seed_aweme_id: str = "") -> Dict:
        """🔴 (24/08) 合集 (hợp tuyển/mix) CHÍNH THỨC — lấy danh sách video trong 1 BỘ theo mix_id (phân trang
        `cursor`). Tin cậy hơn ĐOÁN tiêu đề (giống Bilibili ugc_season / TikTok collection). Endpoint web
        Douyin. Response: {aweme_list:[...], cursor, has_more}. `self.get` tự ký a_bogus như các API khác."""
        uri = "/aweme/v1/web/mix/aweme/"
        params = {"mix_id": mix_id, "cursor": cursor, "count": count}
        try:
            return await self.get(uri, params)
        except Exception:
            # 🔴 14/09/2026 — Douyin chặn HTTP /mix/aweme/ bằng Argus ("Signature Not Found"): detail/post
            #   đã có đường 'lấy QUA TRANG', mix thì chưa ⇒ "cào theo bộ" ra 0 video (đo trên 安安小丧尸).
            #   Probe: mở /video/<seed> thì TRANG tự phát /mix/aweme/ trả đủ cả bộ. Dùng lại pattern _thd_lay.
            #   Chỉ lùi khi ĐÚNG Argus + có trang + có seed; lỗi mạng vẫn ném như cũ.
            if getattr(self, "argus_chan", False) and self.playwright_page is not None and seed_aweme_id:
                utils.logger.warning(
                    "[DouYinClient.get_mix_aweme_list] Douyin chặn HTTP mix (Argus) → LẤY 合集 QUA TRANG.")
                return await self._thmix_lay(str(seed_aweme_id))
            raise

    async def get_series_aweme_list(self, series_id: str, cursor: int = 0, count: int = 12,
                                    seed_aweme_id: str = "") -> Dict:
        """🔴 15/09/2026 — 短剧 (PHIM NGẮN) ĐI CỬA KHÁC 合集. Đừng gộp hai thứ này làm một.

        ĐO THẬT trên bộ `我穿成了校花的恶毒老爹` (seed 7684577127580060943), mở /video/<id> bằng đúng
        trình duyệt của app rồi ghi lại mọi API trang tự phát:
          · `/aweme/v1/web/mix/aweme/`    — **0 lần**  ← chính là cửa `get_mix_aweme_list` đang gõ
          · `/aweme/v1/web/series/aweme/` — có, `aweme_list=6`, `has_more=1`
        Tham số đo được: `series_id` (TRÙNG ĐÚNG `mix_info.mix_id`, nên không phải đi tìm id khác) ·
        `pull_type=2` · `cursor=2` · `count=6` · `source=playlet_homepage_hot`.
        Phản hồi có `max_cursor`/`min_cursor` — **KHÔNG có khoá `cursor`** như mix, nên bên gọi phải tự
        cộng `len(aweme_list)` chứ đừng đọc `res["cursor"]` (đọc sẽ ra None ⇒ đứng yên ⇒ lặp vô hạn).
        `cursor` là CHỈ SỐ TẬP (0-based): đo được request `cursor=2` trong khi `statis.current_episode=3`
        và phần tử đầu đúng là video seed ⇒ muốn từ tập 1 thì bắt đầu `cursor=0`.
        `count=12` ở đây là xin thêm cho đỡ số lượt gọi; trang thật xin 6 — server trả bao nhiêu cũng an
        toàn vì vòng lặp tiến theo `len(aweme_list)`.
        """
        uri = "/aweme/v1/web/series/aweme/"
        params = {"series_id": series_id, "pull_type": 2, "cursor": cursor, "count": count,
                  "source": "playlet_homepage_hot"}
        try:
            return await self.get(uri, params)
        except Exception:
            # Cùng luật với mix: chỉ lùi khi ĐÚNG Argus + có trang + có seed; lỗi mạng vẫn ném như cũ.
            # `_thmix_lay` nay hứng cả `/series/aweme/` nên dùng chung được, không cần hàm song sinh.
            if getattr(self, "argus_chan", False) and self.playwright_page is not None and seed_aweme_id:
                utils.logger.warning(
                    "[DouYinClient.get_series_aweme_list] Douyin chặn HTTP series (Argus) → LẤY 短剧 QUA TRANG.")
                return await self._thmix_lay(str(seed_aweme_id))
            raise

    # ── HỨNG 合集 BẰNG TRANG (14/09/2026) — song sinh với `_thd_lay` của /aweme/detail/ ──────────
    _thmix_hang = None
    _thmix_gan = False

    async def _thmix_lay(self, seed_aweme_id: str) -> Dict:
        """Lấy danh sách bộ qua TRANG — khoá chung với `_thd_lay` (xem lý do ERR_ABORTED ở đó)."""
        if self._trang_khoa is None:
            self._trang_khoa = asyncio.Lock()
        async with self._trang_khoa:
            return await self._thmix_lay_trong(seed_aweme_id)

    async def _thmix_lay_trong(self, seed_aweme_id: str) -> Dict:
        """Mở /video/<seed> rồi HỨNG mọi phản hồi /mix/aweme/ + /series/aweme/ do CHÍNH TRANG phát.

        KHÔNG cuộn (video Douyin cuộn = nhảy video kế). Trả has_more=False: không phân trang qua trang
        được, nên bộ cực lớn có thể chỉ lấy được trang đầu — log rõ để không âm thầm thiếu."""
        pg = self.playwright_page
        if self._thmix_hang is None:
            self._thmix_hang = asyncio.Queue()
        if not self._thmix_gan:
            async def _hung(resp):
                # 🔴 15/09/2026 — HỨNG CẢ HAI CỬA. 合集 đi `/mix/aweme/`, còn 短剧 (phim ngắn) đi
                #   `/series/aweme/`. ĐO trên bộ `我穿成了校花的恶毒老爹`: mở /video/<id> thì trang phát
                #   25 API mà KHÔNG có `/mix/aweme/` lần nào ⇒ bản cũ chờ đủ 24s rồi trả rỗng. Một trang
                #   chỉ phát MỘT trong hai, nên nhận cả hai là đủ cho cả hai loại bộ — khỏi viết hàm thứ hai.
                if not any(_f in resp.url for _f in ("/aweme/v1/web/mix/aweme/",
                                                     "/aweme/v1/web/series/aweme/")):
                    return
                try:
                    d = await resp.json()
                except Exception:
                    return
                if isinstance(d, dict) and d.get("aweme_list") is not None:
                    self._thmix_hang.put_nowait(d)

            pg.on("response", _hung)
            self._thmix_gan = True
        while not self._thmix_hang.empty():
            self._thmix_hang.get_nowait()
        await pg.goto("https://www.douyin.com/video/" + str(seed_aweme_id),
                      wait_until="domcontentloaded", timeout=60000)
        gop = {}
        _last = None
        for _ in range(20):     # 20 x 1,2s = 24s cho trang phat request
            while not self._thmix_hang.empty():
                d = self._thmix_hang.get_nowait()
                for _aw in (d.get("aweme_list") or []):
                    _aid = str((_aw or {}).get("aweme_id") or "")
                    if _aid and _aid not in gop:
                        gop[_aid] = _aw
                _last = d
            if gop and _last is not None and not _last.get("has_more"):
                break
            await asyncio.sleep(1.2)
        if not gop:
            _u = ""
            try:
                _u = pg.url or ""
            except Exception:
                pass
            utils.logger.warning("[DouYinClient._thmix_lay] mở /video/%s KHÔNG hứng được 合集 sau 24s "
                                 "(URL cuối %s)" % (seed_aweme_id, _u[:60]))
        elif _last is not None and _last.get("has_more"):
            utils.logger.warning("[DouYinClient._thmix_lay] 合集 còn has_more nhưng đường-qua-trang chỉ lấy "
                                 "được trang đầu (%d video) — bộ rất lớn có thể thiếu tập cuối." % len(gop))
        return {"aweme_list": list(gop.values()), "cursor": (_last or {}).get("cursor", 0), "has_more": False}

    async def get_aweme_comments(self, aweme_id: str, cursor: int = 0):
        """get note comments

        """
        uri = "/aweme/v1/web/comment/list/"
        params = {"aweme_id": aweme_id, "cursor": cursor, "count": 20, "item_type": 0}
        keywords = request_keyword_var.get()
        referer_url = "https://www.douyin.com/search/" + keywords + '?aid=3a3cec5a-9e27-4040-b6aa-ef548c2c1138&publish_time=0&sort_type=0&source=search_history&type=general'
        headers = copy.copy(self.headers)
        headers["Referer"] = urllib.parse.quote(referer_url, safe=':/')
        return await self.get(uri, params)

    async def get_sub_comments(self, aweme_id: str, comment_id: str, cursor: int = 0):
        """
            获取子评论
        """
        uri = "/aweme/v1/web/comment/list/reply/"
        params = {
            'comment_id': comment_id,
            "cursor": cursor,
            "count": 20,
            "item_type": 0,
            "item_id": aweme_id,
        }
        keywords = request_keyword_var.get()
        referer_url = "https://www.douyin.com/search/" + keywords + '?aid=3a3cec5a-9e27-4040-b6aa-ef548c2c1138&publish_time=0&sort_type=0&source=search_history&type=general'
        headers = copy.copy(self.headers)
        headers["Referer"] = urllib.parse.quote(referer_url, safe=':/')
        return await self.get(uri, params)

    async def get_aweme_all_comments(
        self,
        aweme_id: str,
        crawl_interval: float = 1.0,
        is_fetch_sub_comments=False,
        callback: Optional[Callable] = None,
        max_count: int = 10,
    ):
        """
        获取帖子的所有评论，包括子评论
        :param aweme_id: 帖子ID
        :param crawl_interval: 抓取间隔
        :param is_fetch_sub_comments: 是否抓取子评论
        :param callback: 回调函数，用于处理抓取到的评论
        :param max_count: 一次帖子爬取的最大评论数量
        :return: 评论列表
        """
        result = []
        comments_has_more = 1
        comments_cursor = 0
        while comments_has_more and len(result) < max_count:
            comments_res = await self.get_aweme_comments(aweme_id, comments_cursor)
            comments_has_more = comments_res.get("has_more", 0)
            comments_cursor = comments_res.get("cursor", 0)
            comments = comments_res.get("comments", [])
            if not comments:
                continue
            if len(result) + len(comments) > max_count:
                comments = comments[:max_count - len(result)]
            result.extend(comments)
            if callback:  # If there is a callback function, execute the callback function
                await callback(aweme_id, comments)

            await asyncio.sleep(crawl_interval)
            if not is_fetch_sub_comments:
                continue
            # Get secondary reviews
            for comment in comments:
                reply_comment_total = comment.get("reply_comment_total")

                if reply_comment_total > 0:
                    comment_id = comment.get("cid")
                    sub_comments_has_more = 1
                    sub_comments_cursor = 0

                    while sub_comments_has_more:
                        sub_comments_res = await self.get_sub_comments(aweme_id, comment_id, sub_comments_cursor)
                        sub_comments_has_more = sub_comments_res.get("has_more", 0)
                        sub_comments_cursor = sub_comments_res.get("cursor", 0)
                        sub_comments = sub_comments_res.get("comments", [])

                        if not sub_comments:
                            continue
                        result.extend(sub_comments)
                        if callback:  # If there is a callback function, execute the callback function
                            await callback(aweme_id, sub_comments)
                        await asyncio.sleep(crawl_interval)
        return result

    async def get_user_info(self, sec_user_id: str):
        uri = "/aweme/v1/web/user/profile/other/"
        params = {
            "sec_user_id": sec_user_id,
            "publish_video_strategy_type": 2,
            "personal_center_strategy": 1,
        }
        return await self.get(uri, params)

    # ── THU HOẠCH BẰNG TRANG (03/09/2026) ────────────────────────────────────────────────────────
    # Vì sao phải có đường này: Douyin bật ArgusSecurityPlugin cho `/aweme/v1/web/aweme/post/`.
    # ĐÃ ĐO (bắt request thật của trình duyệt trên chính kênh khách báo lỗi, 03/09/2026):
    #   · thiếu `uifid`                  → "Uifid Not Found"        (đã vá: đọc từ cookie, xem trên)
    #   · thiếu `x-secsdk-web-signature` → "Signature Not Found"    ← ĐÚNG lỗi khách gặp
    #     (đo bằng cách bỏ ĐÚNG MỘT tham số khỏi URL thật rồi phát lại — không suy đoán)
    #   · `x-secsdk-web-signature` 32 ký tự, KHÔNG nằm trong cookie nào ⇒ JS tính từng request.
    # Và 4 đường vòng đều ĐÃ THỬ, ĐỀU CHẾT — đừng thử lại:
    #   1. phát lại NGUYÊN VĂN URL thật từ Python/httpx (đủ cookie + header)  → "Sign Invalid"
    #   2. `fetch()` trong page, bỏ chữ ký để secsdk tự ký                    → "Sign Invalid"
    #   3. `XMLHttpRequest` trong page (secsdk CÓ chèn a_bogus vào URL đi ra) → "Sign Invalid"
    #   4. phát lại NGUYÊN VĂN trong page (giữ y nguyên chuỗi thô, không qua  → 200 nhưng trả
    #      parse_qsl/urlencode kẻo đổi thứ tự & cách mã hoá mà a_bogus ký lên)   HTML, không phải JSON
    #   Trong khi ĐÚNG request do CHÍNH TRANG tự phát ra → 200 + JSON thật (đo: 26 thẻ video,
    #   `status_code:0`) và KHÔNG CẦN ĐĂNG NHẬP. ⇒ Chữ ký gắn chặt vào request gốc; cách duy nhất
    #   còn lại là để trang tự gọi rồi HỨNG phản hồi.
    # Thiết kế: chỉ THAY NGUỒN của `get_user_aweme_posts`, trả về đúng hình dạng cũ
    # (`aweme_list`/`has_more`/`max_cursor` — đều là giá trị THẬT của Douyin, vì ta hứng nguyên
    # phản hồi API). Nhờ vậy `_collect_user_posts` (CHASE/DEEP/vượt trang rỗng) KHÔNG phải đụng.
    # Hứng theo kiểu LƯỜI: mỗi lần xin một trang mới thì mới cuộn thêm — không nạp sạch kênh 500
    # video trong khi người dùng chỉ xin 20.
    _th_bat = False        # đã chuyển hẳn sang đường trang (khỏi thử lại HTTP mỗi trang → chậm + dễ bị chặn thêm)
    _th_uid = ""           # kênh trang đang mở
    _th_hang = None        # asyncio.Queue chứa các phản hồi đã hứng
    _th_thay = None        # (HTTP, số byte) của phản hồi `/aweme/post/` GẦN NHẤT mà CHÍNH TRANG tự gọi

    async def _th_mo(self, sec_user_id: str) -> None:
        """Mở trang kênh và gắn bộ HỨNG. Bộ hứng gắn MỘT LẦN cho cả vòng đời client
        (gắn lại mỗi lần đổi kênh sẽ chồng handler → mỗi phản hồi vào hàng nhiều lần)."""
        pg = self.playwright_page
        if self._th_hang is None:
            self._th_hang = asyncio.Queue()

            async def _hung(resp):
                if "/aweme/v1/web/aweme/post/" not in resp.url:
                    return
                # 🔴 10/09/2026 (lượt 3) — GHI LẠI để lúc THẤT BẠI còn nói được VÌ SAO. Hai bệnh
                #   khác hẳn nhau vẫn đang rơi vào cùng một câu log "cuộn hết 24 vòng":
                #     (a) trang bị ĐÁ đi nơi khác ⇒ KHÔNG hề gọi `/aweme/post/`  → chữa được bằng
                #         đổi kiểu cửa sổ (VC_DY_CUA_SO=1);
                #     (b) trang gọi ĐÚNG mà Douyin trả HTTP 200 THÂN RỖNG cho CHÍNH trình duyệt
                #         thật (đo 10/09 trên máy dev: 0 byte) ⇒ KHÔNG chỗ nào hứng được, đừng đi
                #         tìm endpoint khác nữa — đó là chặn ở mức tài khoản/IP.
                #   Thất bại CÂM chính là thứ làm cả ngày 10/09 đi sai hướng.
                try:
                    _t = await resp.text()
                except Exception:
                    self._th_thay = (resp.status, -1)
                    return
                self._th_thay = (resp.status, len(_t or ""))
                try:
                    d = json.loads(_t)
                except Exception:
                    return          # 403/HTML/thân rỗng — bỏ qua, vòng cuộn sẽ thử tiếp
                if isinstance(d, dict) and d.get("aweme_list") is not None:
                    self._th_hang.put_nowait(d)

            pg.on("response", _hung)
        while not self._th_hang.empty():      # dọn hàng của kênh trước
            self._th_hang.get_nowait()
        self._th_thay = None                  # quên phản hồi của kênh trước, kẻo chẩn nhầm
        await pg.goto("https://www.douyin.com/user/" + sec_user_id,
                      wait_until="domcontentloaded", timeout=60000)
        self._th_uid = sec_user_id

    async def _th_trang(self, sec_user_id: str) -> Dict:
        """Trả MỘT trang phản hồi do chính trang phát ra; cuộn tới khi có trang mới."""
        pg = self.playwright_page
        if self._th_uid != sec_user_id or self._th_hang is None:
            await self._th_mo(sec_user_id)
        # 24 vòng × 1,2s ≈ 29s: đủ cho lượt đầu (trang phải tải xong mới phát request) và cho
        # những lần cuộn mà Douyin trả chậm. Hết vòng mà không có gì → coi như hết video
        # (has_more=0) chứ KHÔNG ném lỗi: ném ở đây thì mất luôn số video đã lấy được.
        # 🔴 15/09/2026 — PHẢI ĐƯA CHUỘT VÀO GIỮA LƯỚI RỒI MỚI LĂN. Sự kiện `wheel` của Playwright bắn
        #   vào phần tử đang nằm DƯỚI con trỏ; mặc định con trỏ ở (0,0) = góc trái trên = ngoài vùng
        #   danh sách ⇒ trang Douyin KHÔNG lazy-load thêm.
        #   ĐO THẬT trên kênh khách (cùng trang, cùng phiên, 5 cách cuộn):
        #     · `mouse.wheel` trần (cách cũ)            → **3 lô = 57 video** rồi TẮT HẲN (cuộn 60 vòng vẫn im)
        #     · `window.scrollTo` / `scrollTop` / `End` → +0 lô
        #     · **`mouse.move(giữa lưới)` + `wheel`**   → **+5 lô = 132 video** (TRỌN kênh)
        #   Các lô ra `[21,18,18,17,18,17,17,6]` khớp TỪNG LÔ với đường HTTP ⇒ đúng là cùng dữ liệu.
        #   Đây chính là ca khách báo "cào kênh cứ 57 là dừng": HTTP bị Argus chặn ⇒ rơi xuống đường
        #   này ⇒ 3 lô rồi thôi, mà lô cuối Douyin còn ghi `has_more=1` (tức CÒN video).
        try:
            _vp = pg.viewport_size or {}
            _mx, _my = int(_vp.get("width", 1920) * 0.5), int(_vp.get("height", 1080) * 0.55)
        except Exception:
            _mx, _my = 960, 600
        _con = None                                  # has_more của lô THẬT gần nhất (để khỏi nói dối "hết video")
        for _ in range(24):
            if not self._th_hang.empty():
                _d = self._th_hang.get_nowait()
                self._th_con = _d.get("has_more")
                return _d
            try:
                await pg.mouse.move(_mx, _my)        # BẮT BUỘC: không có dòng này là chết ở lô thứ 3
                await pg.mouse.wheel(0, 2500)
            except Exception:
                pass
            await asyncio.sleep(1.2)
        # Nói RÕ dừng vì đâu — xem chú thích trong `_hung` (hai bệnh, hai cách chữa khác hẳn).
        _u = ""
        try:
            _u = pg.url or ""
        except Exception:
            pass
        if self._th_thay is None:
            utils.logger.warning(
                "[DouYinClient._th_trang] cuộn hết 24 vòng mà TRANG KHÔNG HỀ GỌI /aweme/post/ — "
                "URL cuối: %s. Dấu hiệu trang bị đá / chưa render. Thử đặt biến môi trường "
                "VC_DY_CUA_SO=1 rồi chạy lại (mở cửa sổ Chrome thật, đẩy ra ngoài màn hình)." % _u[:70])
        elif self._th_thay[1] <= 0:
            utils.logger.warning(
                "[DouYinClient._th_trang] Trang GỌI ĐÚNG /aweme/post/ nhưng Douyin trả HTTP %s "
                "THÂN RỖNG (%s byte) cho CHÍNH trình duyệt thật ⇒ KHÔNG có chỗ nào hứng được. "
                "Đây là chặn ở mức TÀI KHOẢN/IP cho endpoint danh sách kênh — KHÔNG phải lỗi tool, "
                "KHÔNG chữa được bằng đổi cách mở trình duyệt. Cách thử: đăng nhập lại Douyin, đợi "
                "15-30 phút, hoặc dùng 'Theo link' cho từng video."
                % (self._th_thay[0], self._th_thay[1]))
        elif getattr(self, "_th_con", 0) == 1:
            # Lô THẬT gần nhất báo `has_more=1` mà cuộn mãi không ra lô mới ⇒ KHÔNG phải hết video,
            # mà là trang ngừng tải thêm. Trả has_more=0 để vòng ngoài dừng gọn, nhưng PHẢI NÓI RA —
            # im lặng ở đây chính là thứ làm khách tưởng "tool có trần 57 video".
            utils.logger.warning("[DouYinClient._th_trang] trang NGỪNG tải thêm dù Douyin báo has_more=1 "
                                 "— danh sách bị CẮT NGẮN, không phải hết video.")
            print("LOG:⚠ Trang kênh ngừng tải thêm — nền tảng báo VẪN CÒN video. Danh sách lấy được bị "
                  "cắt ngắn. Đợi vài phút rồi cào lại (video đã tải sẽ tự bỏ qua).", flush=True)
        else:
            utils.logger.info("[DouYinClient._th_trang] cuộn hết 24 vòng không thấy trang mới → coi như hết video")
        return {"aweme_list": [], "has_more": 0, "max_cursor": ""}

    async def get_user_aweme_posts(self, sec_user_id: str, max_cursor: str = "") -> Dict:
        uri = "/aweme/v1/web/aweme/post/"
        params = {
            "sec_user_id": sec_user_id,
            "count": 18,
            "max_cursor": max_cursor,
            "locate_query": "false",
            "publish_video_strategy_type": 2,
        }
        # DY_EP_TRANG=1: ÉP đi đường trang ngay từ đầu (không đợi Argus chặn). Dùng để KIỂM THỬ đường
        # này — nó chỉ chạy khi nền tảng chặn HTTP nên bình thường không tài nào chạm tới mà đo.
        if self._th_bat or (os.environ.get("DY_EP_TRANG") == "1" and self.playwright_page is not None):
            return await self._th_trang(sec_user_id)
        try:
            return await self.get(uri, params)
        except Exception as e:
            # Chỉ lùi sang đường trang khi ĐÚNG là Argus chặn. Lỗi mạng/timeout vẫn ném như cũ —
            # nuốt hết mọi lỗi vào đây là che mất sự cố thật.
            # ⚠ 10/09 lượt 3: cổng này TỪNG neo `"ArgusSecurityPlugin" in str(e)` — Douyin đổi
            #   sang trả thân RỖNG là câm ngay. Nay dùng CHUNG cờ với `request()` (xem chú thích
            #   ở đó): cứ "có phản hồi mà dùng không được" + CÓ trang thì lấy qua trang.
            if getattr(self, "argus_chan", False) and self.playwright_page is not None:
                utils.logger.warning(
                    "[DouYinClient.get_user_aweme_posts] Douyin chặn đường HTTP (%s) → chuyển sang "
                    "LẤY DANH SÁCH QUA TRANG. Chậm hơn nhưng không mất video." % str(e)[:90])
                self._th_bat = True
                return await self._th_trang(sec_user_id)
            raise

    async def get_all_user_aweme_posts(self, sec_user_id: str, callback: Optional[Callable] = None):
        posts_has_more = 1
        max_cursor = ""
        result = []
        while posts_has_more == 1:
            aweme_post_res = await self.get_user_aweme_posts(sec_user_id, max_cursor)
            posts_has_more = aweme_post_res.get("has_more", 0)
            max_cursor = aweme_post_res.get("max_cursor")
            aweme_list = aweme_post_res.get("aweme_list") if aweme_post_res.get("aweme_list") else []
            utils.logger.info(f"[DouYinClient.get_all_user_aweme_posts] get sec_user_id:{sec_user_id} video len : {len(aweme_list)}")
            if callback:
                await callback(aweme_list)
            result.extend(aweme_list)
        return result

    async def get_aweme_media(self, url: str) -> Union[bytes, None]:
        # Gửi kèm User-Agent + Referer (+ Cookie) để qua chống hotlink của CDN Douyin (tránh 403)
        media_headers = {
            "User-Agent": self.headers.get("User-Agent", ""),
            "Referer": "https://www.douyin.com/",
            "Accept": "*/*",
        }
        if self.headers.get("Cookie"):
            media_headers["Cookie"] = self.headers["Cookie"]
        # BUG khách (0xC00D36C4 "file is corrupt", thumbnail+preview đen): trước đây `return response.content`
        # (buffered) — khi CDN đóng kết nối sớm (rate-limit/token URL hết hạn sau vài video — "4 đầu OK, sau
        # hỏng"), httpx NÉM RemoteProtocolError → rơi except → return None; nhưng nếu server trả 200 rồi cắt
        # cụt vẫn đủ Content-Length khai báo thì file .mp4 thiếu mdat vẫn ghi ra (faststart: moov ở ĐẦU nên
        # header+duration còn → player hiện được nhưng frame đen) + mark_seen (ledger chặn tải lại VĨNH VIỄN).
        # FIX: STREAM (giữ được bytes đã nhận DÙ kết nối đứt giữa chừng) + verify theo Content-Length; thiếu
        # → RESUME phần còn lại bằng Range, retry; vẫn thiếu → return None (KHÔNG ghi file hỏng). Content-Length
        # vắng (chunked) mà stream chạy hết bình thường → chấp nhận như cũ.
        media_timeout = httpx.Timeout(connect=20.0, read=120.0, write=20.0, pool=20.0)

        def _range_start(resp) -> Optional[int]:
            """Đọc offset BẮT ĐẦU thật của body 206 từ Content-Range 'bytes M-.../total'. None nếu vắng/méo."""
            cr = resp.headers.get("content-range", "")
            if cr.lower().startswith("bytes "):
                seg = cr[6:].split("/", 1)[0].strip()   # "M-N"
                m = seg.split("-", 1)[0].strip()
                if m.isdigit():
                    return int(m)
            return None

        async def _stream_into(buf: bytearray, want_from: int) -> Optional[int]:
            """Tải body (Range từ want_from nếu >0) NỐI ĐÚNG VỊ TRÍ vào buf. Trả expected (tổng bytes toàn file)
            hoặc None nếu không rõ. httpx KHÔNG validate Content-Range → tự kiểm offset server trả:
              - 200 (bỏ qua Range): body TỪ ĐẦU → buf phải reset về want_from=0 mới nối (nếu want_from>0 mà 200 →
                server không hỗ trợ Range: xoá buf, nạp lại từ 0).
              - 206 start = len(buf) đúng → extend. start < len(buf) (server làm tròn xuống) → CẮT phần chồng lấn
                rồi extend (tránh ghép lệch = file hỏng ngầm). start > len(buf) → có LỖ HỔNG → BỎ (không extend,
                để 'không tiến' → vòng ngoài dừng, return None thay vì ghép file thủng).
            Đứt giữa chừng / lỗi mạng (kể cả OSError/SSL ngoài httpx.HTTPError) → giữ phần đã nhận, KHÔNG raise."""
            exp = None
            headers = dict(media_headers)
            if want_from > 0:
                headers["Range"] = f"bytes={want_from}-"
            try:
                async with make_async_client(proxy=self.proxy) as client:
                    async with client.stream("GET", url, timeout=media_timeout,
                                             follow_redirects=True, headers=headers) as resp:
                        if resp.status_code == 416:
                            # Range vượt EOF: file THẬT ngắn hơn Content-Length server khai (khai thừa) →
                            # buf hiện có là ĐỦ file thật. Trả sentinel -1 để vòng ngoài chấp nhận buf.
                            utils.logger.info(f"[DouYinClient.get_aweme_media] 416 @{want_from} — Content-Length khai thừa, file đã đủ")
                            return -1
                        if resp.status_code not in (200, 206):
                            utils.logger.error(f"[DouYinClient.get_aweme_media] status {resp.status_code} for {url}")
                            return None
                        if resp.status_code == 200:
                            # server gửi TỪ ĐẦU file (bỏ qua Range nếu có) → nối phải bắt đầu từ 0
                            if want_from > 0:
                                buf.clear()
                            start = 0
                        else:  # 206
                            start = _range_start(resp)
                            if start is None:
                                start = want_from   # server 206 nhưng vắng Content-Range → tin theo yêu cầu
                        cl = resp.headers.get("content-length")
                        if cl and cl.isdigit():
                            exp = start + int(cl)   # tổng = offset thật + độ dài phần này
                        if start > len(buf):
                            # LỖ HỔNG giữa phần đã có và phần server gửi → không thể ghép liền → bỏ hẳn phần này
                            utils.logger.warning(f"[DouYinClient.get_aweme_media] 206 start {start} > buf {len(buf)} (lỗ hổng) — bỏ khối")
                            return exp
                        skip = len(buf) - start   # server trả sớm hơn chỗ đang có → cắt phần chồng lấn đầu
                        # 19/08/2026 — TIẾN ĐỘ TẢI (xem tools/tien_do_tai.py). Trước đây suốt lúc tải một
                        # video 300-600MB không in dòng nào ⇒ khách tưởng treo. Báo theo GIÁ TRỊ TUYỆT ĐỐI
                        # `len(buf)` chứ không cộng dồn từng chunk: nhánh resume ở trên có `buf.clear()`
                        # (server bỏ qua Range, trả lại từ đầu) — cộng dồn ở đó sẽ đếm TRÙNG, in ra 180%.
                        _td = _TienDo(url[-24:], doan="dy", tong=(exp or 0))
                        try:
                            async for chunk in resp.aiter_bytes():
                                if skip > 0:
                                    if len(chunk) <= skip:
                                        skip -= len(chunk); continue
                                    chunk = chunk[skip:]; skip = 0
                                buf.extend(chunk)
                                _td.dat_da(len(buf))
                        except Exception as exc:   # đứt GIỮA CHỪNG (httpx.HTTPError / OSError / SSL...) → giữ phần đã nhận
                            utils.logger.warning(f"[DouYinClient.get_aweme_media] {exc.__class__.__name__} khi stream @{len(buf)} bytes")
                        finally:
                            _td.dong()   # PHẢI gỡ khỏi sổ dù đứt giữa chừng, kẻo dòng tổng đếm mãi video đã chết
            except Exception as exc:   # lỗi TRƯỚC khi có body (connect/status) → không có gì để giữ
                utils.logger.error(f"[DouYinClient.get_aweme_media] {exc.__class__.__name__} for {url} - {exc}")
            return exp

        # BUG khách (log "0 MB" dù báo save_video success — nghi CDN trả HTTP 200 kèm trang lỗi/rác NGẮN thay
        # vì mp4 thật, Content-Length KHỚP nội dung rác đó nên qua được verify độ dài ở trên): file mp4 THẬT
        # luôn bắt đầu bằng ISO-BMFF box (4 byte size + 4 byte tag 'ftyp'/'free'/'moov'...) trong ~64 byte đầu —
        # HTML/JSON lỗi thì không. Kiểm tra RẺ (chỉ đọc buf đã có sẵn trong RAM, không tải thêm) trước khi
        # CHẤP NHẬN bất kỳ kết quả nào — không phải bằng chứng chắc chắn 100% (vd webm/mkv hiếm gặp từ Douyin
        # sẽ bị từ chối oan) nhưng chặn được lớp lỗi phổ biến nhất (HTML/JSON rác đủ dài để qua check size).
        def _co_dau_hieu_mp4(b: bytes) -> bool:
            if len(b) < 12:
                return False
            for _off in (4, 8):   # box đầu tiên thường ở offset 4 ('....ftyp'); vài CDN chèn box rỗng trước
                if _off + 4 <= len(b) and b[_off:_off + 4] in (b"ftyp", b"moov", b"free", b"skip", b"wide"):
                    return True
            return False

        def _ket_qua(b: bytearray):
            data = bytes(b)
            if not _co_dau_hieu_mp4(data):
                utils.logger.error(f"[DouYinClient.get_aweme_media] tải xong {len(data)} bytes NHƯNG không phải MP4 thật "
                                    f"(thiếu ftyp/moov đầu file — nghi CDN trả trang lỗi) — bỏ, đầu file: {data[:32]!r}")
                return None
            return data

        buf = bytearray()
        expected = await _stream_into(buf, 0)
        if not buf:
            return None
        # đủ, hoặc server không khai độ dài mà stream đã chạy hết (không đứt) → chấp nhận
        if expected is None or len(buf) >= expected:
            return _ket_qua(buf)

        # THIẾU → resume phần còn lại bằng Range, retry tối đa 4 lần (mỗi lần tải nốt từ chỗ đang có)
        utils.logger.warning(f"[DouYinClient.get_aweme_media] tải THIẾU {len(buf)}/{expected} bytes — resume bằng Range...")
        for _try in range(4):
            if len(buf) >= expected:
                break
            before = len(buf)
            _r = await _stream_into(buf, len(buf))
            if _r == -1:   # 416: Content-Length khai thừa, file thật đã đủ → chấp nhận buf hiện có
                return _ket_qua(buf)
            if len(buf) <= before:   # không nhích (server không hỗ trợ Range → tải lại full rồi cắt cùng chỗ /
                utils.logger.warning(f"[DouYinClient.get_aweme_media] resume không tiến (lần {_try + 1}/4)")  # lỗ hổng / lỗi)
                await asyncio.sleep(1.0)                                                                       # → nghỉ, thử lại (tối đa 4)

        if len(buf) >= expected:
            utils.logger.info(f"[DouYinClient.get_aweme_media] resume XONG {len(buf)}/{expected} bytes")
            return _ket_qua(buf)
        utils.logger.error(f"[DouYinClient.get_aweme_media] resume thất bại {len(buf)}/{expected} bytes — bỏ (sẽ tải lại lần sau)")
        return None

    async def resolve_short_url(self, short_url: str) -> str:
        """
        解析抖音短链接,获取重定向后的真实URL
        Args:
            short_url: 短链接,如 https://v.douyin.com/iF12345ABC/
        Returns:
            重定向后的完整URL
        """
        async with make_async_client(proxy=self.proxy, follow_redirects=False) as client:
            try:
                utils.logger.info(f"[DouYinClient.resolve_short_url] Resolving short URL: {short_url}")
                response = await client.get(short_url, timeout=10)

                # Short links usually return a 302 redirect
                if response.status_code in [301, 302, 303, 307, 308]:
                    redirect_url = response.headers.get("Location", "")
                    utils.logger.info(f"[DouYinClient.resolve_short_url] Resolved to: {redirect_url}")
                    return redirect_url
                else:
                    utils.logger.warning(f"[DouYinClient.resolve_short_url] Unexpected status code: {response.status_code}")
                    return ""
            except Exception as e:
                utils.logger.error(f"[DouYinClient.resolve_short_url] Failed to resolve short URL: {e}")
                return ""
