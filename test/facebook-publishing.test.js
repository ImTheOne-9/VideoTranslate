const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FacebookAccountStore } = require('../lib/facebook-account-store');
const { FacebookPublishJobStore } = require('../lib/facebook-publish-job-store');
const { FacebookPublishQueue } = require('../lib/facebook-publish-queue');
const { normalizeFacebookError } = require('../lib/facebookApi');

function temporaryRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'facebook-publish-')); }
const testProtector = {
  type: 'test',
  protect: (value) => Buffer.from(`protected:${value}`).toString('base64'),
  unprotect: (value) => Buffer.from(value, 'base64').toString().replace(/^protected:/, '')
};

test('FacebookAccountStore không ghi token rõ và không trả token ra danh sách', () => {
  const root = temporaryRoot();
  try {
    const file = path.join(root, 'accounts.json');
    const store = new FacebookAccountStore(file, { protector: testProtector });
    const saved = store.upsert({ pageId: '123', accessToken: 'EAA-SECRET', name: 'Page A' });
    assert.equal(saved.tokenStored, true);
    assert.equal(saved.accessToken, undefined);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /EAA-SECRET/);
    assert.equal(store.list()[0].accessToken, undefined);
    assert.equal(store.get(saved.id).accessToken, 'EAA-SECRET');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('FacebookPublishJobStore chống tạo trùng bằng idempotency key', () => {
  const root = temporaryRoot();
  try {
    const store = new FacebookPublishJobStore(path.join(root, 'jobs.json'));
    const first = store.create({ accountId: 'a', type: 'reel', videoPath: 'x.mp4', idempotencyKey: 'same' });
    const second = store.create({ accountId: 'a', type: 'reel', videoPath: 'x.mp4', idempotencyKey: 'same' });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.job.id, second.job.id);
    assert.equal(store.list().length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Facebook queue đăng Reel, đợi published và giữ lỗi comment dưới dạng warning', async () => {
  const root = temporaryRoot();
  try {
    const video = path.join(root, 'video.mp4');
    fs.writeFileSync(video, Buffer.alloc(1024));
    const accountStore = new FacebookAccountStore(path.join(root, 'accounts.json'), { protector: testProtector });
    const account = accountStore.upsert({ pageId: 'p1', accessToken: 'token', name: 'Page' });
    const jobStore = new FacebookPublishJobStore(path.join(root, 'jobs.json'));
    const queue = new FacebookPublishQueue({
      accountStore, jobStore, intervalMs: 60000,
      probeMedia: async () => ({ size: 1024, duration: 30, width: 1080, height: 1920 }),
      clientFactory: () => ({
        uploadReel: async (_file, _message, progress) => { progress(95); return { id: 'video-1' }; },
        getVideoStatus: async () => ({ status: 'ready', published: true, permalink: 'https://facebook.test/reel/1' }),
        getPostInfo: async () => ({ permalink_url: 'https://facebook.test/reel/1' }),
        postComment: async () => { throw new Error('permission denied'); }
      })
    });
    const created = queue.enqueue({ accountId: account.id, type: 'reel', videoPath: video, firstComment: 'Hello' });
    await queue.tick();
    const result = jobStore.get(created.job.id);
    assert.equal(result.status, 'published');
    assert.equal(result.percent, 100);
    assert.match(result.warning, /permission denied/);
    assert.equal(result.permalink, 'https://facebook.test/reel/1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Facebook Graph lỗi token được phân loại auth_required và không retry', () => {
  const error = normalizeFacebookError({ response: { status: 400, data: { error: { code: 190, error_subcode: 463, message: 'Token expired' } } } }, 'verify');
  assert.equal(error.authRequired, true);
  assert.equal(error.retryable, false);
  assert.equal(error.code, 190);
});

test('Facebook Graph lỗi rate limit được phép retry', () => {
  const error = normalizeFacebookError({ response: { status: 429, data: { error: { code: 4, message: 'Rate limited' } } } }, 'upload');
  assert.equal(error.rateLimited, true);
  assert.equal(error.retryable, true);
});
