const crypto = require('node:crypto');

const digest = (value) => crypto.createHash('sha256').update(value).digest('base64url');

class FacebookOAuthClient {
  constructor({ baseUrl, credentials, accountStore, http, now = Date.now }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new Error('Facebook OAuth backend phải là địa chỉ HTTPS của license server.');
    }
    this.baseUrl = url.origin;
    this.credentials = credentials;
    this.accountStore = accountStore;
    this.http = http || require('axios').create({ timeout: 20000, maxRedirects: 0 });
    this.now = now;
    this.sessions = new Map();
  }

  async request(method, route, data) {
    try {
      const response = await this.http.request({ method, url: `${this.baseUrl}/api/facebook${route}`, data, headers: { 'Cache-Control': 'no-store' } });
      if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('Invalid backend response');
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      // Never pass axios request objects or server-controlled messages to the renderer.
      const message = status === 401 || status === 403 ? 'Bản quyền thiết bị chưa được backend chấp nhận.'
        : status === 404 || status === 410 ? 'Backend chưa có luồng kết nối này hoặc phiên đã hết hạn.'
          : 'Không kết nối được Facebook OAuth backend. Vui lòng thử lại sau.';
      throw Object.assign(new Error(message), { status, transient: !status || status >= 500 || status === 429 });
    }
  }

  getCredentials() {
    const result = this.credentials();
    if (!result?.key || !result?.hwid) throw new Error('Hãy kích hoạt bản quyền trước khi kết nối Facebook.');
    return { key: result.key, hwid: result.hwid };
  }

  cleanup() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }

  async config() {
    const result = await this.request('get', '/oauth/config');
    return { configured: result.configured === true && result.mode === 'backend', mode: 'backend', scopes: result.scopes || [] };
  }

  async start() {
    this.cleanup();
    if (this.sessions.size >= 5) throw new Error('Đã có phiên đăng nhập đang chờ. Hãy hoàn tất hoặc đợi phiên hết hạn.');
    const credentials = this.getCredentials();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const result = await this.request('post', '/oauth/sessions', { ...credentials, challenge: digest(verifier) });
    const url = new URL(result.url);
    if (url.origin !== this.baseUrl || url.pathname !== '/api/facebook/oauth/authorize' || url.username || url.password || url.hash || url.searchParams.get('sessionId') !== result.sessionId || !/^[A-Za-z0-9_-]{43}$/.test(result.sessionId || '')) {
      throw new Error('Backend trả địa chỉ đăng nhập không hợp lệ.');
    }
    const expiresAt = new Date(result.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 11 * 60 * 1000) throw new Error('Thời hạn phiên đăng nhập không hợp lệ.');
    const id = crypto.randomUUID();
    this.sessions.set(id, { cloudId: result.sessionId, verifier, owner: digest(`${credentials.key}\0${credentials.hwid}`), expiresAt, status: 'waiting' });
    return { sessionId: id, url: url.href, expiresAt: new Date(expiresAt).toISOString() };
  }

  async status(id) {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session) return { status: 'error', error: 'Phiên kết nối đã hết hạn. Hãy bấm Kết nối Facebook lại.' };
    const credentials = this.getCredentials();
    if (session.owner !== digest(`${credentials.key}\0${credentials.hwid}`)) throw new Error('Phiên kết nối thuộc bản quyền thiết bị khác.');
    if (session.status === 'success') return { status: 'success', accounts: session.accounts };
    // Concurrent browser polling shares one claim/save/ACK operation.
    if (!session.pending) session.pending = this.receive(session, credentials).finally(() => { session.pending = null; });
    return session.pending;
  }

  async receive(session, credentials) {
    const proof = { ...credentials, verifier: session.verifier };
    let result;
    try { result = await this.request('post', `/oauth/sessions/${session.cloudId}/result`, proof); }
    catch (error) { if (error.transient) return { status: 'waiting' }; throw error; }
    if (result.status === 'error') return { status: 'error', error: String(result.error || 'Facebook từ chối kết nối.').slice(0, 500) };
    if (result.status === 'consumed') return { status: 'error', error: 'Phiên đã nhận kết quả. Hãy tải lại danh sách Page hoặc kết nối lại.' };
    if (result.status !== 'ready') return { status: 'waiting' };
    if (!Array.isArray(result.pages) || !result.pages.length || result.pages.length > 2000 || result.pages.some((page) => typeof page.pageId !== 'string' || !/^[0-9]+$/.test(page.pageId) || typeof page.accessToken !== 'string' || !page.accessToken)) {
      throw new Error('Backend trả danh sách Page không hợp lệ.');
    }
    // Local encrypted saves must finish before deleting the temporary server copy.
    // upsert makes re-delivery safe if saving was interrupted halfway through.
    const accounts = result.pages.map((page) => this.accountStore.upsert({ pageId: page.pageId, accessToken: page.accessToken,
      name: page.name, pageName: page.pageName, avatar: page.avatar, fanCount: page.fanCount, category: page.category, tasks: page.tasks }));
    session.accounts = accounts;
    session.status = 'success';
    try { await this.request('post', `/oauth/sessions/${session.cloudId}/ack`, proof); }
    catch { /* Temporary encrypted server copy expires after 10 minutes if ACK is lost. */ }
    session.verifier = null;
    return { status: 'success', accounts };
  }
}

module.exports = { FacebookOAuthClient };
