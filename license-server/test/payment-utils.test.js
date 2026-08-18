'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPaymentKeyRef, buildPaymentMemo } = require('../payment-utils');

test('extracts the two real SePay memos without whitespace', () => {
  assert.equal(extractPaymentKeyRef('VST52D3FCA8'), '52D3FCA8');
  assert.equal(extractPaymentKeyRef('vst808C91A3'), '808C91A3');
});

test('keeps compatibility with legacy memo separators', () => {
  assert.equal(extractPaymentKeyRef('VST 52D3FCA8'), '52D3FCA8');
  assert.equal(extractPaymentKeyRef('Thanh toan VST-52D3FCA8 don hang'), '52D3FCA8');
});

test('rejects malformed or overlong key references', () => {
  assert.equal(extractPaymentKeyRef('VST 52D3FCA'), null);
  assert.equal(extractPaymentKeyRef('VST52D3FCA8FF'), null);
  assert.equal(extractPaymentKeyRef('khong co ma thanh toan'), null);
});

test('builds the canonical memo without whitespace', () => {
  assert.equal(buildPaymentMemo('52d3fca8'), 'VST52D3FCA8');
  assert.throws(() => buildPaymentMemo('52D3FCA'), /Invalid payment key reference/);
});
