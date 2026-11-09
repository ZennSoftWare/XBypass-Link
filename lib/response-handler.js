#!/usr/bin/env node
/* ============================================================
 * lib/response-handler.js — XBypass
 * ============================================================
 * Pengelolaan respons API agar seluruh endpoint memakai format
 * JSON yang konsisten (satu sumber kebenaran format):
 *
 *   SUKSES:
 *   {
 *     "success": true,
 *     "provider": "sfl",
 *     "targetUrl": "https://...",
 *     "message": "Bypass berhasil"
 *   }
 *
 *   GAGAL:
 *   {
 *     "success": false,
 *     "provider": "sfl",
 *     "error": { "code": "BYPASS_FAILED", "message": "URL gagal diproses" }
 *   }
 *
 * Prinsip:
 *   - buildSuccess()/buildError() dipakai BAIK oleh fungsi send* (Node res)
 *     MAUPUN middleware Vercel (web Response) — tidak ada duplikasi format.
 *   - Sukses hanya diklaim bila target URL valid http/https dan memang
 *     hasil engine berstatus resolved. Hasil bertipe CAPTCHA / passcode /
 *     butuh interaksi TIDAK pernah diubah menjadi sukses palsu.
 *   - Pesan error disanitasi: tidak ada stack trace, path internal,
 *     kredensial, atau alamat internal yang terbocor ke pengguna.
 * ============================================================ */
'use strict';

const urlValidator = require('./url-validator.js');

/* ==================================================================== */
/* Kode & status HTTP                                                    */
/* ==================================================================== */

const ERROR_CODE_DEFAULT_MESSAGE = {
  EMPTY_URL: 'Link masih kosong. Tempel atau ketik link terlebih dahulu.',
  INVALID_URL: 'Format link tidak valid. Gunakan alamat yang diawali http:// atau https://.',
  BAD_PROTOCOL: 'Protokol link tidak didukung. Gunakan http:// atau https://.',
  BAD_PORT: 'Port pada link tidak diizinkan.',
  CREDENTIALS: 'Link tidak boleh berisi username/password.',
  BLOCKED_ADDRESS: 'Alamat tujuan termasuk alamat internal dan tidak diizinkan.',
  SUSPICIOUS_HOST: 'Hostname link tidak valid.',
  UNSUPPORTED_DOMAIN: 'Domain ini belum didukung. Cek daftar Bypass yang Didukung.',
  PROVIDER_DISABLED: 'Provider untuk domain ini sedang dinonaktifkan.',

  SUSPICIOUS_REQUEST: 'Format permintaan mencurigakan dan ditolak.',
  BOT_BLOCKED: 'Akses ditolak: pola permintaan otomatis (non-browser) terdeteksi.',
  VALIDATION: 'Permintaan tidak valid.',

  METHOD_NOT_ALLOWED: 'Metode HTTP tidak diizinkan untuk endpoint ini.',
  UNSUPPORTED_MEDIA_TYPE: 'Content-Type harus application/json.',
  PAYLOAD_TOO_LARGE: 'Ukuran permintaan melebihi batas.',
  ORIGIN_FORBIDDEN: 'Origin permintaan tidak diizinkan.',

  IP_BLOCKED: 'Akses sementara ditolak. Coba lagi beberapa saat kemudian.',
  RATE_LIMITED: 'Terlalu banyak permintaan. Beri jeda sebentar.',
  IP_LIMIT: 'Terlalu banyak permintaan dari sambungan ini. Beri jeda sebentar.',
  ENDPOINT_LIMIT: 'Terlalu banyak permintaan untuk endpoint ini. Beri jeda sebentar.',
  COOLDOWN: 'Permintaan terlalu cepat. Tunggu beberapa detik lagi.',
  DUPLICATE_REQUEST: 'Permintaan duplikat melebihi batas. Tunggu beberapa detik lagi.',
  TOO_MANY_TARGETS: 'Terlalu banyak link berbeda diproses dalam waktu singkat.',

  API_UNAVAILABLE: 'API belum terintegrasi untuk provider ini.',
  ENGINE_CAPTCHA: 'Link ini memerlukan verifikasi captcha dan tidak bisa diproses otomatis.',
  ENGINE_PASSWORD: 'Link ini dilindungi sandi dari pembuatnya.',
  ENGINE_INTERACTION: 'Link ini membutuhkan tindakan/verifikasi di situs asalnya.',
  NOT_FOUND: 'Shortlink tidak ditemukan atau sudah dihapus.',
  EXPIRED: 'Link ini sudah kedaluwarsa atau tidak aktif.',
  BYPASS_FAILED: 'URL gagal diproses.',
  NO_TARGET_URL: 'Respons sukses, tetapi tidak berisi link tujuan.',
  INVALID_TARGET: 'Link tujuan dari server bukan URL http/https yang valid.',
  INVALID_JSON: 'Respons server bukan JSON yang valid.',
  INVALID_RESPONSE: 'Format respons server tidak dikenali.',
  TIMEOUT: 'Permintaan melewati batas waktu. Coba lagi.',
  INTERNAL_ERROR: 'Terjadi kesalahan tak terduga.',
};

