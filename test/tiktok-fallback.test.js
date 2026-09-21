const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getCrawlerPaths } = require('../lib/crawler-paths');

test('TikTok fallback verifies identity, video stream, cleanup and browser-first ordering', () => {
  const python = getCrawlerPaths().python;
  const result = spawnSync(fs.existsSync(python) ? python : 'python', [path.join(__dirname, 'tiktok_fallback_test.py')], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});
