'use strict';

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const ROMAN = Object.freeze({ I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 });

function readThreeDigits(value, full = false) {
  const number = Math.max(0, Math.min(999, Math.floor(Number(value) || 0)));
  const hundreds = Math.floor(number / 100);
  const remainder = number % 100;
  const tens = Math.floor(remainder / 10);
  const units = remainder % 10;
  const parts = [];
  if (hundreds > 0 || full) parts.push(`${DIGITS[hundreds]} trăm`);
  if (tens === 0) {
    if (units > 0) parts.push((hundreds > 0 || full) ? `lẻ ${DIGITS[units]}` : DIGITS[units]);
  } else if (tens === 1) {
    parts.push(units === 0 ? 'mười' : (units === 5 ? 'mười lăm' : `mười ${DIGITS[units]}`));
  } else {
    let text = `${DIGITS[tens]} mươi`;
    if (units === 1) text += ' mốt';
    else if (units === 4) text += ' tư';
    else if (units === 5) text += ' lăm';
    else if (units > 0) text += ` ${DIGITS[units]}`;
    parts.push(text);
  }
  return parts.join(' ').trim();
}

function readVietnameseInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return String(value);
  if (parsed === 0) return DIGITS[0];
  let number = Math.abs(parsed);
  const groups = [];
  while (number > 0) {
    groups.push(number % 1000);
    number = Math.floor(number / 1000);
  }
  const output = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    let scale = '';
    if (index === 1) scale = ' nghìn';
    else if (index === 2) scale = ' triệu';
    else if (index >= 3) {
      const prefix = ['', ' nghìn', ' triệu'][index % 3];
      scale = `${prefix}${' tỷ'.repeat(Math.floor(index / 3))}`;
    }
    output.push(`${readThreeDigits(group, index !== groups.length - 1)}${scale}`);
  }
  return `${parsed < 0 ? 'âm ' : ''}${output.join(' ')}`.trim();
}

function readDigits(value) {
  return String(value).replace(/\D/g, '').split('').map(char => DIGITS[Number(char)]).join(' ');
}

function romanToInteger(value) {
  const roman = String(value || '').toUpperCase();
  if (!/^(?=.{2,}$)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(roman)) return null;
  let total = 0;
  let previous = 0;
  for (const char of [...roman].reverse()) {
    const current = ROMAN[char];
    total += current < previous ? -current : current;
    previous = Math.max(previous, current);
  }
  return total > 0 ? total : null;
}

function normalizeVietnameseTtsText(value) {
  const original = String(value || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  // Keep the same fast path as the reference pipeline: number normalization is
  // skipped completely for the common case where a cue has no decimal digit.
  if (!original || !/\d/.test(original)) return original;
  let text = ` ${original} `;
  text = text.replace(/\d{1,3}(?:\.\d{3})+/g, match => match.replace(/\./g, ''));
  text = text.replace(/\b(?:ngày\s+)?(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/gi,
    (_, day, month, year) => `ngày ${readVietnameseInteger(day)} tháng ${readVietnameseInteger(month)} năm ${readVietnameseInteger(year)}`);
  text = text.replace(/\b(\d{1,2})[/-](\d{4})\b/g,
    (_, month, year) => `tháng ${readVietnameseInteger(month)} năm ${readVietnameseInteger(year)}`);
  text = text.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g,
    (_, hour, minute, second) => `${readVietnameseInteger(hour)} giờ ${readVietnameseInteger(minute)} phút${second ? ` ${readVietnameseInteger(second)} giây` : ''}`);
  text = text.replace(/\b(\d{1,2})h(\d{2})\b/gi,
    (_, hour, minute) => `${readVietnameseInteger(hour)} giờ ${readVietnameseInteger(minute)} phút`);
  text = text.replace(/(?<![\p{L}\p{N}_])([IVXLCDM]{2,})(?![\p{L}\p{N}_])/gu, match => {
    const number = romanToInteger(match);
    return number ? readVietnameseInteger(number) : match;
  });
  text = text.replace(/\$\s*(\d+)/g, (_, number) => `${readVietnameseInteger(number)} đô la`);
  text = text.replace(/€\s*(\d+)/g, (_, number) => `${readVietnameseInteger(number)} ơ-rô`);
  text = text.replace(/(\d+)\s*(?:đồng|VND|VNĐ|vnđ|đ)(?=\s|[.,!?;:]|$)/gi,
    (_, number) => `${readVietnameseInteger(number)} đồng`);
  text = text.replace(/(\d+)\s*[-–—]\s*(\d+)\s*%/g,
    (_, left, right) => `${readVietnameseInteger(left)} đến ${readVietnameseInteger(right)} phần trăm`);
  text = text.replace(/(\d+)\s*%/g, (_, number) => `${readVietnameseInteger(number)} phần trăm`);
  text = text.replace(/(\d+),(\d+)/g, (_, integer, fraction) => `${readVietnameseInteger(integer)} phẩy ${readDigits(fraction)}`);
  text = text.replace(/(\d+)\s*[-–—]\s*(\d+)/g,
    (_, left, right) => `${readVietnameseInteger(left)} đến ${readVietnameseInteger(right)}`);
  text = text.replace(/\b0\d{9,10}\b/g, match => readDigits(match));
  text = text.replace(/(?<![\d\p{L}_])-\s*(\d+)/gu, (_, number) => `âm ${readVietnameseInteger(number)}`);
  text = text.replace(/\d+/g, match => readVietnameseInteger(match));
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeTtsText(value, options = {}) {
  const text = String(value || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  const language = String(options.language || 'vi').toLowerCase().split('-')[0];
  return language === 'vi' ? normalizeVietnameseTtsText(text) : text;
}

function hanCharacterRatio(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const visible = [...text].filter(char => !/\s/u.test(char));
  if (!visible.length) return 0;
  const han = visible.filter(char => /[\u3400-\u4DBF\u4E00-\u9FFF]/u.test(char)).length;
  return han / visible.length;
}

/**
 * Prepares Vietnamese text specifically for Piper.
 *
 * Number/date/money normalization stays in JavaScript so checkpoint keys and
 * early-TTS reuse remain deterministic. English-to-Vietnamese transliteration
 * is completed by the persistent Python Piper bridge using vietnormalizer,
 * matching the reference pipeline without applying that transformation to
 * Edge TTS or OmniVoice.
 */
function normalizePiperTtsText(value, options = {}) {
  const language = String(options.language || 'vi').toLowerCase().split(/[-_]/)[0];
  const text = String(value || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (language !== 'vi') return text;
  const hanThreshold = Number.isFinite(Number(options.hanThreshold))
    ? Math.max(0, Number(options.hanThreshold))
    : 0.35;
  if (hanThreshold > 0 && hanCharacterRatio(text) >= hanThreshold) return '';
  return normalizeVietnameseTtsText(text);
}

module.exports = {
  hanCharacterRatio,
  normalizePiperTtsText,
  normalizeTtsText,
  normalizeVietnameseTtsText,
  readVietnameseInteger,
  romanToInteger
};
