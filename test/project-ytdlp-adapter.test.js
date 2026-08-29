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
    return { stdout: 'LOG:test\n{"ok":true,"items":[{"id":"abc","title":"Clip","thumb":"https://img","url":"https://video","like":"123","nick":"Kenh","duration":87}]}\n' };
  };
  const items = await adapter.preview({ platform: 'youtube', mode: 'search', input: 'phim', count: 5 });
  assert.equal(path.basename(call.script), 'tai_ytdlp.py');
  assert.ok(call.args.includes('--list'));
  assert.ok(call.args.includes('yt'));
  assert.equal(items[0].engine, 'Video Studio yt-dlp');
  assert.equal(items[0].viewCount, 123);
  assert.equal(items[0].duration, 87);
});

test('BiliTV detail preview is routed through the generic video parser', async () => {
  const adapter = new ProjectYtDlpAdapter();
  let call = null;
  adapter._run = async (script, args) => {
    call = { script, args };
    return { stdout: '{"ok":true,"items":[{"id":"2049633062","title":"Anime","url":"https://www.bilibili.tv/en/video/2049633062","duration":60}]}' };
  };
  const items = await adapter.preview({
    platform: 'bilitv', mode: 'detail', input: 'https://www.bilibili.tv/en/video/2049633062', count: 1
  });
  assert.equal(call.args[call.args.indexOf('--platform') + 1], 'bilitv');
  assert.equal(items[0].sourceUrl, 'https://www.bilibili.tv/en/video/2049633062');
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'tai_ytdlp.py'), 'utf8');
  assert.match(source, /plat not in \("yt", "tt", "fb", "ig", "bilitv"\)/);
  assert.match(source, /def _item_video_generic\(e\):/);
});

test('yt-dlp ledger is written only after final media validation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'tai_ytdlp.py'), 'utf8');
  assert.match(source, /_cho_kiem_tra\[str\(vid\)\] = dict\(info\)/);
  assert.match(source, /if _tim_media_theo_id\(_vid\):\s+_ghi_lich_su\(_info\)/);
  assert.match(source, /_xoa_archive_id\(_vid\)/);
});

test('Facebook preview source enriches sparse DOM cards with yt-dlp metadata', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'tai_ytdlp.py'), 'utf8');
  assert.match(source, /def _fb_bo_sung_metadata\(items, log=print\)/);
  assert.match(source, /items = _fb_bo_sung_metadata\(items, log=log\)/);
  assert.match(source, /info\.get\("duration"\)/);
  assert.match(source, /FB_METADATA_CONCUR/);
  assert.match(source, /shutil\.copyfile\(cookiefile, thread_cookie\)/);
});

test('Facebook numeric Page preview prefers reels_tab and accepts modern Reel links', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'tai_ytdlp.py'), 'utf8');
  assert.match(source, /tab_candidates\.extend\(\["reels_tab", "videos", "reels"\]\)/);
  assert.match(source, /sk=\{tab\}/);
  assert.match(source, /a\[href\*='\/share\/r\/'\]/);
  assert.match(source, /reels\?\/\(\\d\+\)/);
  assert.match(source, /khong_moi >= 5/);
});

test('Instagram preview supports creator and detail through the project profile pipeline', async () => {
  const adapter = new ProjectYtDlpAdapter();
  const calls = [];
  adapter._run = async (script, args) => {
    calls.push({ script, args });
    return { stdout: '{"ok":true,"items":[{"id":"ig1","title":"Reel","url":"https://www.instagram.com/reel/ig1/","nick":"Rocco","duration":42}]}' };
  };
  const creator = await adapter.preview({ platform: 'instagram', mode: 'creator', input: 'https://www.instagram.com/roccoandmaddie/reels/', count: 5 });
  const detail = await adapter.preview({ platform: 'instagram', mode: 'detail', input: 'https://www.instagram.com/reel/ig1/', count: 1 });
  assert.equal(creator[0].duration, 42);
  assert.equal(detail[0].duration, 42);
  assert.ok(calls[0].args.includes('creator'));
  assert.ok(calls[1].args.includes('detail'));
});

