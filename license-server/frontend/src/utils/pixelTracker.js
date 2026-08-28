const ATTRIBUTION_KEY = 'editnhanh_meta_attribution';
const pendingEvents = [];

function dispatchFbq(action, eventName, params, options) {
  if (Object.keys(options).length > 0) window.fbq(action, eventName, params, options);
  else if (Object.keys(params).length > 0) window.fbq(action, eventName, params);
  else window.fbq(action, eventName);
}

function safeFbq(action, eventName, params = {}, options = {}) {
  if (typeof window === 'undefined' || typeof window.fbq !== 'function') return;
  if (!window.__editnhanhMetaPixelId) {
    pendingEvents.push({ action, eventName, params, options });
    return;
  }
  try {
    dispatchFbq(action, eventName, params, options);
  } catch (error) {
    console.warn('[Meta Pixel Warning]', error);
  }
}

function readCookie(name) {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  const entry = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : '';
}

function clean(value, maxLength = 500) {
  return value ? String(value).trim().slice(0, maxLength) : '';
}

export function initMetaPixel(pixelId) {
  if (!pixelId || typeof window === 'undefined' || typeof window.fbq !== 'function') return false;
  if (window.__editnhanhMetaPixelId === String(pixelId)) return true;
  window.fbq('init', String(pixelId));
  window.fbq('track', 'PageView');
  window.__editnhanhMetaPixelId = String(pixelId);
  while (pendingEvents.length > 0) {
    const event = pendingEvents.shift();
    dispatchFbq(event.action, event.eventName, event.params, event.options);
  }
  captureMetaAttribution();
  return true;
}

export function captureMetaAttribution() {
  if (typeof window === 'undefined') return {};
  let stored = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(ATTRIBUTION_KEY) || '{}');
  } catch {}

  const query = new URLSearchParams(window.location.search);
  const fbclid = clean(query.get('fbclid'), 255);
  const generatedFbc = fbclid ? `fb.1.${Date.now()}.${fbclid}` : '';
  const attribution = {
    fbp: readCookie('_fbp') || stored.fbp || '',
    fbc: readCookie('_fbc') || stored.fbc || generatedFbc,
    eventSourceUrl: clean(stored.eventSourceUrl || window.location.href),
    referrer: clean(stored.referrer || document.referrer),
    utmSource: clean(stored.utmSource || query.get('utm_source'), 120),
    utmMedium: clean(stored.utmMedium || query.get('utm_medium'), 120),
    utmCampaign: clean(stored.utmCampaign || query.get('utm_campaign'), 160),
    utmContent: clean(stored.utmContent || query.get('utm_content'), 160),
    utmTerm: clean(stored.utmTerm || query.get('utm_term'), 160)
  };
  try {
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(attribution));
  } catch {}
  return attribution;
}

export function getMetaAttribution() {
  return captureMetaAttribution();
}

export function trackRegistration(eventId) {
  safeFbq('track', 'CompleteRegistration', {
    content_name: 'Tài khoản Editnhanh',
    status: true
  }, eventId ? { eventID: String(eventId) } : {});
}

export function trackDownloadApp() {
  safeFbq('trackCustom', 'DownloadApp', {
    content_name: 'Bộ cài Editnhanh Windows',
    file_type: 'exe'
  });
}

export function trackInitiateCheckout(planName, price, planId) {
  safeFbq('track', 'InitiateCheckout', {
    content_name: planName || 'Gói Bản Quyền Editnhanh',
    content_ids: planId ? [String(planId)] : undefined,
    content_type: planId ? 'product' : undefined,
    value: Number(price) || 0,
    currency: 'VND'
  });
}

export function trackPurchase(planName, price, eventId, planId) {
  safeFbq('track', 'Purchase', {
    content_name: planName || 'Bản Quyền Editnhanh',
    content_ids: planId ? [String(planId)] : undefined,
    content_type: planId ? 'product' : undefined,
    value: Number(price) || 0,
    currency: 'VND',
    order_id: eventId || undefined
  }, eventId ? { eventID: String(eventId) } : {});
}

export function trackLogin() {
  safeFbq('trackCustom', 'Login', { content_name: 'Đăng nhập Editnhanh', method: 'Password' });
}

export function trackViewContent(contentName = 'Bảng giá Editnhanh') {
  safeFbq('track', 'ViewContent', { content_name: contentName, content_type: 'product_group' });
}

export function trackContact(channelName = 'Zalo Support') {
  safeFbq('track', 'Contact', { content_name: channelName });
}

export function trackCopyLicenseKey() {
  safeFbq('trackCustom', 'CopyLicenseKey', { content_name: 'Sao chép License Key' });
}
