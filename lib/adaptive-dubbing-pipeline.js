'use strict';

const DEFAULT_POLICY = Object.freeze({
  maxSilenceMs: 1200,
  preserveGapMs: 3000,
  maxSpeed: 1.6,
  fitTolerance: 0.12,
  catchUp: true,
  catchUpThresholdMs: 300,
  catchUpMaxSpeed: 2.2,
  borrowLeadMs: 250,
  borrowTailMs: 250,
  maxOverflowMs: 200,
  redistributeClusters: false,
  clusterGapMs: 400,
  redistributeThreshold: 1.76,
  videoAssistMaxSlow: 0.20,
  videoAssistVoiceCap: 1.12,
  videoAssistMaxSegments: 1200,
  videoAssistGapAbsorbMs: 500,
  videoAssistFactorStep: 0.05,
  minimumCoverage: 0.5,
  minimumCueMs: 100
});

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createDubbingPolicy(overrides = {}) {
  const policy = {
    maxSilenceMs: Math.max(0, numberOr(overrides.maxSilenceMs, DEFAULT_POLICY.maxSilenceMs)),
    preserveGapMs: Math.max(0, numberOr(overrides.preserveGapMs, DEFAULT_POLICY.preserveGapMs)),
    maxSpeed: Math.max(1, numberOr(overrides.maxSpeed, DEFAULT_POLICY.maxSpeed)),
    fitTolerance: Math.max(0, numberOr(overrides.fitTolerance, DEFAULT_POLICY.fitTolerance)),
    catchUp: overrides.catchUp !== false,
    catchUpThresholdMs: Math.max(0, numberOr(
      overrides.catchUpThresholdMs,
      DEFAULT_POLICY.catchUpThresholdMs
    )),
    catchUpMaxSpeed: Math.max(1, numberOr(
      overrides.catchUpMaxSpeed,
      DEFAULT_POLICY.catchUpMaxSpeed
    )),
    borrowLeadMs: Math.max(0, numberOr(overrides.borrowLeadMs, DEFAULT_POLICY.borrowLeadMs)),
    borrowTailMs: Math.max(0, numberOr(overrides.borrowTailMs, DEFAULT_POLICY.borrowTailMs)),
    maxOverflowMs: Math.max(0, numberOr(overrides.maxOverflowMs, DEFAULT_POLICY.maxOverflowMs)),
    redistributeClusters: overrides.redistributeClusters === true,
    clusterGapMs: Math.max(0, numberOr(overrides.clusterGapMs, DEFAULT_POLICY.clusterGapMs)),
    redistributeThreshold: Math.max(1, numberOr(
      overrides.redistributeThreshold,
      DEFAULT_POLICY.redistributeThreshold
    )),
    videoAssistMaxSlow: Math.min(0.5, Math.max(0, numberOr(
      overrides.videoAssistMaxSlow,
      DEFAULT_POLICY.videoAssistMaxSlow
    ))),
    videoAssistVoiceCap: Math.max(1, numberOr(
      overrides.videoAssistVoiceCap,
      DEFAULT_POLICY.videoAssistVoiceCap
    )),
    videoAssistMaxSegments: Math.max(0, Math.floor(numberOr(
      overrides.videoAssistMaxSegments,
      DEFAULT_POLICY.videoAssistMaxSegments
    ))),
    videoAssistGapAbsorbMs: Math.max(0, numberOr(
      overrides.videoAssistGapAbsorbMs,
      DEFAULT_POLICY.videoAssistGapAbsorbMs
    )),
    videoAssistFactorStep: Math.max(0, numberOr(
      overrides.videoAssistFactorStep,
      DEFAULT_POLICY.videoAssistFactorStep
    )),
    minimumCoverage: Math.min(1, Math.max(0, numberOr(
      overrides.minimumCoverage,
      DEFAULT_POLICY.minimumCoverage
    ))),
    minimumCueMs: Math.max(1, numberOr(overrides.minimumCueMs, DEFAULT_POLICY.minimumCueMs))
  };
  if (policy.catchUpMaxSpeed < policy.maxSpeed) {
    policy.catchUpMaxSpeed = policy.maxSpeed;
  }
  return Object.freeze(policy);
}

function createTimelineState() {
  return {
    cursorMs: 0,
    silenceDebtMs: 0,
    planned: 0,
    compressed: 0,
    catchUps: 0,
    capHits: 0
  };
}

