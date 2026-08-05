'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSegmentCaptions,
  formatWordCaptions,
  joinWords,
  wrapCaptionText
} = require('../lib/caption-formatter');

test('groups word timestamps into readable captions while retaining each word timing', () => {
  const captions = formatWordCaptions([
    { text: ' Xin', timestamp: [0, 0.4] },
    { text: ' chào', timestamp: [0.4, 0.8] },
    { text: ' bạn.', timestamp: [0.8, 1.2] },
    { text: ' Hôm', timestamp: [2.2, 2.5] },
    { text: ' nay', timestamp: [2.5, 2.8] }
  ]);

  assert.deepEqual(captions.map((cue) => cue.text), ['Xin chào bạn.', 'Hôm nay']);
  assert.deepEqual(captions[0].timestamp, [0, 1.2]);
  assert.deepEqual(captions[0].words, [
    { text: 'Xin', timestamp: [0, 0.4] },
    { text: 'chào', timestamp: [0.4, 0.8] },
    { text: 'bạn.', timestamp: [0.8, 1.2] }
  ]);
});

test('breaks a caption at the configured readable character limit', () => {
  const captions = formatWordCaptions([
    { text: 'một', timestamp: [0, 0.3] },
    { text: 'hai', timestamp: [0.3, 0.6] },
    { text: 'ba', timestamp: [0.6, 0.9] }
  ], { maxCharacters: 7 });
  assert.deepEqual(captions.map((cue) => cue.text), ['một hai', 'ba']);
});

test('joins punctuation without inserting an unwanted space', () => {
  assert.equal(joinWords([{ text: 'Xin' }, { text: 'chào' }, { text: '!' }]), 'Xin chào!');
});

test('wraps readable captions into at most two lines and extends timing for reading speed', () => {
  assert.equal(
    wrapCaptionText('một câu phụ đề tương đối dài để hiển thị', 24),
    'một câu phụ đề tương đối\ndài để hiển thị'
  );
  const [caption] = formatWordCaptions([
    { text: 'abcdefghij', timestamp: [0, 0.1] },
    { text: 'abcdefghij', timestamp: [0.1, 0.2] }
  ]);
  assert.ok(caption.timestamp[1] >= 21 / 18);
  assert.ok(caption.text.split('\n').length <= 2);
});

test('splits a long segment proportionally without overlapping timestamps', () => {
  const captions = formatSegmentCaptions([{
    text: 'Đây là câu đầu tiên khá dài. Đây là câu thứ hai cũng cần hiển thị riêng.',
    timestamp: [10, 16]
  }], { maxCharacters: 35, maxLineCharacters: 22 });
  assert.ok(captions.length >= 2);
  assert.equal(captions[0].timestamp[0], 10);
  assert.equal(captions.at(-1).timestamp[1], 16);
  for (let index = 1; index < captions.length; index += 1) {
    assert.equal(captions[index].timestamp[0], captions[index - 1].timestamp[1]);
  }
});
