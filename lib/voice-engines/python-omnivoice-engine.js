'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');
const { getOmnivoiceRuntimePaths } = require('../omnivoice-runtime-manager');
const { crawlerEnvironment } = require('../crawler-paths');
const { resolveOmnivoiceSeed } = require('../voice-defaults');

const UNSUPPORTED_LANGUAGES = new Set(['ne', 'su', 'ar']);
const SUPPORTED_LANGUAGES = Object.freeze(
  require('../voice-language-catalog').OUTPUT_LANGUAGES
    .map((item) => item.code)
    .filter((code) => !UNSUPPORTED_LANGUAGES.has(code))
);
const START_TIMEOUT_MS = 4 * 60 * 1000;
const STALL_TIMEOUT_MS = Math.max(60_000, Number(process.env.OMNIVOICE_STALL_SECONDS || 1800) * 1000);
const ABSOLUTE_TIMEOUT_MS = Math.max(STALL_TIMEOUT_MS, Number(process.env.OMNIVOICE_ABSOLUTE_SECONDS || 14400) * 1000);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeRemove(filePath) {
  try { fs.rmSync(filePath, { force: true, recursive: true }); } catch (_) {}
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
  fs.renameSync(temp, filePath);
}

function sanitizeCudaPath(value) {
  return String(value || '')
    .split(path.delimiter)
    .filter((entry) => entry && !/NVIDIA GPU Computing Toolkit[\\/]CUDA|[\\/]cudnn[\\/].*[\\/]bin/i.test(entry))
    .join(path.delimiter);
}

function usableWav(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 64) return false;
    const header = Buffer.alloc(12);
    const handle = fs.openSync(filePath, 'r');
    try { fs.readSync(handle, header, 0, 12, 0); } finally { fs.closeSync(handle); }
    return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
  } catch (_) {
    return false;
  }
}

