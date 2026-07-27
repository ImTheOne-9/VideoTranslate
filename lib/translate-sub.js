const fs = require('fs');
const path = require('path');
const Parser = require('srt-parser-2').default;
const { getAppDataRoot } = require('./path-helper');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const LANG_MAP = {
  vi: { name: 'Tiếng Việt', nllb: 'vie_Latn', google: 'vi' },
  en: { name: 'English', nllb: 'eng_Latn', google: 'en' },
  zh: { name: 'Tiếng Trung', nllb: 'zho_Hans', google: 'zh' },
};

const TRANSLATION_STYLES = Object.freeze({
  natural: 'Tự nhiên, rõ ràng, phù hợp video ngắn',
  neutral: 'Trung tính, an toàn, không suồng sã',
  formal: 'Trang trọng, lịch sự',
  casual: 'Gần gũi, đời thường',
  historical: 'Cổ trang, giữ đúng vai vế và kính ngữ'
});

function limitText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeTranslationProfile(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};

  const style = Object.prototype.hasOwnProperty.call(TRANSLATION_STYLES, raw.style)
    ? raw.style
    : 'natural';
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .slice(0, 100)
    .map((entry) => {
      const mode = ['required', 'keep', 'output'].includes(entry?.mode) ? entry.mode : 'required';
      const source = limitText(entry?.source, 120);
      const target = mode === 'keep' ? source : limitText(entry?.target, 120);
      return { mode, source, target };
    })
    .filter((entry) => entry.source && entry.target);

  return {
    style,
    speakerPronoun: limitText(raw.speakerPronoun, 40),
    audiencePronoun: limitText(raw.audiencePronoun, 40),
    context: limitText(raw.context, 1200),
    entries
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsCjk(value) {
  return /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7a3]/u.test(value);
}

function replaceTranslationTerm(text, source, target, ignoreCase = false) {
  if (!source) return String(text || '');
  const flags = ignoreCase ? 'giu' : 'gu';
  if (containsCjk(source)) {
    return String(text || '').replace(new RegExp(escapeRegExp(source), flags), () => target);
  }
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(source)})(?=$|[^\\p{L}\\p{N}])`, flags);
  return String(text || '').replace(pattern, (match, prefix) => prefix + target);
}

function glossaryToken(index) {
  return `[[VST_TERM_${index + 1}]]`;
}

function buildTranslationProfileInstructions(profileInput) {
  const profile = normalizeTranslationProfile(profileInput);
  const lines = [
    `- Văn phong bắt buộc: ${TRANSLATION_STYLES[profile.style]}.`
  ];
  if (profile.speakerPronoun) lines.push(`- Người nói/người dẫn tự xưng: ${profile.speakerPronoun}.`);
  if (profile.audiencePronoun) lines.push(`- Người nói gọi người nghe/khán giả là: ${profile.audiencePronoun}.`);
  if (profile.context) lines.push(`- Bối cảnh và quan hệ nhân vật: ${profile.context}`);

  const protectedEntries = profile.entries.filter((entry) => entry.mode !== 'output');
  protectedEntries.forEach((entry) => {
    const index = profile.entries.indexOf(entry);
    const action = entry.mode === 'keep' ? 'giữ nguyên' : `dịch thành "${entry.target}"`;
    lines.push(`- ${glossaryToken(index)} đại diện cho "${entry.source}": ${action}; phải giữ nguyên token trong JSON trả về.`);
  });
  profile.entries.filter((entry) => entry.mode === 'output').forEach((entry) => {
    lines.push(`- Không dùng "${entry.source}" trong bản dịch; luôn dùng "${entry.target}".`);
  });
  return lines.join('\n');
}

function prepareTextForTranslation(text, profileInput) {
  const profile = normalizeTranslationProfile(profileInput);
  let processed = String(text || '');
  profile.entries.forEach((entry, index) => {
    if (entry.mode === 'required' || entry.mode === 'keep') {
      processed = replaceTranslationTerm(processed, entry.source, glossaryToken(index), false);
    }
  });
  return preProcessText(processed);
}

function applyTranslationProfileToText(text, profileInput) {
  const profile = normalizeTranslationProfile(profileInput);
  let processed = String(text || '');
  profile.entries.forEach((entry, index) => {
    if (entry.mode === 'required' || entry.mode === 'keep') {
      const tokenPattern = new RegExp(`\\[\\[\\s*VST_TERM_${index + 1}\\s*\\]\\]`, 'giu');
      processed = processed.replace(tokenPattern, () => entry.target);
      processed = replaceTranslationTerm(processed, entry.source, entry.target, true);
    }
  });
  profile.entries.forEach((entry) => {
    if (entry.mode === 'output') {
      processed = replaceTranslationTerm(processed, entry.source, entry.target, true);
    }
  });
  return processed;
}

function createTranslationQualityReport(sourceText, translatedText, profileInput) {
  const profile = normalizeTranslationProfile(profileInput);
  const extractSubtitleText = (value) => {
    const raw = String(value || '');
    if (!raw.includes('-->')) return raw.replace(/\s+/g, ' ').trim();
    try {
      return new Parser().fromSrt(raw).map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
    } catch {
      return raw.replace(/\s+/g, ' ').trim();
    }
  };
  const sourceContent = extractSubtitleText(sourceText);
  const translatedContent = extractSubtitleText(translatedText);
  const issues = [];
  const explicitOutputTerms = new Set(
    profile.entries.filter((entry) => entry.mode === 'output').map((entry) => entry.source.toLocaleLowerCase('vi'))
  );
  for (const entry of profile.entries) {
    if (entry.mode === 'required' || entry.mode === 'keep') {
      if (sourceContent.includes(entry.source) && !translatedContent.includes(entry.target)) {
        issues.push({ type: 'missing_term', source: entry.source, expected: entry.target });
      }
    } else if (entry.mode === 'output') {
      const replaced = replaceTranslationTerm(translatedContent, entry.source, '', true);
      if (replaced !== translatedContent) {
        issues.push({ type: 'forbidden_term', source: entry.source, expected: entry.target });
      }
    }
  }
  const pronounGroups = [
    ['tôi', 'mình', 'tớ', 'tao'],
    ['bạn', 'các bạn', 'cậu', 'mày', 'quý vị']
  ];
  const checkPronoun = (preferred) => {
    if (!preferred) return;
    const normalizedPreferred = preferred.toLocaleLowerCase('vi');
    const group = pronounGroups.find((values) => values.includes(normalizedPreferred));
    if (!group) return;
    const contentWithoutPreferred = replaceTranslationTerm(translatedContent, preferred, '', true);
    group.filter((value) => value !== normalizedPreferred).forEach((value) => {
      if (explicitOutputTerms.has(value)) return;
      if (replaceTranslationTerm(contentWithoutPreferred, value, '', true) !== contentWithoutPreferred) {
        issues.push({ type: 'inconsistent_pronoun', source: value, expected: preferred });
      }
    });
  };
  checkPronoun(profile.speakerPronoun);
  checkPronoun(profile.audiencePronoun);

  const ruleCount = profile.entries.length
    + (profile.speakerPronoun ? 1 : 0)
    + (profile.audiencePronoun ? 1 : 0);
  return {
    checked: ruleCount > 0,
    ruleCount,
    issueCount: issues.length,
    issues: issues.slice(0, 50)
  };
}

// Tự xây dựng hàm dịch bằng API miễn phí chính thức của Google Translate (client=gtx) để không bao giờ bị dính lỗi rate limit (Too Many Requests)
async function translate(text, options = {}) {
  const toLang = options.to || 'vi';
  const params = new URLSearchParams({
    sl: 'auto',
    tl: toLang,
    q: text
  });

  const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=rm&dj=1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
    },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Google HTTP error! status: ${res.status}`);
  }

  const data = await res.json();
  if (data && data.sentences) {
    const translatedText = data.sentences.map(s => s.trans).join('');
    return { text: translatedText };
  }

  throw new Error('Định dạng phản hồi không hợp lệ');
}

