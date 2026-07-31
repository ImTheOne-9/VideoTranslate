const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const unzipper = require('unzipper');
const shared = require('./shared-state');

const OCR_COMPONENT_MANIFEST_URL = 'https://huggingface.co/datasets/dvh1910/video-studio-tools/resolve/main/vse-cli/manifest.json';
const COMPONENT_ROOT = 'vse-cli';
const EXECUTABLE_NAME = 'vse-cli.exe';
const REQUIRED_LANGUAGES = ['ch', 'vi', 'en', 'japan', 'korean'];
const MAX_REDIRECTS = 5;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function manifestError(message) {
  return new Error(`Invalid OCR component manifest: ${message}`);
}

function isSafePathSegment(segment) {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !/[\u0000-\u001f<>:"|?*]/.test(segment) &&
    !/[. ]$/.test(segment) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i.test(segment)
  );
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return false;
  }

  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return false;
  }

  const segments = normalized.split('/');
  return segments.every(isSafePathSegment);
}

function validateManifest(value, profile = {}) {
  const componentRoot = profile.componentRoot || COMPONENT_ROOT;
  const executableName = profile.executableName || EXECUTABLE_NAME;
  const requiredLanguages = profile.requiredSupportedLanguages || REQUIRED_LANGUAGES;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw manifestError('expected an object');
  }
  if (typeof value.version !== 'string' || !SEMVER_PATTERN.test(value.version)) {
    throw manifestError('version must be semantic');
  }

  let archiveUrl;
  try {
    archiveUrl = new URL(value.archiveUrl);
  } catch {
    throw manifestError('archiveUrl must be a valid HTTPS URL');
  }
  if (archiveUrl.protocol !== 'https:' || !archiveUrl.hostname) {
    throw manifestError('archiveUrl must be a valid HTTPS URL');
  }

  for (const field of ['archiveSize', 'installedSize']) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) {
      throw manifestError(`${field} must be a positive integer`);
    }
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw manifestError('sha256 must be a lowercase 64-character SHA-256');
  }
  if (!isSafeRelativePath(value.componentRoot) || value.componentRoot !== componentRoot) {
    throw manifestError(`componentRoot must be exactly ${componentRoot}`);
  }
  if (!isSafeRelativePath(value.executable) || value.executable !== executableName) {
    throw manifestError(`executable must be exactly ${executableName}`);
  }
  if (
    !Array.isArray(value.requiredFiles) ||
    value.requiredFiles.length === 0 ||
    !value.requiredFiles.every(isSafeRelativePath)
  ) {
    throw manifestError('requiredFiles must be a non-empty array of safe relative paths');
  }
  if (
    !Array.isArray(value.supportedLanguages) ||
    (requiredLanguages.length > 0 && value.supportedLanguages.length === 0) ||
    !value.supportedLanguages.every((language) => (
      typeof language === 'string' && language.length > 0
    )) ||
    !requiredLanguages.every((language) => value.supportedLanguages.includes(language))
  ) {
    throw manifestError(`supportedLanguages must include ${requiredLanguages.join(', ')}`);
  }

  let extension = {};
  if (typeof profile.validateExtension === 'function') {
    try {
      extension = profile.validateExtension(value) || {};
    } catch (error) {
      throw manifestError(error.message);
    }
  }

  return {
    version: value.version,
    archiveUrl: archiveUrl.href,
    archiveSize: value.archiveSize,
    installedSize: value.installedSize,
    sha256: value.sha256,
    componentRoot: value.componentRoot,
    executable: value.executable,
    requiredFiles: [...value.requiredFiles],
    supportedLanguages: [...value.supportedLanguages],
    ...extension
  };
}

function resolveRelativeFile(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Unsafe component file path: ${relativePath}`);
  }
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, ...relativePath.replace(/\\/g, '/').split('/'));
  const relative = path.relative(rootPath, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Component file escapes root: ${relativePath}`);
  }
  return resolved;
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isRegularFileInside(root, filePath) {
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
    return isPathInside(fs.realpathSync(root), fs.realpathSync(filePath));
  } catch {
    return false;
  }
}

