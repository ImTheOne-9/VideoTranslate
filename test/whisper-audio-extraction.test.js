const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractWhisperAudioWithFallback,
  WHISPER_AUDIO_FILTER,
  WHISPER_AUDIO_SAFE_FILTER
} = require('../lib/whisper-helper');

test('Whisper audio extraction retries without anlmdn after an FFmpeg crash', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-audio-fallback-'));
  try {
    const audioPath = path.join(directory, 'audio.wav');
    const calls = [];
    let fallbackError;
    const result = await extractWhisperAudioWithFallback({
      ffmpegPath: 'ffmpeg.exe', videoPath: 'source.mp4', audioPath,
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        if (calls.length === 1) {
          fs.writeFileSync(audioPath, 'partial');
          throw Object.assign(new Error('FFmpeg crashed'), { code: -1073741819, stderr: 'progress before crash' });
        }
        assert.equal(fs.existsSync(audioPath), false);
        fs.writeFileSync(audioPath, 'complete');
      },
      onFallback: (error) => { fallbackError = error; }
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[calls[0].args.indexOf('-af') + 1], WHISPER_AUDIO_FILTER);
    assert.equal(calls[1].args[calls[1].args.indexOf('-af') + 1], WHISPER_AUDIO_SAFE_FILTER);
    assert.equal(result.fallbackUsed, true);
    assert.equal(fallbackError.code, -1073741819);
    assert.equal(fs.readFileSync(audioPath, 'utf8'), 'complete');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Whisper audio extraction does not retry a video without an audio stream', async () => {
  let calls = 0;
  await assert.rejects(
    extractWhisperAudioWithFallback({
      ffmpegPath: 'ffmpeg.exe', videoPath: 'silent.mp4', audioPath: path.join(os.tmpdir(), 'unused-audio.wav'),
      run: async () => {
        calls += 1;
        throw Object.assign(new Error('no audio'), { stderr: 'Output file does not contain any stream' });
      }
    }),
    /no audio/
  );
  assert.equal(calls, 1);
});

test('Whisper audio extraction does not retry cancellation or timeout', async () => {
  for (const message of ['Timeout sau 5 phút: ffmpeg.exe', 'Tiến trình bị hủy (signal=SIGKILL)']) {
    let calls = 0;
    await assert.rejects(
      extractWhisperAudioWithFallback({
        ffmpegPath: 'ffmpeg.exe', videoPath: 'source.mp4', audioPath: path.join(os.tmpdir(), 'unused-audio.wav'),
        run: async () => { calls += 1; throw new Error(message); }
      }),
      new RegExp(message.split(' ')[0])
    );
    assert.equal(calls, 1);
  }
});
