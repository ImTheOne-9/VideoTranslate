const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`Invalid argument near ${key || '<end>'}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function listFiles(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) return listFiles(root, fullPath);
    if (!entry.isFile()) throw new Error(`Unsupported component entry: ${fullPath}`);
    return [{
      path: path.relative(root, fullPath).replaceAll(path.sep, '/'),
      size: fs.statSync(fullPath).size
    }];
  });
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const key of ['component-dir', 'archive', 'archive-url', 'version', 'output']) {
    if (!options[key]) throw new Error(`Missing --${key}`);
  }

  const componentDir = path.resolve(options['component-dir']);
  const archivePath = path.resolve(options.archive);
  const outputPath = path.resolve(options.output);
  const executable = 'mdx-separator.exe';
  const files = listFiles(componentDir);
  if (!files.some((file) => file.path === executable && file.size > 0)) {
    throw new Error(`Missing ${executable}`);
  }
  const archiveStats = fs.statSync(archivePath);
  const installedSize = files.reduce((sum, file) => sum + file.size, 0);
  const manifest = {
    version: options.version,
    archiveUrl: new URL(options['archive-url']).href,
    archiveSize: archiveStats.size,
    installedSize,
    sha256: await sha256(archivePath),
    componentRoot: 'mdx-onnx/cuda',
    executable,
    requiredFiles: files
      .map((file) => file.path)
      .filter((file) => file !== executable)
      .sort(),
    supportedLanguages: [],
    runtime: {
      provider: 'cuda',
      cudaMajor: 12,
      cudnnMajor: 9
    }
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    outputPath,
    archiveSize: manifest.archiveSize,
    installedSize,
    sha256: manifest.sha256,
    requiredFileCount: manifest.requiredFiles.length
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