/**
 * Plans one cue on a sequential, non-overlapping narration timeline.
 * Small gaps are capped to reduce dead air; large gaps remain anchored to video.
 * Slight overflow is left natural. Real drift enables a stronger catch-up cap.
 */
function planAdaptiveCue(options = {}) {
  const policy = createDubbingPolicy(options.policy);
  const state = options.state || createTimelineState();
  const startMs = Math.max(0, Math.round(numberOr(options.startMs, 0)));
  const endMs = Math.max(startMs + policy.minimumCueMs, Math.round(numberOr(options.endMs, startMs)));
  const rawDurationMs = Math.max(1, Math.round(numberOr(options.rawDurationMs, 1)));

  const availableLeadMs = Math.max(0, Math.round(numberOr(options.availableLeadMs, 0)));
  const availableTailMs = Math.max(0, Math.round(numberOr(options.availableTailMs, 0)));
  const overflowNeedMs = Math.max(0, rawDurationMs - Math.max(policy.minimumCueMs, endMs - startMs));
  const leadSafetyMs = availableLeadMs > 0 ? 30 : 0;
  const tailSafetyMs = options.isLastCue === true ? 0 : (availableTailMs > 0 ? 30 : 0);
  const borrowedLeadMs = Math.min(
    policy.borrowLeadMs,
    Math.max(0, availableLeadMs - leadSafetyMs),
    startMs,
    overflowNeedMs
  );
  const borrowedTailMs = Math.min(
    policy.borrowTailMs,
    Math.max(0, availableTailMs - tailSafetyMs),
    Math.max(0, overflowNeedMs - borrowedLeadMs)
  );
  const effectiveStartMs = Math.max(0, startMs - borrowedLeadMs);
  const effectiveEndMs = endMs + borrowedTailMs;
  const rawGapMs = effectiveStartMs - state.cursorMs;
  let insertedSilenceMs = 0;
  if (rawGapMs > 30) {
    if (policy.preserveGapMs === 0 || rawGapMs > policy.preserveGapMs) {
      insertedSilenceMs = rawGapMs;
      state.silenceDebtMs = 0;
    } else {
      const baseSilenceMs = Math.min(rawGapMs, policy.maxSilenceMs);
      const spareMs = Math.max(0, rawGapMs - baseSilenceMs);
      const debtPaymentMs = Math.min(spareMs, state.silenceDebtMs);
      insertedSilenceMs = baseSilenceMs + debtPaymentMs;
      state.silenceDebtMs = Math.max(0, state.silenceDebtMs - debtPaymentMs)
        + Math.max(0, rawGapMs - insertedSilenceMs);
    }
  }

  const placementStartMs = Math.max(0, Math.round(state.cursorMs + insertedSilenceMs));
  const cueDurationMs = Math.max(policy.minimumCueMs, endMs - startMs);
  const driftMs = placementStartMs - startMs;
  const catchUp = policy.catchUp && driftMs > policy.catchUpThresholdMs;
  const dynamicCatchUp = policy.maxSpeed + Math.min(Math.max(0, driftMs) / 2000, 0.9);
  let speedCap = catchUp
    ? Math.min(policy.catchUpMaxSpeed, dynamicCatchUp)
    : policy.maxSpeed;
  const fitBudgetMs = Math.max(policy.minimumCueMs, effectiveEndMs - placementStartMs);
  const enforceOverflowCap = options.enforceMaxOverflow === true && !catchUp;
  const absoluteOverflowTargetMs = fitBudgetMs + policy.maxOverflowMs;
  if (enforceOverflowCap) speedCap = Math.max(speedCap, policy.catchUpMaxSpeed);
  const compressionThresholdMs = catchUp
    ? fitBudgetMs
    : enforceOverflowCap
      ? absoluteOverflowTargetMs
      : fitBudgetMs * (1 + policy.fitTolerance);

  let speed = 1;
  if (rawDurationMs > compressionThresholdMs) {
    speed = Math.min(
      speedCap,
      rawDurationMs / Math.max(1, enforceOverflowCap ? absoluteOverflowTargetMs : fitBudgetMs)
    );
  }
  speed = Math.max(1, Math.ceil(speed * 1000) / 1000);
  const fittedDurationMs = Math.max(1, Math.ceil(rawDurationMs / speed));
  const placementEndMs = placementStartMs + fittedDurationMs;

  state.cursorMs = placementEndMs;
  state.planned += 1;
  if (speed > 1.001) state.compressed += 1;
  if (catchUp) state.catchUps += 1;
  if (rawDurationMs / fitBudgetMs > speedCap + 0.001) state.capHits += 1;

  return {
    version: 1,
    mode: 'adaptive-cue',
    status: speed > 1.001 ? (catchUp ? 'catch_up' : 'compressed') : 'natural',
    startMs,
    endMs,
    cueDurationMs,
    rawDurationMs,
    placementStartMs,
    placementEndMs,
    insertedSilenceMs,
    borrowedLeadMs,
    borrowedTailMs,
    driftMs,
    fitBudgetMs,
    fittedDurationMs,
    speed,
    maxSpeed: speedCap,
    catchUp,
    capHit: rawDurationMs / fitBudgetMs > speedCap + 0.001,
    overflowMs: Math.max(0, placementEndMs - effectiveEndMs),
    trimmedMs: 0
  };
}

