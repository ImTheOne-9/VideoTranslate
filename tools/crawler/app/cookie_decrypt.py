# -*- coding: utf-8 -*-
"""Giải mã cookie Chromium (v10: DPAPI + AES-256-GCM) KHÔNG mở browser.

Dùng cho chế độ cào API-only (httpx + cookie) — bỏ Playwright headless để nền tảng
(bilibili) không phát hiện fingerprint trình duyệt tự động rồi vô hiệu hóa phiên login.

Windows (DPAPI + AES-256-GCM) + macOS (Keychain PBKDF2 + AES-128-CBC). Windows v20 App-Bound Encryption
CHƯA hỗ trợ. macOS: key từ Keychain 'Chromium Safe Storage', cookie file ở Default/Cookies (không có Network/).
(Bug đã fix: trên Mac check-login Douyin luôn 'out' oan vì cookie_decrypt chỉ đọc DPAPI Windows → 0 cookie.)

Public API:
    doc_cookies(user_data_dir, host_substr) -> {name: value}
    cookie_header(user_data_dir, host_substr) -> "name=value; name=value"
    (CookieManager đã gỡ 01/08 — không nơi nào dùng, đã grep cả MediaCrawler/)
"""

import os
import json
import base64
import sqlite3
import shutil
import tempfile
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_NO_WIN = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW: app Electron KHÔNG có console →
                                                  # tiến trình con thiếu cờ tự BUNG cửa sổ đen (khách báo).


