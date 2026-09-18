$ErrorActionPreference = "Stop"
$youtubeUserRoot = if ($env:VIDEO_STUDIO_CRAWLER_HOME) { $env:VIDEO_STUDIO_CRAWLER_HOME } else { Join-Path $env:APPDATA "Video Studio Tools/crawler" }
$youtubePython = if ($env:VIDEO_STUDIO_CRAWLER_PYTHON) { $env:VIDEO_STUDIO_CRAWLER_PYTHON } else { Join-Path $youtubeUserRoot "runtime/venv/Scripts/python.exe" }
if (!(Test-Path -LiteralPath $youtubePython)) { throw "Chưa có runtime Python. Mở tool và cài runtime trước." }
$env:MC_BROWSER_DATA_DIR = if ($env:VIDEO_STUDIO_CRAWLER_BROWSER_DATA) { $env:VIDEO_STUDIO_CRAWLER_BROWSER_DATA } else { Join-Path $youtubeUserRoot "browser_data" }
$youtubeExportScript = Join-Path $PSScriptRoot "../tools/crawler/app/youtube_session.py"
& $youtubePython $youtubeExportScript --action export --output (Join-Path $youtubeUserRoot "youtube-cookies.txt")
