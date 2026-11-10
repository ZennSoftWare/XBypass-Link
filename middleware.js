/* ====================================================================
 * XBypass — middleware.js (Vercel Routing Middleware, Edge runtime)
 *
 * Lapisan keamanan HANYA untuk /api/:path* (lihat export const config).
 * Static assets (HTML/CSS/JS/font/gambar/logo) tidak pernah lewat sini.
 *
 * Alur:  REQUEST → middleware (security check) → [selanjutnya]
 *        rate limit (lib/rate-limit.js, Redis terdistribusi)
 *        → endpoint handler (Node/CJS) → lib/response-handler.js → JSON
 *
 * Ketentuan:
 *  - Import helper resmi: ipAddress() & next() dari "@vercel/functions".
 *    Subpath dipakai (headers/middleware) agar Edge tidak ikut memuat
 *    modul Node yang tidak diperlukan.
 *  - Validasi, limit & kategori kode HANYA sekali di lib/ — middleware
 *    tidak memusatkan tabel sendiri (anti-duplikasi).
 *  - IP diambil via ipAddress(request) — header platform Vercel
 *    (x-real-ip), bukan header yang bisa dipalsukan pengguna.
 *  - Blokir IP sementara disimpan di Redis (TTL kedaluwarsa otomatis),
 *    BUKAN variabel lokal serverless.
 *  - Blokir permanen isu User-Agent SAJA: dilarang. UA hanya sinyal
 *    bersama dengan penekanan rate (lihat botScore + blok akseleratif).
 *  - Log operasional tanpa token/cookie/konten pengguna.
 *  - Berkas ini SAYA WAJIB bercorak ESM (export default/config) karena
 *    kontrak file middleware Vercel — ini TIDAK menyetel proyek ini jadi
 *    ESM: seluruh engine di api/ tetap CommonJS.
 * ==================================================================== */

import { ipAddress } from '@vercel/functions';
import { next } from '@vercel/functions/middleware';
import rbPack from './lib/response-handler.js';
import rl from './lib/rate-limit.js';

/* ------------------------------------------------------------------ */
/* Konfigurasi ekspresi lingkungan                                     */
/* ------------------------------------------------------------------ */

function numEnv(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  let v = Math.floor(n);
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

const MAX_BODY_BYTES = numEnv('MW_MAX_BODY_BYTES', 32768, { min: 64, max: 1048576 });
const BOT_STRICT_SCORE = numEnv('MW_BOT_STRICT_SCORE', 60, { min: 0, max: 100 });
const EXTRA_ORIGINS = new Set(
  (process.env.MW_EXTRA_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS', 'HEAD']);

/* Header keamanan dan cache untuk seluruh respons API */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'deny',
  'permissions-policy': 'browsing-topics=(), camera=(), microphone=(), geolocation=(), payment=()',
  'cache-control': 'no-store, max-age=0',
};

/* ------------------------------------------------------------------ */
/* Monitoring (tersanitasi: tanpa UA/token/cookie/body)                */
/* ------------------------------------------------------------------ */

function shortIp(ip) {
  if (!ip) return 'unknown';
  return ip.length > 40 ? ip.slice(0, 40) : ip;
}

function logLine(entry) {
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
  } catch {
    /* logging tidak boleh membatalkan alur request */
  }
}

/* ------------------------------------------------------------------ */
/* Anti-bot: analisis kombinasi sinyal (skor, bukan blokir by-UA)      */
/* ------------------------------------------------------------------ */

const AUTOMATION_UA =
  /(curl|wget|python-requests|python-urllib|scrapy|httpx|go-http-client|java\/|okhttp|libwww|undici|axios\/|node-fetch|httpclient|postmanruntime|reqwest|akamai|headless|puppeteer|playwright|phantom|selenium|^bot|crawler|spider|slurp|scanner|masscan|zgrab)/i;
const BROWSER_UA = /(mozilla|chrome|safari|gecko|firefox|edge|opr)/i;

function botScore(request) {
  const signals = [];
  const ua = request.headers.get('user-agent') || '';

  if (!ua.trim()) {
    signals.push('ua_missing');
  } else if (AUTOMATION_UA.test(ua)) {
    signals.push('ua_automation');
  }

  if (BROWSER_UA.test(ua)) {
    // UA mengaku browser: karakteristik browser harus ada, kalau tidak
    // ini kecurigaan palinting (tetap bukan bantag untuk blokir langsung)
    if (!request.headers.get('accept')) signals.push('ua_browser_no_accept');
    if (!request.headers.get('sec-fetch-site')) signals.push('ua_browser_no_sec-fetch');
  }

  const score = Math.min(
    100,
    (signals.includes('ua_missing') ? 25 : 0) +
      (signals.includes('ua_automation') ? 40 : 0) +
      (signals.includes('ua_browser_no_accept') ? 10 : 0) +
      (signals.includes('ua_browser_no_sec-fetch') ? 15 : 0) +
      (signals.includes('ua_browser_no_accept') && signals.includes('ua_browser_no_sec-fetch') ? 20 : 0)
  );
  return { score, signals };
}

/* ------------------------------------------------------------------ */
/* Util respons Edge                                                   */
/* ------------------------------------------------------------------ */

function denyResponse(status, code, userMessage, extraHeaders) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) headers.set(k, String(v));
    }
  }
  const message = rbPack.OUTPUT_MESSAGES[code] || userMessage || 'Request tidak diizinkan.';
  return new Response(
    JSON.stringify({ success: false, provider: null, error: { code, message } }),
    { status, headers }
  );
}

