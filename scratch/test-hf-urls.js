const https = require('https');

function checkUrl(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      resolve(res.statusCode);
    }).on('error', (err) => {
      resolve(err.message);
    });
  });
}

async function main() {
  const txtUrl = 'https://huggingface.co/Systran/faster-whisper-large-v3/resolve/main/vocabulary.txt';
  const jsonUrl = 'https://huggingface.co/Systran/faster-whisper-large-v3/resolve/main/vocabulary.json';
  
  console.log('Checking vocabulary.txt...');
  const txtStatus = await checkUrl(txtUrl);
  console.log('vocabulary.txt status:', txtStatus);
  
  console.log('Checking vocabulary.json...');
  const jsonStatus = await checkUrl(jsonUrl);
  console.log('vocabulary.json status:', jsonStatus);
}

main();
