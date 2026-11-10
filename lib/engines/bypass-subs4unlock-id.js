/**
 * ============================================================================
 *  scrape-bypass-subs4unlock-id.js
 *  Engine scraper & bypass subs4unlock.id (Social Unlock / Content Locker)
 *  creator  : Razeerh
 *  runtime  : Node.js (CommonJS)
 *  deps     : axios, cheerio (TANPA engine berat: no puppeteer/playwright/selenium)
 *  cookies  : otomatis dibangun via set-cookie per-request (tidak minta token manual)
 *  usage    : node scrape-bypass-subs4unlock-id.js "https://subs4unlock.id/slqfny" [--out result.json]
 *  module   : const { scrapeSubs4Unlock } = require('./scrape-bypass-subs4unlock-id.js')
 * ============================================================================
 *
 *  HASIL ANALISIS STRUKTUR HALAMAN (diverifikasi live pada engine 2026):
 *  ---------------------------------------------------------------------
 *  subs4unlock.id = Laravel + engine unlock JS (gen/set/dec), alur unlock:
 *
 *   1) GET  https://subs4unlock.id/{code}          -> 302 (stempel session) -> /set
 *   2) GET  https://subs4unlock.id/set             -> 200 HTML yang menyertakan
 *          <textarea class="hidden" name="link">{"id":..,"original":"?k=v1..","active":true,"direct":false}</textarea>
 *        nilai param `original` di-encode: btoa(encodeURIComponent(nilaiAsli))
 *        kunci penting (dari fbSTU):
 *          ttl/sttl/sty/thmb/not/exp/pas1 = judul,subjudul,gaya,thumbnail,catatan,tgl-kedaluwarsa,password
 *          lnk1..lnk5 (+lnk1t..lnk5t label) = TUJUAN/destination (group "file")
 *          yt1,yt2,ytl1,ytc1,ytlc1, wa1,wa2, tg1, tk1,tkl1, web1, ig1,igl1,
 *          fb1..3,fbl1..3, tw1..3,twl1..3, dc1..3       = tasks (group sosial)
 *   3) seluruh verifikasi task & countdown DILAKUKAN DI CLIENT (localStorage/
 *      sessionStorage + timer DOM/print css). TIDAK ADA verifikasi server
 *      terhadap eksekusi task.
 *   4) tombol unlock membuka /go?link=<dest> ; server langsung 302 -> dest.
 *      -> dengan itu, chain berikut bekerja 100% via HTTP murni:
 *         /{code} (302 ke /set, stempel session)
 *         /set    (200, baca payload dari HTML)
 *         /go?link=<dest> (302 -> destination_url)
 *  Karena payung di atas, "engine bypass" di sini = mbaca data publik halaman
 *  (public_page_data) + verifikasi redirect tujuan lewat /go?link= tanpa
 *  menjalankan JavaScript sama sekali (anti-endpoint-engine-berat, no headless).
 *
 *  PAGINATION: engine ini satu-halaman per short_code (tidak ada pagination),
 *  jadi handler pagination tidak diperlukan; yang ditangani adalah:
 *  redirect chain multi-hop, timeout, retry bertingkat, 404/429/5xx,
 *  rate-limit sederhana, dan data kosong.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const axios = require('axios');

/* ================================ KONFIG ================================ */
const CREATOR = 'Razeerh';
const DOMAIN = 'subs4unlock.id';
const BASE_URL = 'https://subs4unlock.id';
const MIRROR_BASE = 'https://sub2unlock.id'; // engine kembar (identik) sebagai fallback domain
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const REQUEST_TIMEOUT = 20000;
const MAX_HOPS = 8;
const RETRY_DELAYS_MS = [800, 1600, 3200]; // retry jaringan/5xx bertingkat (terbatas, anti-DDoS)
const GO_HOP_DELAY_MS = 300; // jeda sopan sebelum hop verifikasi /go?link=

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
  'Referer': 'https://subs4unlock.id/',
};

