'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createCheckpointSignature } = require('./checkpoint-utils');
const { getCrawlerPaths } = require('./crawler-paths');

const CACHE_VERSION = 1;
const inFlight = new Map();
const fileHashMemo = new Map();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cacheRoot() {
  return path.join(getCrawlerPaths().runtimeRoot, 'subtitle_source_cache');
}

async function hashFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) return null;
  const identity = `${path.resolve(filePath)}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  if (fileHashMemo.has(identity)) return fileHashMemo.get(identity);
  const promise = new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
  fileHashMemo.set(identity, promise);
  try {
    return await promise;
  } catch (error) {
    fileHashMemo.delete(identity);
    throw error;
  }
}

async function createSourceCacheKey(options = {}) {
  let videoHash;
  try {
    videoHash = await hashFile(options.videoPath);
  } catch {
    return null;
  }
  if (!videoHash) return null;
  return createCheckpointSignature({
    version: CACHE_VERSION,
    videoHash,
    durationMs: Math.round(Number(options.durationMs) || 0),
    sourceLanguage: String(options.sourceLanguage || options.ocrLanguage || 'auto'),
    whisperModel: String(options.whisperModel || ''),
    whisperBackend: String(options.whisperBackend || ''),
    whisperTimestampLevel: String(options.whisperTimestampLevel || ''),
    whisperDevice: String(options.whisperDevice || 'auto'),
    ocrPipeline: String(options.ocrPipeline || 'auto'),
    ocrMode: String(options.ocrMode || 'auto'),
    forceWhisper: options.forceWhisper === true,
    ocrOnly: options.ocrOnly === true,
    capcutAsrEnabled: options.capcutAsrEnabled === true,
    hybridWhisperFill: options.hybridWhisperFill === true,
    ocrAlgorithm: 'viral-2026-09-04',
    routingAlgorithm: 'viral-capcut-first-v1'
  });
}

function directoryForKey(key, root = cacheRoot()) {
  if (!/^[a-f0-9]{64}$/i.test(String(key || ''))) return null;
  return path.join(root, key.slice(0, 2), key);
}

function lockPathForKey(key, root = cacheRoot()) {
  const directory = directoryForKey(key, root);
  return directory ? `${directory}.lock` : null;
}

function parseLockPid(token) {
  const pid = Number.parseInt(String(token || '').split('-')[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function ownerIsDefinitelyDead(token) {
  const pid = parseLockPid(token);
  if (!pid || pid === process.pid) return false;
  try {
    // In Node, signal 0 only checks whether the process exists; it does not kill it.
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

async function readLock(lockPath) {
  try {
    const [token, stat] = await Promise.all([
      fsp.readFile(lockPath, 'utf8'),
      fsp.stat(lockPath)
    ]);
    return { token: String(token || '').trim(), stat };
  } catch {
    return null;
  }
}

async function removeLockIfOwned(lockPath, token) {
  try {
    const current = String(await fsp.readFile(lockPath, 'utf8')).trim();
    if (current !== token) return false;
    await fsp.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function tryAcquireSourceCacheLock(key, options = {}) {
  const root = options.root || cacheRoot();
  const lockPath = lockPathForKey(key, root);
  if (!lockPath) return null;
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const configuredStaleMs = Number(options.staleMs ?? process.env.SUBTITLE_CACHE_LOCK_TTL_MS);
  const staleMs = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0
    ? configuredStaleMs
    : 180_000;
  const current = await readLock(lockPath);
  if (current) {
    const stale = Date.now() - current.stat.mtimeMs > staleMs;
    if (stale || ownerIsDefinitelyDead(current.token)) {
      await removeLockIfOwned(lockPath, current.token);
    }
  }
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  let handle;
  try {
    handle = await fsp.open(lockPath, 'wx');
    await handle.writeFile(token, 'utf8');
    return { key, lockPath, token };
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    return { key, lockPath: null, token: null, failSafe: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function touchSourceCacheLock(lock) {
  if (!lock?.lockPath || !lock.token) return false;
  try {
    const current = String(await fsp.readFile(lock.lockPath, 'utf8')).trim();
    if (current !== lock.token) return false;
    const now = new Date();
    await fsp.utimes(lock.lockPath, now, now);
    return true;
  } catch {
    return false;
  }
}

async function releaseSourceCacheLock(lock) {
  if (!lock?.lockPath || !lock.token) return false;
  return removeLockIfOwned(lock.lockPath, lock.token);
}

async function readManifest(key, options = {}) {
  const directory = directoryForKey(key, options.root || cacheRoot());
  if (!directory) return null;
  try {
    const value = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    return value?.version === CACHE_VERSION && value?.key === key ? { directory, value } : null;
  } catch {
    return null;
  }
}

async function restoreSourceCache(key, workDir, options = {}) {
  const found = await readManifest(key, options);
  if (!found) return null;
  const { directory, value } = found;
  await fsp.mkdir(workDir, { recursive: true });
  if (value.noSpeech === true) {
    return {
      ...value.result,
      path: null,
      noSpeech: true,
      cached: true,
      cachedReason: value.result?.reason || null,
      reason: 'source_cache_hit'
    };
  }
  const sourcePath = path.join(directory, 'source.srt');
  try {
    if ((await fsp.stat(sourcePath)).size <= 0) return null;
  } catch {
    return null;
  }
  const outputPath = path.join(workDir, 'cached-source.srt');
  await fsp.copyFile(sourcePath, outputPath);
  for (const [cacheName, outputName] of [
    ['source.asr.json', `${outputPath}.asr.json`],
    ['ocr-report.json', path.join(workDir, 'ocr-report.json')]
  ]) {
    try {
      await fsp.copyFile(path.join(directory, cacheName), outputName);
    } catch {}
  }
  return {
    ...value.result,
    path: outputPath,
    cached: true,
    cachedReason: value.result?.reason || null,
    reason: 'source_cache_hit'
  };
}

async function saveSourceCache(key, result, workDir, options = {}) {
  const directory = directoryForKey(key, options.root || cacheRoot());
  if (!directory || !result) return false;
  const parent = path.dirname(directory);
  await fsp.mkdir(parent, { recursive: true });
  const temporary = `${directory}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(temporary, { recursive: true });
  try {
    if (result.path) {
      const stat = await fsp.stat(result.path);
      if (!stat.isFile() || stat.size <= 0) return false;
      await fsp.copyFile(result.path, path.join(temporary, 'source.srt'));
      try {
        await fsp.copyFile(`${result.path}.asr.json`, path.join(temporary, 'source.asr.json'));
      } catch {}
    } else if (result.noSpeech !== true) {
      return false;
    }
    try {
      await fsp.copyFile(path.join(workDir, 'ocr-report.json'), path.join(temporary, 'ocr-report.json'));
    } catch {}
    const safeResult = {
      source: result.source || 'unknown',
      language: result.language || null,
      cueCount: Number(result.cueCount) || 0,
      removedWatermarks: Number(result.removedWatermarks) || 0,
      reason: result.reason || null,
      languageConfidence: result.languageConfidence ?? null,
      languageEvidence: result.languageEvidence || null,
      online: result.online === true,
      uploadedAudio: result.uploadedAudio === true,
      noSpeech: result.noSpeech === true
    };
    await fsp.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({
      version: CACHE_VERSION,
      key,
      createdAt: new Date().toISOString(),
      noSpeech: result.noSpeech === true,
      result: safeResult
    }, null, 2), 'utf8');
    try {
      await fsp.rm(directory, { recursive: true, force: true });
    } catch {}
    await fsp.rename(temporary, directory);
    return true;
  } catch {
    return false;
  } finally {
    try {
      await fsp.rm(temporary, { recursive: true, force: true });
    } catch {}
  }
}

