const FacebookApiService = require('./facebookApi');
const { probeMedia, validateForType } = require('./facebook-media-validator');
const { pagePostId, managementId, facebookPermalink } = require('./facebook-object-identity');

const FINISH_PHASES = ['finishing', 'finished'];
const canCheckPublication = (job) => Boolean(job.platformWorkId || (job.upload?.videoId && FINISH_PHASES.includes(job.upload.phase)));
const needsReview = (message) => Object.assign(new Error(message), { needsReview: true, retryable: false });

class FacebookPublishQueue {
  constructor(options) {
    this.jobStore = options.jobStore;
    this.accountStore = options.accountStore;
    this.ffprobePath = options.ffprobePath;
    this.runExecFile = options.runExecFile;
    this.probeMedia = options.probeMedia || probeMedia;
    this.clientFactory = options.clientFactory || ((pageId, token, config) => new FacebookApiService(pageId, token, config));
    this.intervalMs = Number(options.intervalMs || 10000);
    this.pollMs = Number(options.pollMs || process.env.FACEBOOK_STATUS_POLL_MS || 10000);
    this.maxStatusChecks = Number(options.maxStatusChecks || process.env.FACEBOOK_STATUS_POLL_ATTEMPTS || 60);
    this.running = false;
    this.timer = null;
    this.activeJobId = null;
    this.controllers = new Map();
    this.stopped = false;
  }

  recoverJobs() {
    for (const job of this.jobStore.list({ limit: Number.MAX_SAFE_INTEGER })) {
      const legacyUpload = !job.upload && !job.platformWorkId && Number(job.percent || 0) >= 3 && ['failed', 'retrying', 'auth_required', 'uploading'].includes(job.status);
      if (!legacyUpload && !['uploading', 'validating', 'finalizing'].includes(job.status)) continue;
      // Legacy uploads have no durable session. Recreating them could publish twice.
      const uncertain = legacyUpload || (!canCheckPublication(job) && (job.feedPhase === 'publishing' || job.upload?.phase === 'starting' || (job.status === 'uploading' && !job.upload)));
      this.jobStore.update(job.id, {
        status: uncertain ? 'needs_review' : canCheckPublication(job) ? 'processing' : 'queued',
        error: uncertain ? 'Ứng dụng dừng khi đang gửi yêu cầu; cần kiểm tra trên Facebook trước khi đăng lại' : null,
        nextAttemptAt: new Date().toISOString()
      });
    }
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.recoverJobs();
    this.timer = setInterval(() => this.tick().catch((error) => console.error('[Facebook Queue]', error.message)), this.intervalMs);
    this.timer.unref?.();
    this.kick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
  }

  kick() { setImmediate(() => this.tick().catch((error) => console.error('[Facebook Queue]', error.message))); }

  enqueue(input) {
    const result = this.jobStore.create(input);
    this.kick();
    return result;
  }

  async tick() {
    if (this.running || this.stopped) return;
    const due = this.jobStore.list({ limit: Number.MAX_SAFE_INTEGER }).filter((job) =>
      ['queued', 'retrying', 'processing', 'finalizing'].includes(job.status) && new Date(job.nextAttemptAt || job.scheduledAt || 0).getTime() <= Date.now());
    if (!due.length) return;
    due.sort((a, b) => new Date(a.nextAttemptAt || a.scheduledAt) - new Date(b.nextAttemptAt || b.scheduledAt));
    this.running = true;
    this.activeJobId = due[0].id;
    try { await this.runJob(due[0]); }
    finally { this.running = false; this.activeJobId = null; }
    this.kick();
  }

