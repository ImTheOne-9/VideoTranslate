const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NarrationFitError,
  generateNarrationWithinCue
} = require('../lib/narration-fit-service');

test('keeps narration unchanged when no more than 2x is required', async () => {
  let synthesized = 0;
  const result = await generateNarrationWithinCue({
    initialText: 'Câu vừa đủ',
    startMs: 0,
    endMs: 2000,
    createSignature: (text) => text,
    synthesize: async () => { synthesized += 1; },
    measureDuration: async () => 2900,
    shortenText: async () => assert.fail('must not shorten')
  });

  assert.equal(result.fitPlan.speed, 1.488);
  assert.equal(result.shortened, false);
  assert.equal(synthesized, 1);
});

test('shortens by measured duration and synthesizes again until narration fits', async () => {
  const durations = [5000, 2800];
  const calls = [];
  const result = await generateNarrationWithinCue({
    initialText: 'Một câu thuyết minh rất dài',
    startMs: 0,
    endMs: 2000,
    createSignature: (text) => text,
    synthesize: async (text) => calls.push(['synthesize', text]),
    measureDuration: async () => durations.shift(),
    shortenText: async (request) => {
      calls.push(['shorten', request.targetDurationMs]);
      return 'Câu thuyết minh ngắn';
    }
  });

  assert.equal(result.text, 'Câu thuyết minh ngắn');
  assert.equal(result.attempts, 1);
  assert.equal(result.shortened, true);
  assert.ok(result.fitPlan.speed <= 1.5);
  assert.deepEqual(calls, [
    ['synthesize', 'Một câu thuyết minh rất dài'],
    ['shorten', 3900],
    ['synthesize', 'Câu thuyết minh ngắn']
  ]);
});

test('continues beyond two shortening attempts until narration fits', async () => {
  const durations = [5000, 4200, 3400, 2600, 1800];
  const result = await generateNarrationWithinCue({
    initialText: 'abcdefghij',
    startMs: 0,
    endMs: 1000,
    createSignature: (text) => text,
    synthesize: async () => {},
    measureDuration: async () => durations.shift(),
    shortenText: async ({ text }) => text.slice(0, -1)
  });

  assert.equal(result.attempts, 4);
  assert.equal(result.text, 'abcdef');
  assert.ok(result.fitPlan.speed <= 2);
});

test('stops safely when AI cannot make the narration shorter', async () => {
  await assert.rejects(
    generateNarrationWithinCue({
      initialText: 'Câu vẫn quá dài',
      startMs: 0,
      endMs: 1000,
      createSignature: (text) => text,
      synthesize: async () => {},
      measureDuration: async () => 4000,
      shortenText: async ({ text }) => text
    }),
    (error) => error instanceof NarrationFitError
      && error.code === 'NARRATION_TOO_LONG'
      && /không thể rút gọn thêm/i.test(error.message)
  );
});
