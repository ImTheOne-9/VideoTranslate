'use strict';

// ============================================================================
// controllers/antiDupeController.js
// Hai nhóm tính năng:
//   (1) renderAntiDupe  — NÉ TRÙNG render (flip + setpts + eq + trim + drawtext
//                          + scale/crop + volume) -> *_xuly.mp4
//   (2) renderSceneSplit — BĂM VIDEO THEO CẢNH (FFmpeg scene detect) + render từng
//                          clip, BỎ setpts(tốc độ) và eq(màu) đúng yêu cầu.
// Tiến độ qua shared.state.antiDupeProgress; frontend poll /api/anti-dupe-progress.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const shared = require('../lib/shared-state');
const anti = require('../lib/anti-dupe');

// Trạng thái một tác vụ duy nhất (giống studio render)
let activeJob = null;

function snapshot() {
  if (!activeJob) {
    return { status: 'idle', percent: 0, step: '', error: null, type: null, id: null, result: null, clips: null, total: 0, current: 0 };
  }
  return {
    id: activeJob.id, type: activeJob.type, status: activeJob.status,
    percent: activeJob.percent, step: activeJob.step,
    error: activeJob.error || null, result: activeJob.result || null,
    clips: activeJob.clips || null, total: activeJob.total || 0, current: activeJob.current || 0
  };
}

function setProgress(job, percent, step, extra) {
  job.percent = Math.max(0, Math.min(100, Math.round(percent)));
  job.step = step;
  if (extra) Object.assign(job, extra);
}

function isRunning() {
  return activeJob && (activeJob.status === 'running' || activeJob.status === 'rendering');
}

function hasCUDA() {
  return process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\nvcuda.dll');
}
function encoderArgs() {
  return hasCUDA()
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '24']
    : ['-c:v', 'libx264', '-preset', 'veryfast'];
}

function baseName(p) { return path.basename(p, path.extname(p)); }
function safeBaseName(p) { return baseName(p).replace(/[^\w\-_. ]+/g, '_').slice(0, 80); }
function pad2(n) { return String(n).padStart(2, '0'); }

function resolveSource(req) {
  if (req.file) {
    return shared.moveUploadedFile(req.file, shared.DOWNLOADS_DIR, req.file.originalname);
  }
  if (req.body && req.body.mainVideoFile) {
    return shared.resolveAssetPath('video', req.body.mainVideoFile);
  }
  return null;
}

function killProc(proc) {
  if (!proc || !proc.pid) return;
  ['stdin', 'stdout', 'stderr'].forEach(s => { try { if (proc[s] && !proc[s].destroyed) proc[s].destroy(); } catch (e) {} });
  try { execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', timeout: 5000 }); }
  catch (e) { try { proc.kill('SIGKILL'); } catch (e2) {} }
}

// Chạy 1 lệnh FFmpeg, cập nhật tiến độ theo time= trong stderr
function runFFmpeg(args, totalDuration, job, basePct, span, label) {
  return new Promise((resolve, reject) => {
    const proc = shared.spawn(shared.FFMPEG_PATH, args);
    job.proc = proc;
    let stderr = '';
    proc.stderr.on('data', chunk => {
      const s = chunk.toString('utf8');
      stderr += s;
      if (totalDuration > 0) {
        const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m) {
          const cur = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
          const p = (cur / totalDuration) * 100;
          setProgress(job, basePct + (p * span / 100), `${label} ${cur.toFixed(1)}s/${totalDuration.toFixed(1)}s`);
        }
      }
    });
    proc.on('close', code => {
      job.proc = null;
      if (job.cancelled) return reject(new Error('Đã hủy bởi người dùng'));
      if (code === 0) resolve();
      else reject(new Error(`Lỗi FFmpeg (code ${code}): ${stderr.slice(-1200)}`));
    });
    proc.on('error', e => { job.proc = null; reject(e); });
  });
}

function buildRenderArgs(source, built, cfg, outPath) {
  const args = ['-y', '-i', source];
  if (built.useLogo && cfg.logoPath) args.push('-i', cfg.logoPath);
  if (built.segments.length) args.push('-filter_complex', built.segments.join(';'));
  args.push('-map', built.hasVideo ? '[vout]' : '0:v');
  args.push('-map', built.hasAudio ? '[aout]' : '0:a?');
  if (built.hasVideo) args.push(...encoderArgs()); else args.push('-c:v', 'copy');
  args.push('-c:a', built.hasAudio ? 'aac' : 'copy');
  args.push('-movflags', '+faststart', '-shortest', outPath);
  return args;
}

// Resolve thư mục xuất: mặc định RENDERS_DIR (servable qua /renders)
function resolveOutDir(body) {
  let d = (body.outputDir || '').toString().trim();
  if (!d) return shared.RENDERS_DIR;
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
  catch (e) { d = shared.RENDERS_DIR; }
  return d;
}
function urlForOutDir(outDir, outName) {
  const r = path.resolve(shared.RENDERS_DIR);
  const dl = path.resolve(shared.DOWNLOADS_DIR);
  const od = path.resolve(outDir);
  if (od === r) return `/renders/${encodeURIComponent(outName)}`;
  if (od === dl) return `/downloads/${encodeURIComponent(outName)}`;
  // Custom directory: serve via /api/serve-file
  return `/api/serve-file?path=${encodeURIComponent(path.join(od, outName))}`;
}

