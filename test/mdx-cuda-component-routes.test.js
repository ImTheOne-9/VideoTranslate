const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMdxCudaComponentHandlers,
  registerMdxCudaComponentRoutes
} = require('../controllers/systemController');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('MDX CUDA routes register status, download progress and cancellation endpoints', () => {
  const calls = [];
  const app = {
    get: (route) => calls.push(['GET', route]),
    post: (route) => calls.push(['POST', route])
  };
  const handlers = createMdxCudaComponentHandlers({
    refreshStatus() {},
    download() {},
    getDownloadProgress() {},
    cancelDownload() {}
  });

  registerMdxCudaComponentRoutes(app, handlers);
  assert.deepEqual(calls, [
    ['GET', '/api/mdx-cuda-component/status'],
    ['POST', '/api/mdx-cuda-component/download'],
    ['GET', '/api/mdx-cuda-component/download-status'],
    ['POST', '/api/mdx-cuda-component/cancel']
  ]);
});

test('MDX CUDA download responds 202 immediately and progress remains queryable', async () => {
  let resolveDownload;
  const downloadPromise = new Promise(resolve => { resolveDownload = resolve; });
  const manager = {
    refreshStatus: async () => ({ status: 'not_installed' }),
    download: () => downloadPromise,
    getDownloadProgress: () => ({ status: 'downloading', percent: 42 }),
    cancelDownload: async () => ({ status: 'cancelled' })
  };
  const handlers = createMdxCudaComponentHandlers(manager, { error() {} });

  const startResponse = responseRecorder();
  handlers.startMdxCudaComponentDownload({}, startResponse);
  assert.equal(startResponse.statusCode, 202);
  assert.equal(startResponse.body.success, true);

  const progressResponse = responseRecorder();
  handlers.getMdxCudaComponentDownloadStatus({}, progressResponse);
  assert.deepEqual(progressResponse.body, { status: 'downloading', percent: 42 });

  resolveDownload({ status: 'ready' });
  await downloadPromise;
});

test('MDX CUDA explicit cancellation delegates to the component manager', async () => {
  const manager = {
    refreshStatus: async () => ({ status: 'not_installed' }),
    download: async () => ({ status: 'ready' }),
    getDownloadProgress: () => ({ status: 'idle' }),
    cancelDownload: async () => ({ status: 'cancelled', version: null, error: null })
  };
  const handlers = createMdxCudaComponentHandlers(manager, { error() {} });
  const response = responseRecorder();

  await handlers.cancelMdxCudaComponentDownload({}, response);
  assert.deepEqual(response.body, {
    success: true,
    status: { status: 'cancelled', version: null, error: null }
  });
});