// Hàm chia dòng phụ đề thành tối đa 2 dòng cân đối và gọn gàng cho màn hình đứng
function wrapTextToTwoLines(text, maxCharsPerLine = 22) {
  // Thay thế ký tự ngắt dòng cũ và khoảng trắng dư thừa
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }

  const words = cleanText.split(' ');
  const midPoint = Math.floor(cleanText.length / 2);
  let bestIndex = -1;
  let minDiff = Infinity;
  
  let currentPos = 0;
  for (let i = 0; i < words.length - 1; i++) {
    currentPos += words[i].length + 1; // +1 cho dấu cách
    const diff = Math.abs(currentPos - midPoint);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }

  if (bestIndex !== -1) {
    const line1 = words.slice(0, bestIndex + 1).join(' ');
    const line2 = words.slice(bestIndex + 1).join(' ');
    return `${line1}\n${line2}`;
  }

  return cleanText;
}

function wrapTextToThreeLines(text, maxCharsPerLine = 22) {
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }
  if (cleanText.length <= maxCharsPerLine * 1.6) {
    return wrapTextToTwoLines(cleanText, maxCharsPerLine);
  }
  
  const words = cleanText.split(' ');
  if (words.length <= 2) {
    return words.join('\n');
  }
  
  const totalLen = cleanText.length;
  
  let bestI = -1;
  let bestJ = -1;
  let minVariance = Infinity;
  
  let posI = 0;
  for (let i = 0; i < words.length - 2; i++) {
    posI += words[i].length + 1;
    
    let posJ = posI;
    for (let j = i + 1; j < words.length - 1; j++) {
      posJ += words[j].length + 1;
      
      const len1 = posI - 1;
      const len2 = posJ - posI - 1;
      const len3 = totalLen - posJ;
      
      const mean = totalLen / 3;
      const variance = Math.pow(len1 - mean, 2) + Math.pow(len2 - mean, 2) + Math.pow(len3 - mean, 2);
      
      if (variance < minVariance) {
        minVariance = variance;
        bestI = i;
        bestJ = j;
      }
    }
  }
  
  if (bestI !== -1 && bestJ !== -1) {
    const line1 = words.slice(0, bestI + 1).join(' ');
    const line2 = words.slice(bestI + 1, bestJ + 1).join(' ');
    const line3 = words.slice(bestJ + 1).join(' ');
    return `${line1}\n${line2}\n${line3}`;
  }
  
  return cleanText;
}

function srtTimeToMs(timeStr) {
  if (!timeStr) return 0;
  try {
    const parts = timeStr.split(':');
    if (parts.length === 2) {
      const secParts = parts[1].split(',');
      const minutes = parseInt(parts[0], 10) || 0;
      const seconds = parseInt(secParts[0], 10) || 0;
      const ms = parseInt(secParts[1], 10) || 0;
      return minutes * 60000 + seconds * 1000 + ms;
    }
    if (parts.length < 3) return 0;
    const secParts = parts[2].split(',');
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    const seconds = parseInt(secParts[0], 10) || 0;
    const ms = parseInt(secParts[1], 10) || 0;
    return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
  } catch (e) {
    return 0;
  }
}

function msToSrtTime(ms) {
  const hours = Math.floor(ms / 3600000);
  let remain = ms % 3600000;
  const minutes = Math.floor(remain / 60000);
  remain %= 60000;
  const seconds = Math.floor(remain / 1000);
  const milliseconds = Math.floor(remain % 1000);
  
  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');
  const msStr = String(milliseconds).padStart(3, '0');
  return `${h}:${m}:${s},${msStr}`;
}