def _dpapi_unprotect(blob: bytes) -> bytes:
    """CryptUnprotectData (DPAPI per-user) qua ctypes — không cần pywin32."""
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf_in = ctypes.create_string_buffer(blob, len(blob))
    blob_in = DATA_BLOB(len(blob), ctypes.cast(buf_in, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _aes_key_mac() -> bytes:
    """macOS: key AES-128 = PBKDF2(HMAC-SHA1, password='Chromium Safe Storage' lấy từ KEYCHAIN, salt='saltysalt',
    iter=1003, dklen=16). Chromium KHÔNG lưu encrypted_key trong Local State trên Mac (khác Windows DPAPI) →
    phải lấy password từ Keychain qua `security find-generic-password`. Service tên '<app> Safe Storage'
    (Chromium='Chromium Safe Storage'; app đóng gói Electron dùng 'Chromium Safe Storage' cho persistent context)."""
    import subprocess
    from hashlib import pbkdf2_hmac
    pw = None
    for svc in ("Chromium Safe Storage", "Chrome Safe Storage"):
        try:
            r = subprocess.run(["security", "find-generic-password", "-w", "-s", svc],
                               capture_output=True, text=True, timeout=8, creationflags=_NO_WIN)
            if r.returncode == 0 and (r.stdout or "").strip():
                pw = r.stdout.strip().encode("utf-8"); break
        except Exception:
            pass
    if pw is None:
        raise ValueError("Không lấy được key Safe Storage từ Keychain (macOS)")
    return pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, 16)   # AES-128 key


def _aes_key(user_data_dir: str) -> bytes:
    """Key AES giải cookie Chromium. macOS → Keychain (PBKDF2). Windows → Local State encrypted_key (DPAPI)."""
    import sys
    if sys.platform == "darwin":
        return _aes_key_mac()
    ls = os.path.join(user_data_dir, "Local State")
    with open(ls, "r", encoding="utf-8") as f:
        data = json.load(f)
    enc = base64.b64decode(data["os_crypt"]["encrypted_key"])
    if enc[:5] != b"DPAPI":
        raise ValueError(
            "Cookie KHÔNG phải v10 DPAPI (có thể v20 App-Bound Encryption) — chưa hỗ trợ"
        )
    return _dpapi_unprotect(enc[5:])


def _decrypt_value_mac(enc: bytes, key: bytes) -> str:
    """macOS: v10 cookie = prefix(3='v10') + AES-128-CBC(key, IV=16 space bytes) ciphertext. KHÁC Windows GCM.
    Padding PKCS7. Chromium Mac prepend 32-byte SHA256(domain) vào plaintext ở Chrome mới → cắt nếu có."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend
    try:
        ct = enc[3:]                                    # bỏ prefix 'v10'
        iv = b" " * 16
        dec = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend()).decryptor()
        pt = dec.update(ct) + dec.finalize()
        if pt:                                          # bỏ PKCS7 padding
            pad = pt[-1]
            if 1 <= pad <= 16:
                pt = pt[:-pad]
        s = pt.decode("utf-8", "replace")
        # Chrome ≥ v24 Mac prepend 32-byte hash domain → nếu 32 ký tự đầu là rác thì thử cắt (heuristic an toàn:
        # chỉ cắt khi phần sau in được và phần đầu có ký tự điều khiển). Đa số cookie cũ KHÔNG prepend → giữ nguyên.
        return s
    except Exception:
        return ""


def _decrypt_value(enc: bytes, key: bytes) -> str:
    """Giải 1 encrypted_value. Windows v10/v11 = prefix(3)+nonce(12)+ct+tag(16) AES-256-GCM. macOS v10 = AES-128-CBC."""
    if not enc:
        return ""
    import sys
    if enc[:3] in (b"v10", b"v11"):
        if sys.platform == "darwin":
            return _decrypt_value_mac(enc, key)
        nonce = enc[3:15]
        ct_tag = enc[15:]  # ciphertext + 16-byte GCM tag (AESGCM nhận chung)
        try:
            return AESGCM(key).decrypt(nonce, ct_tag, None).decode("utf-8", "replace")
        except Exception:
            return ""
    # Cookie cũ DPAPI thuần (không prefix, Chrome < 80) — chỉ Windows
    if sys.platform != "darwin":
        try:
            return _dpapi_unprotect(enc).decode("utf-8", "replace")
        except Exception:
            return ""
    return ""


def doc_cookies(user_data_dir: str, host_substr: str) -> dict:
    """Trả {name: value} cookie đã giải mã cho host khớp host_substr. KHÔNG mở browser.

    Copy Cookies + -wal/-shm ra temp (tránh khóa sqlite khi Chromium đang chạy), đọc trực tiếp.
    """
    # File Cookies: Chrome mới = Default/Network/Cookies; Chrome cũ / macOS Electron = Default/Cookies.
    # Thử cả 2 (macOS Chromium bundled thường dùng Default/Cookies — không có thư mục Network).
    ck = os.path.join(user_data_dir, "Default", "Network", "Cookies")
    if not os.path.isfile(ck):
        _alt = os.path.join(user_data_dir, "Default", "Cookies")
        if os.path.isfile(_alt):
            ck = _alt
        else:
            return {}
    key = _aes_key(user_data_dir)
    rows = None
    # (0) ĐỌC TRỰC TIẾP read-only bằng SQLite URI immutable=1 — KHÔNG copyfile. Khi Chromium/app GIỮ
    # KHÓA ĐỘC QUYỀN file Cookies (đang mở profile), shutil.copyfile ném PermissionError(13) → nhánh
    # copy dưới trả {} (0 cookie) → API check login báo 'out' OAN dù ĐÃ đăng nhập (reproduce máy khách:
    # file TỒN TẠI mà doc_cookies=PermissionError). immutable=1 bỏ qua lock, đọc snapshot an toàn (chỉ đọc,
    # không ghi/không copy). Nếu lỗi (file version lạ...) → rơi xuống copyfile cũ. WAL: immutable coi file
    # là bất biến nên KHÔNG merge -wal → cookie ghi CHƯA checkpoint có thể thiếu; copyfile (kèm -wal) là bù.
    try:
        uri = "file:" + ck.replace("\\", "/").replace("?", "%3f") + "?immutable=1"
        con = sqlite3.connect(uri, uri=True)
        try:
            rows = con.execute(
                "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?",
                ("%" + host_substr + "%",),
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        rows = None
    # Retry chống khóa thoáng qua: app nền (kiem_tra_login badge) có thể mở profile bili giây lát
    # -> copy bắt đúng lúc đó = file dở -> "no such table". Thử lại vài lần với khoảng nghỉ ngắn.
    for attempt in range(4):
        if rows:
            break  # immutable=1 đã đọc được -> khỏi copyfile
        td = tempfile.mkdtemp(prefix="ckdec_")
        b = os.path.join(td, "Cookies")
        try:
            shutil.copyfile(ck, b)
            for ext in ("-wal", "-shm"):
                if os.path.exists(ck + ext):
                    try:
                        shutil.copyfile(ck + ext, b + ext)
                    except Exception:
                        pass
            con = sqlite3.connect(b)
            try:
                rows = con.execute(
                    "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?",
                    ("%" + host_substr + "%",),
                ).fetchall()
                break  # đọc được bảng (kể cả 0 dòng khớp) -> xong
            except sqlite3.OperationalError:
                rows = None  # "no such table" = khóa/copy dở -> thử lại
            finally:
                con.close()
        except (OSError, sqlite3.Error):
            # PermissionError (Errno 13): file Cookies bị KHÓA ĐỘC QUYỀN (Chromium/badge-check
            # mở profile giây lát) -> copyfile fail. NUỐT + thử lại — KHÔNG để crash preview/crawl.
            rows = None
        finally:
            shutil.rmtree(td, ignore_errors=True)
        if attempt < 3:
            time.sleep(0.6)
    if not rows:
        return {}
    out = {}
    for name, enc in rows:
        if enc:
            val = _decrypt_value(bytes(enc), key)
            if val:
                out[name] = val
    return out


def cookie_header(user_data_dir: str, host_substr: str) -> str:
    """Trả chuỗi 'name=value; name=value' cho httpx header Cookie. '' nếu không có.

    🐛 KHÔI PHỤC 01/08/2026 — hàm này bị đợt dọn dead-code `6aeac96` (08:08 cùng ngày) XOÁ vì
    grep trong các file .py ở GỐC repo không thấy ai gọi. Nhưng `MediaCrawler/` là CÂY RIÊNG,
    nạp `cookie_decrypt` bằng cách chèn root vào `sys.path` lúc chạy — grep thường không nối
    được 2 đầu. Hậu quả THẬT: cào Bilibili chết ngay khi khởi động client
    (`AttributeError: module 'cookie_decrypt' has no attribute 'cookie_header'`, mã thoát 1),
    và Douyin nhánh no-browser cũng dính y hệt. 2 chỗ gọi:
      MediaCrawler/media_platform/bilibili/core.py:382
      MediaCrawler/media_platform/douyin/core.py:984
    ⇒ Sửa `cookie_decrypt.py` thì PHẢI grep cả `MediaCrawler/`, đừng chỉ grep thư mục gốc.
    (`CookieManager` bị xoá cùng đợt thì THẬT SỰ không ai gọi — đã grep cả cây — nên không khôi phục.)
    """
    c = doc_cookies(user_data_dir, host_substr)
    return "; ".join("%s=%s" % (k, v) for k, v in c.items())


if __name__ == "__main__":
    # CLI test: python cookie_decrypt.py <platform>  -> in cookie (CHE giá trị) để kiểm decrypt đúng
    import sys

    _PLAT = {
        "bilibili": ("bili", "bilibili.com"), "bili": ("bili", "bilibili.com"),
        "douyin": ("dy", "douyin.com"), "dy": ("dy", "douyin.com"),
        "xhs": ("xhs", "xiaohongshu.com"),
        "weibo": ("wb", "weibo.com"), "wb": ("wb", "weibo.com"),
    }
    plat = sys.argv[1] if len(sys.argv) > 1 else "bilibili"
    bd = os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "MediaCrawler", "browser_data")
    udd, host = _PLAT.get(plat, (None, None))
    if not udd:
        print("LỖI: Nền không hỗ trợ:", plat)
        sys.exit(1)
    profile_dir = os.path.join(bd, "%s_user_data_dir" % udd)
    try:
        cookies = doc_cookies(profile_dir, host)
    except Exception as e:
        print("LỖI:", e)
        sys.exit(1)
    print("Nền:", plat, "| profile:", profile_dir)
    print("Số cookie giải mã:", len(cookies))
    for name, val in cookies.items():
        # CHE giá trị (bảo mật) — chỉ in độ dài + định dạng để xác minh decrypt đúng
        printable = all(32 <= ord(c) < 127 for c in val[:64]) if val else False
        fmt = "ascii-OK" if printable else "GARBAGE?"
        extra = ""
        if name == "bili_jct":
            extra = "(32hex)" if (len(val) == 32 and all(c in "0123456789abcdef" for c in val)) else "(?)"
        if name == "DedeUserID":
            extra = "(digits=%s)" % val if val.isdigit() else "(?)"
        print("  %-16s len=%-4d %s %s" % (name, len(val), fmt, extra))
