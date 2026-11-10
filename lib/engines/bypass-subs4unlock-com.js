/**
 * ============================================================================
 *  scrape-bypass-subs4unlock-com.js
 *  Engine scraper & bypass subs4unlock.com (Social Subscription Link Locker)
 *  creator  : Razeerh
 *  runtime  : Node.js (CommonJS) — jalan mulus di Termux/Acode (pure JS deps)
 *  deps     : axios, cheerio (TANPA engine berat: no puppeteer/playwright/selenium)
 *  header   : kredensial engine dibangun OTOMATIS dari konstanta publik situs
 *             (Origin + Bearer) — tidak ada token/cookie yang harus diambil user.
 *  usage    : node scrape-bypass-subs4unlock-com.js "https://subs4unlock.com/d675c4fc9b"
 *  module   : const { scrapeSubs4Unlock } = require('./scrape-bypass-subs4unlock-com.js')
 * ============================================================================
 *
 *  HASIL ANALISIS STRUKTUR HALAMAN (diverifikasi live, 2026-11-08):
 *  ----------------------------------------------------------------
 *  subs4unlock.com BERBEDA dengan subs4unlock.id (bukan Laravel). Ini adalah
 *  React + Vite SPA (PWA) dengan backend API sendiri, semuanya publik:
 *
 *   1) GET https://subs4unlock.com/{code}  -> shell HTML Vite (assets/
 *      index-<hash>.js; lapisan SEO server menyuntikkan judul jika sudah
 *      mengenal key — untuk key baru shell lazim dibalas HTTP 404, tetapi
 *      body tetap shell SPA lengkap, browser tetap merender halaman unlock).
 *   2) Konstanta engine hidup di bundle (kecil, jadi sinkron dibaca dinamis):
 *        const <x>="https://myapi.videyhost.my.id/api.php"  → API_URL
 *        const <y>="AgungDeveloper"                         → TOKEN (Bearer)
 *        <map> = {YouTube:{subs:"Subscribe Channel",...},…} → LABEL TASK
 *      Sumber: chunk ./PageLink-<hash>.js (dibaca dari index-<hash>.js →
 *      berlaku juga bila situs rebuild; fallback: konstanta hasil bedah live).
 *   3) GET https://myapi.videyhost.my.id/api.php?key={code}
 *      Header WAJIB hasil pengetesan live:
 *        Authorization: Bearer AgungDeveloper  (salah → 401 Unauthorized)
 *        Origin: https://subs4unlock.com       (absen/salah → 403 Forbidden)
 *      Referer/Content-Type bebas.
 *        key valid   → 200 {"status":"success","data":{key,data,created_at}}
 *        key unknown → 400 {"error":"Invalid key"}
 *   4) data.data berisi: title, subtitle, color, sty, buttonName;
 *      "Advance Option": {pass?, exp?, thumb?, note?};
 *      grup taskByUrl platform (urutan render tetap SPA):
 *        YouTube/subs|like|comm, WhatsApp/msg|grp, Telegram/chan|msg,
 *        TikTok/flw|like, Website/visit, Instagram/flw|like,
 *        Facebook/flw|like|grp;   targetLinks:{tlink1..} = DESTINATION.
 *   5) SELURUH GATE UNLOCK DILAKUKAN DI CLIENT (tidak ada verifikasi server):
 *        - task "selesai" = timer 4 detik di browser;
 *        - password   = dibandingkan string di browser;
 *        - expiry     = dibandingkan tanggal di browser;
 *        - tombol target hanya menyimpan sessionStorage["targetUrl"]=url lalu
 *          buka /getlink — yang hanya menampilkan URL itu kembali.
 *      => destination adalah DATA PUBLIK yang dikirim API ke browser siapa pun.
 *         "Bypass" di sini = membaca page-data publik penyusunnya via HTTP
 *         murni + memverifikasi redirect publik destination secara langsung
 *         (tanpa JavaScript, tanpa engine berat, tanpa cookie manual).
 *
 *  CATATAN METODE:
 *   - Pagination: engine ini 1 link = 1 halaman (tidak ada pagination); yang
 *     ditangani: redirect chain, timeout, retry bertingkat, 404/429/5xx,
 *     403-shield, dan data kosong.
 *   - "SELAGI BELUM BERHASIL JANGAN BERHENTI": retry pass utama TANPA BATAS
 *     (backoff naik + jitter, cap 10s) sampai sukses; error permanen (input
 *     salah, 400 Invalid key) berhenti wajar karena mustahil berhasil. Bila
 *     ingin berbatas: --retries N.
 * ============================================================================
 */

'use strict';

/* ---------------------------------------------------------------- deps ---- */
let axios, cheerio;
try {
  axios = require('axios');
  cheerio = require('cheerio');
} catch (e) {
  console.error('[scraper] Dependency belum terpasang. Jalankan: npm install');
  console.error('[scraper] Detail:', e.message);
  process.exitCode = 1;
  throw e;
}

const fs = require('fs');
const path = require('path');

