'use strict';

const fs = require('fs');

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

function send(message) {
  if (typeof process.send !== 'function') return Promise.resolve();
  return new Promise((resolve) => process.send(message, resolve));
}

function readMono16kWav(audioPath, wavefileModulePath) {
  const { WaveFile } = require(wavefileModulePath);
  const wav = new WaveFile(fs.readFileSync(audioPath));
  wav.toBitDepth('32f');
  if (Number(wav.fmt?.sampleRate) !== SAMPLE_RATE) wav.toSampleRate(SAMPLE_RATE);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return samples instanceof Float32Array ? samples : Float32Array.from(samples);
}

function mergeSpeechRegions(regions, totalSamples, options) {
  const padSamples = Math.round(options.speechPadMs * SAMPLE_RATE / 1000);
  const mergeGapSamples = Math.round(options.mergeGapMs * SAMPLE_RATE / 1000);
  const maxSamples = Math.round(options.maxSegmentSeconds * SAMPLE_RATE);
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

async function detect(job) {
  const ort = require(job.onnxruntimeModulePath);
  const options = { ...DEFAULT_OPTIONS, ...(job.options || {}) };
  const samples = readMono16kWav(job.audioPath, job.wavefileModulePath);
  const session = await ort.InferenceSession.create(job.modelPath, {
    executionProviders: ['cpu'],
    interOpNumThreads: 1,
    intraOpNumThreads: 1
  });
  let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  let context = new Float32Array(64);
  const sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);
  const frameMs = FRAME_SAMPLES * 1000 / SAMPLE_RATE;
  const minSpeechSamples = Math.max(
    FRAME_SAMPLES,
    Math.round(options.minSpeechMs * SAMPLE_RATE / 1000)
  );
  const minSilenceFrames = Math.max(1, Math.ceil(options.minSilenceMs / frameMs));
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

    if (probability >= options.threshold) {
      if (candidateStart == null) candidateStart = offset;
      silenceFrames = 0;
    } else if (candidateStart != null) {
      if (probability < options.negativeThreshold) silenceFrames += 1;
      else silenceFrames = 0;
      if (silenceFrames >= minSilenceFrames) {
        const endSample = Math.max(
          candidateStart,
          offset - (silenceFrames - 1) * FRAME_SAMPLES
        );
        if (endSample - candidateStart >= minSpeechSamples) {
          rawRegions.push({ startSample: candidateStart, endSample });
        }
        candidateStart = null;
        silenceFrames = 0;
      }
    }

    const percent = Math.min(
      100,
      Math.floor(((offset + FRAME_SAMPLES) / Math.max(1, samples.length)) * 100)
    );
    if (percent >= lastProgress + 5 || percent === 100) {
      lastProgress = percent;
      await send({ type: 'progress', percent });
    }
  }

  if (candidateStart != null && samples.length - candidateStart >= minSpeechSamples) {
    rawRegions.push({ startSample: candidateStart, endSample: samples.length });
  }
  const regions = mergeSpeechRegions(rawRegions, samples.length, options).map((region) => ({
    start: region.startSample / SAMPLE_RATE,
    end: region.endSample / SAMPLE_RATE
  }));
  return {
    durationSeconds: samples.length / SAMPLE_RATE,
    speechSeconds: regions.reduce((sum, region) => sum + region.end - region.start, 0),
    regions
  };
}

process.once('message', async (job) => {
  try {
    const result = await detect(job);
    await send({ type: 'result', result });
    process.exit(0);
  } catch (error) {
    await send({ type: 'error', error: error?.stack || String(error) });
    process.exit(1);
  }
});
