const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\r\n/g, '\n');
const functions = source.slice(source.indexOf('function facebookScheduleLocalValue('), source.indexOf('// ==========================================\n// QUẢN LÝ DANH SÁCH FANPAGE', source.indexOf('function facebookScheduleLocalValue(')));

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-03T16:55:00Z').getTime() });
  const elements = {}, messages = [], requests = [];
  for (const id of ['fb-schedule-now', 'fb-schedule-later', 'fb-schedule-date', 'fb-schedule-time', 'fb-schedule-details', 'fb-schedule-note', 'fb-scheduled-at', 'fb-schedule-summary', 'fb-schedule-timezone', 'fb-publish-btn', 'fb-video-url', 'fb-page-id', 'fb-page-token', 'fb-description', 'fb-comment', 'fb-page-select', 'fb-publish-type']) {
    elements[id] = { value: '', checked: false, disabled: false, textContent: '', classList: { toggle() {} } };
  }
  elements['fb-video-url'].value = '/renders/test.mp4';
  elements['fb-page-select'].value = '0';
  const context = vm.createContext({ Date, Intl, $, document: { getElementById: $ }, fbPages: [{ id: 'account', pageId: '123' }],
    toast: message => messages.push(message), setBusy: (button, busy) => { button.disabled = busy; },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'test-key' },
    fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({}) }; },
    loadFacebookJobs() {}, closeFbModal() {}
  });
  function $(id) { return elements[id]; }
  vm.runInContext(functions, context);
  return { context, elements, requests, messages };
}

test('Switching back to immediate clears the scheduled payload', async t => {
  const f = fixture(t);
  f.context.setFacebookScheduleMode('later');
  assert.ok(f.elements['fb-scheduled-at'].value);
  f.context.setFacebookScheduleMode('now');
  assert.equal(f.elements['fb-scheduled-at'].value, '');
  await f.context.publishToFacebook();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].scheduledAt, undefined);
});

test('Quick preset sends the chosen local time as the correct UTC instant', async t => {
  const f = fixture(t);
  f.context.setFacebookScheduleMode('later');
  f.context.chooseFacebookSchedule('15m');
  await f.context.publishToFacebook();
  assert.equal(f.requests[0].scheduledAt, new Date(Date.now() + 15 * 60000).toISOString());
  f.context.chooseFacebookSchedule('tomorrow');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  assert.equal(new Date(f.elements['fb-scheduled-at'].value).getTime(), tomorrow.getTime());
});

test('Incomplete and past schedules cannot silently enqueue an immediate post', async t => {
  const f = fixture(t);
  f.context.setFacebookScheduleMode('later');
  f.elements['fb-schedule-time'].value = '';
  f.context.updateFacebookSchedule();
  await f.context.publishToFacebook();
  assert.match(f.messages.at(-1), /đầy đủ/);
  f.elements['fb-schedule-date'].value = '2020-01-01';
  f.elements['fb-schedule-time'].value = '09:00';
  f.context.updateFacebookSchedule();
  await f.context.publishToFacebook();
  assert.match(f.messages.at(-1), /tương lai/);
  assert.equal(f.requests.length, 0);
});

test('A schedule that expires while the modal is open is rejected on submit', async t => {
  const f = fixture(t);
  f.context.setFacebookScheduleMode('later');
  f.context.chooseFacebookSchedule('15m');
  t.mock.timers.tick(16 * 60000);
  await f.context.publishToFacebook();
  assert.equal(f.requests.length, 0);
  assert.match(f.messages.at(-1), /tương lai/);
});
