'use strict';

const fs = require('fs');
const path = require('path');
const { resolveOmnivoiceSeed } = require('../voice-defaults');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');

const SUPPORTED_LANGUAGES = ['vi', 'en', 'zh'];
const SUPPORTED_DEVICES = ['cpu', 'vulkan:0', 'cuda:0'];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function replaceDevice(args, device) {
  const result = [...args];
  const index = result.indexOf('--device');
  if (index >= 0) result[index + 1] = device;
  return result;
}

class CurrentOmniVoiceEngine extends VoiceEngine {
  constructor(options = {}) {
    super({
      id: options.id || 'current-omnivoice',
      name: options.name || 'OmniVoice hiện tại',
      version: options.version || '1'
    });
    this.cliPath = options.cliPath;
    this.modelPath = options.modelPath;
    this.existsSync = options.existsSync || fs.existsSync;
    this.statSync = options.statSync || fs.statSync;
    this.runCli = options.runCli;
    this.spawnCli = options.spawnCli;
    this.killProcess = options.killProcess || ((processHandle) => processHandle?.kill('SIGTERM'));
    this.serverManager = options.serverManager || null;
    this.activeProcesses = new Set();
  }

  getCapabilities() {
    let modelSizeBytes = null;
    try {
      if (this.modelPath && this.existsSync(this.modelPath)) {
        modelSizeBytes = this.statSync(this.modelPath).size;
      }
    } catch {}
    const persistentDevices = SUPPORTED_DEVICES.filter((device) => (
      this.serverManager?.isAvailable(device)
    ));
    return {
      cloneVoice: true,
      languages: [...SUPPORTED_LANGUAGES],
      devices: [...SUPPORTED_DEVICES],
      modelSizeBytes,
      sampleRate: 24000,
      emotion: false,
      speedControl: false,
      durationControl: true,
      persistentRuntime: persistentDevices.length > 0,
      referencePromptCache: persistentDevices.length > 0,
      persistentDevices
    };
  }

  async checkStatus() {
    const cliExists = Boolean(this.cliPath && this.existsSync(this.cliPath));
    const modelExists = Boolean(this.modelPath && this.existsSync(this.modelPath));
    return {
      ready: cliExists && modelExists,
      state: cliExists && modelExists ? 'ready' : 'not_installed',
      cliExists,
      modelExists,
      cliPath: this.cliPath || null,
      modelPath: this.modelPath || null
    };
  }

  async loadModel() {
    const status = await this.checkStatus();
    if (!status.ready) {
      const missing = [];
      if (!status.cliExists) missing.push('OmniVoice CLI');
      if (!status.modelExists) missing.push('model GGUF');
      throw new VoiceEngineError(`Thieu ${missing.join(' va ')}`, {
        code: 'VOICE_ENGINE_NOT_READY',
        engineId: this.id,
        details: status
      });
    }
    return status;
  }

  buildArguments(options = {}) {
    const text = normalizeText(options.text);
    if (!text) {
      throw new VoiceEngineError('Noi dung giong noi dang trong', {
        code: 'VOICE_ENGINE_INVALID_TEXT',
        engineId: this.id
      });
    }
    if (!options.outputPath) {
      throw new VoiceEngineError('Thieu duong dan am thanh dau ra', {
        code: 'VOICE_ENGINE_INVALID_OUTPUT',
        engineId: this.id
      });
    }

    const language = SUPPORTED_LANGUAGES.includes(options.language) ? options.language : 'vi';
    const device = SUPPORTED_DEVICES.includes(options.device) ? options.device : 'cpu';
    const args = [
      '--model', this.modelPath,
      '--text', text,
      '--output', options.outputPath,
      '--response-format', 'wav',
      '--language', language,
      '--device', device,
      '--num-step', String(options.steps || 16),
      '--seed', resolveOmnivoiceSeed(options.seed),
      '--position-temperature', String(options.positionTemperature || 1.5)
    ];

    const referenceAudioPath = options.referenceAudioPath;
    const referenceText = normalizeText(options.referenceText);
    if (referenceAudioPath && referenceText) {
      args.push('--ref-audio', referenceAudioPath, '--ref-text', referenceText);
    } else {
      args.push('--instruct', options.instruct || 'female');
      if (Number.isFinite(Number(options.duration)) && Number(options.duration) > 0) {
        args.push('--duration', String(options.duration));
      }
    }
    return { args, device, language, text };
  }

