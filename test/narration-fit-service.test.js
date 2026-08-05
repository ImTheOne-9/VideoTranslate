const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateNarrationWithinCue
} = require('../lib/narration-fit-service');

test('generates narration and creates fitPlan without AI shortening', async () => {
  let synthesized = 0;
  const result = await generateNarrationWithinCue({
    initialText: 'Một câu thoại rất dài vượt quá thời lượng cue',
    startMs: 0,
    endMs: 2000,
    createSignature: (text) => text,
    synthesize: async () => { synthesized += 1; },
    measureDuration: async () => 5000
  });

  assert.equal(result.text, 'Một câu thoại rất dài vượt quá thời lượng cue');
  assert.equal(result.fitPlan.status, 'sped_up');
  assert.equal(result.fitPlan.speed, 2.565);
  assert.equal(result.shortened, false);
  assert.equal(synthesized, 1);
});
