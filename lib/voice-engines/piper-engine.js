'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { getCrawlerPaths, crawlerEnvironment } = require('../crawler-paths');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');

const VIETNAMESE_PIPER_VOICES = Object.freeze([
  ['ngochuyen', 'Ngọc Huyền', 'female'], ['ngochuyennew', 'Ngọc Huyền (mới)', 'female'],
  ['ngocngan3701', 'Ngọc Ngạn', 'male'], ['maiphuong', 'Mai Phương', 'female'],
  ['phuongtrang', 'Phương Trang', 'female'], ['thanhphuong2', 'Thanh Phương', 'female'],
  ['calmwoman3688', 'Giọng nữ trầm', 'female'], ['yannew', 'Yan', 'female'],
  ['lacphi', 'Lạc Phi', 'male'], ['manhdung', 'Mạnh Dũng', 'male'],
  ['minhkhang', 'Minh Khang', 'male'], ['minhquang', 'Minh Quang', 'male'],
  ['duyoryx3175', 'Duy Oryx', 'male'], ['adam1', 'Adam', 'male'],
  ['chieuthanh', 'Chiều Thanh', 'male'], ['taian4', 'Tài An', 'male']
]);
const PIPER_LANGUAGE_VOICES = Object.freeze({
  en: 'en_US-ryan-high', de: 'de_DE-thorsten-high', es: 'es_AR-daniela-high',
  pl: 'pl_PL-bass-high', uk: 'uk_UA-tetiana-high', kk: 'kk_KZ-issai-high'
});

function languageRoot(value) {
  return String(value || 'vi').trim().toLowerCase().split(/[-_]/)[0] || 'vi';
}

function resolvePiperVoice(language, requestedVoice) {
  const lang = languageRoot(language);
  const requested = String(requestedVoice || '').trim();
  if (lang === 'vi') return requested || 'ngochuyen';
  if (requested && requested.includes('_')) return requested;
  return PIPER_LANGUAGE_VOICES[lang] || '';
}

class PiperEngine extends VoiceEngine {
  constructor(options = {}) {
    super({ id: options.id || 'piper', name: options.name || 'Piper (Offline)', version: '1' });
    this.paths = options.paths || getCrawlerPaths();
    this.bridgePath = options.bridgePath || path.join(this.paths.appRoot, 'piper_tts_bridge.py');
    this.spawn = options.spawn || spawn;
    this.spawnSync = options.spawnSync || spawnSync;
    this.session = null;
    this.pending = new Map();
    this.readyPromise = null;
    this.poolWorkers = [];
    this.poolThreshold = Math.max(1, Number(options.poolThreshold) || 24);
    this.cpuCount = options.cpuCount || (() => os.cpus()?.length || 2);
    this.environment = options.environment || process.env;
    this.workerFactory = options.workerFactory || (() => new PiperEngine({
      paths: this.paths,
      bridgePath: this.bridgePath,
      spawn: this.spawn,
      spawnSync: this.spawnSync,
      poolThreshold: Number.MAX_SAFE_INTEGER,
      cpuCount: this.cpuCount,
      environment: this.environment
    }));
    this.cudaAvailable = false;
    this.cudaEligible = false;
    this.gpuProfile = null;
  }

  getCapabilities() {
    return {
      cloneVoice: false,
      languages: ['vi', ...Object.keys(PIPER_LANGUAGE_VOICES)],
      devices: ['auto', 'cpu', 'cuda'],
      modelSizeBytes: 60000000,
      sampleRate: 22050,
      emotion: false,
      speedControl: true,
      durationControl: false,
      persistentRuntime: true,
      referencePromptCache: false,
      persistentDevices: ['cpu', 'cuda'],
      batchSynthesis: true,
      batchConcurrency: this.resolveWorkerCount(),
      voices: [
        ...VIETNAMESE_PIPER_VOICES.map(([id, name, gender]) => ({ id, name, lang: 'vi', gender })),
        ...Object.entries(PIPER_LANGUAGE_VOICES).map(([lang, id]) => ({
          id, name: `${id} (Offline)`, lang, gender: ['es', 'uk'].includes(lang) ? 'female' : 'male'
        }))
      ]
    };
  }