/* ==================== PETA TASK/PLATFORM (engine fbSTU) ==================== */
/* Diekstrak dari /js/stu/gen-config.js + /js/stu/set.js (diverifikasi live). */
const TASK_MAP = {
  yt1: { task_type: 'youtube_subscribe', platform: 'YouTube' },
  yt2: { task_type: 'youtube_subscribe', platform: 'YouTube' },
  ytl1: { task_type: 'youtube_like', platform: 'YouTube' },
  ytc1: { task_type: 'youtube_comment', platform: 'YouTube' },
  ytlc1: { task_type: 'youtube_like_comment', platform: 'YouTube' },
  wa1: { task_type: 'whatsapp_join', platform: 'WhatsApp' },
  wa2: { task_type: 'whatsapp_join', platform: 'WhatsApp' },
  tg1: { task_type: 'telegram_join', platform: 'Telegram' },
  tk1: { task_type: 'tiktok_follow', platform: 'TikTok' },
  tkl1: { task_type: 'tiktok_like', platform: 'TikTok' },
  web1: { task_type: 'website_visit', platform: 'Website' },
  ig1: { task_type: 'instagram_follow', platform: 'Instagram' },
  igl1: { task_type: 'instagram_like', platform: 'Instagram' },
  fb1: { task_type: 'facebook_follow', platform: 'Facebook' },
  fb2: { task_type: 'facebook_follow', platform: 'Facebook' },
  fb3: { task_type: 'facebook_follow', platform: 'Facebook' },
  fbl1: { task_type: 'facebook_like', platform: 'Facebook' },
  fbl2: { task_type: 'facebook_like', platform: 'Facebook' },
  fbl3: { task_type: 'facebook_like', platform: 'Facebook' },
  tw1: { task_type: 'twitter_follow', platform: 'X (Twitter)' },
  tw2: { task_type: 'twitter_follow', platform: 'X (Twitter)' },
  tw3: { task_type: 'twitter_follow', platform: 'X (Twitter)' },
  twl1: { task_type: 'twitter_like', platform: 'X (Twitter)' },
  twl2: { task_type: 'twitter_like', platform: 'X (Twitter)' },
  twl3: { task_type: 'twitter_like', platform: 'X (Twitter)' },
  dc1: { task_type: 'discord_join', platform: 'Discord' },
  dc2: { task_type: 'discord_join', platform: 'Discord' },
  dc3: { task_type: 'discord_join', platform: 'Discord' },
};
const KNOWN_TASK_KEYS = new Set(Object.keys(TASK_MAP));
const META_KEYS = new Set(['ttl', 'sttl', 'sty', 'thmb', 'not']);
const DEST_KEYS = ['lnk1', 'lnk2', 'lnk3', 'lnk4', 'lnk5'];
const OTHER_KEYS = new Set(['pas1', 'exp']);

/* =============================== UTILITAS =============================== */

