'use strict';

// ============================================================================
// lib/anti-dupe.js — Nhóm filter NÉ TRÙNG render + BĂM VIDEO THEO CẢNH
// Dùng FFmpeg (shared.FFMPEG_PATH) — KHÔNG cần PySceneDetect.
//
// (1) NÉ TRÙNG RENDER: flip(hflip) -> trim(cắt đầu/cuối)
//                          -> scale/crop(tỉ lệ) -> drawtext(watermark)
// (2) BĂM THEO CẢNH:      phát hiện cảnh bằng FFmpeg `select='gt(scene,T)',showinfo`
//                          rồi render từng clip với cùng nhóm filter.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { spawn, execFile, FFMPEG_PATH } = require('./shared-state');

// ---- Tiện ích parse --------------------------------------------------------
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function bool(v) {
  return v === true || v === 'true' || v === '1' || v === 1 || v === 'on' || v === 'yes';
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Đổi "cắt đầu / cắt cuối" (số giây BỎ ở đầu/cuối video) thành cửa sổ tuyệt đối [start, end].
// end là thời điểm KẾT THÚC tuyệt đối = duration - cutEnd (null = đến hết video).
// Dùng cho render né trùng: UI nhập "cắt cuối" = số giây bỏ ở cuối, KHÔNG phải mốc thời gian.
// (Sửa lỗi: trước đây endSec bị nạp thẳng thành mốc end tuyệt đối -> render ra clip 1s/0s.)
function resolveTrimWindow(startSec, cutEndSec, durationSec) {
  const start = Math.max(0, num(startSec, 0));
  if (cutEndSec === null || cutEndSec === undefined || cutEndSec === '') return { start, end: null };
  const cut = Math.max(0, num(cutEndSec, 0));
  const end = (Number.isFinite(durationSec) && durationSec > 0)
    ? Math.max(start, durationSec - cut)
    : null;
  return { start, end };
}

// Escape đường dẫn để nhúng vào filtergraph (giống escapeSubtitleForFilter)
function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

// Vị trí drawtext (w,h là kích thước video; text_w/text_h là kích thước chữ)
function drawtextPos(pos, margin) {
  const m = margin == null ? 14 : margin;
  switch (pos) {
    case 'tl': return { x: String(m), y: String(m) };
    case 'tr': return { x: `w-text_w-${m}`, y: String(m) };
    case 'bl': return { x: String(m), y: `h-text_h-${m}` };
    case 'center': return { x: `(w-text_w)/2`, y: `(h-text_h)/2` };
    case 'br':
    default: return { x: `w-text_w-${m}`, y: `h-text_h-${m}` };
  }
}

// Vị trí overlay logo (W,H = video; w,h = logo)
function overlayPos(pos, margin) {
  const m = margin == null ? 14 : margin;
  switch (pos) {
    case 'tl': return { x: String(m), y: String(m) };
    case 'tr': return { x: `W-w-${m}`, y: String(m) };
    case 'bl': return { x: String(m), y: `H-h-${m}` };
    case 'center': return { x: `(W-w)/2`, y: `(H-h)/2` };
    case 'br':
    default: return { x: `W-w-${m}`, y: `H-h-${m}` };
  }
}

// Ghi text watermark ra file để né lỗi escape ký tự đặc biệt / unicode cho drawtext
function writeTextFile(workDir, name, text) {
  if (!workDir) throw new Error('anti-dupe: workDir bắt buộc khi có watermark');
  const p = path.join(workDir, name);
  fs.writeFileSync(p, String(text || ''), 'utf8');
  return p;
}

// ---- Lõi: sinh filter né trùng ---------------------------------------------
// cfg: { startSec, endSec, flip, aspect, watermarkText, watermarkPos,
//        watermarkSize, watermarkColor, watermarkAlpha, logoPath, logoPos }
// opts: { workDir, fontFile, durationSec }
// Trả: { segments: string[], hasVideo, hasAudio, outDurationSec, useLogo }
function buildAntiDupeFilters(cfg, opts = {}) {
  const workDir = opts.workDir;
  const fontFile = opts.fontFile || 'C:/Windows/Fonts/arialbd.ttf';

  const inputVideoLabel = opts.inputVideoLabel || '0:v';
  const inputAudioLabel = opts.inputAudioLabel || '0:a';
  const outputVideoLabel = opts.outputVideoLabel || 'vout';
  const outputAudioLabel = opts.outputAudioLabel || 'aout';
  const logoInputLabel = opts.logoInputLabel || '1:v';

  const startSec = Math.max(0, num(cfg.startSec, 0));
  const endSec = (cfg.endSec === null || cfg.endSec === undefined || cfg.endSec === '')
    ? null : Math.max(startSec, num(cfg.endSec, 0));
  const hasTrim = startSec > 0 || endSec !== null;

  const flip = bool(cfg.flip);

  const aspect = String(cfg.aspect || 'keep').trim();
  const useAspect = aspect !== 'keep' && /^\d+:\d+$/.test(aspect);

  const watermarkText = String(cfg.watermarkText || '').trim();
  const useWatermark = watermarkText.length > 0;

  const logoPath = cfg.logoPath ? String(cfg.logoPath) : '';
  const useLogo = logoPath && fs.existsSync(logoPath);

  // ---- chuỗi filter VIDEO (trên [0:v]) ----
  const vFilters = [];
  if (hasTrim) {
    vFilters.push(endSec !== null
      ? `trim=start=${startSec.toFixed(4)}:end=${endSec.toFixed(4)}`
      : `trim=start=${startSec.toFixed(4)}`);
    vFilters.push('setpts=PTS-STARTPTS');
  }
  if (flip) vFilters.push('hflip');
  if (useAspect) {
    const [aw, ah] = aspect.split(':').map(x => parseInt(x, 10));
    let tw, th;
    if (aw === ah) { tw = 1080; th = 1080; }
    else if (aw > ah) { tw = 1920; th = Math.round(1920 * ah / aw); }
    else { th = 1920; tw = Math.round(1920 * aw / ah); }
    tw -= tw % 2; th -= th % 2;
    vFilters.push(`scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},setsar=1`);
  }
  if (useWatermark) {
    const wmFile = writeTextFile(workDir, 'anti_dupe_wm.txt', watermarkText);
    const fp = escapeFilterPath(wmFile);
    const font = escapeFilterPath(fontFile);
    const pos = drawtextPos(cfg.watermarkPos || 'br', 14);
    const fsize = Math.max(8, Math.round(num(cfg.watermarkSize, 30)));
    const fcolor = String(cfg.watermarkColor || 'white');
    const falpha = clamp(num(cfg.watermarkAlpha, 0.85), 0, 1);
    vFilters.push(
      `drawtext=fontfile='${font}':textfile='${fp}'` +
      `:x=${pos.x}:y=${pos.y}:fontsize=${fsize}` +
      `:fontcolor=${fcolor}@${falpha}`
    );
  }
  const hasVideo = vFilters.length > 0 || useLogo;

  // ---- chuỗi filter AUDIO (trên [0:a]) ----
  const aFilters = [];
  if (hasTrim) {
    aFilters.push(endSec !== null
      ? `atrim=start=${startSec.toFixed(4)}:end=${endSec.toFixed(4)}`
      : `atrim=start=${startSec.toFixed(4)}`);
    aFilters.push('asetpts=N/SR/TB');
  }
  const hasAudio = aFilters.length > 0;

  // ---- ghép filter_complex (segment) ----
  const segments = [];
  if (hasVideo) {
    if (useLogo) {
      const base = vFilters.length ? vFilters.join(',') : 'null';
      segments.push(`[${inputVideoLabel}]${base}[vpre]`);
      segments.push(`[${logoInputLabel}]scale=120:-1[vlogo]`);
      const op = overlayPos(cfg.logoPos || 'br', 14);
      segments.push(`[vpre][vlogo]overlay=${op.x}:${op.y}[${outputVideoLabel}]`);
    } else {
      segments.push(`[${inputVideoLabel}]${vFilters.join(',')}[${outputVideoLabel}]`);
    }
  }
  if (hasAudio) segments.push(`[${inputAudioLabel}]${aFilters.join(',')}[${outputAudioLabel}]`);

  let outDurationSec = null;
  if (opts.durationSec && endSec !== null) outDurationSec = (endSec - startSec);
  else if (opts.durationSec) outDurationSec = (opts.durationSec - startSec);

  return { segments, hasVideo, hasAudio, outDurationSec, useLogo };
}

// ---- Thông tin video (duration + dims) bằng ffmpeg --------------------------
function getVideoInfo(videoPath) {
  return new Promise((resolve) => {
    if (!videoPath || !fs.existsSync(videoPath)) return resolve({ durationSec: 0, width: 0, height: 0 });
    execFile(FFMPEG_PATH, ['-i', videoPath], (err, stdout, stderr) => {
      const out = stderr || '';
      let durationSec = 0, width = 0, height = 0;
      const dm = out.match(/Duration:\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
      if (dm) {
        durationSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) + parseInt(dm[4].padEnd(3, '0').slice(0, 3), 10) / 1000;
      }
      const vm = out.match(/,\s+(\d{2,5})x(\d{2,5})[, ]/);
      if (vm) { width = parseInt(vm[1], 10); height = parseInt(vm[2], 10); }
      resolve({ durationSec, width, height });
    });
  });
}

// Ánh xạ độ nhạy -> ngưỡng scene score của FFmpeg
// Thấp (ít cảnh)  | Vừa | Cao (nhiều cảnh)  | hoặc số thập phân trực tiếp
function sensitivityToThreshold(sensitivity) {
  const s = String(sensitivity || 'medium').toLowerCase();
  if (/^\d/.test(s)) return clamp(parseFloat(s), 0.01, 0.99);
  if (s === 'low' || s === 'thap') return 0.40;
  if (s === 'high' || s === 'cao') return 0.10;
  return 0.25; // medium / vừa
}

// Phát hiện điểm cắt cảnh bằng FFmpeg (showinfo + scene score). KHÔNG cần PySceneDetect.
// Trả về mảng thời điểm bắt đầu cảnh mới (loại 0). Lỗi -> [].
function detectSceneCuts(videoPath, sensitivity = 'medium') {
  return new Promise((resolve) => {
    const threshold = sensitivityToThreshold(sensitivity);
    const filter = `select='gt(scene\\,${threshold})',showinfo`;
    execFile(FFMPEG_PATH, ['-hide_banner', '-i', videoPath, '-filter:v', filter, '-an', '-f', 'null', '-'],
      { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = stderr || '';
        const times = [];
        let m;
        const re = /pts_time=(\d+(?:\.\d+)?)/g;
        while ((m = re.exec(out)) !== null) {
          const t = parseFloat(m[1]);
          if (Number.isFinite(t)) times.push(t);
        }
        times.sort((a, b) => a - b);
        // gom cụm: giữ điểm đầu mỗi cụm cách nhau >= minGap
        const minGap = 1.2;
        const cuts = [];
        let lastKept = -Infinity;
        for (const t of times) {
          if (t - lastKept >= minGap) { cuts.push(t); lastKept = t; }
        }
        resolve(cuts.filter(t => t > 0.05));
      });
  });
}

// Lập kế hoạch chia cảnh -> danh sách clip. Hỗ trợ "Số bản (chia đều)".
// Nếu số cảnh phát hiện < numCopies -> chia tiếp đoạn dài nhất cho đủ numCopies.
function planSceneSegments(cuts, durationSec, numCopies = 0) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  let bounds = [0, ...cuts.filter(c => c > 0 && (dur === 0 || c < dur - 0.05))];
  if (dur > 0) bounds.push(dur); else if (bounds.length === 1) return [];
  // loại trùng/giảm dần
  bounds = Array.from(new Set(bounds.map(b => +b.toFixed(3)))).sort((a, b) => a - b);

  let segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    segs.push({ start: bounds[i], end: bounds[i + 1], duration: bounds[i + 1] - bounds[i] });
  }

  const target = Math.max(0, Math.floor(Number(numCopies) || 0));
  // Chia đều khi không phát hiện cảnh hoặc muốn nhiều clip hơn
  let guard = 0;
  while (target > 0 && segs.length < target && guard++ < 1000) {
    segs.sort((a, b) => b.duration - a.duration);
    const longest = segs.shift();
    if (!longest || longest.duration < 0.6) { segs.push(longest); break; }
    const mid = +(longest.start + longest.duration / 2).toFixed(3);
    segs.push({ start: longest.start, end: mid, duration: mid - longest.start });
    segs.push({ start: mid, end: longest.end, duration: longest.end - mid });
  }

  segs.sort((a, b) => a.start - b.start);
  return segs.map((s, i) => ({ index: i + 1, start: s.start, end: s.end, duration: s.duration }));
}

module.exports = {
  num, bool, clamp, escapeFilterPath, drawtextPos, overlayPos,
  resolveTrimWindow,
  buildAntiDupeFilters, getVideoInfo, sensitivityToThreshold,
  detectSceneCuts, planSceneSegments
};
