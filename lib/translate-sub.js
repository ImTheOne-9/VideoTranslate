const fs = require('fs');
const path = require('path');
const Parser = require('srt-parser-2').default;
const { getAppDataRoot } = require('./path-helper');
const {
  createCheckpointSignature,
  readJsonFile,
  writeJsonAtomic
} = require('./checkpoint-utils');
const { cleanWhisperParentheticalSegmentation } = require('./whisper-onnx-helper');
const { translateViaGeminiWeb, closeGeminiWebSession } = require('./gemini-web-adapter');
const { OUTPUT_LANGUAGES } = require('./voice-language-catalog');
const { sanitizeResidualCjk } = require('./translation-output-safety');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const LEGACY_NLLB_CODES = {
  vi: 'vie_Latn', en: 'eng_Latn', zh: 'zho_Hans', ko: 'kor_Hang', ja: 'jpn_Jpan',
  th: 'tha_Thai', fr: 'fra_Latn', es: 'spa_Latn', pt: 'por_Latn', de: 'deu_Latn',
  it: 'ita_Latn', ru: 'rus_Cyrl', id: 'ind_Latn', ms: 'zsm_Latn', ar: 'arb_Arab',
  hi: 'hin_Deva', tr: 'tur_Latn'
};
const LANG_MAP = Object.freeze(Object.fromEntries(OUTPUT_LANGUAGES.map((language) => [
  language.code,
  {
    name: language.promptName,
    nllb: LEGACY_NLLB_CODES[language.code] || language.code,
    google: language.google
  }
])));

const TRANSLATION_STYLES = {
  hai_huoc: 'hài hước, dí dỏm',
  viral: 'viral kiểu TikTok (câu mở gây tò mò, cuốn người xem)',
  kich_tinh: 'kịch tính, hồi hộp',
  cam_xuc: 'giàu cảm xúc, lay động',
  doi_thuong: 'đời thường, gần gũi như đang trò chuyện',
  van_hoc: 'văn học, giàu hình ảnh',
  ngan_gon: 'ngắn gọn, súc tích'
};

function parseTranslationStyles(value) {
  let styles = value;
  if (typeof styles === 'string') {
    try {
      const parsed = JSON.parse(styles);
      styles = Array.isArray(parsed) ? parsed : styles.split(',');
    } catch {
      styles = styles.split(',');
    }
  }
  return [...new Set((Array.isArray(styles) ? styles : [])
    .map(item => String(item || '').trim())
    .filter(item => Object.hasOwn(TRANSLATION_STYLES, item)))];
}

function normalizeSourceLanguage(value) {
  const key = String(value || '').trim().toLowerCase();
  if (['ch', 'zh', 'zh-cn', 'zh-tw', 'zho_hans', 'zho_hant'].includes(key)) return 'zho_Hans';
  if (['vi', 'vie', 'vie_latn'].includes(key)) return 'vie_Latn';
  if (['en', 'eng', 'eng_latn'].includes(key)) return 'eng_Latn';
  if (['japan', 'ja', 'jp', 'jpn', 'jpn_jpan'].includes(key)) return 'jpn_Jpan';
  if (['korean', 'ko', 'kor', 'kor_hang'].includes(key)) return 'kor_Hang';
  if (['thai', 'th', 'tha', 'tha_thai'].includes(key)) return 'tha_Thai';
  if (['french', 'fr', 'fra', 'fra_latn'].includes(key)) return 'fra_Latn';
  if (['spanish', 'es', 'spa', 'spa_latn'].includes(key)) return 'spa_Latn';
  if (['portuguese', 'pt', 'por', 'por_latn'].includes(key)) return 'por_Latn';
  if (['german', 'de', 'deu', 'deu_latn'].includes(key)) return 'deu_Latn';
  if (['italian', 'it', 'ita', 'ita_latn'].includes(key)) return 'ita_Latn';
  if (['russian', 'ru', 'rus', 'rus_cyrl'].includes(key)) return 'rus_Cyrl';
  if (['indonesian', 'id', 'ind', 'ind_latn'].includes(key)) return 'ind_Latn';
  if (['malay', 'ms', 'zsm', 'zsm_latn'].includes(key)) return 'zsm_Latn';
  if (['arabic', 'ar', 'arb', 'arb_arab'].includes(key)) return 'arb_Arab';
  if (['hindi', 'hi', 'hin', 'hin_deva'].includes(key)) return 'hin_Deva';
  if (['turkish', 'tr', 'tur', 'tur_latn'].includes(key)) return 'tur_Latn';
  return key && key !== 'auto' ? value : 'auto';
}

function detectSourceLanguage(content, requested = 'auto') {
  const normalized = normalizeSourceLanguage(requested);
  if (normalized !== 'auto') return normalized;
  const text = String(content || '');
  if (/[\u3040-\u30ff\u31f0-\u31ff]/u.test(text)) return 'jpn_Jpan';
  if (/[\uac00-\ud7a3]/u.test(text)) return 'kor_Hang';
  if (/[\u0e00-\u0e7f]/u.test(text)) return 'tha_Thai';
  if (/[\u0900-\u097f]/u.test(text)) return 'hin_Deva';
  if (/[\u0600-\u06ff]/u.test(text)) return 'arb_Arab';
  if (/[\u0400-\u04ff]/u.test(text)) return 'rus_Cyrl';
  if (/[\u4e00-\u9fa5]/u.test(text)) return 'zho_Hans';
  const lower = text.normalize('NFC').toLocaleLowerCase('vi-VN');
  const vietnameseMarks = (lower.match(/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gu) || []).length;
  const vietnameseWords = (lower.match(/\b(?:của|và|là|không|nhưng|được|đang|một|những|người|chúng|này|đó|với|cho|khi|tôi|bạn|anh|em)\b/gu) || []).length;
  if (vietnameseMarks >= 2 || vietnameseWords >= 3) return 'vie_Latn';
  return 'eng_Latn';
}

function sourceMatchesTarget(srcLang, targetLang) {
  const source = normalizeSourceLanguage(srcLang);
  const sourceRoot = String(source || '').toLowerCase().split(/[-_]/)[0];
  if (sourceRoot === String(targetLang || '').toLowerCase()) return true;
  const targetCodes = {
    vi: 'vie_Latn', en: 'eng_Latn', zh: 'zho_Hans', ja: 'jpn_Jpan', ko: 'kor_Hang',
    th: 'tha_Thai', fr: 'fra_Latn', es: 'spa_Latn', pt: 'por_Latn', de: 'deu_Latn',
    it: 'ita_Latn', ru: 'rus_Cyrl', id: 'ind_Latn', ms: 'zsm_Latn', ar: 'arb_Arab',
    hi: 'hin_Deva', tr: 'tur_Latn'
  };
  if (targetLang === 'zh') return source.startsWith('zho');
  return targetCodes[targetLang] === source;
}

function buildTranslationStyleRule(styles) {
  const selected = parseTranslationStyles(styles);
  if (!selected.length) return '';
  return `VIẾT LẠI lời thoại theo phong cách: ${selected.map(code => TRANSLATION_STYLES[code]).join(', ')}. GIỮ NGUYÊN ý nghĩa, KHÔNG thêm/bớt tình tiết, KHÔNG đổi timeline hay số câu.`;
}

