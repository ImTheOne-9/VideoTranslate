'use strict';

const SAMPLE_FONT_SIZE = 100;
const MAX_CACHE_ENTRIES = 12000;
const widthCache = new Map();

function normalizeMeasurementText(text) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeMeasurementText(text) {
  const clean = normalizeMeasurementText(text);
  if (!clean) return [];
  if (/\s/u.test(clean)) {
    return clean.split(/(\s+)/u).filter(Boolean).map(token => (/^\s+$/u.test(token) ? ' ' : token));
  }
  return Array.from(clean);
}

function escapePangoMarkup(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function heuristicWidth(text, fontSize) {
  let units = 0;
  for (const char of Array.from(String(text || ''))) {
    if (/\s/u.test(char)) units += 0.33;
    else if (/[\u1100-\u11ff\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0e7f\u0e80-\u0eff\u1000-\u109f\u1780-\u17ff]/u.test(char)) units += 1;
    else if (/[MW@#%&]/u.test(char)) units += 0.85;
    else if (/[A-Z0-9]/u.test(char)) units += 0.64;
    else if (/[.,:;!'`|ilI]/u.test(char)) units += 0.3;
    else units += 0.54;
  }
  return units * Math.max(1, Number(fontSize) || 1);
}

function makeFontDescription(fontName, bold, size = SAMPLE_FONT_SIZE) {
  const safeName = String(fontName || 'Arial').replace(/[<>]/g, '').trim() || 'Arial';
  return `${safeName}${bold ? ' Bold' : ''} ${size}`;
}

async function readRenderedWidth(sharpImpl, text, fontDescription) {
  const metadata = await sharpImpl({
    text: {
      text: escapePangoMarkup(text),
      font: fontDescription,
      rgba: true,
      dpi: 72
    }
  }).metadata();
  return Math.max(0, Number(metadata.width) || 0);
}

async function mapWithConcurrency(values, concurrency, worker) {
  const queue = Array.from(values || []);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    while (cursor < queue.length) {
      const index = cursor++;
      await worker(queue[index], index);
    }
  });
  await Promise.all(runners);
}

async function createSubtitleFontMeasurer(texts, options = {}) {
  const fontName = String(options.fontName || 'Arial');
  const bold = options.bold !== false;
  const fontDescription = makeFontDescription(fontName, bold);
  let sharpImpl = options.sharpImpl;
  if (!sharpImpl) {
    try {
      sharpImpl = require('sharp');
    } catch (_error) {
      return {
        provider: 'heuristic',
        measuredTokens: 0,
        measureText: heuristicWidth
      };
    }
  }

  const tokens = new Set(['M', 'MM', 'M M']);
  for (const text of texts || []) {
    for (const token of tokenizeMeasurementText(text)) {
      if (token !== ' ') tokens.add(token);
    }
  }

  const localWidths = new Map();
  let provider = 'sharp-pango';
  try {
    await mapWithConcurrency(tokens, Number(options.concurrency) || 12, async (token) => {
      const cacheKey = `${fontDescription}\u0000${token}`;
      let width = widthCache.get(cacheKey);
      if (!Number.isFinite(width)) {
        width = await readRenderedWidth(sharpImpl, token, fontDescription);
        if (widthCache.size >= MAX_CACHE_ENTRIES) widthCache.clear();
        widthCache.set(cacheKey, width);
      }
      localWidths.set(token, width);
    });
  } catch (_error) {
    provider = 'heuristic';
  }

  const measuredM = localWidths.get('M') || heuristicWidth('M', SAMPLE_FONT_SIZE);
  const measuredMM = localWidths.get('MM') || measuredM * 2;
  const measuredMSpaceM = localWidths.get('M M') || measuredMM + SAMPLE_FONT_SIZE * 0.33;
  const spaceWidth = Math.max(SAMPLE_FONT_SIZE * 0.18, measuredMSpaceM - measuredMM);

  function measureText(text, fontSize) {
    const size = Math.max(1, Number(fontSize) || 1);
    if (provider !== 'sharp-pango') return heuristicWidth(text, size);
    let width = 0;
    for (const token of tokenizeMeasurementText(text)) {
      if (token === ' ') {
        width += spaceWidth;
      } else {
        width += localWidths.get(token) || heuristicWidth(token, SAMPLE_FONT_SIZE);
      }
    }
    return width * size / SAMPLE_FONT_SIZE;
  }

  return {
    provider,
    measuredTokens: provider === 'sharp-pango' ? localWidths.size : 0,
    measureText
  };
}

function clearSubtitleFontWidthCache() {
  widthCache.clear();
}

module.exports = {
  SAMPLE_FONT_SIZE,
  clearSubtitleFontWidthCache,
  createSubtitleFontMeasurer,
  escapePangoMarkup,
  heuristicWidth,
  makeFontDescription,
  normalizeMeasurementText,
  tokenizeMeasurementText
};
