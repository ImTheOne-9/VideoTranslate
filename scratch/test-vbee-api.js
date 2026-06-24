const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app_id = '470eb36b-eca1-4d22-96b6-c88c997b5bea';
const user_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODIxNzkwMzd9.5k5_aMzZw-BQLLBPtFZMNL0O2bCS6mootc_UBMKlNIU';

async function generateVoice(filename, voiceCode, text) {
  const url = 'https://api.vbee.vn/v1/tts';
  const data = {
    text: text,
    voiceCode: voiceCode,
    outputFormat: 'wav',
    speed: 1.0,
    mode: 'sync'
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${user_token}`,
    'App-id': app_id
  };

  console.log(`Sending request to Vbee for ${voiceCode}...`);
  try {
    const response = await axios.post(url, data, {
      headers: headers,
      responseType: 'arraybuffer', // Get raw audio binary
      timeout: 20000
    });

    console.log(`SUCCESS [${response.status}] for ${voiceCode}, received ${response.data.byteLength} bytes.`);
    const savePath = path.join(__dirname, filename);
    fs.writeFileSync(savePath, response.data);
    console.log(`Saved audio to ${savePath}`);
    return true;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      let errMsg = err.response.data;
      if (err.response.headers['content-type'] && err.response.headers['content-type'].includes('application/json')) {
        try {
          errMsg = JSON.parse(Buffer.from(err.response.data).toString('utf8'));
        } catch (e) {}
      } else {
        errMsg = Buffer.from(err.response.data).toString('utf8');
      }
      console.log(`ERROR [${status}]:`, errMsg);
    } else {
      console.log('ERROR:', err.message);
    }
    return false;
  }
}

async function run() {
  const text = 'Chào mừng bạn đến với công cụ Video Studio Tools. Đây là giọng đọc mẫu lồng tiếng của Vbee AI.';
  
  // Test with hn_female_ngochuyen_full_48k-fhg
  await generateVoice('test_nu_bac.wav', 'hn_female_ngochuyen_full_48k-fhg', text);
}

run();
