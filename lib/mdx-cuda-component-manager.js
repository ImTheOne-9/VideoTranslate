const path = require('node:path');
const shared = require('./shared-state');
const { createOcrComponentManager } = require('./ocr-component-manager');

const MDX_CUDA_COMPONENT_MANIFEST_URL =
  process.env.MDX_CUDA_COMPONENT_MANIFEST_URL ||
  'https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/mdx-onnx-cuda/manifest.json';

const COMPONENT_ROOT = 'mdx-onnx/cuda';
const EXECUTABLE_NAME = 'mdx-separator.exe';

function validateRuntime(value) {
  const runtime = value.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error('runtime must be an object');
  }
  if (runtime.provider !== 'cuda') {
    throw new Error('runtime.provider must be cuda');
  }
  if (!Number.isSafeInteger(runtime.cudaMajor) || runtime.cudaMajor < 12) {
    throw new Error('runtime.cudaMajor must be an integer >= 12');
  }
  if (!Number.isSafeInteger(runtime.cudnnMajor) || runtime.cudnnMajor < 9) {
    throw new Error('runtime.cudnnMajor must be an integer >= 9');
  }
  return {
    runtime: {
      provider: 'cuda',
      cudaMajor: runtime.cudaMajor,
      cudnnMajor: runtime.cudnnMajor
    }
  };
}

function createMdxCudaComponentManager(options = {}) {
  const manager = createOcrComponentManager({
    ...options,
    dataToolsDir: options.dataToolsDir || shared.DATA_TOOLS_DIR,
    manifestUrl: options.manifestUrl || MDX_CUDA_COMPONENT_MANIFEST_URL,
    componentRoot: COMPONENT_ROOT,
    executableName: EXECUTABLE_NAME,
    requiredSupportedLanguages: [],
    validateManifestExtension: validateRuntime
  });

  function toStatus(status) {
    return {
      status: status.status,
      version: status.version,
      error: status.error
    };
  }

  return {
    getStatus: () => toStatus(manager.getOcrComponentStatus()),
    refreshStatus: async () => toStatus(await manager.refreshOcrComponentStatus()),
    getExecutablePath: () => manager.getOcrExecutablePath(),
    getDownloadProgress: () => manager.getOcrDownloadProgress(),
    download: async () => toStatus(await manager.downloadOcrComponent()),
    cancelDownload: async () => toStatus(await manager.cancelOcrComponentDownload())
  };
}

const defaultManager = createMdxCudaComponentManager();

module.exports = {
  MDX_CUDA_COMPONENT_MANIFEST_URL,
  MDX_CUDA_COMPONENT_PATH: path.join(shared.DATA_TOOLS_DIR, ...COMPONENT_ROOT.split('/')),
  createMdxCudaComponentManager,
  getStatus: defaultManager.getStatus,
  refreshStatus: defaultManager.refreshStatus,
  getExecutablePath: defaultManager.getExecutablePath,
  getDownloadProgress: defaultManager.getDownloadProgress,
  download: defaultManager.download,
  cancelDownload: defaultManager.cancelDownload
};
