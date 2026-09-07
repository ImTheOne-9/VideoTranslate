'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createSourceCacheKey,
  lockPathForKey,
  releaseSourceCacheLock,
  restoreSourceCache,
  saveSourceCache,
  tryAcquireSourceCacheLock
} = require('../lib/subtitle-source-cache');

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-cache-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('source cache key follows video content and recognition options', async () => {
  await withTempDirectory(async (directory) => {
    const videoPath = path.join(directory, 'video.mp4');
    await fs.writeFile(videoPath, 'same-video-content');
    const base = {
      videoPath,
      durationMs: 12_000,
      sourceLanguage: 'ch',
      whisperModel: 'large-v3-turbo',
      ocrPipeline: 'viral',
      capcutAsrEnabled: true
    };
    const first = await createSourceCacheKey(base);
    const same = await createSourceCacheKey({ ...base });
    const changed = await createSourceCacheKey({ ...base, sourceLanguage: 'vi' });
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, same);
    assert.notEqual(first, changed);
  });
});

test('source cache restores SRT, ASR metadata and OCR report into another work directory', async () => {
  await withTempDirectory(async (directory) => {
    const root = path.join(directory, 'cache');
    const sourceWork = path.join(directory, 'work-a');
    const targetWork = path.join(directory, 'work-b');
    await fs.mkdir(sourceWork, { recursive: true });
    const sourcePath = path.join(sourceWork, 'source.srt');
    await fs.writeFile(sourcePath, '1\n00:00:00,000 --> 00:00:01,000\n第一句\n', 'utf8');
    await fs.writeFile(`${sourcePath}.asr.json`, JSON.stringify({ engineId: 'capcut-asr' }), 'utf8');
    await fs.writeFile(path.join(sourceWork, 'ocr-report.json'), JSON.stringify({ cueCount: 1 }), 'utf8');
    const key = 'a'.repeat(64);
    assert.equal(await saveSourceCache(key, {
      path: sourcePath,
      source: 'capcut-asr',
      language: 'ch',
      cueCount: 1,
      reason: 'capcut_audio_preferred'
    }, sourceWork, { root }), true);

    const restored = await restoreSourceCache(key, targetWork, { root });
    assert.equal(restored.cached, true);
    assert.equal(restored.reason, 'source_cache_hit');
    assert.equal(restored.cachedReason, 'capcut_audio_preferred');
    assert.match(await fs.readFile(restored.path, 'utf8'), /第一句/u);
    assert.equal(JSON.parse(await fs.readFile(`${restored.path}.asr.json`, 'utf8')).engineId, 'capcut-asr');
    assert.equal(JSON.parse(await fs.readFile(path.join(targetWork, 'ocr-report.json'), 'utf8')).cueCount, 1);
  });
});

test('source cache preserves explicit no-speech without creating an empty SRT', async () => {
  await withTempDirectory(async (directory) => {
    const root = path.join(directory, 'cache');
    const workDir = path.join(directory, 'work');
    await fs.mkdir(workDir, { recursive: true });
    const key = 'b'.repeat(64);
    assert.equal(await saveSourceCache(key, {
      path: null,
      source: 'capcut-asr',
      language: 'ch',
      cueCount: 0,
      reason: 'capcut_no_speech',
      noSpeech: true
    }, workDir, { root }), true);
    const restored = await restoreSourceCache(key, path.join(directory, 'target'), { root });
    assert.equal(restored.path, null);
    assert.equal(restored.noSpeech, true);
    assert.equal(restored.cached, true);
  });
});

test('cross-process cache lock is atomic and release is guarded by its owner token', async () => {
  await withTempDirectory(async (root) => {
    const key = 'c'.repeat(64);
    const first = await tryAcquireSourceCacheLock(key, { root });
    assert.ok(first?.token);
    assert.equal(await tryAcquireSourceCacheLock(key, { root }), null);

    const foreign = { ...first, token: `${process.pid}-foreign` };
    assert.equal(await releaseSourceCacheLock(foreign), false);
    await fs.stat(lockPathForKey(key, root));

    assert.equal(await releaseSourceCacheLock(first), true);
    const second = await tryAcquireSourceCacheLock(key, { root });
    assert.ok(second?.token);
    assert.notEqual(second.token, first.token);
    assert.equal(await releaseSourceCacheLock(second), true);
  });
});
