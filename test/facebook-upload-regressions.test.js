const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const vm = require('node:vm');
const FacebookApiService = require('../lib/facebookApi');
const { normalizeVideoStatus } = FacebookApiService;
const { FacebookPublishQueue } = require('../lib/facebook-publish-queue');
const { FacebookPublishJobStore } = require('../lib/facebook-publish-job-store');
const { probeMedia, validateForType } = require('../lib/facebook-media-validator');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facebook-upload-test-'));
  const file = path.join(root, 'video.mp4');
  fs.writeFileSync(file, Buffer.alloc(8, 42));
  t.after(async () => {
    await nextTurn();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('facebook-upload-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file, store: new FacebookPublishJobStore(path.join(root, 'jobs.json')) };
}

const networkError = () => Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' });
const graphError = (code, subcode, data) => ({ response: { status: 400, data: { error: { code, error_subcode: subcode, error_data: data, message: 'Graph rejected request' } } } });
const complete = (type) => ({ id: 'video-1', published: type === 'post', post_id: 'page_post', status: {
  video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' }, publishing_phase: { status: 'complete', publish_status: 'published' }
} });

async function consume(data) {
  if (!data?.on) return;
  await new Promise((resolve, reject) => { data.on('error', reject); data.on('end', resolve); data.on('data', () => {}); data.resume(); });
}

function client(handler, options = {}) {
  return new FacebookApiService('page-1', 'test-token', { ...options, http: { request: async (config) => {
    await consume(config.data);
    return { data: await handler(config) };
  } } });
}

function queueFor(f, handler, options = {}) {
  const queue = new FacebookPublishQueue({
    jobStore: f.store, accountStore: { get: () => ({ id: 'account', pageId: 'page-1', accessToken: 'test-token' }), markStatus() {} },
    probeMedia: async () => ({ size: 8, duration: 30, width: 1080, height: 1920 }),
    clientFactory: (_page, _token, config) => client(handler, config), ...options
  });
  // Keep scheduling deterministic; invoke runJob/tick explicitly in these tests.
  queue.kick = () => {};
  return queue;
}

function newJob(f, type = 'post', extra = {}) {
  return f.store.create({ accountId: 'account', type, videoPath: f.file, ...extra }).job;
}

function usualResponse(config, type = 'post') {
  const phase = config.params?.upload_phase;
  if (phase === 'start') return type === 'post'
    ? { video_id: 'video-1', upload_session_id: 'session-1', start_offset: '0', end_offset: '4' }
    : { video_id: 'video-1', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/video-1' };
  if (phase === 'transfer') return { start_offset: String(config.params.start_offset + 4), end_offset: '8' };
  if (phase === 'finish') return { success: true, ...(type === 'story' ? { post_id: 'story-post' } : {}) };
  if (config.method === 'get' && config.params?.fields.includes('status')) return complete(type);
  if (config.method === 'get') return { permalink_url: 'https://www.facebook.com/test-video' };
  return { success: true };
}

for (const type of ['post', 'reel', 'story']) {
  test(`${type}: separate endpoint, strict finish, saved session and published status`, async (t) => {
    const f = fixture(t), calls = [];
    const job = newJob(f, type);
    const queue = queueFor(f, (config) => {
      calls.push(config);
      const saved = f.store.get(job.id);
      if (config.params?.upload_phase === 'start') assert.equal(saved.upload.phase, 'starting');
      else if (config.method === 'post') assert.equal(saved.upload.videoId, 'video-1');
      if (config.params?.upload_phase === 'finish') assert.equal(saved.upload.phase, 'finishing');
      assert.equal(config.params?.content_category, undefined);
      return usualResponse(config, type);
    });
    await queue.runJob(job);
    assert.equal(f.store.get(job.id).status, 'published');
    assert.equal(f.store.get(job.id).upload.phase, 'finished');
    const finish = calls.find((c) => c.params?.upload_phase === 'finish');
    assert.ok(finish.url.endsWith(type === 'post' ? '/videos' : type === 'reel' ? '/video_reels' : '/video_stories'));
    if (type === 'post') {
      assert.equal(finish.params.published, true);
      assert.deepEqual(calls.filter((c) => c.params?.upload_phase === 'transfer').map((c) => c.params.start_offset), [0, 4]);
    }
    if (type === 'story') {
      assert.equal(f.store.get(job.id).platformWorkId, 'story-post');
      assert.equal(f.store.get(job.id).mediaId, 'video-1');
    }
  });

  test(`${type}: rejected finish is never published`, async (t) => {
    const f = fixture(t), job = newJob(f, type);
    const queue = queueFor(f, (config) => config.params?.upload_phase === 'finish' ? { success: false } : usualResponse(config, type));
    await queue.runJob(job);
    assert.equal(f.store.get(job.id).status, 'failed');
    assert.equal(f.store.get(job.id).upload.phase, 'transferred');
  });

  test(`${type}: lost finish response survives restart, only GETs afterwards`, async (t) => {
    const f = fixture(t), job = newJob(f, type), mutations = [];
    const handler = (config) => {
      if (config.method === 'post') mutations.push(config.params?.upload_phase || 'binary');
      if (config.params?.upload_phase === 'finish') throw networkError();
      return usualResponse(config, type);
    };
    await queueFor(f, handler).runJob(job);
    assert.equal(f.store.get(job.id).status, 'processing');
    assert.equal(f.store.get(job.id).upload.phase, 'finishing');
    const count = mutations.length;
    // Source file may disappear after finish; checking publication must still work.
    fs.unlinkSync(f.file);
    await queueFor(f, handler).runJob(f.store.get(job.id));
    assert.equal(mutations.length, count);
    assert.equal(f.store.get(job.id).status, 'published');
  });
}

test('Post resumes confirmed chunk after process restart without creating another session', async (t) => {
  const f = fixture(t), job = newJob(f), starts = [], offsets = [];
  let fail = true;
  const handler = (config) => {
    if (config.params?.upload_phase === 'start') starts.push(1);
    if (config.params?.upload_phase === 'transfer') {
      offsets.push(config.params.start_offset);
      if (config.params.start_offset === 4 && fail) { fail = false; throw networkError(); }
    }
    return usualResponse(config);
  };
  await queueFor(f, handler).runJob(job);
  assert.equal(f.store.get(job.id).upload.offset, 4);
  assert.equal(f.store.get(job.id).status, 'retrying');
  await queueFor(f, handler).runJob(f.store.get(job.id));
  assert.deepEqual(offsets, [0, 4, 4]);
  assert.equal(starts.length, 1);
  assert.equal(f.store.get(job.id).status, 'published');
});

test('Post recovers server-confirmed offset from subcode 1363037', async (t) => {
  const f = fixture(t), offsets = [];
  const api = client((config) => {
    if (config.params?.upload_phase === 'transfer') {
      offsets.push(config.params.start_offset);
      if (offsets.length === 1) throw graphError(100, 1363037, { start_offset: '4', end_offset: '8' });
    }
    return usualResponse(config);
  });
  await api.uploadVideoPost(f.file);
  assert.deepEqual(offsets, [0, 4]);
});

for (const bad of [{ start_offset: '8', end_offset: '8' }, { start_offset: '0', end_offset: '4' }, { start_offset: '4', end_offset: '999' }, {}]) {
  test(`Post refuses invalid transfer offsets ${JSON.stringify(bad)}`, async (t) => {
    const f = fixture(t), phases = [];
    const api = client((config) => {
      phases.push(config.params?.upload_phase);
      return config.params?.upload_phase === 'transfer' ? bad : usualResponse(config);
    });
    await assert.rejects(api.uploadVideoPost(f.file));
    assert.ok(!phases.includes('finish'));
  });
}

test('Reel transfer with unknown result checks saved video and finishes only once', async (t) => {
  const f = fixture(t), job = newJob(f, 'reel');
  let uploads = 0, starts = 0, finishes = 0;
  const handler = (config) => {
    if (config.url.includes('rupload.')) { uploads++; throw networkError(); }
    if (config.params?.upload_phase === 'start') starts++;
    if (config.params?.upload_phase === 'finish') finishes++;
    return usualResponse(config, 'reel');
  };
  await queueFor(f, handler).runJob(job);
  await queueFor(f, handler).runJob(f.store.get(job.id));
  assert.deepEqual([uploads, starts, finishes], [1, 1, 1]);
  assert.equal(f.store.get(job.id).status, 'published');
});

test('Partial binary upload pauses for review without inventing a resume offset', async (t) => {
  const f = fixture(t), job = newJob(f, 'story');
  let uploads = 0, finishes = 0;
  const handler = (config) => {
    if (config.url.includes('rupload.')) { uploads++; throw networkError(); }
    if (config.params?.upload_phase === 'finish') finishes++;
    if (config.method === 'get') return { id: 'video-1', status: { uploading_phase: { status: 'in_progress', bytes_transfered: 3 } } };
    return usualResponse(config, 'story');
  };
  const queue = queueFor(f, handler);
  await queue.runJob(job);
  await queue.runJob(f.store.get(job.id));
  assert.equal(f.store.get(job.id).status, 'needs_review');
  assert.deepEqual([uploads, finishes], [1, 0]);
});

test('Missing finish success is reconciled, never silently accepted', async (t) => {
  const f = fixture(t), job = newJob(f);
  const queue = queueFor(f, (config) => config.params?.upload_phase === 'finish' ? {} : usualResponse(config));
  await queue.runJob(job);
  assert.equal(f.store.get(job.id).status, 'processing');
  assert.equal(f.store.get(job.id).upload.phase, 'finishing');
});

test('Unknown start outcome and malformed starts cannot be retried into new sessions', async (t) => {
  const f = fixture(t);
  for (const response of [null, {}, { video_id: 'video-1' }]) {
    const job = newJob(f), queue = queueFor(f, () => { if (response === null) throw networkError(); return response; });
    await queue.runJob(job);
    assert.equal(f.store.get(job.id).status, 'needs_review');
    assert.equal(queue.retry(job.id), null);
  }
});

test('Status normalization requires publication, not ready alone', () => {
  for (const type of ['post', 'reel', 'story']) {
    assert.equal(normalizeVideoStatus({ status: { video_status: 'ready' } }, type).published, false);
    assert.equal(normalizeVideoStatus(complete(type), type).published, true);
    const pending = complete(type);
    pending.status.publishing_phase = { status: 'not_started', publish_status: 'published' };
    assert.equal(normalizeVideoStatus(pending, type).published, false);
    pending.status.publishing_phase = { status: 'error' };
    assert.equal(normalizeVideoStatus(pending, type).failed, true);
  }
  assert.equal(normalizeVideoStatus({ published: false, status: { video_status: 'ready' } }, 'post').published, false);
  assert.equal(normalizeVideoStatus({ published: true, status: { video_status: 'ready' } }, 'post').published, true);
});

test('Processing checks do not consume upload retries or block another queued job', async (t) => {
  const f = fixture(t), first = newJob(f), second = newJob(f, 'feed', { message: 'text' });
  f.store.update(first.id, { status: 'processing', platformWorkId: 'video-1', mediaId: 'video-1', attempt: 2 });
  const queue = queueFor(f, (config) => {
    if (config.method === 'get' && config.params?.fields.includes('status')) return { id: 'video-1', status: { video_status: 'ready' } };
    if (config.url.endsWith('/feed')) return { id: 'feed-1' };
    return usualResponse(config);
  }, { maxStatusChecks: 2 });
  await queue.tick();
  await queue.tick();
  assert.equal(f.store.get(second.id).status, 'published');
  assert.equal(f.store.get(first.id).attempt, 2);
  await queue.runJob(f.store.get(first.id));
  assert.equal(f.store.get(first.id).status, 'needs_review');
  assert.equal(queue.retry(first.id).status, 'processing');
  assert.equal(queue.retry(second.id), null);
});

test('Cancellation aborts HTTP upload and stream, never reaches finish or overwrites cancelled', async (t) => {
  const f = fixture(t), job = newJob(f, 'reel');
  let transferStarted, stream, aborted = false, finishes = 0;
  const started = new Promise((resolve) => { transferStarted = resolve; });
  const queue = queueFor(f, () => {}, { clientFactory: (_page, _token, config) => new FacebookApiService('page-1', 'test-token', {
    ...config, http: { request: async (request) => {
      if (request.params?.upload_phase === 'finish') finishes++;
      if (!request.url.includes('rupload.')) return { data: usualResponse(request, 'reel') };
      stream = request.data;
      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' })); }, { once: true });
        transferStarted();
      });
    } }
  }) });
  const run = queue.runJob(job);
  await started;
  queue.cancel(job.id);
  await run;
  assert.equal(aborted, true);
  assert.equal(stream.destroyed, true);
  assert.equal(finishes, 0);
  assert.equal(f.store.get(job.id).status, 'cancelled');
  assert.equal(queue.retry(job.id), null);
});

test('Cancel during status response preserves cancelled and never comments', async (t) => {
  const f = fixture(t), job = newJob(f, 'post', { firstComment: 'hello' });
  let comments = 0;
  f.store.update(job.id, { platformWorkId: 'video-1', status: 'processing' });
  const queue = queueFor(f, (config) => {
    if (config.method === 'get' && config.params?.fields.includes('status')) queue.cancel(job.id);
    if (config.url.endsWith('/comments')) comments++;
    return usualResponse(config);
  });
  await queue.runJob(f.store.get(job.id));
  assert.equal(f.store.get(job.id).status, 'cancelled');
  assert.match(f.store.get(job.id).warning, /Facebook/);
  assert.equal(comments, 0);
});

test('Interrupted first comment is not posted again after restart', async (t) => {
  const f = fixture(t), job = newJob(f, 'post', { firstComment: 'hello' });
  f.store.update(job.id, { platformWorkId: 'video-1', status: 'finalizing', commentPhase: 'sending' });
  let comments = 0;
  const queue = queueFor(f, (config) => { if (config.url.endsWith('/comments')) comments++; return usualResponse(config); });
  queue.recoverJobs();
  await queue.runJob(f.store.get(job.id));
  assert.equal(comments, 0);
  assert.equal(f.store.get(job.id).status, 'published');
  assert.match(f.store.get(job.id).warning, /Không gửi lại/);
});

test('Recovery retains unfinished uploads and protects old uploads without session IDs', (t) => {
  const f = fixture(t);
  const uploading = newJob(f), finishing = newJob(f), legacy = newJob(f);
  f.store.update(uploading.id, { status: 'uploading', upload: { phase: 'transferring', videoId: 'v1', offset: 4 } });
  f.store.update(finishing.id, { status: 'uploading', upload: { phase: 'finishing', videoId: 'v2' } });
  f.store.update(legacy.id, { status: 'failed', percent: 95 });
  queueFor(f, () => {}).recoverJobs();
  assert.equal(f.store.get(uploading.id).status, 'queued');
  assert.equal(f.store.get(finishing.id).status, 'processing');
  assert.equal(f.store.get(legacy.id).status, 'needs_review');
  f.store.removeOld(1);
  assert.equal(f.store.list().length, 3);
});

test('Idempotency survives failure and damaged store fails closed', (t) => {
  const f = fixture(t), job = newJob(f, 'post', { idempotencyKey: 'request-1' });
  f.store.update(job.id, { status: 'failed' });
  assert.equal(f.store.create({ idempotencyKey: 'request-1' }).job.id, job.id);
  fs.writeFileSync(f.store.filePath, '{broken');
  assert.throws(() => f.store.create({ idempotencyKey: 'request-1' }), /tránh đăng trùng/);
});

test('Changed media cannot resume an old upload', async (t) => {
  const f = fixture(t);
  let state;
  const api = client((config) => { if (config.params?.upload_phase === 'transfer') throw networkError(); return usualResponse(config); });
  await assert.rejects(api.uploadVideoPost(f.file, '', '', () => {}, { onCheckpoint: (s) => { state = s; } }));
  fs.appendFileSync(f.file, 'changed');
  await assert.rejects(api.uploadVideoPost(f.file, '', '', () => {}, { state }), /đã thay đổi/);
});

test('Media requires ffprobe, a video stream and a known duration', async (t) => {
  const f = fixture(t);
  await assert.rejects(probeMedia(f.file), /ffprobe/);
  const options = { ffprobePath: f.file, runExecFile: async () => ({ stdout: JSON.stringify({ format: { duration: 30 }, streams: [] }) }) };
  await assert.rejects(probeMedia(f.file, options), /luồng video/);
  options.runExecFile = async () => ({ stdout: JSON.stringify({ format: {}, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }] }) });
  await assert.rejects(probeMedia(f.file, options), /thời lượng/);
  assert.doesNotThrow(() => validateForType({ size: 8, duration: 315 }, 'post'));
  const previousReelLimit = process.env.FACEBOOK_REEL_MAX_SECONDS;
  t.after(() => {
    if (previousReelLimit === undefined) delete process.env.FACEBOOK_REEL_MAX_SECONDS;
    else process.env.FACEBOOK_REEL_MAX_SECONDS = previousReelLimit;
  });
  delete process.env.FACEBOOK_REEL_MAX_SECONDS;
  assert.doesNotThrow(() => validateForType({ size: 8, duration: 315 }, 'reel'));
  process.env.FACEBOOK_REEL_MAX_SECONDS = '0';
  assert.doesNotThrow(() => validateForType({ size: 8, duration: 315 }, 'reel'));
  process.env.FACEBOOK_REEL_MAX_SECONDS = '90';
  assert.throws(() => validateForType({ size: 8, duration: 315 }, 'reel'), /cấu hình trong phần mềm/);
  assert.throws(() => validateForType({ size: 8, duration: 0 }, 'reel'), /thời lượng/);
  assert.throws(() => validateForType({ size: 8, duration: NaN }, 'story'), /thời lượng/);
});

