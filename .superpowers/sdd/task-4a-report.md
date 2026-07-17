# Task 4A Audit Report

## Result

**DONE**

Commit: `8f350ab` (`feat: download optional OCR component`)

The commit contains only:

- `lib/ocr-component-manager.js`
- `test/ocr-component-manager.test.js`

## Original RED And Baseline

- Original implementer RED, supplied by the controller: `MODULE_NOT_FOUND` for `lib/ocr-component-manager.js`.
- Controller handoff evidence: 16 focused tests and 43 full tests passing after the original GREEN implementation.
- Fresh pre-audit baseline reproduced those results:
  - `node --test test/ocr-component-manager.test.js`: 16 passed, 0 failed.
  - `npm test`: 43 passed, 0 failed.

## Audit Coverage

The brief was checked line by line against implementation and tests, including:

- Semantic version, HTTPS URL, integer sizes, SHA-256, fixed component root/executable, required-file, language, and safe-relative-path manifest validation.
- Local synchronous readiness, executable lookup, offline refresh fallback, and version-mismatch preservation of the prior install.
- Shared in-flight promise identity, pre-download disk accounting, sibling partial/staging/backup paths, progress states, and idle/active cancellation.
- Real default manifest/download code paths for HTTPS redirects, the five-redirect bound, HTTPS downgrade rejection, stream progress, AbortSignal cancellation, and partial cleanup.
- Archive size and SHA-256 verification, ZIP traversal preflight, extraction containment, required-file validation, and extracted-size bounds.
- Windows-safe swap order, rollback after an injected staged-to-final rename failure, final metadata verification, backup removal, scratch cleanup, and preservation of an old working install on failures.

## Concrete Findings And Fixes

### 1. Windows-unsafe relative paths were accepted

Manifest and ZIP path checks accepted NTFS alternate-data-stream names such as `runtime.dll:payload`, reserved device names such as `NUL.dll`, and trailing-dot aliases.

- RED: the invalid-manifest test reached archive handling instead of rejecting the ADS path as a manifest error.
- RED: an ADS ZIP entry installed successfully instead of being rejected in preflight.
- Fix: added a shared Windows-safe segment validator and reused it for manifest and ZIP entry paths. It rejects control/forbidden characters, trailing dots/spaces, device names, empty/dot segments, roots, and drive-qualified paths.
- GREEN: both focused regressions pass.

### 2. Local readiness followed junctions outside the component

A safe lexical required-file path could traverse a directory junction and validate a runtime file physically outside `vse-cli`.

- RED: local status reported `ready` with `runtime/` junctioned to an external directory.
- Fix: local and staged verification now require a regular file and compare canonical real paths against the canonical component root.
- GREEN: the junction escape reports `not_installed` and exposes no executable path.

### 3. `installedSize` did not bound extraction

Disk space was checked using `installedSize`, but ZIP extraction did not enforce that limit. A matching archive could therefore expand beyond the amount reserved before download.

- RED: a ZIP whose uncompressed payload exceeded `installedSize` installed successfully.
- Fix: extraction preflights safe uncompressed entry sizes and also enforces a runtime byte cap before writes.
- GREEN: oversized extraction is rejected, scratch paths are removed, and the prior installation remains intact.

### 4. Immediate progress state was stale

`downloadOcrComponent()` returned its in-flight promise before progress changed to `downloading/checking`; synchronous observers briefly saw `not_installed/checking`.

- RED: the immediate progress snapshot had `status: 'not_installed'`.
- Fix: initialize checking progress before the first asynchronous filesystem operation.
- GREEN: callers immediately observe the documented downloading/checking state.

### 5. Default HTTPS behavior lacked direct coverage

The original tests covered injected fetch/download adapters but not the built-in HTTPS and stream implementations.

- Added deterministic transport-level tests around the actual default adapters.
- Verified relative and cross-host HTTPS redirects for manifest and archive downloads.
- Verified exactly five redirects are allowed and a sixth is rejected.
- Verified redirect downgrade to HTTP is rejected.
- Verified AbortSignal cancels the default stream pipeline and cleanup completes before cancellation returns.

No production defect was found in these default HTTPS paths.

## Final Evidence

- `node --test test/ocr-component-manager.test.js`: 24 passed, 0 failed.
- `npm test`: 51 passed, 0 failed.
- `node --check lib/ocr-component-manager.js`: passed.
- `node --check test/ocr-component-manager.test.js`: passed.
- `git diff --check`: passed; only Git's informational LF-to-CRLF warning was printed.
- Staged-file audit before commit listed exactly the two owned task files.
- Commit completed successfully: `8f350ab`.

