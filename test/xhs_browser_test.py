import asyncio
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

source = pathlib.Path(__file__).resolve().parents[1] / "tools/crawler/app/xhs_browser.py"
spec = importlib.util.spec_from_file_location("xhs_browser_test_target", source)
xhs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xhs)

class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_saves_article_title_without_share_token(self):
        import json
        browser = xhs.XHSBrowser("unused")
        page = AsyncMock()
        page.evaluate.return_value = {"title": "Trang diem - rednote", "thumbnail": "https://example.com/cover.jpg"}
        with tempfile.TemporaryDirectory() as tmp:
            output = str(pathlib.Path(tmp) / "note.mp4")
            await browser._luu_metadata_bai(page, "https://www.rednote.com/explore/abc?xsec_token=secret", output)
            record = json.loads(pathlib.Path(output + ".metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(record["title"], "Trang diem")
            self.assertNotIn("secret", record["url"])


    async def test_reads_note_tab_and_distinguishes_login_images_unavailable(self):
        browser = xhs.XHSBrowser("unused")
        class Page:
            def __init__(self, text, video=False, images=0):
                self.text, self.video, self.images = text, video, images
            async def inner_text(self, *args, **kwargs): return self.text
            async def evaluate(self, script):
                return self.images if "querySelectorAll" in script else self.video
        self.assertEqual(await browser._ly_do_hong(Page("Log in to view")), "tuong_login")
        self.assertEqual(await browser._ly_do_hong(Page("", images=3)), "anh")
        self.assertEqual(await browser._ly_do_hong(Page("note not found")), "token_het")
        self.assertEqual(await browser._ly_do_hong(Page("Log in to view", video=True)), "tai_loi")

    async def test_retries_login_only_and_preserves_original_profile(self):
        browser = xhs.XHSBrowser("original", headless=False)
        browser.last_failure = "tuong_login"
        browser._tai_explore_url = AsyncMock(return_value=False)
        contexts = []
        class Clean:
            def __init__(self, profile, **kwargs):
                self.profile, self.last_failure = profile, None
                contexts.append(self)
                self.headless = kwargs["headless"]
            async def __aenter__(self): return self
            async def __aexit__(self, *args): self.closed = True
            async def _tai_explore_url(self, href, output, **kwargs): return True
        with tempfile.TemporaryDirectory() as output, patch.object(xhs, "XHSBrowser", Clean):
            result = await browser.tai_theo_links(["https://www.rednote.com/explore/abc?xsec_token=test"], output)
        self.assertTrue(result["ok"])
        self.assertEqual(result["tai"], ["abc"])
        self.assertEqual(result["tom_tat"], {})
        self.assertEqual(browser.profile_dir, "original")
        self.assertFalse(contexts[0].headless)
        self.assertTrue(contexts[0].closed)
        self.assertFalse(pathlib.Path(contexts[0].profile).exists())

    async def test_persistent_login_retries_at_most_two_rounds(self):
        browser = xhs.XHSBrowser("original")
        browser.last_failure = "tuong_login"
        browser._tai_explore_url = AsyncMock(return_value=False)
        profiles = []
        class Clean:
            def __init__(self, profile, **kwargs):
                profiles.append(profile)
                self.last_failure = "tuong_login"
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def _tai_explore_url(self, *args, **kwargs): return False
        with tempfile.TemporaryDirectory() as output, patch.object(xhs, "XHSBrowser", Clean), patch.object(xhs.asyncio, "sleep", AsyncMock()):
            result = await browser.tai_theo_links(["https://www.rednote.com/explore/abc?xsec_token=test"], output)
        self.assertFalse(result["ok"])
        self.assertEqual(len(profiles), 2)
        self.assertEqual(result["tom_tat"], {"tuong_login": 1})
        self.assertEqual(result["loi"], ["abc"])
        self.assertTrue(all(not pathlib.Path(p).exists() for p in profiles))

    async def test_non_login_failure_does_not_retry(self):
        browser = xhs.XHSBrowser("original")
        browser.last_failure = "anh"
        browser._tai_explore_url = AsyncMock(return_value=False)
        with tempfile.TemporaryDirectory() as output, patch.object(xhs, "XHSBrowser") as clean:
            result = await browser.tai_theo_links(["https://www.rednote.com/explore/abc?xsec_token=test"], output)
        clean.assert_not_called()
        self.assertEqual(result["tom_tat"], {"anh": 1})

    async def test_no_stream_reports_reason_and_closes_page(self):
        browser = xhs.XHSBrowser("original")
        page = type("Page", (), {})()
        page.on = lambda *args: None
        page.goto = AsyncMock(return_value=None)
        page.wait_for_timeout = AsyncMock()
        page.evaluate = AsyncMock(return_value="")
        page.close = AsyncMock()
        browser.ctx = type("Context", (), {"new_page": AsyncMock(return_value=page)})()
        browser._ly_do_hong = AsyncMock(return_value="tuong_login")
        self.assertFalse(await browser._tai_explore_url("https://www.rednote.com/explore/abc", "unused.mp4"))
        self.assertEqual(browser.last_failure, "tuong_login")
        page.close.assert_awaited_once()

if __name__ == "__main__":
    unittest.main()
