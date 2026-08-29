param(
  [string]$Python = "",
  [string]$RuntimeRoot = "",
  [string]$Uv = "",
  [ValidateSet("asr", "ocr", "crawler")]
  [string]$Capability = "crawler"
)

$ErrorActionPreference = "Stop"
$crawlerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$requirements = switch ($Capability) {
  "asr" { Join-Path $crawlerRoot "requirements-asr.txt" }
  "ocr" { Join-Path $crawlerRoot "requirements-ocr.txt" }
  default { Join-Path $crawlerRoot "requirements-crawler.txt" }
}

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
  Write-Host "5% Đang tạo môi trường Python dùng chung..."
  if ($Uv) {
    & $Uv venv $venvRoot --python 3.11
  } elseif ([System.IO.Path]::GetFileName($Python) -ieq "py.exe") {
    & $Python -3.11 -m venv $venvRoot
  } else {
    & $Python -m venv $venvRoot
  }
}

Write-Host "10% Đang cài các thư viện cho $Capability..."
if ($Uv) {
  # uv can install into a freshly-created environment even when pip is not seeded.
  & $Uv pip install --python $venvPython --upgrade pip
  & $Uv pip install --python $venvPython -r $requirements
} else {
  & $venvPython -m pip install --upgrade pip
  & $venvPython -m pip install -r $requirements
}
if ($Capability -eq "asr") {
  Write-Host "60% Đang dùng ONNX Runtime hiện có của hệ thống..."
  & $venvPython -c "import onnxruntime as ort; ort.SessionOptions(); print(','.join(ort.get_available_providers()))"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "65% ONNX Runtime chưa có hoặc bị hỏng, đang cài bản CPU an toàn..."
    if ($Uv) { & $Uv pip install --python $venvPython "onnxruntime==1.26.0" }
    else { & $venvPython -m pip install "onnxruntime==1.26.0" }
  }
  # Không cho dependency onnxruntime của faster-whisper ghi đè onnxruntime-gpu
  # mà RapidOCR có thể đã cài trong cùng môi trường Python.
  if ($Uv) { & $Uv pip install --python $venvPython --upgrade --no-deps "faster-whisper==1.2.1" }
  else { & $venvPython -m pip install --upgrade --no-deps "faster-whisper==1.2.1" }
  Write-Host "70% Đang kiểm tra Faster-Whisper và Silero VAD..."
  & $venvPython -c "import onnxruntime as ort, faster_whisper, ctranslate2; ort.SessionOptions(); print('VIDEO_STUDIO_ASR_RUNTIME_OK')"

  $asrRuntimeMarker = Join-Path $RuntimeRoot "asr-runtime-v1.json"
  $asrMarkerData = @{
    version = 1
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    engine = "faster-whisper"
    model = "large-v3-turbo"
    modelOnDemand = $true
    fallback = "large-v3-turbo-cpu-int8"
  } | ConvertTo-Json
  Set-Content -LiteralPath $asrRuntimeMarker -Value $asrMarkerData -Encoding UTF8
  Write-Host "100% Faster-Whisper runtime đã sẵn sàng tại $RuntimeRoot"
  exit 0
}
if ($Capability -eq "ocr") {
  Write-Host "60% Đang dùng ONNX Runtime hiện có của hệ thống..."
  & $venvPython -c "import onnxruntime as ort; ort.SessionOptions(); print(','.join(ort.get_available_providers()))"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "65% ONNX Runtime chưa có hoặc bị hỏng, đang cài bản CPU an toàn..."
    if ($Uv) { & $Uv pip install --python $venvPython "onnxruntime==1.26.0" }
    else { & $venvPython -m pip install "onnxruntime==1.26.0" }
  }
  # Gói tương thích PP-OCRv4 được giữ để fallback nhưng không được phép kéo
  # onnxruntime CPU đè lên backend GPU đang hoạt động.
  if ($Uv) { & $Uv pip install --python $venvPython --upgrade --no-deps "rapidocr-onnxruntime==1.4.4" }
  else { & $venvPython -m pip install --upgrade --no-deps "rapidocr-onnxruntime==1.4.4" }
  Write-Host "70% Đang kiểm tra RapidOCR bằng ảnh thử..."
  & $venvPython -c "import numpy as np, cv2, onnxruntime as ort, rapidocr, rapidocr_onnxruntime, zhconv; ort.SessionOptions(); e=rapidocr.RapidOCR(); e(np.zeros((64,320,3),dtype=np.uint8)); print('VIDEO_STUDIO_OCR_RUNTIME_OK')"

  $ocrRuntimeMarker = Join-Path $RuntimeRoot "ocr-runtime-v3.json"
  $ocrMarkerData = @{
    version = 3
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    pipeline = "rapidocr-ppocrv6"
    ocrDefaultDevice = "cpu"
    gpuOptional = $true
  } | ConvertTo-Json
  Set-Content -LiteralPath $ocrRuntimeMarker -Value $ocrMarkerData -Encoding UTF8
  Write-Host "100% RapidOCR runtime đã sẵn sàng tại $RuntimeRoot"
  exit 0
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
  fallback = "large-v3-turbo-cpu-int8"
} | ConvertTo-Json
Set-Content -LiteralPath $asrRuntimeMarker -Value $asrMarkerData -Encoding UTF8

Write-Host "Bộ công cụ hệ thống đã sẵn sàng tại $RuntimeRoot"
