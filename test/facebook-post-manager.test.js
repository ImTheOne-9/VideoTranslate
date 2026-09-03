const test = require('node:test');
const assert = require('node:assert/strict');
const FacebookApiService = require('../lib/facebookApi');
const { FacebookPublishQueue } = require('../lib/facebook-publish-queue');
const { pagePostId, managementId, resolveManagedObjectId, facebookPermalink } = require('../lib/facebook-object-identity');

const account = { id: 'account', pageId: '123', accessToken: 'test-token' };
const storedJob = { id: 'job', accountId: account.id, pageId: account.pageId, type: 'post', status: 'published',
  platformWorkId: '456', mediaId: '789', upload: { videoId: '789' }, facebookStatus: { postId: '456' } };

test('A bare Page post ID becomes PAGE_POST, without double prefixing', () => {
  assert.equal(pagePostId('123', '456'), '123_456');
  assert.equal(pagePostId('123', '123_456'), '123_456');
  assert.equal(pagePostId('', '456'), '456');
  assert.equal(managementId(storedJob), '123_456');
  assert.equal(managementId({ ...storedJob, facebookStatus: null }), '123_456');
  assert.equal(managementId({ type: 'feed', pageId: '123', platformWorkId: '456' }), '123_456');
});

test('Old and new manager requests resolve the same post, leaving comment IDs and other accounts alone', () => {
  for (const id of ['456', '123_456', '789']) assert.equal(resolveManagedObjectId([storedJob], account, id), '123_456');
  assert.equal(resolveManagedObjectId([storedJob], account, '456_999'), '456_999');
  assert.equal(resolveManagedObjectId([storedJob], account, '999'), '999');
  assert.equal(resolveManagedObjectId([storedJob], { id: 'other', pageId: '321' }, '456'), '456');
});

test('Video-only jobs retain their Video ID instead of guessing a Page post ID', () => {
  for (const type of ['post', 'reel', 'story']) {
    assert.equal(managementId({ type, pageId: '123', platformWorkId: '789', mediaId: '789' }), '789');
  }
});

test('Relative Facebook permalinks become absolute Facebook links', () => {
  assert.equal(facebookPermalink('/reel/789/'), 'https://www.facebook.com/reel/789/');
  assert.equal(facebookPermalink('https://www.facebook.com/123/posts/456'), 'https://www.facebook.com/123/posts/456');
  assert.equal(facebookPermalink('javascript:alert(1)'), null);
  assert.equal(facebookPermalink('https://facebook.com.evil.test/reel/789'), null);
});

test('Graph video post_id is normalized before management and insights use supported defaults', async () => {
  const calls = [];
  const api = new FacebookApiService('123', 'test-token', { http: { request: async (config) => {
    calls.push(config);
    if (config.url.endsWith('/insights')) return { data: { data: [] } };
    return { data: { id: '789', post_id: '456', published: true, permalink_url: '/reel/789/', status: { video_status: 'ready' } } };
  } } });
  const status = await api.getVideoStatus('789', 'post');
  assert.equal(status.postId, '123_456');
  assert.equal(status.permalink, 'https://www.facebook.com/reel/789/');
  await api.getInsights(status.postId);
  assert.ok(calls[1].url.endsWith('/123_456/insights'));
  assert.equal(calls[1].params.metric, 'post_media_view,post_clicks');
});

test('Queue keeps Video ID for polling and qualifies Post ID for first comment', async () => {
  let job = { ...storedJob, status: 'processing', firstComment: 'hello' };
  const objects = [];
  const queue = new FacebookPublishQueue({
    jobStore: { get: () => job, update: (_id, changes) => (job = { ...job, ...changes }), removeOld() {} },
    accountStore: { get: () => account, markStatus() {} },
    clientFactory: () => ({
      getVideoStatus: async (id) => { objects.push(['status', id]); return { published: true, postId: '456', permalink: '/reel/789/' }; },
      getPostInfo: async (id) => { objects.push(['info', id]); return {}; },
      postComment: async (id) => { objects.push(['comment', id]); return '456_999'; }
    })
  });
  await queue.runJob(job);
  assert.deepEqual(objects, [['status', '789'], ['info', '123_456'], ['comment', '123_456']]);
  assert.equal(job.platformWorkId, '123_456');
  assert.equal(job.mediaId, '789');
  assert.equal(job.permalink, 'https://www.facebook.com/reel/789/');
  assert.equal(job.status, 'published');
});