/** Ambil code dari input: full URL, URL tanpa https, atau kode telanjang. */
function extractCode(input, baseUrl = BASE_URL) {
  if (!input || typeof input !== 'string') {
    return { code: null, baseUrl, error: 'Input URL kosong.' };
  }
  const raw = input.trim();
  let host = null;
  let slug = null;
  try {
    // dukung beberapa bentuk: https://subs4unlock.id/x ; //subs4unlock.id/x ; subs4unlock.id/x ; "x"
    let urlLike = raw;
    if (!/^https?:\/\//i.test(urlLike)) {
      if (urlLike.startsWith('//')) urlLike = 'https:' + urlLike;
      else if (/^[\w-]+(\.[\w-]+)+\//i.test(urlLike) || /^[\w-]+(\.[\w-]+)+$/i.test(urlLike)) urlLike = 'https://' + urlLike;
    }
    if (/^https?:\/\//i.test(urlLike)) {
      const u = new URL(urlLike);
      host = u.hostname.replace(/^www\./i, '');
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length && !['page', 'signin', 'signup', 'dashboard', 'generate', 'set', 'go', 'dec', 'stu-expired'].includes(parts[0].toLowerCase())) {
        slug = parts[u.search && /\?|link=/.test(urlLike) ? 0 : 0]; // first segment
        // jika ada query ?link= (format tombol unlock), ambil nilai original code dari path juga
        slug = parts[0];
      }
    } else {
      slug = urlLike.replace(/^\/+/, '').split('?')[0].split('#')[0];
    }
  } catch (e) {
    slug = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/').filter(Boolean)[0];
  }

  if (host && !/(^|\.)subs[24]?unlock\.id$/i.test(host) && !/(^|\.)sub2?unlock\.id$/i.test(host)) {
    return { code: null, baseUrl, error: `Domain tidak didukung: ${host} (engine ini khusus subs4unlock.id / sub2unlock.id).` };
  }
  if (/(^|\.|^)sub2unlock\.id$/i.test(host || '')) baseUrl = MIRROR_BASE; else baseUrl = BASE_URL;
  // www. diabaikan (www.subs4unlock.id -> BASE_URL)
  if (!slug) return { code: null, baseUrl, error: 'Tidak menemukan short code pada input. Contoh: https://subs4unlock.id/slqfny' };
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(slug)) {
    return { code: null, baseUrl, error: `Short code tidak valid: "${slug}"` };
  }
  return { code: slug, baseUrl, error: null };
}

/** Decode engine: nilai param = btoa(encodeURIComponent(asli)) */
function decodeValue(val) {
  if (typeof val !== 'string') return null;
  let out = val;
  try {
    // URLSearchParams sudah decode %XX; b64 bisa kehilangan '+' jika payload berasal dari jalur lawas
    let b64 = out.includes(' ') && !out.includes('+') ? out.replace(/ /g, '+') : out;
    const bin = Buffer.from(b64, 'base64').toString('binary');
    out = decodeURIComponent(bin);
    return out;
  } catch (e) {
    try {
      const bin = Buffer.from(out, 'base64').toString('utf8');
      if (bin && /\S/.test(bin)) return bin;
    } catch (e2) { /* ignore */ }
    return val; // tidak ter-encode? kembalikan apa adanya
  }
}

/** Buat HTTP client dengan jar cookie kecil otomatis (tanpa input user). */
function makeSessionJar(initialUrl) {
  const jar = new Map();
  const client = axios.create({ timeout: REQUEST_TIMEOUT, maxRedirects: 0, validateStatus: () => true });

  function absorbSetCookies(res) {
    const rawSC = res.headers && (res.headers['set-cookie'] || []);
    for (const c of [].concat(rawSC)) {
      const first = String(c).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      let value = first.slice(idx + 1).trim();
      if (value === '' && jar.has(name)) jar.delete(name); // cookie expired
      else jar.set(name, value);
    }
  }

  async function hop(url, extraHeaders = {}) {
    const res = await client.get(url, {
      headers: { ...HEADERS, ...extraHeaders, Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') || undefined },
    });
    absorbSetCookies(res);
    return res;
  }

  async function clearJar() {
    jar.clear();
  }

  return { jar, hop, clearJar };
}

/** Tunggu ms ms. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kemungkinan error network yang layak di-retry. */
const RETRYABLE = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_ECONNRESET', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'EPROTO',
]);

/** Request dengan retry terbatas (3x, backoff). Selagi belum 200 = dicoba lagi, tapi selalu berbatas. */
async function resilientHop(session, url, label = 'hop', extraHeaders = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await session.hop(url, extraHeaders);
      const st = res.status;
      const okHtml = typeof res.data === 'string' && /text\/html/i.test(res.headers['content-type'] || 'text/html');
      if ((st >= 200 && st < 400) || !RETRYABLE.has(String(st))) return res;
      if (st >= 500 || st === 408 || st === 429) {
        lastErr = new Error(`HTTP ${st} pada ${label}`);
        const ra = Number(res.headers && res.headers['retry-after']);
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : RETRY_DELAYS_MS[attempt] || 3200;
        await sleep(wait);
        continue;
      }
      return res; // 4xx selain 408/429: jangan dibronjong ulang
    } catch (e) {
      lastErr = e;
      const code = (e && (e.code || (e.cause && e.cause.code))) || '';
      if (!RETRYABLE.has(code) || attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt] || 3200);
    }
  }
  throw lastErr || new Error(`Gagal melakukan ${label}`);
}

