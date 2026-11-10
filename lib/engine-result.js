'use strict';

/* Evaluator tunggal hasil engine (Edge-safe, tanpa import modul Node). */

const TARGET_PATHS = [
  'targetUrl',
  'target_url',
  'final_url',
  'finalUrl',
  'destination_url',
  'destinationUrl',
  'data.final_url',
  'data.destination_url',
  'data.target_url',
  'data.destinationUrl',
  'destination.original_url',
  'destination.url',
  'destination.href',
  'direct.final_url',
  'direct.destination_url',
  'direct.target_url',
  'urls.0',
  'data.urls.0',
  'links.0.url',
  'links.0.href',
  'links.0',
  'data.links.0.url',
  'data.links.0.href',
  'data.links.0',
];

const DENY_STATUS = new Set([
  'failed',
  'error',
  'not_found',
  'expired',
  'partial',
  'requires_interaction',
  'requires_verification',
  'password_required',
  'captcha_required',
  'locked',
  'unavailable',
]);

function getPath(obj, path) {
  let v = obj;
  for (const k of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[k];
  }
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    if (typeof v.url === 'string') return v.url;
    if (typeof v.href === 'string') return v.href;
  }
  return undefined;
}

function isHttpUrlString(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || s.length > 2048) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

function pickTargetUrl(result) {
  for (const path of TARGET_PATHS) {
    const v = getPath(result, path);
    if (isHttpUrlString(v)) return v.trim();
  }
  return null;
}

function textOf(result) {
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const page = result.page && typeof result.page === 'object' ? result.page : {};
  const texts = [
    typeof result.error === 'string' ? result.error : result.error && result.error.message,
    result.resolver && result.resolver.message,
    result.message,
    data.error,
    page.error,
  ];
  return texts.filter((t) => typeof t === 'string' && t.trim()).join(' | ');
}

function mapText(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  if (/captcha|turnstile|recaptcha|hcaptcha|challenge/.test(s)) return 'CAPTCHA_REQUIRED';
  if (/password|passcode|kata sandi|terkunci password/.test(s)) return 'PASSWORD_REQUIRED';
  if (/expired|kedaluwarsa|kadaluarsa/.test(s)) return 'LINK_EXPIRED';
  if (/not[\s_-]?found|404|tidak ditemukan|tidak ada|dihapus/.test(s)) return 'NOT_FOUND';
  if (/requires?[_ ]?interaction|membutuhkan interaksi|verifikasi|verification/.test(s)) return 'VERIFICATION_REQUIRED';
  return null;
}

function isResolved(result) {
  if (result.status === false) return false;
  if (result.bypassed === false) return false;
  if (result.is_resolved === false) return false;
  if (result.resolver && result.resolver.resolved === false) return false;
  if (result.destination && result.destination.unlock_required === true) return false;
  if (result.destination && result.destination.status === 'locked') return false;
  if (result.data && typeof result.data.resolution_status === 'string' && result.data.resolution_status.toLowerCase() !== 'resolved') return false;

  if (result.status === true || result.status === 'resolved' || result.status === 'success') return true;
  if (result.bypassed === true) return true;
  if (result.is_resolved === true) return true;
  if (result.resolver && result.resolver.resolved === true) return true;
  if (result.destination && result.destination.status === 'unlocked') return true;
  if (result.data && result.data.resolution_status === 'resolved') return true;
  return false;
}

function explicitFailureCode(result) {
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const page = result.page && typeof result.page === 'object' ? result.page : {};
  const dest = result.destination && typeof result.destination === 'object' ? result.destination : {};

  if (result.captcha_required === true || data.captcha_required === true || page.captcha_required === true) return 'CAPTCHA_REQUIRED';
  if (result.password_required === true || data.password_required === true || page.password_required === true) return 'PASSWORD_REQUIRED';
  if (result.requires_verification === true) return 'VERIFICATION_REQUIRED';
  if (result.requires_interaction === true || data.requires_interaction === true) return 'INTERACTION_REQUIRED';
  if (dest.unlock_required === true || dest.status === 'locked') return 'LOCKED_DESTINATION';

  for (const raw of [result.resolution_status, data.resolution_status, result.page_status, page.status, data.page_status, dest.status]) {
    if (typeof raw !== 'string') continue;
    const s = raw.toLowerCase();
    if (s === 'not_found' || s === 'unavailable') return 'NOT_FOUND';
    if (s === 'expired') return 'LINK_EXPIRED';
    if (s === 'captcha_required') return 'CAPTCHA_REQUIRED';
    if (s === 'password_required') return 'PASSWORD_REQUIRED';
    if (s === 'requires_verification') return 'VERIFICATION_REQUIRED';
    if (s === 'requires_interaction') return 'INTERACTION_REQUIRED';
    if (DENY_STATUS.has(s)) return 'BYPASS_FAILED';
  }

  if (result.is_resolved === false) return 'UNRESOLVED';
  if (result.resolver && result.resolver.resolved === false) return 'BYPASS_FAILED';

  const textCode = mapText(textOf(result));
  if (textCode) return textCode;
  return null;
}

function safeMessage(result, code) {
  const candidates = [
    typeof result.error === 'string' ? result.error : result.error && result.error.message,
    result.resolver && result.resolver.message,
    result.message,
    result.data && result.data.error,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim().replace(/\s+/g, ' ');
    if (!s || s.length > 160) continue;
    if (/\n|:\d+:\d+|https?:\/\/|Bearer\s|password\s*[=:]/i.test(s)) continue;
    return s;
  }
  return undefined;
}

function evaluateEngineResult(provider, result) {
  if (!result || typeof result !== 'object') return { success: false, code: 'BYPASS_FAILED' };
  if (Array.isArray(result)) result = result[0];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { success: false, code: 'BYPASS_FAILED' };

  const target = pickTargetUrl(result);
  const resolved = isResolved(result);

  if (target && resolved) {
    return { success: true, targetUrl: target };
  }

  const code = explicitFailureCode(result) || (target ? 'BYPASS_FAILED' : 'NO_TARGET_URL');
  return { success: false, code, message: safeMessage(result, code) };
}

module.exports = { evaluateEngineResult, pickTargetUrl, isResolved, explicitFailureCode, TARGET_PATHS };
