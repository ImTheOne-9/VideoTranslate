const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const { withTempDir } = require('./helpers/temp-dir');

test('withTempDir removes the directory after a successful callback', async () => {
  let directory;
  await withTempDir('cleanup-success-', async (createdDirectory) => {
    directory = createdDirectory;
    await fs.writeFile(`${createdDirectory}/nested.txt`, 'content');
    assert.equal(await fs.readFile(`${createdDirectory}/nested.txt`, 'utf8'), 'content');
  });

  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});

test('withTempDir removes the directory when the callback fails and rethrows', async () => {
  let directory;
  await assert.rejects(
    withTempDir('cleanup-failure-', async (createdDirectory) => {
      directory = createdDirectory;
      throw new Error('callback failed');
    }),
    { message: 'callback failed' }
  );

  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});
