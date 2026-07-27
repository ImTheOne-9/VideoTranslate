const fs = require('fs');
const path = require('path');
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

  generateClonerVoice: async (req, res) => {
    const { voiceName, refText, script, device } = req.body;
    const refAudio = req.file;

    if (!voiceName || !refAudio || !refText || !script) {
      return res.status(400).json({ error: 'Thiếu thông tin: voiceName, refAudio, refText hoặc script' });
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
      // Multer file gốc
      const refOrigPath = refAudio.path;
      tempFiles.push(refOrigPath);
      const refWavPath = refOrigPath + '_converted.wav';
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

      clonerState.stage = 'Đang tải model AI...';
      clonerState.percent = 10;

      console.log(`[OmniCloner] Đang tạo giọng "${baseName}"...`);
      let selectedDevice = device || process.env.OMNIVOICE_DEVICE || 'cpu';

      const engineId = req.body.voiceEngine || DEFAULT_VOICE_ENGINE_ID;
      const engine = voiceEngineRegistry.resolve(engineId, DEFAULT_VOICE_ENGINE_ID);
      clonerState.engineId = engine.id;
      const runSelectedVoiceEngine = async () => {
        return engine.cloneVoice({
          text: script,
          outputPath: voicePath,
          language: 'vi',
          device: selectedDevice,
          steps: process.env.OMNIVOICE_STEPS || '16',
          seed: String(Math.floor(Math.random() * 9999999)),
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
      console.log(`[OmniCloner] Đã lưu giọng tạm thời tại ${voicePath}`);

      clonerState.stage = 'Hoàn tất!';
      clonerState.percent = 100;
      clonerState.active = false;

      res.json({
        success: true,
        message: 'Tạo giọng mẫu bằng Omni Cloner thành công!',
        filename: '_temp_cloner_voice.wav'
      });

    } catch (err) {
      if (!clonerState.active) {
        try { if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath); } catch (e) {}
        try { if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); } catch (e) {}
        return res.json({ success: false, cancelled: true, message: 'Da huy tao giong' });
      }
      console.error('Error generating Omni Cloner voice:', err.message);
      if (err.message !== 'Đã hủy') {
        try { if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath); } catch (e) {}
        try { if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); } catch (e) {}
        clonerState.error = err.message;
        res.status(500).json({ error: `Lỗi Omni Cloner: ${err.message}` });
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
