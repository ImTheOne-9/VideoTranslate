'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shared = require('../shared-state');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');

const DEFAULT_VOICES = {
  vi: 'vi-VN-HoaiMyNeural',
  'vi-female': 'vi-VN-HoaiMyNeural',
  'vi-male': 'vi-VN-NamMinhNeural',
  en: 'en-US-AndrewNeural',
  'en-female': 'en-US-AvaNeural',
  'en-male': 'en-US-AndrewNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  'zh-female': 'zh-CN-XiaoxiaoNeural',
  'zh-male': 'zh-CN-YunjianNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  es: 'es-ES-ElviraNeural',
  ru: 'ru-RU-SvetlanaNeural'
};

const SUPPORTED_LANGUAGES = ['vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];
const TRANSIENT_ERROR_CODES = new Set([
  'EDGE_TTS_NETWORK_ERROR',
  'EDGE_TTS_TIMEOUT',
  'EDGE_TTS_CONNECTION_CLOSED',
  'EDGE_TTS_EMPTY_AUDIO'
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_TTS_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_TTS_SEC_VERSION = '1-143.0.3650.75';
const EDGE_TTS_ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_TTS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const WIN_EPOCH_SECONDS = 11644473600;

/**
 * Sec-MS-GEC DRM token (see https://github.com/rany2/edge-tts/issues/290)
 * Ticks = unix time + Windows epoch, rounded down to 5 minutes, in 100ns units,
 * then sha256(ticks + TrustedClientToken) as uppercase hex.
 */
function generateSecMsGec() {
  let ticks = Date.now() / 1000;
  ticks += WIN_EPOCH_SECONDS;
  ticks -= ticks % 300;
  ticks *= 10000000;
  const strToHash = `${Math.round(ticks)}${EDGE_TTS_TOKEN}`;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function edgeTTSTimestamp() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function connectId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : crypto.randomBytes(16).toString('hex');
}

/**
 * Direct Edge TTS Synthesizer using WebSocket protocol.
 */
function createEdgeError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizeRate(value) {
  const match = String(value || '+0%').trim().match(/^([+-]?)(\d{1,3})%$/);
  if (!match) return '+0%';
  const amount = Math.min(100, Number(match[2]));
  const sign = match[1] === '-' ? '-' : '+';
  return `${sign}${amount}%`;
}

function normalizePitch(value) {
  const match = String(value || '+0Hz').trim().match(/^([+-]?)(\d{1,3})Hz$/i);
  if (!match) return '+0Hz';
  const amount = Math.min(100, Number(match[2]));
  const sign = match[1] === '-' ? '-' : '+';
  return `${sign}${amount}Hz`;
}

function synthesizeEdgeTTSStream({
  text,
  voice,
  rate = '+0%',
  pitch = '+0Hz',
  signal,
  onSocket,
  timeoutMs = 20000
}) {
  return new Promise((resolve, reject) => {
    let WsImpl = null;
    try { WsImpl = require('ws'); } catch {}
    const useNative = !(WsImpl && typeof WsImpl === 'function') && typeof globalThis.WebSocket === 'function';
    if (!WsImpl && !useNative) {
      return reject(createEdgeError(
        'Thiếu WebSocket runtime để chạy Edge TTS',
        'EDGE_TTS_WEBSOCKET_UNAVAILABLE'
      ));
    }

    if (signal?.aborted) {
      return reject(createEdgeError('Đã hủy tạo giọng Edge TTS', 'EDGE_TTS_CANCELLED'));
    }

    const reqId = generateRequestId();
    const endpoint = `${EDGE_TTS_ENDPOINT}?TrustedClientToken=${EDGE_TTS_TOKEN}&ConnectionId=${connectId()}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${EDGE_TTS_SEC_VERSION}`;

    let ws;
    try {
      ws = useNative
        ? new globalThis.WebSocket(endpoint)
        : new WsImpl(endpoint, {
            headers: {
              'Pragma': 'no-cache',
              'Cache-Control': 'no-cache',
              'Origin': EDGE_TTS_ORIGIN,
              'User-Agent': EDGE_TTS_USER_AGENT,
              'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cookie': `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`
            },
            perMessageDeflate: false
          });
    } catch (error) {
      return reject(createEdgeError(
        `Không thể khởi tạo WebSocket Edge TTS: ${error.message}`,
        'EDGE_TTS_NETWORK_ERROR',
        error
      ));
    }
    onSocket?.(ws);

    const audioBuffers = [];
    let completed = false;

    const timeoutTimer = setTimeout(() => {
      if (!completed) {
        completed = true;
        try { ws.close(); } catch {}
        signal?.removeEventListener?.('abort', abortHandler);
        reject(createEdgeError(
          `Edge TTS không phản hồi sau ${Math.round(timeoutMs / 1000)} giây`,
          'EDGE_TTS_TIMEOUT'
        ));
      }
    }, timeoutMs);

    const abortHandler = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutTimer);
      try { ws.close(); } catch {}
      reject(createEdgeError('Đã hủy tạo giọng Edge TTS', 'EDGE_TTS_CANCELLED'));
    };
    signal?.addEventListener?.('abort', abortHandler, { once: true });

    const finish = (callback) => {
      signal?.removeEventListener?.('abort', abortHandler);
      callback();
    };

    const on = (event, handler) => {
      if (typeof ws.on === 'function') ws.on(event, handler);
      else ws.addEventListener(event, (payload) => {
        if (event === 'message') handler(payload.data);
        else handler(payload);
      });
    };

    const handleMessage = (data, isBinary) => {
      if (isBinary === true) {
        const buffer = Buffer.from(data);
        if (buffer.length >= 2) {
          const headerLen = buffer.readUInt16BE(0);
          if (buffer.length >= 2 + headerLen) {
            const headerStr = buffer.toString('utf8', 2, 2 + headerLen);
            if (headerStr.includes('Path:audio')) {
              const audioChunk = buffer.slice(2 + headerLen);
              if (audioChunk.length > 0) {
                audioBuffers.push(audioChunk);
              }
            }
          }
        }
      } else {
        const textMsg = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        if (textMsg.includes('Path:turn.end')) {
          completed = true;
          clearTimeout(timeoutTimer);
          try { ws.close(); } catch {}
          finish(() => resolve(Buffer.concat(audioBuffers)));
        }
      }
    };

    on('open', () => {
      // 1. Send speech config
      const configBody = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
            }
          }
        }
      });
      ws.send(`X-Timestamp:${edgeTTSTimestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${configBody}\r\n`);

      // 2. Send SSML request
      const lang = voice.split('-').slice(0, 2).join('-');
      const ssmlBody = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${edgeTTSTimestamp()}Z\r\nPath:ssml\r\n\r\n${ssmlBody}`);
    });

    on('message', (data, isBinary) => {
      if (completed) return;
      if (typeof isBinary === 'boolean') {
        return isBinary ? handleMessage(data, true) : handleMessage(data, false);
      }
      if (Buffer.isBuffer(data) || ArrayBuffer.isView(data)) return handleMessage(data, true);
      if (data instanceof ArrayBuffer) return handleMessage(Buffer.from(data), true);
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.arrayBuffer().then((ab) => handleMessage(Buffer.from(ab), true)).catch(() => {});
        return;
      }
      handleMessage(data, false);
    });

    on('error', (err) => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutTimer);
        finish(() => reject(createEdgeError(
          `Lỗi kết nối Edge TTS: ${err && err.message ? err.message : String(err)}`,
          'EDGE_TTS_NETWORK_ERROR',
          err
        )));
      }
    });

    on('close', () => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutTimer);
        if (audioBuffers.length > 0) {
          finish(() => resolve(Buffer.concat(audioBuffers)));
        } else {
          finish(() => reject(createEdgeError(
            'Kết nối Edge TTS đóng trước khi nhận được âm thanh',
            'EDGE_TTS_CONNECTION_CLOSED'
          )));
        }
      }
    });
  });
}

const AVAILABLE_VOICES = [
  { id: 'vi-VN-HoaiMyNeural', name: 'Hoài My (Nữ - Tiếng Việt)', lang: 'vi', gender: 'female' },
  { id: 'vi-VN-NamMinhNeural', name: 'Nam Minh (Nam - Tiếng Việt)', lang: 'vi', gender: 'male' },
  { id: 'en-US-AndrewNeural', name: 'Andrew (Nam - Tiếng Anh)', lang: 'en', gender: 'male' },
  { id: 'en-US-AvaNeural', name: 'Ava (Nữ - Tiếng Anh)', lang: 'en', gender: 'female' },
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao (Nữ - Tiếng Trung)', lang: 'zh', gender: 'female' },
  { id: 'zh-CN-YunjianNeural', name: 'Yunjian (Nam - Tiếng Trung)', lang: 'zh', gender: 'male' },
  { id: 'ja-JP-NanamiNeural', name: 'Nanami (Nữ - Tiếng Nhật)', lang: 'ja', gender: 'female' },
  { id: 'ko-KR-SunHiNeural', name: 'Sun-Hi (Nữ - Tiếng Hàn)', lang: 'ko', gender: 'female' },
  { id: 'fr-FR-DeniseNeural', name: 'Denise (Nữ - Tiếng Pháp)', lang: 'fr', gender: 'female' },
  { id: 'de-DE-KatjaNeural', name: 'Katja (Nữ - Tiếng Đức)', lang: 'de', gender: 'female' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira (Nữ - Tiếng Tây Ban Nha)', lang: 'es', gender: 'female' },
  { id: 'ru-RU-SvetlanaNeural', name: 'Svetlana (Nữ - Tiếng Nga)', lang: 'ru', gender: 'female' }
];

class EdgeTTSEngine extends VoiceEngine {
  constructor(options = {}) {
    super({
      id: options.id || 'edge-tts',
      name: options.name || 'Edge TTS (Microsoft Cloud - Siêu nhẹ)',
      version: options.version || '1'
    });
    this.existsSync = options.existsSync || fs.existsSync;
    this.execFile = options.execFile || shared.execFile;
    this.ffmpegPath = options.ffmpegPath || shared.FFMPEG_PATH;
    this.synthesizeStream = options.synthesizeStream || synthesizeEdgeTTSStream;
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 2;
    this.timeoutMs = Number(options.timeoutMs) || 20000;
    this.activeControllers = new Set();
    this.activeSockets = new Set();
    this.activeProcesses = new Set();
    this.lastRemoteStatus = { state: 'unchecked', checkedAt: null, error: null };
  }

  listVoices() {
    return AVAILABLE_VOICES;
  }

  getCapabilities() {
    return {
      cloneVoice: false,
      languages: [...SUPPORTED_LANGUAGES],
      devices: ['cpu'],
      modelSizeBytes: 0,
      sampleRate: 24000,
      emotion: false,
      speedControl: true,
      durationControl: false,
      persistentRuntime: false,
      referencePromptCache: false,
      persistentDevices: [],
      voices: AVAILABLE_VOICES
    };
  }

  async checkStatus() {
    let websocketAvailable = false;
    try {
      const WsImpl = require('ws');
      websocketAvailable = typeof WsImpl === 'function';
    } catch {
      websocketAvailable = typeof globalThis.WebSocket === 'function';
    }
    const ffmpegExists = Boolean(this.ffmpegPath && this.existsSync(this.ffmpegPath));
    const ready = websocketAvailable && ffmpegExists;
    return {
      ready,
      state: ready ? 'ready' : 'missing_dependency',
      websocketAvailable,
      ffmpegExists,
      requiresInternet: true,
      remote: { ...this.lastRemoteStatus },
      provider: 'Microsoft Edge Cloud TTS',
      error: ready
        ? null
        : !websocketAvailable
          ? 'Thiếu dependency WebSocket (ws)'
          : 'Không tìm thấy FFmpeg để xuất WAV'
    };
  }

  async loadModel() {
    const status = await this.checkStatus();
    if (!status.ready) {
      throw new VoiceEngineError(status.error || 'Edge TTS chưa sẵn sàng', {
        code: 'VOICE_ENGINE_MISSING_DEPENDENCY',
        engineId: this.id,
        details: status
      });
    }
    return status;
  }

  resolveVoice(options = {}) {
    if (options.voice && typeof options.voice === 'string' && options.voice.includes('-')) {
      return options.voice;
    }
    const lang = (options.language || 'vi').toLowerCase();
    const gender = options.gender ? `${lang}-${options.gender}` : lang;
    return DEFAULT_VOICES[gender] || DEFAULT_VOICES[lang] || DEFAULT_VOICES['vi'];
  }

  async synthesize(options = {}) {
    const text = normalizeText(options.text);
    if (!text) {
      throw new VoiceEngineError('Nội dung giọng nói đang trống', {
        code: 'VOICE_ENGINE_INVALID_TEXT',
        engineId: this.id
      });
    }

    if (!options.outputPath) {
      throw new VoiceEngineError('Thiếu đường dẫn file đầu ra', {
        code: 'VOICE_ENGINE_INVALID_OUTPUT',
        engineId: this.id
      });
    }

    const outputExtension = path.extname(options.outputPath).toLowerCase();
    if (!['.mp3', '.wav'].includes(outputExtension)) {
      throw new VoiceEngineError('Edge TTS chỉ hỗ trợ đầu ra MP3 hoặc WAV', {
        code: 'VOICE_ENGINE_INVALID_OUTPUT',
        engineId: this.id
      });
    }
    if (outputExtension === '.wav' && !this.existsSync(this.ffmpegPath)) {
      throw new VoiceEngineError('Không tìm thấy FFmpeg để xuất WAV từ Edge TTS', {
        code: 'VOICE_ENGINE_MISSING_DEPENDENCY',
        engineId: this.id
      });
    }

    const voice = this.resolveVoice(options);
    const rate = normalizeRate(options.rate);
    const pitch = normalizePitch(options.pitch);

    options.onProgress?.({ stage: 'synthesizing', percent: 30 });

    try {
      fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
      const controller = new AbortController();
      this.activeControllers.add(controller);
      let audioBuffer;
      let lastError;
      try {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
          try {
            audioBuffer = await this.synthesizeStream({
              text,
              voice,
              rate,
              pitch,
              signal: controller.signal,
              timeoutMs: this.timeoutMs,
              onSocket: (socket) => {
                this.activeSockets.add(socket);
                const remove = () => this.activeSockets.delete(socket);
                if (typeof socket.once === 'function') socket.once('close', remove);
                else socket.addEventListener?.('close', remove, { once: true });
              }
            });
            this.lastRemoteStatus = {
              state: 'reachable',
              checkedAt: new Date().toISOString(),
              error: null
            };
            break;
          } catch (error) {
            lastError = error;
            if (error.code === 'EDGE_TTS_CANCELLED') throw error;
            const canRetry = TRANSIENT_ERROR_CODES.has(error.code) && attempt < this.maxRetries;
            if (!canRetry) throw error;
            options.onProgress?.({
              stage: 'retrying',
              percent: 30,
              attempt: attempt + 2,
              maxAttempts: this.maxRetries + 1
            });
          }
        }
        if (!audioBuffer && lastError) throw lastError;
      } finally {
        this.activeControllers.delete(controller);
      }
      if (!audioBuffer || audioBuffer.length === 0) {
        throw createEdgeError('Dữ liệu âm thanh nhận từ Edge TTS bị rỗng', 'EDGE_TTS_EMPTY_AUDIO');
      }

      options.onProgress?.({ stage: 'saving', percent: 80 });

      const targetPath = path.resolve(options.outputPath);
      const isWav = targetPath.toLowerCase().endsWith('.wav');
      const tempId = `${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const tempMp3Path = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${tempId}.mp3`);
      const tempOutputPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${tempId}.tmp.wav`);

      if (isWav) {
        fs.writeFileSync(tempMp3Path, audioBuffer);

        try {
          await new Promise((resolve, reject) => {
            let child = null;
            let processCompleted = false;
            child = this.execFile(this.ffmpegPath, [
              '-i', tempMp3Path,
              '-acodec', 'pcm_s16le',
              '-ar', '24000',
              '-ac', '1',
              '-y', tempOutputPath
            ], (err, stdout, stderr) => {
              processCompleted = true;
              this.activeProcesses.delete(child);
              if (err) reject(createEdgeError(
                'Lỗi chuyển MP3 sang WAV bằng FFmpeg: ' + (stderr || err.message),
                err.killed ? 'EDGE_TTS_CANCELLED' : 'EDGE_TTS_FFMPEG_FAILED',
                err
              ));
              else resolve();
            });
            if (child && !processCompleted) this.activeProcesses.add(child);
          });
          const stat = fs.statSync(tempOutputPath);
          if (stat.size <= 44) {
            throw createEdgeError('File WAV Edge TTS không hợp lệ', 'EDGE_TTS_INVALID_AUDIO');
          }
          try { fs.unlinkSync(targetPath); } catch {}
          fs.renameSync(tempOutputPath, targetPath);
        } finally {
          try { fs.unlinkSync(tempMp3Path); } catch {}
          try { fs.unlinkSync(tempOutputPath); } catch {}
        }
      } else {
        fs.writeFileSync(tempMp3Path, audioBuffer);
        try {
          try { fs.unlinkSync(targetPath); } catch {}
          fs.renameSync(tempMp3Path, targetPath);
        } finally {
          try { fs.unlinkSync(tempMp3Path); } catch {}
        }
      }

      options.onProgress?.({ stage: 'completed', percent: 100 });

      return {
        engineId: this.id,
        outputPath: targetPath,
        requestedDevice: 'cpu',
        usedDevice: 'cpu',
        fallback: false,
        language: options.language || 'vi',
        voice,
        rate,
        pitch
      };
    } catch (error) {
      if (error instanceof VoiceEngineError) throw error;
      this.lastRemoteStatus = {
        state: error.code === 'EDGE_TTS_CANCELLED' ? 'cancelled' : 'unreachable',
        checkedAt: new Date().toISOString(),
        error: error.message
      };
      throw new VoiceEngineError(`Edge-TTS không thể tạo giọng: ${error.message}`, {
        code: error.code || 'VOICE_ENGINE_EXECUTION_FAILED',
        engineId: this.id,
        cause: error
      });
    }
  }

  async cloneVoice(options = {}) {
    // Edge-TTS does not support voice cloning, so gracefully synthesize using resolved voice
    options.onFallback?.({
      engineId: this.id,
      from: 'voice-cloning',
      to: 'edge-tts-standard',
      error: 'Edge-TTS không hỗ trợ clone giọng từ file mẫu. Đã chuyển sang giọng đọc tiêu chuẩn.'
    });

    const result = await this.synthesize(options);
    return {
      ...result,
      fallback: true
    };
  }

  async cancel() {
    const hadActiveWork = this.activeControllers.size > 0
      || this.activeSockets.size > 0
      || this.activeProcesses.size > 0;
    for (const controller of this.activeControllers) controller.abort();
    for (const socket of this.activeSockets) {
      try { socket.close(); } catch {}
    }
    for (const child of this.activeProcesses) {
      try { child.kill('SIGTERM'); } catch {}
    }
    return hadActiveWork;
  }
}

module.exports = {
  EdgeTTSEngine,
  DEFAULT_VOICES,
  SUPPORTED_LANGUAGES
};
