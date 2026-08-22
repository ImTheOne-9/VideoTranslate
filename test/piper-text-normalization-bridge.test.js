'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { getCrawlerPaths } = require('../lib/crawler-paths');

test('Piper bridge prefers vietnormalizer only for Vietnamese output', (t) => {
  const python = getCrawlerPaths().python;
  if (!fs.existsSync(python)) {
    t.skip('Crawler Python runtime is not installed');
    return;
  }
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vietnormalizer-stub-'));
  fs.writeFileSync(path.join(stubRoot, 'vietnormalizer.py'), [
    'class VietnameseNormalizer:',
    '    def normalize(self, text):',
    '        return text.replace("iPhone 15", "ai-phôn mười lăm")'
  ].join('\n'), 'utf8');
  const appRoot = path.resolve(__dirname, '..', 'tools', 'crawler', 'app');
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(appRoot)})`,
    'import piper_tts_bridge as bridge',
    'values = [bridge.normalize_piper_text("iPhone 15", "vi"), '
      + 'bridge.normalize_piper_text("iPhone 15", "en"), '
      + 'bridge.normalize_piper_text("平常你几点睡几点起", "vi")]',
    'print(json.dumps(values, ensure_ascii=False))'
  ].join('; ');
  const result = spawnSync(python, ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONPATH: stubRoot
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [
    'ai-phôn mười lăm',
    'iPhone 15',
    ''
  ]);
});
