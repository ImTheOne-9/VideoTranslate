const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { convertSrtToAss } = require('../controllers/studioController');

test('ASS burn conversion measures text and splits only the display copy of an abnormal cue', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ass-test-'));
  const srtPath = path.join(workDir, 'translated.srt');
  const assPath = path.join(workDir, 'render.ass');
  const source = [
    '1',
    '00:00:01,000 --> 00:00:13,000',
    'Đây là một câu phụ đề đặc biệt dài, cần được chia thành các nhịp dễ đọc ngay trước khi burn lên video, nhưng tuyệt đối không được làm thay đổi tệp SRT nguồn.',
    ''
  ].join('\n');
  fs.writeFileSync(srtPath, source, 'utf8');

  try {
    const report = await convertSrtToAss(srtPath, assPath, {
      videoWidth: 1920,
      videoHeight: 1080,
      fontName: 'Arial',
      fontSize: 43,
      assColor: '&H00FFFFFF',
      isBold: true,
      borderStyle: 1,
      outline: 3,
      shadow: 1,
      outlineColor: '&H00000000',
      backColor: '&H80000000',
      alignment: 2,
      marginV: 28,
      marginL: 20,
      marginR: 20,
      theme: 'outline',
      maxLines: 2,
      fontMeasurer: {
        provider: 'test-metrics',
        measuredTokens: 1,
        measureText: (text, size) => Array.from(text).length * size * 0.5
      }
    });
    const ass = fs.readFileSync(assPath, 'utf8');
    const dialogueLines = ass.split(/\r?\n/u).filter(line => line.startsWith('Dialogue:'));

    assert.equal(report.provider, 'test-metrics');
    assert.equal(report.inputCues, 1);
    assert.ok(report.outputCues > report.inputCues);
    assert.equal(dialogueLines.length, report.outputCues);
    assert.match(ass, /Style: Default,Arial,43,/u);
    assert.equal(fs.readFileSync(srtPath, 'utf8'), source);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
