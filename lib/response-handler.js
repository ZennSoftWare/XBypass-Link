'use strict';

/* ====================================================================
 * XBypass — lib/response-handler.js
 *
 * Pusat pengelolaan respons API. Format HARUS selaras dengan frontend
 * (script.js — adapter API generik):
 *
 *   SUKSES  : { success: true,  provider, targetUrl, message }
 *   GAGAL   : { success: false, provider, error: { code, message } }
 *
 * Aturan penting (jangan dilanggar oleh endpoint apa pun):
 *  1. Hanya hasil engine yang BENAR-BENAR resolved + memiliki target URL
 *    http/https valid & publik yang boleh dijawab sebagai sukses.
 *  2. Status engine CAPTCHA / password required / membutuhkan aksi
 *    pengguna AKAN dipetakan ke kode gagal — tidak pernah disamarkan
 *    menjadi sukses palsu.
 *  3. Exception tidak pernah dibocorkan (tanpa stack trace, tanpa
 *    pesan internal mentah ke pengguna).
 *
 * Target target penggunaan: handler Node (module.exports) di folder
 * api/ — tabel CODE_STATUS & OUTPUT_MESSAGES di sini juga dipakai
 * middleware Edge sehingga konsisten satu-sumber.
 *
 * Modul ini bebas dependensi & bebas import modul core Node agar aman
 * dibundel ke middleware Edge.
 * ==================================================================== */

/* ------------------------------------------------------------------ */
/* Tabel kode → status HTTP & pesan pengguna                           */
/* ------------------------------------------------------------------ */

const CODE_STATUS = {
  // input pengguna
  INVALID_URL: 400,
  UNSUPPORTED_DOMAIN: 400,
  UNSAFE_TARGET: 400,
  RATE_LIMITED: 429,
  // pelanggaran request (dipakai middleware edge juga untuk konsistensi)
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  FORBIDDEN_ORIGIN: 403,
  // hasil engine
  BYPASS_FAILED: 502,
  NO_TARGET_URL: 502,
  INVALID_TARGET: 502,
  UNRESOLVED: 502,
  CAPTCHA_REQUIRED: 502,
  PASSWORD_REQUIRED: 502,
  INTERACTION_REQUIRED: 502,
  VERIFICATION_REQUIRED: 502,
  LOCKED_DESTINATION: 502,
  LINK_EXPIRED: 502,
  NOT_FOUND: 404,
  // sisi server / hulu
  TIMEOUT: 504,
  NETWORK_ERROR: 502,
  API_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/* Pesan default pengguna (Indonesia, tanpa detail internal). */
const OUTPUT_MESSAGES = {
  INVALID_URL: 'Format link tidak valid. Gunakan alamat http/https lengkap.',
  UNSUPPORTED_DOMAIN: 'Domain ini belum didukung. Cek daftar Bypass yang Didukung di bawah.',
  UNSAFE_TARGET: 'Alamat localhost, IP internal, atau jaringan tidak diperbolehkan.',
  RATE_LIMITED: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
  METHOD_NOT_ALLOWED: 'Metode HTTP tidak diizinkan untuk API ini.',
  PAYLOAD_TOO_LARGE: 'Ukuran request melebihi batas.',
  UNSUPPORTED_MEDIA_TYPE: 'Kirim data sebagai application/json.',
  FORBIDDEN_ORIGIN: 'Kode asal (origin) tidak diperbolehkan.',
  BYPASS_FAILED: 'URL gagal diproses.',
  NO_TARGET_URL: 'Respons sukses, tetapi tidak berisi link tujuan.',
  INVALID_TARGET: 'Link tujuan dari server bukan URL http/https yang valid.',
  UNRESOLVED: 'Link belum dapat dibuka otomatis oleh sistem.',
  CAPTCHA_REQUIRED: 'Halaman tujuan meminta captcha. Link tidak dapat diproses otomatis.',
  PASSWORD_REQUIRED: 'Halaman tujuan terkunci kata sandi dan tidak dapat dibuka otomatis.',
  INTERACTION_REQUIRED: 'Link membutuhkan tindakan pengguna dan tidak dapat dibuka otomatis.',
  VERIFICATION_REQUIRED: 'Link membutuhkan verifikasi dan tidak dapat dibuka otomatis.',
  LOCKED_DESTINATION: 'Tautan tujuan masih terkunci sepenuhnya oleh provider.',
  LINK_EXPIRED: 'Link telah kedaluwarsa.',
  NOT_FOUND: 'Link tidak ditemukan atau sudah dihapus.',
  TIMEOUT: 'Permintaan melewati batas waktu. Coba lagi.',
  NETWORK_ERROR: 'Koneksi terputus atau server tidak dapat dijangkau.',
  API_UNAVAILABLE: 'API belum terintegrasi untuk provider ini.',
  INTERNAL_ERROR: 'Terjadi kesalahan tak terduga. Coba lagi nanti.',
};

const MAX_MESSAGE_LENGTH = 240;

function clampMessage(msg, fallback) {
  let s = typeof msg === 'string' ? msg.trim() : '';
  if (!s) return fallback;
  s = s.replace(/\s+/g, ' ');
  if (s.length > MAX_MESSAGE_LENGTH) s = s.slice(0, MAX_MESSAGE_LENGTH - 1) + '…';
  return s;
}

/* -- pengirim level rendah (adaptasi Node res serverless Vercel) --- */

/** validasi format URL keluaran (boundary check saja; keamanan penuh
 *  tetap di lib/url-validator.js yang dipakai handler Node) */
function isHttpUrlString(v) {
  if (typeof v !== 'string') return false;
  let s = v.trim();
  if (!s || s.length > 2048) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * Kirim objek JSON (semua respons API dipusatkan di sini).
 * Mendukung bentuk `res` Vercel/Express (.status().json()) maupun
 * http.ServerResponse Node murni (writeHead + end) — hensel shim/test.
 * @param {object} res  res serverless Vercel atau Node
 */
function sendJson(res, status, body, extraHeaders) {
  if (!res) return false;

  const statusNum = Number(status) || 500;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
  };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) headers[k] = String(v);
    }
  }

  if (typeof res.status === 'function' && typeof res.json === 'function') {
    for (const [k, v] of Object.entries(headers)) res.setHeader && res.setHeader(k, v);
    res.status(statusNum).json(body);
    return true;
  }

  if (typeof res.writeHead === 'function' && typeof res.end === 'function') {
    res.writeHead(statusNum, headers);
    res.end(JSON.stringify(body));
    return true;
  }

  return false;
}

