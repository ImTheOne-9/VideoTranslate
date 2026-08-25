const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('startup dependency check uses the model-aware aggregate endpoint', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'drag-drop-module.js'),
    'utf8'
  );
  const functionSource = source.match(
    /async function checkLocalDependencies\(\) \{[\s\S]*?\n\}/
  )?.[0] || '';

  assert.match(functionSource, /fetch\('\/api\/check-dependencies'\)/);
  assert.doesNotMatch(functionSource, /check-dependencies-status/);
});

test('aggregate dependency status preserves CUDA and checks Faster-Whisper model files', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'systemController.js'),
    'utf8'
  );

  assert.match(source, /cuda:\s*runtimeDependencies\.cuda/);
  assert.match(source, /getFasterWhisperReadiness\(\)/);
  assert.match(source, /'large-v3-turbo':\s*whisperModelOk/);
  assert.match(source, /whisper:\s*whisperModelOk/);
});

test('studio exposes only Faster-Whisper and routes model setup to Large V3 Turbo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const library = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'library-module.js'), 'utf8');

  assert.match(html, /Faster-Whisper Large V3 Turbo \(1,51 GB\)/);
  assert.doesNotMatch(html, /Whisper ONNX|Medium Q8|value="whisper-onnx"/);
  assert.match(app, /body: JSON\.stringify\(\{ model: 'large-v3-turbo' \}\)/);
  assert.doesNotMatch(app, /whisper-model\/status\?variant=/);
  assert.match(library, /FASTER_WHISPER_MODEL_ID = 'large-v3-turbo'/);
});
