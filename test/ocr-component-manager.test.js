const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const AdmZip = require('adm-zip');

const {
  createOcrComponentManager
} = require('../lib/ocr-component-manager');

const REQUIRED_LANGUAGES = ['ch', 'vi', 'en', 'japan', 'korean'];

function createManifest(overrides = {}) {
  return {
    version: '1.2.3',
    archiveUrl: 'https://example.test/vse-cli.zip',
    archiveSize: 128,
    installedSize: 256,
    sha256: 'a'.repeat(64),
    componentRoot: 'vse-cli',
    executable: 'vse-cli.exe',
    requiredFiles: ['runtime.dll'],
    supportedLanguages: [...REQUIRED_LANGUAGES],
    ...overrides
  };
}

async function createTempToolsDir(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocr-component-'));
  const dataToolsDir = path.join(root, 'tools');
  await fs.promises.mkdir(dataToolsDir, { recursive: true });
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return { root, dataToolsDir };
}

async function createZip(root, files = {
  'vse-cli/vse-cli.exe': 'new executable',
  'vse-cli/runtime.dll': 'new runtime'
}) {
  const zip = new AdmZip();
  for (const [entryName, contents] of Object.entries(files)) {
    zip.addFile(entryName, Buffer.from(contents));
  }

  const archivePath = path.join(root, `fixture-${crypto.randomUUID()}.zip`);
  await fs.promises.writeFile(archivePath, zip.toBuffer());
  const archive = await fs.promises.readFile(archivePath);
  return {
    archivePath,
    archiveSize: archive.length,
    installedSize: Object.values(files).reduce(
      (total, contents) => total + Buffer.byteLength(contents),
      0
    ),
    sha256: crypto.createHash('sha256').update(archive).digest('hex')
  };
}

async function createTraversalZip(root) {
  const zip = new AdmZip();
  zip.addFile('xx/escaped.txt', Buffer.from('outside'));
  zip.addFile('vse-cli/vse-cli.exe', Buffer.from('executable'));
  zip.addFile('vse-cli/runtime.dll', Buffer.from('runtime'));

  const archive = zip.toBuffer();
  const safeName = Buffer.from('xx/escaped.txt');
  const unsafeName = Buffer.from('../escaped.txt');
  let offset = 0;
  let replacements = 0;
  while ((offset = archive.indexOf(safeName, offset)) !== -1) {
    unsafeName.copy(archive, offset);
    offset += unsafeName.length;
    replacements += 1;
  }
  assert.equal(replacements, 2, 'both ZIP filename records should be patched');

  const archivePath = path.join(root, `traversal-${crypto.randomUUID()}.zip`);
  await fs.promises.writeFile(archivePath, archive);
  return {
    archivePath,
    archiveSize: archive.length,
    installedSize: 24,
    sha256: crypto.createHash('sha256').update(archive).digest('hex')
  };
}

async function writeInstalledComponent(dataToolsDir, manifest, contents = {}) {
  const componentDir = path.join(dataToolsDir, 'vse-cli');
  await fs.promises.mkdir(componentDir, { recursive: true });

  const files = new Set([manifest.executable, ...manifest.requiredFiles]);
  for (const relativePath of files) {
    const filePath = path.join(componentDir, relativePath);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(
      filePath,
      contents[relativePath] || `installed ${relativePath}`
    );
  }

  await fs.promises.writeFile(
    path.join(componentDir, 'installed.json'),
    JSON.stringify({ ...manifest, installedAt: '2026-07-17T00:00:00.000Z' }, null, 2)
  );
  return componentDir;
}

function createCopyDownloader(archivePath, onDestination) {
  return async ({ destination, onProgress, signal }) => {
    signal?.throwIfAborted();
    onDestination?.(destination);
    const archive = await fs.promises.readFile(archivePath);
    await fs.promises.writeFile(destination, archive);
    onProgress?.(archive.length, archive.length);
  };
}

function createManager(dataToolsDir, manifest, overrides = {}) {
  return createOcrComponentManager({
    dataToolsDir,
    fetchManifest: async () => manifest,
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER,
    ...overrides
  });
}

function assertNoScratchArtifacts(dataToolsDir) {
  const names = fs.readdirSync(dataToolsDir);
  assert.deepEqual(
    names.filter((name) => (
      name.endsWith('.partial') ||
      name.startsWith('.staging-') ||
      name.startsWith('.backup-')
    )),
    []
  );
}