function mergeWarpSegments(segments) {
  const merged = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const startMs = Math.max(0, Math.round(numberOr(segment.startMs, 0)));
    const endMs = Math.max(startMs, Math.round(numberOr(segment.endMs, startMs)));
    const factor = Math.min(1, Math.max(0.5, numberOr(segment.factor, 1)));
    if (endMs <= startMs) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.endMs === startMs && Math.abs(previous.factor - factor) < 0.001) {
      previous.endMs = endMs;
    } else {
      merged.push({ startMs, endMs, factor });
    }
  }
  let outputCursorMs = 0;
  return merged.map((segment) => {
    const outputStartMs = outputCursorMs;
    outputCursorMs += Math.round((segment.endMs - segment.startMs) / segment.factor);
    return { ...segment, outputStartMs, outputEndMs: outputCursorMs };
  });
}

function warpTimeMs(value, timeWarp) {
  const inputMs = Math.max(0, numberOr(value, 0));
  const segments = Array.isArray(timeWarp) ? timeWarp : [];
  if (!segments.length) return Math.round(inputMs);
  for (const segment of segments) {
    if (inputMs < segment.startMs) break;
    if (inputMs <= segment.endMs) {
      return Math.round(segment.outputStartMs + (inputMs - segment.startMs) / segment.factor);
    }
  }
  const last = segments[segments.length - 1];
  return Math.round(last.outputEndMs + Math.max(0, inputMs - last.endMs));
}

function buildVideoAssistWarp(items, totalDurationMs, policy) {
  const endOfVideoMs = Math.round(numberOr(totalDurationMs, 0));
  if (
    policy.videoAssistMaxSlow <= 0
    || !Array.isArray(items)
    || !items.length
    || endOfVideoMs <= 0
  ) return [];
  const quantizeFactor = (factor) => {
    const step = policy.videoAssistFactorStep;
    if (step <= 0 || factor >= 0.999) return factor >= 0.999 ? 1 : factor;
    const quantized = Number((Math.round(factor / step) * step).toFixed(6));
    return Math.max(1 - policy.videoAssistMaxSlow, Math.min(1, quantized));
  };
  const raw = [];
  let cursorMs = 0;
  items.forEach((item) => {
    const startMs = Math.max(cursorMs, item.startMs);
    const endMs = Math.min(endOfVideoMs, Math.max(startMs, item.endMs));
    if (startMs > cursorMs) raw.push({ startMs: cursorMs, endMs: startMs, factor: 1 });
    const slotMs = Math.max(policy.minimumCueMs, endMs - startMs);
    const need = Math.max(1, item.rawDurationMs / slotMs);
    const factor = need > policy.videoAssistVoiceCap + 0.001
      ? quantizeFactor(Math.max(1 - policy.videoAssistMaxSlow, policy.videoAssistVoiceCap / need))
      : 1;
    raw.push({ startMs, endMs, factor });
    cursorMs = endMs;
  });
  if (endOfVideoMs > cursorMs) raw.push({ startMs: cursorMs, endMs: endOfVideoMs, factor: 1 });
  if (!raw.some((segment) => segment.factor < 0.999)) return [];

  // ViralCrawl absorbs a tiny natural-speed gap into the preceding slow region,
  // then merges equal (quantized) factors before enforcing the graph-size cap.
  const absorbed = [];
  for (let rawIndex = 0; rawIndex < raw.length; rawIndex += 1) {
    const segment = raw[rawIndex];
    const previous = absorbed.at(-1);
    const next = raw[rawIndex + 1];
    if (
      previous
      && previous.factor < 0.999
      && segment.factor >= 0.999
      && segment.endMs - segment.startMs < policy.videoAssistGapAbsorbMs
      && next?.factor < 0.999
    ) {
      previous.endMs = segment.endMs;
    } else {
      absorbed.push({ ...segment });
    }
  }
  let merged = mergeWarpSegments(absorbed);
  if (policy.videoAssistMaxSegments > 0 && merged.length > policy.videoAssistMaxSegments) {
    const slowIndexes = merged
      .map((segment, index) => ({ index, factor: segment.factor }))
      .filter((item) => item.factor < 0.999)
      .sort((left, right) => left.factor - right.factor);
    const keepCount = Math.max(1, Math.floor(policy.videoAssistMaxSegments / 2));
    const keep = new Set(slowIndexes.slice(0, keepCount).map((item) => item.index));
    merged = mergeWarpSegments(merged.map((segment, index) => ({
      ...segment,
      factor: segment.factor < 0.999 && !keep.has(index) ? 1 : segment.factor
    })));
  }
  return merged;
}

