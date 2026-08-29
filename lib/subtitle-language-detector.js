'use strict';

const FUNCTION_WORDS = Object.freeze({
  en: 'the and of to in is that it for on with as was you this be are have not but from they',
  fr: 'le la les de des du et un une dans que qui pour pas est sont avec sur ce il elle nous',
  es: 'el la los las de del y que en un una por con no se para es son como pero su',
  pt: 'o a os as de do da e que em um uma por com não se para é são como mas seu',
  de: 'der die das und den dem ist nicht ein eine mit von zu auf sich für aber auch wir',
  it: 'il lo la gli le di del che non un una per con nel sono come ma anche questo',
  nl: 'de het een en van is niet dat in op met voor zijn maar ook wij naar',
  id: 'yang dan di ke dari untuk itu ini dengan tidak adalah akan pada saya kami sudah',
  ms: 'yang dan di ke dari untuk itu ini dengan tidak ialah akan pada saya kami sudah',
  tr: 'bir ve bu ile için de da ne çok ama daha gibi olarak sonra',
  pl: 'nie to jest się na w z że do i po ale jak tylko co',
  ro: 'de la și în cu un o care nu pentru este dar sau mai',
  sv: 'och att det som en för av med inte på den till han',
  da: 'og at det som en for af med ikke på den til han',
  fi: 'ja on ei se että kun niin mutta hän tämä ovat',
  cs: 'a je se na to že v ne s jak ale pro po',
  hu: 'a az és hogy nem is de van meg egy már csak',
  tl: 'ang ng sa na mga ay at hindi ito para may siya',
  vi: 'và là của có không được cho với những một người này đã sẽ khi thì mà ở trong ra đi lại rất cũng để nhưng tôi anh em va la cua co khong duoc voi nhung mot nguoi nay da se khi thi ma o trong ra di lai rat cung de nhung toi anh em'
});

const FUNCTION_WORD_SETS = Object.fromEntries(
  Object.entries(FUNCTION_WORDS).map(([language, words]) => [language, new Set(words.split(/\s+/u))])
);

function detectScriptLanguage(text) {
  const value = String(text || '');
  const alphanumeric = [...value].filter((character) => /[\p{L}\p{N}]/u.test(character));
  if (!alphanumeric.length) return { language: null, confidence: 0, evidence: 'script' };
  const decomposed = value.normalize('NFD');
  const scores = {
    ch: (value.match(/[\p{Script=Han}]/gu) || []).length,
    korean: (value.match(/[\p{Script=Hangul}]/gu) || []).length,
    japan: (value.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length,
    th: (value.match(/[\p{Script=Thai}]/gu) || []).length,
    vi: (decomposed.match(/[\u0309\u0323]/gu) || []).length
      + (value.match(/[ơưăđƠƯĂĐ]/gu) || []).length
  };
  const [language, count] = Object.entries(scores).sort((left, right) => right[1] - left[1])[0];
  return {
    language: count > 0 ? language : null,
    confidence: count / alphanumeric.length,
    evidence: 'script'
  };
}

function detectLatinLanguage(text, options = {}) {
  const minimumWords = Math.max(1, Number(options.minimumWords) || 25);
  const minimumRatio = Math.max(0, Number(options.minimumRatio) || 0.06);
  const safetyMargin = Math.max(1, Number(options.safetyMargin) || 1.4);
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{M}]+/gu) || [];
  if (words.length < minimumWords) return { language: null, confidence: 0, evidence: 'function_words' };
  const ranked = Object.entries(FUNCTION_WORD_SETS).map(([language, dictionary]) => ({
    language,
    confidence: words.filter((word) => dictionary.has(word)).length / words.length
  })).sort((left, right) => right.confidence - left.confidence);
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first.confidence < minimumRatio) {
    return { language: null, confidence: 0, evidence: 'function_words' };
  }
  if (second?.confidence > 0 && first.confidence < second.confidence * safetyMargin) {
    return { language: null, confidence: first.confidence, evidence: 'function_words_ambiguous' };
  }
  return { ...first, evidence: 'function_words' };
}

function verifySubtitleLanguage(text, options = {}) {
  const script = detectScriptLanguage(text);
  const scriptThreshold = Math.max(0, Number(options.scriptThreshold) || 0.15);
  if (script.language && script.confidence >= scriptThreshold) return script;
  const latin = detectLatinLanguage(text, options);
  if (latin.language) return latin;
  return script.language ? { ...script, evidence: 'script_low_confidence' } : latin;
}

module.exports = {
  FUNCTION_WORDS,
  detectLatinLanguage,
  detectScriptLanguage,
  verifySubtitleLanguage
};