/* ================================ KONFIG ================================ */
const CREATOR = 'Razeerh';
const DOMAIN = 'subs4unlock.com';
const BASE_URL = 'https://subs4unlock.com';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const REQUEST_TIMEOUT = 20000;
const MAX_HOPS_SHELL = 8;     /* redirect safety: shell /{code} */
const MAX_HOPS_DEST = 5;      /* redirect safety: destination publik */
const GO_HOP_DELAY_MS = 300;  /* jeda sopan sebelum cek destination */

/* Fallback konstanta engine (hasil bedah live 2026-11-08). Dipakai bila
 * engine-discovery dinamis gagal (mis. shell down) supaya tetap bekerja. */
const ENGINE_FALLBACK = {
  api_url: 'https://myapi.videyhost.my.id/api.php',
  token: 'AgungDeveloper',
  origin: BASE_URL,
  referer: BASE_URL + '/',
  platform_order: ['YouTube', 'WhatsApp', 'Telegram', 'TikTok', 'Website', 'Instagram', 'Facebook'],
  labels: {
    YouTube: { subs: 'Subscribe Channel', like: 'Like Video', comm: 'Comment Video' },
    WhatsApp: { msg: 'Send Message', grp: 'Join Group' },
    Telegram: { chan: 'Join Channel', msg: 'Send Message' },
    TikTok: { flw: 'Follow Account', like: 'Like Video' },
    Website: { visit: 'Visit Website' },
    Instagram: { flw: 'Follow Account', like: 'Like Post' },
    Facebook: { flw: 'Follow Profile', like: 'Like Page', grp: 'Join Group' },
  },
  source: 'fallback_bundel_live_2026-11-08',
};

/* Peta tipe task (prefix key sebelum angka urut, mis. "subs1", "like2"). */
const ACTION_TYPE_MAP = {
  subs: 'subscribe',
  like: 'like',
  comm: 'comment',
  msg: 'message',
  grp: 'join',
  chan: 'join',
  flw: 'follow',
  visit: 'visit',
};

/* =============================== UTILITAS =============================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Backoff dinamis: delay ke-i naik (0.5s,1s,2s,4s,8s) lalu cap 10s + jitter. */
function backoffDelay(attempt) {
  const base = Math.min(500 * Math.pow(2, Math.max(0, Math.min(attempt, 5))), 10000);
  const jitter = Math.floor(Math.random() * Math.min(base * 0.25, 2000));
  return base + jitter;
}

/** Error jaringan yang layak di-retry. */
const RETRYABLE_NET = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ERR_ECONNRESET', 'ERR_SOCKET_CONNECTION_TIMEOUT',
  'EPROTO', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function netCode(e) {
  return (e && (e.code || (e.cause && e.cause.code))) || '';
}

/** GET sederhana dgn retry (default 1x kalau maxAttempts=1; policy per caller).
 *  maxRedirects:0 → 3xx dikembalikan apa adanya supaya caller merekam chain. */
async function resilientGet(url, opts = {}) {
  const {
    headers = {}, label = 'request', maxAttempts = 1, timeout = REQUEST_TIMEOUT,
    onAttempt = null,
  } = opts;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await axios.get(url, {
        timeout,
        maxRedirects: 0,
        validateStatus: () => true,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
          ...headers,
        },
      });
      const st = res.status;
      if ((st >= 200 && st < 400) || attempt >= maxAttempts) return res;
      const retryableStatus = st === 403 || st === 408 || st === 429 || st >= 500;
      if (!retryableStatus) return res; /* 4xx lain: final utk caller */
      const ra = Number(res.headers && res.headers['retry-after']);
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : backoffDelay(attempt - 1);
      if (onAttempt) onAttempt(attempt, st, wait, label);
      await sleep(wait);
    } catch (e) {
      const retryableNet = RETRYABLE_NET.has(netCode(e)) || /timeout/i.test(String(e && e.message));
      if (!retryableNet || attempt >= maxAttempts) throw e;
      const wait = backoffDelay(attempt - 1);
      if (onAttempt) onAttempt(attempt, netCode(e) || e.message, wait, label);
      await sleep(wait);
    }
  }
}

/** Ambil code dari input: URL penuh, URL tanpa scheme, atau kode telanjang. */
function extractCode(input) {
  if (!input || typeof input !== 'string') {
    return { code: null, error: 'Input URL kosong.' };
  }
  const raw = input.trim();
  let host = null;
  let slug = null;
  try {
    let urlLike = raw;
    if (!/^https?:\/\//i.test(urlLike)) {
      if (urlLike.startsWith('//')) urlLike = 'https:' + urlLike;
      else if (/^[\w-]+(\.[\w-]+)+\//i.test(urlLike) || /^[\w-]+(\.[\w-]+)+$/i.test(urlLike)) urlLike = 'https://' + urlLike;
    }
    if (/^https?:\/\//i.test(urlLike)) {
      const u = new URL(urlLike);
      host = u.hostname.replace(/^www\./i, '');
      const parts = u.pathname.split('/').filter(Boolean).filter((p) => p !== 'index.html');
      const qkey = u.searchParams.get('key');
      if (qkey) slug = qkey;
      else if (parts.length) slug = parts[0];
    } else {
      slug = urlLike.replace(/^\/+/, '').split('?')[0].split('#')[0];
    }
  } catch (e) {
    slug = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/').filter(Boolean)[0] || null;
  }

  const ownHost = new URL(BASE_URL).hostname;
  if (host && host !== ownHost) {
    return { code: null, error: `Domain tidak didukung: ${host} (engine ini khusus ${ownHost}).` };
  }
  if (!slug) {
    return { code: null, error: `Tidak menemukan short code pada input. Contoh: ${BASE_URL}/d675c4fc9b` };
  }
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(slug)) {
    return { code: null, error: `Short code tidak valid: "${slug}"` };
  }
  return { code: slug, error: null };
}

