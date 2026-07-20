# OCR-First Automatic Subtitle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automatic subtitle mode that tries hard-subtitle OCR first, validates the OCR result, and falls back to Whisper when no usable subtitle is found, while asking the user before fallback on technical OCR failures.

**Architecture:** Introduce a subtitle coordinator between `studioController` and the existing Whisper helper. The coordinator owns OCR execution, result classification, quality validation, and fallback decisions. A dedicated component manager downloads the optional VSE runtime into `VideoStudioData/tools`, while the render queue gains a resumable `waiting_input` state for technical OCR errors.

**Tech Stack:** Electron, Node.js, Express, vanilla browser JavaScript, `child_process`, `crypto`, `adm-zip`, `srt-parser-2`, Python/VSE CLI, `node:test`.

## Global Constraints

- Keep the existing translation, subtitle formatting, and FFmpeg rendering pipeline unchanged after a subtitle SRT has been selected.
- Write OCR output only inside the render task's `workDir`. Never create a same-name `.srt` beside the source video.
- Default OCR region is the bottom 30%: `0.70,0.98,0.05,0.95`.
- The user must select the source text language before rendering. Initial choices include Chinese (`ch`), Vietnamese (`vi`), English (`en`), Japanese (`japan`), Korean (`korean`), and every additional language verified as supported by the packaged VSE runtime.
- Select GPU automatically only when NVIDIA CUDA is available; otherwise run OCR on CPU.
- When GPU execution fails specifically because CUDA cannot initialize or runs out of memory, retry OCR once on CPU before classifying the run as a technical failure.
- Treat VSE exit code `0` as OCR success, `2` as no hard subtitles, and every other non-zero exit as a technical failure.
- No subtitles or a rejected OCR quality result falls back to Whisper automatically.
- A technical OCR failure moves the render task to `waiting_input`; it must not silently fall back.
- The OCR runtime is downloaded on first use to `shared.DATA_TOOLS_DIR/vse-cli`; it is not bundled into the installer.
- Download through a versioned manifest, verify archive size and SHA-256, extract into staging, verify the executable, then replace the installed version atomically.
- Preserve source video information across a `waiting_input` retry.
- Use test-driven development for each behavior below.

---

## Task 1: Establish the Node Test Harness

**Files:**
- Create: `test/run-tests.js`
- Create: `test/harness-smoke.test.js`
- Create: `test/helpers/temp-dir.js`

- [ ] **Step 1: Add a failing smoke test for test discovery**

Create `test/harness-smoke.test.js` with one `node:test` assertion. Run `npm test` first to prove the existing package script fails because `test/run-tests.js` is missing.

The runner must discover files ending in `.test.js` below `test/`, exclude `run-tests.js`, and invoke Node's built-in test runner without shell interpolation.

- [ ] **Step 2: Implement the test runner**

Implement `test/run-tests.js` with `fs.readdirSync(..., { recursive: true })`, sort the test paths for deterministic output, then run:

```js
spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit'
});
```

Return the child exit status and fail clearly if no test files are found.

- [ ] **Step 3: Add a reusable temporary-directory helper**

Export:

```js
async function withTempDir(prefix, callback)
```

It creates a directory below `os.tmpdir()` and always removes it in `finally`.

- [ ] **Step 4: Verify the harness**

Run: `npm test`

Expected: the smoke test passes and the process exits `0`.

- [ ] **Step 5: Commit**

```powershell
git add test/run-tests.js test/harness-smoke.test.js test/helpers/temp-dir.js
git commit -m "test: add node test harness"
```

## Task 2: Build the OCR SRT Quality Gate

**Files:**
- Create: `lib/subtitle-quality.js`
- Create: `test/subtitle-quality.test.js`

- [ ] **Step 1: Write failing quality tests**

Cover these cases with temporary SRT files:

1. Accept at least two distinct, timed subtitle cues.
2. Reject an empty SRT.
3. Reject one static phrase repeated throughout the video.
4. Remove a line that appears in at least 60% of cues and at least three times, while retaining changing dialogue lines.
5. Reject malformed cues and cues with non-positive durations.
6. Accept Chinese text even though it is not separated into Latin words.