function mockHttpsRoutes(t, routes) {
  const requests = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    const href = url instanceof URL ? url.href : String(url);
    requests.push(href);
    const request = new EventEmitter();
    let response = null;
    request.destroy = (error) => {
      if (response) {
        response.destroy(error);
      } else if (error) {
        queueMicrotask(() => request.emit('error', error));
      }
    };

    queueMicrotask(() => {
      const route = routes.get(href);
      if (!route) {
        request.emit('error', new Error(`Unexpected HTTPS request: ${href}`));
        return;
      }
      response = new PassThrough();
      response.statusCode = route.statusCode ?? 200;
      response.headers = route.headers || {};
      callback(response);
      if (route.onResponse) {
        route.onResponse(response, request);
      } else {
        response.end(route.body || Buffer.alloc(0));
      }
    });

    return request;
  });
  return requests;
}

test('public singleton exports delegate with documented callable contracts', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const managerPath = require.resolve('../lib/ocr-component-manager');
  const sharedPath = require.resolve('../lib/shared-state');
  const script = `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    const https = require('node:https');
    const managerPath = ${JSON.stringify(managerPath)};
    const sharedPath = ${JSON.stringify(sharedPath)};
    require.cache[sharedPath] = {
      id: sharedPath,
      filename: sharedPath,
      loaded: true,
      exports: { DATA_TOOLS_DIR: process.env.OCR_SINGLETON_TEST_DIR }
    };
    https.get = () => {
      const request = new EventEmitter();
      request.destroy = (error) => {
        if (error) queueMicrotask(() => request.emit('error', error));
      };
      queueMicrotask(() => request.emit('error', new Error('offline singleton fixture')));
      return request;
    };

    (async () => {
      const api = require(managerPath);
      assert.deepEqual(Object.keys(api).sort(), [
        'OCR_COMPONENT_MANIFEST_URL',
        'cancelOcrComponentDownload',
        'createOcrComponentManager',
        'downloadOcrComponent',
        'getOcrComponentStatus',
        'getOcrDownloadProgress',
        'getOcrExecutablePath',
        'refreshOcrComponentStatus'
      ]);
      for (const name of Object.keys(api).filter((name) => name !== 'OCR_COMPONENT_MANIFEST_URL')) {
        assert.equal(typeof api[name], 'function', name);
        assert.equal(api[name].length, 0, name);
      }

      assert.deepEqual(api.getOcrComponentStatus(), {
        status: 'not_installed',
        version: null,
        supportedLanguages: [],
        error: null
      });
      assert.equal(api.getOcrExecutablePath(), null);
      assert.deepEqual(api.getOcrDownloadProgress(), {
        status: 'not_installed',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        step: 'checking',
        error: null
      });

      const refreshPromise = api.refreshOcrComponentStatus();
      assert.equal(refreshPromise instanceof Promise, true);
      assert.equal((await refreshPromise).status, 'error');

      const downloadPromise = api.downloadOcrComponent();
      assert.equal(downloadPromise instanceof Promise, true);
      await assert.rejects(downloadPromise, /offline singleton fixture/i);

      const cancelPromise = api.cancelOcrComponentDownload();
      assert.equal(cancelPromise instanceof Promise, true);
      assert.equal((await cancelPromise).status, 'error');
    })().catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      OCR_SINGLETON_TEST_DIR: dataToolsDir
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('missing executable reports not_installed', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  const componentDir = await writeInstalledComponent(dataToolsDir, manifest);
  await fs.promises.rm(path.join(componentDir, manifest.executable));
  const manager = createManager(dataToolsDir, manifest);

  assert.deepEqual(manager.getOcrComponentStatus(), {
    status: 'not_installed',
    version: null,
    supportedLanguages: [],
    error: null
  });
});

test('matching verified local manifest reports ready and executable path', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  await writeInstalledComponent(dataToolsDir, manifest);
  const manager = createManager(dataToolsDir, manifest);

  assert.deepEqual(manager.getOcrComponentStatus(), {
    status: 'ready',
    version: manifest.version,
    supportedLanguages: manifest.supportedLanguages,
    error: null
  });
  assert.equal(
    manager.getOcrExecutablePath(),
    path.join(dataToolsDir, 'vse-cli', 'vse-cli.exe')
  );
});

test('local readiness rejects a required file reached through an external junction', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest({ requiredFiles: ['runtime/runtime.dll'] });
  const componentDir = await writeInstalledComponent(dataToolsDir, manifest);
  const externalRuntimeDir = path.join(root, 'external-runtime');
  const runtimeDir = path.join(componentDir, 'runtime');
  await fs.promises.mkdir(externalRuntimeDir);
  await fs.promises.writeFile(path.join(externalRuntimeDir, 'runtime.dll'), 'external runtime');
  await fs.promises.rm(runtimeDir, { recursive: true });
  await fs.promises.symlink(externalRuntimeDir, runtimeDir, 'junction');
  const manager = createManager(dataToolsDir, manifest);

  assert.equal(manager.getOcrComponentStatus().status, 'not_installed');
  assert.equal(manager.getOcrExecutablePath(), null);
});

test('local readiness rejects a component root junction outside data tools', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  const externalToolsDir = path.join(root, 'external-tools');
  const externalComponentDir = await writeInstalledComponent(externalToolsDir, manifest);
  const componentDir = path.join(dataToolsDir, 'vse-cli');
  await fs.promises.symlink(externalComponentDir, componentDir, 'junction');
  const manager = createManager(dataToolsDir, manifest);

  assert.equal(manager.getOcrComponentStatus().status, 'not_installed');
  assert.equal(manager.getOcrExecutablePath(), null);
});

test('offline manifest refresh preserves a valid local install', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  await writeInstalledComponent(dataToolsDir, manifest);
  const manager = createManager(dataToolsDir, manifest, {
    fetchManifest: async () => {
      throw new Error('network offline');
    }
  });

  assert.deepEqual(await manager.refreshOcrComponentStatus(), {
    status: 'ready',
    version: manifest.version,
    supportedLanguages: manifest.supportedLanguages,
    error: null
  });
});

test('version mismatch reports not_installed without deleting the old install', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manager = createManager(
    dataToolsDir,
    createManifest({ version: '2.0.0' })
  );

  assert.deepEqual(await manager.refreshOcrComponentStatus(), {
    status: 'not_installed',
    version: oldManifest.version,
    supportedLanguages: oldManifest.supportedLanguages,
    error: null
  });
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
});

test('invalid manifest fields are rejected before disk or archive use', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const invalidManifests = [
    ['semantic version', { version: '1.2' }],
    ['HTTPS archive URL', { archiveUrl: 'http://example.test/archive.zip' }],
    ['positive archive size', { archiveSize: 0 }],
    ['integer installed size', { installedSize: 1.5 }],
    ['lowercase SHA-256', { sha256: 'A'.repeat(64) }],
    ['fixed component root', { componentRoot: 'other-root' }],
    ['safe executable', { executable: '../vse-cli.exe' }],
    ['expected executable', { executable: 'other.exe' }],
    ['non-empty required files', { requiredFiles: [] }],
    ['safe required files', { requiredFiles: ['../runtime.dll'] }],
    ['Windows alternate data stream', { requiredFiles: ['runtime.dll:payload'] }],
    ['Windows reserved filename', { requiredFiles: ['NUL.dll'] }],
    ['Windows trailing-dot alias', { requiredFiles: ['runtime.dll.'] }],
    ['required languages', { supportedLanguages: ['ch', 'vi', 'en'] }]
  ];

  for (const [label, invalid] of invalidManifests) {
    let freeSpaceCalls = 0;
    let downloaderCalls = 0;
    const manager = createManager(dataToolsDir, createManifest(invalid), {
      getFreeSpace: async () => {
        freeSpaceCalls += 1;
        return Number.MAX_SAFE_INTEGER;
      },
      downloadFile: async () => {
        downloaderCalls += 1;
      }
    });

    await assert.rejects(
      manager.downloadOcrComponent(),
      /manifest/i,
      label
    );
    assert.equal(freeSpaceCalls, 0, `${label}: disk check must not run`);
    assert.equal(downloaderCalls, 0, `${label}: download must not run`);
  }
});

test('default HTTPS adapters follow manifest and archive redirects', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const archiveContents = await fs.promises.readFile(archive.archivePath);
  const manifestUrl = 'https://origin.test/manifest.json';
  const finalManifestUrl = 'https://origin.test/manifests/latest.json';
  const archiveUrl = 'https://origin.test/vse-cli.zip';
  const finalArchiveUrl = 'https://cdn.test/vse-cli.zip';
  const manifest = createManifest({
    archiveUrl,
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const routes = new Map([
    [manifestUrl, { statusCode: 302, headers: { location: '/manifests/latest.json' } }],
    [finalManifestUrl, { body: Buffer.from(JSON.stringify(manifest)) }],
    [archiveUrl, { statusCode: 307, headers: { location: finalArchiveUrl } }],
    [finalArchiveUrl, {
      headers: { 'content-length': String(archiveContents.length) },
      body: archiveContents
    }]
  ]);
  const requests = mockHttpsRoutes(t, routes);
  const manager = createOcrComponentManager({
    dataToolsDir,
    manifestUrl,
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER
  });

  assert.equal((await manager.downloadOcrComponent()).status, 'ready');
  assert.deepEqual(requests, [manifestUrl, finalManifestUrl, archiveUrl, finalArchiveUrl]);
  assert.equal(
    await fs.promises.readFile(path.join(dataToolsDir, 'vse-cli', 'vse-cli.exe'), 'utf8'),
    'new executable'
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('default HTTPS adapter allows at most five redirects', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const routes = new Map();
  const expectedRequests = [];
  for (let index = 0; index <= 5; index += 1) {
    const currentUrl = `https://redirect.test/manifest-${index}.json`;
    expectedRequests.push(currentUrl);
    routes.set(currentUrl, {
      statusCode: 302,
      headers: { location: `/manifest-${index + 1}.json` }
    });
  }
  const requests = mockHttpsRoutes(t, routes);
  const manager = createOcrComponentManager({
    dataToolsDir,
    manifestUrl: expectedRequests[0],
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER
  });

  await assert.rejects(manager.downloadOcrComponent(), /too many HTTPS redirects/i);
  assert.deepEqual(requests, expectedRequests);
  assertNoScratchArtifacts(dataToolsDir);
});

