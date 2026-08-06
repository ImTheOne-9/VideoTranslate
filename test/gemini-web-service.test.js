const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  docTm,
  tyLeHan,
  tranTuDich,
  slotGiay,
  buildPrompt,
  parseResponseLo
} = require('../lib/gemini-web-service');

test('tyLeHan detects Chinese character ratio correctly', () => {
  assert.equal(tyLeHan('你好世界'), 1.0);
  assert.equal(tyLeHan('Xin chào thế giới'), 0.0);
  assert.ok(tyLeHan('你好 Hello') > 0.25);
});

test('slotGiay parses SRT timestamp strings to duration in seconds', () => {
  const duration = slotGiay('00:00:01,000 --> 00:00:03,500');
  assert.equal(duration, 2.5);
});

test('tranTuDich calculates max words limit based on duration and source syllables', () => {
  // 2s duration, 4 source syllables
  const maxW = tranTuDich(2.0, '你好世界');
  assert.ok(maxW >= 3);
  assert.ok(maxW <= 10);
});

test('parseResponseLo correctly parses numbered translation responses', () => {
  const sampleResp = `
1. Xin chào thế giới
2. Rất vui được gặp bạn
3. Chúc một ngày tốt lành
`;
  const parsed = parseResponseLo(sampleResp, 3);
  assert.equal(parsed[1], 'Xin chào thế giới');
  assert.equal(parsed[2], 'Rất vui được gặp bạn');
  assert.equal(parsed[3], 'Chúc một ngày tốt lành');
});

test('buildPrompt builds full system prompt with 1:1 constraint and length anchors', () => {
  const items = [
    { id: 1, timestamp: '00:00:01,000 --> 00:00:03,000', text: '你好' },
    { id: 2, timestamp: '00:00:03,500 --> 00:00:05,000', text: '谢谢' }
  ];
  const prompt = buildPrompt(items, '', 'vi', true);
  assert.ok(prompt.includes('QUY TẮC DỊCH THUẬT'));
  assert.ok(prompt.includes('1. [2.0s ≤'));
  assert.ok(prompt.includes('你好'));
  assert.ok(prompt.includes('谢谢'));
});
