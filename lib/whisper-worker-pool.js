'use strict';

const childProcess = require('child_process');

class WhisperWorkerPool {
  constructor(options = {}) {
    this.fork = options.forkImpl || childProcess.fork;
    this.idleTimeoutMs = Number.isFinite(options.idleTimeoutMs)
      ? options.idleTimeoutMs
      : 3 * 60 * 1000;
    this.entries = new Set();
    this.idleByKey = new Map();
  }

  createEntry(workerPath, forkOptions, key) {
    const worker = this.fork(workerPath, [], forkOptions);
    const entry = { worker, key, busy: false, current: null, idleTimer: null, stderr: '' };
    this.entries.add(entry);
    worker.stderr?.on('data', (chunk) => {
      entry.stderr += String(chunk);
      if (entry.stderr.length > 16000) entry.stderr = entry.stderr.slice(-16000);
    });
    worker.on('message', (message) => this.handleMessage(entry, message));
    worker.on('error', (error) => this.failEntry(entry, error));
    worker.on('exit', (code, signal) => {
      const details = entry.stderr.trim() || `code=${code}, signal=${signal || 'none'}`;
      this.failEntry(entry, new Error(`Whisper ONNX process dừng bất ngờ: ${details}`));
      this.removeEntry(entry);
    });
    return entry;
  }

  removeEntry(entry) {
    clearTimeout(entry.idleTimer);
    this.entries.delete(entry);
    if (this.idleByKey.get(entry.key) === entry) this.idleByKey.delete(entry.key);
  }

  closeEntry(entry) {
    this.removeEntry(entry);
    try { entry.worker.send({ type: 'shutdown' }); } catch {}
    const timer = setTimeout(() => {
      try { entry.worker.kill('SIGKILL'); } catch {}
    }, 1000);
    timer.unref?.();
  }

  failEntry(entry, error) {
    const current = entry.current;
    entry.current = null;
    entry.busy = false;
    if (!current) return;
    clearTimeout(current.timeout);
    current.reject(error);
  }

  handleMessage(entry, message) {
    const current = entry.current;
    if (!current) return;
    try {
      if (message?.type === 'stage') current.onStage?.(message);
      if (message?.type === 'language_detected') current.onLanguageDetected?.(message);
      if (message?.type === 'region_result') current.onRegionResult?.(message);
    } catch (error) {
      this.finishRequest(entry, () => current.reject(error));
      this.closeEntry(entry);
      return;
    }
    if (message?.type === 'result') this.finishRequest(entry, () => current.resolve(message.result));
    if (message?.type === 'error') {
      this.finishRequest(entry, () => current.reject(new Error(message.error)));
      this.closeEntry(entry);
    }
  }

  finishRequest(entry, callback) {
    const current = entry.current;
    if (!current) return;
    entry.current = null;
    entry.busy = false;
    clearTimeout(current.timeout);
    callback();
    const previous = this.idleByKey.get(entry.key);
    if (previous && previous !== entry) this.closeEntry(previous);
    this.idleByKey.set(entry.key, entry);
    entry.idleTimer = setTimeout(() => this.closeEntry(entry), this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  request(options) {
    const { key, workerPath, forkOptions, payload } = options;
    let entry = this.idleByKey.get(key);
    if (entry) {
      this.idleByKey.delete(key);
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    } else {
      entry = this.createEntry(workerPath, forkOptions, key);
      options.onSpawn?.(entry.worker);
    }
    entry.busy = true;
    entry.stderr = '';
    return new Promise((resolve, reject) => {
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 0;
      const timeout = timeoutMs > 0 ? setTimeout(() => {
        try { entry.worker.kill('SIGKILL'); } catch {}
        this.removeEntry(entry);
        this.failEntry(entry, new Error(`Whisper ONNX timeout sau ${Math.round(timeoutMs / 60000)} phút`));
      }, timeoutMs) : null;
      entry.current = {
        resolve,
        reject,
        timeout,
        owner: options.owner,
        onStage: options.onStage,
        onRegionResult: options.onRegionResult,
        onLanguageDetected: options.onLanguageDetected
      };
      try {
        entry.worker.send(payload);
      } catch (error) {
        this.removeEntry(entry);
        this.failEntry(entry, error);
      }
    });
  }

  cancel(owner) {
    const key = String(owner || '');
    for (const entry of this.entries) {
      if (entry.current?.owner !== key) continue;
      try { entry.worker.kill('SIGKILL'); } catch {}
      this.removeEntry(entry);
      return true;
    }
    return false;
  }

  dispose() {
    for (const entry of [...this.entries]) this.closeEntry(entry);
  }
}

module.exports = { WhisperWorkerPool };