- [ ] **Step 2: Implement deterministic normalization**

Create these internal helpers:

```js
function normalizeLine(value)
function countMeaningfulCharacters(value)
function parseTimestamp(value)
function findRepeatedLines(cues)
```

Normalization trims whitespace, collapses repeated spaces, lowercases Latin text, and removes punctuation for comparison only. Preserve the original text in the cleaned output.

- [ ] **Step 3: Implement the public quality API**

Export:

```js
async function evaluateAndCleanSrt(inputPath, outputPath)
```

Return:

```js
{
  accepted: boolean,
  path: accepted ? outputPath : null,
  cueCount: number,
  distinctCueCount: number,
  removedRepeatedLines: string[],
  reason: 'accepted' | 'empty' | 'invalid_timing' | 'too_few_distinct_cues' | 'too_little_text'
}
```

Use `srt-parser-2`. Split each cue into lines before detecting repeated fixed text. A normalized line is fixed text when it occurs in at least `max(3, ceil(validCueCount * 0.6))` cues. Remove those lines, discard empty cues, and write a cleaned SRT only if all acceptance rules pass:

- at least two cues remain;
- at least two normalized cue texts are distinct;
- at least eight meaningful Latin, numeric, Vietnamese, or CJK characters remain in total.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/subtitle-quality.test.js`

Expected: all quality-gate tests pass.

- [ ] **Step 5: Commit**

```powershell
git add lib/subtitle-quality.js test/subtitle-quality.test.js
git commit -m "feat: validate and clean OCR subtitles"
```

## Task 3: Make VSE Runnable from Node on GPU or CPU

**Files:**
- Create: `lib/vse-helper.js`
- Create: `test/vse-helper.test.js`
- Modify: `tools/vse_builder/video-subtitle-extractor/backend/main.py`
- Modify: `tools/vse_builder/video-subtitle-extractor/vse_cli.py`
- Create: `tools/vse_builder/video-subtitle-extractor/tests/test_cli_output.py`

- [ ] **Step 1: Write failing Node tests for the VSE process contract**

Inject a fake `spawn` implementation and test:

1. Arguments include the exact video, language, region, device, mode, and work-directory output path.
2. JSON-lines progress is parsed without failing on diagnostic stderr text.
3. Exit `0` returns `{ kind: 'success' }`.
4. Exit `2` returns `{ kind: 'no_subtitles' }`.
5. Exit `1` and spawn errors throw `OcrTechnicalError` with code `OCR_TECHNICAL_ERROR`.
6. A timeout terminates the child and throws the same typed error.
7. CUDA detection returns `gpu` only when `nvcuda.dll` exists; otherwise it returns `cpu`.
8. CUDA initialization and out-of-memory errors are marked as eligible for one CPU retry.
9. Paths containing spaces and Vietnamese characters are passed as unchanged argument values.
10. Cancellation terminates the registered OCR process tree.

- [ ] **Step 2: Implement the VSE runner**

Export:

```js
class OcrTechnicalError extends Error {}

function detectOcrDevice(options = {})