function isPhysicalDirectoryInside(root, directoryPath) {
  try {
    const stats = fs.lstatSync(directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return isPathInside(fs.realpathSync(root), fs.realpathSync(directoryPath));
  } catch {
    return false;
  }
}

function inspectInstallation(dataToolsDir, componentDir, profile) {
  try {
    if (!isPhysicalDirectoryInside(dataToolsDir, componentDir)) {
      return { valid: false, manifest: null };
    }
    const metadataPath = path.join(componentDir, 'installed.json');
    if (!isRegularFileInside(componentDir, metadataPath)) {
      return { valid: false, manifest: null };
    }

    const installed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const manifest = validateManifest(installed, profile);
    if (
      typeof installed.installedAt !== 'string' ||
      Number.isNaN(Date.parse(installed.installedAt))
    ) {
      return { valid: false, manifest: null };
    }

    const files = new Set([manifest.executable, ...manifest.requiredFiles]);
    for (const relativePath of files) {
      if (!isRegularFileInside(componentDir, resolveRelativeFile(componentDir, relativePath))) {
        return { valid: false, manifest: null };
      }
    }

    return {
      valid: true,
      manifest: { ...manifest, installedAt: installed.installedAt }
    };
  } catch {
    return { valid: false, manifest: null };
  }
}

function createAbortError() {
  const error = new Error('OCR component download cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createOperationFailure(operation, targetPath, cause) {
  const error = new Error(`${operation} failed for ${targetPath}: ${cause.message}`, { cause });
  error.operation = operation;
  error.path = targetPath;
  return error;
}

function attachFailureDetails(primaryError, property, failures) {
  if (failures.length === 0) return primaryError;
  const existing = Array.isArray(primaryError[property]) ? primaryError[property] : [];
  const details = [...existing, ...failures];
  try {
    Object.defineProperty(primaryError, property, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: details
    });
    return primaryError;
  } catch {
    const wrapped = new Error(primaryError.message, { cause: primaryError });
    wrapped.name = primaryError.name;
    wrapped[property] = details;
    return wrapped;
  }
}

async function captureOperationFailure(failures, operation, targetPath, callback) {
  try {
    await callback();
  } catch (error) {
    failures.push(createOperationFailure(operation, targetPath, error));
  }
}

function getHttpsResponse(url, signal, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error(`Invalid HTTPS URL: ${url}`));
      return;
    }
    if (parsedUrl.protocol !== 'https:') {
      reject(new Error(`Refusing non-HTTPS URL: ${url}`));
      return;
    }
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let settled = false;
    let request;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => request?.destroy(createAbortError());

    request = https.get(parsedUrl, {
      headers: { 'User-Agent': 'Video-Studio-Tools' }
    }, (response) => {
      cleanup();
      const statusCode = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        if (!response.headers.location) {
          rejectOnce(new Error(`HTTPS redirect from ${url} did not include a location`));
          return;
        }
        if (redirectsRemaining <= 0) {
          rejectOnce(new Error(`Too many HTTPS redirects while requesting ${url}`));
          return;
        }
        let redirectUrl;
        try {
          redirectUrl = new URL(response.headers.location, parsedUrl).href;
        } catch {
          rejectOnce(new Error(`Invalid HTTPS redirect from ${url}`));
          return;
        }
        settled = true;
        resolve(getHttpsResponse(redirectUrl, signal, redirectsRemaining - 1));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        rejectOnce(new Error(`HTTPS request failed with status ${statusCode}: ${url}`));
        return;
      }
      if (settled) return;
      settled = true;
      resolve(response);
    });
    request.once('error', rejectOnce);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readResponseBuffer(response, signal, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  const onAbort = () => response.destroy(createAbortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    for await (const chunk of response) {
      throwIfAborted(signal);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        response.destroy();
        throw new Error(`HTTPS response exceeded ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function defaultFetchManifest({ url, signal }) {
  const response = await getHttpsResponse(url, signal);
  const body = await readResponseBuffer(response, signal, MAX_MANIFEST_BYTES);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new Error(`Manifest response is not valid JSON: ${error.message}`);
  }
}

async function defaultDownloadFile({ url, destination, signal, onProgress }) {
  throwIfAborted(signal);
  const response = await getHttpsResponse(url, signal);
  if (signal?.aborted) {
    response.destroy();
    throw createAbortError();
  }
  const contentLength = Number.parseInt(response.headers['content-length'], 10);
  const totalBytes = Number.isSafeInteger(contentLength) && contentLength > 0
    ? contentLength
    : 0;
  let downloadedBytes = 0;
  const progressStream = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      onProgress?.(downloadedBytes, totalBytes);
      callback(null, chunk);
    }
  });
  const output = fs.createWriteStream(destination, { flags: 'wx' });
  const pipelineOptions = signal ? { signal } : {};
  await pipeline(response, progressStream, output, pipelineOptions);
}

async function defaultGetFreeSpace({ path: targetPath }) {
  const statistics = await fs.promises.statfs(targetPath, { bigint: true });
  return statistics.bavail * statistics.bsize;
}

async function pathExists(targetPath) {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function directorySize(targetPath) {
  let stats;
  try {
    stats = await fs.promises.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  if (!stats.isDirectory()) return stats.size;

  let total = 0;
  const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else {
      total += (await fs.promises.lstat(entryPath)).size;
    }
  }
  return total;
}

async function sha256File(filePath, signal) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  const onAbort = () => stream.destroy(createAbortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function resolveZipDestination(stagingDir, entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.includes('\0')) {
    throw new Error('ZIP entry escapes staging: invalid filename');
  }
  const normalized = entryName.replace(/\\/g, '/');
  const relativeName = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (!isSafeRelativePath(relativeName)) {
    throw new Error(`ZIP entry escapes staging: ${entryName}`);
  }

  const stagingRoot = path.resolve(stagingDir);
  const destination = path.resolve(stagingRoot, ...normalized.split('/'));
  const relative = path.relative(stagingRoot, destination);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`ZIP entry escapes staging: ${entryName}`);
  }
  return destination;
}

async function extractZipSafely(archivePath, stagingDir, installedSize, signal) {
  throwIfAborted(signal);
  const zip = await unzipper.Open.file(archivePath);
  let declaredExtractedBytes = 0;
  const entries = zip.files.map((entry) => {
    const rawName = entry.path;
    const isDirectory = entry.type === 'Directory';
    if (!isDirectory) {
      const entrySize = entry.uncompressedSize;
      if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
        throw new Error(`Invalid uncompressed ZIP entry size: ${rawName}`);
      }
      if (entrySize > installedSize - declaredExtractedBytes) {
        throw new Error(`ZIP payload exceeds installedSize of ${installedSize} bytes`);
      }
      declaredExtractedBytes += entrySize;
    }
    return {
      entry,
      isDirectory,
      destination: resolveZipDestination(stagingDir, rawName)
    };
  });

  await fs.promises.mkdir(stagingDir, { recursive: true });
  let extractedBytes = 0;
  for (const { entry, isDirectory, destination } of entries) {
    throwIfAborted(signal);
    if (isDirectory) {
      await fs.promises.mkdir(destination, { recursive: true });
      continue;
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    let entryBytes = 0;
    const sizeGuard = new Transform({
      transform(chunk, encoding, callback) {
        if (chunk.length > installedSize - extractedBytes) {
          callback(new Error(`ZIP payload exceeds installedSize of ${installedSize} bytes`));
          return;
        }
        extractedBytes += chunk.length;
        entryBytes += chunk.length;
        callback(null, chunk);
      }
    });
    await pipeline(
      entry.stream(),
      sizeGuard,
      fs.createWriteStream(destination),
      { signal }
    );
    if (entryBytes !== entry.uncompressedSize) {
      throw new Error(`ZIP entry size mismatch after extraction: ${entry.path}`);
    }
  }
}

async function assertRequiredFiles(componentDir, manifest) {
  const realComponentDir = await fs.promises.realpath(componentDir);
  const files = new Set([manifest.executable, ...manifest.requiredFiles]);
  for (const relativePath of files) {
    const filePath = resolveRelativeFile(componentDir, relativePath);
    let stats;
    try {
      stats = await fs.promises.lstat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Missing required file after extraction: ${relativePath}`);
      }
      throw error;
    }
    if (!stats.isFile()) {
      throw new Error(`Missing required file after extraction: ${relativePath}`);
    }
    const realFilePath = await fs.promises.realpath(filePath);
    if (!isPathInside(realComponentDir, realFilePath)) {
      throw new Error(`Required file escapes component after extraction: ${relativePath}`);
    }
  }
}

