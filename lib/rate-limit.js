'use strict';

/* ====================================================================
 * XBypass — lib/rate-limit.js
 *
 * Rate limiting sliding window untuk lingkungan Vercel Serverless.
 *
 * LEVEL PENYIMPANAN (satu pusat, dipakai middleware & endpoint):
 *  1. "redis"  — produksi. @upstash/redis + @upstash/ratelimit
 *                (UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN).
 *                Sliding window terdistribusi antar semua instance.
 *  2. "memory" — FALLBACK PENGEMBANGAN LOKAL SAJA (Map in-process).
 *                SETIAP instance serverless punya Map sendiri sehingga
 *                ini BUKAN perlindungan global.
 *  3. "unconfigured"/"degraded" — Redis tidak diset / gagal. Limit
 *                open (fail-open), status disinyal eksplisit lewat
 *                getRateLimitStatus() & console.warn — status konfigurasi
 *                dianggap tidak aktif, jangan pernah klaim global.
 *
 * Konfigurasi via environment variable (semua opsional):
 *   RL_IP_LIMIT           default 20   — maks request / IP dalam window
 *   RL_IP_WINDOW_SEC      default 60   — panjang window global IP (detik)
 *   RL_ENDPOINT_LIMIT     default 10   — maks request / IP+endpoint window
 *   RL_ENDPOINT_WINDOW_SEC default 60  — panjang window endpoint (detik)
 *   RL_COOLDOWN_MS        default 1000 — jeda minimum antar request pada
 *                                      pasangan IP+endpoint yang sama
 *   RL_BLOCK_THRESHOLD    default 3    — pelanggaran window sebelum
 *                                      temporary block
 *   RL_BLOCK_TTL_SEC      default 600  — masa blokir sementara (TTL;
 *                                      kedaluwarsa otomatis, tanpa ban
 *                                      permanen; sekali pun tidak dibuat
 *                                      dari User-Agent saja)
 *
 * Desain tegatan: modul ini bebas modul core Node agar bisa dibundel
 * ke middleware Edge (@vercel/functions).
 * ==================================================================== */

/* Kunci env Redis — hanya dibaca, tidak pernah disimpan ke source. */
const REDIS_URL_ENV = 'UPSTASH_REDIS_REST_URL';
const REDIS_TOKEN_ENV = 'UPSTASH_REDIS_REST_TOKEN';
const KEY_PREFIX = 'xbypass';

/* -- konfigurasi efektif (dihitung saat init, stabil per instance) -- */
function numEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const CONFIG = {
  ipLimit: numEnv('RL_IP_LIMIT', 20, { min: 1, max: 10000 }),
  ipWindowSec: numEnv('RL_IP_WINDOW_SEC', 60, { min: 5, max: 86400 }),
  endpointLimit: numEnv('RL_ENDPOINT_LIMIT', 10, { min: 1, max: 10000 }),
  endpointWindowSec: numEnv('RL_ENDPOINT_WINDOW_SEC', 60, { min: 5, max: 86400 }),
  cooldownMs: numEnv('RL_COOLDOWN_MS', 1000, { min: 0, max: 60000 }),
  violationThreshold: numEnv('RL_BLOCK_THRESHOLD', 3, { min: 1, max: 1000 }),
  blockTtlSec: numEnv('RL_BLOCK_TTL_SEC', 600, { min: 5, max: 86400 }),
  memoryMaxKeys: 20000, // batas anti-leak untuk fallback dev
};

/* -- backend hasil inisialisasi ------------------------------------ */
let backend = null;
let warned = {};

function warnOnce(kind, message) {
  if (warned[kind]) return;
  warned[kind] = true;
  console.warn(message);
}

