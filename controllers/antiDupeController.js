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
const os = require('os');
const crypto = require('crypto');
const { execFile, execSync } = require('child_process');
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
    clips: activeJob.clips || null, total: activeJob.total || 0, current: activeJob.current || 0,
    logs: (activeJob.logs || []).slice(-120)
  };
}

function setProgress(job, percent, step, extra) {
  job.percent = Math.max(0, Math.min(100, Math.round(percent)));
  job.step = step;
  if (step && job.logs && job.logs.at(-1) !== step) {
    job.logs.push(step);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  }
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
function safeBaseName(p) {
  return baseName(p).replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || 'video';
}
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
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
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
    cancelled: false, proc: null, logs: []
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

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
}

function resolveSplitSources(req) {
  const sources = [];
  for (const file of req.files?.videoUpload || []) {
    const moved = shared.moveUploadedFile(file, shared.DOWNLOADS_DIR, file.originalname);
    if (moved) sources.push(moved);
  }
  const requested = [req.body?.mainVideoFile, ...parseStringArray(req.body?.mainVideoFiles)].filter(Boolean);
  for (const filename of requested) {
    const resolved = shared.resolveAssetPath('video', filename);
    if (resolved) sources.push(resolved);
  }
  return [...new Set(sources.map((source) => path.resolve(source)))];
}

function sourceReference(source) {
  const root = path.resolve(shared.DOWNLOADS_DIR);
  const resolved = path.resolve(source);
  return resolved.startsWith(`${root}${path.sep}`) ? path.relative(root, resolved) : '';
}

function defaultSplitOutDir(source) { return path.join(path.dirname(source), 'clip_nho'); }

function splitSignature(source, segments, config) {
  let stat = null;
  try { stat = fs.statSync(source); } catch (_) {}
  return crypto.createHash('sha256').update(JSON.stringify({
    source: path.resolve(source), size: stat?.size || 0, mtimeMs: Math.round(stat?.mtimeMs || 0),
    segments: segments.map(({ start, end }) => [Number(start.toFixed(3)), Number(end.toFixed(3))]),
    aspect: config.aspect, flip: config.flip, precise: config.precise
  })).digest('hex');
}

function splitSignaturePath(outDir, source) {
  const sourceHash = crypto.createHash('sha1').update(path.resolve(source)).digest('hex').slice(0, 10);
  return path.join(outDir, `.bam-${sourceHash}.json`);
}

function readSplitSignature(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function writeSplitSignature(filePath, payload) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function clipOutputName(source, index, aspect) {
  const suffix = aspect && aspect !== 'keep' ? `_${aspect.replace(':', 'x')}` : '';
  return `${safeBaseName(source)}_clip_${pad2(index)}${suffix}.mp4`;
}

function cleanupStaleSplitOutputs(outDir, source) {
  const prefix = `${safeBaseName(source)}_clip_`;
  let entries = [];
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch (_) {}
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !/\.mp4$/i.test(entry.name)) continue;
    try { fs.unlinkSync(path.join(outDir, entry.name)); } catch (_) {}
  }
}

