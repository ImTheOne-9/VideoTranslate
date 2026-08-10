const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCustomData,
  buildUserData,
  hashSHA256,
  normalizeEmail,
  normalizePhone,
  sendCapiEvent
} = require('../lib/meta-capi');

test('normalizes and hashes Meta identifiers', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.equal(normalizePhone('0912 345 678'), '84912345678');
  assert.equal(hashSHA256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('builds privacy-safe user_data with hashed PII', () => {
  const data = buildUserData({
    clientIp: '203.0.113.5',
    userAgent: 'Browser',
    userEmail: 'User@Example.com',
    userPhone: '0912345678',
    externalId: 'internal-user-1',
    fbp: 'fb.1.123.456',
    fbc: 'fb.1.123.click'
  });
  assert.notEqual(data.em[0], 'user@example.com');
  assert.notEqual(data.ph[0], '84912345678');
  assert.equal(data.client_ip_address, '203.0.113.5');
  assert.equal(data.fbp, 'fb.1.123.456');
  assert.equal(data.fbc, 'fb.1.123.click');
});

test('builds Purchase custom_data with plan and order identifiers', () => {
  assert.deepEqual(buildCustomData({ amount: 299000, planName: 'Gói tháng', planId: 'monthly', orderId: 'bank-123' }), {
    currency: 'VND',
    value: 299000,
    content_name: 'Gói tháng',
    content_ids: ['monthly'],
    content_type: 'product',
    order_id: 'bank-123'
  });
});

test('skips CAPI safely when the server token is missing', async () => {
  const previous = process.env.META_CAPI_ACCESS_TOKEN;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  const result = await sendCapiEvent({ eventName: 'Purchase', eventId: 'purchase_test' });
  if (previous) process.env.META_CAPI_ACCESS_TOKEN = previous;
  assert.equal(result.skipped, true);
});
