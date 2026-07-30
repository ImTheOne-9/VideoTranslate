const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { WaveFile } = require('wavefile');

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;
const DEFAULT_OPTIONS = Object.freeze({
  threshold: 0.35,
  negativeThreshold: 0.2,
  minSpeechMs: 250,
  minSilenceMs: 550,
  speechPadMs: 400,
  mergeGapMs: 1000,
  maxSegmentSeconds: Number.POSITIVE_INFINITY
});
const activeWorkers = new Map();

function resolveVadModelPath() {
  if (process.env.SILERO_VAD_MODEL_PATH) return process.env.SILERO_VAD_MODEL_PATH;
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'tools', 'silero-vad', 'silero_vad.onnx');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(__dirname, '..', 'tools', 'silero-vad', 'silero_vad.onnx');
}

function readMono16kWav(audioPath) {
  const wav = new WaveFile(fs.readFileSync(audioPath));
  wav.toBitDepth('32f');
  wav.toSampleRate(SAMPLE_RATE);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return samples instanceof Float32Array ? samples : Float32Array.from(samples);
}

function mergeSpeechRegions(regions, totalSamples, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const padSamples = Math.round(config.speechPadMs * SAMPLE_RATE / 1000);
  const mergeGapSamples = Math.round(config.mergeGapMs * SAMPLE_RATE / 1000);
  const maxSamples = Math.round(config.maxSegmentSeconds * SAMPLE_RATE);
  const padded = regions.map((region) => ({
    startSample: Math.max(0, region.startSample - padSamples),
    endSample: Math.min(totalSamples, region.endSample + padSamples)
  }));
  const merged = [];
  for (const region of padded) {
    const previous = merged[merged.length - 1];
    if (previous && region.startSample <= previous.endSample + mergeGapSamples) {
      previous.endSample = Math.max(previous.endSample, region.endSample);
    } else {
      merged.push({ ...region });
    }
  }

  const split = [];
  for (const region of merged) {
    if (!Number.isFinite(maxSamples) || region.endSample - region.startSample <= maxSamples) {
      split.push(region);
      continue;
    }
    for (let start = region.startSample; start < region.endSample; start += maxSamples) {
      split.push({
        startSample: start,
        endSample: Math.min(region.endSample, start + maxSamples)
      });
    }
  }
  return split;
}

async function detectSpeechRegionsInProcess(audioPath, options = {}) {
  const ort = options.onnxruntimeModulePath
    ? require(options.onnxruntimeModulePath)
    : require('onnxruntime-node');
  const config = { ...DEFAULT_OPTIONS, ...options };
  const modelPath = options.modelPath || resolveVadModelPath();
  if (!fs.existsSync(modelPath)) throw new Error('Thiếu model Silero VAD tại ' + modelPath);

  const samples = readMono16kWav(audioPath);
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    interOpNumThreads: 1,
    intraOpNumThreads: 1
  });
  let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  let context = new Float32Array(64);
  const sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);
  const frameMs = FRAME_SAMPLES * 1000 / SAMPLE_RATE;
  const minSpeechSamples = Math.max(FRAME_SAMPLES, Math.round(config.minSpeechMs * SAMPLE_RATE / 1000));
  const minSilenceFrames = Math.max(1, Math.ceil(config.minSilenceMs / frameMs));
  const rawRegions = [];
  let candidateStart = null;
  let silenceFrames = 0;
  let lastProgress = -1;

  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const frame = new Float32Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, Math.min(samples.length, offset + FRAME_SAMPLES)));
    const modelInput = new Float32Array(context.length + frame.length);
    modelInput.set(context);
    modelInput.set(frame, context.length);
    const output = await session.run({
      input: new ort.Tensor('float32', modelInput, [1, modelInput.length]),
      state,
      sr: sampleRate
    });
    state = output.stateN || output.state;
    context = modelInput.slice(modelInput.length - 64);
    const probability = Number((output.output || output.probability)?.data?.[0] || 0);
    const progress = Math.min(100, Math.floor(((offset + FRAME_SAMPLES) / samples.length) * 100));
    if (progress >= lastProgress + 5 || progress === 100) {
      lastProgress = progress;
      await options.onProgress?.(progress);
    }

    if (probability >= config.threshold) {
      if (candidateStart == null) candidateStart = offset;
      silenceFrames = 0;
    } else if (candidateStart != null) {
      if (probability < config.negativeThreshold) silenceFrames += 1;
      else silenceFrames = 0;
      if (silenceFrames >= minSilenceFrames) {
        const endSample = Math.max(candidateStart, offset - (silenceFrames - 1) * FRAME_SAMPLES);
        if (endSample - candidateStart >= minSpeechSamples) {
          rawRegions.push({ startSample: candidateStart, endSample });
        }
        candidateStart = null;
        silenceFrames = 0;
      }
    }
  }

  if (candidateStart != null && samples.length - candidateStart >= minSpeechSamples) {
    rawRegions.push({ startSample: candidateStart, endSample: samples.length });
  }
  const regions = mergeSpeechRegions(rawRegions, samples.length, config).map((region) => ({
    ...region,
    start: region.startSample / SAMPLE_RATE,
    end: region.endSample / SAMPLE_RATE,
    ...(options.includeSamples === false
      ? {}
      : { samples: samples.slice(region.startSample, region.endSample) })
  }));
  return {
    durationSeconds: samples.length / SAMPLE_RATE,
    speechSeconds: regions.reduce((sum, region) => sum + region.end - region.start, 0),
    regions
  };
}

