const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const sileroVad = require('./silero-vad-helper');
const {
  readJsonFile,
  writeJsonAtomic
} = require('./checkpoint-utils');

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
    const { onStage, onRegionResult, timeoutMs, ...optionData } = options;
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
      if (settled) return;
      if (message?.type === 'stage') onStage?.(message);
      if (message?.type === 'region_result') {
        try {
          onRegionResult?.(message);
        } catch (error) {
          try { worker.kill('SIGKILL'); } catch {}
          finish(() => reject(error));
          return;
        }
      }
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

function loadCheckpointSamples(audioPath, regions) {
  const { WaveFile } = require('wavefile');
  const wav = new WaveFile(fs.readFileSync(audioPath));
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return regions.map((region) => {
    const startIndex = Math.max(0, Math.floor(Number(region.start) * 16000));
    const endIndex = Math.min(samples.length, Math.ceil(Number(region.end) * 16000));
    return {
      start: Number(region.start),
      end: Number(region.end),
      samples: samples.slice(startIndex, endIndex)
    };
  });
}

function combineRegionResults(regionResults, vadMetadata) {
  const ordered = Object.entries(regionResults || {})
    .map(([index, result]) => ({ index: Number(index), result }))
    .filter((entry) => Number.isInteger(entry.index) && entry.result)
    .sort((a, b) => a.index - b.index);
  return {
    text: ordered.map((entry) => String(entry.result.text || '').trim()).filter(Boolean).join(' '),
    chunks: ordered.flatMap((entry) => Array.isArray(entry.result.chunks) ? entry.result.chunks : []),
    vad: vadMetadata
  };
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

  const savedCheckpoint = options.checkpointPath && options.checkpointKey
    ? readJsonFile(options.checkpointPath)
    : null;
  const checkpoint = savedCheckpoint?.version === 1
    && savedCheckpoint.checkpointKey === options.checkpointKey
    ? savedCheckpoint
    : {
        version: 1,
        checkpointKey: options.checkpointKey || null,
        vad: null,
        regions: {}
      };
  checkpoint.regions ||= {};
  const saveCheckpoint = () => {
    if (options.checkpointPath && options.checkpointKey) {
      checkpoint.updatedAt = new Date().toISOString();
      writeJsonAtomic(options.checkpointPath, checkpoint);
    }
  };

  let speechRegions;
  let vadMetadata;
  if (options.useVad !== false) {
    const cachedRegions = checkpoint.vad?.regions;
    const hasValidCachedRegions = Array.isArray(cachedRegions)
      && cachedRegions.every((region) => (
        Number.isFinite(Number(region?.start))
        && Number.isFinite(Number(region?.end))
        && Number(region.start) >= 0
        && Number(region.end) > Number(region.start)
      ));
    if (hasValidCachedRegions) {
      vadMetadata = checkpoint.vad.metadata;
      const materializeRegions = options.loadCheckpointSamples || loadCheckpointSamples;
      speechRegions = materializeRegions(options.audioPath, cachedRegions);
      options.onStage?.({ type: 'stage', stage: 'vad_complete', ...vadMetadata, resumed: true });
    } else {
      if (checkpoint.vad) {
        checkpoint.vad = null;
        checkpoint.regions = {};
        saveCheckpoint();
      }
      options.onStage?.({ type: 'stage', stage: 'vad_analyzing' });
      try {
        const detectSpeechRegions = options.detectSpeechRegions || sileroVad.detectSpeechRegions;
        const vadResult = await detectSpeechRegions(options.audioPath, options.vadOptions);
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
        checkpoint.vad = {
          metadata: vadMetadata,
          regions: speechRegions.map(({ start, end }) => ({ start, end }))
        };
        saveCheckpoint();
        options.onStage?.({ type: 'stage', stage: 'vad_complete', ...vadMetadata });
      } catch (error) {
        vadMetadata = { enabled: false, fallback: true, error: error.message };
        options.onStage?.({ type: 'stage', stage: 'vad_fallback', error: error.message });
      }
    }
    if (speechRegions?.length === 0) return { text: '', chunks: [], vad: vadMetadata };
  }

  if (Array.isArray(speechRegions)) {
    const totalRegions = speechRegions.length;
    const getPendingRegions = () => speechRegions
      .map((region, index) => ({
        ...region,
        checkpointIndex: index,
        checkpointTotal: totalRegions
      }))
      .filter((region) => !checkpoint.regions[String(region.checkpointIndex)]);
    const runPendingRegions = async (device) => {
      const pendingRegions = getPendingRegions();
      if (pendingRegions.length === 0) return null;
      const inferenceWorker = options.runWorker || runWorker;
      return inferenceWorker({
        audioPath: options.audioPath,
        modelPath: options.modelPath,
        dtype: variantConfig.dtype,
        language: normalizeLanguage(options.language),
        speechRegions: pendingRegions,
        vadMetadata,
        timeoutMs: options.timeoutMs,
        onStage: options.onStage,
        device,
        onRegionResult(message) {
          checkpoint.regions[String(message.index)] = message.result;
          saveCheckpoint();
          options.onRegionCheckpoint?.({
            current: Object.keys(checkpoint.regions).length,
            total: totalRegions,
            index: message.index
          });
        }
      });
    };

    const preferredDevice = options.device || process.env.WHISPER_ONNX_DEVICE || 'cpu';
    if (preferredDevice === 'dml') {
      try {
        await runPendingRegions('dml');
        return combineRegionResults(checkpoint.regions, vadMetadata);
      } catch (error) {
        options.onStage?.({ type: 'stage', stage: 'gpu_fallback', error: error.message });
      }
    }
    await runPendingRegions('cpu');
    return combineRegionResults(checkpoint.regions, vadMetadata);
  }

  const baseOptions = {
    audioPath: options.audioPath,
    modelPath: options.modelPath,
    dtype: variantConfig.dtype,
    language: normalizeLanguage(options.language),
    vadMetadata,
    timeoutMs: options.timeoutMs,
    onStage: options.onStage
  };
  const preferredDevice = options.device || process.env.WHISPER_ONNX_DEVICE || 'cpu';
  const inferenceWorker = options.runWorker || runWorker;
  if (preferredDevice === 'dml') {
    try {
      return await inferenceWorker({ ...baseOptions, device: 'dml' });
    } catch (error) {
      options.onStage?.({ type: 'stage', stage: 'gpu_fallback', error: error.message });
    }
  }
  return inferenceWorker({ ...baseOptions, device: 'cpu' });
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
  combineRegionResults,
  chunksToSrt,
  filterRepeatedParentheticalCues,
  formatSrtTime,
  normalizeLanguage,
  resolveWorkerModulePaths,
  transcribeAudio,
  transcribeToSrt
};
