const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const studioController = require('../controllers/studioController');
const { withTempDir } = require('./helpers/temp-dir');

const {
  appendFilterComplexArgs,
  applyRenderTaskFailure,
  applyRenderTaskSuccess,
  cleanupLegacyCheckpointFiles,
  cleanupRenderWorkDir,
  createAutomaticSubtitleProgressHandler,
  createAutomaticSubtitleResolver,
  createRenderQueueHandlers,
  createRenderQueueTask,
  createRenderSourceResolver,
  createVoiceChunkCheckpoint,
  findNextPendingRenderTask,
  mergeRenderBlurBoxes,
  readSubtitleTimingCues
} = studioController;

function requireFunction(value, name) {
  assert.equal(typeof value, 'function', `${name} must be a production function`);
}

function createResponse() {
  return {
    statusCode: 200,
    jsonCalls: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonCalls.push(payload);
      return this;
    }
  };
}

function createQueueState(tasks = []) {
  return {
    renderQueue: tasks,
    currentActiveTask: null,
    isStudioRendering: false,
    activeRenderId: null,
    studioProgress: { status: 'idle', percent: 0, step: '', error: null }
  };
}

test('manual watermark blur and automatic OCR subtitle boxes are rendered together', () => {
  const manual = [{ id: 'watermark', start: 0, end: 99999 }];
  const automatic = [
    { source: 'viral_ocr', start: 0, end: 1.5 },
    { source: 'viral_ocr', start: 2, end: 3.5 }
  ];

  assert.deepEqual(
    mergeRenderBlurBoxes(manual, automatic, true),
    [...manual, ...automatic]
  );
  assert.deepEqual(mergeRenderBlurBoxes(manual, automatic, false), manual);
});

test('render never auto-masks OCR boxes and keeps manual masks as blur', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'studioController.js'), 'utf8');
  assert.match(source, /const useAutomaticOcrBlur = false;/);
  assert.doesNotMatch(source, /body\.ocrAutoBlur/);
  assert.match(source, /maskStyle: 'blur'/);
});

test('manual render blur regions are not passed to OCR as excluded regions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'studioController.js'), 'utf8');
  assert.doesNotMatch(source, /ocrExcludedRegions:\s*parseOcrExcludedRegions\(body\.blurBoxes\)/);
});

test('each manual blur region keeps its blur-strength slider visible', () => {
  const canvas = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'canvas-module.js'), 'utf8');
  assert.match(canvas, /Độ mờ \(Blur\)<\/label>/);
  assert.doesNotMatch(canvas, /ocr-mask-style'\)\?\.value === 'blur'/);
});

test('OCR blur reads source SRT timing for cue end alignment', async () => {
  await withTempDir('studio-blur-timing-', async (directory) => {
    const srtPath = path.join(directory, 'source.srt');
    fs.writeFileSync(srtPath, [
      '1',
      '00:00:01,000 --> 00:00:02,500',
      '第一句',
      '',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      '第二句',
      ''
    ].join('\n'), 'utf8');

    assert.deepEqual(readSubtitleTimingCues(srtPath), [
      { startMs: 1000, endMs: 2500 },
      { startMs: 3000, endMs: 4000 }
    ]);
  });
});

test('large FFmpeg filter graphs use a script file to avoid the Windows command limit', async () => {
  await withTempDir('studio-filter-script-', async (directory) => {
    const args = [];
    const segments = ['[0:v]null[v0]', '[v0]null[vout]'];
    const result = appendFilterComplexArgs(args, segments, directory, 1);

    assert.equal(result.mode, 'script');
    assert.deepEqual(args, ['-/filter_complex', result.scriptPath]);
    assert.equal(fs.readFileSync(result.scriptPath, 'utf8'), segments.join(';'));
  });
});

function createQueueHandlers(state, overrides = {}) {
  requireFunction(createRenderQueueHandlers, 'createRenderQueueHandlers');
  return createRenderQueueHandlers({
    state,
    existsSync: () => true,
    rmSync: () => {},
    killActiveRenderProcesses: () => {},
    processNextRenderTask: () => Promise.resolve(),
    schedule: () => {},
    logger: { log() {}, error() {} },
    ...overrides
  });
}

