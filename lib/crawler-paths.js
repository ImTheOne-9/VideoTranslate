const fs = require('fs');
const os = require('os');
const path = require('path');

const PRODUCT_DIRECTORY = 'Video Studio Tools';

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || paths.find(Boolean) || '';
}

function hasPlaywrightChromium(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && /^chromium-\d+$/i.test(entry.name));
  } catch (_) {
    return false;
  }
}

function resolvePlaywrightBrowsersDir(runtimeRoot, resourceRuntimeRoot) {
  const preferred = path.join(runtimeRoot, 'ms-playwright-python');
  const candidates = [
    preferred,
    path.join(runtimeRoot, 'ms-playwright'),
    path.join(resourceRuntimeRoot, 'ms-playwright-python'),
    path.join(resourceRuntimeRoot, 'ms-playwright')
  ];
  return candidates.find(hasPlaywrightChromium) || preferred;
}

function getBundledRoot() {
  const packaged = __dirname.includes('app.asar');
  return packaged ? process.resourcesPath : path.join(__dirname, '..');
}

function getCrawlerPaths(options = {}) {
  const bundledRoot = path.resolve(options.bundledRoot || getBundledRoot());
  const appRoot = path.resolve(options.appRoot || process.env.VIDEO_STUDIO_CRAWLER_APP_ROOT
    || path.join(bundledRoot, 'tools', 'crawler', 'app'));
  const defaultUserRoot = process.env.APPDATA
    ? path.join(process.env.APPDATA, PRODUCT_DIRECTORY, 'crawler')
    : path.join(os.homedir(), `.${PRODUCT_DIRECTORY.toLowerCase().replace(/\s+/g, '-')}`, 'crawler');
  const userRoot = path.resolve(options.userRoot || process.env.VIDEO_STUDIO_CRAWLER_HOME || defaultUserRoot);
  const runtimeRoot = path.resolve(options.runtimeRoot || process.env.VIDEO_STUDIO_CRAWLER_RUNTIME
    || path.join(userRoot, 'runtime'));
  const resourceRuntimeRoot = path.join(bundledRoot, 'tools', 'crawler', 'runtime');
  const python = path.resolve(options.python || process.env.VIDEO_STUDIO_CRAWLER_PYTHON || firstExisting([
    path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe'),
    path.join(resourceRuntimeRoot, 'venv', 'Scripts', 'python.exe')
  ]));
  const browserDataDir = path.resolve(options.browserDataDir || process.env.VIDEO_STUDIO_CRAWLER_BROWSER_DATA
    || path.join(userRoot, 'browser_data'));
  const dataDir = path.resolve(options.dataDir || process.env.VIDEO_STUDIO_CRAWLER_DATA
    || path.join(userRoot, 'data'));
  const playwrightBrowsersDir = path.resolve(options.playwrightBrowsersDir
    || process.env.VIDEO_STUDIO_PLAYWRIGHT_BROWSERS
    || resolvePlaywrightBrowsersDir(runtimeRoot, resourceRuntimeRoot));

  return {
    bundledRoot,
    appRoot,
    crawlerRoot: path.join(appRoot, 'MediaCrawler'),
    userRoot,
    runtimeRoot,
    python,
    browserDataDir,
    dataDir,
    loginStatusPath: path.join(userRoot, 'login_status.json'),
    playwrightBrowsersDir,
    ffmpegPath: path.join(bundledRoot, 'tools', 'ffmpeg.exe'),
    ffprobePath: path.join(bundledRoot, 'tools', 'ffprobe.exe'),
    ytDlpPath: path.join(bundledRoot, 'tools', 'yt-dlp.exe'),
    nodePath: path.join(bundledRoot, 'tools', 'node', 'node.exe')
  };
}

function ensureCrawlerDirectories(paths) {
  for (const directory of [paths.userRoot, paths.runtimeRoot, paths.browserDataDir, paths.dataDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function crawlerEnvironment(paths, extra = {}) {
  const pathParts = [
    path.dirname(paths.ffmpegPath),
    path.dirname(paths.nodePath),
    process.env.PATH || ''
  ].filter(Boolean);
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    VIDEO_STUDIO_CRAWLER_HOME: paths.userRoot,
    VIDEO_STUDIO_CRAWLER_RUNTIME: paths.runtimeRoot,
    MC_BROWSER_DATA_DIR: paths.browserDataDir,
    MC_DATA_DIR: paths.dataDir,
    KHACH_DB_DIR: paths.userRoot,
    LIC_CACHE_DIR: paths.userRoot,
    VIDEO_STUDIO_LOGIN_STATUS_FILE: paths.loginStatusPath,
    PLAYWRIGHT_BROWSERS_PATH: paths.playwrightBrowsersDir,
    PATH: pathParts.join(path.delimiter),
    ...extra
  };
}

module.exports = {
  PRODUCT_DIRECTORY,
  hasPlaywrightChromium,
  getBundledRoot,
  getCrawlerPaths,
  ensureCrawlerDirectories,
  crawlerEnvironment
};
