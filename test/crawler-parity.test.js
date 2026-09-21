const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { selectItems, metric } = require('../lib/crawl-selection');
const { normalizeCrawlRequest } = require('../lib/crawler-input-normalizer');
const { mapPreviewItem, ProjectYtDlpAdapter } = require('../lib/project-ytdlp-adapter');
const { MediaCrawlerAdapter, mapJsonlPreviewRow } = require('../lib/mediacrawler-adapter');
const { DownloadCrawlManager } = require('../lib/download-crawl-manager');
const { SourceChannelManager } = require('../lib/source-channel-manager');
const { SupplementalCrawler } = require('../lib/supplemental-crawler');
const { monitorProcess, redactLog } = require('../lib/crawl-process-monitor');
const { acquireProfiles } = require('../lib/crawl-profile-lock');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function manager(t, options = {}) {
  const root = fixture(t);
  const crawl = new DownloadCrawlManager({ shared: { DOWNLOADS_DIR: root }, downloadsDir: root, ...options });
  crawl.setPaused(true);
  return crawl;
}
function sources(t, preview) {
  const crawlManager = { capabilities: () => ({ douyin: { creator: true } }), history: [], tasks: [],
    preview, _log() {}, enqueueJob(job) { const id = `job-${this.tasks.length}`; this.tasks.push({ id, status: 'pending', config: job }); return { taskId: id }; } };
  return new SourceChannelManager({ storePath: path.join(fixture(t), 'channels.json'), crawlManager });
}
function mp4(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); const bytes = Buffer.alloc(110 * 1024); bytes.write('ftyp', 4); fs.writeFileSync(file, bytes); }

test('Douyin modal video on search page remains detail or chase, including multi-link input', () => {
  for (const mode of ['detail', 'chase']) {
    const result = normalizeCrawlRequest({ platform: 'douyin', mode, input: 'https://www.douyin.com/search/cat?modal_id=123\nhttps://www.douyin.com/video/456' });
    assert.equal(result.mode, mode);
    assert.equal(result.input, 'https://www.douyin.com/video/123\nhttps://www.douyin.com/video/456');
  }
});

test('filters exclude unknown metadata, preserve true zero, deduplicate and sort', () => {
  assert.equal(metric(null), null); assert.equal(metric(''), null); assert.equal(metric('0'), 0);
  const rows = [{ id: '1', likeCount: 20, viewCount: 300, timestamp: 100000 }, { id: '2', likeCount: null, viewCount: 9999 }, { id: '3', likeCount: 50, viewCount: 500, timestamp: 100000 }];
  assert.deepEqual(selectItems([...rows, rows[0]], { minLike: 10, sort: 'likes' }).map((r) => r.id), ['3', '1']);
  assert.deepEqual(selectItems(rows, { filterDays: 1 }, 100000 * 1000).map((r) => r.id), ['1', '3']);
});

test('TikTok metrics are independent and ambiguous legacy like does not fabricate likes', () => {
  const item = mapPreviewItem({ id: '1', like: '10000', view_count: 10000, like_count: 120 }, 'tiktok');
  assert.equal(item.likeCount, 120); assert.equal(item.viewCount, 10000);
  assert.equal(mapPreviewItem({ like: '10000' }, 'tiktok').likeCount, null);
});

test('specialized preview applies the same thresholds and sorting as generic preview', async (t) => {
  const crawl = manager(t, { previewResolvers: { 'youtube:search': async () => [{ id: 'a', likeCount: 1 }, { id: 'b', likeCount: 30 }, { id: 'c', likeCount: 50 }] } });
  const result = await crawl.preview({ platform: 'youtube', mode: 'search', input: 'cat', minLike: 20, sort: 'likes' });
  assert.deepEqual(result.items.map((r) => r.id), ['c', 'b']);
});

test('direct filtered crawl resolves only matching URLs and preserves original source', async (t) => {
  let config;
  const crawl = manager(t, { previewResolvers: { 'youtube:search': async () => [{ id: 'a', url: 'https://example.com/a', likeCount: 1 }, { id: 'b', url: 'https://example.com/b', likeCount: 30 }] },
    crawlResolvers: { youtube: async (request) => { config = request; return { success: true, completedVideos: 1 }; } } });
  crawl.enqueueJob({ platform: 'youtube', mode: 'search', input: 'cat', minLike: 20 });
  await crawl._runCrawlTask(crawl.tasks[0]);
  assert.equal(config.mode, 'detail'); assert.equal(config.input, 'https://example.com/b');
  assert.equal(config.sourceMode, 'search'); assert.equal(config.sourceInput, 'cat');
});

