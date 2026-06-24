const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app_id = '470eb36b-eca1-4d22-96b6-c88c997b5bea';
const user_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODIxNzkwMzd9.5k5_aMzZw-BQLLBPtFZMNL0O2bCS6mootc_UBMKlNIU';

const DEFAULT_VOICES_DIR = path.join(__dirname, '..', 'public', 'default_voices');

if (!fs.existsSync(DEFAULT_VOICES_DIR)) {
  fs.mkdirSync(DEFAULT_VOICES_DIR, { recursive: true });
}

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${user_token}`,
    'App-Id': app_id
  };
}

async function downloadSync(filename, voiceCode, text) {
  const url = 'https://api.vbee.vn/v1/tts';
  const data = {
    text: text,
    voiceCode: voiceCode,
    outputFormat: 'wav',
    speed: 1.0,
    mode: 'sync'
  };

  const audioPath = path.join(DEFAULT_VOICES_DIR, filename + '.wav');
  const txtPath = path.join(DEFAULT_VOICES_DIR, filename + '.txt');

  console.log(`[Vbee Sync] Requesting ${filename} (${voiceCode})...`);
  try {
    const response = await axios.post(url, data, {
      headers: getHeaders(),
      responseType: 'arraybuffer',
      timeout: 30000
    });

    fs.writeFileSync(audioPath, response.data);
    fs.writeFileSync(txtPath, text, 'utf8');
    console.log(`[SUCCESS] Saved sync voice to: ${audioPath}`);
    return true;
  } catch (err) {
    console.log(`[INFO] Sync download failed/not supported for ${voiceCode}. Error: ${err.message}. Retrying via Async...`);
    return false;
  }
}

async function downloadAsync(filename, voiceCode, text) {
  const url = 'https://api.vbee.vn/v1/tts';
  const data = {
    text: text,
    voiceCode: voiceCode,
    outputFormat: 'wav',
    speed: 1.0,
    mode: 'async',
    bitrate: 128,
    webhookUrl: 'https://example.com/callback'
  };

  const audioPath = path.join(DEFAULT_VOICES_DIR, filename + '.wav');
  const txtPath = path.join(DEFAULT_VOICES_DIR, filename + '.txt');

  console.log(`[Vbee Async] Requesting ${filename} (${voiceCode})...`);
  try {
    const response = await axios.post(url, data, {
      headers: getHeaders(),
      timeout: 30000
    });

    const requestId = response.data?.requestId;
    if (!requestId) {
      throw new Error('No requestId returned from Vbee.');
    }

    console.log(`[SUCCESS] Triggered async task for ${filename}. Request ID: ${requestId}. Polling status...`);

    let status = 'PROCESSING';
    let audioLink = null;
    const maxAttempts = 20;
    let attempts = 0;

    while (status === 'PROCESSING' && attempts < maxAttempts) {
      attempts++;
      console.log(`Polling status for ${filename} (Attempt ${attempts}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const pollRes = await axios.get(`https://api.vbee.vn/v1/tts/requests/${requestId}`, {
        headers: getHeaders(),
        timeout: 10000
      });

      status = pollRes.data?.status;
      console.log(`Status for ${filename}: ${status}`);

      if (status === 'COMPLETED') {
        audioLink = pollRes.data?.audioLink;
        break;
      } else if (status === 'FAILED') {
        throw new Error('Vbee async processing failed.');
      }
    }

    if (!audioLink) {
      throw new Error('Polling timed out or audio link not found.');
    }

    console.log(`Downloading audio file for ${filename} from: ${audioLink}`);
    const audioRes = await axios.get(audioLink, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    fs.writeFileSync(audioPath, audioRes.data);
    fs.writeFileSync(txtPath, text, 'utf8');
    console.log(`[SUCCESS] Saved async voice to: ${audioPath}`);
    return true;
  } catch (err) {
    console.error(`[ERROR] Async download failed for ${voiceCode}:`, err.message);
    return false;
  }
}

async function getVoice(filename, voiceCode, gender, text) {
  // If voice is female, try Sync first. If it fails, try Async.
  // If voice is male, go directly to Async (since Vbee males usually don't support sync mode).
  if (gender === 'female') {
    const success = await downloadSync(filename, voiceCode, text);
    if (success) return true;
  }
  return await downloadAsync(filename, voiceCode, text);
}

async function run() {
  const text = 'Chào mừng bạn đến với công cụ Video Studio Tools. Đây là giọng đọc mẫu lồng tiếng chất lượng cao.';
  
  const voicesToDownload = [
    { filename: 'Giọng Nữ miền Bắc', code: 'hn_female_ngochuyen_full_48k-fhg', gender: 'female' },
    { filename: 'Giọng Nam miền Bắc', code: 'hn_male_manhdung_news_48k-fhg', gender: 'male' },
    { filename: 'Giọng Nữ miền Nam', code: 'sg_female_lantrinh_vdts_48k-fhg', gender: 'female' },
    { filename: 'Giọng Nam miền Nam', code: 'sg_male_minhhoang_full_48k-fhg', gender: 'male' },
    { filename: 'Giọng Nữ miền Trung', code: 'hue_female_huonggiang_full_48k-fhg', gender: 'female' },
    { filename: 'Giọng Nam miền Trung', code: 'hue_male_duyphuong_full_48k-fhg', gender: 'male' }
  ];

  console.log(`Starting to download ${voicesToDownload.length} default voices...`);
  
  let successCount = 0;
  for (const voice of voicesToDownload) {
    // Skip if file already exists to save API quota, unless forced
    const wavExists = fs.existsSync(path.join(DEFAULT_VOICES_DIR, voice.filename + '.wav'));
    const txtExists = fs.existsSync(path.join(DEFAULT_VOICES_DIR, voice.filename + '.txt'));
    if (wavExists && txtExists) {
      console.log(`\n[SKIP] Voice ${voice.filename} already exists.`);
      successCount++;
      continue;
    }
    
    const success = await getVoice(voice.filename, voice.code, voice.gender, text);
    if (success) successCount++;
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\n===========================================`);
  console.log(`Downloaded ${successCount}/${voicesToDownload.length} default voices successfully!`);
  console.log(`===========================================`);
}

run();