test('default HTTPS adapter rejects a redirect downgrade', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifestUrl = 'https://secure.test/manifest.json';
  const requests = mockHttpsRoutes(t, new Map([
    [manifestUrl, { statusCode: 302, headers: { location: 'http://insecure.test/manifest.json' } }]
  ]));
  const manager = createOcrComponentManager({
    dataToolsDir,
    manifestUrl,
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER
  });

  await assert.rejects(manager.downloadOcrComponent(), /refusing non-HTTPS URL/i);
  assert.deepEqual(requests, [manifestUrl]);
  assertNoScratchArtifacts(dataToolsDir);
});

test('default manifest stream aborts when cancellation wins the response handoff', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifestUrl = 'https://manifest-race.test/manifest.json';
  let manifestResponse = null;
  let cancelPromise = null;
  let notifyHeadersReceived;
  const headersReceived = new Promise((resolve) => {
    notifyHeadersReceived = resolve;
  });
  let manager;
  mockHttpsRoutes(t, new Map([
    [manifestUrl, {
      onResponse(response) {
        manifestResponse = response;
        cancelPromise = manager.cancelOcrComponentDownload();
        notifyHeadersReceived();
      }
    }]
  ]));
  manager = createOcrComponentManager({
    dataToolsDir,
    manifestUrl,
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER
  });

  const rejectedDownload = assert.rejects(manager.downloadOcrComponent(), /cancelled/i);
  await headersReceived;
  await new Promise((resolve) => setImmediate(resolve));
  const destroyedImmediately = manifestResponse.destroyed;
  if (!destroyedImmediately) {
    manifestResponse.destroy(new Error('test cleanup for missed manifest abort'));
  }
  await rejectedDownload;
  await cancelPromise;

  assert.equal(destroyedImmediately, true);
  assertNoScratchArtifacts(dataToolsDir);
});

