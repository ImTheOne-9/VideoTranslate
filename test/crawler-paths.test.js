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
    assert.doesNotMatch(JSON.stringify(paths), /ViralCrawl|viralcrawl-desktop/i);
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
    path.join('MediaCrawler', 'main.py')
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `missing ${relative}`);
  }
});
