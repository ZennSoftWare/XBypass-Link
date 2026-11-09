#!/usr/bin/env node
/* ============================================================
 * lib/rate-limit.js — XBypass
 * ============================================================
 * Rate limiting (sliding window) untuk lingkungan Vercel Serverless.
 *
 * ARSITEKTUR PENYIMPANAN:
 *   1. MODE "redis"   (produksi) — @upstash/ratelimit + @upstash/redis.
 *      Counter & window disimpan di Upstash Redis sehingga berlaku
 *      GLOBAL antar instance serverless (bukan per-instance).
 *   2. MODE "memory-fallback" (pengembangan lokal saja) — Map/memory.
 *      Sengaja TIDAK dipakai sebagai perlindungan produksi karena
 *      Vercel menjalankan banyak instance.
 *   3. MODE "disabled" — production/preview TANPA env Upstash:
 *      rate limiting dinonaktifkan (fail-open supaya layanan tetap
 *      hidup) dan getStatus() menyatakan eksplisit bahwa proteksi
 *      global TIDAK aktif. Tidak pernah mengklaim lokal = global.
 *
 * FITUR:
 *   - Limit per IP  (sliding window, default 20/60s)
 *   - Limit per endpoint per IP (sliding window, default 8/60s)
 *   - Cooldown antar request (default 12s per IP+endpoint)
 *   - Penolakan request duplikat (payload hash identik, default 30s)
 *   - Batas jumlah target berbeda per IP (anti-mass-scraping, default 40/10m)
 *   - Temporary IP blocking via TTL (blokir kedaluwarsa otomatis)
 *   - Eskalasi: pelanggaran beruntun -> blok sementara (TTL)
 *   - Semua limit dikonfigurasi lewat environment variable RL_*
 *
 * ATURAN KETAT:
 *   - Tidak ada permaban permanen; semua blok memakai TTL.
 *   - User-Agent TIDAK dipakai sebagai kunci blok permanen.
 *   - Tidak menyimpan daftar blokir permanen di variabel lokal.
 * ============================================================ */
'use strict';

/* ==================================================================== */
/* Import defensif (paket dideklarasikan di package.json)                */
/* ==================================================================== */

let RedisClass = null;
let RatelimitClass = null;
try {
  const m = require('@upstash/redis');
  RedisClass = m.Redis || m.default || null;
} catch (_) { /* dotenv-less dev: modul otoritas Redis tidak tersedia */ }
try {
  const m = require('@upstash/ratelimit');
  RatelimitClass = m.Ratelimit || m.default || null;
} catch (_) { /* fallback memori tetap berfungsi */ }

/* ==================================================================== */
/* Konfigurasi lewat environment variable                                */
/* ==================================================================== */

function envInt(name, fallback, { min = 0 } = {}) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

const CONFIG = Object.freeze({
  ipMax: envInt('RL_IP_MAX', 20, { min: 1 }),
  ipWindowMs: envInt('RL_IP_WINDOW_MS', 60_000),
  endpointMax: envInt('RL_ENDPOINT_MAX', 8, { min: 1 }),
  endpointWindowMs: envInt('RL_ENDPOINT_WINDOW_MS', 60_000),
  cooldownMs: envInt('RL_COOLDOWN_MS', 12_000),
  duplicateWindowMs: envInt('RL_DUPLICATE_WINDOW_MS', 30_000),
  maxTargets: envInt('RL_MAX_TARGETS', 40, { min: 1 }),
  targetWindowMs: envInt('RL_TARGET_WINDOW_MS', 600_000),
  blockTtlMs: envInt('RL_BLOCK_TTL_MS', 600_000),
  violationThreshold: envInt('RL_VIOLATION_THRESHOLD', 5, { min: 1 }),
  violationWindowMs: envInt('RL_VIOLATION_WINDOW_MS', 900_000),
});

const KEY_PREFIX = 'xbypass:rl';

/* ==================================================================== */
/* Mode penyimpanan                                                      */
/* ==================================================================== */

function isUpstashConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * 'development' (vercel dev / local) | 'deployment' (production & preview)
 */
function detectEnvironment() {
  const env = process.env.VERCEL_ENV;
  if (!env) return 'development';
  return env === 'development' ? 'development' : 'deployment';
}

let modeCache = null;
function resolveMode() {
  if (modeCache) return modeCache;
  const configured = isUpstashConfigured();
  const env = detectEnvironment();
  if (configured) modeCache = 'redis';
  else if (env === 'development') modeCache = 'memory-fallback';
  else modeCache = 'disabled';
  return modeCache;
}

