const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  ProjectYtDlpAdapter,
  mapMode,
  mapRedditSort,
  mapRedditTime
} = require('../lib/project-ytdlp-adapter');

test('Video Studio yt-dlp maps modes and Reddit filters to tai_ytdlp CLI values', () => {
  assert.equal(mapMode('chase'), 'bo');
  assert.equal(mapMode('creator'), 'creator');
  assert.equal(mapRedditSort('likes'), 'top');
  assert.equal(mapRedditSort('newest'), 'new');
  assert.equal(mapRedditTime(1), 'day');
  assert.equal(mapRedditTime(7), 'week');
  assert.equal(mapRedditTime(30), 'month');
});

test('preview calls tai_ytdlp metadata-only and maps its JSON contract', async () => {
  const adapter = new ProjectYtDlpAdapter();
  let call = null;
  adapter._run = async (script, args) => {
    call = { script, args };
    return { stdout: 'LOG:test\n{"ok":true,"items":[{"id":"abc","title":"Clip","thumb":"https://img","url":"https://video","like":"123","nick":"Kenh"}]}\n' };
  };
  const items = await adapter.preview({ platform: 'youtube', mode: 'search', input: 'phim', count: 5 });
  assert.equal(path.basename(call.script), 'tai_ytdlp.py');
  assert.ok(call.args.includes('--list'));
  assert.ok(call.args.includes('yt'));
  assert.equal(items[0].engine, 'Video Studio yt-dlp');
  assert.equal(items[0].viewCount, 123);
});

test('crawl delegates the complete job to tai_ytdlp with project output root', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-ytdlp-'));
  try {
    const adapter = new ProjectYtDlpAdapter();
    let call = null;
    adapter._run = async (script, args, options) => {
      call = { script, args, options };
      return { stdout: '' };
    };
    const result = await adapter.crawl({ platform: 'tiktok', mode: 'creator', input: '@kenh', count: 3, outputDir: directory });
    assert.equal(path.basename(call.script), 'tai_ytdlp.py');
    assert.deepEqual(call.args.slice(0, 6), ['--platform', 'tt', '--type', 'creator', '--input', '@kenh']);
    assert.equal(call.options.env.MC_DATA_DIR, directory);
    assert.equal(result.engine, 'Video Studio yt-dlp');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
