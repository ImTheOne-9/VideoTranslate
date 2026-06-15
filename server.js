const express = require('express');
const path = require('path');
const { execFile, spawn, exec } = require('child_process');
const fs = require('fs');
const contentDisposition = require('content-disposition');
const multer = require('multer');
const { translateSubtitles } = require('./lib/translate-sub');

const app = express();
const PORT = 3456;

// Create downloads directory
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Create uploads directory for studio
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const VOICES_DIR = path.join(UPLOADS_DIR, 'voices');
const MUSIC_DIR = path.join(UPLOADS_DIR, 'music');
const SUBTITLES_DIR = path.join(UPLOADS_DIR, 'subtitles');
const TMP_UPLOADS_DIR = path.join(UPLOADS_DIR, 'tmp');
const RENDERS_DIR = path.join(DOWNLOADS_DIR, 'renders');
for (const dir of [VOICES_DIR, MUSIC_DIR, SUBTITLES_DIR, TMP_UPLOADS_DIR, RENDERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });
const studioUpload = multer({ dest: TMP_UPLOADS_DIR });

const FFMPEG_PATH = path.join(__dirname, 'tools', 'ffmpeg.exe');
const YTDLP_PATH = path.join(__dirname, 'tools', 'yt-dlp.exe');
const OMNIVOICE_CLI_PATH = process.env.OMNIVOICE_CLI_PATH || path.join(__dirname, 'tools', 'omnivoice', 'omnivoice-cli.exe');
const OMNIVOICE_MODEL_PATH = process.env.OMNIVOICE_MODEL_PATH || path.join(__dirname, 'tools', 'omnivoice', 'models', 'omnivoice-q8_0.gguf');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/renders', express.static(RENDERS_DIR));

// Helper: Run yt-dlp command and get JSON output
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp stderr:', stderr);
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

// Validate Video URL
function isValidVideoUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com\/(shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/)/.test(url);
}

function safeFileName(name) {
  return (name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120);
}

function moveUploadedFile(file, targetDir, fallbackName) {
  if (!file) return null;
  const ext = path.extname(file.originalname || '') || path.extname(fallbackName || '') || '.bin';
  const base = safeFileName(path.basename(file.originalname || fallbackName || `asset_${Date.now()}`, ext));
  const finalName = `${Date.now()}_${base}${ext}`;
  const finalPath = path.join(targetDir, finalName);
  fs.renameSync(file.path, finalPath);
  return finalPath;
}

function listFiles(dir, exts) {
  try {
    return fs.readdirSync(dir)
      .filter(name => exts.includes(path.extname(name).toLowerCase()))
      .map(name => {
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        return {
          filename: name,
          size: stat.size,
          modified: stat.mtime
        };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
  } catch (e) {
    return [];
  }
}

function resolveAssetPath(kind, filename) {
  const roots = {
    video: DOWNLOADS_DIR,
    voice: VOICES_DIR,
    music: MUSIC_DIR,
    subtitle: SUBTITLES_DIR
  };
  const root = roots[kind];
  if (!root || !filename) return null;
  const resolved = path.resolve(root, filename);
  if (!resolved.startsWith(path.resolve(root))) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function escapeSubtitleForFilter(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// API: Get video info
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Vui lòng nhập URL video' });
    }

    if (!isValidVideoUrl(url)) {
      return res.status(400).json({ error: 'URL không hợp lệ' });
    }

    // Get video info as JSON using yt-dlp
    const output = await runYtDlp([
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      url
    ]);

    const info = JSON.parse(output);

    // Extract formats - only mp4 with video
    const formats = (info.formats || [])
      .filter(f => {
        // Only mp4 container with video
        return f.ext === 'mp4' && f.vcodec && f.vcodec !== 'none' && f.height;
      })
      .map(f => ({
        format_id: f.format_id,
        quality: f.height ? `${f.height}p` : f.format_note || 'N/A',
        height: f.height || 0,
        fps: f.fps || 30,
        size: f.filesize
          ? (f.filesize / (1024 * 1024)).toFixed(1) + ' MB'
          : f.filesize_approx
            ? '~' + (f.filesize_approx / (1024 * 1024)).toFixed(1) + ' MB'
            : 'N/A',
        // We will merge everything with audio, so everything "has audio" from the user's perspective
        hasAudio: true, 
        container: 'mp4',
        format_note: f.format_note || '',
      }))
      // Remove duplicates by quality
      .reduce((acc, f) => {
        const key = `${f.quality}-${f.fps}`;
        if (!acc.map.has(key)) {
          acc.map.set(key, true);
          acc.list.push(f);
        }
        return acc;
      }, { map: new Map(), list: [] }).list
      // Sort: height desc
      .sort((a, b) => {
        if (a.height !== b.height) return b.height - a.height;
        return b.fps - a.fps;
      });

    // Get best thumbnail
    const thumbnails = info.thumbnails || [];
    const thumbnail = thumbnails.length > 0
      ? thumbnails[thumbnails.length - 1].url
      : '';

    res.json({
      title: info.title || 'Untitled',
      thumbnail,
      duration: info.duration || 0,
      author: info.uploader || info.channel || 'Unknown',
      viewCount: info.view_count || 0,
      formats,
    });
  } catch (error) {
    console.error('Error getting info:', error.message);
    res.status(500).json({ error: 'Không thể lấy thông tin video. Vui lòng thử lại.' });
  }
});

