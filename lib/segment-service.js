const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SrtParser = require('srt-parser-2').default;

const {
  createCheckpointSignature,
  isUsableFile,
  readJsonFile,
  writeJsonAtomic
} = require('./checkpoint-utils');
const { aggregateAsrQuality } = require('./asr-quality');
const { normalizeSmartFitMode } = require('./smart-fit-service');

const SEGMENT_MANIFEST_VERSION = 1;
const MAX_SEGMENTS = 5000;
const MAX_TEXT_LENGTH = 5000;
const VALID_STATUSES = new Set(['pending', 'generating', 'ready', 'error']);

class SegmentServiceError extends Error {
  constructor(message, code = 'SEGMENT_ERROR', statusCode = 400) {
    super(message);
    this.name = 'SegmentServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class SegmentRevisionConflictError extends SegmentServiceError {
  constructor(currentRevision) {
    super(
      'Dữ liệu segment đã được thay đổi ở nơi khác. Vui lòng tải lại trước khi lưu.',
      'SEGMENT_REVISION_CONFLICT',
      409
    );
    this.currentRevision = currentRevision;
  }
}

function assertTaskId(value) {
  const taskId = String(value || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    throw new SegmentServiceError('Mã tác vụ không hợp lệ', 'INVALID_TASK_ID');
  }
  return taskId;
}

function assertSegmentId(value) {
  const segmentId = String(value || '');
  if (!/^seg_[a-zA-Z0-9_-]{6,80}$/.test(segmentId)) {
    throw new SegmentServiceError('Mã segment không hợp lệ', 'INVALID_SEGMENT_ID');
  }
  return segmentId;
}

function parseSrtTime(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(value || '').trim());
  if (!match) return Number.NaN;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000)
    + Number(match[4].padEnd(3, '0'));
}

function formatSrtTime(milliseconds) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`
    + `${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function normalizeText(value) {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw new SegmentServiceError(
      `Nội dung segment không được vượt quá ${MAX_TEXT_LENGTH} ký tự`,
      'SEGMENT_TEXT_TOO_LONG'
    );
  }
  return text;
}

function makeSegmentId() {
  return `seg_${crypto.randomUUID().replace(/-/g, '')}`;
}

function groupCues(cues) {
  const groups = [];
  let current = [];

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    current.push(cue);
    const next = cues[index + 1];
    let shouldSplit = !next;

    if (next) {
      const gapMs = next.startMs - cue.endMs;
      if (gapMs > 1000 || /[.!?…。]$/u.test(cue.text.trim())) shouldSplit = true;
      if (!shouldSplit && cue.endMs - current[0].startMs > 10000) shouldSplit = true;
    }

    if (shouldSplit) {
      groups.push(current);
      current = [];
    }
  }

  return groups;
}

function mapSourceCues(sourceCues, startMs, endMs) {
  const overlapping = sourceCues.filter((cue) => cue.endMs > startMs && cue.startMs < endMs);
  const asrCues = overlapping.map((cue) => cue.asr).filter(Boolean);
  const asrQuality = aggregateAsrQuality(asrCues);
  return {
    sourceCueIds: overlapping.map((cue) => cue.id),
    sourceText: overlapping.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim(),
    asr: asrCues.length
      ? {
          status: 'ready',
          ...asrQuality,
          words: asrCues.flatMap((cue) => Array.isArray(cue.words) ? cue.words : []),
          retryCount: 0,
          error: null
        }
      : null
  };
}

