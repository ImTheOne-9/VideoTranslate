'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const shared = require('./shared-state');
const { prepareOmnivoiceReference } = require('./omnivoice-reference-preprocessor');
const { applyVoiceSpeedToFile } = require('./voice-audio-fit');
const {
  engineUsesNativeVoiceSpeed,
  resolveVoiceSpeed,
  voiceSpeedToEdgeRate,
  voiceSpeedToPiperLengthScale
} = require('./voice-speed-policy');
const { voiceEngineRegistry } = require('./voice-engines');

const MAX_LINES = 500;
const MAX_CHARACTERS = 20_000;
const PAUSE_SECONDS = 0.35;
const state = { active: false, engineId: '', percent: 0, step: '', error: null, outputUrl: null };

function splitLines(text) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) throw new Error('Nội dung cần đọc đang trống.');
  if (normalized.length > MAX_CHARACTERS) throw new Error(`Nội dung vượt quá ${MAX_CHARACTERS.toLocaleString('vi-VN')} ký tự.`);
  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > MAX_LINES) throw new Error(`Chỉ hỗ trợ tối đa ${MAX_LINES} dòng mỗi lần.`);
  return lines;
}

function validOutput(filePath) {
  try { return fs.statSync(filePath).size > 512; } catch (_) { return false; }
}

