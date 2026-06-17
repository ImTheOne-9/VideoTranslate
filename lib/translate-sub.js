const fs = require('fs');
const Parser = require('srt-parser-2').default;

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

function srtTimeToMs(timeStr) {
  if (!timeStr) return 0;
  try {
    const parts = timeStr.split(':');
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

// Định dạng lại toàn bộ file phụ đề để tất cả các khối sub có tối đa 2 dòng và độ dài vừa vặn
function formatSubtitleFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const parser = new Parser();
  const srtArray = parser.fromSrt(content);
  
  // 1. Chia nhỏ các khối sub quá dài
  let newSrtArray = [];
  for (const item of srtArray) {
    newSrtArray.push(...splitSubtitleItem(item, 36));
  }
  
  // 2. Đánh lại ID và định dạng thành tối đa 2 dòng cân đối
  newSrtArray.forEach((item, idx) => {
    item.id = String(idx + 1);
    item.text = wrapTextToTwoLines(item.text, 22);
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

async function translateSubtitles(inputPath, outputPath) {
  const content = fs.readFileSync(inputPath, 'utf8');
  const parser = new Parser();
  const srtArray = parser.fromSrt(content);

  console.log(`Bắt đầu dịch ${srtArray.length} dòng phụ đề...`);

  const batchSize = 10;
  for (let i = 0; i < srtArray.length; i += batchSize) {
    const batch = srtArray.slice(i, i + batchSize);
    
    // Áp dụng tiền xử lý từ điển trước khi dịch
    const textToTranslate = batch.map(item => {
      const clean = preProcessText(item.text);
      return clean.replace(/\n/g, ' ');
    }).join(' ||| ');
    
    // Giãn cách nhẹ giữa các đợt dịch
    if (i > 0) {
      await sleep(1000);
    }

    try {
      const { text } = await translate(textToTranslate, { to: 'vi' });
      const normalizedText = text.normalize('NFC');
      const translatedParts = normalizedText.split(/\|\|\||\| \| \|/i).map(s => s.trim());
      
      if (translatedParts.length === batch.length) {
        for (let j = 0; j < batch.length; j++) {
          const processed = postProcessText(translatedParts[j]);
          batch[j].text = wrapTextToTwoLines(processed, 22);
        }
      } else {
        console.warn(`Số phần dịch không khớp (${translatedParts.length} vs ${batch.length}). Đang tự động chuyển sang dịch dòng đơn...`);
        for (const item of batch) {
          try {
            const cleanText = preProcessText(item.text);
            const { text } = await translate(cleanText, { to: 'vi' });
            const processed = postProcessText(text.normalize('NFC'));
            item.text = wrapTextToTwoLines(processed, 22);
            await sleep(300); // Giãn cách ngắn tránh rate limit
          } catch (e) {
            console.error('Lỗi dịch dòng đơn:', e.message);
          }
        }
      }
    } catch (err) {
      console.error('Lỗi dịch lô phụ đề:', err.message);
      await sleep(2000);
      
      for (const item of batch) {
        try {
          const cleanText = preProcessText(item.text);
          const { text } = await translate(cleanText, { to: 'vi' });
          const processed = postProcessText(text.normalize('NFC'));
          item.text = wrapTextToTwoLines(processed, 22);
          await sleep(500); // Nghỉ ngắn giữa các dòng đơn lẻ
        } catch (e) {
          console.error('Lỗi dịch dòng đơn:', e.message);
        }
      }
    }
    
    console.log(`Đã dịch ${Math.min(i + batchSize, srtArray.length)}/${srtArray.length} dòng.`);
  }

  const translatedContent = parser.toSrt(srtArray);
  fs.writeFileSync(outputPath, translatedContent, 'utf8');
  
  // Định dạng lại file phụ đề tiếng Việt cuối cùng (chia nhỏ khối dài, wrap chuẩn 1-2 dòng ngắn)
  try {
    formatSubtitleFile(outputPath);
  } catch (err) {
    console.error('Lỗi định dạng phụ đề sau dịch:', err.message);
  }

  console.log(`Đã dịch và lưu phụ đề tiếng Việt tại: ${outputPath}`);
}

module.exports = { translateSubtitles, formatSubtitleFile, srtTimeToMs, msToSrtTime };