function ensureEditorPreview(source, info) {
  const compatibleContainer = ['.mp4', '.m4v', '.mov'].includes(path.extname(source).toLowerCase());
  if (compatibleContainer && ['h264', 'avc1'].includes(String(info.videoCodec || '').toLowerCase())) return Promise.resolve('');
  const stat = fs.statSync(source);
  const previewDir = path.join(shared.UPLOADS_DIR, 'bam-preview-cache');
  fs.mkdirSync(previewDir, { recursive: true });
  const key = crypto.createHash('sha1').update(`${path.resolve(source)}:${stat.size}:${Math.round(stat.mtimeMs)}`).digest('hex');
  const output = path.join(previewDir, `${key}.mp4`);
  if (fs.existsSync(output) && fs.statSync(output).size > 1024) return Promise.resolve(`/api/serve-file?path=${encodeURIComponent(output)}`);
  return new Promise((resolve, reject) => {
    execFile(shared.FFMPEG_PATH, ['-y', '-i', source, '-map', '0:v:0', '-map', '0:a?',
      '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output],
    { timeout: Math.max(300000, Math.ceil((info.durationSec || 0) * 3000)), maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error && fs.existsSync(output) && fs.statSync(output).size > 1024) return resolve(`/api/serve-file?path=${encodeURIComponent(output)}`);
      try { fs.unlinkSync(output); } catch (_) {}
      reject(new Error(`Không tạo được bản xem trước tương thích: ${String(stderr || error?.message || '').slice(-500)}`));
    });
  });
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

async function analyzeSceneSplit(req, res) {
  if (isRunning()) {
    return res.status(409).json({ error: 'Đang có tác vụ né trùng/băm cảnh chạy. Hãy đợi hoặc hủy trước.' });
  }
  const source = resolveSplitSources(req)[0];
  if (!source) {
    return res.status(400).json({ error: 'Thiếu video nguồn. Chọn video trong kho hoặc tải file lên.' });
  }
  try {
    const info = await anti.getVideoInfo(source);
    if (!info.durationSec) throw new Error('Không đọc được thời lượng video nguồn.');
    const skippedLongVideo = info.durationSec > 2400;
    const cuts = await anti.detectSceneCuts(source, req.body?.sensitivity || 'medium', { durationSec: info.durationSec });
    const previewUrl = await ensureEditorPreview(source, info);
    return res.json({ success: true, source: sourceReference(source), name: path.basename(source),
      durationSec: info.durationSec, width: info.width, height: info.height, cuts, skippedLongVideo, previewUrl });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function runSceneSplitJob(job, sources, body) {
  const customOutputDir = String(body.outputDir || '').trim();
  const sensitivity = String(body.sensitivity || 'medium');
  const mode = String(body.splitMode || 'count');
  const numCopies = Math.max(1, Math.min(200, parseInt(body.numCopies, 10) || 5));
  const targetSeconds = Math.max(3, Math.min(600, Number(body.targetSeconds) || 40));
  const aspect = String(body.aspect || 'keep');
  const flip = anti.bool(body.flip);
  const precise = anti.bool(body.precise);
  let manualRanges = null;
  try {
    const parsed = JSON.parse(String(body.ranges || 'null'));
    if (Array.isArray(parsed)) manualRanges = parsed.map((range) => ({ start: Number(range?.[0]), end: Number(range?.[1]) }))
      .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start >= 0.5);
  } catch (_) {}

  job.totalVideos = sources.length;
  job.clips = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    if (job.cancelled) throw new Error('Đã hủy bởi người dùng');
    const source = sources[sourceIndex];
    setProgress(job, (sourceIndex / sources.length) * 95, `Đang đọc ${sourceIndex + 1}/${sources.length}: ${path.basename(source)}`);
    const info = await anti.getVideoInfo(source);
    if (!info.durationSec) throw new Error(`Không đọc được thời lượng: ${path.basename(source)}`);
    let segments;
    if (manualRanges && sourceIndex === 0) {
      segments = manualRanges.map((range, index) => ({ index: index + 1, ...range, duration: range.end - range.start }));
    } else {
      let cuts = [];
      if (info.durationSec > 2400) {
        setProgress(job, job.percent, `Video ${Math.round(info.durationSec / 60)} phút: chia đều để tránh treo máy.`);
      } else {
        setProgress(job, job.percent, `Đang dò cảnh ${sourceIndex + 1}/${sources.length}…`);
        cuts = await anti.detectSceneCuts(source, sensitivity, {
          durationSec: info.durationSec,
          onProcess: (proc) => { job.proc = proc; }
        });
        if (job.cancelled) throw new Error('Đã hủy bởi người dùng');
      }
      segments = mode === 'duration'
        ? anti.planTargetDurationSegments(cuts, info.durationSec, targetSeconds)
        : anti.planSceneSegments(cuts, info.durationSec, numCopies);
    }
    if (!segments.length) throw new Error(`Không lập được khoảng cắt cho ${path.basename(source)}`);
    job.total = (job.total || 0) + segments.length;
    const outDir = customOutputDir || defaultSplitOutDir(source);
    fs.mkdirSync(outDir, { recursive: true });
    const signatureFile = splitSignaturePath(outDir, source);
    const signature = splitSignature(source, segments, { aspect, flip, precise });
    const canResume = readSplitSignature(signatureFile)?.signature === signature;
    if (!canResume) cleanupStaleSplitOutputs(outDir, source);
    writeSplitSignature(signatureFile, { signature, source, updatedAt: new Date().toISOString() });

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      if (job.cancelled) throw new Error('Đã hủy bởi người dùng');
      const segment = segments[segmentIndex];
      job.current = job.clips.length + 1;
      const outPath = path.join(outDir, clipOutputName(source, segmentIndex + 1, aspect));
      const clip = { index: segmentIndex + 1, file: path.basename(outPath), url: urlForOutDir(outDir, path.basename(outPath)),
        path: outPath, source: path.basename(source), start: segment.start, end: segment.end, duration: segment.duration };
      const completedInfo = canResume && fs.existsSync(outPath) ? await anti.getVideoInfo(outPath) : null;
      const durationTolerance = Math.max(1.5, segment.duration * 0.1);
      if (completedInfo?.durationSec > 0.05 && Math.abs(completedInfo.durationSec - segment.duration) <= durationTolerance) {
        job.logs.push(`↻ Bỏ qua clip đã hoàn tất: ${path.basename(outPath)}`);
        job.clips.push({ ...clip, reused: true });
        continue;
      }
      const itemSpan = 95 / sources.length / segments.length;
      const basePct = sourceIndex * (95 / sources.length) + segmentIndex * itemSpan;
      const canStreamCopy = !precise && aspect === 'keep' && !flip;
      let args;
      if (canStreamCopy) {
        args = ['-y', '-ss', segment.start.toFixed(3), '-i', source, '-t', segment.duration.toFixed(3),
          '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', outPath];
      } else {
        const built = anti.buildSceneClipFilters({ startSec: segment.start, endSec: segment.end, aspect, flip }, { hasAudio: info.hasAudio !== false });
        args = ['-y', '-i', source, '-filter_complex', built.segments.join(';'), '-map', '[vout]'];
        if (info.hasAudio !== false) args.push('-map', '[aout]');
        args.push(...encoderArgs());
        if (info.hasAudio !== false) args.push('-c:a', 'aac');
        args.push('-movflags', '+faststart', '-shortest', outPath);
      }
      await runFFmpeg(args, segment.duration, job, basePct, itemSpan,
        `Băm ${sourceIndex + 1}/${sources.length} · clip ${segmentIndex + 1}/${segments.length}`);
      job.clips.push({ ...clip, reused: false });
    }
  }
  setProgress(job, 100, `Hoàn tất: ${job.clips.length} clip.`);
  job.status = 'done';
  job.result = { clips: job.clips, count: job.clips.length };
}

// ---- (2) BĂM VIDEO THEO CẢNH ------------------------------------------------
// Khởi động nền để request không treo suốt quá trình xử lý video dài.
async function renderSceneSplit(req, res) {
  if (isRunning()) return res.status(409).json({ error: 'Đang có tác vụ né trùng/băm cảnh chạy. Hãy đợi hoặc hủy trước.' });
  const sources = resolveSplitSources(req);
  if (!sources.length) return res.status(400).json({ error: 'Thiếu video nguồn. Chọn video trong kho hoặc tải file lên.' });
  const job = newJob('scenesplit');
  activeJob = job;
  setImmediate(() => runSceneSplitJob(job, sources, { ...req.body }).catch((error) => {
    job.status = job.cancelled ? 'cancelled' : 'error';
    job.error = error.message;
    setProgress(job, job.percent, `${job.cancelled ? 'Đã hủy' : 'Lỗi'}: ${error.message}`);
  }));
  return res.status(202).json({ success: true, started: true, jobId: job.id, videos: sources.length });
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

module.exports = { renderAntiDupe, analyzeSceneSplit, renderSceneSplit, getProgress, cancel };
