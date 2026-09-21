import asyncio
import os
import pathlib
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools/crawler/app/MediaCrawler"))
from media_platform.bilibili.client import BilibiliClient
from media_platform.bilibili.core import BilibiliCrawler
from tools.tien_do_tai import TienDo

class NativeUpgradeTests(unittest.IsolatedAsyncioTestCase):
    async def test_play_url_requests_dash_and_can_force_mp4_fallback(self):
        client = object.__new__(BilibiliClient)
        captured = []
        async def get(uri, params, **kwargs):
            captured.append(dict(params)); return {"ok": True}
        client.get = get
        with patch.dict(os.environ, {"BILI_QN": "120", "BILI_FNVAL": "4048"}):
            await client.get_video_play_url(1, 2)
            await client.get_video_play_url(1, 2, fnval=1)
        self.assertEqual(captured[0]["qn"], 120)
        self.assertEqual(captured[0]["fnval"], 4048)
        self.assertEqual(captured[1]["fnval"], 1)
        self.assertEqual(captured[0]["fourk"], 1)

    async def test_dash_selects_highest_avc_and_merges_video_audio(self):
        crawler = object.__new__(BilibiliCrawler)
        requested = []
        class Media:
            async def get_video_media(self, url, backup_urls=None):
                requested.append((url, backup_urls)); return (b"video" if "video" in url else b"audio") * 3000
        crawler.bili_client = Media()
        result = {"dash": {"video": [
            {"baseUrl": "https://cdn/video-720", "height": 720, "codecid": 7, "bandwidth": 20},
            {"baseUrl": "https://cdn/video-av1", "height": 1080, "codecid": 13, "bandwidth": 40},
            {"baseUrl": "https://cdn/video-avc", "height": 1080, "codecid": 7, "bandwidth": 30, "backupUrl": ["https://backup/video-avc"]}],
            "audio": [{"baseUrl": "https://cdn/audio", "bandwidth": 10}]}}
        def merge(args, **kwargs):
            pathlib.Path(args[-1]).write_bytes(b"merged" * 2000)
            return SimpleNamespace(returncode=0, stderr=b"")
        with patch.object(BilibiliCrawler, "_tim_ffmpeg", return_value="ffmpeg"), patch.object(subprocess, "run", side_effect=merge), patch.dict(os.environ, {"BILI_CODEC": "avc"}):
            output = await crawler._tai_dash_bili(result)
        self.assertTrue(output.startswith(b"merged"))
        self.assertEqual(requested[0], ("https://cdn/video-avc", ["https://backup/video-avc"]))
        self.assertEqual(requested[1][0], "https://cdn/audio")

    def test_progress_accepts_whole_file_total_for_parallel_segments(self):
        with patch.dict(os.environ, {"MC_TIENDO": "0"}):
            progress = TienDo("video", doan="0", tong=10, tong_file=100)
            progress.dat_da(10)
            progress.dong()

if __name__ == "__main__": unittest.main()
