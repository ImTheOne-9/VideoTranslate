const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAudioMixGraph,
  buildVoiceMasterFilters,
  normalizeAudioMasteringConfig
} = require('../lib/audio-mastering');

test('audio mastering exposes safe automatic defaults and clamps custom values', () => {
  const automatic = normalizeAudioMasteringConfig({});
  assert.equal(automatic.mode, 'auto');
  assert.equal(automatic.duckingEnabled, false);
  assert.equal(automatic.noiseGateEnabled, false);
  assert.equal(automatic.mixLufs, -14);

  const custom = normalizeAudioMasteringConfig({
    audioMasteringMode: 'custom',
    audioVoiceLufs: -100,
    audioMixLufs: 10,
    audioDuckingAttackMs: 0,
    audioDuckingReleaseMs: 9999
  });
  assert.equal(custom.voiceLufs, -30);
  assert.equal(custom.mixLufs, -8);
  assert.equal(custom.duckingAttackMs, 1);
  assert.equal(custom.duckingReleaseMs, 3000);

  const disabledProcessors = normalizeAudioMasteringConfig({
    audioMasteringMode: 'custom',
    audioNoiseGate: 'false',
    audioDucking: 'false'
  });
  assert.equal(disabledProcessors.noiseGateEnabled, false);
  assert.equal(disabledProcessors.duckingEnabled, false);
});

test('off mode preserves the legacy limiter without loudness, gate or ducking', () => {
  const config = normalizeAudioMasteringConfig({ audioMasteringMode: 'off' });
  assert.deepEqual(buildVoiceMasterFilters(config), []);
  const graph = buildAudioMixGraph({
    config,
    originalVolume: 0.5,
    inputs: [{ index: 1, type: 'single', volume: 1 }]
  });
  assert.equal(graph.duckingApplied, false);
  assert.doesNotMatch(graph.filter, /sidechaincompress|loudnorm|agate/);
  assert.match(graph.filter, /alimiter/);
});

test('automatic graph applies opt-in gate and ducking to original and music', () => {
  const graph = buildAudioMixGraph({
    config: normalizeAudioMasteringConfig({
      audioMasteringMode: 'auto',
      audioNoiseGate: 'true',
      audioDucking: 'true'
    }),
    originalVolume: 0.65,
    inputs: [
      { index: 1, type: 'chunk', volume: 1, startMs: 1250 },
      { index: 2, type: 'music', volume: 0.4 },
      { index: 3, type: 'reaction', volume: 0.8 }
    ]
  });
  assert.equal(graph.hasVoice, true);
  assert.equal(graph.duckingApplied, true);
  assert.match(graph.filter, /adelay=1250:all=1/);
  assert.match(graph.filter, /agate=/);
  assert.match(graph.filter, /loudnorm=I=-18/);
  assert.match(graph.filter, /\[voice_processed\]volume=1\[voice_master\]/);
  assert.equal((graph.filter.match(/sidechaincompress=/g) || []).length, 2);
  assert.match(graph.filter, /loudnorm=I=-14/);
  assert.match(graph.filter, /\[aout\]$/);
});

test('automatic defaults master audio without optional gate or ducking', () => {
  const graph = buildAudioMixGraph({
    config: normalizeAudioMasteringConfig({ audioMasteringMode: 'auto' }),
    originalVolume: 0.67,
    inputs: [
      { index: 1, type: 'single', volume: 1 },
      { index: 2, type: 'music', volume: 0.3 }
    ]
  });
  assert.match(graph.filter, /loudnorm=I=-18/);
  assert.match(graph.filter, /loudnorm=I=-14/);
  assert.doesNotMatch(graph.filter, /agate=|sidechaincompress=/);
  assert.equal(graph.duckingApplied, false);
});

test('audio graph does not add ducking when no narration exists', () => {
  const graph = buildAudioMixGraph({
    config: normalizeAudioMasteringConfig({ audioMasteringMode: 'auto' }),
    originalVolume: 1,
    inputs: [{ index: 1, type: 'music', volume: 0.2 }]
  });
  assert.equal(graph.hasVoice, false);
  assert.equal(graph.duckingApplied, false);
  assert.doesNotMatch(graph.filter, /sidechaincompress/);
});

test('automatic graph masters an original-only soundtrack', () => {
  const graph = buildAudioMixGraph({
    config: normalizeAudioMasteringConfig({ audioMasteringMode: 'auto' }),
    originalVolume: 0.67,
    inputs: []
  });
  assert.equal(graph.hasVoice, false);
  assert.match(graph.filter, /\[original_pre\]amix=inputs=1/);
  assert.match(graph.filter, /loudnorm=I=-14/);
  assert.match(graph.filter, /\[aout\]$/);
});
