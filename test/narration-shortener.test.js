const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNarrationShorteningPrompt,
  getShorteningConstraints,
  selectBestCandidate,
  shortenNarrationText
} = require('../lib/narration-shortener');

test('shortening prompt uses the measured target and protects meaning', () => {
  const prompt = buildNarrationShorteningPrompt({
    text: 'Trong lúc vô cùng nguy cấp, anh ấy chạy đến cứu cô ấy.',
    currentDurationMs: 6000,
    targetDurationMs: 4500,
    language: 'vi'
  });
  assert.match(prompt, /Audio hiện tại: 6\.000 giây/);
  assert.match(prompt, /Audio tối đa cho phép: 4\.500 giây/);
  assert.match(prompt, /khoảng 69%/);
  assert.match(prompt, /Không quá \d+ từ/);
  assert.match(prompt, /Không quá \d+ ký tự/);
  assert.match(prompt, /Giữ nguyên ý chính và hành động trung tâm/);
  assert.match(prompt, /Giữ nguyên đầy đủ tên người/);
  assert.match(prompt, /Không được làm mất hoặc đảo nghĩa các từ phủ định/);
  assert.match(prompt, /Không thêm suy đoán, giải thích hoặc thông tin/i);
  assert.match(prompt, /Tạo 3 phương án/);
  assert.match(prompt, /"candidates"/);
});

test('later shortening attempts explicitly require a stronger rewrite without a fixed limit', () => {
  const prompt = buildNarrationShorteningPrompt({
    text: 'Câu thuyết minh trước vẫn còn quá dài so với thời lượng.',
    currentDurationMs: 5200,
    targetDurationMs: 4000,
    language: 'vi',
    attempt: 2
  });
  assert.match(prompt, /lần rút gọn 2, mức nén mạnh/);
  assert.doesNotMatch(prompt, /2\/2/);
  assert.match(prompt, /Kết quả trước vẫn quá dài/);
  assert.match(prompt, /phải rút gọn mạnh hơn/);
});

test('later attempts progressively reduce the word and character budget', () => {
  const input = {
    text: 'Đây là một câu thuyết minh khá dài cần được rút gọn rõ rệt.',
    currentDurationMs: 6000,
    targetDurationMs: 4000
  };
  const first = getShorteningConstraints({ ...input, attempt: 1 });
  const third = getShorteningConstraints({ ...input, attempt: 3 });
  assert.ok(third.maxWords < first.maxWords);
  assert.ok(third.maxCharacters < first.maxCharacters);
  assert.equal(third.compressionLevel, 'tối giản');
});

test('selects the shortest candidate that preserves numbers and negation', () => {
  const original = 'Anh không mua 10 món hàng ở Hà Nội.';
  const constraints = getShorteningConstraints({
    text: original,
    currentDurationMs: 6000,
    targetDurationMs: 4500
  });
  const result = selectBestCandidate([
    'Anh mua 10 món.',
    'Anh không mua món.',
    'Anh không mua 10 món ở Hà Nội.'
  ], original, constraints);
  assert.equal(result.selected, 'Anh không mua 10 món ở Hà Nội.');
});

test('treats Bạn có biết as a removable lead-in while preserving the real name and negation', () => {
  const original = 'Bạn có biết tại sao Lang Lãng không dùng ngón tay này để chơi piano không?';
  const constraints = getShorteningConstraints({
    text: original,
    currentDurationMs: 4320,
    targetDurationMs: 3100
  });
  const result = selectBestCandidate([
    'Bạn biết tại sao anh ta không chơi piano?',
    'Vì sao Lang Lãng dùng ngón này chơi piano?',
    'Vì sao Lang Lãng không dùng ngón này chơi piano?'
  ], original, constraints);
  assert.equal(result.selected, 'Vì sao Lang Lãng không dùng ngón này chơi piano?');
  assert.deepEqual(result.evaluated[2].missingSubjects, []);
  assert.deepEqual(result.evaluated[2].missingProperNames, []);
});

test('OpenCode shortening returns a strictly shorter narration sentence', async () => {
  const requests = [];
  const result = await shortenNarrationText({
    text: 'Trong thời điểm vô cùng nguy hiểm, anh ấy lập tức chạy đến cứu cô ấy.',
    currentDurationMs: 6000,
    targetDurationMs: 4500,
    config: { aiProvider: 'opencode' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"text":"Lúc nguy cấp, anh lập tức cứu cô."}' } }]
        })
      };
    }
  });
  assert.equal(result, 'Lúc nguy cấp, anh lập tức cứu cô.');
  assert.match(requests[0].url, /opencode\.ai/);
});

test('rejects an AI response that does not shorten the sentence', async () => {
  const text = 'Câu này không được rút gọn.';
  await assert.rejects(
    shortenNarrationText({
      text,
      currentDurationMs: 4000,
      targetDurationMs: 2500,
      config: { aiProvider: 'opencode' },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ text }) } }] })
      })
    }),
    /chưa rút gọn/
  );
});

test('retries with validation feedback when candidates lose protected facts', async () => {
  const requests = [];
  const responses = [
    { candidates: ['Anh mua hàng.', 'Anh mua món.', 'Anh lấy hàng.'] },
    { candidates: ['Anh không mua 10 món.', 'Anh không lấy 10 món.', 'Không mua 10 món.'] }
  ];
  const result = await shortenNarrationText({
    text: 'Anh không mua 10 món hàng trong ngày hôm nay.',
    currentDurationMs: 6000,
    targetDurationMs: 3500,
    config: { aiProvider: 'opencode' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const content = JSON.stringify(responses.shift());
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] })
      };
    }
  });
  assert.equal(result, 'Anh không mua 10 món.');
  assert.equal(requests.length, 2);
  assert.match(JSON.parse(requests[1].options.body).messages[0].content, /PHẢN HỒI KIỂM TRA/);
});
