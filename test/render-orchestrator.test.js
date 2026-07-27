const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRenderOrchestrator } = require('../lib/render-orchestrator');

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-orchestrator-'));
  const saves = [];
  const store = {
    saveTask(task) {
      saves.push(JSON.parse(JSON.stringify(task)));
    }
  };
  const orchestrator = createRenderOrchestrator({
    store,
    existsSync: fs.existsSync,
    logger: { log() {} }
  });
  return {
    directory,
    saves,
    orchestrator,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

test('completed stage reuses its output when checkpoint files still exist', async () => {
  const harness = createHarness();
  try {
    const subtitlePath = path.join(harness.directory, 'subtitle.srt');
    fs.writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\nTest');
    const task = {
      stages: {
        subtitle: {
          status: 'success',
          output: { subtitlePath }
        }
      }
    };
    let calls = 0;

    const output = await harness.orchestrator.runStage(task, 'subtitle', async () => {
      calls += 1;
      return { subtitlePath };
    });

    assert.equal(calls, 0);
    assert.equal(output.subtitlePath, subtitlePath);
  } finally {
    harness.cleanup();
  }
});

test('completed stage reruns when a checkpoint file has been removed', async () => {
  const harness = createHarness();
  try {
    const missingPath = path.join(harness.directory, 'missing.srt');
    const replacementPath = path.join(harness.directory, 'replacement.srt');
    fs.writeFileSync(replacementPath, 'replacement');
    const task = {
      stages: {
        subtitle: {
          status: 'success',
          output: { subtitlePath: missingPath }
        }
      }
    };
    let calls = 0;

    const output = await harness.orchestrator.runStage(task, 'subtitle', async () => {
      calls += 1;
      return { subtitlePath: replacementPath };
    });

    assert.equal(calls, 1);
    assert.equal(output.subtitlePath, replacementPath);
    assert.equal(task.stages.subtitle.status, 'success');
  } finally {
    harness.cleanup();
  }
});

test('failed stage records the error before rethrowing', async () => {
  const harness = createHarness();
  try {
    const task = { stages: {} };
    await assert.rejects(
      harness.orchestrator.runStage(task, 'translation', async () => {
        throw new Error('provider unavailable');
      }),
      /provider unavailable/
    );

    assert.equal(task.stages.translation.status, 'error');
    assert.equal(task.stages.translation.error, 'provider unavailable');
    assert.ok(harness.saves.length >= 2);
  } finally {
    harness.cleanup();
  }
});