/* ==================== ENGINE DISCOVERY (adaptif) ==================== */

/* Cache engine dalam satu proses (hindari 2 request ekstra per link). */
let ENGINE_CACHE = null;

/** Parser kecil: ambil objek literal JS "{…}" mulai dari posisi "keyIdx"
 *  (keyIdx = index karakter key tertentu), hitung braces dgn sadar quotes,
 *  kutip keys, lalu JSON.parse. */
function parseLiteralObject(src, keyIdx) {
  if (keyIdx < 0) return null;
  let i = src.indexOf('{', keyIdx);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let p = i; p < src.length; p++) {
    const ch = src[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = p; break; } }
  }
  if (end < 0) return null;
  const raw = src.slice(i, end + 1);
  const quoted = raw.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
  try { return JSON.parse(quoted); } catch (e) { return null; }
}

/** Bedah konstanta engine dari chunk PageLink minified. */
function parseEngineChunk(js) {
  const out = {};
  const mApi = js.match(/"(https?:\/\/[A-Za-z0-9.\-]+\/api\.php)"/);
  if (mApi) out.api_url = mApi[1];
  const mTok = js.match(/api\.php"\s*,\s*[A-Za-z_$][\w$]*="([A-Za-z0-9_\-]+)"/);
  if (mTok) out.token = mTok[1];
  const mOrder = js.match(/\[(?:"(?:YouTube|WhatsApp|Telegram|TikTok|Website|Instagram|Facebook)"(?:\s*,"(?:YouTube|WhatsApp|Telegram|TikTok|Website|Instagram|Facebook)")*)\]/);
  if (mOrder && /"YouTube"/.test(mOrder[0])) {
    try { out.platform_order = JSON.parse(mOrder[0]); } catch (e) { /* pakai fallback */ }
  }
  const mapIdx = js.search(/[A-Za-z_$][\w$]*=\{\s*YouTube\s*:\s*\{/);
  if (mapIdx >= 0) {
    const obj = parseLiteralObject(js, mapIdx);
    if (obj && obj.YouTube) out.labels = obj;
  }
  out.source = 'dibaca_dari_bundel_engine_live';
  return out;
}

/** Ambil shell + bedah bundle engine. Semua longgar: gagal = tidak memblokir,
 *  fallback konstanta live terpakai. */
async function discoverEngine(onAttempt) {
  if (ENGINE_CACHE) return ENGINE_CACHE;
  const engine = { ...ENGINE_FALLBACK, labels: JSON.parse(JSON.stringify(ENGINE_FALLBACK.labels)) };
  try {
    const shell = await resilientGet(BASE_URL + '/', {
      label: 'shell beranda', maxAttempts: 5, headers: { Referer: BASE_URL + '/' }, onAttempt,
    });
    const html = typeof shell.data === 'string' ? shell.data : '';
    const mIndex = html.match(/\/assets\/(?:index|main)-([A-Za-z0-9]+)\.js/);
    if (mIndex) {
      const idxRes = await resilientGet(`${BASE_URL}/assets/index-${mIndex[1]}.js`, { label: 'index bundle', maxAttempts: 3 });
      const idxJs = typeof idxRes.data === 'string' ? idxRes.data : '';
      const mChunk = idxJs.match(/\.\/PageLink-([A-Za-z0-9]+)\.js/);
      if (mChunk) {
        const plRes = await resilientGet(`${BASE_URL}/assets/PageLink-${mChunk[1]}.js`, { label: 'PageLink chunk', maxAttempts: 3 });
        const plJs = typeof plRes.data === 'string' ? plRes.data : '';
        Object.assign(engine, parseEngineChunk(plJs), { origin: BASE_URL, referer: BASE_URL + '/' });
      }
    }
  } catch (e) {
    engine.discovery_note = `engine-discovery gagal (${e.message || e.code || 'unknown'}) — memakai fallback konstanta engine live`;
  }
  ENGINE_CACHE = engine;
  return engine;
}

/* ============================ REQUEST ENGINE ============================ */

/** Header API — dibangun OTOMATIS dari konstanta publik engine (bukan token
 *  manual dari user). Origin harus tepat (decisive), Referer bebas. */
function apiHeaders(engine) {
  const origin = (engine && engine.origin) || BASE_URL;
  return {
    Authorization: `Bearer ${(engine && engine.token) || ENGINE_FALLBACK.token}`,
    Origin: origin,
    Referer: ((engine && engine.referer) || BASE_URL) + '/',
  };
}

/** Panggil API page-data. Return {res, parsed}. */
async function apiFetch(engine, code, onAttempt) {
  const url = `${engine.api_url}?key=${encodeURIComponent(code)}`;
  const res = await resilientGet(url, {
    label: 'api page-data',
    headers: { ...apiHeaders(engine), Accept: 'application/json, text/plain, */*' },
    onAttempt,
  });
  let parsed = null;
  if (typeof res.data === 'object' && res.data !== null) parsed = res.data;
  else {
    try { parsed = JSON.parse(String(res.data)); } catch (e) { parsed = null; }
  }
  return { res, parsed };
}

/** GET shell dgn manual redirect chain (maks MAX_HOPS_SHELL). */
async function fetchShell(url, onAttempt) {
  let current = url;
  const chain = [];
  let last = null;
  for (let hop = 0; hop < MAX_HOPS_SHELL; hop++) {
    try {
      last = await resilientGet(current, {
        label: 'shell', maxAttempts: 5, headers: { Referer: BASE_URL + '/' }, onAttempt,
      });
    } catch (e) {
      return { res: null, chain, error: e };
    }
    chain.push({ url: current, status: last.status, location: last.headers ? (last.headers.location || null) : null });
    const st = last.status;
    const loc = last.headers && last.headers.location ? String(last.headers.location) : null;
    if (st >= 300 && st < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }
  return { res: last, chain, error: null };
}

/* ============================== PARSER HTML ============================== */

/** Ekstrak metadata SEO dari shell HTML (server-injection bila tersedia). */
function extractShellMeta(html) {
  const meta = { title: null, description: null, canonical_url: null, creator_name: null };
  if (!html || typeof html !== 'string') return meta;
  const isPlaceholder = (s) => /<!--\s*__SEO_[A-Z_]+__\s*-->/.test(String(s || ''));
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (title && !isPlaceholder(title)) meta.title = title.trim();
  const $ = cheerio.load(html);
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  if (desc && !isPlaceholder(desc)) meta.description = desc;
  const ogUrl = ($('meta[property="og:url"]').attr('content') || '').trim();
  if (ogUrl && /^https?:\/\//.test(ogUrl) && !isPlaceholder(ogUrl)) meta.canonical_url = ogUrl;
  const ld = $('script[type="application/ld+json"]').first().contents().text();
  if (ld && /SoftwareApplication|WebPage/.test(ld)) {
    try {
      const json = JSON.parse(ld);
      if (json && json.author && json.author.name) meta.creator_name = String(json.author.name);
    } catch (e) { /* JSON-LD bermasalah? kembali alternatif */ }
  }
  return meta;
}

/* =========================== PARSER DATA ENGINE ========================== */

/** Susun daftar task mengikuti urutan render tetap SPA + urutan key numerik. */
function collectTasks(cfg, labels, platformOrder) {
  const platforms = platformOrder || ENGINE_FALLBACK.platform_order;
  const rows = [];
  for (const platform of platforms) {
    const grp = cfg && cfg[platform];
    if (!grp || typeof grp !== 'object') continue;
    const entries = Object.entries(grp)
      .filter(([, url]) => typeof url === 'string' && url.trim() !== '')
      .sort((a, b) => {
        const na = Number((String(a[0]).match(/(\d+)$/) || [])[1] || 0);
        const nb = Number((String(b[0]).match(/(\d+)$/) || [])[1] || 0);
        return na - nb;
      });
    for (const [actionKey, url] of entries) {
      const action = actionKey.replace(/\d+$/, '');
      const label = (labels && labels[platform] && labels[platform][action]) || (ENGINE_FALLBACK.labels[platform] || {})[action] || null;
      rows.push({
        platform: platform.toLowerCase(),
        platform_label: platform,
        action_key: actionKey,
        task_type: ACTION_TYPE_MAP[action] || 'action',
        task_title: label || `${platform} ${actionKey}`,
        task_url: url.trim(),
        task_description: `Kunjungi tautan berikut dan selesaikan aksi "${label || actionKey}" (${platform}).`,
      });
    }
  }
  rows.forEach((t, i) => { t.task_order = i + 1; });
  return rows;
}

/** targetLinks → destination + alternates (urut angka, skip kosong). */
function collectTargetLinks(cfg) {
  const raw = (cfg && cfg.targetLinks) || null;
  const items = [];
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) {
        const num = Number((String(k).match(/(\d+)$/) || [])[1] || 0);
        items.push({ key: k, num, url: v.trim() });
      }
    }
    items.sort((a, b) => (a.num - b.num) || String(a.key).localeCompare(String(b.key)));
  }
  return items;
}

/** Expiry via sémantik engine client: X(exp) → layar "Link Expired" saat
 *  hari-ini >= tanggal exp; valid selama hari-ini < exp. */
function expiredFor(cfg) {
  const exp = cfg && cfg['Advance Option'] && cfg['Advance Option'].exp;
  if (!exp) return { hasExp: false, expired: false, iso: null };
  const dt = new Date(exp);
  if (isNaN(dt.getTime())) return { hasExp: true, expired: false, iso: null, raw: exp };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const thatDay = new Date(dt); thatDay.setHours(0, 0, 0, 0);
  return { hasExp: true, expired: today.getTime() >= thatDay.getTime(), iso: dt.toISOString() };
}

/* ==================== VERIFIKASI REDIRECT DESTINATION =================== */

/** Cek redirect publik destination secara langsung (tanpa sembunyi-sembunyi):
 *  GET (maxRedirects:0) dgn UA browser; bila 3xx → catat Location & lanjut. */
async function checkDestinationRedirect(destUrl, onAttempt) {
  const chain = [];
  let current = destUrl;
  let referer = BASE_URL + '/';
  try {
    for (let hop = 1; hop <= MAX_HOPS_DEST; hop++) {
      await sleep(hop === 1 ? GO_HOP_DELAY_MS : 250);
      const res = await resilientGet(current, {
        label: `dest-hop${hop}`, maxAttempts: 3, timeout: 15000,
        headers: { Accept: 'text/html', Referer: referer }, onAttempt,
      });
      const st = res.status;
      const loc = res.headers && res.headers.location ? String(res.headers.location) : null;
      chain.push({
        url: current,
        status: st,
        location: loc ? new URL(loc, current).toString() : null,
        content_type: (res.headers && res.headers['content-type']) || null,
      });
      if (st >= 300 && st < 400 && loc) {
        current = new URL(loc, current).toString();
        referer = current;
        continue;
      }
      break;
    }
  } catch (e) {
    return { chain, redirect_url: null, note: `cek redirect destination gagal: ${e.message || e.code || 'unknown'}` };
  }
  const firstHop = chain.find((c) => c.status >= 300 && c.status < 400 && c.location);
  return {
    chain,
    redirect_url: firstHop ? firstHop.location : null,
    final_status: chain.length ? chain[chain.length - 1].status : null,
  };
}

/* ============================ RESULT FACTORY ============================ */

function baseResult(input) {
  return {
    status: null,
    creator: CREATOR,
    domain: DOMAIN,
    original_url: input || null,
    link_id: null,
    page: {
      title: null,
      description: null,
      status: null,          /* active | expired | not_found | error */
      creator_name: null,
      canonical_url: null,
      page_url: null,
      thumbnail: null,
      note: null,
      color: null,
      style: null,
      button_text: null,
      password_protected: false,
      created_at: null,
      expires_at: null,
    },
    requirements: {
      total_tasks: 0,
      tasks: [],
    },
    destination: {
      status: 'locked',      /* unlocked | locked */
      url: null,
      access_method: null,   /* public_page_data (API publik engine sendiri) */
      redirect_url: null,
      alternate_links: [],
    },
    technical: {
      http_status: null,     /* status HTTP halaman /{code} */
      content_type: null,
      response_status: null, /* success | error */
      fetched_at: new Date().toISOString(),
      error_message: null,
      api_url: null,
      api_status: null,
      api_content_type: null,
      engine_source: null,
      shell_redirect_chain: [],
      destination_redirect_chain: [],
      retries_used: 0,
      duration_ms: null,
    },
    error: null,
  };
}

/* ============================ ALUR UTAMA ENGINE ========================= */

/**
 * Fungsi inti scrape+bypass subs4unlock.com.
 * @param {string} input URL penuh / kode telanjang
 * @param {{savePath?: string|null, pretty?: boolean, maxRetries?: number,
 *          checkDest?: boolean}} opts
 *   savePath   : default 'result.json' (hasil selalu diupayakan tersimpan);
 *                null/'none' = tanpa file.
 *   pretty     : default true.
 *   maxRetries : batas pass retry utama; default INFINITY (selagi belum
 *                sukses terus dicoba — baca catatan di header file).
 *   checkDest  : default true — verifikasi redirect publik destination.
 */
async function scrapeSubs4Unlock(input, opts = {}) {
  const startedMs = Date.now();
  const pretty = opts.pretty !== false;
  const savePath = opts.savePath === undefined ? 'result.json' : opts.savePath;
  const maxRetries = typeof opts.maxRetries === 'number' ? Math.max(0, opts.maxRetries) : Infinity;
  const checkDest = opts.checkDest !== false;

  const attempts = [];

  const { code, error: inputErr } = extractCode(input);
  if (!code) {
    const res = failResult(code, null, `input_error: ${inputErr}`, 'error', input);
    res.technical.duration_ms = Date.now() - startedMs;
    finalizeResult(res, savePath, pretty, attempts);
    return res;
  }

  let finalRes = null;

  /* ==== PASS LOOP: SELAGI BELUM SUKSES (dan bukan error permanen) ====
     1 pass sukses = API page-data 200 + status:"success". Shell
     (kebetulan 404) tidak memblokir — API sumber data otoritatif. */
  const MAX_PASSES_SAFETY = 10000; /* jaringan hidup: praktis tak terbatas */
  let lastNetworkError = null;
  for (let pass = 1; pass <= MAX_PASSES_SAFETY; pass++) {
    const verdict = await enginePass(code, pass, attempts);

    if (verdict.done) {
      finalRes = verdict.result;
      break;
    }

    if (verdict.networkError) lastNetworkError = verdict.networkError;

    /* Menahan tempo pass: backoff ringan di antara pass agar sopan ke server. */
    const calm = pass <= 4 ? backoffDelay(pass - 1) : 10000;
    await sleep(calm);

    if (pass >= maxRetries) {
      finalRes = failResult(
        code, verdict.shell || null,
        `error: belum sukses setelah ${pass} pass retry (${lastNetworkError ? `terakhir: ${lastNetworkError}` : 'engine belum memberikan data lengkap'}). Naikkan --retries bila ingin lebih gigih.`,
        'error', input
      );
      break;
    }
  }

  if (finalRes === null) {
    finalRes = failResult(code, verdict ? verdict.shell || null : null, 'error: loop re-try berhenti tanpa hasil (tak terduga).', 'error', input);
  }

  /* ============ destination + verifikasi redirect publik ============ */
  if (finalRes.destination.url) {
    if (checkDest) {
      const via = await checkDestinationRedirect(finalRes.destination.url, (n, info, wait, label) =>
        attempts.push({ kind: 'retry', at: label || 'destination', detail: String(info), wait }));
      finalRes.technical.destination_redirect_chain = via.chain;
      if (via.redirect_url) finalRes.destination.redirect_url = via.redirect_url;
      else if (via.note) finalRes.technical.nav_note = via.note;
    }
    finalRes.destination.access_method = 'public_page_data';
    finalRes.destination.status = 'unlocked';
    if (finalRes.page.status === 'expired') {
      finalRes.destination.expired_note = 'Link sudah kedaluwarsa di UI engine, namun destination tetap dipublikasikan API (kasus sama seperti expired_but_public).';
    }
  } else if (finalRes.page.status === 'active' || finalRes.page.status === 'expired') {
    finalRes.destination.status = finalRes.page.status === 'expired' ? 'expired' : 'locked';
    finalRes.destination.access_method = null;
  }

  /* ============== status keseluruhan + error_message final =============== */
  finalRes.technical.retries_used = attempts.filter((a) => a.kind === 'retry').length;
  finalRes.technical.duration_ms = Date.now() - startedMs;
  if (finalRes.error) {
    finalRes.status = false;
    finalRes.technical.response_status = 'error';
    finalRes.technical.error_message = finalRes.error;
  } else {
    finalRes.status = true;
    finalRes.technical.response_status = 'success';
    finalRes.technical.error_message = null;
    finalRes.technical.engine_source = (ENGINE_CACHE && ENGINE_CACHE.source) || ENGINE_FALLBACK.source;
    finalRes.technical.discovery_note = (ENGINE_CACHE && ENGINE_CACHE.discovery_note) || null;
    /* Keterangan jujur: shell 404 bukan indicasi gagal — link valid & unlock
       public tetap datang dari API engine. */
    if (finalRes.technical.http_status != null && finalRes.technical.http_status >= 400 && finalRes.technical.api_status === 200) {
      finalRes.technical.shell_note =
        `Halaman /${code} dibalas ${finalRes.technical.http_status} oleh lapisan SEO server; body tetap shell SPA yang siap merender, dan data unlock adalah respons publik API engine (page-data).`;
    }
  }

  finalizeResult(finalRes, savePath, pretty, attempts);
  return finalRes;
}

/* ==================== PASS TUNGGAL: shell + engine + API ================== */

/**
 * Satu pass = shell fetch (longgar) + engine discovery (fallback) + API read
 * (strict). Return {done, fail?, result, shell, networkError?}.
 */
async function enginePass(code, passOrdinal, attemptLog) {
  /* hook logging internal: resilientGet memanggil (n, info, wait, label) */
  const hook = (n, info, wait, label) => attemptLog.push({ kind: 'retry', at: label || 'unknown', detail: String(info), wait });

  /* 1) shell /{code} — meta SEO + status http; LONGGAR (tidak memblokir) */
  const shell = await fetchShell(`${BASE_URL}/${encodeURIComponent(code)}`, hook);

  /* 2) engine discovery adaptif (dengan fallback konstanta live) */
  let engine;
  try { engine = await discoverEngine(hook); }
  catch (e) {
    attemptLog.push({ kind: 'error', at: 'engine', detail: e.message || e.code });
    engine = { ...ENGINE_FALLBACK, labels: JSON.parse(JSON.stringify(ENGINE_FALLBACK.labels)) };
  }

  /* 3) API page-data — jantung engine ini */
  let apiRes = null;
  let parsed = null;
  try {
    ({ res: apiRes, parsed } = await apiFetch(engine, code, hook));
  } catch (e) {
    attemptLog.push({ kind: 'error', at: 'api', detail: e.message || e.code });
    return { done: false, shell, networkError: `API tidak terjangkau (${e.message || e.code})` };
  }

  const stApi = apiRes.status;

  /* 400 Invalid key = permanen */
  if (stApi === 400) {
    return { done: true, fail: true, result: failResult(code, shell, 'not_found: kode tidak dikenal engine (400 Invalid key).', 'not_found'), shell };
  }
  /* 401 = token engine mungkin berubah → refresh discovery lalu retry pass */
  if (stApi === 401) {
    ENGINE_CACHE = null;
    attemptLog.push({ kind: 'refresh', at: 'engine-auth', detail: 'cache engine dibuang; akan dibaca ulang di pass berikutnya' });
    return { done: false, shell, networkError: 'engine 401 (bearer berubah) — pass berikutnya dengan engine segar' };
  }
  /* 403/429/5xx → biarkan pass berikutnya mencoba (perpetual) */
  if (stApi === 403 || stApi === 429 || stApi >= 500) {
    return { done: false, shell, networkError: `engine belum menyetujui peri request (HTTP ${stApi}) — pass berikutnya` };
  }

  /* respons API tidak bisa di-parse → error data (permanen) */
  if (!parsed || typeof parsed !== 'object') {
    return {
      done: true, fail: true,
      result: failResult(code, shell, `error: respons engine (HTTP ${stApi}) bukan JSON page-data yang valid.`, 'error'),
      shell,
    };
  }
  if (parsed && parsed.status === 'error') {
    const msg = (parsed.error && (parsed.error.message || parsed.error)) || 'engine melaporkan error halaman';
    return { done: true, fail: true, result: failResult(code, shell, `error: engine API menolak: ${msg}`, 'error'), shell };
  }
  if (parsed.status !== 'success' || !parsed.data || typeof parsed.data !== 'object') {
    return {
      done: true, fail: true,
      result: failResult(code, shell, `error: page-data engine punya bentuk tidak dikenal (${JSON.stringify(parsed).slice(0, 160)}).`, 'error'),
      shell,
    };
  }

  /* ========= SUKSES: bangun hasil final dari public page data ========= */
  const cfg = parsed.data.data || {};
  const adv = cfg['Advance Option'] || {};
  const shellMeta = extractShellMeta(shell.res && typeof shell.res.data === 'string' ? shell.res.data : '');
  const created_at = parsed.data.created_at || null;
  const expInfo = expiredFor(cfg);

  const tasks = collectTasks(cfg, engine.labels, engine.platform_order);
  const targets = collectTargetLinks(cfg);
  const destUrl = targets.length ? targets[0].url : null;

  const res = emptyScrapeResult(code);
  res.original_url = shell.res ? (shell.res.config && shell.res.config.url) || `${BASE_URL}/${code}` : `${BASE_URL}/${code}`;

  /* ---- page ---- */
  res.page.title = cfg.title || shellMeta.title || null;
  res.page.description = cfg.subtitle || shellMeta.description || null;
  res.page.status = !expInfo.expired ? 'active' : 'expired';
  res.page.creator_name = shellMeta.creator_name || null;
  res.page.canonical_url = shellMeta.canonical_url || `${BASE_URL}/${code}`;
  res.page.page_url = `${BASE_URL}/${code}`;
  res.page.thumbnail = adv.thumb || null;
  res.page.note = adv.note || null;
  res.page.color = cfg.color || null;
  res.page.style = cfg.sty || null;
  res.page.button_text = cfg.buttonName || null;
  res.page.password_protected = Boolean(adv.pass);
  res.page.created_at = created_at;
  res.page.expires_at = expInfo.iso;

  /* ---- requirements ---- */
  res.requirements.total_tasks = tasks.length;
  res.requirements.tasks = tasks.map((t) => ({
    platform: t.platform,
    task_type: t.task_type,
    task_title: t.task_title,
    task_order: t.task_order,
    task_url: t.task_url,
    task_description: t.task_description,
    action_key: t.action_key,
  }));

  /* ---- destination (dipublikasikan engine ke setiap browser) ---- */
  res.destination.url = destUrl;
  res.destination.alternate_links = targets.slice(1).map((t) => ({ key: t.key, url: t.url }));
  if (adv.pass) {
    res.destination.password_note =
      'Link ini dilindungi password di UI (dibandingkan di browser); nilai destination tetap dipublikasikan API engine.';
  }

  /* ---- technical ---- */
  const tx = res.technical;
  tx.http_status = shell.res ? shell.res.status : null;
  tx.content_type = shell.res && shell.res.headers ? (shell.res.headers['content-type'] || null) : null;
  tx.shell_redirect_chain = shell.chain;
  tx.api_url = engine.api_url;
  tx.api_status = apiRes.status;
  tx.api_content_type = (apiRes.headers && apiRes.headers['content-type']) || null;
  tx.engine_source = engine.source || null;

  attemptLog.push({ kind: 'success', pass: passOrdinal });
  return { done: true, fail: false, result: res, shell };
}/* ============================ HELPERS HASIL ============================ */

/** Kerangka hasil dengan kontrak data user (nilai kosong). */
function emptyScrapeResult(code) {
  const res = baseResult(null);
  res.original_url = `${BASE_URL}/${code}`;
  res.link_id = code;
  return res;
}

/** Hasil gagal/not_found/error yang tetap konsisten bentuknya. */
function failResult(code, shell, errMsg, pageStatus, originalInput) {
  const res = emptyScrapeResult(code || 'unknown');
  if (originalInput) res.original_url = originalInput;
  res.status = false;
  res.error = errMsg;
  res.page.status = pageStatus;
  if (shell && shell.res) {
    res.technical.http_status = shell.res.status;
    res.technical.content_type = (shell.res.headers && shell.res.headers['content-type']) || null;
    res.technical.shell_redirect_chain = shell.chain || [];
  }
  return res;
}

/** Simpan result.json + bersihkan konteks bantuan. */
function finalizeResult(res, savePath, pretty, attempts) {
  if (savePath) {
    try {
      const p = path.resolve(savePath);
      fs.writeFileSync(p, JSON.stringify(res, null, pretty ? 2 : 0) + '\n', 'utf8');
      res._saved_to = p;
    } catch (e) { /* best-effort */ }
  }
}

/* =============================== CLI =============================== */
function printHelp() {
  console.log(`
scrape-bypass-subs4unlock-com.js — engine subs4unlock.com (creator: ${CREATOR})
Output: JSON (simpan result.json + cetak ke stdout)

PENGGUNAAN:
  node scrape-bypass-subs4unlock-com.js <URL|code> [opsi]

OPSI:
  --out <file>        file output (default result.json); 'none' = tanpa file
  --compact           JSON 1 baris (default: pretty indent)
  --retries <N>       batas retry pass utama (default: TANPA BATAS selagi belum sukses)
  --no-dest-check     lewati verifikasi redirect publik destination
  --help, -h          bantuan ini

CONTOH:
  node scrape-bypass-subs4unlock-com.js "https://subs4unlock.com/d675c4fc9b"
  node scrape-bypass-subs4unlock-com.js d675c4fc9b --out hasil.json
  node scrape-bypass-subs4unlock-com.js "https://subs4unlock.com/6d363412ab" --compact
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
    let savePath = 'result.json';
    let pretty = true;
    let maxRetries = Infinity;
    let checkDest = true;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--out' && argv[i + 1] !== undefined) { savePath = argv[i + 1] === 'none' ? null : argv[i + 1]; i++; }
      else if (argv[i] === '--compact') pretty = false;
      else if (argv[i] === '--pretty') pretty = true;
      else if (argv[i] === '--retries' && argv[i + 1] !== undefined) { const n = Number(argv[i + 1]); maxRetries = Number.isFinite(n) && n > 0 ? n : Infinity; i++; }
      else if (argv[i] === '--no-dest-check') checkDest = false;
    }

    console.error(`[scraper] target  : ${input}`);
    const result = await scrapeSubs4Unlock(input, { savePath, pretty, maxRetries, checkDest });

    console.error(`[scraper] status  : ${result.status} | halaman: ${result.page.status} | tugas: ${result.requirements.total_tasks} | destination: ${result.destination.status}${result.destination.url ? ` → ${result.destination.url}` : ''}`);
    console.error(`[scraper] retry=${result.technical.retries_used} | durasi=${result.technical.duration_ms}ms | simpan=${result._saved_to || '(stdout saja)'}`);

    const view = Object.assign({}, result);
    delete view._saved_to;
    console.log(JSON.stringify(view, null, pretty ? 2 : 0));
    process.exit(result.status ? 0 : 1);
  })().catch((e) => {
    console.error('[scraper] fatal:', e.message);
    const err = baseResult(process.argv[2] || null);
    err.status = false;
    err.error = `fatal: ${e.message || e.code || 'unknown'}`;
    err.page.status = 'error';
    err.technical.response_status = 'error';
    err.technical.error_message = err.error;
    try { fs.writeFileSync(path.resolve('result.json'), JSON.stringify(err, null, 2) + '\n'); } catch (e2) { /* diamkan */ }
    console.log(JSON.stringify(err, null, 2));
    process.exit(1);
  });
}

/* ============================ EKSPORT MODULE ============================ */
module.exports = {
  scrapeSubs4Unlock,
  extractCode,
  checkDestinationRedirect,
  parseEngineChunk,
  discoverEngine,
  collectTasks,
  collectTargetLinks,
  expiredFor,
  ACTION_TYPE_MAP,
  ENGINE_FALLBACK,
  constants: { CREATOR, DOMAIN, BASE_URL, FALLBACK_API_URL: ENGINE_FALLBACK.api_url, FALLBACK_TOKEN: ENGINE_FALLBACK.token },
};
