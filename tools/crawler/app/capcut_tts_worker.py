# -*- coding: utf-8 -*-
"""CapCut anonymous TTS batch worker used by the desktop voice engine."""
import argparse
import base64
import hashlib
import json
import os
import random
import secrets
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlencode

import requests

BASE_URL = os.environ.get("CAPCUT_BASE") or "https://editor-api-sg.capcutapi.com"
AID = "359289"
APP_VERSION = os.environ.get("CAPCUT_APPVR") or "8.7.0"
PATH_NEW = "/lv/v1/common_task/new"
PATH_QUERY = "/lv/v1/common_task/query"
BATCH_SIZE = max(1, int(os.environ.get("CAPCUT_LO") or "40"))
CONCURRENCY = max(1, int(os.environ.get("CAPCUT_SONG_SONG") or "6"))
REPAIR_BATCH_SIZE = max(1, int(os.environ.get("CAPCUT_LO_BU") or "10"))
POLL_SECONDS = max(10, int(os.environ.get("CAPCUT_POLL_SECONDS") or "90"))
BATCH_BUDGET_SECONDS = max(POLL_SECONDS, int(
    os.environ.get("CAPCUT_BATCH_BUDGET_SECONDS") or str(POLL_SECONDS * 4)))
MIN_SPLIT_BATCH_SIZE = max(1, int(os.environ.get("CAPCUT_MIN_SPLIT_BATCH") or "8"))
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmTd34Lw4b7IuldSXh/zY
CMla+ITdGG5TeWz6ad+OySd4r+IrY45AoqrYUxhQ2dl+7z+i7r/5vEa8rr39BYfB
8AGMQLmZA8HmgpWBsqrn/V6daUALkKnkLb70Fn32CJigIuGXAYqxUdGuI340aC+0
v5Es3puJsHyzf01/AelE4Cdc6bZhQrASJLBh8R3BQToYClmDVSDUQk28o8sl/guA
Z4n303Vj+6Siv1HayPCdV6kpVVnMBAG4+umUbwGmn132N3fgpzLarFF3XyWmS1zh
D/J07iM/rP8GDO9IskHNHd2phrO0G6KzrcFAnTBHjVv+hCBEfzN/no3FNA9AuC36
mwIDAQAB
-----END PUBLIC KEY-----"""
MACHINES = [
    ("mac", "MacBookPro17,4", "15.7.4", "capcutpc_google"),
    ("windows", "Windows", "10.0.19045", "capcutpc_google"),
    ("mac", "MacBookPro18,3", "14.6.1", "capcutpc_google"),
]
BABI = {
    "feature_entrance": "editor",
    "feature_entrance_detail": "editor-feature-text_to_speech",
    "feature_key": "text_to_speech",
    "scenario": "video_editor",
}


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def der_length(data, index):
    value = data[index]
    index += 1
    if value < 0x80:
        return value, index
    width = value & 0x7F
    return int.from_bytes(data[index:index + width], "big"), index + width


def der_value(data, index, tag):
    if data[index] != tag:
        raise ValueError("invalid DER tag")
    length, index = der_length(data, index + 1)
    return data[index:index + length], index + length


def der_int(data, index):
    raw, index = der_value(data, index, 0x02)
    return int.from_bytes(raw.lstrip(b"\x00"), "big"), index


def public_numbers():
    encoded = "".join(line for line in PUBLIC_KEY.splitlines() if not line.startswith("-----"))
    outer, _ = der_value(base64.b64decode(encoded), 0, 0x30)
    _, index = der_value(outer, 0, 0x30)
    bits, _ = der_value(outer, index, 0x03)
    rsa, _ = der_value(bits[1:], 0, 0x30)
    modulus, index = der_int(rsa, 0)
    exponent, _ = der_int(rsa, index)
    return modulus, exponent


def rsa_encrypt(message):
    modulus, exponent = public_numbers()
    width = (modulus.bit_length() + 7) // 8
    raw = message.encode("utf-8")
    padding = bytearray()
    while len(padding) < width - len(raw) - 3:
        padding.extend(value for value in secrets.token_bytes(width - len(raw) - 3 - len(padding)) if value)
    packet = b"\x00\x02" + bytes(padding[:width - len(raw) - 3]) + b"\x00" + raw
    encrypted = pow(int.from_bytes(packet, "big"), exponent, modulus).to_bytes(width, "big")
    return base64.b64encode(encrypted).decode("ascii")


def device_path(payload):
    explicit = str(payload.get("deviceFile") or "").strip()
    if explicit:
        return explicit
    root = os.environ.get("APPDATA") or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(root, "video-studio-tools", "capcut_tts_device.json")


def new_device():
    device_id = str(random.randint(7 * 10 ** 18, 8 * 10 ** 18))
    platform, kind, version, channel = random.choice(MACHINES)
    return {
        "aid": AID, "app_name": "CapCut", "appvr": APP_VERSION,
        "version_name": APP_VERSION, "version_code": APP_VERSION,
        "channel": channel, "device_platform": platform, "device_type": kind,
        "device_brand": kind, "os_version": version, "device_id": device_id,
        "iid": device_id, "tdid": device_id, "region": "VN", "loc": "VN",
        "lan": "vi-VN", "pf": "3",
    }


def load_device(payload, renew=False):
    target = device_path(payload)
    if not renew:
        try:
            with open(target, encoding="utf-8") as stream:
                saved = json.load(stream)
            if saved.get("device_id"):
                saved["appvr"] = saved["version_name"] = saved["version_code"] = APP_VERSION
                return saved
        except (OSError, ValueError, AttributeError):
            pass
    device = new_device()
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as stream:
            json.dump(device, stream, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return device


def query(device, include_babi=True, include_region=True):
    keys = ("app_name", "device_type", "os_version", "channel", "version_name",
            "device_brand", "device_id", "iid", "version_code", "device_platform", "aid")
    result = {key: device[key] for key in keys}
    if include_region:
        result["region"] = device["region"]
    if include_babi:
        result["babi_param"] = compact(BABI)
    return result


def headers(device, body, path):
    now = str(int(time.time()))
    seed = uuid.uuid4().hex
    result = {
        "content-type": "application/json", "appvr": device["appvr"],
        "ch": device["channel"], "device-time": now, "lan": device["lan"],
        "loc": device["loc"], "pf": device["pf"], "sign-ver": "1",
        "tdid": device["tdid"], "x-ss-stub": hashlib.md5(body.encode()).hexdigest(),
        "x-ss-dp": device["aid"], "x-khronos": now,
        "x-tt-trace-id": "00-%s-%s-01" % (seed, seed[:16]),
        "user-agent": "Cronet/TTNetVersion:1d7cc3b1 2025-07-16 QuicVersion:52c2b40d 2025-04-03",
        "accept-encoding": "gzip, deflate", "store-country-code": device["loc"].lower(),
        "store-country-code-src": "did", "is-dispatch-us-ttp": "0", "is-app-region-us-ttp": "0",
        "app-sdk-version": device["appvr"], "appid": device["aid"],
    }
    result["sign"] = hashlib.md5(
        ("9e2c|%s|3|%s|%s|%s|11ac" % (path[-7:], APP_VERSION, now, device["tdid"])).encode()
    ).hexdigest()
    return result


def post(path, body_value, device, include_babi=True, include_region=True):
    body = compact(body_value)
    url = BASE_URL + path + "?" + urlencode(query(device, include_babi, include_region))
    response = requests.post(url, headers=headers(device, body, path), data=body.encode("utf-8"), timeout=60)
    response.raise_for_status()
    return response.json()


def xml_escape(value):
    return (str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


class CapCutBatchError(RuntimeError):
    def __init__(self, message, reason="failed"):
        super().__init__(message)
        self.reason = reason


def create_task(items, device):
    need_timestamps = any(item.get("children") for item in items)
    timestamp_text = "true" if need_timestamps else "false"
    providers = {"11labs" if item.get("provider") == "11labs" else "sami" for item in items}
    if len(providers) != 1:
        raise RuntimeError("CapCut batch mixes incompatible TTS providers")
    provider = providers.pop()
    voices = []
    for item in items:
        voices.append(
            '    <voice name="%s" mock_tone_info="" platform="%s" resource_id="%s" '
            'emotion="" emotion_scale="0" style="" role="" moyin_emotion="" '
            'is_clone_tone="false" need_subtitle_timestamp="%s">\n'
            '        <prosody rate="1.0">%s</prosody>\n    </voice>'
            % (item["voiceType"], provider, item["resourceId"], timestamp_text, xml_escape(item["text"]))
        )
    ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\n'
    ssml += "\n".join(voices) + "\n</speak>"
    extra = compact({"benefit_info": {}})
    inner = {
        "audio_format": "mp3", "babi_param": compact(BABI), "credit_disable": False,
        "extra_info": extra, "need_merge_voice": False,
        "need_subtitle_timestamp": need_timestamps,
        "scene": "text_to_speech", "ssml": ssml,
    }
    signature = "appid:%s&did:%s&creditDisable:false&ssml:%s&extraInfo:%s" % (
        AID, device["device_id"], hashlib.md5(ssml.encode("utf-8")).hexdigest(), extra
    )
    inner["sign"] = rsa_encrypt(signature)
    response = post(PATH_NEW, {
        "bind_id": str(uuid.uuid4()), "can_queue": True, "enter_from": "text_to_speech",
        "tasks": [{"context": str(uuid.uuid4()), "payload": compact(inner),
                   "req_key": provider + "_text_to_speech", "task_version": "v3"}],
    }, device)
    if str(response.get("ret")) != "0":
        reason = str(response.get("errmsg") or response.get("ret") or "CapCut rejected request")
        blocked = str(response.get("ret")) == "-6" or "shark block" in reason.lower()
        raise CapCutBatchError(reason, "blocked" if blocked else "rejected")
    task = response["data"]["tasks"][0]
    return task["id"], task["token"]


def poll_task(task_id, token, device, deadline_limit=None):
    deadline = time.time() + POLL_SECONDS
    if deadline_limit is not None:
        deadline = min(deadline, deadline_limit)
    while time.time() < deadline:
        time.sleep(1)
        try:
            response = post(PATH_QUERY, {
                "tasks": [{"bind_id": "", "id": task_id, "req_key": "sami_text_to_speech",
                           "task_version": "v3", "token": token}]
            }, device, include_babi=False, include_region=False)
            task = response["data"]["tasks"][0]
        except (KeyError, IndexError, TypeError, ValueError, requests.RequestException):
            continue
        status = task.get("status")
        if status == "succeed":
            try:
                audio = json.loads(task["payload"])["audio_subtitles"]
            except (KeyError, TypeError, ValueError) as error:
                raise CapCutBatchError("CapCut returned an invalid task payload: %s" % error,
                                       "invalid_payload")
            if not isinstance(audio, list):
                raise CapCutBatchError("CapCut audio_subtitles is not a list", "invalid_payload")
            return audio
        if status not in ("queueing", "processing", "running"):
            raise CapCutBatchError("CapCut task status=%s" % status, "failed")
    raise CapCutBatchError("CapCut TTS timed out", "timeout")


def request_once(items, payload, device, deadline):
    try:
        task_id, token = create_task(items, device)
        audio = poll_task(task_id, token, device, deadline)
        if len(audio) != len(items):
            raise CapCutBatchError(
                "CapCut returned %d/%d audio items" % (len(audio), len(items)),
                "length_mismatch")
        return [None if item.get("invalid_input") or not item.get("speech_url") else item
                for item in audio], "ok", None
    except requests.RequestException as error:
        return None, "network", error
    except CapCutBatchError as error:
        return None, error.reason, error
    except Exception as error:
        return None, "failed", error


def request_batch(items, payload, deadline=None):
    if deadline is None:
        deadline = time.time() + BATCH_BUDGET_SECONDS
    if time.time() >= deadline:
        return [None] * len(items)
    device = load_device(payload)
    audio, reason, last_error = request_once(items, payload, device, deadline)
    if audio is not None:
        return audio
    sys.stderr.write("CapCut batch %d cues failed (%s): %s; retrying\n"
                     % (len(items), reason, last_error))

    if time.time() < deadline:
        retry_device = load_device(payload, renew=(reason == "blocked"))
        audio, reason, last_error = request_once(items, payload, retry_device, deadline)
        if audio is not None:
            sys.stderr.write("CapCut batch retry recovered %d/%d cues\n"
                             % (sum(1 for item in audio if item), len(items)))
            return audio

    if len(items) > MIN_SPLIT_BATCH_SIZE and time.time() < deadline:
        middle = len(items) // 2
        sys.stderr.write("CapCut batch retry failed (%s); splitting %d into %d+%d\n"
                         % (reason, len(items), middle, len(items) - middle))
        return (request_batch(items[:middle], payload, deadline)
                + request_batch(items[middle:], payload, deadline))
    if time.time() >= deadline:
        sys.stderr.write("CapCut batch exhausted %ds total budget; dropping %d cues\n"
                         % (BATCH_BUDGET_SECONDS, len(items)))
    else:
        sys.stderr.write("CapCut batch failed (%s): %s\n" % (reason, last_error))
    return [None] * len(items)


def normalize_split_text(value):
    return "".join(char.lower() for char in str(value or "") if char.isalnum() or char == "_")


def convert_audio(temp, output, ffmpeg, start_ms=None, end_ms=None):
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", temp]
    if start_ms is not None:
        command += ["-ss", "%.3f" % (max(0, start_ms) / 1000.0)]
    if end_ms is not None:
        duration_ms = max(1, end_ms - max(0, start_ms or 0))
        command += ["-t", "%.3f" % (duration_ms / 1000.0)]
    command += ["-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-y", output]
    process = subprocess.run(
        command, capture_output=True, text=True, timeout=120,
        creationflags=(0x08000000 if os.name == "nt" else 0)
    )
    if process.returncode != 0 or not os.path.isfile(output) or os.path.getsize(output) <= 44:
        raise RuntimeError((process.stderr or "ffmpeg produced empty wav")[-300:])


def merged_boundaries(item, audio):
    utterances = audio.get("utterances") or []
    pieces = []
    cursor = 0
    for child in item.get("children") or []:
        target = normalize_split_text(child.get("text"))
        collected = ""
        start_ms = None
        end_ms = None
        while cursor < len(utterances) and len(collected) < len(target):
            utterance = utterances[cursor]
            if start_ms is None:
                start_ms = utterance.get("start_time")
            collected += normalize_split_text(utterance.get("word"))
            end_ms = utterance.get("end_time")
            cursor += 1
        if collected != target or start_ms is None or end_ms is None:
            raise RuntimeError("CapCut utterance timestamps do not match merged cue text")
        next_start = (utterances[cursor].get("start_time") if cursor < len(utterances)
                      else end_ms + 250)
        pieces.append((child, start_ms, max(end_ms, min(next_start, end_ms + 600))))
    return pieces


def split_merged_audio(item, audio, temp, ffmpeg):
    pieces = item.get("_mergedBoundaries") or merged_boundaries(item, audio)
    results = []
    for child, start_ms, end_ms in pieces:
        output = os.path.abspath(child["outputPath"])
        os.makedirs(os.path.dirname(output), exist_ok=True)
        convert_audio(temp, output, ffmpeg, start_ms, end_ms)
        results.append({"key": child.get("key"), "ok": True, "outputPath": output,
                        "mergedSentence": True})
    return results


def child_units(item):
    return [{
        "key": child.get("key"),
        "text": child.get("text"),
        "outputPath": child.get("outputPath"),
        "voiceType": item.get("voiceType"),
        "resourceId": item.get("resourceId"),
        "provider": item.get("provider") or "sami",
        "fallbackFromMerged": True,
    } for child in (item.get("children") or [])]


def request_units(units, payload, batch_size):
    if not units:
        return []
    provider_indexes = {}
    for index, item in enumerate(units):
        provider = "11labs" if item.get("provider") == "11labs" else "sami"
        provider_indexes.setdefault(provider, []).append(index)
    batches = []
    for indexes in provider_indexes.values():
        batches.extend(indexes[start:start + batch_size]
                       for start in range(0, len(indexes), batch_size))
    audio_items = [None] * len(units)
    with ThreadPoolExecutor(max_workers=min(CONCURRENCY, len(batches))) as executor:
        futures = {
            executor.submit(request_batch, [units[index] for index in indexes], payload): indexes
            for indexes in batches
        }
        for future in as_completed(futures):
            indexes = futures[future]
            try:
                batch_audio = future.result()
            except Exception as error:
                sys.stderr.write("CapCut request failed: %s\n" % error)
                batch_audio = [None] * len(indexes)
            for item_index, audio in zip(indexes, batch_audio):
                audio_items[item_index] = audio
    return audio_items


def repair_missing_units(units, audio_items, payload):
    missing = [index for index, audio in enumerate(audio_items) if not audio]
    if not missing:
        return audio_items
    provider_indexes = {}
    for index in missing:
        provider = "11labs" if units[index].get("provider") == "11labs" else "sami"
        provider_indexes.setdefault(provider, []).append(index)
    groups = []
    for indexes in provider_indexes.values():
        groups.extend(indexes[start:start + REPAIR_BATCH_SIZE]
                      for start in range(0, len(indexes), REPAIR_BATCH_SIZE))
    with ThreadPoolExecutor(max_workers=min(CONCURRENCY, len(groups))) as executor:
        futures = {
            executor.submit(request_batch, [units[index] for index in group], payload): group
            for group in groups
        }
        for future in as_completed(futures):
            group = futures[future]
            try:
                repaired = future.result()
            except Exception as error:
                sys.stderr.write("CapCut repair batch failed: %s\n" % error)
                repaired = [None] * len(group)
            for item_index, audio in zip(group, repaired):
                if audio:
                    audio_items[item_index] = audio
    return audio_items


def download_and_convert(item, audio, ffmpeg):
    url = audio.get("speech_url") if audio else None
    result_keys = [child.get("key") for child in item.get("children", [])] or [item.get("key")]
    if not url:
        return [{"key": key, "ok": False, "error": "missing_url"} for key in result_keys]
    output = os.path.abspath(item["outputPath"])
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temp = output + ".capcut.mp3"
    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        if len(response.content) < 200:
            raise RuntimeError("CapCut returned an empty or truncated audio file")
        with open(temp, "wb") as stream:
            stream.write(response.content)
        if item.get("children"):
            return split_merged_audio(item, audio, temp, ffmpeg)
        convert_audio(temp, output, ffmpeg)
        result = {"key": item.get("key"), "ok": True, "outputPath": output}
        if item.get("fallbackFromMerged"):
            result["fallbackFromMerged"] = True
        return [result]
    except Exception as error:
        for child in item.get("children") or []:
            try:
                os.remove(os.path.abspath(child["outputPath"]))
            except OSError:
                pass
        return [{"key": key, "ok": False, "error": str(error)[:300]} for key in result_keys]
    finally:
        try:
            os.remove(temp)
        except OSError:
            pass


def run(payload):
    if os.environ.get("CAPCUT_TAT") == "1":
        raise RuntimeError("CapCut TTS has been disabled by CAPCUT_TAT=1")
    items = [item for item in payload.get("items", []) if str(item.get("text") or "").strip()]
    ffmpeg = str(payload.get("ffmpegPath") or "ffmpeg")
    audio_items = repair_missing_units(
        items, request_units(items, payload, BATCH_SIZE), payload)

    # A merged request is only useful when CapCut's word timestamps can be mapped
    # back to every original cue. Validate that mapping before downloading/cutting.
    # If it is incomplete, restore those children to the regular per-cue batch path.
    primary_jobs = []
    fallback_units = []
    for item, audio in zip(items, audio_items):
        if not item.get("children"):
            primary_jobs.append((item, audio))
            continue
        if not audio:
            fallback_units.extend(child_units(item))
            continue
        try:
            validated_item = dict(item)
            validated_item["_mergedBoundaries"] = merged_boundaries(item, audio)
            primary_jobs.append((validated_item, audio))
        except Exception as error:
            sys.stderr.write("CapCut merged timestamps rejected; retrying original cues: %s\n" % error)
            fallback_units.extend(child_units(item))

    primary_groups = [None] * len(primary_jobs)
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(primary_jobs)))) as executor:
        futures = {
            executor.submit(download_and_convert, item, audio, ffmpeg): index
            for index, (item, audio) in enumerate(primary_jobs)
        }
        for future in as_completed(futures):
            index = futures[future]
            primary_groups[index] = future.result()

    # A merged URL can still fail while downloading or cutting. In that case the
    # original cues get one more chance through the same-voice batched endpoint.
    for (item, _audio), group in zip(primary_jobs, primary_groups):
        if item.get("children") and not all(result.get("ok") for result in (group or [])):
            fallback_units.extend(child_units(item))

    fallback_audio = repair_missing_units(
        fallback_units, request_units(fallback_units, payload, BATCH_SIZE), payload)
    fallback_groups = [None] * len(fallback_units)
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(fallback_units)))) as executor:
        futures = {
            executor.submit(download_and_convert, item, fallback_audio[index], ffmpeg): index
            for index, item in enumerate(fallback_units)
        }
        for future in as_completed(futures):
            index = futures[future]
            fallback_groups[index] = future.result()

    by_key = {}
    for group in primary_groups + fallback_groups:
        for result in group or []:
            key = result.get("key")
            if key is not None and (key not in by_key or result.get("ok")):
                by_key[key] = result

    ordered_keys = []
    for item in items:
        children = item.get("children") or []
        ordered_keys.extend(child.get("key") for child in children)
        if not children:
            ordered_keys.append(item.get("key"))
    results = [by_key.get(key, {"key": key, "ok": False, "error": "missing_result"})
               for key in ordered_keys]
    recovered = sum(1 for result in results
                    if result.get("ok") and result.get("fallbackFromMerged"))
    return {
        "ok": any(result.get("ok") for result in results),
        "results": results,
        "fallbackMergedCues": recovered,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        print(compact({"ok": os.environ.get("CAPCUT_TAT") != "1", "online": True}))
        return 0
    payload = json.loads(sys.stdin.read() or "{}")
    print(compact(run(payload)))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(compact({"ok": False, "error": str(exc)[:600]}))
        raise SystemExit(1)
