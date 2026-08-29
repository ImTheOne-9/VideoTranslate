const views = {
  download: {
    title: 'Tải video',
    desc: 'Dán link video đơn lẻ hoặc link kênh để tải về thư mục downloads.'
  },
  'crawl-history': {
    title: 'Lịch sử cào',
    desc: 'Lọc, chọn và tải lại video đã tìm thấy từ tất cả nền tảng.'
  },
  studio: {
    title: 'Studio render',
    desc: 'Dịch tiếng Việt, chèn sub, thêm giọng nói hoặc nhạc nền rồi render ra MP4.'
  },
  library: {
    title: 'Thư viện',
    desc: 'Quản lý các tài nguyên của bạn: Video đã render, giọng lồng tiếng, và nhạc nền.'
  },
  pages: {
    title: 'Quản lý Fanpage',
    desc: 'Quản lý danh sách các Fanpage của bạn, bao gồm thêm, sửa, xóa và tìm kiếm.'
  }
};

views.antidupe = {
  title: 'Băm cảnh',
  desc: 'Cắt video dài thành các clip ngắn theo cảnh cho Reels/Shorts.'
};

views.tts = {
  title: 'Tạo Voice (TTS)',
  desc: 'Biến văn bản thành WAV bằng Piper, Edge, OmniVoice hoặc CapCut TTS.'
};

let currentUrl = '';
let currentHistoryPage = 1;
const historyPerPage = 5;
let currentSavedLinkPage = 1;
const savedLinksPerPage = 5;
let currentBulkPage = 1;
const bulkVideosPerPage = 10;
let currentPlaylistVideos = [];
let currentSavedChannelPage = 1;
const savedChannelsPerPage = 5;
let currentPlaylistSessionId = null;
let assets = { videos: [], voices: [], music: [], logos: [], subtitles: [], renders: [], omiConfigured: false };
let isBulkDownloadCancelled = false;
let activeBulkDownloadController = null;

let konvaStage = null;
let konvaLayer = null;
let konvaSubtitle = null;
let konvaReaction = null;
let konvaBlur = null;
let konvaWatermark = null;
let konvaLogo = null;
let konvaTransformer = null;
let vGuideline = null;
let hGuideline = null;

// Timed multiple blur boxes variables
let blurBoxes = [];
let activeBlurBoxId = null;

const $ = (id) => document.getElementById(id);

// Dependency Downloader globals
let dependencyStatus = { cuda: true, whisper: true, separator: true };
let activeDownloadType = null;
let downloadSuccessCallback = null;
let downloadProgressInterval = null;
