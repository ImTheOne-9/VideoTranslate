const fs = require('node:fs/promises');
const SrtParser = require('srt-parser-2').default;

function normalizeLine(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .replace(/\p{P}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function countMeaningfulCharacters(value) {
  return (String(value ?? '').match(/[\p{Script=Latin}\p{Number}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
}

function parseTimestamp(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(value ?? '').trim());
  if (!match) return null;

  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) return null;

  return (((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000)
    + Number(milliseconds.padEnd(3, '0'));
}

function findRepeatedLines(cues) {
  const occurrences = new Map();

  for (const cue of cues) {
    const seenInCue = new Set();
    for (const line of cue.text.split(/\r?\n/u)) {
      const normalized = normalizeLine(line);
      if (!normalized || seenInCue.has(normalized)) continue;

      seenInCue.add(normalized);
      const occurrence = occurrences.get(normalized) || {
        normalized,
        original: line.trim(),
        cueCount: 0
      };
      occurrence.cueCount += 1;
      occurrences.set(normalized, occurrence);
    }
  }

  const threshold = Math.max(3, Math.ceil(cues.length * 0.6));
  return [...occurrences.values()].filter((occurrence) => occurrence.cueCount >= threshold);
}

async function removeOutput(outputPath) {
  await fs.rm(outputPath, { force: true });
}

function rejectedResult(reason, cueCount, distinctCueCount, removedRepeatedLines) {
  return {
    accepted: false,
    path: null,
    cueCount,
    distinctCueCount,
    removedRepeatedLines,
    reason
  };
}

async function evaluateAndCleanSrt(inputPath, outputPath) {
  const rawSrt = await fs.readFile(inputPath, 'utf8');
  await removeOutput(outputPath);

  if (!rawSrt.trim()) {
    return rejectedResult('empty', 0, 0, []);
  }

  const parser = new SrtParser();
  let parsedCues;
  try {
    parsedCues = parser.fromSrt(rawSrt);
  } catch {
    parsedCues = [];
  }

  const validTimedCues = parsedCues.filter((cue) => {
    const start = parseTimestamp(cue.startTime);
    const end = parseTimestamp(cue.endTime);
    return start !== null && end !== null && end > start;
  });

  if (validTimedCues.length === 0) {
    return rejectedResult('invalid_timing', 0, 0, []);
  }

  const repeatedLines = findRepeatedLines(validTimedCues);
  const repeatedNormalizedLines = new Set(repeatedLines.map((line) => line.normalized));
  const removedRepeatedLines = repeatedLines.map((line) => line.original);
  const cleanedCues = validTimedCues.flatMap((cue) => {
    const text = cue.text
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !repeatedNormalizedLines.has(normalizeLine(line)))
      .join('\n');

    if (!text.trim()) return [];
    return [{ startTime: cue.startTime, endTime: cue.endTime, text }];
  });
  const cueCount = cleanedCues.length;
  const distinctCueCount = new Set(cleanedCues.map((cue) => normalizeLine(cue.text))).size;

  if (cueCount < 2 || distinctCueCount < 2) {
    return rejectedResult('too_few_distinct_cues', cueCount, distinctCueCount, removedRepeatedLines);
  }

  const meaningfulCharacters = cleanedCues.reduce(
    (total, cue) => total + countMeaningfulCharacters(cue.text),
    0
  );
  if (meaningfulCharacters < 8) {
    return rejectedResult('too_little_text', cueCount, distinctCueCount, removedRepeatedLines);
  }

  const outputCues = cleanedCues.map((cue, index) => ({
    id: String(index + 1),
    ...cue
  }));
  await fs.writeFile(outputPath, parser.toSrt(outputCues), 'utf8');

  return {
    accepted: true,
    path: outputPath,
    cueCount,
    distinctCueCount,
    removedRepeatedLines,
    reason: 'accepted'
  };
}

module.exports = { evaluateAndCleanSrt };
