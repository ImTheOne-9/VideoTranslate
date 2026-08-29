'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getCrawlerPaths } = require('./crawler-paths');

function getOmnivoiceRuntimePaths(options = {}) {
  const crawler = getCrawlerPaths(options);
  const root = path.join(crawler.runtimeRoot, 'omnivoice');
  return {
    ...crawler,
    root,
    python: path.join(root, 'venv', 'Scripts', 'python.exe'),
    sitePackages: path.join(root, 'venv', 'Lib', 'site-packages'),
    torchPackage: path.join(root, 'venv', 'Lib', 'site-packages', 'torch'),
    torchNnPackage: path.join(root, 'venv', 'Lib', 'site-packages', 'torch', 'nn'),
    torchaudioPackage: path.join(root, 'venv', 'Lib', 'site-packages', 'torchaudio'),
    omnivoicePackage: path.join(root, 'venv', 'Lib', 'site-packages', 'omnivoice'),
    marker: path.join(root, 'runtime-v1.json'),
    hfHome: path.join(root, 'hf-cache'),
    queueRoot: path.join(root, 'queue'),
    worker: path.join(crawler.appRoot, 'omnivoice_batch_worker.py'),
    setupScript: path.join(crawler.bundledRoot, 'tools', 'crawler', 'setup-omnivoice-runtime.ps1'),
    uv: path.join(crawler.bundledRoot, 'tools', 'uv.exe')
  };
}

class OmnivoiceRuntimeManager {
  constructor(options = {}) {
    this.paths = getOmnivoiceRuntimePaths(options);
    this.spawnImpl = options.spawnImpl || spawn;
    this.process = null;
    this.state = { status: 'idle', percent: 0, message: '', error: null };
    this.diagnostics = '';
  }

  inspect() {
    const python = fs.existsSync(this.paths.python);
    const marker = fs.existsSync(this.paths.marker);
    const worker = fs.existsSync(this.paths.worker);
    const packagesComplete = fs.existsSync(this.paths.torchPackage)
      && fs.existsSync(this.paths.torchNnPackage)
      && fs.existsSync(this.paths.torchaudioPackage)
      && fs.existsSync(this.paths.omnivoicePackage);
    let metadata = null;
    try { metadata = JSON.parse(fs.readFileSync(this.paths.marker, 'utf8').replace(/^\uFEFF/, '')); } catch (_) {}
    const ready = python && marker && worker && packagesComplete
      && Number(metadata?.version || 0) >= 2
      && metadata?.cudaInferenceVerified === true
      && metadata?.modelInferenceVerified === true
      && metadata?.runtimeHealthVerified === true
      && metadata?.dllPathSanitized === true;
    const liveState = ready
      ? { status: 'ready', percent: 100, message: 'OmniVoice Python đã sẵn sàng.', error: null }
      : this.state;
    if (ready && this.state.status !== 'installing') this.state = liveState;
    return {
      ...liveState,
      ready,
      state: ready ? 'ready' : (this.state.status === 'error' ? 'error' : 'not_installed'),
      python,
      marker,
      worker,
      packagesComplete,
      metadata,
      runtimeRoot: this.paths.root,
      requiresNvidia: true,
      modelId: 'k2-fsa/OmniVoice'
    };
  }

  install(onLog) {
    if (this.process) return { started: false, alreadyRunning: true, ...this.inspect() };
    if (this.inspect().ready) return { started: false, alreadyReady: true, ...this.inspect() };
    if (!fs.existsSync(this.paths.setupScript)) throw new Error(`Thiếu script cài OmniVoice: ${this.paths.setupScript}`);
    if (!fs.existsSync(this.paths.uv)) throw new Error(`Thiếu uv.exe: ${this.paths.uv}`);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const proc = this.spawnImpl(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.paths.setupScript,
      '-RuntimeRoot', this.paths.runtimeRoot, '-Uv', this.paths.uv
    ], { cwd: this.paths.bundledRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = proc;
    this.diagnostics = '';
    this.state = { status: 'installing', percent: 1, message: 'Đang chuẩn bị OmniVoice Python…', error: null };
    const handle = (chunk, error = false) => {
      const text = String(chunk || '').trim();
      if (!text) return;
      this.diagnostics = `${this.diagnostics}\n${text}`.slice(-12_000);
      const match = [...text.matchAll(/(\d{1,3})%/g)].at(-1);
      if (match) this.state.percent = Math.max(this.state.percent, Math.min(99, Number(match[1])));
      this.state.message = text.split(/\r?\n/).filter(Boolean).at(-1).slice(0, 400);
      onLog?.(this.state.message, error ? 'error' : 'info');
    };
    proc.stdout?.on('data', (chunk) => handle(chunk));
    proc.stderr?.on('data', (chunk) => handle(chunk, true));
    proc.once('error', (error) => {
      this.process = null;
      this.state = { status: 'error', percent: 0, message: error.message, error: error.message };
    });
    proc.once('close', (code) => {
      this.process = null;
      const ready = this.inspect().ready;
      const lastDiagnostic = this.diagnostics.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
      this.state = ready
        ? { status: 'ready', percent: 100, message: 'OmniVoice Python đã sẵn sàng.', error: null }
        : {
            status: 'error',
            percent: this.state.percent || 0,
            message: lastDiagnostic || `Cài OmniVoice thất bại (mã ${code}).`,
            error: lastDiagnostic ? `exit_${code}: ${lastDiagnostic}` : `exit_${code}`,
            diagnostics: this.diagnostics.slice(-4000)
          };
    });
    return { started: true, pid: proc.pid, ...this.inspect() };
  }

  cancel() {
    if (!this.process) return false;
    try { this.process.kill('SIGTERM'); } catch (_) {}
    this.process = null;
    this.state = { status: 'cancelled', percent: 0, message: 'Đã hủy cài OmniVoice.', error: null };
    return true;
  }
}

const omnivoiceRuntimeManager = new OmnivoiceRuntimeManager();

module.exports = {
  OmnivoiceRuntimeManager,
  getOmnivoiceRuntimePaths,
  omnivoiceRuntimeManager
};
