const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const vad = require('../lib/silero-vad-helper');
const whisper = require('../lib/whisper-onnx-helper');

test('pads, merges, and clips nearby speech regions', () => {
  const regions = vad.mergeSpeechRegions([
    { startSample: 1000, endSample: 3000 },
    { startSample: 5000, endSample: 7000 },
    { startSample: 15000, endSample: 17000 }
  ], 18000, {
    speechPadMs: 100,
    mergeGapMs: 50,
    maxSegmentSeconds: Number.POSITIVE_INFINITY
  });

  assert.deepEqual(regions, [
    { startSample: 0, endSample: 8600 },
    { startSample: 13400, endSample: 18000 }
  ]);
});

test('splits an unusually long continuous region only when a maximum is configured', () => {
  const regions = vad.mergeSpeechRegions([
    { startSample: 0, endSample: 48000 }
  ], 48000, {
    speechPadMs: 0,
    mergeGapMs: 0,
    maxSegmentSeconds: 1
  });

  assert.deepEqual(regions, [
    { startSample: 0, endSample: 16000 },
    { startSample: 16000, endSample: 32000 },
    { startSample: 32000, endSample: 48000 }
  ]);
});

test('returns no Whisper chunks when VAD confirms that audio contains no speech', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-vad-empty-'));
  const required = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    path.join('onnx', 'encoder_model_quantized.onnx'),
    path.join('onnx', 'decoder_model_merged_quantized.onnx')
  ];
  for (const file of required) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }

  const original = vad.detectSpeechRegions;
  vad.detectSpeechRegions = async () => ({
    durationSeconds: 12,
    speechSeconds: 0,
    regions: []
  });
  try {
    const stages = [];
    const result = await whisper.transcribeAudio({
      audioPath: path.join(directory, 'audio.wav'),
      modelPath: directory,
      variant: 'q8',
      onStage: (event) => stages.push(event.stage)
    });
    assert.deepEqual(result.chunks, []);
    assert.deepEqual(result.vad, {
      enabled: true,
      durationSeconds: 12,
      speechSeconds: 0,
      regionCount: 0
    });
    assert.deepEqual(stages, ['vad_analyzing', 'vad_complete']);
  } finally {
    vad.detectSpeechRegions = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelled VAD does not fall back to full-file Whisper', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-vad-cancelled-'));
  const required = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    path.join('onnx', 'encoder_model_quantized.onnx'),
    path.join('onnx', 'decoder_model_merged_quantized.onnx')
  ];
  for (const file of required) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }

  let inferenceStarted = false;
  const cancellation = new Error('cancelled');
  cancellation.code = 'VAD_CANCELLED';
  try {
    await assert.rejects(whisper.transcribeAudio({
      audioPath: path.join(directory, 'audio.wav'),
      modelPath: directory,
      variant: 'q8',
      detectSpeechRegions: async () => {
        throw cancellation;
      },
      runWorker: async () => {
        inferenceStarted = true;
        return {};
      }
    }), (error) => error.code === 'VAD_CANCELLED');
    assert.equal(inferenceStarted, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('packaging includes the Silero ONNX model as an external resource', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const toolResource = packageJson.build.extraResources.find((entry) => entry.from === 'tools/');
  assert.ok(toolResource.filter.includes('silero-vad/silero_vad.onnx'));
});

function createFakeVadChild(onSend) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.send = (message) => onSend(message, child);
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  };
  return child;
}

test('runs Silero VAD in a child process and forwards progress', async () => {
  const progress = [];
  let forkPath;
  let forkOptions;
  let sentJob;
  const result = await vad.detectSpeechRegions('audio.wav', {
    modelPath: 'silero.onnx',
    modulePaths: {
      onnxruntimeModulePath: 'ort-module',
      wavefileModulePath: 'wavefile-module'
    },
    onProgress: (percent) => progress.push(percent),
    forkImpl(workerPath, args, options) {
      forkPath = workerPath;
      forkOptions = options;
      return createFakeVadChild((job, child) => {
        sentJob = job;
        setImmediate(() => {
          child.emit('message', { type: 'progress', percent: 45 });
          child.emit('message', {
            type: 'result',
            result: {
              durationSeconds: 3,
              speechSeconds: 1,
              regions: [{ start: 1, end: 2 }]
            }
          });
        });
      });
    }
  });

  assert.match(forkPath, /silero-vad-child-runtime\.js$/);
  assert.equal(forkOptions.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(forkOptions.serialization, 'advanced');
  assert.equal(sentJob.audioPath, 'audio.wav');
  assert.equal(sentJob.modelPath, 'silero.onnx');
  assert.equal(sentJob.onnxruntimeModulePath, 'ort-module');
  assert.deepEqual(progress, [45]);
  assert.deepEqual(result.regions, [{ start: 1, end: 2 }]);
  assert.equal(result.regions[0].samples, undefined);
});

test('owner cancellation terminates an active VAD child', async () => {
  let child;
  const pending = vad.detectSpeechRegions('audio.wav', {
    owner: 'render-1',
    modelPath: 'silero.onnx',
    modulePaths: {
      onnxruntimeModulePath: 'ort-module',
      wavefileModulePath: 'wavefile-module'
    },
    forkImpl() {
      child = createFakeVadChild(() => {});
      return child;
    }
  });

  assert.equal(vad.cancelVadWorker('render-1'), true);
  await assert.rejects(pending, (error) => error.code === 'VAD_CANCELLED');
  assert.equal(child.killed, true);
  assert.equal(vad.cancelVadWorker('render-1'), false);
});

test('packaging and obfuscation include the VAD child runtime', () => {
  const root = path.join(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const obfuscateSource = fs.readFileSync(path.join(root, 'obfuscate.js'), 'utf8');
  const helperSource = fs.readFileSync(path.join(root, 'lib', 'silero-vad-helper.js'), 'utf8');

  assert.ok(packageJson.build.files.includes('silero-vad-child-runtime.js'));
  assert.match(obfuscateSource, /silero-vad-child-runtime\.js/);
  assert.match(helperSource, /childProcess\.fork|forkImpl/);
  assert.match(helperSource, /ELECTRON_RUN_AS_NODE:\s*'1'/);
});

test('real VAD child keeps the parent event loop responsive', {
  skip: !fs.existsSync(vad.resolveVadModelPath())
}, async () => {
  const { WaveFile } = require('wavefile');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silero-vad-child-'));
  const audioPath = path.join(directory, 'silence.wav');
  const wav = new WaveFile();
  wav.fromScratch(1, 16000, '16', new Int16Array(16000));
  fs.writeFileSync(audioPath, wav.toBuffer());

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);
  try {
    const result = await vad.detectSpeechRegions(audioPath);
    assert.equal(result.durationSeconds, 1);
    assert.deepEqual(result.regions, []);
    assert.ok(ticks >= 5, `parent event loop ticked only ${ticks} times`);
  } finally {
    clearInterval(timer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
