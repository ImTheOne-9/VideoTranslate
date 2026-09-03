const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createFacebookOAuthRouter, digest } = require('../lib/facebook-oauth');
const { FacebookOAuthClient } = require('../../lib/facebook-oauth-client');

const secret = 'test-only-app-secret';
const pageToken = 'test-page-access-token';
const verifier = crypto.randomBytes(32).toString('base64url');
const credentials = { key: 'test-license', hwid: 'test-machine' };

function memoryStore() {
  const sessions = new Map();
  const matches = (session, filter) => Object.entries(filter).every(([key, value]) =>
    value?.$in ? value.$in.includes(session[key]) : session[key] === value);
  return {
    sessions, ready: () => true,
    count: async (owner, now) => [...sessions.values()].filter((s) => s.owner === owner && s.expiresAt > now && !['error', 'consumed'].includes(s.status)).length,
    create: async (session) => sessions.set(session._id, structuredClone(session)),
    get: async (id, now) => {
      const session = sessions.get(id);
      return session && session.expiresAt > now ? structuredClone(session) : null;
    },
    transition: async (filter, changes, now) => {
      const session = [...sessions.values()].find((s) => s.expiresAt > now && matches(s, filter));
      if (!session) return null;
      Object.assign(session, changes);
      return structuredClone(session);
    }
  };
}

async function setup(t, options = {}) {
  let time = Date.now();
  const store = options.store || memoryStore(), calls = [];
  const license = { ...credentials, status: 'active', paymentStatus: 'active', expiresAt: new Date(time + 86400000) };
  const env = { FACEBOOK_APP_ID: '123', FACEBOOK_APP_SECRET: secret,
    FACEBOOK_OAUTH_REDIRECT_URI: 'https://backend.test/api/facebook/oauth/callback',
    FACEBOOK_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'), ...options.env };
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use('/api/facebook', createFacebookOAuthRouter({ store, env, now: () => time,
    findLicense: async (key) => key === credentials.key ? license : null,
    fetchImpl: async (url, config) => {
      calls.push({ url, config });
      if (options.fetchImpl) return options.fetchImpl(url, config);
      const isPages = new URL(url).pathname.endsWith('/me/accounts');
      return { ok: true, json: async () => isPages
        ? { data: [{ id: '456', name: 'Test Page', access_token: pageToken, tasks: ['CREATE_CONTENT'] }] }
        : { access_token: 'test-user-token' } };
    }
  }));
  const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  async function request(route, data, headers = {}) {
    const res = await fetch(`${base}/api/facebook${route}`, { method: data === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  }
  const begin = async () => {
    const response = await request('/oauth/sessions', { ...credentials, challenge: digest(verifier), redirectUri: 'https://evil.test/' });
    assert.equal(response.status, 201);
    const id = response.body.sessionId;
    const opened = await request(`/oauth/authorize?sessionId=${id}`);
    assert.equal(opened.status, 302);
    const url = new URL(opened.headers.get('location'));
    const cookie = opened.headers.get('set-cookie').split(';')[0];
    return { id, state: url.searchParams.get('state'), cookie, url, opened };
  };
  const callback = (session, extra = '') => request(`/oauth/callback?state=${session.state}&code=test-code${extra}`, undefined, { Cookie: session.cookie });
  const result = (session, proof = {}) => request(`/oauth/sessions/${session.id}/result`, { ...credentials, verifier, ...proof });
  return { store, calls, license, request, begin, callback, result, advance: (ms) => { time += ms; }, base };
}

test('Backend code flow pins redirect, binds browser and delivers encrypted pages only to owner', async (t) => {
  const f = await setup(t), s = await f.begin();
  assert.equal(s.url.searchParams.get('redirect_uri'), 'https://backend.test/api/facebook/oauth/callback');
  assert.equal(s.url.searchParams.has('client_secret'), false);
  assert.match(s.opened.headers.get('set-cookie'), /HttpOnly/);
  assert.match(s.opened.headers.get('set-cookie'), /Secure/);
  assert.match(s.opened.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await f.callback(s)).status, 200);
  assert.equal(f.calls.length, 3);
  assert.ok(!JSON.stringify([...f.store.sessions.values()]).includes(pageToken));
  assert.equal((await f.result(s, { hwid: 'wrong-machine' })).status, 403);
  assert.equal((await f.result(s, { verifier: crypto.randomBytes(32).toString('base64url') })).status, 404);
  const first = await f.result(s), repeated = await f.result(s);
  assert.equal(first.body.pages[0].accessToken, pageToken);
  assert.deepEqual(repeated.body, first.body);
  const ack = await f.request(`/oauth/sessions/${s.id}/ack`, { ...credentials, verifier });
  assert.equal(ack.status, 200);
  assert.equal(f.store.sessions.get(s.id).encryptedPages, '');
  assert.equal((await f.result(s)).body.status, 'consumed');
});

test('Wrong browser, reused state and concurrent callbacks cannot exchange code twice', async (t) => {
  const f = await setup(t), s = await f.begin();
  assert.equal((await f.request(`/oauth/callback?state=${s.state}&code=test-code`)).status, 400);
  assert.equal(f.calls.length, 0);
  const responses = await Promise.all([f.callback(s), f.callback(s)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.request(`/oauth/authorize?sessionId=${s.id}`)).status, 410);
});

test('Expiry is enforced before Mongo TTL cleanup and revoked license cannot retrieve pages', async (t) => {
  const f = await setup(t), s = await f.begin();
  await f.callback(s);
  f.license.status = 'suspended';
  assert.equal((await f.result(s)).status, 403);
  f.license.status = 'active';
  f.advance(11 * 60 * 1000);
  assert.equal((await f.result(s)).status, 404);
  assert.equal((await f.callback(s)).status, 400);
});

test('Denial and provider errors are not reflected into callback HTML or tokens', async (t) => {
  const f = await setup(t), s = await f.begin();
  const denied = await f.callback(s, '&error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E');
  assert.equal(denied.status, 400);
  assert.ok(!denied.body.includes('<script>'));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.result(s)).body.status, 'error');
});

