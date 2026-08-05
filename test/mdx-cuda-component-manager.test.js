const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const {
  createMdxCudaComponentManager
} = require('../lib/mdx-cuda-component-manager');

async function fixture(t, files = {
  'mdx-onnx/cuda/mdx-separator.exe': 'cuda executable',
  'mdx-onnx/cuda/onnxruntime.dll': 'onnx runtime',
  'mdx-onnx/cuda/onnxruntime_providers_cuda.dll': 'cuda provider',
  'mdx-onnx/cuda/cudnn64_9.dll': 'cudnn'
}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mdx-cuda-component-'));
  const dataToolsDir = path.join(root, 'tools');
  await fs.promises.mkdir(dataToolsDir, { recursive: true });
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const zip = new AdmZip();
  for (const [name, contents] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(contents));
  }
  const archive = zip.toBuffer();
  const archivePath = path.join(root, 'mdx-cuda.zip');
  await fs.promises.writeFile(archivePath, archive);

  const manifest = {
    version: '1.0.0',
    archiveUrl: 'https://example.test/mdx-cuda.zip',
    archiveSize: archive.length,
    installedSize: Object.values(files).reduce(
      (sum, contents) => sum + Buffer.byteLength(contents),
      0
    ),
    sha256: crypto.createHash('sha256').update(archive).digest('hex'),
    componentRoot: 'mdx-onnx/cuda',
    executable: 'mdx-separator.exe',
    requiredFiles: [
      'onnxruntime.dll',
      'onnxruntime_providers_cuda.dll',
      'cudnn64_9.dll'
    ],
    supportedLanguages: [],
    runtime: {
      provider: 'cuda',
      cudaMajor: 12,
      cudnnMajor: 9
    }
  };

  return { root, dataToolsDir, archive, archivePath, manifest };
}

function createManager(dataToolsDir, archivePath, manifest, overrides = {}) {
  return createMdxCudaComponentManager({
    dataToolsDir,
    fetchManifest: async () => manifest,
    downloadFile: async ({ destination, onProgress }) => {
      const archive = await fs.promises.readFile(archivePath);
      await fs.promises.writeFile(destination, archive);
      onProgress?.(archive.length, archive.length);
    },
    getFreeSpace: async () => Number.MAX_SAFE_INTEGER,
    ...overrides
  });
}

test('MDX CUDA install verifies manifest and exposes only a verified executable', async (t) => {
  const data = await fixture(t);
  const manager = createManager(
    data.dataToolsDir,
    data.archivePath,
    data.manifest
  );

  assert.equal(manager.getStatus().status, 'not_installed');
  assert.equal(manager.getExecutablePath(), null);

  const status = await manager.download();
  assert.deepEqual(status, { status: 'ready', version: '1.0.0', error: null });
  assert.equal(
    manager.getExecutablePath(),
    path.join(data.dataToolsDir, 'mdx-onnx', 'cuda', 'mdx-separator.exe')
  );
  assert.equal(manager.getDownloadProgress().percent, 100);
});

test('MDX CUDA manifest rejects CPU provider and unsupported CUDA/cuDNN generations', async (t) => {
  const data = await fixture(t);
  const invalidRuntimeValues = [
    { provider: 'cpu', cudaMajor: 12, cudnnMajor: 9 },
    { provider: 'cuda', cudaMajor: 11, cudnnMajor: 9 },
    { provider: 'cuda', cudaMajor: 12, cudnnMajor: 8 }
  ];

  for (const runtime of invalidRuntimeValues) {
    let downloadCalls = 0;
    const manager = createManager(
      data.dataToolsDir,
      data.archivePath,
      { ...data.manifest, runtime },
      {
        downloadFile: async () => {
          downloadCalls += 1;
        }
      }
    );
    await assert.rejects(manager.download(), /invalid OCR component manifest/i);
    assert.equal(downloadCalls, 0);
  }
});

test('MDX CUDA checksum mismatch preserves not_installed state and cleans scratch data', async (t) => {
  const data = await fixture(t);
  const manager = createManager(
    data.dataToolsDir,
    data.archivePath,
    { ...data.manifest, sha256: '0'.repeat(64) }
  );

  await assert.rejects(manager.download(), /SHA-256 mismatch/);
  assert.equal(manager.getStatus().status, 'error');
  assert.equal(manager.getExecutablePath(), null);
  assert.deepEqual(
    fs.readdirSync(data.dataToolsDir).filter(name => (
      name.endsWith('.partial') ||
      name.startsWith('.staging-') ||
      name.startsWith('.backup-')
    )),
    []
  );
});

test('MDX CUDA install rejects an archive missing a declared provider DLL', async (t) => {
  const data = await fixture(t, {
    'mdx-onnx/cuda/mdx-separator.exe': 'cuda executable',
    'mdx-onnx/cuda/onnxruntime.dll': 'onnx runtime'
  });
  const manifest = {
    ...data.manifest,
    requiredFiles: ['onnxruntime.dll', 'onnxruntime_providers_cuda.dll']
  };
  const manager = createManager(data.dataToolsDir, data.archivePath, manifest);

  await assert.rejects(manager.download(), /missing required file/i);
  assert.equal(manager.getExecutablePath(), null);
});

test('offline refresh preserves an already verified MDX CUDA installation', async (t) => {
  const data = await fixture(t);
  const manager = createManager(data.dataToolsDir, data.archivePath, data.manifest);
  await manager.download();

  const offlineManager = createMdxCudaComponentManager({
    dataToolsDir: data.dataToolsDir,
    fetchManifest: async () => {
      throw new Error('offline');
    }
  });
  assert.deepEqual(
    await offlineManager.refreshStatus(),
    { status: 'ready', version: '1.0.0', error: null }
  );
});
