const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkDependencyStatus,
  cleanupLegacySeparator,
  DEPENDENCIES
} = require('../lib/dependency-downloader');

test('defines one MDX ONNX separator dependency with runner and model', () => {
  assert.equal(DEPENDENCIES['separator-gpu'], undefined);
  assert.equal(DEPENDENCIES.separator.zipName, 'mdx-onnx-separator.zip');
  assert.deepEqual(DEPENDENCIES.separator.expectedFiles, [
    path.join('mdx-onnx', 'mdx-separator.exe'),
    path.join('mdx-onnx', 'models', 'UVR_MDXNET_KARA_2.onnx')
  ]);
});

test('separator readiness requires both the MDX runner and model', () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdx-status-'));
  const separatorDir = path.join(toolsDir, 'mdx-onnx');
  const modelDir = path.join(separatorDir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(separatorDir, 'mdx-separator.exe'), 'runner');

  assert.equal(checkDependencyStatus(toolsDir).separator, false);
  fs.writeFileSync(path.join(modelDir, 'UVR_MDXNET_KARA_2.onnx'), 'model');
  assert.equal(checkDependencyStatus(toolsDir).separator, true);
  fs.rmSync(toolsDir, { recursive: true, force: true });
});

test('legacy separator cleanup removes Python and Roformer assets', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdx-cleanup-'));
  const toolsDir = path.join(dataDir, 'tools');
  fs.mkdirSync(path.join(toolsDir, 'models'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'temp_env', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'audio-separator.exe'), 'old');
  fs.writeFileSync(path.join(toolsDir, 'models', 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'), 'old');
  fs.writeFileSync(path.join(dataDir, 'temp_env', 'Scripts', 'python.exe'), 'old');

  cleanupLegacySeparator(toolsDir);

  assert.equal(fs.existsSync(path.join(toolsDir, 'audio-separator.exe')), false);
  assert.equal(fs.existsSync(path.join(toolsDir, 'models', 'model_bs_roformer_ep_317_sdr_12.9755.ckpt')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'temp_env')), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('production separator flow no longer references Python or dual variants', () => {
  const root = path.join(__dirname, '..');
  const files = [
    'controllers/studioController.js',
    'controllers/systemController.js',
    'lib/shared-state.js',
    'public/app.js',
    'public/index.html',
    'public/js/globals.js'
  ];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

  assert.doesNotMatch(source, /separator-gpu|separatorGpu|separate_audio\.py|setup_gpu_separator|audio-separator\.exe/i);
  assert.match(source, /UVR_MDXNET_KARA_2\.onnx/);
  assert.match(source, /output-vocals-wav=\$\{instrumentalPath\}/);
  assert.match(source, /extractedBgmPath = instrumentalPath/);
  assert.doesNotMatch(source, /extractedBgmPath = (?:accompanimentPath|residualVocalsPath)/);
});
