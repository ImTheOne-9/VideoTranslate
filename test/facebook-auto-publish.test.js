const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { resolveFacebookRenderPath } = require('../lib/facebook-render-path');
const { publicationSchedule } = require('../lib/facebook-scheduling');
const { FacebookPublishJobStore } = require('../lib/facebook-publish-job-store');
const { applyRenderTaskSuccess, createRenderQueueTask } = require('../controllers/studioController');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-auto-render-'));
  const renders = path.join(root, 'renders');
  fs.mkdirSync(renders);
  const name = 'video thử 100%.mp4', file = path.join(renders, name);
  fs.writeFileSync(file, Buffer.alloc(8));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('fb-auto-render-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, renders, name, file };
}

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

test('Render URL, encoded name and filename resolve to the same file within renders', t => {
  const f = fixture(t);
  for (const input of [f.name, encodeURIComponent(f.name), f.file, '/renders/' + encodeURIComponent(f.name), '/renders/' + encodeURIComponent(f.name) + '?v=1']) {
    assert.equal(resolveFacebookRenderPath(input, f.renders), f.file);
  }
  const numeric = 'studio_1788420411695.mp4';
  fs.writeFileSync(path.join(f.renders, numeric), 'test');
  assert.equal(resolveFacebookRenderPath('/renders/' + numeric, f.renders), path.join(f.renders, numeric));
});

test('URL mapping still rejects traversal, external paths, malformed URLs and missing files', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'outside.mp4'), 'outside');
  for (const input of ['/renders/../outside.mp4', '/renders/%2e%2e%2foutside.mp4', '/renders/%2e%2e%5coutside.mp4', '../outside.mp4', path.join(f.root, 'outside.mp4'), 'https://example.com/video.mp4', '/renders/%ZZ', '/renders/']) {
    assert.throws(() => resolveFacebookRenderPath(input, f.renders));
  }
  assert.throws(() => resolveFacebookRenderPath('missing.mp4', f.renders), /Không tìm thấy/);
  fs.mkdirSync(path.join(f.renders, 'folder'));
  assert.throws(() => resolveFacebookRenderPath('folder', f.renders), /không phải file/);
});

test('Render request snapshot reaches auto-publish queue once with the correct Page and file', t => {
  const f = fixture(t), store = new FacebookPublishJobStore(path.join(f.root, 'jobs.json'));
  const source = fs.readFileSync(path.join(__dirname, '../controllers/facebookController.js'), 'utf8').replace(/\r\n/g, '\n');
  const context = vm.createContext({ crypto, publicationSchedule,
    accountStore: { get: id => id === 'account' ? { id: 'account', pageId: '123' } : null },
    resolveRenderPath: value => resolveFacebookRenderPath(value, f.renders),
    publishQueue: { enqueue: input => store.create(input) }
  });
  vm.runInContext(extract(source, 'enqueueFromBody') + '\n' + extract(source, 'enqueueRenderResult'), context);
  const config = { enabled: true, accountId: 'account', type: 'post', message: 'Test caption' };
  const task = createRenderQueueTask({ taskId: 'test_auto_publish', body: { facebookPublish: JSON.stringify(config) }, files: {}, taskDir: f.root });
  const result = { success: true, file: f.name, url: '/renders/' + encodeURIComponent(f.name) };
  const state = {};
  applyRenderTaskSuccess(task, result, state, { enqueueRenderResult: context.enqueueRenderResult });
  assert.equal(task.status, 'success');
  assert.equal(result.facebookPublishWarning, undefined);
  const job = store.get(result.facebookPublishJobId);
  assert.equal(job.videoPath, f.file);
  assert.equal(job.type, 'post');
  assert.equal(job.accountId, 'account');
  assert.equal(job.message, config.message);
  assert.equal(job.sourceRenderTaskId, task.id);
  assert.equal(job.scheduleMode, 'immediate');
  assert.equal(job.status, 'queued');
  const replay = { success: true, url: result.url };
  applyRenderTaskSuccess(task, replay, state, { enqueueRenderResult: context.enqueueRenderResult });
  assert.equal(replay.facebookPublishJobId, job.id);
  assert.equal(store.list().length, 1);
});

test('Auto-publish failure stays visible while render succeeds, disabled tasks do not enqueue', () => {
  const task = { body: { facebookPublish: { enabled: true } } }, result = { success: true };
  applyRenderTaskSuccess(task, result, {}, { enqueueRenderResult: () => { throw new Error('Page unavailable'); } });
  assert.equal(task.status, 'success');
  assert.equal(result.facebookPublishWarning, 'Page unavailable');
  applyRenderTaskSuccess({ body: {} }, {}, {}, { enqueueRenderResult: () => { throw new Error('Must not run'); } });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\r\n/g, '\n');
  const context = vm.createContext({});
  vm.runInContext(extract(source, 'fbEscape') + '\n' + extract(source, 'renderFacebookAutoPublishSummary'), context);
  assert.match(context.renderFacebookAutoPublishSummary(result), /Page unavailable/);
  assert.doesNotMatch(context.renderFacebookAutoPublishSummary({ facebookPublishWarning: '<script>bad</script>' }), /<script>/);
  assert.match(context.renderFacebookAutoPublishSummary({ facebookPublishJobId: 'job' }), /Đã tạo tác vụ/);
  assert.equal(context.renderFacebookAutoPublishSummary({}), '');
});
