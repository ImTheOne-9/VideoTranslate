const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getCrawlerPaths } = require('./crawler-paths');

class CrawlerRuntimeManager {
  constructor(options = {}) {
    this.paths = getCrawlerPaths(options);
    this.spawnImpl = options.spawnImpl || spawn;
    this.process = null;
    const ready = this.ready();
    this.state = { status: ready ? 'ready' : 'not_installed', percent: ready ? 100 : 0, message: ready ? 'Runtime crawler đã sẵn sàng.' : '', error: null };
  }

  ready() {
    let hasChromium = false;
    try {
      hasChromium = fs.readdirSync(this.paths.playwrightBrowsersDir, { withFileTypes: true })
        .some((entry) => entry.isDirectory() && /^chromium-\d+$/i.test(entry.name));
    } catch (_) {}
    return fs.existsSync(this.paths.python) && hasChromium;
  }

  status() {
    if (!this.process) this.state.status = this.ready() ? 'ready' : (this.state.status === 'error' ? 'error' : 'not_installed');
    return {
      ...this.state,
      ready: this.ready(),
      runtimeRoot: this.paths.runtimeRoot,
      python: this.paths.python,
      browserRoot: this.paths.playwrightBrowsersDir
    };
  }

  install(onLog) {
    if (this.process) return { started: false, alreadyRunning: true, ...this.status() };
    if (this.ready()) return { started: false, alreadyReady: true, ...this.status() };
    const script = path.join(this.paths.bundledRoot, 'tools', 'crawler', 'setup-runtime.ps1');
    const uv = path.join(this.paths.bundledRoot, 'tools', 'uv.exe');
    if (!fs.existsSync(script)) throw new Error(`Thiếu script cài crawler: ${script}`);
    if (!fs.existsSync(uv)) throw new Error(`Thiếu uv.exe: ${uv}`);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const proc = this.spawnImpl(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-RuntimeRoot', this.paths.runtimeRoot, '-Uv', uv
    ], { cwd: this.paths.bundledRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = proc;
    this.state = { status: 'installing', percent: 1, message: 'Đang chuẩn bị runtime crawler…', error: null };
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
      this.state = { status: 'error', percent: 0, message: error.message, error: error.message };
    });
    proc.once('close', (code) => {
      this.process = null;
      const ready = this.ready();
      this.state = ready
        ? { status: 'ready', percent: 100, message: 'Runtime crawler đã sẵn sàng.', error: null }
        : { status: 'error', percent: 0, message: `Cài runtime thất bại (mã ${code}).`, error: `exit_${code}` };
    });
    return { started: true, pid: proc.pid, ...this.status() };
  }
}

module.exports = { CrawlerRuntimeManager };
