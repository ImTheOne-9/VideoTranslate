'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { getCrawlerPaths, crawlerEnvironment } = require('./crawler-paths');
const { writeJsonAtomic } = require('./checkpoint-utils');

class CapCutAsrError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CapCutAsrError';
    this.code = options.code || 'CAPCUT_ASR_ERROR';
    this.exitCode = options.exitCode;
    this.details = options.details || null;
  }
}

function timestamp(milliseconds) {
  const total = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function normalizeCues(cues, durationMs = 0) {
  const duration = Math.max(0, Number(durationMs) || 0);
  let previousEnd = 0;
  return (Array.isArray(cues) ? cues : []).map((cue) => {
    const startMs = Math.max(previousEnd, Math.round(Number(cue?.startMs) || 0));
    const rawEnd = Math.round(Number(cue?.endMs) || 0);
    const endMs = duration > 0 ? Math.min(duration, rawEnd) : rawEnd;
    const text = String(cue?.text || '').trim();
    if (!text || endMs <= startMs) return null;
    previousEnd = endMs;
    return { text, startMs, endMs };
  }).filter(Boolean);
}

function writeSrt(outputPath, cues) {
  const content = cues.map((cue, index) => (
    `${index + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${cue.text}\n`
  )).join('\n');
  fs.writeFileSync(outputPath, content.replace(/\n/g, '\r\n'), 'utf8');
}

function adaptiveApiTimeoutSeconds(durationMs = 0) {
  const minutes = Math.max(0, Number(durationMs) || 0) / 60_000;
  return Math.round(Math.max(40, Math.min(600, 2 * (6 + 0.8 * minutes) + 25)));
}

function adaptiveProcessTimeoutMs(durationMs = 0, attempts = 2, apiTimeoutSeconds) {
  const attemptCount = Math.max(1, Math.min(10, Number(attempts) || 2));
  const apiSeconds = Math.max(
    30,
    Number(apiTimeoutSeconds) || adaptiveApiTimeoutSeconds(durationMs)
  );
  // Includes audio extraction, upload and retry overhead. The eight-minute
  // floor preserves existing behavior for normal videos.
  return Math.min(
    30 * 60_000,
    Math.max(8 * 60_000, (apiSeconds * attemptCount + 240) * 1000)
  );
}

function runWorker(options = {}) {
  const paths = getCrawlerPaths(options);
  const pythonPath = options.pythonPath || paths.python;
  const workerPath = options.workerPath || path.join(paths.appRoot, 'capcut_asr.py');
  if (!fs.existsSync(pythonPath)) {
    return Promise.reject(new CapCutAsrError(`Thiếu Python runtime: ${pythonPath}`, {
      code: 'CAPCUT_ASR_RUNTIME_MISSING'
    }));
  }
  if (!fs.existsSync(workerPath)) {
    return Promise.reject(new CapCutAsrError(`Thiếu CapCut ASR worker: ${workerPath}`, {
      code: 'CAPCUT_ASR_WORKER_MISSING'
    }));
  }
  const configuredAttempts = options.attempts === undefined
    ? Number(process.env.CAPCUT_ASR_THU_LAI)
    : Number(options.attempts);
  const attempts = Math.max(1, Math.min(10, configuredAttempts || 2));
  const apiTimeoutSeconds = Math.max(
    30,
    Number(options.apiTimeoutSeconds) || adaptiveApiTimeoutSeconds(options.durationMs)
  );
  const args = [
    workerPath,
    '--video', path.resolve(options.videoPath),
    '--output', path.resolve(options.resultPath),
    '--ffmpeg', path.resolve(options.ffmpegPath || paths.ffmpegPath),
    '--ffprobe', path.resolve(options.ffprobePath || paths.ffprobePath),
    '--duration', String(Math.max(0, Number(options.durationMs) || 0) / 1000),
    '--language', options.language || 'auto',
    '--timeout', String(apiTimeoutSeconds),
    '--attempts', String(attempts)
  ];
  return new Promise((resolve, reject) => {
    const child = (options.spawnImpl || spawn)(pythonPath, args, {
      cwd: path.dirname(workerPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: crawlerEnvironment(paths)
    });
    global.registerChildProcess?.(child);
    let stdout = '';
    let stderr = '';
    let lastEvent = null;
    let settled = false;
    const timeoutMs = Math.max(
      60_000,
      Number(options.timeoutMs)
        || adaptiveProcessTimeoutMs(options.durationMs, attempts, apiTimeoutSeconds)
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new CapCutAsrError('CapCut ASR quá hạn; sẽ dùng Faster Whisper local', {
        code: 'CAPCUT_ASR_TIMEOUT'
      }));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + String(chunk || '')).slice(-256 * 1024);
      for (const line of String(chunk || '').split(/\r?\n/).filter(Boolean)) {
        try {
          lastEvent = JSON.parse(line);
          options.onStage?.(lastEvent);
        } catch {}
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk || '')).slice(-64 * 1024);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CapCutAsrError(error.message, { code: 'CAPCUT_ASR_SPAWN_FAILED' }));
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitCode === 0) return resolve({ stdout, stderr, lastEvent });
      reject(new CapCutAsrError(
        lastEvent?.message || stderr.trim() || `CapCut ASR thoát mã ${exitCode}`,
        {
          code: exitCode === 42
            ? 'CAPCUT_ASR_NO_SPEECH'
            : lastEvent?.category === 'network'
              ? 'CAPCUT_ASR_NETWORK'
              : lastEvent?.category === 'api'
                ? 'CAPCUT_ASR_API'
                : 'CAPCUT_ASR_UNAVAILABLE',
          exitCode,
          details: lastEvent
        }
      ));
    });
  });
}

async function transcribeToSrt(options = {}) {
  fs.mkdirSync(options.workDir, { recursive: true });
  const resultPath = options.resultPath || path.join(options.workDir, 'capcut-asr-result.json');
  const outputPath = options.outputPath || path.join(options.workDir, 'capcut-asr.srt');
  try { fs.rmSync(resultPath, { force: true }); } catch {}
  await (options.runWorker || runWorker)({ ...options, resultPath });
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const cues = normalizeCues(result.cues, options.durationMs);
  if (!cues.length) {
    throw new CapCutAsrError('CapCut ASR không trả về cue hợp lệ', { code: 'CAPCUT_ASR_EMPTY' });
  }
  writeSrt(outputPath, cues);
  const metadataPath = `${outputPath}.asr.json`;
  writeJsonAtomic(metadataPath, {
    version: 1,
    engineId: 'capcut-asr',
    online: true,
    uploadedAudio: true,
    language: result.language || options.language || 'auto',
    languageConfidence: result.languageConfidence ?? null,
    createdAt: new Date().toISOString(),
    cues: cues.map((cue, index) => ({ id: String(index + 1), ...cue, source: 'capcut-asr' }))
  });
  return { path: outputPath, metadataPath, cues, language: result.language || options.language || 'auto' };
}

module.exports = {
  CapCutAsrError,
  adaptiveApiTimeoutSeconds,
  adaptiveProcessTimeoutMs,
  normalizeCues,
  runWorker,
  transcribeToSrt,
  writeSrt
};
