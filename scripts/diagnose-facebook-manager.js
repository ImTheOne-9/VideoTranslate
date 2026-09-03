// Read-only diagnosis. Never prints tokens, comment text, or raw request objects.
const path = require('node:path');
const fs = require('node:fs');
const axios = require('axios');
const { FacebookAccountStore } = require('../lib/facebook-account-store');

async function main() {
  const jobId = process.argv[2];
  if (!jobId) throw new Error('Usage: node scripts/diagnose-facebook-manager.js JOB_ID');
  const directory = path.join(__dirname, '..', 'facebook');
  const job = JSON.parse(fs.readFileSync(path.join(directory, 'publish-jobs.json'), 'utf8')).jobs.find((item) => item.id === jobId);
  if (!job || job.status !== 'published') throw new Error('Published job not found');
  const account = new FacebookAccountStore(path.join(directory, 'accounts.json')).get(job.accountId || job.pageId);
  if (!account) throw new Error('Saved Page account not found');
  const base = `https://graph.facebook.com/${job.upload?.apiVersion || 'v25.0'}`;
  const rawId = job.platformWorkId;
  const scopedId = rawId.includes('_') ? rawId : `${account.pageId}_${rawId}`;
  if (process.argv[3] === '--verify') {
    const FacebookApiService = require('../lib/facebookApi');
    const { managementId } = require('../lib/facebook-object-identity');
    const api = new FacebookApiService(account.pageId, account.accessToken, { apiVersion: job.upload?.apiVersion });
    const id = managementId(job, account.pageId);
    for (const [name, read] of [
      ['post', () => api.getPostInfo(id)],
      ['comments', () => api.listComments(id)],
      ['insights', () => api.getInsights(id)]
    ]) {
      try {
        const data = await read();
        console.log(JSON.stringify({ name, ok: true, id: data.id, permalink: data.permalink_url,
          count: Array.isArray(data.data) ? data.data.length : undefined,
          metrics: Array.isArray(data.data) ? data.data.map((item) => item.name).filter(Boolean) : undefined }));
      } catch (error) {
        console.log(JSON.stringify({ name, ok: false, code: error.code, message: String(error.message).split(account.accessToken).join('[redacted]') }));
        process.exitCode = 2;
      }
    }
    return;
  }
  async function check(name, object, params) {
    try {
      const { data } = await axios.get(`${base}/${object}`, { params: { ...params, access_token: account.accessToken }, timeout: 20000 });
      console.log(JSON.stringify({ name, ok: true, id: data.id, permalink: data.permalink_url, count: Array.isArray(data.data) ? data.data.length : undefined,
        metrics: Array.isArray(data.data) ? data.data.map((item) => item.name).filter(Boolean) : undefined }));
    } catch (error) {
      const graph = error.response?.data?.error;
      console.log(JSON.stringify({ name, ok: false, status: error.response?.status, code: graph?.code || error.code,
        message: String(graph?.message || 'Request failed').split(account.accessToken).join('[redacted]') }));
      if (!error.response) process.exitCode = 2;
    }
  }
  await check('raw-comments', `${rawId}/comments`, { fields: 'id', limit: 1 });
  await check('page-scoped-comments', `${scopedId}/comments`, { fields: 'id', limit: 1 });
  await check('page-scoped-post', scopedId, { fields: 'id,permalink_url' });
  for (const metric of ['post_impressions', 'post_engaged_users', 'post_clicks', 'post_media_view']) {
    await check(metric, `${scopedId}/insights`, { metric });
  }
}

main().catch(() => { console.error('Could not read the selected job/account for diagnosis. No credentials were printed.'); process.exitCode = 1; });