function mergeShortSubtitles(srtArray, maxGapMs = 800, maxMergedLength = 65) {
  if (!srtArray || srtArray.length <= 1) return srtArray;
  
  const merged = [];
  let current = { ...srtArray[0] };
  
  for (let i = 1; i < srtArray.length; i++) {
    const next = srtArray[i];
    const currentEnd = srtTimeToMs(current.endTime);
    const nextStart = srtTimeToMs(next.startTime);
    const gap = nextStart - currentEnd;
    
    const currentText = current.text.trim();
    const endsWithPunctuation = /[.!?…]$/.test(currentText);
    const mergedLength = currentText.length + next.text.trim().length + 1;
    
    if (gap >= 0 && gap <= maxGapMs && !endsWithPunctuation && mergedLength <= maxMergedLength) {
      current.endTime = next.endTime;
      current.text = (currentText + ' ' + next.text.trim()).replace(/\s+/g, ' ');
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  
  merged.forEach((item, idx) => {
    item.id = String(idx + 1);
  });
  
  return merged;
}

function deduplicateSubtitles(srtArray) {
  if (!srtArray || srtArray.length <= 1) return srtArray;

  const result = [];
  let i = 0;
  while (i < srtArray.length) {
    // --- Pattern 0: combined duplicate followed by its parts (A+B, A, B) ---
    if (i + 2 < srtArray.length) {
      const combinedText = srtArray[i].text.trim().replace(/\s+/g, ' ');
      const aText = srtArray[i + 1].text.trim();
      const bText = srtArray[i + 2].text.trim();
      const mergedAB = (aText + ' ' + bText).replace(/\s+/g, ' ');
      if (combinedText === mergedAB) {
        const combined = { ...srtArray[i] };
        combined.endTime = srtArray[i + 2].endTime;
        result.push(combined);
        i += 3;
        continue;
      }
      const aIndex = combinedText.indexOf(aText);
      const bIndex = aIndex === -1 ? -1 : combinedText.indexOf(bText, aIndex + aText.length);
      if (aIndex === 0 && bIndex >= aText.length && combinedText.length > mergedAB.length) {
        // The combined cue also contains unrelated repeated context. Keep the
        // two clean following cues and discard this corrupted chunk-boundary cue.
        i += 1;
        continue;
      }
    }

    // --- Pattern 1: duplicate pair (A, B, A, B) ---
    if (i + 3 < srtArray.length) {
      const a1 = srtArray[i].text.trim();
      const b1 = srtArray[i + 1].text.trim();
      const a2 = srtArray[i + 2].text.trim();
      const b2 = srtArray[i + 3].text.trim();
      if (a1 === a2 && b1 === b2) {
        const a = { ...srtArray[i] };
        const b = { ...srtArray[i + 1] };
        b.endTime = srtArray[i + 3].endTime;
        result.push(a, b);
        i += 4;
        continue;
      }
    }

    // --- Pattern 2: combined duplicate (A, B, A+B) ---
    if (i + 2 < srtArray.length) {
      const aText = srtArray[i].text.trim();
      const bText = srtArray[i + 1].text.trim();
      const combinedText = srtArray[i + 2].text.trim();
      const mergedAB = (aText + ' ' + bText).replace(/\s+/g, ' ');
      if (mergedAB === combinedText) {
        const a = { ...srtArray[i] };
        a.endTime = srtArray[i + 2].endTime;
        a.text = combinedText;
        result.push(a);
        i += 3;
        continue;
      }
    }

    // --- Pattern 3: consecutive exact duplicate ---
    if (i + 1 < srtArray.length) {
      const curText = srtArray[i].text.trim();
      const nextText = srtArray[i + 1].text.trim();
      if (curText === nextText) {
        const a = { ...srtArray[i] };
        a.endTime = srtArray[i + 1].endTime;
        result.push(a);
        i += 2;
        continue;
      }
    }

    result.push({ ...srtArray[i] });
    i++;
  }

  result.forEach((item, idx) => {
    item.id = String(idx + 1);
  });

  return result;
}

function splitSubtitleItem(item, maxCharsPerBlock = 36, depth = 0) {
  if (!item || !item.text) return [item];
  if (depth > 5) return [{ ...item, text: item.text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim() }];
  const text = item.text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  if (text.length <= maxCharsPerBlock) {
    return [item];
  }

  const words = text.split(' ');
  if (words.length <= 2) {
    return [item];
  }

  let bestIndex = -1;
  let minDiff = Infinity;
  let currentPos = 0;
  const midPoint = Math.floor(text.length / 2);

  for (let i = 0; i < words.length - 1; i++) {
    currentPos += words[i].length + 1;
    const diff = Math.abs(currentPos - midPoint);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) {
    return [item];
  }

  const part1Text = words.slice(0, bestIndex + 1).join(' ');
  const part2Text = words.slice(bestIndex + 1).join(' ');

  // Giữ nguyên timestamp gốc (không tính lại theo số từ)
  const item1 = {
    ...item,
    text: part1Text
  };

  const item2 = {
    ...item,
    text: part2Text
  };

  return [
    ...splitSubtitleItem(item1, maxCharsPerBlock, depth + 1),
    ...splitSubtitleItem(item2, maxCharsPerBlock, depth + 1)
  ];
}

// Gom phụ đề về 1 dòng: thay mọi ký tự xuống dòng/tab bằng dấu cách và gộp khoảng trắng thừa.
function cleanSpaces(text) {
  let s = String(text || '');
  s = s.split(String.fromCharCode(13)).join(' ');
  s = s.split(String.fromCharCode(10)).join(' ');
  s = s.split(String.fromCharCode(9)).join(' ');
  while (s.indexOf('  ') !== -1) s = s.split('  ').join(' ');
  return s.trim();
}

// Cắt một dòng text dài thành nhiều đoạn, mỗi đoạn có độ dài <= maxChars.
// Ưu tiên cắt tại dấu cách (không cắt giữa từ); với CJK (không có dấu cách) thì cắt theo ký tự.
function splitTextToFitLine(text, maxChars) {
  const clean = cleanSpaces(text);
  if (maxChars <= 0 || clean.length <= maxChars) return [clean];
  const segments = [];
  const tokens = clean.split(' ').filter(t => t.length > 0);
  let current = '';
  for (const token of tokens) {
    if (token.length > maxChars) {
      if (current) { segments.push(current); current = ''; }
      if (isCJKRun(token)) {
        for (let i = 0; i < token.length; i += maxChars) {
          segments.push(token.slice(i, i + maxChars));
        }
      } else {
        segments.push(token);
      }
      continue;
    }
    if (current.length === 0) {
      current = token;
    } else if (current.length + 1 + token.length <= maxChars) {
      current += ' ' + token;
    } else {
      segments.push(current);
      current = token;
    }
  }
  if (current) segments.push(current);
  return segments.length ? segments : [clean];
}

// Kiểm tra token có chứa ký tự CJK (có thể cắt giữa các ký tự) hay không.
function isCJKRun(s) {
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) ||
        (c >= 0xac00 && c <= 0xd7a3)) return true;
  }
  return false;
}

// Khi chọn "tối đa 1 dòng": cắt các subtitle dài thành nhiều đoạn NỐI TIẾP nhau,
// mỗi đoạn vừa khung 1 dòng (<= maxCharsPerLine). Thời gian gốc được chia tỷ lệ theo độ dài từng đoạn.
function splitSubtitlesForOneLine(srtArray, maxCharsPerLine) {
  if (!srtArray || srtArray.length === 0) return srtArray || [];
  const maxChars = maxCharsPerLine > 0 ? maxCharsPerLine : 22;
  const result = [];
  for (const item of srtArray) {
    const segments = splitTextToFitLine(item.text || '', maxChars);
    if (segments.length <= 1) {
      result.push({ ...item, text: (segments[0] || '').trim() });
      continue;
    }
    const startMs = srtTimeToMs(item.startTime);
    const endMs = srtTimeToMs(item.endTime);
    const total = Math.max(1, endMs - startMs);
    const lengths = segments.map(s => Math.max(1, s.length));
    const totalLen = lengths.reduce((a, b) => a + b, 0);
    let cursor = startMs;
    for (let k = 0; k < segments.length; k++) {
      const segStart = cursor;
      let segEnd;
      if (k === segments.length - 1) {
        segEnd = endMs;
      } else {
        const dur = Math.max(1, Math.round((lengths[k] / totalLen) * total));
        segEnd = Math.min(endMs, segStart + dur);
      }
      result.push({
        ...item,
        text: segments[k].trim(),
        startTime: msToSrtTime(segStart),
        endTime: msToSrtTime(segEnd)
      });
      cursor = segEnd;
    }
  }
  return result;
}

// Định dạng lại toàn bộ file phụ đề để tất cả các khối sub có tối đa 1 hoặc 2 dòng và độ dài vừa vặn theo chiều rộng kéo thả
function formatSubtitleFile(filePath, maxLines = 0, maxCharsPerLine = 22) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const parser = new Parser();
  let srtArray = parser.fromSrt(content);
  // Different Whisper chunks can translate to the same sentence. Deduplicate
  // again after translation so the final SRT contains one continuous cue.
  srtArray = deduplicateSubtitles(srtArray);
  
  let resultArray;
  if (maxLines === 1) {
    // Ép 1 dòng: cắt subtitle dài thành các đoạn NỐI TIẾP, mỗi đoạn vừa khung 1 dòng (không tràn mép)
    resultArray = splitSubtitlesForOneLine(srtArray, maxCharsPerLine);
    // Gán lại ID liên tục vì số khối có thể tăng sau khi cắt
    resultArray.forEach((item, idx) => { item.id = String(idx + 1); });
  } else {
    // 2/3/tự động: chỉ wrap text trong từng segment (không split thành đoạn riêng)
    srtArray.forEach((item) => {
      if (maxLines === 2) {
        item.text = wrapTextToTwoLines(item.text, maxCharsPerLine);
      } else if (maxLines === 3) {
        item.text = wrapTextToThreeLines(item.text, maxCharsPerLine);
      } else { // maxLines === 0 (Tự động)
        const clean = cleanSpaces(item.text);
        if (clean.length <= maxCharsPerLine) {
          item.text = clean;
        } else if (clean.length <= maxCharsPerLine * 1.6) {
          item.text = wrapTextToTwoLines(clean, maxCharsPerLine);
        } else {
          item.text = wrapTextToThreeLines(clean, maxCharsPerLine);
        }
      }
    });
    resultArray = srtArray;
  }

  const formattedContent = parser.toSrt(resultArray);
  fs.writeFileSync(filePath, formattedContent, 'utf8');
}

