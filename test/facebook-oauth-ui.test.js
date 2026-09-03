const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`${name}(`);
  const line = source.lastIndexOf('\n', start) + 1;
  return source.slice(line, source.indexOf('\n}', start) + 2);
}

function setup(t, statusRequest) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const button = { textContent: 'KẾT NỐI FACEBOOK', dataset: {}, disabled: false };
  const popup = { closed: false, location: {}, close() { this.closed = true; } };
  const messages = [];
  let loads = 0, statusCalls = 0;
  const response = (data, ok = true) => ({ ok, json: async () => data });
  const context = vm.createContext({
    $, window: { open: () => popup }, AbortController, Date,
    setInterval, clearInterval, setTimeout, clearTimeout,
    toast: (message, type) => messages.push({ message, type }),
    loadFbPages: async () => { loads++; }, renderFbPages() {},
    fetch: async (url, options) => {
      if (url.endsWith('/config')) return response({ configured: true });
      if (url.endsWith('/start')) return response({ sessionId: 'test-session', url: 'https://backend.test/authorize', expiresAt: new Date(Date.now() + 600000).toISOString() });
      statusCalls++;
      return statusRequest({ options, response, popup });
    }
  });
  function $() { return button; }
  vm.runInContext(`${extract('function setBusy')}\n${extract('async function connectFacebookOAuth')}`, context);
  return { context, popup, button, messages, loads: () => loads, calls: () => statusCalls,
    tick: async (ms = 0) => { t.mock.timers.tick(ms); await new Promise(setImmediate); } };
}

test('Closing popup aborts a stalled status request and restores the connect button', async (t) => {
  let aborted = false;
  const f = setup(t, ({ options }) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  const running = f.context.connectFacebookOAuth();
  await f.tick();
  assert.match(f.button.textContent, /Đang chờ/);
  await f.tick(1500);
  assert.equal(f.calls(), 1);
  f.popup.closed = true;
  await f.tick(250);
  await f.tick(5000);
  await running;
  assert.equal(aborted, true);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.textContent, 'KẾT NỐI FACEBOOK');
  assert.equal(f.messages.at(-1).type, 'info');
  assert.equal(f.loads(), 0);
});

test('Callback completed just before popup closure still loads Pages and reports success', async (t) => {
  const f = setup(t, ({ response }) => response({ status: 'success', accounts: [{ id: 'page' }] }));
  const running = f.context.connectFacebookOAuth();
  await f.tick();
  f.popup.closed = true;
  await f.tick(1500);
  await running;
  assert.equal(f.loads(), 1);
  assert.equal(f.messages.at(-1).type, 'success');
  assert.equal(f.button.disabled, false);
  await f.tick(6000);
  assert.equal(f.button.textContent, 'KẾT NỐI FACEBOOK');
});

test('HTTP failure exits polling instead of leaving the button busy for ten minutes', async (t) => {
  const f = setup(t, ({ response }) => response({ error: 'Backend unavailable' }, false));
  const running = f.context.connectFacebookOAuth();
  await f.tick();
  await f.tick(1500);
  await running;
  assert.equal(f.messages.at(-1).message, 'Backend unavailable');
  assert.equal(f.button.disabled, false);
  assert.equal(f.popup.closed, true);
});

test('A stalled request times out even while the popup remains open', async (t) => {
  const f = setup(t, ({ options }) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const running = f.context.connectFacebookOAuth();
  await f.tick();
  await f.tick(1500);
  await f.tick(45000);
  await running;
  assert.match(f.messages.at(-1).message, /phản hồi quá lâu/);
  assert.equal(f.button.disabled, false);
});
