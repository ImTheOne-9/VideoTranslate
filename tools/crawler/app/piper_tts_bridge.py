# -*- coding: utf-8 -*-
"""Persistent Piper bridge for Video Studio Tools.

The process reads one JSON request per line and keeps the ONNX voice loaded
between cues. Models are stored in the writable crawler runtime, never in the
installed application directory.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
import wave


HF_BASE = os.environ.get(
    "VIDEO_STUDIO_PIPER_MODEL_BASE",
    "https://huggingface.co/doof-ferb/nghitts-copy/resolve/main/piper-tts",
).rstrip("/")
DEFAULT_VOICE = "ngochuyen"
KNOWN_VOICES = {
    "ngochuyen", "ngochuyennew", "ngocngan3701", "maiphuong",
    "phuongtrang", "thanhphuong2", "calmwoman3688", "yannew",
    "lacphi", "manhdung", "minhkhang", "minhquang", "duyoryx3175",
    "adam1", "chieuthanh", "taian4",
}
PIPER_LANGUAGE_VOICES = {
    "en": "en_US-ryan-high",
    "de": "de_DE-thorsten-high",
    "es": "es_AR-daniela-high",
    "pl": "pl_PL-bass-high",
    "uk": "uk_UA-tetiana-high",
    "kk": "kk_KZ-issai-high",
}

try:
    import tts_chuan_hoa

    _fallback_normalize = tts_chuan_hoa.chuan_hoa
except Exception:
    def _fallback_normalize(value):
        return value

try:
    from vietnormalizer import VietnameseNormalizer

    _vietnamese_normalizer = VietnameseNormalizer()
except Exception:
    _vietnamese_normalizer = None


def _han_character_ratio(value):
    visible = [char for char in str(value or "").strip() if not char.isspace()]
    if not visible:
        return 0.0
    han = sum(1 for char in visible if "\u4e00" <= char <= "\u9fff" or "\u3400" <= char <= "\u4dbf")
    return han / len(visible)


def normalize_piper_text(value, language="vi", han_threshold=0.35):
    """Mirror ViralCrawl's Piper-only Vietnamese normalization policy."""
    text = str(value or "").strip()
    language_root = str(language or "vi").strip().lower().replace("_", "-").split("-", 1)[0]
    if not text or language_root != "vi":
        return text
    try:
        threshold = max(0.0, float(han_threshold))
    except (TypeError, ValueError):
        threshold = 0.35
    if threshold > 0 and _han_character_ratio(text) >= threshold:
        return ""
    if _vietnamese_normalizer is not None:
        try:
            normalized = _vietnamese_normalizer.normalize(text)
            if str(normalized or "").strip():
                return str(normalized).strip()
        except Exception:
            pass
    return str(_fallback_normalize(text) or text).strip()


def _runtime_root():
    configured = os.environ.get("VIDEO_STUDIO_CRAWLER_RUNTIME", "").strip()
    if configured:
        return os.path.abspath(configured)
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(appdata, "Video Studio Tools", "crawler", "runtime")


def _model_path(voice_name):
    safe_name = voice_name if voice_name in KNOWN_VOICES or voice_name in PIPER_LANGUAGE_VOICES.values() else DEFAULT_VOICE
    return os.path.join(_runtime_root(), "piper_models", safe_name + ".onnx")


def _valid_model(model_path):
    try:
        if os.path.getsize(model_path) < 1_000_000:
            return False
        with open(model_path, "rb") as stream:
            prefix = stream.read(16).lstrip()
        return prefix[:1] not in (b"<", b"{")
    except OSError:
        return False


def _download_file(url, destination):
    temporary = destination + ".part"
    try:
        urllib.request.urlretrieve(url, temporary)
        os.replace(temporary, destination)
    finally:
        try:
            if os.path.isfile(temporary):
                os.remove(temporary)
        except OSError:
            pass


