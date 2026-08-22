'use strict';

const AUDIO_MASTERING_VERSION = 1;
const AUDIO_MASTERING_MODES = new Set(['off', 'auto', 'custom']);
const DEFAULT_AUDIO_MASTERING = Object.freeze({
  mode: 'auto',
  voiceLufs: -18,
  mixLufs: -14,
  truePeakDb: -1.5,
  loudnessRange: 9,
  noiseGateEnabled: false,
  noiseGateThresholdDb: -48,
  noiseGateRatio: 2,
  duckingEnabled: false,
  duckingThreshold: 0.025,
  duckingRatio: 8,
  duckingAttackMs: 20,
  duckingReleaseMs: 350,
  exportTracks: false
});

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === 'on' || value === '1';
}

function normalizeAudioMasteringConfig(body = {}) {
  const requestedMode = String(body.audioMasteringMode || DEFAULT_AUDIO_MASTERING.mode);
  const mode = AUDIO_MASTERING_MODES.has(requestedMode)
    ? requestedMode
    : DEFAULT_AUDIO_MASTERING.mode;
  const enabled = mode !== 'off';
  return {
    version: AUDIO_MASTERING_VERSION,
    mode,
    enabled,
    voiceLufs: clamp(body.audioVoiceLufs, -30, -10, DEFAULT_AUDIO_MASTERING.voiceLufs),
    mixLufs: clamp(body.audioMixLufs, -24, -8, DEFAULT_AUDIO_MASTERING.mixLufs),
    truePeakDb: clamp(body.audioTruePeakDb, -6, -0.1, DEFAULT_AUDIO_MASTERING.truePeakDb),
    loudnessRange: clamp(
      body.audioLoudnessRange,
      1,
      20,
      DEFAULT_AUDIO_MASTERING.loudnessRange
    ),
    noiseGateEnabled: enabled && bool(
      body.audioNoiseGate,
      DEFAULT_AUDIO_MASTERING.noiseGateEnabled
    ),
    noiseGateThresholdDb: clamp(
      body.audioNoiseGateThresholdDb,
      -70,
      -20,
      DEFAULT_AUDIO_MASTERING.noiseGateThresholdDb
    ),
    noiseGateRatio: clamp(
      body.audioNoiseGateRatio,
      1,
      10,
      DEFAULT_AUDIO_MASTERING.noiseGateRatio
    ),
    duckingEnabled: enabled && bool(
      body.audioDucking,
      DEFAULT_AUDIO_MASTERING.duckingEnabled
    ),
    duckingThreshold: clamp(
      body.audioDuckingThreshold,
      0.001,
      0.2,
      DEFAULT_AUDIO_MASTERING.duckingThreshold
    ),
    duckingRatio: clamp(
      body.audioDuckingRatio,
      1,
      20,
      DEFAULT_AUDIO_MASTERING.duckingRatio
    ),
    duckingAttackMs: clamp(
      body.audioDuckingAttackMs,
      1,
      500,
      DEFAULT_AUDIO_MASTERING.duckingAttackMs
    ),
    duckingReleaseMs: clamp(
      body.audioDuckingReleaseMs,
      50,
      3000,
      DEFAULT_AUDIO_MASTERING.duckingReleaseMs
    ),
    exportTracks: bool(body.audioExportTracks, DEFAULT_AUDIO_MASTERING.exportTracks)
  };
}

function dbToLinear(db) {
  return Math.pow(10, Number(db) / 20);
}

function buildVoiceMasterFilters(config) {
  if (!config.enabled) return [];
  const filters = [];
  if (config.noiseGateEnabled) {
    filters.push(
      `agate=threshold=${dbToLinear(config.noiseGateThresholdDb).toFixed(6)}`
      + `:ratio=${config.noiseGateRatio.toFixed(2)}:attack=10`
      + `:release=${Math.max(50, config.duckingReleaseMs / 2).toFixed(0)}`
    );
  }
  if (!config.voicePreNormalized) {
    filters.push(
      `loudnorm=I=${config.voiceLufs}:LRA=${config.loudnessRange}:TP=${config.truePeakDb}`
    );
  }
  filters.push(
    `alimiter=limit=${dbToLinear(config.truePeakDb).toFixed(6)}`
    + ':attack=5:release=50:level=disabled'
  );
  return filters;
}

