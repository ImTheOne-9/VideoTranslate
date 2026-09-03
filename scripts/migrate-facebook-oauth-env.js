// Moves only Facebook OAuth configuration; never prints secret values.
// No network requests. Render environment variables still need deployment setup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');

const MOVED = ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_LOGIN_CONFIG_ID', 'FACEBOOK_WEBHOOK_VERIFY_TOKEN'];
function setValue(text, key, value) {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, () => line) : `${text.trimEnd()}\n${line}\n`;
}

function migrate(root) {
  const clientPath = path.join(root, '.env'), serverPath = path.join(root, 'license-server', '.env');
  let clientText = fs.readFileSync(clientPath, 'utf8');
  let serverText = fs.existsSync(serverPath) ? fs.readFileSync(serverPath, 'utf8') : '';
  const client = dotenv.parse(clientText), server = dotenv.parse(serverText);
  const base = new URL(client.FACEBOOK_OAUTH_BACKEND_URL || client.LICENSE_SERVER_URL || 'https://editnhanh.com');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Địa chỉ backend không hợp lệ.');
  for (const key of MOVED) {
    if (server[key] && client[key] && server[key] !== client[key]) throw new Error(`Cấu hình ${key} khác nhau giữa desktop và backend; cần chọn cấu hình đúng trước khi di chuyển.`);
    const value = server[key] || client[key];
    if (value) serverText = setValue(serverText, key, value);
  }
  const merged = dotenv.parse(serverText);
  if (!merged.FACEBOOK_APP_ID || !merged.FACEBOOK_APP_SECRET) throw new Error('Chưa có cấu hình Meta App để chuyển.');
  const callback = `${base.origin}/api/facebook/oauth/callback`;
  if (server.FACEBOOK_OAUTH_REDIRECT_URI && server.FACEBOOK_OAUTH_REDIRECT_URI !== callback) throw new Error('Callback backend hiện tại khác địa chỉ đang chọn; chưa thay đổi file.');
  serverText = setValue(serverText, 'FACEBOOK_OAUTH_REDIRECT_URI', callback);
  serverText = setValue(serverText, 'FACEBOOK_GRAPH_API_VERSION', server.FACEBOOK_GRAPH_API_VERSION || client.FACEBOOK_GRAPH_API_VERSION || 'v25.0');
  serverText = setValue(serverText, 'FACEBOOK_OAUTH_ENCRYPTION_KEY', server.FACEBOOK_OAUTH_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64'));
  // Write and verify the server copy BEFORE removing the desktop copy.
  const temporary = `${serverPath}.tmp`;
  fs.writeFileSync(temporary, serverText, { mode: 0o600 });
  fs.renameSync(temporary, serverPath);
  const saved = dotenv.parse(fs.readFileSync(serverPath, 'utf8'));
  if (saved.FACEBOOK_APP_SECRET !== merged.FACEBOOK_APP_SECRET) throw new Error('Không xác minh được bản sao cấu hình backend.');
  const remove = new RegExp(`^(?:export\\s+)?(?:${[...MOVED, 'FACEBOOK_OAUTH_REDIRECT_URI'].join('|')})\\s*=.*(?:\\r?\\n|$)`, 'gm');
  clientText = clientText.replace(remove, '');
  clientText = setValue(clientText, 'FACEBOOK_OAUTH_BACKEND_URL', base.origin);
  const clientTemp = `${clientPath}.tmp`;
  fs.writeFileSync(clientTemp, clientText, { mode: 0o600 });
  fs.renameSync(clientTemp, clientPath);
  return { backend: base.origin, callback, serverFile: serverPath, desktopSecretRemoved: !dotenv.parse(clientText).FACEBOOK_APP_SECRET };
}

if (require.main === module) {
  try { console.log(JSON.stringify(migrate(path.resolve(__dirname, '..')))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { migrate };
