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
    recognizerPath: path.join(moduleRoot, 'ocr_text.py'),
    traditionalDictionaryPath: path.join(moduleRoot, 'zhcdict.json'),
    qualityPath: path.join(moduleRoot, 'chat_luong.py'),
    systemInfoPath: path.join(moduleRoot, 'thong_tin_may.py'),
    diagnosticsPath: path.join(moduleRoot, 'chan_doan_loi.py'),
    cudaCompatPath: path.join(moduleRoot, 'phu_de.py'),
    ortRepairPath: path.join(moduleRoot, 'cai_gpu.py')
  };
}

function getViralOcrStatus(options = {}) {
  const paths = getViralOcrPaths(options);
  const runtimeMarker = fs.existsSync(paths.ocrRuntimeMarkerPath)
    ? paths.ocrRuntimeMarkerPath
    : paths.resourceOcrRuntimeMarkerPath;
  const missing = [
    paths.python,
    runtimeMarker,
    paths.cliPath,
    paths.detectorPath,
    paths.recognizerPath,
    paths.traditionalDictionaryPath,
    paths.qualityPath,
    paths.systemInfoPath,
    paths.diagnosticsPath,
    paths.cudaCompatPath,
    paths.ortRepairPath
  ]
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
  device = 'cpu',
  model = 'v6-small',
  excludedRegions = [],
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
      'Runtime RapidOCR chưa sẵn sàng; hãy cài hoặc cập nhật Runtime Crawler',
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
  if (Array.isArray(excludedRegions) && excludedRegions.length > 0) {
    args.push('--exclude-regions', JSON.stringify(excludedRegions));
  }
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
        if (event.stage === 'progress' || event.stage === 'finalized' || event.stage === 'provider') {
          onProgress?.({ kind: event.stage, ...event });
        }
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
        settle(() => reject(technicalError(`RapidOCR exited with code ${code}`, diagnostic)));
        return;
      }
      if (!fs.existsSync(absoluteOutputPath) || !reportExists) {
        settle(() => reject(technicalError('RapidOCR thiếu SRT hoặc báo cáo đầu ra', diagnostic)));
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
          PYTHONPATH: [paths.moduleRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
          OCR_DUNG_GPU: device === 'gpu' ? '1' : '0',
          OCR_GOP_DAI: process.env.OCR_GOP_DAI || '10',
          OCR_DO_HYBRID: process.env.OCR_DO_HYBRID || '0',
          OCR_GHIM_SHAPE: process.env.OCR_GHIM_SHAPE || '1',
          OCR_GO_WM_CHU: process.env.OCR_GO_WM_CHU || '1',
          OCR_VUNG_TAY_PREMASK: process.env.OCR_VUNG_TAY_PREMASK || '1',
          CHE_SONGNGU: process.env.CHE_SONGNGU || '0'
        }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      shared.registerChildProcess(child);
      reader = readline.createInterface({ input: child.stdout });
      reader.on('line', onLine);
      child.stderr?.on('data', appendDiagnostic);
      child.once('error', (error) => settle(() => reject(technicalError('Không thể khởi động RapidOCR', error.message))));
      child.once('close', onClose);
      timer = setTimeout(() => {
        try {
          shared.killProcessTree(child);
        } catch (error) {
          appendDiagnostic(error.message);
        }
        settle(() => reject(technicalError('RapidOCR timed out', diagnostic)));
      }, timeoutMs);
    } catch (error) {
      settle(() => reject(technicalError('Không thể khởi động RapidOCR', error.message)));
    }
  });
}

module.exports = {
  getViralOcrPaths,
  getViralOcrStatus,
  runViralOcr
};
