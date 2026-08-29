param(
  [string]$RuntimeRoot = "",
  [string]$Uv = ""
)

$ErrorActionPreference = "Stop"
$crawlerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RuntimeRoot) {
  $RuntimeRoot = Join-Path $env:APPDATA "Video Studio Tools\crawler\runtime"
}
if (-not $Uv) {
  $Uv = Join-Path (Split-Path -Parent $crawlerRoot) "uv.exe"
}
if (-not (Test-Path -LiteralPath $Uv)) { throw "Khong tim thay uv.exe: $Uv" }

$nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $nvidia) { throw "OmniVoice Python yeu cau GPU NVIDIA va driver hoat dong." }
& $nvidia.Source -L | Out-Null
if ($LASTEXITCODE -ne 0) { throw "nvidia-smi khong hoat dong. Hay cai/cap nhat NVIDIA Driver." }

$omniRoot = Join-Path ([System.IO.Path]::GetFullPath($RuntimeRoot)) "omnivoice"
$venvRoot = Join-Path $omniRoot "venv"
$python = Join-Path $venvRoot "Scripts\python.exe"
$hfHome = Join-Path $omniRoot "hf-cache"
$marker = Join-Path $omniRoot "runtime-v1.json"
New-Item -ItemType Directory -Path $omniRoot -Force | Out-Null
New-Item -ItemType Directory -Path $hfHome -Force | Out-Null
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }

$driverVersion = (& $nvidia.Source --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
Write-Host "2% NVIDIA Driver $driverVersion - dang kiem tra runtime cu..."

Write-Host "5% Dang tao moi truong Python rieng cho OmniVoice..."
if (Test-Path -LiteralPath $python) {
  & $python -c "import sys; assert sys.version_info[:2] == (3, 11)" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "7% Runtime Python cu bi hong/sai phien ban - dang tao lai venv..."
    & $Uv venv $venvRoot --python 3.11 --clear
    if ($LASTEXITCODE -ne 0) { throw "Khong tu sua duoc moi truong Python OmniVoice." }
  }
} else {
  & $Uv venv $venvRoot --python 3.11
  if ($LASTEXITCODE -ne 0) { throw "Khong tao duoc moi truong OmniVoice." }
}

Write-Host "12% Dang cai OmniVoice va thu vien am thanh..."
& $Uv pip install --python $python --upgrade --reinstall "omnivoice" "soundfile" "numpy" "huggingface-hub"
if ($LASTEXITCODE -ne 0) { throw "Khong cai duoc goi OmniVoice." }

$computeText = [string](& $nvidia.Source --query-gpu=compute_cap --format=csv,noheader 2>$null | Select-Object -First 1)
$compute = 0.0
[double]::TryParse((($computeText -replace ',', '.').Trim()), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$compute) | Out-Null
if ($compute -gt 0 -and $compute -lt 6.1) {
  throw "GPU compute capability $compute qua cu; PyTorch 2.8 Windows khong con kernel phu hop cho OmniVoice."
}
$torchVersion = "2.8.0"
$channels = if ($compute -ge 10.0) { @("cu128") } else { @("cu126", "cu128") }
$selectedChannel = ""

# PyTorch wheel includes matching CUDA/cuDNN DLLs. Remove system CUDA Toolkit
# and cuDNN from PATH so Windows cannot load a conflicting major DLL first.
$cleanPathParts = @($env:PATH -split ';' | Where-Object {
  $_ -and $_ -notmatch 'NVIDIA GPU Computing Toolkit[\\/]CUDA' -and $_ -notmatch '[\\/]cudnn[\\/].*[\\/]bin'
})
$env:PATH = $cleanPathParts -join ';'

