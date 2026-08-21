'use strict';

const fs = require('fs');
const path = require('path');
const SrtParser = require('srt-parser-2').default;

const DEFAULT_TIMELINE_OPTIONS = Object.freeze({
  minimumGapMs: 80,
  overlapEpsilonMs: 20,
  minimumDisplayMs: 250
});

function parseSrtTime(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(value || '').trim());
  if (!match) return Number.NaN;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000)
    + Number(match[4].padEnd(3, '0'));
}

function formatSrtTime(milliseconds) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`
    + `${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function normalizeSubtitleTimeline(cues, options = {}) {
  const config = { ...DEFAULT_TIMELINE_OPTIONS, ...options };
  const minimumGapMs = Math.max(0, Number(config.minimumGapMs) || 0);
  const overlapEpsilonMs = Math.max(1, Number(config.overlapEpsilonMs) || 20);
  const minimumDisplayMs = Math.max(0, Number(config.minimumDisplayMs) || 0);
  const valid = (Array.isArray(cues) ? cues : [])
    .map((cue, sourceIndex) => ({
      ...cue,
      sourceIndex,
      startMs: Number.isFinite(cue.startMs) ? cue.startMs : parseSrtTime(cue.startTime),
      endMs: Number.isFinite(cue.endMs) ? cue.endMs : parseSrtTime(cue.endTime),
      text: String(cue.text || '').trim()
    }))
    .filter((cue) => (
      cue.text
      && Number.isFinite(cue.startMs)
      && Number.isFinite(cue.endMs)
      && cue.endMs > cue.startMs
    ))
    .sort((left, right) => left.startMs - right.startMs || left.sourceIndex - right.sourceIndex);

  const output = [];
  const report = {
    inputCues: Array.isArray(cues) ? cues.length : 0,
    validCues: valid.length,
    outputCues: 0,
    trimmedCues: 0,
    droppedSameStartCues: 0,
    restoredShortCues: 0,
    remainingShortCues: 0,
    minimumGapMs,
    minimumDisplayMs,
    changed: false
  };

  // Match ViralCrawl's final _chong_de pass: the later cue wins the
  // boundary, so trim the previous cue. Cues that start at effectively the
  // same instant are duplicates for a linear subtitle track; keep the first.
  for (const cue of valid) {
    if (output.length) {
      const previous = output[output.length - 1];
      const hasRealOverlap = cue.startMs < previous.endMs - overlapEpsilonMs;
      if (hasRealOverlap && cue.startMs - previous.startMs <= overlapEpsilonMs) {
        report.droppedSameStartCues += 1;
        report.changed = true;
        continue;
      }
      if (cue.startMs < previous.endMs + minimumGapMs) {
        const adjustedEnd = Math.max(
          previous.startMs + overlapEpsilonMs,
          Math.min(previous.endMs, cue.startMs - minimumGapMs)
        );
        if (adjustedEnd < previous.endMs) {
          previous.endMs = adjustedEnd;
          report.trimmedCues += 1;
          report.changed = true;
        }
      }
    }
    output.push({ ...cue });
  }

  // Match ViralCrawl's display-floor restoration after overlap trimming.
  // Borrow silence before a short cue only when doing so preserves the gap.
  for (let index = 0; index < output.length; index += 1) {
    const cue = output[index];
    if (minimumDisplayMs <= 0 || cue.endMs - cue.startMs >= minimumDisplayMs) continue;
    const previousBoundary = index > 0 ? output[index - 1].endMs + minimumGapMs : 0;
    const adjustedStart = Math.max(previousBoundary, cue.endMs - minimumDisplayMs);
    if (cue.endMs - adjustedStart >= minimumDisplayMs) {
      if (adjustedStart < cue.startMs) {
        cue.startMs = adjustedStart;
        report.restoredShortCues += 1;
        report.changed = true;
      }
    } else {
      report.remainingShortCues += 1;
    }
  }

  report.outputCues = output.length;
  return { cues: output, report };
}

function normalizeSubtitleTimelineFile(inputPath, outputPath, options = {}) {
  const parser = new SrtParser();
  const source = fs.readFileSync(inputPath, 'utf8');
  const parsed = parser.fromSrt(source);
  const { cues, report } = normalizeSubtitleTimeline(parsed, options);
  if (!cues.length) {
    const error = new Error('Phụ đề không còn cue hợp lệ sau khi sửa timeline');
    error.code = 'EMPTY_NORMALIZED_SUBTITLE_TIMELINE';
    throw error;
  }

  const serialized = parser.toSrt(cues.map((cue, index) => ({
    id: String(index + 1),
    startTime: formatSrtTime(cue.startMs),
    endTime: formatSrtTime(cue.endMs),
    text: cue.text
  })));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, serialized, 'utf8');
  fs.renameSync(temporaryPath, outputPath);
  return { path: outputPath, report };
}

module.exports = {
  DEFAULT_TIMELINE_OPTIONS,
  formatSrtTime,
  normalizeSubtitleTimeline,
  normalizeSubtitleTimelineFile,
  parseSrtTime
};
