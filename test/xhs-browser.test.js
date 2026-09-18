const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getCrawlerPaths } = require('../lib/crawler-paths');
const { classifyCrawlError } = require('../lib/download-crawl-manager');

test('XHS retries and failure diagnostics pass offline Python behavior tests', () => {
  const configured = getCrawlerPaths().python;
  const python = fs.existsSync(configured) ? configured : 'python';
  const result = spawnSync(python, [path.join(__dirname, 'xhs_browser_test.py')], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});

test('XHS zero-download summary is not classified as an invalid URL', () => {
  assert.equal(classifyCrawlError('Tải 0/1 video XHS/RedNote (theo link đã chọn)'), 'extractor');
  assert.equal(classifyCrawlError('Link không hợp lệ'), 'invalid_link');
});
