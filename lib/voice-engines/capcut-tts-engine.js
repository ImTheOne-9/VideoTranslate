'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getCrawlerPaths, crawlerEnvironment } = require('../crawler-paths');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');

const FALLBACK_CAPCUT_VOICES = Object.freeze([
  { id: 'BV421_vivn_streaming', name: 'Nhỏ Ngọt Ngào', lang: 'vi', gender: 'female', resourceId: '7252594014782755330' },
  { id: 'multi_female_richgirl_uranus_bigtts', name: 'Review Phim new', lang: 'vi', gender: 'female', resourceId: '7637460351541447956' },
  { id: 'BV075_streaming', name: 'Thanh Niên Tự Tin', lang: 'vi', gender: 'male', resourceId: '7102355803792740865' },
  { id: 'vi_female_huong', name: 'Giọng Nữ Phổ Thông', lang: 'vi', gender: 'female', resourceId: '7264854897953083905' },
  { id: 'BV074_streaming_dsp', name: 'Giọng Bé', lang: 'vi', gender: 'female', resourceId: '7550087831092251920' },
  { id: 'BV074_streaming', name: 'Cô Gái Hoạt Ngôn', lang: 'vi', gender: 'female', resourceId: '7102355709945188865' },
  { id: 'BV075_streaming_vibrato_dsp', name: 'Việt Méo', lang: 'vi', gender: 'male', resourceId: '7569450639810465040' },
  { id: 'BV562_streaming', name: 'Mai', lang: 'vi', gender: 'female', resourceId: '7483736254694035984' },
  { id: 'multi_female_yangguangnv_uranus_bigtts', name: 'Ban Mai', lang: 'vi', gender: 'female', resourceId: '7637456432522218773' },
  { id: 'multi_female_quanweinv_uranus_bigtts', name: 'Bản Tin 1', lang: 'vi', gender: 'female', resourceId: '7637458743197732117' },
  { id: 'multi_female_stokie_uranus_bigtts', name: 'Review Phim 4', lang: 'vi', gender: 'female', resourceId: '7637456729696996628' },
  { id: 'multi_female_sisi_uranus_bigtts', name: 'Bản Tin nữ', lang: 'vi', gender: 'female', resourceId: '7637455857285860629' },
  { id: 'multi_female_daqi_uranus_bigtts', name: 'Review Phim 3', lang: 'vi', gender: 'female', resourceId: '7637451983389019409' },
  { id: 'multi_female_xyf04auto_uranus_bigtts', name: 'Review Phim 2', lang: 'vi', gender: 'female', resourceId: '7637458743197732117' },
  { id: 'multi_female_kiwi_uranus_bigtts', name: 'Sunny Idol', lang: 'vi', gender: 'female', resourceId: '7637457995882089749' },
  { id: 'BV075_streaming_demon_dsp', name: 'Kenny Đại Đế', lang: 'vi', gender: 'male', resourceId: '7569442422665661712' },
  { id: 'BV075_streaming_robot_dsp', name: 'Robot VN', lang: 'vi', gender: 'male', resourceId: '7538698409633516816' },
  { id: 'multi_male_felipe_uranus_bigtts', name: 'Felipe (nữ)', lang: 'vi', gender: 'female', resourceId: '7637456729696996628' },
  { id: 'multi_female_peiqi_uranus_bigtts', name: 'Giọng Gái Mới Lớn', lang: 'vi', gender: 'female', resourceId: '7637458789033151751' },
  { id: 'multi_female_xinwenjieshuo_uranus_bigtts', name: 'Bản Tin 2', lang: 'vi', gender: 'female', resourceId: '7637455039719640327' },
  { id: 'multi_female_tianmeijieshuo_uranus_bigtts', name: 'Thuyết Minh Ngọt', lang: 'vi', gender: 'female', resourceId: '7637460417295469832' },
  { id: 'BV560_streaming', name: 'Alex Đại Đế', lang: 'vi', gender: 'male', resourceId: '7483736167565758992' },
  { id: 'en_us_006', name: 'English US', lang: 'en', gender: 'female', resourceId: '7114563482518819329' },
  { id: 'ICL_ja_female_zhiyu', name: 'Lovely Idol', lang: 'ja', gender: 'female', resourceId: '7579078759446285584' },
  { id: 'BV452_streaming', name: 'Chinese Wuhan', lang: 'zh', gender: 'female', resourceId: '7543766515837848833' },
  { id: 'DiT_es_male_bilunan', name: 'Español entusiasta', lang: 'es', gender: 'male', resourceId: '7597943534309690641' },
  { id: 'id_female_icha_uranus_bigtts', name: 'Bahasa Icathian', lang: 'id', gender: 'female', resourceId: '7587328219989249296' },
  { id: 'BV568_streaming', name: 'ภาษาไทย', lang: 'th', gender: 'female', resourceId: '7483736089434264065' },
  { id: 'DiT_pt_male_wenrou', name: 'Português Wenrou', lang: 'pt', gender: 'male', resourceId: '7576131428711255297' },
  { id: 'DiT_fr_female_soothing', name: 'Français Douce', lang: 'fr', gender: 'female', resourceId: '7573961077009042689' },
  { id: 'DiT_de_female_qingsong', name: 'Deutsch Sanfte', lang: 'de', gender: 'female', resourceId: '7584344912292760848' }
]);

