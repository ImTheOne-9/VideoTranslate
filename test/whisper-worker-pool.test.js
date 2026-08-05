'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { WhisperWorkerPool } = require('../lib/whisper-worker-pool');

function createFakeFork(workers) {
  return () => {
    const worker = new EventEmitter();
    worker.stderr = new EventEmitter();
    worker.sent = [];
    worker.send = (message) => worker.sent.push(message);
    worker.kill = () => worker.emit('exit', null, 'SIGKILL');
    workers.push(worker);
    return worker;
  };
}

test('reuses an idle Whisper worker with the same model key', async () => {
  const workers = [];
  const pool = new WhisperWorkerPool({ forkImpl: createFakeFork(workers), idleTimeoutMs: 10000 });
  const first = pool.request({ key: 'small-q8-cpu', workerPath: 'worker.js', forkOptions: {}, payload: { id: 1 } });
  workers[0].emit('message', { type: 'result', result: { text: 'one' } });
  assert.equal((await first).text, 'one');

  const second = pool.request({ key: 'small-q8-cpu', workerPath: 'worker.js', forkOptions: {}, payload: { id: 2 } });
  assert.equal(workers.length, 1);
  workers[0].emit('message', { type: 'result', result: { text: 'two' } });
  assert.equal((await second).text, 'two');
  pool.dispose();
});

test('cancels only the worker owned by the requested task', async () => {
  const workers = [];
  const pool = new WhisperWorkerPool({ forkImpl: createFakeFork(workers), idleTimeoutMs: 10000 });
  const pending = pool.request({
    key: 'medium-q8-cpu',
    workerPath: 'worker.js',
    forkOptions: {},
    payload: {},
    owner: 'task-1'
  });
  assert.equal(pool.cancel('other-task'), false);
  assert.equal(pool.cancel('task-1'), true);
  await assert.rejects(pending, /dừng bất ngờ/);
  pool.dispose();
});