test('default downloader aborts before opening output when cancellation wins the response handoff', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifestUrl = 'https://download-race.test/manifest.json';
  const archiveUrl = 'https://download-race.test/vse-cli.zip';
  const manifest = createManifest({ archiveUrl });
  let archiveResponse = null;
  let cancelPromise = null;
  let outputCreations = 0;
  let notifyHeadersReceived;
  const headersReceived = new Promise((resolve) => {
    notifyHeadersReceived = resolve;
  });
  const createWriteStream = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (...args) => {
    outputCreations += 1;
    return createWriteStream(...args);
  });
  let manager;
  mockHttpsRoutes(t, new Map([
    [manifestUrl, { body: Buffer.from(JSON.stringify(manifest)) }],
    [archiveUrl, {
      headers: { 'content-length': String(manifest.archiveSize) },
      onResponse(response) {
        archiveResponse = response;
        cancelPromise = manager.cancelOcrComponentDownload();
        notifyHeadersReceived();
      }
    }]
  ]));
  manager = createOcrComponentManager({
    dataToolsDir,
    manifestUrl,
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER
  });

  const rejectedDownload = assert.rejects(manager.downloadOcrComponent(), /cancelled/i);
  await headersReceived;
  await new Promise((resolve) => setImmediate(resolve));
  const destroyedImmediately = archiveResponse.destroyed;
  if (!destroyedImmediately) {
    archiveResponse.destroy(new Error('test cleanup for missed download abort'));
  }
  await rejectedDownload;
  await cancelPromise;

  assert.equal(destroyedImmediately, true);
  assert.equal(outputCreations, 0);
  assertNoScratchArtifacts(dataToolsDir);
});