  async runJob(input) {
    let job = this.jobStore.get(input.id);
    if (!job || ['cancelled', 'published'].includes(job.status) || this.controllers.has(job.id)) return;
    const controller = new AbortController();
    const signal = controller.signal;
    this.controllers.set(job.id, controller);
    const guard = () => {
      signal.throwIfAborted();
      const current = this.jobStore.get(job.id);
      if (!current || current.status === 'cancelled') throw Object.assign(new Error('Tác vụ đã bị hủy'), { cancelled: true });
    };
    const update = (changes) => { guard(); job = this.jobStore.update(job.id, changes); return job; };
    let account;
    try {
      guard();
      account = this.accountStore.get(job.accountId || job.pageId);
      if (!account) return update({ status: 'auth_required', error: 'Page đã bị xóa hoặc chưa có token' });
      const client = this.clientFactory(account.pageId, account.accessToken, { signal, apiVersion: job.upload?.apiVersion });
      update({ error: null });
      if (!canCheckPublication(job)) {
        if (job.feedPhase === 'publishing') throw needsReview('Chưa rõ kết quả bài viết đã gửi; không tự gửi lại để tránh trùng');
        update({ attempt: Number(job.attempt || 0) + 1 });
        let result;
        if (job.type === 'feed') {
          update({ feedPhase: 'publishing', status: 'uploading' });
          try { result = await client.createFeedPost(job.message); }
          catch (error) {
            if (!error.ambiguous && !error.cancelled && !signal.aborted) update({ feedPhase: null });
            throw error;
          }
          if (!result?.id) throw needsReview('Facebook trả thiếu ID bài viết; cần kiểm tra trước khi gửi lại');
          // Store acceptance and ID atomically before finalization.
          result.id = pagePostId(account.pageId, result.id);
          update({ feedPhase: 'published', platformWorkId: result.id });
        } else {
          update({ status: 'validating', percent: Math.max(1, job.percent || 0) });
          const media = validateForType(await this.probeMedia(job.videoPath, {
            ffprobePath: this.ffprobePath, runExecFile: this.runExecFile, signal
          }), job.type);
          update({ media, status: 'uploading', percent: Math.max(3, job.percent || 0) });
          const onProgress = (percent) => update({ percent: Math.min(95, percent), status: 'uploading' });
          const options = { signal, state: job.upload, onCheckpoint: async (upload) => {
            // Retain IDs even if cancellation arrived while a response was in flight.
            const current = this.jobStore.get(job.id);
            if (current) job = this.jobStore.update(job.id, { upload, mediaId: upload.videoId || current.mediaId });
            guard();
          } };
          if (job.type === 'post') result = await client.uploadVideoPost(job.videoPath, job.message, job.title, onProgress, options);
          else if (job.type === 'story') result = await client.uploadVideoStory(job.videoPath, onProgress, options);
          else if (job.type === 'reel') result = await client.uploadReel(job.videoPath, job.message, onProgress, options);
          else throw new Error('Loại nội dung Facebook không hợp lệ');
        }
        if (!result?.id) throw needsReview('Facebook trả thiếu ID nội dung');
        update({ platformWorkId: result.id, mediaId: result.videoId || result.id,
          status: job.type === 'feed' ? 'finalizing' : 'processing', percent: 96, nextAttemptAt: new Date().toISOString() });
      }
      if (job.type !== 'feed') {
        const ready = await this.checkPublication(client, job, update);
        if (!ready) return;
        update({ status: 'finalizing', percent: 98, publicationConfirmedAt: new Date().toISOString(),
          platformWorkId: managementId(job, account.pageId),
          permalink: facebookPermalink(ready.permalink || job.permalink) });
      }
      guard();
      let permalink = job.permalink;
      try {
        const info = await client.getPostInfo(job.platformWorkId);
        permalink = info.permalink_url || permalink;
      } catch (error) { if (signal.aborted || error.cancelled) throw error; }
      guard();
      let warning = job.warning || null;
      if (job.firstComment?.trim() && !job.commentPostedAt) {
        if (job.commentPhase === 'sending') {
          warning = 'Bài đã đăng; chưa rõ bình luận đầu đã được nhận. Không gửi lại để tránh trùng.';
        } else if (job.commentPhase !== 'failed') {
          update({ commentPhase: 'sending' });
          try {
            const commentId = await client.postComment(job.platformWorkId, job.firstComment.trim());
            if (!commentId) throw new Error('Facebook không trả ID bình luận');
            update({ commentPhase: 'posted', commentId, commentPostedAt: new Date().toISOString() });
          } catch (error) {
            guard();
            warning = `Đã đăng bài nhưng chưa xác nhận bình luận đầu: ${error.message}`;
            update({ commentPhase: 'failed', warning });
          }
        }
      }
      guard();
      this.accountStore.markStatus(account.id, 'online', null);
      update({ status: 'published', percent: 100, permalink: permalink || null, warning, error: null, publishedAt: new Date().toISOString() });
      this.jobStore.removeOld();
    } catch (error) {
      const current = this.jobStore.get(job.id);
      if (!current || current.status === 'cancelled') return;
      if (signal.aborted || error.cancelled) {
        return this.jobStore.update(job.id, { status: canCheckPublication(current) ? 'processing' : 'queued', nextAttemptAt: new Date(Date.now() + this.pollMs).toISOString() });
      }
      if (error.authRequired) {
        if (account) this.accountStore.markStatus(account.id, 'auth_required', error.message);
        return this.jobStore.update(job.id, { status: 'auth_required', error: error.message, errorCode: error.code || null });
      }
      if (canCheckPublication(current) && (error.ambiguous || error.retryable)) return this.deferCheck(current, error.message);
      if (error.needsReview || current.upload?.phase === 'starting' || current.feedPhase === 'publishing') {
        return this.jobStore.update(job.id, { status: 'needs_review', error: error.message, errorCode: error.code || null });
      }
      const attempt = Number(current.attempt || 0);
      if (error.retryable && attempt < Number(current.maxAttempts || 3)) {
        const delay = Math.min(15 * 60 * 1000, 30000 * (2 ** Math.max(0, attempt - 1)));
        return this.jobStore.update(job.id, { status: 'retrying', error: error.message, errorCode: error.code || null, nextAttemptAt: new Date(Date.now() + delay).toISOString() });
      }
      return this.jobStore.update(job.id, { status: 'failed', error: error.message, errorCode: error.code || null });
    } finally { this.controllers.delete(input.id); }
  }

