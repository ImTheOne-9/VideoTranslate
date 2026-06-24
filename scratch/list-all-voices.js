const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
      
      if (page > 20) break;
    }

    console.log(`Found a total of ${voices.length} voices.`);
    
    // Sort and map them
    const formattedVoices = voices.map(v => ({
      code: v.code,
      name: v.name,
      gender: v.gender,
      region: v.region,
      description: v.description,
      voiceQuality: v.voiceQuality
    }));

    const outputPath = path.join(__dirname, 'all_vbee_voices.json');
    fs.writeFileSync(outputPath, JSON.stringify(formattedVoices, null, 2), 'utf8');
    console.log(`Saved voices list to: ${outputPath}`);

  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
