# -*- coding: utf-8 -*-
import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import ocr_text


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def timestamp(value):
    total_ms = max(0, int(round(float(value) * 1000.0)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def atomic_text(path, content):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(content)
    os.replace(temporary, path)


def video_duration(video):
    try:
        import cv2
        capture = cv2.VideoCapture(os.path.abspath(video))
        fps = capture.get(cv2.CAP_PROP_FPS) or 0.0
        frames = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        capture.release()
        return frames / fps if fps > 0 else 0.0
    except Exception:
        return 0.0


def has_han_on_screen(video, log, n_frames=6, min_boxes=1):
    """Thăm dò toàn khung: True=có Hán, False=không thấy, None=không kết luận được."""
    try:
        import cv2

        capture = cv2.VideoCapture(os.path.abspath(video))
        if not capture.isOpened():
            return None
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if frame_count <= 0:
            capture.release()
            return None
        engine = ocr_text._engine()
        found = 0
        for index in range(max(1, int(n_frames))):
            frame_index = int(frame_count * (0.05 + 0.90 * index / max(1, n_frames - 1)))
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            try:
                result, _ = engine(frame, use_cls=False)
            except Exception:
                capture.release()
                return None
            for item in result or []:
                if not item or len(item) < 3:
                    continue
                text = str(item[1] or "")
                if sum(1 for char in text if "一" <= char <= "鿿") >= 2 and float(item[2]) >= 0.6:
                    found += 1
            if found >= min_boxes:
                break
        capture.release()
        if found >= min_boxes:
            log(f"👁 Thăm dò OCR-medium thấy {found} box chữ Hán trên toàn khung.")
            return True
        return False
    except Exception as error:
        log(f"⚠ Thăm dò OCR-medium bỏ qua ({str(error)[:80]}).")
        return None


def actual_provider():
    """Trả provider thật của các ONNX session sau khi engine đã được dựng."""
    try:
        actual = ocr_text._ep_that(ocr_text._ENGINE)
        if actual is True:
            return "cuda"
        if actual is False:
            return "cpu"
    except Exception:
        pass
    return "unknown"


def main():
    parser = argparse.ArgumentParser(description="RapidOCR PP-OCRv6 moving subtitle OCR")
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--model", default="v6-small")
    parser.add_argument("--device", choices=("auto", "cpu", "gpu"), default="cpu")
    parser.add_argument("--exclude-regions", default="")
    args = parser.parse_args()

    if not os.path.isfile(args.video):
        raise FileNotFoundError(f"Video không tồn tại: {args.video}")

    os.environ["OCR_MODEL"] = args.model
    os.environ.setdefault("OCR_GOP_DAI", "10")
    os.environ.setdefault("OCR_DO_HYBRID", "0")
    os.environ.setdefault("OCR_GHIM_SHAPE", "1")
    os.environ.setdefault("OCR_GO_WM_CHU", "1")
    os.environ.setdefault("OCR_VUNG_TAY_PREMASK", "1")
    os.environ.setdefault("CHE_SONGNGU", "0")
    if args.exclude_regions:
        os.environ["OCR_LOAI_VUNG"] = args.exclude_regions
    else:
        os.environ.pop("OCR_LOAI_VUNG", None)
    if args.device != "gpu":
        os.environ["OCR_DUNG_GPU"] = "0"
        os.environ["OCR_NO_CUDA"] = "1"
    else:
        os.environ["OCR_DUNG_GPU"] = "1"
        os.environ.pop("OCR_NO_CUDA", None)

    duration = video_duration(args.video)

    def log(message):
        emit({"stage": "log", "message": str(message)})

    def on_segment(index, start, end, text):
        pct = min(98.0, max(1.0, (float(end) / duration * 100.0))) if duration > 0 else 1.0
        emit({
            "stage": "progress",
            "pct": round(pct, 2),
            "cue": int(index),
            "start": float(start),
            "end": float(end),
            "text": str(text),
        })

    def on_finalized(index, start, end, text):
        emit({
            "stage": "finalized",
            "cue": int(index),
            "start": float(start),
            "end": float(end),
            "text": str(text),
        })

    raw_segments, boxes = ocr_text.ocr_dong(
        os.path.abspath(args.video),
        log=log,
        on_seg=on_segment,
        on_chot=on_finalized,
    )
    used_provider = actual_provider()
    selected_model = args.model
    minimum_cues = int(os.environ.get("OCR_MIN_CUE", "3") or 3)
    should_rescue = (len(raw_segments) < minimum_cues and args.model != "v6-medium"
                     and os.environ.get("OCR_RESCUE_MEDIUM", "1") != "0")
    if should_rescue:
        completely_empty = not raw_segments and not boxes and os.environ.get("OCR_RESCUE_TRONG", "0") != "1"
        old_model = os.environ.get("OCR_MODEL")
        try:
            os.environ["OCR_MODEL"] = "v6-medium"
            ocr_text._ENGINE = None
            if completely_empty:
                probe_frames = int(os.environ.get("OCR_TD_KHUNG", "6") or 6)
                probe_result = has_han_on_screen(args.video, log, probe_frames, 1)
                completely_empty = probe_result is False
                if probe_result is None:
                    log("ℹ Không kết luận được từ thăm dò Medium → vẫn chạy lại đầy đủ để tránh bỏ sót chữ.")
            if not completely_empty:
                log(f"🔎 OCR-small đọc ít ({len(raw_segments)} câu) → thử lại OCR-medium…")
                ocr_text._ENGINE = None
                medium_segments, medium_boxes = ocr_text.ocr_dong(
                    os.path.abspath(args.video), log=log, on_seg=None, on_chot=None
                )
                used_provider = actual_provider()
                boxes = list(boxes or []) + list(medium_boxes or [])
                if len(medium_segments) >= minimum_cues:
                    raw_segments = medium_segments
                    selected_model = "v6-medium"
                    log(f"✔ OCR-medium đọc được {len(raw_segments)} câu → dùng kết quả medium.")
            else:
                log("ℹ Quét OCR và thăm dò Medium đều không thấy chữ Hán → không chạy lại toàn video.")
        finally:
            if old_model is None:
                os.environ.pop("OCR_MODEL", None)
            else:
                os.environ["OCR_MODEL"] = old_model
            ocr_text._ENGINE = None
    segments = list(raw_segments or [])
    emit({
        "stage": "provider",
        "requestedDevice": args.device,
        "provider": ("CUDAExecutionProvider" if used_provider == "cuda"
                     else "CPUExecutionProvider" if used_provider == "cpu"
                     else "unknown"),
        "model": selected_model,
    })

    srt_blocks = []
    for index, (start, end, text) in enumerate(segments, 1):
        clean_text = str(text or "").strip()
        if not clean_text or float(end) <= float(start):
            continue
        srt_blocks.append(
            f"{index}\n{timestamp(start)} --> {timestamp(end)}\n{clean_text}\n"
        )
    atomic_text(args.output, "\n".join(srt_blocks))

    blur_boxes = []
    for item in boxes or []:
        try:
            start, end, y0, y1, x0, x1 = [float(value) for value in item[:6]]
            if end <= start or y1 <= y0 or x1 <= x0:
                continue
            blur_boxes.append({
                "x": round(max(0.0, min(1.0, x0)) * 100.0, 3),
                "y": round(max(0.0, min(1.0, y0)) * 100.0, 3),
                "width": round((max(0.0, min(1.0, x1)) - max(0.0, min(1.0, x0))) * 100.0, 3),
                "height": round((max(0.0, min(1.0, y1)) - max(0.0, min(1.0, y0))) * 100.0, 3),
                "radius": 20,
                "start": round(start, 3),
                "end": round(end, 3),
                "source": "viral_ocr",
            })
        except (TypeError, ValueError, IndexError):
            continue

    report = {
        "version": 2,
        "source": "viral_ocr",
        "engine": "RapidOCR PP-OCRv6",
        "model": selected_model,
        "requestedDevice": args.device,
        "provider": used_provider,
        "strategy": "viral_dynamic_tracking",
        "selectedRegion": None,
        "rawCueCount": len(raw_segments),
        "cueCount": len(srt_blocks),
        "removedCueCount": max(0, len(raw_segments) - len(srt_blocks)),
        "blurBoxes": blur_boxes,
        "attempts": [{
            "id": "viral_dynamic_tracking",
            "region": "full_frame_dynamic",
            "result": "success" if srt_blocks else "no_subtitles",
            "accepted": bool(srt_blocks),
            "cueCount": len(srt_blocks),
            "boxCount": len(blur_boxes),
        }],
    }
    atomic_text(args.report, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    emit({
        "stage": "result",
        "cues": len(srt_blocks),
        "boxes": len(blur_boxes),
        "output": os.path.abspath(args.output),
        "report": os.path.abspath(args.report),
    })
    return 0 if srt_blocks else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        emit({"stage": "error", "message": str(error), "type": type(error).__name__})
        raise
