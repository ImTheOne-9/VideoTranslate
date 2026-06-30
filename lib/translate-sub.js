const fs = require('fs');
const path = require('path');
const Parser = require('srt-parser-2').default;
const { getAppDataRoot } = require('./path-helper');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Tự xây dựng hàm dịch bằng API miễn phí chính thức của Google Translate (client=gtx) để không bao giờ bị dính lỗi rate limit (Too Many Requests)
async function translate(text, options = {}) {
  const toLang = options.to || 'vi';
  const params = new URLSearchParams({
    sl: 'auto',
    tl: toLang,
    q: text
  });

  const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=rm&dj=1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
    },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Google HTTP error! status: ${res.status}`);
  }

  const data = await res.json();
  if (data && data.sentences) {
    const translatedText = data.sentences.map(s => s.trans).join('');
    return { text: translatedText };
  }

  throw new Error('Định dạng phản hồi không hợp lệ');
}

// Hàm chia dòng phụ đề thành tối đa 2 dòng cân đối và gọn gàng cho màn hình đứng
function wrapTextToTwoLines(text, maxCharsPerLine = 22) {
  // Thay thế ký tự ngắt dòng cũ và khoảng trắng dư thừa
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }

  const words = cleanText.split(' ');
  const midPoint = Math.floor(cleanText.length / 2);
  let bestIndex = -1;
  let minDiff = Infinity;
  
  let currentPos = 0;
  for (let i = 0; i < words.length - 1; i++) {
    currentPos += words[i].length + 1; // +1 cho dấu cách
    const diff = Math.abs(currentPos - midPoint);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }

  if (bestIndex !== -1) {
    const line1 = words.slice(0, bestIndex + 1).join(' ');
    const line2 = words.slice(bestIndex + 1).join(' ');
    return `${line1}\n${line2}`;
  }

  return cleanText;
}

function wrapTextToThreeLines(text, maxCharsPerLine = 22) {
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }
  if (cleanText.length <= maxCharsPerLine * 1.6) {
    return wrapTextToTwoLines(cleanText, maxCharsPerLine);
  }
  
  const words = cleanText.split(' ');
  if (words.length <= 2) {
    return words.join('\n');
  }
  
  const totalLen = cleanText.length;
  
  let bestI = -1;
  let bestJ = -1;
  let minVariance = Infinity;
  
  let posI = 0;
  for (let i = 0; i < words.length - 2; i++) {
    posI += words[i].length + 1;
    
    let posJ = posI;
    for (let j = i + 1; j < words.length - 1; j++) {
      posJ += words[j].length + 1;
      
      const len1 = posI - 1;
      const len2 = posJ - posI - 1;
      const len3 = totalLen - posJ;
      
      const mean = totalLen / 3;
      const variance = Math.pow(len1 - mean, 2) + Math.pow(len2 - mean, 2) + Math.pow(len3 - mean, 2);
      
      if (variance < minVariance) {
        minVariance = variance;
        bestI = i;
        bestJ = j;
      }
    }
  }
  
  if (bestI !== -1 && bestJ !== -1) {
    const line1 = words.slice(0, bestI + 1).join(' ');
    const line2 = words.slice(bestI + 1, bestJ + 1).join(' ');
    const line3 = words.slice(bestJ + 1).join(' ');
    return `${line1}\n${line2}\n${line3}`;
  }
  
  return cleanText;
}

function srtTimeToMs(timeStr) {
  if (!timeStr) return 0;
  try {
    const parts = timeStr.split(':');
    if (parts.length === 2) {
      const secParts = parts[1].split(',');
      const minutes = parseInt(parts[0], 10) || 0;
      const seconds = parseInt(secParts[0], 10) || 0;
      const ms = parseInt(secParts[1], 10) || 0;
      return minutes * 60000 + seconds * 1000 + ms;
    }
    if (parts.length < 3) return 0;
    const secParts = parts[2].split(',');
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    const seconds = parseInt(secParts[0], 10) || 0;
    const ms = parseInt(secParts[1], 10) || 0;
    return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
  } catch (e) {
    return 0;
  }
}

function msToSrtTime(ms) {
  const hours = Math.floor(ms / 3600000);
  let remain = ms % 3600000;
  const minutes = Math.floor(remain / 60000);
  remain %= 60000;
  const seconds = Math.floor(remain / 1000);
  const milliseconds = Math.floor(remain % 1000);
  
  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');
  const msStr = String(milliseconds).padStart(3, '0');
  return `${h}:${m}:${s},${msStr}`;
}

function mergeShortSubtitles(srtArray, maxGapMs = 800, maxMergedLength = 65) {
  if (!srtArray || srtArray.length <= 1) return srtArray;
  
  const merged = [];
  let current = { ...srtArray[0] };
  
  for (let i = 1; i < srtArray.length; i++) {
    const next = srtArray[i];
    const currentEnd = srtTimeToMs(current.endTime);
    const nextStart = srtTimeToMs(next.startTime);
    const gap = nextStart - currentEnd;
    
    const currentText = current.text.trim();
    const endsWithPunctuation = /[.!?…]$/.test(currentText);
    const mergedLength = currentText.length + next.text.trim().length + 1;
    
    if (gap >= 0 && gap <= maxGapMs && !endsWithPunctuation && mergedLength <= maxMergedLength) {
      current.endTime = next.endTime;
      current.text = (currentText + ' ' + next.text.trim()).replace(/\s+/g, ' ');
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  
  merged.forEach((item, idx) => {
    item.id = String(idx + 1);
  });
  
  return merged;
}

function splitSubtitleItem(item, maxCharsPerBlock = 36) {
  if (!item || !item.text) return [item];
  const text = item.text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. Thử tìm dấu câu kết thúc câu để tách trước (giúp giọng đọc liền mạch theo câu thực tế)
  // Thực hiện điều này kể cả khi độ dài nhỏ hơn maxCharsPerBlock để phân tách câu chuẩn xác
  const puncRegex = /[.!?…](?:\s|$)/g;
  let match;
  let bestPuncIndex = -1;
  let minPuncDiff = Infinity;
  const midPoint = Math.floor(text.length / 2);

  while ((match = puncRegex.exec(text)) !== null) {
    const puncPos = match.index; // vị trí của ký tự dấu câu
    // Tránh tách ở rìa quá sát (để lại tối thiểu 3 ký tự cả hai bên)
    if (puncPos > 2 && puncPos < text.length - 3) {
      const diff = Math.abs(puncPos - midPoint);
      if (diff < minPuncDiff) {
        minPuncDiff = diff;
        bestPuncIndex = puncPos;
      }
    }
  }

  let part1Text = '';
  let part2Text = '';
  let part1WordCount = 0;
  let totalWordCount = 0;

  if (bestPuncIndex !== -1) {
    // Tách dựa trên dấu câu
    part1Text = text.substring(0, bestPuncIndex + 1).trim();
    part2Text = text.substring(bestPuncIndex + 1).trim();
    part1WordCount = part1Text.split(/\s+/).length;
    totalWordCount = part1WordCount + part2Text.split(/\s+/).length;
  } else {
    // Nếu không tách theo dấu câu và độ dài đủ ngắn thì trả về luôn
    if (text.length <= maxCharsPerBlock) {
      return [item];
    }

    // 2. Nếu không có dấu câu phù hợp, tách ở giữa câu như cũ dựa trên từ ngữ
    const words = text.split(' ');
    if (words.length <= 2) {
      return [item];
    }

    let bestIndex = -1;
    let minDiff = Infinity;
    let currentPos = 0;

    for (let i = 0; i < words.length - 1; i++) {
      currentPos += words[i].length + 1; // +1 cho dấu cách
      const diff = Math.abs(currentPos - midPoint);
      if (diff < minDiff) {
        minDiff = diff;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      return [item];
    }

    const part1Words = words.slice(0, bestIndex + 1);
    const part2Words = words.slice(bestIndex + 1);
    part1Text = part1Words.join(' ');
    part2Text = part2Words.join(' ');
    part1WordCount = part1Words.length;
    totalWordCount = words.length;
  }

  const startTimeMs = srtTimeToMs(item.startTime);
  const endTimeMs = srtTimeToMs(item.endTime);
  const duration = endTimeMs - startTimeMs;

  if (duration <= 0 || isNaN(duration)) {
    const item1 = { ...item, text: part1Text };
    const item2 = { ...item, text: part2Text };
    return [
      ...splitSubtitleItem(item1, maxCharsPerBlock),
      ...splitSubtitleItem(item2, maxCharsPerBlock)
    ];
  }

  const part1Duration = Math.floor(duration * (part1WordCount / totalWordCount));
  const splitTimeMs = startTimeMs + part1Duration;

  const item1 = {
    id: item.id,
    startTime: item.startTime,
    endTime: msToSrtTime(splitTimeMs),
    text: part1Text
  };

  const item2 = {
    id: item.id,
    startTime: msToSrtTime(splitTimeMs),
    endTime: item.endTime,
    text: part2Text
  };

  return [
    ...splitSubtitleItem(item1, maxCharsPerBlock),
    ...splitSubtitleItem(item2, maxCharsPerBlock)
  ];
}

// Định dạng lại toàn bộ file phụ đề để tất cả các khối sub có tối đa 1 hoặc 2 dòng và độ dài vừa vặn theo chiều rộng kéo thả
function formatSubtitleFile(filePath, maxLines = 0, maxCharsPerLine = 22) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const parser = new Parser();
  const srtArray = parser.fromSrt(content);
  
  // 1. Chia nhỏ các khối sub quá dài (phù hợp với số dòng tối đa cấu hình)
  let newSrtArray = [];
  let maxChars = maxCharsPerLine;
  if (maxLines === 2) {
    maxChars = Math.round(maxCharsPerLine * 1.6);
  } else if (maxLines === 3 || maxLines === 0) {
    maxChars = Math.round(maxCharsPerLine * 2.3);
  }
  for (const item of srtArray) {
    newSrtArray.push(...splitSubtitleItem(item, maxChars));
  }
  
  // 2. Đánh lại ID và định dạng dòng tương ứng
  newSrtArray.forEach((item, idx) => {
    item.id = String(idx + 1);
    if (maxLines === 1) {
      item.text = item.text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    } else if (maxLines === 2) {
      item.text = wrapTextToTwoLines(item.text, maxCharsPerLine);
    } else if (maxLines === 3) {
      item.text = wrapTextToThreeLines(item.text, maxCharsPerLine);
    } else { // maxLines === 0 (Tự động)
      const clean = item.text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length <= maxCharsPerLine) {
        item.text = clean;
      } else if (clean.length <= maxCharsPerLine * 1.6) {
        item.text = wrapTextToTwoLines(clean, maxCharsPerLine);
      } else {
        item.text = wrapTextToThreeLines(clean, maxCharsPerLine);
      }
    }
  });
  
  const formattedContent = parser.toSrt(newSrtArray);
  fs.writeFileSync(filePath, formattedContent, 'utf8');
}

// Từ điển thay thế từ khóa trước khi dịch (từ tiếng Trung sang từ gợi ý chuẩn)
const PRE_TRANSLATE_DICT = {
  "舞单": "thần tượng",
  "短剧": "phim ngắn"
};

// Từ điển sửa lỗi sau khi dịch (sửa các lỗi dịch nghĩa đen của Google)
const POST_TRANSLATE_DICT = {
  "người kéo tường": "Huawei Mate X",
  "người kéo": "Huawei Mate X"
};

function preProcessText(text) {
  if (!text) return '';
  let processed = text;
  for (const [key, value] of Object.entries(PRE_TRANSLATE_DICT)) {
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    processed = processed.replace(new RegExp(escapedKey, 'g'), value);
  }
  return processed;
}

function postProcessText(text) {
  if (!text) return '';
  let processed = text;
  for (const [key, value] of Object.entries(POST_TRANSLATE_DICT)) {
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    processed = processed.replace(new RegExp(escapedKey, 'gi'), value);
  }
  return processed;
}

let cachedGeminiModel = null;

async function getAvailableGeminiModel(apiKey) {
  if (cachedGeminiModel) return cachedGeminiModel;
  
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!res.ok) throw new Error('Không thể lấy danh sách model từ API.');
  
  const data = await res.json();
  const models = data.models || [];
  
  const validModels = models.filter(m => 
    m.supportedGenerationMethods && 
    m.supportedGenerationMethods.includes('generateContent') &&
    m.name.includes('gemini')
  );
  
  // Ưu tiên lấy model flash mới nhất, sau đó đến pro
  const flashModel = validModels.find(m => m.name.includes('flash'));
  const proModel = validModels.find(m => m.name.includes('pro'));
  
  if (flashModel) cachedGeminiModel = flashModel.name;
  else if (proModel) cachedGeminiModel = proModel.name;
  else if (validModels.length > 0) cachedGeminiModel = validModels[0].name;
  else throw new Error('Không tìm thấy model Gemini nào hỗ trợ generateContent.');
  
  console.log('[Gemini AI] Đã tự động nhận diện Model tối ưu nhất:', cachedGeminiModel);
  return cachedGeminiModel;
}

function extractJson(text) {
  if (!text) return {};
  let cleaned = text;
  
  // 1. Loại bỏ suy nghĩ <think>...</think> của DeepSeek R1/Reasoning models
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // 2. Loại bỏ khối markdown json, srt hoặc plain markdown code blocks
  cleaned = cleaned.replace(/```[a-zA-Z0-9-]*\n/gi, '')
                   .replace(/```/g, '')
                   .trim();
  
  // 3. Tìm khối JSON bằng cách định vị dấu { và } ngoài cùng
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Lỗi cú pháp JSON nhận được:', cleaned);
    throw new Error('Không thể phân tích phản hồi JSON từ AI: ' + err.message);
  }
}

async function translateWithGemini(map, apiKey) {
  const prompt = `Hãy đóng vai một chuyên gia dịch thuật video chuyên nghiệp (Tiktok, Facebook Reels, YouTube Shorts).
Dưới đây là một danh sách các khối phụ đề (subtitle blocks) dưới dạng JSON object.

LƯU Ý QUAN TRỌNG: Các khối phụ đề này được cắt ngắn theo mốc thời gian thực tế trong video nên nhiều câu bị ngắt đôi hoặc ngắt ba ở giữa chừng.
Nhiệm vụ của bạn:
1. Đọc toàn bộ danh sách đầu vào để hiểu rõ toàn bộ nội dung và ngữ cảnh của câu chuyện trong video.
2. Dịch từng khối phụ đề sang tiếng Việt sao cho:
   - Khi ghép các khối phụ đề liên tiếp lại để đọc liên tục, chúng tạo thành các câu tiếng Việt hoàn chỉnh, tự nhiên, mượt mà, đúng ngữ pháp và ngữ cảnh.
   - KHÔNG dịch word-by-word từng khối độc lập. Hãy khéo léo điều chỉnh từ ngữ ở từng khối sao cho phù hợp với cấu trúc ngữ pháp tiếng Việt sau khi ghép lại thành câu dài.
   - Giữ nguyên văn phong sinh động, phù hợp với mạng xã hội.
3. Giữ NGUYÊN VẸN các khóa (keys) của JSON gốc. Tuyệt đối không thêm bớt hoặc thay đổi bất kỳ khóa nào.
4. Chỉ trả về một chuỗi JSON hợp lệ chứa các câu thoại đã dịch, không thêm bất kỳ văn bản giải thích nào khác.

Dữ liệu đầu vào:
${JSON.stringify(map, null, 2)}`;

  const modelName = await getAvailableGeminiModel(apiKey);

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    cachedGeminiModel = null; // Reset cache nếu bị lỗi
    throw new Error(`Lỗi API: ${err}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return extractJson(rawText);
}