test('Token rejected at finish can retry same session after reconnecting', async (t) => {
  const f = fixture(t), job = newJob(f);
  let starts = 0, transfers = 0, finishes = 0;
  const queue = queueFor(f, (config) => {
    if (config.params?.upload_phase === 'start') starts++;
    if (config.params?.upload_phase === 'transfer') transfers++;
    if (config.params?.upload_phase === 'finish' && ++finishes === 1) throw graphError(190, 463);
    return usualResponse(config);
  });
  await queue.runJob(job);
  assert.equal(f.store.get(job.id).status, 'auth_required');
  assert.equal(f.store.get(job.id).upload.phase, 'transferred');
  const retried = queue.retry(job.id);
  await queue.runJob(retried);
  assert.deepEqual([starts, transfers, finishes], [1, 2, 2]);
  assert.equal(f.store.get(job.id).status, 'published');
});

test('Cannot send a finish request if its checkpoint cannot be saved', async (t) => {
  const f = fixture(t);
  let finishes = 0;
  const api = client((config) => { if (config.params?.upload_phase === 'finish') finishes++; return usualResponse(config); });
  await assert.rejects(api.uploadVideoPost(f.file, '', '', () => {}, {
    onCheckpoint(state) { if (state.phase === 'finishing') throw new Error('disk full'); }
  }), /disk full/);
  assert.equal(finishes, 0);
});

