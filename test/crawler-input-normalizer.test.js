const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractHttpUrls,
  normalizeCrawlRequest,
  mapDouyinSort,
  mapDouyinCreatorSort
} = require('../lib/crawler-input-normalizer');

test('extracts clean links from pasted share text and normalizes post mode', () => {
  assert.deepEqual(extractHttpUrls('Tiêu đề https://a.test/1, https://b.test/2 #tag'), [
    'https://a.test/1', 'https://b.test/2'
  ]);
  const result = normalizeCrawlRequest({ platform: 'bilibili', type: 'post', input: 'Xem https://b23.tv/abc nhé' });
  assert.equal(result.mode, 'detail');
  assert.equal(result.input, 'https://b23.tv/abc');
});

test('recognizes Douyin search, modal, note and creator URL forms', () => {
  assert.deepEqual(
    normalizeCrawlRequest({ platform: 'douyin', mode: 'creator', input: 'https://www.douyin.com/search/%E7%8C%AB?modal_id=1' }),
    { platform: 'douyin', mode: 'search', input: '猫' }
  );
  assert.equal(
    normalizeCrawlRequest({ platform: 'douyin', mode: 'detail', input: 'https://www.douyin.com/jingxuan?modal_id=123' }).input,
    'https://www.douyin.com/video/123'
  );
  assert.equal(
    normalizeCrawlRequest({ platform: 'douyin', mode: 'detail', input: 'https://www.douyin.com/note/456' }).input,
    'https://www.douyin.com/video/456'
  );
  assert.equal(
    normalizeCrawlRequest({ platform: 'douyin', mode: 'detail', input: 'https://www.douyin.com/video/7671964777823866146?modeFrom=' }).input,
    'https://www.douyin.com/video/7671964777823866146'
  );
  assert.equal(
    normalizeCrawlRequest({ platform: 'douyin', mode: 'creator', input: 'https://www.douyin.com/user/sec?modal_id=789' }).input,
    'https://www.douyin.com/user/sec'
  );
});

test('accepts and canonicalizes only mainland Bilibili video links', () => {
  assert.equal(
    normalizeCrawlRequest({ platform: 'bilibili', mode: 'detail', input: 'https://m.bilibili.com/video/BV1TEST123/?share=1' }).input,
    'https://www.bilibili.com/video/BV1TEST123'
  );
  assert.equal(
    normalizeCrawlRequest({ platform: 'bilibili', mode: 'detail', input: 'https://www.bilibili.com/video/av12345?p=2' }).input,
    'https://www.bilibili.com/video/av12345'
  );
  assert.throws(
    () => normalizeCrawlRequest({ platform: 'bilibili', mode: 'detail', input: 'https://www.bilibili.tv/en/video/123' }),
    /chỉ hỗ trợ Bilibili nội địa/
  );
  assert.throws(
    () => normalizeCrawlRequest({ platform: 'bilibili', mode: 'detail', input: 'https://www.youtube.com/watch?v=123' }),
    /chỉ hỗ trợ link Bilibili nội địa/
  );
});

test('maps Video Studio sort options to the crawler sort values', () => {
  assert.equal(mapDouyinSort('relevance'), '0');
  assert.equal(mapDouyinSort('likes'), '1');
  assert.equal(mapDouyinSort('newest'), '2');
  assert.equal(mapDouyinCreatorSort('likes'), 'most_liked');
  assert.equal(mapDouyinCreatorSort('newest'), 'newest');
});