function originIsAllowed(originHeader, requestUrl) {
  let o;
  try {
    o = new URL(originHeader);
  } catch {
    return false;
  }
  if (o.protocol !== 'https:' && o.protocol !== 'http:') return false;
  if (o.origin === requestUrl.origin) return true;
  if (EXTRA_ORIGINS.has(o.origin)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Middleware utama                                                    */
/* ------------------------------------------------------------------- */

export default async function middleware(request) {
  const url = new URL(request.url);
  const endpoint = url.pathname;
  /* belt & brace: matcher sudah /api/:path* */
  if (!endpoint.startsWith('/api/') && endpoint !== '/api') return next();

  const method = request.method.toUpperCase();
  const ip = shortIp(ipAddress(request));
  const status = rl.getRateLimitStatus();
  const ingressMs = Date.now();

  /* --- E. validasi HTTP method ------------------------------------- */
  if (!ALLOWED_METHODS.has(method)) {
    logLine({ s: 'blocked', r: 'method', m: method, p: endpoint, ip, rl: status.mode });
    return denyResponse(
      rbPack.CODE_STATUS.METHOD_NOT_ALLOWED,
      'METHOD_NOT_ALLOWED',
      null,
      { Allow: 'GET, POST, OPTIONS, HEAD' }
    );
  }

  /* --- CORS: hanya echo origin yang diperbolehkan, tanpa wildcard --- */
  const origin = request.headers.get('origin');
  if (origin && !originIsAllowed(origin, url)) {
    logLine({ s: 'blocked', r: 'origin_forbidden', m: method, p: endpoint, ip, rl: status.mode });
    return denyResponse(rbPack.CODE_STATUS.FORBIDDEN_ORIGIN, 'FORBIDDEN_ORIGIN');
  }

  /* inline preflight — origin sudah diverifikasi di atas */
  if (method === 'OPTIONS') {
    const headers = new Headers(SECURITY_HEADERS);
    if (origin) headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS, HEAD');
    headers.set('access-control-allow-headers', 'Content-Type, Accept');
    headers.set('access-control-max-age', '86400');
    logLine({ s: 'pass', r: 'preflight', m: method, p: endpoint, ip, rl: status.mode });
    return new Response(null, { status: 204, headers });
  }

  /* --- E2. ukuran body & content type (hanya POST ber-body JSON) --- */
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    logLine({ s: 'blocked', r: 'payload_size', m: method, p: endpoint, ip, rl: status.mode });
    return denyResponse(rbPack.CODE_STATUS.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE');
  }
  if (method === 'POST') {
    const ct = (request.headers.get('content-type') || '').toLowerCase().trim();
    if (!ct.startsWith('application/json')) {
      logLine({ s: 'blocked', r: 'content_type', m: method, p: endpoint, ip, rl: status.mode });
      return denyResponse(rbPack.CODE_STATUS.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_MEDIA_TYPE');
    }
  }

  /* --- D. rate limit (Redis sliding window; middleware memakai      */
  /*      lib yang sama jadi pusat — tidak ada salinan algoritma) ----- */
  const rate = await rl.checkRateLimit({ ip, endpoint });
  const bot = botScore(request);

  if (rate.blocked || isGenuineLimit(rate)) {
    /* pelanggaran rate + sinyal bot tinggi → blokir sementara
       dipercepat (kombinasi, bukan berdasarkan UA saja) */
    if (isGenuineLimit(rate) && !rate.blocked && bot.score >= BOT_STRICT_SCORE) {
      await rl.temporaryBlock(ip, Math.min(rl.CONFIG.blockTtlSec, 300), 'bot_accelerated');
    }
    const retryAfter = rate.retryAfterSec || rl.CONFIG.blockTtlSec;
    const headers = {
      'retry-after': String(retryAfter),
      'x-ratelimit-limit': String(rl.CONFIG.ipLimit),
      'x-ratelimit-remaining': '0',
      'x-ratelimit-mode': rate.mode,
    };
    if (rate.resetMs) headers['x-ratelimit-reset'] = String(Math.ceil(rate.resetMs / 1000));
    logLine({
      s: 'blocked', r: rate.reason, m: method, p: endpoint, ip, b: bot.score, sigs: bot.signals.join(','), rl: rate.mode,
    });
    return denyResponse(rbPack.CODE_STATUS.RATE_LIMITED, 'RATE_LIMITED', null, headers);
  }

  /* fail-open saat Redis tak tersedia: sinyal eksplisit via header,
     tanpa klaim perlindungan global */
  if (rate.reason === 'rate_limiting_unconfigured' || rate.reason === 'rate_limiting_degraded' || rate.reason === 'redis_error') {
    logLine({ s: 'open', r: rate.reason, m: method, p: endpoint, ip, b: bot.score, rl: rate.mode });
  } else {
    logLine({ s: 'pass', m: method, p: endpoint, ip, b: bot.score, rl: rate.mode, ms: Date.now() - ingressMs });
  }

  /* --- F. header keamanan + info limit → lewatkan ke endpoint ------ */
  const passHeaders = new Headers(SECURITY_HEADERS);
  passHeaders.set('x-ratelimit-mode', rate.mode);
  if (rate.remaining !== null && rate.remaining !== undefined) {
    passHeaders.set('x-ratelimit-limit', String(rl.CONFIG.ipLimit));
    passHeaders.set('x-ratelimit-remaining', String(rate.remaining));
    passHeaders.set('x-ratelimit-reset', String(Math.ceil((rate.resetMs || 0) / 1000)));
  }
  return next({ headers: passHeaders });
}

/* limit sungguhan (bukan status fail-open) */
function isGenuineLimit(rate) {
  if (!rate.limited || rate.blocked) return rate.blocked === true;
  return (
    rate.reason === 'ip_limit' ||
    rate.reason === 'endpoint_limit' ||
    rate.reason === 'cooldown' ||
    rate.reason === 'temporary_block'
  );
}

/* ------------------------------------------------------------------ */
/* Kontrak middleware Vercel: hanya /api/:path*                        */
/* ------------------------------------------------------------------ */

export const config = {
  matcher: '/api/:path*',
};
