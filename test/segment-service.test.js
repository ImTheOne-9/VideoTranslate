const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SegmentRevisionConflictError,
  SegmentService
} = require('../lib/segment-service');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'segment-service-'));
}

function writeSrt(filePath, cues) {
  const content = cues.map((cue, index) => (
    `${index + 1}\n${cue.start} --> ${cue.end}\n${cue.text}\n`
  )).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
}

function createFixture(options = {}) {
  const workDir = makeTempDir();
  const sourcePath = path.join(workDir, 'source.srt');
  const finalPath = path.join(workDir, 'final.srt');
  const sourceCues = options.sourceCues || [
    { start: '00:00:00,000', end: '00:00:01,000', text: '你好' },
    { start: '00:00:01,000', end: '00:00:02,000', text: '世界。' },
    { start: '00:00:04,000', end: '00:00:05,000', text: '再见' }
  ];
  const finalCues = options.finalCues || [
    { start: '00:00:00,000', end: '00:00:01,000', text: 'Xin chào' },
    { start: '00:00:01,000', end: '00:00:02,000', text: 'thế giới.' },
    { start: '00:00:04,000', end: '00:00:05,000', text: 'Tạm biệt' }
  ];
  writeSrt(sourcePath, sourceCues);
  writeSrt(finalPath, finalCues);
  const asrMetadataPath = path.join(workDir, 'source.srt.asr.json');
  if (options.asrMetadata) {
    fs.writeFileSync(asrMetadataPath, JSON.stringify(options.asrMetadata), 'utf8');
  }
  const service = new SegmentService();
  const manifest = service.createOrLoad({
    taskId: 'task_segments',
    workDir,
    sourceSubtitlePath: sourcePath,
    finalSubtitlePath: finalPath,
    durationMs: 10000,
    reviewRequired: true,
    defaultVoiceFile: 'voice.wav',
    defaultEngineId: 'current-omnivoice',
    asrMetadataPath: options.asrMetadata ? asrMetadataPath : null
  });
  return { asrMetadataPath, finalPath, manifest, service, sourcePath, workDir };
}

test('groups adjacent SRT cues into natural OmniVoice speech segments', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));

  assert.equal(fixture.manifest.version, 1);
  assert.equal(fixture.manifest.reviewStatus, 'pending');
  assert.equal(fixture.manifest.segments.length, 2);
  assert.match(fixture.manifest.segments[0].id, /^seg_[a-zA-Z0-9_-]+$/);
  assert.equal(fixture.manifest.segments[0].sourceText, '你好 世界。');
  assert.equal(fixture.manifest.segments[0].text, 'Xin chào thế giới.');
  assert.equal(fixture.manifest.segments[0].startMs, 0);
  assert.equal(fixture.manifest.segments[0].endMs, 2000);
  assert.equal(fixture.manifest.segments[1].sourceText, '再见');
  assert.equal(fixture.manifest.segments[1].text, 'Tạm biệt');
  assert.equal(fixture.manifest.segments[1].startMs, 4000);
  assert.equal(fixture.manifest.segments[1].endMs, 5000);
  assert.equal(fs.existsSync(fixture.manifest.reviewedSrtPath), true);
});

test('reuses an unchanged version 1 grouped manifest', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const segmentIds = fixture.manifest.segments.map((segment) => segment.id);

  const restored = fixture.service.createOrLoad({
    taskId: 'task_segments',
    workDir: fixture.workDir,
    sourceSubtitlePath: fixture.sourcePath,
    finalSubtitlePath: fixture.finalPath,
    durationMs: 10000,
    reviewRequired: true
  });

  assert.equal(restored.version, 1);
  assert.deepEqual(restored.segments.map((segment) => segment.id), segmentIds);
  assert.deepEqual(restored.segments.map((segment) => [segment.startMs, segment.endMs]), [
    [0, 2000],
    [4000, 5000]
  ]);
});

test('reloading unchanged subtitle inputs preserves immutable segment IDs', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const ids = fixture.manifest.segments.map((segment) => segment.id);

  const restored = fixture.service.createOrLoad({
    taskId: 'task_segments',
    workDir: fixture.workDir,
    sourceSubtitlePath: fixture.sourcePath,
    finalSubtitlePath: fixture.finalPath,
    durationMs: 10000,
    reviewRequired: true
  });

  assert.deepEqual(restored.segments.map((segment) => segment.id), ids);
});

test('maps optional ASR metadata into segments without changing manifest version', (t) => {
  const fixture = createFixture({
    asrMetadata: {
      version: 1,
      engineId: 'whisper-onnx',
      variant: 'medium-q8',
      language: 'auto',
      languageMode: 'auto',
      timestampLevel: 'segment',
      cues: [
        {
          id: '1',
          qualityScore: 92,
          modelConfidence: null,
          warnings: [],
          words: [{ text: 'xin', startMs: 0, endMs: 400 }]
        },
        {
          id: '2',
          qualityScore: 48,
          modelConfidence: 0.48,
          warnings: ['asr_low_confidence']
        }
      ]
    }
  });
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));

  assert.equal(fixture.manifest.version, 1);
  assert.equal(fixture.manifest.asr.engineId, 'whisper-onnx');
  assert.equal(fixture.manifest.asr.languageMode, 'auto');
  assert.deepEqual(fixture.manifest.segments[0].sourceCueIds, ['1', '2']);
  assert.equal(fixture.manifest.segments[0].asr.modelConfidence, 0.48);
  assert.ok(fixture.manifest.segments[0].warnings.includes('asr_low_confidence'));
});

