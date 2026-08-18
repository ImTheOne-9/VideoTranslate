const fs = require('node:fs/promises');
const SrtParser = require('srt-parser-2').default;

const AUTO_REGIONS = Object.freeze([
  { id: 'lower', region: '0.62,0.99,0.03,0.97' },
  { id: 'lower_middle', region: '0.45,0.78,0.03,0.97' },
  { id: 'middle', region: '0.24,0.62,0.03,0.97' },
  { id: 'upper', region: '0.03,0.38,0.03,0.97' }
]);

function timestampToMs(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/u.exec(String(value || '').trim());
  if (!match) return null;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000)
    + Number(match[4].padEnd(3, '0'));
}

function normalizeStrategy(value) {
  return value === 'auto' ? 'auto' : 'manual';
}

function buildRegionCandidates(primaryRegion) {
  const seen = new Set([primaryRegion]);
  return AUTO_REGIONS.filter(({ region }) => {
    if (seen.has(region)) return false;
    seen.add(region);
    return true;
  });
}

function scoreAttempt(attempt) {
  if (!attempt?.quality?.accepted) return Number.NEGATIVE_INFINITY;
  const cueCount = Number(attempt.quality.cueCount) || 0;
  const distinctCueCount = Number(attempt.quality.distinctCueCount) || cueCount;
  const watermarkCount = Array.isArray(attempt.quality.removedRepeatedLines)
    ? attempt.quality.removedRepeatedLines.length
    : 0;
  return (cueCount * 100) + (distinctCueCount * 25) - (watermarkCount * 8);
}

function chooseBestAttempt(attempts) {
  return attempts
    .filter((attempt) => attempt?.quality?.accepted)
    .sort((left, right) => scoreAttempt(right) - scoreAttempt(left))[0] || null;
}

function shouldProbeAdditionalRegions(quality, durationMs) {
  if (!quality?.accepted) return true;
  const durationSeconds = Math.max(0, Number(durationMs) || 0) / 1000;
  const expectedMinimum = Math.max(2, Math.min(8, Math.ceil(durationSeconds / 45)));
  return (Number(quality.cueCount) || 0) < expectedMinimum;
}

async function parseSrtCues(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parser = new SrtParser();
    return parser.fromSrt(content).flatMap((cue) => {
      const startMs = timestampToMs(cue.startTime);
      const endMs = timestampToMs(cue.endTime);
      if (startMs === null || endMs === null || endMs <= startMs || !String(cue.text || '').trim()) return [];
      return [{ startMs, endMs, text: String(cue.text).trim() }];
    });
  } catch {
    return [];
  }
}

function createTimedBlurBoxes(cues, region, options = {}) {
  const values = String(region).split(',').map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return [];
  const [top, bottom, left, right] = values;
  const mergeGapMs = Math.max(0, Number(options.mergeGapMs) || 180);
  const paddingMs = Math.max(0, Number(options.paddingMs) || 80);
  const intervals = [];

  for (const cue of [...cues].sort((a, b) => a.startMs - b.startMs)) {
    const startMs = Math.max(0, cue.startMs - paddingMs);
    const endMs = cue.endMs + paddingMs;
    const previous = intervals.at(-1);
    if (previous && startMs <= previous.endMs + mergeGapMs) {
      previous.endMs = Math.max(previous.endMs, endMs);
    } else {
      intervals.push({ startMs, endMs });
    }
  }

  return intervals.map((interval) => ({
    x: Number((left * 100).toFixed(3)),
    y: Number((top * 100).toFixed(3)),
    width: Number(((right - left) * 100).toFixed(3)),
    height: Number(((bottom - top) * 100).toFixed(3)),
    radius: 20,
    start: Number((interval.startMs / 1000).toFixed(3)),
    end: Number((interval.endMs / 1000).toFixed(3)),
    source: 'ocr'
  }));
}

async function writeOcrReport(reportPath, details) {
  const cues = await parseSrtCues(details.subtitlePath);
  const report = {
    version: 1,
    source: 'ocr',
    strategy: normalizeStrategy(details.strategy),
    selectedRegion: details.selectedRegion,
    cueCount: Number(details.quality?.cueCount) || cues.length,
    distinctCueCount: Number(details.quality?.distinctCueCount) || 0,
    removedWatermarks: Array.isArray(details.quality?.removedRepeatedLines)
      ? details.quality.removedRepeatedLines
      : [],
    attempts: (details.attempts || []).map((attempt) => ({
      id: attempt.id,
      region: attempt.region,
      result: attempt.resultKind,
      accepted: Boolean(attempt.quality?.accepted),
      cueCount: Number(attempt.quality?.cueCount) || 0,
      reason: attempt.quality?.reason || attempt.reason || null
    })),
    blurBoxes: createTimedBlurBoxes(cues, details.selectedRegion),
    generatedAt: new Date().toISOString()
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

module.exports = {
  AUTO_REGIONS,
  buildRegionCandidates,
  chooseBestAttempt,
  createTimedBlurBoxes,
  normalizeStrategy,
  parseSrtCues,
  scoreAttempt,
  shouldProbeAdditionalRegions,
  writeOcrReport
};
