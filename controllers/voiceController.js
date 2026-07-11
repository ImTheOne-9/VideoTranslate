const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const shared = require('../lib/shared-state');

// Trạng thái tiến trình cloner voice
const clonerState = {
  active: false,
  process: null,
  stage: '',
  percent: 0,
  error: null,
  tempFiles: [],
  voiceFilename: null
};

function resetClonerState() {
  clonerState.active = false;
  clonerState.process = null;
  clonerState.stage = '';
  clonerState.percent = 0;
  clonerState.error = null;
  clonerState.tempFiles = [];
  clonerState.voiceFilename = null;
}

module.exports = {
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

    const voicePath = path.join(shared.VOICES_DIR, `${baseName}.wav`);
    const txtPath = path.join(shared.VOICES_DIR, `${baseName}.txt`);

    if (fs.existsSync(voicePath) || fs.existsSync(txtPath)) {
      return res.status(400).json({ error: 'Giọng mẫu với tên này đã tồn tại, vui lòng chọn tên khác.' });
    }

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

      // Chạy OmniVoice CLI và capture output để parse stage
      const omnivoiceArgs = [
        '--model', shared.OMNIVOICE_MODEL_PATH,
        '--text', script.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim(),
        '--output', voicePath,
        '--response-format', 'wav',
        '--language', 'vi',
        '--device', device || process.env.OMNIVOICE_DEVICE || 'cpu',
        '--num-step', process.env.OMNIVOICE_STEPS || '16',
        '--seed', String(Math.floor(Math.random() * 9999999)),
        '--ref-audio', refWavPath,
        '--ref-text', refText,
        '--position-temperature', '1.5'
      ];

      console.log(`[OmniCloner] Đang tạo giọng "${baseName}"...`);

      const cliPath = shared.OMNIVOICE_CLI_PATH;
      const child = spawn(cliPath, omnivoiceArgs, {
        cwd: path.dirname(cliPath),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      clonerState.process = child;

      child.stdout.on('data', (data) => {
        const line = data.toString();
        if (line.includes('model_load done')) {
          clonerState.stage = 'Đã tải model, đang xử lý giọng mẫu...';
          clonerState.percent = 30;
        } else if (line.includes('reference_encode') || line.includes('reference_read')) {
          clonerState.stage = 'Đang phân tích giọng mẫu...';
          clonerState.percent = 50;
        } else if (line.includes('generate')) {
          clonerState.stage = 'Đang tạo giọng nói AI...';
          clonerState.percent = 70;
        }
      });

      child.stderr.on('data', (data) => {
        const line = data.toString();
        if (line.includes('generate')) {
          clonerState.stage = 'Đang tạo giọng nói AI...';
          clonerState.percent = 70;
        } else if (line.includes('model_load')) {
          clonerState.stage = 'Đang tải model AI...';
          clonerState.percent = 10;
        }
      });

      const exitCode = await new Promise((resolve, reject) => {
        child.on('exit', (code) => {
          if (code === 0 || code === null) resolve(code);
          else reject(new Error(`OmniVoice CLI thoát với mã lỗi ${code}`));
        });
        child.on('error', reject);
      });

      if (!clonerState.active) {
        throw new Error('Đã hủy');
      }

      clonerState.stage = 'Đang lưu kết quả...';
      clonerState.percent = 90;

      fs.writeFileSync(txtPath, script, 'utf8');
      clonerState.voiceFilename = `${baseName}.wav`;
      console.log(`[OmniCloner] Đã lưu giọng tại ${voicePath}`);

      clonerState.stage = 'Hoàn tất!';
      clonerState.percent = 100;

      res.json({
        success: true,
        message: 'Tạo giọng mẫu bằng Omni Cloner thành công!',
        filename: `${baseName}.wav`
      });

    } catch (err) {
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
      voiceFilename: clonerState.voiceFilename
    });
  },

  cancelClonerVoice: async (req, res) => {
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
