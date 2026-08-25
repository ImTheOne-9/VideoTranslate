const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  OcrComponentRequiredError,
  resolveAutomaticSubtitle
} = require('../lib/subtitle-source-helper');
const { OcrTechnicalError } = require('../lib/vse-helper');
const { evaluateAndCleanSrt } = require('../lib/subtitle-quality');

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-source-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function createOptions(directory, overrides = {}) {
  return {
    videoPath: path.join(directory, 'Nguon co dau', 'Nguoi dep.mp4'),
    workDir: path.join(directory, 'Thu muc OCR'),
    ffmpegPath: 'C:\\Cong cu\\ffmpeg.exe',
    durationMs: 12_345,
    whisperModel: 'small',
    whisperOnnxVariant: 'q8',
    ocrLanguage: 'vi',
    ocrMode: 'auto',
    ...overrides
  };
}

function createDependencies(overrides = {}) {
  return {
    getOcrComponentStatus: () => ({
      status: 'ready',
      version: '1.0.0',
      supportedLanguages: ['vi', 'en'],
      error: null
    }),
    getOcrExecutablePath: () => 'C:\\Cong cu OCR\\vse-cli.exe',
    detectOcrDevice: () => 'gpu',
    runVse: async () => ({ kind: 'success', result: null }),
    evaluateAndCleanSrt: async (rawPath, cleanPath) => ({
      accepted: true,
      path: cleanPath,
      cueCount: 3,
      distinctCueCount: 3,
      removedRepeatedLines: [],
      reason: 'accepted'
    }),
    extractAudioAndTranscribe: async () => {
      throw new Error('unexpected Whisper call');
    },
    ...overrides
  };
}

function technicalError(message, retryableOnCpu = false) {
  const error = new OcrTechnicalError(message);
  if (retryableOnCpu) error.retryableOnCpu = true;
  return error;
}

test('force Whisper skips every OCR dependency and preserves exact Whisper argument order', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory, {
      forceWhisper: true,
      ocrRegion: 'not,a,valid,region'
    });
    const whisperCalls = [];
    const failIfCalled = () => {
      throw new Error('OCR dependency must be skipped');
    };
    const dependencies = createDependencies({
      getOcrComponentStatus: failIfCalled,
      getOcrExecutablePath: failIfCalled,
      detectOcrDevice: failIfCalled,
      runVse: failIfCalled,
      evaluateAndCleanSrt: failIfCalled,
      extractAudioAndTranscribe: async (...args) => {
        whisperCalls.push(args);
        assert.equal((await fs.stat(options.workDir)).isDirectory(), true);
        return path.join(options.workDir, 'whisper.srt');
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);

    assert.deepEqual(whisperCalls, [[
      options.videoPath,
      options.workDir,
      options.ffmpegPath,
      options.whisperModel,
      options.durationMs,
      options.ocrLanguage,
      options.whisperOnnxVariant,
      undefined,
      'segment',
      'auto',
      'faster-whisper'
    ]]);
    assert.deepEqual(result, {
      path: path.join(options.workDir, 'whisper.srt'),
      source: 'whisper',
      language: 'vi',
      cueCount: 0,
      removedWatermarks: 0,
      reason: 'forced_whisper'
    });
  });
});

test('missing or corrupt component state throws the typed component-required error', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const cases = [
      createDependencies({
        getOcrComponentStatus: () => ({ status: 'not_installed', supportedLanguages: [] })
      }),
      createDependencies({
        getOcrComponentStatus: () => ({ status: 'error', supportedLanguages: ['vi'] })
      }),
      createDependencies({ getOcrExecutablePath: () => '' }),
      createDependencies({ getOcrExecutablePath: () => null })
    ];

    for (const dependencies of cases) {
      await assert.rejects(
        resolveAutomaticSubtitle(options, dependencies),
        (error) => {
          assert.equal(error instanceof OcrComponentRequiredError, true);
          assert.equal(error.code, 'OCR_COMPONENT_REQUIRED');
          return true;
        }
      );
    }
  });
});