test('source resolver prefers a valid persisted path without moving the upload again', () => {
  requireFunction(createRenderSourceResolver, 'createRenderSourceResolver');
  const persistedPath = path.join('D:', 'downloads', 'persisted.mp4');
  let moveCalls = 0;
  let libraryCalls = 0;
  const resolveSource = createRenderSourceResolver({
    existsSync: (candidate) => candidate === persistedPath,
    moveUploadedFile: () => {
      moveCalls += 1;
      return path.join('D:', 'downloads', 'moved.mp4');
    },
    downloadsDir: path.join('D:', 'downloads'),
    resolveAssetPath: () => {
      libraryCalls += 1;
      return path.join('D:', 'downloads', 'library.mp4');
    }
  });
  const task = {
    sourceVideoPath: persistedPath,
    body: { mainVideoFile: 'library.mp4' },
    files: { videoUpload: [{ path: 'already-moved.tmp', originalname: 'upload.mp4' }] }
  };

  assert.equal(resolveSource(task), persistedPath);
  assert.equal(moveCalls, 0);
  assert.equal(libraryCalls, 0);
});

test('first upload resolution persists the moved source path on the task', () => {
  requireFunction(createRenderSourceResolver, 'createRenderSourceResolver');
  const movedPath = path.join('D:', 'downloads', 'upload.mp4');
  const upload = { path: 'staged-upload.tmp', originalname: 'upload.mp4' };
  const moveCalls = [];
  const resolveSource = createRenderSourceResolver({
    existsSync: () => false,
    moveUploadedFile: (...args) => {
      moveCalls.push(args);
      return movedPath;
    },
    downloadsDir: path.join('D:', 'downloads'),
    resolveAssetPath: () => null
  });
  const task = { sourceVideoPath: null, body: {}, files: { videoUpload: [upload] } };

  assert.equal(resolveSource(task), movedPath);
  assert.equal(task.sourceVideoPath, movedPath);
  assert.deepEqual(moveCalls, [[upload, path.join('D:', 'downloads'), 'upload.mp4']]);
});

test('a missing persisted source fails before upload reuse or coordinator startup', async () => {
  requireFunction(createRenderSourceResolver, 'createRenderSourceResolver');
  requireFunction(createAutomaticSubtitleResolver, 'createAutomaticSubtitleResolver');
  let moveCalls = 0;
  let coordinatorCalls = 0;
  const resolveSource = createRenderSourceResolver({
    existsSync: () => false,
    moveUploadedFile: () => {
      moveCalls += 1;
      return 'unexpected.mp4';
    },
    downloadsDir: 'downloads',
    resolveAssetPath: () => 'unexpected-library.mp4'
  });
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async () => {
      coordinatorCalls += 1;
      return { path: 'unexpected.srt' };
    },
    updateStudioProgress: () => {}
  });
  const task = {
    sourceVideoPath: 'downloads/missing.mp4',
    body: { subtitleMode: 'generate', mainVideoFile: 'fallback.mp4' },
    files: { videoUpload: [{ path: 'stale-upload.tmp', originalname: 'upload.mp4' }] }
  };

  await assert.rejects(async () => {
    const sourceVideo = resolveSource(task);
    await resolveSubtitle({
      body: task.body,
      sourceVideo,
      workDir: 'work',
      totalDuration: 10,
      isVoiceOnlySub: false,
      ffmpegPath: 'ffmpeg.exe'
    });
  }, /video nguồn đã lưu không còn tồn tại/i);
  assert.equal(moveCalls, 0);
  assert.equal(coordinatorCalls, 0);
});