/* ============================== PARSER HTML ============================== */

/** Ekstrak payload <textarea name="link"> JSON dari HTML halaman /set. */
function extractPayload(html) {
  if (!html || typeof html !== 'string') return null;
  const $ = cheerio.load(html);
  const payload = { metaOg: {} };

  // 1) payload utama
  const ta = $('textarea[name="link"]').first();
  let rawJson = '';
  if (ta.length) rawJson = ta.text() || ''; // cheerio otomatis unescape entity HTML
  if (!rawJson) {
    const m = html.match(/<textarea[^>]*name=["']?link["']?[^>]*>([\s\S]*?)<\/textarea>/i);
    if (m) rawJson = unescapeHtml(m[1]);
  }
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson.trim());
      if (parsed && (parsed.original || parsed.direct)) {
        payload.link = parsed;
      }
    } catch (e) { /* payload rusak? coba jalur regex di bawah */ }
  }
  if (!payload.link) {
    // regex fallback longgar: cari objek {"id":"...","original":"..."}
    const m = html.match(/\{"id"\s*:\s*"[^"]+"\s*,\s*"original"\s*:\s*"[^"]*"[\s\S]{0,200}?\}/);
    if (m) {
      try {
        const fix = unescapeHtml(m[0]);
        payload.link = JSON.parse(fix);
      } catch (e) { /* ignore */ }
    }
  }

  // 2) meta og fallback untuk metadata
  payload.metaOg.title = $('meta[property="og:title"]').attr('content') || null;
  payload.metaOg.description = $('meta[property="og:description"]').attr('content') || null;
  payload.metaOg.image = $('meta[property="og:image"]').attr('content') || null;
  payload.pageTitle = ($('title').first().text() || '').trim() || null;
  payload.isHomepage = !!payload.metaOg.title && payload.pageTitle && payload.pageTitle.includes('Best Sub to Unlock Service');

  return payload.link ? payload : payload;
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Parse query-string original → { key: {raw, decoded} } */
function parseOriginal(original) {
  const qs = String(original || '').replace(/^\?/, '');
  const out = {};
  if (!qs) return out;
  let sp;
  try { sp = new URLSearchParams(qs); } catch (e) {
    for (const [k, v] of qs.split('&').map((kv) => kv.split('='))) {
      if (k) out[k] = { raw: v || '', decoded: decodeValue((v || '').replace(/\+/g, '%2B')) };
    }
    return out;
  }
  for (const [k, v] of sp.entries()) {
    if (!k) continue;
    out[k] = { raw: v, decoded: decodeValue(v) };
  }
  return out;
}

/** Bungsus output required_tasks dari params engine. */
function collectTasks(params) {
  const tasks = [];
  for (const key of Object.keys(params)) {
    const map = TASK_MAP[key];
    if (!map) continue;
    const url = (params[key].decoded || '').trim();
    tasks.push({
      task_type: map.task_type,
      platform: map.platform,
      task_url: url || null,
      status: url ? 'required' : 'required',
      engine_key: key,
    });
  }
  return tasks;
}

/* ============================ ALUR UTAMA ENGINE ============================ */

/**
 * Fungsi inti scrape+bypass.
 * @param {string} input URL atau code
 * @param {{mirrorFallback?: boolean, savePath?: string, pretty?: boolean}} opts
 */
