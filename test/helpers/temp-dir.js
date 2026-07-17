const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function withTempDir(prefix, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { withTempDir };
