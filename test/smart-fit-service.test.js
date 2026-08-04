const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createSmartFitSignature,
  normalizeSmartFitMode,
  planSmartFit
} = require('../lib/smart-fit-service');
const {
  buildAtempoFilters,
  createFittedVoiceChunk,
  readWavDurationMs
} = require('../lib/voice-audio-fit');

function writeSilentWav(filePath, durationMs = 1000) {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = Math.round(sampleRate * channels * (bitsPerSample / 8) * durationMs / 1000);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, buffer);
}

test('normalizes every legacy Smart Fit mode to cue', () => {
  assert.equal(normalizeSmartFitMode('natural'), 'cue');
  assert.equal(normalizeSmartFitMode('CINEMATIC'), 'cue');
  assert.equal(normalizeSmartFitMode('unknown'), 'cue');
  assert.equal(normalizeSmartFitMode(), 'cue');
});

test('keeps audio unchanged when it fits inside the cue budget', () => {
  const plan = planSmartFit({
    mode: 'cue',
    startMs: 1000,
    endMs: 3000,
    rawDurationMs: 1800,
    nextStartMs: 3500
  });
  assert.equal(plan.status, 'unchanged');
  assert.equal(plan.speed, 1);
  assert.equal(plan.trimmedMs, 0);
  assert.equal(plan.fittedDurationMs, 1800);
});

test('cue mode ignores following gaps and speeds audio to the exact cue budget', () => {
  const plan = planSmartFit({
    mode: 'cue',
    startMs: 0,
    endMs: 2000,
    nextStartMs: 2600,
    rawDurationMs: 2300
  });
  assert.equal(plan.status, 'sped_up');
  assert.equal(plan.speed, 1.18);
  assert.equal(plan.borrowedMs, 0);
  assert.ok(plan.fittedDurationMs <= plan.baseAvailableMs);
  assert.ok(plan.effectiveEndMs <= 2000);
});

test('cue mode speeds audio beyond 2x without capping or requesting rewrite', () => {
  const plan = planSmartFit({
    mode: 'cue',
    startMs: 0,
    endMs: 1000,
    nextStartMs: 1000,
    rawDurationMs: 5000
  });
  assert.equal(plan.status, 'sped_up');
  assert.equal(plan.maxSpeed, null);
  assert.equal(plan.unlimitedSpeed, true);
  assert.equal(plan.trimmedMs, 0);
  assert.equal(plan.warning, null);
  assert.ok(plan.fittedDurationMs <= plan.baseAvailableMs);
});

test('does not treat the remaining video as a gap when the next cue starts immediately', () => {
  const plan = planSmartFit({
    mode: 'cue',
    startMs: 0,
    endMs: 1540,
    nextStartMs: 1540,
    timelineEndMs: 218000,
    rawDurationMs: 3110
  });
  assert.equal(plan.borrowedMs, 0);
  assert.equal(plan.status, 'sped_up');
  assert.equal(plan.trimmedMs, 0);
  assert.ok(plan.effectiveEndMs <= 1540);
});

test('does not borrow time across an overlapping next cue', () => {
  const plan = planSmartFit({
    mode: 'cue',
    startMs: 1000,
    endMs: 3000,
    nextStartMs: 2900,
    timelineEndMs: 10000,
    rawDurationMs: 2600
  });
  assert.equal(plan.borrowedMs, 0);
  assert.ok(plan.effectiveEndMs <= 3000);
});

test('legacy mode input produces the same cue-only plan', () => {
  const input = {
    startMs: 0,
    endMs: 2000,
    nextStartMs: 2000,
    rawDurationMs: 2400
  };
  const natural = planSmartFit({ ...input, mode: 'natural' });
  const cue = planSmartFit({ ...input, mode: 'cue' });
  assert.deepEqual(natural, cue);
  assert.equal(cue.status, 'sped_up');
  assert.equal(cue.trimmedMs, 0);
});

test('cue-fit signature is stable, ignores legacy mode, and changes with timing', () => {
  const input = {
    rawSignature: 'raw-a',
    mode: 'cue',
    startMs: 0,
    endMs: 2000,
    nextStartMs: 2500
  };
  assert.equal(createSmartFitSignature(input), createSmartFitSignature({ ...input }));
  assert.notEqual(createSmartFitSignature(input), createSmartFitSignature({ ...input, endMs: 2100 }));
  assert.equal(createSmartFitSignature(input), createSmartFitSignature({ ...input, mode: 'natural' }));
  assert.notEqual(
    createSmartFitSignature(input),
    createSmartFitSignature({ ...input, audioProcessing: { crossfadeMs: 35 } })
  );
});

test('builds valid chained atempo filters', () => {
  assert.deepEqual(buildAtempoFilters(1), []);
  assert.deepEqual(buildAtempoFilters(1.25), ['atempo=1.250']);
  assert.deepEqual(buildAtempoFilters(4), ['atempo=2.0', 'atempo=2.000']);
  assert.deepEqual(
    buildAtempoFilters(5.264),
    ['atempo=2.0', 'atempo=2.0', 'atempo=1.316']
  );
});

test('normalizes fitted copies without modifying the raw WAV', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-fit-audio-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rawPath = path.join(directory, 'raw.wav');
  const fittedPath = path.join(directory, 'fitted.wav');
  writeSilentWav(rawPath, 1000);
  const before = fs.readFileSync(rawPath);

  const duration = await createFittedVoiceChunk({
    rawPath,
    outputPath: fittedPath,
    fitPlan: planSmartFit({
      mode: 'cue',
      startMs: 0,
      endMs: 2000,
      rawDurationMs: 1000
    }),
    ffmpegPath: 'ffmpeg',
    normalizationOptions: { fadeMs: 35, integratedLufs: -17 },
    runExecFile: async (_command, args) => {
      const filter = args[args.indexOf('-filter:a') + 1];
      assert.match(filter, /loudnorm=I=-17:LRA=7:TP=-1\.5/);
      assert.match(filter, /alimiter=/);
      assert.match(filter, /aresample=24000/);
      assert.match(filter, /afade=t=in:st=0:d=0\.035/);
      fs.copyFileSync(rawPath, args.at(-1));
    }
  });

  assert.equal(duration, 1000);
  assert.deepEqual(fs.readFileSync(rawPath), before);
  assert.equal(readWavDurationMs(fittedPath), 1000);
});

test('cue-only fitting uses atempo without trimming speech', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-fit-filter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rawPath = path.join(directory, 'raw.wav');
  const fittedPath = path.join(directory, 'fitted.wav');
  writeSilentWav(rawPath, 2000);
  const before = fs.readFileSync(rawPath);
  let receivedArgs;
  const plan = planSmartFit({
    mode: 'cue',
    startMs: 0,
    endMs: 1500,
    nextStartMs: 1500,
    rawDurationMs: 2000
  });

  await createFittedVoiceChunk({
    rawPath,
    outputPath: fittedPath,
    fitPlan: plan,
    ffmpegPath: 'ffmpeg',
    runExecFile: async (_command, args) => {
      receivedArgs = args;
      fs.copyFileSync(rawPath, args.at(-1));
    }
  });

  const filter = receivedArgs[receivedArgs.indexOf('-filter:a') + 1];
  assert.match(filter, /atempo=/);
  assert.doesNotMatch(filter, /atrim=duration=/);
  assert.deepEqual(fs.readFileSync(rawPath), before);
});
