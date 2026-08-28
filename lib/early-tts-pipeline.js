'use strict';

const fs = require('fs');
const path = require('path');
const { createCheckpointSignature } = require('./checkpoint-utils');
const { normalizePiperTtsText, normalizeTtsText } = require('./tts-text-normalizer');
const { preparePiperCueText } = require('./adaptive-dubbing-pipeline');

class EarlyTtsPipeline {
  constructor(options = {}) {
    this.engine = options.engine;
    this.workDir = path.resolve(options.workDir);
    this.voice = options.voice || '';
    this.language = options.language || 'vi';
    this.device = options.device || 'auto';
    this.enabled = options.enabled !== false && process.env.TTS_SOM !== '0';
    this.logger = options.logger || console;
    this.entries = new Map();
    this.pending = new Set();
    this.cancelled = false;
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  signature(item, text) {
    return createCheckpointSignature({
      version: 1,
      engine: this.engine?.id,
      text,
      voice: this.voice,
      language: this.language,
      device: this.device
    });
  }

  prepareText(item, nextItem = null) {
    const normalized = this.engine?.id === 'piper'
      ? normalizePiperTtsText(item.text, { language: this.language })
      : normalizeTtsText(item.text, { language: this.language });
    if (this.engine?.id !== 'piper') return normalized;
    return preparePiperCueText(normalized, nextItem, {
      currentEndMs: item.endMs,
      nextStartMs: nextItem?.startMs,
      currentId: item.id,
      nextId: nextItem?.id
    });
  }

  enqueue(items = []) {
    if (!this.enabled || this.cancelled || !this.engine || !Array.isArray(items)) return;
    const batchEntries = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item?.text) continue;
      const next = items[index + 1] || (item.nextId ? {
        id: item.nextId,
        startMs: item.nextStartMs
      } : null);
      const prepared = {
        ...item,
        startMs: item.startMs ?? 0,
        endMs: item.endMs ?? 0
      };
      const text = this.prepareText(prepared, next);
      if (!text) continue;
      const signature = this.signature(item, text);
      const key = signature;
      if (this.entries.has(key)) continue;
      const outputPath = path.join(this.workDir, `cue_${signature}.wav`);
      if (this.engine.id === 'capcut-tts') {
        batchEntries.push({ item, text, signature, key, outputPath });
        continue;
      }
      const promise = this.engine.synthesize({
        text,
        outputPath,
        voice: this.voice,
        language: this.language,
        device: this.device,
        lengthScale: 0.8
      }).then(() => {
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 44) {
          throw new Error('WAV đọc sớm rỗng');
        }
        this.entries.set(key, { key, signature, text, outputPath, item: { ...item } });
      }).catch(error => {
        this.logger.warn(`[TTS đọc sớm] Cue ${item.id} lỗi: ${error.message}`);
        try { fs.rmSync(outputPath, { force: true }); } catch {}
      }).finally(() => this.pending.delete(promise));
      this.pending.add(promise);
    }
    if (batchEntries.length > 0) {
      const promise = this.engine.synthesizeBatch({
        items: batchEntries.map((entry) => ({
          key: entry.key,
          text: entry.text,
          outputPath: entry.outputPath,
          voice: this.voice,
          language: this.language,
          startMs: entry.item.startMs,
          endMs: entry.item.endMs,
          sequenceIndex: Number(entry.item.id)
        }))
      }).then((results) => {
        results.forEach((result, index) => {
          const entry = batchEntries[index];
          if (!result?.ok || !fs.existsSync(entry.outputPath) || fs.statSync(entry.outputPath).size <= 44) {
            this.logger.warn(
              `[TTS đọc sớm] CapCut cue ${entry.item.id} lỗi:`
              + ` ${result?.error?.message || 'audio rỗng'}`
            );
            try { fs.rmSync(entry.outputPath, { force: true }); } catch {}
            return;
          }
          this.entries.set(entry.key, { ...entry, item: { ...entry.item } });
        });
      }).catch((error) => {
        this.logger.warn(`[TTS đọc sớm] Lô CapCut lỗi: ${error.message}`);
      }).finally(() => this.pending.delete(promise));
      this.pending.add(promise);
    }
  }

  async drain() {
    await Promise.allSettled([...this.pending]);
    return this.entries.size;
  }

  restore(item, expectedText, outputPath) {
    const entry = this.entries.get(this.signature(item, expectedText));
    if (!entry || entry.text !== expectedText || !fs.existsSync(entry.outputPath)) return false;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(entry.outputPath, outputPath);
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 44;
  }

  async cancel() {
    this.cancelled = true;
    await this.engine?.cancel?.();
  }
}

module.exports = { EarlyTtsPipeline };
