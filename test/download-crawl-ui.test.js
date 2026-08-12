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
    '/api/download-crawl/preview-stream',
    '/api/download-crawl/enqueue',
    '/api/download-crawl/status',
    '/api/download-crawl/stats',
    '/api/download-crawl/history',
    '/api/download-crawl/history/delete',
    '/api/download-crawl/open-file-folder',
    '/api/download-crawl/runtime-status',
    '/api/download-crawl/runtime-install',
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
  assert.match(server, /project-ytdlp-adapter/);
  assert.match(server, /ProjectYtDlpAdapter/);
  assert.match(server, /\['youtube', 'tiktok', 'facebook', 'instagram', 'twitter', 'reddit'\]/);
  assert.match(server, /\/api\/download-crawl\/engine-status/);
  assert.match(server, /'douyin:detail': createMediaCrawlerPreviewResolver\('douyin'\)/);
  assert.match(server, /'bilibili:detail': createMediaCrawlerPreviewResolver\('bilibili'\)/);
  assert.match(server, /'instagram:creator': createProjectYtDlpPreviewResolver\('instagram'\)/);
  assert.match(server, /'instagram:detail': createProjectYtDlpPreviewResolver\('instagram'\)/);
  assert.doesNotMatch(server, /'douyin:detail': async/);
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
  assert.match(html, /id="crawl-history-list"/);
  assert.match(html, /id="crawl-runtime-install-btn"/);
  assert.match(html, /id="crawl-now-sort"/);
  assert.match(html, /id="crawl-now-language"/);
});

test('crawl history is a dedicated navbar view with ViralCrawl-style filters and bulk download', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const globals = read('public/js/globals.js');
  assert.match(html, /class="nav-btn" data-view="crawl-history"/);
  assert.match(html, /<section class="view" id="view-crawl-history">/);
  assert.doesNotMatch(html, /crawl-now-side[\s\S]*panel crawl-history-card/);
  for (const id of ['crawl-history-query', 'crawl-history-platform', 'crawl-history-days', 'crawl-history-mode', 'crawl-history-source', 'crawl-history-sort', 'crawl-history-undownloaded', 'crawl-history-select-all', 'crawl-history-download-selected', 'crawl-history-delete-range']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(globals, /'crawl-history':/);
  assert.match(app, /function crawlRenderHistory/);
  assert.match(app, /function crawlHistoryDownloadSelected/);
  assert.match(app, /function crawlHistoryDelete/);
  assert.match(app, /function crawlHistoryModeLabel/);
  assert.match(app, /function crawlHistoryOpenFolder/);
  assert.match(app, />Mở thư mục<\/button>/);
  assert.match(app, /optgroup label="Kênh/);
  assert.match(app, /optgroup label="Từ khóa/);
  assert.match(app, /platform, mode: 'detail'/);
});

test('crawl-now hides Weibo, X and Reddit while retaining supported visible platforms', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const historyPlatformFilter = html.match(/<select id="crawl-history-platform"[\s\S]*?<\/select>/)?.[0] || '';
  for (const platform of ['youtube', 'tiktok', 'facebook', 'instagram', 'douyin', 'bilibili', 'xiaohongshu', 'rednote']) {
    assert.match(html, new RegExp(`data-platform="${platform}"`));
  }
  for (const platform of ['weibo', 'twitter', 'reddit']) {
    assert.doesNotMatch(html, new RegExp(`data-platform="${platform}"`));
    assert.doesNotMatch(historyPlatformFilter, new RegExp(`<option value="${platform}"`));
  }
  assert.match(app, /hiddenCrawlPlatforms = new Set\(\['weibo', 'twitter', 'reddit'\]\)/);
  assert.match(app, /!hiddenCrawlPlatforms\.has\(String\(item\.platform/);
  assert.match(app, /MediaCrawler \+ Video Studio yt-dlp sẵn sàng/);
  assert.match(app, /jobCrawlerPlatforms = \['youtube', 'tiktok', 'facebook', 'instagram', 'twitter', 'reddit', 'douyin', 'bilibili', 'xiaohongshu', 'rednote', 'weibo'\]/);
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
  assert.match(app, /sourceMode: sourceRequest\.mode, sourceInput: sourceRequest\.input/);
  assert.doesNotMatch(app, /function crawlPreviewScroll/);
  assert.doesNotMatch(app, /crawl-now-count'\)\.value\s*=/);
  assert.match(app, /crawlPreview\(\{ append: true, requestCount \}\)/);
  assert.doesNotMatch(read('public/index.html'), /onscroll="crawlPreviewScroll/);
  assert.match(app, /application\/x-ndjson|preview-stream/);
  assert.match(app, /function crawlLoadHistory/);
  assert.match(app, /function crawlInstallRuntime/);
  assert.match(app, /Number\(seconds\) <= 0\) return '--:--'/);
});

test('crawl history does not flood the local API with thumbnail requests', () => {
  const server = read('server.js');
  const controller = read('controllers/downloadController.js');
  const app = read('public/app.js');

  assert.match(server, /RATE_LIMIT_EXEMPT_PATHS[\s\S]*'\/api\/proxy-image'/);
  assert.match(server, /RATE_LIMIT_EXEMPT_PATHS[\s\S]*'\/api\/update-status'/);
  assert.match(server, /req\.method === 'GET' && RATE_LIMIT_EXEMPT_PATHS\.has\(req\.path\)/);
  assert.match(controller, /Cache-Control', 'public, max-age=86400'/);
  assert.match(app, /limit: '800'/);
  assert.match(app, /loading="lazy" decoding="async"/);
});