function initBackend() {
  if (backend) return backend;
  const url = process.env[REDIS_URL_ENV];
  const token = process.env[REDIS_TOKEN_ENV];
  const isProd = process.env.VERCEL_ENV === 'production';

  if (!url || !token) {
    if (isProd) {
      backend = { mode: 'unconfigured', reason: 'UPSTASH_REDIS_REST_URL/TOKEN belum diset' };
      warnOnce(
        'unconfigured-prod',
        '[xbypass][ratelimit] PRODUKSI: Upstash Redis belum dikonfigurasi — ' +
          'rate limiting GLOBAL TIDAK AKTIF (fallback lokal tidak dipakai di produksi). ' +
          'Set UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN.'
      );
    } else {
      backend = { mode: 'memory', reason: 'development fallback lokal (bukan global)' };
    }
    return backend;
  }

  try {
    // eslint-disable-next-line global-require
    const { Redis } = require('@upstash/redis');
    // eslint-disable-next-line global-require
    const { Ratelimit } = require('@upstash/ratelimit');
    const redis = new Redis({ url, token });
    const ipLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(CONFIG.ipLimit, CONFIG.ipWindowSec + ' s'),
      prefix: KEY_PREFIX + ':rl:ip',
    });
    const endpointLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(CONFIG.endpointLimit, CONFIG.endpointWindowSec + ' s'),
      prefix: KEY_PREFIX + ':rl:endpoint',
    });
    backend = { mode: 'redis', redis, ipLimiter, endpointLimiter };
  } catch (err) {
    backend = { mode: 'degraded', reason: 'gagal inisialisasi Upstash client: ' + (err && err.message ? err.message : 'unknown') };
    warnOnce('degraded-init', '[xbypass][ratelimit] Redis gagal diinisialisasi — rate limiting GLOBAL TIDAK AKTIF (fail-open): ' + backend.reason);
  }
  return backend;
}

function resetBackendForTest() {
  backend = null;
  warned = {};
}

/* -- status eksplisit ---------------------------------------------- */

/** Laporkan mode & konfigurasi (tanpa rahasia). Untuk logging/diagnostik. */
function getRateLimitStatus() {
  const b = initBackend();
  return {
    mode: b.mode,
    globalLimitActive: b.mode === 'redis',
    reason: b.reason || null,
    config: { ...CONFIG },
  };
}

/* -- fallback memori (HANYA pengembangan lokal) --------------------- */

const mem = {
  windows: new Map(), // key -> array timestamp(ms)
  cooldown: new Map(), // key keypair -> lastCustomerMs
  violations: new Map(), // ip -> {count, windowStart}
  blocks: new Map(), // ip -> expireAtMs
};

function memTrim() {
  if (mem.windows.size + mem.cooldown.size + mem.violations.size + mem.blocks.size < CONFIG.memoryMaxKeys) return;
  const now = Date.now();
  for (const [k, arr] of mem.windows) {
    if (!arr || !arr.length || arr[arr.length - 1] < now - 600000) mem.windows.delete(k);
  }
  for (const [k, at] of mem.blocks) if (at <= now) mem.blocks.delete(k);
  for (const [k, v] of mem.cooldown) if (now - v.providerMs > 120000) mem.cooldown.delete(k);
  for (const [k, v] of mem.violations) if (now - v.windowStart > 600000) mem.violations.delete(k);
}

/** sliding window in-memory: hitung-hosting timestamp; kembalikan info window */
function memWindow(key, limit, windowMs) {
  const now = Date.now();
  let arr = mem.windows.get(key);
  if (!Array.isArray(arr)) arr = [];
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= limit) {
    const resetMs = arr[0] + windowMs - now;
    return { allowed: false, remaining: 0, resetMs: Math.max(1, resetMs), count: arr.length };
  }
  arr.push(now);
  mem.windows.set(key, arr);
  return { allowed: true, remaining: Math.max(0, limit - arr.length), resetMs: Math.max(1, windowMs), count: arr.length };
}

/* - util penyusun hasil client-side --------------------------------- */
function resultShape(mode) {
  return {
    ok: true, // izin lolos
    limited: false, // ditahan oleh limit window
    blocked: false, // sedang diblok sementara
    reason: null,
    mode,
    remaining: null, // sisa kuota window global IP
    endpointRemaining: null,
    resetMs: null,
    retryAfterSec: null,
  };
}

/* -- temporary blocking (TTL kedaluwarsa otomatis) ------------------- */

async function temporaryBlock(ip, seconds, reason) {
  const ttl = Math.max(1, Number(seconds || CONFIG.blockTtlSec));
  const b = initBackend();
  if (b.mode === 'redis') {
    try {
      await b.redis.set(KEY_PREFIX + ':block:' + ip, String(reason || 'rate-limit'), { ex: ttl });
      return true;
    } catch {
      failBackend(b);
      return false;
    }
  }
  if (b.mode === 'memory') {
    mem.blocks.set(ip, Date.now() + ttl * 1000);
    memTrim();
    return true;
  }
  return false;
}

