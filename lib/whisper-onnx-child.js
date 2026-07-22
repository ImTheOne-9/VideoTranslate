const fs = require('fs');
const path = require('path');

function send(message) {
  if (typeof process.send !== 'function') return Promise.resolve();
  return new Promise((resolve) => process.send(message, resolve));
}

async function transcribe(job) {
  const { pipeline, env } = require(job.transformersModulePath);
  const { WaveFile } = require(job.wavefileModulePath);
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.dirname(job.modelPath) + path.sep;

  let samples;
  if (!Array.isArray(job.speechRegions)) {
    const wav = new WaveFile(fs.readFileSync(job.audioPath));
    wav.toBitDepth('32f');
    wav.toSampleRate(16000);
    samples = wav.getSamples();
    if (Array.isArray(samples)) samples = samples[0];
  }

  await send({ type: 'stage', stage: 'loading_model', device: job.device });
  const transcriber = await pipeline(
    'automatic-speech-recognition',
    path.basename(job.modelPath),
    { device: job.device, dtype: job.dtype }
  );
  await send({ type: 'stage', stage: 'transcribing', device: job.device });
  const transcribeOptions = {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: job.language,
    task: 'transcribe'
  };

  if (!Array.isArray(job.speechRegions)) {
    const result = await transcriber(samples, transcribeOptions);
    if (job.vadMetadata) result.vad = job.vadMetadata;
    return result;
  }

  const chunks = [];
  const texts = [];
  for (let index = 0; index < job.speechRegions.length; index += 1) {
    const region = job.speechRegions[index];
    await send({
      type: 'stage',
      stage: 'transcribing_region',
      current: index + 1,
      total: job.speechRegions.length
    });
    const regionResult = await transcriber(region.samples, transcribeOptions);
    if (regionResult?.text) texts.push(String(regionResult.text).trim());
    for (const chunk of Array.isArray(regionResult?.chunks) ? regionResult.chunks : []) {
      const start = chunk.timestamp?.[0];
      const end = chunk.timestamp?.[1];
      chunks.push({
        ...chunk,
        timestamp: [
          start == null ? start : Number(start) + region.start,
          end == null ? end : Number(end) + region.start
        ]
      });
    }
  }
  return { text: texts.filter(Boolean).join(' '), chunks, vad: job.vadMetadata };
}

process.once('message', async (job) => {
  try {
    const result = await transcribe(job);
    await send({ type: 'result', result });
    process.exit(0);
  } catch (error) {
    await send({ type: 'error', error: error?.stack || String(error) });
    process.exit(1);
  }
});