  async checkStatus() {
    if (!fs.existsSync(this.paths.python) || !fs.existsSync(this.bridgePath)) {
      return {
        ready: false,
        state: 'missing_dependency',
        requiresInternet: false,
        error: 'Chưa cài runtime Piper'
      };
    }
    const checked = this.spawnSync(this.paths.python, [this.bridgePath, '--check'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: crawlerEnvironment(this.paths)
    });
    const ready = checked.status === 0;
    let checkDetails = {};
    try { checkDetails = JSON.parse(String(checked.stdout || '').trim().split(/\r?\n/).pop()); } catch (_) {}
    const providers = Array.isArray(checkDetails.providers) ? checkDetails.providers : [];
    return {
      ready,
      state: ready ? 'ready' : 'missing_dependency',
      requiresInternet: true,
      provider: 'Piper ONNX',
      providers,
      cudaAvailable: providers.includes('CUDAExecutionProvider'),
      error: ready ? null : 'Runtime chưa đủ Piper/AudioStretchy; hãy cài hoặc cập nhật runtime crawler.'
    };
  }

  async loadModel() {
    const status = await this.checkStatus();
    if (!status.ready) {
      throw new VoiceEngineError(status.error, {
        code: 'VOICE_ENGINE_MISSING_DEPENDENCY',
        engineId: this.id,
        details: status
      });
    }
    const providers = Array.isArray(status.providers) ? status.providers : [];
    this.cudaAvailable = status.cudaAvailable === true;
    this.cudaEligible = this.cudaAvailable && this.isGpuEligible();
    const selected = this.cudaEligible ? 'CUDAExecutionProvider' : 'CPUExecutionProvider';
    console.log(`[Piper] providers=${providers.join(',') || 'unknown'} selected=${selected}`);
    await this.ensureSession();
    return status;
  }

