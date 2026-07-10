const fs = require('fs');
const path = require('path');
const shared = require('../lib/shared-state');
const { translateSubtitles, formatSubtitleFile, srtTimeToMs, msToSrtTime } = require('../lib/translate-sub');

// Helpers for Studio rendering
function escapeSubtitleForFilter(filePath) {
  // FFmpeg subtitles filter: ' làm delimiter, cần dùng '\\'' để escape
  const noBackslash = filePath.replace(/\\/g, '/');
  const noColon = noBackslash.replace(/:/g, '\\:');
  const escaped = noColon.replace(/'/g, "'\\''");
  return escaped;
}

function hexToAssColor(hexStr) {
  if (!hexStr || !hexStr.startsWith('#')) return '&H00FFFFFF';
  const cleanHex = hexStr.replace('#', '');
  if (cleanHex.length !== 6) return '&H00FFFFFF';
  const rr = cleanHex.substring(0, 2);
  const gg = cleanHex.substring(2, 4);
  const bb = cleanHex.substring(4, 6);
  return `&H00${bb}${gg}${rr}`;
}

function getVideoDurationInSeconds(videoPath) {
  return new Promise((resolve) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      return resolve(0);
    }
    shared.execFile(shared.FFMPEG_PATH, ['-i', videoPath], (err, stdout, stderr) => {
      const output = stderr || '';
      const match = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d+)/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const centiseconds = parseInt(match[4].padEnd(3, '0').slice(0, 3), 10);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds + centiseconds / 1000;
        resolve(totalSeconds);
      } else {
        resolve(0);
      }
    });
  });
}

function runFFmpegWithProgress(args, totalDuration) {
  return new Promise((resolve, reject) => {
    console.log(`[FFmpeg Progress] Running FFmpeg with total duration ${totalDuration}s`);
    const proc = shared.spawn(shared.FFMPEG_PATH, args);

    let stderrOutput = '';

    proc.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      stderrOutput += chunk;

      if (totalDuration > 0) {
        const match = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (match) {
          const hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const seconds = parseInt(match[3], 10);
          const currentTime = hours * 3600 + minutes * 60 + seconds;

          const ffmpegProgress = Math.floor((currentTime / totalDuration) * 100);
          const overallPercent = 83 + Math.floor((ffmpegProgress / 100) * 14);
          shared.updateStudioProgress(overallPercent, `Đang kết xuất (render) video: ${ffmpegProgress}%`);
        }
      }
    });

    let settled = false;
    const safeResolve = (v) => { if (!settled) { settled = true; clearTimeout(timeoutHandle); resolve(v); } };
    const safeReject = (e) => { if (!settled) { settled = true; clearTimeout(timeoutHandle); e.stderr = stderrOutput; reject(e); } };

    proc.on('close', (code) => {
      if (code === 0) {
        safeResolve();
      } else {
        safeReject(new Error(`FFmpeg error (code ${code})`));
      }
    });

    proc.on('error', (err) => {
      safeReject(err);
    });

    // Khi proc bị kill ngoài (user hủy), 'close' vẫn fire với code != 0 -> safeReject
    // Timeout dự phòng: 2 tiếng (tránh treo vĩnh viễn nếu pipe chết mà không fire event)
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        try { proc.kill('SIGKILL'); } catch (e) { }
        safeReject(new Error('FFmpeg render timeout (2h)'));
      }
    }, 2 * 60 * 60 * 1000);
  });
}