test('default downloader aborts its stream and cleans partial state', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifestUrl = 'https://cancel.test/manifest.json';
  const archiveUrl = 'https://cancel.test/vse-cli.zip';
  const manifest = createManifest({ archiveUrl });
  let archiveResponse = null;
  let notifyArchiveOpened;
  const archiveOpened = new Promise((resolve) => {
    notifyArchiveOpened = resolve;
  });
  mockHttpsRoutes(t, new Map([
    [manifestUrl, { body: Buffer.from(JSON.stringify(manifest)) }],
    [archiveUrl, {
      headers: { 'content-length': String(manifest.archiveSize) },
      onResponse(response) {
        archiveResponse = response;
        response.write(Buffer.alloc(16, 1));
        notifyArchiveOpened();
      }
    }]
  ]));
  const manager = createOcrComponentManager({
    dataToolsDir,
    manifestUrl,
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER
  });

  const downloadPromise = manager.downloadOcrComponent();
  const rejectedDownload = assert.rejects(downloadPromise, /cancelled/i);
  await archiveOpened;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.getOcrDownloadProgress().downloadedBytes > 0) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(manager.getOcrDownloadProgress().downloadedBytes, 16);
  assert.equal((await manager.cancelOcrComponentDownload()).status, 'cancelled');
  await rejectedDownload;

  assert.equal(archiveResponse.destroyed, true);
  assert.equal(manager.getOcrDownloadProgress().step, 'cancelled');
  assertNoScratchArtifacts(dataToolsDir);
});

test('insufficient disk space fails before the downloader is called', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0', installedSize: 777 });
  await writeInstalledComponent(dataToolsDir, oldManifest);
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const requiredBytes = manifest.archiveSize + manifest.installedSize + oldManifest.installedSize;
  let checkedPath = null;
  let downloaderCalls = 0;
  const manager = createManager(dataToolsDir, manifest, {
    getFreeSpace: async ({ path: targetPath }) => {
      checkedPath = targetPath;
      return requiredBytes - 1;
    },
    downloadFile: async () => {
      downloaderCalls += 1;
    }
  });

  await assert.rejects(manager.downloadOcrComponent(), /insufficient disk space/i);
  assert.equal(checkedPath, dataToolsDir);
  assert.equal(downloaderCalls, 0);
  assertNoScratchArtifacts(dataToolsDir);
});

test('concurrent download calls share one in-flight promise', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const manifest = createManifest({
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  let releaseDownload;
  let notifyDownloadStarted;
  let downloaderCalls = 0;
  const gate = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  const downloadStarted = new Promise((resolve) => {
    notifyDownloadStarted = resolve;
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: async (request) => {
      downloaderCalls += 1;
      notifyDownloadStarted();
      await gate;
      await createCopyDownloader(archive.archivePath)(request);
    }
  });

  const first = manager.downloadOcrComponent();
  const second = manager.downloadOcrComponent();
  assert.strictEqual(first, second);
  await downloadStarted;
  assert.equal(downloaderCalls, 1);

  releaseDownload();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 'ready');
  assert.deepEqual(secondResult, firstResult);
});

test('download progress enters checking state before asynchronous setup', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  const manager = createManager(dataToolsDir, manifest, {
    fetchManifest: async ({ signal }) => {
      signal.throwIfAborted();
      return manifest;
    }
  });

  const downloadPromise = manager.downloadOcrComponent();
  const rejectedDownload = assert.rejects(downloadPromise, /cancelled/i);
  const immediateProgress = manager.getOcrDownloadProgress();
  await manager.cancelOcrComponentDownload();
  await rejectedDownload;
  assertNoScratchArtifacts(dataToolsDir);

  assert.deepEqual(immediateProgress, {
    status: 'downloading',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    step: 'checking',
    error: null
  });
});

test('partial download stays outside the final install and reports byte progress', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const manifest = createManifest({
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const componentDir = path.join(dataToolsDir, 'vse-cli');
  let partialPath = null;
  let manager;
  manager = createManager(dataToolsDir, manifest, {
    downloadFile: async ({ destination, onProgress }) => {
      partialPath = destination;
      assert.equal(path.dirname(destination), dataToolsDir);
      assert.equal(destination.endsWith('.partial'), true);
      assert.equal(destination.startsWith(`${componentDir}${path.sep}`), false);
      const contents = await fs.promises.readFile(archive.archivePath);
      await fs.promises.writeFile(destination, contents);
      onProgress(Math.floor(contents.length / 2), contents.length);
      assert.deepEqual(manager.getOcrDownloadProgress(), {
        status: 'downloading',
        percent: Math.floor((Math.floor(contents.length / 2) / contents.length) * 100),
        downloadedBytes: Math.floor(contents.length / 2),
        totalBytes: contents.length,
        step: 'downloading',
        error: null
      });
      onProgress(contents.length, contents.length);
    }
  });

  await manager.downloadOcrComponent();
  assert.equal(fs.existsSync(partialPath), false);
  assertNoScratchArtifacts(dataToolsDir);
});

for (const integrityFailure of ['size', 'sha256']) {
  test(`${integrityFailure} mismatch cleans scratch paths and preserves the old install`, async (t) => {
    const { root, dataToolsDir } = await createTempToolsDir(t);
    const archive = await createZip(root);
    const oldManifest = createManifest({ version: '1.0.0' });
    const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
      'vse-cli.exe': 'old executable'
    });
    const manifest = createManifest({
      version: '2.0.0',
      archiveSize: integrityFailure === 'size' ? archive.archiveSize + 1 : archive.archiveSize,
      installedSize: archive.installedSize,
      sha256: integrityFailure === 'sha256' ? '0'.repeat(64) : archive.sha256
    });
    const manager = createManager(dataToolsDir, manifest, {
      downloadFile: createCopyDownloader(archive.archivePath)
    });

    await assert.rejects(
      manager.downloadOcrComponent(),
      integrityFailure === 'size' ? /archive size mismatch/i : /sha-256 mismatch/i
    );
    assert.equal(
      await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
      'old executable'
    );
    assert.equal(manager.getOcrDownloadProgress().step, 'error');
    assertNoScratchArtifacts(dataToolsDir);
  });
}