function limitText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeComparableTranslation(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:'"“”‘’…()[\]{}，。！？；：、]/g, '')
    .trim()
    .toLocaleLowerCase();
}

function countSourceScriptCharacters(value, srcLang) {
  const text = String(value || '');
  if (String(srcLang).startsWith('zho')) return (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
  if (String(srcLang).startsWith('jpn')) return (text.match(/[\u3040-\u30ff\u31f0-\u31ff]/gu) || []).length;
  if (String(srcLang).startsWith('kor')) return (text.match(/[\uac00-\ud7a3]/gu) || []).length;
  if (String(srcLang).startsWith('tha')) return (text.match(/[\u0e00-\u0e7f]/gu) || []).length;
  if (String(srcLang).startsWith('ara')) return (text.match(/[\u0600-\u06ff]/gu) || []).length;
  if (String(srcLang).startsWith('rus')) return (text.match(/[\u0400-\u04ff]/gu) || []).length;
  return 0;
}

function validateTranslationCandidate(sourceText, translatedText, options = {}) {
  let translated = String(translatedText || '').trim();
  if (!translated) return { valid: false, reason: 'empty_translation' };

  const sourceComparable = normalizeComparableTranslation(sourceText);
  const translatedComparable = normalizeComparableTranslation(translated);
  const meaningfulLength = sourceComparable.replace(/[^\p{L}\p{N}]/gu, '').length;
  const sourceScriptCount = countSourceScriptCharacters(sourceText, options.srcLang);
  const targetUsesSameScript = options.targetLang === 'zh'
    && String(options.srcLang).startsWith('zho');
  const unchangedMeaningfulText = sourceComparable === translatedComparable
    && meaningfulLength >= 6
    && (sourceScriptCount > 0 || /\s/u.test(String(sourceText || '')));
  if (unchangedMeaningfulText) {
    return { valid: false, reason: 'unchanged_from_source', text: '' };
  }

  const sourceIsCjk = String(options.srcLang || '').startsWith('zho')
    || String(options.srcLang || '').startsWith('jpn')
    || /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff]/u.test(String(sourceText || ''));
  if (sourceIsCjk && !['zh', 'ja'].includes(options.targetLang)) {
    const safety = sanitizeResidualCjk(translated, {
      targetLang: options.targetLang,
      threshold: Number(options.cleanupThreshold ?? process.env.HAN_GO_NGUONG ?? 0.15)
    });
    if (!safety.valid) return { valid: false, reason: 'source_language_remaining', text: '', safety };
    translated = safety.text;
  }

  if (sourceScriptCount >= 3 && !targetUsesSameScript) {
    const remaining = countSourceScriptCharacters(translated, options.srcLang);
    if (remaining / sourceScriptCount >= 0.6) {
      return { valid: false, reason: 'source_language_remaining', text: '' };
    }
  }
  return { valid: true, reason: null, text: translated };
}

function validateTranslationMap(batchMap, translatedMap, options = {}) {
  const valid = {};
  const failures = [];
  for (const [id, sourceText] of Object.entries(batchMap || {})) {
    const candidate = translatedMap && Object.hasOwn(translatedMap, id)
      ? translatedMap[id]
      : null;
    const result = validateTranslationCandidate(sourceText, candidate, options);
    if (result.valid) valid[id] = result.text;
    else failures.push({ id: String(id), reason: result.reason });
  }
  return { valid, failures };
}

function createTranslationCheckpoint(outputPath, context) {
  const checkpointPath = `${outputPath}.translation-checkpoint.json`;
  const signature = createCheckpointSignature({
    // Version 4 separates Gemini Web checkpoints from the shared JSON providers.
    version: 4,
    sourceText: context.sourceText,
    targetLang: context.targetLang,
    pipeline: context.pipeline || 'shared-json-v3'
  });
  const saved = readJsonFile(checkpointPath);
  const checkpoint = saved?.version === 1 && saved.signature === signature
    ? saved
    : {
        version: 1,
        signature,
        targetLang: context.targetLang,
        entries: {},
        updatedAt: null
      };

  function save() {
    checkpoint.updatedAt = new Date().toISOString();
    writeJsonAtomic(checkpointPath, checkpoint);
  }

  function get(item, validationOptions) {
    const entry = checkpoint.entries[String(item.id)];
    if (!entry || entry.status !== 'success' || entry.source !== item.text) return null;
    const validation = validateTranslationCandidate(entry.source, entry.translated, validationOptions);
    return validation.valid ? validation.text : null;
  }

  function success(item, translated, provider) {
    checkpoint.entries[String(item.id)] = {
      source: item.text,
      translated,
      status: 'success',
      provider,
      error: null
    };
  }

  function failure(item, provider, reason, error) {
    checkpoint.entries[String(item.id)] = {
      source: item.text,
      translated: null,
      status: 'error',
      provider,
      reason,
      error: limitText(error, 500)
    };
  }

  function getGlobalContext(analysisKey) {
    const analysis = checkpoint.globalContext;
    if (!analysis || analysis.key !== analysisKey || !analysis.context) return null;
    return analysis.context;
  }

  function saveGlobalContext(analysisKey, globalContext) {
    checkpoint.globalContext = {
      key: analysisKey,
      context: globalContext,
      createdAt: new Date().toISOString()
    };
    save();
  }

  function report(total) {
    const entries = Object.entries(checkpoint.entries);
    const successful = entries.filter(([, entry]) => entry.status === 'success');
    const failed = entries.filter(([, entry]) => entry.status === 'error');
    return {
      total,
      translated: successful.length,
      failed: failed.length,
      fallbackUsed: successful.filter(([, entry]) => entry.provider === 'nllb-fallback').length,
      unchangedFromSource: failed.filter(([, entry]) => entry.reason === 'unchanged_from_source').length,
      sourceLanguageRemaining: failed.filter(([, entry]) => entry.reason === 'source_language_remaining').length,
      failedCueIds: failed.map(([id]) => id)
    };
  }

  return {
    checkpoint,
    checkpointPath,
    failure,
    get,
    getGlobalContext,
    report,
    save,
    saveGlobalContext,
    success
  };
}

function attachTranslationStats(report, stats) {
  return {
    ...(report || { checked: false, ruleCount: 0, issueCount: 0, issues: [] }),
    translation: stats
  };
}

