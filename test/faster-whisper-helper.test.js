'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  runWorker,
  transcribeAudio,
  transcribeToSrt,
  validateFasterWhisperResult
} = require('../lib/faster-whisper-helper');

function fakeChild(onKill) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    onKill?.();
    setImmediate(() => child.emit('close', null));
    return true;
  };
  return child;
}

test('Faster Whisper worker receives original media, checkpoint, GPU state and FFmpeg paths', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faster-whisper-args-'));
  const sourcePath = path.join(directory, 'source.mp4');
  fs.writeFileSync(sourcePath, 'media');
  let receivedArgs;
  try {
    await runWorker({
      pythonPath: __filename,
      workerPath: path.resolve(__dirname, '../tools/crawler/app/faster_whisper_asr.py'),
      sourcePath,
      audioPath: path.join(directory, 'filtered.wav'),
      resultPath: path.join(directory, 'result.json'),
      checkpointPath: path.join(directory, 'checkpoint.json'),
      ffmpegPath: path.join(directory, 'ffmpeg.exe'),
      gpuStatePath: path.join(directory, 'gpu-state.json'),
      gpuLockPath: path.join(directory, 'gpu.lock'),
      modelRoot: directory,
      workDir: directory,
      durationSeconds: 42,
      spawnImpl(command, args) {
        receivedArgs = args;
        const child = fakeChild();
        setImmediate(() => child.emit('close', 0));
        return child;
      }
    });
    assert.equal(receivedArgs[receivedArgs.indexOf('--audio') + 1], sourcePath);
    for (const flag of ['--checkpoint', '--ffmpeg', '--gpu-state', '--gpu-lock', '--duration']) {
      assert.ok(receivedArgs.includes(flag), `missing ${flag}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Faster Whisper watchdog kills a worker that stops emitting heartbeat', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faster-whisper-watchdog-'));
  const sourcePath = path.join(directory, 'source.mp4');
  fs.writeFileSync(sourcePath, 'media');
  let killed = false;
  try {
    await assert.rejects(runWorker({
      pythonPath: __filename,
      workerPath: path.resolve(__dirname, '../tools/crawler/app/faster_whisper_asr.py'),
      sourcePath,
      resultPath: path.join(directory, 'result.json'),
      modelRoot: directory,
      workDir: directory,
      stallTimeoutMs: 25,
      allowUnsafeTimeoutForTest: true,
      spawnImpl() { return fakeChild(() => { killed = true; }); }
    }), (error) => error.code === 'FASTER_WHISPER_STALLED');
    assert.equal(killed, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Python worker contains ViralCrawl recovery contracts', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../tools/crawler/app/faster_whisper_asr.py'), 'utf8');
  assert.match(source, /vad_retry_selected/);
  assert.match(source, /needsCpuResume=True/);
  assert.match(source, /device, compute_type = "cpu", "int8"/);
  assert.match(source, /HALLUCINATION_MARKERS/);
  assert.match(source, /GpuFileLock/);
  assert.match(source, /inputMode.*original_media/);
});

test('watchdog failure resumes the same Faster Whisper checkpoint on CPU', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faster-whisper-resume-'));
  const calls = [];
  try {
    const result = await transcribeAudio({
      workDir: directory,
      resultPath: path.join(directory, 'result.json'),
      device: 'auto',
      language: 'zh',
      durationSeconds: 4,
      async runWorker(options) {
        calls.push(options.device);
        if (calls.length === 1) {
          const error = new Error('stalled');
          error.code = 'FASTER_WHISPER_STALLED';
          throw error;
        }
        fs.writeFileSync(options.resultPath, JSON.stringify({
          language: 'zh', duration: 4,
          segments: [{ start: 0, end: 3, text: '继续已有进度' }]
        }));
      }
    });
    assert.deepEqual(calls, ['auto', 'cpu']);
    assert.equal(result.text, '继续已有进度');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Faster Whisper quality gate rejects wrong-script Chinese output', () => {
  const result = validateFasterWhisperResult({
    language: 'zh',
    duration: 20,
    segments: [{ start: 0, end: 10, text: 'this is clearly an english hallucination in chinese mode' }]
  }, { language: 'zh', durationSeconds: 20 });
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes('wrong_script'));
});

test('Faster Whisper quality gate rejects timestamps outside video duration', () => {
  const result = validateFasterWhisperResult({
    language: 'vi',
    duration: 10,
    segments: [{ start: 9, end: 15, text: 'xin chào' }]
  }, { durationSeconds: 10 });
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes('past_duration:0'));
});

test('Faster Whisper adapter writes readable SRT and ASR metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faster-whisper-'));
  const resultPath = path.join(directory, 'result.json');
  const outputPath = path.join(directory, 'audio.srt');
  try {
    const result = await transcribeToSrt({
      workDir: directory,
      resultPath,
      outputPath,
      language: 'zh',
      durationSeconds: 8,
      async runWorker(options) {
        fs.writeFileSync(options.resultPath, JSON.stringify({
          model: 'large-v3-turbo',
          device: 'cuda',
          computeType: 'int8_float16',
          language: 'zh',
          duration: 8,
          segments: [
            { start: 0.2, end: 2.5, text: '这是第一句话', words: [] },
            { start: 3, end: 5.5, text: '这是第二句话', words: [] }
          ]
        }));
      }
    });
    assert.equal(result.cues.length, 2);
    assert.match(fs.readFileSync(outputPath, 'utf8'), /这是第一句话/);
    const metadata = JSON.parse(fs.readFileSync(`${outputPath}.asr.json`, 'utf8'));
    assert.equal(metadata.engineId, 'faster-whisper');
    assert.equal(metadata.device, 'cuda');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