function createWavHeader(dataLength, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataLength + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function readWavInfo(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(44);
  fs.readSync(fd, header, 0, 44, 0);
  fs.closeSync(fd);
  const sampleRate = header.readUInt32LE(24);
  const bitsPerSample = header.readUInt16LE(34);
  const numChannels = header.readUInt16LE(22);
  const subchunk1Size = header.readUInt32LE(16);
  const dataOffset = 20 + subchunk1Size;
  let actualDataOffset = dataOffset;
  if (dataOffset > 44) {
    // scan for "data" chunk beyond fmt
    const extendedHdr = Buffer.alloc(dataOffset - 44);
    const fd2 = fs.openSync(filePath, 'r');
    fs.readSync(fd2, extendedHdr, 0, dataOffset - 44, 44);
    const dataPos = extendedHdr.indexOf('data');
    if (dataPos !== -1) actualDataOffset = 44 + dataPos;
    fs.closeSync(fd2);
  }
  const bytesPerSample = bitsPerSample / 8;
  const bytesPerMs = (sampleRate * numChannels * bytesPerSample) / 1000;
  const dataSize = stat.size - actualDataOffset;
  return { sampleRate, bitsPerSample, numChannels, bytesPerMs, dataSize, actualDataOffset };
}

function convertSrtToAss(srtPath, assPath, options) {
  const Parser = require('srt-parser-2').default;
  const parser = new Parser();
  const srtContent = fs.readFileSync(srtPath, 'utf8');
  const srtArray = parser.fromSrt(srtContent);

  function convertSrtTime(srtTime) {
    if (!srtTime) return "0:00:00.00";
    const parts = srtTime.split(':');
    let hours = 0;
    let minutes = "00";
    let seconds = "00";
    let ms = "000";

    if (parts.length === 2) {
      minutes = parts[0];
      const secParts = parts[1].split(',');
      seconds = secParts[0];
      ms = secParts[1] || '000';
    } else if (parts.length >= 3) {
      hours = parseInt(parts[0], 10);
      minutes = parts[1];
      const secParts = parts[2].split(',');
      seconds = secParts[0];
      ms = secParts[1] || '000';
    } else {
      return "0:00:00.00";
    }
    const cs = ms.substring(0, 2).padEnd(2, '0');
    return `${hours}:${minutes}:${seconds}.${cs}`;
  }

  const {
    videoWidth,
    videoHeight,
    fontName,
    fontSize,
    assColor,
    isBold,
    borderStyle,
    outline,
    shadow,
    outlineColor,
    backColor,
    alignment,
    marginV,
    marginL,
    marginR,
    theme
  } = options;

  const assLines = [];
  assLines.push('[Script Info]');
  assLines.push('ScriptType: v4.00+');
  assLines.push(`PlayResX: ${videoWidth}`);
  assLines.push(`PlayResY: ${videoHeight}`);
  assLines.push('WrapStyle: 0');
  assLines.push('');
  assLines.push('[V4+ Styles]');
  assLines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, Strikeout, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  assLines.push(`Style: Default,${fontName},${fontSize},${assColor},&H000000FF,${outlineColor},${backColor},${isBold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`);
  assLines.push('');
  assLines.push('[Events]');
  assLines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  for (const item of srtArray) {
    const start = convertSrtTime(item.startTime);
    const end = convertSrtTime(item.endTime);
    let text = item.text.replace(/\n/g, '\\N');
    if (theme === 'neon-glow') {
      text = `{\\blur4}${text}`;
    }
    assLines.push(`Dialogue: 0,${start},${end},Default,,${marginL},${marginR},${marginV},,${text}`);
  }

  fs.writeFileSync(assPath, assLines.join('\n'), 'utf8');
}


// Queue workers
async function executeRenderTask(task) {
  const tempFiles = [];
  const voiceChunks = [];
  const renderId = task.id;

  global.activeRenderRes = null;
  shared.state.activeRenderId = renderId;
  shared.state.isStudioRendering = true;

  const res = {
    statusCode: 200,
    status: function (code) {
      this.statusCode = code;
      return this;
    },
    json: function (data) {
      if (this.statusCode >= 400 || data.error) {
        throw new Error(data.error || 'Lỗi không xác định khi kết xuất');
      }
      task.status = 'success';
      task.percent = 100;
      task.step = 'Hoàn tất render!';
      task.result = data;
      shared.state.studioProgress = {
        status: 'success',
        percent: 100,
        step: 'Hoàn tất render!',
        error: null,
        result: data
      };
      return this;
    }
  };

  try {
    shared.state.studioProgress = {
      status: 'rendering',
      percent: 2,
      step: 'Khởi tạo thư mục làm việc...',
      error: null
    };
    task.status = 'rendering';
    task.percent = 2;
    task.step = 'Khởi tạo thư mục làm việc...';

    const body = task.body;
    const files = task.files || {};
    const timestamp = Date.now();
    const workDir = path.join(shared.UPLOADS_DIR, `render_${timestamp}`);
    fs.mkdirSync(workDir, { recursive: true });

    let sourceVideo = null;
    if (files.videoUpload?.[0]) {
      const originalName = files.videoUpload[0].originalname;
      sourceVideo = shared.moveUploadedFile(files.videoUpload[0], shared.DOWNLOADS_DIR, originalName);
    } else if (body.mainVideoFile) {
      sourceVideo = shared.resolveAssetPath('video', body.mainVideoFile);
    }
    if (!sourceVideo) return res.status(400).json({ error: 'Thiếu video nguồn' });

    shared.updateStudioProgress(5, 'Đang phân tích thông tin video nguồn...');
    const dimensions = await shared.getVideoDimensions(sourceVideo);
    const videoWidth = dimensions.width;
    const videoHeight = dimensions.height;
    const totalDuration = await getVideoDurationInSeconds(sourceVideo);
    console.log(`[Studio Render] Kích thước video nguồn: ${videoWidth}x${videoHeight}, Thời lượng: ${totalDuration}s`);

    let extractedBgmPath = null;
    if (body.keepOriginalBgmAI === 'true') {
      const tempAudioToSeparate = path.join(workDir, `original_audio_${timestamp}.wav`);
      try {
        await new Promise((resolve, reject) => {
          shared.execFile(shared.FFMPEG_PATH, [
            '-i', sourceVideo,
            '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
            '-y', tempAudioToSeparate
          ], (err, stdout, stderr) => {
            if (err) reject(new Error('Lỗi FFmpeg trích xuất audio gốc: ' + stderr));
            else resolve();
          });
        });
        tempFiles.push(tempAudioToSeparate);

        // Ưu tiên GPU (venv Python + PyTorch CUDA), fallback CPU (audio-separator.exe)
        const appDataRoot = path.resolve(shared.DATA_TOOLS_DIR, '..');
        const pythonPath = path.join(appDataRoot, 'temp_env', 'Scripts', 'python.exe');
        const scriptPath = path.join(shared.DATA_TOOLS_DIR, 'separate_audio.py');
        const gpuAvailable = fs.existsSync(pythonPath) && fs.existsSync(scriptPath);

        const exePath = fs.existsSync(shared.AUDIO_SEPARATOR_CLI_PATH)
          ? shared.AUDIO_SEPARATOR_CLI_PATH
          : (fs.existsSync(path.join(shared.TOOLS_DIR, 'audio-separator.exe'))
            ? path.join(shared.TOOLS_DIR, 'audio-separator.exe') : null);

        if (gpuAvailable) {
          shared.updateStudioProgress(6, 'Đang dùng AI tách nhạc nền (GPU)...');
          const modelDir = path.join(shared.DATA_TOOLS_DIR, 'models');
          await shared.runExecFile(pythonPath, [
            scriptPath,
            tempAudioToSeparate,
            '--output_dir', workDir,
            '--model_dir', modelDir,
            '--stem', 'Instrumental'
          ]);
        } else if (exePath) {
          shared.updateStudioProgress(6, 'Đang dùng AI tách nhạc nền (CPU)...');
          await shared.runExecFile(exePath, [
            tempAudioToSeparate,
            '--output_dir', workDir,
            '--output_format', 'WAV',
            '--single_stem', 'Instrumental',
            '--model_file_dir', path.join(path.dirname(exePath), 'models')
          ]);
        } else {
          throw new Error('Không tìm thấy công cụ tách nhạc (GPU hoặc CPU)');
        }

        const separatedFiles = fs.readdirSync(workDir).filter(f => f.includes('(Instrumental)'));
        if (separatedFiles.length > 0) {
          extractedBgmPath = path.join(workDir, separatedFiles[0]);
          console.log('[Studio Render] Đã tách xong nhạc nền:', extractedBgmPath);
          tempFiles.push(extractedBgmPath);
        } else {
          console.warn('[Studio Render] Không tìm thấy file (Instrumental) đầu ra từ audio-separator.');
        }
      } catch (err) {
        console.error('[Studio Render] Lỗi tách nhạc nền bằng AI:', err.message);
      }
    }

    let reactionVideoPath = null;
    const reactionMode = body.reactionMode || 'none';
    if (reactionMode === 'upload' && files.reactionUpload?.[0]) {
      reactionVideoPath = shared.moveUploadedFile(files.reactionUpload[0], workDir, 'reaction.mp4');
      tempFiles.push(reactionVideoPath);
    } else if (reactionMode === 'library' && body.savedReactionFile) {
      reactionVideoPath = shared.resolveAssetPath('video', body.savedReactionFile);
    }

    let subtitlePath = null;
    let subtitleMode = body.subtitleMode || 'none';
    const voiceMode = body.voiceMode || 'none';
    const omiScriptText = (body.omiScript || '').trim();

    let isVoiceOnlySub = false;
    if (voiceMode === 'omi' && !omiScriptText && subtitleMode === 'none') {
      subtitleMode = 'generate';
      isVoiceOnlySub = true;
      console.log('[Studio Render] Tự động chuyển sang chế độ tạo phụ đề ngầm để phục vụ thuyết minh.');
    }

    if (subtitleMode === 'upload' && files.subtitleUpload?.[0]) {
      shared.updateStudioProgress(10, 'Đang chuẩn bị file phụ đề tải lên...');
      subtitlePath = shared.moveUploadedFile(files.subtitleUpload[0], shared.SUBTITLES_DIR, files.subtitleUpload[0].originalname);
    } else if (subtitleMode === 'saved') {
      shared.updateStudioProgress(10, 'Đang nạp file phụ đề đã chọn...');
      subtitlePath = shared.resolveAssetPath('subtitle', body.savedSubtitleFile);
    } else if (subtitleMode === 'generate') {
      shared.updateStudioProgress(12, 'Đang chuẩn bị tạo phụ đề tự động bằng AI (Whisper)...');
      const { extractAudioAndTranscribe } = require('../lib/whisper-helper');
      subtitlePath = await extractAudioAndTranscribe(sourceVideo, workDir, shared.FFMPEG_PATH, body.whisperModel || 'base');
    }

    let originalIsChinese = false;
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const originalSubContent = fs.readFileSync(subtitlePath, 'utf8');
      if (/[\u4e00-\u9fa5]/.test(originalSubContent)) {
        originalIsChinese = true;
        console.log('[Auto-Detect] Phát hiện video nguồn có phụ đề tiếng Trung.');
      }
    }

    const scaleFactor = 1.35;
    const studioFontSize = Math.round(Number(body.subtitleSize || 18) * scaleFactor);
    const studioMarginH = Number(body.subtitleMarginH || 20);
    const studioMarginL = (body.subtitleMarginL !== undefined && body.subtitleMarginL !== '') ? Number(body.subtitleMarginL) : studioMarginH;
    const studioMarginR = (body.subtitleMarginR !== undefined && body.subtitleMarginR !== '') ? Number(body.subtitleMarginR) : studioMarginH;
    const studioBoxWidth = videoWidth - studioMarginL - studioMarginR;
    const studioMaxChars = Math.max(10, Math.floor(studioBoxWidth / (studioFontSize * 0.5)));

    if (subtitlePath && body.translateVi === 'true') {
      const targetLang = body.translateTargetLang || 'vi';
      const langNames = { vi: 'Việt Nam', en: 'English', zh: 'Trung Quốc' };
      shared.updateStudioProgress(35, `Đang dịch phụ đề sang ${langNames[targetLang] || 'Tiếng Việt'} bằng AI...`);
      const translatedPath = path.join(workDir, `translated_${timestamp}.srt`);
      await translateSubtitles(subtitlePath, translatedPath, {
        aiProvider: body.aiProvider,
        geminiApiKey: body.geminiApiKey,
        geminiModel: body.geminiModel,
        openRouterApiKey: body.openRouterApiKey,
        openRouterModel: body.openRouterModel,
        ninerouterApiKey: body.ninerouterApiKey,
        ninerouterModel: body.ninerouterModel,
        ninerouterBaseUrl: body.ninerouterBaseUrl,
        targetLang
      }, Number(body.subtitleMaxLines || 0), studioMaxChars, () => shared.state.activeRenderId !== renderId);
      subtitlePath = translatedPath;
    } else if (subtitlePath && fs.existsSync(subtitlePath)) {
      shared.updateStudioProgress(35, 'Đang định dạng cấu trúc phụ đề...');
      try {
        formatSubtitleFile(subtitlePath, Number(body.subtitleMaxLines || 0), studioMaxChars);
      } catch (err) {
        console.error('Lỗi định dạng phụ đề ban đầu:', err.message);
      }
    }

    let voicePath = null;
    if (voiceMode === 'upload' && files.voiceUpload?.[0]) {
      shared.updateStudioProgress(38, 'Đang chuẩn bị file lồng tiếng tải lên...');
      voicePath = shared.moveUploadedFile(files.voiceUpload[0], workDir, files.voiceUpload[0].originalname);
      tempFiles.push(voicePath);
    } else if (voiceMode === 'saved') {
      shared.updateStudioProgress(38, 'Đang nạp giọng lồng tiếng đã chọn...');
      voicePath = shared.resolveAssetPath('voice', body.savedVoiceFile);
    } else if (voiceMode === 'omi') {
      shared.updateStudioProgress(40, 'Đang khởi động bộ nhân bản giọng nói AI (OmniVoice)...');
      const refAudioPath = shared.resolveAssetPath('voice', body.savedVoiceFile);
      let refText = (body.refText || '').trim();
      let omiScript = (body.omiScript || '').trim();

      if (!fs.existsSync(shared.OMNIVOICE_CLI_PATH)) {
        return res.status(400).json({ error: `Thiếu omnivoice-cli.exe tại ${shared.OMNIVOICE_CLI_PATH}` });
      }
      if (!fs.existsSync(shared.OMNIVOICE_MODEL_PATH)) {
        return res.status(400).json({ error: `Thiếu model GGUF tại ${shared.OMNIVOICE_MODEL_PATH}` });
      }

      let finalRefAudioPath = null;
      if (refAudioPath) {
        if (!refText && refAudioPath) {
          const txtPath = refAudioPath.replace(path.extname(refAudioPath), '.txt');
          if (fs.existsSync(txtPath)) {
            try {
              refText = fs.readFileSync(txtPath, 'utf8').trim();
              console.log('Đã tìm thấy kịch bản giọng mẫu có sẵn:', refText);
            } catch (txtErr) {
              console.error('Lỗi khi đọc file kịch bản có sẵn:', txtErr.message);
            }
          }
        }

        if (!refText) {
          try {
            shared.updateStudioProgress(42, 'Đang trích xuất câu thoại từ giọng mẫu (AI Whisper)...');
            const { transcribeVoice } = require('../lib/whisper-helper');
            console.log('Đang tự động nhận diện câu thoại trong giọng mẫu...');
            refText = await transcribeVoice(refAudioPath, workDir, shared.FFMPEG_PATH, body.whisperModel || 'base');
            console.log('Đã tự động trích xuất Ref-text:', refText);
          } catch (err) {
            console.error('Lỗi tự động nhận dạng giọng mẫu:', err.message);
            return res.status(400).json({ error: 'Không thể tự nhận diện giọng mẫu. Vui lòng nhập thủ công Ref-text.' });
          }
        }

        if (!refText) {
          return res.status(400).json({ error: 'Không thể tự động nhận diện giọng mẫu (file quá nhiễu hoặc không có tiếng nói rõ ràng). Vui lòng nhập thủ công Ref-text hoặc chọn giọng mẫu khác.' });
        }

        refText = refText.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

        finalRefAudioPath = refAudioPath;
        const refWavPath = path.join(workDir, `ref_voice_${timestamp}.wav`);
        try {
          shared.updateStudioProgress(45, 'Đang chuẩn bị giọng mẫu (FFmpeg)...');
          console.log('Đang chuyển đổi giọng mẫu sang định dạng WAV chuẩn 16kHz cho OmniVoice...');
          await new Promise((resolve, reject) => {
            shared.execFile(shared.FFMPEG_PATH, [
              '-i', refAudioPath,
              '-acodec', 'pcm_s16le',
              '-ar', '16000',
              '-ac', '1',
              '-y', refWavPath
            ], (err, stdout, stderr) => {
              if (err) reject(new Error('Lỗi FFmpeg: ' + stderr));
              else resolve();
            });
          });
          finalRefAudioPath = refWavPath;
          tempFiles.push(refWavPath);
        } catch (err) {
          console.error('Lỗi khi convert ref-audio sang WAV:', err.message);
          finalRefAudioPath = refAudioPath;
        }
      }

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        console.log('Bắt đầu đồng bộ giọng đọc OmniVoice theo từng câu phụ đề...');
        const Parser = require('srt-parser-2').default;
        const parser = new Parser();
        const srtContent = fs.readFileSync(subtitlePath, 'utf8');
        const srtArray = parser.fromSrt(srtContent).filter(item => item.text && item.text.trim());

        if (srtArray.length === 0) {
          return res.status(400).json({ error: 'File phụ đề rỗng hoặc không có nội dung chữ.' });
        }

        const groups = [];
        let currentGroup = [];

        for (let i = 0; i < srtArray.length; i++) {
          const item = srtArray[i];
          currentGroup.push(item);

          const currentEndMs = srtTimeToMs(item.endTime);
          const nextItem = srtArray[i + 1];

          let shouldSplit = false;
          if (!nextItem) {
            shouldSplit = true;
          } else {
            const nextStartMs = srtTimeToMs(nextItem.startTime);
            const gapMs = nextStartMs - currentEndMs;

            const endsWithPunctuation = /[.!?…]$/.test(item.text.trim());
            if (gapMs > 1000 || endsWithPunctuation) {
              shouldSplit = true;
            }

            // Tách group nếu tổng thời gian đã vượt quá 10s để tránh đọc quá sớm
            if (!shouldSplit) {
              const groupStartMs = srtTimeToMs(currentGroup[0].startTime);
              if (currentEndMs - groupStartMs > 10000) {
                shouldSplit = true;
              }
            }
          }

          if (shouldSplit) {
            groups.push(currentGroup);
            currentGroup = [];
          }
        }

        if (groups.length === 0) {
          return res.status(400).json({ error: 'Không thể phân nhóm phụ đề.' });
        }

        for (let idx = 0; idx < groups.length; idx++) {
          if (!shared.state.isStudioRendering || task.status === 'failed' || (task.step && task.step.includes('hủy'))) {
            console.log(`[Studio Render] Phát hiện đã hủy, dừng loop OmniVoice tại câu ${idx + 1}/${groups.length}`);
            throw new Error('Đã hủy kết xuất bởi người dùng');
          }
          const group = groups[idx];
          const lineText = group.map(item => item.text.replace(/\n/g, ' ').trim()).join(' ').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          if (!lineText) continue;

          const progressPercent = 48 + Math.floor((idx / groups.length) * 30);
          shared.updateStudioProgress(progressPercent, `AI Cloner: Đang đọc câu thoại ${idx + 1}/${groups.length}...`);

          const chunkPath = path.join(workDir, `chunk_${idx}_${timestamp}.wav`);

          const startMs = srtTimeToMs(group[0].startTime);
          const endMs = srtTimeToMs(group[group.length - 1].endTime);
          const durationSec = Math.max(0.5, (endMs - startMs) / 1000);

          const syllableCount = lineText.split(/\s+/).filter(w => w.length > 0).length;
          const naturalDuration = Math.max(0.6, syllableCount * 0.17);

          const minSpeed = originalIsChinese ? 0.85 : 1.0;
          const speed = Math.max(minSpeed, Math.min(2.0, naturalDuration / durationSec));
          const targetDuration = naturalDuration / speed;

          const usedDevice = body.omiDevice || process.env.OMNIVOICE_DEVICE || 'cpu';

          const omnivoiceArgs = [
            '--model', shared.OMNIVOICE_MODEL_PATH,
            '--text', lineText,
            '--output', chunkPath,
            '--response-format', 'wav',
            '--language', ['vi', 'en', 'zh'].includes(body.omiLanguage) ? body.omiLanguage : 'vi',
            '--device', usedDevice,
          '--num-step', body.omiSteps || process.env.OMNIVOICE_STEPS || '16',
            '--seed', (body.omiSeed && body.omiSeed.trim() !== '') ? body.omiSeed : String(Math.floor(Math.random() * 9999999)),
            '--speed', String(speed.toFixed(2)),
            '--position-temperature', '1.0'
          ];

          if (finalRefAudioPath && refText) {
            omnivoiceArgs.push('--ref-audio', finalRefAudioPath);
            omnivoiceArgs.push('--ref-text', refText);
          } else {
            omnivoiceArgs.push('--instruct', 'female');
            omnivoiceArgs.push('--duration', String(targetDuration.toFixed(2)));
          }

          console.log(`[OmniVoice-Sub] Đang đọc nhóm câu ${idx + 1}/${groups.length}: "${lineText}" (Tốc độ: ${speed.toFixed(2)}x, Thời lượng: ${targetDuration.toFixed(2)}s, Bắt đầu: ${(startMs / 1000).toFixed(2)}s, Device: ${usedDevice})`);
          try {
            await shared.runOmnivoiceCLI(omnivoiceArgs, { cwd: path.dirname(shared.OMNIVOICE_CLI_PATH) }, body.omiDevice || 'cpu');
            if (fs.existsSync(chunkPath)) {
              try {
                const wavInfo = readWavInfo(chunkPath);
                const dataSize = wavInfo.dataSize;
                let actualDurationMs = Math.round(dataSize / wavInfo.bytesPerMs);

                const subtitleDurationMs = endMs - startMs;
                const maxAllowedDurationMs = Math.max(200, subtitleDurationMs - 50);

                if (actualDurationMs > maxAllowedDurationMs) {
                  const speedUpRatio = actualDurationMs / maxAllowedDurationMs;
                  console.log(`[OmniVoice-Sub] Nhóm câu ${idx + 1} dài hơn phụ đề (${actualDurationMs}ms > ${maxAllowedDurationMs}ms). Đang dùng FFmpeg để tăng tốc ${speedUpRatio.toFixed(2)}x...`);

                  const tempSpeedUpPath = chunkPath.replace('.wav', '_speedup.wav');
                  let remainingRatio = speedUpRatio;
                  const filterParts = [];
                  while (remainingRatio > 2.0) {
                    filterParts.push('atempo=2.0');
                    remainingRatio /= 2.0;
                  }
                  if (remainingRatio > 0.5) {
                    filterParts.push(`atempo=${remainingRatio.toFixed(3)}`);
                  }
                  const atempoFilter = filterParts.join(',');

                  const ffmpegSpeedArgs = [
                    '-i', chunkPath,
                    '-filter:a', atempoFilter,
                    '-y', tempSpeedUpPath
                  ];

                  await shared.runExecFile(shared.FFMPEG_PATH, ffmpegSpeedArgs);
                  if (fs.existsSync(tempSpeedUpPath)) {
                    fs.copyFileSync(tempSpeedUpPath, chunkPath);
                    fs.unlinkSync(tempSpeedUpPath);
                    console.log(`[OmniVoice-Sub] Đã tăng tốc nhóm câu ${idx + 1} thành công.`);
                  }
                }
              } catch (speedUpErr) {
                console.error(`[OmniVoice-Sub] Lỗi khi xử lý tăng tốc nhóm câu ${idx + 1}:`, speedUpErr.message);
                throw speedUpErr;
              }

              voiceChunks.push({
                filePath: chunkPath,
                startMs: startMs
              });
              tempFiles.push(chunkPath);
            } else {
              throw new Error(`Không tìm thấy file âm thanh thuyết minh đầu ra của nhóm câu ${idx + 1} sau khi chạy OmniVoice.`);
            }
          } catch (err) {
            console.error(`Lỗi khi thuyết minh nhóm câu ${idx + 1}/${groups.length}:`, err.stderr || err.message);
            throw err;
          }
        }

        if (voiceChunks.length === 0) {
          return res.status(400).json({ error: 'Không thể tạo được bất kỳ file âm thanh nào cho các câu phụ đề.' });
        }

        voiceChunks.sort((a, b) => a.startMs - b.startMs);

        try {
          shared.updateStudioProgress(78, 'Đang gộp các đoạn giọng nói...');
          console.log('[OmniVoice] Đang gộp các chunk giọng nói thành một file duy nhất...');
          let maxEndMs = 0;
          const chunkDataList = [];
          let combinedSampleRate = 24000;

          for (let ci = 0; ci < voiceChunks.length; ci++) {
            const chunk = voiceChunks[ci];
            const wavInfo = readWavInfo(chunk.filePath);
            const { sampleRate, bytesPerMs, dataSize, actualDataOffset } = wavInfo;
            combinedSampleRate = sampleRate;
            const durationMs = Math.round(dataSize / bytesPerMs);
            const endMs = chunk.startMs + durationMs;
            if (endMs > maxEndMs) {
              maxEndMs = endMs;
            }

            const fd = fs.openSync(chunk.filePath, 'r');
            const pcmBuffer = Buffer.alloc(dataSize);
            fs.readSync(fd, pcmBuffer, 0, dataSize, actualDataOffset);
            fs.closeSync(fd);

            // Fade-in và fade-out tất cả chunk để tránh tiếng "tách" giữa các câu
            const totalSamples = dataSize / 2;
            const fadeSamples = Math.min(360, Math.floor(totalSamples / 2));
            for (let sampleIdx = 0; sampleIdx < totalSamples; sampleIdx++) {
              const byteOffset = sampleIdx * 2;
              let val = pcmBuffer.readInt16LE(byteOffset);
              if (sampleIdx < fadeSamples) {
                val = Math.round(val * (sampleIdx / fadeSamples));
              } else if (sampleIdx >= totalSamples - fadeSamples) {
                const distFromEnd = totalSamples - 1 - sampleIdx;
                val = Math.round(val * (distFromEnd / fadeSamples));
              }
              pcmBuffer.writeInt16LE(val, byteOffset);
            }

            chunkDataList.push({
              startMs: chunk.startMs,
              pcmBuffer: pcmBuffer,
              durationMs: durationMs,
              bytesPerMs: bytesPerMs
            });
          }

          if (maxEndMs > 0) {
            const bytesPerMs = chunkDataList[0].bytesPerMs;
            const maxSafeMs = Math.min(maxEndMs, 7200000);
            const combinedDataSize = Math.round(maxSafeMs * bytesPerMs);
            let combinedBuffer;
            try {
              combinedBuffer = Buffer.alloc(combinedDataSize);
            } catch (e) {
              throw new Error(`Không thể cấp phát bộ nhớ cho WAV gộp (${(combinedDataSize / 1024 / 1024).toFixed(0)}MB): ${e.message}`);
            }

            for (const chunk of chunkDataList) {
              const targetOffset = Math.round(chunk.startMs * chunk.bytesPerMs);
              const pcmLength = chunk.pcmBuffer.length;
              const limit = Math.min(pcmLength, combinedDataSize - targetOffset);

              for (let i = 0; i < limit; i += 2) {
                if (targetOffset + i + 1 >= combinedDataSize) break;

                const sample1 = combinedBuffer.readInt16LE(targetOffset + i);
                const sample2 = chunk.pcmBuffer.readInt16LE(i);

                let mixed = sample1 + sample2;
                if (mixed > 32767) mixed = 32767;
                else if (mixed < -32768) mixed = -32768;

                combinedBuffer.writeInt16LE(mixed, targetOffset + i);
              }
            }

            const wavHeader = createWavHeader(combinedDataSize, combinedSampleRate, 1, 16);
            voicePath = path.join(workDir, `combined_voice_${timestamp}.wav`);
            fs.writeFileSync(voicePath, Buffer.concat([wavHeader, combinedBuffer]));
            tempFiles.push(voicePath);

            console.log(`[OmniVoice] Đã gộp thành công ${voiceChunks.length} chunk thành file đơn: ${voicePath} (Thời lượng: ${(maxEndMs / 1000).toFixed(2)}s, Sample Rate: ${combinedSampleRate}Hz)`);
            voiceChunks.length = 0;
          }
        } catch (mergeErr) {
          console.error('[OmniVoice] Lỗi khi gộp các file chunk âm thanh:', mergeErr.message);
          console.warn('[OmniVoice] Dùng các chunk riêng lẻ (adelay) với cảnh báo: chất lượng ghép nối có thể không mượt.');
          // Không throw — để render tiếp với individual chunks (voiceChunks chưa bị clear)
        }
      } else {
        if (!omiScript && subtitlePath && fs.existsSync(subtitlePath)) {
          try {
            const Parser = require('srt-parser-2').default;
            const parser = new Parser();
            const srtContent = fs.readFileSync(subtitlePath, 'utf8');
            const srtArray = parser.fromSrt(srtContent);
            omiScript = srtArray.map(item => item.text.replace(/\n/g, ' ')).join(' ');
            console.log('Tự động lấy kịch bản từ phụ đề tiếng Việt (fallback):', omiScript);
          } catch (e) {
            console.error('Lỗi phân tích phụ đề làm kịch bản:', e.message);
          }
        }

        if (!omiScript) {
          return res.status(400).json({ error: 'Vui lòng nhập kịch bản hoặc bật chế độ phụ đề để OmniVoice tự đọc.' });
        }

        omiScript = omiScript.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        voicePath = path.join(workDir, `omnivoice_${timestamp}.wav`);
        const usedDevice = body.omiDevice || process.env.OMNIVOICE_DEVICE || 'cpu';
        const omnivoiceArgs = [
          '--model', shared.OMNIVOICE_MODEL_PATH,
          '--text', omiScript,
          '--output', voicePath,
          '--response-format', 'wav',
          '--language', ['vi', 'en', 'zh'].includes(body.omiLanguage) ? body.omiLanguage : 'vi',
          '--device', usedDevice,
          '--num-step', body.omiSteps || process.env.OMNIVOICE_STEPS || '40',
          '--seed', (body.omiSeed && body.omiSeed.trim() !== '') ? body.omiSeed : String(Math.floor(Math.random() * 9999999)),
          '--position-temperature', '1.5'
        ];

        if (finalRefAudioPath && refText) {
          omnivoiceArgs.push('--ref-audio', finalRefAudioPath);
          omnivoiceArgs.push('--ref-text', refText);
        } else {
          omnivoiceArgs.push('--instruct', 'female');
          const estDuration = Math.max(1.5, omiScript.length * 0.075);
          omnivoiceArgs.push('--duration', String(estDuration.toFixed(1)));
        }

        console.log('\n======================================================================');
        console.log(`[OmniVoice] Kịch bản đang đọc (${body.omiLanguage || 'vi'}, Device: ${usedDevice}):\n${omiScript}`);
        console.log('======================================================================\n');

        const scriptOutName = `studio_${timestamp}.txt`;
        fs.writeFileSync(path.join(shared.RENDERS_DIR, scriptOutName), omiScript, 'utf8');
        console.log(`[OmniVoice] Đã xuất kịch bản thành file văn bản: ${path.join(shared.RENDERS_DIR, scriptOutName)}`);

        shared.updateStudioProgress(55, 'AI Cloner: Đang đọc toàn bộ kịch bản...');
        await shared.runOmnivoiceCLI(omnivoiceArgs, { cwd: path.dirname(shared.OMNIVOICE_CLI_PATH) }, body.omiDevice || 'cpu');
        tempFiles.push(voicePath);
      }
    }

    shared.updateStudioProgress(80, 'Đang chuẩn bị các track nhạc nền và lồng tiếng...');
    let musicPath = null;
    const musicMode = body.musicMode || 'none';
    if (extractedBgmPath) {
      musicPath = extractedBgmPath;
    } else if (musicMode === 'upload' && files.musicUpload?.[0]) {
      musicPath = shared.moveUploadedFile(files.musicUpload[0], shared.MUSIC_DIR, files.musicUpload[0].originalname);
    } else if (musicMode === 'saved') {
      musicPath = shared.resolveAssetPath('music', body.savedMusicFile);
    }

    const hasCUDA = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\nvcuda.dll');
    const outName = `studio_${timestamp}.mp4`;
    const outPath = path.join(shared.RENDERS_DIR, outName);
    const args = ['-i', sourceVideo];
    const audioInputs = [];

    const voiceVolume = Math.max(0, Number(body.voiceVolume !== undefined ? body.voiceVolume : 1.0));

    if (voiceChunks && voiceChunks.length > 0) {
      voiceChunks.forEach(chunk => {
        args.push('-i', chunk.filePath);
        audioInputs.push({
          index: args.filter(v => v === '-i').length - 1,
          volume: voiceVolume,
          type: 'chunk',
          startMs: chunk.startMs
        });
      });
    } else if (voicePath) {
      args.push('-i', voicePath);
      audioInputs.push({
        index: args.filter(v => v === '-i').length - 1,
        volume: voiceVolume,
        type: 'single'
      });
    }

    if (musicPath) {
      args.push('-stream_loop', '-1', '-i', musicPath);
      const bgmVolume = Math.max(0, Number(body.musicVolume || 0.18));
      audioInputs.push({
        index: args.filter(v => v === '-i').length - 1,
        volume: bgmVolume,
        type: 'music'
      });
    }

    let reactionInputIndex = -1;
    if (reactionVideoPath) {
      args.push('-stream_loop', '-1', '-i', reactionVideoPath);
      reactionInputIndex = args.filter(v => v === '-i').length - 1;
      if (body.reactionAudio === 'true') {
        audioInputs.push({
          index: reactionInputIndex,
          volume: 1.0,
          type: 'reaction'
        });
      }
    }

    let renderSubtitlePath = null;
    let videoFilter = null;
    let hasVideoFilter = false;

    if (subtitlePath && body.burnSub === 'true' && !isVoiceOnlySub) {
      const scaleFactor = 1.35;
      const fontSize = Math.round(Number(body.subtitleSize || 18) * scaleFactor);
      const marginV = Number(body.subtitleMargin || 28);
      const marginH = Number(body.subtitleMarginH || 20);
      // Đọc marginL và marginR riêng biệt, fallback về marginH đối xứng
      const marginL = (body.subtitleMarginL !== undefined && body.subtitleMarginL !== '') ? Number(body.subtitleMarginL) : marginH;
      const marginR = (body.subtitleMarginR !== undefined && body.subtitleMarginR !== '') ? Number(body.subtitleMarginR) : marginH;
      const boxWidth = videoWidth - marginL - marginR;
      const maxChars = Math.max(10, Math.floor(boxWidth / (fontSize * 0.5)));

      try {
        formatSubtitleFile(subtitlePath, Number(body.subtitleMaxLines || 0), maxChars);
      } catch (err) {
        console.error('Lỗi định dạng phụ đề 1-2 dòng:', err.message);
      }

      const ssaToAssAlignment = {
        1: 1, 2: 2, 3: 3, 9: 4, 10: 5, 11: 6, 5: 7, 6: 8, 7: 9
      };
      const alignment = ssaToAssAlignment[Number(body.subtitleAlignment || 2)] || 2;
      const fontName = body.subtitleFont || 'Arial';
      const isBold = body.subtitleBold !== 'false';
      const assColor = hexToAssColor(body.subtitleColor || '#FFFFFF');
      const theme = body.subtitleTheme || 'outline';

      let borderStyle = 1;
      let outline = 2.5 * scaleFactor;
      let shadow = 1 * scaleFactor;
      let outlineColor = '&H00000000';
      let backColor = '&H80000000';
      let finalAssColor = assColor;

      if (theme === 'box') {
        borderStyle = 3;
        backColor = '&H66000000';
        outlineColor = '&H66000000';
        outline = 4.0 * scaleFactor;
        shadow = 0;
      } else if (theme === 'box-deep') {
        borderStyle = 3;
        backColor = '&H0D000000';
        outlineColor = '&H0D000000';
        outline = 4.0 * scaleFactor;
        shadow = 0;
      } else if (theme === 'shadow') {
        borderStyle = 1;
        outline = 0;
        shadow = 2 * scaleFactor;
        backColor = '&H90000000';
      } else if (theme === 'outline-thick') {
        borderStyle = 1;
        outline = 5.0 * scaleFactor;
        shadow = 0;
        outlineColor = '&H00000000';
      } else if (theme === 'outline-shadow') {
        borderStyle = 1;
        outline = 2.5 * scaleFactor;
        shadow = 3 * scaleFactor;
        outlineColor = '&H00000000';
        backColor = '&H90000000';
      } else if (theme === 'neon-glow') {
        borderStyle = 1;
        outline = 2.0 * scaleFactor;
        shadow = 0;
        outlineColor = assColor;
        finalAssColor = '&H00FFFFFF';
      } else if (theme === 'three-d') {
        borderStyle = 1;
        outline = 1.0 * scaleFactor;
        shadow = 3.0 * scaleFactor;
        outlineColor = '&H00000000';
        backColor = '&H00000000';
      }

      const assPath = path.join(workDir, `render_subtitles_${timestamp}.ass`);
      try {
        convertSrtToAss(subtitlePath, assPath, {
          videoWidth, videoHeight, fontName, fontSize,
          assColor: finalAssColor, isBold, borderStyle, outline, shadow,
          outlineColor, backColor, alignment, marginV, marginL, marginR, theme
        });
        renderSubtitlePath = assPath;
      } catch (err) {
        console.error('Lỗi chuyển đổi SRT sang ASS:', err.message);
        renderSubtitlePath = subtitlePath;
      }
    }

    let baseVideoLabel = '0:v';
    let blurFilterString = '';
    const hasReaction = !!reactionVideoPath;
    const hasSubtitles = !!renderSubtitlePath;

    if (body.blurOriginalSub === 'true') {
      hasVideoFilter = true;
      baseVideoLabel = (hasReaction || hasSubtitles) ? 'v_base' : 'vout';
      let blurBoxes = [];
      if (body.blurBoxes) {
        try {
          blurBoxes = JSON.parse(body.blurBoxes);
        } catch (e) {
          console.error('Lỗi parse blurBoxes JSON:', e.message);
        }
      }

      if (!Array.isArray(blurBoxes) || blurBoxes.length === 0) {
        const blurXPercentVal = Math.min(100, Math.max(0, Number(body.blurX !== undefined ? body.blurX : 10))) / 100;
        const blurWidthPercentVal = Math.min(100, Math.max(1, Number(body.blurWidth !== undefined ? body.blurWidth : 80))) / 100;
        const blurYPercentVal = Math.min(100, Math.max(0, Number(body.blurY !== undefined ? body.blurY : 75))) / 100;
        const blurHeightPercentVal = Math.min(100, Math.max(1, Number(body.blurHeight !== undefined ? body.blurHeight : 15))) / 100;
        const blurRadius = Math.min(50, Math.max(1, Number(body.blurRadius || 20)));

        let blurXPercent = blurXPercentVal;
        if (blurXPercent + blurWidthPercentVal > 1) blurXPercent = 1 - blurWidthPercentVal;
        let blurYPercent = blurYPercentVal;
        if (blurYPercent + blurHeightPercentVal > 1) blurYPercent = 1 - blurHeightPercentVal;

        const rawCropW = videoWidth * blurWidthPercentVal;
        const rawCropH = videoHeight * blurHeightPercentVal;
        const rawCropX = videoWidth * blurXPercent;
        const rawCropY = videoHeight * blurYPercent;

        const evenCropW = Math.max(2, Math.floor(rawCropW / 2) * 2);
        const evenCropH = Math.max(2, Math.floor(rawCropH / 2) * 2);
        const evenCropX = Math.max(0, Math.floor(rawCropX / 2) * 2);
        const evenCropY = Math.max(0, Math.floor(rawCropY / 2) * 2);

        const maxLumaR = Math.max(1, Math.floor(Math.min(evenCropW, evenCropH) / 2) - 1);
        const maxChromaR = Math.max(1, Math.floor(Math.min(evenCropW / 2, evenCropH / 2) / 2) - 1);
        const safeLumaRadius = Math.min(blurRadius, maxLumaR);
        const safeChromaRadius = Math.min(blurRadius, maxChromaR);

        blurFilterString = `[0:v]split[orig][copy];[copy]crop=${evenCropW}:${evenCropH}:${evenCropX}:${evenCropY},boxblur=lr=${safeLumaRadius}:cr=${safeChromaRadius},format=yuv420p[blurred];[orig][blurred]overlay=${evenCropX}:${evenCropY}[${baseVideoLabel}]`;
      } else {
        let currentInputLabel = '0:v';
        const filters = [];

        blurBoxes.forEach((box, index) => {
          const isLast = index === blurBoxes.length - 1;
          const outputLabel = isLast ? baseVideoLabel : `v_blur_${index}`;
          const xPercent = Math.min(100, Math.max(0, Number(box.x !== undefined ? box.x : 10))) / 100;
          const widthPercent = Math.min(100, Math.max(1, Number(box.width !== undefined ? box.width : 80))) / 100;
          const yPercent = Math.min(100, Math.max(0, Number(box.y !== undefined ? box.y : 75))) / 100;
          const heightPercent = Math.min(100, Math.max(1, Number(box.height !== undefined ? box.height : 15))) / 100;
          const radius = Math.min(50, Math.max(1, Number(box.radius || 20)));

          let clampedX = xPercent;
          if (clampedX + widthPercent > 1) clampedX = 1 - widthPercent;
          let clampedY = yPercent;
          if (clampedY + heightPercent > 1) clampedY = 1 - heightPercent;

          const rawCropW = videoWidth * widthPercent;
          const rawCropH = videoHeight * heightPercent;
          const rawCropX = videoWidth * clampedX;
          const rawCropY = videoHeight * clampedY;

          const evenCropW = Math.max(2, Math.floor(rawCropW / 2) * 2);
          const evenCropH = Math.max(2, Math.floor(rawCropH / 2) * 2);
          const evenCropX = Math.max(0, Math.floor(rawCropX / 2) * 2);
          const evenCropY = Math.max(0, Math.floor(rawCropY / 2) * 2);

          const maxLumaR = Math.max(1, Math.floor(Math.min(evenCropW, evenCropH) / 2) - 1);
          const maxChromaR = Math.max(1, Math.floor(Math.min(evenCropW / 2, evenCropH / 2) / 2) - 1);
          const safeLumaRadius = Math.min(radius, maxLumaR);
          const safeChromaRadius = Math.min(radius, maxChromaR);

          const start = Number(box.start !== undefined ? box.start : 0);
          const end = Number(box.end !== undefined ? box.end : 99999);

          const origLabel = `orig_${index}`;
          const copyLabel = `copy_${index}`;
          const blurredLabel = `blurred_${index}`;

          filters.push(`[${currentInputLabel}]split[${origLabel}][${copyLabel}]`);
          filters.push(`[${copyLabel}]crop=${evenCropW}:${evenCropH}:${evenCropX}:${evenCropY},boxblur=lr=${safeLumaRadius}:cr=${safeChromaRadius},format=yuv420p[${blurredLabel}]`);
          filters.push(`[${origLabel}][${blurredLabel}]overlay=${evenCropX}:${evenCropY}:enable='between(t,${start},${end})'[${outputLabel}]`);
          currentInputLabel = outputLabel;
        });
        blurFilterString = filters.join(';');
      }
    }

    if (reactionVideoPath) {
      hasVideoFilter = true;
      const rx = body.reactionX !== undefined && body.reactionX !== '' ? Number(body.reactionX) : null;
      const ry = body.reactionY !== undefined && body.reactionY !== '' ? Number(body.reactionY) : null;

      let overlayPos = 'main_w-overlay_w-20:main_h-overlay_h-20';
      if (rx !== null && ry !== null) {
        overlayPos = `${rx}:${ry}`;
      } else {
        const position = body.reactionPosition || 'bottom-right';
        if (position === 'bottom-left') overlayPos = '20:main_h-overlay_h-20';
        if (position === 'top-right') overlayPos = 'main_w-overlay_w-20:20';
        if (position === 'top-left') overlayPos = '20:20';
      }

      const width = Number(body.reactionWidth || 320);
      let filterChain = '';
      if (blurFilterString) {
        filterChain += blurFilterString + ';';
      }
      filterChain += `[${reactionInputIndex}:v]scale=${width}:-1[pip];[${baseVideoLabel}][pip]overlay=${overlayPos}`;

      if (renderSubtitlePath) {
        filterChain += `[v_pip];[v_pip]subtitles='${escapeSubtitleForFilter(renderSubtitlePath)}'[vout]`;
      } else {
        filterChain += `[vout]`;
      }
      videoFilter = filterChain;
    } else if (renderSubtitlePath) {
      hasVideoFilter = true;
      let filterChain = '';
      if (blurFilterString) {
        filterChain += blurFilterString + ';';
      }
      filterChain += `[${baseVideoLabel}]subtitles='${escapeSubtitleForFilter(renderSubtitlePath)}'[vout]`;
      videoFilter = filterChain;
    } else if (body.blurOriginalSub === 'true') {
      videoFilter = blurFilterString;
    }

    const filterComplex = [];
    if (hasVideoFilter && videoFilter) {
      filterComplex.push(videoFilter);
    }

    let hasAudioFilter = false;
    let originalVolume = Math.max(0, Number(body.originalVolume !== undefined ? body.originalVolume : 1.0));
    if ((body.keepOriginalBgmAI === true || body.keepOriginalBgmAI === 'true') && extractedBgmPath) {
      originalVolume = 0;
    }
    if (audioInputs.length > 0) {
      hasAudioFilter = true;
      const audioFilters = [`[0:a]volume=${originalVolume}[a0]`];
      const mixLabels = ['[a0]'];
      audioInputs.forEach((input, idx) => {
        const label = `a${idx + 1}`;
        const targetVolume = input.volume;
        if (input.type === 'chunk') {
          if (input.startMs > 0) {
            audioFilters.push(`[${input.index}:a]adelay=${input.startMs}:all=1,volume=${targetVolume}[${label}]`);
          } else {
            audioFilters.push(`[${input.index}:a]volume=${targetVolume}[${label}]`);
          }
        } else {
          audioFilters.push(`[${input.index}:a]volume=${targetVolume}[${label}]`);
        }
        mixLabels.push(`[${label}]`);
      });
      audioFilters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,dynaudnorm=p=0.95:m=1[aout]`);
      filterComplex.push(audioFilters.join(';'));
    } else if (body.originalVolume !== undefined && originalVolume !== 1.0) {
      hasAudioFilter = true;
      filterComplex.push(`[0:a]volume=${originalVolume}[aout]`);
    }

    if (filterComplex.length > 0) {
      args.push('-filter_complex', filterComplex.join(';'));
    }

    if (hasVideoFilter) {
      args.push('-map', '[vout]');
    } else {
      args.push('-map', '0:v');
    }

    if (hasAudioFilter) {
      args.push('-map', '[aout]', '-c:a', 'aac');
    } else {
      args.push('-map', '0:a?', '-c:a', 'aac');
    }

    const encoderArgs = hasCUDA
      ? ['-c:v', 'h264_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '23']
      : ['-c:v', 'libx264', '-preset', 'veryfast'];
    args.push(...encoderArgs, '-movflags', '+faststart', '-shortest', '-y', outPath);
    shared.updateStudioProgress(83, 'Bắt đầu render video thành phẩm (FFmpeg)...');
    console.log('[FFmpeg Command Arguments]:', JSON.stringify(args));
    try {
      await runFFmpegWithProgress(args, totalDuration);
    } catch (ffErr) {
      const stderrMsg = (ffErr.stderr || ffErr.message || '').toLowerCase();
      if (hasCUDA && stderrMsg.includes('nvenc')) {
        console.log('[FFmpeg] NVENC không khả dụng, fallback sang libx264...');
        const fallbackArgs = args.map(a => a);
        // Thay h264_nvenc → libx264
        const nvencIdx = fallbackArgs.indexOf('h264_nvenc');
        if (nvencIdx !== -1) {
          fallbackArgs[nvencIdx] = 'libx264';
          // Xóa các tùy chọn NVENC cụ thể (-rc vbr -cq N) nếu tìm thấy
          const nvencEncoderArgs = ['-rc', 'vbr', '-cq', '23', '-cq', '23']; // mẫu cần xóa
          for (let ii = nvencIdx + 1; ii < fallbackArgs.length - 1; ii++) {
            if (fallbackArgs[ii] === '-rc' && fallbackArgs[ii + 1] === 'vbr') {
              fallbackArgs.splice(ii, 2);
              break;
            }
          }
          for (let ii = nvencIdx + 1; ii < fallbackArgs.length - 1; ii++) {
            if (fallbackArgs[ii] === '-cq') {
              fallbackArgs.splice(ii, 2);
              break;
            }
          }
          // Thay preset p7 → veryfast
          const p7Idx = fallbackArgs.indexOf('p7');
          if (p7Idx !== -1) fallbackArgs[p7Idx] = 'veryfast';
          await runFFmpegWithProgress(fallbackArgs, totalDuration);
        } else {
          throw ffErr;
        }
      } else {
        throw ffErr;
      }
    }

    if (subtitlePath && fs.existsSync(subtitlePath)) {
      try {
        shared.updateStudioProgress(98, 'Đang xuất các file phụ đề bổ sung...');
        const outSrtName = `studio_${timestamp}.srt`;
        fs.copyFileSync(subtitlePath, path.join(shared.RENDERS_DIR, outSrtName));
        fs.copyFileSync(subtitlePath, path.join(shared.SUBTITLES_DIR, outSrtName));
        console.log(`[Studio Render] Đã xuất file phụ đề bổ sung: ${outSrtName}`);
      } catch (srtCopyErr) {
        console.error('Lỗi khi sao chép file phụ đề kết quả:', srtCopyErr.message);
      }
    }

    if (shared.state.activeRenderId === renderId) {
      shared.updateStudioProgress(100, 'Hoàn tất render!');
      shared.state.isStudioRendering = false;
      res.json({
        success: true,
        message: 'Đã render video',
        file: outName,
        url: `/renders/${encodeURIComponent(outName)}`
      });
    } else {
      console.log(`[Studio Render] Phiên render cũ (${renderId}) đã hoàn thành nhưng đã bị thay thế hoặc hủy trước đó.`);
    }
  } catch (error) {
    console.error('Render studio error:', error.stderr || error.message, error.code ? `(code: ${error.code})` : '');
    shared.state.isStudioRendering = false;
    shared.state.activeRenderId = null;
    if (shared.state.currentActiveTask === task) {
      shared.state.currentActiveTask = null;
    }
    if (task.status === 'failed' || task.step?.includes('hủy') || task.error?.includes('hủy') || task.error?.includes('cancel') || (error.message && error.message.includes('hủy'))) {
      console.log(`[Queue] Tác vụ ${task.id} đã bị hủy, reset state.`);
      task.status = 'failed';
      task.step = 'Đã bị hủy';
      shared.state.studioProgress = { status: 'idle', percent: 0, step: 'Đã hủy kết xuất', error: null };
      return;
    }
    task.status = 'error';
    task.error = error.message;
    task.step = 'Lỗi kết xuất';
    shared.state.studioProgress = {
      status: 'error',
      percent: task.percent,
      step: 'Lỗi kết xuất: ' + error.message,
      error: error.message
    };
  } finally {
    // Dọn dẹp tempFiles
    try {
      if (workDir && fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
        console.log(`[Studio Render] Đã dọn thư mục tạm: ${workDir}`);
      }
    } catch (cleanErr) {
      console.error('[Studio Render] Lỗi dọn dẹp temp:', cleanErr.message);
    }
  }
}

let _processingNext = false;
async function processNextRenderTask() {
  if (_processingNext || shared.state.currentActiveTask) {
    console.log('[Queue] Đang chạy một tác vụ kết xuất khác...');
    return;
  }
  _processingNext = true;
  const nextTask = shared.state.renderQueue.find(t => t.status === 'pending');
  if (!nextTask) {
    console.log('[Queue] Hàng đợi trống. Không có tác vụ nào chờ xử lý.');
    _processingNext = false;
    return;
  }
  shared.state.currentActiveTask = nextTask;
  console.log(`[Queue] Bắt đầu thực thi tác vụ kết xuất: ${nextTask.id}`);
  try {
    await executeRenderTask(nextTask);
  } catch (err) {
    console.error(`[Queue] Lỗi nghiêm trọng khi thực thi tác vụ ${nextTask.id}:`, err.message);
    nextTask.status = 'error';
    nextTask.error = err.message;
    nextTask.step = 'Lỗi hệ thống';
  } finally {
    shared.state.currentActiveTask = null;
    _processingNext = false;
    setTimeout(() => {
      processNextRenderTask();
    }, 1500);
  }
}

module.exports = {
  getProjects: async (req, res) => {
    try {
      if (!fs.existsSync(shared.PROJECTS_DIR)) {
        return res.json({ projects: [] });
      }
      const files = fs.readdirSync(shared.PROJECTS_DIR).filter(f => f.endsWith('.json'));
      const projects = files.map(file => {
        try {
          const content = fs.readFileSync(path.join(shared.PROJECTS_DIR, file), 'utf8');
          const proj = JSON.parse(content);
          return {
            id: proj.id,
            name: proj.name,
            updatedAt: proj.updatedAt || new Date().toISOString(),
            videoTitle: proj.videoTitle || '',
            sourceVideoPath: proj.sourceVideoPath || '',
            thumbnail: proj.thumbnail || ''
          };
        } catch (err) {
          console.error(`Lỗi đọc file dự án ${file}:`, err.message);
          return null;
        }
      }).filter(Boolean);

      projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.json({ projects });
    } catch (error) {
      console.error('Lỗi khi lấy danh sách dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  getProjectById: async (req, res) => {
    try {
      const { id } = req.params;
      const file = path.join(shared.PROJECTS_DIR, `${id}.json`);
      if (!fs.existsSync(file)) {
        return res.status(404).json({ error: 'Không tìm thấy dự án' });
      }
      const content = fs.readFileSync(file, 'utf8');
      const proj = JSON.parse(content);
      res.json(proj);
    } catch (error) {
      console.error('Lỗi khi đọc chi tiết dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  saveProject: async (req, res) => {
    try {
      let { id, name, data } = req.body;
      if (!id) {
        id = `proj_${Date.now()}`;
      }
      if (!name) {
        name = `Dự án_${new Date().toLocaleString('vi-VN')}`;
      }
      const file = path.join(shared.PROJECTS_DIR, `${id}.json`);
      const projectObj = {
        ...data, id, name, updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(file, JSON.stringify(projectObj, null, 2), 'utf8');
      res.json({ success: true, project: projectObj });
    } catch (error) {
      console.error('Lỗi khi lưu dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  deleteProject: async (req, res) => {
    try {
      const { id } = req.params;
      const file = path.join(shared.PROJECTS_DIR, `${id}.json`);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Lỗi khi xóa dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  duplicateProject: async (req, res) => {
    try {
      const { id } = req.params;
      const srcFile = path.join(shared.PROJECTS_DIR, `${id}.json`);
      if (!fs.existsSync(srcFile)) {
        return res.status(404).json({ error: 'Không tìm thấy dự án nguồn' });
      }
      const content = fs.readFileSync(srcFile, 'utf8');
      const proj = JSON.parse(content);

      const newId = `proj_${Date.now()}`;
      const newName = `${proj.name} (Bản sao)`;
      const newProj = {
        ...proj, id: newId, name: newName, updatedAt: new Date().toISOString()
      };
      const destFile = path.join(shared.PROJECTS_DIR, `${newId}.json`);
      fs.writeFileSync(destFile, JSON.stringify(newProj, null, 2), 'utf8');
      res.json({ success: true, project: newProj });
    } catch (error) {
      console.error('Lỗi khi nhân bản dự án:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  renderReaction: async (req, res) => {
    const { mainVideoFile, position } = req.body;
    const reactionFile = req.file;
    if (!mainVideoFile || !reactionFile) {
      return res.status(400).json({ error: 'Thiếu file video' });
    }

    const mainPath = path.join(shared.DOWNLOADS_DIR, mainVideoFile);
    const outPath = path.join(shared.DOWNLOADS_DIR, `reaction_${Date.now()}.mp4`);
    let overlayPos = 'main_w-overlay_w-20:main_h-overlay_h-20';
    if (position === 'bottom-left') overlayPos = '20:main_h-overlay_h-20';
    if (position === 'top-right') overlayPos = 'main_w-overlay_w-20:20';
    if (position === 'top-left') overlayPos = '20:20';

    const filter = `[1:v]scale=320:-1[pip];[0:v][pip]overlay=${overlayPos}[v]`;
    const args = [
      '-i', mainPath, '-i', reactionFile.path,
      '-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-c:a', 'copy', '-y', outPath
    ];

    console.log('Rendering Reaction with FFmpeg...');
    shared.execFile(shared.FFMPEG_PATH, args, (error, stdout, stderr) => {
      try { fs.unlinkSync(reactionFile.path); } catch (e) { }
      if (error) {
        console.error('FFmpeg error:', stderr);
        return res.status(500).json({ error: 'Lỗi khi render video' });
      }
      res.json({ success: true, message: 'Tạo video thành công!', file: path.basename(outPath) });
    });
  },

  getStudioAssets: async (req, res) => {
    res.json({
      videos: shared.listFiles(shared.DOWNLOADS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
      renders: shared.listFiles(shared.RENDERS_DIR, ['.mp4', '.mov', '.mkv', '.webm']),
      voices: shared.listFiles(shared.VOICES_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4']),
      music: shared.listFiles(shared.MUSIC_DIR, ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4']),
      subtitles: shared.listFiles(shared.SUBTITLES_DIR, ['.srt', '.vtt', '.ass']),
      omiConfigured: fs.existsSync(shared.OMNIVOICE_CLI_PATH) && fs.existsSync(shared.OMNIVOICE_MODEL_PATH),
      omnivoice: {
        cliExists: fs.existsSync(shared.OMNIVOICE_CLI_PATH),
        modelExists: fs.existsSync(shared.OMNIVOICE_MODEL_PATH),
        cliPath: shared.OMNIVOICE_CLI_PATH,
        modelPath: shared.OMNIVOICE_MODEL_PATH
      }
    });
  },

  getRenderProgress: async (req, res) => {
    res.json(shared.state.studioProgress);
  },

  renderStudio: async (req, res) => {
    const timestamp = Date.now();
    const taskId = `task_${timestamp}`;
    try {
      const body = req.body;
      const files = req.files || {};
      const taskDir = path.join(shared.UPLOADS_DIR, `task_${timestamp}`);
      fs.mkdirSync(taskDir, { recursive: true });

      const movedFiles = {};
      for (const [fieldname, fileArr] of Object.entries(files)) {
        if (fileArr && fileArr[0]) {
          const file = fileArr[0];
          const newPath = path.join(taskDir, file.filename + path.extname(file.originalname));
          fs.renameSync(file.path, newPath);
          movedFiles[fieldname] = [{ ...file, path: newPath }];
        }
      }

      const task = {
        id: taskId,
        projectId: body.projectId || null,
        projectName: body.projectName || 'Dự án chưa đặt tên',
        status: 'pending',
        percent: 0,
        step: 'Đang xếp hàng...',
        error: null,
        createdAt: new Date(),
        body: body,
        files: movedFiles,
        taskDir: taskDir,
        result: null
      };

      shared.state.renderQueue.push(task);
      console.log(`[Queue] Đã xếp hàng tác vụ ${taskId}. Tổng hàng đợi: ${shared.state.renderQueue.length}`);
      processNextRenderTask();

      return res.json({
        success: true,
        message: 'Đã thêm video vào hàng đợi thành công.',
        taskId: taskId
      });
    } catch (error) {
      console.error('[Queue Error] Lỗi xếp hàng tác vụ:', error.message);
      return res.status(500).json({ error: 'Không thể thêm video vào hàng đợi: ' + error.message });
    }
  },

  getQueueStatus: async (req, res) => {
    res.json({
      queue: shared.state.renderQueue.map(t => ({
        id: t.id,
        projectId: t.projectId,
        projectName: t.projectName,
        status: t.status,
        percent: t.percent,
        step: t.step,
        error: t.error,
        createdAt: t.createdAt,
        videoName: t.body.mainVideoFile || (t.files.videoUpload?.[0] ? t.files.videoUpload[0].originalname : 'Video Tải Lên'),
        result: t.result
      })),
      currentActiveId: shared.state.currentActiveTask ? shared.state.currentActiveTask.id : null
    });
  },

  cancelQueueTask: async (req, res) => {
    const { taskId } = req.body;
    if (!taskId) {
      return res.status(400).json({ error: 'Thiếu mã tác vụ taskId' });
    }
    const taskIndex = shared.state.renderQueue.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Không tìm thấy tác vụ kết xuất' });
    }
    const task = shared.state.renderQueue[taskIndex];

    if (task.status === 'pending') {
      shared.state.renderQueue.splice(taskIndex, 1);
      console.log(`[Queue] Đã gỡ tác vụ đang chờ khỏi hàng đợi: ${taskId}`);
      return res.json({ success: true, message: 'Đã gỡ tác vụ khỏi hàng đợi thành công.' });
    }

    if (task.status === 'rendering') {
      console.log(`[Queue] Nhận yêu cầu hủy và gỡ tác vụ đang chạy trực tiếp: ${taskId}`);
      shared.killActiveRenderProcesses();
      shared.state.isStudioRendering = false;
      shared.state.activeRenderId = null;
      shared.state.studioProgress = {
        status: 'idle', percent: 0, step: 'Đã hủy kết xuất', error: null
      };
      task.status = 'failed';
      task.step = 'Đã bị người dùng hủy';

      shared.state.renderQueue.splice(taskIndex, 1);
      shared.state.currentActiveTask = null;

      setTimeout(() => {
        processNextRenderTask();
      }, 1500);
      return res.json({ success: true, message: 'Đã hủy tiến trình và gỡ tác vụ khỏi hàng đợi thành công.' });
    }

    shared.state.renderQueue.splice(taskIndex, 1);
    return res.json({ success: true, message: 'Đã gỡ tác vụ khỏi danh sách.' });
  },

  clearQueue: async (req, res) => {
    console.log('[Queue] Nhận yêu cầu xóa sạch toàn bộ hàng đợi...');
    if (shared.state.isStudioRendering || (shared.state.studioProgress && shared.state.studioProgress.status === 'rendering')) {
      shared.killActiveRenderProcesses();
    }
    shared.state.isStudioRendering = false;
    shared.state.activeRenderId = null;
    shared.state.studioProgress = {
      status: 'idle', percent: 0, step: 'Hàng đợi trống', error: null
    };
    shared.state.currentActiveTask = null;
    shared.state.renderQueue.length = 0;
    return res.json({ success: true, message: 'Đã xóa sạch hàng đợi thành công.' });
  },

  cancelRender: async (req, res) => {
    if (shared.state.isStudioRendering || (shared.state.studioProgress && shared.state.studioProgress.status === 'rendering')) {
      const renderId = shared.state.activeRenderId;
      console.log(`[Studio Render] Nhận yêu cầu hủy render ID: ${renderId}...`);
      shared.killActiveRenderProcesses();
      shared.state.isStudioRendering = false;
      if (shared.state.activeRenderId === renderId) {
        shared.state.activeRenderId = null;
      }
      shared.state.studioProgress = {
        status: 'idle', percent: 0, step: 'Đã hủy kết xuất', error: null
      };

      if (shared.state.currentActiveTask) {
        shared.state.currentActiveTask.status = 'failed';
        shared.state.currentActiveTask.step = 'Đã bị hủy';
        shared.state.currentActiveTask = null;
        setTimeout(() => {
          processNextRenderTask();
        }, 1500);
      }

      if (global.activeRenderRes) {
        try {
          global.activeRenderRes.status(400).json({ error: 'Render đã bị hủy.' });
        } catch (e) { }
        global.activeRenderRes = null;
      }
    }
    res.json({ success: true, message: 'Đã hủy render thành công.' });
  },

  processNextRenderTask // Expose helper if other controllers need it
};
