const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\r\n/g, '\n');
const manager = source.slice(source.indexOf('function closeFacebookPostManager()'), source.indexOf('async function initFbPages()'));
const escapeFunction = source.slice(source.indexOf('function fbEscape('), source.indexOf('async function loadFbPages('));

test('Facebook manager interactions in an isolated browser (no live API)', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function setup() {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<div id="facebook-post-manager-modal"><div id="facebook-post-insights"></div><input id="facebook-post-comment-input"><div id="facebook-post-comments"></div></div>');
    await page.addScriptTag({ content: `
      const $ = id => document.getElementById(id);
      const notices = [];
      const toast = (...args) => notices.push(args);
      const fbPages = [{ id: 'account', name: 'Video hay' }];
      const facebookLoadedJobs = [{ id: 'job', accountId: 'account', platformWorkId: '123_456' }];
      let activeFacebookManageJob = facebookLoadedJobs[0];
      let facebookManagerSession = 1;
      let facebookManagerComments = new Map();
      window.prompt = () => { throw new Error('prompt() is not supported'); };
      window.calls = [];
      window.fetch = (url, options) => {
        calls.push({ url, options });
        return new Promise(resolve => { window.finishRequest = (data, ok = true) => resolve({ok, json: async () => data}); });
      };
      ${escapeFunction}
      ${manager}
      renderFacebookManagerComments([{id:'456_789', message:'Bình luận gốc', from:{name:'Người xem'}, like_count:2, user_likes:false}]);
    ` });
    return page;
  }
  await t.test('Like updates immediately after success, ignores double click, and supports unlike', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => { window.pending = likeFacebookManagerObject('456_789'); likeFacebookManagerObject('456_789'); });
      assert.equal(await page.evaluate(() => calls.length), 1);
      assert.equal(await page.locator('#fb-comment-likes-456_789').textContent(), '2');
      assert.equal(await page.locator('#fb-comment-like-456_789').isDisabled(), true);
      await page.evaluate(async () => { finishRequest({success:true}); await pending; });
      assert.equal(await page.locator('#fb-comment-likes-456_789').textContent(), '3');
      assert.equal(await page.locator('#fb-comment-like-456_789').textContent(), 'Bỏ thích');
      await page.evaluate(() => { window.pending = likeFacebookManagerObject('456_789'); });
      assert.equal(await page.evaluate(() => JSON.parse(calls[1].options.body).liked), false);
      await page.evaluate(async () => { finishRequest({success:true}); await pending; });
      assert.equal(await page.locator('#fb-comment-likes-456_789').textContent(), '2');
    } finally { await page.close(); }
  });
  await t.test('Failed likes keep the count and re-enable the button', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => { window.pending = likeFacebookManagerObject('456_789'); });
      await page.evaluate(async () => { finishRequest({success:false,error:'Không đủ quyền'}); await pending; });
      assert.equal(await page.locator('#fb-comment-likes-456_789').textContent(), '2');
      assert.equal(await page.locator('#fb-comment-like-456_789').isDisabled(), false);
      assert.equal(await page.evaluate(() => notices.at(-1)[0]), 'Không đủ quyền');
    } finally { await page.close(); }
  });
  await t.test('Inline reply targets the comment, prevents duplicates, and renders escaped text', async () => {
    const page = await setup();
    try {
      await page.getByRole('button', {name:'Trả lời',exact:true}).click();
      await page.locator('#fb-comment-input-456_789').fill(' Cảm ơn <img src=x onerror=alert(1)> ');
      await page.evaluate(() => { window.pending = sendFacebookReply('456_789'); sendFacebookReply('456_789'); });
      const calls = await page.evaluate(() => window.calls);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, '/api/facebook/objects/456_789/comments');
      assert.deepEqual(JSON.parse(calls[0].options.body), {accountId:'account',message:'Cảm ơn <img src=x onerror=alert(1)>'});
      await page.evaluate(async () => { finishRequest({success:true,id:'reply-id'}); await pending; });
      assert.match(await page.locator('#fb-comment-replies-456_789').textContent(), /Cảm ơn <img/);
      assert.equal(await page.locator('#fb-comment-replies-456_789 img').count(), 0);
      assert.equal(await page.locator('#fb-comment-input-456_789').inputValue(), '');
      assert.equal(await page.locator('#fb-comment-editor-456_789').isHidden(), true);
    } finally { await page.close(); }
  });
  await t.test('Failed reply preserves its draft and a missing ID is not reported as success', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => replyFacebookComment('456_789'));
      await page.locator('#fb-comment-input-456_789').fill('Giữ nội dung');
      for (const response of [{success:false,error:'Lỗi mạng'}, {success:true}]) {
        await page.evaluate(() => { window.pending = sendFacebookReply('456_789'); });
        await page.evaluate(async (data) => { finishRequest(data); await pending; }, response);
        assert.equal(await page.locator('#fb-comment-input-456_789').inputValue(), 'Giữ nội dung');
        assert.equal(await page.locator('#fb-comment-input-456_789').isDisabled(), false);
        assert.equal(await page.locator('.facebook-comment-reply').count(), 0);
        assert.equal(await page.evaluate(() => notices.at(-1)[1]), 'error');
      }
    } finally { await page.close(); }
  });
  await t.test('Late mutation response cannot change a newly opened manager', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => {
        window.pending = likeFacebookManagerObject('456_789');
        closeFacebookPostManager();
        activeFacebookManageJob = facebookLoadedJobs[0];
        renderFacebookManagerComments([{id:'456_789',like_count:10,user_likes:false}]);
      });
      await page.evaluate(async () => { finishRequest({success:true}); await pending; });
      assert.equal(await page.locator('#fb-comment-likes-456_789').textContent(), '10');
      assert.equal(await page.evaluate(() => notices.length), 0);
    } finally { await page.close(); }
  });
});
