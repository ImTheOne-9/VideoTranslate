const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const LANGUAGE_MAP = Object.freeze({
  ch: 'chinese',
  zh: 'chinese',
  vi: 'vietnamese',
  en: 'english',
  japan: 'japanese',
  ja: 'japanese',
  korean: 'korean',
  ko: 'korean'
});

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

(async () => {
  const { pipeline, env } = require(workerData.transformersModulePath);
  const { WaveFile } = require(workerData.wavefileModulePath);
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.dirname(workerData.modelPath) + path.sep;

  const wav = new WaveFile(fs.readFileSync(workerData.audioPath));
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];

  parentPort.postMessage({ type: 'stage', stage: 'loading_model', device: workerData.device });
  const transcriber = await pipeline(
    'automatic-speech-recognition',
    path.basename(workerData.modelPath),
    { device: workerData.device, dtype: workerData.dtype }
  );
  parentPort.postMessage({ type: 'stage', stage: 'transcribing', device: workerData.device });
  const result = await transcriber(samples, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: workerData.language,
    task: 'transcribe'
  });
  parentPort.postMessage({ type: 'result', result });
})().catch((error) => {
  parentPort.postMessage({
    type: 'error',
    error: error && error.stack ? error.stack : String(error)
  });
});
`;

function normalizeLanguage(language) {
  const key = String(language || '').trim().toLowerCase();
  return LANGUAGE_MAP[key] || key || 'vietnamese';
}

function formatSrtTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMs = Math.round(safe * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function cleanRepeatedParentheticalText(text) {
  return String(text || '')
    .replace(/(\([^()\r\n]{1,8}\))(?:\s*\1){2,}/gu, '')
    .replace(/(（[^（）\r\n]{1,8}）)(?:\s*\1){2,}/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function getShortParentheticalValue(text) {
  const match = String(text || '').trim().match(/^(?:\(([^()\r\n]+)\)|（([^（）\r\n]+)）)$/u);
  if (!match) return null;
  const value = (match[1] || match[2] || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return value && Array.from(value).length <= 4 ? value : null;
}

function filterRepeatedParentheticalCues(cues) {
  const filtered = [];
  for (let index = 0; index < cues.length;) {
    const value = getShortParentheticalValue(cues[index].text);
    if (!value) {
      filtered.push(cues[index]);
      index += 1;
      continue;
    }

    let runEnd = index + 1;
    while (runEnd < cues.length && getShortParentheticalValue(cues[runEnd].text) === value) {
      runEnd += 1;
    }
    if (runEnd - index < 3) filtered.push(...cues.slice(index, runEnd));
    index = runEnd;
  }
  return filtered;
}

function chunksToSrt(chunks, durationSeconds) {
  const candidates = (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => ({
      text: cleanRepeatedParentheticalText(chunk?.text),
      start: chunk?.timestamp?.[0] == null ? Number.NaN : Number(chunk.timestamp[0]),
      end: chunk?.timestamp?.[1] == null ? Number.NaN : Number(chunk.timestamp[1])
    }))
    .filter((cue) => cue.text && Number.isFinite(cue.start));
  const valid = filterRepeatedParentheticalCues(candidates);
  const normalized = [];
  let previousEnd = 0;

  for (let index = 0; index < valid.length; index += 1) {
    const cue = valid[index];
    const start = Math.max(0, cue.start, previousEnd);
    if (Number.isFinite(durationSeconds) && start >= durationSeconds) continue;
    const nextStart = valid[index + 1]?.start;
    let end = Number.isFinite(cue.end) && cue.end > start
      ? cue.end
      : start + Math.max(1, cue.text.length * 0.12);
    if (Number.isFinite(nextStart) && nextStart > start) end = Math.min(end, nextStart);
    if (Number.isFinite(durationSeconds)) end = Math.min(end, durationSeconds);
    if (end <= start) continue;
    normalized.push({ ...cue, start, end });
    previousEnd = end;
  }

  return normalized.map((cue, index) => (
    `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`
  )).join('\n');
}

function resolveWorkerModulePaths() {
  return {
    transformersModulePath: require.resolve('@huggingface/transformers'),
    wavefileModulePath: require.resolve('wavefile')
  };
}

function runWorker(options) {
  return new Promise((resolve, reject) => {
    const { onStage, timeoutMs, ...optionData } = options;
    const workerData = { ...optionData, ...resolveWorkerModulePaths() };
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('Whisper ONNX timeout sau 30 phút'));
    }, timeoutMs || 30 * 60 * 1000);

    if (global.registerRenderWorker) global.registerRenderWorker(worker);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    worker.on('message', (message) => {
      if (message?.type === 'stage') onStage?.(message);
      if (message?.type === 'result') finish(() => resolve(message.result));
      if (message?.type === 'error') finish(() => reject(new Error(message.error)));
    });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`Whisper ONNX worker dừng với mã ${code}`)));
    });
  });
}

async function transcribeAudio(options) {
  const variant = String(options.variant || 'q8').trim().toLowerCase();
  const variantConfig = {
    q8: {
      dtype: 'q8',
      files: [
        path.join('onnx', 'encoder_model_quantized.onnx'),
        path.join('onnx', 'decoder_model_merged_quantized.onnx')
      ]
    },
    'medium-q8': {
      dtype: 'q8',
      files: [
        path.join('onnx', 'encoder_model_quantized.onnx'),
        path.join('onnx', 'decoder_model_merged_quantized.onnx')
      ]
    },
    fp32: {
      dtype: 'fp32',
      files: [
        path.join('onnx', 'encoder_model.onnx'),
        path.join('onnx', 'decoder_model_merged.onnx')
      ]
    }
  }[variant];
  if (!variantConfig) throw new Error(`Biến thể Whisper ONNX không hợp lệ: ${options.variant}`);

  const requiredFiles = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    ...variantConfig.files
  ];
  if (!requiredFiles.every((file) => fs.existsSync(path.join(options.modelPath, file)))) {
    throw new Error(`Thiếu model Whisper ONNX ${variant.toUpperCase()} tại ${options.modelPath}`);
  }

  const baseOptions = {
    audioPath: options.audioPath,
    modelPath: options.modelPath,
    dtype: variantConfig.dtype,
    language: normalizeLanguage(options.language),
    timeoutMs: options.timeoutMs,
    onStage: options.onStage
  };
  const preferredDevice = options.device || process.env.WHISPER_ONNX_DEVICE || 'cpu';
  if (preferredDevice === 'dml') {
    try {
      return await runWorker({ ...baseOptions, device: 'dml' });
    } catch (error) {
      options.onStage?.({ type: 'stage', stage: 'gpu_fallback', error: error.message });
    }
  }
  return runWorker({ ...baseOptions, device: 'cpu' });
}

async function transcribeToSrt(options) {
  const result = await transcribeAudio(options);
  const srt = chunksToSrt(result?.chunks, options.durationSeconds);
  if (!srt.trim()) throw new Error('Whisper ONNX không trả về cue có timestamp');
  fs.writeFileSync(options.outputPath, srt, 'utf8');
  return { ...result, outputPath: options.outputPath };
}

module.exports = {
  cleanRepeatedParentheticalText,
  chunksToSrt,
  filterRepeatedParentheticalCues,
  formatSrtTime,
  normalizeLanguage,
  resolveWorkerModulePaths,
  transcribeAudio,
  transcribeToSrt
};
