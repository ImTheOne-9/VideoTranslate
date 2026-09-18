import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("youtube_session", pathlib.Path(__file__).resolve().parents[1] / "tools/crawler/app/youtube_session.py")
y = importlib.util.module_from_spec(spec)
spec.loader.exec_module(y)
COOKIE = {"domain": ".youtube.com", "path": "/", "secure": True, "expires": 0, "name": "SAPISID", "value": "offline-test", "httpOnly": True}

class SessionTests(unittest.TestCase):
    def test_export_validates_login_and_filters_unrelated_domains(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "cookies.txt"
            self.assertEqual(y.write_cookies([COOKIE, {**COOKIE, "domain": ".example.com"}], out), 1)
            text = out.read_text()
            self.assertIn("#HttpOnly_.youtube.com", text)
            self.assertNotIn("example.com", text)
            with self.assertRaises(RuntimeError):
                y.write_cookies([{**COOKIE, "name": "visitor"}], out)
            self.assertEqual(out.read_text(), text)

    def test_cdp_failure_falls_back_to_snapshot_without_exposing_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "cookies.txt"
            with patch.object(y, "cookies_via_cdp", side_effect=RuntimeError("locked")), patch.object(y, "cookies_via_snapshot", return_value=[COOKIE]) as snapshot:
                result = y.export_cookies(out, profile=tmp)
            self.assertTrue(result["ok"])
            self.assertEqual(result["method"], "cookie-mirror")
            snapshot.assert_called_once()
            self.assertTrue(out.exists())

    def test_failed_export_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "cookies.txt"
            out.write_text("previous")
            with patch.object(y, "cookies_via_cdp", side_effect=RuntimeError("secret")), patch.object(y, "cookies_via_snapshot", side_effect=RuntimeError("secret")):
                with self.assertRaises(RuntimeError) as error:
                    y.export_cookies(out, profile=tmp)
            self.assertNotIn("secret", str(error.exception))
            self.assertEqual(out.read_text(), "previous")

    def test_postprocessor_changes_title_before_filename_and_keeps_id(self):
        from yt_dlp import YoutubeDL
        key = y.register_title_translation()
        downloader = YoutubeDL({"postprocessors": [{"key": key, "when": "pre_process"}]})
        with patch.object(y, "translate_title", return_value="Translated title"):
            info = downloader.pre_process({"title": "original", "id": "123"})[0]
        self.assertEqual(info["title"], "Translated title")
        self.assertEqual(info["id"], "123")

    def test_non_chinese_and_disabled_translation_keep_original(self):
        self.assertEqual(y.translate_title("English title"), "English title")
        with patch.dict(y.os.environ, {"YT_TRANSLATE_TITLES": "0"}):
            self.assertEqual(y.translate_title("中文标题"), "中文标题")

if __name__ == "__main__": unittest.main()
