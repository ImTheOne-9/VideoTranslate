'use strict';

const DEFAULT_CHUNK_MAX = 60;
const DEFAULT_SIGMA = 16;
const DEFAULT_PRE_ROLL = 0.1;
const DEFAULT_CONTINUOUS_GAP = 0.35;
// Viral OCR already pads its detector boxes (x ±1%, top 0.6%, bottom 0.8%).
// Keep render padding at zero to avoid applying that safety margin twice.
const DEFAULT_HORIZONTAL_PADDING = 0;
const DEFAULT_VERTICAL_PADDING = 0;
const DEFAULT_MASK_COLOR = '#000000';

function normalizeMaskStyle(value) {
  return ['blur', 'solid', 'custom'].includes(value) ? value : 'blur';
}

function normalizeOpaqueColor(value, fallback = DEFAULT_MASK_COLOR) {
  const candidate = String(value || '').trim();
  const safeFallback = /^#[0-9a-f]{6}$/i.test(String(fallback || '').trim())
    ? String(fallback).trim()
    : DEFAULT_MASK_COLOR;
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toUpperCase() : safeFallback.toUpperCase();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBlurBox(box = {}, options = {}) {
  const width = clamp(finiteNumber(box.width, 80), 1, 100);
  const height = clamp(finiteNumber(box.height, 15), 1, 100);
  let x = clamp(finiteNumber(box.x, 10), 0, Math.max(0, 100 - width));
  const y = clamp(finiteNumber(box.y, 75), 0, Math.max(0, 100 - height));
  if (options.mirrored) x = clamp(100 - x - width, 0, Math.max(0, 100 - width));
  const start = Math.max(0, finiteNumber(box.start, 0));
  const end = Math.max(start, finiteNumber(box.end, 99999));
  return {
    ...box,
    x,
    y,
    width,
    height,
    start,
    end,
    radius: clamp(finiteNumber(box.radius, 20), 1, 50)
  };
}

function normalizeCueTiming(cue = {}) {
  const start = finiteNumber(cue.start, finiteNumber(cue.startMs, 0) / 1000);
  const end = finiteNumber(cue.end, finiteNumber(cue.endMs, 0) / 1000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start: Math.max(0, start), end: Math.max(0, end) };
}

function sameVerticalTrack(left, right, tolerance = 5) {
  const leftCenter = left.y + left.height / 2;
  const rightCenter = right.y + right.height / 2;
  return Math.abs(leftCenter - rightCenter) <= tolerance;
}

function padAutomaticBox(box, options = {}) {
  const horizontalPadding = Math.max(0, finiteNumber(
    options.horizontalPadding,
    DEFAULT_HORIZONTAL_PADDING
  ));
  const verticalPadding = Math.max(0, finiteNumber(
    options.verticalPadding,
    DEFAULT_VERTICAL_PADDING
  ));
  const x0 = Math.max(0, box.x - horizontalPadding);
  const y0 = Math.max(0, box.y - verticalPadding);
  const x1 = Math.min(100, box.x + box.width + horizontalPadding);
  const y1 = Math.min(100, box.y + box.height + verticalPadding);
  return {
    ...box,
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0
  };
}

function prepareAutomaticBlurBoxes(boxes, options = {}) {
  const preRoll = Math.max(0, finiteNumber(options.preRoll, DEFAULT_PRE_ROLL));
  const continuousGap = Math.max(0, finiteNumber(
    options.continuousGap,
    DEFAULT_CONTINUOUS_GAP
  ));
  const cueMatchTolerance = Math.max(0, finiteNumber(options.cueMatchTolerance, 0.3));
  const trackTolerance = Math.max(0, finiteNumber(options.trackTolerance, 5));
  const cues = (Array.isArray(options.displayCues) ? options.displayCues : [])
    .map(normalizeCueTiming)
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  const normalized = (Array.isArray(boxes) ? boxes : [])
    .map((box) => normalizeBlurBox(box, options))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const timed = normalized.map((box, index) => {
    let previous = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (sameVerticalTrack(box, normalized[cursor], trackTolerance)) {
        previous = normalized[cursor];
        break;
      }
    }
    const rawGap = previous ? box.start - previous.end : box.start;
    const availableGap = Math.max(0, rawGap);
    const bridgeContinuousCue = previous && rawGap > 0 && rawGap <= continuousGap;
    const calculatedStart = bridgeContinuousCue
      ? previous.end
      : Math.max(0, box.start - Math.min(preRoll, availableGap));
    const start = Number(calculatedStart.toFixed(3));
    let end = box.end;
    let bestCue = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cue of cues) {
      if (cue.start > box.start + cueMatchTolerance) break;
      const distance = Math.abs(cue.start - box.start);
      if (distance <= cueMatchTolerance && distance < bestDistance) {
        bestCue = cue;
        bestDistance = distance;
      }
    }
    if (bestCue) end = Math.max(end, bestCue.end);

    for (let cursor = index + 1; cursor < normalized.length; cursor += 1) {
      const next = normalized[cursor];
      if (!sameVerticalTrack(box, next, trackTolerance)) continue;
      end = Math.min(end, Math.max(box.end, next.start - 0.02));
      break;
    }
    return padAutomaticBox({
      ...box,
      start,
      end: Math.max(box.end, end),
      timingAdjustment: bridgeContinuousCue
        ? 'continuous_gap'
        : (start < box.start ? 'pre_roll' : 'none')
    }, options);
  });
  return timed;
}

