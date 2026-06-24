const axios = require('axios');

const app_id = '470eb36b-eca1-4d22-96b6-c88c997b5bea';
const user_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3ODIxNzkwMzd9.5k5_aMzZw-BQLLBPtFZMNL0O2bCS6mootc_UBMKlNIU';

async function run() {
  try {
    let voices = [];
    let nextCursor = null;
    let hasNext = true;
    let page = 1;

    while (hasNext) {
      console.log(`Fetching page ${page}...`);
      const url = `https://vbee.vn/api/public/v1/voices?voiceOwnership=VBEE&languageCode=vi-VN${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`;
      
      const res = await axios.get(url, {
        headers: {
          'app-id': app_id,
          'Authorization': `Bearer ${user_token}`
        }
      });

      const pageVoices = res.data?.result?.voices || [];
      voices = voices.concat(pageVoices);
      nextCursor = res.data?.result?.pagination?.next_cursor;
      hasNext = res.data?.result?.pagination?.has_next_page && nextCursor;
      page++;
      
      // Safety limit
      if (page > 10) break;
    }

    console.log(`Found a total of ${voices.length} voices.`);

    const text = 'Chào mừng bạn đến với công cụ Video Studio Tools.';
    const syncVoices = [];

    // Let's first filter male voices and test them
    const maleVoices = voices.filter(v => v.gender === 'male');
    console.log(`Testing ${maleVoices.length} male voices...`);

    for (const voice of maleVoices) {
      const code = voice.code;
      const name = voice.name;
      console.log(`Testing ${name} (${code})...`);
      try {
        const response = await axios.post('https://api.vbee.vn/v1/tts', {
          text: text,
          voiceCode: code,
          outputFormat: 'wav',
          speed: 1.0,
          mode: 'sync'
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${user_token}`,
            'App-id': app_id
          },
          responseType: 'arraybuffer',
          timeout: 4000
        });
        
        if (response.status === 200) {
          console.log(`-> SUCCESS! Supports sync!`);
          syncVoices.push({ code, name, gender: 'male' });
        }
      } catch (err) {
        // error
      }
    }

    console.log('\n--- Sync Supported MALE Voices List: ---');
    console.log(JSON.stringify(syncVoices, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