// Từ điển thay thế từ khóa trước khi dịch (từ tiếng Trung sang từ gợi ý chuẩn)
const PRE_TRANSLATE_DICT = {
  "舞单": "thần tượng",
  "短剧": "phim ngắn"
};

// Từ điển sửa lỗi sau khi dịch (sửa các lỗi dịch nghĩa đen của Google)
const POST_TRANSLATE_DICT = {
  "người kéo tường": "Huawei Mate X",
  "người kéo": "Huawei Mate X"
};

function preProcessText(text) {
  if (!text) return '';
  let processed = text;
  for (const [key, value] of Object.entries(PRE_TRANSLATE_DICT)) {
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    processed = processed.replace(new RegExp(escapedKey, 'g'), value);
  }
  return processed;
}

function postProcessText(text, translationProfile) {
  if (!text) return '';
  let processed = text;
  for (const [key, value] of Object.entries(POST_TRANSLATE_DICT)) {
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    processed = processed.replace(new RegExp(escapedKey, 'gi'), value);
  }
  return applyTranslationProfileToText(processed, translationProfile);
}

async function translateBatchWithRetry(batchMap, translateFn, depth) {
  depth = depth || 0;
  try {
    return await translateFn(batchMap);
  } catch (err) {
    const ids = Object.keys(batchMap);
    if (ids.length <= 1 || depth > 4) throw err;
    console.warn('[Dich] Lo ' + ids.length + ' dong parse that bai (' + String(err.message).slice(0, 80) + '). Chia doi + retry.');
    const mid = Math.floor(ids.length / 2);
    const left = {}; const right = {};
    ids.slice(0, mid).forEach(function (id) { left[id] = batchMap[id]; });
    ids.slice(mid).forEach(function (id) { right[id] = batchMap[id]; });
    const leftRes = await translateBatchWithRetry(left, translateFn, depth + 1);
    const rightRes = await translateBatchWithRetry(right, translateFn, depth + 1);
    return Object.assign({}, leftRes, rightRes);
  }
}

let cachedGeminiModel = null;

async function getAvailableGeminiModel(apiKey) {
  if (cachedGeminiModel) return cachedGeminiModel;
  
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!res.ok) throw new Error('Không thể lấy danh sách model từ API.');
  
  const data = await res.json();
  const models = data.models || [];
  
  const validModels = models.filter(m => 
    m.supportedGenerationMethods && 
    m.supportedGenerationMethods.includes('generateContent') &&
    m.name.includes('gemini')
  );
  
  // Ưu tiên lấy model flash mới nhất, sau đó đến pro
  const flashModel = validModels.find(m => m.name.includes('flash'));
  const proModel = validModels.find(m => m.name.includes('pro'));
  
  if (flashModel) cachedGeminiModel = flashModel.name;
  else if (proModel) cachedGeminiModel = proModel.name;
  else if (validModels.length > 0) cachedGeminiModel = validModels[0].name;
  else throw new Error('Không tìm thấy model Gemini nào hỗ trợ generateContent.');
  
  console.log('[Gemini AI] Đã tự động nhận diện Model tối ưu nhất:', cachedGeminiModel);
  return cachedGeminiModel;
}

function extractJson(text) {
  if (!text) return {};
  let cleaned = text;
  
  // 1. Loại bỏ suy nghĩ <think>...</think> của DeepSeek R1/Reasoning models
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // 2. Loại bỏ khối markdown json, srt hoặc plain markdown code blocks
  cleaned = cleaned.replace(/```[a-zA-Z0-9-]*\n/gi, '')
                   .replace(/```/g, '')
                   .trim();
  
  // 3. Tìm khối JSON bằng cách định vị dấu { và } ngoài cùng
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    try {
      return lenientParseJson(cleaned);
    } catch (_) {
      console.error('Lỗi cú pháp JSON nhận được:', cleaned);
      throw new Error('Không thể phân tích phản hồi JSON từ AI: ' + err.message);
    }
  }
}

function lenientParseJson(str) {
  const result = {};
  let i = 0;
  while (i < str.length) {
    while (i < str.length && (str[i] === ' ' || str[i] === '\t' || str[i] === '\n' || str[i] === '\r' || str[i] === ',')) i++;
    if (i >= str.length) break;
    if (str[i] === '{' || str[i] === '}') { i++; continue; }

    if (str[i] !== '"') { i++; continue; }
    i++;
    let key = '';
    while (i < str.length && str[i] !== '"') {
      key += str[i]; i++;
    }
    if (i >= str.length) break;
    i++;

    while (i < str.length && (str[i] === ' ' || str[i] === '\t' || str[i] === '\n' || str[i] === '\r' || str[i] === ':')) i++;
    if (i >= str.length || str[i] !== '"') { i++; continue; }
    i++;

    let value = '';
    while (i < str.length) {
      if (str[i] === '\\') {
        value += str[i] + (str[i+1] || ''); i += 2; continue;
      }
      if (str[i] === '"') {
        let j = i + 1;
        while (j < str.length && (str[j] === ' ' || str[j] === '\t' || str[j] === '\n' || str[j] === '\r')) j++;
        if (j >= str.length || str[j] === ',' || str[j] === '}' || /^"\d/.test(str.substring(j))) {
          i++; break;
        }
        value += '"'; i++; continue;
      }
      value += str[i]; i++;
    }

    result[key] = value;
  }
  return result;
}

