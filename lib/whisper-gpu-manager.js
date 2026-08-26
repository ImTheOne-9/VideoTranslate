'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { getCrawlerPaths } = require('./crawler-paths');

function parseWhisperGpuJson(text) {
  const line = String(text || '').split(/\r?\n/u).reverse()
    .find((item) => item.startsWith('WHISPER_GPU_JSON '));
  if (!line) return null;
  try { return JSON.parse(line.slice('WHISPER_GPU_JSON '.length)); } catch (_) { return null; }
}

function messageFor(payload = {}) {
  if (payload.gpuReady && payload.actualInference) {
    return `Whisper GPU sẵn sàng · ${payload.gpuName || 'NVIDIA'} · Large V3 Turbo CUDA đã chạy thật`;
  }
  if (payload.reason === 'model_required') return 'Hãy tải model Large V3 Turbo trước khi cài GPU.';
  if (payload.reason === 'no_nvidia') return 'Máy không có GPU NVIDIA · Whisper sẽ chạy CPU int8.';
  if (payload.reason === 'driver_too_old') return `Driver NVIDIA ${payload.driver || ''} quá cũ · cần cập nhật trước.`.trim();
  if (payload.reason === 'unsupported_compute_capability') return `GPU ${payload.gpuName || ''} không hỗ trợ CUDA runtime hiện tại.`.trim();
  if (payload.detail) return `Whisper GPU chưa sẵn sàng · ${String(payload.detail).slice(0, 220)}`;
  return 'Chưa kiểm tra tăng tốc GPU Whisper.';
}

class WhisperGpuManager {
  constructor(options = {}) {
    this.paths = getCrawlerPaths(options);
    this.modelsDir = path.resolve(options.modelsDir || path.join(this.paths.bundledRoot, 'models'));
    this.spawnImpl = options.spawnImpl || spawn;
    this.runtimeReady = options.runtimeReady || (() => fs.existsSync(this.paths.python));
    this.modelReady = options.modelReady || (() => false);
    this.isBusy = options.isBusy || (() => false);
    this.process = null;
    this.refreshPromise = null;
    this.state = { status: 'unchecked', percent: 0, message: '', error: null, gpuReady: false };
    const cached = this.readCachedStatus();
    if (cached) this.applyPayload(cached);
  }

  get installerPath() {
    return path.join(this.paths.bundledRoot, 'tools', 'crawler', 'install-whisper-gpu.py');
  }

  get modelRoot() {
    return path.join(this.modelsDir, 'whisper', 'faster-whisper');
  }

  readCachedStatus() {
    try { return JSON.parse(fs.readFileSync(this.paths.whisperGpuStatusPath, 'utf8')); } catch (_) { return null; }
  }

  applyPayload(payload = {}) {
    const gpuReady = payload.gpuReady === true && payload.actualInference === true;
    this.state = {
      ...payload,
      status: gpuReady ? 'ready'
        : payload.reason === 'model_required' ? 'model_required'
          : payload.supported === false ? 'unsupported' : 'available',
      percent: gpuReady ? 100 : 0,
      message: messageFor(payload),
      error: null,
      gpuReady,
      device: gpuReady ? 'cuda' : 'cpu'
    };
    return this.state;
  }

  status() {
    return {
      ...this.state,
      installing: Boolean(this.process),
      runtimeReady: Boolean(this.runtimeReady()),
      modelReady: Boolean(this.modelReady()),
      statusFile: this.paths.whisperGpuStatusPath
    };
  }

  childArgs(mode) {
    const args = [this.installerPath];
    if (mode === '--status') args.push('--status');
    args.push('--runtime-root', this.paths.runtimeRoot,
      '--model-root', this.modelRoot, '--app-root', this.paths.appRoot);
    if (mode !== '--status') {
      args.push('--uv', path.join(this.paths.bundledRoot, 'tools', 'uv.exe'));
    }
    return args;
  }

  async refresh() {
    if (this.process) return this.status();
    if (!this.runtimeReady()) {
      this.state = { status: 'runtime_required', percent: 0, message: 'Hãy cài Faster-Whisper trước.', error: null, gpuReady: false };
      return this.status();
    }
    if (!this.modelReady()) {
      this.state = { status: 'model_required', percent: 0, message: 'Hãy tải model Large V3 Turbo trước.', error: null, gpuReady: false };
      return this.status();
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.runStatus().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  runStatus() {
    return new Promise((resolve) => {
      const child = this.spawnImpl(this.paths.python, this.childArgs('--status'), {
        cwd: this.paths.runtimeRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk || ''); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk || ''); });
      child.once('error', (error) => {
        this.state = { status: 'error', percent: 0, message: error.message, error: error.message, gpuReady: false };
        resolve(this.status());
      });
      child.once('close', () => {
        const payload = parseWhisperGpuJson(stdout) || this.readCachedStatus();
        if (payload) this.applyPayload(payload);
        else {
          const message = stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1) || 'Kiểm tra Whisper GPU không trả kết quả.';
          this.state = { status: 'error', percent: 0, message, error: message, gpuReady: false };
        }
        resolve(this.status());
      });
    });
  }

  install(onLog) {
    if (this.process) return { started: false, alreadyRunning: true, ...this.status() };
    if (this.isBusy()) {
      const error = new Error('Không thể sửa GPU trong lúc đang render. Hãy chờ render hoàn tất.');
      error.code = 'WHISPER_GPU_BUSY';
      throw error;
    }
    if (!this.runtimeReady() || !this.modelReady()) {
      const error = new Error('Hãy cài Faster-Whisper và tải model Large V3 Turbo trước.');
      error.code = 'WHISPER_RUNTIME_REQUIRED';
      throw error;
    }
    if (!fs.existsSync(this.installerPath)) throw new Error(`Thiếu trình cài GPU Whisper: ${this.installerPath}`);
    const uv = path.join(this.paths.bundledRoot, 'tools', 'uv.exe');
    if (!fs.existsSync(uv)) throw new Error(`Thiếu uv.exe: ${uv}`);

    const proc = this.spawnImpl(this.paths.python, this.childArgs('--install'), {
      cwd: this.paths.runtimeRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process = proc;
    this.state = { status: 'installing', percent: 1, message: 'Đang kiểm tra GPU NVIDIA…', error: null, gpuReady: false };
    let finalPayload = null;
    let diagnostics = '';
    const reader = readline.createInterface({ input: proc.stdout });
    reader.on('line', (line) => {
      const progress = line.match(/^WHISPER_GPU_PROGRESS\s+(\d{1,3})\s+(.+)$/u);
      if (progress) {
        this.state.percent = Math.max(1, Math.min(99, Number(progress[1])));
        this.state.message = progress[2].trim();
        onLog?.(this.state.message, 'info');
        return;
      }
      const payload = parseWhisperGpuJson(line);
      if (payload) finalPayload = payload;
      else if (line.trim()) onLog?.(line.trim(), 'info');
    });
    proc.stderr?.on('data', (chunk) => {
      diagnostics = `${diagnostics}${String(chunk || '')}`.slice(-5000);
      const line = String(chunk || '').trim().split(/\r?\n/u).filter(Boolean).at(-1);
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
      if (code === 0 && payload) this.applyPayload(payload);
      else {
        const message = diagnostics.trim().split(/\r?\n/u).filter(Boolean).at(-1) || `Cài Whisper GPU thất bại (mã ${code}).`;
        this.state = { status: 'error', percent: 0, message, error: message, gpuReady: false };
      }
    });
    return { started: true, pid: proc.pid, ...this.status() };
  }
}

module.exports = { WhisperGpuManager, parseWhisperGpuJson, messageFor };
