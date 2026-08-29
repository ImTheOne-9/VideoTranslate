const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SourceChannelManager, inferPlatform, canonicalChannelUrl } = require('../lib/source-channel-manager');

test('source channels persist schedules and enqueue crawl-only jobs once per day', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-channel-'));
  try {
    const queued = [];
    const crawlManager = {
      capabilities: () => ({ douyin: { creator: true } }),
      enqueueJob: (job) => { queued.push(job); return { taskId: 'task-1' }; },
      _log: () => {}
    };
    const storePath = path.join(directory, 'channels.json');
    const manager = new SourceChannelManager({ crawlManager, storePath });
    const channel = manager.add({ url: 'https://www.douyin.com/user/abc?utm_source=x', name: 'Demo' });
    manager.updateSchedule(channel.id, { enabled: true, dailyCount: 5, time: '01:00' });
    manager.tick(new Date('2026-08-28T02:00:00'));
    manager.tick(new Date('2026-08-28T03:00:00'));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].mode, 'creator');
    assert.equal(queued[0].count, 5);
    assert.equal(Object.hasOwn(queued[0], 'render'), false);
    assert.equal(new SourceChannelManager({ crawlManager, storePath }).list().length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source channel URL helpers recognize BiliTV and remove tracking parameters', () => {
  assert.equal(inferPlatform('https://www.bilibili.tv/en/video/123'), 'bilitv');
  assert.equal(canonicalChannelUrl('https://www.douyin.com/user/abc/?utm_source=x'), 'https://douyin.com/user/abc');
});

test('source channels auto-follow at most eight discovered creators and sync download state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-discovery-'));
  try {
    const crawlManager = {
      history: [],
      capabilities: () => ({ douyin: { creator: true } }),
      enqueueJob: () => ({ taskId: 'unused' }),
      _log: () => {}
    };
    const manager = new SourceChannelManager({ crawlManager, storePath: path.join(directory, 'channels.json') });
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `video-${index}`, platform: 'douyin', uploader: `Kênh ${index}`,
      creatorUrl: `https://www.douyin.com/user/channel-${index}`
    }));
    assert.equal(manager.discoverFromItems(items).length, 8);
    const first = manager.list()[0];
    first.videos = [];
    const stored = manager.channels.find((channel) => channel.id === first.id);
    stored.videos = [{ id: 'downloaded-video', downloaded: false }];
    crawlManager.history.push({ key: 'douyin:downloaded-video', status: 'success' });
    assert.equal(manager.list().find((channel) => channel.id === first.id).downloadedCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
