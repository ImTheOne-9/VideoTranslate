'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const compiledMode = process.argv.includes('--compiled');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const errors = [];
const warnings = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const requiredFiles = [
  'index.js',
  'logo.ico',
  'changelog.json',
  'public/default_voices/Giọng Nữ miền Bắc.wav',
  'public/default_voices/Giọng Nữ miền Bắc.txt',
  'public/default_voices/Giọng Nam miền Bắc.wav',
  'public/default_voices/Giọng Nam miền Bắc.txt',
  'tools/ffmpeg.exe',
  'tools/ffprobe.exe',
  'tools/yt-dlp.exe',
  'tools/uv.exe',
  'tools/node/node.exe',
  'tools/nllb_translate.exe',
  'tools/silero-vad/silero_vad.onnx',
  'tools/crawler/requirements-crawler.txt',
  'tools/crawler/requirements-asr.txt',
  'tools/crawler/requirements-ocr.txt',
  'tools/crawler/install-ocr-gpu.py',
  'tools/crawler/install-whisper-gpu.py',
  'tools/crawler/setup-runtime.ps1',
  'tools/crawler/setup-omnivoice-runtime.ps1',
  'tools/crawler/setup-piper-runtime.ps1',
  'tools/crawler/app/tai_ytdlp.py',
  'tools/crawler/app/tim_anh.py',
  'tools/crawler/app/mo_dang_nhap.py',
  'tools/crawler/app/kiem_tra_login.py',
  'tools/crawler/app/xhs_browser.py',
  'tools/crawler/app/cookie_decrypt.py',
  'tools/crawler/app/index_metadata.py',
  'tools/crawler/app/piper_tts_bridge.py',
  'tools/crawler/app/audio_stretch_bridge.py',
  'tools/crawler/app/faster_whisper_asr.py',
  'tools/crawler/app/capcut_asr.py',
  'tools/crawler/app/capcut_tts_worker.py',
  'tools/crawler/app/capcut_voice_catalog.json',
  'tools/crawler/app/omnivoice_batch_worker.py',
  'tools/crawler/app/whisper_cuda_runtime.py',
  'tools/crawler/app/viral_ocr/viral_ocr_cli.py',
  'tools/crawler/app/viral_ocr/ocr_text.py',
  'tools/crawler/app/viral_ocr/dai_sub_rapid.py',
  'tools/crawler/app/viral_ocr/chat_luong.py',
  'tools/crawler/app/viral_ocr/thong_tin_may.py',
  'tools/crawler/app/viral_ocr/chan_doan_loi.py',
  'tools/crawler/app/viral_ocr/phu_de.py',
  'tools/crawler/app/viral_ocr/cai_gpu.py',
  'tools/crawler/app/MediaCrawler/main.py',
  'tools/crawler/app/MediaCrawler/tools/tien_do_tai.py',
  'tools/crawler/app/MediaCrawler/media_platform/douyin/client.py',
  'tools/crawler/app/MediaCrawler/media_platform/bilibili/client.py',
  'tools/crawler/app/MediaCrawler/media_platform/xhs/client.py',
  'tools/crawler/app/MediaCrawler/media_platform/xhs/core.py'
];

for (const relativePath of requiredFiles) {
  check(exists(relativePath), `Thiếu tài nguyên bắt buộc: ${relativePath}`);
}

const crawlerResource = (packageJson.build?.extraResources || [])
  .find((entry) => entry.from === 'tools/crawler/');
check(Boolean(crawlerResource), 'Thiếu extraResources cho tools/crawler/.');
const crawlerFilters = crawlerResource?.filter || [];
for (const filename of ['requirements-crawler.txt', 'requirements-asr.txt', 'requirements-ocr.txt', 'install-ocr-gpu.py', 'install-whisper-gpu.py', 'setup-runtime.ps1', 'setup-omnivoice-runtime.ps1', 'setup-piper-runtime.ps1']) {
  check(crawlerFilters.includes(filename), `extraResources chưa chứa tools/crawler/${filename}`);
}
for (const pattern of [
  '!app/models/**/*',
  '!app/**/browser_data/**/*',
  '!app/**/__pycache__/**/*',
  '!app/**/*.pyc',
  '!app/**/test/**/*',
  '!app/**/tests/**/*',
  '!app/**/test_data/**/*',
  '!app/**/docs/**/*',
  '!app/**/data/**/*',
  '!app/**/media_data/**/*'
]) {
  check(crawlerFilters.includes(pattern), `Bộ lọc crawler chưa loại trừ: ${pattern}`);
}

const toolResource = (packageJson.build?.extraResources || [])
  .find((entry) => entry.from === 'tools/');
const toolFilters = toolResource?.filter || [];
for (const filename of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'uv.exe', 'node/node.exe']) {
  check(toolFilters.includes(filename), `extraResources chưa chứa tools/${filename}`);
}

const buildFiles = packageJson.build?.files || [];
for (const excluded of ['!license-server/**/*', '!.env', '!.env.*', '!**/.env', '!**/.env.*']) {
  check(buildFiles.includes(excluded), `Thiếu loại trừ cấu hình server khỏi gói desktop: ${excluded}`);
}
if (exists('.env')) {
  check(!/^\s*(?:export\s+)?FACEBOOK_APP_SECRET\s*=/m.test(fs.readFileSync(path.join(root, '.env'), 'utf8')),
    'FACEBOOK_APP_SECRET còn trong .env desktop; chuyển sang cấu hình backend trước khi build.');
}
for (const pattern of [
  'public/**/*',
  'scripts/**/*',
  'lib/**/*.jsc',
  'controllers/**/*.jsc',
  'server.jsc',
  'main.jsc',
  'index.js',
  'silero-vad-child-runtime.js',
  'whisper-onnx-child-runtime.js'
]) {
  check(buildFiles.includes(pattern), `build.files chưa chứa ${pattern}`);
}

if (compiledMode) {
  for (const relativePath of ['main.jsc', 'server.jsc']) {
    check(exists(relativePath), `Thiếu bytecode sau biên dịch: ${relativePath}`);
  }
  const jscCount = ['lib', 'controllers'].reduce((total, directory) => {
    const pending = [path.join(root, directory)];
    let count = 0;
    while (pending.length) {
      const current = pending.pop();
      if (!fs.existsSync(current)) continue;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(fullPath);
        else if (entry.name.endsWith('.jsc')) count += 1;
      }
    }
    return total + count;
  }, 0);
  check(jscCount >= 10, `Số file backend .jsc bất thường: ${jscCount}`);
} else {
  for (const relativePath of ['main.js', 'server.js', 'lib/shared-state.js', 'controllers/studioController.js']) {
    check(exists(relativePath), `Thiếu source trước build: ${relativePath}`);
  }
  if (exists('backup_src')) warnings.push('Đang tồn tại backup_src; hãy xác minh lần build trước đã khôi phục source.');
}

const outputDirectory = path.resolve(packageJson.build?.directories?.output || path.join(root, 'dist'));
const outputRoot = path.parse(outputDirectory).root;
try {
  const stats = fs.statfsSync(outputRoot);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  check(freeBytes >= 3 * 1024 ** 3, `Ổ build còn dưới 3 GB: ${outputRoot}`);
} catch (error) {
  errors.push(`Không kiểm tra được dung lượng ổ build ${outputRoot}: ${error.message}`);
}

if (warnings.length) {
  for (const warning of warnings) console.warn(`[Packaging warning] ${warning}`);
}
if (errors.length) {
  for (const error of errors) console.error(`[Packaging error] ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[Packaging preflight] OK (${compiledMode ? 'compiled' : 'source'})`);
}
