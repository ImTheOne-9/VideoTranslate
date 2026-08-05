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
  const signature = options.createSignature(originalText);
  const reusable = options.isReusable?.(signature) === true;
  if (!reusable) await options.synthesize(originalText, signature, 0);
  const rawDurationMs = await options.measureDuration();
  const fitPlan = planSmartFit({
    mode: 'cue',
    startMs: options.startMs,
    endMs: options.endMs,
    rawDurationMs
  });

  return {
    text: originalText,
    originalText,
    signature,
    rawDurationMs,
    fitPlan,
    attempts: 0,
    shortened: false
  };
}

module.exports = {
  NarrationFitError,
  generateNarrationWithinCue
};