test('generate resolver wires coordinator options and returns result.path downstream', async () => {
  requireFunction(createAutomaticSubtitleResolver, 'createAutomaticSubtitleResolver');
  let receivedOptions;
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async (options) => {
      receivedOptions = options;
      return { path: 'work/ocr-clean.srt', source: 'ocr' };
    },
    updateStudioProgress: () => {}
  });
  const body = {
    whisperModel: 'small',
    whisperOnnxVariant: 'fp32',
    whisperTimestampLevel: 'segment',
    ocrLanguage: 'zh',
    ocrMode: 'accurate',
    ocrRegion: '0.6,0.95,0.1,0.9',
    blurBoxes: JSON.stringify([{ x: 5, y: 8, width: 20, height: 10, start: 2, end: 7 }])
  };

  const subtitlePath = await resolveSubtitle({
    body,
    sourceVideo: 'downloads/source.mp4',
    workDir: 'uploads/render-1',
    totalDuration: 12.5,
    isVoiceOnlySub: false,
    ffmpegPath: 'tools/ffmpeg.exe'
  });

  assert.equal(subtitlePath, 'work/ocr-clean.srt');
  assert.equal(Object.hasOwn(receivedOptions, 'ocrExcludedRegions'), false);
  assert.deepEqual(
    { ...receivedOptions, onProgress: typeof receivedOptions.onProgress },
    {
      videoPath: 'downloads/source.mp4',
      workDir: 'uploads/render-1',
      ffmpegPath: 'tools/ffmpeg.exe',
      durationMs: 12500,
      whisperModel: 'small',
      whisperOnnxVariant: 'fp32',
      whisperTimestampLevel: 'segment',
      whisperDevice: 'cpu',
      ocrLanguage: 'zh',
      ocrMode: 'accurate',
      ocrRegion: '0.6,0.95,0.1,0.9',
      ocrRegionStrategy: 'auto',
      ocrPipeline: 'auto',
      forceWhisper: false,
      ocrOnly: false,
      onProgress: 'function'
    }
  );
});

test('generate resolver preserves an explicitly selected OCR pipeline', async () => {
  let receivedOptions;
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async (options) => {
      receivedOptions = options;
      return { path: 'work/subtitles.srt' };
    },
    updateStudioProgress: () => {}
  });

  await resolveSubtitle({
    body: { ocrLanguage: 'ch', ocrPipeline: 'vse' },
    sourceVideo: 'source.mp4', workDir: 'work', totalDuration: 3, ffmpegPath: 'ffmpeg.exe'
  });

  assert.equal(receivedOptions.ocrPipeline, 'vse');
});

test('Omi voice-only subtitle generation still tries OCR first', async () => {
  requireFunction(createAutomaticSubtitleResolver, 'createAutomaticSubtitleResolver');
  let receivedOptions;
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async (options) => {
      receivedOptions = options;
      return { path: 'voice-only.srt' };
    },
    updateStudioProgress: () => {}
  });

  await resolveSubtitle({
    body: { whisperModel: 'base' },
    sourceVideo: 'source.mp4',
    workDir: 'work',
    totalDuration: 3,
    isVoiceOnlySub: true,
    ffmpegPath: 'ffmpeg.exe'
  });

  assert.equal(receivedOptions.forceWhisper, false);
  assert.equal(receivedOptions.ocrOnly, false);
});

test('user-selected Whisper bypasses OCR while user-selected OCR disables fallback', async () => {
  const received = [];
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async (options) => {
      received.push(options);
      return { path: 'selected.srt' };
    },
    updateStudioProgress: () => {}
  });

  for (const subtitleEngine of ['whisper', 'ocr']) {
    await resolveSubtitle({
      body: { subtitleEngine, whisperOnnxVariant: 'fp32' },
      sourceVideo: 'source.mp4',
      workDir: 'work',
      totalDuration: 3,
      ffmpegPath: 'ffmpeg.exe'
    });
  }

  assert.deepEqual(
    received.map(({ forceWhisper, ocrOnly }) => ({ forceWhisper, ocrOnly })),
    [
      { forceWhisper: true, ocrOnly: false },
      { forceWhisper: false, ocrOnly: true }
    ]
  );
  assert.deepEqual(received.map(({ whisperOnnxVariant }) => whisperOnnxVariant), ['fp32', 'fp32']);
});

test('invalid or missing ONNX variants fall back to Q8', async () => {
  const received = [];
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async (options) => {
      received.push(options.whisperOnnxVariant);
      return { path: 'selected.srt' };
    },
    updateStudioProgress: () => {}
  });

  for (const whisperOnnxVariant of [undefined, 'unknown']) {
    await resolveSubtitle({
      body: { subtitleEngine: 'whisper', whisperOnnxVariant },
      sourceVideo: 'source.mp4',
      workDir: 'work',
      totalDuration: 3,
      ffmpegPath: 'ffmpeg.exe'
    });
  }

  assert.deepEqual(received, ['q8', 'q8']);
});

