'use strict';

const fs = require('fs');
const path = require('path');
const { getCrawlerPaths } = require('./crawler-paths');

let cachedDictionary = null;
let cachedPrefixSet = null;

function dictionaryCandidates() {
  const relative = path.join('tools', 'crawler', 'app', 'viral_ocr', 'zhcdict.json');
  let configured = null;
  try {
    configured = path.join(getCrawlerPaths().appRoot, 'viral_ocr', 'zhcdict.json');
  } catch {}
  return [
    configured,
    path.join(__dirname, '..', relative),
    process.resourcesPath ? path.join(process.resourcesPath, relative) : null
  ].filter(Boolean);
}

function loadDictionary() {
  if (cachedDictionary && cachedPrefixSet) {
    return { dictionary: cachedDictionary, prefixes: cachedPrefixSet };
  }
  const dictionaryPath = dictionaryCandidates().find((candidate) => fs.existsSync(candidate));
  if (!dictionaryPath) return { dictionary: null, prefixes: null };
  try {
    const payload = JSON.parse(fs.readFileSync(dictionaryPath, 'utf8'));
    const dictionary = payload?.zh2Hans;
    if (!dictionary || typeof dictionary !== 'object') return { dictionary: null, prefixes: null };
    const prefixes = new Set();
    for (const word of Object.keys(dictionary)) {
      for (let length = 1; length <= word.length; length += 1) {
        prefixes.add(word.slice(0, length));
      }
    }
    cachedDictionary = dictionary;
    cachedPrefixSet = prefixes;
    return { dictionary, prefixes };
  } catch {
    return { dictionary: null, prefixes: null };
  }
}

// Port of zhconv's maximal-forward-matching conversion used by ViralCrawl.
// It is comparison-only: the original subtitle text is never rewritten.
function traditionalToSimplified(value) {
  const source = String(value || '');
  if (!source) return source;
  const { dictionary, prefixes } = loadDictionary();
  if (!dictionary || !prefixes) return source;

  const output = [];
  let position = 0;
  while (position < source.length) {
    let cursor = position;
    let fragment = source[position];
    let replacement = null;
    let replacementEnd = position;
    while (cursor < source.length && prefixes.has(fragment)) {
      if (Object.hasOwn(dictionary, fragment)) {
        replacement = dictionary[fragment];
        replacementEnd = cursor;
      }
      cursor += 1;
      fragment = source.slice(position, cursor + 1);
    }
    if (replacement === null) {
      output.push(source[position]);
      position += 1;
    } else {
      output.push(replacement);
      position = replacementEnd + 1;
    }
  }
  return output.join('');
}

function resetTraditionalToSimplifiedCache() {
  cachedDictionary = null;
  cachedPrefixSet = null;
}

module.exports = {
  resetTraditionalToSimplifiedCache,
  traditionalToSimplified
};
