#!/usr/bin/env node
/* ============================================================
 * api/dispatch.js — XBypass
 * ============================================================
 * ADAPTER HTTP tunggal untuk semua engine bypass (CommonJS).
 *
 * Peran:
 *   - Menyerap permintaan serverless Vercel (req/res Node biasa).
 *   - Memetakan /api/bypass-<provider> ke fungsi utama file engine
 *     yang SUDAH ADA — fungsi engine dipanggil apa adanya.
 *     >>> FILE ENGINE TIDAK DIUBAH satu byte pun. <<<
 *   - Semua hasil engine diputus oleh lib/response-handler
 *     (interpretEngineResult): sukses hanya bila status resolved
 *     + target URL valid; captcha/passcode/interaksi TIDAK pernah
 *     diubah menjadi sukses palsu.
 *
 * Routing (vercel.json):
 *   /api/bypass-*  ->  /api/dispatch.js?engine=bypass-<slug>
 *   Query param `engine` yang sah menimpa path — dispatcher juga
 *   bisa membaca id engine dari pathname bila query tidak ada,
 *   sehingga tetap bekerja di harness lokal tanpa rewrite.
 *
 * Linkvertise (khusus):
 *   Belum ada engine-nya (dibuat menyusul). Endpoint ini dijawab
 *   501 API_UNAVAILABLE dengan pesan rapi — bukan 404/500 kasar.
 * ============================================================ */
'use strict';

const path = require('path');
const responseHandler = require('../lib/response-handler');
const urlValidator = require('../lib/url-validator');

/* ==================================================================== */
/* Konstanta                                                             */
/* ==================================================================== */

const MAX_BODY_BYTES = 16 * 1024; // 16 KB — selaras middleware.js

/* Pagar luar utk engine yang menggantung: serverless Vercel max 60 dtk. */
const BASE_DEADLINE_MS = 55000;
const DEADLINE_MS = (() => {
  const n = parseInt(process.env.XBYPASS_DISPATCH_DEADLINE_MS || '', 10);
  return Number.isFinite(n) && n > 0 && n <= 300000 ? n : BASE_DEADLINE_MS;
})();

/* ==================================================================== */
/* Tabel engine (nama fungsi = export UTAMA persis milik file engine)     */
/* provider/id sesuai data/bypass.js (frontend)                          */
/* ==================================================================== */

const ENGINES = {
  'bypass-sub2unlock-me':   { file: './bypass-sub2unlock-me.js',   fn: 'scrapeSub2Unlock',  provider: 'sub2unlock',  hosts: ['sub2unlock.me'] },
  'bypass-sub2unlock-io':   { file: './bypass-sub2unlock-io.js',   fn: 'bypassSub2Unlock',  provider: 'sub2unlock',  hosts: ['sub2unlock.io'] },
  'bypass-bicolink':        { file: './bypass-bicolink.js',        fn: 'bypassBicolink',    provider: 'Bicolink',    hosts: ['bicolink.com'] },
  'bypass-pastelink-net':   { file: './bypass-pastelink-net.js',   fn: 'scrapePastelink',   provider: 'pastelink',   hosts: ['pastelink.net'] },
  'bypass-pastelink-id':    { file: './bypass-pastelink-id.js',    fn: 'scrapePastelink',   provider: 'Pastelink',   hosts: ['pastelink.id'] },
  'bypass-shrinkme':        { file: './bypass-shrinkme.js',        fn: 'resolve',           provider: 'shrinkme',    hosts: ['shrinkme.io'] },
  'bypass-sfl':             { file: './bypass-sfl.js',             fn: 'scrapeSafelink',    provider: 'safelinku',   hosts: ['safelinku.com'] },
  'bypass-subs4unlock-id':  { file: './bypass-subs4unlock-id.js',  fn: 'scrapeSubs4Unlock', provider: 'subs4unlock', hosts: ['subs4unlock.id'] },
  'bypass-sub4unlock-com':  { file: './bypass-sub4unlock-com.js',  fn: 'scrapeSub4Unlock',  provider: 'sub4unlock',  hosts: ['sub4unlock.com'] },
  'bypass-subs4unlock-com': { file: './bypass-subs4unlock-com.js', fn: 'scrapeSubs4Unlock', provider: 'subs4unlock', hosts: ['subs4unlock.com'] },
};

/* Endpoint tanpa engine (dikosongkan dulu — file engine menyusul). */
const DISABLED_ENGINES = {
  'bypass-linkvertise':
    'Linkvertise belum tersedia. Engine scrape-nya sedang dibuat dan akan aktif tanpa perubahan di frontend.',
};

const TOO_BIG = Symbol('body-too-big');

/* ==================================================================== */
/* Util                                                                  */
/* ==================================================================== */

/**
 * resolveEngineId — deteksi id engine:
 *   1) query `?engine=bypass-<slug>` (hasil rewrite vercel.json),
 *   2) fallback: pathname /api/bypass-<slug> bekerja tanpa rewrite.
 */
function resolveEngineId(req) {
  const rawUrl = String((req && req.url) || '/');
  const qIdx = rawUrl.indexOf('?');
  const query = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)) : null;
  const fromQuery = query && String(query.get('engine') || '').replace(/^\/+/, '') || null;
  const pathname = (qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl).split('#')[0];
  const id = pathname
    .replace(/^\/+/, '')       // '/api/xxx' -> 'xxx'... lebih tepatnya: buang slash awal lalu 'api/'
    .replace(/^api\//, '')
    .replace(/\/+$/, '');
  if (fromQuery && (ENGINES[fromQuery] || DISABLED_ENGINES[fromQuery])) return fromQuery;
  return id;
}