test('zero matches never starts a download or increments statistics', async (t) => {
  let downloads = 0;
  const crawl = manager(t, { previewResolvers: { 'youtube:search': async () => [] }, crawlResolvers: { youtube: async () => { downloads++; } } });
  crawl.enqueueJob({ platform: 'youtube', mode: 'search', input: 'cat', minLike: 20 });
  await crawl._runCrawlTask(crawl.tasks[0]);
  assert.equal(downloads, 0); assert.equal(crawl.tasks[0].reason, 'no_matches'); assert.equal(crawl.stats().completed, 0);
});

test('resolver explicit failure cannot become a successful queue item', async (t) => {
  const crawl = manager(t, { crawlResolvers: { youtube: async () => ({ success: false, message: 'download failed' }) } });
  crawl.enqueueJob({ platform: 'youtube', mode: 'creator', input: 'https://www.youtube.com/@test' });
  await crawl._runCrawlTask(crawl.tasks[0]); assert.equal(crawl.tasks[0].status, 'error');
});

test('partial results are labeled and can be retried by reason', async (t) => {
  const crawl = manager(t, { crawlResolvers: { youtube: async () => ({ success: true, completedVideos: 2, failedVideos: 1 }) } });
  crawl.enqueueJob({ platform: 'youtube', mode: 'creator', input: 'https://www.youtube.com/@test' });
  await crawl._runCrawlTask(crawl.tasks[0]); assert.equal(crawl.tasks[0].reason, 'partial');
  assert.equal(crawl.retryAll('youtube', 'network'), 0); assert.equal(crawl.retryAll('youtube', 'partial'), 1);
});

test('chase mode automatically enables whole-series behavior without a second UI flag', (t) => {
  const crawl = manager(t);
  const task = crawl.enqueueJob({ platform: 'douyin', mode: 'chase', input: 'https://www.douyin.com/video/123', wholeSeries: false });
  assert.equal(crawl.tasks.find((item) => item.id === task.taskId).config.wholeSeries, true);
});

test('source refresh retains old catalog and establishes baseline before notifying new items', async (t) => {
  let items = [{ id: '1', title: 'Tập 1', url: 'https://example.com/1' }];
  const source = sources(t, async () => ({ items })); const channel = source.add({ url: 'https://www.douyin.com/user/demo' });
  await source.refresh(channel.id); assert.equal(channel.newCount, 0);
  items = [{ id: '2', title: 'Tập 2', url: 'https://example.com/2' }];
  await source.refresh(channel.id); assert.equal(channel.videos.length, 2); assert.equal(channel.newCount, 1);
  source.update(channel.id, { seenIds: ['2'], list: { name: 'Bộ A', ids: ['1', '2', 'not-found'] } });
  assert.equal(channel.newCount, 0); assert.deepEqual(channel.lists[0].ids, ['1', '2']);
  source.runSelected(channel.id, ['2']); assert.equal(source.crawlManager.tasks[0].config.input, 'https://example.com/2');
});

test('source refresh coalesces overlapping requests', async (t) => {
  let resolve, count = 0;
  const source = sources(t, () => { count++; return new Promise((r) => { resolve = r; }); });
  const channel = source.add({ url: 'https://www.douyin.com/user/demo' });
  const first = source.refresh(channel.id), second = source.refresh(channel.id);
  resolve({ items: [] }); await Promise.all([first, second]); assert.equal(count, 1);
});

test('schedule retries enqueue failure after backoff and prevents overlapping channel jobs', (t) => {
  const source = sources(t); const channel = source.add({ url: 'https://www.douyin.com/user/demo' });
  source.updateSchedule(channel.id, { enabled: true, time: '01:00' });
  const enqueue = source.crawlManager.enqueueJob;
  source.crawlManager.enqueueJob = () => { throw new Error('temporary'); };
  source.tick(new Date('2026-09-07T02:00:00'));
  assert.equal(channel.schedule.lastRunDate, '');
  source.crawlManager.enqueueJob = enqueue;
  source.tick(new Date('2026-09-07T02:06:00')); source.tick(new Date('2026-09-07T02:07:00'));
  source.runNow(channel.id, 4);
  assert.equal(source.crawlManager.tasks.length, 1);
});

