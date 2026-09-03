const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function fallbackKey() {
  let machine = `${require('os').hostname()}|${require('os').homedir()}`;
  try { machine = require('node-machine-id').machineIdSync({ original: true }); } catch {}
  return crypto.createHash('sha256').update(`video-studio-facebook|${machine}`).digest();
}

function createProtector() {
  try {
    const { safeStorage } = require('electron');
    if (safeStorage?.isEncryptionAvailable?.()) {
      return {
        type: 'electron-safe-storage',
        protect: (value) => safeStorage.encryptString(value).toString('base64'),
        unprotect: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
      };
    }
  } catch {}
  const key = fallbackKey();
  return {
    type: 'aes-256-gcm-machine',
    protect(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    unprotect(value) {
      const raw = Buffer.from(value, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}

class FacebookAccountStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.protector = options.protector || createProtector();
  }
  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed.accounts) ? parsed : { version: 1, accounts: [] };
    } catch { return { version: 1, accounts: [] }; }
  }
  publicAccount(account) {
    const { tokenEncrypted, ...safe } = account;
    return { ...safe, tokenStored: Boolean(tokenEncrypted), encryption: this.protector.type };
  }
  list() { return this.read().accounts.map((item) => this.publicAccount(item)); }
  get(id) {
    const account = this.read().accounts.find((item) => item.id === id || item.pageId === id);
    if (!account) return null;
    return { ...this.publicAccount(account), accessToken: this.protector.unprotect(account.tokenEncrypted) };
  }
  upsert(input) {
    if (!input.pageId || !input.accessToken) throw new Error('Thiếu Page ID hoặc Page Access Token');
    const data = this.read();
    const now = new Date().toISOString();
    const existingIndex = data.accounts.findIndex((item) => item.pageId === String(input.pageId));
    const existing = existingIndex >= 0 ? data.accounts[existingIndex] : null;
    const account = {
      id: existing?.id || crypto.randomUUID(), pageId: String(input.pageId),
      name: String(input.name || input.pageName || existing?.name || input.pageId),
      pageName: String(input.pageName || input.name || existing?.pageName || ''),
      avatar: input.avatar || existing?.avatar || null,
      fanCount: Number(input.fanCount ?? existing?.fanCount ?? 0),
      category: input.category || existing?.category || null,
      tasks: Array.isArray(input.tasks) ? input.tasks : (existing?.tasks || []),
      status: input.status || 'online', tokenEncrypted: this.protector.protect(String(input.accessToken)),
      tokenHint: String(input.accessToken).slice(-6), createdAt: existing?.createdAt || now, updatedAt: now
    };
    if (existingIndex >= 0) data.accounts[existingIndex] = account;
    else data.accounts.push(account);
    atomicWrite(this.filePath, data);
    return this.publicAccount(account);
  }
  markStatus(id, status, lastError = null) {
    const data = this.read();
    const account = data.accounts.find((item) => item.id === id || item.pageId === id);
    if (!account) return null;
    account.status = status; account.lastError = lastError; account.updatedAt = new Date().toISOString();
    atomicWrite(this.filePath, data);
    return this.publicAccount(account);
  }
  remove(id) {
    const data = this.read();
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((item) => item.id !== id && item.pageId !== id);
    if (data.accounts.length !== before) atomicWrite(this.filePath, data);
    return data.accounts.length !== before;
  }
}

module.exports = { FacebookAccountStore, createProtector };
