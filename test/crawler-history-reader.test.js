const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCrawlerHistory, deleteCrawlerHistory, recordCrawlerOrigins } = require('../lib/crawler-history-reader');

test('crawler history deduplicates metadata and uses the real media file for downloaded status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-history-'));
  try {
    const jsonl = path.join(root, 'douyin', 'jsonl');
    fs.mkdirSync(jsonl, { recursive: true });
    fs.writeFileSync(path.join(jsonl, 'search_contents_1.jsonl'), [
      JSON.stringify({ aweme_id: '1', desc: 'Old', aweme_url: 'https://douyin/1', create_time: 10 }),
      JSON.stringify({ aweme_id: '1', desc: 'New title', aweme_url: 'https://douyin/1', create_time: 20 }),
      JSON.stringify({ aweme_id: '2', desc: 'Other', aweme_url: 'https://douyin/2', create_time: 30 })
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'douyin', '_da_tai_ids.txt'), '1\nhttps://douyin/1\n');
    const videos = path.join(root, 'douyin', 'videos', 'kenh', 'demo');
    fs.mkdirSync(videos, { recursive: true });
    const mediaFile = path.join(videos, 'New title [1].mp4');
    fs.writeFileSync(mediaFile, 'video');
    const items = readCrawlerHistory(root, { platform: 'douyin' });
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.id === '1').title, 'New title');
    assert.equal(items.find((item) => item.id === '1').downloaded, true);
    assert.deepEqual(readCrawlerHistory(root, { platform: 'douyin', onlyUndownloaded: true }).map((item) => item.id), ['2']);
    fs.unlinkSync(mediaFile);
    assert.equal(readCrawlerHistory(root, { platform: 'douyin' }).find((item) => item.id === '1').downloaded, false);
    assert.deepEqual(readCrawlerHistory(root, { platform: 'douyin', onlyUndownloaded: true }).map((item) => item.id), ['2', '1']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('crawler history deletion removes only recent metadata and preserves downloads and archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-history-delete-'));
  try {
    const platformRoot = path.join(root, 'tiktok');
    const jsonl = path.join(platformRoot, 'jsonl');
    fs.mkdirSync(jsonl, { recursive: true });
    const recent = Math.floor(Date.now() / 1000) - 60;
    const old = recent - 10 * 86400;
    fs.writeFileSync(path.join(jsonl, 'detail_contents_test.jsonl'), [
      JSON.stringify({ id: 'recent', title: 'Recent', url: 'https://tiktok/recent', create_time: recent }),
      JSON.stringify({ id: 'old', title: 'Old', url: 'https://tiktok/old', create_time: old })
    ].join('\n'));
    fs.writeFileSync(path.join(platformRoot, '_da_tai.txt'), 'recent\n', 'utf8');
    fs.writeFileSync(path.join(platformRoot, 'video.mp4'), 'video', 'utf8');

    assert.equal(deleteCrawlerHistory(root, 24).deleted, 1);
    assert.deepEqual(readCrawlerHistory(root).map((item) => item.id), ['old']);
    assert.equal(fs.readFileSync(path.join(platformRoot, '_da_tai.txt'), 'utf8'), 'recent\n');
    assert.equal(fs.readFileSync(path.join(platformRoot, 'video.mp4'), 'utf8'), 'video');
    assert.equal(deleteCrawlerHistory(root, 0).deleted, 1);
    assert.deepEqual(readCrawlerHistory(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('crawler history restores the original source mode for selected detail downloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-history-origin-'));
  try {
    const jsonl = path.join(root, 'douyin', 'jsonl');
    fs.mkdirSync(jsonl, { recursive: true });
    const url = 'https://www.douyin.com/video/1234567890123456789';
    fs.writeFileSync(path.join(jsonl, 'detail_contents_test.jsonl'), `${JSON.stringify({ aweme_id: '1234567890123456789', aweme_url: url, desc: 'Cat' })}\n`);
    recordCrawlerOrigins(root, { platform: 'douyin', input: url, sourceMode: 'search', sourceInput: 'mèo vui' });
    const item = readCrawlerHistory(root)[0];
    assert.equal(item.sourceMode, 'search');
    assert.equal(item.sourceInput, 'mèo vui');
    assert.equal(readCrawlerHistory(root, { query: 'mèo vui' }).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('crawler history recognizes a downloaded media file even when the archive is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-history-media-'));
  try {
    const jsonl = path.join(root, 'youtube', 'jsonl');
    const videos = path.join(root, 'youtube', 'videos', 'tu-khoa', 'demo');
    fs.mkdirSync(jsonl, { recursive: true });
    fs.mkdirSync(videos, { recursive: true });
    fs.writeFileSync(path.join(jsonl, 'search_contents_test.jsonl'), `${JSON.stringify({ id: 'abc-123_X', title: 'Clip', url: 'https://youtube.test/watch?v=abc-123_X', source_keyword: 'demo' })}\n`);
    fs.writeFileSync(path.join(videos, 'Clip [abc-123_X].mp4'), 'video');
    const item = readCrawlerHistory(root)[0];
    assert.equal(item.downloaded, true);
    assert.equal(item.mediaPath, path.join('youtube', 'videos', 'tu-khoa', 'demo', 'Clip [abc-123_X].mp4'));
    assert.equal(item.sourceMode, 'search');
    assert.equal(item.sourceInput, 'demo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('crawler history matches Bilibili files that use the final six AV-id digits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-history-bili-media-'));
  try {
    const jsonl = path.join(root, 'bili', 'jsonl');
    const videos = path.join(root, 'bili', 'videos', 'kenh', 'demo');
    fs.mkdirSync(jsonl, { recursive: true });
    fs.mkdirSync(videos, { recursive: true });
    fs.writeFileSync(path.join(jsonl, 'creator_contents_test.jsonl'), `${JSON.stringify({
      video_id: '117018632129322', title: 'Clip', video_url: 'https://www.bilibili.com/video/av117018632129322'
    })}\n`);
    const mediaFile = path.join(videos, 'Clip_129322.mp4');
    fs.writeFileSync(mediaFile, 'video');
    const downloaded = readCrawlerHistory(root, { platform: 'bilibili' })[0];
    assert.equal(downloaded.downloaded, true);
    assert.equal(downloaded.mediaPath, path.join('bili', 'videos', 'kenh', 'demo', 'Clip_129322.mp4'));
    fs.unlinkSync(mediaFile);
    assert.equal(readCrawlerHistory(root, { platform: 'bilibili' })[0].downloaded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
