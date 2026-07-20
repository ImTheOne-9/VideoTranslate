# OCR-First Automatic Subtitle Design

## Goal

Integrate hard-subtitle OCR into Video Studio Tools as the first automatic subtitle source. If the video has no usable hard subtitles, continue with the existing Whisper transcription flow. Keep the existing translation, formatting, voice-over, and render pipeline unchanged after an SRT file has been selected.

## User Experience

The existing **Phu de tu dong** mode remains the single entry point. It adds:

- Source text language: Chinese, Vietnamese, English, Japanese, Korean, and other OCR-supported languages.
- OCR region: bottom 30% by default (`0.70,0.98,0.05,0.95`).
- Advanced region controls for top, bottom, left, and right bounds.

The user does not choose between OCR and Whisper. The application makes that decision automatically.

## Architecture

Add a dedicated subtitle-source coordinator at `lib/subtitle-source-helper.js`. Its public operation accepts the source video, OCR language and region, Whisper model, work directory, video duration, and FFmpeg path. It returns:

```js
{
  path: "...srt",
  source: "ocr" | "whisper",
  language: "ch",
  cueCount: 28,
  removedWatermarks: 1
}
```

`controllers/studioController.js` calls this coordinator instead of calling `extractAudioAndTranscribe()` directly. Once a subtitle path is returned, the current translation, formatting, voice-over, subtitle rendering, and SRT export logic continues unchanged.

The existing `lib/whisper-helper.js` remains the Whisper implementation and fallback. OCR process execution, progress parsing, result validation, and fallback decisions belong to the coordinator rather than the controller.

## Processing Flow

1. Ensure the optional OCR component is installed and valid.
2. Detect an available NVIDIA CUDA device; use GPU when available and CPU otherwise.
3. Run `vse-cli.exe` with the selected source language and OCR region.
4. Parse JSON progress lines from stdout while preserving non-JSON diagnostic output in the log.
5. Clean and validate the generated SRT.
6. Return a valid OCR SRT, or call Whisper when no usable hard subtitles remain.
7. On a technical OCR failure, pause the render task and wait for the user to choose Whisper or cancel.

The OCR SRT must always be written inside the render work directory. It must never be written beside the source video. This prevents media players from automatically loading a same-name sidecar SRT and displaying a second subtitle layer over the original hard subtitles.

## Exit And Task States

- OCR exit code `0`: inspect and validate the generated SRT.
- OCR exit code `2`: no hard subtitles; automatically run Whisper.
- OCR exit code `1` or an abnormal process failure: set the render task to `waiting_input` and expose **Dung Whisper thay the** and **Huy tac vu** actions.

Choosing Whisper resumes the same queued task with OCR bypassed. The user does not need to upload the source video or re-enter render settings.

Cancellation must terminate the OCR process tree through the existing active-render process registry, remove temporary OCR files, and leave the queue ready for the next task.

## OCR Component Distribution

OCR is an optional first-use download because the current unpacked runtime is about 4.7 GB. It is stored under:

```text
VideoStudioData/tools/vse-cli/
```

The component has a versioned manifest containing its URL, expected download size, SHA-256 checksum, and executable path.

Installation flow:

1. Download to a `.partial` file with visible progress and cancellation.
2. Check available disk space, file size, and SHA-256.
3. Extract into a staging directory.
4. Verify `vse-cli.exe` and required runtime files.
5. Atomically replace the installed OCR directory.

A failed download or upgrade must not damage a previously working OCR installation. The application downloads OCR again only when the required component version changes or verification fails.

## Quality Gate

The coordinator parses the OCR SRT and normalizes whitespace, punctuation, and case for comparison. It removes:

- Empty cues and invalid timestamp ranges.
- Text below the configured recognition threshold.
- Fixed or near-identical text repeated across most of the video, such as channel names and watermarks.

The initial acceptance rule requires at least two distinct, meaningful cues and a minimum amount of valid recognized text after cleanup. These thresholds remain internal and configurable so they can be tuned using real videos without changing the UI.

If the cleaned result does not pass the quality gate, it is treated as no hard subtitles and Whisper runs automatically. Quality rejection is not a technical error.

## Progress And Logging

Map OCR JSON stages into the existing render progress range before translation:

- Component check/download: installation progress when required.
- Frame extraction: `stage=frame`.
- Recognition: `stage=ocr`.
- Cleanup and quality validation: a short post-processing step.

Raw Paddle, CUDA, and VideoSubFinder messages remain available in the application log. Only valid JSON objects control progress and result state.

## Error Handling

User-actionable technical errors include missing or corrupt OCR files, checksum mismatch, insufficient disk space, process launch failure, missing runtime DLLs, GPU out-of-memory with failed CPU retry, timeout, and invalid output files.

The error shown to the user contains a concise reason and the two approved actions. Detailed diagnostics remain in the log. The coordinator creates output directories before starting OCR and supports paths containing spaces, Vietnamese characters, and long filenames.

## Testing

Unit tests cover language mapping, region validation, JSON progress parsing, SRT normalization, watermark removal, and quality-gate decisions.

Integration tests use a fake OCR CLI to verify exit codes `0`, `1`, and `2`, progress mapping, timeout, cancellation, `waiting_input`, and resume-through-Whisper behavior.

Component installation tests cover interrupted downloads, invalid checksums, insufficient disk space, atomic upgrades, and preservation of a working prior version.

Packaged smoke tests cover:

- A video with changing hard subtitles.
- A video with no hard subtitles.
- A video containing only a fixed watermark.
- GPU execution on supported NVIDIA hardware.
- CPU execution without CUDA.
- Paths with spaces and Vietnamese characters.
- Output directory creation and confirmation that no sidecar SRT is created beside the source video.

## Acceptance Criteria

The user selects automatic subtitles and the source text language. The application uses OCR when a valid hard-subtitle track can be reconstructed, otherwise uses Whisper. Technical OCR failures are visible and recoverable through the Whisper action. Existing translation, voice-over, and rendering behavior remains compatible, and the source video directory is not modified by OCR.
