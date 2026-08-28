'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNvencEncoderArgs,
  buildX264EncoderArgs,
  buildNvencProbeArgs,
  replaceVideoEncoderArgs,
  resolveStudioVideoEncoder,
  clearNvencProbeCache
} = require('../lib/studio-video-encoder');

test('Studio NVENC giữ CQ 23 và bật đầy đủ cờ chất lượng', () => {
  const nvenc = buildNvencEncoderArgs();
  assert.deepStrictEqual(nvenc, [
    '-c:v', 'h264_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '23', '-b:v', '0',
    '-tune', 'hq', '-spatial-aq', '1', '-aq-strength', '8', '-rc-lookahead', '20',
    '-profile:v', 'high', '-g', '60', '-pix_fmt', 'yuv420p'
  ]);

});

test('Studio x264 fallback có cấu hình chất lượng và tương thích rõ ràng', () => {
  const x264 = buildX264EncoderArgs();
  assert.deepStrictEqual(x264, [
    '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
    '-profile:v', 'high', '-g', '60', '-pix_fmt', 'yuv420p'
  ]);

});

test('Thay khối NVENC bằng x264 không để sót tùy chọn riêng của GPU', () => {
  const nvenc = buildNvencEncoderArgs();
  const x264 = buildX264EncoderArgs();
  const original = ['-i', 'in.mp4', '-c:a', 'aac', ...nvenc, '-movflags', '+faststart', '-y', 'out.mp4'];
  const replaced = replaceVideoEncoderArgs(original, x264);
  assert.deepStrictEqual(replaced, [
    '-i', 'in.mp4', '-c:a', 'aac', ...x264, '-movflags', '+faststart', '-y', 'out.mp4'
  ]);
  assert.strictEqual(replaced.includes('spatial-aq'), false);
  assert.strictEqual(replaced.includes('h264_nvenc'), false);

});

test('Probe NVENC dùng nguồn hình nhỏ và không tạo file', () => {
  const probe = buildNvencProbeArgs(buildNvencEncoderArgs());
  assert.strictEqual(probe.includes('color=c=black:s=256x256:d=0.2'), true);
  assert.strictEqual(probe.at(-1), '-');

});

test('Probe đầy đủ thành công được cache theo FFmpeg runtime', async () => {
  clearNvencProbeCache();
  let calls = 0;
  const full = await resolveStudioVideoEncoder({
    hasCUDA: true,
    ffmpegPath: 'ffmpeg-full-test',
    runExecFile: async () => { calls += 1; }
  });
  assert.strictEqual(full.kind, 'nvenc');
  assert.strictEqual(full.advanced, true);
  assert.strictEqual(calls, 1);
  await resolveStudioVideoEncoder({
    hasCUDA: true,
    ffmpegPath: 'ffmpeg-full-test',
    runExecFile: async () => { calls += 1; }
  });
  assert.strictEqual(calls, 1, 'kết quả probe thành công phải được cache');

});

test('Driver không nhận AQ sẽ lùi về NVENC tương thích nhưng vẫn giữ CQ 23 và b:v 0', async () => {
  clearNvencProbeCache();
  const attempted = [];
  const compatible = await resolveStudioVideoEncoder({
    hasCUDA: true,
    ffmpegPath: 'ffmpeg-compatible-test',
    runExecFile: async (_command, args) => {
      attempted.push(args);
      if (args.includes('-spatial-aq')) throw new Error('unsupported option');
    }
  });
  assert.strictEqual(compatible.kind, 'nvenc');
  assert.strictEqual(compatible.advanced, false);
  assert.strictEqual(compatible.args.includes('-b:v'), true);
  assert.strictEqual(compatible.args.includes('-spatial-aq'), false);
  assert.strictEqual(attempted.length, 2);

});

test('Máy không CUDA dùng x264 CRF 23', async () => {
  const cpu = await resolveStudioVideoEncoder({ hasCUDA: false });
  assert.strictEqual(cpu.kind, 'x264');
  assert.deepStrictEqual(cpu.args, buildX264EncoderArgs());
});