test('Medium Q8 is preserved when resolving automatic subtitles', async () => {
  let receivedVariant;
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async (options) => {
      receivedVariant = options.whisperOnnxVariant;
      return { path: 'selected.srt' };
    },
    updateStudioProgress: () => {}
  });

  await resolveSubtitle({
    body: { subtitleEngine: 'whisper', whisperOnnxVariant: 'medium-q8' },
    sourceVideo: 'source.mp4',
    workDir: 'work',
    totalDuration: 3,
    ffmpegPath: 'ffmpeg.exe'
  });

  assert.equal(receivedVariant, 'medium-q8');
});

test('only the trusted task resume flag forces Whisper through coordinator options', async () => {
  requireFunction(createAutomaticSubtitleResolver, 'createAutomaticSubtitleResolver');
  const receivedFlags = [];
  const resolveSubtitle = createAutomaticSubtitleResolver({
    resolveAutomaticSubtitle: async (options) => {
      receivedFlags.push(options.forceWhisper);
      return { path: 'forced.srt' };
    },
    updateStudioProgress: () => {}
  });

  await resolveSubtitle({
    body: { forceWhisper: true },
    sourceVideo: 'source.mp4',
    workDir: 'work',
    totalDuration: 3,
    isVoiceOnlySub: false,
    ffmpegPath: 'ffmpeg.exe'
  });
  await resolveSubtitle({
    body: {},
    sourceVideo: 'source.mp4',
    workDir: 'work',
    totalDuration: 3,
    isVoiceOnlySub: false,
    forceWhisper: true,
    ffmpegPath: 'ffmpeg.exe'
  });

  assert.deepEqual(receivedFlags, [false, true]);
});

test('coordinator progress stays below translation and callback failures are observational', () => {
  requireFunction(createAutomaticSubtitleProgressHandler, 'createAutomaticSubtitleProgressHandler');
  const updates = [];
  const onProgress = createAutomaticSubtitleProgressHandler((percent, step) => {
    updates.push({ percent, step });
  });

  onProgress({ phase: 'ocr_starting' });
  onProgress({ phase: 'ocr_processing', detail: { pct: 100 } });
  onProgress({ phase: 'ocr_retry_cpu' });
  onProgress({ phase: 'ocr_validating' });
  onProgress({ phase: 'whisper_fallback' });

  assert.equal(updates.length, 5);
  assert.equal(updates.every(({ percent }) => percent >= 12 && percent < 35), true);
  assert.equal(updates[1].percent, 34);
  assert.equal(updates.every(({ step }) => typeof step === 'string' && step.length > 0), true);

  const throwingProgress = createAutomaticSubtitleProgressHandler(() => {
    throw new Error('UI disconnected');
  });
  assert.doesNotThrow(() => throwingProgress({ phase: 'ocr_starting' }));
});

test('coordinator writes the real RapidOCR provider to the render log', () => {
  const lines = [];
  const onProgress = createAutomaticSubtitleProgressHandler(() => {}, {
    log: (line) => lines.push(line)
  });
  onProgress({
    phase: 'ocr_processing',
    detail: {
      kind: 'provider', model: 'v6-small', requestedDevice: 'gpu',
      provider: 'CUDAExecutionProvider'
    }
  });
  assert.deepEqual(lines, [
    '[RapidOCR] model=v6-small requestedDevice=gpu actualProvider=CUDAExecutionProvider'
  ]);
});

test('OCR technical errors enter the exact waiting state instead of generic error', () => {
  requireFunction(applyRenderTaskFailure, 'applyRenderTaskFailure');
  const error = Object.assign(new Error('VSE exited with code 1'), { code: 'OCR_TECHNICAL_ERROR' });
  const task = { id: 'task-ocr', status: 'rendering', percent: 7, step: 'OCR', error: null };
  const state = createQueueState([task]);
  state.currentActiveTask = task;
  state.isStudioRendering = true;
  state.activeRenderId = task.id;

  assert.equal(applyRenderTaskFailure(task, error, state), 'waiting_input');
  assert.equal(task.status, 'waiting_input');
  assert.equal(task.step, 'OCR gặp lỗi kỹ thuật');
  assert.equal(task.error, error.message);
  assert.equal(task.actionRequired, 'ocr_fallback');
  assert.equal(task.percent, 12);
  assert.equal(state.isStudioRendering, false);
  assert.equal(state.activeRenderId, null);
  assert.equal(state.currentActiveTask, null);
  assert.deepEqual(state.studioProgress, {
    status: 'waiting_input',
    percent: 12,
    step: 'OCR gặp lỗi kỹ thuật',
    error: error.message
  });
});

