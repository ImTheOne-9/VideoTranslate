const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const systemController = require('../controllers/systemController');
const { createOcrComponentHandlers } = systemController;

function createResponse() {
  return {
    statusCode: 200,
    jsonCalls: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonCalls.push(payload);
      return this;
    }
  };
}

function createLogger() {
  return {
    errors: [],
    error(...args) {
      this.errors.push(args);
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('status awaits refresh and returns the manager status object', async () => {
  const status = {
    status: 'ready',
    version: '1.2.3',
    supportedLanguages: ['vi', 'en'],
    error: null
  };
  let refreshed = false;
  const handlers = createOcrComponentHandlers({
    refreshOcrComponentStatus: async () => {
      await Promise.resolve();
      refreshed = true;
      return status;
    }
  });
  const response = createResponse();

  await handlers.getOcrComponentStatus({}, response);

  assert.equal(refreshed, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.jsonCalls, [status]);
});

test('status refresh failures return 500 and log the detailed error', async () => {
  const error = new Error('manifest unavailable');
  const logger = createLogger();
  const handlers = createOcrComponentHandlers({
    refreshOcrComponentStatus: async () => {
      throw error;
    }
  }, logger);
  const response = createResponse();

  await handlers.getOcrComponentStatus({}, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.jsonCalls, [{ error: error.message }]);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].includes(error), true);
});

test('download responds with 202 before the manager promise settles', () => {
  const download = createDeferred();
  const handlers = createOcrComponentHandlers({
    downloadOcrComponent: () => download.promise
  });
  const response = createResponse();

  handlers.startOcrComponentDownload({}, response);

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.jsonCalls, [{
    success: true,
    message: 'Bắt đầu tải OCR'
  }]);
  download.resolve();
});

test('download rejection is logged without another response or an unhandled rejection', async () => {
  const download = createDeferred();
  const rejection = new Error('download failed');
  const logger = createLogger();
  const handlers = createOcrComponentHandlers({
    downloadOcrComponent: () => download.promise
  }, logger);
  const response = createResponse();
  let unhandledReason = null;
  const onUnhandledRejection = (reason) => {
    unhandledReason = reason;
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    handlers.startOcrComponentDownload({}, response);
    download.reject(rejection);
    await waitForEventLoop();
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }

  assert.equal(unhandledReason, null);
  assert.equal(response.statusCode, 202);
  assert.equal(response.jsonCalls.length, 1);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].includes(rejection), true);
});

test('repeated download requests invoke the manager safely and both return 202', () => {
  let calls = 0;
  const handlers = createOcrComponentHandlers({
    downloadOcrComponent: () => {
      calls += 1;
      return Promise.resolve();
    }
  });
  const firstResponse = createResponse();
  const secondResponse = createResponse();

  handlers.startOcrComponentDownload({}, firstResponse);
  handlers.startOcrComponentDownload({}, secondResponse);

  assert.equal(calls, 2);
  assert.equal(firstResponse.statusCode, 202);
  assert.equal(secondResponse.statusCode, 202);
  assert.equal(firstResponse.jsonCalls.length, 1);
  assert.equal(secondResponse.jsonCalls.length, 1);
});

test('download status returns manager progress unchanged', () => {
  const progress = {
    status: 'downloading',
    percent: 37,
    downloadedBytes: 37,
    totalBytes: 100,
    step: 'downloading',
    error: null
  };
  const handlers = createOcrComponentHandlers({
    getOcrDownloadProgress: () => progress
  });
  const response = createResponse();

  handlers.getOcrComponentDownloadStatus({}, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.jsonCalls, [progress]);
});

test('cancel awaits cleanup and returns the final manager status', async () => {
  const cancellation = createDeferred();
  const finalStatus = {
    status: 'cancelled',
    version: '1.2.3',
    supportedLanguages: ['vi', 'en'],
    error: null
  };
  const handlers = createOcrComponentHandlers({
    cancelOcrComponentDownload: () => cancellation.promise
  });
  const response = createResponse();
  const handlerPromise = handlers.cancelOcrComponentDownload({}, response);

  assert.equal(response.jsonCalls.length, 0);
  cancellation.resolve(finalStatus);
  await handlerPromise;

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.jsonCalls, [{ success: true, status: finalStatus }]);
});

test('cancel failures return 500', async () => {
  const error = new Error('cleanup failed');
  const logger = createLogger();
  const handlers = createOcrComponentHandlers({
    cancelOcrComponentDownload: async () => {
      throw error;
    }
  }, logger);
  const response = createResponse();

  await handlers.cancelOcrComponentDownload({}, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.jsonCalls, [{ error: error.message }]);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].includes(error), true);
});

test('download start failures thrown synchronously return 500', () => {
  const error = new Error('manager unavailable');
  const logger = createLogger();
  const handlers = createOcrComponentHandlers({
    downloadOcrComponent: () => {
      throw error;
    }
  }, logger);
  const response = createResponse();

  handlers.startOcrComponentDownload({}, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.jsonCalls, [{ error: error.message }]);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].includes(error), true);
});

test('systemController exports callable singleton-backed OCR handlers', () => {
  for (const handlerName of [
    'getOcrComponentStatus',
    'startOcrComponentDownload',
    'getOcrComponentDownloadStatus',
    'cancelOcrComponentDownload'
  ]) {
    assert.equal(typeof systemController[handlerName], 'function', handlerName);
  }
});

test('registerOcrComponentRoutes registers exact OCR method, path, and handler pairs', () => {
  const routes = [];
  const app = {
    get(routePath, handler) {
      routes.push({ method: 'GET', path: routePath, handler });
    },
    post(routePath, handler) {
      routes.push({ method: 'POST', path: routePath, handler });
    }
  };

  systemController.registerOcrComponentRoutes(app, systemController);

  assert.deepEqual(
    routes.map(({ method, path: routePath }) => [method, routePath]),
    [
      ['GET', '/api/ocr-component/status'],
      ['POST', '/api/ocr-component/download'],
      ['GET', '/api/ocr-component/download-status'],
      ['POST', '/api/ocr-component/cancel']
    ]
  );
  assert.strictEqual(routes[0].handler, systemController.getOcrComponentStatus);
  assert.strictEqual(routes[1].handler, systemController.startOcrComponentDownload);
  assert.strictEqual(routes[2].handler, systemController.getOcrComponentDownloadStatus);
  assert.strictEqual(routes[3].handler, systemController.cancelOcrComponentDownload);
});

test('server retains executable dependency and Whisper route registrations', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const executableRoutes = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^app\.(?:get|post)\('/.test(line));

  assert.equal(executableRoutes.includes(
    "app.get('/api/check-dependencies', systemController.checkDependencies);"
  ), true);
  assert.equal(executableRoutes.includes(
    "app.post('/api/download-dependency', systemController.downloadDependency);"
  ), true);
  assert.equal(executableRoutes.includes(
    "app.get('/api/whisper-model/status', systemController.getWhisperModelStatus);"
  ), true);
  assert.equal(executableRoutes.includes(
    "app.post('/api/download-whisper-model', systemController.downloadWhisperModel);"
  ), true);
});

test('OCR download progress is exempt from the global API rate limiter', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /RATE_LIMIT_EXEMPT_PATHS[\s\S]*\/api\/ocr-component\/download-status/);
  assert.match(source, /RATE_LIMIT_EXEMPT_PATHS\.has\(req\.path\)/);
});
