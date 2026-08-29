const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  DownloadCrawlManager,
  splitInputs,
  safeCount,
  resolvePlatformOutputDir,
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

function makeDownloadProcess({ code = 0, stderr = '' } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code, null);
  });
  return proc;
}

function writeFakeValidMp4(outputTemplate) {
  const filePath = String(outputTemplate).replace('%(ext)s', 'mp4');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = Buffer.alloc(110 * 1024);
  body.writeUInt32BE(24, 0);
  body.write('ftyp', 4, 'ascii');
  fs.writeFileSync(filePath, body);
  return filePath;
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

test('public XHS detail preview uses the anonymous single-download metadata path', async () => {
  const directory = makeTempDir();
  try {
    const sourceUrl = 'https://www.xiaohongshu.com/explore/public-note?xsec_token=token';
    let receivedArgs = null;
    let specializedCalls = 0;
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async (args) => {
          receivedArgs = args;
          return JSON.stringify({ id: 'public-note', title: 'Public XHS', webpage_url: sourceUrl });
        }
      }),
      downloadsDir: directory,
      previewResolvers: {
        'xiaohongshu:detail': async () => { specializedCalls += 1; return []; }
      }
    });
    assert.equal(manager.capabilities().xiaohongshu.detail, true);
    assert.ok(manager.capabilities().xiaohongshu.previewModes.includes('detail'));

    const result = await manager.preview({ platform: 'xiaohongshu', mode: 'detail', input: sourceUrl, count: 1 });

    assert.equal(specializedCalls, 0);
    assert.ok(receivedArgs.includes(sourceUrl));
    assert.equal(result.items[0].id, 'public-note');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('anonymous platform output keeps the same platform and source folders as crawler downloads', () => {
  const root = path.resolve('C:\\downloads');
  assert.equal(
    resolvePlatformOutputDir(root, 'douyin', { sourceMode: 'detail' }),
    path.join(root, 'douyin', 'videos', 'link')
  );
  assert.equal(
    resolvePlatformOutputDir(root, 'bilibili', { sourceMode: 'search', sourceInput: 'mèo/vui' }),
    path.join(root, 'bili', 'videos', 'tu-khoa', 'mèovui')
  );
  assert.equal(
    resolvePlatformOutputDir(root, 'rednote', { sourceMode: 'creator', sourceName: 'Kênh: Demo' }),
    path.join(root, 'rednote', 'videos', 'kenh', 'Kênh Demo')
  );
  assert.equal(
    resolvePlatformOutputDir(root, 'xiaohongshu', { sourceMode: 'detail' }),
    path.join(root, 'xhs', 'videos', 'link')
  );
});