test('a cancelled OCR process remains cancellation because cancellation is classified first', () => {
  requireFunction(applyRenderTaskFailure, 'applyRenderTaskFailure');
  const error = Object.assign(new Error('OCR đã bị hủy'), { code: 'OCR_TECHNICAL_ERROR' });
  const task = {
    id: 'task-cancelled',
    status: 'failed',
    percent: 18,
    step: 'Đã bị người dùng hủy',
    error: 'Đã hủy',
    actionRequired: 'ocr_fallback'
  };
  const state = createQueueState([task]);

  assert.equal(applyRenderTaskFailure(task, error, state), 'cancelled');
  assert.equal(task.status, 'failed');
  assert.equal(task.step, 'Đã bị hủy');
  assert.equal(task.actionRequired, null);
  assert.equal(state.studioProgress.status, 'idle');
});

test('generic success and error transitions clear stale actionRequired', () => {
  requireFunction(applyRenderTaskSuccess, 'applyRenderTaskSuccess');
  requireFunction(applyRenderTaskFailure, 'applyRenderTaskFailure');
  const successfulTask = { status: 'rendering', actionRequired: 'ocr_fallback' };
  const successState = createQueueState([successfulTask]);

  applyRenderTaskSuccess(successfulTask, { file: 'render.mp4' }, successState);
  assert.equal(successfulTask.status, 'success');
  assert.equal(successfulTask.actionRequired, null);

  const failedTask = { status: 'rendering', percent: 20, actionRequired: 'ocr_fallback' };
  const failureState = createQueueState([failedTask]);
  assert.equal(applyRenderTaskFailure(failedTask, new Error('render failed'), failureState), 'error');
  assert.equal(failedTask.status, 'error');
  assert.equal(failedTask.actionRequired, null);
});

test('waiting tasks are skipped while the next pending task remains eligible', () => {
  requireFunction(findNextPendingRenderTask, 'findNextPendingRenderTask');
  const waitingTask = { id: 'waiting', status: 'waiting_input' };
  const pendingTask = { id: 'pending', status: 'pending' };

  assert.strictEqual(findNextPendingRenderTask([waitingTask, pendingTask]), pendingTask);
});

test('resume handler validates missing id, unknown task, and wrong state or action', async () => {
  const task = {
    id: 'wrong-state',
    status: 'pending',
    actionRequired: null,
    sourceVideoPath: 'source.mp4',
    body: {}
  };
  const handlers = createQueueHandlers(createQueueState([task]));

  const missingResponse = createResponse();
  await handlers.useWhisperForRenderTask({ body: {} }, missingResponse);
  assert.equal(missingResponse.statusCode, 400);

  const unknownResponse = createResponse();
  await handlers.useWhisperForRenderTask({ body: { taskId: 'unknown' } }, unknownResponse);
  assert.equal(unknownResponse.statusCode, 404);

  const conflictResponse = createResponse();
  await handlers.useWhisperForRenderTask({ body: { taskId: task.id } }, conflictResponse);
  assert.equal(conflictResponse.statusCode, 409);
});

test('resume keeps a waiting task waiting when its persisted source is missing', async () => {
  const task = {
    id: 'missing-source',
    status: 'waiting_input',
    actionRequired: 'ocr_fallback',
    sourceVideoPath: 'downloads/gone.mp4',
    error: 'OCR failed',
    body: {}
  };
  let processCalls = 0;
  const handlers = createQueueHandlers(createQueueState([task]), {
    existsSync: () => false,
    processNextRenderTask: () => {
      processCalls += 1;
    }
  });
  const response = createResponse();

  await handlers.useWhisperForRenderTask({ body: { taskId: task.id } }, response);

  assert.equal(response.statusCode, 409);
  assert.equal(task.status, 'waiting_input');
  assert.equal(task.actionRequired, 'ocr_fallback');
  assert.match(task.error, /video nguồn.*không còn tồn tại/i);
  assert.equal(processCalls, 0);
});

