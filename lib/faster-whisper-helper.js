'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { getCrawlerPaths, crawlerEnvironment } = require('./crawler-paths');
const { assessAsrCue } = require('./asr-quality');
const { formatSegmentCaptions, formatWordCaptions } = require('./caption-formatter');
const { normalizeWhisperChunks } = require('./whisper-onnx-helper');
const { writeJsonAtomic } = require('./checkpoint-utils');

const activeProcesses = new Map();
const CHINESE_LANGUAGES = new Set(['ch', 'zh', 'zh-cn', 'zh-tw', 'chinese']);

class FasterWhisperError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'FasterWhisperError';
    this.code = options.code || 'FASTER_WHISPER_ERROR';
    this.exitCode = options.exitCode;
    this.details = options.details || null;
  }
}

function resolveRuntime(options = {}) {
  const paths = getCrawlerPaths(options);
  return {
    paths,
    pythonPath: options.pythonPath || paths.python,
    workerPath: options.workerPath || path.join(paths.appRoot, 'faster_whisper_asr.py')
  };
}

function countScriptCharacters(text) {
  const normalized = String(text || '');
  return {
    letters: (normalized.match(/\p{L}/gu) || []).length,
    han: (normalized.match(/[\p{Script=Han}]/gu) || []).length,
    replacements: (normalized.match(/\uFFFD/gu) || []).length
  };
}

function validateFasterWhisperResult(result, options = {}) {
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const language = String(options.language || result?.language || '').toLowerCase();
  const durationSeconds = Number(options.durationSeconds || result?.duration);
  const text = segments.map((segment) => String(segment?.text || '')).join(' ');
  const script = countScriptCharacters(text);
  const expectedChinese = CHINESE_LANGUAGES.has(language);
  const hanRatio = script.han / Math.max(1, script.letters);
  const issues = [];
  if (segments.length === 0) issues.push('empty_segments');
  if (script.replacements > 0) issues.push('replacement_characters');
  if (expectedChinese && script.letters >= 24 && hanRatio < 0.65) issues.push('wrong_script');
  let previousEnd = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const start = Number(segments[index]?.start);
    const end = Number(segments[index]?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      issues.push(`invalid_timestamp:${index}`);
      continue;
    }
    if (start + 0.05 < previousEnd) issues.push(`overlap:${index}`);
    if (Number.isFinite(durationSeconds) && end > durationSeconds + 1) issues.push(`past_duration:${index}`);
    previousEnd = Math.max(previousEnd, end);
  }
  return {
    valid: issues.length === 0,
    issues: issues.slice(0, 20),
    segmentCount: segments.length,
    replacementCount: script.replacements,
    hanRatio
  };
}

function recordGpuWatchdogFailure(statePath, message) {
  try {
    let previous = {};
    try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    const failureCount = Math.max(0, Number(previous.failureCount) || 0) + 1;
    writeJsonAtomic(statePath, {
      version: 1,
      failureCount,
      disabledUntil: failureCount >= 2 ? Date.now() / 1000 + 30 * 60 : 0,
      lastFailure: Date.now() / 1000,
      lastError: String(message || '').slice(0, 500),
      watchdog: true
    });
  } catch {}
}