function groupAdjacentTracks(boxes) {
  const byTrack = new Map();
  for (const box of boxes) {
    const bin = Math.trunc((box.y + box.height / 2) / 5);
    if (!byTrack.has(bin)) byTrack.set(bin, []);
    byTrack.get(bin).push(box);
  }

  const bins = [...byTrack.keys()].sort((a, b) => a - b);
  if (bins.length === 0) return [];
  const tracks = [];
  let adjacentBins = [bins[0]];
  for (const bin of bins.slice(1)) {
    if (bin - adjacentBins[adjacentBins.length - 1] <= 1) {
      adjacentBins.push(bin);
    } else {
      tracks.push(adjacentBins.flatMap((item) => byTrack.get(item)));
      adjacentBins = [bin];
    }
  }
  tracks.push(adjacentBins.flatMap((item) => byTrack.get(item)));
  return tracks.map((track) => track.sort((a, b) => a.start - b.start || a.end - b.end));
}

function splitTrackBySize(track, options = {}) {
  const chunkMax = Math.max(1, Math.trunc(finiteNumber(options.chunkMax, DEFAULT_CHUNK_MAX)));
  const heightGap = Math.max(0, finiteNumber(options.heightGap, 3));
  const widthGap = Math.max(0, finiteNumber(options.widthGap, 15));
  const chunks = [];
  let chunk = [];
  let maxHeight = 0;
  let maxWidth = 0;

  for (const box of track) {
    const height = clamp(box.height, 3, 25);
    const width = clamp(box.width, 5, 100);
    if (chunk.length && (
      chunk.length >= chunkMax ||
      height > maxHeight + heightGap ||
      width > maxWidth + widthGap
    )) {
      chunks.push(chunk);
      chunk = [];
      maxHeight = 0;
      maxWidth = 0;
    }
    chunk.push({ ...box, width, height });
    maxHeight = Math.max(maxHeight, height);
    maxWidth = Math.max(maxWidth, width);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function splitTrackByDimensions(track, options = {}) {
  const widthBucket = Math.max(1, finiteNumber(options.widthBucket, 6));
  const heightBucket = Math.max(1, finiteNumber(options.heightBucket, 4));
  const buckets = new Map();
  for (const box of track) {
    const key = `${Math.floor(box.width / widthBucket)}:${Math.floor(box.height / heightBucket)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(box);
  }
  return [...buckets.values()].flatMap((bucket) => {
    const lanes = [];
    for (const box of bucket.sort((left, right) => left.start - right.start || left.end - right.end)) {
      let lane = lanes.find((candidate) => box.start >= candidate.end - 0.001);
      if (!lane) {
        lane = { end: Number.NEGATIVE_INFINITY, boxes: [] };
        lanes.push(lane);
      }
      lane.boxes.push(box);
      lane.end = Math.max(lane.end, box.end);
    }
    return lanes.flatMap((lane) => splitTrackBySize(lane.boxes, options));
  });
}

function groupedRegion(chunk, options = {}) {
  const heights = chunk.map((box) => box.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 0;
  const rawY0 = Math.min(...chunk.map((box) => box.y));
  const rawY1 = Math.max(...chunk.map((box) => box.y + box.height));
  const maxEnvelopeRatio = Math.max(1, finiteNumber(options.maxEnvelopeRatio, 1.8));
  if (!medianHeight || rawY1 - rawY0 > medianHeight * maxEnvelopeRatio) return null;

  const rawX0 = Math.min(...chunk.map((box) => box.x));
  const rawX1 = Math.max(...chunk.map((box) => box.x + box.width));
  const padding = Math.max(medianHeight * 0.25, 1.5);
  const y0 = Math.max(0, rawY0 - padding);
  const y1 = rawY1 >= 98.5 ? 100 : Math.min(100, rawY1 + padding);
  const width = clamp(rawX1 - rawX0, 5, 100);
  const height = clamp(y1 - y0, 3, 40);
  return {
    x: clamp(rawX0, 0, 100 - width),
    y: clamp(y0, 0, 100 - height),
    width,
    height
  };
}

function optimizeAutomaticOcrBlurBoxes(boxes, options = {}) {
  const normalized = prepareAutomaticBlurBoxes(boxes, options);
  const chunks = groupAdjacentTracks(normalized)
    .flatMap((track) => splitTrackByDimensions(track, options));
  return chunks.map((chunk) => {
    const region = groupedRegion(chunk, { ...options, dynamicPosition: true });
    return {
      mode: region ? 'dynamic' : 'per_box',
      boxes: chunk,
      region
    };
  });
}

function evenPixels(percent, total, minimum = 2) {
  return Math.max(minimum, Math.floor((total * percent / 100) / 2) * 2);
}

function regionPixels(region, videoWidth, videoHeight) {
  const width = Math.min(videoWidth, evenPixels(region.width, videoWidth));
  const height = Math.min(videoHeight, evenPixels(region.height, videoHeight));
  const x = Math.min(videoWidth - width, evenPixels(region.x, videoWidth, 0));
  const y = Math.min(videoHeight - height, evenPixels(region.y, videoHeight, 0));
  return { width, height, x: Math.max(0, x), y: Math.max(0, y) };
}

function timeExpression(boxes) {
  return boxes
    .map((box) => `between(t,${box.start.toFixed(3)},${box.end.toFixed(3)})`)
    .join('+');
}

function nestedTimeExpression(boxes, valueForBox, fallback = 0) {
  let expression = String(fallback);
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const box = boxes[index];
    expression = `if(between(t,${box.start.toFixed(3)},${box.end.toFixed(3)}),${valueForBox(box)},${expression})`;
  }
  return expression;
}

function dynamicRegionPixels(group, videoWidth, videoHeight) {
  const widthPercent = Math.max(...group.boxes.map((box) => box.width));
  const heightPercent = Math.max(...group.boxes.map((box) => box.height));
  const pixels = regionPixels({ x: 0, y: 0, width: widthPercent, height: heightPercent }, videoWidth, videoHeight);
  const positionFor = (box) => {
    const centerX = videoWidth * (box.x + box.width / 2) / 100;
    const centerY = videoHeight * (box.y + box.height / 2) / 100;
    return {
      x: Math.max(0, Math.min(videoWidth - pixels.width, Math.round(centerX - pixels.width / 2))),
      y: Math.max(0, Math.min(videoHeight - pixels.height, Math.round(centerY - pixels.height / 2)))
    };
  };
  return {
    ...pixels,
    xExpression: nestedTimeExpression(group.boxes, (box) => positionFor(box).x),
    yExpression: nestedTimeExpression(group.boxes, (box) => positionFor(box).y)
  };
}

function buildTimedBlurFilterGraph(options = {}) {
  const videoWidth = Math.max(2, Math.trunc(finiteNumber(options.videoWidth, 1920)));
  const videoHeight = Math.max(2, Math.trunc(finiteNumber(options.videoHeight, 1080)));
  const inputLabel = String(options.inputLabel || '0:v');
  const outputLabel = String(options.outputLabel || 'vout');
  const mirrored = options.mirrored === true;
  const maskStyle = normalizeMaskStyle(options.maskStyle);
  const maskColor = maskStyle === 'custom'
    ? normalizeOpaqueColor(options.maskColor)
    : DEFAULT_MASK_COLOR;
  const ffmpegMaskColor = `0x${maskColor.slice(1)}@1.0`;
  const sigma = Math.max(1, Math.trunc(finiteNumber(options.sigma, DEFAULT_SIGMA)));
  const manual = (Array.isArray(options.manualBoxes) ? options.manualBoxes : [])
    .map((box) => normalizeBlurBox(box, { mirrored }));
  const automaticGroups = maskStyle === 'blur'
    ? optimizeAutomaticOcrBlurBoxes(options.automaticBoxes, { ...options, mirrored })
    : [];
  const automaticSolidBoxes = maskStyle === 'blur'
    ? []
    : prepareAutomaticBlurBoxes(options.automaticBoxes, { ...options, mirrored });
  const filters = [];
  let current = inputLabel;
  let nodeIndex = 0;
  let groupedCount = 0;
  let perBoxAutomaticCount = 0;
  let solidFilterCount = 0;

  const appendSolidBox = (box, prefix) => {
    const pixels = regionPixels(box, videoWidth, videoHeight);
    const next = `${prefix}_solid_out_${nodeIndex}`;
    const enable = timeExpression([box]);
    filters.push(
      `[${current}]drawbox=x=${pixels.x}:y=${pixels.y}:w=${pixels.width}:h=${pixels.height}:color=${ffmpegMaskColor}:t=fill:enable='${enable}'[${next}]`
    );
    current = next;
    nodeIndex += 1;
    solidFilterCount += 1;
  };

  const appendManualBox = (box) => {
    const pixels = regionPixels(box, videoWidth, videoHeight);
    const original = `blur_orig_${nodeIndex}`;
    const copy = `blur_copy_${nodeIndex}`;
    const blurred = `blurred_${nodeIndex}`;
    const next = `blur_out_${nodeIndex}`;
    const maxLuma = Math.max(1, Math.floor(Math.min(pixels.width, pixels.height) / 2) - 1);
    const maxChroma = Math.max(1, Math.floor(Math.min(pixels.width / 2, pixels.height / 2) / 2) - 1);
    const luma = Math.min(box.radius, maxLuma);
    const chroma = Math.min(box.radius, maxChroma);
    const enable = timeExpression([box]);
    filters.push(`[${current}]split[${original}][${copy}]`);
    filters.push(`[${copy}]crop=${pixels.width}:${pixels.height}:${pixels.x}:${pixels.y},boxblur=lr=${luma}:cr=${chroma},format=yuv420p[${blurred}]`);
    filters.push(`[${original}][${blurred}]overlay=${pixels.x}:${pixels.y}:enable='${enable}'[${next}]`);
    current = next;
    nodeIndex += 1;
  };

  const appendAutomaticBox = (box) => {
    const pixels = regionPixels(box, videoWidth, videoHeight);
    const original = `ocr_orig_${nodeIndex}`;
    const copy = `ocr_copy_${nodeIndex}`;
    const blurred = `ocr_blurred_${nodeIndex}`;
    const next = `ocr_out_${nodeIndex}`;
    const enable = timeExpression([box]);
    filters.push(`[${current}]split=2[${original}][${copy}]`);
    filters.push(`[${copy}]crop=${pixels.width}:${pixels.height}:${pixels.x}:${pixels.y},gblur=sigma=${sigma}:steps=2:enable='${enable}',format=yuv420p[${blurred}]`);
    filters.push(`[${original}][${blurred}]overlay=${pixels.x}:${pixels.y}:enable='${enable}'[${next}]`);
    current = next;
    nodeIndex += 1;
    perBoxAutomaticCount += 1;
  };

  for (const box of manual) {
    if (maskStyle === 'blur') appendManualBox(box);
    else appendSolidBox(box, 'manual');
  }
  for (const box of automaticSolidBoxes) appendSolidBox(box, 'ocr');
  for (const group of automaticGroups) {
    if (group.mode !== 'dynamic') {
      for (const box of group.boxes) appendAutomaticBox(box);
      continue;
    }
    const pixels = dynamicRegionPixels(group, videoWidth, videoHeight);
    const original = `ocr_group_orig_${nodeIndex}`;
    const copy = `ocr_group_copy_${nodeIndex}`;
    const blurred = `ocr_group_blurred_${nodeIndex}`;
    const next = `ocr_group_out_${nodeIndex}`;
    const enable = timeExpression(group.boxes);
    filters.push(`[${current}]split=2[${original}][${copy}]`);
    filters.push(`[${copy}]crop=${pixels.width}:${pixels.height}:x='${pixels.xExpression}':y='${pixels.yExpression}',gblur=sigma=${sigma}:steps=2:enable='${enable}',format=yuv420p[${blurred}]`);
    filters.push(`[${original}][${blurred}]overlay=x='${pixels.xExpression}':y='${pixels.yExpression}':eval=frame:enable='${enable}'[${next}]`);
    current = next;
    nodeIndex += 1;
    groupedCount += 1;
  }

  if (filters.length > 0) filters.push(`[${current}]null[${outputLabel}]`);
  return {
    filter: filters.join(';'),
    stats: {
      manualCount: manual.length,
      automaticCount: maskStyle === 'blur'
        ? automaticGroups.reduce((sum, group) => sum + group.boxes.length, 0)
        : automaticSolidBoxes.length,
      automaticGroupCount: automaticGroups.length,
      groupedFilterCount: groupedCount,
      perBoxAutomaticCount,
      bridgedGapCount: (maskStyle === 'blur'
        ? automaticGroups.flatMap((group) => group.boxes)
        : automaticSolidBoxes
      ).filter((box) => box.timingAdjustment === 'continuous_gap').length,
      maskStyle,
      maskColor,
      solidFilterCount,
      filterNodeCount: nodeIndex
    }
  };
}

module.exports = {
  buildTimedBlurFilterGraph,
  groupedRegion,
  normalizeMaskStyle,
  normalizeOpaqueColor,
  normalizeBlurBox,
  optimizeAutomaticOcrBlurBoxes,
  prepareAutomaticBlurBoxes
};
