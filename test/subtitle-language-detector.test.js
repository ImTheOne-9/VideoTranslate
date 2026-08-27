'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectLatinLanguage,
  detectScriptLanguage,
  verifySubtitleLanguage
} = require('../lib/subtitle-language-detector');

test('script verification distinguishes Chinese, Japanese, Korean, Thai and Vietnamese', () => {
  assert.equal(detectScriptLanguage('这是一个中文字幕测试').language, 'ch');
  assert.equal(detectScriptLanguage('これは日本語のテストです').language, 'japan');
  assert.equal(detectScriptLanguage('이것은 한국어 자막 테스트입니다').language, 'korean');
  assert.equal(detectScriptLanguage('นี่คือการทดสอบคำบรรยาย').language, 'th');
  assert.equal(detectScriptLanguage('Người Việt ở Hà Nội rất tốt').language, 'vi');
});

test('Latin verification requires enough evidence and recognizes function words', () => {
  assert.equal(detectLatinLanguage('this is too short').language, null);
  const english = 'the video is in the room and the person is speaking with you about the work that they have done for this new project and it is not finished but they are working on it';
  assert.equal(detectLatinLanguage(english).language, 'en');
  const vietnamese = 'đây là một video của người việt và trong video này có những người đang nói với nhau nhưng tôi không biết họ sẽ đi đâu và khi nào họ sẽ quay lại';
  assert.equal(detectLatinLanguage(vietnamese).language, 'vi');
});

test('subtitle verification prefers strong script evidence over Latin hints', () => {
  const result = verifySubtitleLanguage('the and of 这是中文字幕内容而且文字数量很多');
  assert.equal(result.language, 'ch');
  assert.equal(result.evidence, 'script');
});
