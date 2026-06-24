const https = require('https');
const fs = require('fs');
const path = require('path');

const url = 'https://huggingface.co/Systran/faster-whisper-large-v3/resolve/main/preprocessor_config.json';
const dest = path.join(__dirname, '..', 'models', 'whisper', 'large-v3', 'preprocessor_config.json');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return download(redirectUrl, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('Status: ' + res.statusCode));
      }
      console.log('Content-Length:', res.headers['content-length']);
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(res.headers['content-length']));
      });
    }).on('error', reject);
  });
}

download(url, dest)
  .then((len) => console.log('Downloaded preprocessor_config.json successfully, size:', len))
  .catch((err) => console.error('Failed to download:', err));
