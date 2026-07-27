const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RenderJobStore, sanitizeBody } = require('../lib/render-job-store');

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-job-store-'));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createTask(id, body = {}) {
  return {
    id,
    projectName: 'Checkpoint test',
    status: 'rendering',
    percent: 35,
    step: 'Đang dịch',
    createdAt: new Date('2026-07-24T00:00:00Z'),
    body,
    files: {},
    stages: {
      subtitle: {
        status: 'success',
        output: { subtitlePath: 'C:\\data\\subtitle.srt' }
      }
    }
  };
}

test('render manifest persists resumable state without API keys', () => {
  withTempDir((directory) => {
    const store = new RenderJobStore(directory);
    const task = createTask('task_secure', {
      aiProvider: 'gemini',
      geminiApiKey: 'secret-gemini',
      openRouterApiKey: 'secret-openrouter',
      ninerouterApiKey: 'secret-nine',
      geminiModel: 'gemini-test'
    });
    task.uiSnapshot = {
      subtitleMode: 'generate',
      savedVoiceFile: 'voice.wav',
      blurBoxes: [{ id: 'blur-1', x: 0.1, y: 0.7, width: 0.8, height: 0.2 }],
      geminiApiKey: 'snapshot-secret'
    };
    task.voiceExecution = {
      engineId: 'current-omnivoice',
      requestedDevice: 'vulkan:0',
      usedDevice: 'cpu',
      fallback: true
    };

    store.saveTask(task);

    const raw = fs.readFileSync(store.getManifestPath(task.id), 'utf8');
    const restored = store.loadTask(task.id);
    assert.doesNotMatch(raw, /secret-gemini|secret-openrouter|secret-nine|snapshot-secret/);
    assert.equal(restored.body.aiProvider, 'gemini');
    assert.equal(restored.body.geminiModel, 'gemini-test');
    assert.equal(restored.body.geminiApiKey, undefined);
    assert.equal(restored.uiSnapshot.savedVoiceFile, 'voice.wav');
    assert.equal(restored.uiSnapshot._subMode, 'generate');
    assert.equal(restored.uiSnapshot.blurBoxes.length, 1);
    assert.equal(restored.stages.subtitle.status, 'success');
    assert.deepEqual(restored.voiceExecution, task.voiceExecution);
  });
});

test('unfinished jobs are restored as waiting for explicit resume', () => {
  withTempDir((directory) => {
    const store = new RenderJobStore(directory);
    const interrupted = createTask('task_resume');
    interrupted.status = 'error';
    interrupted.error = 'Lỗi tách âm thanh: ffmpeg version 8.1 full diagnostic output';
    store.saveTask(interrupted);
    const completed = createTask('task_done');
    completed.status = 'success';
    store.saveTask(completed);

    const restored = store.loadUnfinishedTasks();

    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, 'task_resume');
    assert.equal(restored[0].status, 'waiting_input');
    assert.equal(restored[0].actionRequired, 'render_resume');
    assert.equal(restored[0].error, null);
    assert.match(restored[0].step, /checkpoint|khôi phục/i);
  });
});

test('segment review waiting state and summary survive application restart', () => {
  withTempDir((rootDir) => {
    const store = new RenderJobStore(rootDir);
    const task = createTask('task_segment_review');
    task.status = 'waiting_input';
    task.actionRequired = 'segment_review';
    task.step = 'Cần duyệt lời thoại';
    task.segmentReview = {
      status: 'pending',
      revision: 4,
      total: 12,
      approved: 5,
      warnings: 2
    };
    store.saveTask(task);

    const restored = store.loadUnfinishedTasks();

    assert.equal(restored.length, 1);
    assert.equal(restored[0].status, 'waiting_input');
    assert.equal(restored[0].actionRequired, 'segment_review');
    assert.deepEqual(restored[0].segmentReview, task.segmentReview);
  });
});

test('OCR fallback choice is preserved across application restarts', () => {
  withTempDir((directory) => {
    const store = new RenderJobStore(directory);
    const task = createTask('task_ocr_fallback');
    task.status = 'waiting_input';
    task.actionRequired = 'ocr_fallback';
    task.error = 'OCR runtime failed';
    store.saveTask(task);

    const [restored] = store.loadUnfinishedTasks();

    assert.equal(restored.status, 'waiting_input');
    assert.equal(restored.actionRequired, 'ocr_fallback');
    assert.equal(restored.error, 'OCR runtime failed');
  });
});

test('sanitizeBody preserves render settings and removes only credentials', () => {
  assert.deepEqual(sanitizeBody({
    subtitleMode: 'generate',
    geminiApiKey: 'x',
    openRouterApiKey: 'y',
    ninerouterApiKey: 'z'
  }), {
    subtitleMode: 'generate'
  });
});