function getTranslationPrompt(map, targetLangName = 'Tiếng Việt', prevContext = [], translationProfile = {}) {
  return `Bạn là một chuyên gia dịch thuật phụ đề video ngắn chuyên nghiệp cho TikTok, Facebook Reels và YouTube Shorts.

Tôi sẽ cung cấp một danh sách các khối phụ đề dưới dạng JSON. Mỗi khối phụ đề có thể bị cắt ngắn theo mốc thời gian thực tế của video, nên một câu hoàn chỉnh có thể bị chia thành nhiều khối liên tiếp.

Nhiệm vụ của bạn là dịch nội dung phụ đề sang ${targetLangName} tự nhiên, chính xác và đúng ngữ cảnh.

YÊU CẦU BẮT BUỘC:

1. Trước khi dịch, hãy đọc toàn bộ danh sách phụ đề để hiểu đầy đủ bối cảnh, mạch câu chuyện, quan hệ giữa nhân vật, sắc thái cảm xúc và văn phong của video.

2. Dịch từng khối phụ đề theo đúng thứ tự ban đầu, nhưng không được dịch word-by-word từng khối một cách rời rạc.

3. Vì phụ đề có thể bị ngắt giữa câu, hãy dịch sao cho khi ghép các khối liên tiếp lại, nội dung tiếng Việt trở thành câu hoàn chỉnh, mượt mà, tự nhiên, đúng ngữ pháp và đúng ngữ cảnh.

4. Giữ văn phong phù hợp với video ngắn trên mạng xã hội: rõ ràng, sinh động, dễ hiểu, có nhịp nói tự nhiên, nhưng không phóng tác quá xa nội dung gốc.

5. Sử dụng đại từ nhân xưng và kính ngữ tiếng Việt phù hợp với ngữ cảnh:
   - Xác định quan hệ giữa người nói và người nghe nếu có thể.
   - Dùng cách xưng hô tự nhiên như tôi, mình, bạn, anh, chị, em, cô, chú, ông, bà, quý vị... tùy ngữ cảnh.
   - Giữ sự nhất quán về xưng hô trong toàn bộ đoạn dịch.
   - Nếu ngữ cảnh không đủ rõ, chọn cách xưng hô trung tính, tự nhiên và an toàn.

6. Dịch theo nghĩa và sắc thái, không dịch máy móc:
   - Thành ngữ, tiếng lóng, câu cảm thán, câu đùa hoặc cách nói ẩn dụ cần được chuyển sang tiếng Việt tương đương tự nhiên.
   - Không thêm thông tin không có trong bản gốc.
   - Không lược bỏ ý quan trọng.
   - Không làm sai giọng điệu, thái độ hoặc mức độ trang trọng của câu gốc.

7. Giữ nguyên các yếu tố sau nếu xuất hiện:
   - Tên riêng, tên thương hiệu, tên địa danh, số liệu, đơn vị đo, mã sản phẩm, hashtag, username, URL.
   - Ký hiệu đặc biệt hoặc định dạng quan trọng trong nội dung gốc, trừ khi việc điều chỉnh là cần thiết để câu tiếng Việt tự nhiên hơn.

8. Giữ nguyên cấu trúc JSON gốc:
   - Không thêm, xóa, đổi tên hoặc sắp xếp lại bất kỳ key nào.
   - Không thay đổi thứ tự các khối phụ đề.
   - Không gộp khối, không tách khối.
   - Tuyệt đối giữ ranh giới nội dung riêng biệt giữa từng ID JSON, không được nối ý hoặc tràn văn bản từ ID này sang ID khác.
   - Các giá trị không phải nội dung thoại/phụ đề như id, start, end, duration, timestamp... phải được giữ nguyên.
   - Chỉ thay thế phần văn bản phụ đề bằng bản dịch tiếng Việt.

9. Bổ sung dấu câu chuẩn ở cuối câu:
   - Cuối các khối phụ đề hoàn chỉnh ý, bắt buộc phải có dấu chấm (.), dấu hỏi (?) hoặc dấu cảm (!).
   - Việc bổ sung dấu câu chuẩn giúp bộ đọc thoại OmniVoice nhận diện ngắt nhóm câu tự nhiên, tránh bị dồn nhiều câu thành nhóm quá dài.

10. Kết quả trả về phải là JSON hợp lệ tuyệt đối:
   - Chỉ trả về JSON.
   - Không dùng Markdown.
   - Không bọc trong \`\`\`json.
   - Không thêm giải thích, ghi chú, nhận xét hoặc bất kỳ văn bản nào ngoài JSON.

HỒ SƠ DỊCH CỦA DỰ ÁN (BẮT BUỘC TUÂN THỦ TRONG MỌI LÔ):
${buildTranslationProfileInstructions(translationProfile)}

NGỮ CẢNH TRƯỚC ĐÓ (đã dịch, CHỈ làm tham chiếu để giữ nhất quán nhân xưng/thuật ngữ/mạch câu xuyên lô — KHÔNG đưa vào kết quả, KHÔNG dịch lại):
${prevContext && prevContext.length ? JSON.stringify(prevContext, null, 2) : '(không có — đây là lô đầu)'}

Dữ liệu đầu vào (các khối CẦN dịch sang ${targetLangName}):

${JSON.stringify(map, null, 2)}`;
}

async function translateWithOpenAICompatible(map, apiKey, model, baseUrl, providerName, targetLangName = 'Tiếng Việt', prevContext = [], translationProfile = {}) {
  const prompt = getTranslationPrompt(map, targetLangName, prevContext, translationProfile);
  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey && apiKey.trim() !== '') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (providerName === 'OpenRouter') {
    headers['HTTP-Referer'] = 'https://github.com/Antigravity';
    headers['X-Title'] = 'Video Studio Tools';
  }

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      stream: false
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${providerName} API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const rawText = data?.choices?.[0]?.message?.content || '';
  return extractJson(rawText);
}

async function translateWithGemini(map, apiKey, modelNameInput, targetLangName = 'Tiếng Việt', prevContext = [], translationProfile = {}) {
  const prompt = getTranslationPrompt(map, targetLangName, prevContext, translationProfile);

  let modelName = modelNameInput;
  if (!modelName) {
    modelName = await getAvailableGeminiModel(apiKey);
  } else {
    if (!modelName.startsWith('models/')) {
      modelName = 'models/' + modelName;
    }
  }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    cachedGeminiModel = null; // Reset cache nếu bị lỗi
    throw new Error(`Lỗi API: ${err}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return extractJson(rawText);
}

async function translateWithOpenRouter(map, apiKey, model, targetLangName = 'Tiếng Việt', prevContext = [], translationProfile = {}) {
  const selectedModel = model || 'openrouter/owl-alpha';
  return translateWithOpenAICompatible(map, apiKey, selectedModel, 'https://openrouter.ai/api/v1/chat/completions', 'OpenRouter', targetLangName, prevContext, translationProfile);
}

async function translateWithNineRouter(map, apiKey, model, baseUrl, targetLangName = 'Tiếng Việt', prevContext = [], translationProfile = {}) {
  const selectedModel = model || '';
  const endpoint = `${baseUrl || 'http://localhost:20128/v1'}/chat/completions`;
  return translateWithOpenAICompatible(map, apiKey, selectedModel, endpoint, '9Router', targetLangName, prevContext, translationProfile);
}

let openCodeServerInstance = null;

async function ensureOpenCodeServerRunning(port = 4096) {
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${baseUrl}/session`, { method: 'GET' });
    if (res.ok || res.status === 200 || res.status === 401 || res.status === 404) {
      return baseUrl;
    }
  } catch (e) {
    // Server chưa chạy, tiến hành tự động khởi chạy
  }

  console.log(`[OpenCode] Đang tự động khởi chạy OpenCode server ngầm tại cổng ${port}...`);
  const sdk = await import('@opencode-ai/sdk');
  if (!openCodeServerInstance) {
    openCodeServerInstance = await sdk.createOpencodeServer({ port: port, hostname: '127.0.0.1' });
  }
  return openCodeServerInstance.url || baseUrl;
}

