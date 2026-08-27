const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { getViralOcrStatus, probeChineseHardsub, runViralOcr } = require('../lib/viral-ocr-helper');

function preparePaths(root) {
  const appRoot = path.join(root, 'app');
  const runtimeRoot = path.join(root, 'runtime');
  const moduleRoot = path.join(appRoot, 'viral_ocr');
  const python = path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(python, 'python');
  fs.writeFileSync(path.join(runtimeRoot, 'ocr-runtime-v3.json'), '{}');
  for (const filename of [
    'viral_ocr_cli.py',
    'dai_sub_rapid.py',
    'ocr_text.py',
    'zhcdict.json',
    'chat_luong.py',
    'thong_tin_may.py',
    'chan_doan_loi.py',
    'phu_de.py',
    'cai_gpu.py'
  ]) {
    fs.writeFileSync(path.join(moduleRoot, filename), '# test');
  }
  return { bundledRoot: root, userRoot: root, runtimeRoot, appRoot, python };
}

function fakeProcess(onStart) {
  const process = new EventEmitter();
  process.pid = 456;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  queueMicrotask(() => onStart(process));
  return process;
}

test('Viral OCR status requires project runtime marker and all copied pipeline modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-ocr-status-'));
  try {
    const options = preparePaths(root);
    assert.equal(getViralOcrStatus(options).ready, true);
    fs.rmSync(path.join(options.appRoot, 'viral_ocr', 'ocr_text.py'));
    const status = getViralOcrStatus(options);
    assert.equal(status.ready, false);
    assert.match(status.missing.join(' '), /ocr_text\.py/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Viral OCR runner invokes the copied Python pipeline and forwards progress', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-ocr-run-'));
  try {
    const pathOptions = preparePaths(root);
    const outputPath = path.join(root, 'work', 'ocr.srt');
    const reportPath = path.join(root, 'work', 'report.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const progress = [];
    let invocation;
    const result = await runViralOcr({
      videoPath: path.join(root, 'video.mp4'),
      outputPath,
      reportPath,
      device: 'gpu',
      model: 'v6-medium',
      excludedRegions: [{ x0: 0, y0: 0, x1: 0.2, y1: 0.1, t0: 0, t1: 5 }],
      pathOptions,
      onProgress: (event) => progress.push(event),
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        return fakeProcess((child) => {
          fs.writeFileSync(outputPath, '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
          fs.writeFileSync(reportPath, '{"cueCount":3,"blurBoxes":[]}');
          child.stdout.write('{"stage":"progress","pct":55}\n');
          child.stdout.write('{"stage":"result","cues":3,"boxes":2}\n');
          child.stdout.end();
          child.emit('close', 0);
        });
      }
    });

    assert.equal(result.kind, 'success');
    assert.equal(invocation.command, pathOptions.python);
    assert.ok(invocation.args.includes('v6-medium'));
    assert.ok(invocation.args.includes('gpu'));
    assert.ok(invocation.args.includes('--exclude-regions'));
    assert.equal(invocation.options.env.OCR_DUNG_GPU, '1');
    assert.equal(invocation.options.env.OCR_GOP_DAI, '10');
    assert.equal(invocation.options.env.CHE_SONGNGU, '0');
    assert.equal(progress[0].pct, 55);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RapidOCR hardsub probe samples 20 frames and returns the Han conclusion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-ocr-probe-'));
  try {
    const pathOptions = preparePaths(root);
    let invocation;
    const result = await probeChineseHardsub({
      videoPath: path.join(root, 'video.mp4'),
      pathOptions,
      spawnImpl: (command, args) => {
        invocation = { command, args };
        return fakeProcess((child) => {
          child.stdout.write('{"stage":"probe_result","hasHan":true,"conclusive":true,"frames":20,"minimumBoxes":3}\n');
          child.stdout.end();
          child.emit('close', 0);
        });
      }
    });
    assert.equal(invocation.command, pathOptions.python);
    assert.ok(invocation.args.includes('--probe-only'));
    assert.equal(invocation.args[invocation.args.indexOf('--probe-frames') + 1], '20');
    assert.deepEqual(result, { hasHan: true, conclusive: true, frames: 20, minimumBoxes: 3 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RapidOCR defaults to CPU and forwards finalized cues without treating them as final output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-ocr-defaults-'));
  try {
    const pathOptions = preparePaths(root);
    const outputPath = path.join(root, 'work', 'ocr.srt');
    const reportPath = path.join(root, 'work', 'report.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const progress = [];
    let invocation;
    await runViralOcr({
      videoPath: 'video.mp4', outputPath, reportPath, pathOptions,
      onProgress: (event) => progress.push(event),
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        return fakeProcess((child) => {
          fs.writeFileSync(outputPath, '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
          fs.writeFileSync(reportPath, '{"cueCount":1,"blurBoxes":[]}');
          child.stdout.write('{"stage":"finalized","cue":1,"start":0,"end":1,"text":"你好"}\n');
          child.stdout.write('{"stage":"result","cues":1,"boxes":1}\n');
          child.stdout.end();
          child.emit('close', 0);
        });
      }
    });
    assert.ok(invocation.args.includes('cpu'));
    assert.equal(invocation.options.env.OCR_DUNG_GPU, '0');
    assert.equal(progress[0].kind, 'finalized');
    assert.equal(progress[0].text, '你好');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Viral OCR runner forwards the actual RapidOCR device log to the UI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-ocr-device-log-'));
  try {
    const pathOptions = preparePaths(root);
    const outputPath = path.join(root, 'work', 'ocr.srt');
    const reportPath = path.join(root, 'work', 'report.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const progress = [];
    await runViralOcr({
      videoPath: 'video.mp4', outputPath, reportPath, pathOptions,
      onProgress: (event) => progress.push(event),
      spawnImpl: () => fakeProcess((child) => {
        fs.writeFileSync(outputPath, '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
        fs.writeFileSync(reportPath, '{"cueCount":1,"blurBoxes":[]}');
        child.stdout.write('LOG:👁 RapidOCR GPU đang hoạt động (CUDAExecutionProvider).\n');
        child.stdout.write('{"stage":"result","cues":1,"boxes":1}\n');
        child.stdout.end();
        child.emit('close', 0);
      })
    });
    assert.equal(progress[0].kind, 'log');
    assert.match(progress[0].message, /RapidOCR GPU/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Viral OCR runner preserves a zero-cue report as a confirmed no-subtitles result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-ocr-empty-'));
  try {
    const pathOptions = preparePaths(root);
    const outputPath = path.join(root, 'work', 'ocr.srt');
    const reportPath = path.join(root, 'work', 'report.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const result = await runViralOcr({
      videoPath: 'video.mp4',
      outputPath,
      reportPath,
      pathOptions,
      spawnImpl: () => fakeProcess((child) => {
        fs.writeFileSync(outputPath, '');
        fs.writeFileSync(reportPath, '{"cueCount":0,"blurBoxes":[]}');
        child.stdout.write('{"stage":"result","cues":0,"boxes":0}\n');
        child.stdout.end();
        child.emit('close', 2);
      })
    });
    assert.equal(result.kind, 'no_subtitles');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
