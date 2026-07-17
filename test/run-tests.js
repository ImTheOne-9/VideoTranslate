const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findTestFiles(testDir = __dirname) {
  return fs.readdirSync(testDir, { recursive: true })
    .filter((entry) => entry.endsWith('.test.js') && path.basename(entry) !== 'run-tests.js')
    .map((entry) => path.join(testDir, entry))
    .sort();
}

function runTests(options = {}) {
  const testDir = options.testDir ?? __dirname;
  const testFiles = findTestFiles(testDir);

  if (testFiles.length === 0) {
    (options.logError ?? console.error)('No test files found below test/.');
    return 1;
  }

  const result = (options.spawnSync ?? spawnSync)(process.execPath, ['--test', ...testFiles], {
    cwd: options.cwd ?? path.resolve(__dirname, '..'),
    stdio: 'inherit'
  });

  return result.status ?? 1;
}

module.exports = { findTestFiles, runTests };

if (require.main === module) {
  process.exitCode = runTests();
}