async function scrapeSubs4Unlock(input, opts = {}) {
  const startedAt = new Date().toISOString();
  const base = opts.baseUrl || BASE_URL;
  const mirror = opts.mirrorFallback !== false ? MIRROR_BASE : null;

  const mk = (error) => ({  // factory result konsisten
    status: !error,
    creator: CREATOR,
    domain: DOMAIN || new URL(base).hostname,
    original_url: input || null,
    short_code: null,
    metadata: { title: null, description: null, thumbnail: null },
    required_tasks: [],
    destination_url: null,
    destination_title: null,
    extra_links: [],
    extras: { password: null, note: null, expired_at: null },
    redirect_chain: [],
    http_status: null,
    is_resolved: false,
    resolution_status: error ? 'error' : 'requires_verification',
    resolution_method: null,
    error: error || null,
    started_at: startedAt,
  });

  const { code, baseUrl: bb, error: inputErr } = extractCode(input, base);
  const baseUsed = bb || base;
  if (inputErr) {
    const res = mk(`input_error: ${inputErr}`);
    if (input && /^[A-Za-z0-9_-]{2,64}$/.test(String(input).trim())) res.short_code = String(input).trim();
    res.original_url = input;
    res.http_status = null;
    if (opts.savePath) saveResult(res, opts.savePath, opts.pretty);
    return withSaved(res, opts);
  }

  const targets = [baseUsed];
  if (mirror && mirror !== baseUsed) targets.push(mirror);

  // PRINSIP "SELAGI BELUM 200 JANGAN BERHENTI" (terbatas agar tidak DDoS):
  // per-hop sudah ada retry 3x (backoff); ditambah full-pass retry ketika
  // error memang mekanis (network/5xx). Ketika code tidak ada di domain utama
  // (404), target berikut (domain mirror dengan engine identik) ikut dicoba
  // SEKALI — jika tetap tidak ada, hasil not_found tetap dilaporkan jujur.
  const MAX_FULL_PASSES = 2;
  const attempts = [];
  let chosen = null;
  for (let pass = 0; pass < MAX_FULL_PASSES; pass++) {
    if (pass > 0) await sleep(1500); // jeda wajar sebelum pass berikutnya
    let retryableFailure = false;
    let found = null;
    for (let t = 0; t < targets.length; t++) {
      const origin = targets[t];
      const attempt = mk(null);
      attempt.short_code = code;
      attempt.original_url = `${origin}/${code}`;
      try {
        const engine = await engineRun(origin, code, attempt);
        attempts.push({ engine, attempt });
        if (engine.ok && attempt.resolution_status !== 'not_found') { found = { engine, attempt }; break; }
        if (!engine.ok && engine.retryable) retryableFailure = true;
      } catch (e) {
        attempts.push({ engine: { ok: false, error: e.message, retryable: true }, attempt });
        retryableFailure = true;
      }
    }
    if (found) { chosen = found; break; }
    if (!retryableFailure) break; // 404/not_found di semua target: tidak diburu-lagi
  }

  if (!chosen) {
    // prioritas: not_found milik domain yang user tulis > error terakhir > placeholder
    chosen =
      attempts.find((a) => a.attempt.resolution_status === 'not_found') ||
      attempts[attempts.length - 1] ||
      { engine: null, attempt: Object.assign(mk(null), { error: 'Engine gagal total.' }) };
  }

  const engine = chosen.engine;
  const res = chosen.attempt;
  res.domain = res.domain || new URL(baseUsed).hostname;
  if (engine && engine.ok && res.domain !== new URL(baseUsed).hostname) {
    res.resolved_via = res.domain; // transparansi: engine domain mana yang berhasil
  }

  /* ---------- resolusi destination (bypass tahap verifikasi) ---------- */
  if (res.publicDestination) {
    // destination sudah tersedia publik via payload HTML; verifikasi /go?link=
    await sleep(GO_HOP_DELAY_MS);
    const origin = engine.result && engine.result._origin ? engine.result._origin : (engine.origin || BASE_URL);
    const via = await resolveViaGo(engine.session, res.publicDestination, origin);
    res.redirect_chain.push(...via.chain);
    if (via.finalUrl) {
      res.destination_url = via.finalUrl;
      res.is_resolved = true;
      res.resolution_status = res.expiredDetected ? 'expired_but_public' : 'resolved';
      res.resolution_method = 'public_page_data';
      res.http_status = via.chain.length ? via.chain[via.chain.length - 1].status : 302;
    } else {
      // tidak berhasil path /go? tampilkan dari payload publik (sah: itu data halaman publik)
      res.destination_url = res.publicDestination;
      res.is_resolved = true;
      res.resolution_status = res.expiredDetected ? 'expired_but_public' : 'resolved';
      res.resolution_method = 'public_page_data';
      res.http_status = res.http_status || 200;
    }
  } else if (!res.error) {
    res.is_resolved = false;
    res.resolution_status = res.expiredDetected ? 'expired' : 'requires_verification';
    res.http_status = res.http_status || 200;
  }

  res.publicDestination = undefined;
  res.expiredDetected = undefined;
  res._origin = undefined;

  saveAndFinalize(res, opts);
  return res;
}