test('single-segment ASR retry updates source text and marks translated text stale', (t) => {
  const fixture = createFixture({
    asrMetadata: {
      version: 1,
      engineId: 'whisper-onnx',
      cues: [{ id: '1', qualityScore: 90, warnings: [] }]
    }
  });
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const segment = fixture.manifest.segments[0];

  const updated = fixture.service.setSegmentAsrResult(
    fixture.workDir,
    segment.id,
    fixture.manifest.revision,
    {
      text: 'Nội dung gốc đã nhận dạng lại',
      modelConfidence: 0.88,
      qualityScore: 88,
      qualitySource: 'model',
      warnings: [],
      words: [{ text: 'Nội dung', startMs: 0, endMs: 500 }]
    }
  );

  assert.equal(updated.segments[0].sourceText, 'Nội dung gốc đã nhận dạng lại');
  assert.equal(updated.segments[0].text, segment.text);
  assert.equal(updated.segments[0].asr.retryCount, 1);
  assert.equal(updated.segments[0].asr.translationStale, true);
  assert.ok(updated.segments[0].warnings.includes('asr_translation_stale'));
});

test('current manifests without ASR metadata still load unchanged', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const loaded = fixture.service.load(fixture.workDir);

  assert.equal(loaded.version, 1);
  assert.equal(loaded.asr, null);
  assert.equal(loaded.segments[0].asr, null);
});

test('text changes invalidate only the edited segment audio', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const [first, second] = fixture.manifest.segments;
  const firstAudio = path.join(fixture.workDir, 'voice', 'first.wav');
  const secondAudio = path.join(fixture.workDir, 'voice', 'second.wav');
  fs.mkdirSync(path.dirname(firstAudio), { recursive: true });
  fs.writeFileSync(firstAudio, Buffer.alloc(64));
  fs.writeFileSync(secondAudio, Buffer.alloc(64));
  let manifest = fixture.service.setSegmentAudio(fixture.workDir, first.id, {
    status: 'ready',
    audioFile: path.relative(fixture.workDir, firstAudio),
    audioDurationMs: 900,
    audioSignature: 'first'
  });
  manifest = fixture.service.setSegmentAudio(fixture.workDir, second.id, {
    status: 'ready',
    audioFile: path.relative(fixture.workDir, secondAudio),
    audioDurationMs: 800,
    audioSignature: 'second'
  });

  const updated = fixture.service.updateSegments(fixture.workDir, manifest.revision, [{
    id: first.id,
    text: 'Nội dung mới'
  }]);

  assert.equal(updated.segments[0].status, 'pending');
  assert.equal(updated.segments[0].audioFile, null);
  assert.equal(fs.existsSync(firstAudio), false);
  assert.equal(updated.segments[1].audioFile, path.relative(fixture.workDir, secondAudio));
  assert.equal(fs.existsSync(secondAudio), true);
});

test('timing changes preserve raw audio, invalidate fitted audio, and update reviewed SRT', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const segment = fixture.manifest.segments[0];
  const audioPath = path.join(fixture.workDir, 'voice', 'timing.wav');
  const rawAudioPath = path.join(fixture.workDir, 'voice', 'timing-raw.wav');
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, Buffer.alloc(64));
  fs.writeFileSync(rawAudioPath, Buffer.alloc(64));
  const withAudio = fixture.service.setSegmentAudio(fixture.workDir, segment.id, {
    status: 'ready',
    rawAudioFile: path.relative(fixture.workDir, rawAudioPath),
    rawAudioDurationMs: 1200,
    rawAudioSignature: 'raw-audio',
    audioFile: path.relative(fixture.workDir, audioPath),
    audioDurationMs: 1000,
    audioSignature: 'same-audio',
    audioQuality: {
      version: 1,
      rmsDbfs: -40,
      peakDbfs: -10,
      warnings: ['audio_too_quiet']
    },
    fit: { mode: 'cue', status: 'sped_up', effectiveEndMs: 2000 }
  });

  const updated = fixture.service.updateSegments(fixture.workDir, withAudio.revision, [{
    id: segment.id,
    startMs: 250,
    endMs: 2500
  }]);

  assert.equal(updated.segments[0].audioFile, null);
  assert.equal(updated.segments[0].audioQuality, null);
  assert.equal(fs.existsSync(audioPath), false);
  assert.equal(updated.segments[0].rawAudioFile, path.relative(fixture.workDir, rawAudioPath));
  assert.equal(fs.existsSync(rawAudioPath), true);
  assert.match(fs.readFileSync(updated.reviewedSrtPath, 'utf8'), /00:00:00,250 --> 00:00:02,500/);
});

