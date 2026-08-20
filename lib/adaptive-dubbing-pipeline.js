'use strict';

const DEFAULT_POLICY = Object.freeze({
  maxSilenceMs: 1200,
  preserveGapMs: 3000,
  maxSpeed: 1.6,
  fitTolerance: 0.12,
  catchUp: true,
  catchUpThresholdMs: 300,
  catchUpMaxSpeed: 2.2,
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

  const rawGapMs = startMs - state.cursorMs;
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
  const speedCap = catchUp
    ? Math.min(policy.catchUpMaxSpeed, dynamicCatchUp)
    : policy.maxSpeed;
  const fitBudgetMs = catchUp
    ? Math.max(policy.minimumCueMs, endMs - placementStartMs)
    : cueDurationMs;
  const compressionThresholdMs = catchUp
    ? fitBudgetMs
    : fitBudgetMs * (1 + policy.fitTolerance);

  let speed = 1;
  if (rawDurationMs > compressionThresholdMs) {
    speed = Math.min(speedCap, rawDurationMs / fitBudgetMs);
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
    driftMs,
    fitBudgetMs,
    fittedDurationMs,
    speed,
    maxSpeed: speedCap,
    catchUp,
    capHit: rawDurationMs / fitBudgetMs > speedCap + 0.001,
    trimmedMs: 0
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

async function synthesizeWithFallback(options = {}) {
  const attempts = [];
  const engines = [options.primary, options.fallback]
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
  synthesizeWithFallback
};