  async runStreaming(args, options = {}) {
    if (typeof this.spawnCli !== 'function') {
      throw new VoiceEngineError('Voice engine streaming runner is unavailable', {
        code: 'VOICE_ENGINE_RUNNER_UNAVAILABLE',
        engineId: this.id
      });
    }

    const runAttempt = (attemptArgs, usedDevice) => new Promise((resolve, reject) => {
      const child = this.spawnCli(this.cliPath, attemptArgs, {
        cwd: path.dirname(this.cliPath),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.activeProcesses.add(child);
      options.onProcess?.(child);
      let stderr = '';
      let settled = false;

      const inspectOutput = (value) => {
        const line = String(value || '');
        if (line.includes('model_load done')) {
          options.onProgress?.({ stage: 'model_loaded', percent: 30 });
        } else if (line.includes('reference_encode') || line.includes('reference_read')) {
          options.onProgress?.({ stage: 'reference_processing', percent: 50 });
        } else if (line.includes('generate')) {
          options.onProgress?.({ stage: 'synthesizing', percent: 70 });
        } else if (line.includes('model_load')) {
          options.onProgress?.({ stage: 'model_loading', percent: 10 });
        }
      };

      child.stdout?.on('data', inspectOutput);
      child.stderr?.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-8192);
        inspectOutput(data);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        this.activeProcesses.delete(child);
        reject(error);
      });
      child.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        this.activeProcesses.delete(child);
        if (code === 0) {
          resolve({ device: usedDevice, fallback: usedDevice !== options.requestedDevice });
        } else {
          const error = new Error(`OmniVoice CLI exited with code ${code}`);
          error.code = code;
          error.signal = signal;
          error.stderr = stderr;
          reject(error);
        }
      });
    });

    try {
      return await runAttempt(args, options.requestedDevice);
    } catch (error) {
      if (options.allowCpuFallback && options.requestedDevice !== 'cpu') {
        options.onFallback?.({
          engineId: this.id,
          from: options.requestedDevice,
          to: 'cpu',
          error: error.message
        });
        return runAttempt(replaceDevice(args, 'cpu'), 'cpu');
      }
      throw error;
    }
  }

  async synthesize(options = {}) {
    await this.loadModel();
    const built = this.buildArguments(options);
    try {
      let execution;
      if (this.serverManager?.isAvailable(built.device)) {
        options.onProgress?.({ stage: 'model_loading', percent: 10 });
        try {
          execution = await this.serverManager.synthesize({
            ...options,
            modelPath: this.modelPath,
            device: built.device,
            language: built.language
          });
        } catch (error) {
          if (
            options.allowCpuFallback
            && built.device !== 'cpu'
            && this.serverManager.isAvailable('cpu')
          ) {
            options.onFallback?.({
              engineId: this.id,
              from: built.device,
              to: 'cpu',
              error: error.message
            });
            execution = await this.serverManager.synthesize({
              ...options,
              modelPath: this.modelPath,
              device: 'cpu',
              language: built.language
            });
            execution.fallback = true;
          } else {
            throw error;
          }
        }
        options.onProgress?.({ stage: 'synthesizing', percent: 90 });
      } else if (options.streamProgress) {
        execution = await this.runStreaming(built.args, {
          requestedDevice: built.device,
          allowCpuFallback: options.allowCpuFallback === true,
          onFallback: options.onFallback,
          onProgress: options.onProgress,
          onProcess: options.onProcess
        });
      } else {
        if (typeof this.runCli !== 'function') {
          throw new Error('Voice engine runner is unavailable');
        }
        let fallbackInfo = null;
        execution = await this.runCli(
          built.args,
          { cwd: path.dirname(this.cliPath) },
          built.device,
          {
            skipRenderCheck: options.skipRenderCheck === true,
            allowCpuFallback: options.allowCpuFallback === true,
            onFallback: (detail) => {
              fallbackInfo = detail;
              options.onFallback?.(detail);
            }
          }
        );
        if (fallbackInfo && !execution?.device) {
          execution = { ...execution, device: 'cpu', fallback: true };
        }
      }
      if (!this.existsSync(options.outputPath)) {
        throw new VoiceEngineError('Voice engine did not create the requested output file', {
          code: 'VOICE_ENGINE_OUTPUT_MISSING',
          engineId: this.id,
          details: { outputPath: options.outputPath }
        });
      }
      return {
        engineId: this.id,
        outputPath: options.outputPath,
        requestedDevice: built.device,
        usedDevice: execution?.device || built.device,
        fallback: execution?.fallback === true,
        language: built.language,
        persistentRuntime: execution?.persistentRuntime === true,
        referencePromptCache: execution?.referencePromptCache === true
      };
    } catch (error) {
      if (error instanceof VoiceEngineError) throw error;
      throw new VoiceEngineError(
        `OmniVoice khong the tao giong bang ${built.device}: ${error.message}`,
        {
          code: 'VOICE_ENGINE_EXECUTION_FAILED',
          engineId: this.id,
          cause: error,
          details: {
            requestedDevice: built.device,
            cpuFallbackAllowed: options.allowCpuFallback === true,
            cpuFallbackAvailable: built.device !== 'cpu'
          }
        }
      );
    }
  }

  async cloneVoice(options = {}) {
    if (!options.referenceAudioPath || !normalizeText(options.referenceText)) {
      throw new VoiceEngineError('Clone voice requires reference audio and reference text', {
        code: 'VOICE_ENGINE_REFERENCE_REQUIRED',
        engineId: this.id
      });
    }
    return this.synthesize(options);
  }

  async cancel() {
    const stoppedServer = await this.serverManager?.stop?.();
    const processes = [...this.activeProcesses];
    for (const processHandle of processes) {
      try {
        this.killProcess(processHandle);
      } catch {}
    }
    this.activeProcesses.clear();
    return Boolean(stoppedServer || processes.length > 0);
  }
}

module.exports = {
  CurrentOmniVoiceEngine,
  SUPPORTED_LANGUAGES,
  SUPPORTED_DEVICES,
  normalizeText,
  replaceDevice
};