function preferUnpackedModulePath(modulePath) {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (!modulePath.includes(asarSegment)) return modulePath;
  const unpackedPath = modulePath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpackedPath) ? unpackedPath : modulePath;
}

function resolveVadWorkerModulePaths() {
  return {
    onnxruntimeModulePath: preferUnpackedModulePath(require.resolve('onnxruntime-node')),
    wavefileModulePath: preferUnpackedModulePath(require.resolve('wavefile'))
  };
}

function detectSpeechRegions(audioPath, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      onProgress,
      owner,
      timeoutMs,
      forkImpl = childProcess.fork,
      modulePaths = resolveVadWorkerModulePaths(),
      modelPath = resolveVadModelPath(),
      ...workerOptions
    } = options;
    const workerPath = path.join(__dirname, '..', 'silero-vad-child-runtime.js');
    const worker = forkImpl(workerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      serialization: 'advanced',
      silent: true
    });
    let settled = false;
    let stderr = '';
    worker.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    if (global.registerChildProcess) global.registerChildProcess(worker);
    if (owner) {
      const previous = activeWorkers.get(owner);
      if (previous && previous !== worker) {
        try { previous.kill('SIGKILL'); } catch {}
      }
      activeWorkers.set(owner, worker);
    }

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (owner && activeWorkers.get(owner) === worker) activeWorkers.delete(owner);
      callback();
    };
    const timeout = setTimeout(() => {
      try { worker.kill('SIGKILL'); } catch {}
      finish(() => reject(new Error('Silero VAD timeout sau 10 phut')));
    }, timeoutMs || 10 * 60 * 1000);

    worker.on('message', (message) => {
      if (settled) return;
      if (message?.type === 'progress') {
        try { onProgress?.(Number(message.percent) || 0); } catch {}
      }
      if (message?.type === 'result') finish(() => resolve(message.result));
      if (message?.type === 'error') finish(() => reject(new Error(message.error)));
    });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code, signal) => {
      if (settled) return;
      const details = stderr.trim() || `code=${code}, signal=${signal || 'none'}`;
      const error = new Error(`Silero VAD process dung bat ngo: ${details}`);
      if (worker.vadCancelled || signal === 'SIGKILL' || signal === 'SIGTERM') {
        error.code = 'VAD_CANCELLED';
      }
      finish(() => reject(error));
    });
    worker.send({
      audioPath,
      modelPath,
      options: workerOptions,
      ...modulePaths
    });
  });
}

function cancelVadWorker(owner) {
  const key = String(owner || '');
  const worker = activeWorkers.get(key);
  if (!worker) return false;
  activeWorkers.delete(key);
  try {
    worker.vadCancelled = true;
    worker.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  cancelVadWorker,
  DEFAULT_OPTIONS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  detectSpeechRegions,
  detectSpeechRegionsInProcess,
  mergeSpeechRegions,
  preferUnpackedModulePath,
  readMono16kWav,
  resolveVadWorkerModulePaths,
  resolveVadModelPath
};
