# -*- coding: utf-8 -*-
"""Cài/sửa ONNX Runtime CUDA cho RapidOCR, có khôi phục CPU an toàn."""
import argparse
import glob
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
ORT_VERSION = "1.22.0"
MIN_COMPUTE_CAPABILITY = 6.1
MIN_DRIVER = 527.41
CUDA_PACKAGES = (
    "nvidia-cuda-runtime-cu12>=12,<13",
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12>=9,<10",
    "nvidia-cufft-cu12",
    "nvidia-curand-cu12",
)


def run(command, **kwargs):
    return subprocess.run(command, creationflags=NO_WINDOW, **kwargs)


def progress(percent, message):
    print("OCR_GPU_PROGRESS %d %s" % (int(percent), message), flush=True)


def emit_status(payload):
    print("OCR_GPU_JSON " + json.dumps(payload, ensure_ascii=False), flush=True)


def number(value):
    try:
        return float(str(value).strip())
    except Exception:
        return None


def inspect_hardware():
    result = {
        "nvidia": False, "supported": False, "gpuName": "",
        "computeCapability": None, "driver": None, "cudaChannel": None,
        "reason": "no_nvidia",
    }
    try:
        proc = run(
            ["nvidia-smi", "--query-gpu=name,compute_cap,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=20,
        )
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            # Một số driver cũ không hỗ trợ trường compute_cap nhưng vẫn có
            # thể chạy CUDA. Dò lại không có trường đó thay vì báo nhầm không GPU.
            proc = run(
                ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=20,
            )
            if proc.returncode != 0 or not (proc.stdout or "").strip():
                return result
            fallback = [part.strip() for part in (proc.stdout or "").splitlines()[0].split(",")]
            fields = [fallback[0] if fallback else "NVIDIA GPU", "", fallback[1] if len(fallback) > 1 else ""]
        else:
            fields = [part.strip() for part in (proc.stdout or "").splitlines()[0].split(",")]
        result["nvidia"] = True
        result["gpuName"] = fields[0] if fields else "NVIDIA GPU"
        result["computeCapability"] = number(fields[1]) if len(fields) > 1 else None
        result["driver"] = number(fields[2]) if len(fields) > 2 else None
        capability, driver = result["computeCapability"], result["driver"]
        if capability is not None and capability < MIN_COMPUTE_CAPABILITY:
            result["reason"] = "unsupported_compute_capability"
            return result
        if driver is not None and driver < MIN_DRIVER:
            result["reason"] = "driver_too_old"
            return result
        result["supported"] = True
        result["reason"] = "ok"
        result["cudaChannel"] = "cu128" if (capability or 0) >= 10.0 else "cu126"
        return result
    except Exception as error:
        result["reason"] = "nvidia_probe_failed"
        result["detail"] = str(error)[:300]
        return result


def add_cuda_dll_dirs():
    try:
        import importlib.util
        spec = importlib.util.find_spec("nvidia")
        roots = list(spec.submodule_search_locations or []) if spec else []
        for root in roots:
            for directory in glob.glob(os.path.join(root, "*", "bin")):
                if not os.path.isdir(directory):
                    continue
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(directory)
                os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def installed_ort_version():
    for distribution in ("onnxruntime-gpu", "onnxruntime"):
        try:
            return importlib.metadata.version(distribution), distribution
        except Exception:
            pass
    return "", ""


def rapidocr_models():
    import rapidocr
    root = os.path.dirname(rapidocr.__file__)
    return glob.glob(os.path.join(root, "**", "*det*.onnx"), recursive=True)


def probe_cuda_in_process():
    """Tạo ONNX Session thật bằng model RapidOCR, không chỉ hỏi provider có sẵn."""
    try:
        add_cuda_dll_dirs()
        import onnxruntime as ort
        models = rapidocr_models()
        if not models:
            return False, "Không tìm thấy model RapidOCR để kiểm tra CUDA", []
        session = ort.InferenceSession(
            models[0], providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
        )
        providers = list(session.get_providers())
        return "CUDAExecutionProvider" in providers, ",".join(providers), providers
    except Exception as error:
        return False, str(error)[:500], []


def cuda_session_status():
    try:
        result = run(
            [sys.executable, os.path.abspath(__file__), "--probe"],
            capture_output=True, text=True, timeout=300,
        )
        line = next((item[13:] for item in reversed((result.stdout or "").splitlines())
                     if item.startswith("OCR_GPU_JSON ")), "{}")
        payload = json.loads(line)
        return bool(payload.get("gpu")), str(payload.get("detail") or ""), payload.get("providers") or []
    except Exception as error:
        return False, str(error)[:500], []


def ort_imports():
    try:
        result = run(
            [sys.executable, "-c", "import onnxruntime as o; o.SessionOptions(); print(o.__version__)"],
            capture_output=True, text=True, timeout=180,
        )
        return result.returncode == 0, (result.stdout or result.stderr or "").strip()[:300]
    except Exception as error:
        return False, str(error)[:300]


def status_payload(runtime_root=""):
    hardware = inspect_hardware()
    gpu, detail, providers = cuda_session_status() if hardware["nvidia"] else (False, "", [])
    version, distribution = installed_ort_version()
    payload = {
        **hardware,
        "gpuReady": gpu,
        "provider": "CUDAExecutionProvider" if gpu else "CPUExecutionProvider",
        "providers": providers,
        "providerDetail": detail,
        "onnxruntimeVersion": version,
        "onnxruntimeDistribution": distribution,
        "enabled": gpu,
    }
    if runtime_root:
        payload["runtimeRoot"] = os.path.abspath(runtime_root)
    return payload


def write_status(runtime_root, payload):
    os.makedirs(runtime_root, exist_ok=True)
    target = os.path.join(runtime_root, "ocr-gpu-status.json")
    temporary = target + ".tmp"
    with open(temporary, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
    os.replace(temporary, target)


def pip_download(package, directory):
    run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", package, "-d", directory],
        check=True, timeout=3600)


def install_wheel(wheel):
    run([sys.executable, "-m", "pip", "install", "--force-reinstall", "--no-deps", wheel],
        check=True, timeout=1800)


def uninstall_ort():
    run([sys.executable, "-m", "pip", "uninstall", "-y", "onnxruntime", "onnxruntime-gpu"],
        timeout=600)


def restore_cpu(cpu_wheel):
    progress(92, "GPU chưa hoạt động; đang khôi phục ONNX Runtime CPU…")
    uninstall_ort()
    install_wheel(cpu_wheel)
    imported, detail = ort_imports()
    if not imported:
        raise RuntimeError("Không khôi phục được ONNX Runtime CPU: " + detail)


def install_gpu(args):
    hardware = inspect_hardware()
    if not hardware["nvidia"] or not hardware["supported"]:
        payload = status_payload(args.runtime_root)
        write_status(args.runtime_root, payload)
        emit_status(payload)
        return 0

    ready, _, _ = cuda_session_status()
    if ready:
        payload = status_payload(args.runtime_root)
        write_status(args.runtime_root, payload)
        progress(100, "RapidOCR GPU đã sẵn sàng.")
        emit_status(payload)
        return 0

    uv = args.uv or shutil.which("uv") or "uv"
    cache = os.path.join(args.runtime_root, "cache", "ocr-gpu-wheels")
    os.makedirs(cache, exist_ok=True)
    progress(5, "Đã xác nhận GPU NVIDIA và driver.")
    runtime_free = shutil.disk_usage(args.runtime_root).free
    temp_free = shutil.disk_usage(os.environ.get("TEMP") or args.runtime_root).free
    if runtime_free < 2_500_000_000 or temp_free < 1_000_000_000:
        raise RuntimeError(
            "Không đủ dung lượng để cài GPU (cần khoảng 2.5 GB tại runtime và 1 GB tại TEMP)"
        )
    # Tải đủ cả GPU lẫn CPU dự phòng trước khi đụng tới runtime đang chạy.
    progress(12, "Đang tải ONNX Runtime GPU và bản CPU dự phòng…")
    pip_download("onnxruntime-gpu==" + ORT_VERSION, cache)
    pip_download("onnxruntime==" + ORT_VERSION, cache)
    gpu_wheels = glob.glob(os.path.join(cache, "onnxruntime_gpu-*.whl"))
    cpu_wheels = [item for item in glob.glob(os.path.join(cache, "onnxruntime-*.whl"))
                  if "onnxruntime_gpu-" not in os.path.basename(item)]
    if not gpu_wheels or not cpu_wheels:
        raise RuntimeError("Không tải đủ wheel GPU và CPU dự phòng")

    progress(35, "Đang cài CUDA Runtime, cuBLAS và cuDNN…")
    run([uv, "pip", "install", "--python", sys.executable, *CUDA_PACKAGES],
        check=True, timeout=5400)
    progress(70, "Đang chuyển RapidOCR sang ONNX Runtime GPU…")
    uninstall_ort()
    try:
        install_wheel(gpu_wheels[-1])
        imported, import_detail = ort_imports()
        if not imported:
            raise RuntimeError("onnxruntime-gpu không nạp được: " + import_detail)
        ready, provider_detail, _ = cuda_session_status()
        if not ready:
            raise RuntimeError("CUDAExecutionProvider không chạy được: " + provider_detail)
    except Exception as error:
        restore_cpu(cpu_wheels[-1])
        payload = status_payload(args.runtime_root)
        payload["installError"] = str(error)[:500]
        payload["restoredCpu"] = True
        write_status(args.runtime_root, payload)
        progress(100, "GPU không tương thích; đã khôi phục CPU an toàn.")
        emit_status(payload)
        return 0

    progress(94, "Đang kiểm thử model RapidOCR trên CUDA…")
    payload = status_payload(args.runtime_root)
    payload["installedBy"] = "video-studio-ocr-gpu-manager"
    payload["restoredCpu"] = False
    write_status(args.runtime_root, payload)
    progress(100, "RapidOCR GPU đã sẵn sàng.")
    emit_status(payload)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uv", default="")
    parser.add_argument("--runtime-root", default="")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if args.probe:
        ready, detail, providers = probe_cuda_in_process()
        emit_status({"gpu": ready, "detail": detail, "providers": providers})
        return 0 if ready else 1
    if not args.runtime_root:
        parser.error("--runtime-root is required")
    if args.status:
        payload = status_payload(args.runtime_root)
        write_status(args.runtime_root, payload)
        emit_status(payload)
        return 0
    return install_gpu(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("OCR_GPU_STATUS INSTALL_ERROR " + str(error), file=sys.stderr, flush=True)
        raise