/** Menyimpan result.json + global metrik (opsional). */
function saveResult(result, savePath, pretty) {
  try {
    const p = path.resolve(savePath || 'result.json');
    fs.writeFileSync(p, JSON.stringify(result, null, pretty ? 2 : 2) + '\n', 'utf8');
    result._saved_to = p; // info runtime; tidak mengubah kontrak data
  } catch (e) {
    // silent — jangan ganggu hasil jika penulisan file gagal
  }
}

function withSaved(res, opts) {
  saveResult(res, opts && opts.savePath, opts && opts.pretty);
  return res;
}

function saveAndFinalize(res, opts) {
  saveResult(res, opts && opts.savePath, opts && opts.pretty);
}

/** Chain engine: /{code} -> /set baca payload + meta. */
async function engineRun(origin, code, result) {
  const session = makeSessionJar();
  const chain = [];
  let finalHtml = null;
  let httpStatus = null;

  const pushChain = (url, res) => chain.push({
    step: chain.length + 1,
    url,
    status: res.status,
    location: res.headers && res.headers.location ? String(res.headers.location) : null,
  });

  // hop 1: /{code} (biasanya 302 ke /set dengan session stamp)
  let u = `${origin}/${encodeURIComponent(code)}`;
  let res = await resilientHop(session, u, 'entry');
  pushChain(u, res);
  httpStatus = res.status;

  if (res.status === 404) {
    result.error = `Link tidak ditemukan (404): ${u}`;
    result.resolution_status = 'not_found';
    result.http_status = 404;
    result.redirect_chain = chain;
    result.is_resolved = false;
    return { ok: true, result, session };
  }

  if (res.status >= 500) {
    result.error = `Server error ${res.status}`;
    result.resolution_status = 'error';
    result.http_status = res.status;
    result.redirect_chain = chain;
    return { ok: false, result, session, retryable: true };
  }

  let hops = 0;
  while (res.status >= 300 && res.status < 400 && res.headers.location && hops < MAX_HOPS) {
    const loc = new URL(res.headers.location, u).toString();
    u = loc;
    res = await resilientHop(session, u, 'redirect');
    pushChain(u, res);
    httpStatus = res.status;
    hops++;
    if (typeof res.data === 'string' && /text\/html/i.test(res.headers['content-type'] || '')) finalHtml = res.data;
  }

  if (res.status === 200 && typeof res.data === 'string') finalHtml = res.data;
  if (!finalHtml) {
    result.redirect_chain = chain;
    result.http_status = httpStatus;
    result.error = 'Halaman unlock tidak mengembalikan HTML (isi kosong).';
    result.resolution_status = 'error';
    return { ok: false, result, session, retryable: true };
  }

  const payloadWrap = extractPayload(finalHtml);
  const link = payloadWrap && payloadWrap.link;
  // Distinguish: halaman host (homepage) = code invalid tapi dilayani 200 via redirect;
  const isHomepage = payloadWrap && payloadWrap.isHomepage && !link;

  if (!link) {
    result.redirect_chain = chain;
    result.http_status = httpStatus;
    if (isHomepage || httpStatus === 200) {
      // valid code tetap bisa kena 200 → homepage saat engine menganggap code tidak ada
      result.error = 'Code tidak valid/kedaluwarsa — halaman mengalihkan ke beranda tanpa payload unlock.';
      result.resolution_status = 'not_found';
      result.is_resolved = false;
      result.http_status = 200;
    } else {
      result.error = `Payload unlock tidak tersedia (status ${httpStatus}).`;
      result.resolution_status = 'error';
    }
    return { ok: false, result, session, retryable: isHomepage ? false : true };
  }

  /* ============ payload & metadata (public_page_data) ============ */
  const params = parseOriginal(link.original);
  result.metadata.title = (params.ttl && params.ttl.decoded) || payloadWrap.metaOg.title || 'Unlock Your Link';
  result.metadata.description = (params.sttl && params.sttl.decoded) || payloadWrap.metaOg.description || null;
  result.metadata.thumbnail = (params.thmb && params.thmb.decoded) || payloadWrap.metaOg.image || null;

  result.required_tasks = collectTasks(params);

  // extras
  result.extras.password = (params.pas1 && params.pas1.decoded) || null;
  result.extras.note = (params.not && params.not.decoded) || null;
  result.extras.style = (params.sty && params.sty.decoded) || null;

  let expiredDetected = false;
  if (params.exp && params.exp.decoded) {
    const dt = new Date(params.exp.decoded);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (!isNaN(dt.getTime())) {
      result.extras.expired_at = dt.toISOString();
      if (dt.getTime() < today.getTime()) expiredDetected = true;
    }
  }
  result.expiredDetected = expiredDetected;

  // destination + extra links dari group "file" (lnk1..lnk5)
  let publicDest = null;
  let publicDestTitle = null;
  for (let i = 0; i < DEST_KEYS.length; i++) {
    const key = DEST_KEYS[i];
    if (params[key] && params[key].decoded) {
      const dUrl = params[key].decoded.trim();
      const tKey = `${key}t`;
      const tVal = params[tKey] && params[tKey].decoded ? params[tKey].decoded.trim() : null;
      if (!publicDest) {
        publicDest = dUrl;
        publicDestTitle = tVal;
      } else {
        result.extra_links.push({ key, title: tVal, url: dUrl });
      }
      break; // hanya lnk pertama jadi utama; sisanya extra (lanjut untuk extra fill!)
    }
  }
  // lanjut isi extra link untuk lnk2..lnk5
  for (let i = 1; i < DEST_KEYS.length; i++) {
    const key = DEST_KEYS[i];
    if (params[key] && params[key].decoded) {
      const dUrl = params[key].decoded.trim();
      const tKey = `${key}t`;
      const tVal = params[tKey] && params[tKey].decoded ? params[tKey].decoded.trim() : null;
      let exists = false;
      if (publicDest === dUrl) exists = true;
      if (!exists && !result.extra_links.some((x) => x.url === dUrl)) {
        result.extra_links.push({ key, title: tVal, url: dUrl });
      }
    }
  }
  // direct link ("mode direct" engine)
  if (!publicDest && typeof link.direct === 'string' && /^https?:\/\//i.test(link.direct)) {
    publicDest = link.direct.trim();
    publicDestTitle = publicDestTitle || 'Direct link';
  }

  result.publicDestination = publicDest;
  result.destination_title = publicDestTitle;
  result.redirect_chain = chain;
  result.http_status = httpStatus;
  result.domain = new URL(origin).hostname;
  result._origin = origin;

  return { ok: true, result, session };
}

