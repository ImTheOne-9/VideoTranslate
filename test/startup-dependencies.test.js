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

test('aggregate dependency status preserves CUDA and checks Whisper model files', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'systemController.js'),
    'utf8'
  );

  assert.match(source, /cuda:\s*runtimeDependencies\.cuda/);
  assert.match(source, /q8:\s*getWhisperOnnxReadiness\('q8'\)\.exists/);
  assert.match(source, /whisper:\s*whisperModelOk/);
});