test('unsupported OCR language is rejected as invalid options before device detection', async () => {
  await withTempDirectory(async (directory) => {
    let detected = false;
    const dependencies = createDependencies({
      detectOcrDevice: () => {
        detected = true;
        return 'gpu';
      }
    });

    await assert.rejects(
      resolveAutomaticSubtitle(createOptions(directory, { ocrLanguage: 'fr' }), dependencies),
      (error) => {
        assert.equal(error.code, 'OCR_INVALID_OPTIONS');
        assert.equal(error instanceof OcrComponentRequiredError, false);
        assert.equal(error instanceof OcrTechnicalError, false);
        return true;
      }
    );
    assert.equal(detected, false);
  });
});

test('unsupported OCR mode is rejected before device detection', async () => {
  await withTempDirectory(async (directory) => {
    let detected = false;
    const dependencies = createDependencies({
      detectOcrDevice: () => {
        detected = true;
        return 'gpu';
      }
    });

    await assert.rejects(
      resolveAutomaticSubtitle(createOptions(directory, { ocrMode: 'precise' }), dependencies),
      (error) => {
        assert.equal(error.code, 'OCR_INVALID_OPTIONS');
        assert.match(error.message, /mode/i);
        return true;
      }
    );
    assert.equal(detected, false);
  });
});

test('OCR mode defaults to auto and forwards explicit modes to VSE', async () => {
  await withTempDirectory(async (directory) => {
    const seenModes = [];
    const dependencies = createDependencies({
      runVse: async (options) => {
        seenModes.push(options.mode);
        return { kind: 'no_subtitles' };
      },
      extractAudioAndTranscribe: async (videoPath, workDir) => path.join(workDir, 'whisper.srt')
    });

    await resolveAutomaticSubtitle(createOptions(directory, { ocrMode: undefined }), dependencies);
    await resolveAutomaticSubtitle(createOptions(directory, { ocrMode: 'fast' }), dependencies);
    await resolveAutomaticSubtitle(createOptions(directory, { ocrMode: 'accurate' }), dependencies);

    assert.deepEqual(seenModes, ['auto', 'fast', 'accurate']);
  });
});

test('invalid OCR regions are rejected as invalid options', async () => {
  await withTempDirectory(async (directory) => {
    const invalidRegions = [
      '0.7,0.98,0.05',
      '0.7,nope,0.05,0.95',
      '0.7,1.01,0.05,0.95',
      '-0.1,0.98,0.05,0.95',
      '0.9,0.7,0.05,0.95',
      '0.7,0.98,0.95,0.05',
      [0.7, 0.98, 0.05],
      [0.7, Infinity, 0.05, 0.95],
      { top: 0.7, bottom: 0.98, left: 0.05, right: 0.95 }
    ];

    for (const ocrRegion of invalidRegions) {
      await assert.rejects(
        resolveAutomaticSubtitle(createOptions(directory, { ocrRegion }), createDependencies()),
        (error) => {
          assert.equal(error.code, 'OCR_INVALID_OPTIONS', JSON.stringify(ocrRegion));
          return true;
        }
      );
    }
  });
});

test('default and explicit OCR regions reach VSE as normalized comma strings', async () => {
  await withTempDirectory(async (directory) => {
    const seenRegions = [];
    const dependencies = createDependencies({
      runVse: async (options) => {
        seenRegions.push(options.region);
        return { kind: 'no_subtitles' };
      },
      extractAudioAndTranscribe: async (videoPath, workDir) => path.join(workDir, 'whisper.srt')
    });

    await resolveAutomaticSubtitle(createOptions(directory), dependencies);
    await resolveAutomaticSubtitle(
      createOptions(directory, { ocrRegion: ' 0.6, 0.9, 0.1, 0.8 ' }),
      dependencies
    );
    await resolveAutomaticSubtitle(
      createOptions(directory, { ocrRegion: [0.55, 0.95, 0.12, 0.88] }),
      dependencies
    );

    assert.deepEqual(seenRegions, [
      '0.70,0.98,0.05,0.95',
      '0.6,0.9,0.1,0.8',
      '0.55,0.95,0.12,0.88'
    ]);
  });
});

