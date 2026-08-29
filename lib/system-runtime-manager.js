'use strict';

const { CrawlerRuntimeManager } = require('./crawler-runtime-manager');

// Một runtime Python dùng chung cho ASR, OCR, Piper và MediaCrawler. Giữ class/đường
// dẫn crawler cũ để máy đã cài không phải tải lại, nhưng mọi feature dùng cùng singleton.
const systemRuntimeManager = new CrawlerRuntimeManager();

module.exports = { systemRuntimeManager };
