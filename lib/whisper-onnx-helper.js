const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const sileroVad = require('./silero-vad-helper');

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

function countSpeechCharacters(text) {
  return (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
}

function isImplausiblyDenseCue(cue) {
  if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) {
    return false;
  }
  const duration = cue.end - cue.start;
  const speechCharacterCount = countSpeechCharacters(cue.text);
  const minimumCharacterCount = duration < 0.15 ? 8 : 20;
  if (speechCharacterCount < minimumCharacterCount) return false;
  return speechCharacterCount / duration > 45;
}

function chunksToSrt(chunks, durationSeconds) {
  const candidates = (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => ({
      text: cleanRepeatedParentheticalText(chunk?.text),
      start: chunk?.timestamp?.[0] == null ? Number.NaN : Number(chunk.timestamp[0]),
      end: chunk?.timestamp?.[1] == null ? Number.NaN : Number(chunk.timestamp[1])
    }))
    .filter((cue) => cue.text && Number.isFinite(cue.start));
  // Whisper can repeat context at a chunk boundary and assign a long sentence
  // only a few milliseconds. Later formatting would turn it into flashing cues.
  const valid = filterRepeatedParentheticalCues(candidates)
    .filter((cue) => !isImplausiblyDenseCue(cue));
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
  const preferUnpacked = (modulePath) => {
    const asarSegment = `${path.sep}app.asar${path.sep}`;
    if (!modulePath.includes(asarSegment)) return modulePath;
    const unpackedPath = modulePath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpackedPath) ? unpackedPath : modulePath;
  };
  return {
    transformersModulePath: preferUnpacked(require.resolve('@huggingface/transformers')),
    wavefileModulePath: preferUnpacked(require.resolve('wavefile'))
  };
}

function runWorker(options) {
  return new Promise((resolve, reject) => {
    const { onStage, timeoutMs, ...optionData } = options;
    const sourceWorkerPath = path.join(__dirname, 'whisper-onnx-child.js');
    const workerPath = fs.existsSync(sourceWorkerPath)
      ? sourceWorkerPath
      : path.join(__dirname, '..', 'whisper-onnx-child-runtime.js');
    const worker = childProcess.fork(workerPath, [], {
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

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      try { worker.kill('SIGKILL'); } catch {}
      finish(() => reject(new Error('Whisper ONNX timeout sau 30 phút')));
    }, timeoutMs || 30 * 60 * 1000);

    worker.on('message', (message) => {
      if (message?.type === 'stage') onStage?.(message);
      if (message?.type === 'result') finish(() => resolve(message.result));
      if (message?.type === 'error') finish(() => reject(new Error(message.error)));
    });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code, signal) => {
      if (settled) return;
      const details = stderr.trim() || `code=${code}, signal=${signal || 'none'}`;
      finish(() => reject(new Error(`Whisper ONNX process dừng bất ngờ: ${details}`)));
    });
    worker.send({
      ...optionData,
      ...resolveWorkerModulePaths()
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

  let speechRegions;
  let vadMetadata;
  if (options.useVad !== false) {
    options.onStage?.({ type: 'stage', stage: 'vad_analyzing' });
    try {
      const vadResult = await sileroVad.detectSpeechRegions(options.audioPath, options.vadOptions);
      vadMetadata = {
        enabled: true,
        durationSeconds: vadResult.durationSeconds,
        speechSeconds: vadResult.speechSeconds,
        regionCount: vadResult.regions.length
      };
      speechRegions = vadResult.regions.map((region) => ({
        start: region.start,
        end: region.end,
        samples: region.samples
      }));
      options.onStage?.({ type: 'stage', stage: 'vad_complete', ...vadMetadata });
      if (speechRegions.length === 0) return { text: '', chunks: [], vad: vadMetadata };
    } catch (error) {
      vadMetadata = { enabled: false, fallback: true, error: error.message };
      options.onStage?.({ type: 'stage', stage: 'vad_fallback', error: error.message });
    }
  }

  const baseOptions = {
    audioPath: options.audioPath,
    modelPath: options.modelPath,
    dtype: variantConfig.dtype,
    language: normalizeLanguage(options.language),
    speechRegions,
    vadMetadata,
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
