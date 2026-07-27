const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('server exposes segment editor APIs without accepting client file paths', () => {
  const server = read('server.js');
  const controller = read('controllers/segmentController.js');

  assert.match(server, /app\.get\('\/api\/render-tasks\/:taskId\/segments'/);
  assert.match(server, /app\.put\('\/api\/render-tasks\/:taskId\/segments'/);
  assert.match(server, /segments\/approve'/);
  assert.match(server, /segments\/:segmentId\/regenerate'/);
  assert.match(server, /segments\/:segmentId\/audio'/);
  assert.match(controller, /requireTask\(req\)/);
  assert.match(controller, /segmentService\.getAudioPath/);
  assert.doesNotMatch(controller, /req\.body\.(?:filePath|audioPath|workDir)/);
});

test('render pauses for segment review and uses reviewed SRT after approval', () => {
  const studio = read('controllers/studioController.js');

  assert.match(studio, /SEGMENT_REVIEW_REQUIRED/);
  assert.match(studio, /actionRequired = 'segment_review'/);
  assert.match(studio, /segmentService\.createOrLoad/);
  assert.match(studio, /subtitlePath = segmentManifest\.reviewedSrtPath/);
  assert.match(studio, /segmentService\.setSegmentAudio/);
  assert.match(studio, /voiceCheckpoint\.hasChunk\(checkpointKey, chunkSignature\)/);
});

test('segment review UI is isolated in its own script and wired into queue states', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const editor = read('public/js/segment-editor.js');

  assert.match(html, /name="segmentReviewEnabled"/);
  assert.match(html, /id="segment-editor-modal"/);
  assert.match(html, /id="segment-editor-generate-missing"/);
  assert.match(html, /src="js\/segment-editor\.js"/);
  assert.match(app, /actionRequired === 'segment_review'/);
  assert.match(app, /openSegmentEditor/);
  assert.match(editor, /SEGMENT_REVISION_CONFLICT/);
  assert.match(editor, /approveAndContinue/);
  assert.match(editor, /PAGE_SIZE = 100/);
  assert.match(editor, /error\.manifest = data\.manifest/);
  assert.match(editor, /state\.regenerating\.size > 0/);
  assert.match(editor, /Hãy chờ câu đang tạo giọng hoàn tất/);
  assert.match(editor, /async function regenerateMissing/);
  assert.match(editor, /for \(const segmentId of targets\)/);
  assert.match(editor, /state\.batchGenerating = true/);
  assert.match(editor, /Dừng sau câu hiện tại/);
  assert.match(editor, /if \(state\.stopBatchRequested\) break/);
  assert.match(editor, /window\.openSegmentEditor = open/);
});

test('voice engine lock covers render, cloner, and segment preview paths', () => {
  const studio = read('controllers/studioController.js');
  const voice = read('controllers/voiceController.js');
  const segment = read('controllers/segmentController.js');
  const shared = read('lib/shared-state.js');

  assert.match(shared, /function acquireVoiceEngine/);
  assert.match(shared, /function releaseVoiceEngine/);
  assert.match(studio, /shared\.acquireVoiceEngine/);
  assert.match(voice, /shared\.acquireVoiceEngine/);
  assert.match(segment, /shared\.acquireVoiceEngine/);
  assert.match(segment, /skipRenderCheck: true/);
  assert.match(segment, /error\.manifest = toPublicManifest\(manifest\)/);
});
