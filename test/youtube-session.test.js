const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getCrawlerPaths } = require('../lib/crawler-paths');
const { ProjectYtDlpAdapter } = require('../lib/project-ytdlp-adapter');

test('YouTube cookie fallback, export integrity and title processor pass offline tests', () => {
  const configured = getCrawlerPaths().python;
  const result = spawnSync(fs.existsSync(configured) ? configured : 'python', [path.join(__dirname, 'youtube_session_test.py')], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});

test('YouTube login waits for Chrome helper result and reports errors', async () => {
  const adapter = new ProjectYtDlpAdapter();
  adapter._assertAvailable = () => {};
  adapter._run = async (script, args) => {
    assert.equal(path.basename(script), 'youtube_session.py');
    assert.deepEqual(args, ['--action', 'login']);
    return { stdout: '{"ok":true}' };
  };
  assert.equal((await adapter.openLogin('youtube')).engine, 'Google Chrome');
  adapter._run = async () => ({ stdout: '{"ok":false,"msg":"Chrome missing"}' });
  await assert.rejects(adapter.openLogin('youtube'), /Chrome missing/);
});