function runWorker(options = {}) {
  const runtime = resolveRuntime(options);
  if (!fs.existsSync(runtime.pythonPath)) {
    return Promise.reject(new FasterWhisperError(`Thiếu Python runtime: ${runtime.pythonPath}`, {
      code: 'FASTER_WHISPER_RUNTIME_MISSING'
    }));
  }
  if (!fs.existsSync(runtime.workerPath)) {
    return Promise.reject(new FasterWhisperError(`Thiếu faster-whisper worker: ${runtime.workerPath}`, {
      code: 'FASTER_WHISPER_WORKER_MISSING'
    }));
  }
  const gpuStatePath = options.gpuStatePath || path.join(runtime.paths.runtimeRoot, 'faster-whisper-gpu-state.json');
  const gpuLockPath = options.gpuLockPath || path.join(runtime.paths.runtimeRoot, 'faster-whisper-gpu.lock');
  const inputPath = options.sourcePath || options.audioPath;
  const args = options.check
    ? [runtime.workerPath, '--check', '--gpu-state', gpuStatePath]
    : [
        runtime.workerPath,
        '--audio', path.resolve(inputPath),
        '--output', path.resolve(options.resultPath),
        '--checkpoint', path.resolve(options.checkpointPath || path.join(options.workDir, 'faster-whisper-checkpoint.json')),
        '--ffmpeg', path.resolve(options.ffmpegPath || runtime.paths.ffmpegPath),
        '--gpu-state', path.resolve(gpuStatePath),
        '--gpu-lock', path.resolve(gpuLockPath),
        '--duration', String(Number.isFinite(Number(options.durationSeconds)) ? Number(options.durationSeconds) : 0),
        '--model-root', path.resolve(options.modelRoot),
        '--model', options.model || 'large-v3-turbo',
        '--language', options.language || 'auto',
        '--device', options.device || 'auto'
      ];
  if (options.localFilesOnly) args.push('--local-files-only');
  if (options.disableVadFallback) args.push('--disable-vad-fallback');
  return new Promise((resolve, reject) => {
    const child = (options.spawnImpl || spawn)(runtime.pythonPath, args, {
      cwd: path.dirname(runtime.workerPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: crawlerEnvironment(runtime.paths, {
        HF_HOME: options.modelRoot ? path.resolve(options.modelRoot) : undefined,
        HF_HUB_DISABLE_TELEMETRY: '1'
      })
    });
    if (options.owner) activeProcesses.set(options.owner, child);
    global.registerChildProcess?.(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let watchdogError = null;
    let actualDevice = String(options.device || '').toLowerCase() === 'cpu' ? 'cpu' : null;
    const durationSeconds = Math.max(0, Number(options.durationSeconds) || 0);
    const minimumWatchdogMs = options.allowUnsafeTimeoutForTest ? 10 : 60_000;
    const stallTimeoutMs = Math.max(minimumWatchdogMs, Number(options.stallTimeoutMs) || 4 * 60_000);
    const hardTimeoutMs = Math.max(
      30 * 60_000,
      Number(options.hardTimeoutMs) || Math.min(8 * 60 * 60_000, (durationSeconds * 6 + 600) * 1000)
    );
    let stallTimer;
    let hardTimer;
    const clearWatchdogs = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const stopForWatchdog = (code, message) => {
      if (settled || watchdogError) return;
      watchdogError = new FasterWhisperError(message, { code });
      if (actualDevice === 'cuda') recordGpuWatchdogFailure(gpuStatePath, message);
      try { child.kill('SIGKILL'); } catch {}
    };
    const armStallWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stopForWatchdog(
        'FASTER_WHISPER_STALLED',
        `Faster-Whisper không phát heartbeat trong ${Math.round(stallTimeoutMs / 1000)} giây; đã dừng để tránh treo render`
      ), stallTimeoutMs);
    };
    armStallWatchdog();
    hardTimer = setTimeout(() => stopForWatchdog(
      'FASTER_WHISPER_TIMEOUT',
      `Faster-Whisper vượt thời hạn ${Math.round(hardTimeoutMs / 60000)} phút; đã dừng tiến trình`
    ), hardTimeoutMs);
    child.stdout?.on('data', (chunk) => {
      armStallWatchdog();
      stdout = (stdout + String(chunk || '')).slice(-512 * 1024);
      for (const line of String(chunk || '').split(/\r?\n/).filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'loading_model' && event.device) actualDevice = event.device;
          options.onStage?.(event);
        } catch {}
      }
    });
    child.stderr?.on('data', (chunk) => {
      armStallWatchdog();
      stderr = (stderr + String(chunk || '')).slice(-128 * 1024);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearWatchdogs();
      reject(new FasterWhisperError(error.message, {
        code: 'FASTER_WHISPER_SPAWN_FAILED',
        details: { stderr }
      }));
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearWatchdogs();
      if (options.owner && activeProcesses.get(options.owner) === child) activeProcesses.delete(options.owner);
      if (watchdogError) return reject(watchdogError);
      if (exitCode === 0) return resolve({ stdout, stderr });
      const lastEvent = stdout.trim().split(/\r?\n/).reverse().map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(Boolean);
      reject(new FasterWhisperError(lastEvent?.message || stderr.trim() || `faster-whisper thoát mã ${exitCode}`, {
        code: exitCode === 43 ? 'FASTER_WHISPER_QUALITY_REJECTED' : 'FASTER_WHISPER_PROCESS_FAILED',
        exitCode,
        details: lastEvent
      }));
    });
  });
}

function cancelFasterWhisper(owner) {
  const child = activeProcesses.get(owner);
  if (!child) return false;
  activeProcesses.delete(owner);
  try { child.kill('SIGKILL'); } catch {}
  return true;
}

async function checkStatus(options = {}) {
  try {
    let statusEvent = null;
    await (options.runWorker || runWorker)({
      ...options,
      check: true,
      onStage(event) {
        if (event.event === 'status') statusEvent = event;
        options.onStage?.(event);
      }
    });
    return { ready: Boolean(statusEvent?.ready), state: statusEvent?.ready ? 'ready' : 'unavailable', ...statusEvent };
  } catch (error) {
    return { ready: false, state: 'missing', error: error.message, code: error.code };
  }
}

