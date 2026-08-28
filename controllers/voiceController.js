const fs = require('fs');
const path = require('path');
const { resolveOmnivoiceSeed } = require('../lib/voice-defaults');
const shared = require('../lib/shared-state');
const {
  DEFAULT_VOICE_ENGINE_ID,
  voiceEngineRegistry
} = require('../lib/voice-engines/index');

// Trạng thái tiến trình cloner voice
const clonerState = {
  active: false,
  process: null,
  stage: '',
  percent: 0,
  error: null,
  tempFiles: [],
  voiceFilename: null,
  engineId: DEFAULT_VOICE_ENGINE_ID
};

function isSupportedLogoFile(filePath) {
  try {
    const signature = fs.readFileSync(filePath).subarray(0, 12);
    const isPng = signature.length >= 8 && signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    const isWebp = signature.length >= 12 && signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP';
    return isPng || isJpeg || isWebp;
  } catch (_) {
    return false;
  }
}

function resetClonerState() {
  clonerState.active = false;
  clonerState.process = null;
  clonerState.stage = '';
  clonerState.percent = 0;
  clonerState.error = null;
  clonerState.tempFiles = [];
  clonerState.voiceFilename = null;
  clonerState.engineId = DEFAULT_VOICE_ENGINE_ID;
}