test('schedule retries failed job once after bounded delay', (t) => {
  const source = sources(t); const channel = source.add({ url: 'https://www.douyin.com/user/demo' });
  source.updateSchedule(channel.id, { enabled: true, time: '01:00' });
  source.tick(new Date('2026-09-07T02:00:00'));
  source.crawlManager.tasks[0].status = 'error';
  source.tick(new Date('2026-09-07T02:01:00')); assert.equal(source.crawlManager.tasks.length, 1);
  source.tick(new Date('2026-09-07T02:07:00')); assert.equal(source.crawlManager.tasks.length, 2);
});

test('watchdog distinguishes idle from total time, ignores synthetic UI heartbeat, and cleans up', () => {
  let now = 0, killed = 0, reason;
  const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  const watchdog = monitorProcess(proc, { clock: () => now, idleTimeoutMs: 50, timeoutMs: 200,
    kill: () => killed++, onTimeout: (value) => { reason = value; } });
  now = 40; proc.stdout.emit('data', Buffer.from('progress')); now = 80; watchdog.check(); assert.equal(killed, 0);
  now = 100; watchdog.check(); assert.equal(killed, 1); assert.equal(reason, 'idle'); assert.equal(proc.stdout.listenerCount('data'), 0);
  watchdog.stop();
});

test('log redaction strips session values from headers and signed query strings', () => {
  const result = redactLog('https://example.com/?msToken=secret&x=1\nCookie: session=other-secret');
  assert.doesNotMatch(result, /secret/); assert.match(result, /x=1/);
});

test('shared browser profiles cannot be used simultaneously by preview and downloads', () => {
  const release = acquireProfiles('test-profile-root', 'tim_anh.py', ['--platform', 'rednote']);
  try { assert.throws(() => acquireProfiles('test-profile-root', 'xhs_browser.py', []), (error) => error.reason === 'busy'); }
  finally { release(); }
  acquireProfiles('test-profile-root', 'xhs_browser.py', [])();
});

test('TikTok chase routes to short-drama script and forwards whole-series limit', async (t) => {
  const root = fixture(t), adapter = new ProjectYtDlpAdapter({ dataDir: root }); let args;
  adapter._run = async (script, a) => {
    assert.match(script, /tiktok_series\.py$/); args = a;
    mp4(path.join(root, 'tiktok/videos/bo/demo [123].mp4'));
    return { stdout: '{"ok":true,"failed":1}' };
  };
  const result = await adapter.crawl({ platform: 'tiktok', mode: 'chase', input: 'https://www.tiktok.com/shortdrama/episode/999/1', wholeSeries: true, outputDir: root });
  assert.ok(args.includes('5000')); assert.equal(result.completedVideos, 1); assert.equal(result.failedVideos, 1);
});

test('crawl UI derives wholeSeries from Theo bo mode and has no redundant checkbox', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.doesNotMatch(html, /id="crawl-whole-series"/);
  assert.match(app, /wholeSeries:\s*crawlNowState\.mode === 'chase'/);
});

test('Douyin preview forwards sort and publication time to Python', async () => {
  const adapter = new MediaCrawlerAdapter(); let env;
  adapter._run = async (_, __, options) => { env = options.env; return { stdout: '{"ok":true,"items":[]}' }; };
  await adapter.preview({ platform: 'douyin', mode: 'search', input: 'cat', count: 10, sort: 'likes', timeDays: 7 });
  assert.equal(env.DY_SORT_TYPE, '1'); assert.equal(env.DY_PUBLISH_TIME, '7');
});

test('Kuaishou metadata preserves separate counts and converts milliseconds', () => {
  const item = mapJsonlPreviewRow({ video_id: 'ks1', liked_count: '10', viewd_count: '200', create_time: 1770000000000 }, 'kuaishou');
  assert.equal(item.like, '10'); assert.equal(item.view, '200'); assert.equal(item.time, 1770000000);
});

test('Kuaishou download validates media and does not leak signed CDN links to history', async (t) => {
  const root = fixture(t), adapter = new MediaCrawlerAdapter({ dataDir: root });
  adapter._metadata = async () => [{ video_id: 'ks1', title: 'Demo', video_play_url: 'https://cdn.example.com/file?token=secret', video_url: 'https://www.kuaishou.com/short-video/ks1' }];
  adapter._runExecutable = async (_, args) => { mp4(args[args.indexOf('-o') + 1]); };
  const result = await adapter.crawl({ platform: 'kuaishou', mode: 'detail', input: 'https://www.kuaishou.com/short-video/ks1', outputDir: root });
  assert.equal(result.completedVideos, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'kuaishou/jsonl/detail_contents.jsonl'), 'utf8'), /secret|video_play_url/);
});