// ---- Tiện ích cho handler ---------------------------------------------------
function newJob(type) {
  return {
    id: `ad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type, status: 'running', percent: 0, step: 'Đang khởi tạo...',
    error: null, result: null, clips: null, total: 0, current: 0,
    cancelled: false, proc: null
  };
}

// Nguồn: ưu tiên file upload, sau đó là tên video đã có trong downloads
function resolveSrc(req) {
  if (req.files && req.files.videoUpload && req.files.videoUpload[0]) {
    const f = req.files.videoUpload[0];
    return shared.moveUploadedFile(f, shared.DOWNLOADS_DIR, f.originalname);
  }
  if (req.body && req.body.mainVideoFile) {
    return shared.resolveAssetPath('video', req.body.mainVideoFile);
  }
  return null;
}

// Logo: file upload hoặc đường dẫn tuyệt đối
function resolveLogo(req, workDir) {
  if (req.files && req.files.logoUpload && req.files.logoUpload[0]) {
    const f = req.files.logoUpload[0];
    return shared.moveUploadedFile(f, workDir, f.originalname);
  }
  const p = ((req.body && req.body.logoPath) || '').toString().trim();
  return (p && fs.existsSync(p)) ? p : '';
}

// ---- (1) RENDER NÉ TRÙNG -----------------------------------------------------
// flip -> setpts(tốc độ) -> eq(màu) -> trim(cắt đầu/cuối) -> scale/crop(tỉ lệ)
// -> drawtext(watermark) -> volume. Xuất *_xuly.mp4. Hỗ trợ Preview 5s.
async function renderAntiDupe(req, res) {
  if (isRunning()) {
    return res.status(409).json({ error: 'Đang có tác vụ né trùng/băm cảnh chạy. Hãy đợi hoặc hủy trước.' });
  }
  const source = resolveSrc(req);
  if (!source) {
    return res.status(400).json({ error: 'Thiếu video nguồn. Chọn video trong kho hoặc tải file lên.' });
  }
  const job = newJob('antidupe');
  activeJob = job;
  const workDir = fs.mkdtempSync(path.join(shared.TMP_UPLOADS_DIR, 'ad-'));
  try {
    setProgress(job, 2, 'Đang đọc thông tin video...');
    const info = await anti.getVideoInfo(source);
    const durationSec = info.durationSec || 0;

    // "Cắt đầu/cắt cuối (giây)" = số giây BỎ ở đầu/cuối. Đổi sang cửa sổ tuyệt đối:
    // trước đây endSec bị dùng thành mốc kết thúc tuyệt đối -> render ra clip 1s/0s.
    const trimWin = anti.resolveTrimWindow(req.body.startSec, req.body.endSec, durationSec);
    const cfg = {
      flip: anti.bool(req.body.flip),
      startSec: trimWin.start,
      endSec: trimWin.end,
      aspect: (req.body.aspect || 'keep').toString().trim(),
      watermarkText: (req.body.watermarkText || '').toString().trim(),
      watermarkPos: (req.body.watermarkPos || 'br').toString().trim(),
      watermarkSize: anti.num(req.body.watermarkSize, 30),
      watermarkColor: (req.body.watermarkColor || 'white').toString().trim(),
      watermarkAlpha: anti.num(req.body.watermarkAlpha, 0.85),
      logoPath: resolveLogo(req, workDir),
      logoPos: (req.body.logoPos || 'br').toString().trim()
    };
    // Preview 5s: chỉ render 5 giây đầu (sau cắt đầu)
    if (anti.bool(req.body.preview5s)) cfg.endSec = (cfg.startSec || 0) + 5;

    const built = anti.buildAntiDupeFilters(cfg, { workDir, durationSec });

    let outName = (req.body.outputName || '').toString().trim();
    if (!outName) outName = safeBaseName(source) + '_xuly.mp4';
    if (!/\.mp4$/i.test(outName)) outName += '.mp4';
    const outDir = resolveOutDir(req.body);
    const outPath = shared.getUniqueFilePath(outDir, outName.replace(/\.mp4$/i, ''), '.mp4');

    const args = buildRenderArgs(source, built, cfg, outPath);
    setProgress(job, 5, 'Bắt đầu render né trùng...');
    const total = built.outDurationSec || durationSec || 0;
    await runFFmpeg(args, total, job, 5, 90, 'Render né trùng');

    setProgress(job, 100, 'Hoàn tất render né trùng!');
    job.status = 'done';
    const url = urlForOutDir(outDir, path.basename(outPath));
    const result = { file: path.basename(outPath), url, path: outPath, durationSec: total };
    job.result = result;
    activeJob = null;
    return res.json(Object.assign({ success: true, message: 'Đã render né trùng xong' }, result));
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    setProgress(job, job.percent, 'Lỗi: ' + e.message);
    activeJob = null;
    return res.status(500).json({ error: e.message });
  } finally {
    try { if (workDir && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- (2) BĂM VIDEO THEO CẢNH ------------------------------------------------
// Phát hiện cảnh bằng FFmpeg (KHÔNG cần PySceneDetect) rồi render từng clip.
// Mỗi clip dùng cùng nhóm filter NHƯNG BỎ setpts(tốc độ) và eq(màu).
async function renderSceneSplit(req, res) {
  if (isRunning()) {
    return res.status(409).json({ error: 'Đang có tác vụ né trùng/băm cảnh chạy. Hãy đợi hoặc hủy trước.' });
  }
  const source = resolveSrc(req);
  if (!source) {
    return res.status(400).json({ error: 'Thiếu video nguồn. Chọn video trong kho hoặc tải file lên.' });
  }
  const job = newJob('scenesplit');
  activeJob = job;
  const workDir = fs.mkdtempSync(path.join(shared.TMP_UPLOADS_DIR, 'ad-'));
  try {
    setProgress(job, 2, 'Đang đọc thông tin video...');
    const info = await anti.getVideoInfo(source);
    const durationSec = info.durationSec || 0;
    if (durationSec <= 0) throw new Error('Không đọc được thời lượng video nguồn.');

    setProgress(job, 4, 'Đang phát hiện cảnh bằng FFmpeg...');
    const sensitivity = (req.body.sensitivity || 'medium').toString();
    const cuts = await anti.detectSceneCuts(source, sensitivity);
    const numCopies = Math.max(0, parseInt(req.body.numCopies, 10) || 0);
    setProgress(job, 8, `Lập kế hoạch chia cảnh (${cuts.length} điểm cắt)...`);
    const segs = anti.planSceneSegments(cuts, durationSec, numCopies);
    if (!segs.length) throw new Error('Không thể chia cảnh: video quá ngắn hoặc không phát hiện được cảnh.');

    job.total = segs.length;
    job.clips = [];

    const baseCfg = {
      flip: anti.bool(req.body.flip),
      aspect: (req.body.aspect || 'keep').toString().trim(),
      watermarkText: (req.body.watermarkText || '').toString().trim(),
      watermarkPos: (req.body.watermarkPos || 'br').toString().trim(),
      watermarkSize: anti.num(req.body.watermarkSize, 30),
      watermarkColor: (req.body.watermarkColor || 'white').toString().trim(),
      watermarkAlpha: anti.num(req.body.watermarkAlpha, 0.85),
      logoPath: resolveLogo(req, workDir),
      logoPos: (req.body.logoPos || 'br').toString().trim()
    };
    const outDir = resolveOutDir(req.body);
    const baseNm = safeBaseName(source);
    const span = 87 / segs.length;

    for (let i = 0; i < segs.length; i++) {
      if (job.cancelled) throw new Error('Đã hủy bởi người dùng');
      const s = segs[i];
      job.current = i + 1;
      const cfg2 = Object.assign({}, baseCfg, { startSec: s.start, endSec: s.end });
      const built = anti.buildAntiDupeFilters(cfg2, { workDir, durationSec: s.duration });
      const outPath = shared.getUniqueFilePath(outDir, `${baseNm}_clip_${pad2(i + 1)}`, '.mp4');
      const args = buildRenderArgs(source, built, cfg2, outPath);
      const basePct = 10 + i * span;
      await runFFmpeg(args, s.duration, job, basePct, span, `Băm clip ${i + 1}/${segs.length}`);
      const url = urlForOutDir(outDir, path.basename(outPath));
      job.clips.push({ index: i + 1, file: path.basename(outPath), url, path: outPath, start: s.start, end: s.end, duration: s.duration });
    }

    setProgress(job, 100, `Hoàn tất băm cảnh: ${segs.length} clip!`);
    job.status = 'done';
    const result = { clips: job.clips, count: segs.length };
    job.result = result;
    activeJob = null;
    return res.json(Object.assign({ success: true, message: `Đã băm thành ${segs.length} clip` }, result));
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    setProgress(job, job.percent, 'Lỗi: ' + e.message);
    activeJob = null;
    return res.status(500).json({ error: e.message });
  } finally {
    try { if (workDir && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- Tiến độ / Hủy ----------------------------------------------------------
function getProgress(req, res) {
  return res.json(snapshot());
}

function cancel(req, res) {
  if (!activeJob) return res.json({ success: false, message: 'Không có tác vụ nào đang chạy.' });
  activeJob.cancelled = true;
  activeJob.status = 'cancelled';
  activeJob.step = 'Đang hủy...';
  killProc(activeJob.proc);
  return res.json({ success: true, message: 'Đã gửi yêu cầu hủy tác vụ.' });
}

module.exports = { renderAntiDupe, renderSceneSplit, getProgress, cancel };
