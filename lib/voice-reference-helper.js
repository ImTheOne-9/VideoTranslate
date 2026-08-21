const fs = require('fs');
const path = require('path');

const shared = require('./shared-state');
const {
  createCheckpointSignature,
  getFileIdentity,
  isUsableFile,
  readJsonFile,
  writeJsonAtomic
} = require('./checkpoint-utils');

const VOICE_AUDIO_SIGNATURE_VERSION = 3;

function normalizeSignatureText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function createVoiceAudioSignature(options = {}) {
  return createCheckpointSignature({
    version: VOICE_AUDIO_SIGNATURE_VERSION,
    text: normalizeSignatureText(options.text),
    voiceFile: String(options.voiceFile || ''),
    referenceAudio: options.referenceIdentity
      || getFileIdentity(options.referenceSourcePath || options.referenceAudioPath),
    referenceText: normalizeSignatureText(options.referenceText),
    engineId: String(options.engineId || ''),
    voice: String(options.voice || ''),
    rate: String(options.rate || '+0%'),
    pitch: String(options.pitch || '+0Hz'),
    steps: String(options.steps || '16'),
    language: String(options.language || 'vi'),
    seed: String(options.seed || ''),
    positionTemperature: String(options.positionTemperature ?? '1.0'),
    textNormalization: String(options.textNormalization || '')
  });
}

function createLegacyVoiceAudioSignature(options = {}) {
  return createCheckpointSignature({
    text: options.text,
    voiceFile: String(options.voiceFile || ''),
    referenceAudio: getFileIdentity(options.referenceAudioPath),
    referenceText: options.referenceText,
    engineId: String(options.engineId || ''),
    steps: String(options.steps || '16'),
    language: String(options.language || 'vi')
  });
}

async function resolveVoiceReference(options) {
  const {
    voiceFile,
    defaultVoiceFile = '',
    providedText = '',
    workDir,
    whisperModel = 'small',
    whisperOnnxVariant = 'q8',
    language = ''
  } = options;
  if (!voiceFile) return { audioPath: null, text: '' };

  const sourcePath = shared.resolveAssetPath('voice', voiceFile);
  if (!sourcePath) {
    const error = new Error(`Không tìm thấy file giọng mẫu "${voiceFile}". Hãy chọn lại giọng cho câu này.`);
    error.code = 'VOICE_REFERENCE_NOT_FOUND';
    throw error;
  }
  const sourceIdentity = getFileIdentity(sourcePath);
  const cacheKey = createCheckpointSignature(getFileIdentity(sourcePath)).slice(0, 20);
  const cacheDir = path.join(workDir, 'segments', 'references');
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  const wavPath = path.join(cacheDir, `${cacheKey}.wav`);
  const cached = readJsonFile(cachePath);
  if (cached?.text && isUsableFile(wavPath, 44)) {
    return { audioPath: wavPath, text: cached.text, sourceIdentity };
  }
  fs.mkdirSync(cacheDir, { recursive: true });

  let referenceText = voiceFile === defaultVoiceFile ? String(providedText || '').trim() : '';
  const sidecarPath = sourcePath.replace(path.extname(sourcePath), '.txt');
  if (!referenceText && fs.existsSync(sidecarPath)) {
    referenceText = fs.readFileSync(sidecarPath, 'utf8').trim();
  }
  if (!referenceText) {
    const { transcribeVoice } = require('./whisper-helper');
    referenceText = await transcribeVoice(
      sourcePath,
      cacheDir,
      shared.FFMPEG_PATH,
      whisperModel,
      language,
      ['q8', 'fp32', 'medium-q8'].includes(whisperOnnxVariant)
        ? whisperOnnxVariant
        : 'q8'
    );
  }
  if (!referenceText) {
    const error = new Error('Không thể nhận dạng nội dung giọng mẫu');
    error.code = 'REFERENCE_TEXT_MISSING';
    throw error;
  }

  if (!isUsableFile(wavPath, 44)) {
    await shared.runExecFile(shared.FFMPEG_PATH, [
      '-i', sourcePath,
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y', wavPath
    ]);
  }
  writeJsonAtomic(cachePath, {
    source: getFileIdentity(sourcePath),
    text: referenceText,
    updatedAt: new Date().toISOString()
  });
  return { audioPath: wavPath, text: referenceText, sourceIdentity };
}

module.exports = {
  VOICE_AUDIO_SIGNATURE_VERSION,
  createLegacyVoiceAudioSignature,
  createVoiceAudioSignature,
  normalizeSignatureText,
  resolveVoiceReference
};
