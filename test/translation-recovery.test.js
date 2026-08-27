const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTranslationCheckpoint,
  createTranslationIncompleteError,
  fallbackFailedItemsWithNllb,
  getTranslationPrompt,
  resolveGlobalTranslationContext,
  translateJsonBatchesWithCheckpoint,
  validateTranslationCandidate,
  validateTranslationMap
} = require('../lib/translate-sub');
const { applyRenderTaskFailure } = require('../controllers/studioController');

async function tempOutput(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'translation-recovery-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return path.join(root, 'translated.srt');
}

test('translation validation rejects missing, unchanged and source-language output', () => {
  assert.deepEqual(
    validateTranslationMap(
      { 1: '原来爱一个人真的能为他而死', 2: '她是全剧最让人心疼的人' },
      { 1: 'Hóa ra yêu một người thật sự có thể chết vì người ấy.' },
      { srcLang: 'zho_Hans', targetLang: 'vi' }
    ).failures,
    [{ id: '2', reason: 'empty_translation' }]
  );
  assert.equal(
    validateTranslationCandidate(
      '原来爱一个人真的能为他而死',
      '原来爱一个人真的能为他而死',
      { srcLang: 'zho_Hans', targetLang: 'vi' }
    ).reason,
    'unchanged_from_source'
  );
  assert.equal(
    validateTranslationCandidate(
      '她是全剧最让人心疼的人',
      '她是全剧最让人心疼的角色',
      { srcLang: 'zho_Hans', targetLang: 'vi' }
    ).reason,
    'source_language_remaining'
  );
  assert.equal(
    validateTranslationCandidate('Mine', 'Mine', {
      srcLang: 'eng_Latn',
      targetLang: 'vi'
    }).valid,
    true,
    'a proper name may legitimately remain unchanged'
  );
});

test('translation validation rescues a few residual Han characters before checkpointing', () => {
  const result = validateTranslationCandidate(
    '这是一种剑技',
    'Đây là một 技 kiếm thuật mạnh.',
    { srcLang: 'zho_Hans', targetLang: 'vi' }
  );
  assert.equal(result.valid, true);
  assert.equal(result.text, 'Đây là một kiếm thuật mạnh.');
  assert.equal(validateTranslationCandidate(
    '这是一种剑技',
    '这是剑技 tuyệt đỉnh',
    { srcLang: 'zho_Hans', targetLang: 'vi' }
  ).reason, 'source_language_remaining');
});

test('Vietnamese JSON translation prompt has Chinese proper-name rules without leaking them to other targets', () => {
  const map = { 1: { text: '王明去了北京', durationSec: 2 } };
  const vietnamese = getTranslationPrompt(map, 'Tiếng Việt');
  const english = getTranslationPrompt(map, 'Tiếng Anh');
  assert.match(vietnamese, /王明 → Vương Minh/);
  assert.match(vietnamese, /北京 → Bắc Kinh/);
  assert.doesNotMatch(english, /王明 → Vương Minh/);
});

test('translation checkpoint resumes only failed cues and never stores API keys', async (t) => {
  const outputPath = await tempOutput(t);
  const sourceText = '1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n'
    + '2\n00:00:01,000 --> 00:00:02,000\n第二句\n';
  const items = [
    { id: '1', text: '第一句' },
    { id: '2', text: '第二句' }
  ];
  const sourceById = { 1: '第一句', 2: '第二句' };
  const checkpoint = createTranslationCheckpoint(outputPath, {
    sourceText,
    targetLang: 'vi',
    geminiApiKey: 'must-not-be-stored'
  });
  const firstCalls = [];
  const first = await translateJsonBatchesWithCheckpoint({
    srtArray: items,
    sourceById,
    checkpoint,
    providerName: 'Gemini',
    targetLang: 'vi',
    srcLang: 'zho_Hans',
    retryFailedRounds: 0,
    translateBatch: async (map) => {
      firstCalls.push(Object.keys(map));
      return { 1: 'Câu thứ nhất' };
    }
  });
  assert.equal(first.failedItems.length, 1);
  assert.deepEqual(firstCalls, [['1', '2']]);

  const savedText = await fs.promises.readFile(checkpoint.checkpointPath, 'utf8');
  assert.doesNotMatch(savedText, /must-not-be-stored/);
  assert.equal(JSON.parse(savedText).entries['1'].status, 'success');
  assert.equal(JSON.parse(savedText).entries['2'].status, 'error');

  const resumedItems = [
    { id: '1', text: '第一句' },
    { id: '2', text: '第二句' }
  ];
  const resumed = createTranslationCheckpoint(outputPath, {
    sourceText,
    targetLang: 'vi'
  });
  const resumedCalls = [];
  const second = await translateJsonBatchesWithCheckpoint({
    srtArray: resumedItems,
    sourceById,
    checkpoint: resumed,
    providerName: 'OpenRouter',
    targetLang: 'vi',
    srcLang: 'zho_Hans',
    translateBatch: async (map) => {
      resumedCalls.push(Object.keys(map));
      return { 2: 'Câu thứ hai' };
    }
  });
  assert.equal(second.failedItems.length, 0);
  assert.deepEqual(resumedCalls, [['2']]);
  assert.equal(resumedItems[0].text, 'Câu thứ nhất');
  assert.equal(resumedItems[1].text, 'Câu thứ hai');
});

