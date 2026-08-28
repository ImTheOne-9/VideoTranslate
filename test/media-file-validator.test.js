const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateMediaFile, findValidatedOutput } = require('../lib/media-file-validator');

test('media validator rejects HTML renamed to mp4 and accepts an ISO-BMFF file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-validator-'));
  try {
    const html = path.join(directory, 'bad.mp4');
    fs.writeFileSync(html, `<!doctype html>${'x'.repeat(120000)}`);
    assert.equal(validateMediaFile(html).reason, 'html_or_error_body');

    const video = path.join(directory, 'good.mp4');
    const bytes = Buffer.alloc(110 * 1024);
    bytes.writeUInt32BE(24, 0);
    bytes.write('ftyp', 4, 'ascii');
    fs.writeFileSync(video, bytes);
    assert.equal(validateMediaFile(video).valid, true);
    assert.equal(findValidatedOutput(directory, 'good').path, video);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