function redistributeCueWindows(items, policy) {
  const output = items.map((item) => ({ ...item }));
  if (!policy.redistributeClusters || output.length < 2) return output;
  let clusterStart = 0;
  const flush = (clusterEnd) => {
    if (clusterEnd <= clusterStart) return;
    const cluster = output.slice(clusterStart, clusterEnd + 1);
    const clusterEndMs = cluster.at(-1).endMs;
    const availableMs = clusterEndMs - cluster[0].startMs;
    const rawTotalMs = cluster.reduce((sum, item) => sum + item.rawDurationMs, 0);
    const strongestNeed = Math.max(...cluster.map((item) => (
      item.rawDurationMs / Math.max(policy.minimumCueMs, item.endMs - item.startMs)
    )));
    if (strongestNeed <= policy.redistributeThreshold || rawTotalMs <= 0 || availableMs <= 0) return;
    let cursorMs = cluster[0].startMs;
    cluster.forEach((item, offset) => {
      const isLast = offset === cluster.length - 1;
      const remainingItems = cluster.length - offset - 1;
      const maximumShareMs = Math.max(
        policy.minimumCueMs,
        clusterEndMs - cursorMs - remainingItems * policy.minimumCueMs
      );
      const proportionalMs = Math.round(availableMs * item.rawDurationMs / rawTotalMs);
      const shareMs = isLast ? clusterEndMs - cursorMs : Math.min(maximumShareMs, Math.max(
        policy.minimumCueMs,
        proportionalMs
      ));
      output[clusterStart + offset].startMs = cursorMs;
      output[clusterStart + offset].endMs = cursorMs + shareMs;
      cursorMs += shareMs;
    });
    output[clusterEnd].endMs = clusterEndMs;
  };
  for (let index = 1; index < output.length; index++) {
    if (output[index].startMs - output[index - 1].endMs > policy.clusterGapMs) {
      flush(index - 1);
      clusterStart = index;
    }
  }
  flush(output.length - 1);
  return output;
}

function planAdaptiveTimeline(items, totalDurationMs, policyOverrides = {}) {
  const policy = createDubbingPolicy(policyOverrides);
  const ordered = (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      ...item,
      cueIndex: Number.isInteger(item.cueIndex) ? item.cueIndex : index,
      startMs: Math.max(0, Math.round(numberOr(item.startMs, 0))),
      endMs: Math.max(0, Math.round(numberOr(item.endMs, 0))),
      rawDurationMs: Math.max(1, Math.round(numberOr(item.rawDurationMs, 1)))
    }))
    .sort((left, right) => left.startMs - right.startMs || left.cueIndex - right.cueIndex);
  const timeWarp = buildVideoAssistWarp(ordered, totalDurationMs, policy);
  const warped = ordered.map((item) => ({
    ...item,
    originalStartMs: item.startMs,
    originalEndMs: item.endMs,
    startMs: warpTimeMs(item.startMs, timeWarp),
    endMs: warpTimeMs(item.endMs, timeWarp)
  }));
  const redistributed = redistributeCueWindows(warped, policy);
  const state = createTimelineState();
  let borrowedMs = 0;
  let overflowMs = 0;
  const placements = redistributed.map((item, index) => {
    const previousEndMs = index > 0 ? redistributed[index - 1].endMs : 0;
    const nextStartMs = index + 1 < redistributed.length
      ? redistributed[index + 1].startMs
      : warpTimeMs(totalDurationMs, timeWarp);
    const plan = planAdaptiveCue({
      startMs: item.startMs,
      endMs: item.endMs,
      rawDurationMs: item.rawDurationMs,
      availableLeadMs: Math.max(0, item.startMs - previousEndMs),
      availableTailMs: Math.max(0, nextStartMs - item.endMs),
      isLastCue: index === redistributed.length - 1,
      enforceMaxOverflow: true,
      state,
      policy
    });
    borrowedMs += plan.borrowedLeadMs + plan.borrowedTailMs;
    overflowMs += plan.overflowMs;
    return { ...item, ...plan, cueIndex: item.cueIndex };
  });
  return {
    policy,
    placements,
    timeWarp,
    outputDurationMs: warpTimeMs(totalDurationMs, timeWarp),
    stats: {
      ...state,
      borrowedMs,
      overflowMs,
      redistributed: redistributed.filter((item, index) => (
        item.startMs !== warped[index].startMs || item.endMs !== warped[index].endMs
      )).length,
      slowedSegments: timeWarp.filter((item) => item.factor < 0.999).length
    }
  };
}

