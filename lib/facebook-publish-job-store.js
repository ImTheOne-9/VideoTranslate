const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateFacebookSchedule } = require('./facebook-scheduling');

function writeAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

class FacebookPublishJobStore {
  constructor(filePath) { this.filePath = filePath; }
  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(data.jobs)) throw new Error('Kho tác vụ Facebook không hợp lệ');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, jobs: [] };
      throw new Error(`Không đọc được kho tác vụ Facebook; dừng để tránh đăng trùng: ${error.message}`);
    }
  }
  list(options = {}) {
    let jobs = this.read().jobs;
    if (options.status) jobs = jobs.filter((job) => job.status === options.status);
    return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Number(options.limit || 200));
  }
  get(id) { return this.read().jobs.find((job) => job.id === id) || null; }
  create(input) {
    const data = this.read();
    if (input.idempotencyKey) {
      const existing = data.jobs.find((job) => job.idempotencyKey === input.idempotencyKey);
      if (existing) return { job: existing, duplicate: true };
    }
    const now = new Date().toISOString();
    if (input.scheduleMode === 'facebook') validateFacebookSchedule(input.type, input.scheduledAt);
    const job = {
      id: crypto.randomUUID(), status: 'queued', percent: 0, attempt: 0, maxAttempts: Number(input.maxAttempts || 3),
      createdAt: now, updatedAt: now, scheduledAt: input.scheduledAt || now,
      scheduleMode: input.scheduleMode || 'local',
      nextAttemptAt: input.scheduleMode === 'facebook' ? now : input.scheduledAt || now,
      accountId: input.accountId, pageId: input.pageId || null, type: input.type || 'reel',
      videoPath: input.videoPath || null, message: input.message || '', title: input.title || '', firstComment: input.firstComment || '',
      sourceRenderTaskId: input.sourceRenderTaskId || null, idempotencyKey: input.idempotencyKey || null,
      platformWorkId: null, mediaId: null, upload: null, statusChecks: 0,
      permalink: null, media: null, warning: null, error: null, errorCode: null
    };
    data.jobs.push(job); writeAtomic(this.filePath, data);
    return { job, duplicate: false };
  }
  update(id, changes) {
    const data = this.read();
    const index = data.jobs.findIndex((job) => job.id === id);
    if (index < 0) return null;
    data.jobs[index] = { ...data.jobs[index], ...changes, updatedAt: new Date().toISOString() };
    writeAtomic(this.filePath, data); return data.jobs[index];
  }
  removeOld(max = 1000) {
    const data = this.read();
    if (data.jobs.length <= max) return;
    // Never discard unfinished/uncertain jobs and their resume IDs.
    const active = data.jobs.filter((job) => !['published', 'cancelled'].includes(job.status));
    const history = data.jobs.filter((job) => ['published', 'cancelled'].includes(job.status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.max(0, max - active.length));
    data.jobs = [...active, ...history];
    writeAtomic(this.filePath, data);
  }
}

module.exports = { FacebookPublishJobStore };
