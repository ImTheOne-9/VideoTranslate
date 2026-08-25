param(
  [string]$Python = "",
  [string]$RuntimeRoot = "",
  [string]$Uv = ""
)

$ErrorActionPreference = "Stop"
$crawlerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$requirements = Join-Path $crawlerRoot "requirements-crawler.txt"

if (-not $RuntimeRoot) {
  $RuntimeRoot = Join-Path $env:APPDATA "Video Studio Tools\crawler\runtime"
}
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$venvRoot = Join-Path $RuntimeRoot "venv"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
$playwrightRoot = Join-Path $RuntimeRoot "ms-playwright-python"

if (-not $Python) {
  $candidate = Get-Command py -ErrorAction SilentlyContinue
  if ($candidate) { $Python = $candidate.Source }
  else {
    $candidate = Get-Command python -ErrorAction SilentlyContinue
    if ($candidate) { $Python = $candidate.Source }
  }
}
if (-not $Uv) {
  $bundledUv = Join-Path (Split-Path -Parent $crawlerRoot) "uv.exe"
  if (Test-Path -LiteralPath $bundledUv) { $Uv = $bundledUv }
  else {
    $candidate = Get-Command uv -ErrorAction SilentlyContinue
    if ($candidate) { $Uv = $candidate.Source }
  }
}
if (-not $Python -and -not $Uv) {
  throw "Không tìm thấy Python 3.11 hoặc uv.exe để tự cài Python."
}

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $venvPython)) {
  if ($Uv) {
    & $Uv venv $venvRoot --python 3.11
  } elseif ([System.IO.Path]::GetFileName($Python) -ieq "py.exe") {
    & $Python -3.11 -m venv $venvRoot
  } else {
    & $Python -m venv $venvRoot
  }
}

if ($Uv) {
  # uv can install into a freshly-created environment even when pip is not seeded.
  & $Uv pip install --python $venvPython --upgrade pip
  & $Uv pip install --python $venvPython -r $requirements
} else {
  & $venvPython -m pip install --upgrade pip
  & $venvPython -m pip install -r $requirements
}
$env:PLAYWRIGHT_BROWSERS_PATH = $playwrightRoot
& $venvPython -m playwright install chromium
& $venvPython -c "import numpy as np, yt_dlp, playwright, httpx, pydantic, cv2, onnxruntime as ort, rapidocr, rapidocr_onnxruntime, zhconv, piper, audiostretchy, vietnormalizer, faster_whisper, ctranslate2; ort.SessionOptions(); e=rapidocr.RapidOCR(); e(np.zeros((64,320,3),dtype=np.uint8)); print('VIDEO_STUDIO_CRAWLER_OCR_VOICE_AND_ASR_RUNTIME_OK')"
& $venvPython -c "import onnxruntime, rapidocr; print('VIDEO_STUDIO_OCR_PROVIDERS=' + ','.join(onnxruntime.get_available_providers()))"

$runtimeMarker = Join-Path $RuntimeRoot "ocr-runtime-v3.json"
$markerData = @{
  version = 3
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  pipeline = "rapidocr-ppocrv6"
  ocrDefaultDevice = "cpu"
  gpuOptional = $true
} | ConvertTo-Json
Set-Content -LiteralPath $runtimeMarker -Value $markerData -Encoding UTF8

$voiceRuntimeMarker = Join-Path $RuntimeRoot "voice-runtime-v3.json"
$voiceMarkerData = @{
  version = 3
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  engines = @("piper", "audiostretchy", "vietnormalizer")
  piperModel = "on-demand"
  piperTextNormalization = "vietnormalizer-0.2.3"
} | ConvertTo-Json
Set-Content -LiteralPath $voiceRuntimeMarker -Value $voiceMarkerData -Encoding UTF8

$asrRuntimeMarker = Join-Path $RuntimeRoot "asr-runtime-v1.json"
$asrMarkerData = @{
  version = 1
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  engine = "faster-whisper"
  model = "large-v3-turbo"
  modelOnDemand = $true
  fallback = "whisper-onnx-cpu"
} | ConvertTo-Json
Set-Content -LiteralPath $asrRuntimeMarker -Value $asrMarkerData -Encoding UTF8

Write-Host "Runtime crawler đã sẵn sàng tại $RuntimeRoot"
