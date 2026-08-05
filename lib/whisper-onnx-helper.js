const fs = require('fs');
const path = require('path');
const sileroVad = require('./silero-vad-helper');
const { assessAsrCue } = require('./asr-quality');
const { formatSegmentCaptions, formatWordCaptions } = require('./caption-formatter');
const { validateWhisperOnnxModel } = require('./model-downloader');
const { WhisperWorkerPool } = require('./whisper-worker-pool');
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
const whisperWorkerPool = new WhisperWorkerPool();

function normalizeLanguage(language) {
  const key = String(language || '').trim().toLowerCase();
  return LANGUAGE_MAP[key] || key || 'vietnamese';
}

function normalizeWhisperLanguage(language) {
  const key = String(language || '').trim().toLowerCase();
  if (key === 'auto') return null;
  return normalizeLanguage(language);
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

function cleanWhisperParentheticalSegmentation(text) {
  let cleaned = String(text || '').trim();

  // Whisper sometimes emits spoken dialogue as a run of separately wrapped
  // fragments: "(why) (didn't you...) (name,)". These parentheses describe
  // ASR segmentation rather than something that should be spoken or shown.
  // Require at least two adjacent groups so a normal single aside is retained.
  const parenthetical = String.raw`(?:\([^()\r\n]{1,160}\)|（[^（）\r\n]{1,160}）)`;
  const parentheticalRun = new RegExp(`(?:${parenthetical})(?:\\s*${parenthetical})+`, 'gu');
  cleaned = cleaned.replace(parentheticalRun, (run) => (
    Array.from(
      run.matchAll(/\(([^()\r\n]+)\)|（([^（）\r\n]+)）/gu),
      (match) => (match[1] == null ? match[2] : match[1]).trim()
    ).join(' ')
  ));

  // Remove a lone closing quote that Whisper occasionally leaves after the
  // final fragment. Balanced dialogue quotes remain untouched.
  const straightQuoteCount = (cleaned.match(/"/g) || []).length;
  if (straightQuoteCount % 2 === 1) cleaned = cleaned.replace(/"\s*$/u, '');

  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

function getShortParentheticalValue(text) {
  const match = String(text || '').trim().match(/^(?:\(([^()\r\n]+)\)|（([^（）\r\n]+)）)$/u);
  if (!match) return null;
  const value = (match[1] || match[2] || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  return value && Array.from(value).length <= 4 ? value : null;
}

function getParentheticalContent(text) {
  const match = String(text || '').trim().match(/^(?:\(([^()\r\n]{1,160})\)|（([^（）\r\n]{1,160})）)$/u);
  return match ? (match[1] == null ? match[2] : match[1]).trim() : null;
}

function unwrapAdjacentParentheticalCues(cues) {
  const normalized = cues.map((cue) => ({ ...cue }));
  for (let index = 0; index < normalized.length;) {
    if (getParentheticalContent(normalized[index].text) == null) {
      index += 1;
      continue;
    }

    let runEnd = index + 1;
    while (
      runEnd < normalized.length
      && getParentheticalContent(normalized[runEnd].text) != null
    ) {
      runEnd += 1;
    }

    if (runEnd - index >= 2) {
      for (let cueIndex = index; cueIndex < runEnd; cueIndex += 1) {
        normalized[cueIndex].text = getParentheticalContent(normalized[cueIndex].text);
      }
    }
    index = runEnd;
  }
  return normalized;
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

function normalizeWhisperChunks(chunks, durationSeconds, options = {}) {
  const candidates = (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => ({
      ...chunk,
      text: cleanWhisperParentheticalSegmentation(cleanRepeatedParentheticalText(chunk?.text)),
      start: chunk?.timestamp?.[0] == null ? Number.NaN : Number(chunk.timestamp[0]),
      end: chunk?.timestamp?.[1] == null ? Number.NaN : Number(chunk.timestamp[1])
    }))
    .filter((cue) => cue.text && Number.isFinite(cue.start));
  // Whisper can repeat context at a chunk boundary and assign a long sentence
  // only a few milliseconds. Later formatting would turn it into flashing cues.
  const valid = unwrapAdjacentParentheticalCues(filterRepeatedParentheticalCues(candidates))
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
    normalized.push({
      ...cue,
      start,
      end,
      ...assessAsrCue({ ...cue, start, end }, { language: options.language })
    });
    previousEnd = end;
  }

  return normalized;
}

function chunksToSrt(chunks, durationSeconds) {
  return normalizeWhisperChunks(chunks, durationSeconds).map((cue, index) => (
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
  const { onStage, onRegionResult, onLanguageDetected, timeoutMs, owner, ...optionData } = options;
  const sourceWorkerPath = path.join(__dirname, 'whisper-onnx-child.js');
  const workerPath = fs.existsSync(sourceWorkerPath)
    ? sourceWorkerPath
    : path.join(__dirname, '..', 'whisper-onnx-child-runtime.js');
  const key = [optionData.modelPath, optionData.dtype, optionData.device].join('|');
  return whisperWorkerPool.request({
    key,
    workerPath,
    forkOptions: {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      serialization: 'advanced',
      silent: true
    },
    payload: {
      ...optionData,
      ...resolveWorkerModulePaths()
    },
    timeoutMs,
    owner,
    onStage,
    onRegionResult,
    onLanguageDetected,
    onSpawn(worker) {
      if (global.registerChildProcess) global.registerChildProcess(worker);
    }
  });
}

function cancelWhisperWorker(owner) {
  let cancelled = sileroVad.cancelVadWorker(owner);
  if (whisperWorkerPool.cancel(owner)) cancelled = true;
  return cancelled;
}

function loadAudioRegions(audioPath, regions) {
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

function attachLanguageMetadata(result, checkpoint) {
  return {
    ...result,
    language: checkpoint?.language?.value || result?.language || null,
    languageConfidence: checkpoint?.language?.confidence ?? result?.languageConfidence ?? null
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

  const validateModel = options.validateModel || validateWhisperOnnxModel;
  const modelValidation = validateModel(options.modelPath, variant);
  if (!modelValidation.ready) {
    const detail = modelValidation.state === 'corrupt'
      ? 'bị hỏng hoặc tải chưa hoàn tất'
      : 'bị thiếu';
    throw new Error(`Model Whisper ONNX ${variant.toUpperCase()} ${detail} tại ${options.modelPath}`);
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

  let speechRegions = Array.isArray(options.speechRegions) ? options.speechRegions : null;
  let vadMetadata = options.vadMetadata;
  if (!speechRegions && options.useVad !== false) {
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
      speechRegions = options.loadCheckpointSamples
        ? options.loadCheckpointSamples(options.audioPath, cachedRegions)
        : cachedRegions.map((region) => ({
            start: Number(region.start),
            end: Number(region.end)
          }));
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
        const vadResult = await detectSpeechRegions(options.audioPath, {
          ...(options.vadOptions || {}),
          includeSamples: false,
          owner: options.owner,
          onProgress(percent) {
            options.onStage?.({ type: 'stage', stage: 'vad_progress', percent });
          }
        });
        vadMetadata = {
          enabled: true,
          durationSeconds: vadResult.durationSeconds,
          speechSeconds: vadResult.speechSeconds,
          regionCount: vadResult.regions.length
        };
        speechRegions = vadResult.regions.map((region) => ({
          start: region.start,
          end: region.end
        }));
        checkpoint.vad = {
          metadata: vadMetadata,
          regions: speechRegions.map(({ start, end }) => ({ start, end }))
        };
        saveCheckpoint();
        options.onStage?.({ type: 'stage', stage: 'vad_complete', ...vadMetadata });
      } catch (error) {
        if (error?.code === 'VAD_CANCELLED') throw error;
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
      const explicitLanguage = normalizeWhisperLanguage(options.language);
      return inferenceWorker({
        audioPath: options.audioPath,
        modelPath: options.modelPath,
        dtype: variantConfig.dtype,
        language: explicitLanguage || checkpoint.language?.value || null,
        detectLanguage: !explicitLanguage && !checkpoint.language?.value,
        timestampLevel: options.timestampLevel,
        owner: options.owner,
        speechRegions: pendingRegions,
        vadMetadata,
        timeoutMs: options.timeoutMs,
        onStage: options.onStage,
        device,
        onLanguageDetected(message) {
          checkpoint.language = {
            value: message.language,
            confidence: Number.isFinite(Number(message.confidence))
              ? Number(message.confidence)
              : null
          };
          saveCheckpoint();
          options.onStage?.({ type: 'stage', stage: 'language_detected', ...checkpoint.language });
        },
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
        return attachLanguageMetadata(combineRegionResults(checkpoint.regions, vadMetadata), checkpoint);
      } catch (error) {
        options.onStage?.({ type: 'stage', stage: 'gpu_fallback', error: error.message });
      }
    }
    await runPendingRegions('cpu');
    return attachLanguageMetadata(combineRegionResults(checkpoint.regions, vadMetadata), checkpoint);
  }

  const baseOptions = {
    audioPath: options.audioPath,
    modelPath: options.modelPath,
    dtype: variantConfig.dtype,
    language: normalizeWhisperLanguage(options.language),
    detectLanguage: !normalizeWhisperLanguage(options.language),
    timestampLevel: options.timestampLevel,
    owner: options.owner,
    vadMetadata,
    timeoutMs: options.timeoutMs,
    onStage: options.onStage,
    onLanguageDetected(message) {
      options.onStage?.({
        type: 'stage',
        stage: 'language_detected',
        value: message.language,
        confidence: message.confidence
      });
    }
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
  const timestampLevel = options.timestampLevel === 'word' ? 'word' : 'segment';
  const sourceChunks = timestampLevel === 'word'
    ? formatWordCaptions(result?.chunks, options.captionOptions)
    : formatSegmentCaptions(result?.chunks, options.captionOptions);
  const cues = normalizeWhisperChunks(sourceChunks, options.durationSeconds, {
    language: result?.language || options.language
  });
  const srt = cues.map((cue, index) => (
    `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`
  )).join('\n');
  if (!srt.trim()) throw new Error('Whisper ONNX không trả về cue có timestamp');
  fs.writeFileSync(options.outputPath, srt, 'utf8');
  const metadataPath = options.metadataPath || `${options.outputPath}.asr.json`;
  writeJsonAtomic(metadataPath, {
    version: 1,
    engineId: 'whisper-onnx',
    variant: options.variant || 'q8',
    language: result?.language || options.language || 'auto',
    languageMode: String(options.language || '').toLowerCase() === 'auto' ? 'auto' : 'manual',
    languageConfidence: result?.languageConfidence ?? null,
    timestampLevel,
    vad: result?.vad || null,
    createdAt: new Date().toISOString(),
    cues: cues.map((cue, index) => ({
      id: String(index + 1),
      text: cue.text,
      startMs: Math.round(cue.start * 1000),
      endMs: Math.round(cue.end * 1000),
      modelConfidence: cue.modelConfidence,
      qualityScore: cue.qualityScore,
      qualitySource: cue.qualitySource,
      warnings: cue.warnings,
      needsReview: cue.needsReview,
      words: Array.isArray(cue.words) ? cue.words.map((word) => ({
        text: word.text,
        startMs: Math.round(Number(word.timestamp?.[0]) * 1000),
        endMs: Math.round(Number(word.timestamp?.[1]) * 1000)
      })) : undefined
    }))
  });
  return { ...result, cues, outputPath: options.outputPath, metadataPath };
}

module.exports = {
  cleanWhisperParentheticalSegmentation,
  cancelWhisperWorker,
  cleanRepeatedParentheticalText,
  attachLanguageMetadata,
  combineRegionResults,
  chunksToSrt,
  filterRepeatedParentheticalCues,
  formatSrtTime,
  loadAudioRegions,
  normalizeWhisperChunks,
  normalizeLanguage,
  normalizeWhisperLanguage,
  resolveWorkerModulePaths,
  transcribeAudio,
  transcribeToSrt
};
