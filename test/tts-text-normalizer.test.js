'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTtsText,
  normalizeVietnameseTtsText,
  readVietnameseInteger
} = require('../lib/tts-text-normalizer');

test('reads Vietnamese integers with natural mốt, tư and lăm forms', () => {
  assert.equal(readVietnameseInteger(21), 'hai mươi mốt');
  assert.equal(readVietnameseInteger(24), 'hai mươi tư');
  assert.equal(readVietnameseInteger(105), 'một trăm lẻ năm');
  assert.equal(readVietnameseInteger(1000005), 'một triệu không trăm lẻ năm');
});

test('normalizes dates, time, money, percent and phone numbers for Vietnamese TTS only', () => {
  assert.equal(
    normalizeVietnameseTtsText('Ngày 25/12/2024 lúc 15:30 giảm 50%.'),
    'ngày hai mươi lăm tháng mười hai năm hai nghìn không trăm hai mươi tư lúc mười lăm giờ ba mươi phút giảm năm mươi phần trăm.'
  );
  assert.equal(normalizeVietnameseTtsText('Giá 1.000.000đ.'), 'Giá một triệu đồng.');
  assert.equal(normalizeVietnameseTtsText('Gọi 0987654321.'), 'Gọi không chín tám bảy sáu năm bốn ba hai một.');
  assert.equal(normalizeTtsText('50%', { language: 'en' }), '50%');
});
