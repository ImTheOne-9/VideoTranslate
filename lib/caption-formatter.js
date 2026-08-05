'use strict';

const DEFAULT_CAPTION_OPTIONS = Object.freeze({
  maxCharacters: 68,
  maxLineCharacters: 34,
  maxCharactersPerSecond: 18,
  maxDurationSeconds: 6,
  minDurationSeconds: 0.8,
  pauseBreakSeconds: 0.7
});

function toWord(chunk) {
  const start = Number(chunk?.timestamp?.[0]);
  const end = Number(chunk?.timestamp?.[1]);
  const text = String(chunk?.text || '').trim();
  if (!text || !Number.isFinite(start)) return null;
  return {
    text,
    start,
    end: Number.isFinite(end) && end > start ? end : start + 0.35
  };
}

function joinWords(words) {
  return words.map((word) => word.text).join(' ')
    .replace(/\s+([,.;:!?%\]\)])/gu, '$1')
    .replace(/([\[\(])\s+/gu, '$1')
    .trim();
}

function wrapCaptionText(text, maxLineCharacters) {
  const tokens = String(text || '').split(/\s+/u).filter(Boolean);
  const lines = [];
  let line = '';
  for (const token of tokens) {
    const candidate = line ? `${line} ${token}` : token;
    if (line && candidate.length > maxLineCharacters && lines.length === 0) {
      lines.push(line);
      line = token;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2).join('\n');
}

function formatWordCaptions(chunks, options = {}) {
  const config = { ...DEFAULT_CAPTION_OPTIONS, ...options };
  const words = (Array.isArray(chunks) ? chunks : [])
    .map(toWord)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  const captions = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const start = current[0].start;
    const naturalEnd = current[current.length - 1].end;
    const nextStart = words.find((word) => word.start > naturalEnd)?.start;
    const joinedText = joinWords(current);
    const readableDuration = joinedText.length / config.maxCharactersPerSecond;
    let end = Math.max(
      naturalEnd,
      start + config.minDurationSeconds,
      start + readableDuration
    );
    if (Number.isFinite(nextStart)) end = Math.min(end, nextStart);
    end = Math.min(end, start + config.maxDurationSeconds);
    if (end <= start) end = naturalEnd;
    captions.push({
      text: wrapCaptionText(joinedText, config.maxLineCharacters),
      timestamp: [start, end],
      words: current.map((word) => ({
        text: word.text,
        timestamp: [word.start, word.end]
      }))
    });
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    const candidate = joinWords([...current, word]);
    const pause = previous ? word.start - previous.end : 0;
    const duration = current.length ? word.end - current[0].start : 0;
    const shouldBreak = current.length > 0 && (
      candidate.length > config.maxCharacters
      || pause >= config.pauseBreakSeconds
      || duration > config.maxDurationSeconds
    );
    if (shouldBreak) flush();
    current.push(word);
    if (/[.!?…]$/u.test(word.text) && current.length >= 3) flush();
  }
  flush();
  return captions;
}

function splitReadableText(text, maxCharacters) {
  const tokens = String(text || '').trim().split(/\s+/u).filter(Boolean);
  const groups = [];
  let current = [];
  for (const token of tokens) {
    const candidate = joinWords([...current, { text: token }]);
    if (current.length && candidate.length > maxCharacters) {
      groups.push(joinWords(current));
      current = [];
    }
    current.push({ text: token });
    if (/[.!?…]$/u.test(token) && current.length >= 3) {
      groups.push(joinWords(current));
      current = [];
    }
  }
  if (current.length) groups.push(joinWords(current));
  return groups;
}

function formatSegmentCaptions(chunks, options = {}) {
  const config = { ...DEFAULT_CAPTION_OPTIONS, ...options };
  return (Array.isArray(chunks) ? chunks : []).flatMap((chunk) => {
    const start = Number(chunk?.timestamp?.[0]);
    const end = Number(chunk?.timestamp?.[1]);
    const text = String(chunk?.text || '').trim();
    if (!text || !Number.isFinite(start)) return [];
    const safeEnd = Number.isFinite(end) && end > start ? end : start + Math.max(1, text.length * 0.12);
    const parts = splitReadableText(text, config.maxCharacters);
    if (parts.length <= 1) {
      return [{ ...chunk, text: wrapCaptionText(text, config.maxLineCharacters), timestamp: [start, safeEnd] }];
    }
    const weights = parts.map((part) => Math.max(1, Array.from(part).length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;
    return parts.map((part, index) => {
      const partEnd = index === parts.length - 1
        ? safeEnd
        : cursor + ((safeEnd - start) * weights[index] / totalWeight);
      const formatted = {
        ...chunk,
        text: wrapCaptionText(part, config.maxLineCharacters),
        timestamp: [cursor, partEnd]
      };
      cursor = partEnd;
      return formatted;
    });
  });
}

module.exports = {
  DEFAULT_CAPTION_OPTIONS,
  formatSegmentCaptions,
  formatWordCaptions,
  joinWords,
  splitReadableText,
  wrapCaptionText
};