async function withInFlightSource(key, operation) {
  if (!key) return operation();
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve().then(operation);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }
}

async function withSourceCacheLock(key, operation, options = {}) {
  if (!key) return operation();
  return withInFlightSource(key, async () => {
    const startedAt = Date.now();
    const configuredWaitMs = Number(options.waitMs ?? process.env.SUBTITLE_CACHE_WAIT_MS);
    const waitMs = Number.isFinite(configuredWaitMs) && configuredWaitMs >= 0
      ? configuredWaitMs
      : 1_800_000;
    const configuredHardMaxMs = Number(options.hardMaxMs ?? process.env.SUBTITLE_CACHE_LOCK_HARD_MAX_MS);
    const hardMaxMs = Number.isFinite(configuredHardMaxMs) && configuredHardMaxMs >= 0
      ? configuredHardMaxMs
      : 1_200_000;
    const configuredPollMs = Number(options.pollMs);
    const pollMs = Number.isFinite(configuredPollMs) && configuredPollMs > 0 ? configuredPollMs : 3_000;
    let announcedWait = false;

    while (true) {
      if (typeof options.readAvailable === 'function') {
        const available = await options.readAvailable();
        if (available) return available;
      }
      const lock = await tryAcquireSourceCacheLock(key, options);
      if (lock) {
        if (lock.failSafe) return operation();
        const configuredHeartbeatMs = Number(options.heartbeatMs);
        const heartbeatMs = Number.isFinite(configuredHeartbeatMs) && configuredHeartbeatMs > 0
          ? configuredHeartbeatMs
          : 30_000;
        const heartbeat = setInterval(() => {
          touchSourceCacheLock(lock).catch(() => {});
        }, heartbeatMs);
        heartbeat.unref?.();
        try {
          return await operation();
        } finally {
          clearInterval(heartbeat);
          await releaseSourceCacheLock(lock);
        }
      }

      if (!announcedWait) {
        announcedWait = true;
        try { options.onWait?.(); } catch {}
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= waitMs || (hardMaxMs > 0 && elapsed >= hardMaxMs)) {
        // ViralCrawl's fail-safe: duplicated work is preferable to an indefinitely stuck queue.
        return operation();
      }
      await sleep(Math.min(pollMs, Math.max(1, waitMs - elapsed)));
    }
  });
}

module.exports = {
  CACHE_VERSION,
  cacheRoot,
  createSourceCacheKey,
  directoryForKey,
  hashFile,
  lockPathForKey,
  releaseSourceCacheLock,
  restoreSourceCache,
  saveSourceCache,
  touchSourceCacheLock,
  tryAcquireSourceCacheLock,
  withSourceCacheLock,
  withInFlightSource
};