function getSegmentWarnings(segment, previousSegment, durationMs) {
  const warnings = [];
  const cueDuration = segment.endMs - segment.startMs;
  if (!segment.text) warnings.push('empty_text');
  if (segment.startMs < 0 || segment.endMs <= segment.startMs) warnings.push('invalid_timing');
  if (cueDuration > 0 && cueDuration < 250) warnings.push('cue_too_short');
  if (previousSegment && segment.startMs < previousSegment.endMs) warnings.push('overlap');
  if (Number.isFinite(durationMs) && durationMs > 0 && segment.endMs > durationMs) {
    warnings.push('outside_video');
  }
  if (
    !segment.fit
    && Number(segment.audioDurationMs) > 0
    && Number(segment.audioDurationMs) > cueDuration
  ) {
    warnings.push('audio_too_long');
  }
  if (segment.fit?.warning) warnings.push(segment.fit.warning);
  if (Array.isArray(segment.audioQuality?.warnings)) {
    warnings.push(...segment.audioQuality.warnings);
  }
  if (Array.isArray(segment.asr?.warnings)) warnings.push(...segment.asr.warnings);
  if (segment.asr?.translationStale) warnings.push('asr_translation_stale');
  if (segment.asr?.status === 'error') warnings.push('asr_retry_error');
  if (segment.status === 'error') warnings.push('tts_error');
  return [...new Set(warnings)];
}

