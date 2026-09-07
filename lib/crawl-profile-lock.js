const active = new Set();

function profileKeys(script, args) {
  const index = args.indexOf('--platform');
  if (index >= 0) return [args[index + 1] === 'rednote' ? 'xhs' : args[index + 1]];
  if (/tiktok_series\.py$/i.test(script)) return ['tt'];
  if (/bili_goi_y\.py$/i.test(script)) return ['bili'];
  if (/xhs_browser\.py$/i.test(script)) return ['xhs'];
  if (/kiem_tra_login\.py$/i.test(script)) return args.map((code) => code === 'rednote' ? 'xhs' : code);
  return [];
}

function acquireProfiles(root, script, args) {
  const keys = [...new Set(profileKeys(script, args).map((key) => `${root}:${key}`))];
  if (keys.some((key) => active.has(key))) throw Object.assign(new Error('Hồ sơ nền tảng đang được dùng để cào hoặc xem trước. Đợi tác vụ hiện tại kết thúc rồi thử lại.'), { reason: 'busy' });
  keys.forEach((key) => active.add(key));
  return () => keys.forEach((key) => active.delete(key));
}

module.exports = { acquireProfiles, profileKeys };
