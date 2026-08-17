const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const shared = require('./shared-state');
const { getCrawlerPaths, crawlerEnvironment } = require('./crawler-paths');
const { OcrTechnicalError } = require('./vse-helper');

const MAX_DIAGNOSTIC_LENGTH = 8192;

function getViralOcrPaths(options = {}) {
  const crawlerPaths = getCrawlerPaths(options);
  const moduleRoot = path.join(crawlerPaths.appRoot, 'viral_ocr');
  return {
    ...crawlerPaths,
    moduleRoot,
    cliPath: path.join(moduleRoot, 'viral_ocr_cli.py'),
    detectorPath: path.join(moduleRoot, 'dai_sub_rapid.py'),
    recognizerPath: path.join(moduleRoot, 'ocr_text.py')
  };
}

function getViralOcrStatus(options = {}) {
  const paths = getViralOcrPaths(options);
  const runtimeMarker = fs.existsSync(paths.ocrRuntimeMarkerPath)
    ? paths.ocrRuntimeMarkerPath
    : paths.resourceOcrRuntimeMarkerPath;
  const missing = [paths.python, runtimeMarker, paths.cliPath, paths.detectorPath, paths.recognizerPath]
    .filter((filePath) => !fs.existsSync(filePath));
  return {
    ready: missing.length === 0,
    python: paths.python,
    moduleRoot: paths.moduleRoot,
    missing
  };
}

function technicalError(message, diagnostic = '') {
  const detail = String(diagnostic || '').trim();
  const error = new OcrTechnicalError(detail ? `${message}: ${detail}` : message);
  if (/cuda|cudnn|nvcuda|executionprovider|out of memory/i.test(detail)) {
    error.retryableOnCpu = true;
  }
  return error;
}

function runViralOcr({
  videoPath,
  outputPath,
  reportPath,
  device = 'auto',
  model = 'v6-small',
  cwd,
  onProgress,
  timeoutMs = 60 * 60 * 1000,
  spawnImpl,
  pathOptions
}) {
  const paths = getViralOcrPaths(pathOptions);
  const status = getViralOcrStatus(pathOptions);
  if (!status.ready) {
    throw technicalError(
      'Runtime OCR ViralCrawl chưa sẵn sàng; hãy cài hoặc cập nhật Runtime Crawler',
      status.missing.join(', ')
    );
  }

  const absoluteVideoPath = path.resolve(videoPath);
  const absoluteOutputPath = path.resolve(outputPath);
  const absoluteReportPath = path.resolve(reportPath);
  const args = [
    paths.cliPath,
    '--video', absoluteVideoPath,
    '--output', absoluteOutputPath,
    '--report', absoluteReportPath,
    '--model', model,
    '--device', ['cpu', 'gpu'].includes(device) ? device : 'auto'
  ];
  const runSpawn = spawnImpl || spawn;

  return new Promise((resolve, reject) => {
    let child;
    let reader;
    let timer;
    let settled = false;
    let diagnostic = '';
    let result = null;

    const appendDiagnostic = (value) => {
      diagnostic = `${diagnostic}${String(value || '')}`.slice(-MAX_DIAGNOSTIC_LENGTH);
    };
    const cleanup = () => {
      clearTimeout(timer);
      reader?.close();
      child?.removeAllListeners('error');
      child?.removeAllListeners('close');
      child?.stderr?.removeAllListeners('data');
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onLine = (line) => {
      if (/^LOG:/i.test(line)) {
        onProgress?.({ kind: 'log', stage: 'log', message: line.replace(/^LOG:/i, '').trim() });
        return;
      }
      try {
        const event = JSON.parse(line);
        if (event.stage === 'progress') onProgress?.({ kind: 'progress', ...event });
        if (event.stage === 'log') onProgress?.({ kind: 'log', ...event });
        if (event.stage === 'result') result = event;
        if (event.stage === 'error') appendDiagnostic(`${event.type || 'Error'}: ${event.message}\n`);
      } catch {
        appendDiagnostic(`${line}\n`);
      }
    };
    const onClose = (code) => {
      const reportExists = fs.existsSync(absoluteReportPath);
      if (code === 2 && reportExists && Number(result?.cues) === 0) {
        settle(() => resolve({ kind: 'no_subtitles', result }));
        return;
      }
      if (code !== 0) {
        settle(() => reject(technicalError(`ViralCrawl OCR exited with code ${code}`, diagnostic)));
        return;
      }
      if (!fs.existsSync(absoluteOutputPath) || !reportExists) {
        settle(() => reject(technicalError('ViralCrawl OCR thiếu SRT hoặc báo cáo đầu ra', diagnostic)));
        return;
      }
      settle(() => resolve({ kind: 'success', result }));
    };

    try {
      child = runSpawn(paths.python, args, {
        cwd: cwd || paths.moduleRoot,
        shell: false,
        windowsHide: true,
        env: crawlerEnvironment(paths, {
          PYTHONPATH: [paths.moduleRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
        }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      shared.registerChildProcess(child);
      reader = readline.createInterface({ input: child.stdout });
      reader.on('line', onLine);
      child.stderr?.on('data', appendDiagnostic);
      child.once('error', (error) => settle(() => reject(technicalError('Không thể khởi động ViralCrawl OCR', error.message))));
      child.once('close', onClose);
      timer = setTimeout(() => {
        try {
          shared.killProcessTree(child);
        } catch (error) {
          appendDiagnostic(error.message);
        }
        settle(() => reject(technicalError('ViralCrawl OCR timed out', diagnostic)));
      }, timeoutMs);
    } catch (error) {
      settle(() => reject(technicalError('Không thể khởi động ViralCrawl OCR', error.message)));
    }
  });
}

module.exports = {
  getViralOcrPaths,
  getViralOcrStatus,
  runViralOcr
};