test('failed cues retry automatically with the selected provider in progressively smaller batches', async (t) => {
  const outputPath = await tempOutput(t);
  const items = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' },
    { id: '2', startTime: '00:00:01,000', endTime: '00:00:02,000', text: '第二句' },
    { id: '3', startTime: '00:00:02,000', endTime: '00:00:03,000', text: '第三句' }
  ];
  const sourceById = { 1: '第一句', 2: '第二句', 3: '第三句' };
  const checkpoint = createTranslationCheckpoint(outputPath, {
    sourceText: Object.values(sourceById).join('\n'),
    targetLang: 'vi'
  });
  const calls = [];
  const sharedContext = { summary: 'Ngữ cảnh chung' };

  const result = await translateJsonBatchesWithCheckpoint({
    srtArray: items,
    sourceById,
    checkpoint,
    providerName: 'Gemini Web',
    targetLang: 'vi',
    srcLang: 'zho_Hans',
    batchSize: 4,
    batchDelayMs: 0,
    retryFailedRounds: 2,
    globalContext: sharedContext,
    translateBatch: async (map, previous, context) => {
      const ids = Object.keys(map);
      calls.push({ ids, context });
      if (calls.length === 1) return { 1: 'Câu thứ nhất' };
      if (calls.length === 2) return { 2: 'Câu thứ hai' };
      return { 3: 'Câu thứ ba' };
    }
  });

  assert.deepEqual(calls.map((call) => call.ids), [['1', '2', '3'], ['2', '3'], ['3']]);
  assert.ok(calls.every((call) => call.context === sharedContext));
  assert.equal(result.failedItems.length, 0);
  assert.deepEqual(items.map((item) => item.text), ['Câu thứ nhất', 'Câu thứ hai', 'Câu thứ ba']);
  assert.equal(checkpoint.report(3).fallbackUsed, 0);
  assert.ok(Object.values(checkpoint.checkpoint.entries).every((entry) => entry.provider === 'Gemini Web'));
});

test('changing source invalidates a stale translation checkpoint', async (t) => {
  const outputPath = await tempOutput(t);
  const first = createTranslationCheckpoint(outputPath, {
    sourceText: 'old source',
    targetLang: 'vi'
  });
  first.success({ id: 1, text: 'old source' }, 'bản dịch cũ', 'Gemini');
  first.save();

  const changed = createTranslationCheckpoint(outputPath, {
    sourceText: 'new source',
    targetLang: 'vi'
  });
  assert.deepEqual(changed.checkpoint.entries, {});
});

test('whole-SRT analysis is checkpointed and reused without storing credentials', async (t) => {
  const outputPath = await tempOutput(t);
  const checkpoint = createTranslationCheckpoint(outputPath, {
    sourceText: 'full subtitle source',
    targetLang: 'vi'
  });
  const srtArray = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' },
    { id: '2', startTime: '00:00:01,000', endTime: '00:00:02,000', text: '第二句' }
  ];
  let calls = 0;
  const analyze = async (prompt) => {
    calls += 1;
    assert.match(prompt, /第一句/);
    assert.match(prompt, /第二句/);
    return {
      summary: 'Câu chuyện thử nghiệm',
      characters: [{ name: 'Nhân vật A', gender: 'không rõ', role: 'nhân vật chính' }],
      terminology: [{ source: '术语', target: 'thuật ngữ' }],
      tone: 'Trung tính',
      translationRules: ['Giữ nhất quán xưng hô']
    };
  };

  const first = await resolveGlobalTranslationContext({
    checkpoint,
    analysisKey: 'provider:model',
    srtArray,
    targetLangName: 'Tiếng Việt',
    analyze
  });
  const second = await resolveGlobalTranslationContext({
    checkpoint,
    analysisKey: 'provider:model',
    srtArray,
    targetLangName: 'Tiếng Việt',
    analyze
  });

  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  const savedText = await fs.promises.readFile(checkpoint.checkpointPath, 'utf8');
  assert.match(savedText, /Câu chuyện thử nghiệm/);
  assert.doesNotMatch(savedText, /apiKey|Authorization|Bearer/i);
});

