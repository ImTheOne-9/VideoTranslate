'use strict';

const PAYMENT_KEY_REF_PATTERN = /\bVST[\s._-]*([A-F0-9]{8})(?![A-F0-9])/i;

function extractPaymentKeyRef(content) {
  const match = String(content || '').match(PAYMENT_KEY_REF_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

function buildPaymentMemo(keyRef) {
  const normalizedKeyRef = String(keyRef || '').trim().toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(normalizedKeyRef)) {
    throw new Error('Invalid payment key reference');
  }
  return `VST${normalizedKeyRef}`;
}

module.exports = {
  PAYMENT_KEY_REF_PATTERN,
  extractPaymentKeyRef,
  buildPaymentMemo
};