## Concerns

No blocking or known correctness concerns remain. The default HTTPS tests use deterministic mocked `https.get` transport streams rather than the live Hugging Face service, avoiding an external-network dependency while exercising the real redirect, downloader, pipeline, cancellation, and cleanup code.

## Review Fix Evidence

### RED

- `node --test --test-name-pattern="component root junction|response handoff" test/ocr-component-manager.test.js`: 0 passed, 3 failed.
  - Component-root junction status was `ready` instead of `not_installed`.
  - The already-aborted manifest response was not destroyed.
  - The already-aborted archive handoff opened one output stream instead of zero.
- `node --test --test-name-pattern="scratch cleanup|metadata write failure|failed incomplete-final removal" test/ocr-component-manager.test.js`: 0 passed, 4 failed.
  - The first cleanup error replaced the injected primary download error.
  - The first cleanup error replaced the primary `AbortError`.
  - Both post-rename metadata-failure tests resolved successfully because metadata writes were not injectable.
- `node --test --test-name-pattern="cancellation after metadata write|cancellation during final verification" test/ocr-component-manager.test.js`: 0 passed, 2 failed; both downloads incorrectly resolved `ready`.
- First complete focused run after the fixes exposed one compatibility RED: 33 passed, 1 failed. `default downloader aborts its stream and cleans partial state` received Node's generic `AbortError: The operation was aborted` instead of the manager's cancellation message.

### GREEN

- Path-containment and response-handoff regressions: 3 passed, 0 failed.
- Cleanup, partial-final rollback, and injected rollback-failure regressions: 4 passed, 0 failed.
- Metadata-write and final-verification cancellation races: 2 passed, 0 failed.
- Public singleton export/delegation contract in an isolated subprocess: 1 passed, 0 failed. The child uses a temporary `DATA_TOOLS_DIR` and an offline `https.get` fixture, so it touches neither user data nor the real network.
- The canonical cancellation error now comes from `AbortSignal.reason`; the previously failing default downloader test passes while cleanup details remain attached to the primary error.

### Final Verification

- `node --test test/ocr-component-manager.test.js`: 34 passed, 0 failed.
- `npm test`: 61 passed, 0 failed.
- `node --check lib/ocr-component-manager.js`: passed.
- `node --check test/ocr-component-manager.test.js`: passed.
- `git diff --check`: passed; only Git's informational LF-to-CRLF warnings were printed.

### Review Fix Summary

- Local readiness now requires a physical component directory canonically contained by the managed data-tools root.
- Cleanup attempts both scratch removals and exposes contextual `cleanupErrors` without replacing the primary failure.
- Atomic rollback records contextual `rollbackErrors`, quarantines an incomplete final when removal fails, and still attempts backup restoration.
- Already-aborted response handoffs destroy their streams immediately, and install cancellation is checked around metadata persistence and final verification.
- A real post-rename metadata failure proves restoration of the prior installation.
- All public singleton exports and wrapper return contracts are covered without a production test backdoor.

No blocking or known correctness concerns remain after the review fixes.

## Final Cancellation Rollback Fix Evidence

### RED

- `node --test --test-name-pattern="cancellation with failed backup restore" test/ocr-component-manager.test.js`: 0 passed, 1 failed.
- Failure: `TypeError: Cannot read properties of undefined (reading 'length')` at the assertion for `error.rollbackErrors`, proving `performDownload()` replaced the rollback-decorated install error with clean `signal.reason`.

### GREEN

- `node --test --test-name-pattern="cancellation with failed backup restore" test/ocr-component-manager.test.js`: 1 passed, 0 failed.
- The original download rejection retains the `restore-backup` rollback detail and injected cause.
- `cancelOcrComponentDownload()`, component status, and download progress all report `error` when cancellation rollback fails.
- Existing successful install-window and download-stream cancellations remain `cancelled` in the focused suite.

### Mutation Evidence

- Temporarily changed `if (cancelled && !rollbackFailed)` back to `if (cancelled)`.
- The regression returned to 0 passed, 1 failed with the same missing-`rollbackErrors` failure.
- Restored the guard and reran the regression: 1 passed, 0 failed.

### Final Verification

- `node --test test/ocr-component-manager.test.js`: 35 passed, 0 failed.
- `npm test`: 62 passed, 0 failed.
- `node --check lib/ocr-component-manager.js`: passed.
- `node --check test/ocr-component-manager.test.js`: passed.
- `git diff --check`: passed; only Git's informational LF-to-CRLF warnings were printed.

No blocking or known correctness concerns remain after the final cancellation rollback fix.