function buildAudioMixGraph(options) {
  const {
    inputs = [],
    originalVolume = 1,
    config: rawConfig = {}
  } = options || {};
  const config = rawConfig.version
    ? rawConfig
    : normalizeAudioMasteringConfig(rawConfig);
  const environment = options?.environment || process.env;
  const filters = [];
  const voiceInputs = inputs.filter((input) => input.type === 'chunk' || input.type === 'single');
  const musicInputs = inputs.filter((input) => input.type === 'music');
  const otherInputs = inputs.filter((input) => !['chunk', 'single', 'music'].includes(input.type));

  filters.push(`[0:a]volume=${Math.max(0, Number(originalVolume) || 0)}[original_pre]`);

  const voiceLabels = voiceInputs.map((input, index) => {
    const label = `voice_${index}`;
    const delay = input.type === 'chunk' && Number(input.startMs) > 0
      ? `adelay=${Math.round(Number(input.startMs))}:all=1,`
      : '';
    filters.push(`[${input.index}:a]${delay}anull[${label}]`);
    return `[${label}]`;
  });

  let voiceBus = null;
  if (voiceLabels.length) {
    const rawVoiceLabel = 'voice_raw';
    if (voiceLabels.length === 1) {
      filters.push(`${voiceLabels[0]}anull[${rawVoiceLabel}]`);
    } else {
      filters.push(
        `${voiceLabels.join('')}amix=inputs=${voiceLabels.length}`
        + `:duration=longest:dropout_transition=0:normalize=0[${rawVoiceLabel}]`
      );
    }
    const voiceMasterFilters = buildVoiceMasterFilters(config);
    if (voiceMasterFilters.length) {
      filters.push(`[${rawVoiceLabel}]${voiceMasterFilters.join(',')}[voice_processed]`);
    } else {
      filters.push(`[${rawVoiceLabel}]anull[voice_processed]`);
    }
    const voiceVolume = Math.max(0, Number(voiceInputs[0]?.volume) || 0);
    filters.push(`[voice_processed]volume=${voiceVolume}[voice_master]`);
    voiceBus = 'voice_master';
  }

  const backgroundLabels = [];
  const duckingTargets = [];
  if (Number(originalVolume) > 0) duckingTargets.push({ label: 'original_pre', kind: 'original' });
  else backgroundLabels.push('[original_pre]');

  musicInputs.forEach((input, index) => {
    const label = `music_pre_${index}`;
    filters.push(
      `[${input.index}:a]volume=${Math.max(0, Number(input.volume) || 0)}[${label}]`
    );
    duckingTargets.push({ label, kind: 'music' });
  });

  let voiceMixLabel = voiceBus;
  if (voiceBus && config.duckingEnabled && duckingTargets.length) {
    const splitLabels = ['voice_mix', ...duckingTargets.map((_, index) => `voice_sc_${index}`)];
    filters.push(
      `[${voiceBus}]asplit=${splitLabels.length}`
      + splitLabels.map((label) => `[${label}]`).join('')
    );
    voiceMixLabel = 'voice_mix';
    duckingTargets.forEach((target, index) => {
      const outputLabel = `${target.kind}_ducked_${index}`;
      filters.push(
        `[${target.label}][voice_sc_${index}]sidechaincompress=`
        + `threshold=${config.duckingThreshold.toFixed(4)}`
        + `:ratio=${config.duckingRatio.toFixed(2)}`
        + `:attack=${config.duckingAttackMs.toFixed(0)}`
        + `:release=${config.duckingReleaseMs.toFixed(0)}`
        + `:makeup=1[${outputLabel}]`
      );
      backgroundLabels.push(`[${outputLabel}]`);
    });
  } else {
    backgroundLabels.push(...duckingTargets.map((target) => `[${target.label}]`));
  }

  const otherLabels = otherInputs.map((input, index) => {
    const label = `other_${index}`;
    filters.push(
      `[${input.index}:a]volume=${Math.max(0, Number(input.volume) || 0)}[${label}]`
    );
    return `[${label}]`;
  });
  const mixLabels = [
    ...backgroundLabels,
    ...(voiceMixLabel ? [`[${voiceMixLabel}]`] : []),
    ...otherLabels
  ];
  const limiterLimit = config.enabled
    ? dbToLinear(config.truePeakDb).toFixed(6)
    : '0.891';
  const limiter = `alimiter=limit=${limiterLimit}`
    + ':attack=5:release=50:level=disabled';
  const postFilters = [];
  if (environment.AUDIO_WIND === '1') postFilters.push('highpass=f=120');
  if (environment.AUDIO_DENOISE === '1' || environment.AUDIO_WIND === '1') {
    postFilters.push(`afftdn=nf=${environment.AUDIO_DENOISE_NF || '-25'}`);
  }
  const requestedPitch = Number(environment.DUB_PITCH);
  if (Number.isFinite(requestedPitch) && requestedPitch >= 0.5 && requestedPitch <= 2
    && Math.abs(requestedPitch - 1) > 0.001) {
    postFilters.push(`rubberband=pitch=${requestedPitch.toFixed(4)}`);
  }
  if (environment.AUDIO_ANTIID === '1') {
    const antiPitch = Math.min(2, Math.max(0.5, Number(environment.AUDIO_ANTIID_PITCH) || 1.06));
    postFilters.push(`rubberband=pitch=${antiPitch.toFixed(4)}`);
  }
  let masterFilters = [...postFilters, limiter].join(',');
  if (config.enabled && config.mixLoudnessEnabled !== false) {
    masterFilters = [...postFilters,
      `loudnorm=I=${config.mixLufs}:LRA=${config.loudnessRange}:TP=${config.truePeakDb}`,
      limiter].join(',');
  } else if (environment.AUDIO_LOUDNORM === '1') {
    masterFilters = [...postFilters,
      `loudnorm=I=${environment.AUDIO_LUFS || '-14'}:TP=-1.5:LRA=11`, limiter].join(',');
  }
  filters.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}`
    + `:duration=first:dropout_transition=0:normalize=0,${masterFilters}[aout]`
  );

  return {
    config,
    filter: filters.join(';'),
    filters,
    hasVoice: Boolean(voiceBus),
    duckingApplied: Boolean(voiceBus && config.duckingEnabled && duckingTargets.length)
  };
}

module.exports = {
  AUDIO_MASTERING_VERSION,
  DEFAULT_AUDIO_MASTERING,
  buildAudioMixGraph,
  buildVoiceMasterFilters,
  normalizeAudioMasteringConfig
};
