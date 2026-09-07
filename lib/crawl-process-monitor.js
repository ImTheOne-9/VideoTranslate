const { spawn } = require('child_process');
const fs = require('fs');

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { proc.kill(); } catch (_) {} });
  } else { try { proc.kill('SIGTERM'); } catch (_) {} }
}

function redactLog(value) {
  return String(value || '')
    .replace(/([?&](?:msToken|verifyFp|X-Bogus|token|xsec_token|access_token|sessionid|signature)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:cookie|authorization|passToken|sessionid|access_token)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]');
}

function monitorProcess(proc, options = {}) {
  const clock = options.clock || Date.now;
  const started = clock(); let lastActivity = started, stopped = false, lastDiskCheck = started - 15000;
  const idleMs = Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : 45 * 60 * 1000;
  const totalMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12 * 60 * 60 * 1000;
  const touch = () => { lastActivity = clock(); };
  const check = () => {
    if (stopped) return;
    let lowDisk = false;
    if (options.diskRoot && clock() - lastDiskCheck >= 15000) {
      lastDiskCheck = clock();
      try { const space = fs.statfsSync(options.diskRoot); lowDisk = space.bavail * space.bsize < 100 * 1024 * 1024; } catch (_) {}
    }
    if (!lowDisk && clock() - lastActivity < idleMs && clock() - started < totalMs) return;
    stop();
    const reason = lowDisk ? 'disk_full' : clock() - lastActivity >= idleMs ? 'idle' : 'total';
    try { (options.kill || killTree)(proc); } catch (_) { killTree(proc); }
    options.onTimeout?.(reason);
  };
  const timer = setInterval(check, Math.min(1000, idleMs, totalMs)); timer.unref?.();
  function stop() {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    proc.stdout?.off('data', touch); proc.stderr?.off('data', touch);
  }
  proc.stdout?.on('data', touch); proc.stderr?.on('data', touch);
  proc.once('close', stop); proc.once('error', stop);
  return { check, stop, touch };
}

module.exports = { killTree, redactLog, monitorProcess };
