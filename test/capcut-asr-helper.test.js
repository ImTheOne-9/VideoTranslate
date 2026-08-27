'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { normalizeCues, runWorker, transcribeToSrt } = require('../lib/capcut-asr-helper');

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'capcut-asr-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('CapCut cue normalization removes invalid cues and prevents overlap', () => {
  assert.deepEqual(normalizeCues([
    { startMs: 100, endMs: 900, text: ' Câu một ' },
    { startMs: 800, endMs: 1_500, text: 'Câu hai' },
    { startMs: 1_600, endMs: 1_500, text: 'mốc lỗi' },
    { startMs: 1_700, endMs: 2_500, text: 'quá cuối video' }
  ], 2_000), [
    { startMs: 100, endMs: 900, text: 'Câu một' },
    { startMs: 900, endMs: 1_500, text: 'Câu hai' },
    { startMs: 1_700, endMs: 2_000, text: 'quá cuối video' }
  ]);
});

test('CapCut adapter writes SRT plus an auditable online-ASR sidecar', async () => {
  await withTempDirectory(async (workDir) => {
    const result = await transcribeToSrt({
      videoPath: path.join(workDir, 'source.mp4'),
      workDir,
      ffmpegPath: path.join(workDir, 'ffmpeg.exe'),
      durationMs: 3_000,
      language: 'ch',
      runWorker: async ({ resultPath }) => {
        await fs.writeFile(resultPath, JSON.stringify({
          language: 'ch',
          languageConfidence: null,
          cues: [
            { startMs: 0, endMs: 1_000, text: '第一句' },
            { startMs: 1_100, endMs: 2_200, text: '第二句' }
          ]
        }), 'utf8');
      }
    });
    const srt = await fs.readFile(result.path, 'utf8');
    const metadata = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'));
    assert.match(srt, /第一句/u);
    assert.equal(metadata.engineId, 'capcut-asr');
    assert.equal(metadata.online, true);
    assert.equal(metadata.uploadedAudio, true);
    assert.equal(metadata.cues.length, 2);
  });
});

test('CapCut worker retries with a fresh device and classifies network failures', async () => {
  await withTempDirectory(async (workDir) => {
    const sourcePath = path.join(workDir, 'source.mp4');
    const ffmpegPath = path.join(workDir, 'ffmpeg.exe');
    await fs.writeFile(sourcePath, 'media');
    await fs.writeFile(ffmpegPath, 'ffmpeg');
    let receivedArgs;
    await assert.rejects(runWorker({
      pythonPath: __filename,
      workerPath: path.resolve(__dirname, '../tools/crawler/app/capcut_asr.py'),
      videoPath: sourcePath,
      resultPath: path.join(workDir, 'result.json'),
      ffmpegPath,
      attempts: 2,
      spawnImpl(command, args) {
        receivedArgs = args;
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        queueMicrotask(() => {
          child.stdout.write('{"event":"error","category":"network","message":"offline"}\n');
          child.stdout.end();
          child.emit('close', 1);
        });
        return child;
      }
    }), (error) => error.code === 'CAPCUT_ASR_NETWORK');
    assert.equal(receivedArgs[receivedArgs.indexOf('--attempts') + 1], '2');
  });
});
