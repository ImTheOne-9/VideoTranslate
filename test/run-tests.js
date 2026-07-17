const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findTestFiles() {
  return fs.readdirSync(__dirname, { recursive: true })
    .filter((entry) => entry.endsWith('.test.js') && entry !== 'run-tests.js')
    .map((entry) => path.join(__dirname, entry))
    .sort();
}

function runTests() {
  const testFiles = findTestFiles();

  if (testFiles.length === 0) {
    console.error('No test files found below test/.');
    return 1;
  }

  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit'
  });

  return result.status ?? 1;
}

process.exitCode = runTests();