test('scratch cleanup attempts every path without masking the primary download error', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  const primaryError = new Error('injected primary download failure');
  const cleanupAttempts = [];
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: async () => {
      throw primaryError;
    },
    remove: async (targetPath) => {
      cleanupAttempts.push(targetPath);
      throw new Error(`injected cleanup failure: ${path.basename(targetPath)}`);
    }
  });

  await assert.rejects(manager.downloadOcrComponent(), (error) => {
    assert.strictEqual(error, primaryError);
    assert.equal(error.message, 'injected primary download failure');
    assert.equal(error.cleanupErrors.length, 2);
    assert.deepEqual(
      error.cleanupErrors.map((cleanupError) => cleanupError.operation),
      ['remove-partial', 'remove-staging']
    );
    return true;
  });
  assert.equal(cleanupAttempts.length, 2);
  assert.equal(cleanupAttempts.some((targetPath) => targetPath.endsWith('.partial')), true);
  assert.equal(cleanupAttempts.some((targetPath) => path.basename(targetPath).startsWith('.staging-')), true);
  assert.equal(manager.getOcrDownloadProgress().error, primaryError.message);
});

test('scratch cleanup failures do not replace the primary cancellation error', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  const cleanupAttempts = [];
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: async ({ signal }) => {
      notifyStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    remove: async (targetPath) => {
      cleanupAttempts.push(targetPath);
      throw new Error(`injected cleanup failure: ${path.basename(targetPath)}`);
    }
  });

  const downloadPromise = manager.downloadOcrComponent();
  const rejectedDownload = assert.rejects(downloadPromise, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.match(error.message, /cancelled/i);
    assert.equal(error.cleanupErrors.length, 2);
    return true;
  });
  await started;
  const cancelledStatus = await manager.cancelOcrComponentDownload();
  await rejectedDownload;

  assert.equal(cancelledStatus.status, 'cancelled');
  assert.equal(cleanupAttempts.length, 2);
});

test('ZIP traversal is rejected before extraction writes outside staging', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createTraversalZip(root);
  const manifest = createManifest({
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath)
  });

  await assert.rejects(manager.downloadOcrComponent(), /ZIP entry escapes staging/i);
  assert.equal(fs.existsSync(path.join(dataToolsDir, 'escaped.txt')), false);
  assertNoScratchArtifacts(dataToolsDir);
});

test('ZIP entries with Windows alternate-data-stream names are rejected', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root, {
    'vse-cli/vse-cli.exe': 'new executable',
    'vse-cli/runtime.dll': 'new runtime',
    'vse-cli/runtime.dll:payload': 'hidden payload'
  });
  const manifest = createManifest({
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath)
  });

  await assert.rejects(manager.downloadOcrComponent(), /ZIP entry escapes staging/i);
  assert.equal(fs.existsSync(path.join(dataToolsDir, 'vse-cli')), false);
  assertNoScratchArtifacts(dataToolsDir);
});

test('ZIP payload larger than installedSize is rejected and preserves the old install', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize - 1,
    sha256: archive.sha256
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath)
  });

  await assert.rejects(manager.downloadOcrComponent(), /exceeds installedSize/i);
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('missing required runtime files after extraction is rejected', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root, {
    'vse-cli/vse-cli.exe': 'executable only'
  });
  const manifest = createManifest({
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath)
  });

  await assert.rejects(manager.downloadOcrComponent(), /required file.*runtime\.dll/i);
  assert.equal(fs.existsSync(path.join(dataToolsDir, 'vse-cli')), false);
  assertNoScratchArtifacts(dataToolsDir);
});

