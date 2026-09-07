const fs = require('fs');
const os = require('os');
const path = require('path');
const { lastJsonLine } = require('./mediacrawler-adapter');
const { mapPreviewItem } = require('./project-ytdlp-adapter');
const { listMediaFilesRecursive, validateMediaFile } = require('./media-file-validator');

class SupplementalCrawler {
  constructor(runner) { this.runner = runner; }

  async discover({ platforms = ['douyin', 'bilibili', 'youtube'], keywords, count = 20, minVideos = 0 }, hooks = {}) {
    const terms = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/[\n,]+/)).map((s) => String(s).trim()).filter(Boolean);
    if (!terms.length || terms.length > 20) throw new Error('Nhập từ 1 đến 20 từ khóa.');
    if (!Array.isArray(platforms) || !platforms.length || platforms.some((p) => !['douyin', 'bilibili', 'youtube'].includes(p))) throw new Error('Chọn ít nhất một nền tảng: Douyin, Bilibili hoặc YouTube.');
    const limit = Math.min(200, Math.max(1, Number(count) || 20));
    const minimum = Math.min(1000, Math.max(0, Number(minVideos) || 0));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-studio-discovery-'));
    const channels = new Map(), errors = [];
    try {
      for (const platform of new Set(platforms)) for (const keyword of terms) {
        const file = path.join(directory, `${channels.size}-${errors.length}.json`);
        try {
          const env = { GOI_Y_OUT: file, GOI_Y_LIMIT: String(limit), GOI_Y_MIN_VIDEO: String(minimum), MC_GET_MEDIAS: '0', MC_DATA_DIR: directory };
          if (platform === 'douyin') {
            await this.runner._run('main.py', ['--platform', 'dy', '--type', 'userlist', '--keywords', keyword,
              '--crawler_max_notes_count', String(limit), '--get_comment', 'no', '--save_data_option', 'jsonl', '--headless', 'yes'],
              { ...hooks, env, cwd: this.runner.crawlerRoot, timeoutMs: 10 * 60 * 1000 });
          } else {
            await this.runner._run(path.join(this.runner.appRoot, platform === 'youtube' ? 'yt_goi_y.py' : 'bili_goi_y.py'),
              [keyword], { ...hooks, env, timeoutMs: 10 * 60 * 1000 });
          }
          const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!Array.isArray(rows)) throw new Error('Dữ liệu khám phá không phải danh sách.');
          for (const row of rows.slice(0, limit)) {
            const total = Number(row.videos_count);
            if (minimum > 0 && (!Number.isFinite(total) || total < minimum)) continue;
            if (!/^https?:\/\//i.test(row.link || '')) continue;
            channels.set(`${platform}:${row.link}`, { platform, url: row.link, name: row.nickname || row.link,
              avatar: row.avatar || '', videoCount: Number.isFinite(total) && total >= 0 ? total : null,
              countIsLowerBound: Boolean(row.videos_it_nhat), followers: row.fans ?? null, keyword });
          }
        } catch (error) { errors.push({ platform, keyword, message: error.message }); }
      }
      return { channels: [...channels.values()], errors };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }

  async honggo(config, hooks = {}, preview = false) {
    if (!['detail', 'chase'].includes(config.mode)) throw new Error('Honggo chỉ hỗ trợ link tập hoặc bộ.');
    const inputs = String(config.input || '').split(/\r?\n/).filter(Boolean);
    if (!inputs.length || inputs.some((url) => !/^https:\/\/(?:www\.)?(?:hongguoapp\.cn|hongguoduanju\.com)\//i.test(url))) throw new Error('Honggo: cần link HTTPS thuộc hongguoapp.cn hoặc hongguoduanju.com.');
    const root = config.outputDir || this.runner.dataDir;
    const directory = path.join(root, 'honggo');
    const before = new Set(listMediaFilesRecursive(directory));
    const items = []; let failedVideos = 0;
    for (const input of inputs) {
      // ViralCrawl cho Honggo giữ ô số tập ở mode Theo bộ; các nền tảng series
      // khác dùng wholeSeries=5000 ở adapter tương ứng.
      const args = ['--input', input, '--count', String(config.count || 100)];
      if (preview) args.push('--list');
      else if (config.mode === 'detail') args.push('--mot-tap');
      const result = await this.runner._run(path.join(this.runner.appRoot, 'tai_honggo.py'), args,
        { ...hooks, env: { MC_DATA_DIR: root }, timeoutMs: preview ? 10 * 60 * 1000 : 12 * 60 * 60 * 1000 });
      const payload = lastJsonLine(result.stdout);
      if (!payload?.ok) throw new Error(payload?.msg || 'Honggo không trả về kết quả hợp lệ.');
      items.push(...(payload.items || []).map((item) => mapPreviewItem(item, 'honggo')));
      failedVideos += Math.max(0, Number(payload.tong || 0) - Number(payload.tai || 0) - Number(payload.bo_qua || 0));
    }
    if (preview) return items.slice(0, config.count || 100);
    const files = listMediaFilesRecursive(directory).filter((file) => !before.has(file));
    const valid = files.filter((file) => validateMediaFile(file).valid);
    return { success: !failedVideos || valid.length > 0, engine: 'Honggo', outputDir: directory,
      completedVideos: valid.length, failedVideos: failedVideos + files.length - valid.length };
  }
}

module.exports = { SupplementalCrawler };
