const fs = require('fs');
const path = require('path');
const contentDisposition = require('content-disposition');
const shared = require('../lib/shared-state');
const { translateSubtitles } = require('../lib/translate-sub');
const { validate, validators } = require('../lib/validate');

module.exports = {
  proxyImage: async (req, res) => {
    try {
      const { err, values } = validate(req.query, {
        url: validators.url('Invalid image URL')
      });
      if (err) return res.status(400).send(err);
      const url = values.url;
      const axios = require('axios');
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': url.includes('instagram') ? 'https://www.instagram.com/' : (url.includes('xiaohongshu') ? 'https://www.xiaohongshu.com/' : 'https://www.google.com/')
        },
        timeout: 10000
      });
      res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
      response.data.pipe(res);
    } catch (error) {
      console.error('Proxy image error:', error.message);
      res.status(500).send('Error loading image');
    }
  },

  download: async (req, res) => {
    const controller = new AbortController();
    const { signal } = controller;
    let tempFilePath = null;

    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
        if (tempFilePath) {
          setTimeout(() => {
            shared.cleanupTempFiles(tempFilePath);
          }, 1000);
        }
      }
    });

    try {
      let { url, format_id } = req.query;
      url = shared.extractUrl(url);
      if (!url) {
        return res.status(400).json({ error: 'Thiếu URL' });
      }

      if (!shared.isValidVideoUrl(url)) {
        return res.status(400).json({ error: 'URL không hợp lệ' });
      }

      const ytInfoArgs = [
        '--dump-json',
        '--no-warnings',
        '--no-playlist',
        ...shared.getCustomExtractorArgs(url)
      ];
      ytInfoArgs.push(url);

      const infoOutput = await shared.runYtDlp(ytInfoArgs, { signal });
      const info = JSON.parse(infoOutput);
      const safeTitle = shared.removeVietnameseTones(shared.cleanVideoTitle(info.title)).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);

      const tempFileName = `temp-${Date.now()}-${Math.floor(Math.random()*1000)}.mp4`;
      tempFilePath = path.join(shared.DOWNLOADS_DIR, tempFileName);

      const args = [
        '--no-warnings',
        '--no-playlist',
        '-o', tempFilePath,
        ...shared.getCustomExtractorArgs(url)
      ];

      if (fs.existsSync(shared.FFMPEG_PATH)) {
        args.push('--ffmpeg-location', shared.FFMPEG_PATH);
      }

      if (format_id) {
        const selectedFormat = (info.formats || []).find(f => f.format_id === format_id);
        if (selectedFormat && selectedFormat.acodec === 'none') {
          args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}+bestaudio/best`);
          args.push('--merge-output-format', 'mp4');
        } else {
          args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}/best`);
          args.push('--merge-output-format', 'mp4');
        }
      } else {
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
        args.push('--merge-output-format', 'mp4');
      }

      args.push(url);

      console.log('Downloading with args:', args.join(' '));

      try {
        await shared.runYtDlp(args, { signal });
        if (fs.existsSync(tempFilePath)) {
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}.mp4`));
          
          const stream = fs.createReadStream(tempFilePath);
          stream.pipe(res);
          
          stream.on('end', () => {
            shared.cleanupTempFiles(tempFilePath);
          });
        } else {
          console.error('Quá trình tải video thất bại - File không tồn tại:', tempFilePath);
          res.status(500).json({ error: 'Quá trình tải video thất bại: File không tồn tại trên server' });
        }
      } catch (err) {
        console.error('yt-dlp download error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Không thể tải video: ' + err.message });
        }
      }

    } catch (error) {
      console.error('Download error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Không thể tải video. Vui lòng thử lại. Chi tiết: ' + error.message });
      }
    }
  },

  downloadVi: async (req, res) => {
    const controller = new AbortController();
    const { signal } = controller;
    let tempDir = null;

    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
        if (tempDir) {
          setTimeout(() => {
            try {
              if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
              }
            } catch (e) {
              console.error('Lỗi khi xóa tempDir (req close):', e.message);
            }
          }, 1000);
        }
      }
    });

    try {
      let { url, aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel, ninerouterApiKey, ninerouterModel, ninerouterBaseUrl } = req.query;
      url = shared.extractUrl(url);
      if (!url) return res.status(400).json({ error: 'Thiếu URL' });
      if (!shared.isValidVideoUrl(url)) return res.status(400).json({ error: 'URL không hợp lệ' });

      console.log('Bắt đầu tải video kèm Vietsub:', url);

      const ytInfoArgs = ['--dump-json', '--no-warnings', '--no-playlist', ...shared.getCustomExtractorArgs(url)];
      ytInfoArgs.push(url);
      const infoOutput = await shared.runYtDlp(ytInfoArgs, { signal });
      const info = JSON.parse(infoOutput);
      const safeTitle = shared.removeVietnameseTones(shared.cleanVideoTitle(info.title)).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      const videoId = info.id || Date.now();

      tempDir = path.join(shared.DOWNLOADS_DIR, `temp_${videoId}_${Math.floor(Math.random() * 1000)}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const videoPathPattern = path.join(tempDir, `video.%(ext)s`);
      const subPathPattern = path.join(tempDir, `sub.%(ext)s`);
      const finalVideoPath = path.join(tempDir, `final.mp4`);
      const translatedSubPath = path.join(tempDir, `translated.srt`);

      const videoArgs = ['--no-warnings', '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', videoPathPattern, ...shared.getCustomExtractorArgs(url)];
      videoArgs.push(url);
      if (fs.existsSync(shared.FFMPEG_PATH)) videoArgs.push('--ffmpeg-location', shared.FFMPEG_PATH);
      
      await shared.runYtDlp(videoArgs, { signal });

      const files = fs.readdirSync(tempDir);
      const videoFile = files.find(f => f.startsWith('video.'));
      if (!videoFile) throw new Error('Không tìm thấy video đã tải');
      const actualVideoPath = path.join(tempDir, videoFile);

      const subArgs = ['--write-auto-subs', '--write-subs', '--convert-subs', 'srt', '--skip-download', '-o', subPathPattern, ...shared.getCustomExtractorArgs(url), url];
      try { await shared.runYtDlp(subArgs, { signal }); } catch (e) {}

      const updatedFiles = fs.readdirSync(tempDir);
      let subFile = updatedFiles.find(f => f.startsWith('sub.') && f.endsWith('.srt'));
      let actualSubPath = subFile ? path.join(tempDir, subFile) : null;

      if (!actualSubPath) {
        console.log('Không có phụ đề rời, khởi chạy Whisper Audio-to-Text...');
        const { extractAudioAndTranscribe } = require('../lib/whisper-helper');
        actualSubPath = await extractAudioAndTranscribe(actualVideoPath, tempDir, shared.FFMPEG_PATH);
      }

      if (actualSubPath) {
        console.log('Tìm thấy phụ đề, tiến hành dịch:', actualSubPath);
        const downloadMaxLines = Number(req.query.subtitleMaxLines || 0);
        const downloadFontSize = Math.round(Number(req.query.subtitleSize || 18) * 1.35);
        const downloadMarginH = Number(req.query.subtitleMarginH || 20);
        const downloadWidth = 1080;
        const downloadBoxWidth = downloadWidth - 2 * downloadMarginH;
        const downloadMaxChars = Math.max(10, Math.floor(downloadBoxWidth / (downloadFontSize * 0.5)));
        await translateSubtitles(actualSubPath, translatedSubPath, { aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel, ninerouterApiKey, ninerouterModel, ninerouterBaseUrl }, downloadMaxLines, downloadMaxChars);

        let hasSubtitles = false;
        try {
          if (fs.existsSync(translatedSubPath)) {
            const content = fs.readFileSync(translatedSubPath, 'utf8').trim();
            if (content.length > 0) {
              hasSubtitles = true;
            }
          }
        } catch (e) {}

        if (hasSubtitles) {
          const escapedSubPath = translatedSubPath.replace(/\\/g, '/').replace(/:/g, '\\:');

          const ffmpegArgs = [
            '-i', actualVideoPath,
            '-vf', `subtitles='${escapedSubPath}':force_style='BorderStyle=3,BackColour=&H80000000,MarginV=20,Fontsize=18,WrapStyle=0'`,
            '-c:a', 'copy',
            '-y', finalVideoPath
          ];

          console.log('Đang hardcode phụ đề...');
          await new Promise((resolve, reject) => {
            shared.execFile(shared.FFMPEG_PATH, ffmpegArgs, { signal }, (err, stdout, stderr) => {
              if (err) reject(new Error('Lỗi chèn phụ đề: ' + stderr));
              else resolve();
            });
          });
        } else {
          console.log('Phụ đề trống, sử dụng video gốc.');
          fs.copyFileSync(actualVideoPath, finalVideoPath);
        }
      } else {
        console.log('Không tìm thấy phụ đề, sử dụng video gốc.');
        fs.copyFileSync(actualVideoPath, finalVideoPath);
      }

      if (fs.existsSync(finalVideoPath)) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}_Vietsub.mp4`));
        const stream = fs.createReadStream(finalVideoPath);
        stream.pipe(res);
        stream.on('end', () => {
          try {
            if (fs.existsSync(tempDir)) {
              fs.rmSync(tempDir, { recursive: true, force: true });
            }
          } catch (e) {
            console.error('Lỗi khi xóa tempDir (stream end):', e.message);
          }
        });
      } else {
        throw new Error('Lỗi xuất video cuối');
      }
    } catch (error) {
      console.error('Download Vietsub error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Không thể tải video kèm Vietsub. Vui lòng thử lại. Chi tiết: ' + error.message });
      }
    }
  },

  playlist: async (req, res) => {
    try {
      let { url, limit } = req.body;
      url = shared.extractUrl(url);
      if (!url) return res.status(400).json({ error: 'Thiếu URL' });
      if (!limit || limit <= 0) return res.status(400).json({ error: 'Số lượng không hợp lệ' });

      const ytListArgs = [
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', limit.toString(),
        '--no-warnings',
        ...shared.getCustomExtractorArgs(url)
      ];
      ytListArgs.push(url);

      const output = await shared.runYtDlp(ytListArgs);
      const lines = output.trim().split('\n');
      const videos = lines.map(line => {
        try {
          const item = JSON.parse(line);
          let videoUrl = item.url;
          if (!videoUrl || !videoUrl.startsWith('http')) {
            if (url.includes('youtube.com') || url.includes('youtu.be')) {
              videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
            } else if (url.includes('facebook.com')) {
              videoUrl = `https://www.facebook.com/watch/?v=${item.id}`;
            } else if (url.includes('tiktok.com')) {
              videoUrl = `https://www.tiktok.com/@placeholder/video/${item.id}`;
            } else if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) {
              videoUrl = `https://www.xiaohongshu.com/discovery/item/${item.id}`;
            } else if (url.includes('instagram.com') || url.includes('instagr.am')) {
              videoUrl = `https://www.instagram.com/p/${item.id}`;
            } else if (item.id) {
              videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
            } else {
              videoUrl = '';
            }
          }

          let itemTitle = item.title;
          if ((url.includes('instagram.com') || url.includes('instagr.am')) && item.description) {
            const firstLine = item.description.split('\n')[0].trim();
            if (firstLine) {
              itemTitle = firstLine;
            }
          }

          let thumbUrl = item.thumbnail || (item.thumbnails && item.thumbnails.length > 0 ? item.thumbnails[0].url : '');
          if (thumbUrl && (thumbUrl.startsWith('http://') || thumbUrl.startsWith('https://'))) {
            thumbUrl = `/api/proxy-image?url=${encodeURIComponent(thumbUrl)}`;
          }

          return {
            id: item.id,
            title: itemTitle,
            url: videoUrl,
            duration: item.duration,
            thumbnail: thumbUrl
          };
        } catch(e) {
          return null;
        }
      }).filter(v => v);

      const limitedVideos = videos.slice(0, limit);
      res.json({ videos: limitedVideos });
    } catch (error) {
      console.error('Playlist error:', error.message);
      res.status(500).json({ error: 'Không thể lấy thông tin kênh/playlist.' });
    }
  },

  downloadLocal: async (req, res) => {
    const controller = new AbortController();
    const { signal } = controller;
    let tempDir = null;

    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
        if (tempDir) {
          setTimeout(() => {
            try {
              if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
              }
            } catch (e) {
              console.error('Lỗi khi xóa tempDir (local req close):', e.message);
            }
          }, 1000);
        }
      }
    });

    try {
      let { url, format_id, customFilename, aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel, ninerouterApiKey, ninerouterModel, ninerouterBaseUrl, subtitleMaxLines, subtitleSize, subtitleMarginH } = req.body;
      url = shared.extractUrl(url);
      if (!url) return res.status(400).json({ error: 'Thiếu URL' });

      const ytInfoArgs = ['--dump-json', '--no-warnings', '--no-playlist', ...shared.getCustomExtractorArgs(url)];
      ytInfoArgs.push(url);
      
      const infoOutput = await shared.runYtDlp(ytInfoArgs, { signal });
      const info = JSON.parse(infoOutput);
      
      let safeTitle;
      if (customFilename) {
        safeTitle = shared.removeVietnameseTones(customFilename).replace(/[<>:"/\\|?*]/g, '_').trim();
        if (safeTitle.toLowerCase().endsWith('.mp4')) {
          safeTitle = safeTitle.substring(0, safeTitle.length - 4);
        }
        safeTitle = safeTitle.substring(0, 100);
      } else {
        safeTitle = shared.removeVietnameseTones(shared.cleanVideoTitle(info.title)).replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
      }
      
      const isVietsub = format_id === 'vietsub';

      if (isVietsub) {
        const videoId = info.id || Date.now();
        tempDir = path.join(shared.DOWNLOADS_DIR, `temp_local_${videoId}_${Math.floor(Math.random() * 1000)}`);
        fs.mkdirSync(tempDir, { recursive: true });

        const videoPathPattern = path.join(tempDir, `video.%(ext)s`);
        const subPathPattern = path.join(tempDir, `sub.%(ext)s`);
        const finalVideoPath = path.join(shared.DOWNLOADS_DIR, `${safeTitle}_Vietsub.mp4`);
        const translatedSubPath = path.join(tempDir, `translated.srt`);

        const videoArgs = ['--no-warnings', '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', videoPathPattern, ...shared.getCustomExtractorArgs(url)];
        videoArgs.push(url);
        if (fs.existsSync(shared.FFMPEG_PATH)) videoArgs.push('--ffmpeg-location', shared.FFMPEG_PATH);
        
        await shared.runYtDlp(videoArgs, { signal });

        const files = fs.readdirSync(tempDir);
        const videoFile = files.find(f => f.startsWith('video.'));
        if (!videoFile) throw new Error('Không tìm thấy video đã tải');
        const actualVideoPath = path.join(tempDir, videoFile);

        const subArgs = ['--write-auto-subs', '--write-subs', '--convert-subs', 'srt', '--skip-download', '-o', subPathPattern, ...shared.getCustomExtractorArgs(url), url];
        try { await shared.runYtDlp(subArgs, { signal }); } catch (e) {}

        let subFile = fs.readdirSync(tempDir).find(f => f.startsWith('sub.') && f.endsWith('.srt'));
        let actualSubPath = subFile ? path.join(tempDir, subFile) : null;

        if (!actualSubPath) {
          console.log('Không có phụ đề rời, khởi chạy Whisper Audio-to-Text...');
          const { extractAudioAndTranscribe } = require('../lib/whisper-helper');
          actualSubPath = await extractAudioAndTranscribe(actualVideoPath, tempDir, shared.FFMPEG_PATH);
        }

        if (actualSubPath) {
          console.log('Tìm thấy phụ đề, tiến hành dịch:', actualSubPath);
          const downloadMaxLines = Number(subtitleMaxLines || 0);
          const downloadFontSize = Math.round(Number(subtitleSize || 18) * 1.35);
          const downloadMarginH = Number(subtitleMarginH || 20);
          const downloadWidth = 1080;
          const downloadBoxWidth = downloadWidth - 2 * downloadMarginH;
          const downloadMaxChars = Math.max(10, Math.floor(downloadBoxWidth / (downloadFontSize * 0.5)));
          await translateSubtitles(actualSubPath, translatedSubPath, { aiProvider, geminiApiKey, geminiModel, openRouterApiKey, openRouterModel, ninerouterApiKey, ninerouterModel, ninerouterBaseUrl }, downloadMaxLines, downloadMaxChars);

          let hasSubtitles = false;
          try {
            if (fs.existsSync(translatedSubPath) && fs.readFileSync(translatedSubPath, 'utf8').trim().length > 0) {
              hasSubtitles = true;
            }
          } catch (e) {}

          if (hasSubtitles) {
            const escapedSubPath = translatedSubPath.replace(/\\/g, '/').replace(/:/g, '\\:');
            const ffmpegArgs = [
              '-i', actualVideoPath,
              '-vf', `subtitles='${escapedSubPath}':force_style='BorderStyle=3,BackColour=&H80000000,MarginV=20,Fontsize=18,WrapStyle=0'`,
              '-c:a', 'copy',
              '-y', finalVideoPath
            ];
            await new Promise((resolve, reject) => {
              shared.execFile(shared.FFMPEG_PATH, ffmpegArgs, { signal }, (err, stdout, stderr) => {
                if (err) reject(new Error('Lỗi chèn phụ đề: ' + stderr));
                else resolve();
              });
            });
          } else {
            fs.copyFileSync(actualVideoPath, finalVideoPath);
          }
        } else {
          fs.copyFileSync(actualVideoPath, finalVideoPath);
        }

        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (e) {}
        
        res.json({ success: true, message: 'Đã tải thành công video Vietsub', filename: `${safeTitle}_Vietsub.mp4` });

      } else {
        const finalVideoPath = path.join(shared.DOWNLOADS_DIR, `${safeTitle}.mp4`);
        
        const args = [
          '--no-warnings',
          '--no-playlist',
          '-o', finalVideoPath,
          ...shared.getCustomExtractorArgs(url)
        ];
        if (fs.existsSync(shared.FFMPEG_PATH)) args.push('--ffmpeg-location', shared.FFMPEG_PATH);

        if (format_id && format_id !== 'best') {
          const selectedFormat = (info.formats || []).find(f => f.format_id === format_id);
          if (selectedFormat && selectedFormat.acodec === 'none') {
            args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}+bestaudio/best`);
          } else {
            args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}/best`);
          }
        } else {
          args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
        }
        args.push('--merge-output-format', 'mp4');
        args.push(url);

        await shared.runYtDlp(args, { signal });
        res.json({ success: true, message: 'Đã tải thành công', filename: `${safeTitle}.mp4` });
      }

    } catch (error) {
      console.error('Download local error:', error.message);
      res.status(500).json({ error: 'Lỗi tải video: ' + error.message });
    }
  }
};
