'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { getCrawlerPaths } = require('./crawler-paths');

function parseJsonLine(text) {
  const lines = String(text || '').split(/\r?\n/).reverse();
  const line = lines.find((item) => item.startsWith('OCR_GPU_JSON '));
  if (!line) return null;
  try { return JSON.parse(line.slice('OCR_GPU_JSON '.length)); } catch (_) { return null; }
}

function gpuWasRequested() {
  return process.env.OCR_DUNG_GPU === '1' && process.env.OCR_NO_CUDA !== '1';
}

function messageFor(payload = {}, useGpu = gpuWasRequested()) {
  if (payload.gpuReady && useGpu) {
    return `RapidOCR đang dùng GPU · ${payload.gpuName || 'NVIDIA'} · CUDAExecutionProvider`;
  }
  if (payload.gpuReady) {
    return `GPU đã sẵn sàng · RapidOCR mặc định chạy CPU · ${payload.gpuName || 'NVIDIA'}`;
  }
  if (payload.reason === 'no_nvidia') return 'Máy không có GPU NVIDIA · RapidOCR tiếp tục chạy CPU.';
  if (payload.reason === 'unsupported_compute_capability') {
    return `GPU ${payload.gpuName || ''} không hỗ trợ runtime CUDA hiện tại · RapidOCR chạy CPU.`.trim();
  }
  if (payload.reason === 'driver_too_old') {
    return `Driver NVIDIA ${payload.driver || ''} quá cũ · cần cập nhật trước khi bật GPU.`.trim();
  }
  if (payload.installError && payload.restoredCpu) return 'Không bật được GPU; ONNX Runtime CPU đã được khôi phục an toàn.';
  if (payload.nvidia) return `GPU ${payload.gpuName || 'NVIDIA'} chưa được bật cho RapidOCR.`;
  return 'Chưa kiểm tra tăng tốc GPU cho RapidOCR.';
}

class OcrGpuManager {
  constructor(options = {}) {
    this.paths = getCrawlerPaths(options);
    this.spawnImpl = options.spawnImpl || spawn;
    this.probeImpl = options.probeImpl || null;
    this.runtimeReady = options.runtimeReady || (() => fs.existsSync(this.paths.python));
    this.isBusy = options.isBusy || (() => false);
    this.process = null;
    this.state = { status: 'unchecked', percent: 0, message: '', error: null };
    const cached = this.readCachedStatus();
    if (cached) this.applyPayload(cached);
  }

  get installerPath() {
    return path.join(this.paths.bundledRoot, 'tools', 'crawler', 'install-ocr-gpu.py');
  }

  readCachedStatus() {
    try { return JSON.parse(fs.readFileSync(this.paths.ocrGpuStatusPath, 'utf8')); } catch (_) { return null; }
  }

  applyPayload(payload = {}) {
    const gpuReady = payload.gpuReady === true;
    // GPU đã cài chỉ có nghĩa là CUDA sẵn sàng. RapidOCR xử lý nhiều crop
    // phụ đề nhỏ nên CPU vẫn là mặc định; chỉ OCR_DUNG_GPU=1 mới bật GPU.
    const useGpu = gpuReady && gpuWasRequested();
    process.env.OCR_DUNG_GPU = useGpu ? '1' : '0';
    this.state = {
      ...payload,
      status: gpuReady ? 'ready' : (payload.supported === false ? 'unsupported' : 'available'),
      percent: gpuReady ? 100 : 0,
      message: messageFor(payload, useGpu),
      error: null,
      gpuReady,
      provider: gpuReady ? 'CUDAExecutionProvider' : 'CPUExecutionProvider',
      requestedDevice: useGpu ? 'gpu' : 'cpu',
      activeProvider: useGpu ? 'CUDAExecutionProvider' : 'CPUExecutionProvider'
    };
    return this.state;
  }

  status() {
    return {
      ...this.state,
      installing: Boolean(this.process),
      runtimeReady: Boolean(this.runtimeReady()),
      enabled: this.state.gpuReady === true && this.state.requestedDevice === 'gpu',
      statusFile: this.paths.ocrGpuStatusPath
    };
  }