test('archive extraction streams from disk instead of reading the whole ZIP into memory', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const manifest = createManifest({
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (String(args[0]).endsWith('.partial')) {
      throw new Error('whole archive read is forbidden');
    }
    return readFileSync(...args);
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath)
  });

  assert.equal((await manager.downloadOcrComponent()).status, 'ready');
  assertNoScratchArtifacts(dataToolsDir);
});

test('successful upgrade writes installed metadata and removes backup and scratch paths', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath)
  });

  assert.deepEqual(await manager.downloadOcrComponent(), {
    status: 'ready',
    version: manifest.version,
    supportedLanguages: manifest.supportedLanguages,
    error: null
  });
  const installed = JSON.parse(await fs.promises.readFile(
    path.join(dataToolsDir, 'vse-cli', 'installed.json'),
    'utf8'
  ));
  assert.deepEqual(
    { ...installed, installedAt: undefined },
    { ...manifest, installedAt: undefined }
  );
  assert.equal(Number.isNaN(Date.parse(installed.installedAt)), false);
  assert.equal(
    await fs.promises.readFile(path.join(dataToolsDir, 'vse-cli', 'vse-cli.exe'), 'utf8'),
    'new executable'
  );
  assert.deepEqual(manager.getOcrDownloadProgress(), {
    status: 'ready',
    percent: 100,
    downloadedBytes: archive.archiveSize,
    totalBytes: archive.archiveSize,
    step: 'ready',
    error: null
  });
  assertNoScratchArtifacts(dataToolsDir);
});

test('injected swap failure restores the old install', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  let swapFailed = false;
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath),
    rename: async (source, destination) => {
      if (!swapFailed && source.includes('.staging-') && destination === componentDir) {
        swapFailed = true;
        throw new Error('injected swap failure');
      }
      await fs.promises.rename(source, destination);
    }
  });

  await assert.rejects(manager.downloadOcrComponent(), /injected swap failure/i);
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
  assert.equal(
    JSON.parse(await fs.promises.readFile(
      path.join(componentDir, 'installed.json'),
      'utf8'
    )).version,
    oldManifest.version
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('metadata write failure after staged-to-final rename restores the old install', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const metadataError = new Error('injected metadata write failure');
  let stagedMovedToFinal = false;
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath),
    rename: async (source, destination) => {
      if (source.includes('.staging-') && destination === componentDir) {
        stagedMovedToFinal = true;
      }
      await fs.promises.rename(source, destination);
    },
    writeFile: async () => {
      throw metadataError;
    }
  });

  await assert.rejects(manager.downloadOcrComponent(), (error) => {
    assert.strictEqual(error, metadataError);
    return true;
  });
  assert.equal(stagedMovedToFinal, true);
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
  assert.equal(
    JSON.parse(await fs.promises.readFile(path.join(componentDir, 'installed.json'), 'utf8')).version,
    oldManifest.version
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('failed incomplete-final removal is exposed while rollback restores the old install', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const metadataError = new Error('injected metadata write failure');
  const removalError = new Error('injected incomplete-final removal failure');
  let failedFinalRemoval = false;
  let backupRestored = false;
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath),
    writeFile: async () => {
      throw metadataError;
    },
    remove: async (targetPath) => {
      if (!failedFinalRemoval && targetPath === componentDir) {
        failedFinalRemoval = true;
        throw removalError;
      }
      await fs.promises.rm(targetPath, { recursive: true, force: true });
    },
    rename: async (source, destination) => {
      if (path.basename(source).startsWith('.backup-') && destination === componentDir) {
        backupRestored = true;
      }
      await fs.promises.rename(source, destination);
    }
  });

  await assert.rejects(manager.downloadOcrComponent(), (error) => {
    assert.strictEqual(error, metadataError);
    assert.equal(error.rollbackErrors.length, 1);
    assert.equal(error.rollbackErrors[0].operation, 'remove-incomplete-final');
    assert.strictEqual(error.rollbackErrors[0].cause, removalError);
    return true;
  });
  assert.equal(failedFinalRemoval, true);
  assert.equal(backupRestored, true);
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('cancellation after metadata write rolls back instead of finishing ready', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  let cancelPromise = null;
  let manager;
  manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath),
    writeFile: async (...args) => {
      await fs.promises.writeFile(...args);
      cancelPromise = manager.cancelOcrComponentDownload();
    }
  });

  const rejectedDownload = assert.rejects(manager.downloadOcrComponent(), /cancelled/i);
  await rejectedDownload;
  await cancelPromise;

  assert.equal(manager.getOcrComponentStatus().status, 'cancelled');
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('cancellation with failed backup restore exposes rollback error and reports error state', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const restoreError = new Error('injected backup restore failure during cancellation');
  let restoreAttempted = false;
  let cancelPromise = null;
  let manager;
  manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath),
    writeFile: async (...args) => {
      await fs.promises.writeFile(...args);
      cancelPromise = manager.cancelOcrComponentDownload();
    },
    rename: async (source, destination) => {
      if (path.basename(source).startsWith('.backup-') && destination === componentDir) {
        restoreAttempted = true;
        throw restoreError;
      }
      await fs.promises.rename(source, destination);
    }
  });

  let downloadError = null;
  const rejectedDownload = assert.rejects(manager.downloadOcrComponent(), (error) => {
    downloadError = error;
    assert.match(error.message, /cancelled/i);
    assert.equal(error.rollbackErrors.length, 1);
    assert.equal(error.rollbackErrors[0].operation, 'restore-backup');
    assert.strictEqual(error.rollbackErrors[0].cause, restoreError);
    return true;
  });
  await rejectedDownload;
  const cancelStatus = await cancelPromise;

  assert.equal(restoreAttempted, true);
  assert.equal(downloadError.name, 'AbortError');
  assert.equal(cancelStatus.status, 'error');
  assert.equal(manager.getOcrComponentStatus().status, 'error');
  assert.equal(manager.getOcrDownloadProgress().status, 'error');
  assert.equal(manager.getOcrDownloadProgress().step, 'error');
  assert.match(manager.getOcrDownloadProgress().error, /cancelled/i);
});

