const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FacebookApiService = require('../lib/facebookApi');
const { FacebookPublishQueue } = require('../lib/facebook-publish-queue');
const { FacebookPublishJobStore } = require('../lib/facebook-publish-job-store');
const { publicationSchedule } = require('../lib/facebook-scheduling');

function fixture(t, type = 'post', options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-native-schedule-'));
  const file = path.join(root, 'video.mp4');
  fs.writeFileSync(file, Buffer.alloc(8));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('fb-native-schedule-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new FacebookPublishJobStore(path.join(root, 'jobs.json'));
  const at = Math.floor(Date.now() / 1000) + 3600;
  const job = store.create({ type, videoPath: file, accountId: 'account', pageId: '123',
    firstComment: 'Comment after publication', scheduleMode: 'facebook', scheduledAt: new Date(at * 1000).toISOString() }).job;
  const calls = [];
  const control = { published: false, scheduledTime: at, processed: true, ...options };
  const makeQueue = () => {
    const queue = new FacebookPublishQueue({ jobStore: store, maxStatusChecks: 3,
      probeMedia: async () => ({ size: 8, duration: 30, width: 1080, height: 1920 }),
      accountStore: { get: () => ({ id: 'account', pageId: '123', accessToken: 'test-token' }), markStatus() {} },
      clientFactory: (_page, _token, config) => new FacebookApiService('123', 'test-token', { ...config, http: { request: async config => {
        calls.push(config);
        if (config.data?.on) await new Promise((resolve, reject) => {
          config.data.on('error', reject); config.data.on('end', resolve); config.data.resume();
        });
        const phase = config.params?.upload_phase;
        if (phase === 'start') return { data: type === 'post'
          ? { video_id: '456', upload_session_id: 'session', start_offset: '0', end_offset: '8' }
          : { video_id: '456', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/456' } };
        if (phase === 'transfer' || config.url.includes('rupload.facebook.com')) {
          if (control.slowUpload) t.mock.timers.tick(55 * 60000);
          return { data: phase === 'transfer' ? { start_offset: '8', end_offset: '8' } : { success: true } };
        }
        if (phase === 'finish') {
          assert.equal(store.get(job.id).upload.scheduledPublishTime, at);
          if (control.loseFinish) throw new Error('Lost finish response');
          return { data: { success: !control.rejectFinish } };
        }
        if (config.method === 'get' && config.params.fields.includes('status')) return { data: {
          id: '456', post_id: '789', published: control.published,
          scheduled_publish_time: control.scheduledTime,
          status: { video_status: control.processed ? 'ready' : 'processing',
            uploading_phase: { status: 'complete' }, processing_phase: { status: control.processed ? 'complete' : 'in_progress' },
            publishing_phase: control.published ? { status: 'complete', publish_status: 'published' } : { status: 'not_started' } }
        } };
        if (config.url.endsWith('/comments')) return { data: { id: 'comment' } };
        return { data: { permalink_url: 'https://www.facebook.com/123/posts/789' } };
      } } })
    });
    queue.kick = () => {};
    return queue;
  };
  return { file, store, job, at, calls, control, makeQueue };
}

for (const type of ['post', 'reel', 'story']) {
  test(`${type}: upload now, verify schedule, survive restart, comment only after actual publication`, async t => {
    const f = fixture(t, type), queue = f.makeQueue();
    assert.ok(new Date(f.job.scheduledAt).getTime() > Date.now());
    await queue.tick();
    const finish = f.calls.find(call => call.params?.upload_phase === 'finish');
    assert.equal(finish.params.scheduled_publish_time, f.at);
    if (type === 'post') {
      assert.equal(finish.params.published, false);
      assert.equal(finish.params.unpublished_content_type, 'SCHEDULED');
    } else assert.equal(finish.params.video_state, 'SCHEDULED');
    let saved = f.store.get(f.job.id);
    assert.equal(saved.status, 'facebook_scheduled');
    assert.equal(saved.publishedAt, undefined);
    assert.equal(saved.statusChecks, 0);
    assert.ok(saved.scheduleConfirmedAt);
    assert.ok(f.calls.find(call => call.params?.fields?.includes('scheduled_publish_time')));
    assert.equal(f.calls.some(call => call.url.endsWith('/comments')), false);
    assert.equal(queue.cancel(f.job.id), null);
    fs.unlinkSync(f.file);
    const restored = f.makeQueue(); restored.recoverJobs();
    const before = f.calls.length;
    await restored.tick();
    assert.equal(f.calls.length, before);
    t.mock.timers.tick(3600001);
    f.control.published = true;
    await restored.tick();
    saved = f.store.get(f.job.id);
    assert.equal(saved.status, 'published');
    assert.equal(saved.platformWorkId, '123_789');
    assert.ok(saved.commentPostedAt);
    assert.equal(f.calls.filter(call => call.params?.upload_phase === 'start').length, 1);
    assert.equal(f.calls.filter(call => call.params?.upload_phase === 'finish').length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/comments')).length, 1);
  });

  test(`${type}: missing finish response reconciles saved schedule without republishing`, async t => {
    const f = fixture(t, type, { loseFinish: true });
    await f.makeQueue().runJob(f.job);
    assert.equal(f.store.get(f.job.id).upload.phase, 'finishing');
    assert.equal(f.store.get(f.job.id).scheduleConfirmedAt, undefined);
    assert.equal(f.makeQueue().cancel(f.job.id), null);
    fs.unlinkSync(f.file);
    await f.makeQueue().runJob(f.store.get(f.job.id));
    assert.equal(f.store.get(f.job.id).status, 'facebook_scheduled');
    assert.equal(f.calls.filter(call => call.method === 'post' && call.params?.upload_phase === 'finish').length, 1);
  });

  test(`${type}: rejected schedule never falls back to immediate publication`, async t => {
    const f = fixture(t, type, { rejectFinish: true });
    await f.makeQueue().runJob(f.job);
    assert.equal(f.store.get(f.job.id).status, 'failed');
    assert.equal(f.store.get(f.job.id).scheduleConfirmedAt, undefined);
    assert.equal(f.calls.filter(call => call.params?.upload_phase === 'finish').length, 1);
    assert.equal(f.calls.some(call => call.params?.published === true || call.params?.video_state === 'PUBLISHED'), false);
  });
}

test('Ready without a saved schedule is not confirmation and has bounded retries', async t => {
  const f = fixture(t, 'post', { scheduledTime: undefined }), queue = f.makeQueue();
  await queue.runJob(f.job);
  assert.equal(f.store.get(f.job.id).status, 'processing');
  assert.equal(f.store.get(f.job.id).scheduleConfirmedAt, undefined);
  await queue.runJob(f.store.get(f.job.id));
  await queue.runJob(f.store.get(f.job.id));
  assert.equal(f.store.get(f.job.id).status, 'needs_review');
  assert.equal(f.calls.filter(call => call.params?.upload_phase === 'finish').length, 1);
});

test('Mismatched schedule and incomplete processing cannot be reported safe to turn off', async t => {
  const f = fixture(t, 'reel');
  f.control.scheduledTime++;
  await f.makeQueue().runJob(f.job);
  assert.equal(f.store.get(f.job.id).status, 'needs_review');
  f.control.scheduledTime = f.at; f.control.processed = false;
  await f.makeQueue().runJob(f.store.get(f.job.id));
  assert.equal(f.store.get(f.job.id).status, 'processing');
  assert.equal(f.store.get(f.job.id).scheduleConfirmedAt, undefined);
});

test('Upload that runs too close to the deadline stops before sending finish', async t => {
  const f = fixture(t, 'story', { slowUpload: true });
  await f.makeQueue().runJob(f.job);
  assert.equal(f.store.get(f.job.id).status, 'failed');
  assert.match(f.store.get(f.job.id).error, /10 phút/);
  assert.equal(f.calls.some(call => call.params?.upload_phase === 'finish'), false);
  assert.equal(f.store.get(f.job.id).upload.phase, 'transferred');
});

test('A changed retry schedule cannot mutate the saved upload session', async t => {
  const f = fixture(t, 'post', { rejectFinish: true });
  const queue = f.makeQueue();
  await queue.runJob(f.job);
  const changed = f.store.update(f.job.id, { scheduledAt: new Date((f.at + 3600) * 1000).toISOString() });
  await queue.runJob(changed);
  assert.equal(f.store.get(f.job.id).status, 'needs_review');
  assert.equal(f.calls.filter(call => call.params?.upload_phase === 'finish').length, 1);
});

test('Legacy local schedules retain their original timing and are not uploaded early', async t => {
  const f = fixture(t), queue = f.makeQueue();
  f.store.update(f.job.id, { scheduleMode: undefined, nextAttemptAt: f.job.scheduledAt });
  await queue.tick();
  assert.equal(f.calls.length, 0);
});

test('All three API schedule types validate input without changing immediate posts', () => {
  const now = 1800000000000;
  assert.equal(publicationSchedule({}, 'post', now).scheduleMode, 'immediate');
  for (const type of ['post', 'reel', 'story']) {
    assert.equal(publicationSchedule({ scheduledAt: new Date(now + 3600000).toISOString() }, type, now).scheduleMode, 'facebook');
    for (const value of ['invalid', new Date(now - 60000).toISOString(), new Date(now + 60000).toISOString()]) {
      assert.throws(() => publicationSchedule({ scheduledAt: value }, type, now), /10 phút/);
    }
  }
  assert.throws(() => publicationSchedule({ scheduleMode: 'facebook' }, 'post', now), /Thiếu/);
  assert.throws(() => publicationSchedule({ scheduledAt: new Date(now + 3600000).toISOString() }, 'feed', now), /chỉ áp dụng/);
});

test('A completed publishing phase without published=true does not turn a schedule into a published Reel', () => {
  const normalized = FacebookApiService.normalizeVideoStatus({ published: false, scheduled_publish_time: 1800003600,
    status: { video_status: 'ready', publishing_phase: { status: 'complete' } } }, 'reel');
  assert.equal(normalized.published, false);
  assert.equal(normalized.scheduled, true);
});