  async refresh() {
    if (this.process) return this.status();
    if (!this.runtimeReady()) {
      this.state = {
        status: 'runtime_required', percent: 0,
        message: 'Hãy tải RapidOCR trước khi cài tăng tốc GPU.', error: null,
        gpuReady: false, provider: 'CPUExecutionProvider'
      };
      return this.status();
    }
    try {
      let payload;
      if (this.probeImpl) {
        payload = await this.probeImpl();
      } else {
        payload = await this.runProbe();
      }
      if (!payload) throw new Error('Trình kiểm tra GPU không trả về trạng thái hợp lệ');
      this.applyPayload(payload);
    } catch (error) {
      const cached = this.readCachedStatus();
      if (cached) this.applyPayload(cached);
      else {
        this.state = {
          status: 'error', percent: 0, message: error.message,
          error: error.message, gpuReady: false, provider: 'CPUExecutionProvider'
        };
      }
    }
    return this.status();
  }

  runProbe() {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.paths.python, [
        this.installerPath, '--status', '--runtime-root', this.paths.runtimeRoot
      ], { cwd: this.paths.runtimeRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk || ''); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk || ''); });
      child.once('error', reject);
      child.once('close', (code) => {
        const payload = parseJsonLine(stdout);
        if (code !== 0 && !payload) return reject(new Error(stderr.trim() || `Kiểm tra GPU lỗi (mã ${code})`));
        resolve(payload);
      });
    });
  }

  install(onLog) {
    if (this.process) return { started: false, alreadyRunning: true, ...this.status() };
    if (this.isBusy()) {
      const error = new Error('Không thể thay runtime GPU trong lúc đang render. Hãy chờ render hoàn tất.');
      error.code = 'OCR_GPU_BUSY';
      throw error;
    }
    if (!this.runtimeReady()) {
      const error = new Error('Hãy tải RapidOCR trước khi cài tăng tốc GPU.');
      error.code = 'OCR_RUNTIME_REQUIRED';
      throw error;
    }
    if (!fs.existsSync(this.installerPath)) throw new Error(`Thiếu trình cài GPU: ${this.installerPath}`);
    const uv = path.join(this.paths.bundledRoot, 'tools', 'uv.exe');
    if (!fs.existsSync(uv)) throw new Error(`Thiếu uv.exe: ${uv}`);

    const proc = this.spawnImpl(this.paths.python, [
      this.installerPath, '--uv', uv, '--runtime-root', this.paths.runtimeRoot
    ], { cwd: this.paths.runtimeRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = proc;
    this.state = {
      status: 'installing', percent: 1, message: 'Đang kiểm tra GPU NVIDIA…',
      error: null, gpuReady: false, provider: 'CPUExecutionProvider'
    };
    let finalPayload = null;
    let diagnostics = '';
    const reader = readline.createInterface({ input: proc.stdout });
    reader.on('line', (line) => {
      const progress = line.match(/^OCR_GPU_PROGRESS\s+(\d{1,3})\s+(.+)$/);
      if (progress) {
        this.state.percent = Math.max(1, Math.min(99, Number(progress[1])));
        this.state.message = progress[2].trim();
        onLog?.(this.state.message, 'info');
        return;
      }
      const payload = parseJsonLine(line);
      if (payload) finalPayload = payload;
      else if (line.trim()) onLog?.(line.trim(), 'info');
    });
    proc.stderr?.on('data', (chunk) => {
      diagnostics = `${diagnostics}${String(chunk || '')}`.slice(-4000);
      const line = String(chunk || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (line) onLog?.(line, 'error');
    });
    proc.once('error', (error) => {
      this.process = null;
      reader.close();
      this.state = { status: 'error', percent: 0, message: error.message, error: error.message, gpuReady: false };
    });
    proc.once('close', (code) => {
      this.process = null;
      reader.close();
      const payload = finalPayload || this.readCachedStatus();
      if (code === 0 && payload) {
        this.applyPayload(payload);
        onLog?.(this.state.message, payload.gpuReady ? 'info' : 'error');
      } else {
        const message = diagnostics.trim().split(/\r?\n/).filter(Boolean).at(-1)
          || `Cài tăng tốc GPU thất bại (mã ${code}).`;
        this.state = { status: 'error', percent: 0, message, error: message, gpuReady: false };
        process.env.OCR_DUNG_GPU = '0';
      }
    });
    return { started: true, pid: proc.pid, ...this.status() };
  }
}

module.exports = { OcrGpuManager, parseJsonLine, messageFor };
