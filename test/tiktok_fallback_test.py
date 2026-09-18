import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("tt_download", pathlib.Path(__file__).resolve().parents[1] / "tools/crawler/app/tai_ytdlp.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
URL = "https://www.tiktok.com/@tester/video/1234567890123456789?token=private"
ID = "1234567890123456789"

class FallbackTests(unittest.TestCase):
    def download(self, data, probe_streams):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "video.mp4"
            out.write_bytes(b"previous")
            replies = [io.BytesIO(json.dumps(data).encode()), io.BytesIO(b"x" * 100001)]
            with patch.object(m.urllib.request, "urlopen", side_effect=replies) as network, patch.object(m.shutil, "which", return_value="ffprobe"), patch.object(m.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps({"streams": probe_streams}))), patch("time.sleep"):
                ok = m._tai_tiktok_qua_api(URL, str(out), lambda text: None)
            self.assertNotIn("private", network.call_args_list[0].args[0].full_url)
            self.assertEqual(list(pathlib.Path(tmp).glob("*.part")), [])
            title = data.get("data", {}).get("title")
            if ok and title:
                named = pathlib.Path(tmp) / (m.an_toan(title) + " [" + ID + "].mp4")
                self.assertTrue(named.exists())
                self.assertEqual(out.read_bytes(), b"previous")
                return ok, named.read_bytes(), network.call_count
            return ok, out.read_bytes(), network.call_count

    def test_correct_id_and_video_commits_file(self):
        ok, body, calls = self.download({"code": 0, "data": {"id": ID, "duration": 12, "play": "https://cdn.tikwm.com/video.mp4"}}, [{"codec_type": "video"}])
        self.assertTrue(ok)
        self.assertEqual(len(body), 100001)
        self.assertEqual(calls, 2)

    def test_title_names_file_and_retains_id(self):
        ok, body, calls = self.download({"code": 0, "data": {"id": ID, "title": "Ca ngon: co an duoc khong?", "duration": 12, "play": "https://cdn.tikwm.com/video.mp4"}}, [{"codec_type": "video"}])
        self.assertTrue(ok)
        self.assertEqual(len(body), 100001)

    def test_wrong_id_never_downloads_media(self):
        ok, body, calls = self.download({"code": 0, "data": {"id": "wrong"}}, [])
        self.assertFalse(ok)
        self.assertEqual(body, b"previous")
        self.assertEqual(calls, 1)

    def test_audio_only_preserves_existing_file(self):
        ok, body, calls = self.download({"code": 0, "data": {"id": ID, "duration": 12, "play": "https://cdn.tikwm.com/video.mp4"}}, [])
        self.assertFalse(ok)
        self.assertEqual(body, b"previous")

    def test_browser_rejects_recommended_video_addresses(self):
        doc = json.dumps({"items": [
            {"id": ID, "video": {"playAddr": "https://cdn.example.com/correct"}},
            {"id": "other", "video": {"playAddr": "https://cdn.example.com/recommended"}}
        ]})
        self.assertEqual(m._tiktok_media_dung_bai([doc], ID), {"https://cdn.example.com/correct"})
        self.assertEqual(m._tiktok_media_dung_bai([doc], "unknown"), set())

    def test_preview_uses_article_url_not_cdn(self):
        item = m._item_tt({"id": ID, "url": "https://cdn.example.com/?mime_type=video_mp4", "webpage_url": URL})
        self.assertEqual(item["url"], URL.split("?")[0])
        item = m._item_tt({"id": ID, "url": "https://cdn.example.com/media", "uploader_id": "tester"})
        self.assertEqual(item["url"], URL.split("?")[0])

    def test_disabled_makes_no_request(self):
        with patch.dict(os.environ, {"TT_API_NGOAI": "0"}), patch.object(m.urllib.request, "urlopen") as network:
            self.assertFalse(m._tai_tiktok_qua_api(URL, "unused"))
            network.assert_not_called()

    def test_only_browser_failures_use_api(self):
        tasks = [(URL, "one"), (URL.replace(ID, "9999999999999999999"), "two")]
        with patch.dict(os.environ, {"TT_API_NGOAI": "1"}), patch.object(m, "_tai_tiktok_browser", return_value=[ID]), patch.object(m, "_tai_tiktok_qua_api", return_value=True) as api:
            self.assertEqual(m._tai_tiktok_du_phong(tasks), {ID, "9999999999999999999"})
            api.assert_called_once_with(tasks[1][0], "two", log_fn=None)

if __name__ == "__main__":
    unittest.main()
