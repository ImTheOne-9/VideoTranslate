const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCrawlerHistory } = require('../lib/crawler-history-reader');

test('crawler history reads JSONL, deduplicates and applies the real download archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-history-'));
  try {
    const jsonl = path.join(root, 'douyin', 'jsonl');
    fs.mkdirSync(jsonl, { recursive: true });
    fs.writeFileSync(path.join(jsonl, 'search_contents_1.jsonl'), [
      JSON.stringify({ aweme_id: '1', desc: 'Old', aweme_url: 'https://douyin/1', create_time: 10 }),
      JSON.stringify({ aweme_id: '1', desc: 'New title', aweme_url: 'https://douyin/1', create_time: 20 }),
      JSON.stringify({ aweme_id: '2', desc: 'Other', aweme_url: 'https://douyin/2', create_time: 30 })
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'douyin', '_da_tai_ids.txt'), '1\nhttps://douyin/1\n');
    const items = readCrawlerHistory(root, { platform: 'douyin' });
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.id === '1').title, 'New title');
    assert.equal(items.find((item) => item.id === '1').downloaded, true);
    assert.deepEqual(readCrawlerHistory(root, { platform: 'douyin', onlyUndownloaded: true }).map((item) => item.id), ['2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
