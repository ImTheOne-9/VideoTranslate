const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('packaging excludes crawler profiles, cache, docs and test fixtures', () => {
  const crawler = packageJson.build.extraResources.find((entry) => entry.from === 'tools/crawler/');
  assert.ok(crawler);
  assert.ok(crawler.filter.includes('requirements-asr.txt'));
  assert.ok(crawler.filter.includes('requirements-ocr.txt'));
  assert.ok(crawler.filter.includes('install-whisper-gpu.py'));
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
    assert.ok(crawler.filter.includes(pattern), `missing exclusion ${pattern}`);
  }
});

test('packaging includes a matched FFmpeg and FFprobe pair', () => {
  const tools = packageJson.build.extraResources.find((entry) => entry.from === 'tools/');
  assert.ok(tools.filter.includes('ffmpeg.exe'));
  assert.ok(tools.filter.includes('ffprobe.exe'));
  assert.equal(fs.existsSync(path.join(root, 'tools', 'ffmpeg.exe')), true);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'ffprobe.exe')), true);
});

test('release scripts always use the guarded obfuscation build', () => {
  assert.match(packageJson.scripts['electron-dist'], /obfuscate\.js --build/);
  assert.match(packageJson.scripts['pack-unpacked'], /obfuscate\.js --build --dir/);
  assert.doesNotMatch(packageJson.scripts['electron-dist'], /^electron-builder/);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'package-preflight.js')), true);
});

test('crawler keeps Python Playwright browsers isolated from Node Playwright', () => {
  const pathsSource = fs.readFileSync(path.join(root, 'lib', 'crawler-paths.js'), 'utf8');
  const setupSource = fs.readFileSync(path.join(root, 'tools', 'crawler', 'setup-runtime.ps1'), 'utf8');
  assert.match(pathsSource, /ms-playwright-python/);
  assert.match(setupSource, /ms-playwright-python/);
});

test('packaging keeps the complete RapidOCR source and runtime dependencies', () => {
  const requirements = fs.readFileSync(path.join(root, 'tools', 'crawler', 'requirements-crawler.txt'), 'utf8');
  for (const dependency of ['rapidocr==3.9.1', 'rapidocr-onnxruntime==1.4.4', 'onnxruntime==1.26.0', 'zhconv==1.4.3']) {
    assert.match(requirements, new RegExp(dependency.replace(/[.-]/g, '\\$&')));
  }
  const gpuInstaller = fs.readFileSync(path.join(root, 'tools', 'crawler', 'install-ocr-gpu.py'), 'utf8');
  const runtimeSetup = fs.readFileSync(path.join(root, 'tools', 'crawler', 'setup-runtime.ps1'), 'utf8');
  assert.match(gpuInstaller, /ORT_VERSION = ["']1\.22\.0["']/);
  assert.match(gpuInstaller, /onnxruntime-gpu==/);
  assert.match(gpuInstaller, /CUDAExecutionProvider/);
  assert.match(gpuInstaller, /restore_cpu/);
  assert.doesNotMatch(runtimeSetup, /install-ocr-gpu\.py/);
  const crawler = packageJson.build.extraResources.find((entry) => entry.from === 'tools/crawler/');
  assert.ok(crawler.filter.includes('install-ocr-gpu.py'));
  for (const filename of [
    'viral_ocr_cli.py',
    'ocr_text.py',
    'dai_sub_rapid.py',
    'chat_luong.py',
    'thong_tin_may.py',
    'chan_doan_loi.py',
    'phu_de.py',
    'cai_gpu.py'
  ]) {
    assert.equal(fs.existsSync(path.join(root, 'tools', 'crawler', 'app', 'viral_ocr', filename)), true);
  }
});

test('lightweight ASR and OCR installs preserve an existing ONNX GPU backend', () => {
  const setup = fs.readFileSync(path.join(root, 'tools', 'crawler', 'setup-runtime.ps1'), 'utf8');
  const asr = fs.readFileSync(path.join(root, 'tools', 'crawler', 'requirements-asr.txt'), 'utf8');
  const ocr = fs.readFileSync(path.join(root, 'tools', 'crawler', 'requirements-ocr.txt'), 'utf8');

  assert.doesNotMatch(asr, /^onnxruntime(?:==|\s)/mu);
  assert.doesNotMatch(ocr, /^onnxruntime(?:==|\s)/mu);
  assert.match(setup, /--no-deps "faster-whisper==1\.2\.1"/u);
  assert.match(setup, /--no-deps "rapidocr-onnxruntime==1\.4\.4"/u);
  assert.match(asr, /^requests>=/mu);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'crawler', 'app', 'capcut_asr.py')), true);
});

