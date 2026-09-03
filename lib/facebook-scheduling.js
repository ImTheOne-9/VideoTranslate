// Application buffer for uploading before a scheduled publication, not a claim
// about a universal Meta scheduling window. Meta still validates its own limits.
const MIN_SCHEDULE_LEAD_MS = 10 * 60 * 1000;

function validateFacebookSchedule(type, value, now = Date.now()) {
  if (!['post', 'reel', 'story'].includes(type)) throw new Error('Hẹn giờ phía Facebook chỉ áp dụng cho Video Post, Reel và Story.');
  const milliseconds = typeof value === 'number' ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds - now < MIN_SCHEDULE_LEAD_MS) {
    throw new Error('Hãy hẹn ít nhất 10 phút nữa để còn thời gian tải video và gửi lịch sang Facebook.');
  }
  return Math.floor(milliseconds / 1000);
}

function publicationSchedule(body, type, now = Date.now()) {
  if (!body.scheduledAt) {
    if (body.scheduleMode === 'facebook') throw new Error('Thiếu thời gian hẹn đăng trên Facebook.');
    return { scheduleMode: 'immediate', scheduledAt: new Date(now).toISOString() };
  }
  const timestamp = validateFacebookSchedule(type, body.scheduledAt, now);
  return { scheduleMode: 'facebook', scheduledAt: new Date(timestamp * 1000).toISOString() };
}

module.exports = { MIN_SCHEDULE_LEAD_MS, validateFacebookSchedule, publicationSchedule };
