const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fitSubtitleCue,
  resolveDisplayMaxLines,
  resolveScaledSubtitleFontSize,
  resolveSubtitleScale,
  splitAbnormalCueForDisplay
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

test('subtitle font scales from the short video side while preserving current 1080p appearance', () => {
  assert.equal(resolveSubtitleScale(1920, 1080), 1.35);
  assert.equal(resolveSubtitleScale(1080, 1920), 1.35);
  assert.equal(resolveScaledSubtitleFontSize(32, 1920, 1080), 43);
  assert.equal(resolveScaledSubtitleFontSize(32, 1280, 720), 29);
  assert.equal(resolveScaledSubtitleFontSize(32, 3840, 2160), 86);
});

test('display fitter uses measured glyph widths when a font measurer is provided', () => {
  const measureText = (text, fontSize) => Array.from(text).reduce(
    (width, char) => width + (char === 'W' ? fontSize : fontSize * 0.2),
    0
  );
  const narrow = fitSubtitleCue('iiii iiii', {
    fontSize: 40,
    maxLines: 1,
    boxWidth: 100,
    measureText
  });
  const wide = fitSubtitleCue('WWWW WWWW', {
    fontSize: 40,
    maxLines: 1,
    boxWidth: 100,
    measureText
  });

  assert.equal(narrow.measured, true);
  assert.equal(wide.measured, true);
  assert.ok(wide.fontSize < narrow.fontSize);
});

test('abnormal cue splitting is display-only, contiguous and keeps exact outer timing', () => {
  const cue = {
    startMs: 1000,
    endMs: 13000,
    text: 'Đây là một câu phụ đề đặc biệt dài, cần được chia thành các nhịp đọc dễ nhìn hơn trước khi burn lên video, nhưng không được sửa SRT nguồn.'
  };
  const output = splitAbnormalCueForDisplay(cue);

  assert.ok(output.length > 1);
  assert.equal(output[0].startMs, cue.startMs);
  assert.equal(output.at(-1).endMs, cue.endMs);
  assert.ok(output.every(item => item.text.length > 0));
  for (let index = 1; index < output.length; index += 1) {
    assert.equal(output[index - 1].endMs, output[index].startMs);
  }
  assert.deepEqual(cue, {
    startMs: 1000,
    endMs: 13000,
    text: 'Đây là một câu phụ đề đặc biệt dài, cần được chia thành các nhịp đọc dễ nhìn hơn trước khi burn lên video, nhưng không được sửa SRT nguồn.'
  });
});

test('long-duration but short-text cue is preserved like the current ViralCrawl guard', () => {
  const cue = { startMs: 0, endMs: 20000, text: 'Một câu ngắn.' };
  assert.deepEqual(splitAbnormalCueForDisplay(cue), [
    { ...cue, splitFromAbnormalCue: false }
  ]);
});