test('server routes Honggo detail and series preview through the Honggo extractor', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /'honggo:detail': \(config\) => supplementalCrawler\.honggo\(config, \{ onLog: config\.onLog \}, true\)/);
  assert.match(source, /'honggo:chase': \(config\) => supplementalCrawler\.honggo\(config, \{ onLog: config\.onLog \}, true\)/);
});

test('Honggo rejects other hosts and detail uses one-episode CLI flag', async (t) => {
  const root = fixture(t); let args;
  const adapter = new SupplementalCrawler({ appRoot: root, dataDir: root, _run: async (_, a) => { args = a; return { stdout: '{"ok":true,"tong":1,"bo_qua":1}' }; } });
  await assert.rejects(adapter.honggo({ mode: 'detail', input: 'https://example.com/anything' }), /Honggo/);
  await adapter.honggo({ mode: 'detail', input: 'https://www.hongguoapp.cn/vodplay/12-1-2.html' });
  assert.ok(args.includes('--mot-tap'));
});

test('Honggo official preview uses app metadata and falls back to the three-episode web list', async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'honggo_engine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tai_honggo_api.py'), 'loader');
  fs.writeFileSync(path.join(root, 'tai_honggo.py'), 'web');
  const calls = [];
  const runner = { appRoot: root, dataDir: root, _run: async (script, args) => {
    calls.push(path.basename(script));
    assert.ok(args.includes('--preview-json'));
    return { stdout: 'JSON: {"ok":true,"tong":394,"items":[{"id":"sid/v1","title":"Demo — Tập 1","thumb":"https://img/1.jpg","url":"https://hongguoduanju.com/player/sid/v1","duration":80,"like_count":12,"view_count":300,"nick":"Honggo · 394 tập"},{"id":"sid/v2","title":"Demo — Tập 2","thumb":"https://img/2.jpg","url":"https://hongguoduanju.com/player/sid/v2"}]}' };
  }};
  const crawler = new SupplementalCrawler(runner);
  const items = await crawler.honggo({ mode: 'chase', input: 'https://hongguoduanju.com/player/1234567890123456789', outputDir: root, count: 10 }, {}, true);
  assert.deepEqual(calls, ['tai_honggo_api.py']);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Demo — Tập 1');
  assert.equal(items[0].thumbnail, 'https://img/1.jpg');
  assert.equal(items[0].duration, 80);
  assert.equal(items[0].likeCount, 12);
  assert.equal(items[0].viewCount, 300);

  calls.length = 0;
  runner._run = async (script) => {
    calls.push(path.basename(script));
    if (script.endsWith('tai_honggo_api.py')) throw new Error('signer unavailable');
    return { stdout: '{"ok":true,"tong":1,"items":[{"id":"web1","title":"Web tập 1","url":"https://hongguoduanju.com/player/web1"}]}' };
  };
  const fallback = await crawler.honggo({ mode: 'chase', input: 'https://hongguoduanju.com/player/1234567890123456789', outputDir: root, count: 10 }, {}, true);
  assert.deepEqual(calls, ['tai_honggo_api.py', 'tai_honggo.py']);
  assert.equal(fallback[0].title, 'Web tập 1');
});
test('Honggo official links prefer app API and fall back to web on API failure', async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'honggo_engine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tai_honggo_api.py'), 'loader');
  fs.writeFileSync(path.join(root, 'tai_honggo.py'), 'web');
  const calls = [];
  const runner = { appRoot: root, dataDir: root, _run: async (script, args) => {
    calls.push(path.basename(script));
    if (script.endsWith('tai_honggo_api.py')) {
      const out = args[args.indexOf('--out') + 1];
      mp4(path.join(out, 'Episode 1.mp4'));
      return { stdout: 'LOG:api\nJSON: {"ok":true,"tai":1,"bo_qua":0,"tong":1}' };
    }
    throw new Error('web should not run');
  }};
  const crawler = new SupplementalCrawler(runner);
  const result = await crawler.honggo({ mode: 'chase', input: 'https://hongguoduanju.com/player/1234567890123456789', outputDir: root, count: 2 });
  assert.deepEqual(calls, ['tai_honggo_api.py']);
  assert.equal(result.completedVideos, 1);

  calls.length = 0;
  runner._run = async (script) => {
    calls.push(path.basename(script));
    if (script.endsWith('tai_honggo_api.py')) throw new Error('signer unavailable');
    return { stdout: '{"ok":true,"tai":0,"bo_qua":1,"tong":1}' };
  };
  await crawler.honggo({ mode: 'detail', input: 'https://hongguoduanju.com/player/1234567890123456789/1', outputDir: root, count: 1 });
  assert.deepEqual(calls, ['tai_honggo_api.py', 'tai_honggo.py']);
});

