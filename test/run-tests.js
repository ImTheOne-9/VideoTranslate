/**
 * Test runner: chạy toàn bộ unit test trong test/unit/
 * Chạy: node test/run-tests.js  hoặc  npm test
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const testDir = path.join(__dirname, 'unit');
const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(testDir, f));

if (files.length === 0) {
  console.log('⚠️ Không tìm thấy file test nào trong test/unit/');
  process.exit(0);
}

console.log(`🧪 Chạy ${files.length} file test...\n`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status || 0);