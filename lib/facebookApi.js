const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { pagePostId, facebookPermalink } = require('./facebook-object-identity');
const { validateFacebookSchedule } = require('./facebook-scheduling');

const DEFAULT_API_VERSION = process.env.FACEBOOK_GRAPH_API_VERSION || 'v25.0';

class FacebookApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FacebookApiError';
    Object.assign(this, details);
  }
}

function normalizeFacebookError(error, endpoint = '') {
  if (error instanceof FacebookApiError) return error;
  const graph = error?.response?.data?.error || {};
  const status = Number(error?.response?.status || 0);
  const code = Number(graph.code || 0);
  const subcode = Number(graph.error_subcode || 0);
  const message = graph.message || error?.message || 'Facebook Graph API thất bại';
  const authRequired = status === 401 || code === 190 || [458, 459, 460, 463, 464, 467].includes(subcode);
  const rateLimited = status === 429 || [4, 17, 32, 613].includes(code);
  const cancelled = error?.code === 'ERR_CANCELED' || error?.name === 'AbortError';
  const retryable = !cancelled && !authRequired && (graph.is_transient === true || rateLimited || status >= 500 || !error?.response);
  return new FacebookApiError(message, {
    endpoint, status, code, subcode, authRequired, rateLimited, retryable, cancelled,
    ambiguous: !error?.response || status >= 500,
    offset: graph.error_data?.start_offset, endOffset: graph.error_data?.end_offset,
    details: graph.error_user_msg || graph.error_user_title || null
  });
}

function normalizeVideoStatus(data = {}, type = 'post') {
  const raw = data.status || {};
  const lower = (value) => String(value || '').toLowerCase();
  const phase = (value) => ({ ...(value || {}), status: lower(value?.status) });
  const uploadingPhase = phase(raw.uploading_phase);
  const processingPhase = phase(raw.processing_phase);
  const publishingPhase = phase(raw.publishing_phase);
  const status = lower(raw.video_status) || 'unknown';
  const failed = [status, uploadingPhase.status, processingPhase.status, publishingPhase.status, lower(publishingPhase.publish_status)].some((value) => ['error', 'failed'].includes(value));
  const processed = status === 'ready' || status === 'published' || processingPhase.status === 'complete';
  const publicationComplete = publishingPhase.status === 'complete' && ['published', ''].includes(lower(publishingPhase.publish_status));
  const published = !failed && processed && (type === 'post'
    ? data.published === true && (!publishingPhase.status || publicationComplete)
    : publicationComplete && (lower(publishingPhase.publish_status) === 'published' || data.published !== false));
  const rawSchedule = data.scheduled_publish_time;
  const scheduledPublishTime = typeof rawSchedule === 'number' || (typeof rawSchedule === 'string' && /^\d+$/.test(rawSchedule))
    ? Number(rawSchedule) : rawSchedule ? Math.floor(new Date(rawSchedule).getTime() / 1000) : 0;
  const scheduled = !failed && !published && data.published === false && processed
    && Number.isFinite(scheduledPublishTime) && scheduledPublishTime > 0;
  return { id: data.id, postId: data.post_id || null, status, published, failed, processed, scheduled,
    scheduledPublishTime: Number.isFinite(scheduledPublishTime) ? scheduledPublishTime : 0,
    uploadingPhase, processingPhase, publishingPhase, rawStatus: raw, permalink: facebookPermalink(data.permalink_url) };
}

