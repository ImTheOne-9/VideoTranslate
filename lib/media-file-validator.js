const fs = require('fs');
const path = require('path');

const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v']);
const HTML_PREFIX = /^\s*(?:<!doctype\s+html|<html|<head|<body|\{\s*"(?:error|message)"\s*:)/i;
const ISO_BOXES = new Set(['ftyp', 'moov', 'free', 'skip', 'wide', 'mdat']);

function readHead(filePath, bytes = 4096) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const length = fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(handle);
  }
}

function hasIsoBmffSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  for (let offset = 4; offset <= Math.min(64, buffer.length - 4); offset += 1) {
    if (ISO_BOXES.has(buffer.subarray(offset, offset + 4).toString('ascii'))) return true;
  }
  return false;
}

function validateMediaFile(filePath, options = {}) {
  const minimumBytes = Math.max(1024, Number(options.minimumBytes || 100 * 1024));
  const resolved = path.resolve(String(filePath || ''));
  let stat;
  try { stat = fs.statSync(resolved); } catch (_) {
    return { valid: false, reason: 'missing', path: resolved, size: 0 };
  }
  if (!stat.isFile()) return { valid: false, reason: 'not_file', path: resolved, size: stat.size };
  if (stat.size < minimumBytes) return { valid: false, reason: 'too_small', path: resolved, size: stat.size };

  let head;
  try { head = readHead(resolved); } catch (error) {
    return { valid: false, reason: 'unreadable', error: error.message, path: resolved, size: stat.size };
  }
  const text = head.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '');
  if (HTML_PREFIX.test(text) || /access denied|request blocked|captcha|forbidden/i.test(text)) {
    return { valid: false, reason: 'html_or_error_body', path: resolved, size: stat.size };
  }

  const extension = path.extname(resolved).toLowerCase();
  if (['.mp4', '.m4v', '.mov'].includes(extension) && !hasIsoBmffSignature(head)) {
    return { valid: false, reason: 'invalid_mp4_signature', path: resolved, size: stat.size };
  }
  if (['.webm', '.mkv'].includes(extension) && !head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { valid: false, reason: 'invalid_ebml_signature', path: resolved, size: stat.size };
  }
  return { valid: true, reason: 'ok', path: resolved, size: stat.size };
}

function listMediaFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(directory, entry.name));
  } catch (_) {
    return [];
  }
}

function listMediaFilesRecursive(directory, depth = 8) {
  if (depth < 0) return [];
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return []; }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listMediaFilesRecursive(target, depth - 1));
    else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(target);
  }
  return files;
}

function findValidatedOutput(directory, filenameBase, startedAtMs = 0) {
  const prefix = String(filenameBase || '').toLowerCase();
  const candidates = listMediaFiles(directory)
    .filter((filePath) => !prefix || path.basename(filePath).toLowerCase().startsWith(prefix))
    .map((filePath) => {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) {}
      return { filePath, mtimeMs };
    })
    .filter((item) => !startedAtMs || item.mtimeMs >= startedAtMs - 2000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const checked = validateMediaFile(candidate.filePath);
    if (checked.valid) return checked;
  }
  return { valid: false, reason: candidates.length ? 'no_valid_media' : 'missing_output', path: directory, size: 0 };
}

module.exports = { MEDIA_EXTENSIONS, hasIsoBmffSignature, validateMediaFile, listMediaFiles, listMediaFilesRecursive, findValidatedOutput };