test('valid resume prepares the task and triggers queue processing exactly once', async () => {
  const task = {
    id: 'resume-me',
    status: 'waiting_input',
    actionRequired: 'ocr_fallback',
    sourceVideoPath: 'downloads/source.mp4',
    error: 'OCR failed',
    step: 'OCR gặp lỗi kỹ thuật',
    body: { whisperModel: 'small' }
  };
  const state = createQueueState([task]);
  let processCalls = 0;
  let stateAtProcessCall;
  const handlers = createQueueHandlers(state, {
    existsSync: (candidate) => candidate === task.sourceVideoPath,
    processNextRenderTask: () => {
      processCalls += 1;
      stateAtProcessCall = { status: task.status, responsePrepared: response.jsonCalls.length };
      return Promise.resolve();
    }
  });
  const response = createResponse();

  await handlers.useWhisperForRenderTask({ body: { taskId: task.id } }, response);

  assert.deepEqual(response.jsonCalls, [{ success: true, taskId: task.id }]);
  assert.equal(task.forceWhisper, true);
  assert.equal(task.body.forceWhisper, undefined);
  assert.equal(task.status, 'pending');
  assert.equal(task.error, null);
  assert.equal(task.actionRequired, null);
  assert.equal(task.step, 'Đang chuyển sang Whisper...');
  assert.equal(processCalls, 1);
  assert.deepEqual(stateAtProcessCall, { status: 'pending', responsePrepared: 1 });
  assert.equal(state.renderQueue.length, 1);
});

test('checkpoint resume merges current AI credentials and keeps completed stages', async () => {
  const task = {
    id: 'checkpoint-resume',
    status: 'waiting_input',
    actionRequired: 'render_resume',
    error: 'App was closed',
    step: 'Tác vụ đã được khôi phục',
    body: { aiProvider: 'gemini', translateVi: 'true' },
    stages: {
      subtitle: { status: 'success', output: { subtitlePath: 'saved.srt' } },
      translation: { status: 'error', error: 'App was closed' }
    }
  };
  const state = createQueueState([task]);
  const saved = [];
  let processCalls = 0;
  const handlers = createQueueHandlers(state, {
    jobStore: {
      saveTask(candidate) {
        saved.push(candidate.status);
      },
      removeTask() {}
    },
    processNextRenderTask: () => {
      processCalls += 1;
      return Promise.resolve();
    }
  });
  const response = createResponse();

  await handlers.resumeRenderTask({
    body: {
      taskId: task.id,
      settings: {
        geminiApiKey: 'fresh-key',
        geminiModel: 'gemini-current'
      }
    }
  }, response);

  assert.equal(task.status, 'pending');
  assert.equal(task.actionRequired, null);
  assert.equal(task.body.geminiApiKey, 'fresh-key');
  assert.equal(task.body.geminiModel, 'gemini-current');
  assert.equal(task.stages.subtitle.status, 'success');
  assert.equal(processCalls, 1);
  assert.deepEqual(saved, ['pending']);
  assert.deepEqual(response.jsonCalls[0].completedStages, ['subtitle']);
});

test('queue response exposes actionRequired and waiting task errors', async () => {
  const waitingTask = {
    id: 'waiting',
    projectId: null,
    projectName: 'OCR project',
    status: 'waiting_input',
    percent: 12,
    step: 'OCR gặp lỗi kỹ thuật',
    error: 'VSE failed',
    actionRequired: 'ocr_fallback',
    createdAt: new Date('2026-07-17T00:00:00Z'),
    body: { mainVideoFile: 'source.mp4' },
    files: {},
    result: null,
    backgroundSeparation: {
      requestedProvider: 'auto',
      usedProvider: 'cpu',
      fallback: true
    }
  };
  const handlers = createQueueHandlers(createQueueState([waitingTask]));
  const response = createResponse();

  await handlers.getQueueStatus({}, response);

  assert.equal(response.jsonCalls[0].queue[0].actionRequired, 'ocr_fallback');
  assert.equal(response.jsonCalls[0].queue[0].error, 'VSE failed');
  assert.deepEqual(
    response.jsonCalls[0].queue[0].backgroundSeparation,
    waitingTask.backgroundSeparation
  );
});

