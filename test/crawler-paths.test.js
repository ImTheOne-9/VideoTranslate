const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getCrawlerPaths,
  ensureCrawlerDirectories,
  crawlerEnvironment
} = require('../lib/crawler-paths');

test('crawler resolves project-owned source, runtime, profiles and data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-crawler-'));
  try {
    const paths = getCrawlerPaths({ bundledRoot: directory, userRoot: path.join(directory, 'user') });
    assert.equal(paths.appRoot, path.join(directory, 'tools', 'crawler', 'app'));
    assert.equal(paths.crawlerRoot, path.join(directory, 'tools', 'crawler', 'app', 'MediaCrawler'));
    assert.equal(paths.runtimeRoot, path.join(directory, 'user', 'runtime'));
    assert.equal(paths.browserDataDir, path.join(directory, 'user', 'browser_data'));
    assert.equal(paths.dataDir, path.join(directory, 'user', 'data'));
    const legacyExternalNames = new RegExp([['Viral', 'Crawl'].join(''), ['viral', 'crawl-desktop'].join('')].join('|'), 'i');
    assert.doesNotMatch(JSON.stringify(paths), legacyExternalNames);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('crawler creates only mutable user directories and exports stable child environment', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-crawler-env-'));
  try {
    const paths = getCrawlerPaths({ bundledRoot: directory, userRoot: path.join(directory, 'user') });
    ensureCrawlerDirectories(paths);
    assert.equal(fs.existsSync(paths.browserDataDir), true);
    assert.equal(fs.existsSync(paths.dataDir), true);
    const env = crawlerEnvironment(paths, { MC_GET_MEDIAS: '0' });
    assert.equal(env.MC_BROWSER_DATA_DIR, paths.browserDataDir);
    assert.equal(env.MC_DATA_DIR, paths.dataDir);
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, paths.playwrightBrowsersDir);
    assert.equal(env.MC_GET_MEDIAS, '0');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('crawler reuses a valid legacy Playwright browser runtime after upgrading', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-crawler-legacy-browser-'));
  try {
    const userRoot = path.join(directory, 'user');
    const legacyRoot = path.join(userRoot, 'runtime', 'ms-playwright');
    fs.mkdirSync(path.join(legacyRoot, 'chromium-1124'), { recursive: true });
    const paths = getCrawlerPaths({ bundledRoot: directory, userRoot });
    assert.equal(paths.playwrightBrowsersDir, legacyRoot);
    assert.equal(crawlerEnvironment(paths).PLAYWRIGHT_BROWSERS_PATH, legacyRoot);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('crawler prefers the isolated Python Playwright runtime when both are ready', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-crawler-python-browser-'));
  try {
    const userRoot = path.join(directory, 'user');
    const runtimeRoot = path.join(userRoot, 'runtime');
    fs.mkdirSync(path.join(runtimeRoot, 'ms-playwright', 'chromium-1124'), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, 'ms-playwright-python', 'chromium-1200'), { recursive: true });
    const paths = getCrawlerPaths({ bundledRoot: directory, userRoot });
    assert.equal(paths.playwrightBrowsersDir, path.join(runtimeRoot, 'ms-playwright-python'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('project contains every crawler entrypoint required by both adapters', () => {
  const root = path.resolve(__dirname, '..', 'tools', 'crawler', 'app');
  for (const relative of [
    'tai_ytdlp.py',
    'tim_anh.py',
    'mo_dang_nhap.py',
    'kiem_tra_login.py',
    'xhs_browser.py',
    'cookie_decrypt.py',
    'index_metadata.py',
    'faster_whisper_asr.py',
    path.join('MediaCrawler', 'main.py')
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `missing ${relative}`);
  }
});
