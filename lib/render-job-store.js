const fs = require('fs');
const path = require('path');

const MANIFEST_VERSION = 1;
const SENSITIVE_BODY_FIELDS = new Set([
  'geminiApiKey',
  'openRouterApiKey',
  'ninerouterApiKey'
]);

function assertTaskId(taskId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(taskId || ''))) {
    throw new Error('Mã tác vụ render không hợp lệ');
  }
  return String(taskId);
}

function sanitizeBody(body = {}) {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !SENSITIVE_BODY_FIELDS.has(key))
  );
}

function normalizeUiSnapshot(value, fallbackBody = {}) {
  let snapshot = null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    snapshot = value;
  } else if (typeof value === 'string' && value.length <= 256 * 1024) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snapshot = parsed;
    } catch {}
  }

  const safeSnapshot = sanitizeBody(snapshot || fallbackBody || {});
  delete safeSnapshot.uiSnapshot;
  delete safeSnapshot.__proto__;
  delete safeSnapshot.constructor;
  delete safeSnapshot.prototype;

  if (!safeSnapshot._sourceMode) {
    safeSnapshot._sourceMode = safeSnapshot.mainVideoFile ? 'library' : 'upload';
  }
  safeSnapshot._reactionMode ||= safeSnapshot.reactionMode || 'none';
  safeSnapshot._subMode ||= safeSnapshot.subtitleMode || 'none';
  safeSnapshot._voiceMode ||= safeSnapshot.voiceMode || 'none';
  safeSnapshot._musicMode ||= safeSnapshot.musicMode || 'none';

  if (typeof safeSnapshot.blurBoxes === 'string') {
    try {
      const boxes = JSON.parse(safeSnapshot.blurBoxes);
      safeSnapshot.blurBoxes = Array.isArray(boxes) ? boxes : [];
    } catch {
      safeSnapshot.blurBoxes = [];
    }
  } else if (!Array.isArray(safeSnapshot.blurBoxes)) {
    safeSnapshot.blurBoxes = [];
  }

  return safeSnapshot;
}

function serializeFiles(files = {}) {
  const serialized = {};
  for (const [field, entries] of Object.entries(files)) {
    if (!Array.isArray(entries)) continue;
    serialized[field] = entries.map((file) => ({
      fieldname: file.fieldname,
      originalname: file.originalname,
      encoding: file.encoding,
      mimetype: file.mimetype,
      filename: file.filename,
      path: file.path,
      size: file.size
    }));
  }
  return serialized;
}

class RenderJobStore {
  constructor(rootDir, dependencies = {}) {
    this.rootDir = rootDir;
    this.fs = dependencies.fs || fs;
    this.now = dependencies.now || (() => new Date());
  }

  ensureRoot() {
    this.fs.mkdirSync(this.rootDir, { recursive: true });
  }

  getJobDir(taskId) {
    return path.join(this.rootDir, assertTaskId(taskId));
  }

  getTaskDir(taskId) {
    return path.join(this.getJobDir(taskId), 'uploads');
  }

  getWorkDir(taskId) {
    return path.join(this.getJobDir(taskId), 'work');
  }

  getManifestPath(taskId) {
    return path.join(this.getJobDir(taskId), 'manifest.json');
  }

  ensureJob(taskId) {
    this.ensureRoot();
    this.fs.mkdirSync(this.getTaskDir(taskId), { recursive: true });
    this.fs.mkdirSync(this.getWorkDir(taskId), { recursive: true });
  }

  toManifest(task) {
    const now = this.now().toISOString();
    return {
      version: MANIFEST_VERSION,
      id: task.id,
      projectId: task.projectId || null,
      projectName: task.projectName,
      status: task.status,
      percent: Number(task.percent || 0),
      step: task.step || '',
      error: task.error || null,
      actionRequired: task.actionRequired || null,
      sourceVideoPath: task.sourceVideoPath || null,
      forceWhisper: task.forceWhisper === true,
      translationReport: task.translationReport || null,
      createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
      updatedAt: now,
      body: sanitizeBody(task.body),
      files: serializeFiles(task.files),
      taskDir: task.taskDir || this.getTaskDir(task.id),
      workDir: task.workDir || this.getWorkDir(task.id),
      result: task.result || null,
      currentStage: task.currentStage || null,
      stages: task.stages || {},
      uiSnapshot: normalizeUiSnapshot(task.uiSnapshot, task.body)
    };
  }

  saveTask(task) {
    this.ensureJob(task.id);
    const manifestPath = this.getManifestPath(task.id);
    const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    const manifest = this.toManifest(task);
    this.fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf8');
    this.fs.renameSync(tempPath, manifestPath);
    return manifest;
  }

  loadTask(taskId) {
    const manifestPath = this.getManifestPath(taskId);
    if (!this.fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(this.fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== MANIFEST_VERSION || manifest.id !== taskId) return null;
    return this.fromManifest(manifest);
  }

  fromManifest(manifest) {
    return {
      id: manifest.id,
      projectId: manifest.projectId || null,
      projectName: manifest.projectName || 'Dự án chưa đặt tên',
      status: manifest.status,
      percent: Number(manifest.percent || 0),
      step: manifest.step || '',
      error: manifest.error || null,
      actionRequired: manifest.actionRequired || null,
      sourceVideoPath: manifest.sourceVideoPath || null,
      forceWhisper: manifest.forceWhisper === true,
      translationReport: manifest.translationReport || null,
      createdAt: manifest.createdAt ? new Date(manifest.createdAt) : new Date(),
      body: manifest.body || {},
      files: manifest.files || {},
      taskDir: manifest.taskDir || this.getTaskDir(manifest.id),
      workDir: manifest.workDir || this.getWorkDir(manifest.id),
      result: manifest.result || null,
      currentStage: manifest.currentStage || null,
      stages: manifest.stages || {},
      uiSnapshot: normalizeUiSnapshot(manifest.uiSnapshot, manifest.body)
    };
  }

  loadUnfinishedTasks() {
    this.ensureRoot();
    const tasks = [];
    for (const name of this.fs.readdirSync(this.rootDir)) {
      try {
        const task = this.loadTask(name);
        if (!task || task.status === 'success') continue;
        if (task.status !== 'waiting_input' || task.actionRequired !== 'ocr_fallback') {
          task.status = 'waiting_input';
          task.actionRequired = 'render_resume';
          task.error = null;
          task.step = 'Tác vụ đã được khôi phục. Bấm Tiếp tục để render.';
        }
        tasks.push(task);
      } catch (error) {
        console.error(`[Render Job] Không thể đọc checkpoint ${name}:`, error.message);
      }
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  removeTask(taskId) {
    const jobDir = this.getJobDir(taskId);
    if (this.fs.existsSync(jobDir)) {
      this.fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  MANIFEST_VERSION,
  RenderJobStore,
  normalizeUiSnapshot,
  sanitizeBody,
  serializeFiles
};
