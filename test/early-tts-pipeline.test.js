'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EarlyTtsPipeline } = require('../lib/early-tts-pipeline');

test('early TTS starts without blocking translation and restores matching cue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'early-tts-'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const engine = {
    id: 'piper',
    async synthesize(options) {
      await gate;
      fs.writeFileSync(options.outputPath, Buffer.alloc(64));
    }
  };
  const pipeline = new EarlyTtsPipeline({ engine, workDir: root, language: 'vi' });
  pipeline.enqueue([{ id: '1', text: 'Giảm 50%', startMs: 0, endMs: 1000 }]);
  assert.equal(pipeline.pending.size, 1);
  release();
  assert.equal(await pipeline.drain(), 1);
  const destination = path.join(root, 'restored.wav');
  assert.equal(pipeline.restore({ id: '1' }, 'Giảm năm mươi phần trăm', destination), true);
  assert.equal(fs.existsSync(destination), true);
});