test('Unconfigured server or unavailable Mongo fails closed', async (t) => {
  const f = await setup(t, { env: { FACEBOOK_OAUTH_ENCRYPTION_KEY: '' } });
  assert.equal((await f.request('/oauth/config')).body.configured, false);
  assert.equal((await f.request('/oauth/sessions', { ...credentials, challenge: digest(verifier) })).status, 503);
  const store = memoryStore(); store.ready = () => false;
  const g = await setup(t, { store });
  assert.equal((await g.request('/oauth/config')).body.configured, false);
});

test('Expired license and invalid challenge cannot allocate sessions', async (t) => {
  const f = await setup(t);
  assert.equal((await f.request('/oauth/sessions', { ...credentials, challenge: 'short' })).status, 400);
  f.license.expiresAt = new Date(0);
  assert.equal((await f.request('/oauth/sessions', { ...credentials, challenge: digest(verifier) })).status, 403);
  assert.equal(f.store.sessions.size, 0);
});

test('Sessions can be retrieved across backend instances sharing storage', async (t) => {
  const store = memoryStore(), f = await setup(t, { store }), g = await setup(t, { store });
  const s = await f.begin();
  await g.callback(s);
  assert.equal((await f.result(s)).body.pages[0].pageId, '456');
});

test('Desktop saves encrypted-account inputs before ACK and never sends Page tokens to UI', async (t) => {
  const f = await setup(t), saved = new Map();
  let loseResult = true, saves = 0;
  const client = new FacebookOAuthClient({ baseUrl: 'https://backend.test', credentials: () => credentials,
    accountStore: { upsert: (page) => { saves++; saved.set(page.pageId, page.accessToken); return { id: page.pageId, name: page.name, tokenStored: true }; } },
    http: { request: async (config) => {
      const route = new URL(config.url).pathname.replace('/api/facebook', '');
      const response = await f.request(route, config.method === 'get' ? undefined : config.data);
      if (route.endsWith('/ack')) assert.equal(saved.get('456'), pageToken);
      if (route.endsWith('/result') && response.body.status === 'ready' && loseResult) { loseResult = false; throw new Error('lost network response'); }
      if (response.status >= 400) throw { response: { status: response.status } };
      return { data: response.body };
    } }
  });
  assert.equal((await client.config()).configured, true);
  const started = await client.start(), id = new URL(started.url).searchParams.get('sessionId');
  assert.ok(!('verifier' in started));
  const opened = await f.request(`/oauth/authorize?sessionId=${id}`);
  await f.callback({ state: new URL(opened.headers.get('location')).searchParams.get('state'), cookie: opened.headers.get('set-cookie').split(';')[0] });
  assert.equal((await client.status(started.sessionId)).status, 'waiting');
  const results = await Promise.all([client.status(started.sessionId), client.status(started.sessionId)]);
  assert.equal(results[0].status, 'success');
  assert.equal(JSON.stringify(results).includes(pageToken), false);
  assert.equal(saves, 1);
  assert.equal(f.store.sessions.get(id).status, 'consumed');
  assert.equal(f.store.sessions.get(id).encryptedPages, '');
});