function concatFileLine(filePath) {
  return `file '${path.resolve(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

async function normalizeChunk(inputPath, outputPath) {
  await shared.runExecFile(shared.FFMPEG_PATH, [
    '-y', '-i', inputPath,
    '-af', 'silenceremove=start_periods=1:start_duration=0.02:start_threshold=-50dB:stop_periods=1:stop_duration=0.08:stop_threshold=-50dB',
    '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath
  ], { timeout: 120_000, windowsHide: true });
  if (!validOutput(outputPath)) throw new Error('Một câu TTS không tạo được âm thanh hợp lệ.');
}

async function joinChunks(chunkPaths, workDir, outputPath) {
  const silencePath = path.join(workDir, 'pause.wav');
  await shared.runExecFile(shared.FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(PAUSE_SECONDS),
    '-c:a', 'pcm_s16le', silencePath
  ], { timeout: 60_000, windowsHide: true });
  const list = [];
  chunkPaths.forEach((chunkPath, index) => {
    list.push(concatFileLine(chunkPath));
    if (index < chunkPaths.length - 1) list.push(concatFileLine(silencePath));
  });
  const concatPath = path.join(workDir, 'concat.txt');
  fs.writeFileSync(concatPath, `${list.join('\n')}\n`, 'utf8');
  await shared.runExecFile(shared.FFMPEG_PATH, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath
  ], { timeout: 10 * 60_000, windowsHide: true });
  if (!validOutput(outputPath)) throw new Error('Không ghép được file Voice đầu ra.');
}

async function resolveReference(body, uploadedFile, workDir) {
  const selected = String(body.referenceVoice || '').trim();
  const sourcePath = uploadedFile?.path || (selected ? shared.resolveAssetPath('voice', selected) : null);
  if (!sourcePath) return null;
  const outputPath = path.join(workDir, 'reference.wav');
  await prepareOmnivoiceReference({
    inputPath: sourcePath,
    outputPath,
    ffmpegPath: shared.FFMPEG_PATH,
    ffprobePath: shared.FFPROBE_PATH,
    runExecFile: shared.runExecFile
  });
  return outputPath;
}

async function generate(body = {}, uploadedFile = null) {
  if (state.active) {
    if (uploadedFile?.path) {
      try { fs.rmSync(uploadedFile.path, { force: true }); } catch (_) {}
    }
    throw new Error('Đang có một tác vụ Tạo Voice khác chạy.');
  }
  const lines = splitLines(body.text);
  const engine = voiceEngineRegistry.resolve(String(body.engine || 'piper'), 'piper');
  const voiceSpeed = resolveVoiceSpeed(body.voiceSpeed, { maxSpeed: 2 });
  const language = String(body.language || 'vi').toLowerCase().split(/[-_]/)[0];
  const voice = String(body.voice || '').trim();
  const referenceText = String(body.referenceText || '').trim();
  const workDir = path.join(shared.TMP_UPLOADS_DIR, `standalone_tts_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(workDir, { recursive: true });
  const owner = `standalone-tts:${Date.now()}`;
  let locked = false;
  state.active = true;
  state.engineId = engine.id;
  state.percent = 1;
  state.step = 'Đang chuẩn bị nội dung...';
  state.error = null;
  state.outputUrl = null;
  try {
    shared.acquireVoiceEngine(owner);
    locked = true;
    const referenceAudioPath = engine.id === 'current-omnivoice'
      ? await resolveReference(body, uploadedFile, workDir)
      : null;
    if (engine.id === 'current-omnivoice' && referenceAudioPath && !referenceText) {
      throw new Error('Cần nhập chính xác nội dung đã đọc trong file giọng mẫu.');
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      engine: engine.id, voice, voiceSpeed, language, lines,
      reference: referenceAudioPath
        ? crypto.createHash('sha256').update(fs.readFileSync(referenceAudioPath)).digest('hex')
        : '',
      referenceText
    })).digest('hex').slice(0, 16);
    const outputName = `voice_${engine.id}_${fingerprint}.wav`;
    const outputPath = path.join(shared.TTS_OUTPUT_DIR, outputName);
    if (validOutput(outputPath)) {
      state.percent = 100;
      state.step = 'Đã dùng lại Voice đã tạo.';
      state.outputUrl = `/tts-output/${encodeURIComponent(outputName)}`;
      return { success: true, audioUrl: state.outputUrl, filename: outputName, cached: true, lineCount: lines.length };
    }
    const rawPaths = lines.map((_, index) => path.join(workDir, `raw_${String(index + 1).padStart(3, '0')}.wav`));
    const items = lines.map((text, index) => ({
      key: index,
      text,
      outputPath: rawPaths[index],
      voice,
      language,
      gender: body.gender,
      rate: voiceSpeedToEdgeRate(voiceSpeed),
      lengthScale: voiceSpeedToPiperLengthScale(voiceSpeed),
      speechRate: voiceSpeed,
      referenceAudioPath,
      referenceText,
      instruct: body.gender === 'male' ? 'male' : 'female',
      device: body.device || 'cuda:0',
      allowCpuFallback: true
    }));
    state.step = `Đang tạo ${lines.length} câu bằng ${engine.name}...`;
    state.percent = 8;
    const results = await engine.synthesizeBatch({
      items,
      concurrency: engine.id === 'edge-tts' ? 4 : 1,
      onProgress: (detail) => {
        const completed = Number(detail?.completed) || 0;
        state.percent = Math.max(state.percent, Math.min(72, 8 + Math.round((completed / lines.length) * 64)));
      }
    });
    const failed = results.find((entry) => !entry?.ok);
    if (failed) throw new Error(`Câu ${Number(failed.index) + 1} lỗi: ${failed.error?.message || 'không tạo được audio'}`);
    if (!engineUsesNativeVoiceSpeed(engine.id) && Math.abs(voiceSpeed - 1) > 0.001) {
      for (const rawPath of rawPaths) {
        await applyVoiceSpeedToFile({ inputPath: rawPath, speed: voiceSpeed, ffmpegPath: shared.FFMPEG_PATH, runExecFile: shared.runExecFile });
      }
    }
    state.step = 'Đang rút khoảng lặng và ghép các dòng...';
    const normalizedPaths = [];
    for (let index = 0; index < rawPaths.length; index++) {
      const normalizedPath = path.join(workDir, `line_${String(index + 1).padStart(3, '0')}.wav`);
      await normalizeChunk(rawPaths[index], normalizedPath);
      normalizedPaths.push(normalizedPath);
      state.percent = 72 + Math.round(((index + 1) / rawPaths.length) * 18);
    }
    await joinChunks(normalizedPaths, workDir, outputPath);
    state.percent = 100;
    state.step = `Hoàn tất ${lines.length} dòng.`;
    state.outputUrl = `/tts-output/${encodeURIComponent(outputName)}`;
    return { success: true, audioUrl: state.outputUrl, filename: outputName, cached: false, lineCount: lines.length };
  } catch (error) {
    state.error = error.message;
    state.step = 'Tạo Voice thất bại.';
    throw error;
  } finally {
    if (locked) shared.releaseVoiceEngine(owner);
    state.active = false;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    if (uploadedFile?.path) {
      try { fs.rmSync(uploadedFile.path, { force: true }); } catch (_) {}
    }
  }
}

async function cancel() {
  if (!state.active) return false;
  const engine = voiceEngineRegistry.get(state.engineId);
  await engine?.cancel?.();
  state.step = 'Đã yêu cầu dừng.';
  return true;
}

function getState() {
  return { ...state };
}

function listOutputs() {
  return shared.listFiles(shared.TTS_OUTPUT_DIR, ['.wav']).map((file) => ({
    ...file,
    audioUrl: `/tts-output/${encodeURIComponent(file.filename)}`
  }));
}

module.exports = { MAX_CHARACTERS, MAX_LINES, cancel, generate, getState, listOutputs, splitLines };
