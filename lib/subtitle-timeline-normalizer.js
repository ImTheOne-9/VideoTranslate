'use strict';

const fs = require('fs');
const path = require('path');
const SrtParser = require('srt-parser-2').default;
const { traditionalToSimplified } = require('./zhconv-normalizer');

const SUBTITLE_POSTPROCESS_VERSION = 'viral-cue-v2';

const DEFAULT_TIMELINE_OPTIONS = Object.freeze({
  minimumGapMs: 80,
  overlapEpsilonMs: 20,
  minimumDisplayMs: 250,
  deepCleanup: false,
  duplicateWindow: 3,
  duplicateMaxGapMs: 3000,
  mergeDuplicateGapMs: 2000,
  mergeMaximumDurationMs: 6000,
  fragmentWindow: 2,
  fragmentMinimumLength: 4,
  fragmentMaxGapMs: 3000,
  distantDuplicateEnabled: true,
  distantDuplicateWindow: 8,
  destutterEnabled: true,
  coverageThreshold: 0.85,
  coverageBlockThreshold: 0.6
});

function numberFromEnvironment(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnvironment(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name] !== '0';
}

function resolveTimelineConfig(options) {
  const defaults = {
    ...DEFAULT_TIMELINE_OPTIONS,
    duplicateWindow: numberFromEnvironment('DEDUP_WIN', DEFAULT_TIMELINE_OPTIONS.duplicateWindow),
    duplicateMaxGapMs: numberFromEnvironment('DEDUP_MAX_GAP', 3) * 1000,
    mergeDuplicateGapMs: numberFromEnvironment('GOP_TRUNG_GAP', 2) * 1000,
    mergeMaximumDurationMs: numberFromEnvironment('GOP_TRUNG_MAXDUR', 6) * 1000,
    fragmentMinimumLength: numberFromEnvironment('BO_MANH_MINLEN', DEFAULT_TIMELINE_OPTIONS.fragmentMinimumLength),
    distantDuplicateEnabled: booleanFromEnvironment('DEDUP_XA', DEFAULT_TIMELINE_OPTIONS.distantDuplicateEnabled),
    distantDuplicateWindow: numberFromEnvironment('DEDUP_WIN_XA', DEFAULT_TIMELINE_OPTIONS.distantDuplicateWindow),
    destutterEnabled: booleanFromEnvironment('DUB_DESTUTTER', DEFAULT_TIMELINE_OPTIONS.destutterEnabled),
    coverageThreshold: numberFromEnvironment('SUBTITLE_COVERAGE_WARN_THRESHOLD', DEFAULT_TIMELINE_OPTIONS.coverageThreshold),
    coverageBlockThreshold: numberFromEnvironment('SUBTITLE_COVERAGE_BLOCK_THRESHOLD', DEFAULT_TIMELINE_OPTIONS.coverageBlockThreshold)
  };
  return { ...defaults, ...options };
}

function createSubtitlePostprocessSignature(options = {}) {
  const config = resolveTimelineConfig(options);
  return JSON.stringify({
    version: SUBTITLE_POSTPROCESS_VERSION,
    deepCleanup: Boolean(config.deepCleanup),
    minimumGapMs: Number(config.minimumGapMs),
    overlapEpsilonMs: Number(config.overlapEpsilonMs),
    minimumDisplayMs: Number(config.minimumDisplayMs),
    duplicateWindow: Number(config.duplicateWindow),
    duplicateMaxGapMs: Number(config.duplicateMaxGapMs),
    mergeDuplicateGapMs: Number(config.mergeDuplicateGapMs),
    mergeMaximumDurationMs: Number(config.mergeMaximumDurationMs),
    fragmentWindow: Number(config.fragmentWindow),
    fragmentMinimumLength: Number(config.fragmentMinimumLength),
    fragmentMaxGapMs: Number(config.fragmentMaxGapMs),
    distantDuplicateEnabled: Boolean(config.distantDuplicateEnabled),
    distantDuplicateWindow: Number(config.distantDuplicateWindow),
    destutterEnabled: Boolean(config.destutterEnabled),
    coverageThreshold: Number(config.coverageThreshold),
    coverageBlockThreshold: Number(config.coverageBlockThreshold)
  });
}

