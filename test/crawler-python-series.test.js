const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getCrawlerPaths } = require('../lib/crawler-paths');

test('Python series downloader passes offline manifest, validation, dedup and Honggo tests', () => {
  const configured = getCrawlerPaths().python;
  const python = fs.existsSync(configured) ? configured : 'python';
  const result = spawnSync(python, [path.join(__dirname, 'crawler_series_test.py')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, (result.stderr || '') + (result.stdout || '') + (result.error?.message || ''));
});
