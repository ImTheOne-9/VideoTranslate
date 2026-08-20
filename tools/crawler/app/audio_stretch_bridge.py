# -*- coding: utf-8 -*-
"""Pitch-preserving WAV stretch helper; FFmpeg remains the caller fallback."""

import argparse
import io
import os
import wave


def stretch(input_path, output_path, ratio):
    import numpy as np
    from audiostretchy.stretch import AudioStretch

    engine = AudioStretch()
    with open(input_path, "rb") as source:
        buffer = io.BytesIO(source.read())
    engine.open(file=buffer, format="wav")
    engine.stretch(ratio=max(0.5, min(2.0, float(ratio))))
    samples = engine.samples
    if samples is None or len(samples) == 0:
        raise RuntimeError("AudioStretchy trả về audio rỗng")
    samples = np.asarray(samples)
    nonzero = np.nonzero(samples)[0]
    samples = samples[: nonzero[-1] + 1] if len(nonzero) else samples[:0]
    if len(samples) == 0:
        raise RuntimeError("AudioStretchy chỉ trả về khoảng lặng")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with wave.open(output_path, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(int(engine.framerate or 24000))
        stream.writeframes(samples.astype(np.int16).tobytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ratio", required=True, type=float)
    args = parser.parse_args()
    stretch(os.path.abspath(args.input), os.path.abspath(args.output), args.ratio)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