test('discovery isolates output and returns per-platform failures alongside successful channels', async (t) => {
  const root = fixture(t);
  const crawler = new SupplementalCrawler({ appRoot: root, crawlerRoot: root, _run: async (script, _, options) => {
    if (script.endsWith('bili_goi_y.py')) throw new Error('network');
    fs.writeFileSync(options.env.GOI_Y_OUT, JSON.stringify([{ link: 'https://www.youtube.com/@demo', nickname: 'Demo', videos_count: 30, videos_it_nhat: 1 }]));
  } });
  const result = await crawler.discover({ keywords: 'cat', platforms: ['youtube', 'bilibili'], minVideos: 20 });
  assert.equal(result.channels.length, 1); assert.equal(result.errors.length, 1); assert.equal(result.channels[0].countIsLowerBound, true);
});

test('selected UI download uses visible filtered items even if hidden items remain selected', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('async function crawlEnqueue(items)');
  const end = source.indexOf('\nfunction crawlEnqueueSelected', start);
  let body;
  const context = { crawlNowState: { platform: 'youtube', selected: new Set(['youtube:a', 'youtube:b']) },
    crawlFilteredItems: () => [{ id: 'b', platform: 'youtube', url: 'https://example.com/b' }],
    crawlCurrentRequest: () => ({ mode: 'search', input: 'cat' }),
    fetch: async (_, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ created: 1 }) }; },
    toast() {}, crawlStartPolling() {}, crawlPollStatus: async () => {}, crawlLoadHistory: async () => {}, crawlRefreshStats: async () => {} };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  await context.crawlEnqueue(); assert.equal(body.input, 'https://example.com/b'); assert.equal(body.count, 1);
});

test('Honggo preview preserves series and episode identity', () => {
  const item = mapPreviewItem({
    id: '7685717973641727038/7685762918863866942',
    url: 'https://hongguoduanju.com/player/7685717973641727038/7685762918863866942',
    episode: 2,
    episode_count: 192,
    series_title: 'Demo'
  }, 'honggo');
  assert.equal(item.seriesId, '7685717973641727038');
  assert.equal(item.episodeNumber, 2);
  assert.equal(item.episodeCount, 192);
  assert.equal(item.seriesTitle, 'Demo');
});

test('Honggo selected preview episodes are downloaded as their exact range', async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'honggo_engine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tai_honggo_api.py'), 'loader');
  fs.writeFileSync(path.join(root, 'tai_honggo.py'), 'web');
  const calls = [];
  const runner = { appRoot: root, dataDir: root, _run: async (script, args) => {
    calls.push({ script: path.basename(script), args });
    return { stdout: 'JSON: {"ok":true,"tai":10,"bo_qua":0,"tong":10}' };
  }};
  const crawler = new SupplementalCrawler(runner);
  const seriesId = '7685717973641727038';
  const selectedEpisodes = Array.from({ length: 10 }, (_, index) => ({
    url: `https://hongguoduanju.com/player/${seriesId}/video-${index + 1}`,
    seriesId,
    episodeNumber: index + 1
  }));
  await crawler.honggo({
    mode: 'detail',
    input: selectedEpisodes.map((item) => item.url).join('\n'),
    outputDir: root,
    count: 10,
    selectedEpisodes
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, 'tai_honggo_api.py');
  assert.equal(calls[0].args[calls[0].args.indexOf('--input') + 1], `https://hongguoduanju.com/player/${seriesId}`);
  assert.equal(calls[0].args[calls[0].args.indexOf('--tap') + 1], '1-10');
  assert.ok(!calls[0].args.includes('--mot-tap'));
});

test('Honggo crawl job retains sanitized selected episode metadata', (t) => {
  const crawl = manager(t);
  const selectedEpisodes = [{
    url: 'https://hongguoduanju.com/player/7685717973641727038/7685762918863866942',
    seriesId: '7685717973641727038',
    episodeNumber: 2
  }];
  const { taskId } = crawl.enqueueJob({
    platform: 'honggo', mode: 'detail', input: selectedEpisodes[0].url, count: 1, selectedEpisodes
  });
  const task = crawl.tasks.find((item) => item.id === taskId);
  assert.deepEqual(task.config.selectedEpisodes, selectedEpisodes);
});
