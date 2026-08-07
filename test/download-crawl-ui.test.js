const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('server exposes the complete crawl-now API surface', () => {
  const server = read('server.js');
  for (const route of [
    '/api/download-crawl/capabilities',
    '/api/download-crawl/preview',
    '/api/download-crawl/enqueue',
    '/api/download-crawl/status',
    '/api/download-crawl/stats',
    '/api/download-crawl/login-status',
    '/api/download-crawl/login',
    '/api/download-crawl/translate-keywords',
    '/api/download-crawl/cancel',
    '/api/download-crawl/stop',
    '/api/download-crawl/clear',
    '/api/download-crawl/pause',
    '/api/download-crawl/retry',
    '/api/download-crawl/retry-all',
    '/api/download-crawl/clear-logs'
  ]) {
    assert.match(server, new RegExp(route.replaceAll('/', '\\/')));
  }
});

test('server exposes MediaCrawler engine status and integration', () => {
  const server = read('server.js');
  assert.match(server, /mediacrawler-adapter/);
  assert.match(server, /viral-crawl-ytdlp-adapter/);
  assert.match(server, /ViralCrawlYtDlpAdapter/);
  assert.match(server, /\['youtube', 'tiktok', 'facebook', 'instagram', 'twitter', 'reddit'\]/);
  assert.match(server, /\/api\/download-crawl\/engine-status/);
  assert.match(server, /crawlResolvers/);
});

test('download page keeps legacy modes and makes crawl-now the default', () => {
  const html = read('public/index.html');
  const crawlTab = html.match(/<button[^>]*id="download-mode-crawl-btn"[^>]*>/)?.[0] || '';
  assert.match(crawlTab, /class="download-mode-tab active"/);
  assert.doesNotMatch(crawlTab, /source-tab-btn/);
  assert.match(html, /id="download-crawl-container"/);
  assert.match(html, /id="download-single-container"[^>]*class="download-subview hidden"/);
  assert.match(html, /id="download-bulk-container"[^>]*class="download-subview hidden"/);
  assert.match(html, /id="crawl-platform-grid"/);
  assert.match(html, /id="crawl-mode-tabs"/);
  assert.match(html, /id="crawl-preview-grid"/);
  assert.match(html, /id="crawl-preview-more"/);
  assert.match(html, /id="crawl-queue-list"/);
  assert.match(html, /id="crawl-login-grid"/);
  assert.match(html, /id="crawl-activity-log"/);
  assert.match(html, /id="crawl-progress-speed"/);
  assert.match(html, /id="crawl-progress-eta"/);
  assert.match(html, /id="crawl-now-sort"/);
  assert.match(html, /id="crawl-now-language"/);
});

test('crawl-now exposes ViralCrawl auxiliary platforms and dual-engine status', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  for (const platform of ['instagram', 'twitter', 'reddit']) {
    assert.match(html, new RegExp(`data-platform="${platform}"`));
  }
  assert.match(app, /MediaCrawler \+ ViralCrawl yt-dlp sẵn sàng/);
  assert.match(app, /viralPlatforms = \['youtube', 'tiktok', 'facebook', 'instagram', 'twitter', 'reddit'\]/);
});

test('crawl-now client wires preview, queue controls, progress and duplicate history', () => {
  const app = read('public/app.js');
  for (const endpoint of ['preview', 'enqueue', 'status', 'cancel', 'stop', 'clear']) {
    assert.match(app, new RegExp(`fetch\\('/api/download-crawl/${endpoint}`));
  }
  assert.match(app, /function crawlRenderPreview/);
  assert.match(app, /function crawlRenderQueue/);
  assert.match(app, /crawlRecordedTaskIds/);
  assert.match(app, /addDownloadHistory\(task\.title/);
  assert.match(app, /function crawlTranslateKeywords/);
  assert.match(app, /function crawlLoadLoginStatus/);
  assert.match(app, /function crawlTogglePause/);
  assert.match(app, /function crawlRetryAll/);
  assert.match(app, /function crawlLoadMore/);
  assert.match(app, /function crawlPreviewScroll/);
});
