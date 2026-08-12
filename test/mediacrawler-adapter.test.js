const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  MediaCrawlerAdapter,
  lastJsonLine,
  mapPreviewItem,
  mapJsonlPreviewRow,
  migrateLegacyBilibiliArchive,
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

test('Douyin detail preview uses MediaCrawler metadata-only', async () => {
  const adapter = new MediaCrawlerAdapter();
  let call;
  adapter._run = async (script, args, options) => {
    call = { script, args, options };
    return { stdout: '{"ok":true,"items":[{"id":"7671964777823866146","url":"https://www.douyin.com/video/7671964777823866146"}]}\n' };
  };
  const items = await adapter.preview({
    platform: 'douyin', mode: 'detail',
    input: 'https://www.douyin.com/video/7671964777823866146', count: 60
  });
  assert.equal(path.basename(call.script), 'tim_anh.py');
  assert.ok(call.args.includes('--detail'));
  assert.ok(call.args.includes('https://www.douyin.com/video/7671964777823866146'));
  assert.equal(items[0].id, '7671964777823866146');
});

test('MediaCrawler preview forwards progressive item events', async () => {
  const adapter = new MediaCrawlerAdapter();
  const streamed = [];
  adapter._run = async (script, args, options) => {
    options.onLog('PREVIEW_ITEM {"id":"live","title":"Live","url":"https://www.douyin.com/video/live"}', 'info');
    return { stdout: '{"ok":true,"items":[{"id":"live","url":"https://www.douyin.com/video/live"}]}\n' };
  };
  await adapter.preview({
    platform: 'douyin', mode: 'search', input: 'cat', count: 1,
    onItem: (item) => streamed.push(item)
  });
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0].engine, 'MediaCrawler');
});

test('MediaCrawler preview discovers JSONL rows written while the crawler runs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-preview-jsonl-'));
  try {
    const adapter = new MediaCrawlerAdapter({ dataDir: directory });
    const streamed = [];
    adapter._run = async () => {
      const jsonl = path.join(directory, 'douyin', 'jsonl');
      fs.mkdirSync(jsonl, { recursive: true });
      fs.writeFileSync(path.join(jsonl, 'demo_contents.jsonl'), `${JSON.stringify({
        aweme_id: 'live-jsonl', title: 'Live JSONL', aweme_url: 'https://www.douyin.com/video/live-jsonl',
        video_download_url: 'https://cdn.test/live.mp4'
      })}\n`, 'utf8');
      return { stdout: '{"ok":true,"items":[]}\n' };
    };
    await adapter.preview({
      platform: 'douyin', mode: 'search', input: 'cat', count: 1,
      onItem: (item) => streamed.push(item)
    });
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0].id, 'live-jsonl');
    assert.equal(mapJsonlPreviewRow({ video_id: 'BV1', video_cover_url: 'http://img' }, 'bilibili').thumb, 'https://img');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test('MediaCrawler detail download receives original source grouping through isolated environment', async () => {
  const adapter = new MediaCrawlerAdapter();
  let call;
  adapter._run = async (script, args, options) => {
    call = { script, args, options };
    return { stdout: '' };
  };
  await adapter.crawl({
    platform: 'douyin', mode: 'detail', input: 'https://www.douyin.com/video/123', count: 1,
    sourceMode: 'search', sourceInput: 'mèo vui', outputDir: os.tmpdir()
  });
  assert.equal(call.options.env.MC_SOURCE_MODE, 'search');
  assert.equal(call.options.env.MC_SOURCE_INPUT, 'mèo vui');
  assert.ok(call.args.includes('--specified_id'));
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

test('Xiaohongshu and RedNote use their correct domestic/international domains', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-domain-mode-'));
  try {
    const adapter = new MediaCrawlerAdapter({ userRoot: path.join(directory, 'user') });
    const calls = [];
    adapter._run = async (script, args, options) => {
      calls.push(options.env);
      return { stdout: '' };
    };
    await adapter.crawl({ platform: 'xiaohongshu', mode: 'search', input: 'cat', count: 1, outputDir: directory });
    await adapter.crawl({ platform: 'rednote', mode: 'search', input: 'cat', count: 1, outputDir: directory });
    assert.equal(calls[0].MC_XHS_INTL, '0');
    assert.equal(calls[1].MC_XHS_INTL, '1');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Bilibili detail preview expands b23 and uses MediaCrawler metadata-only', async () => {
  const adapter = new MediaCrawlerAdapter({
    fetchImpl: async () => ({ url: 'https://www.bilibili.com/video/BV1TEST123/?share_source=copy_web' })
  });
  let call;
  adapter._run = async (script, args, options) => {
    call = { script, args, options };
    return { stdout: '{"ok":true,"items":[{"id":"BV1TEST123","url":"https://www.bilibili.com/video/BV1TEST123"}]}\n' };
  };
  const items = await adapter.preview({
    platform: 'bilibili', mode: 'detail', input: 'https://b23.tv/demo', count: 1
  });
  assert.equal(path.basename(call.script), 'tim_anh.py');
  assert.ok(call.args.includes('--detail'));
  assert.ok(call.args.includes('https://www.bilibili.com/video/BV1TEST123'));
  assert.equal(items[0].id, 'BV1TEST123');
});

test('Bilibili short links redirecting to BiliIntl are rejected', async () => {
  await assert.rejects(
    resolveBilibiliShortUrls('https://b23.tv/demo', async () => ({ url: 'https://www.bilibili.tv/en/video/123' })),
    /chỉ hỗ trợ Bilibili nội địa/
  );
});

test('legacy bilibili archive migrates into the canonical bili directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-archive-migration-'));
  try {
    fs.mkdirSync(path.join(directory, 'bili'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'bilibili'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'bili', '_da_tai_ids.txt'), 'old\n', 'utf8');
    fs.writeFileSync(path.join(directory, 'bilibili', '_da_tai_ids.txt'), 'old\nnew\n', 'utf8');
    const result = migrateLegacyBilibiliArchive(directory);
    assert.equal(result.migrated, true);
    assert.deepEqual(
      fs.readFileSync(path.join(directory, 'bili', '_da_tai_ids.txt'), 'utf8').trim().split(/\r?\n/),
      ['old', 'new']
    );
    assert.equal(fs.existsSync(path.join(directory, 'bilibili')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
