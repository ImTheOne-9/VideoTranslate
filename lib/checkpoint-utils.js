const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function createCheckpointSignature(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function getFileIdentity(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    path: path.resolve(filePath),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs)
  };
}

function isUsableFile(filePath, minimumBytes = 1) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size >= minimumBytes;
  } catch {
    return false;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  createCheckpointSignature,
  getFileIdentity,
  isUsableFile,
  readJsonFile,
  stableStringify,
  writeJsonAtomic
};
