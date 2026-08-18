const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildRegionCandidates,
  chooseBestAttempt,
  createTimedBlurBoxes,
  parseSrtCues,
  shouldProbeAdditionalRegions,
  writeOcrReport
} = require('../lib/dynamic-ocr');

test('automatic candidates never repeat the manually selected region', () => {
  const candidates = buildRegionCandidates('0.62,0.99,0.03,0.97');
  assert.equal(candidates.some((candidate) => candidate.region === '0.62,0.99,0.03,0.97'), false);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['lower_middle', 'middle', 'upper']);
});

test('best OCR attempt favors more distinct accepted cues and ignores rejected results', () => {
  const selected = chooseBestAttempt([
    { id: 'rejected', quality: { accepted: false, cueCount: 99 } },
    { id: 'small', quality: { accepted: true, cueCount: 2, distinctCueCount: 2 } },
    { id: 'complete', quality: { accepted: true, cueCount: 8, distinctCueCount: 7 } }
  ]);
  assert.equal(selected.id, 'complete');
});

test('long videos with suspiciously few cues trigger an additional region scan', () => {
  assert.equal(shouldProbeAdditionalRegions({ accepted: true, cueCount: 2 }, 180_000), true);
  assert.equal(shouldProbeAdditionalRegions({ accepted: true, cueCount: 5 }, 180_000), false);
  assert.equal(shouldProbeAdditionalRegions({ accepted: false, cueCount: 0 }, 10_000), true);
});

test('timed blur boxes merge adjacent cues but preserve real subtitle gaps', () => {
  const boxes = createTimedBlurBoxes([
    { startMs: 1000, endMs: 2000 },
    { startMs: 2100, endMs: 3000 },
    { startMs: 5000, endMs: 6000 }
  ], '0.70,0.98,0.05,0.95');

  assert.deepEqual(boxes, [
    { x: 5, y: 70, width: 90, height: 28, radius: 20, start: 0.92, end: 3.08, source: 'ocr' },
    { x: 5, y: 70, width: 90, height: 28, radius: 20, start: 4.92, end: 6.08, source: 'ocr' }
  ]);
});

test('OCR report contains selected region, cleaned cues and render-ready timed boxes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamic-ocr-'));
  try {
    const subtitlePath = path.join(directory, 'clean.srt');
    const reportPath = path.join(directory, 'ocr-report.json');
    await fs.writeFile(subtitlePath, '1\n00:00:01,000 --> 00:00:02,000\nXin chào\n\n2\n00:00:04,000 --> 00:00:05,000\nThế giới\n', 'utf8');
    const cues = await parseSrtCues(subtitlePath);
    assert.equal(cues.length, 2);

    const report = await writeOcrReport(reportPath, {
      strategy: 'auto',
      selectedRegion: '0.62,0.99,0.03,0.97',
      subtitlePath,
      quality: { accepted: true, cueCount: 2, distinctCueCount: 2, removedRepeatedLines: ['logo'] },
      attempts: [{ id: 'lower', region: '0.62,0.99,0.03,0.97', resultKind: 'success', quality: { accepted: true, cueCount: 2, reason: 'accepted' } }]
    });

    assert.equal(report.selectedRegion, '0.62,0.99,0.03,0.97');
    assert.equal(report.blurBoxes.length, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(reportPath, 'utf8')), report);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