// API: Download video
app.get('/api/download', async (req, res) => {
  try {
    const { url, format_id } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Thiếu URL' });
    }

    if (!isValidVideoUrl(url)) {
      return res.status(400).json({ error: 'URL không hợp lệ' });
    }

    // Get video title first
    const infoOutput = await runYtDlp([
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      url
    ]);
    const info = JSON.parse(infoOutput);
    const safeTitle = (info.title || 'video').replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);

    const tempFileName = `temp-${Date.now()}-${Math.floor(Math.random()*1000)}.mp4`;
    const tempFilePath = path.join(DOWNLOADS_DIR, tempFileName);

    // Build yt-dlp args for download
    const args = [
      '--no-warnings',
      '--no-playlist',
      '-o', tempFilePath,
    ];

    if (fs.existsSync(FFMPEG_PATH)) {
      args.push('--ffmpeg-location', FFMPEG_PATH);
    }

    if (format_id) {
      // Check if format has audio in the original data
      const selectedFormat = (info.formats || []).find(f => f.format_id === format_id);
      if (selectedFormat && selectedFormat.acodec === 'none') {
        // Video-only format: merge with best audio
        args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}+bestaudio/best`);
        args.push('--merge-output-format', 'mp4');
      } else {
        // If it already has audio or we can't find it, just download it
        args.push('-f', `${format_id}+bestaudio[ext=m4a]/${format_id}/best`);
        args.push('--merge-output-format', 'mp4');
      }
    } else {
      // Default: best quality with audio
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
      args.push('--merge-output-format', 'mp4');
    }

    args.push(url);

    console.log('Downloading with args:', args.join(' '));

    const ytdlp = spawn(YTDLP_PATH, args);

    ytdlp.stdout.on('data', (data) => {
      console.log('yt-dlp stdout:', data.toString().trim());
    });

    ytdlp.stderr.on('data', (data) => {
      console.log('yt-dlp progress:', data.toString().trim());
    });

    ytdlp.on('error', (err) => {
      console.error('yt-dlp spawn error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Không thể tải video' });
      }
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempFilePath)) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}.mp4`));
        
        const stream = fs.createReadStream(tempFilePath);
        stream.pipe(res);
        
        stream.on('end', () => {
          fs.unlinkSync(tempFilePath); // delete temp file after sending
        });
      } else {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Lỗi khi tải video hoặc merge video' });
        }
      }
    });

    // Handle client disconnect
    req.on('close', () => {
      ytdlp.kill('SIGTERM');
      if (fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch (e) {}
      }
    });

  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể tải video. Vui lòng thử lại.' });
    }
  }
});

