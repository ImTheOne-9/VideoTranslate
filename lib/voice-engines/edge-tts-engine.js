'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shared = require('../shared-state');
const { VoiceEngine, VoiceEngineError } = require('./voice-engine');
const { EDGE_LANGUAGE_VOICES, EDGE_VOICE_LIST } = require('../voice-language-catalog');

const DEFAULT_VOICES = Object.freeze(Object.fromEntries(Object.entries(EDGE_LANGUAGE_VOICES).flatMap(
  ([lang, [female, male]]) => [[lang, lang === 'en' ? male : female], [`${lang}-female`, female], [`${lang}-male`, male]]
)));

const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(EDGE_LANGUAGE_VOICES));
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
  timeoutMs = 20000,
  returnMetadata = false
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
    const boundaries = [];
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
        if (textMsg.includes('Path:audio.metadata')) {
          const bodyIndex = textMsg.indexOf('\r\n\r\n');
          if (bodyIndex >= 0) {
            try {
              const payload = JSON.parse(textMsg.slice(bodyIndex + 4));
              for (const item of payload.Metadata || payload.metadata || []) {
                if (/Boundary$/i.test(String(item.Type || item.type || ''))) boundaries.push(item);
              }
            } catch (_) {}
          }
        }
        if (textMsg.includes('Path:turn.end')) {
          completed = true;
          clearTimeout(timeoutTimer);
          try { ws.close(); } catch {}
          const audioBuffer = Buffer.concat(audioBuffers);
          finish(() => resolve(returnMetadata ? { audioBuffer, boundaries } : audioBuffer));
        }
      }
    };

    on('open', () => {
      // 1. Send speech config
      const configBody = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: returnMetadata ? 'true' : 'false',
                wordBoundaryEnabled: returnMetadata ? 'true' : 'false'
              },
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
          const audioBuffer = Buffer.concat(audioBuffers);
          finish(() => resolve(returnMetadata ? { audioBuffer, boundaries } : audioBuffer));
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

function boundaryValue(item, key) {
  return item?.Data?.[key] ?? item?.data?.[key] ?? item?.[key] ?? item?.[key.toLowerCase()];
}

function mapEdgeBoundaryRanges(texts, boundaries) {
  const normalizedTexts = texts.map((text) => normalizeText(text));
  const joinedText = normalizedTexts.join(' ');
  const cueRanges = [];
  let cueCursor = 0;
  for (const text of normalizedTexts) {
    cueRanges.push({ start: cueCursor, end: cueCursor + text.length });
    cueCursor += text.length + 1;
  }
  let textCursor = 0;
  const words = [];
  const metadata = Array.isArray(boundaries) ? boundaries : [];
  const wordMetadata = metadata.filter((item) => /WordBoundary/i.test(String(item.Type || item.type || '')));
  for (const boundary of wordMetadata.length ? wordMetadata : metadata) {
    const dataText = boundaryValue(boundary, 'text');
    const word = normalizeText(
      typeof dataText === 'object' ? (dataText.Text || dataText.text) : dataText
    );
    const offset = Number(boundaryValue(boundary, 'Offset'));
    const duration = Number(boundaryValue(boundary, 'Duration'));
    if (!word || !Number.isFinite(offset) || offset < 0) continue;
    let charStart = joinedText.indexOf(word, textCursor);
    if (charStart < 0) charStart = textCursor;
    const charEnd = charStart + word.length;
    textCursor = Math.max(textCursor, charEnd);
    words.push({
      charStart,
      charEnd,
      startMs: Math.round(offset / 10000),
      endMs: Math.round((offset + Math.max(0, duration || 0)) / 10000)
    });
  }
  if (!words.length) return null;
  const ranges = cueRanges.map((cueRange, index) => {
    const cueWords = words.filter((word) => (
      word.charStart < cueRange.end && word.charEnd > cueRange.start
    ));
    if (!cueWords.length) return null;
    const nextWords = words.filter((word) => word.charStart >= (cueRanges[index + 1]?.start ?? Infinity));
    const startMs = cueWords[0].startMs;
    const boundaryEndMs = cueWords.reduce((max, word) => Math.max(max, word.endMs), startMs);
    const endMs = nextWords.length ? Math.max(boundaryEndMs, nextWords[0].startMs) : boundaryEndMs;
    return endMs > startMs + 40 ? { startMs, endMs } : null;
  });
  return ranges.every(Boolean) ? ranges : null;
}

const AVAILABLE_VOICES = EDGE_VOICE_LIST;

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
    this.retryBaseDelayMs = Math.max(0, Number(options.retryBaseDelayMs ?? 350));
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.timeoutMs = Number(options.timeoutMs) || 20000;
    this.activeControllers = new Set();
    this.activeSockets = new Set();
    this.activeProcesses = new Set();
    this.lastRemoteStatus = { state: 'unchecked', checkedAt: null, error: null };
    this.groupSize = Math.max(2, Number(options.groupSize) || 4);
    this.groupConcurrency = Math.max(1, Number(options.groupConcurrency) || 3);
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
      batchSynthesis: true,
      batchConcurrency: 4,
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
    const lang = (options.language || 'vi').toLowerCase().split(/[-_]/)[0];
    if (options.voice && typeof options.voice === 'string' && options.voice.includes('-')
      && options.voice.toLowerCase().split('-')[0] === lang) {
      return options.voice;
    }
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
            const streamResult = await this.synthesizeStream({
              text,
              voice,
              rate,
              pitch,
              signal: controller.signal,
              timeoutMs: this.timeoutMs,
              returnMetadata: options.returnMetadata === true,
              onSocket: (socket) => {
                this.activeSockets.add(socket);
                const remove = () => this.activeSockets.delete(socket);
                if (typeof socket.once === 'function') socket.once('close', remove);
                else socket.addEventListener?.('close', remove, { once: true });
              }
            });
            audioBuffer = Buffer.isBuffer(streamResult) ? streamResult : streamResult?.audioBuffer;
            options.__edgeBoundaries = Buffer.isBuffer(streamResult) ? [] : (streamResult?.boundaries || []);
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
            const retryDelayMs = this.retryBaseDelayMs * (2 ** attempt)
              + Math.floor(Math.random() * Math.max(1, this.retryBaseDelayMs));
            options.onProgress?.({
              stage: 'retrying',
              percent: 30,
              attempt: attempt + 2,
              maxAttempts: this.maxRetries + 1,
              retryDelayMs
            });
            if (retryDelayMs > 0) await this.sleep(retryDelayMs);
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
        pitch,
        boundaries: options.__edgeBoundaries || []
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

  async synthesizeBatch(options = {}) {
    const items = Array.isArray(options.items) ? options.items : [];
    const groups = [];
    for (let index = 0; index < items.length;) {
      const first = items[index];
      const group = [{ ...first, __index: index }];
      index += 1;
      while (index < items.length && group.length < this.groupSize) {
        const candidate = items[index];
        if ((candidate.voice || '') !== (first.voice || '')
          || (candidate.rate || '') !== (first.rate || '')
          || (candidate.pitch || '') !== (first.pitch || '')) break;
        group.push({ ...candidate, __index: index });
        index += 1;
      }
      groups.push(group);
    }
    const results = new Array(items.length);
    let groupCursor = 0;
    const worker = async () => {
      while (groupCursor < groups.length) {
        const group = groups[groupCursor++];
        if (group.length === 1) {
          const [result] = await super.synthesizeBatch({ items: group, concurrency: 1 });
          results[group[0].__index] = { ...result, index: group[0].__index };
          continue;
        }
        try {
          const grouped = await this.synthesizeGroupedItems(group);
          for (const item of grouped) results[item.index] = item;
        } catch (error) {
          const fallback = await super.synthesizeBatch({ items: group, concurrency: 1 });
          fallback.forEach((item, localIndex) => {
            const originalIndex = group[localIndex].__index;
            results[originalIndex] = { ...item, index: originalIndex, groupedFallback: true };
          });
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.groupConcurrency, Math.max(1, groups.length)) },
      () => worker()
    ));
    return results;
  }

  async synthesizeGroupedItems(group) {
    const first = group[0];
    const scratchPath = path.join(
      path.dirname(first.outputPath),
      `.edge-group-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`
    );
    try {
      const combined = await this.synthesize({
        ...first,
        text: group.map((item) => normalizeText(item.text)).join(' '),
        outputPath: scratchPath,
        returnMetadata: true
      });
      const ranges = mapEdgeBoundaryRanges(group.map((item) => item.text), combined.boundaries);
      if (!ranges) throw createEdgeError('Metadata boundary không đủ để chia nhóm', 'EDGE_TTS_BOUNDARY_MISMATCH');
      const output = [];
      for (let localIndex = 0; localIndex < group.length; localIndex++) {
        const item = group[localIndex];
        const range = ranges[localIndex];
        fs.mkdirSync(path.dirname(item.outputPath), { recursive: true });
        await new Promise((resolve, reject) => {
          this.execFile(this.ffmpegPath, [
            '-ss', (range.startMs / 1000).toFixed(3),
            '-t', ((range.endMs - range.startMs) / 1000).toFixed(3),
            '-i', scratchPath,
            '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1',
            '-y', item.outputPath
          ], (error, stdout, stderr) => error
            ? reject(createEdgeError(stderr || error.message, 'EDGE_TTS_BOUNDARY_SPLIT_FAILED', error))
            : resolve());
        });
        if (!this.existsSync(item.outputPath) || fs.statSync(item.outputPath).size <= 44) {
          throw createEdgeError('Audio sau chia boundary không hợp lệ', 'EDGE_TTS_BOUNDARY_SPLIT_FAILED');
        }
        output.push({
          ok: true,
          index: item.__index,
          key: item.key ?? item.__index,
          result: { ...combined, outputPath: item.outputPath, grouped: true, range }
        });
      }
      return output;
    } finally {
      try { fs.rmSync(scratchPath, { force: true }); } catch (_) {}
    }
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
  mapEdgeBoundaryRanges,
  SUPPORTED_LANGUAGES
};
