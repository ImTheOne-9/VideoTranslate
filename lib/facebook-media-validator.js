const fs = require('fs');
const path = require('path');

async function probeMedia(videoPath, options = {}) {
  options.signal?.throwIfAborted();
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('Không tìm thấy file video để đăng Facebook');
  const stat = fs.statSync(videoPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('File video rỗng hoặc không hợp lệ');
  const extension = path.extname(videoPath).toLowerCase();
  if (!['.mp4', '.mov', '.m4v', '.webm'].includes(extension)) throw new Error(`Phần mềm chưa hỗ trợ kiểm tra file ${extension || 'không rõ định dạng'}`);
  let probe = { format: {}, streams: [] };
  if (!options.ffprobePath || !fs.existsSync(options.ffprobePath) || typeof options.runExecFile !== 'function') {
    throw new Error('Thiếu ffprobe để kiểm tra video. Hãy cài hoặc cấu hình ffprobe trước khi upload Facebook.');
  }
  if (options.ffprobePath && fs.existsSync(options.ffprobePath) && typeof options.runExecFile === 'function') {
    try {
      const result = await options.runExecFile(options.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', videoPath], { timeout: 30000, signal: options.signal });
      probe = JSON.parse(result.stdout || '{}');
    } catch (error) {
      throw new Error(`Không đọc được thông tin video bằng ffprobe: ${error.message}`);
    }
  }
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video') || {};
  const audio = (probe.streams || []).find((stream) => stream.codec_type === 'audio') || {};
  options.signal?.throwIfAborted();
  if (!video.codec_name || !(Number(video.width) > 0) || !(Number(video.height) > 0)) throw new Error('File không có luồng video hợp lệ');
  if (!Number.isFinite(Number(probe.format?.duration)) || Number(probe.format?.duration) <= 0) throw new Error('Không đọc được thời lượng video; chưa thể kiểm tra giới hạn upload');
  return {
    path: videoPath, filename: path.basename(videoPath), size: stat.size,
    duration: Number(probe.format?.duration || 0), container: probe.format?.format_name || extension.slice(1),
    videoCodec: video.codec_name || null, audioCodec: audio.codec_name || null,
    width: Number(video.width || 0), height: Number(video.height || 0)
  };
}

function validateForType(media, type) {
  if (!['post', 'reel', 'story'].includes(type)) throw new Error('Loại video Facebook không hợp lệ');
  if (!Number.isFinite(media.size) || media.size <= 0 || !Number.isFinite(media.duration) || media.duration <= 0) throw new Error('Thiếu dung lượng hoặc thời lượng video hợp lệ');
  const limit = (name, fallback, allowZero = false) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`Cấu hình ${name} phải là ${allowZero ? 'số không âm (0 để bỏ giới hạn)' : 'số lớn hơn 0'}`);
    return value;
  };
  const maxBytes = limit('FACEBOOK_MAX_VIDEO_BYTES', 4 * 1024 * 1024 * 1024);
  if (media.size > maxBytes) throw new Error(`Video vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)} MB đã cấu hình`);
  if (type === 'story' || type === 'reel') {
    // Reel duration is unrestricted locally by default; a positive override is optional.
    const maxSeconds = type === 'story' ? limit('FACEBOOK_STORY_MAX_SECONDS', 60) : limit('FACEBOOK_REEL_MAX_SECONDS', 0, true);
    if (maxSeconds > 0 && media.duration > maxSeconds) throw new Error(`${type === 'story' ? 'Story' : 'Reel'} dài ${media.duration.toFixed(1)} giây, vượt ngưỡng ${maxSeconds} giây đang cấu hình trong phần mềm. Đây chưa phải lỗi do Facebook trả về. Với video dài, hãy chọn Video Post hoặc điều chỉnh cấu hình sau khi xác minh API.`);
  }
  return media;
}

module.exports = { probeMedia, validateForType };
