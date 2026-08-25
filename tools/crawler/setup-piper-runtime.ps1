param(
  [string]$Python = "",
  [string]$RuntimeRoot = "",
  [string]$Uv = "",
  [switch]$ForceRepair
)

$ErrorActionPreference = "Stop"
$crawlerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $crawlerRoot "app\piper_tts_bridge.py"
if (-not $RuntimeRoot) {
  $RuntimeRoot = Join-Path $env:APPDATA "Video Studio Tools\crawler\runtime"
}
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$venvRoot = Join-Path $RuntimeRoot "venv"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"

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
  throw "Không tìm thấy Python 3.11 hoặc uv.exe để cài Piper."
}
if (-not (Test-Path -LiteralPath $bridgePath)) {
  throw "Thiếu piper_tts_bridge.py: $bridgePath"
}

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $venvPython)) {
  Write-Host "[10%] Đang tạo Python runtime Piper..."
  if ($Uv) {
    & $Uv venv $venvRoot --python 3.11
  } elseif ([System.IO.Path]::GetFileName($Python) -ieq "py.exe") {
    & $Python -3.11 -m venv $venvRoot
  } else {
    & $Python -m venv $venvRoot
  }
}

Write-Host "[30%] Đang kiểm tra ONNX Runtime dùng chung với OCR/GPU..."
& $venvPython -c "import onnxruntime as ort; ort.SessionOptions(); print(','.join(ort.get_available_providers()))"
if ($LASTEXITCODE -ne 0) {
  Write-Host "[40%] ONNX Runtime bị thiếu/hỏng, đang cài bản CPU an toàn..."
  if ($Uv) { & $Uv pip install --python $venvPython --reinstall "onnxruntime==1.26.0" }
  else { & $venvPython -m pip install --force-reinstall "onnxruntime==1.26.0" }
}

# piper-tts chỉ phụ thuộc onnxruntime. Cài --no-deps để không kéo bản CPU đè lên
# onnxruntime-gpu đang hoạt động của RapidOCR/Piper trên máy khách.
Write-Host "[55%] Đang cài thư viện Piper offline..."
if ($Uv) {
  $supportArgs = @("pip", "install", "--python", $venvPython, "--upgrade")
  if ($ForceRepair) {
    $supportArgs += @("--reinstall-package", "audiostretchy", "--reinstall-package", "vietnormalizer")
  }
  $supportArgs += @("audiostretchy>=1.3,<2", "vietnormalizer==0.2.3")
  & $Uv @supportArgs
  $piperArgs = @("pip", "install", "--python", $venvPython, "--upgrade", "--no-deps")
  if ($ForceRepair) { $piperArgs += @("--reinstall-package", "piper-tts") }
  $piperArgs += "piper-tts==1.3.0"
  & $Uv @piperArgs
} else {
  & $venvPython -m pip install --upgrade "audiostretchy>=1.3,<2" "vietnormalizer==0.2.3"
  if ($ForceRepair) {
    & $venvPython -m pip install --force-reinstall --no-deps "audiostretchy>=1.3,<2" "vietnormalizer==0.2.3"
  }
  & $venvPython -m pip install --upgrade --no-deps "piper-tts==1.3.0"
  if ($ForceRepair) { & $venvPython -m pip install --force-reinstall --no-deps "piper-tts==1.3.0" }
}

Write-Host "[90%] Đang xác minh Piper bằng bridge thật..."
$env:VIDEO_STUDIO_CRAWLER_RUNTIME = $RuntimeRoot
& $venvPython $bridgePath --check
if ($LASTEXITCODE -ne 0) {
  throw "Piper bridge kiểm tra thất bại."
}

$marker = @{
  version = 1
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  verifiedBy = "piper_tts_bridge.py --check"
  modelPolicy = "on-demand"
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $RuntimeRoot "piper-runtime-v1.json") -Value $marker -Encoding UTF8
Write-Host "[100%] Piper offline đã sẵn sàng. Model giọng sẽ tải riêng ở lần dùng đầu tiên."