async function isTemporarilyBlocked(ip) {
  const b = initBackend();
  if (b.mode === 'redis') {
    try {
      const ttl = await b.redis.ttl(KEY_PREFIX + ':block:' + ip);
      return ttl > 0 ? { blocked: true, retryAfterSec: ttl } : { blocked: false, retryAfterSec: 0 };
    } catch {
      failBackend(b);
      return { blocked: false, retryAfterSec: 0, degraded: true };
    }
  }
  if (b.mode === 'memory') {
    const until = mem.blocks.get(ip) || 0;
    const now = Date.now();
    if (until > now) return { blocked: true, retryAfterSec: Math.ceil((until - now) / 1000) };
    return { blocked: false, retryAfterSec: 0 };
  }
  return { blocked: false, retryAfterSec: 0 };
}

function failBackend() {
  warnOnce(
    'redis-err',
    '[xbypass][ratelimit] Upstash Redis gagal saat dipakai — mode degraded (fail-open, tanpa perlindungan global).'
  );
}

/* -- entry point utama ---------------------------------------------- */

/**
 * Periksa & catat request berdasarkan IP dan endpoint.
 * @param {{ip:string, endpoint:string}} req
 * @returns {Promise<object>} info limit (limited/blocked/remaining/reset)
 */
async function checkRateLimit({ ip, endpoint } = {}) {
  if (!ip || typeof ip !== 'string') {
    return { ...resultShape('invalid-input'), reason: 'missing_ip' };
  }
  const b = initBackend();
  const scope = String(endpoint || 'global').slice(0, 120);

  /* 1. blokir sementara aktif (jika ada) */
  const block = await isTemporarilyBlocked(ip);
  const out = resultShape(b.mode);
  if (block.blocked) {
    out.ok = false;
    out.blocked = true;
    out.limited = true;
    out.reason = 'temporary_block';
    out.retryAfterSec = block.retryAfterSec || CONFIG.blockTtlSec;
    out.resetMs = Math.max(1, (block.retryAfterSec || CONFIG.blockTtlSec) * 1000);
    return out;
  }

  if (b.mode === 'unconfigured' || b.mode === 'degraded') {
    // fail-open eksplisit; status jelas via getRateLimitStatus()
    out.reason = 'rate_limiting_' + b.mode;
    return out;
  }

  if (b.mode === 'redis') {
    try {
      /* cooldown pasangan IP+endpoint: SET NX PX */
      const cdKey = KEY_PREFIX + ':cd:' + ip + ':' + scope;
      const cd = await b.redis.set(cdKey, '1', { px: Math.max(1, CONFIG.cooldownMs), nx: true });
      // cd: string "OK" bila baru, null bila masih dalam cooldown
      if (cd === null && CONFIG.cooldownMs > 0) {
        const limited = markLimited(out, 'cooldown', CONFIG.cooldownMs);
        out.retryAfterSec = Math.max(1, Math.ceil(CONFIG.cooldownMs / 1000));
        await countViolation(b, ip, out);
        return limited;
      }

      /* window endpoint: kecil, cek dulu supaya remaining global valid */
      const ep = await b.endpointLimiter.limit('ep:' + ip + ':' + scope);
      if (!ep.success) {
        const limited = markLimited(out, 'endpoint_limit', ep.reset);
        out.retryAfterSec = Math.max(1, Math.ceil(ep.reset / 1000));
        await countViolation(b, ip, out);
        return limited;
      }

      /* window global IP */
      const ipRes = await b.ipLimiter.limit('ip:' + ip);
      if (!ipRes.success) {
        const limited = markLimited(out, 'ip_limit', ipRes.reset);
        out.retryAfterSec = Math.max(1, Math.ceil(ipRes.reset / 1000));
        await countViolation(b, ip, out);
        return limited;
      }

      out.ok = true;
      out.remaining = ipRes.remaining;
      out.endpointRemaining = ep.remaining;
      out.resetMs = ipRes.reset;
      return out;
    } catch {
      failBackend(b);
      const out2 = resultShape('degraded');
      out2.reason = 'redis_error';
      return out2;
    }
  }

  if (b.mode === 'memory') {
    memTrim();
    /* cooldown */
    const cdKey = ip + '\n' + scope;
    const last = mem.cooldown.get(cdKey) || 0;
    const now = Date.now();
    if (CONFIG.cooldownMs > 0 && now - last < CONFIG.cooldownMs) {
      mem.cooldown.set(cdKey, last || now); // jangan refresh spam: pakai last semula
      const limited = markLimited(out, 'cooldown', last + CONFIG.cooldownMs - now);
      out.retryAfterSec = Math.max(1, Math.ceil((last + CONFIG.cooldownMs - now) / 1000));
      memViolationSet(ip, now);
      return maybeBlockFromViolations(out, ip);
    }
    mem.cooldown.set(cdKey, now);

    /* window endpoint */
    const epKey = 'ep:' + ip + ':' + scope;
    const epWin = CONFIG.endpointWindowSec * 1000;
    const ep = memWindow(epKey, CONFIG.endpointLimit, epWin);
    if (!ep.allowed) {
      const limited = markLimited(out, 'endpoint_limit', ep.resetMs);
      out.retryAfterSec = Math.max(1, Math.ceil(ep.resetMs / 1000));
      memViolationSet(ip, now);
      return maybeBlockFromViolations(out, ip);
    }

    /* window global */
    const ipKey = 'ip:' + ip;
    const ipWin = CONFIG.ipWindowSec * 1000;
    const ipRes = memWindow(ipKey, CONFIG.ipLimit, ipWin);
    if (!ipRes.allowed) {
      const limited = markLimited(out, 'ip_limit', ipRes.resetMs);
      out.retryAfterSec = Math.max(1, Math.ceil(ipRes.resetMs / 1000));
      memViolationSet(ip, now);
      return maybeBlockFromViolations(out, ip);
    }

    out.ok = true;
    out.remaining = ipRes.remaining;
    out.endpointRemaining = ep.remaining;
    out.resetMs = ipRes.resetMs;
    return out;
  }

  // unknown backend
  const out3 = resultShape(b.mode);
  out3.reason = 'unknown_backend_' + b.mode;
  return out3;
}

