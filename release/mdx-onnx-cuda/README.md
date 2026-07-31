# MDX CUDA 1.0.0 release

Local release artifacts:

- `mdx-onnx-cuda-1.0.0.zip` (ignored by Git because it is 1.66 GB)
- `manifest.json` (generated from the final ZIP)

Verified values:

- Archive size: `1,661,604,711` bytes
- Installed size: `2,471,900,125` bytes
- SHA-256: `2064322ccc2e838d7b9e5054b0a7d010d903b463bec883b5042d757aeef41488`
- sherpa-onnx: `1.13.2`
- ONNX Runtime: `1.24.20260316.3.2d92497`
- CUDA runtime: `12.9.79`
- cuBLAS: `12.9.2.10`
- cuFFT: `11.4.1.4`
- cuDNN: `9.24.0.43`

RTX 3050 verification:

- CUDA provider completed without CPU fallback.
- GPU utilization reached 72% in the source build probe and 100% after the
  archive was installed through the application component manager.
- GPU memory increased by 4.15-5.19 GB.
- Both vocals and accompaniment WAV outputs were produced.
- For the same 30-second WAV, sherpa reported 3.758 seconds on CUDA and
  13.172 seconds on the CPU baseline (about 3.5x faster).

Release procedure:

1. Review NVIDIA redistribution and application clickwrap requirements.
2. Upload `mdx-onnx-cuda-1.0.0.zip`.
3. Verify the remote archive size and SHA-256.
4. Upload `manifest.json` last.
5. Test the public installer on a clean Windows NVIDIA machine.

Do not publish the manifest before the archive. The client manifest URL is:

```text
https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/mdx-onnx-cuda/manifest.json
```