const HTTP_STATUS_BY_CODE = {
  // 400 — kesalahan input pengguna
  EMPTY_URL: 400,
  INVALID_URL: 400,
  BAD_PROTOCOL: 400,
  BAD_PORT: 400,
  CREDENTIALS: 400,
  BLOCKED_ADDRESS: 400,
  SUSPICIOUS_HOST: 400,
  UNSUPPORTED_DOMAIN: 400,
  PROVIDER_DISABLED: 400,
  SUSPICIOUS_REQUEST: 400,
  VALIDATION: 400,
  ORIGIN_FORBIDDEN: 403,
  // 4xx lain
  IP_BLOCKED: 403,
  BOT_BLOCKED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  EXPIRED: 410,
  // 429 — pembatasan
  RATE_LIMITED: 429,
  IP_LIMIT: 429,
  ENDPOINT_LIMIT: 429,
  COOLDOWN: 429,
  DUPLICATE_REQUEST: 429,
  TOO_MANY_TARGETS: 429,
  // 5xx — sisi server / engine
  API_UNAVAILABLE: 501,
  ENGINE_CAPTCHA: 502,
  ENGINE_PASSWORD: 502,
  ENGINE_INTERACTION: 502,
  BYPASS_FAILED: 502,
  NO_TARGET_URL: 502,
  INVALID_TARGET: 502,
  INVALID_JSON: 502,
  INVALID_RESPONSE: 502,
  TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

const CLASSES = {
  '4xx': 'client',
  '5xx': 'engine',
  'LIMIT': 'limit',
  'SECURITY': 'security',
};

/* ==================================================================== */
/* Sanitasi pesan (anti kebocoran informasi internal)                    */
/* ==================================================================== */

function isPrivateIPv4Token(ip) {
  const m = ip.split('.').map(Number);
  if (m.length !== 4 || m.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = m;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * sanitizeMessage — buang potensi kebocoran internal dari teks pesan:
 *   - baris stack ("at ..."),
 *   - path file internal (node_modules, /home, D:\, dsb.),
 *   - IP privat,
 *   - struktur key: secret/token (mis. token=xxx),
 *   - tab/newline/control char.
 */
function sanitizeMessage(message, maxLength = 300) {
  if (message == null) return '';
  let text;
  try {
    text = String(message);
  } catch (_) {
    return '';
  }

  // buang baris stack trace
  const lines = text.split('\n').filter((line) => !/^\s*at\s/.test(line));
  text = lines.join(' ');

  // buang segmen path internal
  text = text.replace(/(?:node_modules|\/home\/|\/var\/|\/tmp\/|C:\\|D:\\|E:\\)[^\s'""'']*/g, '[internal]');

  // buang hex/garbage & file lokal .js/.mjs/.cjs/.json yang menyerupai path
  text = text.replace(/\S+\.(?:js|cjs|mjs|ts|json)(?::\d+)*(?::\d+)?\S*/g, (m) => (/^https?:\/\//i.test(m) ? m : '[internal]'));

  // IP privat diembunyikan (URL publik tidak tersentuh)
  text = text.replace(/(?<!\w)(?:\d{1,3}\.){3}\d{1,3}(?:\/\d+)?(?!\w)/g, (ip) => (isPrivateIPv4Token(ip) ? '[ip-internal]' : ip));

  // kredensial/token dalam bentuk key: value / key=value
  text = text.replace(/(token|secret|password|passwd|passcode|authorization|bearer|api[-_]?key)\s*[:=]\s*([^\s;,}]+)/gi,
    (all, key) => '[' + key.toLowerCase() + '-disembunyikan]');

  // normalisasi whitespace & karakter kontrol
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  if (text.length > maxLength) text = text.slice(0, maxLength - 1).trimEnd() + '…';
  return text;
}

function normalizeCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (ERROR_CODE_DEFAULT_MESSAGE[c]) return c;
  return 'INTERNAL_ERROR';
}

function resolveStatus(code, explicit) {
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return HTTP_STATUS_BY_CODE[code] || 400;
}

/* ==================================================================== */
/* Builder respons (dipakai Node res & web Response)                     */
/* ==================================================================== */

/**
 * buildSuccess — objek sukses sesuai format frontend.
 * targetUrl VALIDASI KERAS: hanya http/https publik yang boleh masuk.
 * @returns {{success:true,provider:string,targetUrl:string,message:string}}
 *          atau {success:false,error} bila targetUrl tidak valid.
 */
function buildSuccess({ provider, targetUrl, message } = {}) {
  const name = String(provider || '').trim();
  const parsed = typeof targetUrl === 'string'
    ? urlValidator.validateTargetUrl(targetUrl)
    : { ok: false };

  if (!parsed.ok) {
    return {
      success: false,
      provider: name || null,
      error: {
        code: 'INVALID_RESPONSE',
        message: 'Hasil proses tidak berisi link tujuan yang valid.',
      },
    };
  }

  return {
    success: true,
    provider: name,
    targetUrl: parsed.url.toString(),
    message: sanitizeMessage(message, 160) || 'Bypass berhasil',
  };
}

/**
 * buildError — objek gagal sesuai format frontend.
 * Stack trace / data sensitif tidak pernah diteruskan ke body.
 */
function buildError({ code, message, provider } = {}) {
  const finalCode = normalizeCode(code);
  const safe = sanitizeMessage(message);
  return {
    success: false,
    provider: String(provider || '').trim() || null,
    error: {
      code: finalCode,
      message: safe || ERROR_CODE_DEFAULT_MESSAGE[finalCode],
    },
  };
}

/* ==================================================================== */
/* Pengiriman respons (Vercel Node handler — res indikator)              */
/* ==================================================================== */

function applyJsonHeaders(res) {
  try {
    res.setHeader && res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader && res.setHeader('Cache-Control', 'no-store');
  } catch (_) { /* header opsional */ }
}

/**
 * sendJson — kirim objek apa pun sebagai JSON dengan status tertentu.
 * @param {import('http').ServerResponse} res
 */
function sendJson(res, status, body) {
  if (!res || typeof res !== 'object') return;
  if (!Number.isInteger(status)) status = 500;
  const payload = JSON.stringify(body);
  try {
    res.statusCode = status;
    applyJsonHeaders(res);
    res.setHeader('Content-Length', String(Buffer.byteLength(payload)));
    res.end(payload);
  } catch (_) {
    try { res.statusCode = 500; res.end('{"success":false,"error":{"code":"INTERNAL_ERROR","message":"Terjadi kesalahan tak terduga."}}'); } catch (_) {/* diam */}
  }
}

/**
 * sendSuccess — sukses; targetUrl diverifikasi keras.
 * @returns {object} body yang sudah terkirim (memudahkan pemeriksaan)
 */
function sendSuccess(res, { provider, targetUrl, message, status = 200 } = {}) {
  const body = buildSuccess({ provider, targetUrl, message });
  if (!body.success) {
    sendJson(res, HTTP_STATUS_BY_CODE.INVALID_RESPONSE, body);
    return body;
  }
  sendJson(res, status, body);
  return body;
}

/**
 * sendError — gagal + logging internal SEBELUM sanitasi (tanpa stack ke user).
 */
function sendError(res, { code, message, provider, status, internal } = {}) {
  if (internal) {
    try {
      console.error('[response-handler]', code || 'unknown', sanitizeMessage(internal.message || internal, 800));
    } catch (_) { /* logging internal terbaik-usaha */ }
  }
  const body = buildError({ code, message, provider });
  sendJson(res, resolveStatus(normalizeCode(code), status), body);
  return body;
}

/* ==================================================================== */
/* Intepretasi hasil engine (banyak engine, format berbeda)              */
/* ==================================================================== */

/* lokasi kandidat link tujuan — EXCLUDE original_url di root (echo input) */
const TARGET_PATHS = [
  'final_url',                 // sfl, pastelink-net(data.final_url)
  'destination_url',           // shrinkme, sub2unlock-io, sub4unlock-com, subs4unlock-id, pastelink-net
  'target_url',                // pastelink-id
  'data.destination_url',      // bicolink, pastelink-net
  'data.final_url',            // pastelink-net
  'destination.original_url',  // sub2unlock-me
  'destination.url',           // subs4unlock-com
];

const RESOLUTION_DENY_STATUS = new Set(['failed', 'error', 'not_found', 'expired', 'partial', 'requires_interaction', 'requires_verification']);

function getPath(obj, path) {
  let v = obj;
  for (const k of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[k];
  }
  return typeof v === 'string' ? v : undefined;
}

/** flag yang menyatakan "resolved" di berbagai engine */
function isResolvedLike(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.status === true) return true;                        // mayoritas engine
  if (result.is_resolved === true) return true;                   // subs4unlock-id
  if (result.data && result.data.resolution_status === 'resolved') return true; // bicolink
  return false;
}

function collectBlockMarkers(result) {
  const markers = [];
  const push = (code) => { if (!markers.includes(code)) markers.push(code); };

  const data = (result && typeof result.data === 'object' && result.data) || {};
  const page = (result && typeof result.page === 'object' && result.page) || {};
  const dest = (result && typeof result.destination === 'object' && result.destination) || {};

  // 1) marker boolean eksplisit
  if (result.captcha_required === true || data.captcha_required === true || page.captcha_required === true) push('ENGINE_CAPTCHA');
  if (result.password_required === true || data.password_required === true) push('ENGINE_PASSWORD');
  if (page.password_protected === true) push('ENGINE_PASSWORD');
  if (result.requires_interaction === true || data.requires_interaction === true) push('ENGINE_INTERACTION');
  if (result.requires_verification === true) push('ENGINE_INTERACTION');
  if (dest.unlock_required === true || result.unlock_required === true) push('BYPASS_FAILED');
  if (resv(result) === false) push('BYPASS_FAILED');
  if (dest.status === 'locked') push('BYPASS_FAILED');

  // 2) resolution_status deny (bicolink / subs4unlock-id)
  const rs = [result.resolution_status, data.resolution_status].filter(Boolean);
  for (const s of rs) {
    const str = String(s);
    if (!RESOLUTION_DENY_STATUS.has(str)) continue;
    if (str === 'not_found') push('NOT_FOUND');
    else if (str === 'expired') push('EXPIRED');
    else if (str === 'requires_interaction' || str === 'requires_verification') push('ENGINE_INTERACTION');
    else push('BYPASS_FAILED');
  }

  // 3) page_status (pastelink-net maupun subs4unlock-com)
  const ps = [result.page_status, data.page_status, page.status].filter(Boolean);
  for (const s of ps) {
    const str = String(s);
    if (str === 'captcha_required') push('ENGINE_CAPTCHA');
    else if (str === 'password_required') push('ENGINE_PASSWORD');
    else if (str === 'expired') push('EXPIRED');
    else if (str === 'unavailable') push('NOT_FOUND');
  }

  // 4) teks: pesan engine (error string / resolver.message / message)
  const texts = [
    typeof result.error === 'string' ? result.error : (result.error && result.error.message),
    result.resolver && result.resolver.message,
    result.message,
    data.error,
  ].filter(Boolean);

  for (const t of texts) {
    const s = String(t).toLowerCase();
    if (/turnstile|captcha|recaptcha|hcaptcha/.test(s)) push('ENGINE_CAPTCHA');
    else if (/passcode|dilindungi passcode|password/.test(s)) push('ENGINE_PASSWORD');
    else if (/requires?[_ ]?interaction|membutuhkan interaksi|human verifica/.test(s)) push('ENGINE_INTERACTION');
    else if (/not[- ]found|404|tidak ditemukan/.test(s)) push('NOT_FOUND');
  }

  return markers;
}

function resv(result) {
  return (result && result.resolver && result.resolver.resolved);
}

/**
 * interpretEngineResult — pusat kepuasan aturan kejujuran engine:
 * SUKSES HANYA bila status resolved + target URL http/https valid.
 * Marker captcha/passcode/interaksi TIDAK pernah jadi sukses palsu.
 *
 * @param {string} provider — id provider (opsional utk provider field)
 * @param {object|null} result — hasil fungsi engine apapun skemanya
 * @returns {{success:boolean,targetUrl:string|null,code:string,message:string}}
 */
function interpretEngineResult(provider, result) {
  const providerName = String(provider || '').trim();

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { success: false, targetUrl: null, code: 'INVALID_RESPONSE', message: null };
  }

  const markers = collectBlockMarkers(result);

  // Cari target valid (http/https publik)
  let targetUrl = null;
  for (const path of TARGET_PATHS) {
    const raw = getPath(result, path);
    if (!raw) continue;
    const v = urlValidator.validateTargetUrl(raw);
    if (v.ok) { targetUrl = v.url.toString(); break; } else if (v.reason === 'BLOCKED_ADDRESS') { continue; } // pindah kandidat berikutnya
  }

  // Marker pagar: captcha/passcode/interaksi/lock TIDAK PERNAH sukses palsu
  if (markers.length) {
    const code = markers[0];
    return { success: false, targetUrl, code, message: null };
  }

  const resolved = isResolvedLike(result);
  if (!resolved || !targetUrl) {
    let message = null;
    if (typeof result.error === 'string' && result.error) message = result.error;
    else if (result.resolver && result.resolver.message) message = result.resolver.message;
    else if (result.message) message = result.message;

    const sflText = (message && /(not[- ]found|404|tidak ditemukan|kedaluwarsa|expired)/i.test(message)) ? 'NOT_FOUND' : 'BYPASS_FAILED';
    return {
      success: false,
      targetUrl,
      code: resolved && !targetUrl ? 'NO_TARGET_URL' : sflText,
      message,
    };
  }

  return { success: true, targetUrl, code: null, message: null };
}

/**
 * respondThroughEngine — adapter siap-pakai untuk handler HTTP:
 * fungsi engine dijalankan, hasil diputus oleh interpretEngineResult,
 * lalu dikirim sesuai kontrak respons frontend.
 */
async function respondThroughEngine(res, { provider, endpoint, engineFn, engineArgs, raiseUnknown }) {
  let result;
  try {
    result = await engineFn(...(engineArgs || []));
  } catch (err) {
    const isTimeout = err && (err.name === 'AbortError' || err.code === 'ETIMEDOUT');
    const message = isTimeout
      ? 'Permintaan melewati batas waktu. Coba lagi.'
      : null;
    sendError(res, {
      provider,
      code: isTimeout ? 'TIMEOUT' : 'BYPASS_FAILED',
      message,
      internal: err,
    });
    return null;
  }

  const verdict = interpretEngineResult(provider, result);
  if (verdict.success) {
    return sendSuccess(res, { provider, targetUrl: verdict.targetUrl, message: 'Bypass berhasil' });
  }

  const code = verdict.code || (raiseUnknown ? 'INTERNAL_ERROR' : 'BYPASS_FAILED');
  if (raiseUnknown && code === 'INTERNAL_ERROR' && result && result.error === undefined) {
    // error asing di engine — dicatat internal
    console.error('[response-handler] hasil engine abnormal untuk', provider);
  }
  sendError(res, { provider, code, message: verdict.message, internal: verdict.internal || null });
  return null;
}

/* ==================================================================== */
/* Exports                                                               */
/* ==================================================================== */

module.exports = {
  // format & builder
  buildSuccess,
  buildError,
  ERROR_CODE_DEFAULT_MESSAGE,
  HTTP_STATUS_BY_CODE,
  CLASSES,
  // kirim ke res Node
  sendJson,
  sendSuccess,
  sendError,
  // intepretasi hasil engine
  interpretEngineResult,
  respondThroughEngine,
  // util
  sanitizeMessage,
  resolveStatus,
};
