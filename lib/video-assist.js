'use strict';

const { warpTimeMs } = require('./adaptive-dubbing-pipeline');

function activeWarp(timeWarp) {
  return Array.isArray(timeWarp)
    && timeWarp.some((segment) => Number(segment.factor) < 0.999);
}

function buildVideoAssistVideoFilters(options = {}) {
  const timeWarp = Array.isArray(options.timeWarp) ? options.timeWarp : [];
  if (!activeWarp(timeWarp)) return { active: false, segments: [], outputLabel: options.inputLabel || '0:v' };
  const inputLabel = options.inputLabel || '0:v';
  const outputLabel = options.outputLabel || 'v_assist';
  const prefix = options.prefix || 'va_v';
  const splitLabels = timeWarp.map((_, index) => `${prefix}_split_${index}`);
  const readyLabels = timeWarp.map((_, index) => `${prefix}_ready_${index}`);
  const segments = timeWarp.length === 1 ? [] : [
    `[${inputLabel}]split=${timeWarp.length}${splitLabels.map((label) => `[${label}]`).join('')}`
  ];
  timeWarp.forEach((segment, index) => {
    const start = (segment.startMs / 1000).toFixed(6);
    const end = (segment.endMs / 1000).toFixed(6);
    const factor = Math.max(0.5, Math.min(1, Number(segment.factor) || 1)).toFixed(6);
    segments.push(
      `[${timeWarp.length === 1 ? inputLabel : splitLabels[index]}]trim=start=${start}:end=${end},`
      + `setpts=(PTS-STARTPTS)/${factor}[${readyLabels[index]}]`
    );
  });
  if (timeWarp.length === 1) {
    segments[0] = segments[0].replace(`[${readyLabels[0]}]`, `[${outputLabel}]`);
  } else {
    segments.push(
      `${readyLabels.map((label) => `[${label}]`).join('')}`
      + `concat=n=${timeWarp.length}:v=1:a=0[${outputLabel}]`
    );
  }
  return { active: true, segments, outputLabel };
}

function buildVideoAssistAudioFilters(options = {}) {
  const timeWarp = Array.isArray(options.timeWarp) ? options.timeWarp : [];
  if (!activeWarp(timeWarp)) return { active: false, segments: [], outputLabel: options.inputLabel || '0:a' };
  const inputLabel = options.inputLabel || '0:a';
  const outputLabel = options.outputLabel || 'a_assist';
  const prefix = options.prefix || 'va_a';
  const splitLabels = timeWarp.map((_, index) => `${prefix}_split_${index}`);
  const readyLabels = timeWarp.map((_, index) => `${prefix}_ready_${index}`);
  const segments = timeWarp.length === 1 ? [] : [
    `[${inputLabel}]asplit=${timeWarp.length}${splitLabels.map((label) => `[${label}]`).join('')}`
  ];
  timeWarp.forEach((segment, index) => {
    const start = (segment.startMs / 1000).toFixed(6);
    const end = (segment.endMs / 1000).toFixed(6);
    const factor = Math.max(0.5, Math.min(1, Number(segment.factor) || 1)).toFixed(6);
    segments.push(
      `[${timeWarp.length === 1 ? inputLabel : splitLabels[index]}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,`
      + `atempo=${factor}[${readyLabels[index]}]`
    );
  });
  if (timeWarp.length === 1) {
    segments[0] = segments[0].replace(`[${readyLabels[0]}]`, `[${outputLabel}]`);
  } else {
    segments.push(
      `${readyLabels.map((label) => `[${label}]`).join('')}`
      + `concat=n=${timeWarp.length}:v=0:a=1[${outputLabel}]`
    );
  }
  return { active: true, segments, outputLabel };
}

function warpTimedBoxes(boxes, timeWarp) {
  if (!activeWarp(timeWarp)) return Array.isArray(boxes) ? boxes : [];
  return (Array.isArray(boxes) ? boxes : []).map((box) => ({
    ...box,
    start: warpTimeMs(Math.max(0, Number(box.start) || 0) * 1000, timeWarp) / 1000,
    end: warpTimeMs(Math.max(0, Number(box.end) || 0) * 1000, timeWarp) / 1000
  }));
}

module.exports = {
  activeWarp,
  buildVideoAssistAudioFilters,
  buildVideoAssistVideoFilters,
  warpTimedBoxes
};
