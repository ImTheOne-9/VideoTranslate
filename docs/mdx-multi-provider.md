# MDX ONNX multi-provider runtime

## Scope

The desktop application supports these user choices for MDX background separation:

- `auto`: use NVIDIA CUDA only when both NVIDIA hardware and the optional CUDA
  component are ready; otherwise use CPU. A recognized CUDA initialization/runtime
  failure is retried once on CPU.
- `cuda`: require NVIDIA hardware and the CUDA component. This mode does not silently
  fall back.
- `cpu`: always use the baseline CPU component.

DirectML is not part of this release. AMD and Intel GPUs continue to use CPU until a
separately verified DirectML runner is available.

The repository's current baseline `tools/mdx-onnx/mdx-separator.exe` was probed on an
NVIDIA RTX 3050. Although it accepts `--provider=cuda`, it reports only
`CPUExecutionProvider` and prints `Fallback to cpu`. It is therefore a CPU build and
must not be repackaged as the CUDA component.

The official sherpa-onnx Windows CUDA build procedure is documented at:

```text
https://k2-fsa.github.io/sherpa/onnx/install/windows/build-cuda.html
```

The official v1.13.4 CUDA 12.x/cuDNN 9 Windows archive was also probed. Its source
separation executable contains `CUDAExecutionProvider`, but the archive does not bundle
the complete CUDA/cuDNN redistributable set. On the development machine it first
reported missing `cublasLt64_12.dll`; after using the existing local cuBLAS files it
reported missing `cufft64_11.dll`. The existing three-file `cuda-libraries.zip` is
therefore not sufficient for this MDX CUDA component. Do not publish the CUDA component
until the complete, license-compliant runtime dependency set is assembled and verified
on a clean machine.

## Runtime layout

```text
VideoStudioData/tools/mdx-onnx/
|-- mdx-separator.exe
|-- models/
|   `-- UVR_MDXNET_KARA_2.onnx
`-- cuda/
    |-- mdx-separator.exe
    `-- CUDA and ONNX Runtime provider DLLs required by that build
