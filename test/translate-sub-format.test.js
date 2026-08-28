const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Parser = require('srt-parser-2').default;

const { formatSubtitleFile } = require('../lib/translate-sub');

function writeSrt(lines) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-format-'));
  const subtitlePath = path.join(tempDir, 'translated.srt');
  fs.writeFileSync(subtitlePath, lines.join('\n'), 'utf8');
  return { tempDir, subtitlePath };
}

test('formatSubtitleFile preserves duplicate cue boundaries and timestamps', () => {
  const { tempDir, subtitlePath } = writeSrt([
    '1', '00:01:24,840 --> 00:01:25,000', 'Cùng với Teigu Koro,', '',
    '2', '00:01:25,000 --> 00:01:26,200', 'Cùng với Teigu Koro,', ''
  ]);

  formatSubtitleFile(subtitlePath, 1, 80);

  const cues = new Parser().fromSrt(fs.readFileSync(subtitlePath, 'utf8'));
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startTime, '00:01:24,840');
  assert.equal(cues[0].endTime, '00:01:25,000');
  assert.equal(cues[1].startTime, '00:01:25,000');
  assert.equal(cues[1].endTime, '00:01:26,200');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('formatSubtitleFile never merges a combined cue with following cue parts', () => {
  const { tempDir, subtitlePath } = writeSrt([
    '1', '00:01:24,840 --> 00:01:25,000',
    'Cùng với Đế Cụ Koro, cô ấy bị dồn vào tình thế nguy hiểm chưa từng có.', '',
    '2', '00:01:25,000 --> 00:01:26,200', 'Cùng với Đế Cụ Koro,', '',
    '3', '00:01:26,200 --> 00:01:28,000',
    'cô ấy bị dồn vào tình thế nguy hiểm chưa từng có.', ''
  ]);

  formatSubtitleFile(subtitlePath, 1, 100);

  const cues = new Parser().fromSrt(fs.readFileSync(subtitlePath, 'utf8'));
  assert.equal(cues.length, 3);
  assert.equal(cues[0].startTime, '00:01:24,840');
  assert.equal(cues[0].endTime, '00:01:25,000');
  assert.equal(cues[0].text, 'Cùng với Đế Cụ Koro, cô ấy bị dồn vào tình thế nguy hiểm chưa từng có.');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('formatSubtitleFile does not delete a cue based on translated text similarity', () => {
  const { tempDir, subtitlePath } = writeSrt([
    '1', '00:01:24,840 --> 00:01:25,000',
    'Cùng với Teigu Koro, cô ta đã đẩy Mine vào tình thế nguy hiểm chưa từng có. Nội dung cũ bị lặp.', '',
    '2', '00:01:25,000 --> 00:01:26,200', 'Cùng với Teigu Koro,', '',
    '3', '00:01:26,200 --> 00:01:28,000',
    'đã đẩy Mine vào tình thế nguy hiểm chưa từng có.', ''
  ]);

  formatSubtitleFile(subtitlePath, 1, 100);

  const cues = new Parser().fromSrt(fs.readFileSync(subtitlePath, 'utf8'));
  assert.equal(cues.length, 3);
  assert.equal(cues[0].startTime, '00:01:24,840');
  assert.match(cues[0].text, /Nội dung cũ bị lặp/);
  assert.equal(cues[2].endTime, '00:01:28,000');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('formatSubtitleFile removes parenthetical ASR segmentation recreated by translation', () => {
  const { tempDir, subtitlePath } = writeSrt([
    '1', '00:02:48,128 --> 00:02:59,728',
    'Cuối cùng vẫn chỉ là hư vô. "(Tại sao) (lần đầu gặp mặt) (cậu lại không giết tôi?)" Denji-kun,', ''
  ]);

  formatSubtitleFile(subtitlePath, 1, 200);

  const [cue] = new Parser().fromSrt(fs.readFileSync(subtitlePath, 'utf8'));
  assert.equal(
    cue.text,
    'Cuối cùng vẫn chỉ là hư vô. "Tại sao lần đầu gặp mặt cậu lại không giết tôi?" Denji-kun,'
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('one-line preference no longer splits a long cue or redistributes its timestamp', () => {
  const { tempDir, subtitlePath } = writeSrt([
    '1', '00:00:02,667 --> 00:00:05,333',
    'Hôm nay ta bàn về nữ sát thủ ngốc nghếch nhất trong Gia Đình Điệp Viên', ''
  ]);

  formatSubtitleFile(subtitlePath, 1, 22);

  const cues = new Parser().fromSrt(fs.readFileSync(subtitlePath, 'utf8'));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startTime, '00:00:02,667');
  assert.equal(cues[0].endTime, '00:00:05,333');
  assert.equal(cues[0].text.includes('\n'), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