function createTranslationIncompleteError(stats, cause) {
  const error = new Error(
    `Dịch phụ đề chưa hoàn tất: ${stats.translated}/${stats.total} câu thành công, ${stats.failed} câu lỗi`
  );
  error.code = 'TRANSLATION_INCOMPLETE';
  error.translationReport = attachTranslationStats(null, stats);
  if (cause) error.cause = cause;
  return error;
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

// Chỉ làm sạch nội dung SRT. Số dòng hiển thị thuộc lớp dựng ASS/libass, không
// được tách cue hoặc chia lại timestamp. Đây là ranh giới quan trọng để luôn
// giữ 1 cue nguồn -> 1 cue dịch.
function formatSubtitleFile(filePath, _maxLines = 0, _maxCharsPerLine = 22) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const parser = new Parser();
  const srtArray = parser.fromSrt(content).map((item) => ({
    ...item,
    text: cleanSpaces(cleanWhisperParentheticalSegmentation(item.text))
  }));
  const formattedContent = parser.toSrt(srtArray);
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

function postProcessText(text) {
  if (!text) return '';
  let processed = text;
  for (const [key, value] of Object.entries(POST_TRANSLATE_DICT)) {
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    processed = processed.replace(new RegExp(escapedKey, 'gi'), value);
  }
  return processed;
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

async function translateJsonBatchesWithCheckpoint(options) {
  const {
    srtArray,
    sourceById,
    checkpoint,
    providerName,
    targetLang,
    srcLang,
    isCancelled,
    translateBatch,
    batchSize = 80,
    batchDelayMs = 1000,
    globalContext = null,
    retryFailedRounds = 3
  } = options;
  let prevContext = [];
  const failedItems = [];
  let reused = 0;

  const prepareBatchMap = (items) => Object.fromEntries(items.map((item) => {
    let prepared = preProcessText(sourceById[String(item.id)]);
    prepared = prepared.replace(/[\r\n]+/g, ' ').trim();
    const startMs = srtTimeToMs(item.startTime);
    const endMs = srtTimeToMs(item.endTime);
    const durationSec = Number(Math.max(0.1, (endMs - startMs) / 1000).toFixed(1));
    return [String(item.id), { text: prepared, durationSec }];
  }));

  const acceptBatchResult = (items, batchMap, translatedMap, batchError, failures) => {
    const translatedContext = [];
    for (const item of items) {
      const id = String(item.id);
      const source = sourceById[id];
      if (batchError || !Object.hasOwn(translatedMap, id)) {
        const reason = batchError ? 'provider_error' : 'missing_id';
        checkpoint.failure({ id: item.id, text: source }, providerName, reason, batchError?.message || 'Provider không trả về ID');
        failures.push({ item, source, reason, error: batchError });
        continue;
      }
      const rawVal = translatedMap[id];
      const rawStr = typeof rawVal === 'object' && rawVal !== null
        ? (rawVal.text || rawVal.translated || rawVal.result || JSON.stringify(rawVal))
        : String(rawVal || '');
      const processed = postProcessText(rawStr);
      const validation = validateTranslationCandidate(source, processed, { targetLang, srcLang });
      if (!validation.valid) {
        checkpoint.failure({ id: item.id, text: source }, providerName, validation.reason, validation.reason);
        failures.push({ item, source, reason: validation.reason, error: null });
        continue;
      }
      item.text = validation.text;
      checkpoint.success({ id: item.id, text: source }, validation.text, providerName);
      translatedContext.push({ id: item.id, original: batchMap[id]?.text || batchMap[id], translated: validation.text });
    }
    return translatedContext;
  };

  for (const item of srtArray) {
    const source = sourceById[String(item.id)];
    const cached = checkpoint.get(
      { id: item.id, text: source },
      { targetLang, srcLang }
    );
    if (cached) {
      item.text = cached;
      reused += 1;
    }
  }

  for (let i = 0; i < srtArray.length; i += batchSize) {
    if (isCancelled?.()) {
      throw new Error('Đã hủy kết xuất trong khi dịch phụ đề');
    }
    const batch = srtArray.slice(i, i + batchSize);
    const pending = batch.filter((item) => {
      const entry = checkpoint.checkpoint.entries[String(item.id)];
      return entry?.status !== 'success';
    });
    if (pending.length === 0) {
      console.log(`[Dịch] Dùng lại ${batch.length} câu từ checkpoint.`);
      continue;
    }

    const batchMap = prepareBatchMap(pending);
    if (i > 0 && batchDelayMs > 0) await sleep(batchDelayMs);

    let translatedMap = {};
    let batchError = null;
    try {
      translatedMap = await translateBatchWithRetry(
        batchMap,
        (map) => translateBatch(map, prevContext, globalContext),
        0
      );
      if (!translatedMap || typeof translatedMap !== 'object') {
        throw new Error(`${providerName} không trả về JSON dịch hợp lệ`);
      }
    } catch (error) {
      batchError = error;
    }

    const translatedContext = acceptBatchResult(pending, batchMap, translatedMap, batchError, failedItems);
    checkpoint.save();
    prevContext = translatedContext.slice(-12);
    console.log(
      `[Dịch] Đã xử lý ${Math.min(i + batchSize, srtArray.length)}/${srtArray.length} câu`
      + (failedItems.length ? `, đang có ${failedItems.length} câu cần xử lý lại.` : '.')
    );
  }

  let retryQueue = failedItems.splice(0);
  const retryRounds = Math.max(0, Math.min(5, Number(retryFailedRounds) || 0));
  for (let round = 1; round <= retryRounds && retryQueue.length > 0; round += 1) {
    if (isCancelled?.()) throw new Error('Đã hủy kết xuất trong khi dịch lại cue lỗi');
    const retrySize = round === retryRounds
      ? 1
      : Math.max(1, Math.ceil(batchSize / (2 ** round)));
    const nextFailures = [];
    console.log(`[Dịch] ${providerName} thử lại ${retryQueue.length} cue lỗi, lần ${round}/${retryRounds}, cỡ lô ${retrySize}.`);
    for (let index = 0; index < retryQueue.length; index += retrySize) {
      if (isCancelled?.()) throw new Error('Đã hủy kết xuất trong khi dịch lại cue lỗi');
      if ((round > 1 || index > 0) && batchDelayMs > 0) await sleep(batchDelayMs);
      const retryItems = retryQueue.slice(index, index + retrySize).map((failed) => failed.item);
      const retryMap = prepareBatchMap(retryItems);
      let translatedMap = {};
      let batchError = null;
      try {
        translatedMap = await translateBatchWithRetry(
          retryMap,
          (map) => translateBatch(map, prevContext, globalContext),
          0
        );
        if (!translatedMap || typeof translatedMap !== 'object') {
          throw new Error(`${providerName} không trả về JSON dịch hợp lệ`);
        }
      } catch (error) {
        batchError = error;
      }
      const retryContext = acceptBatchResult(retryItems, retryMap, translatedMap, batchError, nextFailures);
      if (retryContext.length) prevContext = retryContext.slice(-12);
      checkpoint.save();
    }
    retryQueue = nextFailures;
  }
  failedItems.push(...retryQueue);

  return { failedItems, reused };
}

async function fallbackFailedItemsWithNllb(options) {
  const {
    failedItems,
    checkpoint,
    outputPath,
    parser,
    srcLang,
    targetLang,
    nllbTargetLang,
    isCancelled,
    translateNllb = translateWithNllb
  } = options;
  if (failedItems.length === 0) return [];
  if (isCancelled?.()) throw new Error('Đã hủy kết xuất trước khi dịch dự phòng');

  const fallbackInput = `${outputPath}.nllb-fallback-input.srt`;
  const fallbackOutput = `${outputPath}.nllb-fallback-output.srt`;
  const fallbackCues = failedItems.map(({ item, source }) => ({
    ...item,
    text: source
  }));
  fs.writeFileSync(fallbackInput, parser.toSrt(fallbackCues), 'utf8');
  try {
    await translateNllb(
      fallbackInput,
      fallbackOutput,
      srcLang,
      1,
      10000,
      isCancelled,
      nllbTargetLang
    );
    const translated = fs.existsSync(fallbackOutput)
      ? parser.fromSrt(fs.readFileSync(fallbackOutput, 'utf8'))
      : [];
    const remaining = [];
    for (let index = 0; index < failedItems.length; index += 1) {
      const failed = failedItems[index];
      const candidate = postProcessText(translated[index]?.text || '');
      const validation = validateTranslationCandidate(
        failed.source,
        candidate,
        { targetLang, srcLang }
      );
      if (!validation.valid) {
        checkpoint.failure(
          { id: failed.item.id, text: failed.source },
          'nllb-fallback',
          validation.reason,
          validation.reason
        );
        remaining.push({ ...failed, reason: validation.reason });
        continue;
      }
      failed.item.text = validation.text;
      checkpoint.success(
        { id: failed.item.id, text: failed.source },
        validation.text,
        'nllb-fallback'
      );
    }
    checkpoint.save();
    return remaining;
  } catch (error) {
    for (const failed of failedItems) {
      checkpoint.failure(
        { id: failed.item.id, text: failed.source },
        'nllb-fallback',
        'fallback_error',
        error.message
      );
    }
    checkpoint.save();
    return failedItems.map((failed) => ({ ...failed, reason: 'fallback_error', error }));
  } finally {
    for (const filePath of [fallbackInput, fallbackOutput]) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  }
}

function writeTranslatedSubtitleResult(options) {
  const {
    parser,
    srtArray,
    outputPath,
    checkpoint,
    maxLines,
    maxCharsPerLine
  } = options;
  fs.writeFileSync(outputPath, parser.toSrt(srtArray), 'utf8');
  try {
    formatSubtitleFile(outputPath, maxLines, maxCharsPerLine);
  } catch (error) {
    console.error('Lỗi định dạng phụ đề sau dịch AI:', error.message);
  }
  return attachTranslationStats(null, checkpoint.report(srtArray.length));
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

function getSubtitleAnalysisPrompt(srtArray, targetLangName = 'Tiếng Việt') {
  const fullSubtitle = (Array.isArray(srtArray) ? srtArray : []).map((item) => ({
    id: String(item.id || ''),
    startTime: item.startTime || '',
    endTime: item.endTime || '',
    text: String(item.text || '').replace(/[\r\n]+/g, ' ').trim()
  }));
  return `Bạn là chuyên gia biên tập và dịch phụ đề video ngắn.

Hãy đọc TOÀN BỘ file SRT bên dưới trước khi dịch từng lô. Ở bước này KHÔNG dịch từng cue. Chỉ phân tích bối cảnh tổng thể để mọi lô dịch sang ${targetLangName} dùng chung một cách hiểu nhất quán.

Hãy xác định:
1. Tóm tắt nội dung và diễn biến chính.
2. Danh sách nhân vật/thực thể, giới tính nếu có bằng chứng, vai trò và quan hệ.
3. Cách xưng hô phù hợp và nhất quán giữa các nhân vật.
4. Tên riêng, địa danh, tổ chức, vũ khí, thuật ngữ và cách dịch thống nhất.
5. Giọng điệu, thể loại, mức độ trang trọng và các điểm dễ dịch sai.

Chỉ trả về JSON hợp lệ theo cấu trúc:
{
  "summary": "...",
  "characters": [{ "name": "...", "gender": "...", "role": "...", "relationships": "...", "addressing": "..." }],
  "terminology": [{ "source": "...", "target": "...", "note": "..." }],
  "tone": "...",
  "translationRules": ["..."]
}

Không dùng Markdown, không thêm giải thích ngoài JSON và không bịa thông tin khi SRT không đủ bằng chứng.

TOÀN BỘ SRT:
${JSON.stringify(fullSubtitle, null, 2)}`;
}

function normalizeGlobalTranslationContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI không trả về hồ sơ ngữ cảnh SRT hợp lệ');
  }
  const clean = (input, limit = 1000) => limitText(input, limit);
  const characters = (Array.isArray(value.characters) ? value.characters : [])
    .slice(0, 100)
    .map((item) => ({
      name: clean(item?.name, 200),
      gender: clean(item?.gender, 100),
      role: clean(item?.role, 500),
      relationships: clean(item?.relationships, 800),
      addressing: clean(item?.addressing, 500)
    }))
    .filter((item) => item.name || item.role);
  const terminology = (Array.isArray(value.terminology) ? value.terminology : [])
    .slice(0, 200)
    .map((item) => ({
      source: clean(item?.source, 300),
      target: clean(item?.target, 300),
      note: clean(item?.note, 500)
    }))
    .filter((item) => item.source || item.target);
  const translationRules = (Array.isArray(value.translationRules) ? value.translationRules : [])
    .slice(0, 100)
    .map((item) => clean(item, 500))
    .filter(Boolean);
  const normalized = {
    summary: clean(value.summary, 4000),
    characters,
    terminology,
    tone: clean(value.tone, 1500),
    translationRules
  };
  if (!normalized.summary && !characters.length && !terminology.length && !normalized.tone) {
    throw new Error('Hồ sơ ngữ cảnh SRT do AI trả về bị rỗng');
  }
  return normalized;
}

async function resolveGlobalTranslationContext(options) {
  const { checkpoint, analysisKey, srtArray, targetLangName, analyze, isCancelled } = options;
  const cached = checkpoint.getGlobalContext(analysisKey);
  if (cached) {
    console.log('[Dịch] Dùng lại phân tích toàn bộ SRT từ checkpoint.');
    return cached;
  }
  if (isCancelled?.()) throw new Error('Đã hủy kết xuất trước khi phân tích toàn bộ SRT');
  const prompt = getSubtitleAnalysisPrompt(srtArray, targetLangName);
  const rawContext = await analyze(prompt);
  if (isCancelled?.()) throw new Error('Đã hủy kết xuất trong khi phân tích toàn bộ SRT');
  const globalContext = normalizeGlobalTranslationContext(rawContext);
  checkpoint.saveGlobalContext(analysisKey, globalContext);
  console.log(`[Dịch] Đã phân tích toàn bộ ${srtArray.length} cue trước khi chia lô.`);
  return globalContext;
}

function getTranslationPrompt(map, targetLangName = 'Tiếng Việt', prevContext = [], globalContext = null) {
  const vietnameseProperNameRule = targetLangName === 'Tiếng Việt'
    ? `   - Với nguồn tiếng Trung dịch sang tiếng Việt: tên người, địa danh, môn phái hoặc tổ chức có cách đọc Hán-Việt quen dùng phải chuyển sang tên Hán-Việt, KHÔNG dịch nghĩa và KHÔNG để nguyên chữ Hán. Ví dụ: 王明 → Vương Minh; 北京 → Bắc Kinh; 曹操 → Tào Tháo; 少林寺 → Thiếu Lâm Tự.
   - Phân biệt rõ TÊN RIÊNG với TỪ THƯỜNG: tên riêng được chuyển tên; từ thường và hư từ phải dịch theo nghĩa tiếng Việt tự nhiên, tuyệt đối không phiên âm Hán-Việt máy móc cả câu.\n`
    : '';
  return `Bạn là một chuyên gia dịch thuật phụ đề video ngắn chuyên nghiệp cho TikTok, Facebook Reels và YouTube Shorts.

Tôi sẽ cung cấp một danh sách các khối phụ đề dưới dạng JSON. Mỗi khối phụ đề có chứa văn bản gốc ("text") và thời lượng hiển thị tính bằng giây ("durationSec").

Nhiệm vụ của bạn là dịch nội dung phụ đề sang ${targetLangName} tự nhiên, chính xác, ngắn gọn và đúng ngữ cảnh.

YÊU CẦU BẮT BUỘC:

1. Trước khi dịch, hãy đọc toàn bộ danh sách phụ đề để hiểu đầy đủ bối cảnh, mạch câu chuyện, quan hệ giữa nhân vật, sắc thái cảm xúc và văn phong của video.

2. Dịch từng khối phụ đề theo đúng thứ tự ban đầu, nhưng không được dịch word-by-word từng khối một cách rời rạc.

3. Vì phụ đề có thể bị ngắt giữa câu, hãy dịch sao cho khi ghép các khối liên tiếp lại, nội dung tiếng Việt trở thành câu hoàn chỉnh, mượt mà, tự nhiên, đúng ngữ pháp và đúng ngữ cảnh.

4. GIỚI HẠN ĐỘ DÀI THEO THỜI LƯỢNG (RẤT QUAN TRỌNG):
   - Mỗi khối có trường "durationSec" (giây hiển thị). Tốc độ đọc tiếng Việt tự nhiên chuẩn là khoảng 18 ký tự / giây.
   - Bản dịch Tiếng Việt của mỗi khối KHÔNG ĐƯỢC VƯỢT QUÁ (durationSec × 18) ký tự.
     * Ví dụ: Khối có durationSec = 2.5 giây -> bản dịch tối đa 45 ký tự.
     * Ví dụ: Khối có durationSec = 1.5 giây -> bản dịch tối đa 27 ký tự.
   - Ưu tiên diễn đạt ngắn gọn, tự nhiên, diễn đạt trôi chảy đúng ngữ pháp tiếng Việt, lược bỏ các từ đệm rườm rà nhưng giữ nguyên ý chính.

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

7. XỬ LÝ TÊN RIÊNG VÀ DỮ LIỆU ĐẶC BIỆT:
${vietnameseProperNameRule}   - Tên người/địa danh không có cách gọi chuẩn trong ngôn ngữ đích phải được chuyển tự tự nhiên và giữ nhất quán, không dịch thành nghĩa của tên.
   - Giữ nguyên tên thương hiệu quốc tế, số liệu, đơn vị đo, mã sản phẩm, hashtag, username và URL khi phù hợp.
   - Giữ ký hiệu đặc biệt hoặc định dạng quan trọng trong nội dung gốc, trừ khi việc điều chỉnh là cần thiết để câu tiếng Việt tự nhiên hơn.

8. CẤU TRÚC JSON ĐẦU RA MẪU (FEW-SHOT EXAMPLE):
   - DỮ LIỆU ĐẦU VÀO MẪU (INPUT):
     {
       "1": { "text": "At that critical moment, he immediately ran over to save her.", "durationSec": 2.5 }
     }
   - KẾT QUẢ MẪU YÊU CẦU TRẢ VỀ (OUTPUT):
     {
       "1": "Lúc nguy cấp, anh lập tức chạy tới cứu cô."
     }
   - Tuyệt đối không thêm, xóa hoặc đổi tên bất kỳ ID JSON nào. Kết quả đầu ra chỉ chứa ID làm key và chuỗi bản dịch Tiếng Việt tương ứng làm value.

9. Bổ sung dấu câu chuẩn ở cuối câu:
   - Cuối các khối phụ đề hoàn chỉnh ý, bắt buộc phải có dấu chấm (.), dấu hỏi (?) hoặc dấu cảm (!).
   - Việc bổ sung dấu câu chuẩn giúp bộ đọc thoại OmniVoice nhận diện ngắt nhóm câu tự nhiên, tránh bị dồn nhiều câu thành nhóm quá dài.

10. Kết quả trả về phải là JSON hợp lệ tuyệt đối:
   - Chỉ trả về JSON.
   - Không dùng Markdown.
   - Không bọc trong \`\`\`json.
   - Không thêm giải thích, ghi chú, nhận xét hoặc bất kỳ văn bản nào ngoài JSON.

11. Khối nội dung phi lời thoại:
   - Nếu nội dung khối là ký hiệu phi lời thoại, âm hiệu hoặc caption rác (ví dụ: [nhạc], [cười], [applause]), hãy giữ nguyên text gốc, không dịch.

NGỮ CẢNH TRƯỚC ĐÓ (đã dịch, CHỈ làm tham chiếu để giữ nhất quán nhân xưng/thuật ngữ/mạch câu xuyên lô — KHÔNG đưa vào kết quả, KHÔNG dịch lại):
${prevContext && prevContext.length ? JSON.stringify(prevContext, null, 2) : '(không có — đây là lô đầu)'}

PHÂN TÍCH TOÀN BỘ SRT (dùng cho TẤT CẢ các lô để giữ nhất quán cốt truyện, nhân vật, xưng hô và thuật ngữ; KHÔNG đưa phần này vào kết quả):
${globalContext ? JSON.stringify(globalContext, null, 2) : '(không có)'}

Dữ liệu đầu vào (các khối CẦN dịch sang ${targetLangName}):

${JSON.stringify(map, null, 2)}`;
}

async function requestOpenAICompatibleJson(prompt, apiKey, model, baseUrl, providerName) {
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

async function translateWithOpenAICompatible(map, apiKey, model, baseUrl, providerName, targetLangName = 'Tiếng Việt', prevContext = [], globalContext = null) {
  const prompt = getTranslationPrompt(map, targetLangName, prevContext, globalContext);
  return requestOpenAICompatibleJson(prompt, apiKey, model, baseUrl, providerName);
}

async function requestGeminiJson(prompt, apiKey, modelNameInput) {

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

async function translateWithGemini(map, apiKey, modelNameInput, targetLangName = 'Tiếng Việt', prevContext = [], globalContext = null) {
  const prompt = getTranslationPrompt(map, targetLangName, prevContext, globalContext);
  return requestGeminiJson(prompt, apiKey, modelNameInput);
}

async function translateWithOpenRouter(map, apiKey, model, targetLangName = 'Tiếng Việt', prevContext = [], globalContext = null) {
  const selectedModel = model || 'openrouter/owl-alpha';
  return translateWithOpenAICompatible(map, apiKey, selectedModel, 'https://openrouter.ai/api/v1/chat/completions', 'OpenRouter', targetLangName, prevContext, globalContext);
}

async function translateWithOpenAI(map, apiKey, model, targetLangName = 'Tiếng Việt', prevContext = [], globalContext = null) {
  const selectedModel = model || 'gpt-4o-mini';
  return translateWithOpenAICompatible(map, apiKey, selectedModel, 'https://api.openai.com/v1/chat/completions', 'ChatGPT (OpenAI)', targetLangName, prevContext, globalContext);
}

async function translateWithNineRouter(map, apiKey, model, baseUrl, targetLangName = 'Tiếng Việt', prevContext = [], globalContext = null) {
  const selectedModel = model || '';
  const endpoint = `${baseUrl || 'http://localhost:20128/v1'}/chat/completions`;
  return translateWithOpenAICompatible(map, apiKey, selectedModel, endpoint, '9Router', targetLangName, prevContext, globalContext);
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

async function requestOpenCodeJson(prompt, model = 'DeepSeek V4 Flash (Free)') {
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

async function translateWithOpenCode(map, model = 'DeepSeek V4 Flash (Free)', targetLangName = 'Tiếng Việt', prevContext = [], globalContext = null) {
  const prompt = getTranslationPrompt(map, targetLangName, prevContext, globalContext);
  return requestOpenCodeJson(prompt, model);
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

async function translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, targetNllbLang = 'vie_Latn') {
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
    throw new Error('Đã hủy kết xuất trong khi NLLB đang dịch');
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

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('NLLB đã kết thúc nhưng không tạo được file phụ đề đầu ra.');
  }

  const parser = new Parser();
  const translatedItems = parser.fromSrt(fs.readFileSync(outputPath, 'utf8'));
  if (translatedItems.length === 0) {
    throw new Error('NLLB đã tạo file đầu ra nhưng không có câu phụ đề hợp lệ.');
  }
  translatedItems.forEach((item) => {
    item.text = postProcessText(item.text);
  });
  fs.writeFileSync(outputPath, parser.toSrt(translatedItems), 'utf8');
  
  // Định dạng lại phụ đề
  try {
    formatSubtitleFile(outputPath, maxLines, maxCharsPerLine);
  } catch (err) {
    console.error('Lỗi định dạng phụ đề sau dịch NLLB:', err.message);
  }
  return null;
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
  let openaiApiKeyVal = '';
  let openaiModelVal = 'gpt-4o-mini';
  let srcLang = 'auto';
  let targetLang = 'vi';
  let translationStyles = [];
  let onTranslationBatch = null;

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
    openaiApiKeyVal = geminiApiKey.openaiApiKey || '';
    openaiModelVal = geminiApiKey.openaiModel || 'gpt-4o-mini';
    srcLang = geminiApiKey.srcLang || 'auto';
    targetLang = geminiApiKey.targetLang || 'vi';
    translationStyles = parseTranslationStyles(geminiApiKey.translationStyles);
    onTranslationBatch = typeof geminiApiKey.onTranslationBatch === 'function'
      ? geminiApiKey.onTranslationBatch
      : null;
  } else if (typeof geminiApiKey === 'string' && geminiApiKey.trim() !== '') {
    aiProvider = 'gemini';
    geminiApiKeyVal = geminiApiKey;
  }

  const langInfo = LANG_MAP[targetLang] || LANG_MAP.vi;
  const targetLangName = langInfo.name;
  const nllbTargetLang = langInfo.nllb;

  srcLang = detectSourceLanguage(content, srcLang);
  console.log(`[Auto-Detect] Ngôn ngữ nguồn phụ đề: ${srcLang}`);
  const geminiWebMode = sourceMatchesTarget(srcLang, targetLang) ? 'spellcheck' : 'translate';
  const translationStyleRule = buildTranslationStyleRule(translationStyles);

  let parser = new Parser();
  let srtArray = parser.fromSrt(content);

  // Loại bỏ các mục phụ đề trùng lặp trước khi gộp câu
  srtArray = deduplicateSubtitles(srtArray);
  console.log(`[Dịch phụ đề] Số khối sub sau khi loại trùng: ${srtArray.length}`);
  const sourceById = Object.fromEntries(
    srtArray.map((item) => [String(item.id), item.text])
  );
  const translationCheckpoint = createTranslationCheckpoint(outputPath, {
    sourceText: content,
    targetLang,
    pipeline: aiProvider === 'gemini-web'
      ? `gemini-web-v4:cue-lock:${geminiWebMode}:${translationStyles.join('+') || 'auto'}`
      : 'shared-json-v3'
  });

  // 3. Dịch bằng AI Local NLLB-200
  if (aiProvider === 'nllb') {
    const quality = await translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, nllbTargetLang);
    const nllbReport = attachTranslationStats(quality, {
      total: srtArray.length,
      translated: srtArray.length,
      failed: 0,
      fallbackUsed: 0,
      unchangedFromSource: 0,
      sourceLanguageRemaining: 0,
      failedCueIds: []
    });
    return { outputPath, report: nllbReport };
  }
  // 3.5. Gemini Web dùng pipeline dòng đánh số + timestamp + trần từ động,
  // ghi SRT lũy tiến và chỉ retry cue sót bằng chính Gemini Web.
  if (aiProvider === 'gemini-web') {
    const providerName = 'Gemini Web';
    console.log('Đang dịch bằng pipeline Gemini Web...');
    try {
      const primary = await translateViaGeminiWeb(srtArray, {
        sourceById,
        checkpoint: translationCheckpoint,
        outputPath,
        srtArray,
        srcLang,
        targetLang,
        targetLangName,
        isCancelled,
        fit: geminiWebMode !== 'spellcheck',
        mode: geminiWebMode,
        styleRule: translationStyleRule,
        onBatchTranslated: onTranslationBatch
      });
      const report = writeTranslatedSubtitleResult({
        parser,
        srtArray,
        outputPath,
        checkpoint: translationCheckpoint,
        maxLines,
        maxCharsPerLine
      });
      if (primary.failedItems.length > 0) {
        report.translation.mode = primary.mode;
        report.translation.blanked = primary.blanked;
        if (primary.mode === 'spellcheck') {
          console.warn(`⚠ Gemini Web không sửa được ${primary.failedItems.length} cue; giữ nguyên lời nhận dạng và tiếp tục render.`);
        } else {
          console.warn(`⚠ Gemini Web không dịch được ${primary.failedItems.length} cue sau mọi lần retry; để trống các cue đó và tiếp tục render.`);
        }
      }
      console.log(`Đã hoàn tất ${primary.mode === 'spellcheck' ? 'sửa chính tả' : 'dịch'} bằng ${providerName} và lưu tại: ${outputPath}`);
      return { outputPath, report };
    } catch (err) {
      console.error(`⚠ Dịch Gemini Web chưa hoàn tất (${err.message}). Giữ checkpoint để tiếp tục, không chuyển sang NLLB.`);
      throw err;
    } finally {
      if (process.env.VC_GEMINI_KEEP_HOT !== '1') {
        console.log('[Gemini Web] Đóng phiên Chromium sau video để giải phóng RAM. Đặt VC_GEMINI_KEEP_HOT=1 để giữ nóng.');
        await closeGeminiWebSession();
      }
    }
  }

  // 4. Dịch bằng OpenCode Zen Cloud API (DeepSeek V4 Flash...) sử dụng cấu trúc JSON tối ưu
  if (aiProvider === 'opencode') {
    const selectedOpencodeModel = opencodeModelVal || 'DeepSeek V4 Flash (Free)';
    const providerName = `OpenCode SDK (${selectedOpencodeModel})`;
    console.log(`Đang gọi ${providerName} để dịch phụ đề theo từng lô JSON...`);
    try {
      const analysisKey = createCheckpointSignature({
        version: 1,
        provider: 'opencode',
        model: selectedOpencodeModel,
        targetLang
      });
      const globalContext = await resolveGlobalTranslationContext({
        checkpoint: translationCheckpoint,
        analysisKey,
        srtArray,
        targetLangName,
        isCancelled,
        analyze: (prompt) => requestOpenCodeJson(prompt, selectedOpencodeModel)
      });
      const primary = await translateJsonBatchesWithCheckpoint({
        srtArray,
        sourceById,
        checkpoint: translationCheckpoint,
        providerName,
        targetLang,
        srcLang,
        isCancelled,
        batchSize: Math.min(80, srtArray.length),
        globalContext,
        translateBatch: (map, prevContext, sharedContext) => translateWithOpenCode(
          map,
          selectedOpencodeModel,
          targetLangName,
          prevContext,
          sharedContext
        )
      });
      const remaining = isGemini ? primary.failedItems : await fallbackFailedItemsWithNllb({
        failedItems: primary.failedItems,
        checkpoint: translationCheckpoint,
        outputPath,
        parser,
        srcLang,
        targetLang,
        nllbTargetLang,
        isCancelled
      });
      const report = writeTranslatedSubtitleResult({
        parser,
        srtArray,
        outputPath,
        checkpoint: translationCheckpoint,
        maxLines,
        maxCharsPerLine
      });
      if (remaining.length > 0) {
        const error = createTranslationIncompleteError(report.translation);
        error.translationReport = report;
        throw error;
      }
      console.log(`Đã dịch thành công bằng ${providerName} và lưu tại: ${outputPath}`);
      return { outputPath, report };
    } catch (err) {
      if (err.code === 'TRANSLATION_INCOMPLETE' || /hủy|cancel/i.test(err.message)) throw err;
      if (isGemini) {
        console.error(`${providerName} chưa hoàn tất (${err.message}). Giữ checkpoint để tiếp tục, không chuyển sang NLLB.`);
        throw err;
      }
      console.error(`${providerName} dịch thất bại (${err.message}). Đang lùi về dùng NLLB Local...`);
      const quality = await translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, nllbTargetLang);
      const report = attachTranslationStats(quality, {
        total: srtArray.length,
        translated: srtArray.length,
        failed: 0,
        fallbackUsed: srtArray.length,
        unchangedFromSource: 0,
        sourceLanguageRemaining: 0,
        failedCueIds: []
      });
      return { outputPath, report };
    }
  }

  // 1 & 2 & 9 & OpenAI. Dịch bằng Gemini, OpenRouter, OpenAI hoặc 9Router sử dụng cấu trúc JSON tối ưu
  if ((aiProvider === 'gemini' && geminiApiKeyVal && geminiApiKeyVal.trim() !== '') ||
      (aiProvider === 'openrouter' && openRouterApiKeyVal && openRouterApiKeyVal.trim() !== '') ||
      ((aiProvider === 'openai' || aiProvider === 'chatgpt') && openaiApiKeyVal && openaiApiKeyVal.trim() !== '') ||
      (aiProvider === 'ninerouter' || aiProvider === '9router')) {

    
    const isGemini = aiProvider === 'gemini';
    const isOpenRouter = aiProvider === 'openrouter';
    const isOpenAI = aiProvider === 'openai' || aiProvider === 'chatgpt';
    const apiKey = isGemini ? geminiApiKeyVal.trim() : (isOpenRouter ? openRouterApiKeyVal.trim() : (isOpenAI ? openaiApiKeyVal.trim() : ninerouterApiKeyVal.trim()));
    const providerName = isGemini ? 'Gemini AI' : (isOpenRouter ? `OpenRouter AI (${openRouterModelVal})` : (isOpenAI ? `ChatGPT OpenAI (${openaiModelVal})` : `9Router Local AI Proxy (${ninerouterModelVal})`));
    
    console.log(`Đang gọi ${providerName} để dịch phụ đề theo từng lô JSON...`);
    try {
      const analysisModel = isGemini
        ? (geminiModelVal || 'auto')
        : (isOpenRouter ? openRouterModelVal : (isOpenAI ? openaiModelVal : ninerouterModelVal));
      const analysisKey = createCheckpointSignature({
        version: 1,
        provider: aiProvider,
        model: analysisModel,
        targetLang
      });
      const globalContext = await resolveGlobalTranslationContext({
        checkpoint: translationCheckpoint,
        analysisKey,
        srtArray,
        targetLangName,
        isCancelled,
        analyze: (prompt) => {
          if (isOpenAI) {
            return requestOpenAICompatibleJson(
              prompt,
              apiKey,
              openaiModelVal || 'gpt-4o-mini',
              'https://api.openai.com/v1/chat/completions',
              'ChatGPT (OpenAI)'
            );
          }
          if (isGemini) return requestGeminiJson(prompt, apiKey, geminiModelVal);
          if (isOpenRouter) {
            return requestOpenAICompatibleJson(
              prompt,
              apiKey,
              openRouterModelVal || 'openrouter/owl-alpha',
              'https://openrouter.ai/api/v1/chat/completions',
              'OpenRouter'
            );
          }
          const endpoint = `${ninerouterBaseUrlVal || 'http://localhost:20128/v1'}/chat/completions`;
          return requestOpenAICompatibleJson(
            prompt,
            ninerouterApiKeyVal,
            ninerouterModelVal || '',
            endpoint,
            '9Router'
          );
        }
      });
      const primary = await translateJsonBatchesWithCheckpoint({
        srtArray,
        sourceById,
        checkpoint: translationCheckpoint,
        providerName,
        targetLang,
        srcLang,
        isCancelled,
        batchSize: Math.min(80, srtArray.length),
        globalContext,
        translateBatch: (map, prevContext, sharedContext) => {
          if (isOpenAI) {
            return translateWithOpenAI(
              map, apiKey, openaiModelVal, targetLangName, prevContext, sharedContext
            );
          }
          if (isGemini) {
            return translateWithGemini(
              map, apiKey, geminiModelVal, targetLangName, prevContext, sharedContext
            );
          }
          if (isOpenRouter) {
            return translateWithOpenRouter(
              map, apiKey, openRouterModelVal, targetLangName, prevContext, sharedContext
            );
          }
          return translateWithNineRouter(
            map,
            ninerouterApiKeyVal,
            ninerouterModelVal,
            ninerouterBaseUrlVal,
            targetLangName,
            prevContext,
            sharedContext
          );
        }
      });
      const remaining = await fallbackFailedItemsWithNllb({
        failedItems: primary.failedItems,
        checkpoint: translationCheckpoint,
        outputPath,
        parser,
        srcLang,
        targetLang,
        nllbTargetLang,
        isCancelled
      });
      const report = writeTranslatedSubtitleResult({
        parser,
        srtArray,
        outputPath,
        checkpoint: translationCheckpoint,
        maxLines,
        maxCharsPerLine
      });
      if (remaining.length > 0) {
        const error = createTranslationIncompleteError(report.translation);
        error.translationReport = report;
        throw error;
      }
      console.log(`Đã dịch thành công bằng ${providerName} và lưu tại: ${outputPath}`);
      return { outputPath, report };
    } catch (err) {
      if (err.code === 'TRANSLATION_INCOMPLETE' || /hủy|cancel/i.test(err.message)) throw err;
      console.error(`${providerName} dịch thất bại (${err.message}). Đang lùi về dùng NLLB Local...`);
      const quality = await translateWithNllb(inputPath, outputPath, srcLang, maxLines, maxCharsPerLine, isCancelled, nllbTargetLang);
      const report = attachTranslationStats(quality, {
        total: srtArray.length,
        translated: srtArray.length,
        failed: 0,
        fallbackUsed: srtArray.length,
        unchangedFromSource: 0,
        sourceLanguageRemaining: 0,
        failedCueIds: []
      });
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
  const googleFailedItems = [];
  for (const item of srtArray) {
    const source = sourceById[String(item.id)];
    const cached = translationCheckpoint.get(
      { id: item.id, text: source },
      { targetLang, srcLang }
    );
    if (cached) item.text = cached;
  }
  const googlePending = srtArray.filter((item) => (
    translationCheckpoint.checkpoint.entries[String(item.id)]?.status !== 'success'
  ));

  for (let i = 0; i < googlePending.length; i += batchSize) {
    if (isCancelled && isCancelled()) {
      throw new Error('Đã hủy kết xuất trong khi dịch phụ đề');
    }

    const batch = googlePending.slice(i, i + batchSize);
    
    // Khi Google bị chặn cứng, chuyển phần còn lại sang NLLB thay vì mất checkpoint.
    if (consecutiveFailures >= 3) {
      for (const item of googlePending.slice(i)) {
        const source = sourceById[String(item.id)];
        translationCheckpoint.failure(
          { id: item.id, text: source },
          'google-translate',
          'rate_limited',
          'Google Translate bị chặn liên tiếp'
        );
        googleFailedItems.push({
          item,
          source,
          reason: 'rate_limited',
          error: null
        });
      }
      translationCheckpoint.save();
      break;
    }

    // Áp dụng tiền xử lý từ điển trước khi dịch
    const textToTranslate = batch.map(item => {
      const clean = preProcessText(sourceById[String(item.id)]);
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
          const processed = postProcessText(translatedParts[j]);
          const source = sourceById[String(batch[j].id)];
          const validation = validateTranslationCandidate(source, processed, { targetLang, srcLang });
          if (!validation.valid) {
            translationCheckpoint.failure(
              { id: batch[j].id, text: source },
              'google-translate',
              validation.reason,
              validation.reason
            );
            googleFailedItems.push({
              item: batch[j],
              source,
              reason: validation.reason,
              error: null
            });
          } else {
            batch[j].text = wrapOrClean(validation.text);
            translationCheckpoint.success(
              { id: batch[j].id, text: source },
              batch[j].text,
              'google-translate'
            );
          }
        }
      } else {
        console.warn(`Số phần dịch không khớp (${translatedParts.length} vs ${batch.length}). Đang tự động chuyển sang dịch dòng đơn...`);
        for (const item of batch) {
          if (isCancelled && isCancelled()) {
            throw new Error('Đã hủy kết xuất trong khi dịch từng câu phụ đề');
          }
          try {
            const source = sourceById[String(item.id)];
            const cleanText = preProcessText(source);
            const { text } = await translateWithRetry(cleanText, { to: targetLang });
            const processed = postProcessText(text.normalize('NFC'));
            const validation = validateTranslationCandidate(source, processed, { targetLang, srcLang });
            if (!validation.valid) throw new Error(validation.reason);
            item.text = wrapOrClean(validation.text);
            translationCheckpoint.success(
              { id: item.id, text: source },
              item.text,
              'google-translate'
            );
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
          if (isCancelled && isCancelled()) {
            throw new Error('Đã hủy kết xuất trong khi chờ dịch lại phụ đề');
          }
          const { text } = await translate(textToTranslate, { to: targetLang });
          consecutiveFailures = 0; // Reset lỗi
          const normalizedText = text.normalize('NFC');
          const translatedParts = normalizedText.split(/\|\|\||\| \| \|/i).map(s => s.trim());
          if (translatedParts.length === batch.length) {
            for (let j = 0; j < batch.length; j++) {
              const processed = postProcessText(translatedParts[j]);
              const source = sourceById[String(batch[j].id)];
              const validation = validateTranslationCandidate(source, processed, { targetLang, srcLang });
              if (!validation.valid) throw new Error(validation.reason);
              batch[j].text = wrapOrClean(validation.text);
              translationCheckpoint.success(
                { id: batch[j].id, text: source },
                batch[j].text,
                'google-translate'
              );
            }
            console.log(`Đã phục hồi dịch thành công sau cool-down cho lô từ ${i} đến ${i + batch.length}.`);
            translationCheckpoint.save();
            continue;
          }
        } catch (retryErr) {
          console.error('Dịch lại lô thất bại sau cool-down:', retryErr.message);
          err = new Error(`Dịch thuật bằng Google Translate thất bại sau cool-down: ${retryErr.message}`);
        }
      }

      for (const item of batch) {
        const source = sourceById[String(item.id)];
        if (translationCheckpoint.checkpoint.entries[String(item.id)]?.status === 'success') {
          continue;
        }
        translationCheckpoint.failure(
          { id: item.id, text: source },
          'google-translate',
          'provider_error',
          err.message
        );
        googleFailedItems.push({ item, source, reason: 'provider_error', error: err });
      }
      translationCheckpoint.save();
      continue;
    }

    translationCheckpoint.save();
    console.log(`Đã dịch ${Math.min(i + batchSize, googlePending.length)}/${googlePending.length} câu chưa có checkpoint.`);
  }

  const googleRemaining = await fallbackFailedItemsWithNllb({
    failedItems: googleFailedItems,
    checkpoint: translationCheckpoint,
    outputPath,
    parser,
    srcLang,
    targetLang,
    nllbTargetLang,
    isCancelled
  });
  const report = writeTranslatedSubtitleResult({
    parser,
    srtArray,
    outputPath,
    checkpoint: translationCheckpoint,
    maxLines,
    maxCharsPerLine
  });
  if (googleRemaining.length > 0) {
    const error = createTranslationIncompleteError(report.translation);
    error.translationReport = report;
    throw error;
  }

  console.log(`Đã dịch và lưu phụ đề tiếng Việt tại: ${outputPath}`);
  return { outputPath, report };
}

module.exports = {
  buildTranslationStyleRule,
  createTranslationCheckpoint,
  createTranslationIncompleteError,
  detectSourceLanguage,
  fallbackFailedItemsWithNllb,
  formatSubtitleFile,
  getSubtitleAnalysisPrompt,
  getTranslationPrompt,
  msToSrtTime,
  normalizeGlobalTranslationContext,
  resolveGlobalTranslationContext,
  sourceMatchesTarget,
  srtTimeToMs,
  translateSubtitles,
  translateJsonBatchesWithCheckpoint,
  translateWithOpenAI,
  validateTranslationCandidate,
  validateTranslationMap
};
