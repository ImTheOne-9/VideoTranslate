# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/bilibili/client.py
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

# -*- coding: utf-8 -*-
# @Author  : relakkes@gmail.com
# @Time    : 2023/12/2 18:44
# @Desc    : bilibili request client
import asyncio
import json
import os
import random
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple, Union
from urllib.parse import urlencode

import httpx
from playwright.async_api import BrowserContext, Page
from tools.httpx_util import make_async_client

import config
from base.base_crawler import AbstractApiClient
from proxy.proxy_mixin import ProxyRefreshMixin
from tools import utils
from tools.tien_do_tai import TienDo as _TienDo

if TYPE_CHECKING:
    from proxy.proxy_ip_pool import ProxyIpPool

from .exception import DataFetchError
from .field import CommentOrderType, SearchOrderType
from .help import BilibiliSign


class BilibiliClient(AbstractApiClient, ProxyRefreshMixin):

    def __init__(
        self,
        timeout=60,  # For media crawling, Bilibili long videos need a longer timeout
        proxy=None,
        *,
        headers: Dict[str, str],
        playwright_page: Page,
        cookie_dict: Dict[str, str],
        proxy_ip_pool: Optional["ProxyIpPool"] = None,
    ):
        self.proxy = proxy
        self.timeout = timeout
        self.headers = headers
        self._host = "https://api.bilibili.com"
        self.cookie_urls = ["https://www.bilibili.com"]
        self.playwright_page = playwright_page
        self.cookie_dict = cookie_dict
        # Initialize proxy pool (from ProxyRefreshMixin)
        self.init_proxy_pool(proxy_ip_pool)

    async def request(self, method, url, **kwargs) -> Any:
        # Check if proxy has expired before each request
        await self._refresh_proxy_if_expired()

        async with make_async_client(proxy=self.proxy) as client:
            response = await client.request(method, url, timeout=self.timeout, **kwargs)
        try:
            data: Dict = response.json()
        except json.JSONDecodeError:
            utils.logger.error(f"[BilibiliClient.request] Failed to decode JSON from response. status_code: {response.status_code}, response_text: {response.text}")
            raise DataFetchError(f"Failed to decode JSON, content: {response.text}")
        if data.get("code") != 0:
            raise DataFetchError(data.get("message", "unkonw error"))
        else:
            return data.get("data", {})

    async def pre_request_data(self, req_data: Dict) -> Dict:
        """
        Send request to sign request parameters
        Need to get wbi_img_urls parameter from localStorage, value as follows:
        https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png-https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png
        :param req_data:
        :return:
        """
        if not req_data:
            return {}
        img_key, sub_key = await self.get_wbi_keys()
        return BilibiliSign(img_key, sub_key).sign(req_data)

    async def get_wbi_keys(self) -> Tuple[str, str]:
        """
        Get the latest img_key and sub_key
        :return:
        """
        # Chế độ no-browser (playwright_page=None): bỏ qua localStorage, đi thẳng nav-API lấy wbi key.
        wbi_img_urls = ""
        if self.playwright_page is not None:
            local_storage = await self.playwright_page.evaluate("() => window.localStorage")
            wbi_img_urls = local_storage.get("wbi_img_urls", "")
            if not wbi_img_urls:
                img_url_from_storage = local_storage.get("wbi_img_url")
                sub_url_from_storage = local_storage.get("wbi_sub_url")
                if img_url_from_storage and sub_url_from_storage:
                    wbi_img_urls = f"{img_url_from_storage}-{sub_url_from_storage}"
        if wbi_img_urls and "-" in wbi_img_urls:
            img_url, sub_url = wbi_img_urls.split("-")
        else:
            # PHẢI kèm headers (UA + Cookie): nav-API không headers bị bili risk-control trả 412
            # (no-browser mode luôn đi nhánh này vì không có localStorage).
            #
            # KHÔNG dùng self.request() (ném DataFetchError ngay khi code != 0): ĐO THẬT — nav-API
            # TRẢ code=-101 "账号未登录" cho MỌI request KHÔNG login (kể cả 0 cookie), NHƯNG data.wbi_img
            # vẫn có sẵn (wbi key là salt xoay công khai, không gắn với tài khoản). self.request() ném
            # lỗi ngay trước khi đọc được wbi_img → chặn đứng TOÀN BỘ "cào công khai Bilibili" (không
            # login) vì get_wbi_keys() luôn cần chạy trước MỌI request có ký (pre_request_data). Tự fetch
            # + đọc thẳng data.wbi_img bất kể code, chỉ ném lỗi nếu THỰC SỰ thiếu wbi_img (lỗi khác, vd
            # mất mạng/bili đổi API).
            await self._refresh_proxy_if_expired()
            async with make_async_client(proxy=self.proxy) as client:
                response = await client.request("GET", self._host + "/x/web-interface/nav",
                                                 timeout=self.timeout, headers=self.headers)
            try:
                resp_json: Dict = response.json()
            except json.JSONDecodeError:
                raise DataFetchError(f"Failed to decode JSON, content: {response.text}")
            wbi_img = (resp_json.get("data") or {}).get("wbi_img") or {}
            if not (wbi_img.get("img_url") and wbi_img.get("sub_url")):
                raise DataFetchError(resp_json.get("message", "unkonw error (missing wbi_img)"))
            img_url: str = wbi_img["img_url"]
            sub_url: str = wbi_img["sub_url"]
        img_key = img_url.rsplit('/', 1)[1].split('.')[0]
        sub_key = sub_url.rsplit('/', 1)[1].split('.')[0]
        return img_key, sub_key

    async def get(self, uri: str, params=None, enable_params_sign: bool = True) -> Dict:
        final_uri = uri
        if enable_params_sign:
            params = await self.pre_request_data(params)
        if isinstance(params, dict):
            final_uri = (f"{uri}?"
                         f"{urlencode(params)}")
        return await self.request(method="GET", url=f"{self._host}{final_uri}", headers=self.headers)

    async def post(self, uri: str, data: dict) -> Dict:
        data = await self.pre_request_data(data)
        json_str = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
        return await self.request(method="POST", url=f"{self._host}{uri}", data=json_str, headers=self.headers)

    async def pong(self) -> bool:
        """get a note to check if login state is ok"""
        utils.logger.info("[BilibiliClient.pong] Begin pong bilibili...")
        ping_flag = False
        try:
            check_login_uri = "/x/web-interface/nav"
            response = await self.get(check_login_uri)
            if response.get("isLogin"):
                utils.logger.info("[BilibiliClient.pong] Use cache login state get web interface successfull!")
                ping_flag = True
        except Exception as e:
            utils.logger.error(f"[BilibiliClient.pong] Pong bilibili failed: {e}, and try to login again...")
            ping_flag = False
        return ping_flag

    async def update_cookies(self, browser_context: BrowserContext, urls: Optional[list[str]] = None):
        cookie_str, cookie_dict = await utils.convert_browser_context_cookies(
            browser_context,
            urls=urls or self.cookie_urls,
        )
        self.headers["Cookie"] = cookie_str
        self.cookie_dict = cookie_dict

    async def search_video_by_keyword(
        self,
        keyword: str,
        page: int = 1,
        page_size: int = 20,
        order: SearchOrderType = SearchOrderType.DEFAULT,
        pubtime_begin_s: int = 0,
        pubtime_end_s: int = 0,
    ) -> Dict:
        """
        KuaiShou web search api
        :param keyword: Search keyword
        :param page: Page number for pagination
        :param page_size: Number of items per page
        :param order: Sort order for search results, default is comprehensive sorting
        :param pubtime_begin_s: Publish time start timestamp
        :param pubtime_end_s: Publish time end timestamp
        :return:
        """
        uri = "/x/web-interface/wbi/search/type"
        post_data = {
            "search_type": "video",
            "keyword": keyword,
            "page": page,
            "page_size": page_size,
            "order": order.value,
            "pubtime_begin_s": pubtime_begin_s,
            "pubtime_end_s": pubtime_end_s
        }
        return await self.get(uri, post_data)

    async def get_video_info(self, aid: Union[int, None] = None, bvid: Union[str, None] = None) -> Dict:
        """
        Bilibli web video detail api, choose one parameter between aid and bvid
        :param aid: Video aid
        :param bvid: Video bvid
        :return:
        """
        if not aid and not bvid:
            raise ValueError("Please provide at least one parameter: aid or bvid")

        uri = "/x/web-interface/view/detail"
        params = dict()
        if aid:
            params.update({"aid": aid})
        else:
            params.update({"bvid": bvid})
        return await self.get(uri, params, enable_params_sign=False)

    async def get_season_archives(self, mid: int, season_id: int, page_num: int = 1, page_size: int = 30) -> Dict:
        """"HỢP TUYỂN KÊNH" (ugc_season — nhiều video ĐỘC LẬP do UP chủ gom thành 1 bộ có thứ tự tập,
        khác "phân P" là nhiều tập trong CÙNG 1 video). Lấy TOÀN BỘ video trong 1 hợp tuyển theo mid+season_id
        (season_id lấy từ field `ugc_season.id`/`ugc_season.season_id` của response get_video_info nếu video
        đó thuộc 1 hợp tuyển). Không cần cookie/ký WBI — GET thuần + header Referer (đã có sẵn trong self.headers).
        Trả dict {"archives": [...], "page": {...}} (đã cào hết nếu caller lặp theo page.total)."""
        uri = "/x/polymer/web-space/seasons_archives_list"
        params = {"mid": mid, "season_id": season_id, "sort_reverse": "false",
                  "page_num": page_num, "page_size": page_size}
        return await self.get(uri, params, enable_params_sign=False)

    async def get_video_play_url(self, aid: int, cid: int) -> Dict:
        """
        Bilibli web video play url api
        :param aid: Video aid
        :param cid: cid
        :return:
        """
        if not aid or not cid or aid <= 0 or cid <= 0:
            raise ValueError("aid and cid must exist")
        uri = "/x/player/wbi/playurl"
        qn_value = getattr(config, "BILI_QN", 80)
        params = {
            "avid": aid,
            "cid": cid,
            "qn": qn_value,
            "fourk": 1,
            "fnval": 1,
            "platform": "pc",
        }

        return await self.get(uri, params, enable_params_sign=True)

    async def get_video_media(self, url: str, backup_urls: Optional[List[str]] = None) -> Union[bytes, None]:
        # CDN UPOS bilibili (upos-*.akamaized.net):
        # - Domain KHÁC bilibili.com -> chỉ gửi header trình duyệt THẬT gửi (UA + Referer + Range + Accept);
        #   KHÔNG gửi Cookie bili (cross-domain) / Origin / Content-Type:json -> tránh Akamai nghi bot.
        # NHIỀU KẾT NỐI SONG SONG (CONCUR đoạn Range đều nhau, KHÔNG chia theo kích thước chunk cố định như
        # bản cũ) — đo thật: 1 kết nối đơn CHỈ ~0.1MB/s (CDN akamaized giới hạn băng thông/kết nối, không
        # phải do mạng chậm) → 4 kết nối song song cộng dồn băng thông ~4×. Mỗi đoạn retry ĐỘC LẬP (đổi mirror
        # khi lỗi liên tiếp) — ĐƠN GIẢN hơn bản cũ (không còn khái niệm "khối 8/32MB" + "lượt phục hồi 3 vòng
        # concurrency giảm dần", chỉ N đoạn cố định theo CONCUR, mỗi đoạn tự retry tới cùng).
        url_candidates = [url] + [u for u in (backup_urls or []) if u and u != url]
        CONCUR = 4
        base_headers = {
            "User-Agent": self.headers.get("User-Agent", ""),
            "Referer": "https://www.bilibili.com",
            "Accept": "*/*",
        }
        media_timeout = httpx.Timeout(connect=20.0, read=300.0, write=20.0, pool=20.0)

        async def _fetch_range(rng_start: int, rng_end: Optional[int]):
            """Tải đoạn [rng_start, rng_end] (rng_end=None → tới hết file, dùng cho lần dò kích thước đầu).
            Trả (data, total_size) — data=None nếu fail hẳn (mọi mirror x3 lần).

            🐛 CÓ RESUME (fix 29/07 — ca thật máy khách): bản cũ dùng `resp.content` (đọc 1 phát, KHÔNG stream)
            và mỗi lần retry đặt Range từ ĐÚNG `rng_start` cũ ⇒ đứt ở byte nào cũng VỨT SẠCH rồi tải LẠI TỪ ĐẦU
            đoạn. Log khách: video 1.57GB chia 4 đoạn 401MB, đoạn @402MB đứt 6 lần liên tiếp
            (RemoteProtocolError/ReadError) = tải phí ~2.3GB mà KHÔNG tiến được byte nào, rồi bỏ cuộc.
            CDN akamaized bóp ~0.1MB/s mỗi kết nối (xem chú thích đầu hàm) nên một kết nối phải sống hàng nghìn
            giây mới kéo hết 401MB — Akamai ngắt giữa chừng là chắc chắn, retry kiểu cũ KHÔNG BAO GIỜ xong.
            Nay: đọc THEO LUỒNG (`aiter_bytes`) và GIỮ phần đã nhận trong `buf`; lần thử kế xin Range từ byte
            KẾ TIẾP. Cùng cách đã fix cho Douyin (stream+resume) — nhánh Bilibili trước đây bị sót."""
            total = None
            url_i = 0
            fail_streak = 0
            buf = bytearray()
            _can = (rng_end - rng_start + 1) if rng_end is not None else None   # số byte cần của đoạn này
            # NGÂN SÁCH RETRY ĐẾM THEO "KHÔNG TIẾN BỘ", không đếm tổng số lần thử. Có resume rồi thì một lần
            # đứt-nhưng-nhận-thêm-được-vài-MB là ĐANG TIẾN, phạt nó là tự bóp cổ mình: đo thật (server cắt 50%
            # số request) cho thấy đếm-tổng-số-lần làm đoạn 8MB chết ở lần 3 dù đã gom được 5/8MB và vẫn đang lên.
            # Chỉ bỏ cuộc khi N lần LIÊN TIẾP không nhích thêm byte nào. `_tran` chặn lặp vô hạn.
            _max_ke = max(3, len(url_candidates) * 3)
            _khong_tien = 0
            _lan = 0
            _tran = 200
            progress = _TienDo(url[-24:], doan=str(rng_start), tong=(_can or 0))
            while _khong_tien < _max_ke and _lan < _tran:
                _lan += 1
                _truoc = len(buf)
                cur_start = rng_start + len(buf)          # RESUME: tiếp tục từ chỗ ĐÃ nhận được
                if _can is not None and len(buf) >= _can:
                    break                                  # đã gom đủ qua nhiều lần
                headers = dict(base_headers)
                headers["Range"] = f"bytes={cur_start}-{rng_end if rng_end is not None else ''}"
                _qua_tai = False   # 429/503 = server báo THẲNG "quá tải", khác hẳn lỗi mạng thoáng qua
                try:
                    async with make_async_client(proxy=self.proxy, follow_redirects=True) as client:
                        async with client.stream("GET", url_candidates[url_i], timeout=media_timeout,
                                                 headers=headers) as resp:
                            if resp.status_code in (200, 206):
                                if resp.status_code == 200 and cur_start > rng_start:
                                    # Server BỎ QUA Range → trả từ byte 0, KHÔNG nối tiếp được với buf đang có
                                    # (nối vào là hỏng file). Bỏ phần đã nhận, vòng sau tải lại từ đầu đoạn.
                                    buf.clear()
                                    raise httpx.HTTPError("server bỏ qua Range khi resume")
                                if total is None:
                                    cr = resp.headers.get("content-range", "")   # "bytes 0-X/TỔNG"
                                    if "/" in cr:
                                        try:
                                            total = int(cr.rsplit("/", 1)[1])
                                        except Exception:
                                            pass
                                    elif resp.status_code == 200:                # server bỏ qua Range -> cả file
                                        total = int(resp.headers.get("content-length") or 0) or None
                                async for _c in resp.aiter_bytes():
                                    buf.extend(_c)          # GIỮ được kể cả khi đứt giữa chừng
                                    progress.dat_da(len(buf))
                                if _can is None or len(buf) >= _can:
                                    progress.dong()
                                    return bytes(buf), total
                                # EOF SỚM mà không ném lỗi (nhận thiếu) → vòng sau resume tiếp phần còn lại.
                                utils.logger.warning(f"[BilibiliClient.get_video_media] nhận THIẾU đoạn @{rng_start//1048576}MB "
                                                      f"({len(buf)//1048576}/{_can//1048576}MB) → resume tiếp")
                            else:
                                # 🐛 TRƯỚC ĐÂY nhánh status-lỗi (503/504...) KHÔNG tăng `fail_streak` (chỉ khối
                                # `except httpx.HTTPError` bên dưới mới tăng) ⇒ KHÔNG BAO GIỜ đổi sang mirror dự
                                # phòng dù server trả lỗi liên tục — cứ hỏi ĐÚNG mirror đang quá tải mãi. Đo thật
                                # (cào Bilibili 30/07): 2 video đầu tải xong, video 3 dính `503` 6 lần LIÊN TIẾP
                                # trong ~9s trên CÙNG mirror rồi bỏ cuộc hẳn — không hề thử mirror kia. Nay tăng
                                # `fail_streak` + xét đổi mirror GIỐNG HỆT nhánh exception.
                                utils.logger.error(f"[BilibiliClient.get_video_media] status {resp.status_code} đoạn @{rng_start//1048576}MB")
                                fail_streak += 1
                                if resp.status_code in (429, 503):   # server nói THẲNG "đang quá tải/bị chặn nhịp"
                                    _qua_tai = True
                                if fail_streak >= 2 and len(url_candidates) > 1:
                                    url_i = (url_i + 1) % len(url_candidates)
                                    fail_streak = 0
                except httpx.HTTPError as exc:
                    fail_streak += 1
                    # In THÊM 'đã nhận' — bản cũ chỉ in rng_start (cố định) nên 6 lần retry in y hệt một dòng,
                    # khiến log trông như "kẹt cứng 1 chỗ" trong khi thực ra đang tải lại từ đầu mỗi lần.
                    utils.logger.warning(f"[BilibiliClient.get_video_media] {exc.__class__.__name__} đoạn @{rng_start//1048576}MB "
                                          f"(đã nhận {len(buf)//1048576}/{_can//1048576 if _can else '?'}MB, "
                                          f"mirror {url_i + 1}/{len(url_candidates)}, lần {_lan})")
                    if fail_streak >= 2 and len(url_candidates) > 1:
                        url_i = (url_i + 1) % len(url_candidates)
                        fail_streak = 0
                if len(buf) > _truoc:
                    _khong_tien = 0        # lần này CÓ nhận thêm byte → đang tiến, không tính là thất bại
                    await asyncio.sleep(0.2)   # đang chảy dữ liệu → nối lại NGAY, đừng ngủ 1.5s
                else:
                    _khong_tien += 1
                    if _qua_tai:
                        # 🐛 503/429 là server BÁO THẲNG "đang quá tải" — ngủ y hệt 1.5s như lỗi mạng thoáng qua
                        # (RemoteProtocolError) chẳng khác nào dội thêm request vào đúng lúc server đang từ chối,
                        # dễ kéo dài tình trạng chặn nhịp hơn là để nó nguôi. Ngủ TĂNG DẦN theo số lần liên tiếp
                        # không tiến (5s/10s/15s..., trần 30s) — vẫn nằm trong ngân sách `_max_ke` sẵn có, chỉ
                        # đổi THỜI GIAN chờ giữa các lần, không đổi số lần thử tối đa.
                        _cho = min(30.0, 5.0 * _khong_tien)
                        utils.logger.warning(f"[BilibiliClient.get_video_media] server báo quá tải (status) đoạn "
                                             f"@{rng_start//1048576}MB → nghỉ {_cho:.0f}s trước khi thử lại "
                                             f"(lần không-tiến {_khong_tien}/{_max_ke})")
                        await asyncio.sleep(_cho)
                    else:
                        await asyncio.sleep(1.5)   # tịt hẳn → nghỉ lâu hơn cho CDN nguôi
            if _can is not None and len(buf) >= _can:
                progress.dong()
                return bytes(buf), total       # gom đủ qua nhiều lần resume
            progress.dong()
            return None, total

        # Đoạn ĐẦU tải riêng (không song song) để biết total_size trước khi chia CONCUR đoạn còn lại.
        _probe_len = 1 * 1024 * 1024   # 1MB đủ để lấy content-range mà không lãng phí nếu file nhỏ hơn CONCUR đoạn
        data0, total_size = await _fetch_range(0, _probe_len - 1)
        if data0 is None:
            utils.logger.error("[BilibiliClient.get_video_media] Đoạn dò kích thước thất bại hẳn — dừng.")
            return None
        if total_size is None or total_size <= _probe_len:
            utils.logger.info(f"[BilibiliClient.get_video_media] tải xong {round(len(data0)/1048576,1)}MB (video nhỏ, 1 đoạn)")
            return data0

        # Chia phần CÒN LẠI [_probe_len, total_size) thành NHIỀU đoạn NHỎ cố định, chạy CONCUR đoạn song song.
        # 🐛 Bản cũ chia đúng CONCUR đoạn KHỔNG LỒ (tổng/4): video 1.57GB của khách ⇒ mỗi đoạn 401MB. Một kết
        # nối phải sống rất lâu để kéo hết ngần ấy qua CDN bị bóp băng thông ⇒ Akamai ngắt giữa chừng, và
        # (trước khi có resume) mất trắng cả đoạn. Đoạn NHỎ: kết nối ngắn nên ít bị ngắt, đứt thì chỉ mất
        # ≤CHUNK và resume gom lại được. VẪN giữ CONCUR kết nối song song ⇒ băng thông cộng dồn như cũ.
        # Chỉnh: MC_BILI_CHUNK_MB (mặc định 8).
        try:
            CHUNK = max(1, int(os.environ.get("MC_BILI_CHUNK_MB", "8") or 8)) * 1024 * 1024
        except ValueError:
            CHUNK = 8 * 1024 * 1024
        bounds = []
        _s = _probe_len
        while _s < total_size:
            _e = min(_s + CHUNK, total_size) - 1
            bounds.append((_s, _e))
            _s = _e + 1
        _sem = asyncio.Semaphore(CONCUR)

        async def _tai_1_doan(s, e):
            async with _sem:                  # tối đa CONCUR kết nối cùng lúc (dù có hàng trăm đoạn)
                return await _fetch_range(s, e)

        results = await asyncio.gather(*[_tai_1_doan(s, e) for s, e in bounds])
        parts = [data0]
        for (data, _), (s, e) in zip(results, bounds):
            if data is None:
                utils.logger.error(f"[BilibiliClient.get_video_media] Đoạn @{s//1048576}-{e//1048576}MB thất bại hẳn sau retry — dừng.")
                return None
            parts.append(data)
        merged = b"".join(parts)
        utils.logger.info(f"[BilibiliClient.get_video_media] tải xong {round(len(merged)/1048576,1)}MB "
                          f"({len(bounds)} đoạn × {CHUNK//1048576}MB, {CONCUR} kết nối song song)")
        return merged

    async def get_video_comments(
        self,
        video_id: str,
        order_mode: CommentOrderType = CommentOrderType.DEFAULT,
        next: int = 0,
    ) -> Dict:
        """get video comments
        :param video_id: Video ID
        :param order_mode: Sort order
        :param next: Comment page selection
        :return:
        """
        uri = "/x/v2/reply/wbi/main"
        post_data = {"oid": video_id, "mode": order_mode.value, "type": 1, "ps": 20, "next": next}
        return await self.get(uri, post_data)

    async def get_video_all_comments(
        self,
        video_id: str,
        crawl_interval: float = 1.0,
        is_fetch_sub_comments=False,
        callback: Optional[Callable] = None,
        max_count: int = 10,
    ):
        """
        get video all comments include sub comments
        :param video_id:
        :param crawl_interval:
        :param is_fetch_sub_comments:
        :param callback:
        max_count: Maximum number of comments to crawl per note

        :return:
        """
        result = []
        is_end = False
        next_page = 0
        max_retries = 3
        while not is_end and len(result) < max_count:
            comments_res = None
            for attempt in range(max_retries):
                try:
                    comments_res = await self.get_video_comments(video_id, CommentOrderType.DEFAULT, next_page)
                    break  # Success
                except DataFetchError as e:
                    if attempt < max_retries - 1:
                        delay = 5 * (2**attempt) + random.uniform(0, 1)
                        utils.logger.warning(f"[BilibiliClient.get_video_all_comments] Retrying video_id {video_id} in {delay:.2f}s... (Attempt {attempt + 1}/{max_retries})")
                        await asyncio.sleep(delay)
                    else:
                        utils.logger.error(f"[BilibiliClient.get_video_all_comments] Max retries reached for video_id: {video_id}. Skipping comments. Error: {e}")
                        is_end = True
                        break
            if not comments_res:
                break

            cursor_info: Dict = comments_res.get("cursor")
            if not cursor_info:
                utils.logger.warning(f"[BilibiliClient.get_video_all_comments] Could not find 'cursor' in response for video_id: {video_id}. Skipping.")
                break

            comment_list: List[Dict] = comments_res.get("replies", [])

            # Check if is_end and next exist
            if "is_end" not in cursor_info or "next" not in cursor_info:
                utils.logger.warning(f"[BilibiliClient.get_video_all_comments] 'is_end' or 'next' not in cursor for video_id: {video_id}. Assuming end of comments.")
                is_end = True
            else:
                is_end = cursor_info.get("is_end")
                next_page = cursor_info.get("next")

            if not isinstance(is_end, bool):
                utils.logger.warning(f"[BilibiliClient.get_video_all_comments] 'is_end' is not a boolean for video_id: {video_id}. Assuming end of comments.")
                is_end = True
            if is_fetch_sub_comments:
                for comment in comment_list:
                    comment_id = comment['rpid']
                    if (comment.get("rcount", 0) > 0):
                        {await self.get_video_all_level_two_comments(video_id, comment_id, CommentOrderType.DEFAULT, 10, crawl_interval, callback)}
            if len(result) + len(comment_list) > max_count:
                comment_list = comment_list[:max_count - len(result)]
            if callback:  # If there is a callback function, execute it
                await callback(video_id, comment_list)
            await asyncio.sleep(crawl_interval)
            if not is_fetch_sub_comments:
                result.extend(comment_list)
                continue
        return result

    async def get_video_all_level_two_comments(
        self,
        video_id: str,
        level_one_comment_id: int,
        order_mode: CommentOrderType,
        ps: int = 10,
        crawl_interval: float = 1.0,
        callback: Optional[Callable] = None,
    ) -> Dict:
        """
        get video all level two comments for a level one comment
        :param video_id: Video ID
        :param level_one_comment_id: Level one comment ID
        :param order_mode:
        :param ps: Number of comments per page
        :param crawl_interval:
        :param callback:
        :return:
        """

        pn = 1
        while True:
            result = await self.get_video_level_two_comments(video_id, level_one_comment_id, pn, ps, order_mode)
            comment_list: List[Dict] = result.get("replies", [])
            if callback:  # If there is a callback function, execute it
                await callback(video_id, comment_list)
            await asyncio.sleep(crawl_interval)
            if (int(result["page"]["count"]) <= pn * ps):
                break

            pn += 1

    async def get_video_level_two_comments(
        self,
        video_id: str,
        level_one_comment_id: int,
        pn: int,
        ps: int,
        order_mode: CommentOrderType,
    ) -> Dict:
        """get video level two comments
        :param video_id: Video ID
        :param level_one_comment_id: Level one comment ID
        :param order_mode: Sort order

        :return:
        """
        uri = "/x/v2/reply/reply"
        post_data = {
            "oid": video_id,
            "mode": order_mode.value,
            "type": 1,
            "ps": ps,
            "pn": pn,
            "root": level_one_comment_id,
        }
        result = await self.get(uri, post_data)
        return result

    async def get_creator_videos(self, creator_id: str, pn: int, ps: int = 30, order_mode: SearchOrderType = SearchOrderType.LAST_PUBLISH) -> Dict:
        """get all videos for a creator
        :param creator_id: Creator ID
        :param pn: Page number
        :param ps: Number of videos per page
        :param order_mode: Sort order

        :return:
        """
        uri = "/x/space/wbi/arc/search"
        post_data = {
            "mid": creator_id,
            "pn": pn,
            "ps": ps,
            "order": order_mode,
        }
        return await self.get(uri, post_data)

    async def get_creator_info(self, creator_id: int) -> Dict:
        """
        get creator info
        :param creator_id: Creator ID
        """
        uri = "/x/space/wbi/acc/info"
        post_data = {
            "mid": creator_id,
        }
        return await self.get(uri, post_data)

    async def get_creator_fans(
        self,
        creator_id: int,
        pn: int,
        ps: int = 24,
    ) -> Dict:
        """
        get creator fans
        :param creator_id: Creator ID
        :param pn: Start page number
        :param ps: Number of items per page
        :return:
        """
        uri = "/x/relation/fans"
        post_data = {
            'vmid': creator_id,
            "pn": pn,
            "ps": ps,
            "gaia_source": "main_web",
        }
        return await self.get(uri, post_data)

    async def get_creator_followings(
        self,
        creator_id: int,
        pn: int,
        ps: int = 24,
    ) -> Dict:
        """
        get creator followings
        :param creator_id: Creator ID
        :param pn: Start page number
        :param ps: Number of items per page
        :return:
        """
        uri = "/x/relation/followings"
        post_data = {
            "vmid": creator_id,
            "pn": pn,
            "ps": ps,
            "gaia_source": "main_web",
        }
        return await self.get(uri, post_data)

    async def get_creator_dynamics(self, creator_id: int, offset: str = ""):
        """
        get creator comments
        :param creator_id: Creator ID
        :param offset: Parameter required for sending request
        :return:
        """
        uri = "/x/polymer/web-dynamic/v1/feed/space"
        post_data = {
            "offset": offset,
            "host_mid": creator_id,
            "platform": "web",
        }

        return await self.get(uri, post_data)

    async def get_creator_all_fans(
        self,
        creator_info: Dict,
        crawl_interval: float = 1.0,
        callback: Optional[Callable] = None,
        max_count: int = 100,
    ) -> List:
        """
        get creator all fans
        :param creator_info:
        :param crawl_interval:
        :param callback:
        :param max_count: Maximum number of fans to crawl for a creator

        :return: List of creator fans
        """
        creator_id = creator_info["id"]
        result = []
        pn = config.START_CONTACTS_PAGE
        while len(result) < max_count:
            fans_res: Dict = await self.get_creator_fans(creator_id, pn=pn)
            fans_list: List[Dict] = fans_res.get("list", [])

            pn += 1
            if len(result) + len(fans_list) > max_count:
                fans_list = fans_list[:max_count - len(result)]
            if callback:  # If there is a callback function, execute it
                await callback(creator_info, fans_list)
            await asyncio.sleep(crawl_interval)
            if not fans_list:
                break
            result.extend(fans_list)
        return result

    async def get_creator_all_followings(
        self,
        creator_info: Dict,
        crawl_interval: float = 1.0,
        callback: Optional[Callable] = None,
        max_count: int = 100,
    ) -> List:
        """
        get creator all followings
        :param creator_info:
        :param crawl_interval:
        :param callback:
        :param max_count: Maximum number of followings to crawl for a creator

        :return: List of creator followings
        """
        creator_id = creator_info["id"]
        result = []
        pn = config.START_CONTACTS_PAGE
        while len(result) < max_count:
            followings_res: Dict = await self.get_creator_followings(creator_id, pn=pn)
            followings_list: List[Dict] = followings_res.get("list", [])

            pn += 1
            if len(result) + len(followings_list) > max_count:
                followings_list = followings_list[:max_count - len(result)]
            if callback:  # If there is a callback function, execute it
                await callback(creator_info, followings_list)
            await asyncio.sleep(crawl_interval)
            if not followings_list:
                break
            result.extend(followings_list)
        return result

    async def get_creator_all_dynamics(
        self,
        creator_info: Dict,
        crawl_interval: float = 1.0,
        callback: Optional[Callable] = None,
        max_count: int = 20,
    ) -> List:
        """
        get creator all followings
        :param creator_info:
        :param crawl_interval:
        :param callback:
        :param max_count: Maximum number of dynamics to crawl for a creator

        :return: List of creator dynamics
        """
        creator_id = creator_info["id"]
        result = []
        offset = ""
        has_more = True
        while has_more and len(result) < max_count:
            dynamics_res = await self.get_creator_dynamics(creator_id, offset)
            dynamics_list: List[Dict] = dynamics_res["items"]
            has_more = dynamics_res["has_more"]
            offset = dynamics_res["offset"]
            if len(result) + len(dynamics_list) > max_count:
                dynamics_list = dynamics_list[:max_count - len(result)]
            if callback:
                await callback(creator_info, dynamics_list)
            await asyncio.sleep(crawl_interval)
            result.extend(dynamics_list)
        return result
