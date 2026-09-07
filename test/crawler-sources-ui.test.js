const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('source discovery and catalog work in isolated browser without live accounts', async (t) => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.setContent(`<button id="source-discovery-run"></button><div id="source-discovery-results"></div>
    <textarea id="source-discovery-keywords">cats</textarea><input name="source-discovery-platform" value="youtube" type="checkbox" checked>
    <input id="source-discovery-count" value="20"><input id="source-discovery-min" value="0">`);
  await page.addScriptTag({ content: `
    window.calls = []; window.toast = () => {}; window.crawlStartPolling = () => {};
    window.fetch = async (url, options) => {
      calls.push({url, body: options.body ? JSON.parse(options.body) : null});
      if (url.endsWith('/discover')) return {ok:true,json:async()=>({channels:[{platform:'youtube',url:'https://www.youtube.com/@demo',name:'<img src=x onerror=alert(1)>',videoCount:20}], errors:[]})};
      if (options.method === 'GET') return {ok:true,json:async()=>({channels:[{id:'c1',name:'Demo',url:'https://www.youtube.com/@demo',platform:'youtube',newCount:1,
        schedule:{enabled:true,time:'02:00',dailyCount:3},lists:[{name:'Set A',ids:['v2']}], videos:[{id:'v1',title:'Old',url:'https://example.com/1'},{id:'v2',title:'New',isNew:true,seen:false,url:'https://example.com/2'}]}]})};
      return {ok:true,json:async()=>({created:1})};
    };` });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../public/js/crawl-sources.js'), 'utf8') });
  await page.evaluate(() => crawlDiscoverSources());
  assert.equal(await page.locator('[data-discovered-source]').count(), 1);
  assert.equal(await page.locator('#source-discovery-results img').count(), 0);
  await page.evaluate(() => crawlSaveDiscoveredSources());
  assert.equal(await page.locator('#crawl-source-dialog').isVisible(), true);
  await page.locator('#crawl-source-dialog summary').click();
  await page.locator('[data-source-action="load"]').click();
  assert.equal(await page.locator('[data-video-index="0"]').isChecked(), false);
  assert.equal(await page.locator('[data-video-index="1"]').isChecked(), true);
  await page.locator('[data-source-action="download"]').click();
  assert.deepEqual(await page.evaluate(() => calls.find((call) => call.url.endsWith('/selected')).body.ids), ['v2']);
  await page.locator('[data-source-action="schedule"]').click();
  assert.equal(await page.evaluate(() => calls.find((call) => call.url.endsWith('/schedule')).body.time), '02:00');
});