test('all OCR paths are contained in workDir even for a spaced Vietnamese source path', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory, {
      videoPath: path.join(directory, 'Video nguồn tiếng Việt', 'Người đẹp ở Hà Nội.mp4'),
      workDir: path.join(directory, 'Kết quả tạm', 'Phụ đề OCR')
    });
    const vseCalls = [];
    const qualityCalls = [];
    const dependencies = createDependencies({
      runVse: async (vseOptions) => {
        vseCalls.push(vseOptions);
        return { kind: 'success' };
      },
      evaluateAndCleanSrt: async (...args) => {
        qualityCalls.push(args);
        return {
          accepted: true,
          path: args[1],
          cueCount: 4,
          removedRepeatedLines: []
        };
      }
    });

    await resolveAutomaticSubtitle(options, dependencies);

    const rawPath = path.join(options.workDir, 'ocr-raw.srt');
    const cleanPath = path.join(options.workDir, 'ocr-clean.srt');
    assert.equal((await fs.stat(options.workDir)).isDirectory(), true);
    assert.equal(vseCalls.length, 1);
    assert.equal(vseCalls[0].videoPath, options.videoPath);
    assert.equal(vseCalls[0].outputPath, rawPath);
    assert.equal(vseCalls[0].cwd, options.workDir);
    assert.deepEqual(qualityCalls, [[rawPath, cleanPath]]);
    for (const outputPath of [vseCalls[0].outputPath, ...qualityCalls[0]]) {
      assert.equal(path.relative(options.workDir, outputPath).startsWith('..'), false);
    }
    assert.equal(rawPath.startsWith(path.dirname(options.videoPath)), false);
  });
});

test('accepted OCR quality returns cleaned metadata and never calls Whisper', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    let whisperCalled = false;
    const dependencies = createDependencies({
      evaluateAndCleanSrt: async (rawPath, cleanPath) => ({
        accepted: true,
        path: cleanPath,
        cueCount: 7,
        removedRepeatedLines: ['AUTO CAPTION', 'Channel watermark']
      }),
      extractAudioAndTranscribe: async () => {
        whisperCalled = true;
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);

    assert.deepEqual(result, {
      path: path.join(options.workDir, 'ocr-clean.srt'),
      source: 'ocr',
      language: 'vi',
      cueCount: 7,
      removedWatermarks: 2,
      reason: 'ocr_accepted'
    });
    assert.equal(whisperCalled, false);
  });
});

test('attempts intro recovery after VSE succeeds and before OCR quality validation', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const order = [];
    let recoveryOptions;
    const dependencies = createDependencies({
      runVse: async () => {
        order.push('vse');
        return { kind: 'success' };
      },
      recoverMissingIntroCue: async (received) => {
        order.push('recovery');
        recoveryOptions = received;
        return { recovered: true, recoveredCueCount: 1 };
      },
      evaluateAndCleanSrt: async (rawPath, cleanPath) => {
        order.push('quality');
        return {
          accepted: true,
          path: cleanPath,
          cueCount: 3,
          removedRepeatedLines: []
        };
      }
    });

    await resolveAutomaticSubtitle(options, dependencies);

    assert.deepEqual(order, ['vse', 'recovery', 'quality']);
    assert.equal(recoveryOptions.rawPath, path.join(options.workDir, 'ocr-raw.srt'));
    assert.equal(recoveryOptions.videoPath, options.videoPath);
    assert.equal(recoveryOptions.ffmpegPath, options.ffmpegPath);
    assert.equal(recoveryOptions.device, 'gpu');
    assert.equal(recoveryOptions.runVse, dependencies.runVse);
  });
});

test('VSE no-subtitles result falls back to Whisper', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const whisperCalls = [];
    const dependencies = createDependencies({
      runVse: async () => ({ kind: 'no_subtitles' }),
      evaluateAndCleanSrt: async () => {
        throw new Error('quality gate must be skipped');
      },
      extractAudioAndTranscribe: async (...args) => {
        whisperCalls.push(args);
        return path.join(options.workDir, 'fallback.srt');
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);

    assert.deepEqual(whisperCalls, [[
      options.videoPath,
      options.workDir,
      options.ffmpegPath,
      options.whisperModel,
      options.durationMs,
      options.ocrLanguage,
      options.whisperOnnxVariant,
      undefined,
      'segment',
      'auto',
      'faster-whisper'
    ]]);
    assert.deepEqual(result, {
      path: path.join(options.workDir, 'fallback.srt'),
      source: 'whisper',
      language: 'vi',
      cueCount: 0,
      removedWatermarks: 0,
      reason: 'no_hardsub'
    });
  });
});

