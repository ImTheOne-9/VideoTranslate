const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shared = require('../lib/shared-state');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

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

test('Studio video library groups generated clip_nho files below their source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-video-chopped-'));
  try {
    const folder = path.join(root, 'douyin', 'videos', 'kenh', 'demo');
    fs.mkdirSync(path.join(folder, 'clip_nho'), { recursive: true });
    fs.writeFileSync(path.join(folder, '动漫.mp4'), 'source');
    fs.writeFileSync(path.join(folder, 'clip_nho', '动漫_clip_01.mp4'), 'clip');
    const videos = shared.listVideoFiles(root);
    const source = videos.find((item) => item.name === '动漫.mp4');
    assert.equal(source.chopped, true);
    assert.equal(source.isSplitClip, false);
    assert.equal(source.splitClipCount, 1);
    assert.equal(source.splitClips[0].name, '动漫_clip_01.mp4');
    assert.equal(source.splitClips[0].isSplitClip, true);
    assert.equal(videos.some((item) => item.name === '动漫_clip_01.mp4'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Studio video library keeps orphan split clips visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-video-orphan-'));
  try {
    const folder = path.join(root, 'clip_nho');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'missing_clip_01.mp4'), 'clip');
    const videos = shared.listVideoFiles(root);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].isSplitClip, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Studio video library groups ViralCrawl cảnh filenames and sorts clips numerically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-video-viral-clips-'));
  try {
    const folder = path.join(root, 'bili', 'videos', 'link', 'demo');
    fs.mkdirSync(path.join(folder, 'clip_nho'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'review.mp4'), 'source');
    fs.writeFileSync(path.join(folder, 'clip_nho', 'review_cảnh10_9x16.mp4'), 'clip10');
    fs.writeFileSync(path.join(folder, 'clip_nho', 'review_cảnh2_9x16.mp4'), 'clip2');
    const videos = shared.listVideoFiles(root);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].splitClipCount, 2);
    assert.deepEqual(videos[0].splitClips.map((clip) => clip.name), [
      'review_cảnh2_9x16.mp4',
      'review_cảnh10_9x16.mp4'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Studio grouped clip rows select the clip itself for rendering', () => {
  assert.match(appSource, /const groupVideoEl = card\.querySelector\('video'\)/);
  assert.match(appSource, /\$\('selected-video-file'\)\.value = clip\.filename/);
  assert.match(appSource, /setPreviewVideo\(clipUrl\)/);
  assert.doesNotMatch(appSource.slice(appSource.indexOf("children.querySelectorAll('.video-split-row')"), appSource.indexOf('group.appendChild(children)')), /\bvideoEl\b/);
});
