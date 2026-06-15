const fs = require('fs');
const Parser = require('srt-parser-2').default;
const { translate } = require('@vitalets/google-translate-api');

async function translateSubtitles(inputPath, outputPath) {
  const content = fs.readFileSync(inputPath, 'utf8');
  const parser = new Parser();
  const srtArray = parser.fromSrt(content);

  console.log(`Bắt đầu dịch ${srtArray.length} dòng phụ đề...`);

  const batchSize = 10;
  for (let i = 0; i < srtArray.length; i += batchSize) {
    const batch = srtArray.slice(i, i + batchSize);
    
    const textToTranslate = batch.map(item => item.text.replace(/\n/g, ' ')).join(' ||| ');
    
    try {
      const { text } = await translate(textToTranslate, { to: 'vi' });
      const translatedParts = text.split(/\|\|\||\| \| \|/i).map(s => s.trim());
      
      for (let j = 0; j < batch.length; j++) {
        if (translatedParts[j]) {
          batch[j].text = translatedParts[j];
        }
      }
    } catch (err) {
      console.error('Lỗi dịch lô phụ đề:', err.message);
      for (const item of batch) {
        try {
          const { text } = await translate(item.text, { to: 'vi' });
          item.text = text;
        } catch (e) {
          console.error('Lỗi dịch dòng:', e.message);
        }
      }
    }
    
    console.log(`Đã dịch ${Math.min(i + batchSize, srtArray.length)}/${srtArray.length} dòng.`);
  }

  const translatedContent = parser.toSrt(srtArray);
  fs.writeFileSync(outputPath, translatedContent, 'utf8');
  console.log(`Đã lưu phụ đề tiếng Việt tại: ${outputPath}`);
}

module.exports = { translateSubtitles };