test('Whisper GPU installer performs real inference, runtime repair and deterministic DLL setup', () => {
  const installer = fs.readFileSync(path.join(root, 'tools', 'crawler', 'install-whisper-gpu.py'), 'utf8');
  const dllRuntime = fs.readFileSync(path.join(root, 'tools', 'crawler', 'app', 'whisper_cuda_runtime.py'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'tools', 'crawler', 'app', 'faster_whisper_asr.py'), 'utf8');
  for (const dependency of ['nvidia-cuda-runtime-cu12', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12']) {
    assert.match(installer, new RegExp(dependency));
  }
  assert.match(installer, /WhisperModel\([\s\S]*device="cuda"/u);
  assert.match(installer, /list\(segments\)/u);
  assert.match(installer, /def repair_runtime/u);
  assert.match(dllRuntime, /cudnnPolicy/u);
  assert.match(worker, /whisper-gpu-status\.json/u);
});

test('packaging includes the dedicated Piper installer and bridge', () => {
  const crawler = packageJson.build.extraResources.find((entry) => entry.from === 'tools/crawler/');
  assert.ok(crawler.filter.includes('setup-piper-runtime.ps1'));
  assert.equal(fs.existsSync(path.join(root, 'tools', 'crawler', 'setup-piper-runtime.ps1')), true);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'crawler', 'app', 'piper_tts_bridge.py')), true);
});

test('packaging includes the Python OmniVoice batch worker and on-demand installer', () => {
  const crawler = packageJson.build.extraResources.find((entry) => entry.from === 'tools/crawler/');
  const tools = packageJson.build.extraResources.find((entry) => entry.from === 'tools/');
  assert.ok(crawler.filter.includes('setup-omnivoice-runtime.ps1'));
  assert.equal(fs.existsSync(path.join(root, 'tools', 'crawler', 'setup-omnivoice-runtime.ps1')), true);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'crawler', 'app', 'omnivoice_batch_worker.py')), true);
  assert.equal(fs.existsSync(path.join(root, 'public', 'default_voices', 'Giọng Nữ miền Bắc.wav')), true);
  assert.equal(fs.existsSync(path.join(root, 'public', 'default_voices', 'Giọng Nam miền Bắc.wav')), true);
  const installer = fs.readFileSync(path.join(root, 'tools', 'crawler', 'setup-omnivoice-runtime.ps1'), 'utf8');
  assert.match(installer, /torch\.nn/u);
  assert.match(installer, /cu126[\s\S]*cu128/u);
  assert.match(installer, /dllPathSanitized/u);
  assert.ok(!tools.filter.includes('omnivoice/omnivoice-cli.exe'));
  assert.ok(!tools.filter.includes('omnivoice/omnivoice-server-*.exe'));
});

test('packaging includes the CapCut TTS worker and complete voice catalog', () => {
  const appRoot = path.join(root, 'tools', 'crawler', 'app');
  assert.equal(fs.existsSync(path.join(appRoot, 'capcut_tts_worker.py')), true);
  const catalog = JSON.parse(fs.readFileSync(path.join(appRoot, 'capcut_voice_catalog.json'), 'utf8'));
  assert.equal(catalog.voiceCount, 459);
  assert.equal(catalog.voices.length, 459);
  assert.ok(catalog.voices.some((voice) => voice.provider === '11labs'));
});
