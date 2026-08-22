# -*- coding: utf-8 -*-
"""Chữa riêng onnxruntime bị cài/gỡ dở dang cho tiến trình RapidOCR."""
import os
import shutil
import subprocess
import sys


NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run(command, timeout=1800):
    return subprocess.run(command, check=True, timeout=timeout, creationflags=NO_WINDOW)


def ort_works():
    try:
        import onnxruntime as ort
        ort.__version__
        ort.SessionOptions()
        return True
    except Exception:
        return False


def has_nvidia():
    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"], capture_output=True, text=True,
            timeout=15, creationflags=NO_WINDOW
        )
        return result.returncode == 0 and "GPU" in (result.stdout or "")
    except Exception:
        return False


def repair_ort():
    if ort_works():
        print("onnxruntime vẫn dùng được — không cần sửa.", flush=True)
        return True
    package = "onnxruntime-gpu==1.22.0" if has_nvidia() else "onnxruntime==1.26.0"
    print(f"Đang cài sạch lại {package}…", flush=True)
    pip = [sys.executable, "-m", "pip"]
    try:
        run(pip + ["uninstall", "-y", "onnxruntime", "onnxruntime-gpu"], timeout=600)
    except Exception:
        pass
    try:
        run(pip + ["install", "--force-reinstall", "--no-cache-dir", "--no-deps", package])
    except Exception as error:
        uv = shutil.which("uv")
        if not uv:
            print(f"Không cài lại được onnxruntime: {error}", flush=True)
            return False
        try:
            run([uv, "pip", "install", "--python", sys.executable,
                 "--reinstall", "--no-cache", "--no-deps", package])
        except Exception as uv_error:
            print(f"Không cài lại được onnxruntime: {uv_error}", flush=True)
            return False
    # Tiến trình gọi sẽ purge sys.modules và kiểm tra lại sau khi script thoát.
    print("Đã cài lại onnxruntime.", flush=True)
    return True


if __name__ == "__main__":
    if "--sua-ort" not in sys.argv:
        print("Chỉ hỗ trợ --sua-ort", flush=True)
        raise SystemExit(2)
    raise SystemExit(0 if repair_ort() else 1)
