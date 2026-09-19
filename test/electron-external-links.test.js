const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('Electron opens HTTPS popup links in the default browser and denies child windows', () => {
  assert.match(source, /ipcMain, shell/);
  assert.match(source, /webContents\.setWindowOpenHandler/);
  assert.match(source, /target\.protocol === 'https:'/);
  assert.match(source, /shell\.openExternal\(target\.href\)/);
  assert.match(source, /return \{ action: 'deny' \}/);
});

test('external same-window navigation is redirected outside the application', () => {
  assert.match(source, /webContents\.on\('will-navigate'/);
  assert.match(source, /destination\.origin === application\.origin/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /shell\.openExternal\(destination\.href\)/);
});
