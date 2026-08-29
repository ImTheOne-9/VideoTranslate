"""Shared CUDA DLL discovery for Faster-Whisper subprocesses on Windows."""
from __future__ import annotations

import glob
import importlib.util
import os
from pathlib import Path

_DLL_HANDLES = []


def _package_dirs(module_name: str, suffix: str = "") -> list[Path]:
    try:
        spec = importlib.util.find_spec(module_name)
        roots = list(spec.submodule_search_locations or []) if spec else []
        return [Path(root) / suffix for root in roots if (Path(root) / suffix).is_dir()]
    except Exception:
        return []


def configure_cuda_dlls() -> dict:
    """Expose one deterministic CUDA DLL order without importing torch/ORT."""
    if os.name != "nt":
        return {"directories": [], "cudnnPolicy": "platform_default"}

    ctranslate_dirs = _package_dirs("ctranslate2")
    torch_dirs = [path for path in _package_dirs("torch", "lib") if list(path.glob("cudnn*.dll"))]
    use_torch_cudnn = bool(torch_dirs)
    nvidia_modules = ["nvidia.cuda_runtime", "nvidia.cublas", "nvidia.cuda_nvrtc"]
    if not use_torch_cudnn:
        nvidia_modules.append("nvidia.cudnn")

    ordered = [*torch_dirs, *ctranslate_dirs]
    for module_name in nvidia_modules:
        ordered.extend(_package_dirs(module_name, "bin"))

    unique = []
    seen = set()
    for directory in ordered:
        resolved = str(directory.resolve())
        key = resolved.casefold().rstrip("\\/")
        if key in seen:
            continue
        seen.add(key)
        unique.append(resolved)

    for directory in unique:
        try:
            if hasattr(os, "add_dll_directory"):
                _DLL_HANDLES.append(os.add_dll_directory(directory))
        except OSError:
            pass

    current = [item for item in os.environ.get("PATH", "").split(os.pathsep) if item]
    filtered = [item for item in current if item.casefold().rstrip("\\/") not in seen]
    os.environ["PATH"] = os.pathsep.join([*unique, *filtered])
    return {
        "directories": unique,
        "cudnnPolicy": "torch_only" if use_torch_cudnn else "nvidia",
        "hasCublas": any(glob.glob(os.path.join(item, "cublas64_12.dll")) for item in unique),
        "hasCudart": any(glob.glob(os.path.join(item, "cudart64_12.dll")) for item in unique),
        "hasCudnn": any(glob.glob(os.path.join(item, "cudnn64_9.dll")) for item in unique),
    }