/** Verifikasi & resolve destination lewat public /go?link=<dest> (chain nihil tambahan). */
async function resolveViaGo(session, destUrl, origin = BASE_URL) {
  const chain = [];
  try {
    const goH = {
      Referer: `${origin}/dec`, // mengikuti alur klik aslinya
    };
    const goUrl = `${origin}/go?link=${encodeURIComponent(destUrl)}`;
    let res = await resilientHop(session, goUrl, 'go?link', goH);
    chain.push({ step: 'go?link', url: goUrl, status: res.status, location: res.headers.location || null });

    let hops = 0;
    let u = res.headers.location ? new URL(res.headers.location, goUrl).toString() : null;
    while (u && hops < MAX_HOPS) {
      res = await resilientHop(session, u, 'dest-hop', { Referer: goUrl });
      chain.push({ step: `dest${hops + 1}`, url: u, status: res.status, location: res.headers.location || null });
      hops++;
      const loc = res.headers.location;
      u = loc ? new URL(loc, u).toString() : null;
    }
    const last = chain[chain.length - 1];
    const finalStatusOk = res.status >= 200 && res.status < 400;
    return { chain, finalUrl: finalStatusOk ? (last ? last.url : null) : null, status: res.status };
  } catch (e) {
    return { chain, finalUrl: null, status: null, error: e.message };
  }
}

