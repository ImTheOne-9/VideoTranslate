class NarrationShorteningError extends Error {
  constructor(message, code = 'NARRATION_SHORTENING_FAILED') {
    super(message);
    this.name = 'NarrationShorteningError';
    this.code = code;
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getShorteningConstraints(options = {}) {
  const text = normalizeText(options.text);
  const currentDurationMs = Math.max(1, Math.round(Number(options.currentDurationMs) || 0));
  const targetDurationMs = Math.max(1, Math.round(Number(options.targetDurationMs) || 0));
  const attempt = Math.max(1, Math.round(Number(options.attempt) || 1));
  const durationRatio = Math.max(0.18, Math.min(0.98, targetDurationMs / currentDurationMs));
  const strength = attempt === 1 ? 0.92 : attempt === 2 ? 0.82 : 0.72;
  const targetFraction = Math.max(0.18, Math.min(0.9, durationRatio * strength));
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  return {
    text,
    currentDurationMs,
    targetDurationMs,
    attempt,
    targetFraction,
    targetPercent: Math.max(18, Math.min(90, Math.floor(targetFraction * 100))),
    maxWords: Math.max(attempt >= 3 ? 2 : 3, Math.floor(wordCount * targetFraction)),
    maxCharacters: Math.max(attempt >= 3 ? 8 : 12, Math.floor(text.length * targetFraction)),
    compressionLevel: attempt === 1 ? 'vừa phải' : attempt === 2 ? 'mạnh' : 'tối giản'
  };
}

function buildNarrationShorteningPrompt(options = {}) {
  const {
    text,
    currentDurationMs,
    targetDurationMs,
    attempt,
    targetPercent,
    maxWords,
    maxCharacters,
    compressionLevel
  } = getShorteningConstraints(options);
  const language = options.language === 'en' ? 'English'
    : options.language === 'zh' ? '中文'
      : 'Tiếng Việt';

  return `Bạn là biên tập viên chuyên rút gọn lời thuyết minh để khớp chính xác thời lượng video.

NHIỆM VỤ:
Tạo 3 phương án viết lại bằng ${language}. Mỗi phương án phải là đúng MỘT câu ngắn hơn, tự nhiên và đủ ý để đọc trong thời lượng yêu cầu.
Đây là lần rút gọn ${attempt}, mức nén ${compressionLevel}.${attempt > 1 ? ' Kết quả trước vẫn quá dài, vì vậy lần này phải rút gọn mạnh hơn nhưng không được làm sai nghĩa.' : ''}

THỜI LƯỢNG VÀ GIỚI HẠN CỨNG:
- Audio hiện tại: ${(currentDurationMs / 1000).toFixed(3)} giây.
- Audio tối đa cho phép: ${(targetDurationMs / 1000).toFixed(3)} giây.
- Câu mới chỉ được dài tối đa khoảng ${targetPercent}% câu hiện tại.
- Không quá ${maxWords} từ.
- Không quá ${maxCharacters} ký tự, tính cả khoảng trắng.

YÊU CẦU BẮT BUỘC:
1. Giữ nguyên ý chính và hành động trung tâm.
2. Giữ nguyên đầy đủ tên người, địa danh, thương hiệu, thuật ngữ riêng và tên chiêu thức.
3. Giữ nguyên con số, đơn vị, mốc thời gian và thứ tự sự kiện.
4. Không được làm mất hoặc đảo nghĩa các từ phủ định như "không", "chưa", "chẳng", "đừng", "không thể".
5. Giữ đúng chủ thể thực hiện hành động và đối tượng chịu tác động.
6. Giữ đúng quan hệ nguyên nhân - kết quả, điều kiện và so sánh.
7. Không thêm suy đoán, giải thích hoặc thông tin không có trong câu hiện tại.
8. Dùng câu nói tự nhiên, rõ nghĩa, dễ đọc thành tiếng.
9. Không dùng chữ viết tắt, dấu gạch chéo hoặc ký hiệu khó đọc.
10. Bắt buộc ngắn hơn câu hiện tại và không được vượt bất kỳ giới hạn cứng nào ở trên.
11. Ba phương án phải khác nhau về cách diễn đạt; phương án đầu tiên phải ngắn nhất có thể.

ƯU TIÊN RÚT GỌN THEO THỨ TỰ:
1. Bỏ từ đệm, từ nhấn mạnh và câu dẫn không cần thiết.
2. Thay cụm từ dài bằng từ ngắn tương đương.
3. Gộp các thành phần lặp hoặc trùng nghĩa.
4. Bỏ mô tả phụ, cảm thán, câu dẫn và bối cảnh không ảnh hưởng trực tiếp đến hành động chính.
5. Không được bỏ tên riêng, số liệu, phủ định, chủ thể hoặc kết quả chính.
6. Ở mức tối giản, chỉ giữ chủ thể + hành động chính + đối tượng/kết quả cùng dữ kiện bắt buộc.
7. Được phép bỏ toàn bộ câu dẫn như "Bạn có biết...", "Có thể thấy...", "Thực tế là..." hoặc cách dẫn tương đương; đây không phải chủ thể của sự việc chính.

ĐỊNH DẠNG TRẢ VỀ:
- Chỉ trả về đúng một JSON hợp lệ: {"candidates":["phương án 1","phương án 2","phương án 3"]}.
- Không Markdown, không giải thích và không ghi chú.

CÂU HIỆN TẠI:
${JSON.stringify(text)}`;
}

function extractCandidates(raw) {
  let value = String(raw || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) value = value.slice(start, end + 1);
  try {
    const parsed = JSON.parse(value);
    const values = Array.isArray(parsed?.candidates)
      ? parsed.candidates
      : [parsed?.text];
    return [...new Set(values
      .map((candidate) => normalizeText(
        typeof candidate === 'string' ? candidate : candidate?.text
      ))
      .filter(Boolean))];
  } catch {
    throw new NarrationShorteningError('AI không trả về danh sách câu rút gọn hợp lệ');
  }
}

async function requestOpenAICompatible(prompt, config, fetchImpl) {
  const provider = config.aiProvider;
  const isOpenRouter = provider === 'openrouter';
  const isOpenAI = provider === 'openai' || provider === 'chatgpt';
  const isNineRouter = provider === 'ninerouter' || provider === '9router';
  const baseUrl = isOpenRouter
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : isOpenAI
      ? 'https://api.openai.com/v1/chat/completions'
      : `${config.ninerouterBaseUrl || 'http://localhost:20128/v1'}/chat/completions`;
  const apiKey = isOpenRouter ? config.openRouterApiKey
    : isOpenAI ? config.openaiApiKey
      : config.ninerouterApiKey;
  const model = isOpenRouter ? (config.openRouterModel || 'openrouter/owl-alpha')
    : isOpenAI ? (config.openaiModel || 'gpt-4o-mini')
      : (config.ninerouterModel || '');
  if (!isNineRouter && !String(apiKey || '').trim()) {
    throw new NarrationShorteningError('Thiếu API key để tự rút gọn câu', 'NARRATION_SHORTENER_UNAVAILABLE');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (String(apiKey || '').trim()) headers.Authorization = `Bearer ${apiKey}`;
  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'https://github.com/Antigravity';
    headers['X-Title'] = 'Video Studio Tools';
  }
  const response = await fetchImpl(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      stream: false
    })
  });
  if (!response.ok) throw new NarrationShorteningError(`AI rút gọn lỗi ${response.status}: ${await response.text()}`);
  return extractCandidates((await response.json())?.choices?.[0]?.message?.content);
}

