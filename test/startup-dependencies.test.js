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

test('aggregate dependency status preserves CUDA and requires Faster-Whisper runtime plus model', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'systemController.js'),
    'utf8'
  );

  assert.match(source, /cuda:\s*runtimeDependencies\.cuda/);
  assert.match(source, /getFasterWhisperReadiness\(\)/);
  assert.match(source, /systemRuntimeManager\.status\('asr'\)/);
  assert.match(source, /'large-v3-turbo':\s*whisperModelOk/);
  assert.match(source, /whisperReady\s*=\s*whisperModelOk\s*&&\s*whisperRuntime\.ready/);
  assert.match(source, /whisper:\s*whisperReady/);
});

test('studio exposes only Faster-Whisper and routes model setup to Large V3 Turbo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const library = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'library-module.js'), 'utf8');

  assert.match(html, /Faster-Whisper Large V3 Turbo \(1,51 GB\)/);
  assert.doesNotMatch(html, /Whisper ONNX|Medium Q8|value="whisper-onnx"/);
  assert.doesNotMatch(html, /DirectML GPU|value="dml"/);
  assert.match(html, /id="whisper-gpu-install-btn"/);
  assert.match(html, /id="whisper-runtime-row" class="rapidocr-mini-card"/);
  assert.match(html, /id="whisper-runtime-install-btn" class="mini-pill-btn"/);
  assert.match(html, /id="whisper-gpu-row" class="rapidocr-mini-row rapidocr-gpu-divider"/);
  assert.doesNotMatch(
    html,
    /class="form-group whisper-engine-settings" style="display:\s*none\s*!important;">\s*<label for="whisper-device-select"/,
    'Whisper GPU controls must be visible when the Whisper engine is selected'
  );
  assert.match(app, /body: JSON\.stringify\(\{ model: 'large-v3-turbo' \}\)/);
  assert.doesNotMatch(app, /whisper-model\/status\?variant=/);
  assert.match(app, /await window\.ensureFasterWhisperReady\(\{ openModal: true \}\)/);
  assert.match(library, /FASTER_WHISPER_MODEL_ID = 'large-v3-turbo'/);
  assert.match(library, /window\.ensureFasterWhisperReady = ensureFasterWhisperReady/);
  assert.match(library, /\/api\/whisper-gpu\/status/);
  assert.match(library, /\/api\/whisper-gpu\/install/);
});
