const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const pending = new Map();

async function crawlThumbnail(root, relative, ffmpeg) {
  const realRoot = fs.realpathSync(root);
  const media = fs.realpathSync(path.resolve(realRoot, String(relative || '')));
  const inside = path.relative(realRoot, media);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !/\.(mp4|webm|mkv|mov|m4v)$/i.test(media)) {
    throw new Error('Video không hợp lệ.');
  }
  const stat = fs.statSync(media);
  if (!stat.isFile()) throw new Error('Video không tồn tại.');
  const cache = path.join(realRoot, '.crawl-thumbnails');
  fs.mkdirSync(cache, { recursive: true });
  const key = crypto.createHash('sha256').update(`${media}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  const output = path.join(cache, `${key}.jpg`);
  if (fs.existsSync(output)) return output;
  if (!pending.has(output)) {
    const temporary = `${output}.tmp.jpg`;
    pending.set(output, new Promise((resolve, reject) => {
      execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', media, '-frames:v', '1', '-vf', 'scale=480:-2', temporary],
        { windowsHide: true, timeout: 30000 }, (error) => {
          try {
            if (error) throw error;
            fs.renameSync(temporary, output);
            resolve(output);
          } catch (failure) {
            try { fs.unlinkSync(temporary); } catch (_) {}
            reject(failure);
          }
        });
    }).finally(() => pending.delete(output)));
  }
  return pending.get(output);
}
module.exports = { crawlThumbnail };
