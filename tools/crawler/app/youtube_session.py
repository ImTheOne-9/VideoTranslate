"""YouTube cookie export through the app-owned Chrome profile."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time

LOGIN_NAMES = {"SID", "SAPISID", "LOGIN_INFO", "__Secure-3PAPISID"}


def profile_dir():
    base = os.environ.get("MC_BROWSER_DATA_DIR") or str(Path(__file__).parent / "MediaCrawler/browser_data")
    return Path(base) / "yt_user_data_dir"


def chrome_path():
    for candidate in (
        os.environ.get("YOUTUBE_CHROME_PATH"), shutil.which("chrome"),
        str(Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"),
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def write_cookies(cookies, destination):
    cookies = [c for c in cookies if str(c.get("domain", "")).lstrip(".") in ("youtube.com", "google.com")
               or str(c.get("domain", "")).endswith((".youtube.com", ".google.com"))]
    if not any(c.get("name") in LOGIN_NAMES and c.get("value") for c in cookies):
        raise RuntimeError("Không thấy cookie đăng nhập YouTube. Hãy đăng nhập YouTube trước.")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".yt-cookie-", dir=str(destination.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("# Netscape HTTP Cookie File\n")
            for c in cookies:
                domain = c["domain"]
                fields = ["#HttpOnly_" + domain if c.get("httpOnly") else domain,
                          "TRUE" if domain.startswith(".") else "FALSE", c.get("path") or "/",
                          "TRUE" if c.get("secure") else "FALSE", str(max(0, int(c.get("expires") or 0))),
                          c["name"], c["value"]]
                if any("\n" in str(v) or "\r" in str(v) or "\t" in str(v) for v in fields):
                    continue
                handle.write("\t".join(fields) + "\n")
        os.replace(temporary, destination)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()
    return len(cookies)


def cookies_via_cdp(profile):
    chrome = chrome_path()
    if not chrome:
        raise RuntimeError("Không tìm thấy Google Chrome.")
    port_file = Path(profile) / "DevToolsActivePort"
    # Never attach to a browser the user already opened.
    port_file.unlink(missing_ok=True)
    proc = subprocess.Popen([chrome, "--headless=new", "--remote-debugging-port=0",
                             "--user-data-dir=" + str(profile), "--no-first-run",
                             "--no-default-browser-check", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if port_file.exists():
                break
            if proc.poll() is not None:
                raise RuntimeError("Chrome đang giữ hồ sơ YouTube. Đóng cửa sổ đăng nhập rồi thử lại.")
            time.sleep(0.2)
        if not port_file.exists():
            raise RuntimeError("Không kết nối được Chrome. Đóng cửa sổ đăng nhập YouTube rồi thử lại.")
        port = int(port_file.read_text().splitlines()[0])
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp("http://127.0.0.1:%d" % port, timeout=10000)
            try:
                cookies = browser.contexts[0].cookies()
            finally:
                browser.close()
        return cookies
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


def cookies_via_snapshot(profile):
    """Read a temporary mirror; a locked cookie DB cannot abort the public download."""
    profile = Path(profile)
    with tempfile.TemporaryDirectory(prefix="vst-yt-cookie-mirror-") as tmp:
        mirror = Path(tmp)
        state = profile / "Local State"
        if state.exists():
            shutil.copy2(state, mirror / "Local State")
        found = False
        for relative in ("Default/Network/Cookies", "Default/Cookies", "Network/Cookies", "Cookies"):
            source = profile / relative
            if not source.is_file():
                continue
            target = mirror / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(source.resolve().as_uri() + "?immutable=1", uri=True) as src:
                with sqlite3.connect(str(target)) as dst:
                    src.backup(dst)
            found = True
        if not found:
            raise RuntimeError("Hồ sơ YouTube chưa có dữ liệu cookie.")
        from yt_dlp.cookies import extract_cookies_from_browser
        jar = extract_cookies_from_browser("chrome", str(mirror))
        return [{"domain": c.domain, "path": c.path, "secure": c.secure,
                 "expires": c.expires or 0, "name": c.name, "value": c.value}
                for c in jar]


def export_cookies(destination, profile=None):
    profile = Path(profile or profile_dir())
    if not profile.is_dir():
        raise RuntimeError("Chưa có hồ sơ YouTube. Hãy bấm Đăng nhập YouTube trước.")
    try:
        cookies = cookies_via_cdp(profile)
        count = write_cookies(cookies, destination)
        return {"ok": True, "count": count, "method": "chrome-cdp"}
    except Exception:
        try:
            count = write_cookies(cookies_via_snapshot(profile), destination)
            return {"ok": True, "count": count, "method": "cookie-mirror"}
        except Exception:
            raise RuntimeError("Không đọc được cookie đăng nhập YouTube. Đóng Chrome đăng nhập rồi thử lại; nếu vẫn lỗi, đăng nhập lại YouTube.") from None


def open_login():
    chrome = chrome_path()
    if not chrome:
        raise RuntimeError("Cần cài Google Chrome để đăng nhập YouTube.")
    profile = profile_dir()
    profile.mkdir(parents=True, exist_ok=True)
    subprocess.Popen([chrome, "--user-data-dir=" + str(profile), "--no-first-run",
                      "--no-default-browser-check", "https://www.youtube.com/"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def translate_title(title):
    import re
    if not re.search(r"[\u3400-\u9fff]", title or "") or os.environ.get("YT_TRANSLATE_TITLES", "1") == "0":
        return title
    try:
        import sys
        crawler = str(Path(__file__).parent / "MediaCrawler")
        if crawler not in sys.path:
            sys.path.insert(0, crawler)
        from tools.dich_ten import dich_tieu_de
        return dich_tieu_de(title, "youtube") or title
    except Exception:
        return title


def register_title_translation():
    from yt_dlp.postprocessor.common import PostProcessor
    import yt_dlp.postprocessor
    class VideoStudioYTTitlePP(PostProcessor):
        def run(self, info):
            info["title"] = translate_title(info.get("title") or "")
            return [], info
    yt_dlp.postprocessor.VideoStudioYTTitlePP = VideoStudioYTTitlePP
    yt_dlp.postprocessor.postprocessors.value["VideoStudioYTTitlePP"] = VideoStudioYTTitlePP
    return "VideoStudioYTTitle"


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=("export", "login"), default="export")
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        if args.action == "login":
            open_login()
            result = {"ok": True}
        else:
            if not args.output:
                raise RuntimeError("Thiếu đường dẫn lưu cookie.")
            result = export_cookies(args.output)
    except Exception as error:
        result = {"ok": False, "msg": str(error)}
    print(json.dumps(result, ensure_ascii=False))
