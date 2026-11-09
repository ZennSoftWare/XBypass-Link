/* ============================================================
 * middleware.js — XBypass (Vercel Routing Middleware)
 * ============================================================
 * Lapisan keamanan untuk route /api/* SAJA.
 * Konvensi Vercel (middleware.js di root + export default +
 * export config). Static assets (gambar/CSS/JS/font/HTML) tidak
 * melewati middleware ini — matcher membatasi pada /api/:path*.
 *
 * Rangkaian (REQUEST → MIDDLEWARE → SECURITY/BOT CHECK → RATE LIMIT
 * → URL VALIDATOR (di endpoint) → ENGINE → RESPONSE HANDLER → JSON):
 *   - Semua keputusan rate limit/spam dibaca dari lib/rate-limit.js
 *     (sumber tunggal; tidak ada duplikasi logika).
 *   - Seluruh bentuk body JSON dibuat memakai lib/response-handler.js
 *     (format respons = satu sumber kebenaran).
 *   - Validasi URL/target penulisan Deep (SSRF) tetap di lib/url-validator.js
 *     dan menjalangkannya di endpoint/API adapter (bukan middleware).
 *
 * NOTE runtime: middleware berjalan pada runtime Node.js (default Vercel),
 * sehingga membuat import CommonJS di lib/ aman tanpa mengubah seluruh
 * project menjadi ES Modules — engine API tetap CommonJS.
 *
 * Hard rules:
 *   - IP diambil via ipAddress() helper resmi @vercel/functions
 *     (header X-Forwarded-For user-CONTROLLED tidak dipercaya).
 *   - Blocking hanya TIDAK PERMANEN: seluruh blokir disimpan dengan TTL
 *     (lihat lib/rate-limit.js) — tidak ada daftar blokir lokal.
 *   - Normal users TIDAK diblokir hanya berdasarkan User-Agent;
 *     UA adalah satu dari beberapa sinyal dan threshold dijaga tinggi.
 * ============================================================ */

import { ipAddress, next } from '@vercel/functions';
import rateLimit from './lib/rate-limit.js';
import responseHandler from './lib/response-handler.js';

/* ==================================================================== */
/* Konstanta                                                             */
/* ==================================================================== */

const API_PREFIX = '/api';
const MAX_BODY_BYTES = 16 * 1024; // 16 KB
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i;

/* Signature otomasi yang jelas-jelas BUKAN browser normal:
   user normal tidak akan pernah memakai klien berikut; dianggap
   salah satu sinyal (bukan satu-satunya kunci). */
const AUTOMATION_UA = /(?:curl\/|wget\/|python-(?:requests|urllib|httplib)|go-http-client|java\/|libwww-perl|scrapy|scrapinghub|axios\/|undici\/|aiohttp|httpx\/|postmanruntime|insomnia\/|node-fetch|headlesschrome|puppeteer|playwright|phantomjs|selenium|okhttp\/|dart:io|httrack|masscan|nucktrace|nikto|openai-internal|facebookexternalhit)/i;

/* Ambang skor anti-bot: klien automasi (4) + sinyal header rawan (>=1)
   -> >=5 diblok; normal users (0..1) aman. Header yang hilang hanya
   menambahkan skor, tidak pernah menjadi alasan tunggal pemblokiran. */
const BLOCK_THRESHOLD = 5;

/* ==================================================================== */
/* Utilitas kecil                                                        */
/* ==================================================================== */

function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    'cache-control': 'no-store, must-revalidate',
    ...(extra || {}),
  };
}

function normalizeIp(ip) {
  let value = String(ip || '').trim();
  // menormalisasi bentuk IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (value.startsWith('::ffff:') && value.includes('.')) value = value.slice(7);
  return value || 'unknown';
}

/** Host sama domain ATAU subdomain dari domain deployment sendiri. */
function isSameSiteHostname(hostA, hostB) {
  const a = String(hostA || '').toLowerCase().replace(/\.$/, '');
  const b = String(hostB || '').toLowerCase().replace(/\.$/, '');
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b);
}

