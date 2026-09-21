const test = require('node:test');
const assert = require('node:assert/strict');
const FacebookApiService = require('../lib/facebookApi');

test('exchangeUserToken sends the documented form and normalizes expiry', async () => {
  let request;
  const before = Date.now();
  const result = await FacebookApiService.exchangeUserToken('123456789012345', 'app-secret', 'short-token', {
    http: { request: async (config) => {
      request = config;
      return { data: { access_token: 'long-token', token_type: 'bearer', expires_in: 5184000 } };
    } }
  });
  assert.equal(request.method, 'post');
  assert.match(request.url, /\/oauth\/access_token$/);
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(request.data);
  assert.equal(body.get('grant_type'), 'fb_exchange_token');
  assert.equal(body.get('client_id'), '123456789012345');
  assert.equal(body.get('client_secret'), 'app-secret');
  assert.equal(body.get('fb_exchange_token'), 'short-token');
  assert.equal(result.accessToken, 'long-token');
  assert.equal(result.expiresIn, 5184000);
  assert.ok(new Date(result.expiresAt).getTime() >= before + 5184000 * 1000);
});

test('exchangeUserToken rejects malformed input before any network request', async () => {
  let calls = 0;
  const http = { request: async () => { calls += 1; return { data: {} }; } };
  await assert.rejects(() => FacebookApiService.exchangeUserToken('not-an-id', 'secret', 'token', { http }), /App ID không hợp lệ/);
  await assert.rejects(() => FacebookApiService.exchangeUserToken('123456', '', 'token', { http }), /App Secret không hợp lệ/);
  await assert.rejects(() => FacebookApiService.exchangeUserToken('123456', 'secret', '', { http }), /User Access Token không hợp lệ/);
  assert.equal(calls, 0);
});

test('exchangeUserToken rejects a Meta response without a token', async () => {
  const http = { request: async () => ({ data: { expires_in: 5184000 } }) };
  await assert.rejects(() => FacebookApiService.exchangeUserToken('123456', 'secret', 'short', { http }), /không trả User Access Token dài hạn/);
});
