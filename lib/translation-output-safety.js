'use strict';

const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/gu;
const HAN_RUN_RE = /[\u3400-\u9fff\uf900-\ufaff]+/gu;
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/gu;
const KANA_RUN_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]+/gu;

function countMatches(value, expression) {
  return (String(value || '').match(expression) || []).length;
}

function hanRatio(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const meaningful = text.replace(/\s+/gu, '');
  return meaningful ? countMatches(text, HAN_RE) / meaningful.length : 0;
}

function hasKana(value) {
  return countMatches(value, KANA_RE) > 0;
}

function stripResidualCjk(value) {
  let text = String(value || '');
  const removed = countMatches(text, HAN_RE) + countMatches(text, KANA_RE);
  if (!removed) return { text: text.trim(), removed: 0 };
  text = text.replace(HAN_RUN_RE, ' ').replace(KANA_RUN_RE, ' ');
  text = text.replace(/\s+/gu, ' ').trim();
  text = text.replace(/\s+([,.!?;:\u2026\uff0c\u3002\uff01\uff1f\uff1b\uff1a\u3001])/gu, '$1');
  text = text.replace(/([([\u00ab"'\u300c\u300e\uff08\u3010\u3008\u300a\u3014\uff62])\s+/gu, '$1');
  const emptyPairs = [
    ['\u300c', '\u300d'], ['\u300e', '\u300f'], ['\uff08', '\uff09'], ['\u3010', '\u3011'],
    ['\u3008', '\u3009'], ['\u300a', '\u300b'], ['\u3014', '\u3015'], ['\uff62', '\uff63'],
    ['(', ')'], ['[', ']']
  ];
  for (const [open, close] of emptyPairs) {
    text = text.replace(new RegExp(`${open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*${close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gu'), ' ');
  }
  text = text.replace(/\s+/gu, ' ').trim();
  text = text
    .replace(/^[ \-\u2013\u2014,;:\uff0c\u3001\uff1b\uff1a\uff65\u30fb\uff5e\u301c\u2027.!?\u2026\u3002\uff01\uff1f\uff61\u300d\u300f\uff09\u3011\u3009\u300b\u3015\uff63]+/u, '')
    .replace(/[ \-\u2013\u2014,;:\uff0c\u3001\uff1b\uff1a\uff65\u30fb\uff5e\u301c\u2027\u300c\u300e\uff08\u3010\u3008\u300a\u3014\uff62]+$/u, '')
    .trim();
  return { text, removed };
}

function sanitizeResidualCjk(value, options = {}) {
  const text = String(value || '').trim();
  const target = String(options.targetLang || '').trim().toLowerCase();
  if (!text || ['zh', 'ja'].includes(target)) {
    return { valid: Boolean(text), text, status: text ? 'unchanged' : 'empty', removed: 0 };
  }
  const ratio = hanRatio(text);
  if (ratio <= 0 && !hasKana(text)) {
    return { valid: true, text, status: 'unchanged', removed: 0 };
  }
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.15;
  if (ratio > 0 && (threshold <= 0 || ratio >= threshold)) {
    return { valid: false, text: '', status: 'too_much_source_script', removed: 0, ratio };
  }
  const cleaned = stripResidualCjk(text);
  if (cleaned.text.length < 2) {
    return { valid: false, text: '', status: 'empty_after_cleanup', removed: cleaned.removed, ratio };
  }
  return { valid: true, text: cleaned.text, status: 'rescued', removed: cleaned.removed, ratio };
}

function mergedCueThreshold(values, options = {}) {
  const absolute = Number.isFinite(Number(options.absolute)) ? Number(options.absolute) : 200;
  const usable = (Array.isArray(values) ? values : Object.values(values || {}))
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (usable.length < 4) return absolute > 0 ? absolute : null;
  const lengths = usable.map(value => value.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  const minimumMedian = Number.isFinite(Number(options.minimumMedian)) ? Number(options.minimumMedian) : 8;
  const multiplier = Number.isFinite(Number(options.multiplier)) ? Number(options.multiplier) : 4;
  const floor = Number.isFinite(Number(options.floor)) ? Number(options.floor) : 120;
  const dynamic = median >= minimumMedian ? Math.max(floor, median * multiplier) : null;
  return [dynamic, absolute > 0 ? absolute : null].filter(value => value !== null).reduce(
    (minimum, value) => minimum === null ? value : Math.min(minimum, value),
    null
  );
}

function removeMergedCueValues(values, options = {}) {
  const source = values && typeof values === 'object' ? values : {};
  const threshold = mergedCueThreshold(source, options);
  const cleaned = {};
  const removed = {};
  for (const [key, value] of Object.entries(source)) {
    const text = String(value || '').trim();
    if (threshold !== null && text.length > threshold) removed[key] = text;
    else cleaned[key] = value;
  }
  return { cleaned, removed, threshold };
}

module.exports = {
  hanRatio,
  hasKana,
  mergedCueThreshold,
  removeMergedCueValues,
  sanitizeResidualCjk,
  stripResidualCjk
};
