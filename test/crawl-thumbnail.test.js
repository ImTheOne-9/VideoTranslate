const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { crawlThumbnail } = require('../lib/crawl-thumbnail');

test('history thumbnail creates a real JPEG, reuses cache and rejects outside paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-thumb-test-'));
  const ffmpeg = path.resolve('tools/ffmpeg.exe');
  try {
    const media = path.join(root, 'video.mp4');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=0.2', '-c:v', 'libx264', media], { windowsHide: true });
    const [image, second] = await Promise.all([crawlThumbnail(root, 'video.mp4', ffmpeg), crawlThumbnail(root, 'video.mp4', ffmpeg)]);
    assert.equal(image, second);
    assert.equal(fs.readFileSync(image).subarray(0, 2).toString('hex'), 'ffd8');
    assert.equal(await crawlThumbnail(root, 'video.mp4', 'missing-ffmpeg'), image);
    await assert.rejects(crawlThumbnail(root, path.relative(root, ffmpeg), ffmpeg), /không hợp lệ/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
