/**
 * Unit test cho lib/validate.js
 * Chạy: node --test test/unit/validate.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { validate, validators } = require('../../lib/validate');

describe('validators.str', () => {
  test('hợp lệ', () => {
    const r = validators.str()('hello');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, 'hello');
  });
  test('rỗng → lỗi', () => {
    const r = validators.str()('');
    assert.strictEqual(r.ok, false);
  });
  test('null → lỗi', () => {
    const r = validators.str()(null);
    assert.strictEqual(r.ok, false);
  });
});

describe('validators.num', () => {
  test('trong khoảng hợp lệ', () => {
    const r = validators.num(0, 10)('5');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, 5);
  });
  test('ngoài khoảng → lỗi', () => {
    assert.strictEqual(validators.num(0, 10)('20').ok, false);
    assert.strictEqual(validators.num(0, 10)('-1').ok, false);
  });
  test('không phải số → lỗi', () => {
    assert.strictEqual(validators.num()('abc').ok, false);
  });
  test('NaN từ object → lỗi', () => {
    assert.strictEqual(validators.num()({}).ok, false);
  });
});

describe('validators.url', () => {
  test('https hợp lệ', () => {
    const r = validators.url()('https://youtube.com/watch?v=abc');
    assert.strictEqual(r.ok, true);
  });
  test('http hợp lệ', () => {
    assert.strictEqual(validators.url()('http://localhost:3000').ok, true);
  });
  test('ftp → lỗi', () => {
    assert.strictEqual(validators.url()('ftp://example.com').ok, false);
  });
  test('không phải URL → lỗi', () => {
    assert.strictEqual(validators.url()('not a url').ok, false);
  });
  test('rỗng → lỗi', () => {
    assert.strictEqual(validators.url()('').ok, false);
  });
});

describe('validators.oneOf', () => {
  test('giá trị trong enum', () => {
    const r = validators.oneOf(['a', 'b', 'c'])('b');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, 'b');
  });
  test('giá trị ngoài enum → lỗi', () => {
    assert.strictEqual(validators.oneOf(['a', 'b'])('z').ok, false);
  });
});

describe('validators.optional', () => {
  test('undefined → ok, value undefined', () => {
    const r = validators.optional(validators.num(0, 10))(undefined);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, undefined);
  });
  test('có giá trị → validate bình thường', () => {
    const r = validators.optional(validators.num(0, 10))('5');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, 5);
  });
  test('có giá trị sai → lỗi', () => {
    assert.strictEqual(validators.optional(validators.num(0, 10))('20').ok, false);
  });
});

describe('validators.bool', () => {
  test('true/false thực', () => {
    assert.strictEqual(validators.bool()(true).value, true);
    assert.strictEqual(validators.bool()(false).value, false);
  });
  test('chuỗi "true"/"false"', () => {
    assert.strictEqual(validators.bool()('true').value, true);
    assert.strictEqual(validators.bool()('false').value, false);
  });
  test('sai kiểu → lỗi', () => {
    assert.strictEqual(validators.bool()('yes').ok, false);
  });
});

describe('validate (schema runner)', () => {
  test('tất cả trường hợp lệ → trả values', () => {
    const { err, values } = validate(
      { url: 'https://youtube.com', count: '5' },
      { url: validators.url(), count: validators.int(1, 100) }
    );
    assert.strictEqual(err, null);
    assert.strictEqual(values.url, 'https://youtube.com');
    assert.strictEqual(values.count, 5);
  });

  test('một trường lỗi → trả err, values null', () => {
    const { err, values } = validate(
      { url: 'not a url' },
      { url: validators.url('URL sai') }
    );
    assert.strictEqual(err, 'URL sai');
    assert.strictEqual(values, null);
  });

  test('thiếu trường bắt buộc → lỗi', () => {
    const { err } = validate({}, { key: validators.str('Thiếu key') });
    assert.strictEqual(err, 'Thiếu key');
  });

  test('trường optional thiếu → ok, không có trong values', () => {
    const { err, values } = validate(
      { url: 'https://x.com' },
      { url: validators.url(), optional_field: validators.optional(validators.num()) }
    );
    assert.strictEqual(err, null);
    assert.ok(!('optional_field' in values), 'optional field thiếu không nên có trong values');
  });
});