test('cancelling a waiting task removes only its upload directory and does not kill processes', async () => {
  await withTempDir('studio-ocr-cancel-', async (directory) => {
    const taskDir = path.join(directory, 'task-upload');
    const sourceVideoPath = path.join(directory, 'library-source.mp4');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'staged.txt'), 'staged');
    fs.writeFileSync(sourceVideoPath, 'video');
    const task = {
      id: 'waiting-cancel',
      status: 'waiting_input',
      actionRequired: 'ocr_fallback',
      taskDir,
      sourceVideoPath,
      body: {},
      files: {}
    };
    const state = createQueueState([task]);
    let killCalls = 0;
    const handlers = createQueueHandlers(state, {
      existsSync: fs.existsSync,
      rmSync: fs.rmSync,
      killActiveRenderProcesses: () => {
        killCalls += 1;
      }
    });
    const response = createResponse();

    await handlers.cancelQueueTask({ body: { taskId: task.id } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(killCalls, 0);
    assert.equal(state.renderQueue.length, 0);
    assert.equal(fs.existsSync(taskDir), false);
    assert.equal(fs.existsSync(sourceVideoPath), true);
  });
});

test('new render queue tasks start with resumable OCR fields', () => {
  requireFunction(createRenderQueueTask, 'createRenderQueueTask');
  const task = createRenderQueueTask({
    taskId: 'task-new',
    body: {
      projectName: 'Example',
      subtitleMode: 'generate',
      voiceMode: 'omi',
      uiSnapshot: JSON.stringify({
        subtitleMode: 'generate',
        savedVoiceFile: 'selected.wav',
        reactionMode: 'library',
        savedReactionFile: 'reaction.mp4',
        blurBoxes: [{ id: 'blur-1' }]
      })
    },
    files: {},
    taskDir: 'uploads/task-new',
    createdAt: new Date('2026-07-17T00:00:00Z')
  });

  assert.equal(task.actionRequired, null);
  assert.equal(task.sourceVideoPath, null);
  assert.equal(task.forceWhisper, false);
  assert.deepEqual(task.stages, {});
  assert.equal(task.currentStage, null);
  assert.equal(task.body.uiSnapshot, undefined);
  assert.equal(task.uiSnapshot.savedVoiceFile, 'selected.wav');
  assert.equal(task.uiSnapshot._reactionMode, 'library');
  assert.deepEqual(task.uiSnapshot.blurBoxes, [{ id: 'blur-1' }]);
});

test('voice chunk checkpoint reuses valid chunks and invalidates changed input', async () => {
  requireFunction(createVoiceChunkCheckpoint, 'createVoiceChunkCheckpoint');
  await withTempDir('studio-voice-checkpoint-', async (directory) => {
    const first = createVoiceChunkCheckpoint(directory, 'signature-a');
    const chunkPath = first.getChunkPath(0);
    const fittedPath = first.getFittedChunkPath(0);
    fs.writeFileSync(chunkPath, Buffer.alloc(64));
    fs.writeFileSync(fittedPath, Buffer.alloc(64));
    first.markChunk(0, { filePath: chunkPath, startMs: 0 });
    first.markFittedChunk(0, { filePath: fittedPath, signature: 'fit-a' });

    const restored = createVoiceChunkCheckpoint(directory, 'signature-a');
    assert.equal(restored.hasChunk(0), true);
    assert.equal(restored.hasFittedChunk(0, 'fit-a'), true);
    assert.equal(restored.hasFittedChunk(0, 'fit-b'), false);
    assert.equal(restored.getChunkPath(0), chunkPath);

    const invalidated = createVoiceChunkCheckpoint(directory, 'signature-b');
    assert.equal(invalidated.hasChunk(0), false);
    assert.equal(fs.existsSync(chunkPath), false);
    assert.equal(fs.existsSync(fittedPath), false);
  });
});