test('cancellation during final verification rolls back instead of finishing ready', async (t) => {
  const { root, dataToolsDir } = await createTempToolsDir(t);
  const archive = await createZip(root);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({
    version: '2.0.0',
    archiveSize: archive.archiveSize,
    installedSize: archive.installedSize,
    sha256: archive.sha256
  });
  const metadataPath = path.join(componentDir, 'installed.json');
  const readFileSync = fs.readFileSync;
  let stagedMovedToFinal = false;
  let cancellationTriggered = false;
  let cancelPromise = null;
  let manager;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const contents = readFileSync(...args);
    if (
      stagedMovedToFinal &&
      !cancellationTriggered &&
      path.resolve(args[0]) === path.resolve(metadataPath)
    ) {
      cancellationTriggered = true;
      cancelPromise = manager.cancelOcrComponentDownload();
    }
    return contents;
  });
  manager = createManager(dataToolsDir, manifest, {
    downloadFile: createCopyDownloader(archive.archivePath),
    rename: async (source, destination) => {
      if (source.includes('.staging-') && destination === componentDir) {
        stagedMovedToFinal = true;
      }
      await fs.promises.rename(source, destination);
    }
  });

  const rejectedDownload = assert.rejects(manager.downloadOcrComponent(), /cancelled/i);
  await rejectedDownload;
  await cancelPromise;

  assert.equal(cancellationTriggered, true);
  assert.equal(manager.getOcrComponentStatus().status, 'cancelled');
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('cancellation aborts, cleans scratch paths, and preserves the old install', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const oldManifest = createManifest({ version: '1.0.0' });
  const componentDir = await writeInstalledComponent(dataToolsDir, oldManifest, {
    'vse-cli.exe': 'old executable'
  });
  const manifest = createManifest({ version: '2.0.0' });
  let signalSeen = null;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const manager = createManager(dataToolsDir, manifest, {
    downloadFile: async ({ destination, signal, onProgress }) => {
      signalSeen = signal;
      await fs.promises.writeFile(destination, 'partial archive');
      onProgress(15, manifest.archiveSize);
      notifyStarted();
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });

  const downloadPromise = manager.downloadOcrComponent();
  const rejectedDownload = assert.rejects(downloadPromise, /cancelled/i);
  await started;
  const cancelledStatus = await manager.cancelOcrComponentDownload();
  await rejectedDownload;

  assert.equal(signalSeen.aborted, true);
  assert.deepEqual(cancelledStatus, {
    status: 'cancelled',
    version: oldManifest.version,
    supportedLanguages: oldManifest.supportedLanguages,
    error: null
  });
  assert.deepEqual(manager.getOcrDownloadProgress(), {
    status: 'cancelled',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: manifest.archiveSize,
    step: 'cancelled',
    error: null
  });
  assert.equal(
    await fs.promises.readFile(path.join(componentDir, 'vse-cli.exe'), 'utf8'),
    'old executable'
  );
  assertNoScratchArtifacts(dataToolsDir);
});

test('cancelling while idle is harmless', async (t) => {
  const { dataToolsDir } = await createTempToolsDir(t);
  const manifest = createManifest();
  await writeInstalledComponent(dataToolsDir, manifest);
  const manager = createManager(dataToolsDir, manifest);

  assert.deepEqual(
    await manager.cancelOcrComponentDownload(),
    manager.getOcrComponentStatus()
  );
  assert.equal(manager.getOcrComponentStatus().status, 'ready');
});