async function requestGemini(prompt, config, fetchImpl) {
  const apiKey = String(config.geminiApiKey || '').trim();
  if (!apiKey) {
    throw new NarrationShorteningError('Thiếu Gemini API key để tự rút gọn câu', 'NARRATION_SHORTENER_UNAVAILABLE');
  }
  const model = String(config.geminiModel || 'gemini-2.0-flash').replace(/^models\//, '');
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      })
    }
  );
  if (!response.ok) throw new NarrationShorteningError(`Gemini rút gọn lỗi ${response.status}: ${await response.text()}`);
  return extractCandidates((await response.json())?.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function requestOpenCode(prompt, config, fetchImpl) {
  const modelMap = {
    'DeepSeek V4 Flash (Free)': 'deepseek-v4-flash-free',
    'Big Pickle (Free)': 'big-pickle',
    'HY3 (Free)': 'hy3-free',
    'MiMo V2.5 (Free)': 'mimo-v2.5-free',
    'North Mini Code (Free)': 'north-mini-code-free'
  };
  const selected = config.opencodeModel || 'DeepSeek V4 Flash (Free)';
  const payload = {
    model: modelMap[selected] || selected,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0
  };
  if (payload.model !== 'hy3-free') payload.response_format = { type: 'json_object' };
  const response = await fetchImpl('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new NarrationShorteningError(`OpenCode rút gọn lỗi ${response.status}: ${await response.text()}`);
  const message = (await response.json())?.choices?.[0]?.message;
  return extractCandidates(message?.content || message?.reasoning_content);
}

function extractProtectedFacts(text) {
  const original = normalizeText(text);
  const normalized = original.toLocaleLowerCase('vi');
  const numbers = normalized.match(/\d+(?:[.,]\d+)*(?:%|x)?/gu) || [];
  const properNames = original.match(
    /\p{Lu}[\p{L}\p{M}'’-]*(?:\s+\p{Lu}[\p{L}\p{M}'’-]*)+/gu
  ) || [];
  const negationTerms = [
    'không thể', 'không được', 'không', 'chưa', 'chẳng', 'chả', 'đừng',
    'cannot', "can't", 'not', 'never', 'no',
    '不能', '不可以', '没有', '不', '未', '别'
  ];
  const subjectTerms = [
    'chúng tôi', 'chúng ta', 'anh ấy', 'cô ấy', 'ông ấy', 'bà ấy',
    'tôi', 'ta', 'mình', 'anh', 'cô', 'ông', 'bà', 'hắn', 'nó', 'họ', 'bạn',
    'we', 'they', 'you', 'he', 'she', 'i',
    '我们', '他们', '她们', '你们', '我', '你', '他', '她'
  ];
  const narrationCore = normalized.replace(
    /^(?:(?:xin hỏi\s+)?bạn có biết(?:\s+(?:rằng|là))?|bạn biết(?:\s+(?:rằng|là))?|có thể thấy(?:\s+(?:rằng|là))?|thực tế(?:\s+là)?|trên thực tế|như bạn (?:đã )?biết|do you know(?:\s+that)?|as you know|in fact|你知道|你是否知道|事实上)[,;:!?\s]+/iu,
    ''
  );
  const opening = narrationCore.split(/\s+/u).slice(0, 8).join(' ');
  const subject = subjectTerms
    .map((term) => ({
      term,
      index: /[\u3400-\u9FFF]/u.test(term)
        ? opening.indexOf(term)
        : ` ${opening} `.indexOf(` ${term} `)
    }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || right.term.length - left.term.length)[0]?.term;
  return {
    numbers: [...new Set(numbers)],
    properNames: [...new Set(properNames.map((name) => name.toLocaleLowerCase('vi')))],
    negations: negationTerms.filter((term) => containsProtectedTerm(normalized, term)),
    subjects: subject ? [subject] : []
  };
}

function containsProtectedTerm(text, term) {
  if (/[\u3400-\u9FFF]/u.test(term)) return text.includes(term);
  const normalizeTerms = (value) => value
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${normalizeTerms(text)} `.includes(` ${normalizeTerms(term)} `);
}

function evaluateCandidate(candidate, original, constraints, protectedFacts) {
  const text = normalizeText(candidate);
  const lowered = text.toLocaleLowerCase('vi');
  const words = text.split(/\s+/u).filter(Boolean).length;
  const missingNumbers = protectedFacts.numbers.filter((value) => !lowered.includes(value));
  const missingProperNames = protectedFacts.properNames.filter((value) => (
    !containsProtectedTerm(lowered, value)
  ));
  const missingNegations = protectedFacts.negations.filter((value) => (
    !containsProtectedTerm(lowered, value)
  ));
  const missingSubjects = protectedFacts.subjects.filter((value) => (
    !containsProtectedTerm(lowered, value)
  ));
  return {
    text,
    words,
    shorter: Boolean(text) && text !== original && text.length < original.length,
    protectedFactsPreserved: missingNumbers.length === 0
      && missingProperNames.length === 0
      && missingNegations.length === 0
      && missingSubjects.length === 0,
    withinHardLimits: words <= constraints.maxWords && text.length <= constraints.maxCharacters,
    missingNumbers,
    missingProperNames,
    missingNegations,
    missingSubjects
  };
}

function selectBestCandidate(candidates, original, constraints) {
  const protectedFacts = extractProtectedFacts(original);
  const evaluated = candidates.map((candidate) => (
    evaluateCandidate(candidate, original, constraints, protectedFacts)
  ));
  const valid = evaluated.filter((candidate) => (
    candidate.shorter && candidate.protectedFactsPreserved
  ));
  valid.sort((left, right) => (
    Number(right.withinHardLimits) - Number(left.withinHardLimits)
    || left.text.length - right.text.length
    || left.words - right.words
  ));
  return { selected: valid[0]?.text || '', evaluated };
}

async function requestCandidates(provider, prompt, config, fetchImpl) {
  if (provider === 'gemini') return requestGemini(prompt, config, fetchImpl);
  if (['openrouter', 'openai', 'chatgpt', 'ninerouter', '9router'].includes(provider)) {
    return requestOpenAICompatible(prompt, config, fetchImpl);
  }
  if (provider === 'opencode') return requestOpenCode(prompt, config, fetchImpl);
  throw new NarrationShorteningError(
    'Nhà cung cấp dịch hiện tại không hỗ trợ tự rút gọn. Hãy chọn Gemini, OpenAI, OpenRouter, 9Router hoặc OpenCode.',
    'NARRATION_SHORTENER_UNAVAILABLE'
  );
}

async function shortenNarrationText(options = {}) {
  const original = normalizeText(options.text);
  if (!original) throw new NarrationShorteningError('Câu cần rút gọn đang trống');
  const config = options.config || {};
  const provider = String(config.aiProvider || '').toLowerCase();
  const basePrompt = buildNarrationShorteningPrompt(options);
  const constraints = getShorteningConstraints(options);
  const protectedFacts = extractProtectedFacts(original);
  const fetchImpl = options.fetchImpl || global.fetch;
  let feedback = '';
  for (let responseAttempt = 0; responseAttempt < 2; responseAttempt += 1) {
    const prompt = responseAttempt === 0
      ? basePrompt
      : `${basePrompt}\n\nPHẢN HỒI KIỂM TRA:\n${feedback}\nHãy sửa lỗi và trả lại đúng JSON yêu cầu.`;
    const candidates = await requestCandidates(provider, prompt, config, fetchImpl);
    const result = selectBestCandidate(candidates, original, constraints);
    if (result.selected) return result.selected;

    const missingNumbers = [...new Set(result.evaluated.flatMap((item) => item.missingNumbers))];
    const missingProperNames = [...new Set(result.evaluated.flatMap((item) => item.missingProperNames))];
    const missingNegations = [...new Set(result.evaluated.flatMap((item) => item.missingNegations))];
    const missingSubjects = [...new Set(result.evaluated.flatMap((item) => item.missingSubjects))];
    feedback = [
      'Không có phương án nào vừa ngắn hơn vừa giữ đủ dữ kiện bắt buộc.',
      protectedFacts.numbers.length ? `Phải giữ nguyên số liệu: ${protectedFacts.numbers.join(', ')}.` : '',
      protectedFacts.properNames.length ? `Phải giữ nguyên tên riêng: ${protectedFacts.properNames.join(', ')}.` : '',
      protectedFacts.negations.length ? `Phải giữ nguyên phủ định: ${protectedFacts.negations.join(', ')}.` : '',
      protectedFacts.subjects.length ? `Phải giữ nguyên chủ thể: ${protectedFacts.subjects.join(', ')}.` : '',
      missingNumbers.length ? `Phản hồi vừa rồi làm mất số liệu: ${missingNumbers.join(', ')}.` : '',
      missingProperNames.length ? `Phản hồi vừa rồi làm mất tên riêng: ${missingProperNames.join(', ')}.` : '',
      missingNegations.length ? `Phản hồi vừa rồi làm mất phủ định: ${missingNegations.join(', ')}.` : '',
      missingSubjects.length ? `Phản hồi vừa rồi làm mất chủ thể: ${missingSubjects.join(', ')}.` : '',
      `Giới hạn: ${constraints.maxWords} từ và ${constraints.maxCharacters} ký tự.`
    ].filter(Boolean).join('\n');
  }
  throw new NarrationShorteningError('AI chưa rút gọn được câu thuyết minh mà vẫn giữ đủ dữ kiện');
}

module.exports = {
  NarrationShorteningError,
  buildNarrationShorteningPrompt,
  getShorteningConstraints,
  selectBestCandidate,
  shortenNarrationText
};