async function runVse({
  executablePath,
  videoPath,
  outputPath,
  language,
  region,
  device,
  cwd,
  onProgress,
  timeoutMs = 30 * 60 * 1000,
  spawnImpl
})
```

Use `readline.createInterface` to parse stdout one line at a time. Register the child through `shared.registerChildProcess(child)` so cancellation can terminate it. Never construct a PowerShell or shell command string.

Set `error.retryableOnCpu = true` only when stderr or the structured VSE result identifies CUDA initialization failure or CUDA out-of-memory. Do not retry arbitrary process failures.

- [ ] **Step 3: Write a failing Python regression test for output directories**

Test that the CLI can copy its generated SRT to an output path whose parent exists and that it creates a missing parent directory before `shutil.copyfile`.

- [ ] **Step 4: Remove forced CUDA behavior from the VSE backend**

In `backend/main.py`, pass `--use_cuda` only when the CLI/device setting requests GPU. CPU mode must not initialize CUDA-only providers.

In `vse_cli.py`, create the output parent directory before copying the final SRT:

```python
output_parent = os.path.dirname(os.path.abspath(out_path))
os.makedirs(output_parent, exist_ok=True)
```

- [ ] **Step 5: Verify both layers**

Run:

```powershell
node --test test/vse-helper.test.js
python -m unittest discover tools/vse_builder/video-subtitle-extractor/tests
```

Expected: all Node and Python tests pass.

- [ ] **Step 6: Commit**

```powershell
git add lib/vse-helper.js test/vse-helper.test.js tools/vse_builder/video-subtitle-extractor/backend/main.py tools/vse_builder/video-subtitle-extractor/vse_cli.py tools/vse_builder/video-subtitle-extractor/tests/test_cli_output.py
git commit -m "feat: run VSE OCR on GPU or CPU"
```

## Task 4: Add the Optional OCR Component Manager

**Files:**
- Create: `lib/ocr-component-manager.js`
- Create: `test/ocr-component-manager.test.js`
- Modify: `controllers/systemController.js`
- Modify: `server.js`
- Create: `test/ocr-component-routes.test.js`

- [ ] **Step 1: Write failing component-manager tests**

Use injected filesystem, downloader, and archive adapters. Cover:

1. Missing executable reports `not_installed`.
2. A matching installed manifest reports `ready` and returns the executable path.
3. Insufficient free disk space fails before download.
4. A partial download stays outside the final install directory.
5. Size or SHA-256 mismatch deletes staging and reports an error.
6. Successful extraction verifies `vse-cli/vse-cli.exe`, writes `installed.json`, and atomically replaces the prior version.
7. A concurrent download call returns the same in-progress state rather than starting another download.
8. Cancelling a download aborts the request, removes partial/staging files, and preserves a working installed version.
9. A failed upgrade restores the previous installed directory.

- [ ] **Step 2: Implement the manager**

Use this manifest URL as a named constant:

```text
https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/vse-cli/manifest.json
```

Validate these manifest fields before downloading: non-empty semantic `version`, HTTPS `archiveUrl`, positive integer `archiveSize`, positive integer `installedSize`, 64-character lowercase hexadecimal `sha256`, relative `executable`, non-empty `requiredFiles`, and non-empty `supportedLanguages`. The first published component must declare at least `ch`, `vi`, `en`, `japan`, and `korean`.

Export:

```js
function getOcrComponentStatus()
function getOcrExecutablePath()
function getOcrDownloadProgress()
async function downloadOcrComponent()
async function cancelOcrComponentDownload()
```

Store runtime state under `path.join(shared.DATA_TOOLS_DIR, 'vse-cli')`. Use sibling `.partial`, `.staging-<timestamp>`, and `.backup-<timestamp>` paths. Validate that the manifest executable resolves inside staging before extraction or use. On Windows, rename the current install to backup, rename staging to the final path, then delete backup only after final verification; restore backup if the second rename or verification fails.

- [ ] **Step 3: Write failing API route tests**

Cover:

- `GET /api/ocr-component/status`
- `POST /api/ocr-component/download`
- `POST /api/ocr-component/cancel`
- `GET /api/ocr-component/download-status`

Verify status codes, JSON shape, and that a second POST does not start a duplicate download.

- [ ] **Step 4: Add controller methods and routes**

Controller JSON contracts:

```js
// status
{ status: 'not_installed' | 'ready' | 'downloading' | 'cancelled' | 'error', version, supportedLanguages, error }

// progress
{ status, percent, downloadedBytes, totalBytes, step, error }
```

Start the download asynchronously from the POST route and let the UI poll the progress route.
The cancel route aborts only the active OCR component download and leaves any previously installed version usable.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test test/ocr-component-manager.test.js test/ocr-component-routes.test.js
```

Expected: all component and route tests pass.

- [ ] **Step 6: Commit**

```powershell
git add lib/ocr-component-manager.js test/ocr-component-manager.test.js controllers/systemController.js server.js test/ocr-component-routes.test.js
git commit -m "feat: download optional OCR component"
```

## Task 5: Create the OCR-First Subtitle Coordinator

**Files:**
- Create: `lib/subtitle-source-helper.js`
- Create: `test/subtitle-source-helper.test.js`

- [ ] **Step 1: Write failing decision-table tests**

Inject VSE, quality, component, and Whisper dependencies. Test this complete table:

| Condition | Expected result |
| --- | --- |
| `forceWhisper` is true | Skip OCR and return Whisper SRT |
| OCR component missing | Throw `OCR_COMPONENT_REQUIRED` |
| VSE exit `0`, quality accepted | Return cleaned OCR SRT |
| VSE exit `0`, quality rejected | Run Whisper and return Whisper SRT |
| VSE exit `2` | Run Whisper and return Whisper SRT |
| GPU run reports retryable CUDA failure | Retry VSE once with `device: 'cpu'` |
| CPU retry succeeds | Continue with the OCR result |
| CPU retry fails | Throw `OcrTechnicalError`; do not call Whisper |
| VSE technical failure | Throw `OcrTechnicalError`; do not call Whisper |

Also verify OCR writes to `path.join(workDir, 'ocr-raw.srt')` and cleaned output to `path.join(workDir, 'ocr-clean.srt')`.

- [ ] **Step 2: Implement coordinator errors and validation**

Export:

```js
class OcrComponentRequiredError extends Error {}

async function resolveAutomaticSubtitle({
  videoPath,
  workDir,
  ffmpegPath,
  durationMs,
  whisperModel,
  ocrLanguage,
  ocrRegion,
  forceWhisper = false,
  onProgress
}, dependencies = {})
```

Validate and map:

- `ocrLanguage` is one of the identifiers published by the installed OCR manifest, including `ch`, `vi`, `en`, `japan`, and `korean`;
- region has four finite values within `0..1`;
- top is less than bottom and left is less than right.

Use `0.70,0.98,0.05,0.95` when no advanced region is supplied.

- [ ] **Step 3: Implement the decision table**

Return metadata with the selected SRT:

```js
{
  path,
  source: 'ocr' | 'whisper',
  language: ocrLanguage,
  cueCount,
  removedWatermarks,
  reason: 'ocr_accepted' | 'no_hardsub' | 'ocr_quality_rejected' | 'forced_whisper'
}
```

Forward concise progress phases to the render queue: `ocr_starting`, `ocr_processing`, `ocr_validating`, and `whisper_fallback`.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/subtitle-source-helper.test.js`

Expected: the entire decision table passes.

- [ ] **Step 5: Commit**

```powershell
git add lib/subtitle-source-helper.js test/subtitle-source-helper.test.js
git commit -m "feat: coordinate OCR and Whisper subtitles"
```

## Task 6: Integrate the Coordinator with the Render Queue

**Files:**
- Modify: `controllers/studioController.js`
- Modify: `server.js`
- Create: `test/studio-ocr-render.test.js`

- [ ] **Step 1: Write failing render-state tests**

Extract or inject enough dependencies to test without invoking FFmpeg. Cover:

1. `subtitleMode === 'generate'` calls the coordinator with language, region, model, source video, work directory, and duration.
2. Accepted OCR and automatic Whisper fallback both continue into the existing subtitle processing pipeline.
3. `OcrTechnicalError` sets the task to `waiting_input` with `actionRequired: 'ocr_fallback'`.
4. A waiting task is not selected by `processNextRenderTask`.
5. The source video path remains available after temporary upload files are cleaned.
6. Resume sets `forceWhisper`, returns the task to `pending`, and restarts it from the persisted source.
7. Cancelling a waiting task removes it cleanly.

- [ ] **Step 2: Persist the resolved source path**

Add runtime-only task field:

```js
task.sourceVideoPath = sourceVideo;
```

At the beginning of a retry, resolve the source in this order:

1. existing `task.sourceVideoPath`;
2. uploaded video file;
3. selected library/download video.

Validate that a persisted path still exists before retrying.

- [ ] **Step 3: Replace the direct Whisper call**

In the `subtitleMode === 'generate'` branch, call `resolveAutomaticSubtitle(...)`. Assign `result.path` to the existing `subtitlePath` variable. Do not alter downstream translation, styling, trimming, or rendering behavior.

- [ ] **Step 4: Add the waiting state**

In `executeRenderTask`, catch `OcrTechnicalError` separately:

```js
task.status = 'waiting_input';
task.step = 'OCR gặp lỗi kỹ thuật';
task.error = error.message;
task.actionRequired = 'ocr_fallback';
task.percent = Math.max(task.percent || 0, 12);
```

The task may clean its old `workDir`; resume starts a new attempt and uses `task.sourceVideoPath`. Do not mark the task `error` and do not invoke Whisper here.

- [ ] **Step 5: Add the resume endpoint**

Add:

```text
POST /api/render-use-whisper
body: { taskId: string }
```

Only accept a task with `status === 'waiting_input'` and `actionRequired === 'ocr_fallback'`. Set:

```js
task.body.forceWhisper = true;
task.status = 'pending';
task.error = null;
task.actionRequired = null;
task.step = 'Đang chuyển sang Whisper...';
```

Then trigger `processNextRenderTask()` and return the updated queue state.

- [ ] **Step 6: Expose waiting-state fields in queue responses**

Include `actionRequired` and the OCR technical message in `getQueueStatus`. Ensure queue cleanup and cancel handlers recognize `waiting_input` as a non-running removable state.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/studio-ocr-render.test.js`

