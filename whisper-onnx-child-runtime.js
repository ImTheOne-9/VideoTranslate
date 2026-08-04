const fs = require('fs');
const path = require('path');
let cachedTranscriber = null;
let cachedTranscriberKey = null;

function send(message) {
  if (typeof process.send !== 'function') return Promise.resolve();
  return new Promise((resolve) => process.send(message, resolve));
}

async function transcribe(job) {
  const { pipeline, env, Tensor } = require(job.transformersModulePath);
  const { WaveFile } = require(job.wavefileModulePath);
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.dirname(job.modelPath) + path.sep;

  let samples;
  const needsSourceSamples = !Array.isArray(job.speechRegions)
    || job.speechRegions.some((region) => !region?.samples);
  if (needsSourceSamples) {
    const wav = new WaveFile(fs.readFileSync(job.audioPath));
    wav.toBitDepth('32f');
    if (Number(wav.fmt?.sampleRate) !== 16000) wav.toSampleRate(16000);
    samples = wav.getSamples();
    if (Array.isArray(samples)) samples = samples[0];
  }

  const transcriberKey = [job.modelPath, job.device, job.dtype].join('|');
  if (!cachedTranscriber || cachedTranscriberKey !== transcriberKey) {
    await send({ type: 'stage', stage: 'loading_model', device: job.device });
    cachedTranscriber = await pipeline(
      'automatic-speech-recognition',
      path.basename(job.modelPath),
      { device: job.device, dtype: job.dtype }
    );
    cachedTranscriberKey = transcriberKey;
  } else {
    await send({ type: 'stage', stage: 'model_reused', device: job.device });
  }
  const transcriber = cachedTranscriber;
  let detectedLanguage = null;
  let detectedLanguageConfidence = null;
  if (!job.language && job.detectLanguage) {
    const maximumSamples = 16000 * 30;
    const sampleParts = [];
    let sampleCount = 0;
    const regions = Array.isArray(job.speechRegions) ? job.speechRegions : [];
    for (const region of regions) {
      if (sampleCount >= maximumSamples) break;
      const startSample = Math.max(0, Math.floor(Number(region.start) * 16000));
      const endSample = Math.min(samples?.length || 0, Math.ceil(Number(region.end) * 16000));
      const regionSamples = region.samples || samples?.slice(startSample, endSample);
      if (!regionSamples?.length) continue;
      const take = Math.min(regionSamples.length, maximumSamples - sampleCount, 16000 * 6);
      sampleParts.push(regionSamples.subarray ? regionSamples.subarray(0, take) : regionSamples.slice(0, take));
      sampleCount += take;
    }
    if (sampleParts.length === 0 && samples?.length) {
      sampleParts.push(samples.subarray(0, Math.min(samples.length, maximumSamples)));
      sampleCount = sampleParts[0].length;
    }
    if (sampleCount > 0) {
      const languageSamples = new Float32Array(sampleCount);
      let offset = 0;
      for (const part of sampleParts) {
        languageSamples.set(part, offset);
        offset += part.length;
      }
      const features = await transcriber.processor(languageSamples);
      const generationConfig = transcriber.model.generation_config || {};
      const decoderStartTokenId = generationConfig.decoder_start_token_id;
      if (decoderStartTokenId != null && generationConfig.lang_to_id) {
        const decoderInputIds = new Tensor(
          'int64',
          BigInt64Array.from([BigInt(decoderStartTokenId)]),
          [1, 1]
        );
        const outputs = await transcriber.model.forward({
          input_features: features.input_features,
          decoder_input_ids: decoderInputIds
        });
        const languageScores = Object.entries(generationConfig.lang_to_id)
          .map(([token, tokenId]) => ({ token, score: Number(outputs.logits.data[Number(tokenId)]) }))
          .filter((entry) => Number.isFinite(entry.score));
        if (languageScores.length > 0) {
          languageScores.sort((a, b) => b.score - a.score);
          const best = languageScores[0];
          const denominator = languageScores.reduce(
            (sum, entry) => sum + Math.exp(entry.score - best.score),
            0
          );
          detectedLanguage = best.token.replace(/[<|>]/g, '');
          detectedLanguageConfidence = denominator > 0 ? 1 / denominator : null;
          await send({
            type: 'language_detected',
            language: detectedLanguage,
            confidence: detectedLanguageConfidence
          });
        }
      }
    }
  }
  await send({ type: 'stage', stage: 'transcribing', device: job.device });
  const transcribeOptions = {
    return_timestamps: job.timestampLevel === 'word' ? 'word' : true,
    chunk_length_s: 30,
    stride_length_s: 5,
    task: 'transcribe'
  };
  const lockedLanguage = job.language || detectedLanguage;
  if (lockedLanguage) transcribeOptions.language = lockedLanguage;

  if (!Array.isArray(job.speechRegions)) {
    const result = await transcriber(samples, transcribeOptions);
    if (job.vadMetadata) result.vad = job.vadMetadata;
    if (lockedLanguage) result.language = lockedLanguage;
    if (detectedLanguageConfidence != null) result.languageConfidence = detectedLanguageConfidence;
    return result;
  }

  const chunks = [];
  const texts = [];
  for (let index = 0; index < job.speechRegions.length; index += 1) {
    const region = job.speechRegions[index];
    const checkpointIndex = Number.isInteger(region.checkpointIndex)
      ? region.checkpointIndex
      : index;
    const checkpointTotal = Number.isInteger(region.checkpointTotal)
      ? region.checkpointTotal
      : job.speechRegions.length;
    await send({
      type: 'stage',
      stage: 'transcribing_region',
      current: checkpointIndex + 1,
      total: checkpointTotal
    });
    const startSample = Math.max(0, Math.floor(Number(region.start) * 16000));
    const endSample = Math.min(samples?.length || 0, Math.ceil(Number(region.end) * 16000));
    const regionSamples = region.samples || samples?.slice(startSample, endSample);
    if (!regionSamples?.length) {
      throw new Error(`Vung giong noi ${checkpointIndex + 1} khong co du lieu am thanh`);
    }
    const regionResult = await transcriber(regionSamples, transcribeOptions);
    const regionText = String(regionResult?.text || '').trim();
    const regionChunks = [];
    if (regionText) texts.push(regionText);
    for (const chunk of Array.isArray(regionResult?.chunks) ? regionResult.chunks : []) {
      const start = chunk.timestamp?.[0];
      const end = chunk.timestamp?.[1];
      const adjustedChunk = {
        ...chunk,
        timestamp: [
          start == null ? start : Number(start) + region.start,
          end == null ? end : Number(end) + region.start
        ]
      };
      chunks.push(adjustedChunk);
      regionChunks.push(adjustedChunk);
    }
    await send({
      type: 'region_result',
      index: checkpointIndex,
      result: { text: regionText, chunks: regionChunks }
    });
  }
  return {
    text: texts.filter(Boolean).join(' '),
    chunks,
    vad: job.vadMetadata,
    language: lockedLanguage || null,
    languageConfidence: detectedLanguageConfidence
  };
}

let busy = false;
process.on('message', async (job) => {
  if (job?.type === 'shutdown') return process.exit(0);
  if (busy) {
    await send({ type: 'error', error: 'Whisper worker received a concurrent job' });
    return;
  }
  busy = true;
  try {
    const result = await transcribe(job);
    await send({ type: 'result', result });
  } catch (error) {
    await send({ type: 'error', error: error?.stack || String(error) });
  } finally {
    busy = false;
  }
});