test('automatic region scan recovers subtitles outside the selected lower region and writes metadata', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory, {
      durationMs: 180_000,
      ocrRegionStrategy: 'auto'
    });
    const seenRegions = [];
    const dependencies = createDependencies({
      recoverMissingIntroCue: async () => ({ recovered: false }),
      evaluateAndCleanSrt,
      runVse: async ({ region, outputPath }) => {
        seenRegions.push(region);
        if (region !== '0.45,0.78,0.03,0.97') return { kind: 'no_subtitles' };
        await fs.writeFile(outputPath, [
          '1', '00:00:01,000 --> 00:00:02,000', 'Dòng thứ nhất', '',
          '2', '00:00:03,000 --> 00:00:04,000', 'Dòng thứ hai', '',
          '3', '00:00:05,000 --> 00:00:06,000', 'Dòng thứ ba', ''
        ].join('\n'), 'utf8');
        return { kind: 'success' };
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);
    const report = JSON.parse(await fs.readFile(path.join(options.workDir, 'ocr-report.json'), 'utf8'));

    assert.equal(result.source, 'ocr');
    assert.equal(result.cueCount, 3);
    assert.equal(seenRegions.length, 5);
    assert.equal(report.strategy, 'auto');
    assert.equal(report.selectedRegion, '0.45,0.78,0.03,0.97');
    assert.equal(report.blurBoxes.length, 3);
  });
});

test('RapidOCR pipeline is used directly for Chinese OCR and keeps its exact cleaned SRT', async () => {
  await withTempDirectory(async (directory) => {
    const excludedRegions = [{ x0: 0, y0: 0, x1: 0.2, y1: 0.1, t0: 0, t1: 0 }];
    const options = createOptions(directory, {
      ocrLanguage: 'ch',
      ocrPipeline: 'viral',
      ocrExcludedRegions: excludedRegions
    });
    let vseCalled = false;
    const dependencies = createDependencies({
      getOcrComponentStatus: () => ({ status: 'ready', supportedLanguages: ['ch'] }),
      detectOcrDevice: () => { throw new Error('RapidOCR must not use VSE auto-device detection'); },
      runVse: async () => { vseCalled = true; },
      runViralOcr: async ({ outputPath, reportPath, model, device, excludedRegions: receivedRegions }) => {
        assert.equal(model, 'v6-small');
        assert.equal(device, 'cpu');
        assert.deepEqual(receivedRegions, excludedRegions);
        await fs.writeFile(outputPath, '1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句\n\n3\n00:00:02,000 --> 00:00:03,000\n第三句\n', 'utf8');
        await fs.writeFile(reportPath, JSON.stringify({ cueCount: 3, blurBoxes: [{ start: 0, end: 3 }] }), 'utf8');
        return { kind: 'success' };
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);
    assert.equal(result.reason, 'viral_ocr_accepted');
    assert.equal(result.cueCount, 3);
    assert.equal(vseCalled, false);
    assert.match(await fs.readFile(result.path, 'utf8'), /第一句/);
  });
});

test('automatic OCR routes Chinese subtitles to RapidOCR without requiring a manual region', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory, {
      ocrLanguage: 'ch',
      ocrPipeline: 'auto',
      ocrRegion: 'this,is,not,a,region'
    });
    let vseCalled = false;
    const dependencies = createDependencies({
      runVse: async () => { vseCalled = true; },
      runViralOcr: async ({ outputPath, reportPath }) => {
        await fs.writeFile(outputPath, '1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句\n\n3\n00:00:02,000 --> 00:00:03,000\n第三句\n', 'utf8');
        await fs.writeFile(reportPath, JSON.stringify({ cueCount: 3, blurBoxes: [] }), 'utf8');
        return { kind: 'success' };
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);
    assert.equal(result.reason, 'viral_ocr_accepted');
    assert.equal(vseCalled, false);
  });
});

test('explicit VSE keeps Chinese OCR inside the selected region', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory, { ocrLanguage: 'ch', ocrPipeline: 'vse' });
    const seenRegions = [];
    let viralCalled = false;
    const dependencies = createDependencies({
      getOcrComponentStatus: () => ({ status: 'ready', supportedLanguages: ['ch'] }),
      runVse: async ({ region, outputPath }) => {
        seenRegions.push(region);
        await fs.writeFile(outputPath, '1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句\n\n3\n00:00:02,000 --> 00:00:03,000\n第三句\n', 'utf8');
        return { kind: 'success' };
      },
      runViralOcr: async () => { viralCalled = true; }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);
    assert.equal(result.reason, 'ocr_accepted');
    assert.deepEqual(seenRegions, ['0.70,0.98,0.05,0.95']);
    assert.equal(viralCalled, false);
  });
});