/* =============================== CLI =============================== */
function printHelp() {
  console.log(`
scrape-bypass-subs4unlock-id.js — engine subs4unlock.id (creator: ${CREATOR})
Output: JSON (disimpan ke result.json + stdout)

PENGGUNAAN:
  node scrape-bypass-subs4unlock-id.js <URL|code> [--out <file>] [--pretty|--compact]

CONTOH:
  node scrape-bypass-subs4unlock-id.js "https://subs4unlock.id/slqfny"
  node scrape-bypass-subs4unlock-id.js slqfny --out hasil.json
  node scrape-bypass-subs4unlock-id.js "https://sub2unlock.id/fbOjzk"

Module:
  const { scrapeSubs4Unlock } = require('./scrape-bypass-subs4unlock-id.js');
  const hasil = await scrapeSubs4Unlock('https://subs4unlock.id/slqfny');
`);
}

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
      printHelp();
      process.exit(argv.length ? 0 : 2);
    }
    const input = argv[0];
    let out = 'result.json';
    let pretty = true;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--out' && argv[i + 1]) { out = argv[i + 1]; i++; }
      else if (argv[i] === '--pretty') pretty = true;
      else if (argv[i] === '--compact') pretty = false;
    }

    console.error(`[scraper] target: ${input}`);
    const result = await scrapeSubs4Unlock(input, { savePath: out, pretty });

    console.error(`[scraper] resolution_status = ${result.resolution_status}, destination_url = ${result.destination_url || '(tidak tersedia)'}`);
    console.error(`[scraper] hasil disimpan: ${result._saved_to || out}`);

    const view = Object.assign({}, result);
    delete view._saved_to;
    console.log(JSON.stringify(view, null, pretty ? 2 : 0));

    // exit code informatif: 0 = sukses resolve; 1 = berjalan tapi belum resolved / error
    process.exit(result.is_resolved ? 0 : 1);
  })().catch((e) => {
    console.error('[scraper] fatal:', e.message);
    const err = {
      status: false, creator: CREATOR, domain: DOMAIN, original_url: process.argv[2] || null,
      short_code: null, metadata: { title: null, description: null, thumbnail: null },
      required_tasks: [], destination_url: null, destination_title: null, extra_links: [],
      extras: { password: null, note: null, expired_at: null },
      redirect_chain: [], http_status: null, is_resolved: false,
      resolution_status: 'error', resolution_method: null, error: e.message,
    };
    try {
      fs.writeFileSync(path.resolve('result.json'), JSON.stringify(err, null, 2) + '\n');
    } catch (e2) { /* diamkan */ }
    console.log(JSON.stringify(err, null, 2));
    process.exit(1);
  });
}

/* ============================ EKSPORT MODULE ============================ */
module.exports = {
  scrapeSubs4Unlock,
  extractCode,
  extractPayload,
  parseOriginal,
  decodeValue,
  TASK_MAP,
  constants: { CREATOR, DOMAIN, BASE_URL, MIRROR_BASE },
};
