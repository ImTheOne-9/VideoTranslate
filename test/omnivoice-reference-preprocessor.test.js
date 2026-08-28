'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseSilenceStarts,
  prepareOmnivoiceReference
} = require('../lib/omnivoice-reference-preprocessor');

test('OmniVoice reference parser keeps only useful silence boundaries', () => {
  assert.deepEqual(
    parseSilenceStarts('silence_start: 1.2\nsilence_start: 6.4\nsilence_start: 9.1'),
    [6.4, 9.1]
  );
});

test('long OmniVoice references are normalized to 24k and cut at the last silence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputPath = path.join(root, 'source.wav');
  const outputPath = path.join(root, 'prepared.wav');
  fs.writeFileSync(inputPath, 'source');
  const calls = [];
  const runExecFile = async (command, args) => {
    calls.push({ command, args });
    if (command === 'ffprobe') {
      const target = args.at(-1);
      if (target.endsWith('.silence.wav')) return { stdout: '8.350\n', stderr: '' };
      if (target === outputPath) return { stdout: '10.000\n', stderr: '' };
      return { stdout: '18.000\n', stderr: '' };
    }
    if (args.includes('silencedetect=noise=-35dB:d=0.10')) {
      return { stdout: '', stderr: 'silence_start: 2.0\nsilence_start: 8.2\n' };
    }
    const target = args.at(-1);
    if (/\.wav$/i.test(target)) fs.writeFileSync(target, Buffer.alloc(100));
    return { stdout: '', stderr: '' };
  };
  const result = await prepareOmnivoiceReference({
    inputPath,
    outputPath,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    runExecFile
  });
  assert.equal(result.trimmed, true);
  assert.equal(result.silenceAware, true);
  assert.equal(result.cutAt, 8.35);
  assert.ok(calls.some(({ args }) => args.includes('silenceremove=start_periods=1:start_silence=0.1:start_threshold=-38dB')));
  assert.ok(calls.some(({ args }) => args.includes('24000')));
});