function normalizeComparableText(value) {
  return traditionalToSimplified(String(value || ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function sequenceMatcherRatio(left, right) {
  if (left === right) return left ? 1 : 0;
  if (!left || !right) return 0;
  let matches = 0;
  const ranges = [[0, left.length, 0, right.length]];
  while (ranges.length) {
    const [leftStart, leftEnd, rightStart, rightEnd] = ranges.pop();
    let bestLength = 0;
    let bestLeft = leftStart;
    let bestRight = rightStart;
    let previous = new Map();
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      const current = new Map();
      for (let rightIndex = rightStart; rightIndex < rightEnd; rightIndex += 1) {
        if (left[leftIndex] !== right[rightIndex]) continue;
        const length = (previous.get(rightIndex - 1) || 0) + 1;
        current.set(rightIndex, length);
        if (length > bestLength) {
          bestLength = length;
          bestLeft = leftIndex - length + 1;
          bestRight = rightIndex - length + 1;
        }
      }
      previous = current;
    }
    if (!bestLength) continue;
    matches += bestLength;
    if (leftStart < bestLeft && rightStart < bestRight) {
      ranges.push([leftStart, bestLeft, rightStart, bestRight]);
    }
    const leftAfter = bestLeft + bestLength;
    const rightAfter = bestRight + bestLength;
    if (leftAfter < leftEnd && rightAfter < rightEnd) {
      ranges.push([leftAfter, leftEnd, rightAfter, rightEnd]);
    }
  }
  return (2 * matches) / (left.length + right.length);
}

function temporalGapMs(left, right) {
  if (left.endMs <= right.startMs) return right.startMs - left.endMs;
  if (right.endMs <= left.startMs) return left.startMs - right.endMs;
  return 0;
}

function chooseLongerText(left, right) {
  return normalizeComparableText(right).length > normalizeComparableText(left).length ? right : left;
}

function mergeRelatedCues(cues, config, report) {
  if (!cues.length) return cues;
  const output = [{ ...cues[0] }];
  for (const cue of cues.slice(1)) {
    const previous = output[output.length - 1];
    const previousTextBeforeMerge = previous.text;
    const previousText = normalizeComparableText(previous.text);
    const cueText = normalizeComparableText(cue.text);
    const overlaps = cue.startMs < previous.endMs - config.overlapEpsilonMs;
    const exactlyRepeated = Boolean(previousText && cueText && previousText === cueText);
    const nearRepeated = Math.min(previousText.length, cueText.length) >= 6
      && sequenceMatcherRatio(previousText, cueText) >= 0.8;
    const mergedDuration = Math.max(previous.endMs, cue.endMs) - previous.startMs;
    const mergeNearDuplicate = exactlyRepeated
      && cue.startMs - previous.endMs <= config.mergeDuplicateGapMs
      && mergedDuration <= config.mergeMaximumDurationMs;

    if (!overlaps && !mergeNearDuplicate) {
      output.push({ ...cue });
      continue;
    }

    previous.endMs = Math.max(previous.endMs, cue.endMs);
    if (exactlyRepeated || nearRepeated) {
      previous.text = chooseLongerText(previous.text, cue.text);
    } else if (cueText && !previousText.includes(cueText)) {
      previous.text = `${previous.text.trim()} ${cue.text.trim()}`.trim();
    }
    if (overlaps) report.mergedOverlappingCues += 1;
    else report.mergedRepeatedCues += 1;
    if (report.mergedSamples.length < 5) {
      report.mergedSamples.push({
        firstText: previousTextBeforeMerge,
        mergedText: cue.text,
        reason: overlaps ? 'overlap' : 'repeated_nearby'
      });
    }
  }
  return output;
}

function markDrop(dropTargets, droppedIndex, retainedIndex) {
  if (droppedIndex === retainedIndex || dropTargets.has(droppedIndex)) return;
  dropTargets.set(droppedIndex, retainedIndex);
}

function resolveRetainedTarget(dropTargets, target) {
  const visited = new Set();
  let resolved = target;
  while (dropTargets.has(resolved) && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = dropTargets.get(resolved);
  }
  return resolved;
}

function removeMarkedCues(cues, dropTargets, reportField, sampleField, report) {
  if (!dropTargets.size) return cues;
  const mutable = cues.map((cue) => ({ ...cue }));
  for (const [droppedIndex, targetIndex] of dropTargets) {
    const retainedIndex = resolveRetainedTarget(dropTargets, targetIndex);
    if (retainedIndex >= 0 && retainedIndex < mutable.length && retainedIndex !== droppedIndex) {
      mutable[retainedIndex].startMs = Math.min(mutable[retainedIndex].startMs, mutable[droppedIndex].startMs);
      mutable[retainedIndex].endMs = Math.max(mutable[retainedIndex].endMs, mutable[droppedIndex].endMs);
    }
  }
  report[reportField] += dropTargets.size;
  for (const [droppedIndex, targetIndex] of [...dropTargets].slice(0, 5)) {
    report[sampleField].push({
      droppedIndex: droppedIndex + 1,
      droppedText: cues[droppedIndex].text,
      retainedIndex: resolveRetainedTarget(dropTargets, targetIndex) + 1
    });
  }
  return mutable.filter((cue, index) => !dropTargets.has(index));
}

function removeSplitAndRepeatedCues(cues, config, report) {
  if (cues.length < 2) return cues;
  const normalized = cues.map((cue) => normalizeComparableText(cue.text));
  const dropTargets = new Map();

  for (let index = 0; index < cues.length; index += 1) {
    if (dropTargets.has(index) || normalized[index].length < 6) continue;
    for (const pieceCount of [2, 3]) {
      const indexes = Array.from({ length: pieceCount }, (_, offset) => index + offset + 1);
      if (indexes.at(-1) >= cues.length || indexes.some((item) => dropTargets.has(item))) continue;
      if (temporalGapMs(cues[index], cues[indexes.at(-1)]) > config.duplicateMaxGapMs) continue;
      const joined = indexes.map((item) => normalized[item]).join('');
      if (joined && (
        joined === normalized[index]
        || (Math.min(joined.length, normalized[index].length) >= 6
          && sequenceMatcherRatio(joined, normalized[index]) >= 0.9)
      )) {
        indexes.forEach((item) => markDrop(dropTargets, item, index));
        break;
      }
    }
  }

  // ViralCrawl stage 1b: text can reveal as prefix → FULL → suffix.
  for (let index = 0; index < cues.length; index += 1) {
    if (dropTargets.has(index) || normalized[index].length < 8) continue;
    const full = normalized[index];
    const start = Math.max(0, index - config.duplicateWindow);
    const end = Math.min(cues.length, index + config.duplicateWindow + 1);
    const prefixes = [];
    const suffixes = [];
    for (let candidate = start; candidate < end; candidate += 1) {
      if (candidate === index || dropTargets.has(candidate)) continue;
      if (temporalGapMs(cues[index], cues[candidate]) > config.duplicateMaxGapMs) continue;
      const fragment = normalized[candidate];
      if (fragment.length < 5 || fragment.length >= full.length) continue;
      if (sequenceMatcherRatio(full.slice(0, fragment.length), fragment) >= 0.85) prefixes.push(candidate);
      if (sequenceMatcherRatio(full.slice(-fragment.length), fragment) >= 0.85) suffixes.push(candidate);
    }
    const minimumRatio = prefixes.length && suffixes.length ? 0.3 : 0.45;
    for (const candidate of new Set([...prefixes, ...suffixes])) {
      if (normalized[candidate].length >= minimumRatio * full.length) {
        markDrop(dropTargets, candidate, index);
      }
    }
  }

  for (let index = 0; index < cues.length; index += 1) {
    if (dropTargets.has(index) || normalized[index].length < 4) continue;
    const limit = Math.min(cues.length, index + config.duplicateWindow + 1);
    for (let candidate = index + 1; candidate < limit; candidate += 1) {
      if (dropTargets.has(candidate) || normalized[candidate].length < 4) continue;
      if (temporalGapMs(cues[index], cues[candidate]) > config.duplicateMaxGapMs) continue;
      const left = normalized[index];
      const right = normalized[candidate];
      const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
      const isLongEdgeFragment = shorter.length >= Math.max(4, Math.floor(longer.length * 0.6))
        && (longer.startsWith(shorter) || longer.endsWith(shorter));
      if (isLongEdgeFragment) {
        if (left.length <= right.length) markDrop(dropTargets, index, candidate);
        else markDrop(dropTargets, candidate, index);
        continue;
      }
      const isRepeated = left === right
        || (Math.min(left.length, right.length) >= 10 && sequenceMatcherRatio(left, right) >= 0.85);
      if (isRepeated) markDrop(dropTargets, candidate, index);
    }
  }

  if (config.distantDuplicateEnabled) {
    const counts = new Map();
    for (const text of normalized) {
      if (text.length >= 4 && text.length <= 8) counts.set(text, (counts.get(text) || 0) + 1);
    }
    for (let index = 0; index < cues.length; index += 1) {
      if (dropTargets.has(index)) continue;
      const text = normalized[index];
      if (text.length < 4 || text.length > 8 || (counts.get(text) || 0) < 3) continue;
      const start = index + config.duplicateWindow + 1;
      const end = Math.min(cues.length, index + config.distantDuplicateWindow + 1);
      for (let candidate = start; candidate < end; candidate += 1) {
        if (!dropTargets.has(candidate)
          && normalized[candidate] === text
          && temporalGapMs(cues[index], cues[candidate]) <= config.duplicateMaxGapMs) {
          markDrop(dropTargets, candidate, index);
        }
      }
    }
  }

  return removeMarkedCues(
    cues,
    dropTargets,
    'removedSplitOrRepeatedCues',
    'removedSplitOrRepeatedSamples',
    report
  );
}

function removeNeighborFragments(cues, config, report) {
  if (cues.length < 2) return cues;
  const normalized = cues.map((cue) => normalizeComparableText(cue.text));
  const dropTargets = new Map();
  for (let index = 0; index < cues.length; index += 1) {
    if (dropTargets.has(index) || normalized[index].length < config.fragmentMinimumLength) continue;
    const start = Math.max(0, index - config.fragmentWindow);
    const end = Math.min(cues.length, index + config.fragmentWindow + 1);
    for (let candidate = start; candidate < end; candidate += 1) {
      if (candidate === index || dropTargets.has(candidate)) continue;
      if (temporalGapMs(cues[index], cues[candidate]) > config.fragmentMaxGapMs) continue;
      if (normalized[index].length < normalized[candidate].length
        && normalized[candidate].includes(normalized[index])) {
        markDrop(dropTargets, index, candidate);
        break;
      }
    }
  }
  return removeMarkedCues(cues, dropTargets, 'removedFragmentCues', 'removedFragmentSamples', report);
}

function removeConsecutiveStutter(value, minimumCjk = 3, minimumWords = 3) {
  const text = String(value || '').trim();
  if (!text) return text;
  const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  const wordMode = /\s/u.test(text);
  if (!hasCjk && !wordMode) return text;
  const sequence = wordMode ? text.split(/\s+/u) : [...text];
  const minimumUnit = wordMode ? minimumWords : minimumCjk;
  let changed = true;
  while (changed) {
    changed = false;
    for (let length = Math.floor(sequence.length / 2); length >= minimumUnit; length -= 1) {
      let index = 0;
      while (index + (2 * length) <= sequence.length) {
        const unit = sequence.slice(index, index + length).join('\u0000');
        const next = sequence.slice(index + length, index + (2 * length)).join('\u0000');
        if (unit !== next) {
          index += 1;
          continue;
        }
        let repetitions = 2;
        while (index + ((repetitions + 1) * length) <= sequence.length
          && sequence.slice(index + (repetitions * length), index + ((repetitions + 1) * length)).join('\u0000') === unit) {
          repetitions += 1;
        }
        sequence.splice(index + length, (repetitions - 1) * length);
        changed = true;
      }
      if (changed) break;
    }
  }
  return sequence.join(wordMode ? ' ' : '');
}

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
  const config = resolveTimelineConfig(options);
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

  const report = {
    algorithmVersion: SUBTITLE_POSTPROCESS_VERSION,
    algorithmSignature: createSubtitlePostprocessSignature(config),
    inputCues: Array.isArray(cues) ? cues.length : 0,
    validCues: valid.length,
    invalidCues: Math.max(0, (Array.isArray(cues) ? cues.length : 0) - valid.length),
    outputCues: 0,
    trimmedCues: 0,
    droppedSameStartCues: 0,
    restoredShortCues: 0,
    remainingShortCues: 0,
    mergedOverlappingCues: 0,
    mergedRepeatedCues: 0,
    removedSplitOrRepeatedCues: 0,
    removedFragmentCues: 0,
    destutteredCues: 0,
    mergedSamples: [],
    removedSplitOrRepeatedSamples: [],
    removedFragmentSamples: [],
    destutterSamples: [],
    minimumGapMs,
    minimumDisplayMs,
    deepCleanup: Boolean(config.deepCleanup),
    coverageStartMs: null,
    coverageEndMs: null,
    coverageRatio: null,
    possibleTruncation: false,
    coverageRequiresAction: false,
    changed: false
  };

  let cleaned = valid;
  if (config.deepCleanup) {
    cleaned = mergeRelatedCues(cleaned, config, report);
    cleaned = removeSplitAndRepeatedCues(cleaned, config, report);
    cleaned = removeNeighborFragments(cleaned, config, report);
    cleaned = cleaned.map((cue) => {
      const text = config.destutterEnabled ? removeConsecutiveStutter(cue.text) : cue.text;
      if (text !== cue.text) {
        report.destutteredCues += 1;
        if (report.destutterSamples.length < 5) {
          report.destutterSamples.push({ before: cue.text, after: text });
        }
      }
      return { ...cue, text };
    });
  }

  const output = [];

  // Match ViralCrawl's final _chong_de pass: the later cue wins the
  // boundary, so trim the previous cue. Cues that start at effectively the
  // same instant are duplicates for a linear subtitle track; keep the first.
  for (const cue of cleaned) {
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
  report.changed = report.changed
    || report.mergedOverlappingCues > 0
    || report.mergedRepeatedCues > 0
    || report.removedSplitOrRepeatedCues > 0
    || report.removedFragmentCues > 0
    || report.destutteredCues > 0;
  if (output.length) {
    report.coverageStartMs = output[0].startMs;
    report.coverageEndMs = Math.max(...output.map((cue) => cue.endMs));
    const durationMs = Number(config.videoDurationMs);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      report.coverageRatio = Math.max(0, Math.min(1, report.coverageEndMs / durationMs));
      report.possibleTruncation = durationMs >= 60000
        && report.coverageRatio < Number(config.coverageThreshold || 0.85);
      report.coverageRequiresAction = durationMs >= 60000
        && report.coverageRatio < Number(config.coverageBlockThreshold || 0.6);
    }
  }
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
  SUBTITLE_POSTPROCESS_VERSION,
  createSubtitlePostprocessSignature,
  formatSrtTime,
  normalizeSubtitleTimeline,
  normalizeSubtitleTimelineFile,
  parseSrtTime,
  normalizeComparableText,
  removeConsecutiveStutter,
  sequenceMatcherRatio
};
