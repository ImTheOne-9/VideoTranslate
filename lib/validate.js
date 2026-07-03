/**
 * Helper validation tập trung cho API endpoints.
 * Nhẹ, không phụ thuộc thư viện ngoài, tránh overhead cho app desktop.
 *
 * Cách dùng trong controller:
 *   const { validate, validators } = require('../lib/validate');
 *   const { err, values } = validate(req.body, {
 *     url: validators.url('Thiếu URL hợp lệ'),
 *     format_id: validators.optional(validators.string)
 *   });
 *   if (err) return res.status(400).json({ error: err });
 *   // use values.url
 */

// --- Primitive validators (trả về {ok, value, error}) ---

function str(msg = 'Trường bắt buộc là chuỗi') {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: false, error: msg };
    const s = String(v);
    return { ok: true, value: s };
  };
}

function num(min = -Infinity, max = Infinity, msg) {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: false, error: msg || `Phải là số từ ${min} đến ${max}` };
    const n = Number(v);
    if (isNaN(n)) return { ok: false, error: msg || 'Giá trị không phải số hợp lệ' };
    if (n < min || n > max) return { ok: false, error: msg || `Phải nằm trong khoảng ${min} đến ${max}` };
    return { ok: true, value: n };
  };
}

function int(min = -Infinity, max = Infinity, msg) {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: false, error: msg || `Phải là số nguyên từ ${min} đến ${max}` };
    const n = Number(v);
    if (!Number.isInteger(n)) return { ok: false, error: msg || 'Phải là số nguyên' };
    if (n < min || n > max) return { ok: false, error: msg || `Phải nằm trong khoảng ${min} đến ${max}` };
    return { ok: true, value: n };
  };
}

function bool(msg = 'Phải là boolean') {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: false, error: msg };
    if (typeof v === 'boolean') return { ok: true, value: v };
    if (v === 'true') return { ok: true, value: true };
    if (v === 'false') return { ok: true, value: false };
    return { ok: false, error: msg };
  };
}

// URL phải bắt đầu bằng http(s)://
function url(msg = 'URL không hợp lệ (phải bắt đầu bằng http:// hoặc https://)') {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: false, error: msg };
    const s = String(v).trim();
    if (!/^https?:\/\//i.test(s)) return { ok: false, error: msg };
    try {
      new URL(s);
      return { ok: true, value: s };
    } catch (e) {
      return { ok: false, error: msg };
    }
  };
}

// String không rỗng, không chứa ký tự nguy hiểm (chống command injection)
function safeStr(maxLen = 1000, msg) {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: false, error: msg || 'Trường không được để trống' };
    const s = String(v).trim();
    if (s.length > maxLen) return { ok: false, error: msg || `Quá dài (tối đa ${maxLen} ký tự)` };
    return { ok: true, value: s };
  };
}

// Bọc validator khác thành tùy chọn (undefined/null → bỏ qua, không lỗi)
function optional(validator) {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: true, value: undefined };
    return validator(v);
  };
}

// Optional nhưng nếu có thì phải hợp lệ, giữ giá trị chuỗi
function optionalStr(validator) {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: true, value: '' };
    return validator(v);
  };
}

// Enum: giá trị phải thuộc tập cho phép
function oneOf(allowed, msg) {
  return (v) => {
    if (v === undefined || v === null || v === '') return { ok: false, error: msg || `Phải là một trong: ${allowed.join(', ')}` };
    if (!allowed.includes(String(v))) return { ok: false, error: msg || `Phải là một trong: ${allowed.join(', ')}` };
    return { ok: true, value: String(v) };
  };
}

const validators = { str, num, int, bool, url, safeStr, optional, optionalStr, oneOf };

/**
 * Validate một object (thường là req.body / req.query)
 * @param {object} input - object cần validate
 * @param {object} schema - { fieldName: validatorFn }
 * @returns {{ err: string|null, values: object }}
 */
function validate(input, schema) {
  const values = {};
  for (const [field, validator] of Object.entries(schema)) {
    const r = validator(input[field]);
    if (!r.ok) {
      return { err: r.error, values: null };
    }
    if (r.value !== undefined) values[field] = r.value;
  }
  return { err: null, values };
}

module.exports = { validate, validators };