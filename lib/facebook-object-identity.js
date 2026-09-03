// A Video ID and a Page Post ID are different Graph objects. Only qualify IDs
// that are known to identify a post; never prefix arbitrary video/comment IDs.
function pagePostId(pageId, postId) {
  const id = String(postId || '');
  const page = String(pageId || '');
  return /^[0-9]+$/.test(page) && /^[0-9]+$/.test(id) ? `${page}_${id}` : id;
}

function managementId(job, pageId = job.pageId) {
  const knownPost = job.type === 'story' ? job.upload?.postId || job.facebookStatus?.postId : job.facebookStatus?.postId || job.upload?.postId;
  if (knownPost) return pagePostId(pageId, knownPost);
  const workId = String(job.platformWorkId || '');
  const mediaId = String(job.mediaId || job.upload?.videoId || '');
  if (job.type === 'feed' || (mediaId && workId && workId !== mediaId)) return pagePostId(pageId, workId);
  return workId || mediaId;
}

function resolveManagedObjectId(jobs, account, objectId) {
  const id = String(objectId || '');
  const job = jobs.find((item) => {
    if (item.accountId !== account.id && item.pageId !== account.pageId) return false;
    return [item.platformWorkId, item.mediaId, item.upload?.postId, item.facebookStatus?.postId, managementId(item, account.pageId)]
      .filter(Boolean).map(String).includes(id);
  });
  return job ? managementId(job, account.pageId) : id;
}

function facebookPermalink(value) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://www.facebook.com');
    if (url.protocol !== 'https:' || !(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))) return null;
    return url.href;
  } catch { return null; }
}

module.exports = { pagePostId, managementId, resolveManagedObjectId, facebookPermalink };