module.exports = {
  getVoiceEngines: async (req, res) => {
    try {
      res.json({
        defaultEngineId: DEFAULT_VOICE_ENGINE_ID,
        engines: await voiceEngineRegistry.describeAll()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  previewEngineVoice: async (req, res) => {
    try {
      const { engine: engineId = 'piper', voice = '', text = '' } = req.body || {};
      const engine = voiceEngineRegistry.resolve(engineId, 'piper');

      const safeVoice = shared.safeFileName(voice || 'default') || 'default';
      const ext = engine.id === 'edge-tts' ? 'mp3' : 'wav';
      const previewFileName = `${engine.id}_${safeVoice}.${ext}`;

      const previewDir = shared.VOICE_PREVIEWS_DIR;
      fs.mkdirSync(previewDir, { recursive: true });
      const previewPath = path.join(previewDir, previewFileName);

      if (fs.existsSync(previewPath)) {
        try {
          const stats = fs.statSync(previewPath);
          if (stats.size > 1024) {
            return res.json({
              success: true,
              audioUrl: `/voice-previews/${encodeURIComponent(previewFileName)}`,
              cached: true
            });
          }
        } catch (_) {}
      }

      let lang = 'vi';
      if (engine.id === 'edge-tts' && String(voice).includes('-')) {
        lang = String(voice).split('-')[0].toLowerCase();
      } else if (engine.id === 'piper') {
        const piperLangVoices = {
          en: 'en_US-ryan-high', de: 'de_DE-thorsten-high', es: 'es_AR-daniela-high',
          pl: 'pl_PL-bass-high', uk: 'uk_UA-tetiana-high', kk: 'kk_KZ-issai-high'
        };
        const matched = Object.entries(piperLangVoices).find(([l, v]) => v === voice);
        if (matched) lang = matched[0];
      }

      let sampleText = String(text || '').trim();
      if (!sampleText) {
        if (lang === 'vi') sampleText = 'Xin chào, đây là giọng đọc mẫu của tôi.';
        else if (lang === 'zh') sampleText = '你好，这是我的声音示例。';
        else if (lang === 'ja') sampleText = 'こんにちは、これは私の音声サンプルです。';
        else if (lang === 'ko') sampleText = '안녕하세요, 제 목소리 샘플입니다.';
        else if (lang === 'fr') sampleText = 'Bonjour, ceci est un exemple de ma voix.';
        else if (lang === 'de') sampleText = 'Hallo, das ist ein Beispiel für meine Stimme.';
        else if (lang === 'es') sampleText = 'Hola, esta es una muestra de mi voz.';
        else sampleText = 'Hello, this is a sample of my voice.';
      }

      await engine.loadModel();
      await engine.synthesize({
        text: sampleText,
        voice,
        language: lang,
        outputPath: previewPath
      });

      return res.json({
        success: true,
        audioUrl: `/voice-previews/${encodeURIComponent(previewFileName)}`,
        cached: false
      });
    } catch (error) {
      console.error('[previewEngineVoice] Lỗi:', error);
      res.status(500).json({ error: error.message || 'Không thể tạo giọng mẫu nghe thử.' });
    }
  },

  generateClonerVoice: async (req, res) => {
    const { voiceName, refText, script, device } = req.body;
    const refAudio = req.file;
    const engineId = req.body.voiceEngine || DEFAULT_VOICE_ENGINE_ID;
    let engine;
    try {
      engine = voiceEngineRegistry.resolve(engineId, DEFAULT_VOICE_ENGINE_ID);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const supportsVoiceCloning = engine.getCapabilities().cloneVoice === true;

    if (!voiceName || !script || (supportsVoiceCloning && (!refAudio || !refText))) {
      return res.status(400).json({
        error: supportsVoiceCloning
          ? 'Thiếu thông tin: voiceName, refAudio, refText hoặc script'
          : 'Thiếu thông tin: voiceName hoặc script'
      });
    }

    if (clonerState.active) {
      return res.status(400).json({ error: 'Đang có tiến trình tạo giọng khác, vui lòng đợi hoặc hủy trước.' });
    }

    const baseName = shared.safeFileName(voiceName);
    if (!baseName) {
      return res.status(400).json({ error: 'Tên giọng mẫu không hợp lệ' });
    }

    const targetVoicePath = path.join(shared.VOICES_DIR, `${baseName}.wav`);
    const targetTxtPath = path.join(shared.VOICES_DIR, `${baseName}.txt`);

    if (fs.existsSync(targetVoicePath) || fs.existsSync(targetTxtPath)) {
      return res.status(400).json({ error: 'Giọng mẫu với tên này đã tồn tại, vui lòng chọn tên khác.' });
    }

    const voicePath = path.join(shared.VOICES_DIR, '_temp_cloner_voice.wav');
    const txtPath = path.join(shared.VOICES_DIR, '_temp_cloner_voice.txt');

    const tempFiles = [];
    resetClonerState();
    clonerState.active = true;
    clonerState.stage = 'Đang chuẩn bị...';
    clonerState.percent = 0;

    try {
      let refWavPath = null;
      if (supportsVoiceCloning) {
        const refOrigPath = refAudio.path;
        tempFiles.push(refOrigPath);
        refWavPath = refOrigPath + '_converted.wav';
        tempFiles.push(refWavPath);

        clonerState.stage = 'Đang chuyển đổi file âm thanh (FFmpeg)...';
        await new Promise((resolve, reject) => {
          shared.execFile(shared.FFMPEG_PATH, [
            '-i', refOrigPath,
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            '-y', refWavPath
          ], (err, stdout, stderr) => {
            if (err) reject(new Error('Lỗi FFmpeg: ' + stderr));
            else resolve();
          });
        });
      }

      clonerState.stage = supportsVoiceCloning ? 'Đang tải model AI...' : 'Đang kết nối Edge TTS...';
      clonerState.percent = 10;

      console.log(`[VoiceEngine:${engine.id}] Đang tạo giọng "${baseName}"...`);
      let selectedDevice = engine.id === 'edge-tts'
        ? 'cpu'
        : (device || process.env.OMNIVOICE_DEVICE || 'cpu');
      clonerState.engineId = engine.id;
      await engine.loadModel();
      const runSelectedVoiceEngine = async () => {
        const method = supportsVoiceCloning ? 'cloneVoice' : 'synthesize';
        return engine[method]({
          text: script,
          outputPath: voicePath,
          voice: req.body.edgeVoice,
          rate: req.body.edgeRate,
          pitch: req.body.edgePitch,
          language: req.body.edgeVoice
            ? String(req.body.edgeVoice).split('-').slice(0, 2).join('-').toLowerCase()
            : 'vi',
          device: selectedDevice,
          steps: process.env.OMNIVOICE_STEPS || '8',
          seed: resolveOmnivoiceSeed(req.body.omiSeed),
          referenceAudioPath: refWavPath,
          referenceText: refText,
          positionTemperature: 1.5,
          skipRenderCheck: true,
          streamProgress: true,
          allowCpuFallback: false,
          onProcess: (child) => {
            clonerState.process = child;
          },
          onProgress: (progress) => {
            clonerState.percent = progress.percent;
            const stageLabels = {
              model_loading: 'Đang tải model AI...',
              model_loaded: 'Đã tải model, đang xử lý giọng mẫu...',
              reference_processing: 'Đang phân tích giọng mẫu...',
              synthesizing: 'Đang tạo giọng nói AI...'
            };
            clonerState.stage = stageLabels[progress.stage] || clonerState.stage;
          }
        });
      };

      const voiceLockOwner = `voice-cloner:${Date.now()}`;
      shared.acquireVoiceEngine(voiceLockOwner);
      try {
        try {
          await runSelectedVoiceEngine();
        } catch (err) {
          const allowCpuFallback = req.body.allowCpuFallback === true
            || req.body.allowCpuFallback === 'true'
            || req.body.allowCpuFallback === 'on';
          if (allowCpuFallback && device && device !== 'cpu') {
            console.warn(`[OmniCloner] Chạy bằng ${device} thất bại (${err.message}), thử lại với CPU...`);
            clonerState.stage = 'Đang thử lại với CPU...';
            clonerState.percent = 5;
            selectedDevice = 'cpu';
            await runSelectedVoiceEngine();
          } else {
            throw err;
          }
        }
      } finally {
        shared.releaseVoiceEngine(voiceLockOwner);
      }

      if (!clonerState.active) {
        throw new Error('Đã hủy');
      }

      clonerState.stage = 'Đang lưu kết quả...';
      clonerState.percent = 90;

      fs.writeFileSync(txtPath, script, 'utf8');
      clonerState.voiceFilename = '_temp_cloner_voice.wav';
      console.log(`[VoiceEngine:${engine.id}] Đã lưu giọng tạm thời tại ${voicePath}`);

      clonerState.stage = 'Hoàn tất!';
      clonerState.percent = 100;
      clonerState.active = false;

      res.json({
        success: true,
        message: `Tạo giọng bằng ${engine.name} thành công!`,
        filename: '_temp_cloner_voice.wav'
      });

    } catch (err) {
      if (!clonerState.active) {
        try { if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath); } catch (e) {}
        try { if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); } catch (e) {}
        return res.json({ success: false, cancelled: true, message: 'Da huy tao giong' });
      }
      console.error(`Error generating voice with ${engine.id}:`, err.message);
      if (err.message !== 'Đã hủy') {
        try { if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath); } catch (e) {}
        try { if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); } catch (e) {}
        clonerState.error = err.message;
        res.status(500).json({ error: `Lỗi ${engine.name}: ${err.message}` });
      } else {
        try { if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath); } catch (e) {}
        try { if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); } catch (e) {}
        res.json({ success: false, cancelled: true, message: 'Đã hủy tạo giọng' });
      }
    } finally {
      for (const f of tempFiles) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
      }
      setTimeout(() => {
        if (!clonerState.active) resetClonerState();
      }, 3000);
    }
  },

  getClonerProgress: async (req, res) => {
    res.json({
      active: clonerState.active,
      stage: clonerState.stage,
      percent: clonerState.percent,
      error: clonerState.error,
      voiceFilename: clonerState.voiceFilename,
      engineId: clonerState.engineId
    });
  },

  cancelClonerVoice: async (req, res) => {
    try {
      await voiceEngineRegistry.cancel(clonerState.engineId || DEFAULT_VOICE_ENGINE_ID);
    } catch (error) {
      console.warn('[VoiceEngine] Cannot cancel selected engine:', error.message);
    }
    if (clonerState.process) {
      try {
        clonerState.process.kill('SIGTERM');
        setTimeout(() => {
          try { if (clonerState.process) clonerState.process.kill('SIGKILL'); } catch (e) {}
        }, 2000);
      } catch (e) {}
    }
    clonerState.active = false;
    clonerState.stage = 'Đã hủy';
    res.json({ success: true, message: 'Đã hủy tạo giọng' });
  },

  saveClonerVoice: async (req, res) => {
    const { voiceName } = req.body;
    if (!voiceName) {
      return res.status(400).json({ error: 'Thiếu thông tin: voiceName' });
    }

    const baseName = shared.safeFileName(voiceName);
    if (!baseName) {
      return res.status(400).json({ error: 'Tên giọng mẫu không hợp lệ' });
    }

    const tempVoicePath = path.join(shared.VOICES_DIR, '_temp_cloner_voice.wav');
    const tempTxtPath = path.join(shared.VOICES_DIR, '_temp_cloner_voice.txt');
    const targetVoicePath = path.join(shared.VOICES_DIR, `${baseName}.wav`);
    const targetTxtPath = path.join(shared.VOICES_DIR, `${baseName}.txt`);

    if (!fs.existsSync(tempVoicePath)) {
      return res.status(400).json({ error: 'Không tìm thấy file giọng mẫu tạm thời. Vui lòng tạo lại giọng.' });
    }

    if (fs.existsSync(targetVoicePath) || fs.existsSync(targetTxtPath)) {
      return res.status(400).json({ error: 'Giọng mẫu với tên này đã tồn tại, vui lòng chọn tên khác.' });
    }

    try {
      fs.renameSync(tempVoicePath, targetVoicePath);
      if (fs.existsSync(tempTxtPath)) {
        fs.renameSync(tempTxtPath, targetTxtPath);
      }
      res.json({ success: true, message: 'Đã lưu giọng mẫu thành công!' });
    } catch (err) {
      console.error('Error saving voice:', err);
      res.status(500).json({ error: `Lỗi khi lưu giọng: ${err.message}` });
    }
  },

  clearTempClonerVoice: async (req, res) => {
    try {
      const voicePath = path.join(shared.VOICES_DIR, '_temp_cloner_voice.wav');
      const txtPath = path.join(shared.VOICES_DIR, '_temp_cloner_voice.txt');
      if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath);
      if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
      res.json({ success: true });
    } catch (err) {
      console.error('Error clearing temp voice:', err);
      res.status(500).json({ error: err.message });
    }
  },

  saveVoice: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Thiếu file giọng mẫu' });
      const savedPath = shared.moveUploadedFile(req.file, shared.VOICES_DIR, req.body.voiceName || req.file.originalname);
      
      if (req.body.voiceText && req.body.voiceText.trim()) {
        const txtPath = savedPath.replace(path.extname(savedPath), '.txt');
        fs.writeFileSync(txtPath, req.body.voiceText.trim(), 'utf8');
      }

      res.json({
        success: true,
        message: 'Đã lưu giọng mẫu',
        voice: path.basename(savedPath)
      });
    } catch (error) {
      console.error('Save voice error:', error.message);
      res.status(500).json({ error: 'Không thể lưu giọng mẫu' });
    }
  },

  saveMusic: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Thiếu file nhạc nền' });
      const savedPath = shared.moveUploadedFile(req.file, shared.MUSIC_DIR, req.body.musicName || req.file.originalname);
      res.json({
        success: true,
        message: 'Đã lưu nhạc nền',
        music: path.basename(savedPath)
      });
    } catch (error) {
      console.error('Save music error:', error.message);
      res.status(500).json({ error: 'Không thể lưu nhạc nền' });
    }
  },

  saveLogo: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Thiếu file logo' });
      const originalName = req.body.logoName || req.file.originalname || '';
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(originalName).toLowerCase())) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ error: 'Logo chỉ hỗ trợ PNG, JPG, JPEG hoặc WebP' });
      }
      if (!isSupportedLogoFile(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ error: 'Nội dung file logo không hợp lệ' });
      }
      const savedPath = shared.moveUploadedFile(req.file, shared.LOGOS_DIR, originalName);
      return res.json({ success: true, message: 'Đã lưu logo', logo: path.basename(savedPath) });
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      console.error('Save logo error:', error.message);
      return res.status(500).json({ error: 'Không thể lưu logo' });
    }
  },

  deleteLogo: async (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join(shared.LOGOS_DIR, filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Không tìm thấy logo' });
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: 'Đã xóa logo' });
    } catch (error) {
      console.error('Delete logo error:', error.message);
      return res.status(500).json({ error: 'Không thể xóa logo' });
    }
  },

  saveVideo: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Thiếu file video' });
      const savedPath = shared.moveUploadedFile(req.file, shared.DOWNLOADS_DIR, req.body.videoName || req.file.originalname);
      res.json({
        success: true,
        message: 'Đã lưu video thành công',
        video: path.basename(savedPath)
      });
    } catch (error) {
      console.error('Save video error:', error.message);
      res.status(500).json({ error: 'Không thể lưu video' });
    }
  },

  deleteVideo: async (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join(shared.RENDERS_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return res.json({ success: true, message: 'Đã xóa video thành công!' });
      } else {
        return res.status(404).json({ error: 'Không tìm thấy file video' });
      }
    } catch (err) {
      console.error('Lỗi khi xóa video render:', err.message);
      res.status(500).json({ error: err.message });
    }
  },

  deleteVoice: async (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join(shared.VOICES_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        
        const txtPath = filePath.replace(path.extname(filePath), '.txt');
        if (fs.existsSync(txtPath)) {
          try {
            fs.unlinkSync(txtPath);
          } catch (e) {
            console.error('Lỗi khi xóa file kịch bản kèm theo:', e.message);
          }
        }
        return res.json({ success: true, message: 'Đã xóa giọng mẫu thành công!' });
      } else {
        return res.status(404).json({ error: 'Không tìm thấy file giọng mẫu' });
      }
    } catch (err) {
      console.error('Lỗi khi xóa giọng mẫu:', err.message);
      res.status(500).json({ error: err.message });
    }
  },

  deleteMusic: async (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join(shared.MUSIC_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return res.json({ success: true, message: 'Đã xóa nhạc nền thành công!' });
      } else {
        return res.status(404).json({ error: 'Không tìm thấy file nhạc nền' });
      }
    } catch (err) {
      console.error('Lỗi khi xóa nhạc nền:', err.message);
      res.status(500).json({ error: err.message });
    }
  },

  getLocalVideos: async (req, res) => {
    try {
      const files = fs.readdirSync(shared.DOWNLOADS_DIR)
        .filter(f => f.endsWith('.mp4'))
        .map(f => ({
          filename: f,
          path: path.join(shared.DOWNLOADS_DIR, f)
        }));
      res.json({ videos: files });
    } catch(e) {
      res.json({ videos: [] });
    }
  }
};

module.exports.isSupportedLogoFile = isSupportedLogoFile;