test('public Douyin detail preview prefers its anonymous BrowserWindow resolver over yt-dlp', async () => {
  const directory = makeTempDir();
  try {
    const sourceUrl = 'https://www.douyin.com/video/7674985967115078927';
    const cdnUrl = 'https://example.zjcdn.com/video.mp4';
    let ytDlpCalls = 0;
    let specializedCalls = 0;
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async () => { ytDlpCalls += 1; throw new Error('Fresh cookies are needed'); }
      }),
      downloadsDir: directory,
      previewResolvers: {
        'douyin:detail': async () => { throw new Error('MediaCrawler must not run'); }
      },
      anonymousPreviewResolvers: {
        'douyin:detail': async ({ input }) => {
          specializedCalls += 1;
          assert.equal(input, sourceUrl);
          return [{
            id: '7674985967115078927',
            title: 'Public Douyin',
            sourceUrl,
            url: cdnUrl,
            resolvedDownload: true
          }];
        }
      }
    });

    const result = await manager.preview({ platform: 'douyin', mode: 'detail', input: sourceUrl, count: 1 });

    assert.equal(specializedCalls, 1);
    assert.equal(ytDlpCalls, 0);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sourceUrl, sourceUrl);
    assert.equal(result.items[0].url, cdnUrl);
    assert.equal(result.items[0].resolvedDownload, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('logged-in detail preview uses the authenticated platform resolver', async () => {
  const directory = makeTempDir();
  try {
    const sourceUrl = 'https://www.douyin.com/video/7674985967115078927';
    let authenticatedCalls = 0;
    let anonymousCalls = 0;
    let loginChecks = 0;
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async () => { throw new Error('generic preview must not run'); }
      }),
      downloadsDir: directory,
      loginChecker: async () => { loginChecks += 1; return 'in'; },
      crawlResolvers: {
        douyin: async () => ({ completedVideos: 1 })
      },
      previewResolvers: {
        'douyin:detail': async ({ input }) => {
          authenticatedCalls += 1;
          assert.equal(input, sourceUrl);
          return [{ id: '7674985967115078927', title: 'Authenticated Douyin', url: sourceUrl }];
        }
      },
      anonymousPreviewResolvers: {
        'douyin:detail': async () => { anonymousCalls += 1; return []; }
      }
    });

    const result = await manager.preview({ platform: 'douyin', mode: 'detail', input: sourceUrl, count: 1 });

    assert.equal(loginChecks, 1);
    assert.equal(authenticatedCalls, 1);
    assert.equal(anonymousCalls, 0);
    assert.equal(result.items[0].title, 'Authenticated Douyin');
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
          return { engine: 'MediaCrawler', outputDir: directory, completedVideos: 7, failedVideos: 2 };
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
    assert.equal(task.failedVideos, 2);
    assert.match(task.step, /Hoàn tất 7, lỗi 2/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Bilibili detail uses anonymous single-download path when logged out', async () => {
  const directory = makeTempDir();
  try {
    const sourceUrl = 'https://www.bilibili.com/video/BV1PUBLIC';
    let loginChecks = 0;
    let crawlCalls = 0;
    let downloadArgs = null;
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async () => JSON.stringify({
          id: 'BV1PUBLIC', title: 'Public Bilibili', webpage_url: sourceUrl
        }),
        getCustomExtractorArgs: (url) => url.includes('bilibili.com')
          ? ['--add-header', 'Referer:https://www.bilibili.com']
          : [],
        spawn: (_command, args) => {
          downloadArgs = args;
          writeFakeValidMp4(args[args.indexOf('-o') + 1]);
          return makeDownloadProcess();
        }
      }),
      downloadsDir: directory,
      loginChecker: async () => { loginChecks += 1; return 'out'; },
      crawlResolvers: {
        bilibili: async () => { crawlCalls += 1; throw new Error('MediaCrawler must not run'); }
      }
    });
    manager._processQueue = () => {};
    const { taskId } = manager.enqueueJob({
      platform: 'bilibili', mode: 'detail', input: sourceUrl, count: 1, quality: '720'
    });
    const task = manager.tasks.find((item) => item.id === taskId);

    await manager._runCrawlTask(task);

    assert.equal(loginChecks, 1);
    assert.equal(crawlCalls, 0);
    assert.equal(task.status, 'success');
    assert.equal(task.completedVideos, 1);
    assert.equal(task.config.quality, '720');
    assert.ok(downloadArgs.includes(sourceUrl));
    assert.ok(downloadArgs.includes('Referer:https://www.bilibili.com'));
    const selector = downloadArgs[downloadArgs.indexOf('-f') + 1];
    assert.match(selector, /^bestvideo\[height<=720\]\[ext=mp4\]\[vcodec~/);
    assert.match(selector, /\^\(avc1\|h264\)/);
    assert.ok(downloadArgs.includes('--http-chunk-size'));
    const outputTemplate = downloadArgs[downloadArgs.indexOf('-o') + 1];
    assert.equal(path.dirname(outputTemplate), path.join(directory, 'bili', 'videos', 'link'));
    assert.equal(task.outputPath, path.join(directory, 'bili', 'videos', 'link'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Douyin detail keeps the public CDN extractor when logged out', async () => {
  const directory = makeTempDir();
  try {
    const sourceUrl = 'https://www.douyin.com/video/123456789';
    const cdnUrl = 'https://example.zjcdn.com/public-video.mp4';
    let loginChecks = 0;
    let resolverCalls = 0;
    let downloadedUrl = '';
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async () => { throw new Error('yt-dlp must not inspect public Douyin detail'); },
        spawn: (_command, args) => {
          downloadedUrl = args.at(-1);
          writeFakeValidMp4(args[args.indexOf('-o') + 1]);
          return makeDownloadProcess();
        }
      }),
      downloadsDir: directory,
      loginChecker: async () => { loginChecks += 1; return 'out'; },
      anonymousPreviewResolvers: {
        'douyin:detail': async () => [{
          id: '123456789', title: 'Public Douyin', sourceUrl, url: cdnUrl, resolvedDownload: true
        }]
      },
      downloadResolvers: {
        douyin: async () => { resolverCalls += 1; return { url: cdnUrl }; }
      },
      crawlResolvers: {
        douyin: async () => { throw new Error('MediaCrawler must not run'); }
      }
    });
    manager._processQueue = () => {};
    const { taskId } = manager.enqueueJob({ platform: 'douyin', mode: 'detail', input: sourceUrl, count: 1 });
    const task = manager.tasks.find((item) => item.id === taskId);

    await manager._runCrawlTask(task);

    assert.equal(loginChecks, 1);
    assert.equal(resolverCalls, 0);
    assert.equal(downloadedUrl, cdnUrl);
    assert.equal(task.status, 'success');
    assert.equal(task.outputPath, path.join(directory, 'douyin', 'videos', 'link'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('logged-out RedNote detail asks for login only after the real download reports login required', async () => {
  const directory = makeTempDir();
  try {
    const sourceUrl = 'https://www.rednote.com/explore/public-note?xsec_token=token';
    let loginChecks = 0;
    const manager = new DownloadCrawlManager({
      shared: makeShared({
        DOWNLOADS_DIR: directory,
        runYtDlp: async () => JSON.stringify({ id: 'public-note', title: 'Public RedNote', webpage_url: sourceUrl }),
        spawn: () => makeDownloadProcess({ code: 1, stderr: 'ERROR: Sign in required to view this note' })
      }),
      downloadsDir: directory,
      loginChecker: async () => { loginChecks += 1; return 'out'; },
      crawlResolvers: {
        rednote: async () => { throw new Error('MediaCrawler must not run'); }
      }
    });
    manager._processQueue = () => {};
    const { taskId } = manager.enqueueJob({ platform: 'rednote', mode: 'detail', input: sourceUrl, count: 1 });
    const task = manager.tasks.find((item) => item.id === taskId);

    await manager._runCrawlTask(task);

    assert.equal(loginChecks, 1);
    assert.equal(task.status, 'error');
    assert.equal(task.reason, 'login_expired');
    assert.match(task.error, /Sign in required/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('logged-in detail routes Douyin, Bilibili and RedNote through the authenticated crawler', async () => {
  const directory = makeTempDir();
  try {
    for (const platform of ['douyin', 'bilibili', 'rednote']) {
      const input = {
        douyin: 'https://www.douyin.com/video/123456789',
        bilibili: 'https://www.bilibili.com/video/BV1PUBLIC',
        rednote: 'https://www.rednote.com/explore/public-note?xsec_token=token'
      }[platform];
      let loginChecks = 0;
      let crawlCalls = 0;
      const manager = new DownloadCrawlManager({
        shared: makeShared({
          DOWNLOADS_DIR: directory,
          runYtDlp: async () => { throw new Error('anonymous preview must not run'); }
        }),
        downloadsDir: directory,
        loginChecker: async () => { loginChecks += 1; return 'in'; },
        crawlResolvers: {
          [platform]: async (config) => {
            crawlCalls += 1;
            assert.equal(config.mode, 'detail');
            return { engine: platform === 'rednote' ? 'XHS Browser' : 'MediaCrawler', outputDir: directory, completedVideos: 1 };
          }
        }
      });
      manager._processQueue = () => {};
      const { taskId } = manager.enqueueJob({
        platform, mode: 'detail', input, count: 1
      });
      const task = manager.tasks.find((item) => item.id === taskId);
      await manager._runCrawlTask(task);
      assert.equal(loginChecks, 1);
      assert.equal(crawlCalls, 1);
      assert.equal(task.status, 'success');
      assert.equal(task.completedVideos, 1);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Douyin search still requires login before MediaCrawler runs', async () => {
  const directory = makeTempDir();
  try {
    let crawlCalls = 0;
    const manager = new DownloadCrawlManager({
      shared: makeShared({ DOWNLOADS_DIR: directory }),
      downloadsDir: directory,
      loginChecker: async () => 'out',
      crawlResolvers: {
        douyin: async () => { crawlCalls += 1; return {}; }
      }
    });
    manager._processQueue = () => {};
    const { taskId } = manager.enqueueJob({ platform: 'douyin', mode: 'search', input: 'mèo', count: 1 });
    const task = manager.tasks.find((item) => item.id === taskId);

    await manager._runCrawlTask(task);

    assert.equal(crawlCalls, 0);
    assert.equal(task.status, 'error');
    assert.equal(task.reason, 'login_expired');
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