test('Failed local save keeps backend result available and ACK waits for a successful retry', async (t) => {
  const f = await setup(t);
  let failSave = true, acknowledgements = 0;
  const client = new FacebookOAuthClient({ baseUrl: 'https://backend.test', credentials: () => credentials,
    accountStore: { upsert: (page) => {
      if (failSave) throw new Error('Disk unavailable');
      return { id: page.pageId, name: page.name };
    } },
    http: { request: async (config) => {
      const route = new URL(config.url).pathname.replace('/api/facebook', '');
      if (route.endsWith('/ack')) acknowledgements++;
      const response = await f.request(route, config.data);
      if (response.status >= 400) throw { response: { status: response.status } };
      return { data: response.body };
    } }
  });
  const started = await client.start(), id = new URL(started.url).searchParams.get('sessionId');
  const opened = await f.request(`/oauth/authorize?sessionId=${id}`);
  await f.callback({ state: new URL(opened.headers.get('location')).searchParams.get('state'), cookie: opened.headers.get('set-cookie').split(';')[0] });
  await assert.rejects(client.status(started.sessionId), /Disk unavailable/);
  assert.equal(acknowledgements, 0);
  assert.ok(f.store.sessions.get(id).encryptedPages);
  failSave = false;
  assert.equal((await client.status(started.sessionId)).status, 'success');
  assert.equal(acknowledgements, 1);
  assert.equal(f.store.sessions.get(id).encryptedPages, '');
});

test('Desktop rejects a backend redirect to an unrelated host', async () => {
  const client = new FacebookOAuthClient({ baseUrl: 'https://backend.test', credentials: () => credentials, accountStore: {},
    http: { request: async () => ({ data: { sessionId: verifier, url: `https://evil.test/api/facebook/oauth/authorize?sessionId=${verifier}`, expiresAt: new Date(Date.now() + 600000).toISOString() } }) } });
  await assert.rejects(client.start(), /không hợp lệ/);
  assert.throws(() => new FacebookOAuthClient({ baseUrl: 'http://backend.test' }), /HTTPS/);
});

test('Webhook signature is verified on backend', async (t) => {
  const f = await setup(t), body = { object: 'page', entry: [] };
  assert.equal((await f.request('/webhook', body)).status, 403);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`;
  assert.equal((await f.request('/webhook', body, { 'X-Hub-Signature-256': signature })).status, 200);
});
