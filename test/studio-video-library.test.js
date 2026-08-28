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