class FacebookApiService {
  constructor(pageId, pageAccessToken, options = {}) {
    this.pageId = String(pageId || '');
    this.accessToken = String(pageAccessToken || '');
    this.apiVersion = options.apiVersion || DEFAULT_API_VERSION;
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.videoBaseUrl = `https://graph-video.facebook.com/${this.apiVersion}`;
    this.signal = options.signal;
    this.http = options.http || axios.create({
      timeout: Number(process.env.FACEBOOK_HTTP_TIMEOUT_MS || 120000),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  }

  async request(config, endpoint) {
    try {
      const signal = config.signal || this.signal;
      signal?.throwIfAborted();
      const response = await this.http.request({ ...config, signal });
      if (response.data?.error) throw { response };
      return response;
    }
    catch (error) { throw normalizeFacebookError(error, endpoint); }
  }

  async verifyPage() {
    const response = await this.request({
      method: 'get', url: `${this.baseUrl}/${this.pageId}`,
      params: { fields: 'id,name,picture{url},fan_count,category,tasks', access_token: this.accessToken }
    }, 'verifyPage');
    return response.data;
  }

  static async listManagedPages(userAccessToken, options = {}) {
    const service = new FacebookApiService('', userAccessToken, options);
    const pages = [];
    let url = `${service.baseUrl}/me/accounts`;
    let params = { fields: 'id,name,access_token,picture{url},fan_count,category,tasks', limit: 100, access_token: userAccessToken };
    do {
      const response = await service.request({ method: 'get', url, params }, 'listManagedPages');
      pages.push(...(response.data?.data || []));
      url = response.data?.paging?.next || '';
      params = undefined;
    } while (url);
    return pages;
  }

  async createFeedPost(message, link = '') {
    const response = await this.request({
      method: 'post', url: `${this.baseUrl}/${this.pageId}/feed`,
      params: { message, ...(link ? { link } : {}), access_token: this.accessToken }
    }, 'createFeedPost');
    return response.data;
  }

  // Checkpoint callbacks are awaited before network mutations. A saved "finishing"
  // phase must only be reconciled by GET, never automatically sent again.
  async uploadVideoPost(videoPath, description = '', title = '', progress = () => {}, options = {}) {
    return this.uploadMedia('post', videoPath, description, title, progress, options);
  }

  async uploadReel(videoPath, description = '', progress = () => {}, options = {}) {
    return this.uploadMedia('reel', videoPath, description, '', progress, options);
  }

  async uploadVideoStory(videoPath, progress = () => {}, options = {}) {
    return this.uploadMedia('story', videoPath, '', '', progress, options);
  }

  async uploadMedia(type, videoPath, description, title, progress, options) {
    const signal = options.signal || this.signal;
    let state = { ...(options.state || {}) };
    const checkpoint = async (changes) => {
      state = { ...state, ...changes };
      await options.onCheckpoint?.({ ...state });
      signal?.throwIfAborted();
    };
    const result = () => ({ id: state.postId ? pagePostId(this.pageId, state.postId) : state.videoId, videoId: state.videoId, uploadSessionId: state.sessionId });
    const fail = (message, details = {}) => new FacebookApiError(message, { retryable: false, ...details });
    const scheduledPublishTime = options.scheduledPublishTime ?? 0;
    if (!Number.isSafeInteger(scheduledPublishTime) || scheduledPublishTime < 0) throw fail('Thời gian hẹn đăng không hợp lệ; không tự chuyển thành đăng ngay.');
    // A resumed upload cannot silently change between immediate and scheduled publication.
    if ((state.videoId || state.scheduledPublishTime != null) && Number(state.scheduledPublishTime || 0) !== scheduledPublishTime) {
      throw fail('Lịch đăng không khớp phiên upload đã lưu; không tự thay đổi lịch hoặc đăng ngay.', { needsReview: true });
    }
    if (state.type && state.type !== type) throw fail('Loại nội dung không khớp phiên upload đã lưu');
    if (state.apiVersion && state.apiVersion !== this.apiVersion) throw fail('Phiên upload dùng phiên bản Graph API khác', { needsReview: true });
    if (['finishing', 'finished'].includes(state.phase)) {
      if (!state.videoId) throw fail('Thiếu ID để xác minh kết quả xuất bản', { needsReview: true });
      return result();
    }
    if (state.phase === 'starting') throw fail('Mất phản hồi tạo phiên; cần kiểm tra trước khi tạo upload mới', { needsReview: true });
    if (state.phase === 'invalid_start') throw fail('Phiên upload không đầy đủ; cần kiểm tra thủ công', { needsReview: true });
    if (scheduledPublishTime) validateFacebookSchedule(type, scheduledPublishTime);
    const stat = fs.statSync(videoPath);
    const size = stat.size;
    if (!stat.isFile() || size <= 0) throw fail('File video rỗng hoặc không hợp lệ');
    if (state.size != null && (state.size !== size || state.mtimeMs !== stat.mtimeMs)) {
      throw fail('File video đã thay đổi từ lúc tạo phiên; không thể tiếp tục phiên cũ', { needsReview: true });
    }
    const endpoint = type === 'post' ? 'videoPost' : type;
    const url = type === 'post' ? `${this.videoBaseUrl}/${this.pageId}/videos`
      : `${this.baseUrl}/${this.pageId}/${type === 'reel' ? 'video_reels' : 'video_stories'}`;
    if (!state.videoId) {
      await checkpoint({ phase: 'starting', type, size, mtimeMs: stat.mtimeMs, apiVersion: this.apiVersion, scheduledPublishTime });
      let start;
      try {
        start = await this.request({ method: 'post', url, signal, params: {
          upload_phase: 'start', ...(type === 'post' ? { file_size: size } : {}), access_token: this.accessToken
        } }, `${endpoint}.start`);
      } catch (error) {
        if (!error.ambiguous && !error.cancelled) await checkpoint({ phase: 'new' });
        throw error;
      }
      // Persist any returned ID even when the remainder of the response is malformed.
      const validStart = start.data?.video_id && (type === 'post' ? start.data?.upload_session_id : start.data?.upload_url);
      await checkpoint({ phase: validStart ? 'started' : 'invalid_start', videoId: start.data?.video_id, sessionId: start.data?.upload_session_id,
        uploadUrl: start.data?.upload_url, offset: start.data?.start_offset, endOffset: start.data?.end_offset });
      if (!state.videoId || (type === 'post' ? !state.sessionId : !state.uploadUrl)) {
        throw fail('Facebook trả thiếu thông tin tạo phiên upload', { needsReview: true });
      }
    }
    if (state.phase === 'invalid_start') throw fail('Phiên upload không đầy đủ; cần kiểm tra thủ công', { needsReview: true });
    if (type === 'post' && state.phase !== 'transferred') {
      // Meta SDK also reconciles offset mismatch via error subcode 1363037.
      const offsets = (start, end) => {
        const valid = (value) => (typeof value === 'number' || (typeof value === 'string' && /^[0-9]+$/.test(value))) && Number.isSafeInteger(Number(value));
        if (!valid(start) || !valid(end)) throw fail('Facebook trả về offset upload không hợp lệ', { needsReview: true });
        const offset = Number(start), endOffset = Number(end);
        if (offset < 0 || endOffset > size || endOffset < offset || (offset === endOffset && offset !== size)) {
          throw fail('Offset Facebook nằm ngoài phạm vi file', { needsReview: true });
        }
        return { offset, endOffset };
      };
      let range = offsets(state.offset, state.endOffset);
      let corrections = 0;
      while (range.offset < size) {
        await checkpoint({ ...range, phase: 'transferring' });
        const stream = fs.createReadStream(videoPath, { start: range.offset, end: range.endOffset - 1 });
        const form = new FormData();
        form.append('video_file_chunk', stream, { filename: path.basename(videoPath), knownLength: range.endOffset - range.offset });
        let next;
        try {
          const transfer = await this.requestStream({ method: 'post', url, signal, data: form,
            params: { upload_phase: 'transfer', upload_session_id: state.sessionId, start_offset: range.offset, access_token: this.accessToken },
            headers: form.getHeaders()
          }, `${endpoint}.transfer`, stream);
          next = offsets(transfer.data?.start_offset, transfer.data?.end_offset);
          if (next.offset <= range.offset || next.offset > range.endOffset) throw fail('Facebook không xác nhận đúng chunk vừa tải', { needsReview: true });
        } catch (error) {
          if (error.subcode !== 1363037 || corrections++ >= 3) throw error;
          next = offsets(error.offset, error.endOffset);
          if (next.offset < range.offset) throw fail('Facebook trả offset lùi so với dữ liệu đã xác nhận', { needsReview: true });
        }
        range = next;
        await checkpoint({ ...range, phase: range.offset === size ? 'transferred' : 'started' });
        progress(Math.min(95, Math.round(range.offset / size * 95)));
      }
      await checkpoint({ phase: 'transferred' });
    } else if (type !== 'post' && state.phase !== 'transferred') {
      if (state.phase === 'transferring') {
        const status = await this.getVideoStatus(state.videoId, type, { signal });
        if (status.failed) throw fail('Facebook báo lỗi tải video', { needsReview: true });
        if (status.uploadingPhase.status === 'complete') {
          await checkpoint({ phase: 'transferred', offset: size });
        } else {
          // No documented chunk resume contract is assumed for this binary endpoint.
          throw fail('Upload bị gián đoạn và Facebook chưa xác nhận tải xong; hãy kiểm tra lại phiên đã lưu', { needsReview: true });
        }
      }
      if (state.phase !== 'transferred') {
        const uploadUrl = new URL(state.uploadUrl);
        if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'rupload.facebook.com' || uploadUrl.username || uploadUrl.password) {
          throw fail('Facebook trả địa chỉ upload không hợp lệ');
        }
        await checkpoint({ phase: 'transferring', offset: 0 });
        const stream = fs.createReadStream(videoPath);
        const transfer = await this.requestStream({ method: 'post', url: uploadUrl.href, signal, data: stream, maxRedirects: 0,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), Authorization: `OAuth ${this.accessToken}`, offset: '0', file_size: String(size) }
        }, `${endpoint}.transfer`, stream);
        if (transfer.data?.success !== true) throw fail('Facebook chưa xác nhận dữ liệu upload', { needsReview: true });
        await checkpoint({ phase: 'transferred', offset: size });
      }
      progress(95);
    }
    // Upload may take long enough to miss the safe scheduling window. Never fall back to publishing now.
    if (scheduledPublishTime) validateFacebookSchedule(type, scheduledPublishTime);
    await checkpoint({ phase: 'finishing', finishRequestedAt: new Date().toISOString() });
    let finish;
    try {
      finish = await this.request({ method: 'post', url, signal, params: {
        upload_phase: 'finish', access_token: this.accessToken,
        ...(scheduledPublishTime ? { scheduled_publish_time: scheduledPublishTime } : {}),
        ...(type === 'post' ? { upload_session_id: state.sessionId, published: !scheduledPublishTime,
          ...(scheduledPublishTime ? { unpublished_content_type: 'SCHEDULED' } : {}), ...(title ? { title } : {}), ...(description ? { description } : {}) }
          : { video_id: state.videoId, ...(scheduledPublishTime ? { video_state: 'SCHEDULED' } : type === 'reel' ? { video_state: 'PUBLISHED' } : {}),
            ...(description ? { description } : {}) })
      } }, `${endpoint}.finish`);
    } catch (error) {
      if (!error.ambiguous && !error.cancelled) await checkpoint({ phase: 'transferred' });
      throw error;
    }
    if (finish.data?.success === false) {
      await checkpoint({ phase: 'transferred' });
      throw fail('Facebook từ chối hoàn tất xuất bản video');
    }
    if (finish.data?.success !== true) throw fail('Phản hồi hoàn tất không rõ kết quả; cần xác minh video đã tạo', { ambiguous: true });
    await checkpoint({ phase: 'finished', postId: finish.data.post_id || null, finishObjectId: finish.data.id || null, finishAcceptedAt: new Date().toISOString() });
    return result();
  }

  async requestStream(config, endpoint, stream) {
    const signal = config.signal || this.signal;
    const transferController = new AbortController();
    const abort = () => { transferController.abort(signal?.reason); stream.destroy(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let onError;
    const streamError = new Promise((_, reject) => { onError = reject; stream.once('error', onError); });
    try { return await Promise.race([this.request({ ...config, signal: transferController.signal }, endpoint), streamError]); }
    finally {
      signal?.removeEventListener('abort', abort);
      transferController.abort();
      stream.destroy();
      // Keep the error listener until close: an asynchronous open may still fail.
      stream.once('close', () => stream.removeListener('error', onError));
    }
  }

  async getVideoStatus(videoId, type = 'post', options = {}) {
    const response = await this.request({
      method: 'get', url: `${this.baseUrl}/${videoId}`, signal: options.signal,
      params: { fields: options.checkSchedule ? 'id,status,published,scheduled_publish_time,post_id,permalink_url'
        : type === 'post' ? 'id,status,published,permalink_url,post_id' : 'id,status', access_token: this.accessToken }
    }, 'getVideoStatus');
    const status = normalizeVideoStatus(response.data, type);
    if (status.postId) status.postId = pagePostId(this.pageId, status.postId);
    return status;
  }

  async getPostInfo(postId) {
    const response = await this.request({ method: 'get', url: `${this.baseUrl}/${postId}`, params: { fields: 'id,permalink_url', access_token: this.accessToken } }, 'getPostInfo');
    return { ...response.data, permalink_url: facebookPermalink(response.data.permalink_url) };
  }

  async postComment(postId, message) {
    const response = await this.request({ method: 'post', url: `${this.baseUrl}/${postId}/comments`, params: { message, access_token: this.accessToken } }, 'postComment');
    if (!response.data?.id) throw new FacebookApiError('Facebook chưa xác nhận ID bình luận. Hãy kiểm tra bài trước khi gửi lại.', { retryable: false });
    return response.data.id;
  }

  async deletePost(postId) {
    await this.request({ method: 'delete', url: `${this.baseUrl}/${postId}`, params: { access_token: this.accessToken } }, 'deletePost');
    return true;
  }

  async listComments(postId, limit = 50) {
    const response = await this.request({
      method: 'get', url: `${this.baseUrl}/${postId}/comments`,
      params: { fields: 'id,message,from,created_time,like_count,user_likes,comment_count,permalink_url,comments.limit(20){id,message,from,created_time}', limit, access_token: this.accessToken }
    }, 'listComments');
    return response.data;
  }

  async deleteComment(commentId) {
    await this.request({ method: 'delete', url: `${this.baseUrl}/${commentId}`, params: { access_token: this.accessToken } }, 'deleteComment');
    return true;
  }

  async likeObject(objectId, liked = true) {
    const response = await this.request({ method: liked ? 'post' : 'delete', url: `${this.baseUrl}/${objectId}/likes`, params: { access_token: this.accessToken } }, liked ? 'likeObject' : 'unlikeObject');
    if (response.data !== true && response.data?.success !== true) throw new FacebookApiError('Facebook chưa xác nhận thao tác thích bình luận.', { retryable: false });
    return true;
  }

  async getInsights(objectId, metrics = 'post_media_view,post_clicks') {
    const response = await this.request({ method: 'get', url: `${this.baseUrl}/${objectId}/insights`, params: { metric: metrics, access_token: this.accessToken } }, 'getInsights');
    return response.data;
  }

  async publishAndComment(videoPath, videoCaption, commentText) {
    let upload, result;
    try {
      result = await this.uploadVideoPost(videoPath, videoCaption, '', () => {}, { onCheckpoint: (state) => { upload = state; } });
      const { setTimeout: delay } = require('node:timers/promises');
      let published = false;
      for (let index = 0; index < 60; index += 1) {
        const status = await this.getVideoStatus(result.videoId || result.id, 'post');
        if (status.failed) throw new Error('Facebook xử lý video thất bại');
        if (status.published) { published = true; break; }
        await delay(10000, undefined, { signal: this.signal });
      }
      if (!published) return { success: false, postId: result.id, error: 'Chưa xác nhận xuất bản; hãy kiểm tra video đã tạo trước khi đăng lại', retryable: false };
      if (commentText?.trim()) {
        try { await this.postComment(result.id, commentText.trim()); }
        catch (error) { return { success: true, postId: result.id, warning: `Đã đăng bài nhưng chưa xác nhận bình luận: ${error.message}` }; }
      }
      return { success: true, postId: result.id };
    } catch (error) {
      return { success: false, postId: result?.id || upload?.videoId || null, upload,
        error: error.message, retryable: !upload?.videoId && upload?.phase !== 'starting' && error.retryable === true, authRequired: error.authRequired };
    }
  }
}

module.exports = FacebookApiService;
module.exports.FacebookApiError = FacebookApiError;
module.exports.normalizeFacebookError = normalizeFacebookError;
module.exports.DEFAULT_API_VERSION = DEFAULT_API_VERSION;
module.exports.normalizeVideoStatus = normalizeVideoStatus;
