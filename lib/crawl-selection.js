// Shared server policy: unknown metadata never satisfies a positive threshold.
function metric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function hasFilters(request = {}) {
  return ['minLike', 'minView', 'filterDays', 'timeDays'].some((key) => Number(request[key]) > 0);
}

function selectItems(items, request = {}, now = Date.now()) {
  const days = Math.max(0, Number(request.filterDays || request.timeDays) || 0);
  const cutoff = days ? now / 1000 - days * 86400 : 0;
  const seen = new Set();
  const selected = items.filter((item) => {
    const key = item.key || `${item.platform}:${item.id || item.sourceUrl || item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (Number(request.minLike) > 0 && (metric(item.likeCount) === null || item.likeCount < Number(request.minLike))) return false;
    if (Number(request.minView) > 0 && (metric(item.viewCount) === null || item.viewCount < Number(request.minView))) return false;
    if (cutoff && (!metric(item.timestamp) || Number(item.timestamp) < cutoff)) return false;
    return !(request.deepNew === true && item.downloaded);
  });
  const field = { likes: 'likeCount', views: 'viewCount', newest: 'timestamp' }[request.sort];
  if (field) selected.sort((a, b) => (metric(b[field]) ?? -1) - (metric(a[field]) ?? -1));
  return selected;
}

module.exports = { metric, hasFilters, selectItems };