async function translateWithOpenRouter(map, apiKey, model) {
  const selectedModel = model || 'openrouter/owl-alpha';
  const prompt = `Hãy đóng vai một chuyên gia dịch thuật video chuyên nghiệp (Tiktok, Facebook Reels, YouTube Shorts).
Dưới đây là một danh sách các khối phụ đề (subtitle blocks) dưới dạng JSON object.

LƯU Ý QUAN TRỌNG: Các khối phụ đề này được cắt ngắn theo mốc thời gian thực tế trong video nên nhiều câu bị ngắt đôi hoặc ngắt ba ở giữa chừng.
Nhiệm vụ của bạn:
1. Đọc toàn bộ danh sách đầu vào để hiểu rõ toàn bộ nội dung và ngữ cảnh của câu chuyện trong video.
2. Dịch từng khối phụ đề sang tiếng Việt sao cho:
   - Khi ghép các khối phụ đề liên tiếp lại để đọc liên tục, chúng tạo thành các câu tiếng Việt hoàn chỉnh, tự nhiên, mượt mà, đúng ngữ pháp và ngữ cảnh.
   - KHÔNG dịch word-by-word từng khối độc lập. Hãy khéo léo điều chỉnh từ ngữ ở từng khối sao cho phù hợp với cấu trúc ngữ pháp tiếng Việt sau khi ghép lại thành câu dài.
   - Giữ nguyên văn phong sinh động, phù hợp với mạng xã hội.
3. Giữ NGUYÊN VẸN các khóa (keys) của JSON gốc. Tuyệt đối không thêm bớt hoặc thay đổi bất kỳ khóa nào.
4. Chỉ trả về một chuỗi JSON hợp lệ chứa các câu thoại đã dịch, không thêm bất kỳ văn bản giải thích nào khác.

Dữ liệu đầu vào:
${JSON.stringify(map, null, 2)}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/Antigravity',
      'X-Title': 'Video Studio Tools'
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const rawText = data?.choices?.[0]?.message?.content || '';
  return extractJson(rawText);
}

async function translateWithRetry(text, options = {}) {
  let retries = 3;
  let delay = 3000;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await translate(text, options);
    } catch (err) {
      if (err.message.includes('429') && attempt < retries) {
        console.warn(`[Translate] Gặp lỗi 429 (Rate Limit). Đang tạm dừng ${delay}ms và thử lại lần ${attempt}/${retries}...`);
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
}

async function translateSubtitles(inputPath, outputPath, geminiApiKey, maxLines = 0, maxCharsPerLine = 22, isCancelled = null) {
  const content = fs.readFileSync(inputPath, 'utf8');

  let aiProvider = 'google-translate';
  let geminiApiKeyVal = '';
  let openRouterApiKeyVal = '';
  let openRouterModelVal = '';
  let srcLang = 'auto';

  if (typeof geminiApiKey === 'object' && geminiApiKey !== null) {
    aiProvider = geminiApiKey.aiProvider || 'google-translate';
    geminiApiKeyVal = geminiApiKey.geminiApiKey || '';
    openRouterApiKeyVal = geminiApiKey.openRouterApiKey || '';
    openRouterModelVal = geminiApiKey.openRouterModel || 'openrouter/owl-alpha';
    srcLang = geminiApiKey.srcLang || 'auto';
  } else if (typeof geminiApiKey === 'string' && geminiApiKey.trim() !== '') {
    aiProvider = 'gemini';
    geminiApiKeyVal = geminiApiKey;
  }

  if (!srcLang || srcLang === 'auto') {
    if (/[\u4e00-\u9fa5]/.test(content)) {
      srcLang = 'zho_Hans';
    } else if (/[\uac00-\ud7a3]/.test(content)) {
      srcLang = 'kor_Hang';
    } else if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(content)) {
      srcLang = 'jpn_Jpan';
    } else {
      srcLang = 'eng_Latn';
    }
    console.log(`[Auto-Detect] Tự động nhận diện ngôn ngữ nguồn cho NLLB: ${srcLang}`);
  }

  let parser = new Parser();
  let srtArray = parser.fromSrt(content);

  // Gộp các khối phụ đề ngắn, vụn thành câu hoàn chỉnh trước khi dịch để tránh dịch word-by-word
  console.log(`[Dịch phụ đề] Số khối sub ban đầu: ${srtArray.length}`);
  srtArray = mergeShortSubtitles(srtArray);
  console.log(`[Dịch phụ đề] Số khối sub sau khi gộp câu: ${srtArray.length}`);

  // 3. Dịch bằng AI Local NLLB-200
  if (aiProvider === 'nllb') {
    console.log('Bắt đầu dịch bằng AI Local NLLB-200...');
    
    // Tải model nếu chưa tồn tại
    const { ensureNllbModelExist } = require('./model-downloader');
    const isPackaged = __dirname.includes('app.asar');
    const appDataRoot = getAppDataRoot(path.join(__dirname, '..'));
    const MODELS_DIR = path.join(appDataRoot, 'models');
    const nllbModelDir = path.join(MODELS_DIR, 'nllb');
    
    if (global.updateStudioProgress) {
      global.updateStudioProgress(36, 'Đang kiểm tra và tải model dịch thuật local NLLB-200...');
    }
    
    await ensureNllbModelExist(MODELS_DIR, (progress) => {
      if (global.updateStudioProgress) {
        global.updateStudioProgress(36, `Đang tải model NLLB: ${progress.percent}%`);
      }
    });

    const nllbExePath = isPackaged 
      ? path.join(process.resourcesPath, 'tools', 'nllb_translate.exe')
      : path.join(__dirname, '..', 'tools', 'nllb_translate.exe');

    if (!fs.existsSync(nllbExePath)) {
      throw new Error(`Thiếu file chạy nllb_translate.exe tại ${nllbExePath}. Vui lòng biên dịch hoặc tải về.`);
    }

    if (global.updateStudioProgress) {
      global.updateStudioProgress(37, 'Đang chạy mô hình AI dịch thuật NLLB-200 local...');
    }

    const execFilePromise = (file, args) => {
      return new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        const proc = execFile(file, args, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`NLLB Local Error: ${stderr || error.message}`));
          } else {
            resolve(stdout);
          }
        });
        
        // Đăng ký tiến trình con với activeProcesses của server để có thể hủy
        if (global.registerChildProcess) {
          global.registerChildProcess(proc);
        }
      });
    };

    const targetLang = 'vie_Latn';
    console.log(`Chạy NLLB dịch từ ${srcLang} sang ${targetLang}...`);
    
    const args = [
      inputPath,
      '--model_dir', nllbModelDir,
      '--src_lang', srcLang,
      '--tgt_lang', targetLang,
      '--output', outputPath,
      '--batch_size', '32'
    ];

    try {
      if (isCancelled && isCancelled()) {
        console.log('[Dịch] Hủy dịch NLLB do phiên render đã bị hủy.');
        return;
      }
      await execFilePromise(nllbExePath, args);
      console.log('NLLB Local dịch hoàn tất thành công!');
      
      // Định dạng lại phụ đề
      try {
        formatSubtitleFile(outputPath, maxLines, maxCharsPerLine);
      } catch (err) {
        console.error('Lỗi định dạng phụ đề sau dịch NLLB:', err.message);
      }
      return;
    } catch (err) {
      console.error('NLLB local dịch thất bại:', err.message);
      throw err;
    }
  }

  // 1 & 2. Dịch bằng Gemini hoặc OpenRouter sử dụng cấu trúc JSON tối ưu
  if ((aiProvider === 'gemini' && geminiApiKeyVal && geminiApiKeyVal.trim() !== '') ||
      (aiProvider === 'openrouter' && openRouterApiKeyVal && openRouterApiKeyVal.trim() !== '')) {
    
    const isGemini = aiProvider === 'gemini';
    const apiKey = isGemini ? geminiApiKeyVal.trim() : openRouterApiKeyVal.trim();
    
    console.log(`Đang gọi ${isGemini ? 'Gemini AI' : 'OpenRouter AI (' + openRouterModelVal + ')'} để dịch phụ đề theo từng lô JSON...`);
    try {
      const batchSize = 40;
      for (let i = 0; i < srtArray.length; i += batchSize) {
        if (isCancelled && isCancelled()) {
          console.log('[Dịch] Hủy dịch phụ đề do phiên render đã bị hủy.');
          return;
        }

        const batch = srtArray.slice(i, i + batchSize);
        const batchMap = {};
        batch.forEach(item => {
          batchMap[item.id] = preProcessText(item.text).replace(/\n/g, ' ').trim();
        });
        
        if (i > 0) {
          await sleep(1000);
        }
        
        let translatedMap = {};
        if (isGemini) {
          translatedMap = await translateWithGemini(batchMap, apiKey);
        } else {
          translatedMap = await translateWithOpenRouter(batchMap, apiKey, openRouterModelVal);
        }
        
        batch.forEach(item => {
          if (translatedMap && translatedMap[item.id]) {
            const processed = postProcessText(translatedMap[item.id]);
            item.text = processed;
          } else {
            console.warn(`Thiếu câu dịch cho ID: ${item.id}`);
          }
        });
        
        console.log(`Đã dịch ${Math.min(i + batchSize, srtArray.length)}/${srtArray.length} dòng.`);
      }
      
      const translatedContent = parser.toSrt(srtArray);
      fs.writeFileSync(outputPath, translatedContent, 'utf8');
      try { formatSubtitleFile(outputPath, maxLines, maxCharsPerLine); } catch (e) {}
      console.log(`Đã dịch thành công bằng ${isGemini ? 'Gemini' : 'OpenRouter'} và lưu tại: ${outputPath}`);
      return;
    } catch (err) {
      console.error(`${isGemini ? 'Gemini' : 'OpenRouter'} dịch thất bại (${err.message}). Đang lùi về dùng Google Translate mặc định...`);
    }
  }

  // Cơ chế dự phòng Google Translate
  parser = new Parser();
  srtArray = parser.fromSrt(content);

  console.log(`Bắt đầu dịch ${srtArray.length} dòng phụ đề bằng Google Translate...`);

  const wrapOrClean = (txt) => {
    if (maxLines === 1) {
      return txt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    } else if (maxLines === 2) {
      return wrapTextToTwoLines(txt, maxCharsPerLine);
    } else if (maxLines === 3) {
      return wrapTextToThreeLines(txt, maxCharsPerLine);
    } else { // maxLines === 0
      const clean = txt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length <= maxCharsPerLine) {
        return clean;
      } else if (clean.length <= maxCharsPerLine * 1.6) {
        return wrapTextToTwoLines(clean, maxCharsPerLine);
      } else {
        return wrapTextToThreeLines(clean, maxCharsPerLine);
      }
    }
  };

  const batchSize = 30;
  let consecutiveFailures = 0;

  for (let i = 0; i < srtArray.length; i += batchSize) {
    if (isCancelled && isCancelled()) {
      console.log('[Dịch] Hủy dịch phụ đề do phiên render đã bị hủy.');
      return;
    }

    const batch = srtArray.slice(i, i + batchSize);
    
    // Nếu bị chặn hoàn toàn (3 lô liên tiếp thất bại) thì bypass toàn bộ lô còn lại để tránh treo
    if (consecutiveFailures >= 3) {
      console.warn('[Dịch] Phát hiện bị Google chặn cứng liên tiếp. Bypass dịch phần còn lại để giữ an toàn cho render.');
      for (const item of batch) {
        item.text = wrapOrClean(item.text);
      }
      continue;
    }

    // Áp dụng tiền xử lý từ điển trước khi dịch
    const textToTranslate = batch.map(item => {
      const clean = preProcessText(item.text);
      return clean.replace(/\n/g, ' ');
    }).join(' ||| ');
    
    // Giãn cách nhẹ chủ động giữa các đợt dịch để tránh rate limit
    if (i > 0) {
      await sleep(500);
    }

    try {
      const { text } = await translateWithRetry(textToTranslate, { to: 'vi' });
      consecutiveFailures = 0; // Reset lỗi liên tiếp
      
      const normalizedText = text.normalize('NFC');
      const translatedParts = normalizedText.split(/\|\|\||\| \| \|/i).map(s => s.trim());
      
      if (translatedParts.length === batch.length) {
        for (let j = 0; j < batch.length; j++) {
          const processed = postProcessText(translatedParts[j]);
          batch[j].text = wrapOrClean(processed);
        }
      } else {
        console.warn(`Số phần dịch không khớp (${translatedParts.length} vs ${batch.length}). Đang tự động chuyển sang dịch dòng đơn...`);
        for (const item of batch) {
          if (isCancelled && isCancelled()) return;
          try {
            const cleanText = preProcessText(item.text);
            const { text } = await translateWithRetry(cleanText, { to: 'vi' });
            const processed = postProcessText(text.normalize('NFC'));
            item.text = wrapOrClean(processed);
            await sleep(300); // Giãn cách ngắn tránh rate limit
          } catch (e) {
            console.error('Lỗi dịch dòng đơn:', e.message);
          }
        }
      }
    } catch (err) {
      console.error('Lỗi dịch lô phụ đề:', err.message);
      consecutiveFailures++;
      
      if (err.message.includes('429')) {
        console.log('[Dịch] Google chặn IP, tạm dừng 15s để cool-down...');
        if (global.updateStudioProgress) {
          global.updateStudioProgress(35, 'Đang chờ Google Translate hồi phục (15s)...');
        }
        await sleep(15000); // Chờ 15s để hồi phục
        
        if (global.updateStudioProgress) {
          global.updateStudioProgress(35, 'Đang dịch phụ đề sang tiếng Việt bằng AI...');
        }

        // Thử dịch lại toàn bộ lô đó một lần cuối cùng
        try {
          if (isCancelled && isCancelled()) return;
          const { text } = await translate(textToTranslate, { to: 'vi' });
          consecutiveFailures = 0; // Reset lỗi
          const normalizedText = text.normalize('NFC');
          const translatedParts = normalizedText.split(/\|\|\||\| \| \|/i).map(s => s.trim());
          if (translatedParts.length === batch.length) {
            for (let j = 0; j < batch.length; j++) {
              const processed = postProcessText(translatedParts[j]);
              batch[j].text = wrapOrClean(processed);
            }
            console.log(`Đã phục hồi dịch thành công sau cool-down cho lô từ ${i} đến ${i + batch.length}.`);
            continue;
          }
        } catch (retryErr) {
          console.error('Dịch lại lô thất bại sau cool-down:', retryErr.message);
        }
      }
      
      // Giữ nguyên câu gốc cho lô hiện tại nếu lỗi hoặc sau khi thử lại vẫn lỗi
      console.warn(`Giữ nguyên phụ đề gốc cho lô dịch từ ${i} đến ${i + batch.length} do lỗi dịch.`);
      for (const item of batch) {
        item.text = wrapOrClean(item.text);
      }
    }
    
    console.log(`Đã dịch ${Math.min(i + batchSize, srtArray.length)}/${srtArray.length} dòng.`);
  }

  const translatedContent = parser.toSrt(srtArray);
  fs.writeFileSync(outputPath, translatedContent, 'utf8');
  
  try {
    formatSubtitleFile(outputPath, maxLines, maxCharsPerLine);
  } catch (err) {
    console.error('Lỗi định dạng phụ đề sau dịch:', err.message);
  }

  console.log(`Đã dịch và lưu phụ đề tiếng Việt tại: ${outputPath}`);
}

module.exports = { translateSubtitles, formatSubtitleFile, srtTimeToMs, msToSrtTime };