/**
 * readBody — kumpulkan body dengan batas 16 KB.
 * @returns {Promise<string|null>} null = error baca; TOO_BIG symbol saat melampaui.
 */
function readBody(req) {
  return new Promise((resolve) => {
    let done = false;
    let size = 0;
    const chunks = [];
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { chunks.length = 0; finish(TOO_BIG); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) finish(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { if (!done) { chunks.length = 0; finish(''); } });
  });
}

/** withDeadline — bungkus fungsi engine dgn AbortError saat melewati batas. */
function withDeadline(fn, deadlineMs) {
  return async (...args) => {
    let timer = null;
    try {
      return await Promise.race([
        fn(...args),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error('engine deadline tercapai');
            err.name = 'AbortError';
            reject(err);
          }, deadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** loadEngine — require engine RELATIF ke folder api/ (lazy per request). */
function loadEngine(rel) {
  const abs = rel.startsWith('.') ? path.join(__dirname, rel) : rel;
  return require(abs);
}

/* ==================================================================== */
/* Handler serverless                                                    */
/* ==================================================================== */

async function handler(req, res) {
  try {
    const method = String((req && req.method) || 'GET').toUpperCase();

    /* Hanya POST — frontend memanggil POST JSON; rest besar dijawab 405
       supaya /api/bypass-* tidak jadi pintu scraping GET murah. */
    if (method !== 'POST') {
      responseHandler.sendError(res, {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Gunakan POST application/json dengan body {"url": "https://..."}.',
      });
      return;
    }

    const engineId = resolveEngineId(req);

    /* Endpoint belum punya engine (kelas: linkvertise). */
    if (DISABLED_ENGINES[engineId]) {
      responseHandler.sendError(res, {
        provider: 'linkvertise',
        code: 'API_UNAVAILABLE',
        message: DISABLED_ENGINES[engineId],
      });
      return;
    }

    const entry = ENGINES[engineId];
    if (!entry) {
      responseHandler.sendError(res, {
        code: 'NOT_FOUND',
        message: 'Endpoint bypass tidak dikenali.',
      });
      return;
    }

    /* -- body -- */
    const bodyText = await readBody(req);
    if (bodyText === TOO_BIG) {
      responseHandler.sendError(res, { code: 'PAYLOAD_TOO_LARGE', message: 'Body melebihi 16 KB.' });
      return;
    }

    let payload = null;
    if (bodyText) {
      try { payload = JSON.parse(bodyText); }
      catch (_) { payload = null; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      responseHandler.sendError(res, {
        code: 'SUSPICIOUS_REQUEST',
        message: 'Body tidak memenuhi format JSON yang diterima endpoint.',
      });
      return;
    }

    /* -- url -- */
    const url = typeof payload.url === 'string' ? payload.url.trim() : '';
    if (!url) {
      responseHandler.sendError(res, { provider: entry.provider, code: 'EMPTY_URL' });
      return;
    }

    /* -- validasi (http/https, publik, allowlist provider) -- */
    const parsed = urlValidator.validateIncomingUrl(url);
    if (!parsed.ok) {
      responseHandler.sendError(res, {
        provider: entry.provider,
        code: parsed.reason,
        message: parsed.message,
      });
      return;
    }

    /* -- cocokkan domain dgn endpoint ini -- */
    const hostOk = entry.hosts.some((d) => urlValidator.hostnameMatchesDomain(parsed.hostname, d));
    if (!hostOk) {
      responseHandler.sendError(res, {
        provider: entry.provider,
        code: 'UNSUPPORTED_DOMAIN',
        message: 'Domain "' + parsed.hostname + '" tidak diproses endpoint ini. Pilih endpoint untuk domain tersebut di daftar Bypass yang Didukung.',
      });
      return;
    }

    /* -- muat engine (lazy) & fungsi utama -- */
    const load = (module.exports._loadEngine) || loadEngine;
    let engineModule;
    try {
      engineModule = load(entry.file);
    } catch (err) {
      responseHandler.sendError(res, {
        code: 'API_UNAVAILABLE',
        message: 'Engine untuk provider ini tidak dapat dimuat.',
        internal: err,
      });
      return;
    }

    const fn = engineModule && engineModule[entry.fn];
    if (typeof fn !== 'function') {
      responseHandler.sendError(res, {
        code: 'API_UNAVAILABLE',
        message: 'Fungsi utama engine tidak tersedia.',
        internal: new Error('export hilang: ' + entry.file + ' -> ' + entry.fn),
      });
      return;
    }

    /* -- jalankan engine + interpretasi hasil + kirim respons -- */
    await responseHandler.respondThroughEngine(res, {
      provider: entry.provider,
      engineFn: withDeadline(fn, DEADLINE_MS),
      /* argumen: URL apa adanya (string) + opts kosong; default engine berlaku */
      engineArgs: [url, {}],
      raiseUnknown: true,
    });
  } catch (err) {
    /* Jaring pengaman terakhir — tanpa stack ke klien. */
    responseHandler.sendError(res, { code: 'INTERNAL_ERROR', internal: err });
  }
}

/* ==================================================================== */
/* Exports                                                               */
/* ==================================================================== */

module.exports = handler;
/* loader __dirname-based yang dapat diganti di test */
module.exports._loadEngine = loadEngine;
module.exports.ENGINES = ENGINES;
module.exports.DISABLED_ENGINES = DISABLED_ENGINES;
/* pagaran maksimum khusus fungsi ini di Vercel (60 dtk; diabaikan di luar Vercel) */
module.exports.maxDuration = 60;