  async ensureSession() {
    if (this.session && !this.session.killed) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      const child = this.spawn(this.paths.python, [this.bridgePath, '--server'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: crawlerEnvironment(this.paths)
      });
      this.session = child;
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(-4000); });
      const lines = readline.createInterface({ input: child.stdout });
      const startupTimer = setTimeout(() => reject(new Error('Piper runtime khởi động quá hạn')), 30000);
      lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch (_) { return; }
        if (message.event === 'ready') {
          clearTimeout(startupTimer);
          resolve();
          return;
        }
        if (message.event === 'fatal') {
          clearTimeout(startupTimer);
          reject(new Error(message.error || stderr || 'Piper runtime lỗi'));
          return;
        }
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || 'Piper synthesis failed'));
      });
      child.once('exit', (code) => {
        clearTimeout(startupTimer);
        this.session = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Piper runtime đã dừng (${code}): ${stderr}`));
        }
        this.pending.clear();
      });
      child.once('error', reject);
    });
    return this.readyPromise;
  }

  async synthesize(options = {}) {
    const text = String(options.text || '').trim();
    if (!text || !options.outputPath) {
      throw new VoiceEngineError('Thiếu nội dung hoặc đường dẫn đầu ra Piper', {
        code: 'VOICE_ENGINE_INVALID_TEXT', engineId: this.id
      });
    }
    const language = languageRoot(options.language);
    const resolvedVoice = resolvePiperVoice(language, options.voice);
    if (!resolvedVoice) {
      throw new VoiceEngineError(`Piper chưa có model cho ngôn ngữ '${language}'`, {
        code: 'VOICE_ENGINE_UNSUPPORTED_LANGUAGE',
        engineId: this.id,
        details: { language, supportedLanguages: this.getCapabilities().languages }
      });
    }
    await this.ensureSession();
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    const request = (device) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Piper không phản hồi sau 120 giây'));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.session.stdin.write(`${JSON.stringify({
        id,
        command: 'synthesize',
        text,
        outputPath: path.resolve(options.outputPath),
        voice: resolvedVoice,
        lengthScale: options.lengthScale || 0.8,
        device
      })}\n`);
    });
    const requestedDevice = ['auto', 'cpu', 'cuda'].includes(options.device) ? options.device : 'auto';
    const effectiveDevice = requestedDevice === 'cpu'
      ? 'cpu'
      : (this.cudaEligible ? 'cuda' : 'cpu');
    let result;
    let didFallback = false;
    try {
      result = await request(effectiveDevice);
    } catch (error) {
      const isGpuFailure = effectiveDevice !== 'cpu'
        && /cuda|cudnn|provider|gpu|memory|alloc|oom/i.test(String(error?.message || ''));
      if (!isGpuFailure) throw error;
      options.onFallback?.({ engineId: this.id, from: requestedDevice, to: 'cpu', error: error.message });
      didFallback = true;
      result = await request('cpu');
    }
    return {
      engineId: this.id,
      outputPath: result.outputPath,
      requestedDevice,
      usedDevice: result.usedDevice || 'cpu',
      fallback: didFallback,
      language: options.language || 'vi',
      voice: result.voice,
      providers: result.providers || [],
      persistentRuntime: true
    };
  }

  async cloneVoice(options = {}) {
    return this.synthesize(options);
  }

  async synthesizeBatch(options = {}) {
    const items = Array.isArray(options.items) ? options.items : [];
    if (items.length < this.poolThreshold) {
      return super.synthesizeBatch({ ...options, concurrency: 1 });
    }
    const workerCount = Math.min(items.length, this.resolveWorkerCount(items[0]?.device));
    if (workerCount <= 1) return super.synthesizeBatch({ ...options, concurrency: 1 });

    // Warm/download the requested model once before other processes load it,
    // avoiding multiple workers writing the same .part file simultaneously.
    const results = new Array(items.length);
    try {
      results[0] = { ok: true, index: 0, key: items[0].key ?? 0, result: await this.synthesize(items[0]) };
    } catch (error) {
      results[0] = { ok: false, index: 0, key: items[0].key ?? 0, error };
    }

    while (this.poolWorkers.length < workerCount - 1) {
      this.poolWorkers.push(this.workerFactory());
    }
    const workers = [this, ...this.poolWorkers.slice(0, workerCount - 1)];
    let cursor = 1;
    await Promise.all(workers.map(async (worker) => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        try {
          results[index] = {
            ok: true, index, key: item.key ?? index, result: await worker.synthesize(item)
          };
        } catch (error) {
          results[index] = { ok: false, index, key: item.key ?? index, error };
        }
      }
    }));
    return results;
  }

  resolveWorkerCount(requestedDevice = 'auto') {
    const forced = Math.floor(Number(this.environment.PIPER_WORKERS));
    if (forced > 0) return Math.max(1, Math.min(32, forced));
    const cores = Math.max(1, Number(this.cpuCount()) || 1);
    const cudaRequested = requestedDevice === 'cuda'
      || (requestedDevice === 'auto' && this.cudaEligible);
    if (!cudaRequested) return Math.max(1, Math.min(6, Math.floor(cores / 2) || 1));
    this.detectGpuProfile();
    const vramGb = this.gpuProfile.vramMb / 1024;
    const vramWorkers = vramGb > 0 ? Math.round(10 + (vramGb - 4) * 2.5) : 10;
    return Math.max(1, Math.min(32, vramWorkers, cores || 1));
  }

  detectGpuProfile() {
    if (!this.gpuProfile) {
      try {
        const detected = this.spawnSync('nvidia-smi', [
          '--query-gpu=name,memory.total', '--format=csv,noheader,nounits'
        ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const line = String(detected.stdout || '').trim().split(/\r?\n/)[0] || '';
        const parts = line.split(',');
        this.gpuProfile = { name: parts[0]?.trim() || '', vramMb: Number(parts[1]) || 0 };
      } catch (_) {
        this.gpuProfile = { name: '', vramMb: 0 };
      }
    }
    return this.gpuProfile;
  }

  isGpuEligible() {
    if (this.environment.PIPER_NO_CUDA === '1') return false;
    const profile = this.detectGpuProfile();
    const name = String(profile.name || '').toUpperCase();
    if (name.includes('RTX')) return true;
    const minimum = Math.max(0, Number(this.environment.PIPER_GPU_MIN) || 1050);
    const match = name.match(/GTX\s*(\d{3,4})/);
    return Boolean(match) && Number(match[1]) >= minimum;
  }

  async cancel() {
    const hadSession = Boolean(this.session || this.poolWorkers.length);
    if (this.session) {
      try { this.session.kill(); } catch (_) {}
    }
    this.session = null;
    const workers = this.poolWorkers.splice(0);
    await Promise.allSettled(workers.map((worker) => worker.cancel()));
    return hadSession;
  }
}

module.exports = {
  PIPER_LANGUAGE_VOICES,
  PiperEngine,
  VIETNAMESE_PIPER_VOICES,
  resolvePiperVoice
};