test('every translation batch receives the shared whole-SRT context', async (t) => {
  const outputPath = await tempOutput(t);
  const items = [
    { id: '1', startTime: '00:00:00,000', endTime: '00:00:01,000', text: '第一句' },
    { id: '2', startTime: '00:00:01,000', endTime: '00:00:02,000', text: '第二句' },
    { id: '3', startTime: '00:00:02,000', endTime: '00:00:03,000', text: '第三句' }
  ];
  const sourceById = { 1: '第一句', 2: '第二句', 3: '第三句' };
  const checkpoint = createTranslationCheckpoint(outputPath, {
    sourceText: Object.values(sourceById).join('\n'),
    targetLang: 'vi'
  });
  const globalContext = { summary: 'Ngữ cảnh dùng chung' };
  const received = [];

  const result = await translateJsonBatchesWithCheckpoint({
    srtArray: items,
    sourceById,
    checkpoint,
    providerName: 'Test AI',
    targetLang: 'vi',
    srcLang: 'zho_Hans',
    batchSize: 2,
    batchDelayMs: 0,
    globalContext,
    translateBatch: async (map, previous, shared) => {
      received.push({ ids: Object.keys(map), previous, shared });
      return Object.fromEntries(Object.keys(map).map((id) => [id, `Bản dịch ${id}`]));
    }
  });

  assert.equal(result.failedItems.length, 0);
  assert.deepEqual(received.map((entry) => entry.ids), [['1', '2'], ['3']]);
  assert.ok(received.every((entry) => entry.shared === globalContext));
  assert.equal(received[1].previous.length, 2);
});

test('NLLB fallback receives and replaces only failed cues', async (t) => {
  const outputPath = await tempOutput(t);
  const parser = new (require('srt-parser-2').default)();
  const checkpoint = createTranslationCheckpoint(outputPath, {
    sourceText: 'source',
    targetLang: 'vi'
  });
  const items = [
    {
      id: '1',
      startTime: '00:00:00,000',
      endTime: '00:00:01,000',
      text: 'Câu đã dịch'
    },
    {
      id: '2',
      startTime: '00:00:01,000',
      endTime: '00:00:02,000',
      text: '第二句'
    }
  ];
  const calls = [];
  const remaining = await fallbackFailedItemsWithNllb({
    failedItems: [{ item: items[1], source: '第二句', reason: 'missing_id' }],
    checkpoint,
    outputPath,
    parser,
    srcLang: 'zho_Hans',
    targetLang: 'vi',
    nllbTargetLang: 'vie_Latn',
    translateNllb: async (inputPath, translatedPath) => {
      const input = parser.fromSrt(await fs.promises.readFile(inputPath, 'utf8'));
      calls.push(input.map((item) => item.text));
      input[0].text = 'Câu thứ hai';
      await fs.promises.writeFile(translatedPath, parser.toSrt(input), 'utf8');
    }
  });

  assert.deepEqual(calls, [['第二句']]);
  assert.deepEqual(remaining, []);
  assert.equal(items[0].text, 'Câu đã dịch');
  assert.equal(items[1].text, 'Câu thứ hai');
  assert.equal(checkpoint.report(2).fallbackUsed, 1);
});

test('translation incomplete error produces a resumable queue state with report', () => {
  const stats = {
    total: 10,
    translated: 7,
    failed: 3,
    fallbackUsed: 2,
    failedCueIds: ['8', '9', '10']
  };
  const error = createTranslationIncompleteError(stats);
  const task = { id: 'task-1', status: 'rendering', percent: 35 };
  const state = {
    isStudioRendering: true,
    activeRenderId: 'task-1',
    currentActiveTask: task,
    studioProgress: {}
  };

  assert.equal(applyRenderTaskFailure(task, error, state), 'error');
  assert.equal(task.status, 'error');
  assert.equal(task.actionRequired, 'render_resume');
  assert.equal(task.step, 'Dịch phụ đề chưa hoàn tất (7/10)');
  assert.deepEqual(task.translationReport.translation, stats);
});

test('translation recovery UI reports progress and NLLB fallback usage', () => {
  const appJs = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appJs, /Đã dịch \$\{translated\}\/\$\{total\} câu/);
  assert.match(appJs, /câu đã dùng NLLB dự phòng/);
});
