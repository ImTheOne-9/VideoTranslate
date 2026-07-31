const fs = require('fs');
const path = require('path');

const shared = require('../lib/shared-state');
const { RenderJobStore } = require('../lib/render-job-store');
const {
  DEFAULT_VOICE_ENGINE_ID,
  voiceEngineRegistry
} = require('../lib/voice-engines/index');
const {
  DEFAULT_ASR_ENGINE_ID,
  asrEngineRegistry,
  resolveWhisperModelPath
} = require('../lib/asr-engines/index');
const {
  getFileIdentity,
  isUsableFile
} = require('../lib/checkpoint-utils');
const {
  createVoiceAudioSignature,
  resolveVoiceReference
} = require('../lib/voice-reference-helper');
const { createFittedVoiceChunk, readWavDurationMs } = require('../lib/voice-audio-fit');
const { analyzeWavFile } = require('../lib/audio-quality');
const { normalizeAudioMasteringConfig } = require('../lib/audio-mastering');
const {
  createSmartFitSignature,
  planSmartFit
} = require('../lib/smart-fit-service');
const {
  SegmentRevisionConflictError,
  SegmentService,
  SegmentServiceError
} = require('../lib/segment-service');

const segmentService = new SegmentService();
const renderJobStore = new RenderJobStore(shared.RENDER_JOBS_DIR);
const activeAsrRetries = new Map();
const cancelledAsrOwners = new Set();

function getTask(taskId) {
  return shared.state.renderQueue.find((task) => task.id === taskId)
    || renderJobStore.loadTask(taskId);
}

function requireTask(req) {
  const task = getTask(req.params.taskId);
  if (!task) {
    throw new SegmentServiceError('Không tìm thấy tác vụ render', 'RENDER_TASK_NOT_FOUND', 404);
  }
  if (!task.workDir) {
    throw new SegmentServiceError('Tác vụ chưa có thư mục làm việc', 'RENDER_WORKDIR_MISSING', 409);
  }
  return task;
}

function requireSourceVideo(task) {
  if (!task.sourceVideoPath || !fs.existsSync(task.sourceVideoPath)) {
    throw new SegmentServiceError(
      'Video nguồn không còn tồn tại. Không thể duyệt hoặc tiếp tục tác vụ này.',
      'RENDER_SOURCE_MISSING',
      409
    );
  }
}

function toPublicManifest(manifest) {
  return {
    version: manifest.version,
    taskId: manifest.taskId,
    revision: manifest.revision,
    reviewRequired: manifest.reviewRequired,
    reviewStatus: manifest.reviewStatus,
    durationMs: manifest.durationMs,
    smartFit: manifest.smartFit,
    asr: manifest.asr
      ? {
          version: manifest.asr.version,
          engineId: manifest.asr.engineId,
          variant: manifest.asr.variant,
          language: manifest.asr.language,
          languageMode: manifest.asr.languageMode,
          timestampLevel: manifest.asr.timestampLevel
        }
      : null,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    segments: manifest.segments
  };
}

function saveTaskSummary(task, manifest) {
  task.segmentReview = segmentService.summarize(manifest);
  if (shared.state.renderQueue.includes(task)) renderJobStore.saveTask(task);
}

function sendError(res, error) {
  const statusCode = error instanceof SegmentServiceError
    ? error.statusCode
    : error?.code === 'VOICE_ENGINE_BUSY'
      ? 409
      : 500;
  const body = {
    error: error.message || 'Không thể xử lý segment',
    code: error.code || 'SEGMENT_ERROR'
  };
  if (error instanceof SegmentRevisionConflictError || Number.isFinite(Number(error.currentRevision))) {
    body.currentRevision = error.currentRevision;
  }
  if (error.manifest) body.manifest = error.manifest;
  return res.status(statusCode).json(body);
}

