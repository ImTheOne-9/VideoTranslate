'use strict';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function countSpeechCharacters(text) {
  return (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, 0, 1);
}

function getModelConfidence(chunk) {
  for (const value of [chunk?.confidence, chunk?.score, chunk?.probability]) {
    const confidence = normalizeConfidence(value);
    if (confidence !== null) return confidence;
  }
  const averageLogProbability = Number(chunk?.avg_logprob);
  if (Number.isFinite(averageLogProbability)) {
    return clamp(Math.exp(averageLogProbability), 0, 1);
  }
  return null;
}

function hasRepeatedPhrase(text) {
  const normalized = String(text || '').normalize('NFKC').trim().toLowerCase();
  if (!normalized) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length >= 6) {
    for (let size = 1; size <= Math.min(6, Math.floor(tokens.length / 3)); size += 1) {
      const tail = tokens.slice(-size).join(' ');
      if (
        tokens.slice(-(size * 2), -size).join(' ') === tail
        && tokens.slice(-(size * 3), -(size * 2)).join(' ') === tail
      ) return true;
    }
  }
  return /(.{2,12})(?:\s*\1){2,}/u.test(normalized);
}

function assessAsrCue(cue) {
  const start = Number(cue?.start);
  const end = Number(cue?.end);
  const duration = end - start;
  const text = String(cue?.text || '').trim();
  const characterCount = countSpeechCharacters(text);
  const warnings = [];
  let qualityScore = 100;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    warnings.push('asr_invalid_timestamp');
    qualityScore -= 65;
  } else {
    const charactersPerSecond = duration > 0 ? characterCount / duration : 0;
    if (duration < 0.18 && characterCount >= 4) {
      warnings.push('asr_cue_too_short');
      qualityScore -= 30;
    }
    if (characterCount >= 18 && charactersPerSecond > 32) {
      warnings.push('asr_dense_text');
      qualityScore -= 35;
    }
  }
  if (hasRepeatedPhrase(text)) {
    warnings.push('asr_repeated_text');
    qualityScore -= 30;
  }

  const modelConfidence = getModelConfidence(cue);
  if (modelConfidence !== null) {
    qualityScore = Math.min(qualityScore, Math.round(modelConfidence * 100));
    if (modelConfidence < 0.55) warnings.push('asr_low_confidence');
  }

  return {
    modelConfidence,
    qualityScore: clamp(Math.round(qualityScore), 0, 100),
    qualitySource: modelConfidence === null ? 'heuristic' : 'model',
    warnings: [...new Set(warnings)]
  };
}

function aggregateAsrQuality(cues) {
  const values = (Array.isArray(cues) ? cues : []).filter(Boolean);
  if (!values.length) {
    return {
      modelConfidence: null,
      qualityScore: null,
      qualitySource: 'unavailable',
      warnings: []
    };
  }
  const scores = values
    .map((cue) => cue.qualityScore)
    .filter((value) => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  const confidences = values
    .map((cue) => cue.modelConfidence)
    .filter((value) => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  return {
    modelConfidence: confidences.length ? Math.min(...confidences) : null,
    qualityScore: scores.length ? Math.min(...scores) : null,
    qualitySource: confidences.length ? 'model' : 'heuristic',
    warnings: [...new Set(values.flatMap((cue) => cue.warnings || []))]
  };
}

module.exports = {
  aggregateAsrQuality,
  assessAsrCue,
  getModelConfidence,
  hasRepeatedPhrase
};