test('explicit RapidOCR rejects non-Chinese before starting an OCR engine', async () => {
  await withTempDirectory(async (directory) => {
    let called = false;
    const dependencies = createDependencies({
      runVse: async () => { called = true; },
      runViralOcr: async () => { called = true; }
    });
    await assert.rejects(
      resolveAutomaticSubtitle(createOptions(directory, { ocrPipeline: 'viral' }), dependencies),
      (error) => error?.code === 'OCR_INVALID_OPTIONS' && /RapidOCR.*tiếng Trung/i.test(error.message)
    );
    assert.equal(called, false);
  });
});

test('RapidOCR boxes survive Whisper text fallback when fewer than three OCR cues are read', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory, { ocrLanguage: 'ch', ocrPipeline: 'viral' });
    const dependencies = createDependencies({
      getOcrComponentStatus: () => ({ status: 'ready', supportedLanguages: ['ch'] }),
      runViralOcr: async ({ outputPath, reportPath }) => {
        await fs.writeFile(outputPath, '1\n00:00:00,000 --> 00:00:01,000\n一句\n', 'utf8');
        await fs.writeFile(reportPath, JSON.stringify({ cueCount: 1, blurBoxes: [{ start: 0, end: 1 }] }), 'utf8');
        return { kind: 'success' };
      },
      extractAudioAndTranscribe: async (videoPath, workDir) => path.join(workDir, 'whisper.srt')
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);
    const report = JSON.parse(await fs.readFile(path.join(options.workDir, 'ocr-report.json'), 'utf8'));
    assert.equal(result.source, 'whisper');
    assert.equal(result.reason, 'ocr_quality_rejected');
    assert.equal(report.blurBoxes.length, 1);
  });
});

test('OCR-only mode never falls back to Whisper when no subtitles are found', async () => {
  await withTempDirectory(async (directory) => {
    let whisperCalled = false;
    const dependencies = createDependencies({
      runVse: async () => ({ kind: 'no_subtitles' }),
      extractAudioAndTranscribe: async () => {
        whisperCalled = true;
      }
    });

    await assert.rejects(
      resolveAutomaticSubtitle(createOptions(directory, { ocrOnly: true }), dependencies),
      (error) => error?.code === 'OCR_NO_SUBTITLES'
    );
    assert.equal(whisperCalled, false);
  });
});

test('rejected OCR quality falls back to Whisper', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const dependencies = createDependencies({
      evaluateAndCleanSrt: async () => ({
        accepted: false,
        path: null,
        cueCount: 1,
        removedRepeatedLines: []
      }),
      extractAudioAndTranscribe: async () => path.join(options.workDir, 'quality-fallback.srt')
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);

    assert.equal(result.source, 'whisper');
    assert.equal(result.reason, 'ocr_quality_rejected');
    assert.equal(result.path, path.join(options.workDir, 'quality-fallback.srt'));
    assert.equal(result.cueCount, 0);
    assert.equal(result.removedWatermarks, 0);
  });
});

test('OCR-only mode rejects low-quality OCR without invoking Whisper', async () => {
  await withTempDirectory(async (directory) => {
    let whisperCalled = false;
    const dependencies = createDependencies({
      evaluateAndCleanSrt: async () => ({ accepted: false, cueCount: 1 }),
      extractAudioAndTranscribe: async () => {
        whisperCalled = true;
      }
    });

    await assert.rejects(
      resolveAutomaticSubtitle(createOptions(directory, { ocrOnly: true }), dependencies),
      (error) => error?.code === 'OCR_NO_SUBTITLES'
    );
    assert.equal(whisperCalled, false);
  });
});

test('retryable GPU failure retries VSE exactly once on CPU and accepts OCR', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const devices = [];
    const dependencies = createDependencies({
      runVse: async ({ device }) => {
        devices.push(device);
        if (device === 'gpu') throw technicalError('CUDA initialization failed', true);
        return { kind: 'success' };
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);

    assert.deepEqual(devices, ['gpu', 'cpu']);
    assert.equal(result.source, 'ocr');
    assert.equal(result.reason, 'ocr_accepted');
  });
});