function rawSegmentsToChunks(segments) {
  return (Array.isArray(segments) ? segments : []).map((segment) => ({
    text: String(segment.text || '').trim(),
    timestamp: [
      Number.isFinite(Number(segment.startMs)) ? Number(segment.startMs) / 1000 : Number(segment.start),
      Number.isFinite(Number(segment.endMs)) ? Number(segment.endMs) / 1000 : Number(segment.end)
    ],
    avg_logprob: Number(segment.avgLogprob),
    no_speech_prob: Number(segment.noSpeechProb),
    words: (Array.isArray(segment.words) ? segment.words : []).map((word) => ({
      text: String(word.text || '').trim(),
      timestamp: [Number(word.start), Number(word.end)],
      probability: Number(word.probability)
    })).filter((word) => word.text
      && Number.isFinite(word.timestamp[0])
      && Number.isFinite(word.timestamp[1])
      && word.timestamp[1] > word.timestamp[0])
  })).filter((segment) => segment.text);
}

async function transcribeAudio(options = {}) {
  const resultPath = options.resultPath || path.join(options.workDir, 'faster-whisper-result.json');
  try { fs.rmSync(resultPath, { force: true }); } catch {}
  const worker = options.runWorker || runWorker;
  try {
    await worker({ ...options, resultPath });
  } catch (error) {
    const watchdogStopped = ['FASTER_WHISPER_STALLED', 'FASTER_WHISPER_TIMEOUT'].includes(error?.code);
    if (!watchdogStopped || String(options.device || 'auto').toLowerCase() === 'cpu') throw error;
    options.onStage?.({ event: 'watchdog_cpu_resume', message: error.message });
    await worker({ ...options, resultPath, device: 'cpu' });
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const quality = validateFasterWhisperResult(result, options);
  if (!quality.valid) {
    throw new FasterWhisperError(`Kết quả faster-whisper không đạt quality gate: ${quality.issues.join(', ')}`, {
      code: 'FASTER_WHISPER_QUALITY_REJECTED',
      details: quality
    });
  }
  return {
    ...result,
    text: result.segments.map((segment) => segment.text).join(' '),
    chunks: rawSegmentsToChunks(result.segments),
    quality
  };
}

async function transcribeToSrt(options = {}) {
  const result = await transcribeAudio(options);
  const timestampLevel = options.timestampLevel === 'word' ? 'word' : 'segment';
  const sourceChunks = timestampLevel === 'word'
    ? formatWordCaptions(result.chunks.flatMap((chunk) => chunk.words || []), options.captionOptions)
    : formatSegmentCaptions(result.chunks, options.captionOptions);
  const cues = normalizeWhisperChunks(sourceChunks, options.durationSeconds, {
    language: result.language || options.language
  });
  if (!cues.length) throw new FasterWhisperError('faster-whisper không trả về cue hợp lệ', {
    code: 'FASTER_WHISPER_EMPTY_SRT'
  });
  const srt = cues.map((cue, index) => {
    const format = (seconds) => {
      const totalMs = Math.round(Math.max(0, seconds) * 1000);
      const h = Math.floor(totalMs / 3600000);
      const m = Math.floor((totalMs % 3600000) / 60000);
      const s = Math.floor((totalMs % 60000) / 1000);
      const ms = totalMs % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    return `${index + 1}\n${format(cue.start)} --> ${format(cue.end)}\n${cue.text}\n`;
  }).join('\n');
  fs.writeFileSync(options.outputPath, srt.replace(/\n/g, '\r\n'), 'utf8');
  const metadataPath = options.metadataPath || `${options.outputPath}.asr.json`;
  writeJsonAtomic(metadataPath, {
    version: 1,
    engineId: 'faster-whisper',
    variant: result.model || options.model || 'large-v3-turbo',
    device: result.device,
    computeType: result.computeType,
    language: result.language || options.language || 'auto',
    languageConfidence: result.languageProbability ?? null,
    timestampLevel,
    quality: result.quality,
    inputMode: result.inputMode || 'unknown',
    vadFallbackUsed: Boolean(result.vadFallbackUsed),
    gpuFallbackUsed: Boolean(result.gpuFallbackUsed),
    gpuError: result.gpuError || null,
    filteredHallucinations: result.filteredHallucinations || {},
    createdAt: new Date().toISOString(),
    cues: cues.map((cue, index) => ({
      id: String(index + 1),
      text: cue.text,
      startMs: Math.round(cue.start * 1000),
      endMs: Math.round(cue.end * 1000),
      ...assessAsrCue(cue, { language: result.language || options.language })
    }))
  });
  return { ...result, cues, outputPath: options.outputPath, metadataPath };
}

module.exports = {
  FasterWhisperError,
  cancelFasterWhisper,
  checkStatus,
  countScriptCharacters,
  rawSegmentsToChunks,
  recordGpuWatchdogFailure,
  resolveRuntime,
  runWorker,
  transcribeAudio,
  transcribeToSrt,
  validateFasterWhisperResult
};
