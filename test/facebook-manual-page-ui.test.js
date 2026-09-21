const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'controllers/facebookController.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const licenseServer = fs.readFileSync(path.join(root, 'license-server/server.js'), 'utf8');

test('Facebook Page manager uses tokens from the user own app and exposes a guide', () => {
  assert.match(html, /HƯỚNG DẪN TẠO APP &amp; LẤY TOKEN/);
  assert.match(html, /https:\/\/developers\.facebook\.com\/apps\//);
  assert.match(html, /https:\/\/developers\.facebook\.com\/tools\/explorer\//);
  assert.match(html, /pages_show_list/);
  assert.match(html, /pages_manage_posts/);
  assert.match(html, /facebook-user-access-token/);
  assert.match(html, /facebook-guide-flow/);
  assert.match(html, /facebook-permission-grid/);
  assert.match(html, /facebook-guide-troubleshoot/);
  assert.match(html, /facebook-graph-test-command/);
  assert.match(app, /async function copyFacebookGraphTest/);
  assert.match(app, /function toggleFacebookUserTokenVisibility/);
  assert.match(style, /#facebook-manual-guide-modal \.facebook-guide-modal \{ width: min\(1100px/);
  assert.match(app, /async function importFacebookPagesFromUserToken/);
  assert.match(app, /\/api\/facebook\/accounts\/from-user-token/);
  assert.match(html, /facebook-exchange-app-id/);
  assert.match(html, /facebook-exchange-app-secret/);
  assert.match(html, /facebook-exchange-user-token/);
  assert.match(app, /async function exchangeFacebookLongLivedToken/);
  assert.match(app, /\/api\/facebook\/accounts\/exchange-user-token/);
  assert.match(controller, /FacebookApiService\.exchangeUserToken/);
  assert.match(controller, /accounts\/exchange-user-token/);
  assert.doesNotMatch(controller, /res\.json\(\{[^}]*accessToken:\s*exchanged\.accessToken/s);
});

test('shared Facebook OAuth app flow is absent from desktop and license server runtime', () => {
  assert.doesNotMatch(html, /facebook-oauth-btn|KẾT NỐI FACEBOOK/);
  assert.doesNotMatch(app, /connectFacebookOAuth|\/api\/facebook\/oauth/);
  assert.doesNotMatch(controller, /FacebookOAuthClient|oauthConfig|oauthStart|oauthStatus/);
  assert.doesNotMatch(licenseServer, /createFacebookOAuthRouter|createFacebookOAuthStore/);
});