test('reloading a legacy manifest forces the fixed cue mode', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const segment = fixture.manifest.segments[0];
  const rawPath = path.join(fixture.workDir, 'voice', 'raw.wav');
  const fittedPath = path.join(fixture.workDir, 'voice', 'fitted.wav');
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, Buffer.alloc(64));
  fs.writeFileSync(fittedPath, Buffer.alloc(64));
  const ready = fixture.service.setSegmentAudio(fixture.workDir, segment.id, {
    status: 'ready',
    rawAudioFile: path.relative(fixture.workDir, rawPath),
    rawAudioDurationMs: 1400,
    rawAudioSignature: 'raw-signature',
    audioFile: path.relative(fixture.workDir, fittedPath),
    audioDurationMs: 1000,
    audioSignature: 'legacy-fit-signature',
    fit: { mode: 'natural', status: 'trimmed' }
  });
  ready.smartFit = { mode: 'natural' };
  fixture.service.save(fixture.workDir, ready);

  const restored = fixture.service.createOrLoad({
    taskId: 'task_segments',
    workDir: fixture.workDir,
    sourceSubtitlePath: fixture.sourcePath,
    finalSubtitlePath: fixture.finalPath,
    durationMs: 10000,
    reviewRequired: true
  });

  assert.equal(restored.smartFit.mode, 'cue');
  assert.equal(restored.segments[0].status, 'pending');
  assert.equal(restored.segments[0].audioFile, null);
  assert.equal(fs.existsSync(fittedPath), false);
  assert.equal(restored.segments[0].rawAudioFile, path.relative(fixture.workDir, rawPath));
  assert.equal(fs.existsSync(rawPath), true);
});

test('persists audio QC metrics and exposes their warnings on the segment', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const segment = fixture.manifest.segments[0];
  const quality = {
    version: 1,
    sampleRate: 24000,
    channels: 1,
    durationMs: 1000,
    rmsDbfs: -38.5,
    peakDbfs: -12,
    warnings: ['audio_too_quiet']
  };

  const updated = fixture.service.setSegmentAudio(fixture.workDir, segment.id, {
    status: 'ready',
    audioDurationMs: 1000,
    audioQuality: quality
  });
  const reloaded = fixture.service.load(fixture.workDir);

  assert.deepEqual(updated.segments[0].audioQuality, quality);
  assert.deepEqual(reloaded.segments[0].audioQuality, quality);
  assert.ok(reloaded.segments[0].warnings.includes('audio_too_quiet'));
});

test('reviewed SRT extends only into the safe borrowed gap', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const segment = fixture.manifest.segments[0];
  const updated = fixture.service.setSegmentAudio(fixture.workDir, segment.id, {
    status: 'ready',
    fit: { mode: 'cue', status: 'borrowed', effectiveEndMs: 2300 }
  });
  const srt = fs.readFileSync(updated.reviewedSrtPath, 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:02,300/);
});

test('revision conflicts reject stale editor writes', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const segment = fixture.manifest.segments[0];
  const current = fixture.service.updateSegments(fixture.workDir, fixture.manifest.revision, [{
    id: segment.id,
    text: 'Bản cập nhật đầu tiên'
  }]);

  assert.throws(
    () => fixture.service.updateSegments(fixture.workDir, fixture.manifest.revision, [{
      id: segment.id,
      text: 'Bản ghi cũ'
    }]),
    (error) => error instanceof SegmentRevisionConflictError
      && error.currentRevision === current.revision
  );
});

test('bulk replacement skips locked segments', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));
  const [first] = fixture.manifest.segments;
  const locked = fixture.service.updateSegments(fixture.workDir, fixture.manifest.revision, [{
    id: first.id,
    locked: true
  }]);

  const replaced = fixture.service.replaceText(
    fixture.workDir,
    locked.revision,
    'Tạm biệt',
    'Hẹn gặp lại'
  );

  assert.equal(replaced.segments[0].text, fixture.manifest.segments[0].text);
  assert.equal(replaced.segments[1].text, 'Hẹn gặp lại');
});

test('handles a 2000-segment manifest without truncating data', (t) => {
  const cues = Array.from({ length: 2000 }, (_, index) => {
    const startSeconds = index * 2;
    const endSeconds = startSeconds + 1;
    const time = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`
        + `${String(secs).padStart(2, '0')},000`;
    };
    return { start: time(startSeconds), end: time(endSeconds), text: `Câu ${index}.` };
  });
  const fixture = createFixture({ sourceCues: cues, finalCues: cues });
  t.after(() => fs.rmSync(fixture.workDir, { recursive: true, force: true }));

  assert.equal(fixture.manifest.segments.length, 2000);
  assert.equal(new Set(fixture.manifest.segments.map((segment) => segment.id)).size, 2000);
});