// API: Download video with hardcoded Vietnamese subtitles
app.get('/api/download-vi', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });
    if (!isValidVideoUrl(url)) return res.status(400).json({ error: 'URL không hợp lệ' });

    console.log('Bắt đầu tải video kèm Vietsub:', url);

    // Get video title and ID
    const infoOutput = await runYtDlp(['--dump-json', '--no-warnings', '--no-playlist', url]);
    const info = JSON.parse(infoOutput);
    const safeTitle = (info.title || 'video_vietsub').replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    const videoId = info.id || Date.now();

    const tempDir = path.join(DOWNLOADS_DIR, `temp_${videoId}_${Math.floor(Math.random() * 1000)}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const videoPathPattern = path.join(tempDir, `video.%(ext)s`);
    const subPathPattern = path.join(tempDir, `sub.%(ext)s`);
    const finalVideoPath = path.join(tempDir, `final.mp4`);
    const translatedSubPath = path.join(tempDir, `translated.srt`);

    // 1. Download video
    const videoArgs = ['--no-warnings', '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', videoPathPattern, url];
    if (fs.existsSync(FFMPEG_PATH)) videoArgs.push('--ffmpeg-location', FFMPEG_PATH);
    
    await new Promise((resolve, reject) => {
      execFile(YTDLP_PATH, videoArgs, (err, stdout, stderr) => {
        if (err) reject(new Error('Lỗi tải video gốc: ' + stderr));
        else resolve();
      });
    });

    // Find actual video path
    const files = fs.readdirSync(tempDir);
    const videoFile = files.find(f => f.startsWith('video.'));
    if (!videoFile) throw new Error('Không tìm thấy video đã tải');
    const actualVideoPath = path.join(tempDir, videoFile);

    // 2. Download subtitles
    const subArgs = ['--write-auto-subs', '--write-subs', '--convert-subs', 'srt', '--skip-download', '-o', subPathPattern, url];
    await new Promise((resolve) => {
      execFile(YTDLP_PATH, subArgs, () => resolve()); // Ignore errors if no sub
    });

    const updatedFiles = fs.readdirSync(tempDir);
    let subFile = updatedFiles.find(f => f.startsWith('sub.') && f.endsWith('.srt'));
    let actualSubPath = subFile ? path.join(tempDir, subFile) : null;

    if (!actualSubPath) {
      console.log('Không có phụ đề rời, khởi chạy Whisper Audio-to-Text...');
      const { extractAudioAndTranscribe } = require('./lib/whisper-helper');
      actualSubPath = await extractAudioAndTranscribe(actualVideoPath, tempDir, FFMPEG_PATH);
    }

    // 3. Translate subtitles and burn
    if (actualSubPath) {
      console.log('Tìm thấy phụ đề, tiến hành dịch:', actualSubPath);
      await translateSubtitles(actualSubPath, translatedSubPath);

      // Escape path for FFmpeg filter (windows paths need double backslashes escaping)
      const escapedSubPath = translatedSubPath.replace(/\\/g, '/').replace(/:/g, '\\:');

      // Burn sub: Background black, Text White, border style 3 is opaque box.
      const ffmpegArgs = [
        '-i', actualVideoPath,
        '-vf', `subtitles='${escapedSubPath}':force_style='BorderStyle=3,BackColour=&H80000000,MarginV=20,Fontsize=18'`,
        '-c:a', 'copy',
        '-y', finalVideoPath
      ];

      console.log('Đang hardcode phụ đề...');
      await new Promise((resolve, reject) => {
        execFile(FFMPEG_PATH, ffmpegArgs, (err, stdout, stderr) => {
          if (err) reject(new Error('Lỗi chèn phụ đề: ' + stderr));
          else resolve();
        });
      });
    } else {
      console.log('Không tìm thấy phụ đề, sử dụng video gốc.');
      fs.copyFileSync(actualVideoPath, finalVideoPath);
    }

    // 4. Send to client
    if (fs.existsSync(finalVideoPath)) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', contentDisposition(`${safeTitle}_Vietsub.mp4`));
      const stream = fs.createReadStream(finalVideoPath);
      stream.pipe(res);
      stream.on('end', () => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
    } else {
      throw new Error('Lỗi xuất video cuối');
    }

    req.on('close', () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

  } catch (error) {
    console.error('Download Vietsub error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Không thể tải video kèm Vietsub. Vui lòng thử lại.' });
    }
  }
});

// API: Get playlist info
app.post('/api/playlist', async (req, res) => {
  try {
    const { url, limit } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });
    if (!limit || limit <= 0) return res.status(400).json({ error: 'Số lượng không hợp lệ' });

    // yt-dlp --dump-json --flat-playlist --playlist-end <limit> <url>
    const output = await runYtDlp([
      '--dump-json',
      '--flat-playlist',
      '--playlist-end', limit.toString(),
      '--no-warnings',
      url
    ]);

    // output contains multiple json objects separated by newline
    const lines = output.trim().split('\n');
    const videos = lines.map(line => {
      try {
        const item = JSON.parse(line);
        return {
          id: item.id,
          title: item.title,
          url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
          duration: item.duration
        };
      } catch(e) {
        return null;
      }
    }).filter(v => v);

    res.json({ videos });
  } catch (error) {
    console.error('Playlist error:', error.message);
    res.status(500).json({ error: 'Không thể lấy thông tin kênh/playlist.' });
  }
});

// API: Download locally
app.post('/api/download-local', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    const args = [
      '--no-warnings',
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s'),
    ];

    if (fs.existsSync(FFMPEG_PATH)) {
      args.push('--ffmpeg-location', FFMPEG_PATH);
    }

    args.push(url);

    execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp local stderr:', stderr);
        return res.status(500).json({ error: 'Lỗi tải video' });
      }
      res.json({ success: true, message: 'Đã tải thành công' });
    });

  } catch (error) {
    console.error('Download local error:', error.message);
    res.status(500).json({ error: 'Lỗi tải video' });
  }
});

// API: Open folder
app.get('/api/open-folder', (req, res) => {
  let command = '';
  switch (process.platform) { 
    case 'win32': command = `explorer "${DOWNLOADS_DIR}"`; break;
    case 'darwin': command = `open "${DOWNLOADS_DIR}"`; break;
    default: command = `xdg-open "${DOWNLOADS_DIR}"`; break;
  }
  exec(command);
  res.json({ success: true });
});

// ==========================================
// STUDIO APIs
// ==========================================

// List downloaded videos
app.get('/api/local-videos', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({
        filename: f,
        path: path.join(DOWNLOADS_DIR, f)
      }));
    res.json({ videos: files });
  } catch(e) {
    res.json({ videos: [] });
  }
});

// Render Reaction Video
app.post('/api/render-reaction', upload.single('reactionVideo'), (req, res) => {
  const { mainVideoFile, position } = req.body;
  const reactionFile = req.file;

  if (!mainVideoFile || !reactionFile) {
    return res.status(400).json({ error: 'Thiếu file video' });
  }

  const mainPath = path.join(DOWNLOADS_DIR, mainVideoFile);
  const outPath = path.join(DOWNLOADS_DIR, `reaction_${Date.now()}.mp4`);

  // Build ffmpeg filter complex for PIP
  // Default: bottom-right
  let overlayPos = 'main_w-overlay_w-20:main_h-overlay_h-20';
  if (position === 'bottom-left') overlayPos = '20:main_h-overlay_h-20';
  if (position === 'top-right') overlayPos = 'main_w-overlay_w-20:20';
  if (position === 'top-left') overlayPos = '20:20';

  // We scale the reaction video to width 320
  const filter = `[1:v]scale=320:-1[pip];[0:v][pip]overlay=${overlayPos}[v]`;

  const args = [
    '-i', mainPath,
    '-i', reactionFile.path,
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '0:a?', // Keep original audio
    '-c:v', 'libx264',
    '-c:a', 'copy',
    '-y', outPath
  ];

  console.log('Rendering Reaction with FFmpeg...');
  
  execFile(FFMPEG_PATH, args, (error, stdout, stderr) => {
    // Delete temp upload
    try { fs.unlinkSync(reactionFile.path); } catch(e){}

    if (error) {
      console.error('FFmpeg error:', stderr);
      return res.status(500).json({ error: 'Lỗi khi render video' });
    }
    res.json({ success: true, message: 'Tạo video thành công!', file: path.basename(outPath) });
  });
});

app.get('/api/studio-assets', (req, res) => {
  res.json({
    videos: listFiles(DOWNLOADS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
    renders: listFiles(RENDERS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
    voices: listFiles(VOICES_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg']),
    music: listFiles(MUSIC_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg']),
    subtitles: listFiles(SUBTITLES_DIR, ['.srt', '.vtt', '.ass']),
    omiConfigured: fs.existsSync(OMNIVOICE_CLI_PATH) && fs.existsSync(OMNIVOICE_MODEL_PATH),
    omnivoice: {
      cliExists: fs.existsSync(OMNIVOICE_CLI_PATH),
      modelExists: fs.existsSync(OMNIVOICE_MODEL_PATH),
      cliPath: OMNIVOICE_CLI_PATH,
      modelPath: OMNIVOICE_MODEL_PATH
    }
  });
});

app.post('/api/save-voice', studioUpload.single('voice'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file giọng mẫu' });
    const savedPath = moveUploadedFile(req.file, VOICES_DIR, req.body.voiceName || req.file.originalname);
    res.json({
      success: true,
      message: 'Đã lưu giọng mẫu',
      voice: path.basename(savedPath)
    });
  } catch (error) {
    console.error('Save voice error:', error.message);
    res.status(500).json({ error: 'Không thể lưu giọng mẫu' });
  }
});

app.post('/api/save-music', studioUpload.single('music'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file nhạc nền' });
    const savedPath = moveUploadedFile(req.file, MUSIC_DIR, req.file.originalname);
    res.json({
      success: true,
      message: 'Đã lưu nhạc nền',
      music: path.basename(savedPath)
    });
  } catch (error) {
    console.error('Save music error:', error.message);
    res.status(500).json({ error: 'Không thể lưu nhạc nền' });
  }
});

app.post('/api/render-studio', studioUpload.fields([
  { name: 'videoUpload', maxCount: 1 },
  { name: 'subtitleUpload', maxCount: 1 },
  { name: 'voiceUpload', maxCount: 1 },
  { name: 'musicUpload', maxCount: 1 }
]), async (req, res) => {
  const tempFiles = [];
  try {
    const body = req.body;
    const files = req.files || {};
    const timestamp = Date.now();
    const workDir = path.join(UPLOADS_DIR, `render_${timestamp}`);
    fs.mkdirSync(workDir, { recursive: true });

    let sourceVideo = null;
    if (files.videoUpload?.[0]) {
      sourceVideo = moveUploadedFile(files.videoUpload[0], workDir, 'source.mp4');
      tempFiles.push(sourceVideo);
    } else if (body.mainVideoFile) {
      sourceVideo = resolveAssetPath('video', body.mainVideoFile);
    }
    if (!sourceVideo) return res.status(400).json({ error: 'Thiếu video nguồn' });

    let subtitlePath = null;
    const subtitleMode = body.subtitleMode || 'none';
    if (subtitleMode === 'upload' && files.subtitleUpload?.[0]) {
      subtitlePath = moveUploadedFile(files.subtitleUpload[0], SUBTITLES_DIR, files.subtitleUpload[0].originalname);
    } else if (subtitleMode === 'saved') {
      subtitlePath = resolveAssetPath('subtitle', body.savedSubtitleFile);
    } else if (subtitleMode === 'generate') {
      const { extractAudioAndTranscribe } = require('./lib/whisper-helper');
      subtitlePath = await extractAudioAndTranscribe(sourceVideo, workDir, FFMPEG_PATH);
    }

    if (subtitlePath && body.translateVi === 'true') {
      const translatedPath = path.join(workDir, `translated_${timestamp}.srt`);
      await translateSubtitles(subtitlePath, translatedPath);
      subtitlePath = translatedPath;
    }

    let voicePath = null;
    const voiceMode = body.voiceMode || 'none';
    if (voiceMode === 'upload' && files.voiceUpload?.[0]) {
      voicePath = moveUploadedFile(files.voiceUpload[0], workDir, files.voiceUpload[0].originalname);
      tempFiles.push(voicePath);
    } else if (voiceMode === 'saved') {
      voicePath = resolveAssetPath('voice', body.savedVoiceFile);
    } else if (voiceMode === 'omi') {
      const refAudioPath = resolveAssetPath('voice', body.savedVoiceFile);
      const refText = (body.refText || '').trim();
      const omiScript = (body.omiScript || '').trim();
      if (!refAudioPath) {
        return res.status(400).json({ error: 'Chọn giọng mẫu đã lưu để clone.' });
      }
      if (!refText) {
        return res.status(400).json({ error: 'Nhập ref-text đúng với nội dung trong file giọng mẫu.' });
      }
      if (!omiScript) {
        return res.status(400).json({ error: 'Nhập kịch bản để OmniVoice đọc.' });
      }
      if (!fs.existsSync(OMNIVOICE_CLI_PATH)) {
        return res.status(400).json({ error: `Thiếu omnivoice-cli.exe tại ${OMNIVOICE_CLI_PATH}` });
      }
      if (!fs.existsSync(OMNIVOICE_MODEL_PATH)) {
        return res.status(400).json({ error: `Thiếu model GGUF tại ${OMNIVOICE_MODEL_PATH}` });
      }
      voicePath = path.join(workDir, `omnivoice_${timestamp}.wav`);
      const omnivoiceArgs = [
        '--model', OMNIVOICE_MODEL_PATH,
        '--text', omiScript,
        '--output', voicePath,
        '--response-format', 'wav',
        '--ref-audio', refAudioPath,
        '--ref-text', refText,
        '--language', body.omiLanguage || 'Vietnamese',
        '--device', body.omiDevice || process.env.OMNIVOICE_DEVICE || 'cpu',
        '--num-step', body.omiSteps || process.env.OMNIVOICE_STEPS || '16',
        '--seed', body.omiSeed || '123'
      ];
      await runExecFile(OMNIVOICE_CLI_PATH, omnivoiceArgs, { cwd: path.dirname(OMNIVOICE_CLI_PATH) });
      tempFiles.push(voicePath);
    }

    let musicPath = null;
    const musicMode = body.musicMode || 'none';
    if (musicMode === 'upload' && files.musicUpload?.[0]) {
      musicPath = moveUploadedFile(files.musicUpload[0], MUSIC_DIR, files.musicUpload[0].originalname);
    } else if (musicMode === 'saved') {
      musicPath = resolveAssetPath('music', body.savedMusicFile);
    }

    const outName = `studio_${timestamp}.mp4`;
    const outPath = path.join(RENDERS_DIR, outName);
    const args = ['-i', sourceVideo];
    const audioInputs = [];

    if (voicePath) {
      args.push('-i', voicePath);
      audioInputs.push({ index: args.filter(v => v === '-i').length - 1, volume: 1 });
    }
    if (musicPath) {
      args.push('-stream_loop', '-1', '-i', musicPath);
      const bgmVolume = Math.max(0, Math.min(1, Number(body.musicVolume || 0.18)));
      audioInputs.push({ index: args.filter(v => v === '-i').length - 1, volume: bgmVolume });
    }

    if (subtitlePath && body.burnSub === 'true') {
      const fontSize = Number(body.subtitleSize || 18);
      const marginV = Number(body.subtitleMargin || 28);
      const style = `BorderStyle=3,BackColour=&H80000000,Fontsize=${fontSize},MarginV=${marginV}`;
      args.push('-vf', `subtitles='${escapeSubtitleForFilter(subtitlePath)}':force_style='${style}'`);
    }

    if (audioInputs.length > 0) {
      const originalVolume = Math.max(0, Math.min(1, Number(body.originalVolume || 0.45)));
      const filters = [`[0:a]volume=${originalVolume}[a0]`];
      const mixLabels = ['[a0]'];
      audioInputs.forEach((input, idx) => {
        const label = `a${idx + 1}`;
        filters.push(`[${input.index}:a]volume=${input.volume}[${label}]`);
        mixLabels.push(`[${label}]`);
      });
      filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=2[aout]`);
      args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', 'aac');
    } else {
      args.push('-map', '0:v', '-map', '0:a?', '-c:a', 'aac');
    }

    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', '-shortest', '-y', outPath);
    await runExecFile(FFMPEG_PATH, args);

    res.json({
      success: true,
      message: 'Đã render video',
      file: outName,
      url: `/renders/${encodeURIComponent(outName)}`
    });
  } catch (error) {
    console.error('Render studio error:', error.stderr || error.message);
    res.status(500).json({ error: 'Không thể render video. Kiểm tra video, sub, voice hoặc nhạc nền.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 YouTube Shorts Downloader đang chạy tại:`);
  console.log(`   http://localhost:${PORT}\n`);
});
