# -*- coding: utf-8 -*-
"""OmniVoice batch worker used by Video Studio Tools.

The worker has two modes:
  * one shot: ``--job job.json``
  * warm daemon: ``--serve queue_dir``

Every request contains a list of texts and produces ``seg_<index>.wav`` files.
Files and markers are written atomically so a killed render never mistakes a
partial WAV for a completed cue.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SAMPLE_RATE = 24000
_PROMPT_CACHE: dict[str, object] = {}


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class _GpuFileLock:
    """Same lock format/path as the Faster-Whisper worker."""

    def __init__(self, path: str | None, timeout: float = 1800.0):
        self.path = Path(path).resolve() if path else None
        self.timeout = timeout
        self.owned = False

    def __enter__(self):
        if not self.path:
            return self
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                descriptor = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(descriptor, str(os.getpid()).encode("ascii"))
                os.close(descriptor)
                self.owned = True
                print("[omnivoice] gpu_lock_acquired", flush=True)
                return self
            except FileExistsError:
                try:
                    owner = int(self.path.read_text(encoding="ascii").strip())
                except Exception:
                    owner = 0
                if not _process_alive(owner):
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise RuntimeError("Quá hạn chờ GPU đang được tác vụ khác sử dụng")
                time.sleep(2)

    def __exit__(self, *_):
        if self.owned and self.path:
            try:
                self.path.unlink()
            except OSError:
                pass
            self.owned = False


def _atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(value, encoding="utf-8")
    os.replace(temp, path)


def _atomic_json(path: Path, value: object) -> None:
    _atomic_text(path, json.dumps(value, ensure_ascii=False))


def _write_wav(sf, np, path: Path, audio) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(str(path) + ".tmp.wav")
    arr = np.asarray(audio, dtype="float32").reshape(-1)
    finite = arr[np.isfinite(arr)]
    audible = bool(finite.size >= int(SAMPLE_RATE * 0.08) and float(np.max(np.abs(finite))) > 1e-5)
    if not audible:
        arr = np.zeros(int(SAMPLE_RATE * 0.1), dtype="float32")
    sf.write(str(temp), arr, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    os.replace(temp, path)
    return audible


def _existing_wav_is_audible(sf, np, path: Path) -> bool:
    try:
        audio, sample_rate = sf.read(str(path), dtype="float32", always_2d=False)
        arr = np.asarray(audio, dtype="float32").reshape(-1)
        return bool(sample_rate > 0 and arr.size >= int(sample_rate * 0.08) and float(np.max(np.abs(arr))) > 1e-5)
    except Exception:
        return False


def _load_model():
    import torch
    from omnivoice import OmniVoice

    if not torch.cuda.is_available():
        raise RuntimeError("OmniVoice Python cần NVIDIA CUDA nhưng torch.cuda.is_available() = False")
    # A real CUDA operation catches an incompatible driver/wheel before loading
    # several gigabytes of model weights.
    probe = torch.ones((32, 32), device="cuda")
    float((probe @ probe).sum().item())
    name = torch.cuda.get_device_name(0)
    print(f"[omnivoice] CUDA inference probe OK: {name}", flush=True)
    return OmniVoice.from_pretrained(
        os.environ.get("OMNIVOICE_MODEL_ID", "k2-fsa/OmniVoice"),
        device_map="cuda:0",
        dtype=torch.float16,
    )


def _prompt_key(ref: str, ref_text: str) -> str:
    stat = os.stat(ref)
    raw = f"{os.path.abspath(ref)}\n{stat.st_size}\n{stat.st_mtime_ns}\n{ref_text}"
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()


def _clone_prompt(model, ref: str | None, ref_text: str | None):
    if not ref or not ref_text or not os.path.isfile(ref):
        return None
    key = _prompt_key(ref, ref_text)
    if key in _PROMPT_CACHE:
        print("[omnivoice] reference_prompt=hit", flush=True)
        return _PROMPT_CACHE[key]
    prompt = model.create_voice_clone_prompt(ref, ref_text)
    _PROMPT_CACHE.clear()  # one warm model only needs the latest selected voice
    _PROMPT_CACHE[key] = prompt
    print("[omnivoice] reference_prompt=stored", flush=True)
    return prompt


def _supported_language(language: str) -> bool:
    try:
        from omnivoice.utils.lang_map import LANG_IDS
        return language in LANG_IDS
    except Exception:
        return True


def _synthesize(model, job: dict, batch_size: int) -> dict:
    import numpy as np
    import soundfile as sf
    import torch

    texts = [str(value or "").strip() for value in (job.get("texts") or [])]
    output_dir = Path(job["outputDir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    progress_path = output_dir / "_progress.json"
    language = str(job.get("language") or "vi").lower().split("-")[0].split("_")[0]
    steps = max(4, int(job.get("steps") or 8))
    seed = int(job.get("seed") or 20250827)
    np.random.seed(seed & 0xFFFFFFFF)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    reference = job.get("referenceAudioPath")
    reference_text = str(job.get("referenceText") or "").strip()
    instruct = str(job.get("instruct") or "").strip() or None

    if not _supported_language(language):
        raise RuntimeError(f"OmniVoice không hỗ trợ ngôn ngữ '{language}'")
    prompt = _clone_prompt(model, reference, reference_text)

    valid_indices = []
    completed = 0
    audible = 0
    audible_indices = []
    for index, text in enumerate(texts):
        target = output_dir / f"seg_{index}.wav"
        if target.is_file() and target.stat().st_size > 64 and _existing_wav_is_audible(sf, np, target):
            completed += 1
            audible += 1
            audible_indices.append(index)
        elif text:
            valid_indices.append(index)
        else:
            _write_wav(sf, np, target, np.zeros(int(SAMPLE_RATE * 0.1), dtype="float32"))
            completed += 1

    valid_indices.sort(key=lambda index: len(texts[index]))

    def generate_one(text: str):
        options = {"text": text, "language": language, "num_step": steps}
        if prompt is not None:
            options["voice_clone_prompt"] = prompt
        elif instruct:
            options["instruct"] = instruct
        result = model.generate(**options)
        return result[0] if isinstance(result, (list, tuple)) else result

    _atomic_json(progress_path, {
        "completed": completed, "total": len(texts), "audible": audible,
        "audibleIndices": sorted(set(audible_indices)), "at": time.time(),
    })
    for offset in range(0, len(valid_indices), max(1, batch_size)):
        indices = valid_indices[offset:offset + max(1, batch_size)]
        chunk = [texts[index] for index in indices]
        options = {"text": chunk, "language": [language] * len(chunk), "num_step": steps}
        if prompt is not None:
            options["voice_clone_prompt"] = [prompt] * len(chunk)
        elif instruct:
            options["instruct"] = [instruct] * len(chunk)
        try:
            generated = model.generate(**options)
            if not isinstance(generated, (list, tuple)):
                generated = [generated]
        except Exception as batch_error:
            print(f"[omnivoice] batch lỗi: {batch_error!r}; thử riêng từng cue", flush=True)
            generated = []
            for text in chunk:
                try:
                    generated.append(generate_one(text))
                except Exception as cue_error:
                    print(f"[omnivoice] cue lỗi: {cue_error!r}", flush=True)
                    generated.append(None)

        for local_index, source_index in enumerate(indices):
            audio = generated[local_index] if local_index < len(generated) else None
            target = output_dir / f"seg_{source_index}.wav"
            if audio is None:
                _write_wav(sf, np, target, np.zeros(int(SAMPLE_RATE * 0.1), dtype="float32"))
            elif _write_wav(sf, np, target, audio):
                audible += 1
                audible_indices.append(source_index)
            completed += 1
        _atomic_json(progress_path, {
            "completed": completed, "total": len(texts), "audible": audible,
            "audibleIndices": sorted(set(audible_indices)), "at": time.time(),
        })
        print(f"[omnivoice] {completed}/{len(texts)} (có tiếng={audible})", flush=True)

    result = {
        "ok": audible,
        "total": len(texts),
        "completed": completed,
        "audibleIndices": sorted(set(audible_indices)),
    }
    _atomic_json(output_dir / "_done.json", result)
    print(f"[omnivoice] KETQUA ok={audible}/{len(texts)}", flush=True)
    return result


def _heartbeat(path: Path, stop: threading.Event) -> None:
    while not stop.wait(5):
        try:
            _atomic_text(path, str(os.getpid()))
        except OSError:
            pass


def _serve(queue_dir: Path, batch_size: int) -> None:
    queue_dir.mkdir(parents=True, exist_ok=True)
    alive = queue_dir / "_alive"
    stop = threading.Event()
    gpu_lock = os.environ.get("OMNIVOICE_GPU_LOCK")
    with _GpuFileLock(gpu_lock):
        model = _load_model()
    _atomic_text(alive, str(os.getpid()))
    threading.Thread(target=_heartbeat, args=(alive, stop), daemon=True).start()
    idle_seconds = max(0, int(os.environ.get("OMNIVOICE_IDLE_SECONDS", "180") or 180))
    last_job = time.time()
    print(f"[omnivoice] daemon READY batch={batch_size}", flush=True)
    try:
        while True:
            requests = sorted(glob.glob(str(queue_dir / "req_*.json")))
            if not requests:
                if idle_seconds and time.time() - last_job > idle_seconds:
                    return
                time.sleep(0.25)
                continue
            for request_name in requests:
                request_path = Path(request_name)
                job = {}
                try:
                    job = json.loads(request_path.read_text(encoding="utf-8-sig"))
                    request_path.unlink(missing_ok=True)
                    with _GpuFileLock(gpu_lock):
                        _synthesize(model, job, batch_size)
                except Exception as error:
                    output_dir = Path(job.get("outputDir") or queue_dir)
                    _atomic_text(output_dir / "_error.txt", repr(error))
                    traceback.print_exc()
                    # CUDA/OOM state is not reliably recoverable. Exit so the
                    # parent can release VRAM and retry through one-shot.
                    return
                finally:
                    last_job = time.time()
    finally:
        stop.set()
        alive.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve")
    parser.add_argument("--job")
    parser.add_argument("--batch", type=int, default=8)
    args = parser.parse_args()
    if args.serve:
        _serve(Path(args.serve).resolve(), max(1, args.batch))
        return
    if not args.job:
        parser.error("cần --serve hoặc --job")
    job_path = Path(args.job).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8-sig"))
    with _GpuFileLock(os.environ.get("OMNIVOICE_GPU_LOCK")):
        model = _load_model()
        _synthesize(model, job, max(1, args.batch))


if __name__ == "__main__":
    main()
