const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Parser = require('srt-parser-2').default;

const {
  deduplicateConsecutiveTranslatedCues,
  deduplicateTranslatedSubtitleFile
} = require('../lib/translate-sub');

function cue(id, startTime, endTime, text) {
  return { id: String(id), startTime, endTime, text };
}

test('translated dedup merges exact adjacent OCR translations and extends the first cue', () => {
  const result = deduplicateConsecutiveTranslatedCues([
    cue(1, '00:00:47,690', '00:00:48,220', 'Đi dạo bước ra khỏi khu rừng rậm,'),
    cue(2, '00:00:48,490', '00:00:49,290', 'Đi dạo bước ra khỏi khu rừng rậm,'),
    cue(3, '00:00:49,550', '00:00:50,350', 'Đến đồng cỏ ven rừng thưởng thức,'),
    cue(4, '00:00:50,620', '00:00:51,120', 'Đến đồng cỏ ven rừng thưởng thức,'),
    cue(5, '00:00:51,150', '00:00:51,650', 'Đến đồng cỏ ven rừng thưởng thức,')
  ], { maxGapMs: 2000 });

  assert.equal(result.mergedCount, 3);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].startTime, '00:00:47,690');
  assert.equal(result.cues[0].endTime, '00:00:49,290');
  assert.equal(result.cues[1].startTime, '00:00:49,550');
  assert.equal(result.cues[1].endTime, '00:00:51,650');
  assert.deepEqual(result.cues.map(item => item.id), ['1', '2']);
});

test('translated dedup does not merge a legitimate repeated phrase far away', () => {
  const result = deduplicateConsecutiveTranslatedCues([
    cue(1, '00:00:10,000', '00:00:11,000', 'Được rồi'),
    cue(2, '00:01:00,000', '00:01:01,000', 'Được rồi')
  ], { maxGapMs: 2000 });

  assert.equal(result.mergedCount, 0);
  assert.equal(result.cues.length, 2);
});

test('translated dedup keeps adjacent sentences that are only similar, not identical', () => {
  const result = deduplicateConsecutiveTranslatedCues([
    cue(1, '00:00:10,000', '00:00:11,000', 'Nó lao về phía bạn'),
    cue(2, '00:00:11,100', '00:00:12,000', 'Nó điên cuồng lao về phía bạn')
  ], { maxGapMs: 2000 });

  assert.equal(result.mergedCount, 0);
  assert.equal(result.cues.length, 2);
});

test('translated subtitle file dedup runs before downstream TTS reads the SRT', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translated-dedup-'));
  const subtitlePath = path.join(directory, 'translated.srt');
  const parser = new Parser();
  fs.writeFileSync(subtitlePath, parser.toSrt([
    cue(1, '00:00:00,000', '00:00:00,500', 'Cuộc sống dần dễ thở hơn'),
    cue(2, '00:00:00,750', '00:00:01,500', 'Cuộc sống dần dễ thở hơn'),
    cue(3, '00:00:02,000', '00:00:03,000', 'Câu tiếp theo')
  ]), 'utf8');

  const report = deduplicateTranslatedSubtitleFile(subtitlePath, { maxGapMs: 2000 });
  const cues = parser.fromSrt(fs.readFileSync(subtitlePath, 'utf8'));

  assert.deepEqual(report, { cueCount: 2, mergedCount: 1 });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].endTime, '00:00:01,500');
  assert.equal(cues[1].text, 'Câu tiếp theo');
  fs.rmSync(directory, { recursive: true, force: true });
});