function loadCapCutVoiceCatalog(paths = getCrawlerPaths(), explicitPath = '') {
  const catalogPath = explicitPath || path.join(paths.appRoot, 'capcut_voice_catalog.json');
  try {
    const document = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const seen = new Set();
    const voices = (Array.isArray(document?.voices) ? document.voices : []).filter((voice) => {
      const id = String(voice?.id || '').trim();
      const resourceId = String(voice?.resourceId || '').trim();
      const language = String(voice?.lang || '').trim().toLowerCase();
      if (!id || !resourceId || !language || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map((voice) => ({
      id: String(voice.id),
      name: String(voice.name || voice.id),
      lang: String(voice.lang).toLowerCase(),
      gender: ['male', 'female'].includes(voice.gender) ? voice.gender : 'unknown',
      resourceId: String(voice.resourceId),
      provider: voice.provider === '11labs' ? '11labs' : 'sami'
    }));
    return voices.length ? voices : [...FALLBACK_CAPCUT_VOICES];
  } catch (_) {
    return [...FALLBACK_CAPCUT_VOICES];
  }
}

const CAPCUT_VOICES = Object.freeze(loadCapCutVoiceCatalog());

function parseLastJson(value) {
  const lines = String(value || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch (_) {}
  }
  return null;
}

class CapCutTTSEngine extends VoiceEngine {
  constructor(options = {}) {
    super({ id: 'capcut-tts', name: 'CapCut TTS (Online)', version: '1' });
    this.paths = options.paths || getCrawlerPaths();
    this.workerPath = options.workerPath || path.join(this.paths.appRoot, 'capcut_tts_worker.py');
    this.voices = Object.freeze(options.voices || loadCapCutVoiceCatalog(
      this.paths,
      options.catalogPath
    ));
    this.ffmpegPath = options.ffmpegPath || this.paths.ffmpegPath;
    this.spawn = options.spawn || spawn;
    this.spawnSync = options.spawnSync || spawnSync;
    this.activeProcesses = new Set();
  }

  getCapabilities() {
    return {
      cloneVoice: false,
      languages: [...new Set(this.voices.map((voice) => voice.lang))],
      devices: ['online'],
      modelSizeBytes: 0,
      sampleRate: 24000,
      emotion: false,
      speedControl: false,
      durationControl: false,
      persistentRuntime: false,
      batchSynthesis: true,
      batchConcurrency: 6,
      batchSize: 40,
      repairBatchSize: 10,
      sentenceCueMerge: true,
      voices: this.voices.map(({ resourceId, provider, ...voice }) => voice),
      requiresInternet: true
    };
  }

  async checkStatus() {
    let ready = process.env.CAPCUT_TAT !== '1'
      && fs.existsSync(this.paths.python)
      && fs.existsSync(this.workerPath);
    let diagnostic = '';
    if (ready) {
      const checked = this.spawnSync(this.paths.python, [this.workerPath, '--check'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        env: crawlerEnvironment(this.paths)
      });
      const payload = parseLastJson(checked.stdout);
      ready = checked.status === 0 && payload?.ok === true;
      diagnostic = payload?.error || String(checked.stderr || '').trim();
    }
    return {
      ready,
      state: ready ? 'ready' : 'missing_dependency',
      online: true,
      requiresInternet: true,
      error: ready ? null : (diagnostic || 'Thiếu Python runtime hoặc CapCut TTS worker')
    };
  }

  async loadModel() {
    const status = await this.checkStatus();
    if (!status.ready) {
      throw new VoiceEngineError(status.error, {
        code: 'CAPCUT_TTS_NOT_READY',
        engineId: this.id
      });
    }
    return status;
  }

  resolveVoice(requested, language = 'vi') {
    const lang = String(language || 'vi').toLowerCase().split(/[-_]/)[0];
    return this.voices.find((voice) => voice.id === requested)
      || this.voices.find((voice) => voice.lang === lang)
      || this.voices[0];
  }

  runWorker(items) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.paths.python, [this.workerPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: crawlerEnvironment(this.paths)
      });
      this.activeProcesses.add(child);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        this.activeProcesses.delete(child);
        const payload = parseLastJson(stdout);
        if (code !== 0 || !payload) {
          return reject(new VoiceEngineError(
            payload?.error || stderr.trim() || `CapCut TTS worker thoát mã ${code}`,
            { code: 'CAPCUT_TTS_WORKER_FAILED', engineId: this.id }
          ));
        }
        resolve(payload);
      });
      child.stdin.end(JSON.stringify({
        items,
        ffmpegPath: this.ffmpegPath,
        deviceFile: process.env.CAPCUT_DEVICE_FILE || ''
      }));
    });
  }

  async synthesizeBatch(options = {}) {
    await this.loadModel();
    const source = Array.isArray(options.items) ? options.items : [];
    if (!source.length) return [];
    const prepared = source.map((item, index) => {
      const voice = this.resolveVoice(item.voice, item.language || options.language);
      return {
        key: item.key ?? index,
        text: String(item.text || '').trim(),
        outputPath: item.outputPath,
        voiceType: voice.id,
        resourceId: voice.resourceId,
        provider: voice.provider || 'sami',
        startMs: Number(item.startMs),
        endMs: Number(item.endMs),
        sequenceIndex: Number(item.sequenceIndex)
      };
    });
    const payloadItems = [];
    for (let index = 0; index < prepared.length;) {
      const first = prepared[index];
      const group = [first];
      let characterCount = first.text.length;
      while (group.length < 4 && index + group.length < prepared.length) {
        const previous = group.at(-1);
        const next = prepared[index + group.length];
        const gapMs = next.startMs - previous.endMs;
        const isContinuation = !/[.!?…。！？]$/.test(previous.text.trim());
        if (
          !Number.isFinite(gapMs)
          || gapMs < 0
          || gapMs > 600
          || !isContinuation
          || (Number.isFinite(previous.sequenceIndex)
            && Number.isFinite(next.sequenceIndex)
            && next.sequenceIndex !== previous.sequenceIndex + 1)
          || next.voiceType !== first.voiceType
          || characterCount + next.text.length > 220
        ) break;
        group.push(next);
        characterCount += next.text.length;
      }
      if (group.length > 1) {
        payloadItems.push({
          key: `merged:${index}`,
          text: group.map((item) => item.text).join(' '),
          outputPath: `${group[0].outputPath}.merged.wav`,
          voiceType: first.voiceType,
          resourceId: first.resourceId,
          provider: first.provider,
          children: group.map(({ key, text, outputPath }) => ({ key, text, outputPath }))
        });
      } else {
        payloadItems.push(first);
      }
      index += group.length;
    }
    const payload = await this.runWorker(payloadItems);
    const byKey = new Map((payload.results || []).map((result) => [String(result?.key), result]));
    return source.map((item, index) => {
      const result = byKey.get(String(item.key ?? index));
      return result?.ok
        ? { ok: true, index, key: item.key ?? index, result }
        : {
            ok: false,
            index,
            key: item.key ?? index,
            error: new VoiceEngineError(result?.error || 'CapCut không tạo được audio', {
              code: 'CAPCUT_TTS_CUE_FAILED', engineId: this.id
            })
          };
    });
  }

  async synthesize(options = {}) {
    const result = await this.synthesizeBatch({ items: [{ ...options, key: 0 }] });
    if (!result[0]?.ok) throw result[0]?.error;
    return {
      outputPath: options.outputPath,
      voice: this.resolveVoice(options.voice, options.language).id,
      engineId: this.id,
      requestedDevice: 'online',
      usedDevice: 'online',
      fallback: false,
      language: String(options.language || 'vi').toLowerCase().split(/[-_]/)[0],
      persistentRuntime: false
    };
  }

  async cancel() {
    let cancelled = false;
    for (const child of this.activeProcesses) {
      cancelled = true;
      try { child.kill(); } catch (_) {}
    }
    this.activeProcesses.clear();
    return cancelled;
  }
}

module.exports = {
  CAPCUT_VOICES,
  CapCutTTSEngine,
  loadCapCutVoiceCatalog
};
