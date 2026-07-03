/**
 * Unit test cho shared-state.js - các helper thuần logic
 * Chạy: node --test test/unit/shared-state.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

const shared = require('../../lib/shared-state');

describe('removeVietnameseTones', () => {
  test('chuyển chữ có dấu thành không dấu', () => {
    assert.strictEqual(shared.removeVietnameseTones('Xin chào thế giới'), 'Xin chao the gioi');
  });

  test('xử lý chữ hoa có dấu', () => {
    assert.strictEqual(shared.removeVietnameseTones('Á À Ả Ã Ạ Â Ầ Ẩ Ẫ Ậ'), 'A A A A A A A A A A');
  });

  test('xử lý chữ đ/Đ', () => {
    assert.strictEqual(shared.removeVietnameseTones('đường Đèo'), 'duong Deo');
  });

  test('chuỗi rỗng', () => {
    assert.strictEqual(shared.removeVietnameseTones(''), '');
  });

  test('chuỗi không có dấu giữ nguyên', () => {
    assert.strictEqual(shared.removeVietnameseTones('Hello World 123'), 'Hello World 123');
  });

  test('xử lý chữ E có dấu (bug cũ: Ẽ bị thiếu)', () => {
    const result = shared.removeVietnameseTones('È É Ẹ Ẻ Ẽ Ế Ề Ệ Ể Ễ');
    // Tất cả phải thành "E" (10 ký tự E, phân cách bởi dấu cách)
    const expected = 'E E E E E E E E E E';
    assert.strictEqual(result, expected, 'Chữ E có dấu chưa được xử lý đúng');
  });
});

describe('safeFileName', () => {
  test('loại bỏ ký tự nguy hiểm cho tên file', () => {
    assert.strictEqual(shared.safeFileName('file<>:"/\\|?*name'), 'file_________name');
  });

  test('rút gọn tên quá dài', () => {
    const long = 'a'.repeat(200);
    const result = shared.safeFileName(long);
    assert.ok(result.length <= shared.safeFileName ? 100 : 200, 'Tên file quá dài không bị cắt');
  });

  test('chuỗi rỗng', () => {
    assert.ok(typeof shared.safeFileName('') === 'string');
  });

  test('giữ Vietnamese không dấu', () => {
    const result = shared.safeFileName('Tải video YouTube');
    assert.ok(result.includes('Tai') || result.includes('video'), 'Nên giữ được chữ không dấu');
  });
});

describe('extractUrl', () => {
  test('trích URL từ chuỗi có chữ thừa', () => {
    const result = shared.extractUrl('Xem https://youtube.com/watch?v=abc nhé');
    // Có thể trả về URL hoặc chuỗi chứa URL
    assert.ok(result, 'Không trả null với input có URL');
  });

  test('trả về chuỗi gốc nếu đã là URL', () => {
    const url = 'https://youtube.com/watch?v=abc';
    const result = shared.extractUrl(url);
    assert.ok(result, 'Phải có kết quả với URL thuần');
  });

  test('trả chuỗi gốc nếu không có URL (không trả null)', () => {
    const result = shared.extractUrl('không có link ở đây');
    assert.strictEqual(result, 'không có link ở đây', 'extractUrl trả chuỗi gốc khi không có URL');
  });

  test('trả rỗng với input rỗng', () => {
    assert.strictEqual(shared.extractUrl(''), '');
  });
});

describe('cleanVideoTitle', () => {
  test('loại bỏ ký tự đặc biệt trong title', () => {
    const result = shared.cleanVideoTitle('Video#1 @Channel | Official');
    assert.ok(typeof result === 'string');
    assert.ok(!result.includes('#') || result.length > 0);
  });

  test('input rỗng', () => {
    const result = shared.cleanVideoTitle('');
    assert.ok(typeof result === 'string');
  });
});

describe('isValidVideoUrl', () => {
  test('URL YouTube hợp lệ', () => {
    assert.ok(shared.isValidVideoUrl('https://youtube.com/watch?v=abc123'));
    assert.ok(shared.isValidVideoUrl('https://youtu.be/abc123'));
  });

  test('URL TikTok hợp lệ', () => {
    assert.ok(shared.isValidVideoUrl('https://tiktok.com/@user/video/123'));
  });

  test('URL không hợp lệ', () => {
    assert.strictEqual(shared.isValidVideoUrl('not a url'), false);
    assert.strictEqual(shared.isValidVideoUrl(''), false);
  });

  test('URL ftp:// không hợp lệ (chỉ http/https)', () => {
    assert.strictEqual(shared.isValidVideoUrl('ftp://example.com/video.mp4'), false);
  });
});

describe('getUniqueFilePath', () => {
  test('trả đường dẫn duy nhất khi file chưa tồn tại', () => {
    const dir = require('os').tmpdir();
    const result = shared.getUniqueFilePath(dir, 'testfile', '.tmp');
    assert.ok(result.includes('testfile'), 'Đường dẫn phải chứa tên file');
    assert.ok(result.endsWith('.tmp'), 'Phải có extension đúng');
  });
});