#!/usr/bin/env python3
"""Optional CapCut speech-to-text adapter with a fail-closed JSON protocol.

The adapter uses the same anonymous, device-signed VOD/common-task flow as
ViralCrawl.  It is deliberately isolated in a child process: callers must
fall back to local Faster Whisper for every network/API/protocol failure.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import random
import socket
import subprocess
import sys
import time
import uuid
import zlib
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

import requests

BASE_URL = os.environ.get("CAPCUT_BASE") or "https://editor-api-sg.capcutapi.com"
HOST = "editor-api-sg.capcutapi.com"
AID = "359289"
APP_VERSION = os.environ.get("CAPCUT_APPVR") or "8.7.0"
VOD_REGION, VOD_SERVICE = "sdwdmwlll", "vod"
FEATURE = {
    "feature_entrance": "editor",
    "feature_entrance_detail": "editor-elements-captions-subtitle_recognition",
    "feature_key": "subtitle_recognition",
    "scenario": "video_editor",
}
LANGUAGES = {
    "ch": "zh-CN", "zh": "zh-CN", "cmn": "zh-CN", "yue": "zh-CN",
    "wuu": "zh-CN", "nan": "zh-CN", "hak": "zh-CN", "gan": "zh-CN",
    "en": "en-US", "ja": "ja-JP", "japan": "ja-JP", "ko": "ko-KR",
    "korean": "ko-KR", "vi": "vi-VN", "th": "th-TH", "es": "es-ES",
    "fr": "fr-FR", "de": "de-DE", "ru": "ru-RU", "id": "id-ID",
    "pt": "pt-BR", "it": "it-IT",
}

# ViralCrawl measured these values against CapCut's real segmentation. The
# service treats words_per_line as characters, so 15 works for Chinese but
# fragments Vietnamese/Latin speech into unnaturally short cues.
LINE_LAYOUTS = {
    "zh-": (15, 1),
    "yue": (15, 1),
    "ja-": (30, 2),
    "ko-": (45, 2),
}
DEFAULT_LINE_LAYOUT = (60, 2)

# Only explicit successful empty states belong here. Unknown values remain API
# errors so a changed protocol cannot silently discard speech.
EMPTY_NO_SPEECH_REASONS = frozenset((
    "no_required_caption_type",
    "no_speech_and_singing",
))

_NETWORK_CACHE = [0.0, None]


class CapCutError(RuntimeError):
    pass


class CapCutNoSpeech(CapCutError):
    pass


class CapCutNetworkError(CapCutError):
    pass


class CapCutApiError(CapCutError):
    pass


def compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def emit(event: str, **payload) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def language_code(value: str | None) -> str:
    key = (value or "").strip().lower()
    if not key or key == "auto":
        return ""
    if key in LANGUAGES:
        return LANGUAGES[key]
    if "-" in key:
        return key
    return LANGUAGES.get(key[:2], "")


def line_parameters(capcut_language: str | None) -> tuple[int, int]:
    try:
        forced_words = int(os.environ.get("CAPCUT_WPL", "") or 0)
    except ValueError:
        forced_words = 0
    try:
        forced_lines = int(os.environ.get("CAPCUT_MAX_LINES", "") or 0)
    except ValueError:
        forced_lines = 0
    language = (capcut_language or "").strip().lower()
    for prefix, (words, lines) in LINE_LAYOUTS.items():
        if language.startswith(prefix):
            return forced_words or words, forced_lines or lines
    return forced_words or DEFAULT_LINE_LAYOUT[0], forced_lines or DEFAULT_LINE_LAYOUT[1]


def new_device() -> dict:
    did = str(random.randint(7 * 10**18, 8 * 10**18))
    platform, kind, os_version, channel = random.choice([
        ("windows", "Windows", "10.0.19045", "capcutpc_google"),
        ("mac", "MacBookPro17,4", "15.7.4", "capcutpc_google"),
        ("mac", "MacBookPro18,3", "14.6.1", "capcutpc_google"),
    ])
    return {
        "aid": AID, "app_name": "CapCut", "appvr": APP_VERSION,
        "version_name": APP_VERSION, "version_code": APP_VERSION,
        "channel": channel, "device_platform": platform, "device_type": kind,
        "device_brand": kind, "os_version": os_version, "device_id": did,
        "iid": did, "tdid": did, "region": "VN", "loc": "VN",
        "lan": "vi-VN", "pf": "3",
    }

def query(device: dict, feature=None, region=True) -> dict:
    keys = ("app_name", "device_type", "os_version", "channel", "version_name",
            "device_brand", "device_id", "iid", "version_code", "device_platform", "aid")
    result = {key: device[key] for key in keys}
    if region:
        result["region"] = device["region"]
    if feature is not None:
        result["babi_param"] = compact(feature)
    return result


def signature(path: str, device_time: str, tdid: str) -> str:
    value = "9e2c|%s|3|%s|%s|%s|11ac" % (path[-7:], APP_VERSION, device_time, tdid)
    return hashlib.md5(value.encode()).hexdigest()


def headers(device: dict, body: str, include_app=True) -> dict:
    now = str(int(time.time()))
    seed = uuid.uuid4().hex[:32]
    result = {
        "content-type": "application/json", "appvr": device["appvr"],
        "ch": device["channel"], "device-time": now, "lan": device["lan"],
        "loc": device["loc"], "pf": device["pf"], "sign-ver": "1",
        "tdid": device["tdid"], "x-ss-stub": hashlib.md5(body.encode()).hexdigest(),
        "x-ss-dp": device["aid"], "x-khronos": now,
        "x-tt-trace-id": "00-%s-%s-01" % (seed, seed[:16]),
        "user-agent": "Cronet/TTNetVersion:1d7cc3b1 2025-07-16 QuicVersion:52c2b40d 2025-04-03",
        "accept-encoding": "gzip, deflate", "store-country-code": device["loc"].lower(),
        "store-country-code-src": "did", "is-dispatch-us-ttp": "0",
        "is-app-region-us-ttp": "0",
    }
    if include_app:
        result.update({"app-sdk-version": device["appvr"], "appid": device["aid"]})
    return result


def post(path: str, body_value: dict, device: dict, feature=None, include_app=True, timeout=60) -> dict:
    body = compact(body_value)
    url = BASE_URL + path + "?" + urlencode(query(device, feature, feature is not None))
    request_headers = headers(device, body, include_app)
    request_headers["sign"] = signature(path, request_headers["device-time"], device["tdid"])
    try:
        response = requests.post(url, headers=request_headers, data=body.encode(), timeout=timeout)
        response.raise_for_status()
    except requests.RequestException as error:
        raise CapCutNetworkError(f"CapCut không kết nối được {path}: {str(error)[:160]}") from error
    try:
        value = response.json()
    except (ValueError, json.JSONDecodeError) as error:
        raise CapCutApiError(f"CapCut {path} trả dữ liệu không phải JSON") from error
    ret = value.get("ret") if isinstance(value, dict) else None
    if ret is not None and str(ret) != "0":
        message = str(value.get("errmsg") or value.get("message") or "unknown")[:160]
        raise CapCutApiError(f"CapCut {path} từ chối ret={ret}: {message}")
    return value


def request_json(method: str, url: str, **kwargs) -> dict:
    try:
        response = requests.request(method, url, **kwargs)
        response.raise_for_status()
    except requests.RequestException as error:
        raise CapCutNetworkError(f"CapCut VOD {method} lỗi: {str(error)[:160]}") from error
    try:
        value = response.json()
    except (ValueError, json.JSONDecodeError) as error:
        raise CapCutApiError("CapCut VOD trả dữ liệu không phải JSON") from error
    if not isinstance(value, dict):
        raise CapCutApiError("CapCut VOD trả cấu trúc không hợp lệ")
    return value


def request_ok(method: str, url: str, **kwargs) -> requests.Response:
    try:
        response = requests.request(method, url, **kwargs)
        response.raise_for_status()
        return response
    except requests.RequestException as error:
        raise CapCutNetworkError(f"CapCut upload {method} lỗi: {str(error)[:160]}") from error


def signing_key(secret: str, date_string: str) -> bytes:
    key = hmac.new(("AWS4" + secret).encode(), date_string.encode(), hashlib.sha256).digest()
    key = hmac.new(key, VOD_REGION.encode(), hashlib.sha256).digest()
    key = hmac.new(key, VOD_SERVICE.encode(), hashlib.sha256).digest()
    return hmac.new(key, b"aws4_request", hashlib.sha256).digest()


def vod_headers(method: str, url: str, body: bytes, credentials: dict) -> dict:
    amz = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    date_string = amz[:8]
    scope = "%s/%s/%s/aws4_request" % (date_string, VOD_REGION, VOD_SERVICE)
    signed = "x-amz-date;x-amz-security-token"
    canonical_headers = "x-amz-date:%s\nx-amz-security-token:%s\n" % (amz, credentials["session_token"])
    canonical = "\n".join([
        method, urlsplit(url).path,
        "&".join("%s=%s" % pair for pair in sorted(parse_qsl(urlsplit(url).query, keep_blank_values=True))),
        canonical_headers, signed, hashlib.sha256(body).hexdigest(),
    ])
    value = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    digest = hmac.new(signing_key(credentials["secret_access_key"], date_string), value.encode(), hashlib.sha256).hexdigest()
    return {
        "Authorization": "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
                         % (credentials["access_key_id"], scope, signed, digest),
        "Date": dt.datetime.now(dt.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT"),
        "X-Amz-Date": amz, "X-Amz-Security-Token": credentials["session_token"],
        "User-Agent": "BDFileUpload(%d)" % int(time.time() * 1000),
    }


def upload(data: bytes, device: dict) -> tuple[str, str]:
    md5 = hashlib.md5(data).hexdigest()
    crc = "%08x" % (zlib.crc32(data) & 0xFFFFFFFF)
    response = post("/lv/v1/upload_sign", {"biz": "cc_pc_text_recognize", "key_version": "v5"}, device)
    credentials = (response or {}).get("data") or {}
    if not credentials.get("access_key_id"):
        raise CapCutApiError("CapCut upload_sign không trả thông tin upload")
    apply_url = "https://%s/top/v1?%s" % (credentials["domain"], urlencode({
        "Action": "ApplyUploadInner", "SpaceName": credentials["space_name"],
        "UseQuic": "false", "Version": "2020-11-19", "device_platform": "win",
    }))
    applied = request_json("GET", apply_url, headers=vod_headers("GET", apply_url, b"", credentials), timeout=60)
    node = (((applied.get("Result") or {}).get("InnerUploadAddress") or {}).get("UploadNodes") or [{}])[0]
    store = (node.get("StoreInfos") or [{}])[0]
    vid = node.get("Vid") or (node.get("Vids") or [None])[0]
    if not vid:
        raise CapCutApiError("CapCut ApplyUploadInner không trả Vid")
    transfer = "https://%s/upload/v1/%s?%s" % (node["UploadHost"], store["StoreUri"], urlencode({
        "uploadid": store["UploadID"], "part_number": "0", "phase": "transfer",
    }))
    upload_headers = {
        "Authorization": store["Auth"], "X-Upload-Content-CRC32": crc,
        "Date": dt.datetime.now(dt.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT"),
        "User-Agent": "BDFileUpload(%d)" % int(time.time() * 1000),
        "accept-encoding": "identity", "store-country-code": str(device.get("loc", "vn")).lower(),
        "store-country-code-src": "did", "is-dispatch-us-ttp": "0", "is-app-region-us-ttp": "0",
        "tdid": device.get("tdid", ""), "pf": device.get("pf", ""),
    }
    request_ok("POST", transfer, headers=upload_headers, data=data, timeout=300)
    finish = "https://%s/upload/v1/%s?%s" % (node["UploadHost"], store["StoreUri"], urlencode({
        "uploadmode": "part", "phase": "finish", "uploadid": store["UploadID"],
    }))
    finish_headers = dict(upload_headers)
    finish_headers.pop("X-Upload-Content-CRC32", None)
    request_ok("POST", finish, headers=finish_headers, data=("0:%s" % crc).encode(), timeout=60)
    commit = "https://%s/top/v1?%s" % (credentials["domain"], urlencode({
        "Action": "CommitUploadInner", "SpaceName": credentials["space_name"],
        "Version": "2020-11-19", "device_platform": "win",
    }))
    body = compact({"Functions": [{"Input": {"SnapshotTime": 0.0}, "Name": "Snapshot"}],
                    "SessionKey": node["SessionKey"]}).encode()
    request_ok("POST", commit, headers=vod_headers("POST", commit, body, credentials), data=body, timeout=120)
    return str(vid), md5


def submit(vid: str, md5: str, duration_ms: int, language: str, device: dict) -> tuple[str, str]:
    words_per_line, max_lines = line_parameters(language)
    cap = {
        "adjust_endtime": 200, "audio": vid, "audio_type": "vid", "caption_type": 0,
        "client_request_id": str(uuid.uuid4()), "duration": duration_ms,
        "enable_cache": False, "enter_from": "asr", "language": language,
        "max_lines": max_lines, "md5": md5, "pack_options": {"need_attribute": True},
        "songs_info": [{"end_time": float(duration_ms), "id": "", "start_time": 0}],
        "translation_language": "vi-VN", "use_translation": False,
        "words_per_line": words_per_line,
    }
    request_key = "cc_audio_subtitle_asr"
    task = {"context": str(uuid.uuid4()), "payload": compact({"cap_json": cap}),
            "req_key": request_key, "task_version": "v3"}
    response = post("/lv/v1/common_task/new", {
        "bind_id": str(uuid.uuid4()).upper(), "can_queue": True,
        "enter_from": "asr", "tasks": [task],
    }, device, FEATURE, False)
    item = (((response or {}).get("data") or {}).get("tasks") or [{}])[0]
    if not item.get("id"):
        raise CapCutApiError("CapCut không trả task id")
    return str(item["id"]), str(item.get("token") or "")


def poll(task_id: str, token: str, device: dict, timeout_seconds=120) -> dict:
    started = time.time()
    while time.time() - started < timeout_seconds:
        response = post("/lv/v1/common_task/query", {"tasks": [{
            "bind_id": "", "id": task_id, "req_key": "cc_audio_subtitle_asr",
            "task_version": "v3", "token": token,
        }]}, device, None, False)
        task = (((response or {}).get("data") or {}).get("tasks") or [{}])[0]
        if task.get("status") == "succeed":
            payload = task.get("payload")
            return json.loads(payload) if isinstance(payload, str) else (payload or {})
        if task.get("status") in ("failed", "fail"):
            raise CapCutApiError("CapCut ASR task thất bại: %s" % (task.get("err_msg") or "unknown"))
        time.sleep(3)
    raise CapCutApiError("CapCut ASR quá hạn")


def adaptive_poll_timeout(duration_ms: int | float | None) -> int:
    """ViralCrawl-compatible ASR timeout: 2x measured work + 25s, 40..600s."""
    try:
        minutes = max(0.0, float(duration_ms or 0) / 60000.0)
    except (TypeError, ValueError):
        minutes = 10.0
    return int(round(max(40.0, min(600.0, 2.0 * (6.0 + 0.8 * minutes) + 25.0))))


def network_ok(timeout=4) -> bool:
    """Probe all resolved addresses under one deadline and cache both outcomes."""
    try:
        ttl = float(os.environ.get(
            "CAPCUT_MANG_TTL",
            os.environ.get("CAPCUT_NETWORK_TTL", "120")
        ) or 120)
    except ValueError:
        ttl = 120.0
    now = time.monotonic()
    if ttl > 0 and _NETWORK_CACHE[1] is not None and now - _NETWORK_CACHE[0] < ttl:
        return bool(_NETWORK_CACHE[1])
    deadline = now + max(0.1, float(timeout or 4))
    result = False
    try:
        addresses = socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)
    except OSError:
        addresses = []
    per_address = max(0.5, max(0.1, float(timeout or 4)) / max(1, len(addresses)))
    seen = set()
    for family, socktype, proto, _canonname, sockaddr in addresses:
        key = (family, sockaddr)
        if key in seen:
            continue
        seen.add(key)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        connection = None
        try:
            connection = socket.socket(family, socktype, proto)
            connection.settimeout(min(per_address, remaining))
            connection.connect(sockaddr)
            result = True
            break
        except OSError:
            continue
        finally:
            if connection is not None:
                connection.close()
    _NETWORK_CACHE[0], _NETWORK_CACHE[1] = time.monotonic(), result
    return result


def extract_audio(video: str, output: str, ffmpeg: str) -> None:
    result = subprocess.run([ffmpeg, "-y", "-v", "error", "-i", video, "-vn", "-ac", "1",
                             "-ar", "16000", "-b:a", "64k", output], capture_output=True, timeout=180)
    if result.returncode != 0 or not os.path.isfile(output) or os.path.getsize(output) < 200:
        raise CapCutError("Không trích được audio cho CapCut ASR")


def probe_duration_ms(audio: str, ffprobe: str | None) -> int:
    if not ffprobe:
        return 0
    try:
        result = subprocess.run([
            ffprobe, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nk=1:nw=1", audio,
        ], capture_output=True, text=True, errors="replace", timeout=30)
        return max(0, int(float((result.stdout or "").strip()) * 1000))
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def run(args) -> int:
    if not network_ok(timeout=4):
        raise CapCutNetworkError("Không kết nối được CapCut trong thời hạn kiểm tra mạng")
    audio = str(Path(args.output).with_suffix(".capcut-asr.mp3"))
    try:
        emit("extracting_audio")
        extract_audio(os.path.abspath(args.video), audio, os.path.abspath(args.ffmpeg))
        data = Path(audio).read_bytes()
        measured_duration_ms = int(float(args.duration or 0) * 1000)
        if measured_duration_ms <= 0:
            measured_duration_ms = probe_duration_ms(audio, args.ffprobe)
        duration_ms = measured_duration_ms if measured_duration_ms > 0 else 600000
        payload = None
        last_error = None
        max_attempts = max(1, args.attempts)
        try:
            retry_delay = max(0.0, float(os.environ.get("CAPCUT_ASR_NGHI", "2") or 2))
        except ValueError:
            retry_delay = 2.0
        for attempt in range(1, max_attempts + 1):
            # ViralCrawl creates a fresh anonymous ASR identity per attempt.
            # It avoids carrying an API/device rejection into the retry.
            device = new_device()
            try:
                emit("uploading", attempt=attempt, attempts=max_attempts)
                vid, md5 = upload(data, device)
                emit("submitting", attempt=attempt)
                task_id, token = submit(vid, md5, duration_ms, language_code(args.language), device)
                emit("polling", attempt=attempt, taskId=task_id)
                poll_timeout = args.timeout if args.timeout > 0 else adaptive_poll_timeout(duration_ms)
                payload = poll(task_id, token, device, poll_timeout)
                break
            except CapCutNoSpeech:
                raise
            except (CapCutNetworkError, CapCutApiError) as error:
                last_error = error
                if attempt >= max_attempts:
                    raise
                emit(
                    "retrying", attempt=attempt + 1, reason=str(error)[:240],
                    refreshedDevice=True, category=("network" if isinstance(error, CapCutNetworkError) else "api"),
                )
                if retry_delay > 0:
                    time.sleep(retry_delay)
        if payload is None:
            raise last_error or CapCutApiError("CapCut ASR không trả payload")
        cues = []
        for item in payload.get("utterances") or []:
            text = str(item.get("text") or "").strip()
            start_ms, end_ms = int(item.get("start_time") or 0), int(item.get("end_time") or 0)
            if text and end_ms > start_ms:
                cues.append({"text": text, "startMs": start_ms, "endMs": end_ms})
        if not cues:
            reason = (((payload.get("attribute") or {}).get("extra") or {}).get("empty_reason")) or ""
            if reason in EMPTY_NO_SPEECH_REASONS:
                raise CapCutNoSpeech(f"CapCut xác nhận audio không có lời thoại ({reason})")
            raise CapCutApiError("CapCut ASR trả 0 cue")
        result = {"version": 1, "engineId": "capcut-asr", "language": args.language,
                  "languageConfidence": None, "cues": cues, "attempts": attempt,
                  "deviceIdSuffix": str(device.get("device_id", ""))[-6:]}
        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(f".{output.name}.{os.getpid()}.{time.time_ns()}.tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, output)
        emit("result", cues=len(cues), output=os.path.abspath(args.output))
        return 0
    finally:
        try:
            os.remove(audio)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", default="")
    parser.add_argument("--duration", type=float, default=0)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--timeout", type=int, default=0,
                        help="0 = tự tính theo thời lượng video (40-600 giây)")
    parser.add_argument("--attempts", type=int, default=2)
    args = parser.parse_args()
    try:
        return run(args)
    except CapCutNoSpeech as error:
        emit("no_speech", message=str(error))
        return 42
    except CapCutNetworkError as error:
        emit("error", message=str(error)[:500], category="network", retryable=True)
        return 1
    except CapCutApiError as error:
        emit("error", message=str(error)[:500], category="api", retryable=True)
        return 1
    except Exception as error:
        emit("error", message=str(error)[:500], category="runtime", retryable=False)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