test('CPU retry failure propagates the typed technical error and never calls Whisper', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const retryFailure = technicalError('CPU OCR failed');
    let calls = 0;
    let whisperCalled = false;
    const dependencies = createDependencies({
      runVse: async () => {
        calls += 1;
        if (calls === 1) throw technicalError('CUDA out of memory', true);
        throw retryFailure;
      },
      extractAudioAndTranscribe: async () => {
        whisperCalled = true;
      }
    });

    await assert.rejects(
      resolveAutomaticSubtitle(options, dependencies),
      (error) => error === retryFailure && error.code === 'OCR_TECHNICAL_ERROR'
    );
    assert.equal(calls, 2);
    assert.equal(whisperCalled, false);
  });
});

test('non-retryable technical failure propagates without Whisper or CPU retry', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const failure = technicalError('video decode failed');
    let vseCalls = 0;
    let whisperCalled = false;
    const dependencies = createDependencies({
      runVse: async () => {
        vseCalls += 1;
        throw failure;
      },
      extractAudioAndTranscribe: async () => {
        whisperCalled = true;
      }
    });

    await assert.rejects(resolveAutomaticSubtitle(options, dependencies), (error) => error === failure);
    assert.equal(vseCalls, 1);
    assert.equal(whisperCalled, false);
  });
});

test('stale raw and clean files are removed before the initial attempt and CPU retry', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory);
    const rawPath = path.join(options.workDir, 'ocr-raw.srt');
    const cleanPath = path.join(options.workDir, 'ocr-clean.srt');
    await fs.mkdir(options.workDir, { recursive: true });
    await fs.writeFile(rawPath, 'stale raw before first attempt');
    await fs.writeFile(cleanPath, 'stale clean before first attempt');
    let attempt = 0;
    const dependencies = createDependencies({
      runVse: async ({ outputPath, device }) => {
        attempt += 1;
        await assert.rejects(fs.stat(rawPath), { code: 'ENOENT' });
        await assert.rejects(fs.stat(cleanPath), { code: 'ENOENT' });
        assert.equal(outputPath, rawPath);
        if (attempt === 1) {
          await fs.writeFile(rawPath, 'stale raw from failed GPU attempt');
          await fs.writeFile(cleanPath, 'stale clean from failed GPU attempt');
          throw technicalError('CUDA driver failure', true);
        }
        assert.equal(device, 'cpu');
        await fs.writeFile(rawPath, 'fresh CPU OCR');
        return { kind: 'success' };
      }
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);

    assert.equal(attempt, 2);
    assert.equal(result.source, 'ocr');
  });
});

test('progress phases are stable and ordered across GPU retry and validation', async () => {
  await withTempDirectory(async (directory) => {
    const progress = [];
    const gpuDetail = { kind: 'progress', percent: 20 };
    const cpuDetail = { kind: 'progress', percent: 80 };
    const dependencies = createDependencies({
      runVse: async ({ device, onProgress }) => {
        onProgress(device === 'gpu' ? gpuDetail : cpuDetail);
        if (device === 'gpu') throw technicalError('CUDA initialization failed', true);
        return { kind: 'success' };
      }
    });

    await resolveAutomaticSubtitle(
      createOptions(directory, { onProgress: (event) => progress.push(event) }),
      dependencies
    );

    assert.deepEqual(progress, [
      { phase: 'ocr_starting' },
      { phase: 'ocr_processing' },
      { phase: 'ocr_processing', detail: gpuDetail },
      { phase: 'ocr_retry_cpu' },
      { phase: 'ocr_processing' },
      { phase: 'ocr_processing', detail: cpuDetail },
      { phase: 'ocr_validating' }
    ]);
  });
});

test('progress callback errors do not fail OCR fallback or Whisper generation', async () => {
  await withTempDirectory(async (directory) => {
    const options = createOptions(directory, {
      onProgress: () => {
        throw new Error('UI progress listener failed');
      }
    });
    const dependencies = createDependencies({
      runVse: async ({ onProgress }) => {
        onProgress({ kind: 'progress', percent: 50 });
        return { kind: 'no_subtitles' };
      },
      extractAudioAndTranscribe: async (videoPath, workDir) => path.join(workDir, 'isolated.srt')
    });

    const result = await resolveAutomaticSubtitle(options, dependencies);

    assert.equal(result.path, path.join(options.workDir, 'isolated.srt'));
    assert.equal(result.reason, 'no_hardsub');
  });
});