function evaluateCoverage(totalCues, successfulCues, policyOverrides = {}) {
  const policy = createDubbingPolicy(policyOverrides);
  const total = Math.max(0, Math.round(numberOr(totalCues, 0)));
  const successful = Math.min(total, Math.max(0, Math.round(numberOr(successfulCues, 0))));
  const ratio = total > 0 ? successful / total : 0;
  return {
    total,
    successful,
    missing: Math.max(0, total - successful),
    ratio,
    minimum: policy.minimumCoverage,
    accepted: total > 0 && ratio >= policy.minimumCoverage
  };
}

function preparePiperCueText(text, nextCue, options = {}) {
  const normalized = String(text || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  const terminal = normalized.replace(/["'”’)»】』]+$/g, '');
  if (!normalized || !nextCue || /[.!?…。！？,，;；:]$/.test(terminal)) return normalized;
  const currentEndMs = Math.max(0, numberOr(options.currentEndMs, 0));
  const nextStartMs = Math.max(0, numberOr(options.nextStartMs, currentEndMs));
  const continuationGapMs = Math.max(0, numberOr(options.continuationGapMs, 600));
  const currentId = Number(options.currentId);
  const nextId = Number(options.nextId);
  if (Number.isFinite(currentId) && Number.isFinite(nextId) && nextId !== currentId + 1) return normalized;
  return nextStartMs - currentEndMs <= continuationGapMs ? `${normalized},` : normalized;
}

function alignSubtitleCuesToNarration(cues, placements, options = {}) {
  const minimumDurationMs = Math.max(100, numberOr(options.minimumDurationMs, 350));
  const placementByIndex = new Map(
    (Array.isArray(placements) ? placements : [])
      .filter((item) => Number.isInteger(item?.cueIndex))
      .map((item) => [item.cueIndex, item])
  );
  return (Array.isArray(cues) ? cues : []).map((cue, cueIndex) => {
    const placement = placementByIndex.get(cueIndex);
    if (!placement) return { ...cue };
    const startMs = Math.max(0, Math.round(numberOr(placement.startMs, 0)));
    const requestedEndMs = Math.max(
      startMs + minimumDurationMs,
      Math.round(numberOr(placement.endMs, startMs + minimumDurationMs))
    );
    const nextPlacement = placementByIndex.get(cueIndex + 1);
    const nextStartMs = nextPlacement
      ? Math.max(startMs + minimumDurationMs, Math.round(numberOr(nextPlacement.startMs, requestedEndMs)))
      : null;
    const endMs = nextStartMs == null
      ? requestedEndMs
      : Math.max(startMs + minimumDurationMs, Math.min(requestedEndMs, nextStartMs - 20));
    return {
      ...cue,
      startTime: msToSrtTimestamp(startMs),
      endTime: msToSrtTimestamp(endMs)
    };
  });
}

function srtTimestampToMs(value) {
  const match = String(value || '').match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return 0;
  return Number(match[1]) * 3600000 + Number(match[2]) * 60000
    + Number(match[3]) * 1000 + Number(match[4]);
}

function evaluateOnsetAlignment(cues, placements, options = {}) {
  const source = Array.isArray(cues) ? cues : [];
  const unique = new Map();
  for (const placement of Array.isArray(placements) ? placements : []) {
    if (Number.isInteger(placement?.cueIndex) && placement.cueIndex >= 0 && placement.cueIndex < source.length) {
      unique.set(placement.cueIndex, placement);
    }
  }
  const ordered = [...unique.entries()].sort((a, b) => a[0] - b[0]);
  const minimumCoverage = Math.min(1, Math.max(0, numberOr(options.minimumCoverage, 0.7)));
  const ratio = source.length ? ordered.length / source.length : 0;
  const reasons = [];
  if (!source.length || ratio < minimumCoverage) reasons.push('insufficient_coverage');
  if (ordered.length >= 2 && source.length >= 2) {
    const sourceStarts = source.map((cue) => srtTimestampToMs(cue.startTime));
    const sourceEnd = srtTimestampToMs(source[source.length - 1].endTime);
    const sourceSpan = Math.max(1, sourceEnd - sourceStarts[0]);
    const firstIndex = ordered[0][0];
    const lastIndex = ordered[ordered.length - 1][0];
    const edgeLimit = Math.min(0.5, Math.max(0.05, numberOr(options.edgeCoverageLimit, 0.25)));
    if ((sourceStarts[firstIndex] - sourceStarts[0]) / sourceSpan > edgeLimit) reasons.push('missing_start_span');
    if ((sourceEnd - srtTimestampToMs(source[lastIndex].endTime)) / sourceSpan > edgeLimit) {
      reasons.push('missing_end_span');
    }
    const outputStarts = ordered.map(([, placement]) => Math.max(0, numberOr(placement.startMs, 0)));
    const coveredSourceStarts = ordered.map(([index]) => sourceStarts[index]);
    const coveredSourceSpan = Math.max(1, coveredSourceStarts.at(-1) - coveredSourceStarts[0]);
    const outputSpan = Math.max(0, outputStarts.at(-1) - outputStarts[0]);
    if (outputSpan / coveredSourceSpan < 0.5) reasons.push('clustered_onsets');
    for (let index = 1; index < outputStarts.length; index++) {
      if (outputStarts[index] < outputStarts[index - 1]) {
        reasons.push('non_monotonic_onsets');
        break;
      }
    }
  }
  return {
    accepted: reasons.length === 0,
    total: source.length,
    onsets: ordered.length,
    ratio,
    minimumCoverage,
    reasons
  };
}

function msToSrtTimestamp(value) {
  const totalMs = Math.max(0, Math.round(numberOr(value, 0)));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    + `:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function resolveSafeNarrationPlacement(placement = {}, actualDurationMs, cursorMs = 0) {
  const startMs = Math.max(
    0,
    Math.round(numberOr(placement.placementStartMs ?? placement.startMs, 0)),
    Math.round(numberOr(cursorMs, 0))
  );
  const durationMs = Math.max(1, Math.round(numberOr(actualDurationMs, 1)));
  return { startMs, endMs: startMs + durationMs, durationMs };
}

async function synthesizeWithFallback(options = {}) {
  const attempts = [];
  const engines = [options.primary, ...(options.fallbacks || []), options.fallback]
    .filter(Boolean)
    .filter((engine, index, list) => list.findIndex((item) => item.id === engine.id) === index);
  let lastError = null;

  for (const engine of engines) {
    try {
      await options.beforeAttempt?.(engine);
      const result = await options.synthesize(engine);
      const valid = options.validate ? await options.validate(result, engine) : true;
      if (!valid) throw new Error('Engine tạo file âm thanh rỗng hoặc không hợp lệ');
      attempts.push({ engineId: engine.id, ok: true });
      return {
        result,
        engine,
        fallback: engine.id !== options.primary?.id,
        attempts
      };
    } catch (error) {
      lastError = error;
      attempts.push({ engineId: engine.id, ok: false, error: error.message });
      await options.onAttemptError?.(error, engine);
    }
  }

  const error = new Error(lastError?.message || 'Không engine nào tạo được giọng nói');
  error.code = lastError?.code || 'DUBBING_ALL_ENGINES_FAILED';
  error.attempts = attempts;
  error.cause = lastError;
  throw error;
}

module.exports = {
  DEFAULT_POLICY,
  createDubbingPolicy,
  createTimelineState,
  evaluateCoverage,
  evaluateOnsetAlignment,
  alignSubtitleCuesToNarration,
  preparePiperCueText,
  planAdaptiveCue,
  planAdaptiveTimeline,
  resolveSafeNarrationPlacement,
  warpTimeMs,
  synthesizeWithFallback
};
