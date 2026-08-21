'use strict';

const NVENC_CQ = '23';
const NVENC_PRESET = 'p7';
const X264_CRF = '23';

const nvencProbeCache = new Map();

function buildNvencEncoderArgs(options = {}) {
  const advanced = options.advanced !== false;
  const args = [
    '-c:v', 'h264_nvenc',
    '-preset', NVENC_PRESET,
    '-rc', 'vbr',
    '-cq', NVENC_CQ,
    '-b:v', '0'
  ];
  if (advanced) {
    args.push(
      '-tune', 'hq',
      '-spatial-aq', '1',
      '-aq-strength', '8',
      '-rc-lookahead', '20',
      '-profile:v', 'high',
      '-g', '60'
    );
  }
  args.push('-pix_fmt', 'yuv420p');
  return args;
}

function buildX264EncoderArgs() {
  return [
    '-c:v', 'libx264',
    '-crf', X264_CRF,
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-g', '60',
    '-pix_fmt', 'yuv420p'
  ];
}

function replaceVideoEncoderArgs(args, encoderArgs) {
  const output = Array.from(args || []);
  const start = output.lastIndexOf('-c:v');
  const end = output.indexOf('-movflags', start + 1);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Không tìm thấy khối encoder video trong lệnh FFmpeg');
  }
  output.splice(start, end - start, ...encoderArgs);
  return output;
}

function buildNvencProbeArgs(encoderArgs) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=256x256:d=0.2',
    ...encoderArgs,
    '-an',
    '-f', 'null',
    '-'
  ];
}

async function resolveStudioVideoEncoder(options = {}) {
  if (!options.hasCUDA) {
    return { kind: 'x264', advanced: false, args: buildX264EncoderArgs() };
  }

  const ffmpegPath = String(options.ffmpegPath || 'ffmpeg');
  const runExecFile = options.runExecFile;
  if (typeof runExecFile !== 'function') {
    return { kind: 'nvenc', advanced: true, args: buildNvencEncoderArgs() };
  }

  if (nvencProbeCache.has(ffmpegPath)) return nvencProbeCache.get(ffmpegPath);

  const fullArgs = buildNvencEncoderArgs({ advanced: true });
  try {
    await runExecFile(ffmpegPath, buildNvencProbeArgs(fullArgs), { timeout: 30000 });
    const result = { kind: 'nvenc', advanced: true, args: fullArgs };
    nvencProbeCache.set(ffmpegPath, result);
    return result;
  } catch (advancedError) {
    const compatibleArgs = buildNvencEncoderArgs({ advanced: false });
    try {
      await runExecFile(ffmpegPath, buildNvencProbeArgs(compatibleArgs), { timeout: 30000 });
      const result = {
        kind: 'nvenc',
        advanced: false,
        args: compatibleArgs,
        warning: `Driver NVENC không nhận AQ/High profile/GOP nâng cao: ${advancedError.message}`
      };
      nvencProbeCache.set(ffmpegPath, result);
      return result;
    } catch (baseError) {
      // Không cache thất bại để lần render sau có thể thử lại nếu GPU chỉ đang bận tạm thời.
      return {
        kind: 'nvenc',
        advanced: false,
        args: compatibleArgs,
        warning: `Không thể xác nhận NVENC trước khi render: ${baseError.message}`
      };
    }
  }
}

function clearNvencProbeCache() {
  nvencProbeCache.clear();
}

module.exports = {
  NVENC_CQ,
  buildNvencEncoderArgs,
  buildX264EncoderArgs,
  buildNvencProbeArgs,
  replaceVideoEncoderArgs,
  resolveStudioVideoEncoder,
  clearNvencProbeCache
};
