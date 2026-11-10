'use strict';

/* ====================================================================
 * XBypass — lib/http-gateway.js
 *
 * Utilitas bersama untuk handler HTTP Node (folder api/).
 *
 * Alur endpoint:
 *   MIDDLEWARE (security/rate limit) → HANDLER NODE (berkas ini dipakai)
 *   → ENGINE (api/engine/*) → lib/response-handler.js → JSON konsisten.
 *
 * Kontrak body selaras frontend (script.js):
 *   POST { "url": "https://…" }  →  200 { success, provider, targetUrl, message }
 *   gagal                        →  JSON { success:false, error:{ code, message } }
 *
 * Modul ini HANYA untuk proses Node (jangan diimport middleware Edge).
 * ==================================================================== */

const DEFAULT_MAX_BODY_BYTES = Number(process.env.HANDLER_MAX_BODY_BYTES) || 16384;

/**
 * Baca & parse body JSON dari req Node serverless.
 * @param {object} req  req serverless Vercel (IncomingMessage)
 * @param {object} [options]
 * @returns {Promise<{ok:boolean, data?:object, code?:string, message?:string}>}
 */
async function readJsonBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : DEFAULT_MAX_BODY_BYTES;

  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    return { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Kirim data dengan metode POST.' };
  }

  const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' };
  }

  const declared = Number((req.headers && req.headers['content-length']) || 0);
  if (declared > maxBytes) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'Isi request tidak dapat dibaca.' };
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) {
    return { ok: false, code: 'INVALID_URL', message: 'Link masih kosong. Tempel atau ketik link terlebih dahulu.' };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'Data kiriman bukan JSON yang valid.' };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_URL', message: 'Data kiriman harus berupa objek JSON berisikan url.' };
  }

  if (typeof data.url === 'string') data.url = data.url.trim();
  if (data.password !== undefined && typeof data.password !== 'string') data.password = undefined;

  return { ok: true, data };
}

/**
 * Eksekusi fungsi engine dengan batas waktu absolut serverless.
 * Engine memiliki retry internal; handler tidak boleh menggantung.
 * @param {() => Promise<any>} factory
 * @param {number} ms
 */
function withDeadline(factory, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('waktu eksekusi engine habis');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, Math.max(1, Number(ms) || 1));

    Promise.resolve().then(factory).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/* Public API (CommonJS) */
module.exports = {
  readJsonBody,
  withDeadline,
  DEFAULT_MAX_BODY_BYTES,
};
