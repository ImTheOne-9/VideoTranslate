#!/usr/bin/env python3
"""Resilient Faster-Whisper worker used by Video Studio Tools.

Uses original-media input, Large V3 Turbo, VAD recovery, incremental
checkpoints, GPU-to-CPU continuation, hallucination filters, heartbeat events
and cross-process GPU serialization without loading native CUDA in Electron.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import re
import shutil
import site
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


CHINESE_LANGUAGES = {"ch", "zh", "zh-cn", "zh-tw", "chinese"}
HALLUCINATION_MARKERS = (
    "字幕by", "字幕组", "字幕組", "字幕志愿", "字幕志願", "字幕制作", "字幕製作",
    "字幕提供", "amara.org", "请不吝", "請不吝", "点赞订阅", "點贊訂閱",
    "点赞转发", "點贊轉發", "点赞关注", "點贊關注", "请点赞", "請點贊",
    "明镜与点点", "明鏡與點點", "点点栏目", "點點欄目", "谢谢观看", "謝謝觀看",
    "感谢观看", "感謝觀看", "感谢您的观看", "感謝您的觀看", "谢谢收看",
    "謝謝收看", "谢谢大家观看", "謝謝大家觀看",
)


def emit(event: str, **payload) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def atomic_json(path: str | Path, value: dict) -> None:
    output = Path(path).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.{threading.get_ident()}.{time.time_ns()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    last_error = None
    for attempt in range(10):
        try:
            os.replace(temporary, output)
            return
        except PermissionError as error:
            last_error = error
            time.sleep(0.03 * (attempt + 1))
    try:
        temporary.unlink()
    except OSError:
        pass
    raise last_error or RuntimeError(f"Không thể ghi file JSON: {output}")


def read_json(path: str | Path | None) -> dict:
    if not path:
        return {}
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def add_nvidia_dll_directories() -> list[str]:
    candidates: list[Path] = []
    for root in [*site.getsitepackages(), site.getusersitepackages()]:
        base = Path(root) / "nvidia"
        if base.is_dir():
            candidates.extend(path for path in base.glob("*/bin") if path.is_dir())
    added: list[str] = []
    for candidate in candidates:
        value = str(candidate.resolve())
        try:
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(value)
            added.append(value)
        except OSError:
            continue
    if added:
        os.environ["PATH"] = os.pathsep.join([*added, os.environ.get("PATH", "")])
    return added


def normalize_language(value: str | None) -> str | None:
    key = (value or "").strip().lower()
    if not key or key == "auto":
        return None
    return {
        "ch": "zh", "chinese": "zh", "vietnamese": "vi", "english": "en",
        "japan": "ja", "japanese": "ja", "korean": "ko",
    }.get(key, key)


def normalized_text(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", (text or "").lower(), flags=re.UNICODE)


def collapse_full_repetition(text: str) -> tuple[str, bool]:
    """Collapse a complete phrase repeated at least three times."""
    compact = (text or "").strip()
    for unit_length in range(1, min(20, len(compact) // 3) + 1):
        unit = compact[:unit_length]
        if unit and len(compact) % unit_length == 0 and unit * (len(compact) // unit_length) == compact:
            return unit, True
    words = compact.split()
    if len(words) >= 3 and len(set(words)) == 1:
        return words[0], True
    return compact, False


def clean_hallucination(text: str, start: float, end: float) -> tuple[str, str | None]:
    compact = (text or "").strip()
    marker_text = compact.lower().replace(" ", "")
    if not compact:
        return "", "empty"
    if any(marker in marker_text for marker in HALLUCINATION_MARKERS):
        return "", "known_marker"
    duration = max(0.0, end - start)
    character_count = len(re.sub(r"\s+", "", compact))
    if duration >= 6.0 and character_count <= 10 and character_count / max(duration, 0.1) < 0.6:
        return "", "low_density"
    collapsed, changed = collapse_full_repetition(compact)
    return collapsed, "collapsed_repetition" if changed else None


def text_script_quality(text: str, language: str | None) -> dict:
    replacement_count = text.count("\ufffd")
    control_count = sum(1 for char in text if ord(char) < 32 and char not in "\r\n\t")
    letters = re.findall(r"[^\W\d_]", text, flags=re.UNICODE)
    han_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", text))
    han_ratio = han_count / max(1, len(letters))
    expected_chinese = (language or "").lower() in CHINESE_LANGUAGES or language == "zh"
    valid_script = not expected_chinese or len(letters) < 24 or han_ratio >= 0.65
    return {
        "valid": replacement_count == 0 and control_count == 0 and valid_script,
        "replacementCount": replacement_count, "controlCount": control_count,
        "hanRatio": round(han_ratio, 6), "letterCount": len(letters),
        "expectedChinese": expected_chinese,
    }


def validate_segments(segments: list[dict], language: str | None, duration: float | None) -> dict:
    previous_end = 0.0
    timestamp_errors: list[str] = []
    for index, segment in enumerate(segments):
        start = float(segment.get("start", math.nan))
        end = float(segment.get("end", math.nan))
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            timestamp_errors.append(f"invalid:{index}")
            continue
        if start + 0.05 < previous_end:
            timestamp_errors.append(f"overlap:{index}")
        if duration and end > duration + 1.0:
            timestamp_errors.append(f"past_duration:{index}")
        previous_end = max(previous_end, end)
    text_quality = text_script_quality(" ".join(item.get("text", "") for item in segments), language)
    return {
        **text_quality,
        "valid": bool(segments) and text_quality["valid"] and not timestamp_errors,
        "timestampErrors": timestamp_errors[:20], "segmentCount": len(segments),
    }


def source_identity(path: str) -> dict:
    resolved = Path(path).resolve()
    stat = resolved.stat()
    return {"path": str(resolved), "size": stat.st_size, "mtimeNs": stat.st_mtime_ns}


def checkpoint_matches(checkpoint: dict, args: argparse.Namespace) -> bool:
    try:
        return (
            checkpoint.get("version") == 2
            and checkpoint.get("source") == source_identity(args.audio)
            and checkpoint.get("model") == args.model
            and checkpoint.get("language") == (normalize_language(args.language) or "auto")
            and isinstance(checkpoint.get("segments"), list)
        )
    except Exception:
        return False


class Heartbeat:
    def __init__(self, interval: float = 45.0):
        self.interval = max(10.0, interval)
        self.stop_event = threading.Event()
        self.started = time.monotonic()

    def __enter__(self):
        def pulse():
            while not self.stop_event.wait(self.interval):
                emit("heartbeat", elapsed=round(time.monotonic() - self.started, 1))
        threading.Thread(target=pulse, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.stop_event.set()


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class GpuFileLock:
    def __init__(self, path: str | None, timeout: float = 600.0):
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
                emit("gpu_lock_acquired", path=str(self.path))
                return self
            except FileExistsError:
                try:
                    owner_pid = int(self.path.read_text(encoding="ascii").strip())
                except Exception:
                    owner_pid = 0
                if not process_alive(owner_pid):
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise RuntimeError("Quá hạn chờ GPU đang được tác vụ khác sử dụng")
                emit("gpu_lock_waiting", ownerPid=owner_pid)
                time.sleep(2.0)

    def __exit__(self, *_):
        if self.owned and self.path:
            try:
                self.path.unlink()
            except OSError:
                pass
            self.owned = False


def gpu_state(path: str | None) -> dict:
    state = read_json(path)
    return state if state.get("version") == 1 else {"version": 1, "failureCount": 0, "disabledUntil": 0}


def record_gpu_success(path: str | None) -> None:
    if path:
        try:
            atomic_json(path, {"version": 1, "failureCount": 0, "disabledUntil": 0, "lastSuccess": time.time()})
        except Exception as error:
            emit("gpu_state_warning", message=str(error))


def record_gpu_failure(path: str | None, error: Exception) -> dict:
    state = gpu_state(path)
    count = int(state.get("failureCount", 0) or 0) + 1
    message = str(error)
    fixed = any(token in message.lower() for token in ("cudnn", "cublas", ".dll", "winerror 127", "winerror 1114"))
    disabled_for = 6 * 3600 if fixed else (30 * 60 if count >= 2 else 0)
    value = {
        "version": 1, "failureCount": count, "disabledUntil": (time.time() + disabled_for if disabled_for else 0),
        "lastFailure": time.time(), "lastError": message[:500], "fixedFailure": fixed,
    }
    if path:
        try:
            atomic_json(path, value)
        except Exception as state_error:
            emit("gpu_state_warning", message=str(state_error))
    return value


def requested_device(args: argparse.Namespace, ctranslate2) -> tuple[str, str]:
    requested = (args.device or "auto").strip().lower()
    if requested == "cpu":
        return "cpu", "int8"
    state = gpu_state(args.gpu_state)
    if requested == "auto" and float(state.get("disabledUntil", 0) or 0) > time.time():
        emit("gpu_temporarily_disabled", state=state)
        return "cpu", "int8"
    if ctranslate2.get_cuda_device_count() < 1:
        if requested == "cuda":
            raise RuntimeError("Không tìm thấy CUDA khả dụng cho faster-whisper")
        return "cpu", "int8"
    return "cuda", os.environ.get("FASTER_WHISPER_COMPUTE", "int8_float16")


def transcribe_kwargs(language: str | None, vad_filter: bool, temperature_zero: bool) -> dict:
    temperatures = 0.0 if temperature_zero else (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
    value = {
        "language": language, "task": "transcribe", "vad_filter": vad_filter,
        "condition_on_previous_text": False, "temperature": temperatures,
        "compression_ratio_threshold": 2.4, "no_speech_threshold": 0.4,
        "word_timestamps": True, "hallucination_silence_threshold": 2.0,
    }
    if vad_filter:
        value["vad_parameters"] = {
            "threshold": 0.35, "min_silence_duration_ms": 500, "speech_pad_ms": 600,
        }
    return value


def serialize_segment(segment, offset: float = 0.0) -> dict:
    start = float(segment.start) + offset
    end = float(segment.end) + offset
    # Match ViralCrawl's _ts(): integer seconds plus truncated fractional ms.
    start_ms = int(start) * 1000 + int((start - int(start)) * 1000)
    end_ms = int(end) * 1000 + int((end - int(end)) * 1000)
    return {
        "start": start, "end": end, "startMs": start_ms, "endMs": end_ms,
        "text": (segment.text or "").strip(),
        "avgLogprob": float(getattr(segment, "avg_logprob", 0.0) or 0.0),
        "noSpeechProb": float(getattr(segment, "no_speech_prob", 0.0) or 0.0),
        "compressionRatio": float(getattr(segment, "compression_ratio", 0.0) or 0.0),
        "words": [{
            "text": (word.word or "").strip(),
            "start": float(word.start) + offset if word.start is not None else None,
            "end": float(word.end) + offset if word.end is not None else None,
            "probability": float(word.probability) if word.probability is not None else None,
        } for word in (segment.words or []) if (word.word or "").strip()],
    }


def save_checkpoint(args: argparse.Namespace, segments: list[dict], device: str, **extra) -> None:
    if args.checkpoint:
        try:
            atomic_json(args.checkpoint, {
                "version": 2, "source": source_identity(args.audio), "model": args.model,
                "language": normalize_language(args.language) or "auto", "device": device,
                "complete": False, "updatedAt": time.time(), "segments": segments, **extra,
            })
        except Exception as error:
            emit("checkpoint_warning", message=str(error), segmentCount=len(segments))


def collect_segments(generator, args: argparse.Namespace, seed: list[dict], device: str,
                     offset: float, total_duration: float, write_checkpoint: bool = True) -> tuple[list[dict], dict]:
    segments = list(seed)
    filtered = {"known_marker": 0, "low_density": 0, "duplicate": 0, "collapsed_repetition": 0}
    last_progress = -1
    for segment in generator:
        item = serialize_segment(segment, offset)
        text, reason = clean_hallucination(item["text"], item["start"], item["end"])
        if reason in ("known_marker", "low_density", "empty"):
            if reason != "empty":
                filtered[reason] = filtered.get(reason, 0) + 1
                emit("segment_filtered", reason=reason, start=item["start"], end=item["end"])
            continue
        if reason == "collapsed_repetition":
            filtered[reason] += 1
        item["text"] = text
        key = normalized_text(text)
        if key and any(normalized_text(previous.get("text", "")) == key
                       and item["start"] < float(previous.get("end", 0)) + 0.05 for previous in segments[-3:]):
            filtered["duplicate"] += 1
            emit("segment_filtered", reason="duplicate", start=item["start"], end=item["end"])
            continue
        segments.append(item)
        if write_checkpoint:
            save_checkpoint(args, segments, device, filtered=filtered)
        emit("segment", index=len(segments), start=item["start"], end=item["end"], text=item["text"])
        if device == "cuda" and args.simulate_gpu_failure_after > 0 and len(segments) >= args.simulate_gpu_failure_after:
            raise RuntimeError("Mô phỏng CUDA OOM giữa generator để kiểm tra checkpoint/CPU continuation")
        progress = min(99, int(item["end"] / total_duration * 100)) if total_duration > 0 else 0
        if progress >= last_progress + 5:
            last_progress = progress
            emit("progress", percent=progress, position=item["end"], duration=total_duration)
    return segments, filtered


def coverage_poor(segments: list[dict], duration: float, offset: float = 0.0) -> bool:
    coverage_end = float(segments[-1].get("end", 0) if segments else offset) - offset
    return duration > 30 and (len(segments) <= 2 or coverage_end < duration * 0.6)


def transcribe_once(model, media: str, args: argparse.Namespace, language: str | None,
                    device: str, vad_filter: bool = True, seed: list[dict] | None = None,
                    offset: float = 0.0, total_duration: float = 0.0,
                    write_checkpoint: bool = True) -> tuple[list[dict], object, dict]:
    generator, info = model.transcribe(media, **transcribe_kwargs(language, vad_filter, args.temperature_zero))
    media_duration = float(getattr(info, "duration", 0.0) or 0.0)
    effective_duration = total_duration or (media_duration + offset)
    segments, filtered = collect_segments(generator, args, seed or [], device, offset, effective_duration, write_checkpoint)
    return segments, info, filtered


def transcribe_with_vad_recovery(model, media: str, args: argparse.Namespace, language: str | None,
                                 device: str, seed: list[dict] | None = None, offset: float = 0.0,
                                 total_duration: float = 0.0) -> tuple[list[dict], object, dict, bool]:
    segments, info, filtered = transcribe_once(model, media, args, language, device, True, seed, offset, total_duration, True)
    duration = total_duration or (float(getattr(info, "duration", 0.0) or 0.0) + offset)
    current_tail = segments[len(seed or []):]
    tail_duration = max(0.0, duration - offset)
    if not args.disable_vad_fallback and coverage_poor(current_tail, tail_duration, offset):
        emit("vad_retry", segmentCount=len(current_tail), coverageEnd=(current_tail[-1]["end"] if current_tail else offset))
        retry, retry_info, retry_filtered = transcribe_once(model, media, args, language, device, False, [], offset, duration, False)
        current_end = current_tail[-1]["end"] if current_tail else offset
        retry_end = retry[-1]["end"] if retry else offset
        if len(retry) > len(current_tail) and retry_end > current_end:
            segments, info, filtered = list(seed or []) + retry, retry_info, retry_filtered
            save_checkpoint(args, segments, device, filtered=filtered, vadFallbackUsed=True)
            emit("vad_retry_selected", oldCount=len(current_tail), newCount=len(retry), coverageEnd=retry_end)
            return segments, info, filtered, True
        emit("vad_retry_rejected", oldCount=len(current_tail), newCount=len(retry), coverageEnd=retry_end)
    return segments, info, filtered, False


def cut_resume_audio(args: argparse.Namespace, start: float) -> str:
    if not args.ffmpeg or not Path(args.ffmpeg).is_file():
        raise RuntimeError("Thiếu FFmpeg để tiếp tục ASR từ checkpoint")
    descriptor, output = tempfile.mkstemp(prefix="vst-asr-resume-", suffix=".wav")
    os.close(descriptor)
    command = [args.ffmpeg, "-y", "-i", str(Path(args.audio).resolve()), "-ss", str(max(0.0, start)),
               "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output]
    result = subprocess.run(command, capture_output=True, timeout=300, creationflags=(0x08000000 if os.name == "nt" else 0))
    if result.returncode != 0 or not Path(output).is_file() or Path(output).stat().st_size < 1024:
        try:
            Path(output).unlink()
        except OSError:
            pass
        raise RuntimeError("FFmpeg không cắt được audio để tiếp tục CPU")
    return output


def ensure_runtime_health(model_root: str) -> None:
    root = Path(model_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(str(root)).free < 2 * 1024**3:
        raise RuntimeError("ĐĨA GẦN ĐẦY: cần tối thiểu 2 GB trống để nạp model Faster-Whisper")
    try:
        import onnxruntime as ort
        ort.SessionOptions()
    except Exception as error:
        raise RuntimeError(f"ONNX Runtime dùng cho Silero VAD bị lỗi: {error}") from error


def load_model(WhisperModel, args: argparse.Namespace, device: str, compute_type: str):
    emit("loading_model", model=args.model, device=device, computeType=compute_type)
    started = time.perf_counter()
    model = WhisperModel(args.model, device=device, compute_type=compute_type,
                         download_root=str(Path(args.model_root).resolve()), local_files_only=args.local_files_only)
    emit("model_loaded", seconds=round(time.perf_counter() - started, 3), device=device)
    return model


def run(args: argparse.Namespace) -> int:
    dll_dirs = add_nvidia_dll_directories()
    ensure_runtime_health(args.model_root)
    import ctranslate2
    import faster_whisper
    from faster_whisper import WhisperModel

    if args.check:
        emit("status", ready=True, fasterWhisperVersion=getattr(faster_whisper, "__version__", "unknown"),
             ctranslate2Version=getattr(ctranslate2, "__version__", "unknown"),
             cudaDeviceCount=ctranslate2.get_cuda_device_count(), nvidiaDllDirectories=dll_dirs,
             gpuState=gpu_state(args.gpu_state))
        return 0

    language = normalize_language(args.language)
    checkpoint = read_json(args.checkpoint)
    partial = checkpoint.get("segments", []) if checkpoint_matches(checkpoint, args) and not checkpoint.get("complete") else []
    force_cpu_resume = bool(partial)
    if force_cpu_resume:
        emit("checkpoint_resumed", segmentCount=len(partial), position=partial[-1].get("end", 0))
    device, compute_type = ("cpu", "int8") if force_cpu_resume else requested_device(args, ctranslate2)
    total_duration = max(0.0, float(args.duration or 0.0))
    gpu_failure = None
    vad_fallback_used = False
    filtered: dict = {}
    info = None
    segments: list[dict] = list(partial)
    resume_file = None

    with Heartbeat(args.heartbeat_seconds):
        lock = GpuFileLock(args.gpu_lock) if device == "cuda" else GpuFileLock(None)
        try:
            with lock:
                try:
                    model = load_model(WhisperModel, args, device, compute_type)
                    media, offset, seed = args.audio, 0.0, []
                    if force_cpu_resume and partial and float(partial[-1].get("end", 0)) > 5:
                        offset = float(partial[-1]["end"])
                        resume_file = cut_resume_audio(args, offset)
                        media, seed = resume_file, partial
                    segments, info, filtered, vad_fallback_used = transcribe_with_vad_recovery(
                        model, media, args, language, device, seed, offset, total_duration)
                    if device == "cuda":
                        record_gpu_success(args.gpu_state)
                except Exception as error:
                    if device != "cuda":
                        raise
                    gpu_failure = str(error)
                    state = record_gpu_failure(args.gpu_state, error)
                    saved = read_json(args.checkpoint)
                    if checkpoint_matches(saved, args) and saved.get("segments"):
                        segments = saved["segments"]
                    save_checkpoint(args, segments, "cuda", needsCpuResume=True, gpuError=gpu_failure)
                    emit("gpu_fallback", message=gpu_failure, partialCount=len(segments), gpuState=state)
                    lock.__exit__()
                    model = None
                    gc.collect()
                    device, compute_type = "cpu", "int8"
                    model = load_model(WhisperModel, args, device, compute_type)
                    offset = float(segments[-1].get("end", 0)) if segments else 0.0
                    seed, media = list(segments), args.audio
                    if offset > 5:
                        resume_file = cut_resume_audio(args, offset)
                        media = resume_file
                    else:
                        offset, seed = 0.0, []
                    segments, info, filtered, vad_fallback_used = transcribe_with_vad_recovery(
                        model, media, args, language, device, seed, offset, total_duration)
        finally:
            if resume_file:
                try:
                    Path(resume_file).unlink()
                except OSError:
                    pass

    detected_language = getattr(info, "language", None) or language
    inferred_duration = float(getattr(info, "duration", 0.0) or 0.0)
    duration = total_duration or inferred_duration
    quality = validate_segments(segments, language or detected_language, duration or None)
    if not quality["valid"]:
        emit("quality_rejected", quality=quality)
        return 43
    result = {
        "version": 2, "engineId": "faster-whisper", "model": args.model,
        "device": device, "computeType": compute_type, "language": detected_language,
        "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "duration": duration, "quality": quality, "segments": segments,
        "vadFallbackUsed": vad_fallback_used, "filteredHallucinations": filtered,
        "gpuFallbackUsed": bool(gpu_failure), "gpuError": gpu_failure, "inputMode": "original_media",
    }
    atomic_json(args.output, result)
    if args.checkpoint:
        try:
            Path(args.checkpoint).unlink()
        except OSError:
            pass
    emit("complete", segmentCount=len(segments), output=str(Path(args.output).resolve()), device=device,
         gpuFallbackUsed=bool(gpu_failure), vadFallbackUsed=vad_fallback_used)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--audio")
    parser.add_argument("--output")
    parser.add_argument("--checkpoint")
    parser.add_argument("--ffmpeg")
    parser.add_argument("--gpu-state")
    parser.add_argument("--gpu-lock")
    parser.add_argument("--duration", type=float, default=0.0)
    parser.add_argument("--model-root", default=str(Path.home() / ".cache" / "video-studio-whisper"))
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--temperature-zero", action="store_true")
    parser.add_argument("--disable-vad-fallback", action="store_true")
    parser.add_argument("--heartbeat-seconds", type=float, default=45.0)
    parser.add_argument("--simulate-gpu-failure-after", type=int, default=0, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.check and (not args.audio or not args.output):
        parser.error("--audio và --output là bắt buộc")
    try:
        return run(args)
    except Exception as error:
        message = str(error)
        lowered = message.lower()
        category = "runtime"
        if any(token in lowered for token in ("not enough memory", "paging file", "memoryerror", "winerror 1455")):
            category = "memory"
        elif any(token in lowered for token in ("no space", "đĩa", "enospc", "error 112")):
            category = "disk"
        elif any(token in lowered for token in ("cudnn", "cublas", "cuda", ".dll")):
            category = "gpu_runtime"
        emit("error", message=message, type=type(error).__name__, category=category)
        return 42


if __name__ == "__main__":
    raise SystemExit(main())
