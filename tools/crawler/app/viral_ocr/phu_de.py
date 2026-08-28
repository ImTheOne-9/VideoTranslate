# -*- coding: utf-8 -*-
"""Lớp tương thích tối thiểu cho các guard CUDA mà lõi RapidOCR dùng chung."""
import glob
import importlib.util
import os
import sys


_GPU_CHAN_TEN = ("quadro m1000m",)
_DLL_HANDLES = []


def _gpu_bi_chan(ten):
    value = (ten or "").strip().lower()
    return any(blocked in value for blocked in _GPU_CHAN_TEN)


def bo_qua_cudnn_nvidia():
    """Ưu tiên cuDNN của torch nếu runtime đó thực sự có DLL đi kèm."""
    try:
        spec = importlib.util.find_spec("torch")
        for root in list(spec.submodule_search_locations or []) if spec else []:
            if glob.glob(os.path.join(root, "lib", "cudnn*.dll")):
                return True
    except Exception:
        pass
    return False


def _add_cuda_dll_dirs():
    if sys.platform != "win32":
        return
    try:
        spec = importlib.util.find_spec("nvidia")
        roots = list(spec.submodule_search_locations or []) if spec else []
        for root in roots:
            for directory in glob.glob(os.path.join(root, "*", "bin")):
                if not os.path.isdir(directory):
                    continue
                if bo_qua_cudnn_nvidia() and "cudnn" in directory.lower():
                    continue
                try:
                    _DLL_HANDLES.append(os.add_dll_directory(directory))
                except Exception:
                    pass
                if directory.lower() not in os.environ.get("PATH", "").lower():
                    os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass
