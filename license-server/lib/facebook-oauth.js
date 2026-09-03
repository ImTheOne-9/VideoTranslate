const crypto = require('node:crypto');
const express = require('express');

const SCOPES = ['public_profile', 'pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'read_insights'];
const digest = (value) => crypto.createHash('sha256').update(value).digest('base64url');
const random = () => crypto.randomBytes(32).toString('base64url');
const tokenFormat = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });

function getConfig(env) {
  try {
    const redirect = new URL(env.FACEBOOK_OAUTH_REDIRECT_URI);
    const encryptionKey = Buffer.from(env.FACEBOOK_OAUTH_ENCRYPTION_KEY || '', 'base64');
    const apiVersion = env.FACEBOOK_GRAPH_API_VERSION || 'v25.0';
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/api/facebook/oauth/callback') return null;
    if (!/^[0-9]+$/.test(env.FACEBOOK_APP_ID || '') || !env.FACEBOOK_APP_SECRET || encryptionKey.length !== 32 || !/^v[0-9]+\.0$/.test(apiVersion)) return null;
    return { appId: env.FACEBOOK_APP_ID, appSecret: env.FACEBOOK_APP_SECRET, redirectUri: redirect.href,
      origin: redirect.origin, encryptionKey, apiVersion, configId: env.FACEBOOK_LOGIN_CONFIG_ID || '' };
  } catch { return null; }
}

function encrypt(value, key, sessionId) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(sessionId));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}

function decrypt(value, key, sessionId) {
  const bytes = Buffer.from(value, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(sessionId));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
}

function createFacebookOAuthRouter({ store, findLicense, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const router = express.Router();
  const config = getConfig(env);
  const lifetimeMs = 10 * 60 * 1000;
  const cookieName = (id) => `__Host-fb-oauth-${id}`;
  const limits = new Map();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
    const timestamp = now(), key = req.ip || req.socket?.remoteAddress || 'unknown';
    for (const [id, entry] of limits) if (entry.until <= timestamp) limits.delete(id);
    let entry = limits.get(key);
    if (!entry) {
      if (limits.size >= 10000) return res.status(429).json({ error: 'Máy chủ đang bận, vui lòng thử lại sau.' });
      entry = { count: 0, until: timestamp + 60000 }; limits.set(key, entry);
    }
    if (++entry.count > 120) return res.status(429).json({ error: 'Quá nhiều yêu cầu kết nối, vui lòng thử lại sau.' });
    next();
  });
  const route = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Máy chủ kết nối Facebook tạm thời không khả dụng.' }); }
  };
  const requireReady = () => {
    if (!config || !store.ready()) throw failure(503, 'Máy chủ chưa cấu hình đầy đủ Facebook OAuth hoặc MongoDB chưa sẵn sàng.');
  };
  async function owner(req) {
    requireReady();
    const { key, hwid } = req.body || {};
    if (typeof key !== 'string' || key.length > 256 || typeof hwid !== 'string' || hwid.length > 256 || !key || !hwid) throw failure(401, 'Thiếu thông tin bản quyền thiết bị.');
    const license = await findLicense(key);
    const expires = new Date(license?.expiresAt).getTime();
    if (!license || license.status !== 'active' || license.paymentStatus !== 'active' || !Number.isFinite(expires) || expires <= now() || license.hwid !== hwid) {
      throw failure(403, 'Bản quyền đã hết hạn, bị khóa hoặc không thuộc thiết bị này.');
    }
    return digest(`${key}\0${hwid}`);
  }
  async function ownedSession(req) {
    const ownerId = await owner(req), verifier = req.body?.verifier;
    if (!tokenFormat(verifier) || !tokenFormat(req.params.id)) throw failure(404, 'Không tìm thấy phiên kết nối.');
    const session = await store.get(req.params.id, now());
    if (!session || session.owner !== ownerId || session.challenge !== digest(verifier)) throw failure(404, 'Phiên kết nối không hợp lệ hoặc đã hết hạn.');
    return session;
  }
  async function graph(endpoint, params, accessToken) {
    const url = new URL(`https://graph.facebook.com/${config.apiVersion}/${endpoint}`);
    // Never follow pagination URLs supplied by an external response with a token.
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetchImpl(url.href, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, redirect: 'error', signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || data.error) throw failure(502, 'Facebook từ chối kết nối. Vui lòng thử lại và kiểm tra quyền quản lý Page.');
    return data;
  }
  async function loadPages(code) {
    const token = await graph('oauth/access_token', { client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code });
    if (!token.access_token) throw failure(502, 'Facebook không trả token đăng nhập.');
    const extended = await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.appSecret, fb_exchange_token: token.access_token });
    if (!extended.access_token) throw failure(502, 'Facebook không trả token mở rộng.');
    const pages = [], seen = new Set();
    let after;
    for (let index = 0; index < 20; index++) {
      const data = await graph('me/accounts', { fields: 'id,name,access_token,picture{url},fan_count,category,tasks', limit: '100',
        appsecret_proof: crypto.createHmac('sha256', config.appSecret).update(extended.access_token).digest('hex'), ...(after ? { after } : {}) }, extended.access_token);
      if (!Array.isArray(data.data)) throw failure(502, 'Facebook trả danh sách Page không hợp lệ.');
      for (const page of data.data) if (page.id && page.access_token && !seen.has(String(page.id))) {
        seen.add(String(page.id));
        pages.push({ pageId: String(page.id), accessToken: page.access_token, name: page.name, pageName: page.name,
          avatar: page.picture?.data?.url || null, fanCount: page.fan_count, category: page.category, tasks: page.tasks });
      }
      if (!data.paging?.next) return pages;
      const cursor = data.paging?.cursors?.after;
      if (!cursor || cursor === after) throw failure(502, 'Không đọc hết danh sách Page. Vui lòng kết nối lại.');
      after = cursor;
    }
    throw failure(502, 'Danh sách Page vượt phạm vi một phiên kết nối.');
  }

  router.get('/oauth/config', (_req, res) => res.json({ configured: Boolean(config && store.ready()), mode: 'backend', scopes: SCOPES }));
  router.post('/oauth/sessions', route(async (req, res) => {
    const ownerId = await owner(req), challenge = req.body?.challenge;
    if (!tokenFormat(challenge)) throw failure(400, 'Thiếu mã xác nhận phiên của máy khách.');
    if (await store.count(ownerId, now()) >= 5) throw failure(429, 'Đã có nhiều phiên kết nối. Hãy hoàn tất phiên trước hoặc đợi 10 phút.');
    const id = random(), state = random(), expiresAt = new Date(now() + lifetimeMs);
    await store.create({ _id: id, owner: ownerId, challenge, state, status: 'waiting', expiresAt, createdAt: new Date(now()) });
    res.status(201).json({ sessionId: id, url: `${config.origin}/api/facebook/oauth/authorize?sessionId=${id}`, expiresAt });
  }));
  router.get('/oauth/authorize', route(async (req, res) => {
    requireReady();
    if (!tokenFormat(req.query.sessionId)) throw failure(400, 'Phiên đăng nhập không hợp lệ.');
    const browserSecret = random();
    const session = await store.transition({ _id: req.query.sessionId, status: 'waiting' }, { status: 'authorizing', browserHash: digest(browserSecret) }, now());
    if (!session) throw failure(410, 'Liên kết đã được mở hoặc hết hạn. Hãy kết nối lại từ phần mềm.');
    res.cookie(cookieName(session._id), browserSecret, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: lifetimeMs });
    const params = new URLSearchParams({ client_id: config.appId, redirect_uri: config.redirectUri, state: session.state, response_type: 'code',
      ...(config.configId ? { config_id: config.configId } : { scope: SCOPES.join(',') }) });
    res.redirect(302, `https://www.facebook.com/${config.apiVersion}/dialog/oauth?${params}`);
  }));
  router.get('/oauth/callback', route(async (req, res) => {
    requireReady();
    if (!tokenFormat(req.query.state)) throw failure(400, 'Kết quả đăng nhập không hợp lệ.');
    // Browser proof and state must match atomically before the code is exchanged.
    const cookies = String(req.headers.cookie || '').split(';').map((part) => part.trim().split('='));
    const candidates = cookies.filter(([name, value]) => name.startsWith('__Host-fb-oauth-') && tokenFormat(value));
    let session;
    for (const [name, value] of candidates.slice(0, 10)) {
      const id = name.slice('__Host-fb-oauth-'.length);
      if (!tokenFormat(id)) continue;
      session = await store.transition({ _id: id, state: req.query.state, browserHash: digest(value), status: 'authorizing' }, { status: 'exchanging', browserHash: '' }, now());
      if (session) break;
    }
    if (!session) throw failure(400, 'Phiên đăng nhập không hợp lệ, đã dùng hoặc đã hết hạn.');
    res.clearCookie(cookieName(session._id), { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    let error;
    if (req.query.error) error = 'Bạn đã hủy hoặc từ chối cấp quyền Facebook.';
    else if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 8192) error = 'Facebook không trả mã đăng nhập hợp lệ.';
    else {
      try {
        const pages = await loadPages(req.query.code);
        if (!pages.length) throw failure(400, 'Không tìm thấy Page được cấp quyền. Hãy kiểm tra tài khoản Facebook và quyền đã chọn.');
        const saved = await store.transition({ _id: session._id, status: 'exchanging' }, { status: 'ready', encryptedPages: encrypt(pages, config.encryptionKey, session._id) }, now());
        if (!saved) throw failure(410, 'Phiên đã hết hạn. Hãy kết nối lại từ phần mềm.');
      } catch (err) { error = err.status ? err.message : 'Không hoàn tất được kết nối Facebook. Hãy thử lại từ phần mềm.'; }
    }
    if (error) await store.transition({ _id: session._id, status: 'exchanging' }, { status: 'error', error, encryptedPages: '' }, now());
    // Fixed text only: never echo OAuth code, provider errors, tokens, or state.
    res.status(error ? 400 : 200).type('html').send(`<!doctype html><html lang="vi"><meta charset="utf-8"><title>Kết nối Facebook</title><body><h2>${error ? 'Chưa hoàn tất kết nối Facebook' : 'Đã kết nối Facebook'}</h2><p>${error ? 'Quay lại phần mềm để xem thông báo và thử lại.' : 'Quay lại phần mềm để nhận danh sách Page. Bạn có thể đóng tab này.'}</p></body></html>`);
  }));
  router.post('/oauth/sessions/:id/result', route(async (req, res) => {
    let session = await ownedSession(req);
    if (session.status === 'consumed') return res.json({ status: 'consumed' });
    if (session.status === 'error') return res.json({ status: 'error', error: session.error });
    if (!['ready', 'delivered'].includes(session.status)) return res.json({ status: 'waiting' });
    session = await store.transition({ _id: session._id, owner: session.owner, challenge: session.challenge, status: { $in: ['ready', 'delivered'] } }, { status: 'delivered' }, now());
    if (!session) return res.json({ status: 'consumed' });
    // Same authenticated machine may retry delivery after a lost response until ACK.
    res.json({ status: 'ready', pages: decrypt(session.encryptedPages, config.encryptionKey, session._id) });
  }));
  router.post('/oauth/sessions/:id/ack', route(async (req, res) => {
    const session = await ownedSession(req);
    if (session.status !== 'consumed') {
      const consumed = await store.transition({ _id: session._id, status: 'delivered', owner: session.owner, challenge: session.challenge }, { status: 'consumed', encryptedPages: '' }, now());
      if (!consumed) throw failure(409, 'Chưa có kết quả kết nối để xác nhận.');
    }
    res.json({ success: true });
  }));

  // Local publisher polls Graph status; webhook receipt needs no token relay.
  router.get('/webhook', (req, res) => {
    if (env.FACEBOOK_WEBHOOK_VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.FACEBOOK_WEBHOOK_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  router.post('/webhook', (req, res) => {
    if (!config || !Buffer.isBuffer(req.rawBody)) return res.sendStatus(403);
    const signature = String(req.get('X-Hub-Signature-256') || '');
    const expected = `sha256=${crypto.createHmac('sha256', config.appSecret).update(req.rawBody).digest('hex')}`;
    const a = Buffer.from(signature), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(403);
    res.sendStatus(200);
  });
  return router;
}

module.exports = { createFacebookOAuthRouter, getConfig, encrypt, decrypt, digest };
