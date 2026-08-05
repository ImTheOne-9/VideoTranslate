const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`Invalid argument near ${key || '<end>'}`);
    }
    const name = key.slice(2);
    result[name] = name === 'provider' ? value.toLowerCase() : path.resolve(value);
  }
  return result;
}

function sampleGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used',
      '--format=csv,noheader,nounits'
    ], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const [utilization, memoryMb] = String(stdout).trim().split(',').map(Number);
      resolve({
        timestamp: new Date().toISOString(),
        utilization: Number.isFinite(utilization) ? utilization : 0,
        memoryMb: Number.isFinite(memoryMb) ? memoryMb : 0
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const provider = options.provider || 'cuda';
  if (!['cpu', 'cuda'].includes(provider)) {
    throw new Error('--provider must be cpu or cuda');
  }
  for (const key of ['component-dir', 'model', 'input', 'vocals', 'accompaniment']) {
    if (!options[key]) throw new Error(`Missing --${key}`);
  }

  const executable = path.join(options['component-dir'], 'mdx-separator.exe');
  const args = [
    `--provider=${provider}`,
    '--num-threads=4',
    `--uvr-model=${options.model}`,
    `--input-wav=${options.input}`,
    `--output-vocals-wav=${options.vocals}`,
    `--output-accompaniment-wav=${options.accompaniment}`
  ];

  const samples = [];
  const baseline = await sampleGpu();
  if (baseline) samples.push(baseline);
  const startedAt = Date.now();
  const child = spawn(executable, args, {
    cwd: options['component-dir'],
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const sampler = setInterval(async () => {
    const sample = await sampleGpu();
    if (sample) samples.push(sample);
  }, 500);
  const timeout = setTimeout(() => child.kill(), 10 * 60 * 1000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearInterval(sampler);
  clearTimeout(timeout);

  const finalSample = await sampleGpu();
  if (finalSample) samples.push(finalSample);
  const combinedLog = `${stdout}\n${stderr}`;
  const outputFiles = {};
  for (const key of ['vocals', 'accompaniment']) {
    const filePath = options[key];
    outputFiles[key] = fs.existsSync(filePath)
      ? { path: filePath, size: fs.statSync(filePath).size }
      : null;
  }
  const baselineMemoryMb = baseline?.memoryMb || 0;
  const report = {
    provider,
    success: exitCode === 0 &&
      Boolean(outputFiles.vocals?.size) &&
      Boolean(outputFiles.accompaniment?.size) &&
      !/fallback to cpu|available providers:\s*CPUExecutionProvider/i.test(combinedLog),
    exitCode,
    durationMs: Date.now() - startedAt,
    cpuFallbackDetected: /fallback to cpu|available providers:\s*CPUExecutionProvider/i.test(combinedLog),
    maxGpuUtilization: Math.max(0, ...samples.map(sample => sample.utilization)),
    maxGpuMemoryMb: Math.max(0, ...samples.map(sample => sample.memoryMb)),
    gpuMemoryDeltaMb: Math.max(0, ...samples.map(sample => sample.memoryMb - baselineMemoryMb)),
    outputFiles,
    stdout,
    stderr
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
