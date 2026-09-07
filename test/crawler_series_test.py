"""Offline tests. Never opens a browser or requests a platform endpoint."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1] / 'tools' / 'crawler' / 'app'


def load(name):
    spec = importlib.util.spec_from_file_location(name, APP / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


series = load('tiktok_series')
honggo = load('tai_honggo')


class SeriesTests(unittest.TestCase):
    def test_partial_manifest_contains_public_metadata_not_cookie_or_cdn(self):
        with tempfile.TemporaryDirectory(prefix='series-test-') as output:
            items = [{'id': '123', 'series_id': '999', 'so_tap': 1, 'ten': 'Tap 1', 'bo': 'A/B',
                      'url': 'https://cdn.invalid/video?token=secret', 'ck': {'sessionid': 'secret'}, 'expected_count': 3}]
            with patch.object(series, '_tiktok_bo_tu_video', return_value=items), patch.object(series, '_tai_phim_bo', return_value=1):
                result = series.run_series('https://www.tiktok.com/shortdrama/episode/999/1', 10, output)
            self.assertEqual(result['failed'], 2)
            text = (Path(output) / 'tiktok/jsonl/series_contents.jsonl').read_text(encoding='utf-8')
            self.assertNotIn('secret', text)
            self.assertNotIn('cdn.invalid', text)
            self.assertEqual(json.loads(text)['video_url'], 'https://www.tiktok.com/shortdrama/episode/999/1')

    def test_download_uses_final_valid_media_and_skips_only_valid_existing_file(self):
        with tempfile.TemporaryDirectory(prefix='series-file-test-') as output:
            body = b'\x00\x00\x00\x18ftypisom' + b'\0' * 120000
            response = types.SimpleNamespace(status_code=200, iter_content=lambda _: iter([body]), close=lambda: None)
            calls = []
            fake_requests = types.SimpleNamespace(get=lambda *args, **kwargs: (calls.append(args), response)[1])
            item = {'id': '123', 'ten': 'Tap 1', 'bo': 'A', 'url': 'https://cdn.invalid/video'}
            with patch.dict(sys.modules, {'requests': fake_requests}):
                self.assertEqual(series._tai_phim_bo([item], output, log=lambda _: None), 1)
                self.assertEqual(series._tai_phim_bo([item], output, log=lambda _: None), 1)
            self.assertEqual(len(calls), 1)
            self.assertTrue(series._valid_video(str(next(Path(output).glob('*.mp4')))))
            self.assertEqual(list(Path(output).glob('*.part')), [])

    def test_html_response_is_not_promoted_to_mp4(self):
        with tempfile.TemporaryDirectory(prefix='series-invalid-test-') as output:
            response = types.SimpleNamespace(status_code=200, iter_content=lambda _: iter([b'<html>' + b'x' * 120000]), close=lambda: None)
            with patch.dict(sys.modules, {'requests': types.SimpleNamespace(get=lambda *a, **k: response)}):
                count = series._tai_phim_bo([{'id': '123', 'ten': 'A', 'url': 'https://cdn.invalid'}], output, log=lambda _: None)
            self.assertEqual(count, 0)
            self.assertEqual(list(Path(output).glob('*.mp4')), [])

    def test_honggo_history_uses_stable_episode_id(self):
        with tempfile.TemporaryDirectory(prefix='honggo-test-') as output, patch.dict(os.environ, {'MC_DATA_DIR': output}):
            honggo._record_episode('123-1-2', 'Tap 2', 'https://www.hongguoapp.cn/vodplay/123-1-2.html', 'Series A')
            row = json.loads((Path(output) / 'honggo/jsonl/chase_contents.jsonl').read_text(encoding='utf-8'))
            self.assertEqual(row['video_id'], '123-1-2')
            self.assertEqual(row['source_mode'], 'chase')

    def test_single_episode_never_downloads_other_episodes(self):
        with tempfile.TemporaryDirectory(prefix='series-one-test-') as output:
            items = [{'id': str(n), 'series_id': '999', 'so_tap': n, 'ten': 'Tap %d' % n,
                      'bo': 'Demo', 'url': 'https://cdn.invalid/video', 'expected_count': 3} for n in (1, 2, 3)]
            with patch.object(series, '_tiktok_bo_tu_video', return_value=items), patch.object(series, '_tai_phim_bo', return_value=1) as download:
                result = series.run_series('https://www.tiktok.com/shortdrama/episode/999/2', 1, output, episode_only=True)
            self.assertEqual([item['id'] for item in download.call_args.args[0]], ['2'])
            self.assertEqual(result['total'], 1)
            self.assertEqual(result['failed'], 0)


if __name__ == '__main__':
    unittest.main()