let degraded = false; // Redis sempat error -> tetap melapor secara jujur

/**
 * getStatus — status konfigurasi rate limiting yang JUJUR:
 * tidak pernah mengklaim proteksi global bila yang aktif bukan Redis.
 */
function getStatus() {
  const mode = resolveMode();
  const configured = isUpstashConfigured();
  const environment = detectEnvironment();

  let message;
  if (mode === 'redis') {
    message = degraded
      ? 'Rate limiting Upstash Redis aktif namun koneksi sempat bermasalah (cek log). Sebagian cek dapat berjalan di penyimpanan instance.'
      : 'Rate limiting global aktif melalui Upstash Redis (sliding window, data bersama antar instance serverless).';
  } else if (mode === 'memory-fallback') {
    message = 'MODE PENGEMBANGAN LOKAL: rate memakai memori instance ini dan TIDAK berlaku antar instance Vercel. ' +
      'Setel UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN untuk proteksi production.';
  } else {
    message = 'RATE LIMITING GLOBAL NONAKTIF: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN belum disetel di environment ini. ' +
      'Tidak ada pembatasan yang dapat diklaim berlaku global.';
  }

  return {
    configured,
    mode,
    environment,
    degraded,
    globalProtection: mode === 'redis',
    limitsActive: mode === 'redis' || mode === 'memory-fallback',
    temporaryBlockingActive: mode === 'redis',
    message,
    config: { ...CONFIG },
  };
}

/* ==================================================================== */
/* Klien Redis & limiter (dibuat langsung saat digunakan)                 */
/* ==================================================================== */