function normalizeCue(cue, index) {
  const startMs = parseSrtTime(cue.startTime);
  const endMs = parseSrtTime(cue.endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const text = normalizeText(cue.text);
  if (!text) return null;
  return {
    id: String(cue.id || index + 1),
    startMs,
    endMs,
    text
  };
}

class SegmentService {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.now = options.now || (() => new Date());
  }

  getSegmentsDir(workDir) {
    return path.join(workDir, 'segments');
  }

  getManifestPath(workDir) {
    return path.join(this.getSegmentsDir(workDir), 'manifest.json');
  }

  getReviewedSrtPath(workDir) {
    return path.join(this.getSegmentsDir(workDir), 'reviewed.srt');
  }

  load(workDir) {
    const manifest = readJsonFile(this.getManifestPath(workDir));
    if (!manifest || manifest.version !== SEGMENT_MANIFEST_VERSION || !Array.isArray(manifest.segments)) {
      return null;
    }
    return manifest;
  }

  save(workDir, manifest) {
    manifest.updatedAt = this.now().toISOString();
    writeJsonAtomic(this.getManifestPath(workDir), manifest);
    this.writeReviewedSrt(workDir, manifest);
    return manifest;
  }

  writeReviewedSrt(workDir, manifest) {
    const parser = new SrtParser();
    const cues = manifest.segments.map((segment, index) => ({
      id: String(index + 1),
      startTime: formatSrtTime(segment.startMs),
      endTime: formatSrtTime(Math.max(segment.endMs, Number(segment.fit?.effectiveEndMs) || 0)),
      text: segment.text
    }));
    const outputPath = this.getReviewedSrtPath(workDir);
    this.fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    this.fs.writeFileSync(outputPath, parser.toSrt(cues), 'utf8');
    return outputPath;
  }

  createOrLoad(options) {
    const {
      taskId,
      workDir,
      sourceSubtitlePath,
      finalSubtitlePath,
      durationMs,
      reviewRequired = false,
      defaultVoiceFile = '',
      defaultEngineId = '',
      smartFitMode = 'cue',
      asrMetadataPath = null
    } = options;
    assertTaskId(taskId);
    if (!sourceSubtitlePath || !this.fs.existsSync(sourceSubtitlePath)) {
      throw new SegmentServiceError('Không tìm thấy phụ đề nguồn', 'SOURCE_SUBTITLE_MISSING', 409);
    }
    if (!finalSubtitlePath || !this.fs.existsSync(finalSubtitlePath)) {
      throw new SegmentServiceError('Không tìm thấy phụ đề đã xử lý', 'FINAL_SUBTITLE_MISSING', 409);
    }

    const sourceContent = this.fs.readFileSync(sourceSubtitlePath, 'utf8');
    const finalContent = this.fs.readFileSync(finalSubtitlePath, 'utf8');
    const sourceSignature = createCheckpointSignature(sourceContent);
    const finalSignature = createCheckpointSignature(finalContent);
    const existing = this.load(workDir);
    if (
      existing
      && existing.taskId === taskId
      && existing.sourceSignature === sourceSignature
      && existing.finalSignature === finalSignature
    ) {
      existing.reviewRequired = reviewRequired === true;
      existing.smartFit ||= { mode: normalizeSmartFitMode(smartFitMode) };
      this.recalculateWarnings(existing);
      return this.save(workDir, existing);
    }

    const parser = new SrtParser();
    const sourceCues = parser.fromSrt(sourceContent)
      .map(normalizeCue)
      .filter(Boolean);
    const asrMetadata = asrMetadataPath && this.fs.existsSync(asrMetadataPath)
      ? readJsonFile(asrMetadataPath)
      : null;
    const asrCueMap = new Map(
      (Array.isArray(asrMetadata?.cues) ? asrMetadata.cues : [])
        .map((cue) => [String(cue.id || ''), cue])
    );
    sourceCues.forEach((cue) => {
      cue.asr = asrCueMap.get(String(cue.id)) || null;
    });
    const finalCues = parser.fromSrt(finalContent)
      .map(normalizeCue)
      .filter(Boolean);
    if (!finalCues.length) {
      throw new SegmentServiceError('Phụ đề không có segment hợp lệ', 'EMPTY_SEGMENTS');
    }

    const groups = groupCues(finalCues);
    if (groups.length > MAX_SEGMENTS) {
      throw new SegmentServiceError(
        `Phụ đề vượt quá giới hạn ${MAX_SEGMENTS} segment`,
        'TOO_MANY_SEGMENTS'
      );
    }

    const segments = groups.map((group) => {
      const startMs = group[0].startMs;
      const endMs = group[group.length - 1].endMs;
      const source = mapSourceCues(sourceCues, startMs, endMs);
      return {
        id: makeSegmentId(),
        sourceCueIds: source.sourceCueIds,
        sourceText: source.sourceText,
        asr: source.asr,
        text: group.map((cue) => cue.text.replace(/\n/g, ' ')).join(' ').replace(/\s+/g, ' ').trim(),
        startMs,
        endMs,
        voiceFile: defaultVoiceFile || '',
        engineId: defaultEngineId || '',
        locked: false,
        approved: reviewRequired !== true,
        status: 'pending',
        audioFile: null,
        audioDurationMs: null,
        audioSignature: null,
        rawAudioFile: null,
        rawAudioDurationMs: null,
        rawAudioSignature: null,
        audioQuality: null,
        fit: null,
        error: null,
        warnings: []
      };
    });

    const createdAt = this.now().toISOString();
    const manifest = {
      version: SEGMENT_MANIFEST_VERSION,
      taskId,
      revision: 1,
      reviewRequired: reviewRequired === true,
      reviewStatus: reviewRequired === true ? 'pending' : 'approved',
      sourceSubtitlePath,
      finalSubtitlePath,
      reviewedSrtPath: this.getReviewedSrtPath(workDir),
      sourceSignature,
      finalSignature,
      durationMs: Number(durationMs) || 0,
      smartFit: { mode: normalizeSmartFitMode(smartFitMode) },
      asr: asrMetadata
        ? {
            version: Number(asrMetadata.version) || 1,
            engineId: asrMetadata.engineId || 'whisper-onnx',
            variant: asrMetadata.variant || 'q8',
            language: asrMetadata.language || 'auto',
            languageMode: asrMetadata.languageMode || 'manual',
            timestampLevel: asrMetadata.timestampLevel || 'segment',
            metadataPath: asrMetadataPath
          }
        : null,
      createdAt,
      updatedAt: createdAt,
      segments
    };
    this.recalculateWarnings(manifest);
    return this.save(workDir, manifest);
  }

  recalculateWarnings(manifest) {
    manifest.segments.forEach((segment, index) => {
      segment.warnings = getSegmentWarnings(
        segment,
        index > 0 ? manifest.segments[index - 1] : null,
        Number(manifest.durationMs)
      );
    });
    return manifest;
  }

  updateSegments(workDir, expectedRevision, patches) {
    const manifest = this.load(workDir);
    if (!manifest) {
      throw new SegmentServiceError('Không tìm thấy dữ liệu segment', 'SEGMENT_MANIFEST_MISSING', 404);
    }
    if (Number(expectedRevision) !== Number(manifest.revision)) {
      throw new SegmentRevisionConflictError(manifest.revision);
    }
    if (!Array.isArray(patches) || patches.length === 0 || patches.length > MAX_SEGMENTS) {
      throw new SegmentServiceError('Danh sách thay đổi segment không hợp lệ', 'INVALID_SEGMENT_PATCHES');
    }

    const byId = new Map(manifest.segments.map((segment) => [segment.id, segment]));
    for (const patch of patches) {
      const id = assertSegmentId(patch?.id);
      const segment = byId.get(id);
      if (!segment) {
        throw new SegmentServiceError('Không tìm thấy segment', 'SEGMENT_NOT_FOUND', 404);
      }
      if (segment.locked && patch.locked !== false) {
        throw new SegmentServiceError('Segment đã bị khóa', 'SEGMENT_LOCKED', 409);
      }

      const nextText = Object.hasOwn(patch, 'text') ? normalizeText(patch.text) : segment.text;
      const nextVoice = Object.hasOwn(patch, 'voiceFile')
        ? String(patch.voiceFile || '').trim()
        : segment.voiceFile;
      const nextStart = Object.hasOwn(patch, 'startMs') ? Number(patch.startMs) : segment.startMs;
      const nextEnd = Object.hasOwn(patch, 'endMs') ? Number(patch.endMs) : segment.endMs;
      if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextStart < 0 || nextEnd <= nextStart) {
        throw new SegmentServiceError('Timestamp segment không hợp lệ', 'INVALID_SEGMENT_TIMING');
      }

      const audioChanged = nextText !== segment.text || nextVoice !== segment.voiceFile;
      const timingChanged = Math.round(nextStart) !== segment.startMs
        || Math.round(nextEnd) !== segment.endMs;
      segment.text = nextText;
      segment.voiceFile = nextVoice;
      segment.startMs = Math.round(nextStart);
      segment.endMs = Math.round(nextEnd);
      if (Object.hasOwn(patch, 'locked')) segment.locked = patch.locked === true;
      if (Object.hasOwn(patch, 'approved')) segment.approved = patch.approved === true;

      if (audioChanged) {
        if (segment.audioFile) {
          const audioPath = path.join(workDir, segment.audioFile);
          try { this.fs.rmSync(audioPath, { force: true }); } catch {}
        }
        segment.status = 'pending';
        segment.audioFile = null;
        segment.audioDurationMs = null;
        segment.audioSignature = null;
        if (segment.rawAudioFile) {
          const rawAudioPath = path.join(workDir, segment.rawAudioFile);
          try { this.fs.rmSync(rawAudioPath, { force: true }); } catch {}
        }
        segment.rawAudioFile = null;
        segment.rawAudioDurationMs = null;
        segment.rawAudioSignature = null;
        segment.audioQuality = null;
        segment.fit = null;
        segment.error = null;
      } else if (timingChanged) {
        if (segment.audioFile) {
          const audioPath = path.join(workDir, segment.audioFile);
          try { this.fs.rmSync(audioPath, { force: true }); } catch {}
        }
        segment.status = 'pending';
        segment.audioFile = null;
        segment.audioDurationMs = null;
        segment.audioSignature = null;
        segment.audioQuality = null;
        segment.fit = null;
        segment.error = null;
      }
    }

    manifest.revision += 1;
    manifest.reviewStatus = manifest.segments.every((segment) => segment.approved)
      ? 'approved'
      : 'pending';
    this.recalculateWarnings(manifest);
    return this.save(workDir, manifest);
  }

  replaceText(workDir, expectedRevision, search, replacement) {
    const manifest = this.load(workDir);
    if (!manifest) {
      throw new SegmentServiceError('Không tìm thấy dữ liệu segment', 'SEGMENT_MANIFEST_MISSING', 404);
    }
    if (Number(expectedRevision) !== Number(manifest.revision)) {
      throw new SegmentRevisionConflictError(manifest.revision);
    }
    const needle = String(search || '');
    if (!needle || needle.length > 500) {
      throw new SegmentServiceError('Nội dung tìm kiếm không hợp lệ', 'INVALID_SEARCH');
    }
    const target = String(replacement ?? '');
    const patches = manifest.segments
      .filter((segment) => !segment.locked && segment.text.includes(needle))
      .map((segment) => ({
        id: segment.id,
        text: segment.text.split(needle).join(target)
      }));
    if (!patches.length) return manifest;
    return this.updateSegments(workDir, expectedRevision, patches);
  }

  approve(workDir, expectedRevision) {
    const manifest = this.load(workDir);
    if (!manifest) {
      throw new SegmentServiceError('Không tìm thấy dữ liệu segment', 'SEGMENT_MANIFEST_MISSING', 404);
    }
    if (Number(expectedRevision) !== Number(manifest.revision)) {
      throw new SegmentRevisionConflictError(manifest.revision);
    }
    manifest.segments.forEach((segment) => {
      segment.approved = true;
    });
    manifest.reviewStatus = 'approved';
    manifest.revision += 1;
    this.recalculateWarnings(manifest);
    return this.save(workDir, manifest);
  }

  setSegmentAudio(workDir, segmentId, audio) {
    const manifest = this.load(workDir);
    if (!manifest) {
      throw new SegmentServiceError('Không tìm thấy dữ liệu segment', 'SEGMENT_MANIFEST_MISSING', 404);
    }
    const id = assertSegmentId(segmentId);
    const segment = manifest.segments.find((candidate) => candidate.id === id);
    if (!segment) {
      throw new SegmentServiceError('Không tìm thấy segment', 'SEGMENT_NOT_FOUND', 404);
    }
    segment.status = VALID_STATUSES.has(audio.status) ? audio.status : 'ready';
    if (Object.hasOwn(audio, 'audioFile')) segment.audioFile = audio.audioFile || null;
    if (Object.hasOwn(audio, 'audioDurationMs')) {
      segment.audioDurationMs = Number.isFinite(Number(audio.audioDurationMs))
        ? Math.round(Number(audio.audioDurationMs))
        : null;
    }
    if (Object.hasOwn(audio, 'audioSignature')) {
      segment.audioSignature = audio.audioSignature || null;
    }
    if (Object.hasOwn(audio, 'rawAudioFile')) segment.rawAudioFile = audio.rawAudioFile || null;
    if (Object.hasOwn(audio, 'rawAudioDurationMs')) {
      segment.rawAudioDurationMs = Number.isFinite(Number(audio.rawAudioDurationMs))
        ? Math.round(Number(audio.rawAudioDurationMs))
        : null;
    }
    if (Object.hasOwn(audio, 'rawAudioSignature')) {
      segment.rawAudioSignature = audio.rawAudioSignature || null;
    }
    if (Object.hasOwn(audio, 'audioQuality')) {
      segment.audioQuality = audio.audioQuality || null;
    }
    if (Object.hasOwn(audio, 'fit')) segment.fit = audio.fit || null;
    segment.error = Object.hasOwn(audio, 'error') ? (audio.error || null) : segment.error;
    manifest.revision += 1;
    this.recalculateWarnings(manifest);
    return this.save(workDir, manifest);
  }

  setSegmentAsrResult(workDir, segmentId, expectedRevision, result) {
    const manifest = this.load(workDir);
    if (!manifest) {
      throw new SegmentServiceError('Không tìm thấy dữ liệu segment', 'SEGMENT_MANIFEST_MISSING', 404);
    }
    if (Number(expectedRevision) !== Number(manifest.revision)) {
      throw new SegmentRevisionConflictError(manifest.revision);
    }
    const id = assertSegmentId(segmentId);
    const segment = manifest.segments.find((candidate) => candidate.id === id);
    if (!segment) {
      throw new SegmentServiceError('Không tìm thấy segment', 'SEGMENT_NOT_FOUND', 404);
    }
    if (segment.locked) {
      throw new SegmentServiceError('Segment đã bị khóa', 'SEGMENT_LOCKED', 409);
    }

    const previousSourceText = String(segment.sourceText || '').trim();
    const isError = result?.status === 'error';
    const nextSourceText = isError ? previousSourceText : normalizeText(result?.text);
    if (!isError) segment.sourceText = nextSourceText;
    segment.asr = {
      status: isError ? 'error' : 'ready',
      modelConfidence: result?.modelConfidence !== null
        && result?.modelConfidence !== undefined
        && Number.isFinite(Number(result.modelConfidence))
        ? Number(result.modelConfidence)
        : null,
      qualityScore: result?.qualityScore !== null
        && result?.qualityScore !== undefined
        && Number.isFinite(Number(result.qualityScore))
        ? Math.round(Number(result.qualityScore))
        : null,
      qualitySource: result?.qualitySource || 'heuristic',
      warnings: Array.isArray(result?.warnings) ? [...new Set(result.warnings)] : [],
      words: Array.isArray(result?.words) ? result.words : [],
      retryCount: Number(segment.asr?.retryCount || 0) + (isError ? 0 : 1),
      translationStale: isError
        ? Boolean(segment.asr?.translationStale)
        : Boolean(previousSourceText && nextSourceText !== previousSourceText),
      error: result?.error || null,
      updatedAt: this.now().toISOString()
    };
    manifest.revision += 1;
    this.recalculateWarnings(manifest);
    return this.save(workDir, manifest);
  }

  getAudioPath(workDir, segmentId) {
    return this.getSegmentAudioPath(workDir, segmentId, 'fitted');
  }

  getRawAudioPath(workDir, segmentId) {
    return this.getSegmentAudioPath(workDir, segmentId, 'raw');
  }

  getSegmentAudioPath(workDir, segmentId, variant = 'fitted') {
    const manifest = this.load(workDir);
    if (!manifest) return null;
    const id = assertSegmentId(segmentId);
    const segment = manifest.segments.find((candidate) => candidate.id === id);
    const relativeFile = variant === 'raw' ? segment?.rawAudioFile : segment?.audioFile;
    if (!relativeFile) return null;
    const baseDir = path.resolve(workDir);
    const audioPath = path.resolve(workDir, relativeFile);
    if (!audioPath.startsWith(`${baseDir}${path.sep}`) || !isUsableFile(audioPath, 44)) return null;
    return audioPath;
  }

  updateSmartFitMode(workDir, expectedRevision, mode) {
    const manifest = this.load(workDir);
    if (!manifest) {
      throw new SegmentServiceError('Không tìm thấy dữ liệu segment', 'SEGMENT_MANIFEST_MISSING', 404);
    }
    if (Number(expectedRevision) !== Number(manifest.revision)) {
      throw new SegmentRevisionConflictError(manifest.revision);
    }
    const nextMode = normalizeSmartFitMode(mode);
    if (manifest.smartFit?.mode === nextMode) return manifest;
    manifest.smartFit = { mode: nextMode };
    for (const segment of manifest.segments) {
      if (segment.audioFile) {
        const audioPath = path.join(workDir, segment.audioFile);
        try { this.fs.rmSync(audioPath, { force: true }); } catch {}
      }
      segment.status = 'pending';
      segment.audioFile = null;
      segment.audioDurationMs = null;
      segment.audioSignature = null;
      segment.audioQuality = null;
      segment.fit = null;
      segment.error = null;
    }
    manifest.revision += 1;
    this.recalculateWarnings(manifest);
    return this.save(workDir, manifest);
  }

  summarize(manifest) {
    const segments = manifest?.segments || [];
    return {
      status: manifest?.reviewStatus || 'missing',
      revision: Number(manifest?.revision || 0),
      total: segments.length,
      approved: segments.filter((segment) => segment.approved).length,
      ready: segments.filter((segment) => segment.status === 'ready').length,
      warnings: segments.filter((segment) => segment.warnings?.length).length
    };
  }
}

module.exports = {
  MAX_SEGMENTS,
  MAX_TEXT_LENGTH,
  SEGMENT_MANIFEST_VERSION,
  SegmentRevisionConflictError,
  SegmentService,
  SegmentServiceError,
  assertSegmentId,
  assertTaskId,
  formatSrtTime,
  getSegmentWarnings,
  groupCues,
  parseSrtTime
};
