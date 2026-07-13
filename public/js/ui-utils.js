/**
 * ui-utils.js — Tiện ích UI thuần (pure functions)
 * Được tách từ app.js (6065 dòng) làm bước đầu modular hóa.
 * Các hàm này không phụ thuộc state, dễ test độc lập.
 *
 * Expose lên window để app.js (chưa refactor) vẫn gọi được.
 */

// Chuyển giá trị slider (0-1+) sang volume thực (bình phương cho vùng nhỏ)
window.sliderToVolume = function (x) {
  x = Number(x);
  if (isNaN(x) || x < 0) return 0;
  if (x <= 1) {
    return x * x;
  } else {
    return x;
  }
};

// Hàm nghịch đảo của sliderToVolume
window.volumeToSlider = function (v) {
  v = Number(v);
  if (isNaN(v) || v < 0) return 0;
  if (v <= 1) {
    return Math.sqrt(v);
  } else {
    return v;
  }
};

// Kiểm tra URL có phải link video hỗ trợ (YouTube, TikTok, Douyin, FB, IG, XHS)
window.isValidVideoUrl = function (url) {
  return /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/|xiaohongshu\.com\/|xhslink\.com\/|facebook\.com\/|fb\.watch\/|fb\.com\/|tiktok\.com\/|douyin\.com\/|v\.douyin\.com\/|iesdouyin\.com\/|instagram\.com\/|instagr\.am\/|bilibili\.com\/|b23\.tv\/|youku\.com\/|mgtv\.com\/|iq\.com\/)/.test(url);
};

// Định dạng giây → "M:SS" (ví dụ 125 → "2:05")
window.formatDuration = function (seconds) {
  const value = Math.round(Number(seconds || 0));
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

// Định dạng giây → "MM:SS" (ví dụ 65 → "01:05")
window.formatTime = function (secs) {
  if (isNaN(secs)) return '00:00';
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};