/**
 * Respons sukses (200). targetUrl divalidasi format — TIDAK PERNAH
 * sukses dengan target absah hilang.
 */
function sendSuccess(res, { provider, targetUrl, message } = {}) {
  if (!isHttpUrlString(targetUrl)) {
    return sendFailure(res, provider, 'NO_TARGET_URL');
  }
  return sendJson(res, 200, {
    success: true,
    provider: provider === undefined || provider === null ? null : String(provider),
    targetUrl: targetUrl.trim(),
    message: clampMessage(message, 'Bypass berhasil'),
  });
}

/**
 * Respons gagal selaras format frontend.
 * @param {string} code kode stabil untuk diupload ke frontend
 */
function sendFailure(res, provider, code, userMessage, statusOverride) {
  const knownCode = Object.prototype.hasOwnProperty.call(CODE_STATUS, code) ? code : 'BYPASS_FAILED';
  const status = statusOverride || CODE_STATUS[knownCode];
  return sendJson(res, status, {
    success: false,
    provider: provider === undefined || provider === null ? null : String(provider),
    error: {
      code: knownCode,
      message: clampMessage(userMessage, OUTPUT_MESSAGES[knownCode]),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Evaluasi hasil engine — pintu tunggal status engine → respons       */
/* ------------------------------------------------------------------ */

/* urutan kandidat field URL target sesuai bentuk keluaran 10 engine di folder api/ */
const TARGET_FIELDS = [
  ['direct', 'final_url'],        // sfl
  ['direct', 'destination_url'],  // shrinkme, bicolink, sub2unlock-io, sub4unlock-com, subs4unlock-id
  ['direct', 'target_url'],       // pastelink-id
  ['direct', 'destinationUrl'],
  ['direct', 'href'],
  ['nested', 'destination', 'url'],          // subs4unlock-com
  ['nested', 'destination', 'original_url'], // sub2unlock-me
  ['nested', 'destination', 'href'],
  ['array', 'urls', 0],           // pastelink-id urls[]
  ['array', 'links', 0],          // pastelink-net links[].url
];

function pickTargetUrl(result) {
  for (const spec of TARGET_FIELDS) {
    if (spec[0] === 'direct') {
      const v = result[spec[1]];
      if (isHttpUrlString(v)) return v;
    } else if (spec[0] === 'nested') {
      const obj = result[spec[1]];
      const v = obj && typeof obj === 'object' ? obj[spec[2]] : null;
      if (isHttpUrlString(v)) return v;
    } else if (spec[0] === 'array') {
      const arr = result[spec[1]];
      if (Array.isArray(arr) && arr.length) {
        const first = arr[spec[2]];
        const v = typeof first === 'string' ? first : first && typeof first === 'object' ? first.url : null;
        if (isHttpUrlString(v)) return v;
      }
    }
  }
  return null;
}

/** sinyal interaksi yang TIDAK boleh jadi sukses palsu */
function detectBlockingSignal(result) {
  const maps = [];
  const pageStatus = typeof result.page_status === 'string' ? result.page_status.toLowerCase() : null;
  const nestedPage = result.page && typeof result.page === 'object' ? result.page : null;
  const nestedPageStatus = nestedPage && typeof nestedPage.status === 'string' ? nestedPage.status.toLowerCase() : null;
  const nestedPageHttpStatus = nestedPage && typeof nestedPage.page_status === 'string' ? nestedPage.page_status.toLowerCase() : null;
  if (result.captcha_required === true) maps.push('CAPTCHA_REQUIRED');
  if (result.password_required === true) maps.push('PASSWORD_REQUIRED');
  if (result.requires_interaction === true) maps.push('INTERACTION_REQUIRED');
  if (
    result.requires_verification === true ||
    pageStatus === 'requires_verification' ||
    nestedPageStatus === 'requires_verification' ||
    nestedPageHttpStatus === 'requires_verification'
  ) {
    maps.push('VERIFICATION_REQUIRED');
  }
  if (pageStatus === 'captcha_required' || nestedPageStatus === 'captcha_required' || nestedPageHttpStatus === 'captcha_required') {
    maps.push('CAPTCHA_REQUIRED');
  }
  if (pageStatus === 'password_required' || nestedPageStatus === 'password_required' || nestedPageHttpStatus === 'password_required') {
    maps.push('PASSWORD_REQUIRED');
  }
  if (pageStatus === 'expired' || result.expiredDetected === true) maps.push('LINK_EXPIRED');
  if (nestedPageStatus === 'expired' || nestedPageHttpStatus === 'expired') maps.push('LINK_EXPIRED');
  if (nestedPageStatus === 'not_found' || nestedPageHttpStatus === 'not_found') maps.push('NOT_FOUND');
  // is_resolved eksplisit false → belum resolved (subs4unlock-id)
  if (result.is_resolved === false) maps.push('UNRESOLVED');
  // tujuan masih terkunci walau string URL eksis
  if (result.destination && typeof result.destination === 'object' && result.destination.status === 'locked') {
    maps.push('LOCKED_DESTINATION');
  }
  // resolution_status eksplisit selain resolved (bicolink, pastelink-net)
  if (typeof result.resolution_status === 'string') {
    const rs = result.resolution_status.toLowerCase();
    if (rs === 'requires_verification') maps.push('VERIFICATION_REQUIRED');
    else if (rs === 'error') maps.push('BYPASS_FAILED');
  }
  return maps;
}

/**
 * Evaluasi hasil mentah engine menjadi keputusan respons.
 * @param {string} provider id provider (mis. 'sfl' — dari pemanggil endpoint)
 * @param {object|null} result hasil modul engine api/bypass-*.js
 * @returns {{success:false, code:string, message?:string}
 *          |{success:true, targetUrl:string}}
 */
function evaluateEngineResult(provider, result) {
  if (!result || typeof result !== 'object') {
    return { success: false, code: 'BYPASS_FAILED' };
  }
  // beberapa engine balik array bila input array — ambil elemen tunggal
  if (Array.isArray(result)) result = result[0];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { success: false, code: 'BYPASS_FAILED' };
  }

  /* 1. sinyal interaksi/keadaan terlarang lebih dahulu — walau URL
      eksis, apabila mesin masih menandai captcha/password/aksi
      pengguna, itu bukan hasil bypass yang sah. */
  const blocks = detectBlockingSignal(result);
  if (blocks.length) {
    return { success: false, code: blocks[0] };
  }

  /* 2. status keseluruhan harus menyatakan sukses */
  const statusOk = result.status === true || result.status === 'resolved' ||
    result.status === 'success' || (result.is_resolved === true && result.status !== false);
  if (!statusOk) {
    return { success: false, code: 'BYPASS_FAILED' };
  }

  /* 3. URL target harus ada & bentuk http/https valid */
  const target = pickTargetUrl(result);
  if (!target) {
    return { success: false, code: 'NO_TARGET_URL' };
  }
  return { success: true, targetUrl: target.trim() };
}

/**
 * Evaluasi + kirim langsung ke res — pintu utama handler Node.
 */
function respondFromEngineResult(res, provider, result) {
  const verdict = evaluateEngineResult(provider, result);
  if (verdict.success) {
    return sendSuccess(res, { provider, targetUrl: verdict.targetUrl });
  }
  return sendFailure(res, provider, verdict.code, verdict.message);
}

/* ------------------------------------------------------------------ */
/* Exception → error respons (tanpa bocor informasi internal)          */
/* ------------------------------------------------------------------ */

/** pesan bawaan engine yang AMAN untuk ditampilkan */
function isSafeErrorText(text) {
  if (typeof text !== 'string') return false;
  // tidak mengandung stack, lokasi file:baris, url, token, kata sandi.
  if (text.length > 120) return false;
  const t = text.trim();
  if (/\n/.test(t)) return false;
  if (/^\s*at\s/i.test(t)) return false; // pola baris stack
  if (/:\d+:\d+/.test(t)) return false;  // file:baris:kolom
  if (/\.(js|mjs|cjs|ts)\b/i.test(t)) return false; // jalur berkas
  if (/^Error[:\s]/i.test(t)) return false;
  if (/(https?:\/\/|Bearer\s|password\s*[=:]|token\s*[=:])/i.test(t)) return false;
  return true;
}

/**
 * Sanitasi exception menjadi { code, message, status } aman.
 * Entity axios/Abort dikenali; lainnya INTERNAL_ERROR.
 */
function exceptionToErrorResponse(err) {
  if (!err || typeof err !== 'object') return { code: 'INTERNAL_ERROR' };

  // error input tervalidasi dari url-validator/config handler
  if (err.code && OUTPUT_MESSAGES[err.code] && err.safe === true) {
    return { code: err.code, message: clampMessage(err.message, OUTPUT_MESSAGES[err.code]) };
  }

  const name = err.name || '';
  const kind = err.code || '';

  if (name === 'AbortError' || kind === 'ECANCELLED') return { code: 'TIMEOUT' };
  if (kind === 'ECONNABORTED' || kind === 'ETIMEDOUT') return { code: 'TIMEOUT' };
  if (kind === 'ENOTFOUND' || kind === 'EAI_AGAIN' || kind === 'ECONNREFUSED' || kind === 'ECONNRESET' || kind === 'EHOSTUNREACH' || kind === 'ENETUNREACH') {
    return { code: 'NETWORK_ERROR' };
  }
  if (kind === '404') return { code: 'NOT_FOUND' };

  // pesan engine yang aman & pendek boleh diturunkan (mis. "Password ditolak…")
  if (isSafeErrorText(err.message)) {
    return { code: 'BYPASS_FAILED', message: err.message };
  }
  // sisanya: jangan pernah tampilkan apa pun dari exception internal
  return { code: 'INTERNAL_ERROR' };
}

/** kirim respons kesalahan dari exception — TANPA stack, TANPA detail */
function sendFromException(res, provider, err) {
  const mapped = exceptionToErrorResponse(err);
  return sendFailure(res, provider, mapped.code, mapped.message);
}

/* ================================================================ */
/* Public API (CommonJS)                                              */
/* ================================================================ */

module.exports = {
  OUTPUT_MESSAGES,
  CODE_STATUS,
  sendJson,
  sendSuccess,
  sendFailure,
  evaluateEngineResult,
  respondFromEngineResult,
  exceptionToErrorResponse,
  sendFromException,
};