function parseNumber(value) {
  const parsed = Number(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function defaultVramInfo() {
  try {
    const output = execFileSync('nvidia-smi', [
      '--query-gpu=memory.total,memory.free,name', '--format=csv,noheader,nounits'
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const [total, free, ...name] = output.trim().split(/\s*,\s*/);
    return { totalGb: parseNumber(total) / 1024, freeGb: parseNumber(free) / 1024, name: name.join(', ') };
  } catch (_) {
    return { totalGb: 0, freeGb: 0, name: '' };
  }
}

function batchTier(vramGb) {
  if (vramGb >= 12) return 32;
  if (vramGb >= 8) return 24;
  if (vramGb >= 4.5) return 16;
  return 8;
}

function chooseBatch(vram) {
  const forced = Number(process.env.OMNIVOICE_BATCH);
  if (Number.isInteger(forced) && forced > 0) return forced;
  const totalTier = batchTier(vram.totalGb || 0);
  return Math.min(totalTier, batchTier(vram.freeGb || vram.totalGb || 0));
}

function groupBatchItems(items) {
  const groups = new Map();
  items.forEach((item, index) => {
    const language = String(item.language || 'vi').toLowerCase().split(/[-_]/)[0];
    const key = JSON.stringify({
      language,
      steps: Number(item.steps) || 8,
      referenceAudioPath: item.referenceAudioPath || '',
      referenceText: item.referenceText || '',
      instruct: item.instruct || '',
      seed: resolveOmnivoiceSeed(item.seed)
    });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...item, _sourceIndex: index, language });
  });
  return [...groups.values()];
}

class PythonOmniVoiceEngine extends VoiceEngine {
  constructor(options = {}) {
    super({ id: options.id || 'current-omnivoice', name: options.name || 'OmniVoice Clone', version: 'python-batch-1' });
    this.paths = options.paths || getOmnivoiceRuntimePaths(options.pathOptions || {});
    this.spawnImpl = options.spawnImpl || spawn;
    this.execFileSyncImpl = options.execFileSync || execFileSync;
    this.registerProcess = options.registerProcess || null;
    this.killProcess = options.killProcess || ((processHandle) => processHandle?.kill('SIGTERM'));
    this.vramInfo = options.vramInfo || defaultVramInfo;
    this.logger = options.logger || console;
    this.session = null;
    this.cancelled = false;
    this.activeProcess = null;
    this.jobCounter = 0;
  }

  getCapabilities() {
    const vram = this.vramInfo();
    return {
      cloneVoice: true,
      languages: [...SUPPORTED_LANGUAGES],
      devices: ['cuda:0'],
      sampleRate: 24000,
      emotion: false,
      speedControl: false,
      durationControl: false,
      persistentRuntime: true,
      referencePromptCache: true,
      batchSynthesis: true,
      nativeBatch: true,
      batchConcurrency: 1,
      dynamicBatchSize: chooseBatch(vram),
      requiresNvidia: true,
      dualVoice: true
    };
  }

  async checkStatus() {
    const pythonExists = fs.existsSync(this.paths.python);
    const workerExists = fs.existsSync(this.paths.worker);
    const marker = readJson(this.paths.marker);
    const packagesComplete = fs.existsSync(this.paths.torchPackage || path.join(this.paths.root, 'venv', 'Lib', 'site-packages', 'torch'))
      && fs.existsSync(this.paths.torchNnPackage || path.join(this.paths.root, 'venv', 'Lib', 'site-packages', 'torch', 'nn'))
      && fs.existsSync(this.paths.torchaudioPackage || path.join(this.paths.root, 'venv', 'Lib', 'site-packages', 'torchaudio'))
      && fs.existsSync(this.paths.omnivoicePackage || path.join(this.paths.root, 'venv', 'Lib', 'site-packages', 'omnivoice'));
    const ready = pythonExists && workerExists
      && packagesComplete
      && Number(marker?.version || 0) >= 2
      && marker?.cudaInferenceVerified === true
      && marker?.modelInferenceVerified === true
      && marker?.runtimeHealthVerified === true
      && marker?.dllPathSanitized === true;
    return {
      ready,
      state: ready ? 'ready' : 'not_installed',
      error: ready ? null : 'Chưa cài OmniVoice Python/CUDA',
      pythonExists,
      workerExists,
      packagesComplete,
      cudaInferenceVerified: marker?.cudaInferenceVerified === true,
      modelInferenceVerified: marker?.modelInferenceVerified === true,
      modelId: marker?.engine || 'k2-fsa/OmniVoice',
      runtimeRoot: this.paths.root,
      vram: this.vramInfo(),
      requiresNvidia: true
    };
  }

  async loadModel() {
    const status = await this.checkStatus();
    if (!status.ready) {
      throw new VoiceEngineError(status.error, {
        code: 'VOICE_ENGINE_NOT_READY', engineId: this.id, details: status
      });
    }
    return status;
  }

  environment() {
    const environment = crawlerEnvironment(this.paths, {
      HF_HOME: this.paths.hfHome,
      HUGGINGFACE_HUB_CACHE: path.join(this.paths.hfHome, 'hub'),
      OMNIVOICE_GPU_LOCK: path.join(this.paths.runtimeRoot, 'faster-whisper-gpu.lock'),
      OMNIVOICE_IDLE_SECONDS: process.env.OMNIVOICE_IDLE_SECONDS || '180'
    });
    // PyTorch wheel mang CUDA DLL riêng. Loại CUDA Toolkit/cuDNN hệ thống khỏi
    // PATH của tiến trình OmniVoice để tránh nạp nhầm DLL khác major version.
    environment.PATH = sanitizeCudaPath(environment.PATH);
    return environment;
  }

  materializeDefaultReference(gender = 'female') {
    if (!this.paths.bundledRoot || !this.paths.ffmpegPath || !fs.existsSync(this.paths.ffmpegPath)) return null;
    const male = gender === 'male';
    const fileName = male ? 'Giọng Nam miền Bắc.wav' : 'Giọng Nữ miền Bắc.wav';
    const textName = fileName.replace(/\.wav$/i, '.txt');
    const sourceRoots = [
      path.join(this.paths.bundledRoot, 'public', 'default_voices'),
      path.join(this.paths.bundledRoot, 'app.asar', 'public', 'default_voices')
    ];
    const sourceRoot = sourceRoots.find((candidate) => fs.existsSync(path.join(candidate, fileName)));
    if (!sourceRoot) return null;
    const targetRoot = path.join(this.paths.root, 'default-voices');
    const targetAudio = path.join(targetRoot, male ? 'nam.wav' : 'nu.wav');
    const targetText = path.join(targetRoot, male ? 'nam.txt' : 'nu.txt');
    const copiedSource = path.join(targetRoot, male ? 'nam-source.wav' : 'nu-source.wav');
    fs.mkdirSync(targetRoot, { recursive: true });
    if (!usableWav(targetAudio)) {
      // Node đọc được file bên trong app.asar nhưng FFmpeg thì không. Chép mẫu
      // ra runtime bền vững trước rồi mới chuẩn hóa.
      fs.copyFileSync(path.join(sourceRoot, fileName), copiedSource);
      try {
        this.execFileSyncImpl(this.paths.ffmpegPath, [
          '-y', '-i', copiedSource,
          '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', targetAudio
        ], { windowsHide: true, timeout: 120_000, stdio: 'ignore' });
      } finally {
        safeRemove(copiedSource);
      }
    }
    if (!fs.existsSync(targetText)) {
      const sourceText = path.join(sourceRoot, textName);
      const transcript = fs.existsSync(sourceText)
        ? fs.readFileSync(sourceText, 'utf8').trim()
        : 'Chào mừng bạn đến với công cụ Video Studio Tools. Đây là giọng đọc mẫu lồng tiếng chất lượng cao.';
      fs.writeFileSync(targetText, transcript, 'utf8');
    }
    return {
      audioPath: targetAudio,
      text: fs.readFileSync(targetText, 'utf8').trim(),
      gender: male ? 'male' : 'female'
    };
  }

  spawnPython(args, options = {}) {
    const child = this.spawnImpl(this.paths.python, [this.paths.worker, ...args], {
      cwd: path.dirname(this.paths.worker),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.environment(),
      ...options
    });
    this.registerProcess?.(child);
    this.activeProcess = child;
    return child;
  }

  async stopSession() {
    const session = this.session;
    this.session = null;
    if (session?.process) {
      try { this.killProcess(session.process); } catch (_) {}
    }
    if (this.activeProcess === session?.process) this.activeProcess = null;
  }

  async ensureDaemon(batch) {
    if (this.session && !this.session.exited && this.session.batch === batch) return this.session;
    await this.stopSession();
    const queueDir = path.join(this.paths.queueRoot, `app_${process.pid}`);
    fs.mkdirSync(queueDir, { recursive: true });
    safeRemove(path.join(queueDir, '_alive'));
    const child = this.spawnPython(['--serve', queueDir, '--batch', String(batch)]);
    const session = { process: child, queueDir, batch, exited: false, logs: '', startedAt: Date.now() };
    this.session = session;
    const collect = (chunk) => {
      const text = String(chunk || '');
      session.logs = (session.logs + text).slice(-16_384);
      for (const line of text.split(/\r?\n/).filter(Boolean)) this.logger.log(line);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once?.('error', (error) => { session.exited = true; session.logs += `\n${error.message}`; });
    child.once?.('exit', () => { session.exited = true; if (this.activeProcess === child) this.activeProcess = null; });
    const alive = path.join(queueDir, '_alive');
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.cancelled) throw new Error('Đã hủy OmniVoice');
      if (session.exited) throw new Error(`OmniVoice daemon dừng khi khởi động: ${session.logs.slice(-1000)}`);
      if (fs.existsSync(alive) && Date.now() - fs.statSync(alive).mtimeMs < 15_000) return session;
      await delay(250);
    }
    await this.stopSession();
    throw new Error('OmniVoice daemon khởi động quá thời gian cho phép');
  }

  createJob(group, batch) {
    const jobsRoot = path.join(this.paths.root, 'jobs');
    try {
      for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = path.join(jobsRoot, entry.name);
        if (Date.now() - fs.statSync(target).mtimeMs > 2 * 60 * 60 * 1000) safeRemove(target);
      }
    } catch (_) {}
    const jobId = `${process.pid}_${Date.now()}_${++this.jobCounter}`;
    const outputDir = path.join(jobsRoot, jobId);
    fs.mkdirSync(outputDir, { recursive: true });
    const first = group[0] || {};
    const gender = /(?:^|:)male$|\bmale\b|\bnam\b/i.test(`${first.voice || ''} ${first.instruct || ''}`)
      ? 'male'
      : 'female';
    let referenceAudioPath = first.referenceAudioPath || null;
    let referenceText = first.referenceText || '';
    let defaultReference = false;
    if (!referenceAudioPath) {
      try {
        const reference = this.materializeDefaultReference(gender);
        if (reference) {
          referenceAudioPath = reference.audioPath;
          referenceText = reference.text;
          defaultReference = true;
          this.logger.log(`[OmniVoice] Dùng giọng mẫu ${gender === 'male' ? 'nam' : 'nữ'} cố định để chống trôi giọng.`);
        }
      } catch (error) {
        this.logger.warn(`[OmniVoice] Không chuẩn bị được giọng mẫu mặc định: ${error.message}`);
      }
    }
    const job = {
      id: jobId,
      texts: group.map((item) => String(item.text || '').trim()),
      outputDir,
      language: first.language,
      steps: Number(first.steps) || 8,
      seed: resolveOmnivoiceSeed(first.seed),
      referenceAudioPath,
      referenceText,
      instruct: referenceAudioPath ? null : (first.instruct || `${gender}, young adult, moderate pitch`),
      defaultReference,
      batch
    };
    return { job, outputDir };
  }

  async waitForJob(childOrSession, outputDir, mode) {
    const donePath = path.join(outputDir, '_done.json');
    const errorPath = path.join(outputDir, '_error.txt');
    const progressPath = path.join(outputDir, '_progress.json');
    const started = Date.now();
    let lastProgressAt = Date.now();
    let lastProgressSignature = '';
    while (Date.now() - started < ABSOLUTE_TIMEOUT_MS) {
      if (this.cancelled) throw new Error('Đã hủy OmniVoice');
      const done = readJson(donePath);
      if (done) return done;
      if (fs.existsSync(errorPath)) throw new Error(fs.readFileSync(errorPath, 'utf8').slice(-2000));
      const progress = readJson(progressPath);
      const signature = progress ? `${progress.completed}/${progress.total}/${progress.at}` : '';
      if (signature && signature !== lastProgressSignature) {
        lastProgressSignature = signature;
        lastProgressAt = Date.now();
        this.logger.log(`[OmniVoice] diffusion batch ${progress.completed}/${progress.total}, có tiếng=${progress.audible}.`);
      }
      if (childOrSession.exited || childOrSession.process?.exitCode != null) {
        throw new Error(`OmniVoice ${mode} đã dừng trước khi hoàn tất: ${(childOrSession.logs || '').slice(-1200)}`);
      }
      if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
        throw new Error(`OmniVoice đứng yên quá ${Math.round(STALL_TIMEOUT_MS / 1000)} giây`);
      }
      await delay(500);
    }
    throw new Error('OmniVoice vượt trần an toàn tuyệt đối');
  }

  async runDaemon(job, batch) {
    const session = await this.ensureDaemon(batch);
    const requestPath = path.join(session.queueDir, `req_${job.id}.json`);
    writeJsonAtomic(requestPath, job);
    return this.waitForJob(session, job.outputDir, 'daemon');
  }

  async runOneShot(job, batch) {
    const jobPath = path.join(job.outputDir, 'job.json');
    try {
      for (const name of fs.readdirSync(job.outputDir)) {
        if (/^seg_\d+\.wav$/i.test(name) || /^_(?:progress|done|error)/i.test(name)) {
          safeRemove(path.join(job.outputDir, name));
        }
      }
    } catch (_) {}
    safeRemove(path.join(job.outputDir, '_error.txt'));
    safeRemove(path.join(job.outputDir, '_done.json'));
    writeJsonAtomic(jobPath, job);
    const child = this.spawnPython(['--job', jobPath, '--batch', String(batch)]);
    const state = { process: child, exited: false, logs: '' };
    const collect = (chunk) => {
      const text = String(chunk || '');
      state.logs = (state.logs + text).slice(-16_384);
      for (const line of text.split(/\r?\n/).filter(Boolean)) this.logger.log(line);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once?.('error', (error) => { state.exited = true; state.logs += `\n${error.message}`; });
    child.once?.('exit', () => { state.exited = true; if (this.activeProcess === child) this.activeProcess = null; });
    try {
      return await this.waitForJob(state, job.outputDir, 'one-shot');
    } finally {
      if (!state.exited) {
        try { this.killProcess(child); } catch (_) {}
      }
    }
  }

  async synthesizeGroup(group) {
    const vram = this.vramInfo();
    if (!vram.totalGb) throw new Error('Không phát hiện được GPU NVIDIA/VRAM cho OmniVoice');
    const batch = chooseBatch(vram);
    if (batch < batchTier(vram.totalGb)) {
      this.logger.log(`[OmniVoice] VRAM trống ${vram.freeGb.toFixed(1)}/${vram.totalGb.toFixed(1)} GB; hạ batch xuống ${batch}.`);
    }
    const { job, outputDir } = this.createJob(group, batch);
    let mode = 'one-shot';
    let summary;
    const minimumCoverage = Number(process.env.OMNIVOICE_MIN_COVERAGE || 0.9);
    const required = group.filter((item) => String(item.text || '').trim()).length;
    if (process.env.OMNIVOICE_DAEMON !== '0' && vram.totalGb >= 6) {
      try {
        mode = 'daemon';
        summary = await this.runDaemon(job, batch);
        const daemonOk = Number(summary?.ok) || 0;
        if (daemonOk === 0 && required > 0) {
          const error = new Error('OmniVoice daemon tạo 0 câu có tiếng; bỏ one-shot vì cùng trạng thái VRAM sẽ lỗi lại');
          error.code = 'OMNIVOICE_ZERO_AUDIO';
          throw error;
        }
        if (required > 0 && daemonOk / required < minimumCoverage) {
          this.logger.warn(
            `[OmniVoice] Daemon chỉ đạt ${daemonOk}/${required} cue; thử lại toàn bộ bằng one-shot sạch.`
          );
          summary = null;
          await this.stopSession();
        }
      } catch (error) {
        if (error.code === 'OMNIVOICE_ZERO_AUDIO') throw error;
        this.logger.warn(`[OmniVoice] Daemon lỗi: ${error.message}. Chuyển sang one-shot.`);
        await this.stopSession();
        summary = null;
      }
    }
    if (!summary) {
      mode = 'one-shot';
      try {
        summary = await this.runOneShot(job, batch);
      } catch (error) {
        const rescued = readJson(path.join(outputDir, '_progress.json'));
        if (!rescued?.audible || !Array.isArray(rescued.audibleIndices)) throw error;
        summary = { ok: rescued.audible, total: rescued.total, audibleIndices: rescued.audibleIndices };
        this.logger.warn(
          `[OmniVoice] One-shot bị dừng nhưng đã cứu ${rescued.audible}/${rescued.total} cue hoàn tất.`
        );
      }
    }

    const finalOk = Number(summary?.ok) || 0;
    if (required > 0 && finalOk / required < minimumCoverage) {
      const error = new Error(`OmniVoice one-shot chỉ tạo được ${finalOk}/${required} cue, không đạt độ phủ an toàn`);
      error.code = 'OMNIVOICE_COVERAGE_REJECTED';
      throw error;
    }

    const audibleIndices = new Set(Array.isArray(summary.audibleIndices)
      ? summary.audibleIndices.map(Number)
      : Array.from({ length: Number(summary.ok) || 0 }, (_, index) => index));
    const results = group.map((item, localIndex) => {
      const generatedPath = path.join(outputDir, `seg_${localIndex}.wav`);
      if (!audibleIndices.has(localIndex) || !usableWav(generatedPath)) {
        return { ok: false, item, error: new Error('OmniVoice không tạo được WAV hợp lệ cho cue') };
      }
      fs.mkdirSync(path.dirname(item.outputPath), { recursive: true });
      fs.copyFileSync(generatedPath, item.outputPath);
      return {
        ok: true,
        item,
        result: {
          engineId: this.id,
          outputPath: item.outputPath,
          requestedDevice: 'cuda:0',
          usedDevice: 'cuda:0',
          fallback: false,
          language: item.language,
          persistentRuntime: mode === 'daemon',
          referencePromptCache: mode === 'daemon',
          nativeBatch: true,
          batchSize: batch
        }
      };
    });
    const successful = results.filter((item) => item.ok).length;
    if (required > 0 && successful / required < minimumCoverage) {
      throw new Error(`OmniVoice chỉ tạo được ${successful}/${required} cue, không đạt độ phủ an toàn`);
    }
    safeRemove(outputDir);
    return results;
  }

  async synthesizeBatch(options = {}) {
    await this.loadModel();
    this.cancelled = false;
    const items = Array.isArray(options.items) ? options.items : [];
    const results = new Array(items.length);
    for (const group of groupBatchItems(items)) {
      try {
        const groupResults = await this.synthesizeGroup(group);
        groupResults.forEach((entry) => {
          const index = entry.item._sourceIndex;
          results[index] = entry.ok
            ? { ok: true, index, key: entry.item.key ?? index, result: entry.result }
            : { ok: false, index, key: entry.item.key ?? index, error: entry.error };
        });
      } catch (error) {
        group.forEach((item) => {
          results[item._sourceIndex] = {
            ok: false,
            index: item._sourceIndex,
            key: item.key ?? item._sourceIndex,
            error: new VoiceEngineError(`OmniVoice Python thất bại: ${error.message}`, {
              code: 'VOICE_ENGINE_EXECUTION_FAILED', engineId: this.id, cause: error
            })
          };
        });
      }
    }
    return results;
  }

  async synthesize(options = {}) {
    if (!options.outputPath) throw new VoiceEngineError('Thiếu file audio đầu ra', { engineId: this.id });
    const [entry] = await this.synthesizeBatch({ items: [{ ...options, key: 0 }] });
    if (!entry?.ok) throw entry?.error || new Error('OmniVoice không tạo được audio');
    return entry.result;
  }

  async cloneVoice(options = {}) {
    if (!options.referenceAudioPath || !String(options.referenceText || '').trim()) {
      throw new VoiceEngineError('Clone giọng cần cả audio mẫu và nội dung chính xác của mẫu', {
        code: 'VOICE_ENGINE_REFERENCE_REQUIRED', engineId: this.id
      });
    }
    return this.synthesize(options);
  }

  async cancel() {
    this.cancelled = true;
    if (this.activeProcess) {
      try { this.killProcess(this.activeProcess); } catch (_) {}
      this.activeProcess = null;
    }
    await this.stopSession();
    return true;
  }
}

module.exports = {
  PythonOmniVoiceEngine,
  SUPPORTED_LANGUAGES,
  batchTier,
  chooseBatch,
  groupBatchItems,
  usableWav
};
