function normalizeDisplayText(text) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveDisplayMaxLines(videoWidth, videoHeight) {
  return Number(videoHeight) > Number(videoWidth) ? 3 : 2;
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

function fitSubtitleCue(text, options = {}) {
  const clean = normalizeDisplayText(text);
  const fontSize = Math.max(1, Number(options.fontSize) || 24);
  const maxLines = Math.max(1, Number(options.maxLines) || 2);
  const boxWidth = Math.max(1, Number(options.boxWidth) || 1000);
  const baseCapacity = Math.max(10, Math.floor(boxWidth / (fontSize * 0.5)));
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

module.exports = {
  fitSubtitleCue,
  normalizeDisplayText,
  resolveDisplayMaxLines,
  wrapByCapacity
};
