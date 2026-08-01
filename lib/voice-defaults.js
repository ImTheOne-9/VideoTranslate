'use strict';

const DEFAULT_OMNIVOICE_SEED = 42;

function resolveOmnivoiceSeed(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return String(DEFAULT_OMNIVOICE_SEED);
  }
  const seed = Number(value);
  return Number.isSafeInteger(seed) && seed >= 0
    ? String(seed)
    : String(DEFAULT_OMNIVOICE_SEED);
}

module.exports = {
  DEFAULT_OMNIVOICE_SEED,
  resolveOmnivoiceSeed
};