test('Instagram Python preview normalizes reels tab and exports project profile cookies', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'tai_ytdlp.py'), 'utf8');
  assert.match(source, /return "https:\/\/www\.instagram\.com\/%s\/" % parts\[0\]/);
  assert.match(source, /cookiefile = xuat_cookie_tu_phien\("ig"\)/);
  assert.match(source, /False if a\.type == "detail" else "in_playlist"/);
  assert.match(source, /def _item_ig\(e\):/);
  assert.match(source, /def _ig_liet_ke_kenh\(profile_input, count, log=print\):/);
  assert.match(source, /items = _ig_bo_sung_metadata\(items, log=log\)/);
  assert.match(source, /re\.findall\(r"\/\(reel\|p\)\/\(\[A-Za-z0-9_-\]\+\)"/);
  assert.match(source, /"duration": e\.get\("duration"\) or 0/);
});

test('TikTok creator keeps partial video ids and falls back to browser when secUid extraction fails', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'tai_ytdlp.py'), 'utf8');
  assert.match(source, /class _TikTokChannelLogger:/);
  assert.match(source, /Downloading webpage/);
  assert.match(source, /def _tiktok_liet_ke_kenh_browser\(profile_url, count, log=print\):/);
  assert.match(source, /tt_channel_logger\.items\(count\)/);
  assert.match(source, /_tt_channel_logger\.items\(count\)/);
  assert.match(source, /fallback trình duyệt/);
});

test('TikTok detail preview uses project fallback instead of generic yt-dlp preview', async () => {
  const adapter = new ProjectYtDlpAdapter();
  let call = null;
  adapter._run = async (script, args) => {
    call = { script, args };
    return { stdout: '{"ok":true,"items":[{"id":"7660769402538839317","title":"Video 7660769402538839317","url":"https://www.tiktok.com/@tuannguyen60872/video/7660769402538839317"}]}' };
  };
  const items = await adapter.preview({
    platform: 'tiktok', mode: 'detail',
    input: 'https://www.tiktok.com/@tuannguyen60872/video/7660769402538839317', count: 1
  });
  assert.ok(call.args.includes('--list'));
  assert.ok(call.args.includes('detail'));
  assert.equal(items[0].id, '7660769402538839317');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /'tiktok:detail': createProjectYtDlpPreviewResolver\('tiktok'\)/);
  const pythonSource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'tai_ytdlp.py'), 'utf8');
  assert.match(pythonSource, /def _tiktok_xem_truoc_link_browser\(urls, count, log=print\):/);
  assert.match(pythonSource, /plat == "tt" and a\.type == "detail"/);
});

test('Weibo login window verifies the live page instead of trusting stale cookies', () => {
  const loginSource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'mo_dang_nhap.py'), 'utf8');
  const checkSource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'crawler', 'app', 'kiem_tra_login.py'), 'utf8');
  assert.match(loginSource, /def _wb_da_login_live\(ctx, udd=None\):/);
  assert.match(loginSource, /if plat == "wb":\s+return _wb_da_login_live\(ctx, udd\)/);
  assert.match(loginSource, /https:\/\/m\.weibo\.cn\/api\/config/);
  assert.match(loginSource, /state\["ok"\] >= 2/);
  assert.match(loginSource, /wb_session\.dpapi/);
  assert.match(loginSource, /CryptProtectData/);
  assert.match(checkSource, /def _wb_login_nobrowser\(udd\):/);
  assert.match(checkSource, /cookie_module\._dpapi_unprotect/);
  assert.match(checkSource, /if plat == "wb":\s+[\s\S]*?_wb_login_nobrowser\(udd\)/);
  assert.doesNotMatch(checkSource, /elif plat == "wb":\s+lv = _dom_login/);
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

test('selected preview URLs retain their original grouping when delegated to tai_ytdlp', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-ytdlp-grouping-'));
  try {
    const adapter = new ProjectYtDlpAdapter();
    let call = null;
    adapter._run = async (script, args, options) => {
      call = { script, args, options };
      return { stdout: '' };
    };
    await adapter.crawl({
      platform: 'tiktok', mode: 'detail', input: 'https://www.tiktok.com/@demo/video/1', count: 1,
      sourceMode: 'creator', sourceInput: 'https://www.tiktok.com/@demo', sourceName: 'Demo Channel', outputDir: directory
    });
    assert.ok(call.args.includes('--type'));
    assert.equal(call.args[call.args.indexOf('--type') + 1], 'detail');
    assert.equal(call.args[call.args.indexOf('--source-type') + 1], 'creator');
    assert.equal(call.args[call.args.indexOf('--source-input') + 1], 'https://www.tiktok.com/@demo');
    assert.equal(call.args[call.args.indexOf('--source-name') + 1], 'Demo Channel');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
