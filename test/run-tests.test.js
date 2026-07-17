const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { findTestFiles, runTests } = require('./run-tests');

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-tests-'));
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'z.test.js'), '');
  await fs.writeFile(path.join(root, 'run-tests.js'), '');
  await fs.writeFile(path.join(root, 'nested', 'a.test.js'), '');
  return root;
}

test('findTestFiles recursively returns sorted test files and excludes the runner', async () => {
  const root = await makeFixture();
  try {
    assert.deepEqual(findTestFiles(root), [
      path.join(root, 'nested', 'a.test.js'),
      path.join(root, 'z.test.js')
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runTests builds a no-shell child invocation and returns its exit status', async () => {
  const root = await makeFixture();
  const calls = [];
  try {
    const status = runTests({
      testDir: root,
      cwd: path.join(root, 'cwd'),
      spawnSync: (...args) => {
        calls.push(args);
        return { status: 7 };
      }
    });

    assert.equal(status, 7);
    assert.deepEqual(calls, [[
      process.execPath,
      ['--test', path.join(root, 'nested', 'a.test.js'), path.join(root, 'z.test.js')],
      { cwd: path.join(root, 'cwd'), stdio: 'inherit' }
    ]]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runTests reports an empty suite and returns failure without spawning', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-tests-empty-'));
  const messages = [];
  try {
    assert.equal(runTests({
      testDir: root,
      spawnSync: () => assert.fail('must not spawn an empty suite'),
      logError: (message) => messages.push(message)
    }), 1);
    assert.deepEqual(messages, ['No test files found below test/.']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
