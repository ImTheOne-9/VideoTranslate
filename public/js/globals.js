const views = {
  download: {
    title: 'Tải video',
    desc: 'Dán link video đơn lẻ hoặc link kênh/playlist để tải về thư mục downloads.'
  },
  studio: {
    title: 'Studio render',
    desc: 'Dịch tiếng Việt, chèn sub, thêm voiceover hoặc nhạc nền rồi render ra MP4.'
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

let currentUrl = '';
let currentHistoryPage = 1;
const historyPerPage = 10;
let currentSavedLinkPage = 1;
const savedLinksPerPage = 5;
let currentBulkPage = 1;
const bulkVideosPerPage = 10;
let currentPlaylistVideos = [];
let currentSavedChannelPage = 1;
const savedChannelsPerPage = 5;
let currentPlaylistSessionId = null;
let assets = { videos: [], voices: [], music: [], subtitles: [], renders: [], omiConfigured: false };
let isBulkDownloadCancelled = false;
let activeBulkDownloadController = null;

let konvaStage = null;
let konvaLayer = null;
let konvaSubtitle = null;
let konvaReaction = null;
let konvaBlur = null;
let konvaTransformer = null;
let vGuideline = null;
let hGuideline = null;

// Timed multiple blur boxes variables
let blurBoxes = [];
let activeBlurBoxId = null;

const $ = (id) => document.getElementById(id);

// Dependency Downloader globals
let dependencyStatus = { cuda: true, whisper: true };
let activeDownloadType = null;
let downloadSuccessCallback = null;
let downloadProgressInterval = null;