/* -- util memengaruhi hasil & pelanggaran --------------------------- */

function markLimited(out, reason, resetMs) {
  out.ok = false;
  out.limited = true;
  out.reason = reason;
  out.resetMs = resetMs;
  return out;
}

async function countViolation(b, ip, out) {
  let count = 1;
  try {
    count = await b.redis.incr(KEY_PREFIX + ':viol:' + ip);
    if (count === 1) {
      await b.redis.expire(KEY_PREFIX + ':viol:' + ip, Math.max(CONFIG.ipWindowSec, 60) * 2);
    }
  } catch {
    failBackend(b);
    return;
  }
  if (count >= CONFIG.violationThreshold) {
    await temporaryBlock(ip, CONFIG.blockTtlSec, reasonLabel(out.reason));
    out.blocked = true;
    out.retryAfterSec = CONFIG.blockTtlSec;
    out.resetMs = CONFIG.blockTtlSec * 1000;
  }
}

function memViolationSet(ip, now) {
  const v = mem.violations.get(ip);
  if (!v || now - v.windowStart > 120000) mem.violations.set(ip, { count: 1, windowStart: now });
  else v.count += 1;
}

function maybeBlockFromViolations(out, ip) {
  const v = mem.violations.get(ip);
  if (v && v.count >= CONFIG.violationThreshold) {
    mem.blocks.set(ip, Date.now() + CONFIG.blockTtlSec * 1000);
    out.blocked = true;
    out.reason = out.reason || 'temporary_block';
    out.retryAfterSec = CONFIG.blockTtlSec;
    out.resetMs = CONFIG.blockTtlSec * 1000;
  }
  return out;
}

function reasonLabel(reason) {
  return 'rate_over_' + (reason || 'limit');
}

/* ================================================================ */
/* Public API (CommonJS)                                             */
/* ================================================================ */

module.exports = {
  checkRateLimit,
  temporaryBlock,
  isTemporarilyBlocked,
  getRateLimitStatus,
  resetBackendForTest,
  CONFIG,
  REDIS_ENV: { URL: REDIS_URL_ENV, TOKEN: REDIS_TOKEN_ENV },
  KEY_PREFIX,
};
