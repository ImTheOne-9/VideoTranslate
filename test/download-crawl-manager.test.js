const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DownloadCrawlManager,
  splitInputs,
  safeCount,
  parsePercent,
  parseDownloadTelemetry
} = require('../lib/download-crawl-manager');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'download-crawl-'));
}

function makeShared(overrides = {}) {
  return {
    DOWNLOADS_DIR: 'C:\\downloads',
    FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe',
    YTDLP_PATH: 'C:\\tools\\yt-dlp.exe',
    cleanVideoTitle: (value) => value,
    removeVietnameseTones: (value) => value,
    getCustomExtractorArgs: () => [],
    runYtDlp: async () => '',
    spawn: () => { throw new Error('spawn should not run in this test'); },
    killProcessTree: () => {},
    ...overrides
  };
}

test('crawl input helpers normalize limits and progress', () => {
  assert.deepEqual(splitInputs('a\nb, c'), ['a', 'b', 'c']);
  assert.equal(safeCount('0'), 1);
  assert.equal(safeCount('9999'), 500);
  assert.equal(safeCount('bad', 20), 20);
  assert.equal(parsePercent('[download] 42.7% of 10MiB'), 42.7);
  assert.equal(parsePercent('merging'), null);
  assert.deepEqual(parseDownloadTelemetry('[download] 52% at 3.4MiB/s ETA 00:12'), { speed: '3.4MiB/s', eta: '00:12' });
});

