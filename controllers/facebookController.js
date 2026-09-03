const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FacebookOAuthClient } = require('../lib/facebook-oauth-client');
const { verifyLocalLicense, LICENSE_SERVER_URL } = require('../lib/license-manager');
const shared = require('../lib/shared-state');
const FacebookApiService = require('../lib/facebookApi');
const { FacebookAccountStore } = require('../lib/facebook-account-store');
const { FacebookPublishJobStore } = require('../lib/facebook-publish-job-store');
const { FacebookPublishQueue } = require('../lib/facebook-publish-queue');
const { publicationSchedule } = require('../lib/facebook-scheduling');
const { managementId, resolveManagedObjectId, facebookPermalink } = require('../lib/facebook-object-identity');

const dataDir = path.join(path.dirname(shared.RENDERS_DIR), 'facebook');
const accountStore = new FacebookAccountStore(path.join(dataDir, 'accounts.json'));
const jobStore = new FacebookPublishJobStore(path.join(dataDir, 'publish-jobs.json'));
const publishQueue = new FacebookPublishQueue({
  accountStore, jobStore, ffprobePath: shared.FFPROBE_PATH, runExecFile: shared.runExecFile
});
publishQueue.start();

let backendOAuth;
function oauthClient() {
  if (!backendOAuth) backendOAuth = new FacebookOAuthClient({
    baseUrl: process.env.FACEBOOK_OAUTH_BACKEND_URL || LICENSE_SERVER_URL,
    accountStore,
    credentials: () => {
      const license = verifyLocalLicense();
      if (!license.valid) throw new Error(license.error || 'Hãy kích hoạt bản quyền trước khi kết nối Facebook.');
      return { key: license.payload.key, hwid: license.payload.hwid };
    }
  });
  return backendOAuth;
}
const publicAccount = (account) => account && (({ accessToken, ...safe }) => safe)(account);

// Resolve old stored jobs on read, without rewriting the live queue file.
function publicJob(job) {
  return job && { ...job, platformWorkId: job.platformWorkId ? managementId(job) : null, permalink: facebookPermalink(job.permalink) };
}

function managedObjectId(account, objectId) {
  return resolveManagedObjectId(jobStore.list({ limit: Number.MAX_SAFE_INTEGER }), account, objectId);
}

function graphError(error) {
  return error?.response?.data?.error?.message || error?.message || 'Facebook API thất bại';
}

function resolveRenderPath(value) {
  if (!value) return null;
  const decoded = decodeURIComponent(String(value)).split('?')[0];
  const candidate = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(shared.RENDERS_DIR, path.basename(decoded));
  const root = `${path.resolve(shared.RENDERS_DIR)}${path.sep}`.toLowerCase();
  if (!`${candidate}${path.sep}`.toLowerCase().startsWith(root)) throw new Error('Chỉ được đăng video nằm trong thư mục renders');
  if (!fs.existsSync(candidate)) throw new Error('Không tìm thấy file video đã render');
  return candidate;
}

async function verifyAndSave(body) {
  const pageId = String(body.pageId || body.id || '').trim();
  const token = String(body.accessToken || body.pageToken || body.token || '').trim();
  if (!pageId || !token) throw new Error('Thiếu Page ID hoặc Page Access Token');
  const info = await new FacebookApiService(pageId, token).verifyPage();
  return accountStore.upsert({
    pageId: info.id || pageId, accessToken: token, name: body.name || info.name,
    pageName: info.name, avatar: info.picture?.data?.url || null, fanCount: info.fan_count,
    category: info.category, tasks: info.tasks, status: 'online'
  });
}

function enqueueFromBody(body, account) {
  const type = ['post', 'reel', 'story', 'feed'].includes(body.type) ? body.type : 'reel';
  const videoPath = type === 'feed' ? null : resolveRenderPath(body.videoPath || body.videoUrl);
  const schedule = publicationSchedule(body, type);
  const idempotencyKey = body.idempotencyKey || crypto.createHash('sha256').update([
    body.sourceRenderTaskId || videoPath || body.message || '', account.id, type, schedule.scheduledAt
  ].join('|')).digest('hex');
  return publishQueue.enqueue({
    accountId: account.id, pageId: account.pageId, type, videoPath,
    message: String(body.description || body.message || ''), title: String(body.title || ''),
    firstComment: String(body.comment || body.firstComment || ''), ...schedule,
    sourceRenderTaskId: body.sourceRenderTaskId || null, idempotencyKey
  });
}

function enqueueRenderResult(task, result) {
  const config = task?.body?.facebookPublish;
  if (!config || config.enabled !== true) return null;
  const account = accountStore.get(config.accountId || config.pageId);
  if (!account) throw new Error('Page tự động đăng sau render không còn khả dụng');
  return enqueueFromBody({
    ...config, videoPath: result?.url || result?.file,
    sourceRenderTaskId: task.id,
    idempotencyKey: `render:${task.id}:facebook:${account.id}:${config.type || 'reel'}`
  }, account);
}

const controller = {
  listAccounts: (req, res) => res.json({ accounts: accountStore.list() }),
  saveAccount: async (req, res) => {
    try { res.json({ success: true, account: await verifyAndSave(req.body || {}) }); }
    catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  importLegacyAccounts: async (req, res) => {
    const results = [];
    for (const page of Array.isArray(req.body?.accounts) ? req.body.accounts.slice(0, 100) : []) {
      try { results.push({ success: true, account: await verifyAndSave(page) }); }
      catch (error) { results.push({ success: false, pageId: page.id || page.pageId, error: graphError(error) }); }
    }
    res.json({ success: true, results, accounts: accountStore.list() });
  },
  deleteAccount: (req, res) => res.json({ success: accountStore.remove(req.params.id) }),
  verifyAccount: async (req, res) => {
    const account = accountStore.get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Không tìm thấy Page' });
    try {
      const info = await new FacebookApiService(account.pageId, account.accessToken).verifyPage();
      accountStore.markStatus(account.id, 'online');
      return res.json({ success: true, info, account: publicAccount(accountStore.get(account.id)) });
    } catch (error) {
      accountStore.markStatus(account.id, error.authRequired ? 'auth_required' : 'error', graphError(error));
      return res.status(400).json({ error: graphError(error), authRequired: error.authRequired === true });
    }
  },
  connectUserToken: async (req, res) => {
    try {
      const token = String(req.body?.userAccessToken || '').trim();
      if (!token) return res.status(400).json({ error: 'Thiếu User Access Token' });
      const pages = await FacebookApiService.listManagedPages(token);
      const accounts = pages.map((page) => accountStore.upsert({
        pageId: page.id, accessToken: page.access_token, name: page.name, pageName: page.name,
        avatar: page.picture?.data?.url, fanCount: page.fan_count, category: page.category, tasks: page.tasks
      }));
      res.json({ success: true, accounts });
    } catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  listJobs: (req, res) => res.json({ jobs: jobStore.list({ status: req.query.status, limit: req.query.limit }).map(publicJob) }),
  getJob: (req, res) => {
    const job = jobStore.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Không tìm thấy tác vụ Facebook' });
    res.json({ job: publicJob(job) });
  },
  createJob: (req, res) => {
    try {
      const account = accountStore.get(req.body?.accountId || req.body?.pageId);
      if (!account) return res.status(400).json({ error: 'Hãy chọn Page đã lưu' });
      const result = enqueueFromBody(req.body || {}, account);
      res.status(result.duplicate ? 200 : 202).json({ success: true, ...result });
    } catch (error) { res.status(400).json({ error: error.message }); }
  },
  legacyPublish: async (req, res) => {
    try {
      let account = accountStore.get(req.body?.accountId || req.body?.pageId);
      if (!account && req.body?.pageToken) account = accountStore.get((await verifyAndSave(req.body)).id);
      if (!account) return res.status(400).json({ error: 'Thiếu Page đã lưu hoặc Page Token hợp lệ' });
      const result = enqueueFromBody({ ...req.body, type: req.body.type || 'reel' }, account);
      res.status(result.duplicate ? 200 : 202).json({ success: true, queued: true, ...result });
    } catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  legacyVerify: async (req, res) => {
    try {
      const account = await verifyAndSave(req.body || {});
      res.json({ success: true, name: account.pageName || account.name, account });
    } catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  retryJob: (req, res) => {
    const job = publishQueue.retry(req.params.id);
    if (!job) return res.status(409).json({ error: 'Tác vụ không thể thử lại lúc này. Nếu mất ID phiên hoặc chưa rõ kết quả gửi bài, hãy kiểm tra trên Facebook trước khi tạo tác vụ mới.' });
    res.json({ success: true, job });
  },
  cancelJob: (req, res) => {
    const job = publishQueue.cancel(req.params.id);
    if (!job) return res.status(400).json({ error: 'Không thể hủy tác vụ này trên máy. Nếu lịch đã gửi sang Facebook, hãy kiểm tra hoặc hủy lịch trong Meta Business Suite.' });
    res.json({ success: true, job });
  },
  deletePublishedPost: async (req, res) => {
    const account = accountStore.get(req.body?.accountId);
    if (!account) return res.status(404).json({ error: 'Không tìm thấy Page' });
    try { await new FacebookApiService(account.pageId, account.accessToken).deletePost(managedObjectId(account, req.params.postId)); res.json({ success: true }); }
    catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  listComments: async (req, res) => {
    const account = accountStore.get(req.query.accountId);
    if (!account) return res.status(404).json({ error: 'Không tìm thấy Page' });
    try { res.json(await new FacebookApiService(account.pageId, account.accessToken).listComments(managedObjectId(account, req.params.postId))); }
    catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  createComment: async (req, res) => {
    const account = accountStore.get(req.body?.accountId);
    if (!account) return res.status(404).json({ error: 'Không tìm thấy Page' });
    try { res.json({ success: true, id: await new FacebookApiService(account.pageId, account.accessToken).postComment(managedObjectId(account, req.params.objectId), req.body.message) }); }
    catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  deleteComment: async (req, res) => {
    const account = accountStore.get(req.body?.accountId);
    if (!account) return res.status(404).json({ error: 'Không tìm thấy Page' });
    try { await new FacebookApiService(account.pageId, account.accessToken).deleteComment(req.params.commentId); res.json({ success: true }); }
    catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  likeObject: async (req, res) => {
    const account = accountStore.get(req.body?.accountId);
    if (!account) return res.status(404).json({ error: 'Không tìm thấy Page' });
    try {
      await new FacebookApiService(account.pageId, account.accessToken).likeObject(managedObjectId(account, req.params.objectId), req.body?.liked !== false);
      res.json({ success: true });
    } catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  insights: async (req, res) => {
    const account = accountStore.get(req.query.accountId);
    if (!account) return res.status(404).json({ error: 'Không tìm thấy Page' });
    try { res.json(await new FacebookApiService(account.pageId, account.accessToken).getInsights(managedObjectId(account, req.params.objectId), req.query.metrics)); }
    catch (error) { res.status(400).json({ error: graphError(error) }); }
  },
  oauthConfig: async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await oauthClient().config()); }
    catch (error) { res.status(503).json({ configured: false, mode: 'backend', error: error.message }); }
  },
  oauthStart: async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await oauthClient().start()); }
    catch (error) { res.status(error.status || 503).json({ error: error.message }); }
  },
  oauthStatus: async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await oauthClient().status(req.params.sessionId)); }
    catch (error) { res.status(error.status || 503).json({ status: 'error', error: error.message }); }
  },
  oauthCallback: (_req, res) => res.status(410).send('OAuth callback đã chuyển sang license server. Hãy kết nối lại từ phần mềm.'),
  accountStore, jobStore, publishQueue
};