/**
 * Anti-bot: skor sinyal request.
 * UA hilang / header browser hilang = sinyal lembut (tidak pernah
 * menjadi alasan tunggal block); klien automasi = sinyal kuat.
 */
function antiBotScore(request, ua) {
  let score = 0;
  const signals = [];

  if (!ua) {
    score += 2;
    signals.push('user-agent missing');
  } else if (AUTOMATION_UA.test(ua)) {
    score += 4;
    signals.push('automation client UA');
  }

  // sinyal tambahan maksimum +1 total sekali (tetap lembut)
  const accept = request.headers.get('accept');
  if (!accept || accept === '*/*') {
    score += 1;
    signals.push('accept header kosong / wildcard');
  }

  return { score, signals };
}

/** Limit respons untuk header X-RateLimit-* */
function rateLimitHeaders(verdict, blockedStatus) {
  const headers = {
    'x-ratelimit-mode': verdict.mode || 'unknown',
  };
  if (typeof verdict.limit === 'number') headers['x-ratelimit-limit'] = String(verdict.limit);
  if (typeof verdict.remaining === 'number') headers['x-ratelimit-remaining'] = String(verdict.remaining);
  if (typeof verdict.resetMs === 'number') {
    headers['x-ratelimit-reset'] = String(Math.ceil(verdict.resetMs / 1000));
  } else if (verdict.retryAfterMs > 0) {
    headers['x-ratelimit-reset'] = String(Math.ceil((Date.now() + verdict.retryAfterMs) / 1000));
  }
  if (blockedStatus) {
    headers['retry-after'] = String(Math.max(1, Math.ceil((verdict.retryAfterMs || 60_000) / 1000)));
  }
  return headers;
}

/** Log operasional — TANPA token/cookie/header sensitif lainnya. */
function logRequest({ method, endpoint, ip, status, reason, mode, startedAt }) {
  try {
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      component: 'middleware',
      method,
      endpoint,
      ip,
      status,
      reason: reason || 'OK',
      mode: mode || 'unknown',
      ms: startedAt ? Date.now() - startedAt : undefined,
    }));
  } catch (_) { /* logging opsional */ }
}

/** Baca body dengan batas; kembalikan { text, truncated } */
async function readBodyCapped(request, maxBytes) {
  let stream = null;
  try {
    if (typeof request.clone === 'function') {
      stream = request.clone().body; // original body tidak dikonsumsi di sini
    } else {
      stream = request.body;
    }
    if (!stream || typeof stream.getReader !== 'function') return { text: null, truncated: false };

    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let text = '';
    let read = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += chunk.value ? chunk.value.byteLength : 0;
      if (read > maxBytes) {
        // cancel jangan di-await: undici bisa tidak pernah settle padanya
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) { /* diabaikan */ }
        return { text: null, truncated: true };
      }
      text += chunk.value ? decoder.decode(chunk.value, { stream: true }) : '';
    }
    text += decoder.decode();
    return { text, truncated: false };
  } catch (_) {
    return { text: null, truncated: false };
  }
}

async function sha256Hex(text) {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return null;
  }
}

/** Host dari URL target (jika bisa dipahami) utk anti-scraping */
function extractTargetHostForHash(rawUrl) {
  try {
    const cleaned = String(rawUrl || '').trim();
    if (!cleaned || cleaned.length > 2048) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : 'https://' + cleaned;
    const u = new URL(withScheme);
    return (u.hostname || '').toLowerCase();
  } catch (_) {
    return null;
  }
}

function jsonBlockedResponse(code, { provider = null, message = null, extraHeaders = {} } = {}) {
  const status = responseHandler.HTTP_STATUS_BY_CODE[code] || 400;
  const body = responseHandler.buildError({ code, message, provider });
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...securityHeaders(),
      ...extraHeaders,
    },
  });
}

/* ==================================================================== */
/* Middleware utama                                                      */
/* ==================================================================== */

