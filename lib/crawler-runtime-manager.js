const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getCrawlerPaths, hasPlaywrightChromium } = require('./crawler-paths');

class CrawlerRuntimeManager {
  constructor(options = {}) {
    this.paths = getCrawlerPaths(options);
    this.spawnImpl = options.spawnImpl || spawn;
    this.process = null;
    this.installCapability = null;
    this.installPromise = null;
    const ready = this.ready('crawler');
    this.state = { status: ready ? 'ready' : 'not_installed', percent: ready ? 100 : 0, message: ready ? 'Bộ công cụ hệ thống đã sẵn sàng.' : '', error: null };
  }

  capabilities() {
    const python = fs.existsSync(this.paths.python);
    const asr = python && (
      fs.existsSync(this.paths.asrRuntimeMarkerPath)
      || fs.existsSync(this.paths.resourceAsrRuntimeMarkerPath)
    );
    const ocr = python && (
      fs.existsSync(this.paths.ocrRuntimeMarkerPath)
      || fs.existsSync(this.paths.resourceOcrRuntimeMarkerPath)
    );
    const voice = python && (
      fs.existsSync(this.paths.voiceRuntimeMarkerPath)
      || fs.existsSync(this.paths.resourceVoiceRuntimeMarkerPath)
      || fs.existsSync(this.paths.piperRuntimeMarkerPath)
    );
    const browser = hasPlaywrightChromium(this.paths.playwrightBrowsersDir);
    return {
      python,
      asr,
      ocr,
      voice,
      crawler: python && asr && ocr && voice && browser,
      browser
    };
  }

  ready(capability = 'crawler') {
    const normalized = ['asr', 'ocr', 'voice', 'crawler', 'python'].includes(capability)
      ? capability
      : 'crawler';
    return Boolean(this.capabilities()[normalized]);
  }

  status(capability = 'crawler') {
    const ready = this.ready(capability);
    if (!this.process) this.state.status = ready ? 'ready' : (this.state.status === 'error' ? 'error' : 'not_installed');
    return {
      ...this.state,
      ready,
      capability,
      installingCapability: this.installCapability,
      capabilities: this.capabilities(),
      runtimeRoot: this.paths.runtimeRoot,
      python: this.paths.python,
      browserRoot: this.paths.playwrightBrowsersDir
    };
  }

  install(capability = 'crawler', onLog) {
    if (typeof capability === 'function') {
      onLog = capability;
      capability = 'crawler';
    }
    capability = ['asr', 'ocr', 'crawler'].includes(capability) ? capability : 'crawler';
    if (this.process) return { started: false, alreadyRunning: true, ...this.status(capability) };
    if (this.ready(capability)) return { started: false, alreadyReady: true, ...this.status(capability) };
    const script = path.join(this.paths.bundledRoot, 'tools', 'crawler', 'setup-runtime.ps1');
    const uv = path.join(this.paths.bundledRoot, 'tools', 'uv.exe');
    if (!fs.existsSync(script)) throw new Error(`Thiếu script cài crawler: ${script}`);
    if (!fs.existsSync(uv)) throw new Error(`Thiếu uv.exe: ${uv}`);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const proc = this.spawnImpl(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-RuntimeRoot', this.paths.runtimeRoot, '-Uv', uv, '-Capability', capability
    ], { cwd: this.paths.bundledRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = proc;
    this.installCapability = capability;
    const capabilityLabel = capability === 'asr' ? 'Faster-Whisper' : capability === 'ocr' ? 'RapidOCR' : 'hệ thống';
    this.state = { status: 'installing', percent: 1, message: `Đang chuẩn bị bộ công cụ ${capabilityLabel}…`, error: null };
    this.installPromise = new Promise((resolve, reject) => {
      this._resolveInstall = resolve;
      this._rejectInstall = reject;
    });
    this.installPromise.catch(() => {});
    this._installSettled = false;
    const handle = (chunk, isError = false) => {
      const text = String(chunk || '').trim();
      if (!text) return;
      const percent = text.match(/(\d{1,3})%/g)?.at(-1);
      if (percent) this.state.percent = Math.max(this.state.percent, Math.min(99, Number(percent.replace('%', ''))));
      this.state.message = text.split(/\r?\n/).filter(Boolean).at(-1).slice(0, 300);
      onLog?.(this.state.message, isError ? 'error' : 'info');
    };
    proc.stdout?.on('data', (chunk) => handle(chunk));
    proc.stderr?.on('data', (chunk) => handle(chunk, true));
    proc.once('error', (error) => {
      this.process = null;
      this.installCapability = null;
      this.state = { status: 'error', percent: 0, message: error.message, error: error.message };
      if (!this._installSettled) this._rejectInstall?.(error);
      this._installSettled = true;
      this.installPromise = null;
    });
    proc.once('close', (code) => {
      this.process = null;
      const ready = this.ready(capability);
      this.installCapability = null;
      this.state = ready
        ? { status: 'ready', percent: 100, message: capability === 'asr' ? 'Faster-Whisper runtime đã sẵn sàng.' : capability === 'ocr' ? 'RapidOCR runtime đã sẵn sàng.' : 'Bộ công cụ hệ thống đã sẵn sàng.', error: null }
        : { status: 'error', percent: 0, message: `Cài bộ công cụ thất bại (mã ${code}).`, error: `exit_${code}` };
      if (!this._installSettled) {
        if (ready) this._resolveInstall?.(this.status(capability));
        else this._rejectInstall?.(new Error(this.state.message));
      }
      this._installSettled = true;
      this.installPromise = null;
    });
    return { started: true, pid: proc.pid, ...this.status(capability) };
  }

  async ensure(capability = 'crawler', onLog) {
    if (this.ready(capability)) return this.status(capability);
    if (this.process) {
      await this.installPromise;
      if (!this.ready(capability)) {
        this.install(capability, onLog);
        await this.installPromise;
      }
      return this.status(capability);
    }
    this.install(capability, onLog);
    await this.installPromise;
    return this.status(capability);
  }
}

module.exports = { CrawlerRuntimeManager };