function registerFacebookRoutes(app) {
  app.get('/api/facebook/accounts', controller.listAccounts);
  app.post('/api/facebook/accounts', controller.saveAccount);
  app.post('/api/facebook/accounts/import', controller.importLegacyAccounts);
  app.delete('/api/facebook/accounts/:id', controller.deleteAccount);
  app.post('/api/facebook/accounts/:id/verify', controller.verifyAccount);
  app.post('/api/facebook/accounts/from-user-token', controller.connectUserToken);
  app.get('/api/facebook/jobs', controller.listJobs);
  app.get('/api/facebook/jobs/:id', controller.getJob);
  app.post('/api/facebook/jobs', controller.createJob);
  app.post('/api/facebook/jobs/:id/retry', controller.retryJob);
  app.post('/api/facebook/jobs/:id/cancel', controller.cancelJob);
  app.delete('/api/facebook/posts/:postId', controller.deletePublishedPost);
  app.get('/api/facebook/posts/:postId/comments', controller.listComments);
  app.post('/api/facebook/objects/:objectId/comments', controller.createComment);
  app.delete('/api/facebook/comments/:commentId', controller.deleteComment);
  app.post('/api/facebook/objects/:objectId/like', controller.likeObject);
  app.get('/api/facebook/objects/:objectId/insights', controller.insights);
  app.get('/api/facebook/oauth/config', controller.oauthConfig);
  app.post('/api/facebook/oauth/start', controller.oauthStart);
  app.get('/api/facebook/oauth/status/:sessionId', controller.oauthStatus);
  app.get('/api/facebook/oauth/callback', controller.oauthCallback);
  app.all('/api/facebook/webhook', (_req, res) => res.sendStatus(410));
}

module.exports = { ...controller, registerFacebookRoutes, resolveRenderPath, verifyAndSave, enqueueFromBody, enqueueRenderResult };