def ensure_model(voice_name):
    safe_name = voice_name if voice_name in KNOWN_VOICES or voice_name in PIPER_LANGUAGE_VOICES.values() else DEFAULT_VOICE
    model_path = _model_path(safe_name)
    config_path = model_path + ".json"
    os.makedirs(os.path.dirname(model_path), exist_ok=True)
    lock_path = model_path + ".download.lock"
    lock_fd = None
    deadline = time.time() + 180
    while lock_fd is None:
        try:
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if _valid_model(model_path) and os.path.isfile(config_path):
                return model_path
            if time.time() >= deadline:
                try:
                    os.remove(lock_path)
                except OSError:
                    pass
                deadline = time.time() + 30
            time.sleep(0.2)
    try:
        if safe_name in PIPER_LANGUAGE_VOICES.values() and (
            not _valid_model(model_path) or not os.path.isfile(config_path)
        ):
            completed = subprocess.run(
                [sys.executable, "-m", "piper.download_voices", safe_name,
                 "--data-dir", os.path.dirname(model_path)],
                capture_output=True, text=True, timeout=300,
            )
            if completed.returncode != 0:
                raise RuntimeError((completed.stderr or completed.stdout or "Không tải được model Piper").strip())
        if not _valid_model(model_path):
            for stale in (model_path, config_path):
                try:
                    if os.path.isfile(stale):
                        os.remove(stale)
                except OSError:
                    pass
            if safe_name in KNOWN_VOICES:
                _download_file(f"{HF_BASE}/{safe_name}.onnx", model_path)
        if not os.path.isfile(config_path):
            if safe_name in KNOWN_VOICES:
                _download_file(f"{HF_BASE}/config.json", config_path)
    finally:
        try:
            os.close(lock_fd)
        except OSError:
            pass
        try:
            os.remove(lock_path)
        except OSError:
            pass
    if not _valid_model(model_path) or not os.path.isfile(config_path):
        raise RuntimeError("Model Piper tải về không hợp lệ")
    return model_path


class PiperRuntime:
    def __init__(self):
        from piper import PiperVoice
        self._piper_voice = PiperVoice
        self._voices = {}

    def voice(self, name, requested_device="auto"):
        model_path = ensure_model(name)
        providers = []
        try:
            import onnxruntime as ort
            providers = list(ort.get_available_providers())
        except Exception:
            providers = []
        wants_cuda = requested_device in ("auto", "cuda")
        use_cuda = wants_cuda and "CUDAExecutionProvider" in providers
        cache_key = (model_path, "cuda" if use_cuda else "cpu")
        if cache_key not in self._voices:
            try:
                self._voices[cache_key] = self._piper_voice.load(model_path, use_cuda=use_cuda)
            except TypeError:
                self._voices[cache_key] = self._piper_voice.load(model_path)
                use_cuda = False
                cache_key = (model_path, "cpu")
        return self._voices[cache_key], ("cuda" if use_cuda else "cpu"), providers

    def synthesize(self, request):
        text = normalize_piper_text(
            request.get("text"),
            request.get("language") or "vi",
            request.get("hanThreshold", 0.35),
        )
        output_path = os.path.abspath(str(request.get("outputPath") or ""))
        voice_name = str(request.get("voice") or DEFAULT_VOICE).strip()
        if not text or not output_path:
            raise ValueError("Thiếu text hoặc outputPath")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        voice, used_device, providers = self.voice(
            voice_name, str(request.get("device") or "auto").strip().lower()
        )
        syn_config = None
        try:
            from piper import SynthesisConfig
            length_scale = max(0.68, min(1.5, float(request.get("lengthScale") or 0.8)))
            syn_config = SynthesisConfig(length_scale=length_scale)
        except Exception:
            syn_config = None
        with wave.open(output_path, "wb") as wav_file:
            if syn_config is None:
                voice.synthesize_wav(text, wav_file)
            else:
                voice.synthesize_wav(text, wav_file, syn_config=syn_config)
        if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 44:
            raise RuntimeError("Piper không sinh được âm thanh")
        return {
            "outputPath": output_path,
            "voice": voice_name,
            "normalizedText": text,
            "usedDevice": used_device,
            "providers": providers,
        }


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve():
    try:
        runtime = PiperRuntime()
        emit({"event": "ready"})
    except Exception as error:
        emit({"event": "fatal", "error": str(error)})
        return 2
    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("command") == "stop":
                emit({"id": request_id, "ok": True})
                return 0
            result = runtime.synthesize(request)
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as error:
            emit({"id": request.get("id") if "request" in locals() else None,
                  "ok": False, "error": str(error)})
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--server", action="store_true")
    args = parser.parse_args()
    if args.check:
        try:
            import piper  # noqa: F401
            import audiostretchy  # noqa: F401
            import vietnormalizer  # noqa: F401
            providers = []
            try:
                import onnxruntime as ort
                ort.SessionOptions()
                providers = list(ort.get_available_providers())
            except Exception:
                raise
            emit({"ok": True, "providers": providers, "dependencies": {
                "piper": True, "audiostretchy": True, "vietnormalizer": True,
                "onnxruntime": True,
            }})
            return 0
        except Exception as error:
            emit({"ok": False, "error": str(error)})
            return 1
    return serve() if args.server else 2


if __name__ == "__main__":
    raise SystemExit(main())