Expected: render-state and resume tests pass.

- [ ] **Step 8: Commit**

```powershell
git add controllers/studioController.js server.js test/studio-ocr-render.test.js
git commit -m "feat: add resumable OCR render state"
```

## Task 7: Add OCR Settings, First-Use Download, and Fallback UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Create: `test/public-ocr-ui.test.js`

- [ ] **Step 1: Write failing DOM contract tests**

Using source-level DOM/markup assertions already compatible with the project, verify:

1. Automatic subtitle mode exposes a required source-language selector populated from supported OCR languages.
2. Advanced OCR region controls exist and default to bottom 30%.
3. The first-use modal has download progress and cancel/close states.
4. Queue markup contains a “Dùng Whisper thay thế” action hook.
5. No OCR controls are visible for subtitle modes other than `generate`.

- [ ] **Step 2: Add automatic subtitle controls**

Under the existing automatic subtitle choice, add:

- required language select: Chinese, Vietnamese, English, Japanese, Korean, plus additional languages declared by the installed OCR component manifest;
- collapsed “Vùng nhận diện nâng cao” section;
- numeric controls for top, bottom, left, right, constrained to `0..1`;
- a reset action restoring `0.70,0.98,0.05,0.95`.

Use the current form and control styles. Show these controls only when `data-sub-mode="generate"` is selected.

- [ ] **Step 3: Add first-use OCR download flow**

Before submitting a generate-mode render:

1. call `GET /api/ocr-component/status`;
2. continue immediately when status is `ready`;
3. show the OCR download modal when status is `not_installed` or `error`;
4. POST the download once;
5. poll download status until `ready` or `error`;
6. resume the original form submission after success.

The modal cancel action POSTs `/api/ocr-component/cancel`, stops polling after the cancelled state is observed, and returns control to the render form without submitting it.

Keep the existing Whisper dependency/model checks because Whisper may still be needed for automatic fallback.

- [ ] **Step 4: Send OCR options with the render form**

Submit:

```text
ocrLanguage=<supported VSE language identifier>
ocrRegion=top,bottom,left,right
```

Do not expose `forceWhisper` as a normal user-controlled form field.

- [ ] **Step 5: Render the waiting action**

Queue polling must continue while any task is `pending`, `rendering`, or `waiting_input`. For a task with `actionRequired === 'ocr_fallback'`, show the technical error and a button labeled “Dùng Whisper thay thế”.

The button POSTs `{ taskId }` to `/api/render-use-whisper`, disables while submitting, and refreshes the queue after success. Keep the existing cancel action available.

- [ ] **Step 6: Add responsive styling**

Ensure the language and region controls fit existing desktop and mobile layouts. Use native inputs/selects and the app's existing radius and color tokens; do not add a new visual theme.

- [ ] **Step 7: Verify the UI contract**

Run:

```powershell
node --test test/public-ocr-ui.test.js
npm test
```

Expected: UI contract and all accumulated unit tests pass.

- [ ] **Step 8: Commit**

```powershell
git add public/index.html public/app.js public/style.css test/public-ocr-ui.test.js
git commit -m "feat: add OCR subtitle controls and fallback action"
```

