import asyncio
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools/crawler/app/MediaCrawler"))
from media_platform.douyin.core import _la_ban_khoa, _media_path_parts
from media_platform.douyin.client import DouYinClient

def box(kind, body):
    return (len(body) + 8).to_bytes(4, "big") + kind + body

class UpgradeTests(unittest.IsolatedAsyncioTestCase):
    def test_encryption_only_detected_in_moov(self):
        self.assertFalse(_la_ban_khoa(box(b"mdat", b"encv enca cenc") + box(b"moov", b"avc1 mp4a")))
        self.assertTrue(_la_ban_khoa(box(b"moov", b"encv" + b"padding")))
        self.assertFalse(_la_ban_khoa(b"bad"))

    async def test_selected_keyword_source_group_is_preserved(self):
        with patch.dict("os.environ", {"MC_SOURCE_MODE": "search", "MC_SOURCE_INPUT": "original-keyword"}), patch("media_platform.douyin.core.dich_ten.dich_tieu_de", return_value="Title"):
            folder, filename = await _media_path_parts({"aweme_id": "123", "desc": "test"})
        self.assertEqual(folder, "tu-khoa/original-keyword")
        self.assertIn("123", filename)

    async def test_streaming_uses_compatible_progress_reporter(self):
        from unittest.mock import MagicMock
        body = b"\x00\x00\x00\x18ftyp" + b"x" * 128
        class Response:
            status_code = 200
            headers = {"content-length": str(len(body))}
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def aiter_bytes(self): yield body
        class HTTP:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def stream(self, *args, **kwargs): return Response()
        client = object.__new__(DouYinClient)
        client.proxy = None
        client.headers = {}
        with patch("media_platform.douyin.client.make_async_client", return_value=HTTP()), patch.dict("os.environ", {"MC_TIENDO": "0"}):
            result = await client.get_aweme_media("https://cdn.example.com/video.mp4")
        self.assertEqual(result, body)

    async def test_detail_and_mix_share_one_navigation_lock(self):
        client = object.__new__(DouYinClient)
        client._trang_khoa = None
        active, maximum = 0, 0
        async def navigate(value):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            await asyncio.sleep(0.01)
            active -= 1
            return value
        client._thd_lay_trong = navigate
        client._thmix_lay_trong = navigate
        result = await asyncio.gather(client._thd_lay("one"), client._thmix_lay("two"))
        self.assertEqual(result, ["one", "two"])
        self.assertEqual(maximum, 1)

if __name__ == "__main__":
    unittest.main()