test('deep-new preview scans farther and returns only unseen videos', async () => {
  const directory = makeTempDir();
  try {
    const historyPath = path.join(directory, 'history.json');
    fs.writeFileSync(historyPath, JSON.stringify([{ key: 'youtube:old', status: 'success' }]), 'utf8');
    let receivedArgs;
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async (args) => {
          receivedArgs = args;
          return [
            JSON.stringify({ id: 'old', title: 'Old', url: 'https://youtube.test/old' }),
            JSON.stringify({ id: 'new', title: 'New', url: 'https://youtube.test/new' })
          ].join('\n');
        }
      }),
      downloadsDir: directory,
      historyPath
    });
    const result = await manager.preview({ platform: 'youtube', mode: 'search', input: 'phim', count: 10, deepNew: true });
    assert.ok(receivedArgs.includes('ytsearch30:phim'));
    assert.equal(result.scanned, 2);
    assert.deepEqual(result.items.map((item) => item.id), ['new']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('specialized browser preview resolver also honors deep-new history', async () => {
  const directory = makeTempDir();
  try {
    const historyPath = path.join(directory, 'history.json');
    fs.writeFileSync(historyPath, JSON.stringify([{ key: 'douyin:old', status: 'success' }]), 'utf8');
    let requestedCount = 0;
    const manager = new DownloadCrawlManager({
      shared: makeShared({ DOWNLOADS_DIR: directory }),
      downloadsDir: directory,
      historyPath,
      previewResolvers: {
        'douyin:search': async ({ count }) => {
          requestedCount = count;
          return [
            { id: 'old', title: 'Old', url: 'https://douyin.test/old' },
            { id: 'new', title: 'New', url: 'https://douyin.test/new' }
          ];
        }
      }
    });
    const result = await manager.preview({ platform: 'douyin', mode: 'search', input: '猫', count: 2, deepNew: true });
    assert.equal(requestedCount, 80);
    assert.deepEqual(result.items.map((item) => item.id), ['new']);
    assert.equal(result.scanned, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('specialized preview streams normalized items before returning the final result', async () => {
  const directory = makeTempDir();
  try {
    const streamed = [];
    const manager = new DownloadCrawlManager({
      shared: makeShared({ DOWNLOADS_DIR: directory }),
      downloadsDir: directory,
      previewResolvers: {
        'douyin:search': async ({ onItem }) => {
          onItem({ id: 'live', title: 'Live', url: 'https://douyin.test/live' });
          return [{ id: 'live', title: 'Live', url: 'https://douyin.test/live' }];
        }
      }
    });
    const result = await manager.preview(
      { platform: 'douyin', mode: 'search', input: 'cat', count: 5, deepNew: false },
      { onItem: (item) => streamed.push(item) }
    );
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0].key, 'douyin:live');
    assert.equal(result.items[0].id, 'live');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preview capability is separate from crawl capability', async () => {
  const directory = makeTempDir();
  try {
    const manager = new DownloadCrawlManager({ shared: makeShared({ DOWNLOADS_DIR: directory }), downloadsDir: directory });
    assert.equal(manager.capabilities().xiaohongshu.detail, true);
    await assert.rejects(
      manager.preview({ platform: 'xiaohongshu', mode: 'detail', input: 'https://www.xiaohongshu.com/explore/abc', count: 1 }),
      /chưa hỗ trợ xem trước ổn định/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('queue pause, retry and stats expose persistent operator controls', () => {
  const directory = makeTempDir();
  try {
    const manager = new DownloadCrawlManager({ shared: makeShared({ DOWNLOADS_DIR: directory }), downloadsDir: directory });
    manager._processQueue = () => {};
    manager.history.push({ platform: 'youtube', status: 'success', completedAt: new Date().toISOString() });
    const task = manager.enqueue({ platform: 'youtube', items: [{ id: 'x', title: 'X', url: 'https://youtube.test/x' }] });
    const taskId = task.taskIds[0];
    const queued = manager.tasks.find((item) => item.id === taskId);
    queued.status = 'error';
    assert.equal(manager.setPaused(true).paused, true);
    assert.equal(manager.retry(taskId), true);
    assert.equal(manager.tasks.find((item) => item.id === taskId).status, 'pending');
    assert.equal(manager.stats().today, 1);
    assert.equal(fs.existsSync(path.join(directory, '.crawl-tasks.json')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('YouTube keyword preview builds searchable metadata and downloaded badge', async () => {
  const directory = makeTempDir();
  try {
    const historyPath = path.join(directory, 'history.json');
    fs.writeFileSync(historyPath, JSON.stringify([{ key: 'youtube:abc', status: 'success' }]), 'utf8');
    let receivedArgs = null;
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async (args) => {
          receivedArgs = args;
          return JSON.stringify({ id: 'abc', title: 'Video A', url: 'https://youtube.test/watch?v=abc', duration: 12 });
        }
      }),
      downloadsDir: directory,
      historyPath
    });

    const result = await manager.preview({ platform: 'youtube', mode: 'search', input: 'review phim', count: 10 });

    assert.ok(receivedArgs.includes('ytsearch30:review phim'));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].downloaded, true);
    assert.equal(result.items[0].duration, 12);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unsupported platform mode fails explicitly instead of pretending to crawl', async () => {
  const directory = makeTempDir();
  try {
    const manager = new DownloadCrawlManager({
      shared: makeShared({ DOWNLOADS_DIR: directory }),
      downloadsDir: directory,
      historyPath: path.join(directory, 'history.json')
    });
    await assert.rejects(
      manager.preview({ platform: 'instagram', mode: 'search', input: 'anime', count: 10 }),
      /chưa hỗ trợ cào theo từ khóa/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('enqueue skips completed duplicate and preserves a new item', () => {
  const directory = makeTempDir();
  try {
    const historyPath = path.join(directory, 'history.json');
    fs.writeFileSync(historyPath, JSON.stringify([{ key: 'youtube:old', status: 'success' }]), 'utf8');
    const manager = new DownloadCrawlManager({
      shared: makeShared({ DOWNLOADS_DIR: directory }),
      downloadsDir: directory,
      historyPath
    });
    manager._processQueue = () => {};

    const result = manager.enqueue({
      platform: 'youtube',
      skipDuplicates: true,
      items: [
        { id: 'old', key: 'youtube:old', title: 'Old', url: 'https://youtube.test/old' },
        { id: 'new', key: 'youtube:new', title: 'New', url: 'https://youtube.test/new' }
      ]
    });

    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    assert.equal(manager.snapshot().summary.pending, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('crawl job delegates Chinese platforms to MediaCrawler resolver', async () => {
  const directory = makeTempDir();
  try {
    let received = null;
    const manager = new DownloadCrawlManager({
      shared: makeShared({ DOWNLOADS_DIR: directory }),
      downloadsDir: directory,
      loginChecker: async () => 'in',
      crawlResolvers: {
        douyin: async (config, hooks) => {
          received = config;
          hooks.onLog('đang tải trang 1');
          return { engine: 'MediaCrawler', outputDir: directory, completedVideos: 7 };
        }
      }
    });
    manager._processQueue = () => {};
    const { taskId } = manager.enqueueJob({ platform: 'douyin', mode: 'search', input: '猫', count: 7 });
    const task = manager.tasks.find((item) => item.id === taskId);
    await manager._runCrawlTask(task);
    assert.equal(received.input, '猫');
    assert.equal(task.status, 'success');
    assert.equal(task.engine, 'MediaCrawler');
    assert.equal(task.completedVideos, 7);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('selected detail job persists the original crawl source for output grouping', () => {
  const directory = makeTempDir();
  try {
    const manager = new DownloadCrawlManager({
      shared: makeShared({ DOWNLOADS_DIR: directory }), downloadsDir: directory
    });
    manager._processQueue = () => {};
    const { taskId } = manager.enqueueJob({
      platform: 'tiktok', mode: 'detail', input: 'https://www.tiktok.com/@demo/video/1', count: 1,
      sourceMode: 'search', sourceInput: 'mèo vui'
    });
    const config = manager.tasks.find((task) => task.id === taskId).config;
    assert.equal(config.mode, 'detail');
    assert.equal(config.sourceMode, 'search');
    assert.equal(config.sourceInput, 'mèo vui');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
