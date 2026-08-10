const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ATTEMPTS = 3;

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function normalizePhone(value) {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('0')) return `84${digits.slice(1)}`;
  return digits;
}

function hashSHA256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildUserData({ clientIp, userAgent, userEmail, userPhone, externalId, fbp, fbc }) {
  return compactObject({
    client_ip_address: clientIp,
    client_user_agent: userAgent,
    em: userEmail ? [hashSHA256(normalizeEmail(userEmail))] : undefined,
    ph: userPhone ? [hashSHA256(normalizePhone(userPhone))] : undefined,
    external_id: externalId ? [hashSHA256(String(externalId).trim().toLowerCase())] : undefined,
    fbp,
    fbc
  });
}

function buildCustomData({ amount, planName, planId, orderId }) {
  const numericAmount = Number(amount);
  return compactObject({
    currency: Number.isFinite(numericAmount) ? 'VND' : undefined,
    value: Number.isFinite(numericAmount) ? numericAmount : undefined,
    content_name: planName,
    content_ids: planId ? [String(planId)] : undefined,
    content_type: planId ? 'product' : undefined,
    order_id: orderId
  });
}

async function sendCapiEvent(params) {
  const {
    eventName,
    eventId,
    eventSourceUrl,
    amount,
    planName,
    planId,
    orderId,
    clientIp,
    userAgent,
    userEmail,
    userPhone,
    externalId,
    fbp,
    fbc,
    pixelId: customPixelId,
    accessToken: customAccessToken
  } = params;

  const pixelId = customPixelId || process.env.META_PIXEL_ID || '1048557318333738';
  const accessToken = customAccessToken || process.env.META_CAPI_ACCESS_TOKEN;
  if (!accessToken) {
    return { success: false, skipped: true, reason: 'META_CAPI_ACCESS_TOKEN not configured' };
  }

  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v26.0';
  const timeoutMs = Math.max(1000, Number(process.env.META_CAPI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const maxAttempts = Math.min(5, Math.max(1, Number(process.env.META_CAPI_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS));
  const eventData = compactObject({
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: eventSourceUrl,
    action_source: 'website',
    user_data: buildUserData({ clientIp, userAgent, userEmail, userPhone, externalId, fbp, fbc }),
    custom_data: buildCustomData({ amount, planName, planId, orderId })
  });
  const requestBody = { data: [eventData] };
  if (process.env.META_TEST_EVENT_CODE) requestBody.test_event_code = process.env.META_TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pixelId)}/events`;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { success: true, attempts: attempt, data };

      lastError = { status: response.status, data };
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = { error: error.name === 'AbortError' ? 'Meta CAPI timeout' : error.message };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) await sleep(250 * (2 ** (attempt - 1)));
  }

  console.error('[Meta CAPI Error]', JSON.stringify(lastError));
  return { success: false, attempts: maxAttempts, ...lastError };
}

module.exports = {
  sendCapiEvent,
  hashSHA256,
  normalizeEmail,
  normalizePhone,
  buildUserData,
  buildCustomData
};
