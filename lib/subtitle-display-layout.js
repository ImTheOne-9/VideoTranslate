function normalizeDisplayText(text) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveDisplayMaxLines(videoWidth, videoHeight) {
  return Number(videoHeight) > Number(videoWidth) ? 3 : 2;
}

function resolveSubtitleScale(videoWidth, videoHeight, options = {}) {
  const shortSide = Math.max(1, Math.min(Number(videoWidth) || 1920, Number(videoHeight) || 1080));
  const referenceShortSide = Math.max(1, Number(options.referenceShortSide) || 1080);
  const baseScale = Math.max(0.1, Number(options.baseScale) || 1.35);
  return baseScale * shortSide / referenceShortSide;
}

function resolveScaledSubtitleFontSize(nominalSize, videoWidth, videoHeight, options = {}) {
  return Math.max(10, Math.round((Number(nominalSize) || 18) * resolveSubtitleScale(videoWidth, videoHeight, options)));
}

function splitLongToken(token, capacity) {
  const chars = Array.from(token);
  const parts = [];
  for (let index = 0; index < chars.length; index += capacity) {
    parts.push(chars.slice(index, index + capacity).join(''));
  }
  return parts;
}

function wrapByCapacity(text, capacity) {
  const clean = normalizeDisplayText(text);
  if (!clean || clean.length <= capacity) return clean ? [clean] : [];
  const sourceTokens = clean.includes(' ') ? clean.split(' ') : Array.from(clean);
  const tokens = sourceTokens.flatMap(token => (
    Array.from(token).length > capacity ? splitLongToken(token, capacity) : [token]
  ));
  const separator = clean.includes(' ') ? ' ' : '';
  const lines = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current ? `${current}${separator}${token}` : token;
    if (current && Array.from(candidate).length > capacity) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function tokenizeForLayout(text) {
  const clean = normalizeDisplayText(text);
  if (!clean) return { tokens: [], separator: '' };
  return clean.includes(' ')
    ? { tokens: clean.split(' '), separator: ' ' }
    : { tokens: Array.from(clean), separator: '' };
}

function wrapByMeasuredWidth(text, fontSize, maxWidth, measureText) {
  const clean = normalizeDisplayText(text);
  if (!clean) return [];
  const { tokens, separator } = tokenizeForLayout(clean);
  const lines = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current ? `${current}${separator}${token}` : token;
    if (current && measureText(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function balanceIntoLineCount(text, lineCount) {
  const clean = normalizeDisplayText(text);
  const { tokens, separator } = tokenizeForLayout(clean);
  if (tokens.length <= 1 || lineCount <= 1) return clean ? [clean] : [];
  const target = Math.ceil(Array.from(clean).length / lineCount);
  return wrapByCapacity(clean, Math.max(1, target));
}

function fitSubtitleCue(text, options = {}) {
  const clean = normalizeDisplayText(text);
  const fontSize = Math.max(1, Number(options.fontSize) || 24);
  const maxLines = Math.max(1, Number(options.maxLines) || 2);
  const boxWidth = Math.max(1, Number(options.boxWidth) || 1000);
  const measureText = typeof options.measureText === 'function' ? options.measureText : null;
  const baseCapacity = Math.max(10, Math.floor(boxWidth / (fontSize * 0.5)));
  if (measureText) {
    const minimumFontSize = Math.max(10, Number(options.minimumFontSize) || Math.floor(fontSize * 0.5));
    let fittedFontSize = fontSize;
    let lines = wrapByMeasuredWidth(clean, fittedFontSize, boxWidth, measureText);
    while (lines.length > maxLines && fittedFontSize > minimumFontSize) {
      fittedFontSize = Math.max(minimumFontSize, Math.floor(fittedFontSize * 0.92));
      lines = wrapByMeasuredWidth(clean, fittedFontSize, boxWidth, measureText);
    }
    if (lines.length > maxLines) {
      // Không cắt chữ: giữ đúng số dòng đã chọn và để libass xử lý phần sai số hiếm còn lại.
      lines = balanceIntoLineCount(clean, maxLines);
    }
    return {
      text: lines.join('\\N'),
      lines,
      fontSize: fittedFontSize,
      maxLines,
      baseCapacity,
      measured: true
    };
  }
  const requiredCapacity = Math.max(baseCapacity, Math.ceil(Array.from(clean).length / maxLines));
  const minimumScale = Math.max(0.35, Math.min(1, Number(options.minimumScale) || 0.5));
  const scale = Math.max(minimumScale, Math.min(1, baseCapacity / requiredCapacity));
  const fittedFontSize = Math.max(10, Math.floor(fontSize * scale));
  const fittedCapacity = Math.max(baseCapacity, Math.floor(boxWidth / (fittedFontSize * 0.5)));
  let lines = wrapByCapacity(clean, fittedCapacity);

  // Từ rất dài hoặc sai số đo font có thể tạo dư một dòng. Giữ nguyên chữ,
  // giảm thêm cỡ hiển thị thay vì tách cue/timestamp.
  if (lines.length > maxLines) {
    const rescueCapacity = Math.max(fittedCapacity, Math.ceil(Array.from(clean).length / maxLines));
    lines = wrapByCapacity(clean, rescueCapacity);
  }

  return {
    text: lines.join('\\N'),
    lines,
    fontSize: fittedFontSize,
    maxLines,
    baseCapacity
  };
}

const VIETNAMESE_JOIN_WORDS = new Set(`của và là một các những cái về cho với trong trên dưới từ đến bị đã sẽ đang
rất cũng vẫn thì mà nếu khi để hay hoặc nhưng vì do bởi tại theo cùng như mỗi mọi từng vài
phải nên cần muốn định thử càng hơi khá quá chưa`.split(/\s+/u));

function visibleTextUnits(text) {
  let units = 0;
  for (const char of Array.from(normalizeDisplayText(text))) {
    if (/[\u1100-\u11ff\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0e7f\u0e80-\u0eff\u1000-\u109f\u1780-\u17ff]/u.test(char)) units += 2;
    else units += 1;
  }
  return units;
}

function joinLayoutTokens(tokens, separator) {
  return tokens.join(separator).replace(/\s+([,.;:!?])/gu, '$1').trim();
}

function splitTextAtVisibleUnits(text, maxUnits = 58) {
  const clean = normalizeDisplayText(text);
  if (!clean || visibleTextUnits(clean) <= maxUnits) return clean ? [clean] : [];
  const { tokens, separator } = tokenizeForLayout(clean);
  const output = [];
  let start = 0;
  while (start < tokens.length) {
    let end = start;
    let lastFit = start + 1;
    while (end < tokens.length) {
      const candidate = joinLayoutTokens(tokens.slice(start, end + 1), separator);
      if (end > start && visibleTextUnits(candidate) > maxUnits) break;
      lastFit = end + 1;
      end += 1;
    }
    if (lastFit < tokens.length && separator === ' ') {
      const lowerBound = start + Math.max(1, Math.floor((lastFit - start) * 0.7));
      let best = lastFit;
      let bestScore = -Infinity;
      for (let cut = lowerBound; cut <= lastFit; cut += 1) {
        const previous = String(tokens[cut - 1] || '');
        let score = 5 * (cut - start) / Math.max(1, lastFit - start);
        if (/[,;:]$/u.test(previous)) score += 6;
        if (VIETNAMESE_JOIN_WORDS.has(previous.replace(/[.,]/gu, '').toLowerCase())) score -= 8;
        if (score > bestScore) {
          best = cut;
          bestScore = score;
        }
      }
      lastFit = best;
    }
    output.push(joinLayoutTokens(tokens.slice(start, lastFit), separator));
    start = lastFit;
  }
  return output.filter(Boolean);
}

function splitIntoBalancedParts(text, count) {
  const clean = normalizeDisplayText(text);
  const { tokens, separator } = tokenizeForLayout(clean);
  if (count <= 1 || tokens.length <= 1) return [clean];
  const output = [];
  let start = 0;
  for (let part = 0; part < count && start < tokens.length; part += 1) {
    const remainingParts = count - part;
    const remainingTokens = tokens.length - start;
    const take = Math.max(1, Math.ceil(remainingTokens / remainingParts));
    output.push(joinLayoutTokens(tokens.slice(start, start + take), separator));
    start += take;
  }
  return output.filter(Boolean);
}

function splitAbnormalCueForDisplay(cue, options = {}) {
  const startMs = Math.max(0, Number(cue?.startMs) || 0);
  const endMs = Math.max(startMs, Number(cue?.endMs) || startMs);
  const text = normalizeDisplayText(cue?.text);
  const durationMs = endMs - startMs;
  const abnormalDurationMs = Math.max(1000, Number(options.abnormalDurationMs) || 8000);
  const abnormalCharacters = Math.max(20, Number(options.abnormalCharacters) || 80);
  const maxUnits = Math.max(20, Number(options.maxUnits) || 58);
  if (!text || (durationMs <= abnormalDurationMs && Array.from(text).length <= abnormalCharacters)) {
    return [{ startMs, endMs, text, splitFromAbnormalCue: false }];
  }
  // ViralCrawl mới giữ nguyên câu ngắn dù OCR kéo thời lượng rất dài.
  if (visibleTextUnits(text) <= maxUnits) {
    return [{ startMs, endMs, text, splitFromAbnormalCue: false }];
  }

  const punctuationParts = text
    .split(/(?<=[,，.。!！?？;；:：])\s*/u)
    .map(part => part.trim())
    .filter(Boolean);
  let parts = punctuationParts.flatMap(part => splitTextAtVisibleUnits(part, maxUnits));
  if (parts.length <= 1) parts = splitTextAtVisibleUnits(text, maxUnits);

  const totalWeight = parts.reduce((sum, part) => sum + Math.max(1, Array.from(part).length), 0) || 1;
  let weighted = parts.map(part => ({ text: part, weight: Math.max(1, Array.from(part).length) }));
  const maxDisplayMs = Math.max(1000, Number(options.maxDisplayMs) || 5000);
  weighted = weighted.flatMap(part => {
    const estimatedMs = durationMs * part.weight / totalWeight;
    const desired = Math.ceil(estimatedMs / maxDisplayMs);
    const allowed = Math.max(1, Math.floor(visibleTextUnits(part.text) / 20));
    const count = Math.max(1, Math.min(desired, allowed));
    return splitIntoBalancedParts(part.text, count).map(textPart => ({
      text: textPart,
      weight: Math.max(1, Array.from(textPart).length)
    }));
  });

  const finalWeight = weighted.reduce((sum, part) => sum + part.weight, 0) || 1;
  let cursor = startMs;
  const segments = weighted.map((part, index) => {
    const segmentEnd = index === weighted.length - 1
      ? endMs
      : Math.min(endMs, cursor + durationMs * part.weight / finalWeight);
    const segment = {
      startMs: Math.round(cursor),
      endMs: Math.round(segmentEnd),
      text: part.text,
      splitFromAbnormalCue: true
    };
    cursor = segmentEnd;
    return segment;
  });

  const minimumDisplayMs = Math.max(100, Number(options.minimumDisplayMs) || 450);
  for (let index = 0; index < segments.length && segments.length > 1;) {
    const segment = segments[index];
    if (segment.endMs - segment.startMs >= minimumDisplayMs) {
      index += 1;
      continue;
    }
    const neighborIndex = index + 1 < segments.length ? index + 1 : index - 1;
    const leftIndex = Math.min(index, neighborIndex);
    const rightIndex = Math.max(index, neighborIndex);
    const mergedText = `${segments[leftIndex].text} ${segments[rightIndex].text}`.trim();
    if (visibleTextUnits(mergedText) > maxUnits) {
      index += 1;
      continue;
    }
    segments.splice(leftIndex, 2, {
      startMs: segments[leftIndex].startMs,
      endMs: segments[rightIndex].endMs,
      text: mergedText,
      splitFromAbnormalCue: true
    });
    index = Math.max(0, leftIndex - 1);
  }
  return segments;
}

module.exports = {
  balanceIntoLineCount,
  fitSubtitleCue,
  normalizeDisplayText,
  resolveDisplayMaxLines,
  resolveScaledSubtitleFontSize,
  resolveSubtitleScale,
  splitAbnormalCueForDisplay,
  splitTextAtVisibleUnits,
  visibleTextUnits,
  wrapByMeasuredWidth,
  wrapByCapacity
};
