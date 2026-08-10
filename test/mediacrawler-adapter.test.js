const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  MediaCrawlerAdapter,
  lastJsonLine,
  mapPreviewItem,
  resolveBilibiliShortUrls
} = require('../lib/mediacrawler-adapter');

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

test('preview distinguishes previously seen metadata from an actually downloaded item', () => {
  const item = mapPreviewItem({ id: 'n1', url: 'https://www.rednote.com/explore/n1', link: 'https://www.rednote.com/explore/n1?xsec_token=ok', da_thay: true }, 'rednote');
  assert.equal(item.url, 'https://www.rednote.com/explore/n1');
  assert.equal(item.sourceUrl, 'https://www.rednote.com/explore/n1?xsec_token=ok');
  assert.equal(item.seenBefore, true);
  assert.equal(item.downloaded, false);
});

test('chase passes the seed video through specified_id and forwards Douyin filters', async () => {
  const adapter = new MediaCrawlerAdapter();
  let call;
  adapter._run = async (script, args, options) => {
    call = { script, args, options };
    return { stdout: '' };
  };
  await adapter.crawl({
    platform: 'douyin', mode: 'chase', input: 'https://www.douyin.com/video/123', count: 5,
    sort: 'likes', timeDays: 7, outputDir: os.tmpdir()
  });
  assert.ok(call.args.includes('--specified_id'));
  assert.ok(call.args.includes('https://www.douyin.com/video/123'));
  assert.equal(call.options.env.DY_SORT_TYPE, '1');
  assert.equal(call.options.env.DY_PUBLISH_TIME, '7');
});

test('XHS selected links use browser-first tai_links instead of MediaCrawler detail API', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-browser-first-'));
  try {
    const adapter = new MediaCrawlerAdapter({ userRoot: path.join(directory, 'user') });
    let call;
    adapter._run = async (script, args, options) => {
      call = { script, args, options };
      return { stdout: '{"ok":true,"tai":["abc"],"loi":[]}\n' };
    };
    const result = await adapter.crawl({
      platform: 'rednote', mode: 'detail',
      input: 'https://www.rednote.com/explore/abc?xsec_token=token', count: 1, outputDir: directory
    });
    assert.equal(path.basename(call.script), 'xhs_browser.py');
    assert.ok(call.args.includes('tai_links'));
    assert.ok(call.args.some((value) => value.includes('xsec_token=token')));
    assert.equal(result.completedVideos, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('resolves b23 short links to canonical Bilibili video URLs', async () => {
  const resolved = await resolveBilibiliShortUrls('https://b23.tv/demo', async () => ({
    url: 'https://www.bilibili.com/video/BV1TEST123/?share_source=copy_web'
  }));
  assert.equal(resolved, 'https://www.bilibili.com/video/BV1TEST123');
});
