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
import urllib.parse
from typing import TYPE_CHECKING, Any, Callable, Dict, Union, Optional

import httpx
from playwright.async_api import BrowserContext

from base.base_crawler import AbstractApiClient
from proxy.proxy_mixin import ProxyRefreshMixin
from tools import utils
from tools.tien_do_tai import TienDo as _TienDo
from tools.httpx_util import make_async_client
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
        res = await self.get("/aweme/v1/web/aweme/detail/", params, headers)
        return res.get("aweme_detail", {})

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

    async def get_user_aweme_posts(self, sec_user_id: str, max_cursor: str = "") -> Dict:
        uri = "/aweme/v1/web/aweme/post/"
        params = {
            "sec_user_id": sec_user_id,
            "count": 18,
            "max_cursor": max_cursor,
            "locate_query": "false",
            "publish_video_strategy_type": 2,
        }
        return await self.get(uri, params)

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
                        progress = _TienDo(url[-24:], doan="dy", tong=(exp or 0))
                        try:
                            async for chunk in resp.aiter_bytes():
                                if skip > 0:
                                    if len(chunk) <= skip:
                                        skip -= len(chunk); continue
                                    chunk = chunk[skip:]; skip = 0
                                buf.extend(chunk)
                                progress.dat_da(len(buf))
                        except Exception as exc:   # đứt GIỮA CHỪNG (httpx.HTTPError / OSError / SSL...) → giữ phần đã nhận
                            utils.logger.warning(f"[DouYinClient.get_aweme_media] {exc.__class__.__name__} khi stream @{len(buf)} bytes")
                        finally:
                            progress.dong()
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
