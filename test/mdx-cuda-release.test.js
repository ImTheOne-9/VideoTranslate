const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release', 'mdx-onnx-cuda');
const manifest = JSON.parse(
  fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8')
);

test('MDX CUDA release manifest contains verified immutable artifact metadata', () => {
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.componentRoot, 'mdx-onnx/cuda');
  assert.equal(manifest.executable, 'mdx-separator.exe');
  assert.equal(manifest.archiveSize, 1661604711);
  assert.equal(manifest.installedSize, 2471900125);
  assert.equal(
    manifest.sha256,
    '2064322ccc2e838d7b9e5054b0a7d010d903b463bec883b5042d757aeef41488'
  );
  assert.deepEqual(manifest.runtime, {
    provider: 'cuda',
    cudaMajor: 12,
    cudnnMajor: 9
  });
});

test('MDX CUDA release declares executable provider libraries and license files', () => {
  const required = new Set(manifest.requiredFiles);
  for (const file of [
    'onnxruntime.dll',
    'onnxruntime_providers_shared.dll',
    'onnxruntime_providers_cuda.dll',
    'cudart64_12.dll',
    'cublas64_12.dll',
    'cublasLt64_12.dll',
    'cufft64_11.dll',
    'cudnn64_9.dll',
    'licenses/NVIDIA-CUDA-Runtime-License.txt',
    'licenses/NVIDIA-cuBLAS-License.txt',
    'licenses/NVIDIA-cuFFT-License.txt',
    'licenses/NVIDIA-cuDNN-License.txt',
    'licenses/onnxruntime-LICENSE',
    'licenses/sherpa-onnx-LICENSE',
    'THIRD-PARTY-SOURCES.json'
  ]) {
    assert.equal(required.has(file), true, file);
  }
});

test('local MDX CUDA release archive matches manifest size when present', () => {
  const archivePath = path.join(releaseDir, 'mdx-onnx-cuda-1.0.0.zip');
  if (!fs.existsSync(archivePath)) return;
  assert.equal(fs.statSync(archivePath).size, manifest.archiveSize);
});

test('release scripts keep probe and manifest generation reproducible', () => {
  const probe = fs.readFileSync(path.join(root, 'scripts', 'probe-mdx-cuda.js'), 'utf8');
  const generator = fs.readFileSync(
    path.join(root, 'scripts', 'create-mdx-cuda-manifest.js'),
    'utf8'
  );
  const verifier = fs.readFileSync(
    path.join(root, 'scripts', 'verify-mdx-cuda-release.js'),
    'utf8'
  );

  assert.match(probe, /cpuFallbackDetected/);
  assert.match(probe, /maxGpuUtilization/);
  assert.match(generator, /createHash\('sha256'\)/);
  assert.match(generator, /componentRoot: 'mdx-onnx\/cuda'/);
  assert.match(verifier, /createMdxCudaComponentManager/);
});
