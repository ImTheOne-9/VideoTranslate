const fs = require('fs');
const path = require('path');
const axios = require('axios');
const shared = require('../lib/shared-state');

const VBEE_APP_ID = process.env.VBEE_APP_ID || '470eb36b-eca1-4d22-96b6-c88c997b5bea';
const VBEE_TOKEN = process.env.VBEE_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODIxNzkwMzd9.5k5_aMzZw-BQLLBPtFZMNL0O2bCS6mootc_UBMKlNIU';

module.exports = {
  generateVbeeVoice: async (req, res) => {
    const { voiceCode, text, voiceName } = req.body;
    
    if (!voiceCode || !text || !voiceName) {
      return res.status(400).json({ error: 'Thiếu thông tin yêu cầu: voiceCode, text hoặc voiceName' });
    }

    const baseName = shared.safeFileName(voiceName);
    if (!baseName) {
      return res.status(400).json({ error: 'Tên giọng mẫu không hợp lệ' });
    }

    const audioPath = path.join(shared.VOICES_DIR, `${baseName}.wav`);
    const txtPath = path.join(shared.VOICES_DIR, `${baseName}.txt`);

    if (fs.existsSync(audioPath) || fs.existsSync(txtPath)) {
      return res.status(400).json({ error: 'Giọng mẫu với tên này đã tồn tại, vui lòng chọn tên khác.' });
    }

    try {
      const isFemale = voiceCode.includes('female');
      let success = false;

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VBEE_TOKEN}`,
        'App-Id': VBEE_APP_ID
      };

      const callVbeeSync = async () => {
        console.log(`[Vbee API Sync] Requesting ${baseName} (${voiceCode})...`);
        const response = await axios.post('https://api.vbee.vn/v1/tts', {
          text: text,
          voiceCode: voiceCode,
          outputFormat: 'wav',
          speed: 1.0,
          mode: 'sync'
        }, {
          headers,
          responseType: 'arraybuffer',
          timeout: 30000
        });
        fs.writeFileSync(audioPath, response.data);
        fs.writeFileSync(txtPath, text, 'utf8');
        console.log(`[Vbee API Sync] Saved to ${audioPath}`);
        return true;
      };

      const callVbeeAsync = async () => {
        console.log(`[Vbee API Async] Requesting ${baseName} (${voiceCode})...`);
        const response = await axios.post('https://api.vbee.vn/v1/tts', {
          text: text,
          voiceCode: voiceCode,
          outputFormat: 'wav',
          speed: 1.0,
          mode: 'async',
          bitrate: 128,
          webhookUrl: 'https://example.com/callback'
        }, {
          headers,
          timeout: 30000
        });

        const requestId = response.data?.requestId;
        if (!requestId) {
          throw new Error(response.data?.message || 'Không nhận được requestId từ Vbee.');
        }

        console.log(`[Vbee API Async] Request ID: ${requestId}. Bắt đầu polling...`);
        let status = 'PROCESSING';
        let audioLink = null;
        const maxAttempts = 30;
        let attempts = 0;

        while (status === 'PROCESSING' && attempts < maxAttempts) {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, 2000));

          const pollRes = await axios.get(`https://api.vbee.vn/v1/tts/requests/${requestId}`, {
            headers,
            timeout: 10000
          });

          status = pollRes.data?.status;
          console.log(`[Vbee Polling] Lần ${attempts}/${maxAttempts} - Trạng thái: ${status}`);

          if (status === 'COMPLETED') {
            audioLink = pollRes.data?.audioLink;
            break;
          } else if (status === 'FAILED') {
            throw new Error('Yêu cầu xử lý giọng nói bị lỗi trên Vbee.');
          }
        }

        if (!audioLink) {
          throw new Error('Vbee xử lý quá thời gian chờ (timeout) hoặc không tìm thấy liên kết âm thanh.');
        }

        console.log(`[Vbee Downloading] Đang tải audio từ: ${audioLink}`);
        const audioRes = await axios.get(audioLink, {
          responseType: 'arraybuffer',
          timeout: 30000
        });

        fs.writeFileSync(audioPath, audioRes.data);
        fs.writeFileSync(txtPath, text, 'utf8');
        console.log(`[Vbee API Async] Saved to ${audioPath}`);
        return true;
      };

      if (isFemale) {
        try {
          success = await callVbeeSync();
        } catch (syncErr) {
          console.warn(`[Vbee Sync Warning] Sync failed: ${syncErr.message}. Thử lại bằng Async...`);
          success = await callVbeeAsync();
        }
      } else {
        success = await callVbeeAsync();
      }

      if (success) {
        return res.json({ success: true, message: 'Tạo giọng mẫu thành công!' });
      } else {
        throw new Error('Không thể sinh file hoặc lưu file.');
      }

    } catch (err) {
      console.error('Error generating Vbee voice:', err.message);
      let detailedError = err.message;
      if (err.response?.data) {
        try {
          const errorData = err.response.data;
          const errorBody = Buffer.isBuffer(errorData) 
            ? JSON.parse(errorData.toString('utf8'))
            : (typeof errorData === 'object' ? errorData : JSON.parse(errorData));
          if (errorBody.message) detailedError = errorBody.message;
          else if (errorBody.error) detailedError = errorBody.error;
        } catch (parseErr) {}
      }
      
      try {
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
      } catch (cleanupErr) {}

      res.status(500).json({ error: `Lỗi gọi API Vbee AI: ${detailedError}` });
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