  deferCheck(job, message = 'Facebook đang xử lý hoặc chưa xác nhận xuất bản') {
    const statusChecks = Number(job.statusChecks || 0) + 1;
    return this.jobStore.update(job.id, {
      status: statusChecks >= this.maxStatusChecks ? 'needs_review' : 'processing', statusChecks,
      error: statusChecks >= this.maxStatusChecks ? 'Chưa xác nhận xuất bản. Bấm kiểm tra lại để kiểm tra video cũ, không upload lại.' : message,
      nextAttemptAt: new Date(Date.now() + this.pollMs).toISOString()
    });
  }

  async checkPublication(client, job, update) {
    const status = await client.getVideoStatus(job.mediaId || job.upload?.videoId || job.platformWorkId, job.type);
    update({ facebookStatus: status, lastStatusAt: new Date().toISOString() });
    if (status.failed || ['error', 'failed'].includes(status.status)) throw new Error('Facebook xử lý hoặc xuất bản video thất bại');
    if (status.published === true) return status;
    this.deferCheck(this.jobStore.get(job.id));
    return null;
  }

  retry(id) {
    const job = this.jobStore.get(id);
    if (!job || !['failed', 'auth_required', 'needs_review'].includes(job.status) || this.controllers.has(id)) return null;
    if (job.feedPhase === 'publishing' || ['starting', 'invalid_start'].includes(job.upload?.phase) || (!job.upload && !job.platformWorkId && job.status === 'needs_review')) return null;
    const result = this.jobStore.update(id, { status: canCheckPublication(job) ? 'processing' : 'queued', attempt: 0, statusChecks: 0, error: null, nextAttemptAt: new Date().toISOString() });
    this.kick();
    return result;
  }

  cancel(id) {
    const job = this.jobStore.get(id);
    if (!job || ['published', 'cancelled'].includes(job.status)) return null;
    const result = this.jobStore.update(id, { status: 'cancelled', error: null,
      warning: canCheckPublication(job) || job.feedPhase === 'publishing' ? 'Đã dừng tác vụ trên máy. Yêu cầu xuất bản có thể đã được Facebook nhận; hãy kiểm tra trên Page.' : null });
    this.controllers.get(id)?.abort();
    return result;
  }
}

module.exports = { FacebookPublishQueue };
