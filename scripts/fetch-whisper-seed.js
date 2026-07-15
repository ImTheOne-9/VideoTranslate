// Build-time seed fetcher: đảm bảo tools/whisper.cpp/seed-models có ggml-base + VAD
// Chạy trước electron-dist (đã thêm vào package.json script "electron-dist").
// Kết quả được bundle qua extraResources, rồi runtime copy sang MODELS_DIR (seedBundledWhisperModels).
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'tools', 'whisper.cpp', 'seed-models');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        file.close(); try { fs.unlinkSync(dest); } catch (e) {}
        try { res.resume(); } catch (e) {}
        return download(new URL(res.headers.location, url).href, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(dest); } catch (e) {} return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => { console.log('  downloaded -> ' + path.basename(dest)); resolve(); }));
    }).on('error', (err) => { try { fs.unlink(dest, () => {}); } catch (e) {} reject(err); });
  });
}

async function main() {
  ensureDir(path.join(SEED, 'ggml-base'));
  ensureDir(path.join(SEED, 'vad'));

  // 1) ggml-base.bin từ ggerganov/whisper.cpp
  const baseDest = path.join(SEED, 'ggml-base', 'ggml-base.bin');
  if (fs.existsSync(baseDest) && fs.statSync(baseDest).size > 100 * 1024 * 1024) {
    console.log('[seed] ggml-base.bin da co, bo qua.');
  } else {
    console.log('[seed] Tai ggml-base.bin (142MB) tu HuggingFace...');
    await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', baseDest);
  }

  // 2) VAD silero: copy tu models/whisper/vad cua dev neu co, khong thi bo qua (dev phai co san)
  const vadDest = path.join(SEED, 'vad', 'ggml-silero-v6.2.0.bin');
  if (fs.existsSync(vadDest) && fs.statSync(vadDest).size > 0) {
    console.log('[seed] VAD da co, bo qua.');
  } else {
    const devVad = path.join(ROOT, 'models', 'whisper', 'vad', 'ggml-silero-v6.2.0.bin');
    if (fs.existsSync(devVad)) {
      fs.copyFileSync(devVad, vadDest);
      console.log('[seed] Copy VAD tu models/whisper/vad -> seed-models/vad');
    } else {
      console.warn('[seed] CANH BAO: khong tim thay VAD o models/whisper/vad. Vui long copy ggml-silero-v6.2.0.bin vao tools/whisper.cpp/seed-models/vad truoc khi build.');
    }
  }

  console.log('[seed] Xong. Thu muc seed:', SEED);
  process.exit(0);
}

main().catch((e) => { console.error('[seed] Loi:', e.message); process.exit(1); });
