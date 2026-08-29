# -*- coding: utf-8 -*-
"""Tiến độ tải hợp nhất cho MediaCrawler. Tắt bằng MC_TIENDO=0."""
import os
import threading
import time

_LOCK = threading.Lock()
_ITEMS = {}
_LAST_PRINT = 0.0
_LAST_PERCENT = -1


def _print_progress(force=False):
    global _LAST_PRINT, _LAST_PERCENT
    if not _ITEMS:
        return
    received = sum(item["received"] for item in _ITEMS.values())
    total = sum(item["total"] for item in _ITEMS.values())
    now = time.time()
    percent = min(100, int(received * 100 / total)) if total > 0 else -1
    if not force and now - _LAST_PRINT < 8 and (percent < 0 or percent < _LAST_PERCENT + 5):
        return
    elapsed = max(0.001, now - min(item["started"] for item in _ITEMS.values()))
    speed = received / elapsed / 1048576
    videos = len({item["video"] for item in _ITEMS.values()})
    label = "video" if videos <= 1 else f"{videos} video"
    if total > 0:
        print(f"LOG:📥 Đang tải {label}: {percent}% của {total / 1048576:.0f}MB ({speed:.1f}MB/s)", flush=True)
    else:
        print(f"LOG:📥 Đang tải {label}: {received / 1048576:.0f}MB ({speed:.1f}MB/s)", flush=True)
    _LAST_PRINT = now
    if percent >= 0:
        _LAST_PERCENT = percent


class TienDo:
    def __init__(self, ma, doan="", tong=0):
        self.video = str(ma or id(self))
        self.key = f"{self.video}#{doan}"
        self.enabled = os.environ.get("MC_TIENDO", "1") != "0"
        if self.enabled:
            with _LOCK:
                _ITEMS[self.key] = {"video": self.video, "received": 0, "total": int(tong or 0), "started": time.time()}
                _print_progress(True)

    def dat_tong(self, total):
        if not self.enabled:
            return
        with _LOCK:
            if self.key in _ITEMS and total:
                _ITEMS[self.key]["total"] = int(total)

    def dat_da(self, received):
        if not self.enabled:
            return
        with _LOCK:
            if self.key in _ITEMS:
                _ITEMS[self.key]["received"] = max(0, int(received))
                _print_progress()

    def them(self, amount):
        if not self.enabled or amount <= 0:
            return
        with _LOCK:
            if self.key in _ITEMS:
                _ITEMS[self.key]["received"] += int(amount)
                _print_progress()

    def dong(self):
        if self.enabled:
            with _LOCK:
                _ITEMS.pop(self.key, None)
            self.enabled = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.dong()
        return False
