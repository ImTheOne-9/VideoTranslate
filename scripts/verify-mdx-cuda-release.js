const fs = require('node:fs');
const path = require('node:path');
const { createMdxCudaComponentManager } = require('../lib/mdx-cuda-component-manager');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`Invalid argument near ${key || '<end>'}`);
    }
    result[key.slice(2)] = path.resolve(value);
  }
  return result;
}

async function copyArchive(source, destination, onProgress, signal) {
  const totalBytes = fs.statSync(source).size;
  let downloadedBytes = 0;
  const input = fs.createReadStream(source);
  const output = fs.createWriteStream(destination, { flags: 'wx' });
  signal?.addEventListener('abort', () => input.destroy(signal.reason), { once: true });
  input.on('data', (chunk) => {
    downloadedBytes += chunk.length;
    onProgress?.(downloadedBytes, totalBytes);
  });
  await new Promise((resolve, reject) => {
    input.once('error', reject);
    output.once('error', reject);
    output.once('finish', resolve);
    input.pipe(output);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const key of ['archive', 'manifest', 'install-dir']) {
    if (!options[key]) throw new Error(`Missing --${key}`);
  }
  const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8'));
  const manager = createMdxCudaComponentManager({
    dataToolsDir: options['install-dir'],
    fetchManifest: async () => manifest,
    downloadFile: async ({ destination, onProgress, signal }) => (
      copyArchive(options.archive, destination, onProgress, signal)
    )
  });

  const status = await manager.download();
  const executablePath = manager.getExecutablePath();
  const result = {
    status,
    progress: manager.getDownloadProgress(),
    executablePath,
    executableSize: executablePath ? fs.statSync(executablePath).size : 0
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (status.status !== 'ready' || !executablePath) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
