# -*- coding: utf-8 -*-
"""
Mở cửa sổ Chrome Playwright (headless=False) để người dùng ĐĂNG NHẬP Google Gemini lần đầu.
Phiên đăng nhập được lưu persistent vào GEMINI_PROFILE_DIR.
"""
import os
import sys
import time
import tempfile
from playwright.sync_api import sync_playwright

# Tự trỏ Chromium về runtime/ms-playwright nếu thiếu env PLAYWRIGHT_BROWSERS_PATH
if not (os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip():
    try:
        _venv_dir = os.path.dirname(os.path.dirname(os.path.abspath(sys.executable)))  # ...\runtime\venv
        _bp = os.path.join(os.path.dirname(_venv_dir), "ms-playwright")                # ...\runtime\ms-playwright
        if os.path.isdir(_bp):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = _bp
    except Exception:
        pass

def main():
    profile = os.environ.get("GEMINI_PROFILE_DIR")
    if not profile:
        profile = os.path.join(tempfile.gettempdir(), "vc_gemini_profile")
    os.makedirs(profile, exist_ok=True)

    print("====================================================")
    print("MỞ TRÌNH DUYỆT ĐĂNG NHẬP GEMINI (PERSISTENT PROFILE)")
    print(f"Profile path: {profile}")
    print("Vui lòng đăng nhập tài khoản Google của bạn trên cửa sổ Chrome vừa mở.")
    print("Sau khi đăng nhập xong, bạn có thể đóng cửa sổ Chrome.")
    print("====================================================")

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile,
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox"
            ],
            viewport={"width": 1200, "height": 900}
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"Lỗi mở trang Gemini: {e}")

        print("\n[!] Đang chờ người dùng đóng trình duyệt...")
        while True:
            try:
                if not ctx.pages or page.is_closed():
                    break
                time.sleep(1)
            except Exception:
                break

        print("\n✔ Đã lưu phiên đăng nhập Gemini thành công.")
        try:
            ctx.close()
        except Exception:
            pass

if __name__ == "__main__":
    main()