## Task 8: Build and Publish the Corrected VSE Runtime

**Files:**
- Modify: `tools/vse_builder/video-subtitle-extractor/vse-cli.spec` if the corrected source is not already collected
- Create: `tools/vse_builder/video-subtitle-extractor/release/manifest.json`
- Create: `docs/ocr-component-release.md`

- [ ] **Step 1: Build the VSE executable from corrected source**

Run the repository's existing PyInstaller build command from the VSE directory. Confirm both CPU and GPU code paths are included and that startup does not depend on the source checkout.

- [ ] **Step 2: Smoke-test the runtime on representative videos**

Run the built executable against:

1. a video with visible hard subtitles;
2. a video without hard subtitles;
3. CPU mode explicitly;
4. GPU mode on an NVIDIA/CUDA host.

Expected: exit codes follow the `0/2/technical-error` contract and output is written only to the requested path.

- [ ] **Step 3: Package the component archive**

Create the archive as `vse-cli-$version.zip` with `vse-cli/vse-cli.exe` at the manifest-relative executable path. Calculate archive bytes, extracted bytes, and SHA-256 from the final archive.

- [ ] **Step 4: Write the concrete release manifest**

Populate `release/manifest.json` with the real version, URL, sizes, and checksum. Do not commit fabricated values.

- [ ] **Step 5: Document the release process**

In `docs/ocr-component-release.md`, record:

- exact build command;
- archive layout;
- checksum command;
- upload destination;
- manifest update order;
- rollback procedure to the previous manifest/version.

- [ ] **Step 6: Verify installer scope**

Run the Electron packaging command and inspect the artifact. Confirm the large VSE runtime is absent from `extraResources` and the existing Whisper resources are unchanged.

- [ ] **Step 7: Commit release metadata and documentation**

```powershell
git add tools/vse_builder/video-subtitle-extractor/vse-cli.spec tools/vse_builder/video-subtitle-extractor/release/manifest.json docs/ocr-component-release.md
git commit -m "build: define OCR component release"
```

## Task 9: End-to-End Verification

**Files:**
- Modify tests only if verification reveals a real missing case

- [ ] **Step 1: Run the full automated suite**

Run:

```powershell
npm test
python -m unittest discover tools/vse_builder/video-subtitle-extractor/tests
```

Expected: every test exits `0`.

- [ ] **Step 2: Start the application**

Run the existing development command from `package.json`. Confirm there are no server route conflicts or renderer console errors.

- [ ] **Step 3: Verify first-use installation**

Temporarily move an existing `VideoStudioData/tools/vse-cli` directory aside without deleting it. Start an automatic subtitle render, download the OCR component, and verify:

- progress updates are visible;
- the final executable is below `VideoStudioData/tools/vse-cli`;
- `.partial` and staging directories are removed;
- restarting the app reports the component as ready without downloading again.

Restore the prior directory after the check if needed.

- [ ] **Step 4: Verify the OCR-success path**

Use a hard-subtitled sample and the correct source language. Confirm the queue reports OCR phases, the cleaned SRT is used by the existing pipeline, and no `.srt` appears beside the source video.

- [ ] **Step 5: Verify automatic Whisper fallback**

Use a video without visible hard subtitles and a sample with deliberately unusable/repeated OCR text. Confirm both continue automatically through Whisper.

- [ ] **Step 6: Verify technical-error choice**

Temporarily point the component executable at a failing test executable or rename it after status validation. Confirm the task becomes `waiting_input`, does not run Whisper automatically, and “Dùng Whisper thay thế” resumes and completes the same task.

- [ ] **Step 7: Verify CPU fallback**

On a machine or test environment without `nvcuda.dll`, confirm the command uses `--device cpu` and completes without CUDA initialization errors.

- [ ] **Step 8: Verify cancellation and restart behavior**

Cancel one running OCR task and one `waiting_input` task. Restart the app and confirm no stale active process or unusable queue item remains.

- [ ] **Step 9: Inspect the final diff**

Run:

```powershell
git status --short
git diff --check
git log --oneline -10
```

Expected: no whitespace errors, no generated multi-gigabyte runtime tracked by Git, and commits correspond to the tasks above.