async function translateWithOpenCode(map, model = 'DeepSeek V4 Flash (Free)', targetLangName = 'Tiếng Việt', prevContext = [], translationProfile = {}) {
  const prompt = getTranslationPrompt(map, targetLangName, prevContext, translationProfile);

  const modelMap = {
    'DeepSeek V4 Flash (Free)': 'deepseek-v4-flash-free',
    'Big Pickle (Free)': 'big-pickle',
    'HY3 (Free)': 'hy3-free',
    'MiMo V2.5 (Free)': 'mimo-v2.5-free',
    'North Mini Code (Free)': 'north-mini-code-free'
  };
  const selectedModel = modelMap[model] || model || 'deepseek-v4-flash-free';

  const payload = {
    model: selectedModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.0
  };

  if (selectedModel !== 'hy3-free') {
    payload.response_format = { type: 'json_object' };
  }

  const response = await fetch('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer public'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenCode Zen API returned status ${response.status}: ${errText}`);
  }

  const data = await response.json();
  let text = '';
  if (data.choices && data.choices[0]?.message?.content) {
    text = data.choices[0].message.content;
  } else if (data.choices && data.choices[0]?.message?.reasoning_content) {
    text = data.choices[0].message.reasoning_content;
  } else {
    throw new Error('OpenCode Zen API returned empty or invalid response structure');
  }

  console.log('[OpenCode Zen API Sample Output]:', text.substring(0, 150));
  return extractJson(text);
}


async function translateWithRetry(text, options = {}) {
  let retries = 3;
  let delay = 3000;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await translate(text, options);
    } catch (err) {
      if (err.message.includes('429') && attempt < retries) {
        console.warn(`[Translate] Gặp lỗi 429 (Rate Limit). Đang tạm dừng ${delay}ms và thử lại lần ${attempt}/${retries}...`);
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
}

async function translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, targetNllbLang = 'vie_Latn', translationProfile = {}) {
  console.log('Bắt đầu dịch bằng AI Local NLLB-200...');
  
  // Tải model nếu chưa tồn tại
  const { ensureNllbModelExist } = require('./model-downloader');
  const isPackaged = __dirname.includes('app.asar');
  const appDataRoot = getAppDataRoot(path.join(__dirname, '..'));
  const MODELS_DIR = path.join(appDataRoot, 'models');
  const nllbModelDir = path.join(MODELS_DIR, 'nllb');
  
  if (global.updateStudioProgress) {
    global.updateStudioProgress(36, 'Đang kiểm tra và tải model dịch thuật local NLLB-200...');
  }
  
  await ensureNllbModelExist(MODELS_DIR, (progress) => {
    if (global.updateStudioProgress) {
      global.updateStudioProgress(36, `Đang tải model NLLB: ${progress.percent}%`);
    }
  });

  const nllbExePath = isPackaged 
    ? path.join(process.resourcesPath, 'tools', 'nllb_translate.exe')
    : path.join(__dirname, '..', 'tools', 'nllb_translate.exe');

  if (!fs.existsSync(nllbExePath)) {
    throw new Error(`Thiếu file chạy nllb_translate.exe tại ${nllbExePath}. Vui lòng biên dịch hoặc tải về.`);
  }

  if (global.updateStudioProgress) {
    global.updateStudioProgress(37, 'Đang chạy mô hình AI dịch thuật NLLB-200 local...');
  }

  const execFilePromise = (file, args) => {
    return new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      const proc = execFile(file, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`NLLB Local Error: ${stderr || error.message}`));
        } else {
          resolve(stdout);
        }
      });
      
      // Đăng ký tiến trình con với activeProcesses của server để có thể hủy
      if (global.registerChildProcess) {
        global.registerChildProcess(proc);
      }
    });
  };

  const targetLang = targetNllbLang;
  console.log(`Chạy NLLB dịch từ ${srcLang} sang ${targetLang}...`);
  
  const args = [
    inputPath,
    '--model_dir', nllbModelDir,
    '--src_lang', srcLang,
    '--tgt_lang', targetLang,
    '--output', outputPath,
    '--batch_size', '32'
  ];

  if (isCancelled && isCancelled()) {
    console.log('[Dịch] Hủy dịch NLLB do phiên render đã bị hủy.');
    return;
  }
  // Chạy NLLB với cancel poll mỗi 3s
  const nllbPromise = execFilePromise(nllbExePath, args);
  const cancelPromise = new Promise((_, reject) => {
    const poll = setInterval(() => {
      if (isCancelled && isCancelled()) {
        clearInterval(poll);
        reject(new Error('Đã hủy kết xuất (trong khi NLLB đang dịch)'));
      }
    }, 3000);
    nllbPromise.finally(() => clearInterval(poll));
  });
  await Promise.race([nllbPromise, cancelPromise]);
  console.log('NLLB Local dịch hoàn tất thành công!');

  if (fs.existsSync(outputPath)) {
    const parser = new Parser();
    const translatedItems = parser.fromSrt(fs.readFileSync(outputPath, 'utf8'));
    translatedItems.forEach((item) => {
      item.text = postProcessText(item.text, translationProfile);
    });
    fs.writeFileSync(outputPath, parser.toSrt(translatedItems), 'utf8');
  }
  
  // Định dạng lại phụ đề
  try {
    formatSubtitleFile(outputPath, maxLines, maxCharsPerLine);
  } catch (err) {
    console.error('Lỗi định dạng phụ đề sau dịch NLLB:', err.message);
  }
  return createTranslationQualityReport(
    fs.readFileSync(inputPath, 'utf8'),
    fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '',
    translationProfile
  );
}

async function translateSubtitles(inputPath, outputPath, geminiApiKey, maxLines = 0, maxCharsPerLine = 22, isCancelled = null) {
  const content = fs.readFileSync(inputPath, 'utf8');

  let aiProvider = 'nllb';
  let geminiApiKeyVal = '';
  let geminiModelVal = '';
  let openRouterApiKeyVal = '';
  let openRouterModelVal = '';
  let ninerouterApiKeyVal = '';
  let ninerouterModelVal = '';
  let ninerouterBaseUrlVal = 'http://localhost:20128/v1';
  let opencodeModelVal = 'DeepSeek V4 Flash (Free)';
  let srcLang = 'auto';
  let targetLang = 'vi';
  let translationProfile = normalizeTranslationProfile({});

  if (typeof geminiApiKey === 'object' && geminiApiKey !== null) {
    aiProvider = geminiApiKey.aiProvider || 'nllb';
    geminiApiKeyVal = geminiApiKey.geminiApiKey || '';
    geminiModelVal = geminiApiKey.geminiModel || '';
    openRouterApiKeyVal = geminiApiKey.openRouterApiKey || '';
    openRouterModelVal = geminiApiKey.openRouterModel || 'openrouter/owl-alpha';
    ninerouterApiKeyVal = geminiApiKey.ninerouterApiKey || '';
    ninerouterModelVal = geminiApiKey.ninerouterModel || '';
    ninerouterBaseUrlVal = geminiApiKey.ninerouterBaseUrl || 'http://localhost:20128/v1';
    opencodeModelVal = geminiApiKey.opencodeModel || 'DeepSeek V4 Flash (Free)';
    srcLang = geminiApiKey.srcLang || 'auto';
    targetLang = geminiApiKey.targetLang || 'vi';
    translationProfile = normalizeTranslationProfile(geminiApiKey.translationProfile);
  } else if (typeof geminiApiKey === 'string' && geminiApiKey.trim() !== '') {
    aiProvider = 'gemini';
    geminiApiKeyVal = geminiApiKey;
  }

  const langInfo = LANG_MAP[targetLang] || LANG_MAP.vi;
  const targetLangName = langInfo.name;
  const nllbTargetLang = langInfo.nllb;

  if (!srcLang || srcLang === 'auto') {
    if (/[\u4e00-\u9fa5]/.test(content)) {
      srcLang = 'zho_Hans';
    } else if (/[\uac00-\ud7a3]/.test(content)) {
      srcLang = 'kor_Hang';
    } else if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(content)) {
      srcLang = 'jpn_Jpan';
    } else {
      srcLang = 'eng_Latn';
    }
    console.log(`[Auto-Detect] Tự động nhận diện ngôn ngữ nguồn cho NLLB: ${srcLang}`);
  }

  let parser = new Parser();
  let srtArray = parser.fromSrt(content);

  // Loại bỏ các mục phụ đề trùng lặp trước khi gộp câu
  srtArray = deduplicateSubtitles(srtArray);
  console.log(`[Dịch phụ đề] Số khối sub sau khi loại trùng: ${srtArray.length}`);

  // 3. Dịch bằng AI Local NLLB-200
  if (aiProvider === 'nllb') {
    const report = await translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, nllbTargetLang, translationProfile);
    return { outputPath, report };
  }

  // 4. Dịch bằng OpenCode Zen Cloud API (DeepSeek V4 Flash...) sử dụng cấu trúc JSON tối ưu
  if (aiProvider === 'opencode') {
    const selectedOpencodeModel = opencodeModelVal || 'DeepSeek V4 Flash (Free)';
    const providerName = `OpenCode SDK (${selectedOpencodeModel})`;
    console.log(`Đang gọi ${providerName} để dịch phụ đề theo từng lô JSON...`);
    try {
      const batchSize = Math.min(80, srtArray.length);
      let prevContext = [];
      for (let i = 0; i < srtArray.length; i += batchSize) {
        if (isCancelled && isCancelled()) {
          console.log('[Dịch] Hủy dịch phụ đề do phiên render đã bị hủy.');
          return;
        }

        const batch = srtArray.slice(i, i + batchSize);
        const batchMap = {};
        batch.forEach(function (item) {
          let t = prepareTextForTranslation(item.text, translationProfile);
          t = t.split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ').trim();
          batchMap[item.id] = t;
        });

        if (i > 0) {
          await sleep(1000);
        }

        const translateFn = function (m) {
          return translateWithOpenCode(m, selectedOpencodeModel, targetLangName, prevContext, translationProfile);
        };

        let translatedMap = {};
        try {
          translatedMap = await translateBatchWithRetry(batchMap, translateFn, 0);
          if (!translatedMap || Object.keys(translatedMap).length === 0) {
            throw new Error('OpenCode không trả về kết quả dịch JSON hợp lệ.');
          }
        } catch (retryErr) {
          console.error('[Dịch] Lô ' + i + '-' + (i + batch.length) + ' dịch thất bại sau retry: ' + retryErr.message);
          throw retryErr;
        }

        batch.forEach(function (item) {
          if (translatedMap && translatedMap[item.id]) {
            item.text = postProcessText(translatedMap[item.id], translationProfile);
          } else {
            console.warn('Thiếu câu dịch cho ID: ' + item.id);
          }
        });

        const translatedItems = batch.filter(function (it) { return translatedMap[it.id]; }).map(function (it) {
          return { id: it.id, original: batchMap[it.id], translated: it.text };
        });
        prevContext = translatedItems.slice(-12);

        console.log('Đã dịch ' + Math.min(i + batchSize, srtArray.length) + '/' + srtArray.length + ' dòng.');
      }

      const translatedContent = parser.toSrt(srtArray);
      fs.writeFileSync(outputPath, translatedContent, 'utf8');
      try { formatSubtitleFile(outputPath, maxLines, maxCharsPerLine); } catch (e) { console.error('Lỗi định dạng phụ đề sau dịch AI:', e.message); }
      console.log(`Đã dịch thành công bằng ${providerName} và lưu tại: ${outputPath}`);
      return {
        outputPath,
        report: createTranslationQualityReport(content, fs.readFileSync(outputPath, 'utf8'), translationProfile)
      };
    } catch (err) {
      console.error(`${providerName} dịch thất bại (${err.message}). Đang lùi về dùng NLLB Local...`);
      const report = await translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, nllbTargetLang, translationProfile);
      return { outputPath, report };
    }
  }

  // 1 & 2 & 9. Dịch bằng Gemini, OpenRouter hoặc 9Router sử dụng cấu trúc JSON tối ưu
  if ((aiProvider === 'gemini' && geminiApiKeyVal && geminiApiKeyVal.trim() !== '') ||
      (aiProvider === 'openrouter' && openRouterApiKeyVal && openRouterApiKeyVal.trim() !== '') ||
      (aiProvider === 'ninerouter' || aiProvider === '9router')) {

    
    const isGemini = aiProvider === 'gemini';
    const isOpenRouter = aiProvider === 'openrouter';
    const apiKey = isGemini ? geminiApiKeyVal.trim() : (isOpenRouter ? openRouterApiKeyVal.trim() : ninerouterApiKeyVal.trim());
    const providerName = isGemini ? 'Gemini AI' : (isOpenRouter ? `OpenRouter AI (${openRouterModelVal})` : `9Router Local AI Proxy (${ninerouterModelVal})`);
    
    console.log(`Đang gọi ${providerName} để dịch phụ đề theo từng lô JSON...`);
    try {
    const batchSize = Math.min(80, srtArray.length);
    let prevContext = [];
    for (let i = 0; i < srtArray.length; i += batchSize) {
      if (isCancelled && isCancelled()) {
        console.log('[Dịch] Hủy dịch phụ đề do phiên render đã bị hủy.');
        return;
      }

      const batch = srtArray.slice(i, i + batchSize);
      const batchMap = {};
      batch.forEach(function (item) {
        let t = prepareTextForTranslation(item.text, translationProfile);
        t = t.split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ').trim();
        batchMap[item.id] = t;
      });

      if (i > 0) {
        await sleep(1000);
      }

      const translateFn = function (m) {
        if (isGemini) return translateWithGemini(m, apiKey, geminiModelVal, targetLangName, prevContext, translationProfile);
        if (isOpenRouter) return translateWithOpenRouter(m, apiKey, openRouterModelVal, targetLangName, prevContext, translationProfile);
        return translateWithNineRouter(m, ninerouterApiKeyVal, ninerouterModelVal, ninerouterBaseUrlVal, targetLangName, prevContext, translationProfile);
      };

      let translatedMap = {};
      try {
        translatedMap = await translateBatchWithRetry(batchMap, translateFn, 0);
      } catch (retryErr) {
        console.error('[Dịch] Lô ' + i + '-' + (i + batch.length) + ' dịch thất bại sau retry: ' + retryErr.message + '. Giữ nguyên bản gốc cho lô này.');
        translatedMap = {};
      }

      batch.forEach(function (item) {
        if (translatedMap && translatedMap[item.id]) {
          item.text = postProcessText(translatedMap[item.id], translationProfile);
        } else {
          console.warn('Thiếu câu dịch cho ID: ' + item.id);
        }
      });

      const translatedItems = batch.filter(function (it) { return translatedMap[it.id]; }).map(function (it) {
        return { id: it.id, original: batchMap[it.id], translated: it.text };
      });
      prevContext = translatedItems.slice(-12);

      console.log('Đã dịch ' + Math.min(i + batchSize, srtArray.length) + '/' + srtArray.length + ' dòng.');
    }
      
      const translatedContent = parser.toSrt(srtArray);
      fs.writeFileSync(outputPath, translatedContent, 'utf8');
      try { formatSubtitleFile(outputPath, maxLines, maxCharsPerLine); } catch (e) { console.error('Lỗi định dạng phụ đề sau dịch AI:', e.message); }
      console.log(`Đã dịch thành công bằng ${providerName} và lưu tại: ${outputPath}`);
      return {
        outputPath,
        report: createTranslationQualityReport(content, fs.readFileSync(outputPath, 'utf8'), translationProfile)
      };
    } catch (err) {
      console.error(`${providerName} dịch thất bại (${err.message}). Đang lùi về dùng NLLB Local...`);
      const report = await translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, nllbTargetLang, translationProfile);
      return { outputPath, report };
    }
  }

  // Cơ chế dự phòng Google Translate — dùng srtArray đã dedup+merge từ trên
  console.log(`Bắt đầu dịch ${srtArray.length} dòng phụ đề bằng Google Translate...`);

  const wrapOrClean = (txt) => {
    if (maxLines === 1) {
      return txt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    } else if (maxLines === 2) {
      return wrapTextToTwoLines(txt, maxCharsPerLine);
    } else if (maxLines === 3) {
      return wrapTextToThreeLines(txt, maxCharsPerLine);
    } else { // maxLines === 0
      const clean = txt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length <= maxCharsPerLine) {
        return clean;
      } else if (clean.length <= maxCharsPerLine * 1.6) {
        return wrapTextToTwoLines(clean, maxCharsPerLine);
      } else {
        return wrapTextToThreeLines(clean, maxCharsPerLine);
      }
    }
  };

  const batchSize = 30;
  let consecutiveFailures = 0;

  for (let i = 0; i < srtArray.length; i += batchSize) {
    if (isCancelled && isCancelled()) {
      console.log('[Dịch] Hủy dịch phụ đề do phiên render đã bị hủy.');
      return;
    }

    const batch = srtArray.slice(i, i + batchSize);
    
    // Nếu bị chặn hoàn toàn (3 lô liên tiếp thất bại) thì ném lỗi dừng render
    if (consecutiveFailures >= 3) {
      throw new Error('[Dịch] Phát hiện bị Google Translate chặn cứng liên tiếp 3 lần (Rate Limit/IP Block).');
    }

    // Áp dụng tiền xử lý từ điển trước khi dịch
    const textToTranslate = batch.map(item => {
      const clean = prepareTextForTranslation(item.text, translationProfile);
      return clean.replace(/\n/g, ' ');
    }).join(' ||| ');
    
    // Giãn cách nhẹ chủ động giữa các đợt dịch để tránh rate limit
    if (i > 0) {
      await sleep(500);
    }

    try {
      const { text } = await translateWithRetry(textToTranslate, { to: targetLang });
      consecutiveFailures = 0; // Reset lỗi liên tiếp
      
      const normalizedText = text.normalize('NFC');
      const translatedParts = normalizedText.split(/\|\|\||\| \| \|/i).map(s => s.trim());
      
      if (translatedParts.length === batch.length) {
        for (let j = 0; j < batch.length; j++) {
          const processed = postProcessText(translatedParts[j], translationProfile);
          batch[j].text = wrapOrClean(processed);
        }
      } else {
        console.warn(`Số phần dịch không khớp (${translatedParts.length} vs ${batch.length}). Đang tự động chuyển sang dịch dòng đơn...`);
        for (const item of batch) {
          if (isCancelled && isCancelled()) return;
          try {
            const cleanText = prepareTextForTranslation(item.text, translationProfile);
            const { text } = await translateWithRetry(cleanText, { to: targetLang });
            const processed = postProcessText(text.normalize('NFC'), translationProfile);
            item.text = wrapOrClean(processed);
            await sleep(300); // Giãn cách ngắn tránh rate limit
          } catch (e) {
            console.error('Lỗi dịch dòng đơn:', e.message);
            throw new Error(`Dịch dòng đơn bằng Google Translate thất bại: ${e.message}`);
          }
        }
      }
    } catch (err) {
      console.error('Lỗi dịch lô phụ đề:', err.message);
      consecutiveFailures++;
      
      if (err.message.includes('429')) {
        console.log('[Dịch] Google chặn IP, tạm dừng 15s để cool-down...');
        if (global.updateStudioProgress) {
          global.updateStudioProgress(35, 'Đang chờ Google Translate hồi phục (15s)...');
        }
        await sleep(15000); // Chờ 15s để hồi phục
        
        if (global.updateStudioProgress) {
          global.updateStudioProgress(35, `Đang dịch phụ đề sang ${targetLangName} bằng AI...`);
        }

        // Thử dịch lại toàn bộ lô đó một lần cuối cùng
        try {
          if (isCancelled && isCancelled()) return;
          const { text } = await translate(textToTranslate, { to: targetLang });
          consecutiveFailures = 0; // Reset lỗi
          const normalizedText = text.normalize('NFC');
          const translatedParts = normalizedText.split(/\|\|\||\| \| \|/i).map(s => s.trim());
          if (translatedParts.length === batch.length) {
            for (let j = 0; j < batch.length; j++) {
              const processed = postProcessText(translatedParts[j], translationProfile);
              batch[j].text = wrapOrClean(processed);
            }
            console.log(`Đã phục hồi dịch thành công sau cool-down cho lô từ ${i} đến ${i + batch.length}.`);
            continue;
          }
        } catch (retryErr) {
          console.error('Dịch lại lô thất bại sau cool-down:', retryErr.message);
          throw new Error(`Dịch thuật bằng Google Translate thất bại sau cool-down: ${retryErr.message}`);
        }
      }
      
      throw new Error(`Dịch thuật bằng Google Translate thất bại: ${err.message}`);
    }
    
    console.log(`Đã dịch ${Math.min(i + batchSize, srtArray.length)}/${srtArray.length} dòng.`);
  }

  const translatedContent = parser.toSrt(srtArray);
  fs.writeFileSync(outputPath, translatedContent, 'utf8');
  
  try {
    formatSubtitleFile(outputPath, maxLines, maxCharsPerLine);
  } catch (err) {
    console.error('Lỗi định dạng phụ đề sau dịch:', err.message);
  }

  console.log(`Đã dịch và lưu phụ đề tiếng Việt tại: ${outputPath}`);
  return {
    outputPath,
    report: createTranslationQualityReport(content, fs.readFileSync(outputPath, 'utf8'), translationProfile)
  };
}

module.exports = {
  applyTranslationProfileToText,
  buildTranslationProfileInstructions,
  createTranslationQualityReport,
  formatSubtitleFile,
  getTranslationPrompt,
  msToSrtTime,
  normalizeTranslationProfile,
  prepareTextForTranslation,
  srtTimeToMs,
  translateSubtitles
};