test('legacy timestamped checkpoint files are removed without touching stable outputs', async () => {
  requireFunction(cleanupLegacyCheckpointFiles, 'cleanupLegacyCheckpointFiles');
  await withTempDir('studio-legacy-checkpoints-', async (directory) => {
    const legacy = [
      'chunk_0_1784878427678.wav',
      'ref_voice_1784878427678.wav',
      'instrumental_1784878427678.wav'
    ];
    for (const name of legacy) fs.writeFileSync(path.join(directory, name), 'old');
    fs.writeFileSync(path.join(directory, 'instrumental.wav'), 'stable');
    fs.writeFileSync(path.join(directory, 'translated.srt'), 'subtitle');

    const removed = cleanupLegacyCheckpointFiles(directory);

    assert.equal(removed.length, legacy.length);
    for (const name of legacy) assert.equal(fs.existsSync(path.join(directory, name)), false);
    assert.equal(fs.existsSync(path.join(directory, 'instrumental.wav')), true);
    assert.equal(fs.existsSync(path.join(directory, 'translated.srt')), true);
  });
});

test('render attempt work directory cleanup has valid function scope and removes directories', async () => {
  requireFunction(cleanupRenderWorkDir, 'cleanupRenderWorkDir');
  await withTempDir('studio-ocr-work-', async (directory) => {
    const workDir = path.join(directory, 'render-attempt');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'ocr-raw.srt'), 'temporary');

    cleanupRenderWorkDir(workDir, { logger: { log() {}, error() {} } });

    assert.equal(fs.existsSync(workDir), false);
  });

  const source = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'studioController.js'), 'utf8');
  const executeStart = source.indexOf('async function executeRenderTask(task)');
  const executeEnd = source.indexOf('\nlet _processingNext', executeStart);
  const executeSource = source.slice(executeStart, executeEnd);
  const declaration = executeSource.indexOf('let workDir = null;');
  const tryBlock = executeSource.indexOf('\n  try {');
  const assignment = executeSource.indexOf('workDir = task.workDir || renderJobStore.getWorkDir(task.id)');
  const catchBlock = executeSource.indexOf('\n  } catch (error) {');
  const finallyBlock = executeSource.indexOf('\n  } finally {');
  const cleanupCall = executeSource.indexOf('cleanupRenderWorkDir(workDir', finallyBlock);

  assert.ok(declaration >= 0 && declaration < tryBlock, 'workDir is function-scoped before try');
  assert.ok(assignment > tryBlock, 'workDir is assigned inside the attempt');
  assert.ok(catchBlock > assignment && finallyBlock > catchBlock, 'waiting/error catch flows into finally');
  assert.ok(cleanupCall > finallyBlock, 'finally cleans completed or cancelled work directories');
  assert.match(executeSource.slice(finallyBlock), /task\.status === 'success' \|\| task\.status === 'failed'/);
  assert.doesNotMatch(executeSource, /const workDir\s*=/);
});

test('large render function persists source before work and delegates only generate mode to coordinator', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'studioController.js'), 'utf8');
  const executeStart = source.indexOf('async function executeRenderTask(task)');
  const executeEnd = source.indexOf('\nlet _processingNext', executeStart);
  const executeSource = source.slice(executeStart, executeEnd);
  const sourceResolution = executeSource.indexOf('resolveRenderSource(task)');
  const videoInspection = executeSource.indexOf('getVideoDimensions(sourceVideoPath)');
  const generateStart = executeSource.indexOf("} else if (subtitleMode === 'generate') {");
  const generateEnd = executeSource.indexOf('\n    }\n\n    let originalIsChinese', generateStart);
  const generateSource = executeSource.slice(generateStart, generateEnd);

  assert.ok(sourceResolution >= 0 && sourceResolution < videoInspection);
  assert.match(generateSource, /resolvedSubtitlePath\s*=\s*await resolveRenderAutomaticSubtitle\(\{/);
  assert.doesNotMatch(generateSource, /extractAudioAndTranscribe/);
});

test('server registers the exact resume route while preserving existing queue routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routes = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^app\.(?:get|post)\('\/api\/(?:render-queue-status|render-use-whisper|render-resume|cancel-queue-task|clear-queue|cancel-render)'/.test(line));

  assert.deepEqual(routes, [
    "app.get('/api/render-queue-status', studioController.getQueueStatus);",
    "app.post('/api/render-use-whisper', studioController.useWhisperForRenderTask);",
    "app.post('/api/render-resume', studioController.resumeRenderTask);",
    "app.post('/api/cancel-queue-task', studioController.cancelQueueTask);",
    "app.post('/api/clear-queue', studioController.clearQueue);",
    "app.post('/api/cancel-render', studioController.cancelRender);"
  ]);
});