foreach ($channel in $channels) {
  Write-Host "25% Dang cai/sua PyTorch $torchVersion+$channel (buoc nay tai vai GB)..."
  & $Uv pip install --python $python --reinstall "torch==$torchVersion+$channel" "torchaudio==$torchVersion+$channel" --extra-index-url "https://download.pytorch.org/whl/$channel"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  PyTorch $channel tai/cai that bai; dang thu phuong an tuong thich tiep theo."
    continue
  }
  Write-Host "50% Dang kiem tra import, torch.nn, torchaudio va kernel CUDA that ($channel)..."
  & $python -c "import torch, torch.nn, torchaudio, omnivoice; assert torch.cuda.is_available(); x=torch.ones((64,64),device='cuda'); y=x@x; torch.cuda.synchronize(); cc=torch.cuda.get_device_capability(0); assert float(y.sum())>0; print('OMNIVOICE_CUDA_KERNEL_OK',torch.cuda.get_device_name(0),torch.__version__,cc,torch.cuda.get_arch_list())"
  if ($LASTEXITCODE -eq 0) {
    $selectedChannel = $channel
    break
  }
  Write-Host "  $channel cai duoc nhung kernel/import that that bai; dang tu sua bang kenh tiep theo."
}
if (-not $selectedChannel) {
  throw "Khong tim duoc PyTorch CUDA tuong thich voi GPU/driver. Hay cap nhat NVIDIA Driver roi bam Cai/sua lai."
}

$env:HF_HOME = $hfHome
$env:HUGGINGFACE_HUB_CACHE = Join-Path $hfHome "hub"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
Write-Host "65% Dang tai model k2-fsa/OmniVoice vao du lieu ben vung..."
& $python -c "from huggingface_hub import snapshot_download; print(snapshot_download('k2-fsa/OmniVoice'))"
if ($LASTEXITCODE -ne 0) { throw "Khong tai duoc model k2-fsa/OmniVoice." }

Write-Host "90% Dang kiem tra lai CUDA va toan bo import sau khi tai model..."
& $python -c "import torch, torch.nn, torchaudio, omnivoice; assert torch.cuda.is_available(); x=torch.ones((64,64),device='cuda'); y=x@x; torch.cuda.synchronize(); assert float(y.sum())>0; print('OMNIVOICE_CUDA_INFERENCE_OK',torch.cuda.get_device_name(0),torch.__version__)"
if ($LASTEXITCODE -ne 0) { throw "PyTorch da cai nhung CUDA inference that that bai." }

Write-Host "94% Dang chay mot cau OmniVoice that de xac minh toan bo model..."
$verifyDir = Join-Path $omniRoot "verify"
$verifyJob = Join-Path $verifyDir "job.json"
$worker = Join-Path $crawlerRoot "app\omnivoice_batch_worker.py"
New-Item -ItemType Directory -Path $verifyDir -Force | Out-Null
$verifyData = @{
  texts = @("Xin chao")
  outputDir = $verifyDir
  language = "vi"
  steps = 8
  instruct = "female, young adult, moderate pitch"
} | ConvertTo-Json
Set-Content -LiteralPath $verifyJob -Value $verifyData -Encoding UTF8
& $python $worker --job $verifyJob --batch 1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $verifyDir "_done.json"))) {
  throw "Model da tai nhung OmniVoice inference that that bai."
}
$verifyResult = Get-Content -LiteralPath (Join-Path $verifyDir "_done.json") -Raw | ConvertFrom-Json
if ([int]$verifyResult.ok -lt 1) { throw "OmniVoice inference tao audio cam." }

$markerData = @{
  version = 2
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  engine = "k2-fsa/OmniVoice"
  python = $python
  hfHome = $hfHome
  torch = "$torchVersion+$selectedChannel"
  cudaChannel = $selectedChannel
  driverVersion = "$driverVersion"
  computeCapability = $compute
  cudaInferenceVerified = $true
  modelInferenceVerified = $true
  runtimeHealthVerified = $true
  dllPathSanitized = $true
} | ConvertTo-Json
Set-Content -LiteralPath $marker -Value $markerData -Encoding UTF8
Write-Host "100% OmniVoice Python da san sang."
