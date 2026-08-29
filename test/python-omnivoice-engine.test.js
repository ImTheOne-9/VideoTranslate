'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PythonOmniVoiceEngine,
  chooseBatch,
  groupBatchItems
} = require('../lib/voice-engines/python-omnivoice-engine');

function writeSilentWav(filePath) {
  const dataSize = 4800;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

test('OmniVoice diffusion batch scales from free VRAM without exceeding total VRAM', () => {
  assert.equal(chooseBatch({ totalGb: 4, freeGb: 3 }), 8);
  assert.equal(chooseBatch({ totalGb: 8, freeGb: 5 }), 16);
  assert.equal(chooseBatch({ totalGb: 16, freeGb: 10 }), 24);
  assert.equal(chooseBatch({ totalGb: 16, freeGb: 15 }), 32);
});

test('OmniVoice groups native batches by language and clone prompt', () => {
  const groups = groupBatchItems([
    { text: 'a', language: 'vi', referenceAudioPath: 'female.wav', referenceText: 'mẫu' },
    { text: 'b', language: 'vi', referenceAudioPath: 'female.wav', referenceText: 'mẫu' },
    { text: 'c', language: 'vi', referenceAudioPath: 'male.wav', referenceText: 'mẫu nam' }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 2);
  assert.equal(groups[1].length, 1);
});

test('OmniVoice materializes a fixed bundled reference when no sample is selected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-omni-default-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'bundle', 'public', 'default_voices');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'Giọng Nữ miền Bắc.wav'), Buffer.alloc(100));
  fs.writeFileSync(path.join(sourceRoot, 'Giọng Nữ miền Bắc.txt'), 'Đây là giọng nữ mặc định.');
  const ffmpegPath = path.join(root, 'ffmpeg.exe');
  fs.writeFileSync(ffmpegPath, 'fake');
  const engine = new PythonOmniVoiceEngine({
    paths: {
      root: path.join(root, 'runtime'),
      runtimeRoot: path.join(root, 'runtime'),
      bundledRoot: path.join(root, 'bundle'),
      ffmpegPath,
      queueRoot: path.join(root, 'queue')
    },
    execFileSync: (_command, args) => writeSilentWav(args.at(-1)),
    logger: { log() {}, warn() {} }
  });
  const { job } = engine.createJob([{ text: 'Xin chào', language: 'vi' }], 8);
  assert.equal(job.defaultReference, true);
  assert.match(job.referenceAudioPath, /nu\.wav$/);
  assert.equal(job.referenceText, 'Đây là giọng nữ mặc định.');
  assert.equal(job.instruct, null);
});

test('Python OmniVoice performs one native batch and maps WAV files to original cue order', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-omni-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const python = path.join(root, 'venv', 'Scripts', 'python.exe');
  const worker = path.join(root, 'omnivoice_batch_worker.py');
  const marker = path.join(root, 'runtime-v1.json');
  const sitePackages = path.join(root, 'venv', 'Lib', 'site-packages');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'placeholder');
  fs.writeFileSync(worker, '# placeholder');
  for (const packagePath of ['torch', path.join('torch', 'nn'), 'torchaudio', 'omnivoice']) {
    fs.mkdirSync(path.join(sitePackages, packagePath), { recursive: true });
  }
  fs.writeFileSync(marker, JSON.stringify({
    version: 2,
    cudaInferenceVerified: true,
    modelInferenceVerified: true,
    runtimeHealthVerified: true,
    dllPathSanitized: true
  }));
  const engine = new PythonOmniVoiceEngine({
    paths: {
      root,
      runtimeRoot: root,
      python,
      worker,
      marker,
      sitePackages,
      torchPackage: path.join(sitePackages, 'torch'),
      torchNnPackage: path.join(sitePackages, 'torch', 'nn'),
      torchaudioPackage: path.join(sitePackages, 'torchaudio'),
      omnivoicePackage: path.join(sitePackages, 'omnivoice'),
      hfHome: path.join(root, 'hf'),
      queueRoot: path.join(root, 'queue'),
      ffmpegPath: '', nodePath: '', userRoot: root, browserDataDir: root, dataDir: root,
      loginStatusPath: path.join(root, 'login.json'), playwrightBrowsersDir: root
    },
    vramInfo: () => ({ totalGb: 8, freeGb: 7, name: 'Test GPU' }),
    logger: { log() {}, warn() {} }
  });
  let calls = 0;
  engine.runOneShot = async (job) => {
    calls += 1;
    job.texts.forEach((_, index) => writeSilentWav(path.join(job.outputDir, `seg_${index}.wav`)));
    return { ok: job.texts.length, total: job.texts.length };
  };
  const outputs = [path.join(root, 'out', 'b.wav'), path.join(root, 'out', 'a.wav')];
  const results = await engine.synthesizeBatch({
    items: [
      { key: 'b', text: 'Câu hai', outputPath: outputs[0], language: 'vi', referenceAudioPath: 'ref.wav', referenceText: 'mẫu' },
      { key: 'a', text: 'Câu một', outputPath: outputs[1], language: 'vi', referenceAudioPath: 'ref.wav', referenceText: 'mẫu' }
    ]
  });
  assert.equal(calls, 1);
  assert.deepEqual(results.map((item) => item.key), ['b', 'a']);
  assert.ok(results.every((item) => item.ok && item.result.nativeBatch));
  assert.ok(outputs.every((filePath) => fs.existsSync(filePath)));
});

test('OmniVoice retries the complete group with one-shot when daemon coverage is too low', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-omni-rescue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = new PythonOmniVoiceEngine({
    paths: { root, runtimeRoot: root, queueRoot: path.join(root, 'queue') },
    vramInfo: () => ({ totalGb: 8, freeGb: 8, name: 'Test GPU' }),
    logger: { log() {}, warn() {} }
  });
  let daemonCalls = 0;
  let oneShotCalls = 0;
  engine.runDaemon = async (job) => {
    daemonCalls += 1;
    writeSilentWav(path.join(job.outputDir, 'seg_0.wav'));
    return { ok: 1, total: 2, audibleIndices: [0] };
  };
  engine.stopSession = async () => {};
  engine.runOneShot = async (job) => {
    oneShotCalls += 1;
    job.texts.forEach((_, index) => writeSilentWav(path.join(job.outputDir, `seg_${index}.wav`)));
    return { ok: 2, total: 2, audibleIndices: [0, 1] };
  };
  const results = await engine.synthesizeGroup([
    { text: 'Một', outputPath: path.join(root, 'a.wav'), language: 'vi' },
    { text: 'Hai', outputPath: path.join(root, 'b.wav'), language: 'vi' }
  ]);
  assert.equal(daemonCalls, 1);
  assert.equal(oneShotCalls, 1);
  assert.ok(results.every((entry) => entry.ok));
});
