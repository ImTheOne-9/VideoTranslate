const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const shared = require('./shared-state');

const MAX_DIAGNOSTIC_LENGTH = 4096;

class OcrTechnicalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OcrTechnicalError';
    this.code = 'OCR_TECHNICAL_ERROR';
  }
}

function detectOcrDevice(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'cpu';

  const windir = options.windir ?? process.env.WINDIR;
  const existsSync = options.existsSync ?? fs.existsSync;
  if (!windir) return 'cpu';

  return existsSync(path.join(windir, 'System32', 'nvcuda.dll')) ? 'gpu' : 'cpu';
}

function isRetryableCudaFailure(diagnosticText) {
  const text = diagnosticText.toLowerCase();
  return /cuda.*(?:initiali[sz]|init)|(?:initiali[sz]|init).*cuda/.test(text)
    || /cuda.*(?:driver|dll)|(?:driver|dll).*cuda|nvcuda\.dll/.test(text)
    || /cudnn.*alloc|alloc.*cudnn/.test(text)
    || /cuda.*out[ -]?of[ -]?memory|out[ -]?of[ -]?memory.*cuda/.test(text);
}

function createTechnicalError(message, diagnosticText, retryableOnCpu = false) {
  const details = diagnosticText.trim();
  const error = new OcrTechnicalError(details ? `${message}: ${details}` : message);
  if (retryableOnCpu) {
    error.retryableOnCpu = true;
  }
  return error;
}

async function runVse({
  executablePath,
  videoPath,
  outputPath,
  language,
  region,
  device,
  cwd,
  onProgress,
  timeoutMs = 30 * 60 * 1000,
  spawnImpl
}) {
  const args = [
    '--video', videoPath,
    '--lang', language,
    '--mode', 'fast',
    '--sub_area', region,
    '--device', device,
    '--output', outputPath
  ];
  const runSpawn = spawnImpl ?? spawn;

  return new Promise((resolve, reject) => {
    let child;
    let stdoutReader;
    let timer;
    let settled = false;
    let diagnosticText = '';
    let sawRetryableCudaFailure = false;
    let result = null;

    const appendDiagnostic = (text) => {
      const nextDiagnosticText = `${diagnosticText}${String(text)}`;
      sawRetryableCudaFailure = sawRetryableCudaFailure
        || isRetryableCudaFailure(nextDiagnosticText);
      diagnosticText = nextDiagnosticText.slice(-MAX_DIAGNOSTIC_LENGTH);
    };

    const cleanUp = () => {
      clearTimeout(timer);
      if (child) {
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        child.stderr?.removeListener('data', onStderr);
      }
      if (stdoutReader) {
        stdoutReader.removeListener('line', onStdoutLine);
        stdoutReader.close();
      }
    };

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanUp();
      callback();
    };

    const onStdoutLine = (line) => {
      try {
        const event = JSON.parse(line);
        if (event.kind === 'progress') {
          onProgress?.(event);
        } else if (typeof event.stage === 'string' && Number.isFinite(event.pct)) {
          onProgress?.({ kind: 'progress', percent: event.pct, ...event });
        }

        if (event.kind === 'result' || event.stage === 'result') {
          result = event;
          appendDiagnostic(`${line}\n`);
        } else if (event.stage === 'error') {
          appendDiagnostic(`${line}\n`);
        } else if (event.kind !== 'progress' && !Number.isFinite(event.pct)) {
          result = event;
          appendDiagnostic(`${line}\n`);
        }
      } catch (error) {
        appendDiagnostic(`${line}\n`);
      }
    };

    const onStderr = (chunk) => appendDiagnostic(chunk);

    const onError = (error) => {
      appendDiagnostic(error?.message ?? error);
      settle(() => reject(createTechnicalError(
        'Unable to start VSE OCR',
        diagnosticText,
        sawRetryableCudaFailure
      )));
    };

    const onClose = (code) => {
      if (code === 2) {
        const confirmedNoSubtitles = result?.stage === 'result'
          && Number(result.cues) === 0;
        if (confirmedNoSubtitles) {
          settle(() => resolve({ kind: 'no_subtitles' }));
        } else {
          settle(() => reject(createTechnicalError(
            'VSE OCR exited with code 2 before returning a no-subtitles result',
            diagnosticText,
            sawRetryableCudaFailure
          )));
        }
        return;
      }
      if (code !== 0) {
        settle(() => reject(createTechnicalError(
          `VSE OCR exited with code ${code}`,
          diagnosticText,
          sawRetryableCudaFailure
        )));
        return;
      }
      if (!fs.existsSync(outputPath)) {
        settle(() => reject(createTechnicalError(
          'VSE OCR completed without the requested output file',
          diagnosticText,
          sawRetryableCudaFailure
        )));
        return;
      }
      settle(() => resolve({ kind: 'success', result }));
    };

    try {
      child = runSpawn(executablePath, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      shared.registerChildProcess(child);
      stdoutReader = readline.createInterface({ input: child.stdout });
      stdoutReader.on('line', onStdoutLine);
      child.stderr?.on('data', onStderr);
      child.once('error', onError);
      child.once('close', onClose);
      timer = setTimeout(() => {
        try {
          shared.killProcessTree(child);
        } catch (error) {
          appendDiagnostic(error?.message ?? error);
        }
        settle(() => reject(createTechnicalError(
          'VSE OCR timed out',
          diagnosticText,
          sawRetryableCudaFailure
        )));
      }, timeoutMs);
    } catch (error) {
      appendDiagnostic(error?.message ?? error);
      settle(() => reject(createTechnicalError(
        'Unable to start VSE OCR',
        diagnosticText,
        sawRetryableCudaFailure
      )));
    }
  });
}

module.exports = {
  OcrTechnicalError,
  detectOcrDevice,
  runVse
};
