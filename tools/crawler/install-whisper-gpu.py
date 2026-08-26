# -*- coding: utf-8 -*-
"""Install, repair and verify CTranslate2 CUDA with a real Whisper inference."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MIN_COMPUTE_CAPABILITY = 6.1
MIN_DRIVER = 527.41
CUDA_PACKAGES = (
    "nvidia-cuda-runtime-cu12>=12,<13",
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12>=9,<10",
)


def run(command, **kwargs):
    return subprocess.run(command, creationflags=NO_WINDOW, **kwargs)


def progress(percent, message):
    print("WHISPER_GPU_PROGRESS %d %s" % (int(percent), message), flush=True)


def emit(payload):
    print("WHISPER_GPU_JSON " + json.dumps(payload, ensure_ascii=False), flush=True)


def number(value):
    try:
        return float(str(value).strip())
    except Exception:
        return None


def hardware_status():
    result = {"nvidia": False, "supported": False, "gpuName": "", "driver": None,
              "computeCapability": None, "reason": "no_nvidia"}
    try:
        proc = run(["nvidia-smi", "--query-gpu=name,compute_cap,driver_version",
                    "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            proc = run(["nvidia-smi", "--query-gpu=name,driver_version",
                        "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
            if proc.returncode != 0 or not (proc.stdout or "").strip():
                return result
            fallback = [part.strip() for part in proc.stdout.splitlines()[0].split(",")]
            fields = [fallback[0], "", fallback[1] if len(fallback) > 1 else ""]
        else:
            fields = [part.strip() for part in proc.stdout.splitlines()[0].split(",")]
        result.update(nvidia=True, gpuName=fields[0] or "NVIDIA GPU",
                      computeCapability=number(fields[1]) if len(fields) > 1 else None,
                      driver=number(fields[2]) if len(fields) > 2 else None)
        if result["computeCapability"] is not None and result["computeCapability"] < MIN_COMPUTE_CAPABILITY:
            result["reason"] = "unsupported_compute_capability"
        elif result["driver"] is not None and result["driver"] < MIN_DRIVER:
            result["reason"] = "driver_too_old"
        else:
            result.update(supported=True, reason="ok")
    except Exception as error:
        result.update(reason="nvidia_probe_failed", detail=str(error)[:400])
    return result


def package_version(name):
    try:
        return importlib.metadata.version(name)
    except Exception:
        return ""


def resolve_model(model_root):
    root = Path(model_root).resolve()
    required = ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json")
    candidates = [root / "large-v3-turbo"]
    snapshots = root / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo" / "snapshots"
    if snapshots.is_dir():
        candidates.extend(item for item in snapshots.iterdir() if item.is_dir())
    return next((item for item in candidates if all((item / name).is_file() for name in required)), None)


def runtime_fingerprint(model_root, hardware):
    model = resolve_model(model_root)
    model_file = model / "model.bin" if model else None
    stat = model_file.stat() if model_file and model_file.is_file() else None
    return {
        "modelSize": stat.st_size if stat else 0,
        "modelMtimeNs": stat.st_mtime_ns if stat else 0,
        "driver": hardware.get("driver"),
        "ctranslate2": package_version("ctranslate2"),
        "fasterWhisper": package_version("faster-whisper"),
        "cudaRuntime": package_version("nvidia-cuda-runtime-cu12"),
        "cublas": package_version("nvidia-cublas-cu12"),
        "cudnn": package_version("nvidia-cudnn-cu12"),
    }


def write_status(runtime_root, payload):
    target = Path(runtime_root).resolve() / "whisper-gpu-status.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, target)


def read_status(runtime_root):
    try:
        return json.loads((Path(runtime_root).resolve() / "whisper-gpu-status.json").read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def write_probe_wav(path):
    sample_rate = 16000
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        samples = [int(250 * math.sin(2 * math.pi * 220 * index / sample_rate)) for index in range(sample_rate)]
        stream.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))


def probe_in_process(model_root, app_root):
    sys.path.insert(0, str(Path(app_root).resolve()))
    from whisper_cuda_runtime import configure_cuda_dlls
    dll = configure_cuda_dlls()
    try:
        import onnxruntime as ort
        ort.SessionOptions()
        import ctranslate2
        from faster_whisper import WhisperModel
        model_path = resolve_model(model_root)
        if not model_path:
            return {"gpuReady": False, "reason": "model_required", "detail": "Thiếu model Large V3 Turbo", "dll": dll}
        if ctranslate2.get_cuda_device_count() < 1:
            return {"gpuReady": False, "reason": "cuda_unavailable", "detail": "CTranslate2 không thấy CUDA", "dll": dll}
        model = WhisperModel(str(model_path), device="cuda", compute_type="int8_float16", local_files_only=True)
        with tempfile.TemporaryDirectory(prefix="vst-whisper-gpu-") as directory:
            audio = Path(directory) / "probe.wav"
            write_probe_wav(audio)
            segments, _ = model.transcribe(str(audio), language="en", vad_filter=False,
                                           condition_on_previous_text=False, beam_size=1)
            list(segments)
        return {"gpuReady": True, "reason": "ready", "detail": "Large V3 Turbo inference CUDA thành công",
                "actualInference": True, "device": "cuda", "computeType": "int8_float16", "dll": dll}
    except Exception as error:
        return {"gpuReady": False, "reason": "inference_failed", "detail": str(error)[:800],
                "actualInference": False, "dll": dll}


def isolated_probe(args):
    try:
        proc = run([sys.executable, os.path.abspath(__file__), "--probe", "--model-root", args.model_root,
                    "--app-root", args.app_root], capture_output=True, text=True, timeout=600)
        line = next((item[len("WHISPER_GPU_JSON "):] for item in reversed((proc.stdout or "").splitlines())
                     if item.startswith("WHISPER_GPU_JSON ")), "{}")
        payload = json.loads(line)
        if not payload:
            payload = {"gpuReady": False, "reason": "probe_failed",
                       "detail": (proc.stderr or proc.stdout or "Không có kết quả kiểm tra")[-800:]}
        return payload
    except Exception as error:
        return {"gpuReady": False, "reason": "probe_failed", "detail": str(error)[:800]}


def import_probe(module_code):
    proc = run([sys.executable, "-c", module_code], capture_output=True, text=True, timeout=180)
    return proc.returncode == 0, (proc.stdout or proc.stderr or "").strip()[-500:]


def repair_runtime(args):
    uv = args.uv or shutil.which("uv") or "uv"
    progress(12, "Đang kiểm tra và tự sửa Faster-Whisper runtime…")
    ort_ok, _ = import_probe("import onnxruntime as o; o.SessionOptions(); print(o.__version__)")
    if not ort_ok:
        gpu_ort = bool(package_version("onnxruntime-gpu"))
        package = "onnxruntime-gpu==1.22.0" if gpu_ort else "onnxruntime==1.26.0"
        run([uv, "pip", "uninstall", "--python", sys.executable, "onnxruntime", "onnxruntime-gpu"], timeout=600)
        try:
            run([uv, "pip", "install", "--python", sys.executable, "--reinstall", package], check=True, timeout=1800)
        except Exception:
            if not gpu_ort:
                raise
        ort_ok, _ = import_probe("import onnxruntime as o; o.SessionOptions(); print(o.__version__)")
        if not ort_ok and gpu_ort:
            progress(18, "ONNX Runtime GPU vẫn lỗi; đang khôi phục bản CPU an toàn…")
            run([uv, "pip", "uninstall", "--python", sys.executable, "onnxruntime", "onnxruntime-gpu"], timeout=600)
            run([uv, "pip", "install", "--python", sys.executable, "--reinstall", "onnxruntime==1.26.0"],
                check=True, timeout=1800)
    asr_ok, _ = import_probe("import ctranslate2, faster_whisper; print(ctranslate2.__version__, faster_whisper.__version__)")
    if not asr_ok:
        run([uv, "pip", "install", "--python", sys.executable, "--upgrade", "--no-deps",
             "--reinstall-package", "ctranslate2", "--reinstall-package", "faster-whisper",
             "ctranslate2==4.8.0", "faster-whisper==1.2.1"], check=True, timeout=1800)
    ort_ok, ort_detail = import_probe("import onnxruntime as o; o.SessionOptions(); print(o.__version__)")
    asr_ok, asr_detail = import_probe("import ctranslate2, faster_whisper; print(ctranslate2.__version__, faster_whisper.__version__)")
    if not ort_ok or not asr_ok:
        raise RuntimeError("Tự sửa runtime thất bại: %s | %s" % (ort_detail, asr_detail))


def status(args, force=False):
    hardware = hardware_status()
    fingerprint = runtime_fingerprint(args.model_root, hardware)
    cached = read_status(args.runtime_root)
    cache_age = time.time() - float(cached.get("verifiedAt", 0) or 0)
    if not force and cached.get("gpuReady") and cached.get("fingerprint") == fingerprint and cache_age < 86400:
        return {**cached, **hardware, "cached": True}
    probe = isolated_probe(args) if hardware.get("supported") and fingerprint["modelSize"] else {
        "gpuReady": False,
        "reason": "model_required" if not fingerprint["modelSize"] else hardware.get("reason"),
        "detail": "Hãy tải model Large V3 Turbo trước." if not fingerprint["modelSize"] else "GPU/driver chưa hỗ trợ.",
        "actualInference": False,
    }
    payload = {**hardware, **probe, "fingerprint": fingerprint, "verifiedAt": time.time(),
               "modelReady": bool(fingerprint["modelSize"]), "runtimeRoot": str(Path(args.runtime_root).resolve())}
    write_status(args.runtime_root, payload)
    return payload


def install(args):
    hardware = hardware_status()
    if not hardware.get("supported") or not resolve_model(args.model_root):
        emit(status(args, force=True))
        return 0
    if shutil.disk_usage(args.runtime_root).free < 2_500_000_000:
        raise RuntimeError("Không đủ dung lượng: cần tối thiểu 2,5 GB trống tại runtime để cài CUDA.")

    repair_runtime(args)
    current = status(args, force=True)
    if current.get("gpuReady"):
        progress(100, "Whisper GPU đã sẵn sàng và inference CUDA đã đạt.")
        emit(current)
        return 0

    uv = args.uv or shutil.which("uv") or "uv"
    progress(30, "Đang cài CUDA Runtime, cuBLAS và cuDNN dùng chung…")
    run([uv, "pip", "install", "--python", sys.executable, "--upgrade", *CUDA_PACKAGES],
        check=True, timeout=5400)
    progress(78, "Đang kiểm thử Large V3 Turbo bằng inference CUDA thật…")
    payload = status(args, force=True)
    if not payload.get("gpuReady"):
        progress(86, "CUDA chưa nạp được; đang sửa lại DLL và CTranslate2…")
        run([uv, "pip", "install", "--python", sys.executable, "--upgrade",
             "--reinstall-package", "nvidia-cuda-runtime-cu12",
             "--reinstall-package", "nvidia-cublas-cu12", "--reinstall-package", "nvidia-cudnn-cu12",
             *CUDA_PACKAGES], check=True, timeout=5400)
        payload = status(args, force=True)
    payload["installedBy"] = "video-studio-whisper-gpu-manager"
    write_status(args.runtime_root, payload)
    progress(100, "Whisper GPU đã sẵn sàng · Large V3 Turbo CUDA đã chạy thật." if payload.get("gpuReady")
             else "Không bật được CUDA; Whisper vẫn dùng CPU an toàn.")
    emit(payload)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uv", default="")
    parser.add_argument("--runtime-root", default="")
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--app-root", required=True)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if args.probe:
        emit(probe_in_process(args.model_root, args.app_root))
        return 0
    if not args.runtime_root:
        parser.error("--runtime-root is required")
    if args.status:
        emit(status(args))
        return 0
    return install(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("WHISPER_GPU_STATUS INSTALL_ERROR " + str(error), file=sys.stderr, flush=True)
        raise
