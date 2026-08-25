'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getCrawlerPaths } = require('./crawler-paths');

function validModelFile(modelPath) {
  try {
    if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 1_000_000) return false;
    const descriptor = fs.openSync(modelPath, 'r');
    const header = Buffer.alloc(16);
    try { fs.readSync(descriptor, header, 0, header.length, 0); }
    finally { fs.closeSync(descriptor); }
    const prefix = header.toString('utf8').trimStart();
    return !prefix.startsWith('<') && !prefix.startsWith('{');
  } catch (_) {
    return false;
  }
}

function parseLastJson(text) {
  const lines = String(text || '').trim().split(/\r?\n/u).filter(Boolean).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch (_) {}
  }
  return null;
}

class PiperRuntimeManager {
  constructor(options = {}) {
    this.paths = getCrawlerPaths(options);
    this.spawnImpl = options.spawnImpl || spawn;
    this.spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    this.process = null;
    this.state = { status: 'idle', percent: 0, message: '', error: null };
  }

  inspect() {
    const pythonExists = fs.existsSync(this.paths.python);
    const bridgePath = path.join(this.paths.appRoot, 'piper_tts_bridge.py');
    const bridgeExists = fs.existsSync(bridgePath);
    const defaultModelPath = path.join(this.paths.piperModelsDir, 'ngochuyen.onnx');
    const defaultConfigPath = `${defaultModelPath}.json`;
    const base = {
      runtimeRoot: this.paths.runtimeRoot,
      python: this.paths.python,
      pythonExists,
      bridgePath,
      bridgeExists,
      markerExists: fs.existsSync(this.paths.piperRuntimeMarkerPath),
      modelDir: this.paths.piperModelsDir,
      defaultModel: {
        voice: 'ngochuyen',
        ready: validModelFile(defaultModelPath) && fs.existsSync(defaultConfigPath),
        modelPath: defaultModelPath,
        configPath: defaultConfigPath
      }
    };
    if (!pythonExists || !bridgeExists) {
      return {
        ...base,
        ready: false,
        providers: [],
        error: !pythonExists ? 'Chưa có Python runtime cho Piper.' : 'Thiếu piper_tts_bridge.py.'
      };
    }
    const checked = this.spawnSyncImpl(this.paths.python, [bridgePath, '--check'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        VIDEO_STUDIO_CRAWLER_RUNTIME: this.paths.runtimeRoot,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    });
    const details = parseLastJson(checked.stdout);
    const ready = checked.status === 0 && details?.ok === true;
    const diagnostic = details?.error || String(checked.stderr || '').trim() || checked.error?.message || '';
    return {
      ...base,
      ready,
      providers: Array.isArray(details?.providers) ? details.providers : [],
      dependencies: details?.dependencies || null,
      error: ready ? null : (diagnostic || `Piper kiểm tra thất bại (mã ${checked.status ?? 'spawn_error'}).`)
    };
  }

  status() {
    if (this.process) {
      return {
        ...this.state,
        ready: false,
        installing: true,
        runtimeRoot: this.paths.runtimeRoot,
        python: this.paths.python,
        modelDir: this.paths.piperModelsDir
      };
    }
    const inspected = this.inspect();
    return {
      ...inspected,
      installing: false,
      status: inspected.ready ? 'ready' : (this.state.status === 'error' ? 'error' : 'not_installed'),
      percent: inspected.ready ? 100 : 0,
      message: inspected.ready ? 'Piper offline đã sẵn sàng.' : (this.state.message || inspected.error || ''),
      error: inspected.ready ? null : (this.state.error || inspected.error || null)
    };
  }

  install(options = {}, onLog) {
    if (typeof options === 'function') {
      onLog = options;
      options = {};
    }
    if (this.process) return { started: false, alreadyRunning: true, ...this.status() };
    const current = this.inspect();
    const forceRepair = options.force === true || (current.pythonExists && !current.ready);
    if (current.ready && !options.force) return { started: false, alreadyReady: true, ...this.status() };

    const script = path.join(this.paths.bundledRoot, 'tools', 'crawler', 'setup-piper-runtime.ps1');
    const uv = path.join(this.paths.bundledRoot, 'tools', 'uv.exe');
    if (!fs.existsSync(script)) throw new Error(`Thiếu script cài Piper: ${script}`);
    if (!fs.existsSync(uv)) throw new Error(`Thiếu uv.exe: ${uv}`);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-RuntimeRoot', this.paths.runtimeRoot,
      '-Uv', uv
    ];
    if (forceRepair) args.push('-ForceRepair');
    const proc = this.spawnImpl(powershell, args, {
      cwd: this.paths.bundledRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process = proc;
    this.state = {
      status: 'installing',
      percent: 1,
      message: forceRepair ? 'Đang kiểm tra và sửa Piper…' : 'Đang cài Piper offline…',
      error: null
    };
    const handle = (chunk, isError = false) => {
      const output = String(chunk || '').trim();
      if (!output) return;
      const percent = output.match(/(\d{1,3})%/gu)?.at(-1);
      if (percent) this.state.percent = Math.max(this.state.percent, Math.min(99, Number(percent.replace('%', ''))));
      this.state.message = output.split(/\r?\n/u).filter(Boolean).at(-1).slice(0, 300);
      onLog?.(this.state.message, isError ? 'error' : 'info');
    };
    proc.stdout?.on('data', chunk => handle(chunk));
    proc.stderr?.on('data', chunk => handle(chunk, true));
    proc.once('error', error => {
      this.process = null;
      this.state = { status: 'error', percent: 0, message: error.message, error: error.message };
    });
    proc.once('close', code => {
      this.process = null;
      const verified = this.inspect();
      this.state = verified.ready
        ? { status: 'ready', percent: 100, message: 'Piper offline đã sẵn sàng.', error: null }
        : {
            status: 'error',
            percent: 0,
            message: verified.error || `Cài Piper thất bại (mã ${code}).`,
            error: verified.error || `exit_${code}`
          };
    });
    return { started: true, repairing: forceRepair, pid: proc.pid, ...this.status() };
  }
}

module.exports = {
  PiperRuntimeManager,
  parseLastJson,
  validModelFile
};
