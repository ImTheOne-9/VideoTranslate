const fs = require('node:fs');
const path = require('node:path');

function resolveFacebookRenderPath(value, rendersDir) {
  if (!value) throw new Error('Thiếu file video đã render');
  const input = String(value);
  const root = path.resolve(rendersDir);
  let candidate;
  if (input.startsWith('/renders/')) {
    // This is an application URL, not an absolute filesystem path (including on Windows).
    let name;
    try { name = decodeURIComponent(input.slice('/renders/'.length).split(/[?#]/)[0]); }
    catch { throw new Error('Địa chỉ video render không hợp lệ'); }
    if (!name || /[/\\\x00]/.test(name) || name === '.' || name === '..') throw new Error('Chỉ được đăng video nằm trong thư mục renders');
    candidate = path.resolve(root, name);
  } else if (path.isAbsolute(input)) {
    candidate = path.resolve(input);
  } else {
    if (/[/\\:\x00]/.test(input) || input === '.' || input === '..') throw new Error('Chỉ được đăng video nằm trong thư mục renders');
    // Render results provide decoded names; manual publish may send a URL-encoded name.
    // Prefer an existing literal name so a real percent sign is not decoded twice.
    candidate = path.resolve(root, input);
    if (!fs.existsSync(candidate) && input.includes('%')) {
      let name;
      try { name = decodeURIComponent(input); }
      catch { throw new Error('Tên file video render không hợp lệ'); }
      if (/[/\\:\x00]/.test(name) || name === '.' || name === '..') throw new Error('Chỉ được đăng video nằm trong thư mục renders');
      candidate = path.resolve(root, name);
    }
  }
  const within = (base, target) => {
    const relative = path.relative(base, target);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!within(root, candidate)) throw new Error('Chỉ được đăng video nằm trong thư mục renders');
  if (!fs.existsSync(candidate)) throw new Error('Không tìm thấy file video đã render');
  if (!within(fs.realpathSync(root), fs.realpathSync(candidate))) throw new Error('Chỉ được đăng video nằm trong thư mục renders');
  if (!fs.statSync(candidate).isFile()) throw new Error('Đường dẫn render không phải file video');
  return candidate;
}

module.exports = { resolveFacebookRenderPath };
