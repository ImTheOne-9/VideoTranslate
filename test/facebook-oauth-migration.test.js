const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dotenv = require('dotenv');
const { migrate } = require('../scripts/migrate-facebook-oauth-env');

function fixture(t, server = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facebook-oauth-env-'));
  fs.mkdirSync(path.join(root, 'license-server'));
  fs.writeFileSync(path.join(root, '.env'), 'LICENSE_SERVER_URL=https://backend.test\nFACEBOOK_APP_ID=123\nFACEBOOK_APP_SECRET=test-secret\nFACEBOOK_OAUTH_REDIRECT_URI=https://old-tunnel.test/api/facebook/oauth/callback\nUNRELATED=value\n');
  fs.writeFileSync(path.join(root, 'license-server', '.env'), server);
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('facebook-oauth-env-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('Move OAuth secret to server env, preserve unrelated config, and run idempotently', (t) => {
  const root = fixture(t, 'MONGODB_URI=mongodb://test\n');
  const result = migrate(root);
  assert.equal(result.desktopSecretRemoved, true);
  const client = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
  const backend = dotenv.parse(fs.readFileSync(path.join(root, 'license-server', '.env')));
  assert.equal(client.FACEBOOK_APP_SECRET, undefined);
  assert.equal(client.FACEBOOK_OAUTH_REDIRECT_URI, undefined);
  assert.equal(client.UNRELATED, 'value');
  assert.equal(client.FACEBOOK_OAUTH_BACKEND_URL, 'https://backend.test');
  assert.equal(backend.FACEBOOK_APP_SECRET, 'test-secret');
  assert.equal(backend.MONGODB_URI, 'mongodb://test');
  assert.equal(backend.FACEBOOK_OAUTH_REDIRECT_URI, 'https://backend.test/api/facebook/oauth/callback');
  assert.equal(Buffer.from(backend.FACEBOOK_OAUTH_ENCRYPTION_KEY, 'base64').length, 32);
  migrate(root);
  assert.equal(dotenv.parse(fs.readFileSync(path.join(root, 'license-server', '.env'))).FACEBOOK_OAUTH_ENCRYPTION_KEY, backend.FACEBOOK_OAUTH_ENCRYPTION_KEY);
});

test('Conflicting backend secret is not overwritten and desktop config stays intact', (t) => {
  const root = fixture(t, 'FACEBOOK_APP_SECRET=existing-server-secret\n');
  const original = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.throws(() => migrate(root), /khác nhau/);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), original);
  assert.equal(dotenv.parse(fs.readFileSync(path.join(root, 'license-server', '.env'))).FACEBOOK_APP_SECRET, 'existing-server-secret');
});

test('Desktop runtime has no App Secret access and installer excludes backend env', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['controllers/facebookController.js', 'lib/facebook-oauth-client.js', 'public/app.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /FACEBOOK_APP_SECRET|client_secret/);
  }
  const config = require('../package.json');
  for (const pattern of ['!license-server/**/*', '!.env', '!.env.*', '!**/.env', '!**/.env.*']) assert.ok(config.build.files.includes(pattern));
});