async function getSegments(req, res) {
  try {
    const task = requireTask(req);
    requireSourceVideo(task);
    const manifest = segmentService.load(task.workDir);
    if (!manifest) {
      throw new SegmentServiceError(
        'Tác vụ chưa tạo dữ liệu segment',
        'SEGMENT_MANIFEST_MISSING',
        404
      );
    }
    return res.json({ manifest: toPublicManifest(manifest) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function updateSegments(req, res) {
  try {
    const task = requireTask(req);
    requireSourceVideo(task);
    const manifest = segmentService.updateSegments(
      task.workDir,
      req.body?.revision,
      req.body?.segments
    );
    saveTaskSummary(task, manifest);
    return res.json({ success: true, manifest: toPublicManifest(manifest) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function replaceText(req, res) {
  try {
    const task = requireTask(req);
    requireSourceVideo(task);
    const manifest = segmentService.replaceText(
      task.workDir,
      req.body?.revision,
      req.body?.search,
      req.body?.replacement
    );
    saveTaskSummary(task, manifest);
    return res.json({ success: true, manifest: toPublicManifest(manifest) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function approveSegments(req, res) {
  try {
    const task = requireTask(req);
    requireSourceVideo(task);
    if (task.status !== 'waiting_input' || task.actionRequired !== 'segment_review') {
      throw new SegmentServiceError(
        'Tác vụ không ở trạng thái chờ duyệt segment',
        'SEGMENT_REVIEW_NOT_WAITING',
        409
      );
    }
    const manifest = segmentService.approve(task.workDir, req.body?.revision);
    saveTaskSummary(task, manifest);
    return res.json({
      success: true,
      manifest: toPublicManifest(manifest),
      message: 'Đã duyệt toàn bộ segment. Bạn có thể tiếp tục render.'
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function regenerateSegment(req, res) {
  let task;
  let segment;
  let lockOwner;
  try {
    task = requireTask(req);
    requireSourceVideo(task);
    if (task.status !== 'waiting_input' || task.actionRequired !== 'segment_review') {
      throw new SegmentServiceError(
        'Chỉ có thể nghe thử khi tác vụ đang chờ duyệt segment',
        'SEGMENT_REVIEW_NOT_WAITING',
        409
      );
    }
    let manifest = segmentService.load(task.workDir);
    if (!manifest) {
      throw new SegmentServiceError('Không tìm thấy dữ liệu segment', 'SEGMENT_MANIFEST_MISSING', 404);
    }
    if (Number(req.body?.revision) !== Number(manifest.revision)) {
      throw new SegmentRevisionConflictError(manifest.revision);
    }
    segment = manifest.segments.find((item) => item.id === req.params.segmentId);
    if (!segment) {
      throw new SegmentServiceError('Không tìm thấy segment', 'SEGMENT_NOT_FOUND', 404);
    }
    if (segment.locked) {
      throw new SegmentServiceError('Segment đã bị khóa', 'SEGMENT_LOCKED', 409);
    }

    lockOwner = `segment-preview:${task.id}:${segment.id}`;
    shared.acquireVoiceEngine(lockOwner);
    manifest = segmentService.setSegmentAudio(task.workDir, segment.id, {
      status: 'generating',
      audioFile: null,
      audioDurationMs: null,
      audioSignature: null,
      fit: null,
      error: null
    });
    saveTaskSummary(task, manifest);

    const engineId = segment.engineId || task.body.voiceEngine || DEFAULT_VOICE_ENGINE_ID;
    const engine = voiceEngineRegistry.resolve(engineId, DEFAULT_VOICE_ENGINE_ID);
    await engine.loadModel();
    const reference = await resolveVoiceReference({
      voiceFile: segment.voiceFile || task.body.savedVoiceFile,
      defaultVoiceFile: task.body.savedVoiceFile,
      providedText: task.body.refText,
      workDir: task.workDir,
      whisperModel: task.body.whisperModel || 'small',
      whisperOnnxVariant: task.body.whisperOnnxVariant || 'q8',
      language: task.body.ocrLanguage || ''
    });
    const rawDir = path.join(task.workDir, 'segments', 'previews', 'raw');
    const fittedDir = path.join(task.workDir, 'segments', 'previews', 'fitted');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(fittedDir, { recursive: true });
    const rawPath = path.join(rawDir, `${segment.id}.wav`);
    const outputPath = path.join(fittedDir, `${segment.id}.wav`);
    const language = ['vi', 'en', 'zh'].includes(task.body.omiLanguage)
      ? task.body.omiLanguage
      : 'vi';
    const rawSignature = createVoiceAudioSignature({
      text: segment.text,
      voiceFile: segment.voiceFile || task.body.savedVoiceFile || '',
      referenceIdentity: reference.sourceIdentity,
      referenceText: reference.text,
      engineId,
      steps: task.body.omiSteps || '16',
      language,
      seed: task.body.omiSeed || '',
      positionTemperature: 1
    });
    const rawReady = segment.rawAudioSignature === rawSignature && isUsableFile(rawPath, 44);
    const method = reference.audioPath && reference.text ? 'cloneVoice' : 'synthesize';
    if (!rawReady) await engine[method]({
      text: segment.text,
      outputPath: rawPath,
      language,
      device: task.body.omiDevice || 'cpu',
      steps: task.body.omiSteps || '16',
      seed: task.body.omiSeed || String(Math.floor(Math.random() * 9999999)),
      positionTemperature: 1,
      referenceAudioPath: reference.audioPath,
      referenceText: reference.text,
      instruct: 'female',
      skipRenderCheck: true,
      allowCpuFallback: task.body.voiceAllowCpuFallback === 'true'
        || task.body.voiceAllowCpuFallback === true
    });
    if (!isUsableFile(rawPath, 44)) {
      throw new Error('Voice engine không tạo được audio segment');
    }
    const segmentIndex = manifest.segments.findIndex((item) => item.id === segment.id);
    const audioMastering = normalizeAudioMasteringConfig(task.body);
    const voiceProcessing = {
      enabled: audioMastering.enabled,
      voiceLufs: audioMastering.voiceLufs,
      truePeakDb: audioMastering.truePeakDb,
      loudnessRange: audioMastering.loudnessRange,
      crossfadeMs: audioMastering.crossfadeMs
    };
    const rawDurationMs = readWavDurationMs(rawPath);
    const audioSignature = createSmartFitSignature({
      rawSignature,
      rawFile: getFileIdentity(rawPath),
      mode: 'cue',
      startMs: segment.startMs,
      endMs: segment.endMs,
      audioProcessing: voiceProcessing
    });
    const fitPlan = planSmartFit({
      mode: 'cue',
      startMs: segment.startMs,
      endMs: segment.endMs,
      rawDurationMs
    });
    await createFittedVoiceChunk({
      rawPath,
      outputPath,
      fitPlan,
      ffmpegPath: shared.FFMPEG_PATH,
      runExecFile: shared.runExecFile,
      normalizationOptions: {
        integratedLufs: audioMastering.voiceLufs,
        loudnessRange: audioMastering.loudnessRange,
        truePeakDb: audioMastering.truePeakDb,
        fadeMs: audioMastering.crossfadeMs
      },
      label: `Segment ${segmentIndex + 1}`
    });
    const audioQuality = analyzeWavFile(outputPath);
    const fittedDurationMs = audioQuality.durationMs;
    manifest = segmentService.setSegmentAudio(task.workDir, segment.id, {
      status: 'ready',
      rawAudioFile: path.relative(task.workDir, rawPath),
      rawAudioDurationMs: rawDurationMs,
      rawAudioSignature: rawSignature,
      audioFile: path.relative(task.workDir, outputPath),
      audioDurationMs: fittedDurationMs,
      audioSignature,
      audioQuality,
      fit: { ...fitPlan, fittedDurationMs, signature: audioSignature }
    });
    saveTaskSummary(task, manifest);
    return res.json({ success: true, manifest: toPublicManifest(manifest) });
  } catch (error) {
    if (task?.workDir && segment?.id) {
      try {
        const manifest = segmentService.setSegmentAudio(task.workDir, segment.id, {
          status: 'error',
          error: error.message
        });
        saveTaskSummary(task, manifest);
        error.currentRevision = manifest.revision;
        error.manifest = toPublicManifest(manifest);
      } catch {}
    }
    return sendError(res, error);
  } finally {
    if (lockOwner) shared.releaseVoiceEngine(lockOwner);
  }
}

async function retryAsrSegment(req, res) {
  let task;
  let segment;
  let owner;
  try {
    task = requireTask(req);
    requireSourceVideo(task);
    if (task.status !== 'waiting_input' || task.actionRequired !== 'segment_review') {
      throw new SegmentServiceError(
        'Chỉ có thể nhận dạng lại khi tác vụ đang chờ duyệt lời thoại',
        'SEGMENT_REVIEW_NOT_WAITING',
        409
      );
    }
    const manifest = segmentService.load(task.workDir);
    if (!manifest?.asr || manifest.asr.engineId !== DEFAULT_ASR_ENGINE_ID) {
      throw new SegmentServiceError(
        'Task này không có dữ liệu nguồn từ Whisper ONNX',
        'ASR_METADATA_MISSING',
        409
      );
    }
    if (Number(req.body?.revision) !== Number(manifest.revision)) {
      throw new SegmentRevisionConflictError(manifest.revision);
    }
    segment = manifest.segments.find((item) => item.id === req.params.segmentId);
    if (!segment) {
      throw new SegmentServiceError('Không tìm thấy segment', 'SEGMENT_NOT_FOUND', 404);
    }
    if (segment.locked) {
      throw new SegmentServiceError('Segment đã bị khóa', 'SEGMENT_LOCKED', 409);
    }
    if (activeAsrRetries.has(task.id)) {
      throw new SegmentServiceError(
        'Whisper đang nhận dạng lại một câu khác trong task này',
        'ASR_ENGINE_BUSY',
        409
      );
    }

    const audioPath = path.join(task.workDir, 'audio.wav');
    if (!isUsableFile(audioPath, 44)) {
      throw new SegmentServiceError(
        'Không tìm thấy audio Whisper đã trích xuất của task',
        'ASR_AUDIO_MISSING',
        409
      );
    }

    owner = `asr-retry:${task.id}:${segment.id}`;
    activeAsrRetries.set(task.id, owner);
    const engine = asrEngineRegistry.resolve(manifest.asr.engineId, DEFAULT_ASR_ENGINE_ID);
    const variant = manifest.asr.variant || task.body?.whisperOnnxVariant || 'q8';
    const result = await engine.transcribeSegment({
      audioPath,
      modelPath: resolveWhisperModelPath(variant),
      variant,
      language: req.body?.language || manifest.asr.language || 'auto',
      device: 'cpu',
      startMs: segment.startMs,
      endMs: segment.endMs,
      owner
    });
    if (!result.text) {
      throw new SegmentServiceError(
        'Whisper không nhận dạng được lời nói trong khoảng thời gian này',
        'ASR_EMPTY_RESULT',
        422
      );
    }
    const updated = segmentService.setSegmentAsrResult(
      task.workDir,
      segment.id,
      manifest.revision,
      result
    );
    saveTaskSummary(task, updated);
    return res.json({ success: true, manifest: toPublicManifest(updated) });
  } catch (error) {
    if (owner && cancelledAsrOwners.has(owner)) {
      cancelledAsrOwners.delete(owner);
      return sendError(res, new SegmentServiceError(
        'Đã dừng nhận dạng lại bằng Whisper',
        'ASR_CANCELLED',
        409
      ));
    }
    if (owner && task?.workDir && segment?.id && Number.isFinite(Number(req.body?.revision))) {
      try {
        const manifest = segmentService.setSegmentAsrResult(
          task.workDir,
          segment.id,
          req.body.revision,
          { status: 'error', error: error.message }
        );
        saveTaskSummary(task, manifest);
        error.currentRevision = manifest.revision;
        error.manifest = toPublicManifest(manifest);
      } catch {}
    }
    return sendError(res, error);
  } finally {
    if (task?.id && activeAsrRetries.get(task.id) === owner) activeAsrRetries.delete(task.id);
  }
}

async function cancelAsrRetry(req, res) {
  try {
    const task = requireTask(req);
    const owner = activeAsrRetries.get(task.id);
    if (!owner || !owner.endsWith(`:${req.params.segmentId}`)) {
      return res.json({ success: true, cancelled: false });
    }
    const manifest = segmentService.load(task.workDir);
    const engine = asrEngineRegistry.resolve(
      manifest?.asr?.engineId,
      DEFAULT_ASR_ENGINE_ID
    );
    cancelledAsrOwners.add(owner);
    const cancelled = await engine.cancel(owner);
    if (!cancelled) cancelledAsrOwners.delete(owner);
    activeAsrRetries.delete(task.id);
    return res.json({ success: true, cancelled });
  } catch (error) {
    return sendError(res, error);
  }
}

async function streamSegmentAudio(req, res) {
  try {
    const task = requireTask(req);
    const audioPath = req.query.variant === 'raw'
      ? segmentService.getRawAudioPath(task.workDir, req.params.segmentId)
      : segmentService.getAudioPath(task.workDir, req.params.segmentId);
    if (!audioPath) {
      throw new SegmentServiceError('Segment chưa có audio nghe thử', 'SEGMENT_AUDIO_MISSING', 404);
    }

    const stat = fs.statSync(audioPath);
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(audioPath)}"`);

    if (!range) {
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(audioPath).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return res.status(416).end();
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= stat.size) {
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(audioPath, { start, end }).pipe(res);
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  approveSegments,
  cancelAsrRetry,
  getSegments,
  regenerateSegment,
  replaceText,
  retryAsrSegment,
  streamSegmentAudio,
  updateSegments
};
