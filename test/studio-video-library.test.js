const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shared = require('../lib/shared-state');

test('Studio video library recursively classifies local and crawler videos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-video-library-'));
  try {
    fs.writeFileSync(path.join(root, 'single.mp4'), 'local');
    const keywordDir = path.join(root, 'bili', 'videos', 'tu-khoa', 'phim hay');
    const creatorDir = path.join(root, 'tiktok', 'videos', 'kenh', '@demo');
    fs.mkdirSync(keywordDir, { recursive: true });
    fs.mkdirSync(creatorDir, { recursive: true });
    fs.writeFileSync(path.join(keywordDir, 'bili.mp4'), 'bili');
    fs.writeFileSync(path.join(creatorDir, 'tiktok.webm'), 'tiktok');
    fs.writeFileSync(path.join(keywordDir, 'ignore.txt'), 'metadata');

    const videos = shared.listVideoFiles(root);
    assert.equal(videos.length, 3);
    assert.deepEqual(
      videos.map(({ name, platform, mode, source }) => ({ name, platform, mode, source })).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'bili.mp4', platform: 'bilibili', mode: 'search', source: 'phim hay' },
        { name: 'single.mp4', platform: 'local', mode: 'local', source: '' },
        { name: 'tiktok.webm', platform: 'tiktok', mode: 'creator', source: '@demo' }
      ]
    );
    assert.ok(videos.find((item) => item.name === 'bili.mp4').filename.includes(path.join('bili', 'videos', 'tu-khoa')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Studio video library marks sources and generated clip_nho files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-video-chopped-'));
  try {
    const folder = path.join(root, 'douyin', 'videos', 'kenh', 'demo');
    fs.mkdirSync(path.join(folder, 'clip_nho'), { recursive: true });
    fs.writeFileSync(path.join(folder, '动漫.mp4'), 'source');
    fs.writeFileSync(path.join(folder, 'clip_nho', '动漫_clip_01.mp4'), 'clip');
    const videos = shared.listVideoFiles(root);
    const source = videos.find((item) => item.name === '动漫.mp4');
    const clip = videos.find((item) => item.name === '动漫_clip_01.mp4');
    assert.equal(source.chopped, true);
    assert.equal(source.isSplitClip, false);
    assert.equal(clip.isSplitClip, true);
    assert.equal(clip.chopped, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