let redis = null;
function ensureRedis() {
  if (redis) return redis;
  if (!RedisClass || !isUpstashConfigured()) return null;
  try {
    redis = new RedisClass({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return redis;
  } catch (_) {
    return null;
  }
}

const limiters = Object.create(null);
function ensureRatelimit(prefix, max, windowMs) {
  const r = ensureRedis();
  if (!r || !RatelimitClass) return null;
  const key = prefix + ':' + max + 'x' + windowMs;
  if (!limiters[key]) {
    limiters[key] = new RatelimitClass({
      redis: r,
      limiter: RatelimitClass.slidingWindow(max, windowMs + ' ms'),
      prefix: KEY_PREFIX + ':' + prefix,
      analytics: false,
    });
  }
  return limiters[key];
}

/** Bungkus operasi Redis; bila gagal -> degraded + fallback memori. */
async function withRedis(fn, memoryFallback) {
  if (resolveMode() !== 'redis') return memoryFallback();
  try {
    return await fn(ensureRedis());
  } catch (_) {
    degraded = true;
    return memoryFallback();
  }
}

/* ==================================================================== */
/* Penyimpanan memori (FALLBACK PENGEMBANGAN LOKAL SAJA)                  */
/* Tidak pernah dipakai pada production/preview sebagai proteksi global.  */
/* ==================================================================== */

const MEM_MAX_KEYS = 20_000;
const memoryWindow = new Map(); // key -> [timestamps]
const memoryKV = new Map();    // key -> { value, expiresAt }
const memorySet = new Map();   // key -> { values:Set, expiresAt }

function memPrune(kind, now) {
  const store = kind === 'window' ? memoryWindow : kind === 'set' ? memorySet : memoryKV;
  if (store.size <= MEM_MAX_KEYS) return;
  for (const [k, v] of store) {
    if (kind === 'kv' && v.expiresAt && v.expiresAt <= now) store.delete(k);
    else if (kind === 'set' && v.expiresAt <= now) store.delete(k);
    else if (kind === 'window' && Array.isArray(v) && (v.length === 0 || now - v[v.length - 1] > 3 * 60_000)) store.delete(k);
    if (store.size <= MEM_MAX_KEYS) return;
  }
}

/** Sliding window murni di memori: timestamps dalam rentang window. */
function memLimit(key, max, windowMs, now = Date.now()) {
  memPrune('window', now);
  let q = memoryWindow.get(key);
  if (!q) { q = []; memoryWindow.set(key, q); }
  const cutoff = now - windowMs;
  while (q.length && q[0] <= cutoff) q.shift();
  q.push(now);
  return {
    success: q.length <= max,
    limit: max,
    remaining: Math.max(0, max - q.length),
    reset: q[0] + windowMs,
  };
}

function memSetTTL(key, value, ttlMs) {
  memPrune('kv', Date.now());
  memoryKV.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
}

function memGetTTL(key) {
  const e = memoryKV.get(key);
  if (!e) return null;
  if (e.expiresAt && e.expiresAt <= Date.now()) { memoryKV.delete(key); return null; }
  return e.value;
}

function memDel(key) {
  memoryKV.delete(key);
  memorySet.delete(key);
  memoryWindow.delete(key);
}

function memIncrWindow(key, windowMs) {
  const n = memGetTTL(key);
  const value = (Number.isFinite(Number(n)) ? Number(n) : 0) + 1;
  const existing = memoryKV.get(key);
  const expiresAt = existing && existing.expiresAt ? existing.expiresAt : Date.now() + windowMs;
  memPrune('kv', Date.now());
  memoryKV.set(key, { value, expiresAt });
  return value;
}

function memorySetCount(key, member, windowMs) {
  const now = Date.now();
  memPrune('set', now);
  let entry = memorySet.get(key);
  if (!entry || entry.expiresAt <= now) {
    entry = { values: new Set(), expiresAt: now + windowMs };
  }
  entry.values.add(member);
  memorySet.set(key, entry);
  return entry.values.size;
}

function memorySetSize(key) {
  const entry = memorySet.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return 0;
  return entry.values.size;
}

/* ==================================================================== */
/* Primitif Redis                                                        */
/* ==================================================================== */

function redisRatelimitConsume(prefix, key, max, windowMs) {
  const lim = ensureRatelimit(prefix, max, windowMs);
  if (!lim) return null;
  return lim.limit(key).then((res) => ({
    success: Boolean(res && res.success),
    limit: typeof res.limit === 'number' ? res.limit : max,
    remaining: typeof res.remaining === 'number' ? res.remaining : 0,
    reset: typeof res.reset === 'number' ? res.reset : Date.now() + windowMs,
  }));
}

function redisSetTTL(key, value, ttlMs) {
  return redis.set(key, String(value), { px: ttlMs });
}

function redisSetTTLNX(key, ttlMs) {
  return redis.set(key, String(Date.now() + ttlMs), { nx: true, px: ttlMs })
    .then((v) => v === 'OK' || v === 1);
}

function redisGetUntil(key) {
  return redis.get(key).then((v) => {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  });
}

function redisIncrWindow(key, windowMs) {
  return redis.incr(key).then(async (n) => {
    const value = Number.isFinite(n) ? n : 1;
    if (value === 1) {
      try { await redis.expire(key, Math.ceil(windowMs / 1000)); } catch (_) { /* diabaikan */ }
    }
    return value;
  });
}

function redisSetAddCount(key, member, windowMs) {
  return redis.sadd(key, member).then(async () => {
    const c = await redis.scard(key);
    return Number.isFinite(c) ? c : null;
  }).catch(() => null);
}

function redisSetSize(key) {
  return redis.scard(key).then((c) => (Number.isFinite(c) ? c : null)).catch(() => null);
}

/* Padanan memori utk operasi redis di atas */

/* ==================================================================== */
/* Operasi bersama (Redis atau memori)                                   */
/* ==================================================================== */

function limitBy(prefix, key, max, windowMs) {
  if (modeRedis()) {
    return withRedis((r) => redisRatelimitConsume(prefix, key, max, windowMs), () =>
      memLimit(KEY_PREFIX + ':' + prefix + ':' + key, max, windowMs));
  }
  return Promise.resolve(memLimit(KEY_PREFIX + ':' + prefix + ':' + key, max, windowMs));
}

function setTTLStamp(prefix, key, ttlMs) {
  if (modeRedis()) {
    return withRedis((r) => redisSetTTLNX(KEY_PREFIX + ':' + prefix + ':' + key, ttlMs), () => {
      memSetTTL(KEY_PREFIX + ':' + prefix + ':' + key, Date.now() + ttlMs, ttlMs);
      return true;
    });
  }
  memSetTTL(KEY_PREFIX + ':' + prefix + ':' + key, Date.now() + ttlMs, ttlMs);
  return Promise.resolve(true);
}

function getTTLStamp(prefix, key) {
  if (modeRedis()) {
    return withRedis((r) => redisGetUntil(KEY_PREFIX + ':' + prefix + ':' + key), () => memGetTTL(KEY_PREFIX + ':' + prefix + ':' + key));
  }
  return Promise.resolve(memGetTTL(KEY_PREFIX + ':' + prefix + ':' + key));
}

function incrInWindow(prefix, key, windowMs) {
  if (modeRedis()) {
    return withRedis((r) => redisIncrWindow(KEY_PREFIX + ':' + prefix + ':' + key, windowMs), () =>
      memIncrWindow(KEY_PREFIX + ':' + prefix + ':' + key, windowMs));
  }
  return Promise.resolve(memIncrWindow(KEY_PREFIX + ':' + prefix + ':' + key, windowMs));
}

function setMemberCount(prefix, key, member, windowMs) {
  if (modeRedis()) {
    return withRedis((r) => redisSetAddCount(KEY_PREFIX + ':' + prefix + ':' + key, member, windowMs), () =>
      memorySetCount(KEY_PREFIX + ':' + prefix + ':' + key, member, windowMs));
  }
  return Promise.resolve(memorySetCount(KEY_PREFIX + ':' + prefix + ':' + key, member, windowMs));
}

function currentSetSize(prefix, key) {
  if (modeRedis()) {
    return withRedis((r) => redisSetSize(KEY_PREFIX + ':' + prefix + ':' + key), () =>
      memorySetSize(KEY_PREFIX + ':' + prefix + ':' + key));
  }
  return Promise.resolve(memorySetSize(KEY_PREFIX + ':' + prefix + ':' + key));
}

function deleteKeys(prefix, key) {
  const full = KEY_PREFIX + ':' + prefix + ':' + key;
  if (modeRedis()) {
    return withRedis((r) => {
      // Redis: memori TTL memegang masa berlaku; hanya nilai blocks membutuhkan delete eksplisit
      memDel(full); // bersihkan sisa jejak memori instance
      return r.del(full).catch(() => 0);
    }, () => memDel(full));
  }
  memDel(full);
  return Promise.resolve(1);
}

function modeRedis() {
  return resolveMode() === 'redis';
}

/* ==================================================================== */
/* Efemeral: catatan TTL memori untuk pemantauan debug lokal             */
/* ==================================================================== */

const memoryBlocks = new Map(); // ip -> expiresAt (fallback memori saja)

function memoryBlockGet(ip) {
  const e = memoryBlocks.get(ip);
  if (!e) return null;
  if (e <= Date.now()) { memoryBlocks.delete(ip); return null; }
  return e;
}

/* ==================================================================== */
/* Temporary blocking (SELALU ber-TTL — tidak pernah permanen)           */
/* ==================================================================== */

/**
 * Blok sementara berbasis TTL. TTL yang dipilih memastikan blokir
 * kedaluwarsa otomatis — tidak pernah ada permaban permanen.
 */
function blockIpTemporary(ip, ttlMs) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : CONFIG.blockTtlMs;
  const id = String(ip || 'unknown').slice(0, 64);
  if (modeRedis()) {
    return withRedis(() => redisSetTTL(KEY_PREFIX + ':block:' + id, Date.now() + ttl, ttl)
      .then(() => ({ blocked: true, mode: 'redis', ttlMs: ttl }))
      .catch(() => {
        degraded = true;
        memoryBlocks.set(id, Date.now() + ttl);
        return { blocked: true, mode: 'memory-fallback', ttlMs: ttl };
      }));
  }
  memoryBlocks.set(id, Date.now() + ttl);
  return Promise.resolve({ blocked: true, mode: 'memory-fallback', ttlMs: ttl });
}

/** Sisa waktu blok (ms) atau 0 bila tidak diblokir. */
function remainingBlockMs(ip) {
  const id = String(ip || 'unknown').slice(0, 64);
  if (modeRedis()) {
    return withRedis(() => redisGetUntil(KEY_PREFIX + ':block:' + id).then((v) => (v ? Math.max(0, v - Date.now()) : 0))
      .catch(() => {
        degraded = true;
        return memoryBlockGet(id) ? Math.max(0, memoryBlockGet(id) - Date.now()) : 0;
      }));
  }
  return Promise.resolve(memoryBlockGet(id) ? Math.max(0, memoryBlockGet(id) - Date.now()) : 0);
}

async function isIpBlocked(ip) {
  const ms = await remainingBlockMs(ip);
  return ms > 0;
}

/** Lepas blokir (dipakai admin/alur pemulihan). */
function removeIpBlock(ip) {
  const id = String(ip || 'unknown').slice(0, 64);
  memoryBlocks.delete(id);
  if (modeRedis()) {
    return withRedis(() => redis.del(KEY_PREFIX + ':block:' + id).catch(() => 0), () => 0);
  }
  return Promise.resolve(0);
}

/* ==================================================================== */
/* Pelanggaran -> eskalasi blok sementara                                */
/* ==================================================================== */

const DENY_REASONS = new Set([
  'IP_LIMIT', 'ENDPOINT_LIMIT', 'COOLDOWN', 'DUPLICATE_REQUEST', 'TOO_MANY_TARGETS', 'SUSPICIOUS_ACCESS',
]);

async function reportViolation(ip, reason) {
  const id = String(ip || 'unknown').slice(0, 64);
  if (!DENY_REASONS.has(reason)) return { violations: 0, blocked: false };

  const count = await incrInWindow('viol', id, CONFIG.violationWindowMs);
  if (count >= CONFIG.violationThreshold) {
    const res = await blockIpTemporary(id, CONFIG.blockTtlMs);
    // reset counter pelanggaran sejak blokir sudah diterapkan
    try { await deleteKeys('viol', id); } catch (_) { /* diabaikan */ }
    return { violations: count, blocked: true, blockTtlMs: CONFIG.blockTtlMs, storage: res.mode };
  }
  return { violations: count, blocked: false };
}

/* ==================================================================== */
/* Antisipasi mass-alih target (anti-scraping): set target unik per IP    */
/* ==================================================================== */

/**
 * noteTarget — catat satu target baru (hash hostpath/link) per IP.
 * @param {string} ip
 * @param {string} targetHash — hash stabil dari URL target (disiapkan pemanggil)
 * @returns {Promise<{count:number|null, exceeded:boolean}>}
 */
async function noteTarget(ip, targetHash) {
  const id = String(ip || 'unknown').slice(0, 64);
  const member = String(targetHash || '').slice(0, 128);
  if (!member) return { count: null, exceeded: false };

  const rawKey = KEY_PREFIX + ':targets:' + id;
  let count = null;
  if (modeRedis()) {
    const r = ensureRedis();
    if (r) {
      try {
        await r.sadd(rawKey, member);
        await r.expire(rawKey, Math.ceil(CONFIG.targetWindowMs / 1000));
        const c = await r.scard(rawKey);
        count = Number.isFinite(c) ? c : null;
      } catch (_) {
        degraded = true;
        count = memorySetCount(rawKey, member, CONFIG.targetWindowMs);
      }
    } else {
      count = memorySetCount(rawKey, member, CONFIG.targetWindowMs);
    }
  } else {
    count = memorySetCount(rawKey, member, CONFIG.targetWindowMs);
  }

  return { count, exceeded: count !== null && count > CONFIG.maxTargets };
}

/* ==================================================================== */
/* titik utama: evaluateRequest                                          */
/* ==================================================================== */

function verdictBase(mode) {
  return {
    allowed: true,
    reason: 'OK',
    mode,
    limit: null,
    remaining: null,
    resetMs: null,
    retryAfterMs: null,
    blockRemainingMs: 0,
    violation: null,
  };
}

function limitedResult(mode, reason, extra) {
  return {
    allowed: false,
    reason,
    mode,
    limit: null,
    remaining: null,
    resetMs: null,
    retryAfterMs: null,
    blockRemainingMs: 0,
    violation: null,
    ...(extra || {}),
  };
}

/**
 * evaluateRequest — sumber keputusan tunggal untuk rate limit/spam.
 *
 * @param {object} input
 * @param {string} input.ip            — IP yang sudah dinormalisasi (bukan raw header)
 * @param {string} input.endpoint      — path endpoint, contoh /api/bypass-sfl
 * @param {string} [input.payloadKey]  — hash payload (untuk deteksi duplikat, opsional)
 * @returns {Promise<verdict>}
 */
async function evaluateRequest(input) {
  const ip = String((input && input.ip) || 'unknown').slice(0, 64);
  const endpoint = String((input && input.endpoint) || '').slice(0, 128);
  const payloadKey = (input && input.payloadKey) || null;
  const mode = resolveMode();
  const v = verdictBase(mode);

  // MODE disabled: production tanpa Redis -> fail-open + status jujur
  if (mode === 'disabled') {
    v.mode = mode;
    v.warn = getStatus().message;
    v.message = getStatus().message;
    return v;
  }

  // 1) IP sedang diblokir temporer?
  const blockRemaining = await remainingBlockMs(ip);
  v.blockRemainingMs = blockRemaining;
  if (blockRemaining > 0) {
    return limitedResult(mode, 'IP_BLOCKED', { retryAfterMs: blockRemaining });
  }

  // 2) IP limit (sliding window global per IP)
  const ipRes = await limitBy('ip', ip, CONFIG.ipMax, CONFIG.ipWindowMs);
  v.limit = ipRes.limit || CONFIG.ipMax;
  v.remaining = typeof ipRes.remaining === 'number' ? ipRes.remaining : null;
  v.resetMs = ipRes.reset || null;
  if (!ipRes.success) {
    const verdict = limitedResult(mode, 'IP_LIMIT', {
      limit: ipRes.limit, remaining: 0, resetMs: ipRes.reset, retryAfterMs: Math.max(1, (ipRes.reset || Date.now()) - Date.now()),
    });
    verdict.violation = await reportViolation(ip, 'IP_LIMIT');
    return verdict;
  }

  // 3) Cooldown per IP+endpoint (spam repeated in short time)
  const cdKey = endpoint ? ip + '@' + endpoint : ip;
  const cdUntil = await getTTLStamp('cd', cdKey);
  if (cdUntil && cdUntil - Date.now() > 0) {
    const verdict = limitedResult(mode, 'COOLDOWN', { retryAfterMs: cdUntil - Date.now() });
    verdict.violation = await reportViolation(ip, 'COOLDOWN');
    return verdict;
  }

  // 4) Endpoint limit per IP+endpoint
  let epRes = null;
  if (endpoint) {
    epRes = await limitBy('ep', cdKey, CONFIG.endpointMax, CONFIG.endpointWindowMs);
    if (!epRes.success) {
      const verdict = limitedResult(mode, 'ENDPOINT_LIMIT', {
        limit: epRes.limit, remaining: 0, resetMs: epRes.reset, retryAfterMs: Math.max(1, (epRes.reset || Date.now()) - Date.now()),
      });
      verdict.violation = await reportViolation(ip, 'ENDPOINT_LIMIT');
      return verdict;
    }
  }

  // 5) Request duplikat dalam window pendek (payload hash identik)
  const dupRemaining = payloadKey ? await remainingDuplicateMs(ip, endpoint, payloadKey) : 0;
  if (dupRemaining > 0) {
    const verdict = limitedResult(mode, 'DUPLICATE_REQUEST', { retryAfterMs: dupRemaining });
    verdict.violation = await reportViolation(ip, 'DUPLICATE_REQUEST');
    return verdict;
  }

  return v;
}

/* ==================================================================== */
/* Pasca-sukses: set cooldown/stamp duplikat (dipanggil bila request lolos)*/
/* ==================================================================== */

async function stampCooldown(ip, endpoint, cooldownMs) {
  const key = (endpoint ? ip + '@' + endpoint : ip);
  await setTTLStamp('cd', key, cooldownMs && cooldownMs > 0 ? cooldownMs : CONFIG.cooldownMs);
}

async function stampDuplicate(ip, endpoint, payloadKey, windowMs) {
  if (!payloadKey) return;
  const key = endpoint ? (endpoint + ':' + ip + ':' + String(payloadKey).slice(0, 128)) : (ip + ':' + String(payloadKey).slice(0, 128));
  await setTTLStamp('dup', key, windowMs && windowMs > 0 ? windowMs : CONFIG.duplicateWindowMs);
}

async function remainingDuplicateMs(ip, endpoint, payloadKey) {
  if (!payloadKey) return 0;
  const key = endpoint ? (endpoint + ':' + ip + ':' + String(payloadKey).slice(0, 128)) : (ip + ':' + String(payloadKey).slice(0, 128));
  const until = await getTTLStamp('dup', key);
  return until && until - Date.now() > 0 ? until - Date.now() : 0;
}

/* ==================================================================== */
/* Exports                                                               */
/* ==================================================================== */

module.exports = {
  // status & konfigurasi
  getConfig: () => ({ ...CONFIG }),
  getStatus,
  isUpstashConfigured,
  detectEnvironment,
  // alur keputusan
  evaluateRequest,
  reportViolation,
  // anti-scraping (target unik)
  noteTarget,
  // duplicate stamp
  stampCooldown,
  stampDuplicate,
  remainingDuplicateMs,
  // temporary blocking
  blockIpTemporary,
  removeIpBlock,
  isIpBlocked,
  remainingBlockMs,
};