export default async function middleware(request) {
  const startedAt = Date.now();
  let mode = rateLimit.getStatus().mode;

  try {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = String(request.method || 'GET').toUpperCase();

    // Pengaman ganda: hanya /api/* — matcher sudah membatasi di config.
    if (pathname !== API_PREFIX && !pathname.startsWith(API_PREFIX + '/')) {
      return next();
    }

    let ip = 'unknown';
    try { ip = normalizeIp(ipAddress(request)); } catch (_) { ip = 'unknown'; }

    const ua = request.headers.get('user-agent') || '';

    /* ---------- Preflight CORS (OPTIONS) ---------- */
    if (method === 'OPTIONS') {
      const origin = request.headers.get('origin') || '';
      let corsHeaders = {};
      if (origin && isSameSiteHostname(new URL(origin).hostname, url.hostname)) {
        corsHeaders = {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'false',
        };
      }
      const response = new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type, Accept',
          'access-control-max-age': '86400',
          ...securityHeaders(),
          ...corsHeaders,
        },
      });
      logRequest({ method, endpoint: pathname, ip, status: 204, reason: 'PREFLIGHT', mode, startedAt });
      return response;
    }

    /* ---------- Metode HTTP ---------- */
    if (method !== 'POST' && method !== 'GET' && method !== 'HEAD') {
      const response = jsonBlockedResponse('METHOD_NOT_ALLOWED', {
        extraHeaders: { allow: 'GET, HEAD, POST, OPTIONS' },
      });
      logRequest({ method, endpoint: pathname, ip, status: 405, reason: 'METHOD_NOT_ALLOWED', mode, startedAt });
      return response;
    }

    /* ---------- GET/HEAD: hanya header keamanan + pemantauan ---------- */
    if (method === 'GET' || method === 'HEAD') {
      logRequest({ method, endpoint: pathname, ip, status: 0, reason: 'PASSTHROUGH_GET', mode, startedAt });
      return next({ headers: { ...securityHeaders() } });
    }

    /* ===== POST: lapisan penuh ===== */

    /* -- ukuran (-- 1) --- */
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      const response = jsonBlockedResponse('PAYLOAD_TOO_LARGE');
      logRequest({ method, endpoint: pathname, ip, status: 413, reason: 'PAYLOAD_TOO_LARGE', mode, startedAt });
      return response;
    }

    /* -- content-type (2) --- */
    const contentType = request.headers.get('content-type') || '';
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      const response = jsonBlockedResponse('UNSUPPORTED_MEDIA_TYPE');
      logRequest({ method, endpoint: pathname, ip, status: 415, reason: 'UNSUPPORTED_MEDIA_TYPE', mode, startedAt });
      return response;
    }

    /* -- origin (3) --- */
    const origin = request.headers.get('origin');
    if (origin) {
      const validOrigin = (() => {
        try {
          return new URL(origin).hostname;
        } catch (_) { return null; }
      })();
      if (!validOrigin || !isSameSiteHostname(validOrigin, url.hostname)) {
        const response = jsonBlockedResponse('ORIGIN_FORBIDDEN');
        logRequest({ method, endpoint: pathname, ip, status: 403, reason: 'ORIGIN_FORBIDDEN', mode, startedAt });
        return response;
      }
    }

    /* -- anti-bot (4) --- */
    const bot = antiBotScore(request, ua);
    if (bot.score >= BLOCK_THRESHOLD) {
      const response = jsonBlockedResponse('BOT_BLOCKED', {
        message: 'Karakteristik permintaan terdeteksi sebagai otomatisasi.',
      });
      logRequest({ method, endpoint: pathname, ip, status: 403, reason: 'ANTI_BOT (' + bot.signals.join(', ') + ')', mode, startedAt });
      return response;
    }

    /* -- body dibaca dengan batas ukuran (5) --- */
    const { text: bodyText, truncated } = await readBodyCapped(request, MAX_BODY_BYTES);
    if (truncated) {
      const response = jsonBlockedResponse('PAYLOAD_TOO_LARGE');
      logRequest({ method, endpoint: pathname, ip, status: 413, reason: 'PAYLOAD_TOO_LARGE (baca)', mode, startedAt });
      return response;
    }

    /* -- payload harus JSON object (6) --- */
    let payload = null;
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText);
      } catch (_) {
        payload = null;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        const response = jsonBlockedResponse('SUSPICIOUS_REQUEST', {
          message: 'Body tidak memenuhi format JSON yang diterima endpoint.',
        });
        logRequest({ method, endpoint: pathname, ip, status: 400, reason: 'SUSPICIOUS_REQUEST (payload)', mode, startedAt });
        return response;
      }
    }

    /* -- anti-scraping: hitung target unik (7) --- */
    if (payload && typeof payload.url === 'string') {
      const host = extractTargetHostForHash(payload.url);
      if (host) {
        try {
          const noted = await rateLimit.noteTarget(ip, host);
          if (noted && noted.exceeded) {
            await rateLimit.reportViolation(ip, 'TOO_MANY_TARGETS');
            const response = jsonBlockedResponse('TOO_MANY_TARGETS', {
              extraHeaders: { 'x-rejection-reason': 'TOO_MANY_TARGETS' },
            });
            logRequest({ method, endpoint: pathname, ip, status: 429, reason: 'TOO_MANY_TARGETS', mode, startedAt });
            return response;
          }
        } catch (_) { /* kegagalan anti-scraping tidak mematahkan alur request */ }
      }
    }

    /* -- rate limit + spam protection (8) --- */
    const payloadKey = bodyText ? await sha256Hex(bodyText) : null;
    let verdict = null;
    try {
      verdict = await rateLimit.evaluateRequest({ ip, endpoint: pathname, payloadKey });
      mode = verdict.mode || mode;
    } catch (_) {
      verdict = null; // kegagalan infrastruktur rate limit tidak boleh memblokir request sah
    }

    if (verdict && !verdict.allowed) {
      const key = verdict.reason;
      const status = responseHandler.HTTP_STATUS_BY_CODE[key] || 429;
      const response = jsonBlockedResponse(key === 'IP_BLOCKED' ? 'IP_BLOCKED' : 'RATE_LIMITED', {
        message: null,
        extraHeaders: {
          ...rateLimitHeaders(verdict, true),
          'x-rejection-reason': key,
        },
      });
      logRequest({ method, endpoint: pathname, ip, status, reason: key, mode, startedAt });
      return response;
    }

    /* -- cooldown + duplikat stamp (9) -- diterapkan bila request lolos --- */
    if (verdict && verdict.allowed) {
      try {
        await rateLimit.stampCooldown(ip, pathname, rateLimit.getConfig().cooldownMs);
        if (payloadKey) await rateLimit.stampDuplicate(ip, pathname, payloadKey, rateLimit.getConfig().duplicateWindowMs);
      } catch (_) { /* kegagalan stamp tidak memutus alut request */ }
    }

    /* -- pass-through dengan header keamanan (10) --- */
    const nextHeaders = { ...securityHeaders() };
    if (verdict) {
      Object.assign(nextHeaders, rateLimitHeaders(verdict, false));
    }
    if (mode !== 'redis') {
      nextHeaders['x-ratelimit-mode'] = mode; // status fitur jujur: bukan Redis, TIDAK global
    }
    logRequest({ method, endpoint: pathname, ip, status: 0, reason: 'PASSTHROUGH', mode, startedAt });
    return next({ headers: nextHeaders });
  } catch (err) {
    // Jangan pernah membocorkan stack trace
    try { console.error('[middleware] error internal:', err && err.message ? err.message : String(err)); } catch (_) { /* diabaikan */ }
    const response = jsonBlockedResponse('INTERNAL_ERROR');
    logRequest({ method: request && request.method, endpoint: '(?)', ip: 'unknown', status: 500, reason: 'INTERNAL_ERROR', mode, startedAt });
    return response;
  }
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/api/:path*'],
};