```

The CPU executable and model remain the mandatory baseline. The CUDA directory is an
optional component and must not replace or delete the CPU executable.

Development and controlled deployments may override executable locations with:

```text
MDX_CPU_EXECUTABLE_PATH
MDX_CUDA_EXECUTABLE_PATH
```

## CUDA component release procedure

1. Build `mdx-separator.exe` with the ONNX Runtime CUDA execution provider enabled.
2. Run `mdx-separator.exe --help` and confirm that `cuda` is listed.
3. Put the runner and every required provider/CUDA DLL in an isolated test directory.
4. Test from a clean Windows machine without relying on DLLs in the developer PATH.
5. Run the same WAV and model with `--provider=cpu` and `--provider=cuda`.
6. Confirm both output WAV files exist, are non-silent, and have plausible duration.
7. Confirm `nvidia-smi` shows GPU utilization during the CUDA run.
8. Test a CUDA initialization failure and verify that application `auto` mode retries
   with CPU.
9. Generate SHA-256, archive size, installed size, version, and required-file list.
10. Publish the archive only after the application release endpoint/manifest is ready.

Do not advertise CUDA readiness based only on the CLI help text. A build may expose the
option while still lacking a loadable CUDA provider or its DLL dependencies.

The application downloads the optional component from
`MDX_CUDA_COMPONENT_MANIFEST_URL` when that environment variable is set, otherwise it
uses the release manifest at `video-studio-tools/mdx-onnx-cuda/manifest.json`. Download
and installation enforce HTTPS, archive size, SHA-256, safe ZIP paths, declared
installed size, required files, free disk space, and atomic replacement with rollback.

Example manifest:

```json
{
  "version": "1.0.0",
  "archiveUrl": "https://example.invalid/mdx-onnx-cuda-1.0.0.zip",
  "archiveSize": 123456789,
  "installedSize": 234567890,
  "sha256": "lowercase-64-character-sha256",
  "componentRoot": "mdx-onnx/cuda",
  "executable": "mdx-separator.exe",
  "requiredFiles": [
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
    "onnxruntime_providers_cuda.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "cufft64_11.dll",
    "cudart64_12.dll",
    "cudnn64_9.dll"
  ],
  "supportedLanguages": [],
  "runtime": {
    "provider": "cuda",
    "cudaMajor": 12,
    "cudnnMajor": 9
  }
}
```

The exact required-file list must be generated from the tested build. The example is
not a complete redistribution list and must not be published without dependency and
license verification.

## Verified local release candidate

Release candidate `1.0.0` was assembled and verified on an NVIDIA GeForce RTX 3050:

| Property | Result |
| --- | --- |
| Archive | `release/mdx-onnx-cuda/mdx-onnx-cuda-1.0.0.zip` |
| Archive size | 1,661,604,711 bytes |
| Installed size | 2,471,900,125 bytes |
| SHA-256 | `2064322ccc2e838d7b9e5054b0a7d010d903b463bec883b5042d757aeef41488` |
| CUDA probe | No CPU fallback |
| Peak GPU utilization | 72% before packaging; 100% after clean component install |
| GPU memory increase | 4.15-5.19 GB |
| CUDA processing time | 3.758 seconds for a 30-second stereo WAV |
| CPU processing time | 13.172 seconds for the same WAV |
| Output validation | Both vocals and accompaniment WAV files created |
| Installer validation | Download/checksum/extract/install metadata reported `ready` |

The generated ZIP is intentionally ignored by Git. `manifest.json`, provenance,
licenses, release notes, probe tooling, and manifest tooling remain in the repository.
Public upload is a separate release action because the NVIDIA runtime license requires
the application's distribution terms to protect NVIDIA's software rights.

## Execution record

Each render manifest stores:

```json
{
  "backgroundSeparation": {
    "requestedProvider": "auto",
    "usedProvider": "cuda",
    "fallback": false,
    "fallbackReason": null,
    "durationMs": 12345,
    "model": "UVR_MDXNET_KARA_2"
  }
}
```

This is diagnostic metadata only. It never contains API keys or user credentials.

## Fallback policy

Auto mode falls back only for errors associated with CUDA/provider initialization,
missing CUDA DLLs, incompatible drivers, allocation failures, or GPU out-of-memory.

It must not fall back for:

- cancellation;
- missing or invalid input;
- invalid ONNX model;
- unwritable output;
- missing CPU baseline;
- missing output after a nominally successful process.

## Test cases

### Hardware detection

| ID | Scenario | Expected |
| --- | --- | --- |
| HW-01 | Valid `nvidia-smi` output | GPU name, driver, and VRAM are parsed |
| HW-02 | `nvidia-smi` missing | NVIDIA unavailable, no crash |
| HW-03 | Unsupported platform | Probe is skipped |
| HW-04 | Hung probe | Five-second timeout is enforced |

### Provider selection

| ID | Scenario | Expected |
| --- | --- | --- |
| SEL-01 | Auto + NVIDIA + CUDA runtime | CUDA |
| SEL-02 | Auto + no NVIDIA | CPU |
| SEL-03 | Auto + NVIDIA + no CUDA runtime | CPU |
| SEL-04 | Explicit CUDA + no NVIDIA | `MDX_CUDA_HARDWARE_MISSING` |
| SEL-05 | Explicit CUDA + runtime missing | `MDX_CUDA_RUNTIME_MISSING` |
| SEL-06 | Explicit CPU | CPU regardless of GPU |

### Execution and fallback

| ID | Scenario | Expected |
| --- | --- | --- |
| RUN-01 | CUDA success | Outputs exist, `usedProvider=cuda` |
| RUN-02 | CUDA provider initialization failure in Auto | Retry once on CPU |
| RUN-03 | CUDA out of VRAM in Auto | Retry once on CPU |
| RUN-04 | CUDA process cancelled | No CPU retry |
| RUN-05 | Invalid input/model | No CPU retry |
| RUN-06 | Process exits without both WAV files | `MDX_OUTPUT_MISSING` |
| RUN-07 | CPU fallback succeeds | Reason and duration persist in manifest |

### UI and persistence

| ID | Scenario | Expected |
| --- | --- | --- |
| UI-01 | MDX toggle off | Provider controls hidden |
| UI-02 | MDX toggle on | Auto/CUDA/CPU controls visible |
| UI-03 | Explicit CUDA unavailable | Render is blocked with a clear message |
| UI-04 | Saved project reopened | Provider selection is restored |
| UI-05 | Render restarted | Background execution metadata survives |

### Component installation

| ID | Scenario | Expected |
| --- | --- | --- |
| INS-01 | Valid manifest, checksum and required DLLs | Install atomically and report ready |
| INS-02 | CPU provider or CUDA < 12/cuDNN < 9 in manifest | Reject before download |
| INS-03 | Archive SHA-256 mismatch | Reject, clean scratch files, keep old install |
| INS-04 | Declared provider DLL missing | Reject before final swap |
| INS-05 | ZIP path escapes staging | Reject without writing outside staging |
| INS-06 | Network offline with valid local install | Preserve ready state |
| INS-07 | Concurrent download requests | Share one operation |
| INS-08 | Cancellation during install | Roll back and preserve previous version |
| INS-09 | Executable exists without valid `installed.json` | Treat CUDA as not installed |

## Commands

Focused tests:

```powershell
node --test test/hardware-detector.test.js test/mdx-separator-manager.test.js test/mdx-cuda-component-manager.test.js test/mdx-cuda-component-routes.test.js test/mdx-onnx-separator.test.js test/render-job-store.test.js
```

Full regression suite:

```powershell
npm.cmd test
```