test('Cancel during validation prevents all network requests', async (t) => {
  const f = fixture(t), job = newJob(f);
  let requests = 0;
  const queue = queueFor(f, () => { requests++; }, { probeMedia: async () => {
    queue.cancel(job.id);
    return { size: 8, duration: 30 };
  } });
  await queue.runJob(job);
  assert.equal(requests, 0);
  assert.equal(f.store.get(job.id).status, 'cancelled');
});

test('UI retries a lost enqueue response with same idempotency key', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = source.indexOf('async function publishToFacebook()');
  const functionSource = source.slice(start, source.indexOf('\n}', start) + 2);
  const values = { 'fb-video-url': '/renders/test.mp4', 'fb-page-id': 'page', 'fb-page-token': '',
    'fb-description': 'caption', 'fb-comment': '', 'fb-page-select': '0', 'fb-publish-type': 'post', 'fb-scheduled-at': '' };
  const button = { disabled: false }, storage = new Map(), requests = [];
  let keys = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => id === 'fb-publish-btn' ? button : { value: values[id] } },
    fbPages: [{ id: 'account', pageId: 'page' }],
    crypto: { randomUUID: () => `request-${++keys}` },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setBusy: (target, busy) => { target.disabled = busy; }, toast() {}, loadFacebookJobs() {}, closeFbModal() {},
    fetch: async (_url, config) => {
      requests.push(JSON.parse(config.body));
      if (requests.length === 1) throw networkError();
      return { ok: true, json: async () => ({ success: true, duplicate: true }) };
    }
  });
  vm.runInContext(functionSource, context);
  await context.publishToFacebook();
  await context.publishToFacebook();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(keys, 1);
  assert.equal(storage.size, 0);
  assert.equal(button.disabled, false);
});
