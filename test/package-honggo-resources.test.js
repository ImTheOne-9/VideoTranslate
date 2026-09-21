const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const afterPack = require('../scripts/after-pack');

test('afterPack always copies both Honggo native signer libraries', async () => {
  const projectDir = path.join(__dirname, '..');
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-honggo-pack-'));
  try {
    await afterPack({ appOutDir, packager: { projectDir } });
    for (const relativePath of afterPack.HONGGO_NATIVE_FILES) {
      const source = path.join(projectDir, relativePath);
      const packed = path.join(appOutDir, 'resources', relativePath);
      assert.ok(fs.existsSync(packed), relativePath + ' must exist in packaged resources');
      assert.equal(fs.statSync(packed).size, fs.statSync(source).size);
      assert.ok(fs.statSync(packed).size > 0);
      const payload = path.join(appOutDir, 'resources', 'honggo-native', `${path.basename(relativePath)}.bin`);
      assert.ok(fs.existsSync(payload), relativePath + ' payload must exist with a safe .bin extension');
      assert.equal(fs.statSync(payload).size, fs.statSync(source).size);
    }
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