function isEnoughFreeSpace(availableBytes, requiredBytes) {
  if (typeof availableBytes === 'bigint') {
    return availableBytes >= BigInt(requiredBytes);
  }
  return Number.isFinite(availableBytes) && availableBytes >= requiredBytes;
}

function formatBytes(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function createOcrComponentManager(options = {}) {
  const profile = {
    componentRoot: options.componentRoot || COMPONENT_ROOT,
    executableName: options.executableName || EXECUTABLE_NAME,
    requiredSupportedLanguages: options.requiredSupportedLanguages || REQUIRED_LANGUAGES,
    validateExtension: options.validateManifestExtension
  };
  const dataToolsDir = path.resolve(options.dataToolsDir || shared.DATA_TOOLS_DIR);
  const componentDir = path.join(dataToolsDir, ...profile.componentRoot.split('/'));
  const executablePath = path.join(componentDir, profile.executableName);
  const manifestUrl = options.manifestUrl || OCR_COMPONENT_MANIFEST_URL;
  const fetchManifest = options.fetchManifest || options.network?.fetchManifest || defaultFetchManifest;
  const downloadFile = options.downloadFile || options.downloader || options.network?.downloadFile || defaultDownloadFile;
  const getFreeSpace = options.getFreeSpace || options.disk?.getFreeSpace || defaultGetFreeSpace;
  const rename = options.rename || options.disk?.rename || fs.promises.rename.bind(fs.promises);
  const remove = options.remove || options.disk?.remove || ((targetPath) => (
    fs.promises.rm(targetPath, { recursive: true, force: true })
  ));
  const writeFile = options.writeFile || options.disk?.writeFile || fs.promises.writeFile.bind(fs.promises);
  const now = options.now || (() => new Date());

  let remoteManifest = null;
  let operationState = null;
  let activePromise = null;
  let activeController = null;
  let progress = {
    status: 'not_installed',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    step: 'checking',
    error: null
  };

  function localInstallation() {
    return inspectInstallation(dataToolsDir, componentDir, profile);
  }

  function statusFrom(status, local, error = null) {
    return {
      status,
      version: local.valid ? local.manifest.version : null,
      supportedLanguages: local.valid
        ? [...local.manifest.supportedLanguages]
        : [],
      error
    };
  }

  function getOcrComponentStatus() {
    const local = localInstallation();
    if (operationState) {
      return statusFrom(operationState.status, local, operationState.error);
    }
    if (
      remoteManifest &&
      (!local.valid || local.manifest.version !== remoteManifest.version)
    ) {
      return statusFrom('not_installed', local);
    }
    return statusFrom(local.valid ? 'ready' : 'not_installed', local);
  }

  async function fetchValidatedManifest(signal) {
    const candidate = await fetchManifest({ url: manifestUrl, signal });
    return validateManifest(candidate, profile);
  }

  async function refreshOcrComponentStatus() {
    if (activePromise) return getOcrComponentStatus();
    try {
      remoteManifest = await fetchValidatedManifest();
      operationState = null;
      return getOcrComponentStatus();
    } catch (error) {
      const local = localInstallation();
      if (local.valid) {
        remoteManifest = null;
        operationState = null;
        return statusFrom('ready', local);
      }
      operationState = { status: 'error', error: error.message };
      return getOcrComponentStatus();
    }
  }

  function getOcrExecutablePath() {
    return localInstallation().valid ? executablePath : null;
  }

  function getOcrDownloadProgress() {
    return { ...progress };
  }

  async function rollbackInstall(stagedComponentDir, backupDir, oldMoved, newMoved) {
    const rollbackErrors = [];
    if (newMoved) {
      await captureOperationFailure(
        rollbackErrors,
        'remove-incomplete-final',
        componentDir,
        () => remove(componentDir)
      );

      let incompleteFinalExists = true;
      try {
        incompleteFinalExists = await pathExists(componentDir);
      } catch (error) {
        rollbackErrors.push(createOperationFailure('inspect-incomplete-final', componentDir, error));
      }
      if (incompleteFinalExists) {
        await captureOperationFailure(
          rollbackErrors,
          'quarantine-incomplete-final',
          componentDir,
          () => rename(componentDir, stagedComponentDir)
        );
      }
    }

    if (oldMoved) {
      await captureOperationFailure(
        rollbackErrors,
        'restore-backup',
        backupDir,
        () => rename(backupDir, componentDir)
      );
    }
    return rollbackErrors;
  }

  async function installAtomically(stagedComponentDir, manifest, backupDir, signal) {
    let oldMoved = false;
    let newMoved = false;
    try {
      await fs.promises.mkdir(path.dirname(componentDir), { recursive: true });
      if (await pathExists(componentDir)) {
        await rename(componentDir, backupDir);
        oldMoved = true;
      }
      throwIfAborted(signal);
      await rename(stagedComponentDir, componentDir);
      newMoved = true;
      throwIfAborted(signal);

      const metadata = {
        ...manifest,
        installedAt: now().toISOString()
      };
      throwIfAborted(signal);
      await writeFile(
        path.join(componentDir, 'installed.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8'
      );
      throwIfAborted(signal);
      const installed = inspectInstallation(dataToolsDir, componentDir, profile);
      throwIfAborted(signal);
      if (!installed.valid || installed.manifest.version !== manifest.version) {
        throw new Error('Final OCR component verification failed');
      }
    } catch (error) {
      const rollbackErrors = await rollbackInstall(
        stagedComponentDir,
        backupDir,
        oldMoved,
        newMoved
      );
      throw attachFailureDetails(error, 'rollbackErrors', rollbackErrors);
    }

    if (oldMoved) {
      try {
        await remove(backupDir);
      } catch (error) {
        let backupExists;
        try {
          backupExists = await pathExists(backupDir);
        } catch (inspectionError) {
          throw attachFailureDetails(error, 'rollbackErrors', [
            createOperationFailure('inspect-backup', backupDir, inspectionError)
          ]);
        }
        if (backupExists) {
          const rollbackErrors = await rollbackInstall(
            stagedComponentDir,
            backupDir,
            oldMoved,
            newMoved
          );
          throw attachFailureDetails(error, 'rollbackErrors', rollbackErrors);
        }
      }
    }
  }

  async function performDownload(signal) {
    const uniqueId = crypto.randomUUID();
    const partialPath = path.join(dataToolsDir, `.vse-cli-${uniqueId}.partial`);
    const stagingDir = path.join(dataToolsDir, `.staging-${uniqueId}`);
    const backupDir = path.join(dataToolsDir, `.backup-${uniqueId}`);
    let manifest = null;
    let primaryError = null;

    try {
      progress = {
        status: 'downloading',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        step: 'checking',
        error: null
      };
      await fs.promises.mkdir(dataToolsDir, { recursive: true });
      manifest = await fetchValidatedManifest(signal);
      remoteManifest = manifest;
      throwIfAborted(signal);

      const local = localInstallation();
      const actualInstalledSize = await directorySize(componentDir);
      const currentInstalledSize = local.valid
        ? Math.max(local.manifest.installedSize, actualInstalledSize)
        : actualInstalledSize;
      const requiredBytes = manifest.archiveSize + manifest.installedSize + currentInstalledSize;
      if (!Number.isSafeInteger(requiredBytes)) {
        throw new Error('Required OCR component disk space exceeds the supported range');
      }
      const availableBytes = await getFreeSpace({ path: dataToolsDir, signal });
      throwIfAborted(signal);
      if (!isEnoughFreeSpace(availableBytes, requiredBytes)) {
        throw new Error(
          `Insufficient disk space: required ${requiredBytes} bytes, available ${formatBytes(availableBytes)} bytes`
        );
      }

      progress = {
        status: 'downloading',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: manifest.archiveSize,
        step: 'downloading',
        error: null
      };
      await downloadFile({
        url: manifest.archiveUrl,
        destination: partialPath,
        signal,
        onProgress(downloadedBytes, reportedTotalBytes) {
          const totalBytes = Number.isSafeInteger(reportedTotalBytes) && reportedTotalBytes > 0
            ? reportedTotalBytes
            : manifest.archiveSize;
          const safeDownloadedBytes = Number.isFinite(downloadedBytes)
            ? Math.max(0, downloadedBytes)
            : 0;
          progress = {
            status: 'downloading',
            percent: Math.max(0, Math.min(100, Math.floor((safeDownloadedBytes / totalBytes) * 100))),
            downloadedBytes: safeDownloadedBytes,
            totalBytes,
            step: 'downloading',
            error: null
          };
        }
      });
      throwIfAborted(signal);

      progress = { ...progress, status: 'downloading', step: 'verifying', error: null };
      const archiveStats = await fs.promises.stat(partialPath);
      if (!archiveStats.isFile() || archiveStats.size !== manifest.archiveSize) {
        throw new Error(
          `Archive size mismatch: expected ${manifest.archiveSize} bytes, received ${archiveStats.size} bytes`
        );
      }
      const archiveSha256 = await sha256File(partialPath, signal);
      if (archiveSha256 !== manifest.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${manifest.sha256}, received ${archiveSha256}`);
      }

      progress = { ...progress, status: 'downloading', step: 'extracting', error: null };
      await extractZipSafely(partialPath, stagingDir, manifest.installedSize, signal);
      throwIfAborted(signal);
      const stagedComponentDir = path.join(stagingDir, manifest.componentRoot);
      await assertRequiredFiles(stagedComponentDir, manifest);

      progress = { ...progress, status: 'downloading', step: 'installing', error: null };
      await installAtomically(stagedComponentDir, manifest, backupDir, signal);
      remoteManifest = manifest;
      operationState = null;
      progress = {
        status: 'ready',
        percent: 100,
        downloadedBytes: manifest.archiveSize,
        totalBytes: manifest.archiveSize,
        step: 'ready',
        error: null
      };
      return getOcrComponentStatus();
    } catch (error) {
      const cancelled = Boolean(signal.aborted || error?.name === 'AbortError');
      const rollbackFailed = Array.isArray(error?.rollbackErrors) && error.rollbackErrors.length > 0;
      if (cancelled && !rollbackFailed) {
        primaryError = signal.reason?.name === 'AbortError'
          ? signal.reason
          : error?.name === 'AbortError'
            ? error
            : Object.assign(createAbortError(), { cause: error });
        operationState = { status: 'cancelled', error: null };
        progress = {
          status: 'cancelled',
          percent: 0,
          downloadedBytes: 0,
          totalBytes: manifest?.archiveSize || progress.totalBytes,
          step: 'cancelled',
          error: null
        };
        throw primaryError;
      }
      primaryError = error;
      operationState = { status: 'error', error: error.message };
      progress = {
        ...progress,
        status: 'error',
        step: 'error',
        error: error.message
      };
      throw error;
    } finally {
      const cleanupErrors = [];
      await captureOperationFailure(
        cleanupErrors,
        'remove-partial',
        partialPath,
        () => remove(partialPath)
      );
      await captureOperationFailure(
        cleanupErrors,
        'remove-staging',
        stagingDir,
        () => remove(stagingDir)
      );
      if (cleanupErrors.length > 0) {
        if (primaryError) {
          const detailedError = attachFailureDetails(primaryError, 'cleanupErrors', cleanupErrors);
          if (detailedError !== primaryError) throw detailedError;
        } else {
          const cleanupError = new Error('OCR component cleanup failed', {
            cause: cleanupErrors[0]
          });
          cleanupError.cleanupErrors = cleanupErrors;
          operationState = { status: 'error', error: cleanupError.message };
          progress = {
            ...progress,
            status: 'error',
            step: 'error',
            error: cleanupError.message
          };
          throw cleanupError;
        }
      }
    }
  }

  function downloadOcrComponent() {
    if (activePromise) return activePromise;

    operationState = { status: 'downloading', error: null };
    activeController = new AbortController();
    let trackedPromise;
    trackedPromise = performDownload(activeController.signal).finally(() => {
      if (activePromise === trackedPromise) {
        activePromise = null;
        activeController = null;
      }
    });
    activePromise = trackedPromise;
    return trackedPromise;
  }

  async function cancelOcrComponentDownload() {
    if (!activePromise || !activeController) {
      return getOcrComponentStatus();
    }

    const promise = activePromise;
    activeController.abort(createAbortError());
    try {
      await promise;
    } catch {
      // The caller of downloadOcrComponent receives the cancellation error.
    }
    return getOcrComponentStatus();
  }

  return {
    getOcrComponentStatus,
    refreshOcrComponentStatus,
    getOcrExecutablePath,
    getOcrDownloadProgress,
    downloadOcrComponent,
    cancelOcrComponentDownload
  };
}

const defaultManager = createOcrComponentManager();

function getOcrComponentStatus() {
  return defaultManager.getOcrComponentStatus();
}

function refreshOcrComponentStatus() {
  return defaultManager.refreshOcrComponentStatus();
}

function getOcrExecutablePath() {
  return defaultManager.getOcrExecutablePath();
}

function getOcrDownloadProgress() {
  return defaultManager.getOcrDownloadProgress();
}

function downloadOcrComponent() {
  return defaultManager.downloadOcrComponent();
}

function cancelOcrComponentDownload() {
  return defaultManager.cancelOcrComponentDownload();
}

module.exports = {
  OCR_COMPONENT_MANIFEST_URL,
  createOcrComponentManager,
  getOcrComponentStatus,
  refreshOcrComponentStatus,
  getOcrExecutablePath,
  getOcrDownloadProgress,
  downloadOcrComponent,
  cancelOcrComponentDownload
};
