'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const shared = require('../lib/shared-state');
const voiceController = require('../controllers/voiceController');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('voice preview endpoint is registered in server and exposed in UI', () => {
  assert.match(serverSource, /app\.post\('\/api\/preview-engine-voice', voiceController\.previewEngineVoice\)/);
  assert.match(serverSource, /app\.use\('\/voice-previews', express\.static\(shared\.VOICE_PREVIEWS_DIR\)\)/);
  assert.match(htmlSource, /id="preview-piper-voice-btn"/);
  assert.match(htmlSource, /id="preview-edge-voice-btn"/);
  assert.match(appSource, /async function previewEngineVoice/);
});

test('previewEngineVoice serves cached preview audio when already generated', async () => {
  const previewDir = shared.VOICE_PREVIEWS_DIR;
  fs.mkdirSync(previewDir, { recursive: true });
  const voice = `testmockvoice_${process.pid}_${Date.now()}`;
  const previewFileName = `piper_${voice}_1.00x_e3b0c44298.wav`;
  const testFile = path.join(previewDir, previewFileName);
  fs.writeFileSync(testFile, Buffer.alloc(2048));

  try {
    const req = {
      body: {
        engine: 'piper',
        voice
      }
    };

    let responseData = null;
    let responseStatus = 200;
    const res = {
      status: (s) => { responseStatus = s; return res; },
      json: (data) => { responseData = data; return res; }
    };

    await voiceController.previewEngineVoice(req, res);

    assert.equal(responseStatus, 200);
    assert.ok(responseData);
    assert.equal(responseData.success, true);
    assert.equal(responseData.cached, true);
    assert.equal(responseData.audioUrl, `/voice-previews/${previewFileName}`);
  } finally {
    try { fs.unlinkSync(testFile); } catch (_) {}
  }
});
