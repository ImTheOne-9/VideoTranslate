const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const {
  combineRegionResults,
  chunksToSrt,
  formatSrtTime,
  normalizeWhisperChunks,
  normalizeLanguage,
  normalizeWhisperLanguage,
  resolveWorkerModulePaths,
  transcribeAudio,
  transcribeToSrt
} = require('../lib/whisper-onnx-helper');
const { getWhisperOnnxConfig } = require('../lib/model-downloader');

test('production runtime no longer references the legacy Whisper CLI', () => {
  const root = path.join(__dirname, '..');
  const files = [
    'package.json',
    'lib/whisper-helper.js',
    'lib/model-downloader.js',
    'lib/shared-state.js',
    'controllers/systemController.js'
  ];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

  assert.doesNotMatch(source, /whisper\.cpp|whisper-cli|WHISPER_ENGINE|ensureWhisperModelExist/i);
});

test('eval worker loads Transformers.js and wavefile from resolved module paths', async () => {
  const modulePaths = resolveWorkerModulePaths();
  assert.equal(path.isAbsolute(modulePaths.transformersModulePath), true);
  assert.equal(path.isAbsolute(modulePaths.wavefileModulePath), true);

  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('worker_threads');
      try {
        const transformers = require(workerData.transformersModulePath);
        const wavefile = require(workerData.wavefileModulePath);
        parentPort.postMessage({
          pipeline: typeof transformers.pipeline,
          waveFile: typeof wavefile.WaveFile
        });
      } catch (error) {
        parentPort.postMessage({ error: error.stack || error.message });
      }
    `, { eval: true, workerData: modulePaths });
    worker.once('message', resolve);
    worker.once('error', reject);
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(result, { pipeline: 'function', waveFile: 'function' });
});

test('packaged child dependencies prefer app.asar.unpacked paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'whisper-onnx-helper.js'), 'utf8');
  assert.match(source, /app\.asar\.unpacked/);
  assert.match(source, /fs\.existsSync\(unpackedPath\)/);
});

test('packaging unpacks worker dependencies alongside ONNX Runtime', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.build.asarUnpack, [
    'node_modules/onnxruntime-node/**/*',
    'node_modules/onnxruntime-common/**/*',
    'node_modules/@huggingface/transformers/**/*',
    'node_modules/sharp/**/*',
    'node_modules/@img/**/*',
    'node_modules/detect-libc/**/*',
    'node_modules/semver/**/*',
    'node_modules/wavefile/**/*'
  ]);
  assert.ok(packageJson.build.files.includes('whisper-onnx-child-runtime.js'));
});

test('isolates each Whisper inference from the Electron process', () => {
  const root = path.join(__dirname, '..');
  const helperSource = fs.readFileSync(path.join(root, 'lib', 'whisper-onnx-helper.js'), 'utf8');
  const poolSource = fs.readFileSync(path.join(root, 'lib', 'whisper-worker-pool.js'), 'utf8');
  const childSource = fs.readFileSync(path.join(root, 'lib', 'whisper-onnx-child.js'), 'utf8');

  assert.match(poolSource, /childProcess\.fork/);
  assert.match(helperSource, /whisper-onnx-child-runtime\.js/);
  assert.match(helperSource, /ELECTRON_RUN_AS_NODE:\s*'1'/);
  assert.match(helperSource, /serialization:\s*'advanced'/);
  assert.match(childSource, /process\.on\('message'/);
  assert.match(childSource, /model_reused/);
  assert.equal(fs.existsSync(path.join(root, 'whisper-onnx-child-runtime.js')), true);
});

test('defines separate Small Q8, Small FP32, and Medium Q8 model files', () => {
  const q8 = getWhisperOnnxConfig('q8');
  const fp32 = getWhisperOnnxConfig('fp32');
  const mediumQ8 = getWhisperOnnxConfig('medium-q8');

  assert.equal(q8.folder, 'onnx-small-timestamped');
  assert.equal(q8.modelSize, 'small');
  assert.equal(q8.dtype, 'q8');
  assert.ok(q8.files.some((file) => file.name === 'onnx/encoder_model_quantized.onnx'));
  assert.ok(q8.files.some((file) => file.name === 'onnx/decoder_model_merged_quantized.onnx'));
  assert.equal(fp32.folder, 'onnx-small-timestamped-fp32');
  assert.equal(fp32.modelSize, 'small');
  assert.equal(fp32.dtype, 'fp32');
  assert.ok(fp32.files.some((file) => file.name === 'onnx/encoder_model.onnx'));
  assert.ok(fp32.files.some((file) => file.name === 'onnx/decoder_model_merged.onnx'));
  assert.ok(fp32.files.reduce((sum, file) => sum + file.size, 0) > 900 * 1024 * 1024);
  assert.equal(mediumQ8.repo, 'onnx-community/whisper-medium_timestamped');
  assert.equal(mediumQ8.folder, 'onnx-medium-timestamped');
  assert.equal(mediumQ8.modelSize, 'medium');
  assert.equal(mediumQ8.dtype, 'q8');
  assert.ok(mediumQ8.files.some((file) => file.name === 'onnx/encoder_model_quantized.onnx'));
  assert.ok(mediumQ8.files.some((file) => file.name === 'onnx/decoder_model_merged_quantized.onnx'));
  assert.ok(mediumQ8.files.reduce((sum, file) => sum + file.size, 0) > 940 * 1024 * 1024);
});

test('rejects unsupported ONNX variants before starting a worker', async () => {
  await assert.rejects(
    transcribeAudio({ variant: 'invalid', modelPath: '.', audioPath: 'audio.wav' }),
    /không hợp lệ/i
  );
});

test('maps application language identifiers to Whisper language names', () => {
  assert.equal(normalizeLanguage('ch'), 'chinese');
  assert.equal(normalizeLanguage('vi'), 'vietnamese');
  assert.equal(normalizeLanguage('en'), 'english');
  assert.equal(normalizeLanguage('japan'), 'japanese');
  assert.equal(normalizeLanguage('korean'), 'korean');
  assert.equal(normalizeLanguage(), 'vietnamese');
  assert.equal(normalizeWhisperLanguage('auto'), null);
  assert.equal(normalizeWhisperLanguage('ch'), 'chinese');
});

test('Whisper child supports word timestamps and locks one detected language', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['lib/whisper-onnx-child.js', 'whisper-onnx-child-runtime.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /timestampLevel === 'word' \? 'word' : true/);
    assert.match(source, /const lockedLanguage = job\.language \|\| detectedLanguage/);
    assert.match(source, /type: 'language_detected'/);
  }
});

test('auto language is detected once, persisted, and locked across resumed VAD regions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-language-lock-'));
  try {
    const modelPath = path.join(directory, 'model');
    const checkpointPath = path.join(directory, 'regions.json');
    fs.mkdirSync(path.join(modelPath, 'onnx'), { recursive: true });
    for (const file of [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ]) fs.writeFileSync(path.join(modelPath, file), '{}');

    const baseOptions = {
      variant: 'q8',
      validateModel: () => ({ ready: true }),
      modelPath,
      audioPath: path.join(directory, 'audio.wav'),
      checkpointPath,
      checkpointKey: 'language-lock',
      language: 'auto',
      detectSpeechRegions: async () => ({
        durationSeconds: 2,
        speechSeconds: 2,
        regions: [
          { start: 0, end: 1, samples: new Float32Array([0.1]) },
          { start: 1, end: 2, samples: new Float32Array([0.2]) }
        ]
      })
    };

    await assert.rejects(transcribeAudio({
      ...baseOptions,
      runWorker: async (job) => {
        assert.equal(job.language, null);
        assert.equal(job.detectLanguage, true);
        job.onLanguageDetected({ language: 'vi', confidence: 0.91 });
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: { text: 'một', chunks: [{ timestamp: [0, 1], text: 'một' }] }
        });
        throw new Error('simulated interruption');
      }
    }), /simulated interruption/);

    const result = await transcribeAudio({
      ...baseOptions,
      detectSpeechRegions: async () => { throw new Error('VAD must be reused'); },
      loadCheckpointSamples: (audioPath, regions) => regions.map((region) => ({
        ...region,
        samples: new Float32Array([0.3])
      })),
      runWorker: async (job) => {
        assert.equal(job.language, 'vi');
        assert.equal(job.detectLanguage, false);
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: { text: 'hai', chunks: [{ timestamp: [1, 2], text: 'hai' }] }
        });
        return {};
      }
    });

    assert.equal(result.language, 'vi');
    assert.equal(result.languageConfidence, 0.91);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    assert.deepEqual(checkpoint.language, { value: 'vi', confidence: 0.91 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('combines persisted Whisper region results in original order', () => {
  const result = combineRegionResults({
    2: { text: 'ba', chunks: [{ timestamp: [2, 3], text: 'ba' }] },
    0: { text: 'một', chunks: [{ timestamp: [0, 1], text: 'một' }] },
    1: { text: 'hai', chunks: [{ timestamp: [1, 2], text: 'hai' }] }
  }, { enabled: true, regionCount: 3 });

  assert.equal(result.text, 'một hai ba');
  assert.deepEqual(result.chunks.map((chunk) => chunk.text), ['một', 'hai', 'ba']);
  assert.equal(result.vad.regionCount, 3);
});

test('Whisper child reports each completed VAD region for checkpointing', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['lib/whisper-onnx-child.js', 'whisper-onnx-child-runtime.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /type:\s*'region_result'/);
    assert.match(source, /checkpointIndex/);
    assert.match(source, /checkpointTotal/);
  }
});

test('Whisper resumes from the first unfinished VAD region', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-region-resume-'));
  try {
    const modelPath = path.join(directory, 'model');
    const checkpointPath = path.join(directory, 'regions.json');
    fs.mkdirSync(path.join(modelPath, 'onnx'), { recursive: true });
    for (const file of [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ]) {
      fs.writeFileSync(path.join(modelPath, file), '{}');
    }

    const baseOptions = {
      variant: 'q8',
      validateModel: () => ({ ready: true }),
      modelPath,
      audioPath: path.join(directory, 'audio.wav'),
      checkpointPath,
      checkpointKey: 'same-input',
      device: 'cpu',
      detectSpeechRegions: async () => ({
        durationSeconds: 2,
        speechSeconds: 2,
        regions: [
          { start: 0, end: 1, samples: new Float32Array([0.1]) },
          { start: 1, end: 2, samples: new Float32Array([0.2]) }
        ]
      })
    };

    await assert.rejects(transcribeAudio({
      ...baseOptions,
      runWorker: async (job) => {
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: { text: 'một', chunks: [{ timestamp: [0, 1], text: 'một' }] }
        });
        throw new Error('simulated app exit');
      }
    }), /simulated app exit/);

    let resumedRegions;
    const result = await transcribeAudio({
      ...baseOptions,
      detectSpeechRegions: async () => {
        throw new Error('VAD must be reused');
      },
      loadCheckpointSamples: (audioPath, regions) => regions.map((region) => ({
        ...region,
        samples: new Float32Array([0.3])
      })),
      runWorker: async (job) => {
        resumedRegions = job.speechRegions.map((region) => region.checkpointIndex);
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: { text: 'hai', chunks: [{ timestamp: [1, 2], text: 'hai' }] }
        });
        return { text: 'hai', chunks: [] };
      }
    });

    assert.deepEqual(resumedRegions, [1]);
    assert.equal(result.text, 'một hai');
    assert.deepEqual(result.chunks.map((chunk) => chunk.text), ['một', 'hai']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cached VAD timings are passed to the Whisper child without loading WAV in main', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-vad-timing-only-'));
  try {
    const modelPath = path.join(directory, 'model');
    const checkpointPath = path.join(directory, 'regions.json');
    const audioPath = path.join(directory, 'audio-not-readable-in-main.wav');
    fs.mkdirSync(path.join(modelPath, 'onnx'), { recursive: true });
    for (const file of [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ]) {
      fs.writeFileSync(path.join(modelPath, file), '{}');
    }
    fs.writeFileSync(checkpointPath, JSON.stringify({
      version: 1,
      checkpointKey: 'timing-only',
      vad: {
        metadata: {
          enabled: true,
          durationSeconds: 2,
          speechSeconds: 1,
          regionCount: 1
        },
        regions: [{ start: 0.5, end: 1.5 }]
      },
      regions: {}
    }));

    const result = await transcribeAudio({
      variant: 'q8',
      validateModel: () => ({ ready: true }),
      modelPath,
      audioPath,
      checkpointPath,
      checkpointKey: 'timing-only',
      runWorker: async (job) => {
        assert.deepEqual(job.speechRegions.map(({ start, end, samples }) => ({
          start,
          end,
          hasSamples: samples != null
        })), [{ start: 0.5, end: 1.5, hasSamples: false }]);
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: {
            text: 'xin chao',
            chunks: [{ timestamp: [0.5, 1.5], text: 'xin chao' }]
          }
        });
        return {};
      }
    });

    assert.equal(result.text, 'xin chao');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh VAD passes timing only instead of copying speech samples through the parent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-vad-timing-fresh-'));
  try {
    const modelPath = path.join(directory, 'model');
    fs.mkdirSync(path.join(modelPath, 'onnx'), { recursive: true });
    for (const file of [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ]) fs.writeFileSync(path.join(modelPath, file), '{}');

    let vadOptions;
    const result = await transcribeAudio({
      variant: 'q8',
      validateModel: () => ({ ready: true }),
      modelPath,
      audioPath: path.join(directory, 'audio.wav'),
      language: 'vi',
      detectSpeechRegions: async (audioPath, options) => {
        vadOptions = options;
        return {
          durationSeconds: 2,
          speechSeconds: 1,
          regions: [{ start: 0.5, end: 1.5, samples: new Float32Array([0.1, 0.2]) }]
        };
      },
      runWorker: async (job) => {
        assert.deepEqual(job.speechRegions.map(({ start, end, samples }) => ({
          start,
          end,
          hasSamples: samples != null
        })), [{ start: 0.5, end: 1.5, hasSamples: false }]);
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: { text: 'xin chào', chunks: [{ timestamp: [0.5, 1.5], text: 'xin chào' }] }
        });
        return {};
      }
    });

    assert.equal(vadOptions.includeSamples, false);
    assert.equal(result.text, 'xin chào');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('formats timestamped Whisper chunks as non-overlapping SRT cues', () => {
  const srt = chunksToSrt([
    { timestamp: [0, 1.48], text: ' Câu đầu ' },
    { timestamp: [1.48, 3.44], text: 'Câu sau' }
  ], 3.44);

  assert.equal(srt, [
    '1',
    '00:00:00,000 --> 00:00:01,480',
    'Câu đầu',
    '',
    '2',
    '00:00:01,480 --> 00:00:03,440',
    'Câu sau',
    ''
  ].join('\n'));
});

test('fills a missing chunk end without passing the next cue start', () => {
  const srt = chunksToSrt([
    { timestamp: [2, null], text: 'Một câu khá dài' },
    { timestamp: [3, 4], text: 'Tiếp theo' }
  ]);
  assert.match(srt, /00:00:02,000 --> 00:00:03,000/);
  assert.equal(formatSrtTime(3661.005), '01:01:01,005');
});

test('drops an unreadably dense Whisper chunk at a timestamp boundary', () => {
  const srt = chunksToSrt([
    { timestamp: [124.84, 125.04], text: 'Câu dài bị chia thành nhiều đoạn' },
    { timestamp: [125, 126.2], text: 'Câu kế tiếp' }
  ]);

  assert.equal(srt, [
    '1',
    '00:02:05,000 --> 00:02:06,200',
    'Câu kế tiếp',
    ''
  ].join('\n'));
});

test('removes repeated boundary hallucinations without dropping short valid cues', () => {
  const srt = chunksToSrt([
    { timestamp: [123.24, 124.24], text: 'Wow!' },
    {
      timestamp: [124.76, 124.943],
      text: 'Bạn nhỏ này còn có cơ bụng, vóc dáng này được đấy, mấy tuổi rồi? Tôi thấy hai người như'
    },
    { timestamp: [124.943, 125], text: 'AI vậy, cứ thế ôm lấy nhau.' },
    { timestamp: [126, 129], text: 'Nhỏ tuổi mà đã có cơ bụng, vóc dáng này được đấy.' },
    { timestamp: [129, 130], text: 'Mấy tuổi rồi?' }
  ]);

  assert.match(srt, /00:02:03,240 --> 00:02:04,240\nWow!/);
  assert.doesNotMatch(srt, /Tôi thấy hai người/);
  assert.doesNotMatch(srt, /AI vậy/);
  assert.match(srt, /00:02:06,000 --> 00:02:09,000\nNhỏ tuổi/);
  assert.match(srt, /00:02:09,000 --> 00:02:10,000\nMấy tuổi rồi\?/);
});

test('unwraps adjacent Whisper parenthetical fragments but preserves a normal aside', () => {
  const cues = normalizeWhisperChunks([
    {
      timestamp: [0, 4],
      text: 'Sát thủ. (Tại sao) (lần đầu gặp mặt) (cậu lại không giết tôi?) (Denji-kun,)"'
    },
    {
      timestamp: [4, 6],
      text: '(Thực ra,) (tớ cũng chưa từng nói như vậy.)'
    },
    {
      timestamp: [6, 8],
      text: 'Câu này có một chú thích (giữ nguyên).'
    }
  ]);

  assert.equal(
    cues[0].text,
    'Sát thủ. Tại sao lần đầu gặp mặt cậu lại không giết tôi? Denji-kun,'
  );
  assert.equal(cues[1].text, 'Thực ra, tớ cũng chưa từng nói như vậy.');
  assert.equal(cues[2].text, 'Câu này có một chú thích (giữ nguyên).');
});

test('unwraps adjacent full-width parenthetical fragments from Whisper', () => {
  const [cue] = normalizeWhisperChunks([
    { timestamp: [0, 2], text: '（Thực ra,） （tớ chưa từng nói vậy.）' }
  ]);

  assert.equal(cue.text, 'Thực ra, tớ chưa từng nói vậy.');
});

test('unwraps parenthetical Whisper fragments even without spaces between them', () => {
  const [cue] = normalizeWhisperChunks([
    { timestamp: [0, 2], text: '（Tại sao）（lần đầu gặp mặt）（cậu không giết tôi?）' }
  ]);

  assert.equal(cue.text, 'Tại sao lần đầu gặp mặt cậu không giết tôi?');
});

test('unwraps a run of separately timestamped parenthetical Whisper cues', () => {
  const cues = normalizeWhisperChunks([
    { timestamp: [0, 1], text: '(Tại sao)' },
    { timestamp: [1, 2], text: '(lần đầu gặp mặt)' },
    { timestamp: [2, 3], text: '(cậu lại không giết tôi?)' },
    { timestamp: [3, 4], text: 'Một câu bình thường (có chú thích).' }
  ]);

  assert.deepEqual(
    cues.map((cue) => cue.text),
    ['Tại sao', 'lần đầu gặp mặt', 'cậu lại không giết tôi?', 'Một câu bình thường (có chú thích).']
  );
});

test('normalizes ASR cues with quality metadata without changing timing', () => {
  const [cue] = normalizeWhisperChunks([
    { timestamp: [1, 2], text: ' Xin chào ', confidence: 0.4 }
  ]);
  assert.equal(cue.text, 'Xin chào');
  assert.equal(cue.start, 1);
  assert.equal(cue.end, 2);
  assert.equal(cue.modelConfidence, 0.4);
  assert.ok(cue.warnings.includes('asr_low_confidence'));
});

test('writes backward-compatible SRT plus optional ASR sidecar metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-asr-sidecar-'));
  try {
    const modelPath = path.join(directory, 'model');
    const outputPath = path.join(directory, 'audio.srt');
    fs.mkdirSync(path.join(modelPath, 'onnx'), { recursive: true });
    for (const file of [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ]) {
      fs.writeFileSync(path.join(modelPath, file), '{}');
    }

    const result = await transcribeToSrt({
      variant: 'q8',
      validateModel: () => ({ ready: true }),
      modelPath,
      audioPath: path.join(directory, 'audio.wav'),
      outputPath,
      language: 'auto',
      useVad: false,
      speechRegions: [{ start: 0, end: 2, samples: new Float32Array([0.1]) }],
      runWorker: async (job) => {
        assert.equal(job.language, null);
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: {
            text: 'xin chào',
            chunks: [{ text: 'xin chào', timestamp: [0, 2], confidence: 0.8 }]
          }
        });
        return {};
      }
    });

    assert.equal(fs.existsSync(outputPath), true);
    assert.equal(result.metadataPath, `${outputPath}.asr.json`);
    const metadata = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
    assert.equal(metadata.version, 1);
    assert.equal(metadata.engineId, 'whisper-onnx');
    assert.equal(metadata.languageMode, 'auto');
    assert.equal(metadata.cues[0].qualityScore, 80);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('word timestamp mode writes readable SRT and preserves word timing in metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-word-metadata-'));
  try {
    const modelPath = path.join(directory, 'model');
    const outputPath = path.join(directory, 'audio.srt');
    fs.mkdirSync(path.join(modelPath, 'onnx'), { recursive: true });
    for (const file of [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ]) fs.writeFileSync(path.join(modelPath, file), '{}');

    const result = await transcribeToSrt({
      variant: 'q8',
      validateModel: () => ({ ready: true }),
      modelPath,
      audioPath: path.join(directory, 'audio.wav'),
      outputPath,
      language: 'vi',
      timestampLevel: 'word',
      useVad: false,
      speechRegions: [{ start: 0, end: 2, samples: new Float32Array([0.1]) }],
      runWorker: async (job) => {
        assert.equal(job.timestampLevel, 'word');
        const region = job.speechRegions[0];
        job.onRegionResult({
          index: region.checkpointIndex,
          result: {
            text: 'xin chào bạn',
            chunks: [
              { text: 'xin', timestamp: [0, 0.4] },
              { text: 'chào', timestamp: [0.4, 0.8] },
              { text: 'bạn', timestamp: [0.8, 1.2] }
            ]
          }
        });
        return {};
      }
    });

    assert.match(fs.readFileSync(outputPath, 'utf8'), /xin chào bạn/);
    const metadata = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
    assert.equal(metadata.timestampLevel, 'word');
    assert.deepEqual(metadata.cues[0].words, [
      { text: 'xin', startMs: 0, endMs: 400 },
      { text: 'chào', startMs: 400, endMs: 800 },
      { text: 'bạn', startMs: 800, endMs: 1200 }
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
