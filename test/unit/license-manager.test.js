/**
 * Unit test cho license-manager.js - HWID + verify logic
 * Chạy: node --test test/unit/license-manager.test.js
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const lm = require('../../lib/license-manager');

describe('getCompositeHWID', () => {
  test('trả HWID dạng hex 64 ký tự (SHA256)', () => {
    const hwid = lm.getCompositeHWID();
    assert.ok(hwid, 'HWID không được rỗng');
    assert.strictEqual(hwid.length, 64, 'HWID phải là 64 ký tự hex');
    assert.ok(/^[a-f0-9]+$/.test(hwid), 'HWID phải chỉ chứa hex chars');
  });

  test('HWID ổn định - gọi 2 lần phải giống nhau', () => {
    const hwid1 = lm.getCompositeHWID();
    const hwid2 = lm.getCompositeHWID();
    assert.strictEqual(hwid1, hwid2, 'HWID phải ổn định trên cùng máy');
  });
});

describe('verifyLocalLicense', () => {
  test('chưa kích hoạt → invalid với lỗi rõ ràng', () => {
    // Đảm bảo không có file license tạm ở path dev
    const licPath = lm.getLicenseFilePath();
    if (fs.existsSync(licPath)) {
      fs.unlinkSync(licPath);
    }
    const result = lm.verifyLocalLicense();
    assert.strictEqual(result.valid, false);
    assert.ok(result.error, 'Phải có thông báo lỗi');
  });

  test('file license bị sửa đổi → phát hiện qua HMAC', () => {
    const licPath = lm.getLicenseFilePath();
    // Tạo file license giả (HMAC không khớp)
    const fakeData = {
      payload: { key: 'FAKE-KEY', hwid: 'fakehwid', expiresAt: '2099-12-31', issuedAt: Date.now(), nonce: 'x' },
      signature: 'aabbcc',
      localSig: 'invalid_hmac_value'
    };
    fs.writeFileSync(licPath, JSON.stringify(fakeData), 'utf8');
    try {
      const result = lm.verifyLocalLicense();
      assert.strictEqual(result.valid, false);
      assert.match(result.error, /sửa đổi|không hợp lệ|signature/i, 'Phải báo lỗi sửa file');
    } finally {
      if (fs.existsSync(licPath)) fs.unlinkSync(licPath);
    }
  });

  test('file license hỏng (JSON sai) → invalid', () => {
    const licPath = lm.getLicenseFilePath();
    fs.writeFileSync(licPath, 'this is not json{{{', 'utf8');
    try {
      const result = lm.verifyLocalLicense();
      assert.strictEqual(result.valid, false);
    } finally {
      if (fs.existsSync(licPath)) fs.unlinkSync(licPath);
    }
  });

  test('thiếu trường bắt buộc → invalid', () => {
    const licPath = lm.getLicenseFilePath();
    fs.writeFileSync(licPath, JSON.stringify({ payload: {} }), 'utf8');
    try {
      const result = lm.verifyLocalLicense();
      assert.strictEqual(result.valid, false);
    } finally {
      if (fs.existsSync(licPath)) fs.unlinkSync(licPath);
    }
  });
});

describe('saveLicenseLocal + verifyLocalLicense round-trip', () => {
  test('lưu rồi đọc lại phải khớp payload (nhưng signature không hợp lệ do key server khác)', () => {
    const licPath = lm.getLicenseFilePath();
    const crypto = require('crypto');
    const payload = {
      key: 'TEST-KEY',
      hwid: lm.getCompositeHWID(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      issuedAt: Date.now(),
      nonce: crypto.randomUUID(),
      lastOnlineCheck: Date.now(),
      launchCountSinceOnlineCheck: 0,
      lastRunTimestamp: Date.now()
    };
    // Tạo signature giả (sẽ fail Ed25519 verify vì không phải server ký)
    const fakeSig = 'a'.repeat(128);
    lm.saveLicenseLocal(payload, fakeSig);
    try {
      const result = lm.verifyLocalLicense();
      // HMAC phải pass (do saveLicenseLocal tính đúng), nhưng Ed25519 fail
      assert.strictEqual(result.valid, false);
      assert.match(result.error, /chữ ký|signature/i, 'Phải báo lỗi chữ ký Ed25519');
    } finally {
      if (fs.existsSync(licPath)) fs.unlinkSync(licPath);
    }
  });
});

describe('LICENSE_SERVER_URL', () => {
  test('URL không có dấu / ở cuối (đã normalize)', () => {
    assert.ok(!lm.LICENSE_SERVER_URL.endsWith('/'), 'URL không nên có dấu / cuối');
  });
  test('URL là https hợp lệ', () => {
    assert.ok(lm.LICENSE_SERVER_URL.startsWith('https://'), 'URL phải là https');
  });
});