const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fitSubtitleCue,
  resolveDisplayMaxLines
} = require('../lib/subtitle-display-layout');

test('subtitle layout uses two lines for landscape and three for portrait', () => {
  assert.equal(resolveDisplayMaxLines(1920, 1080), 2);
  assert.equal(resolveDisplayMaxLines(1080, 1920), 3);
  assert.equal(resolveDisplayMaxLines(1080, 1080), 2);
});

test('long subtitle is wrapped for display without changing cue timing data', () => {
  const timing = { startTime: '00:00:02,667', endTime: '00:00:05,333' };
  const fitted = fitSubtitleCue(
    'Hôm nay ta bàn về nữ sát thủ ngốc nghếch nhất trong Gia Đình Điệp Viên',
    { fontSize: 48, maxLines: 2, boxWidth: 760 }
  );

  assert.ok(fitted.lines.length <= 2);
  assert.match(fitted.text, /\\N/);
  assert.deepEqual(timing, { startTime: '00:00:02,667', endTime: '00:00:05,333' });
});

test('display fitter reduces font size instead of producing extra subtitle cues', () => {
  const fitted = fitSubtitleCue('Một câu phụ đề rất dài '.repeat(8), {
    fontSize: 48,
    maxLines: 2,
    boxWidth: 900
  });
  assert.ok(fitted.fontSize < 48);
  assert.ok(fitted.lines.length <= 2);
});
