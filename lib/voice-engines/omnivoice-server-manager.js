'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const SERVER_START_TIMEOUT_MS = 120000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeServerDevice(device) {
  const value = String(device || 'cpu').toLowerCase();
  if (value === 'cpu') return 'cpu';
  if (/^cuda(?::\d+)?$/.test(value)) return value;
  if (/^vulkan(?::\d+)?$/.test(value)) return value;
  return 'cpu';
}

function deviceKind(device) {
  return normalizeServerDevice(device).split(':')[0];
}

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function httpRequest(options = {}) {
  const {
    host = '127.0.0.1',
    port,
    method = 'GET',
    pathname = '/health',
    body = null,
    timeoutMs = REQUEST_TIMEOUT_MS
  } = options;
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request({
      host,
      port,
      path: pathname,
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': payload.length
      } : undefined
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const data = Buffer.concat(chunks);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ statusCode: response.statusCode, headers: response.headers, data });
          return;
        }
        const error = new Error(
          `OmniVoice server HTTP ${response.statusCode}: ${data.toString('utf8').slice(0, 1000)}`
        );
        error.statusCode = response.statusCode;
        reject(error);
      });
    });
    const timer = setTimeout(() => {
      request.destroy(new Error('OmniVoice server request timed out'));
    }, timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
    options.onRequest?.(request);
  });
}

class OmniVoiceServerManager {
  constructor(options = {}) {
    this.serverPaths = options.serverPaths || {};
    this.existsSync = options.existsSync || fs.existsSync;
    this.spawn = options.spawn;
    this.registerProcess = options.registerProcess || null;
    this.killProcess = options.killProcess || ((processHandle) => processHandle?.kill('SIGTERM'));
    this.request = options.request || httpRequest;
    this.getFreePort = options.getFreePort || findFreePort;
    this.logger = options.logger || console;
    this.session = null;
    this.activeRequest = null;
  }

  getServerPath(device) {
    return this.serverPaths[deviceKind(device)] || null;
  }

  isAvailable(device) {
    const serverPath = this.getServerPath(device);
    return Boolean(serverPath && this.existsSync(serverPath) && typeof this.spawn === 'function');
  }

  async waitUntilReady(session) {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      if (session.exited) {
        throw new Error(
          `OmniVoice server stopped before ready${session.stderr ? `: ${session.stderr}` : ''}`
        );
      }
      try {
        await this.request({
          port: session.port,
          pathname: '/health',
          timeoutMs: 1500
        });
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`OmniVoice server startup timed out: ${lastError?.message || 'not ready'}`);
  }

  async ensureSession(options = {}) {
    const device = normalizeServerDevice(options.device);
    if (!options.modelPath) throw new Error('Thiếu đường dẫn model OmniVoice');
    const modelPath = path.resolve(String(options.modelPath));
    const serverPath = this.getServerPath(device);
    if (!serverPath || !this.existsSync(serverPath)) {
      throw new Error(`OmniVoice server chưa sẵn sàng cho ${device}`);
    }
    if (typeof this.spawn !== 'function') {
      throw new Error('OmniVoice server runner is unavailable');
    }
    const key = `${serverPath}\n${modelPath}\n${device}`;
    if (this.session?.key === key && !this.session.exited) {
      await this.session.readyPromise;
      return this.session;
    }

    await this.stop();
    const port = await this.getFreePort();
    const args = [
      '--model', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--device', device
    ];
    const processHandle = this.spawn(serverPath, args, {
      cwd: path.dirname(serverPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.registerProcess?.(processHandle);
    const session = {
      key,
      device,
      modelPath,
      serverPath,
      port,
      process: processHandle,
      exited: false,
      stderr: ''
    };
    processHandle.stderr?.on('data', (data) => {
      const line = data.toString('utf8');
      session.stderr = (session.stderr + line).slice(-8192);
      if (line.includes('[cache] reference_prompt=hit')) {
        this.logger.log('[OmniVoice] Dùng lại voice prompt đã mã hóa.');
      }
    });
    processHandle.once?.('error', (error) => {
      session.exited = true;
      session.stderr = (session.stderr + error.message).slice(-8192);
    });
    processHandle.once?.('exit', () => {
      session.exited = true;
      if (this.session === session) this.session = null;
    });
    session.readyPromise = this.waitUntilReady(session).catch(async (error) => {
      if (this.session === session) this.session = null;
      try { this.killProcess(processHandle); } catch {}
      throw error;
    });
    this.session = session;
    await session.readyPromise;
    return session;
  }

  async synthesize(options = {}) {
    if (!options.outputPath) throw new Error('Thiếu file audio đầu ra');
    const outputPath = path.resolve(String(options.outputPath));
    const session = await this.ensureSession(options);
    const tempPath = `${outputPath}.server.tmp.wav`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    try {
      fs.rmSync(tempPath, { force: true });
      const response = await this.request({
        port: session.port,
        method: 'POST',
        pathname: '/v1/audio/speech',
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: {
          model: 'omnivoice',
          input: options.text,
          response_format: 'wav',
          language: options.language,
          ref_audio: options.referenceAudioPath || undefined,
          ref_text: options.referenceText || undefined,
          instruct: options.instruct || undefined,
          duration: Number.isFinite(Number(options.duration)) ? Number(options.duration) : undefined,
          num_step: Number(options.steps) || 16,
          seed: Number.isFinite(Number(options.seed)) ? Number(options.seed) : undefined,
          position_temperature: Number(options.positionTemperature) || 1
        },
        onRequest: (request) => {
          this.activeRequest = request;
          options.onProcess?.(request);
        }
      });
      fs.writeFileSync(tempPath, response.data);
      fs.copyFileSync(tempPath, outputPath);
      return {
        device: session.device,
        fallback: session.device !== normalizeServerDevice(options.device),
        persistentRuntime: true,
        referencePromptCache: true
      };
    } finally {
      this.activeRequest = null;
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    }
  }

  async stop() {
    if (this.activeRequest?.destroy) {
      try { this.activeRequest.destroy(new Error('Đã hủy bởi người dùng')); } catch {}
    }
    this.activeRequest = null;
    const session = this.session;
    this.session = null;
    if (session?.process) {
      try { this.killProcess(session.process); } catch {}
    }
    return Boolean(session);
  }
}

module.exports = {
  OmniVoiceServerManager,
  deviceKind,
  findFreePort,
  httpRequest,
  normalizeServerDevice
};
