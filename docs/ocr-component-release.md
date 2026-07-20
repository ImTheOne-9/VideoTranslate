# OCR Component Release

The OCR runtime is released independently from the Electron installer so the application can download it on first use.

## Build

Build from the isolated VSE checkout with Python 3.12 and CUDA 11.8:

```powershell
E:\vse_build_env\Scripts\python.exe -m pip install --force-reinstall paddlepaddle-gpu==3.2.2 --index-url https://www.paddlepaddle.org.cn/packages/stable/cu118/
$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = 'True'
E:\vse_build_env\Scripts\python.exe -m PyInstaller --noconfirm --clean vse_cli.spec
```

PaddlePaddle 3.3.x must not be used for this component. Its CPU oneDNN/PIR inference path fails on the bundled OCR models; the build is pinned to 3.2.2.

The PyInstaller output must be an onedir runtime at `dist/vse-cli`. Test both `--device cpu` and `--device gpu` before packaging.

## Package

The ZIP layout is fixed:

```text
vse-cli-1.0.1.zip
`-- vse-cli/
    |-- vse-cli.exe
    `-- _internal/
```

Create the archive with 7-Zip so ZIP64 is available for the multi-gigabyte runtime:

```powershell
7z a -tzip -mx=5 release\vse-cli-1.0.1.zip .\dist\vse-cli
Get-FileHash release\vse-cli-1.0.1.zip -Algorithm SHA256
```

`archiveSize` is the ZIP byte length. `installedSize` is the sum of uncompressed file lengths below `dist/vse-cli`. Generate `release/manifest.json` only from the final archive and directory; never estimate these values.

Release 1.0.1 was verified with these values:

```text
archiveSize:   2618397906
installedSize: 4727674924
sha256:        a271756527b184a22e930b54181cff06a12744805cf90f27f782e1016dca0fd2
```

## Publish

Upload the archive first to:

```text
https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/vse-cli/vse-cli-1.0.1.zip
```

Verify the uploaded archive byte length and SHA-256, then upload `manifest.json` last. Publishing the manifest last prevents clients from seeing a release whose archive is not ready.

## Rollback

Keep the previous archive and manifest in the dataset history. To roll back, restore the previous `vse-cli/manifest.json` commit without deleting either archive. Confirm the restored manifest URL returns HTTP 200 and its checksum matches before ending the incident.

## Installer Check

The Electron `extraResources` list must continue to include the existing Whisper seed/runtime files and must not include `dist/vse-cli`, `vse-cli-*.zip`, or the VSE source checkout.
