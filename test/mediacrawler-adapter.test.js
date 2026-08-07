const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { MediaCrawlerAdapter, lastJsonLine, mapPreviewItem } = require('../lib/mediacrawler-adapter');

test('MediaCrawler adapter reports missing runtime without starting a crawl', () => {
  const adapter = new MediaCrawlerAdapter({
    appRoot: path.join(__dirname, 'missing-app'),
    python: path.join(__dirname, 'missing-python.exe'),
    runtimeRoot: path.join(__dirname, 'missing-runtime')
  });
  const state = adapter.status();
  assert.equal(state.available, false);
  assert.equal(state.engine, 'MediaCrawler');
  assert.ok(state.missing.length >= 3);
});

test('MediaCrawler preview JSON and item fields map to crawl UI contract', () => {
  assert.deepEqual(lastJsonLine('log\n{"ok":true,"items":[]}\n'), { ok: true, items: [] });
  const item = mapPreviewItem({ id: '123', title: 'A', thumb: 'https://img', url: 'https://post', nick: 'B', like: '42', view: '99', loai: 'video' }, 'douyin');
  assert.equal(item.engine, 'MediaCrawler');
  assert.equal(item.likeCount, 42);
  assert.equal(item.viewCount, 99);
  assert.equal(item.sourceUrl, 'https://post');
});
