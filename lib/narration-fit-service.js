const { planSmartFit } = require('./smart-fit-service');

class NarrationFitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NarrationFitError';
    this.code = 'NARRATION_TOO_LONG';
    this.details = details;
  }
}

async function generateNarrationWithinCue(options = {}) {
  const originalText = String(options.initialText || '').trim();
  let text = originalText;
  let attempt = 0;
  let lastResult = null;

  while (true) {
    const signature = options.createSignature(text);
    const reusable = attempt === 0 && options.isReusable?.(signature) === true;
    if (!reusable) await options.synthesize(text, signature, attempt);
    const rawDurationMs = await options.measureDuration();
    const fitPlan = planSmartFit({
      mode: 'cue',
      startMs: options.startMs,
      endMs: options.endMs,
      rawDurationMs
    });
    lastResult = { text, signature, rawDurationMs, fitPlan, attempts: attempt };
    if (fitPlan.status !== 'rewrite_recommended') {
      return {
        ...lastResult,
        originalText,
        shortened: attempt > 0
      };
    }
    await options.onShortening?.({
      text,
      attempt: attempt + 1,
      currentDurationMs: rawDurationMs,
      targetDurationMs: fitPlan.baseAvailableMs * fitPlan.maxSpeed,
      fitPlan
    });
    const shortenedText = String(await options.shortenText({
      text,
      attempt: attempt + 1,
      currentDurationMs: rawDurationMs,
      targetDurationMs: fitPlan.baseAvailableMs * fitPlan.maxSpeed
    }) || '').trim();
    if (!shortenedText || shortenedText.length >= text.length) {
      throw new NarrationFitError(
        `AI không thể rút gọn thêm để giữ tốc độ tối đa ${fitPlan.maxSpeed.toFixed(1)}x`,
        lastResult
      );
    }
    text = shortenedText;
    attempt += 1;
  }
}

module.exports = {
  NarrationFitError,
  generateNarrationWithinCue
};
