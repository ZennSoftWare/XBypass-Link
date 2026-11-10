/**
 * ============================================================================
 *  ShrinkMe Bypass Resolvers — scrape-bypass-shrinkme.js
 *  creator: Razeerh
 * ============================================================================
 *  Target  : https://shrinkme.click   (mirror: shrinkme.io / shrinkme.ink)
 *  Layanan : AdLinkFly 6.6.4 (CakePHP) + Cloudflare Turnstile
 *
 *  ENGINE RINGAN (murni HTTP — TANPA Playwright/Puppeteer/Selenium):
 *   - Engine P (Page)      : halaman shortlink + cookie jar otomatis + leak
 *                            metadata og:* (title/description/image tujuan)
 *   - Engine D (Direct)    : replay rantai resmi AdLinkFly murni HTTP
 *   - Engine P2 (MetaProxy): fallback metadata via proxy teks publik
 *   - Engine V (Search-Verify): og:title halaman shortlink = judul halaman
 *                            tujuan (di-scrape server AdLinkFly); kandidat
 *                            dicari di indeks pencarian publik lalu
 *                            DIVERIFIKASI exact-match judul => destination
 *                            terverifikasi TANPA input/loop apa pun
 *   - Engine C (Crowd)     : FastForward Crowd Query (publik, tanpa API key)
 *   - Engine B (BypassCity): api2.bypass.city + api2.adbypass.org (publik)
 *   - Engine E (Enrich)    : title/desc/og dari halaman destinasi
 *
 *  Transport AJA: axios (utama) <-> node https mentah (cadangan) bergantian
 *  per retry, family IPv4-first (stabil di jaringan seluler/termux), TLS
 *  dikendalikan agar aman terhadap interensi jaringan non-standar.
 *
 *  Kebijakan resolver: SINGLE-SHOT (default) — SATU eksekusi, langsung
 *  dilaporkan hasil + status + alasan mesin (engine_trace), result.json
 *  ditulis sekali di akhir. Mode loop lama hanya lewat flag --loop atau
 *  opts.loop:true di module.
 *
 *  CLI:
 *    npm install
 *    node scrape-bypass-shrinkme.js "https://shrinkme.click/ThiLik" [opsi]
 *    Default = single-shot 1 eksekusi (tanpa retry panjang), lalu cetak
 *    ringkasan status + tulis result.json + exit 0 (sukses) / 3 (belum).
 *    Opsi: --loop  --tries N  --interval SEC  --out PATH  --no-search  --verbose
 *
 *  MODULE:
 *    const { resolve, resolveOnce } = require('./scrape-bypass-shrinkme.js');
 *    const rec = await resolve('https://shrinkme.click/ThiLik');          // single-shot
 *    const rec2 = await resolve(url, { loop: true, tries: 3 });           // mode loop
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const http = require('http');

/* ---------------------------------------------------------------------------
 * Konfigurasi
 * ------------------------------------------------------------------------- */
const CONFIG = {
  creator: 'Razeerh',
  service: 'shrinkme',
  // Keluarga domain ShrinkMe (terverifikasi hidup via riset live Nov 2026)
  domainPool: ['shrinkme.click', 'shrinkme.io', 'shrinkme.ink'],
  canonicalDomain: 'shrinkme.click',
  userAgentA: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  userAgentB: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  requestTimeout: 20000,
  perCallRetries: 4,       // retry per panggilan (axios <-> raw bergantian)
  crowdEndpoint: 'https://crowd.fastforward.team/crowd/query_v1',
  bypassCityEndpoints: ['https://api2.bypass.city/bypass', 'https://api2.adbypass.org/bypass'],
  defaultIntervalMs: 8000,
  resultFile: 'result.json',
  // '4' = paksa IPv4, '6' = paksa IPv6, '' = otomatis (env override)
  family: process.env.SM_FAMILY === '4' || process.env.SM_FAMILY === '6' ? Number(process.env.SM_FAMILY) : 4,
  // Engine V: daftar provider pencarian (bisa di-override untuk test offline)
  searchProviders: null,
};

/* ---------------------------------------------------------------------------
 * Logger
 * ------------------------------------------------------------------------- */
const VERBOSE = process.argv.includes('--verbose');
function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`[${t}] ${msg}\n`);
}
function vlog(msg) { if (VERBOSE) process.stdout.write(`        · ${msg}\n`); }

/* ---------------------------------------------------------------------------
 * Waktu (resolved_at di vs WIB: contoh 2026-11-08T08:30:00+07:00)
 * ------------------------------------------------------------------------- */
function resolvedAtWIB(date = new Date()) {
  const d = new Date(date.getTime() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+07:00`;
}

/* ---------------------------------------------------------------------------
 * Cookie jar otomatis (cookie diambil langsung dari server — bukan manual)
 * ------------------------------------------------------------------------- */
class CookieJar {
  constructor() { this.m = new Map(); }
  apply(hostname, setCookieArr) {
    const cur = this.m.get(hostname) || {};
    const list = Array.isArray(setCookieArr) ? setCookieArr : (setCookieArr ? [setCookieArr] : []);
    for (const raw of list) {
      try {
        const first = String(raw).split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        const expires = /expires=([^;]+)/i.exec(raw);
        if (expires) {
          const d = new Date(expires[1]);
          if (!isNaN(d) && d.getTime() <= Date.now()) { delete cur[name]; continue; }
        }
        if (/max-age=0/i.test(raw)) { delete cur[name]; continue; }
        cur[name] = value;
      } catch (_) { /* abaikan cookie rusak */ }
    }
    this.m.set(hostname, cur);
  }
  header(hostname) {
    const cur = this.m.get(hostname) || {};
    const s = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join('; ');
    return s || undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Transport #1 — axios
 * ------------------------------------------------------------------------- */
const mkAgent = (K) => new K({
  keepAlive: true, maxSockets: 6, family: CONFIG.family || undefined, rejectUnauthorized: false,
  timeout: 0, // timeout dihandle oleh axios per-request
});
const axiosHttpsAgent = mkAgent(https.Agent);
const axiosHttpAgent = mkAgent(http.Agent);

function mkAxiosClient(jar) {
  return async function request(method, url, opts = {}) {
    const u = new URL(url);
    let body;
    const headers = {
      'user-agent': Math.random() > 0.5 ? CONFIG.userAgentA : CONFIG.userAgentB,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'identity',
      ...(jar.header(u.hostname) ? { cookie: jar.header(u.hostname) } : {}),
      ...(opts.headers || {}),
    };
    if (opts.form) {
      body = new URLSearchParams(opts.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(body);
    } else if (opts.json) {
      body = JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    try {
      const res = await axios({
        method, url,
        headers,
        data: body || undefined,
        timeout: opts.timeout || CONFIG.requestTimeout,
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'text',
        httpsAgent: axiosHttpsAgent,
        httpAgent: axiosHttpAgent,
        maxBodyLength: Infinity,
      });
      jar.apply(u.hostname, res.headers && res.headers['set-cookie']);
      return { status: res.status, headers: res.headers, body: typeof res.data === 'string' ? res.data : '' };
    } catch (e) {
      const err = new Error(`network error: ${(e.code || e.message || 'unknown')}`);
      err.network = true;
      throw err;
    }
  };
}

/* ---------------------------------------------------------------------------
 * Transport #2 — node https mentah (cadangan keraguan transport)
 * ------------------------------------------------------------------------- */
const rawAgentHttps = mkAgent(https.Agent);
const rawAgentHttp = mkAgent(http.Agent);

function mkRawClient(jar) {
  return function request(method, url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === 'https:';
      const lib = secure ? https : http;
      const agent = secure ? rawAgentHttps : rawAgentHttp;
      let body;
      const headers = {
        'user-agent': Math.random() > 0.5 ? CONFIG.userAgentA : CONFIG.userAgentB,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'identity',
        ...(jar.header(u.hostname) ? { cookie: jar.header(u.hostname) } : {}),
        ...(opts.headers || {}),
      };
      if (opts.form) {
        body = new URLSearchParams(opts.form).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
        headers['content-length'] = Buffer.byteLength(body);
      } else if (opts.json) {
        body = JSON.stringify(opts.json);
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(body);
      }
      let settled = false;
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (secure ? 443 : 80),
        path: u.pathname + u.search,
        method,
        agent,
        headers,
        timeout: opts.timeout || CONFIG.requestTimeout,
      }, (res) => {
        jar.apply(u.hostname, res.headers['set-cookie']);
        let d = '';
        res.on('data', (c) => { if (d.length < 2_000_000) d += c; });
        res.on('end', () => {
          settled = true;
          resolve({ status: res.statusCode, headers: res.headers, body: d });
        });
      });
      req.on('timeout', () => {
        req.destroy();
        if (!settled) {
          const e = new Error('network error: REQUEST_TIMEOUT');
          e.network = true;
          reject(e);
        }
      });
      req.on('error', (e) => {
        if (!settled) {
          const e2 = new Error(`network error: ${(e.code || e.message || 'unknown')}`);
          e2.network = true;
          reject(e2);
        }
      });
      if (body) req.write(body);
      req.end();
    });
  };
}

/* ---------------------------------------------------------------------------
 * Panggilan dgn retry + pergantian transport (axios <-> raw) tiap attempt
 * ------------------------------------------------------------------------- */
function mkJarClient(jar) {
  const a = mkAxiosClient(jar);
  const b = mkRawClient(jar);
  return { a, b };
}

async function callWithRetry(pair, method, url, opts = {}, tries0 = CONFIG.perCallRetries) {
  const tries = Math.max(1, tries0);
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    const transport = ['axios', 'raw', 'axios', 'raw'][Math.min(i - 1, 3)];
    const client = transport === 'axios' ? pair.a : pair.b;
    try {
      const res = await client(method, url, opts);
      return res;
    } catch (e) {
      if (!e.network) throw e;
      lastErr = e;
      vlog(`net-retry ${i}/${tries} (${transport}) ${new URL(url).hostname}${decodeURI(new URL(url).pathname).slice(0, 40)} — ${e.message.slice(0, 60)}`);
      await sleep(1000 * i);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
 * Parser input
 * ------------------------------------------------------------------------- */
function parseInput(inputUrl) {
  const out = { ok: false, code: null, short_domain: null, error: null };
  try {
    let u = String(inputUrl || '').trim();
    if (!u) { out.error = 'URL kosong'; return out; }
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const poolHosts = CONFIG.domainPool.map((d) => (d.includes('://') ? new URL(d).hostname : d));
    const isShrinkme = poolHosts.some((d) => host === d || host.endsWith('.' + d));
    if (!isShrinkme) { out.error = `bukan link shrinkme: ${host}`; return out; }
    let code = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
    if (!code && url.searchParams.get('adlinkfly')) code = url.searchParams.get('adlinkfly');
    if (!code && url.searchParams.get('r')) code = url.searchParams.get('r');
    code = decodeURIComponent(code || '').split(/[?#]/)[0].trim();
    if (!code) { out.error = 'kode shortlink kosong'; return out; }
    out.ok = true; out.code = code; out.short_domain = host;
  } catch (e) {
    out.error = `URL tidak valid: ${e.message}`;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Ekstraksi umum (metadata og, app_vars, dest dari script)
 * ------------------------------------------------------------------------- */
function ogPats(t) {
  return [
    new RegExp(`<meta[^>]+(?:name|property)=["']${t}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${t}["']`, 'i'),
  ];
}
function extractAppVars(html) {
  const m = /var app_vars = (\{[\s\S]*?\});/.exec(html);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (_) { return {}; }
}
const STATIC_EXT = /\.(css|js|webp|png|jpe?g|gif|svg|woff2?)(\?|$)/i;
const INTERNAL_URL = /shrinkme|cloudflare|googletag|clarity|fonts\.|maxcdn|gstatic|googleapis|ads\.|hai8g|emperydefogs|cloudfront|example\.com|instagram|facebook|skype|cdn-cgi|w3\.org|shortpixel|oss\.maxcdn/i;
const GARBAGE_META = /just a moment|attention required|checking your browser|verifying you are human|enable javascript|browser guard|security check|please wait/i;

function extractMeta(html) {
  const meta = { title: null, description: null, image: null };
  for (const p of ogPats('og:title')) { const m = p.exec(html); if (m) { meta.title = m[1]; break; } }
  for (const p of ogPats('og:description')) { const m = p.exec(html); if (m) { meta.description = m[1]; break; } }
  for (const p of ogPats('og:image')) { const m = p.exec(html); if (m) { meta.image = m[1]; break; } }
  if (!meta.description) {
    const m = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html);
    if (m) meta.description = m[1];
  }
  if (!meta.title) {
    const m = /<title>([^<]*)<\/title>/i.exec(html);
    if (m && m[1]) meta.title = m[1].trim();
  }
  // bersihkan metadata tief kaktus (Cloudflare "Just a moment...", dsb)
  if (meta.title && GARBAGE_META.test(meta.title)) meta.title = null;
  if (meta.description && GARBAGE_META.test(meta.description)) meta.description = null;
  if (meta.image && /favicon/i.test(meta.image)) meta.image = null;
  return meta;
}

function extractDestinationFromScripts(html) {
  const pats = [
    /window\.location\.href\s*=\s*["']([^"']+)["']/gi,
    /window\.location\.replace\(\s*["']([^"']+)["']/gi,
    /(?:var|const|let)\s+[A-Za-z_$]+\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
    /<a[^>]+href=["'](https?:\/\/[^"'\s]+)["']/gi,
  ];
  for (const p of pats) {
    let m;
    while ((m = p.exec(html || ''))) {
      const v = m[1];
      if (!v || STATIC_EXT.test(v) || INTERNAL_URL.test(v)) continue;
      if (!/^https?:\/\//i.test(v)) continue;
      return v;
    }
  }
  return null;
}

function absolutize(base, x) {
  if (!x) return x;
  try { return new URL(x, base).href; } catch (_) { return x; }
}

/* ---------------------------------------------------------------------------
 * ENGINE P — Page: halaman interstitial + metadata leak + konfigurasi captcha
 * ------------------------------------------------------------------------- */
function isFamilyHost(h) {
  h = String(h || '').toLowerCase().replace(/^www\./, '');
  const poolHosts = CONFIG.domainPool.map((d) => {
    if (!d.includes('://')) return d;
    try { return new URL(d).hostname; } catch (_) { return d; }
  });
  return poolHosts.some((d) => h === d || h.endsWith('.' + d));
}
const IS_BLOCK_HOST = /(blockpage|internetpositif|positif|blocked|plerk|bermasalah)/i;

async function enginePage(pair, code) {
  for (const domain of CONFIG.domainPool) {
    const base = domain.includes('://') ? domain.replace(/\/+$/, '') : `https://${domain}`;
    let url = `${base}/${code}`;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const r = await callWithRetry(pair, 'get', url);
        if (r.status >= 300 && r.status < 400 && r.headers.location) {
          const loc = r.headers.location;
          const next = /^https?:/i.test(loc) ? loc : new URL(loc, url).href;
          const nextHost = new URL(next).hostname;
          // JANGAN mengikuti redirect keluar keluarga domain shrinkme
          // amanag banget: host blocker ISP (mis. blockpage.xlaxiata.id)
          if (!isFamilyHost(nextHost)) {
            if (IS_BLOCK_HOST.test(nextHost)) vlog(`P: ${domain} terkena blokir ISP (${nextHost}) — lewat`);
            else vlog(`P: redirect keluar keluarga (#${nextHost}) — berhenti di sini`);
            break;
          }
          url = next;
          vlog(`P redirect -> ${url}`);
          continue;
        }
        if (r.status === 404) {
          return { found: false, is404: true, error: `kode "${code}" tidak ditemukan (404)` };
        }
        if (r.status === 200 && r.body && /app_vars|shrinkme/i.test(r.body)) {
          const pageClass = (/<body class="([^"]+)/i.exec(r.body) || [])[1] || '';
          const appVars = extractAppVars(r.body);
          const captcha = {
            enabled: appVars.enable_captcha === 'yes',
            type: appVars.captcha_type || null,
            counter: parseInt(appVars.counter_value || '0', 10) || 0,
            turnstileKey: appVars.turnstile_site_key || null,
          };
          return {
            found: true,
            finalUrl: url,
            finalDomain: new URL(url).hostname,
            meta: extractMeta(r.body),
            pageClass,
            captcha,
            appVars,
            html: r.body,
          };
        }
        break; // status/format tak dikenal -> coba domain berikutnya
      }
    } catch (e) {
      vlog(`P ${domain} gagal: ${e.message.slice(0, 70)}`);
    }
  }
  return { found: false, error: 'halaman shortlink tidak terjangkau di semua domain keluarga shrinkme' };
}

/* ---------------------------------------------------------------------------
 * ENGINE P2 — Fallback metadata via proxy teks publik (tanpa key).
 * Dipakai bila domain blocked ISP (terminal) atau halaman gagal dibaca,
 * supaya destination_title/description/image tetap terisi.
 * ------------------------------------------------------------------------- */
async function engineMetaProxy(pair, shortUrl) {
  const url = encodeURIComponent(shortUrl);
  const candidates = [
    { name: 'r.jina.ai', url: `https://r.jina.ai/${shortUrl}`, kind: 'jina' },
    { name: 'codetabs', url: `https://api.codetabs.com/v1/proxy?quest=${url}`, kind: 'html' },
  ];
  for (const c of candidates) {
    try {
      const r = await callWithRetry(pair, 'get', c.url, { timeout: 50000, headers: { 'user-agent': 'Mozilla/5.0' } }, 2);
      if (r.status !== 200 || !r.body) { vlog(`P2 ${c.name} => ${r.status}`); continue; }
      if (c.kind === 'html') {
        const m = extractMeta(r.body);
        if (m.title || m.description) return { source: c.name, meta: m };
      } else {
        // format markdown r.jina.ai:
        // "Title: ..." | "URL Source: ..." | "Markdown Content:\n..."
        const jt = (r.body.match(/^Title:\s*(.+)$/mi) || [])[1] || null;
        const firstP = (r.body.match(/Markdown Content:\s*\n+([^\n]{40,300})/) || [])[1] || null;
        const img = (r.body.match(/!\[.*?\]\((https?:\/\/[^)\s]+)\)/) || [])[1] || null;
        let title = jt ? jt.trim() : null;
        if (title && GARBAGE_META.test(title)) title = null;
        let desc = firstP ? firstP.trim() : null;
        if (desc && (GARBAGE_META.test(desc) || /^!\[/.test(desc))) desc = null;
        let image = img || null;
        if (image && /favicon/i.test(image)) image = null;
        if (title || desc) return { source: c.name, meta: { title, description: desc, image } };
      }
      vlog(`P2 ${c.name}: tidak menemukan meta`);
    } catch (e) {
      vlog(`P2 ${c.name} error: ${e.message.slice(0, 55)}`);
    }
  }
  return { source: null, meta: null };
}

/* ---------------------------------------------------------------------------
 * ENGINE D — Direct Chain (murni HTTP)
 *  1) POST /{code} action=captcha (csrf & _Token dari halaman; token kosong)
 *  2) bila lolos: 302/halaman interstitial berisi form #go-link
 *  3) tunggu counter_value (server "Too Early" -> auto-retry)
 *  4) POST go-link (mis. /links/go) dgn X-Requested-With: XMLHttpRequest
 *  Pada instance dengan Turnstile singgungan valid, tahap 1 ditolak dengan
 *  aman (dilaporkan captcha-required) — tidak crash, mesin berlanjut.
 * ------------------------------------------------------------------------- */
function extractCaptchaForm(html) {
  const $ = cheerio.load(html);
  let form = $('form#link-view');
  if (!form.length) form = $('form').first();
  if (!form.length) return null;
  const fields = {};
  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    if (/^(?:cf-turnstile-response|g-recaptcha-response|h-captcha-response|adcopy_challenge|adcopy_response)$/i.test(name)) return;
    fields[name] = $(el).attr('value') || '';
  });
  let captchaType = null;
  if (/turnstile/i.test(html)) captchaType = 'turnstile';
  else if (/g-recaptcha/i.test(html)) captchaType = 'recaptcha';
  else if (/h-captcha/i.test(html)) captchaType = 'hcaptcha';
  else if (/adcopy/i.test(html)) captchaType = 'solvemedia';
  return { action: form.attr('action') || '', fields, captchaType };
}

function extractGoForm(html) {
  const $ = cheerio.load(html);
  const go = $('form#go-link');
  if (!go.length) return null;
  const fields = {};
  go.find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (name) fields[name] = $(el).attr('value') || '';
  });
  return { action: go.attr('action') || '', fields };
}

function pageClassOf(html) { return (/<body class="([^"]+)/i.exec(html || '') || [])[1] || ''; }

async function engineDirect(pair, pageCtx, code) {
  try {
    const cf = extractCaptchaForm(pageCtx.html || '');
    if (!cf) return { ok: false, message: 'form langkah tidak ditemukan' };

    const postUrl = absolutize(pageCtx.finalUrl, cf.action) || pageCtx.finalUrl;
    const r = await callWithRetry(pair, 'post', postUrl, {
      form: {
        ...cf.fields,
        action: 'captcha',
        'cf-turnstile-response': '',
        'g-recaptcha-response': '',
        'h-captcha-response': '',
      },
      headers: { referer: pageCtx.finalUrl, origin: new URL(postUrl).origin },
    });

    let afterHtml = '';
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      const loc = r.headers.location;
      const next = /^https?:/i.test(loc) ? loc : new URL(loc, postUrl).href;
      const rr = await callWithRetry(pair, 'get', next);
      afterHtml = rr.body || '';
    } else {
      afterHtml = r.body || '';
    }
    if (pageClassOf(afterHtml).includes('captcha')) {
      return { ok: false, message: `server menuntut captcha ${cf.captchaType || ''} (response kosong tidak berhasil)` };
    }

    let goForm = extractGoForm(afterHtml);
    let interUrl = (r.status >= 300 && r.status < 400 && r.headers.location && /^https?:/i.test(r.headers.location))
      ? r.headers.location : pageCtx.finalUrl;
    if (!goForm) {
      const rl = await callWithRetry(pair, 'get', interUrl);
      if (rl.status !== 200) return { ok: false, message: `interstitial status ${rl.status}` };
      afterHtml = rl.body;
      goForm = extractGoForm(afterHtml);
    }
    if (!goForm) {
      const directDest = extractDestinationFromScripts(afterHtml);
      if (directDest) return { ok: true, destination: directDest, message: 'dest tersedia langsung di interstitial' };
      return { ok: false, message: 'interstitial tanpa go-link form' };
    }

    const vars = extractAppVars(afterHtml);
    const wait = Math.min(parseInt(vars.counter_value || '0', 10) || 0, 45);
    if (wait > 0) { vlog(`D menunggu counter ${wait}s`); await sleep(wait * 1000); }

    const goUrl = absolutize(interUrl, goForm.action) || interUrl;
    const rg = await callWithRetry(pair, 'post', goUrl, {
      form: { ...goForm.fields },
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        accept: 'application/json, text/javascript, */*; q=0.01',
        referer: interUrl,
        origin: new URL(goUrl).origin,
      },
    });

    const text = String(rg.body || '').trim();
    let j = null;
    try { j = JSON.parse(text); } catch (_) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { j = JSON.parse(m[0]); } catch (_) { j = null; } }
    }
    if (j) {
      const dest = (j.url || j.destination || (j.data && j.data.url)) || null;
      if (dest && /^https?:\/\//i.test(dest) && !/shrinkme/i.test(dest)) {
        return { ok: true, destination: dest, message: `go-post ${new URL(goUrl).pathname}` };
      }
      return { ok: false, message: `go-post ditolak: ${String(j.message || j.error || JSON.stringify(j)).slice(0, 110)}` };
    }
    const fallback = extractDestinationFromScripts(text);
    if (fallback) return { ok: true, destination: fallback, message: 'dest dari respon go-post' };
    return { ok: false, message: `go-post tidak terbaca (status ${rg.status})` };
  } catch (e) {
    return { ok: false, network: !!e.network, message: 'direct chain error: ' + e.message.slice(0, 80) };
  }
}

/* ---------------------------------------------------------------------------
 * ENGINE C — FastForward Crowd Query (publik, tanpa kredensial)
 *  200 text/plain = destination | 201 = ketemu tapi wajib verifikasi ulang
 *  204 = belum ada
 * ------------------------------------------------------------------------- */
async function engineCrowd(pair, code, shortDomain) {
  const doms = [];
  if (shortDomain) doms.push(shortDomain);
  for (const d of CONFIG.domainPool) if (!doms.includes(d)) doms.push(d);
  for (const d of doms) {
    try {
      const r = await callWithRetry(pair, 'post', CONFIG.crowdEndpoint, {
        form: { domain: d, path: code },
        headers: { accept: 'text/plain' },
        timeout: 20000,
      }, 3);
      if (r.status === 201) {
        vlog(`crowd ${d}/${code} => 201 (ada tapi wajib verifikasi ulang; disiklus lagi)`);
        continue;
      }
      if (r.status === 200 && r.body) {
        const t = r.body.trim();
        if (t && (/^https?:\/\//i.test(t) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(t.replace(/^\/+/, '')))) {
          return { found: true, domain: d, destination: normalizeUrl(t) };
        }
      }
      vlog(`crowd ${d}/${code} => ${r.status}`);
    } catch (e) {
      vlog(`crowd ${d}/${code} error: ${e.message.slice(0, 55)}`);
    }
    await sleep(150);
  }
  return { found: false };
}

function normalizeUrl(u) {
  u = String(u).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  return u;
}

/* ---------------------------------------------------------------------------
 * ENGINE B — BypassCity API komunitas (tanpa token)
 * ------------------------------------------------------------------------- */
async function engineBypassCity(pair, shortUrl) {
  for (const ep of CONFIG.bypassCityEndpoints) {
    try {
      const r = await callWithRetry(pair, 'post', ep, {
        json: { url: shortUrl },
        headers: { accept: 'application/json' },
        timeout: 45000,
      }, 2);
      const j = safeJson(r.body);
      if (r.status === 200 && j) {
        const dest = j.destination || j.url || (j.data && (j.data.destination || j.data.url));
        if (dest && /^https?:\/\//i.test(dest)) return { found: true, endpoint: ep, destination: normalizeUrl(dest) };
      }
      vlog(`bypasscity ${ep} => ${r.status} ${JSON.stringify(j || {}).slice(0, 90)}`);
    } catch (e) {
      vlog(`bypasscity ${ep} error: ${e.message.slice(0, 55)}`);
    }
  }
  return { found: false };
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/* ---------------------------------------------------------------------------
 * ENGINE E — Enrichment dari halaman destinasi (best-effort)
 * ------------------------------------------------------------------------- */
async function engineEnrich(pair, destUrl) {
  const out = { title: null, description: null, image: null };
  try {
    const r = await callWithRetry(pair, 'get', destUrl, { timeout: 20000 }, 2);
    if (r.status && r.body) {
      const m = extractMeta(r.body);
      out.title = m.title || out.title;
      out.description = m.description || out.description;
      out.image = m.image || out.image;
    }
  } catch (_) { /* enrichment opsional */ }
  return out;
}

/* ---------------------------------------------------------------------------
 * Rekaman & penulisan result.json
 * ------------------------------------------------------------------------- */
function buildRecord({ inputUrl, shortDomain, code, status, destination, destTitle, destDesc, destImg, error, resolvedAt, engineTrace, hint }) {
  const rec = {
    creator: CONFIG.creator,
    status: !!status,
    service: CONFIG.service,
    original_url: inputUrl,
    input_url: inputUrl,
    short_domain: shortDomain || CONFIG.canonicalDomain,
    short_code: code || null,
    destination_url: destination || null,
    destination_title: destTitle || null,
    destination_description: destDesc || null,
    destination_image: destImg || null,
    resolved_at: resolvedAt || resolvedAtWIB(),
    error: (typeof error === 'string' && error) ? error : null,
  };
  // Info status tambahan: jejak keputusan tiap engine (selection transparan)
  const trace = Array.isArray(engineTrace) ? engineTrace : null;
  if (trace) rec.engine_trace = trace;
  if (typeof hint === 'string' && hint && !rec.status) rec.hint = hint;
  return rec;
}

let GLOBAL_OUT = path.resolve(process.cwd(), CONFIG.resultFile);
let LAST_RECORD = null;
function writeResult(outPath, rec) {
  try {
    const abs = path.resolve(outPath || GLOBAL_OUT);
    GLOBAL_OUT = abs;
    LAST_RECORD = rec;
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
    fs.renameSync(tmp, abs);
    vlog(`result.json diperbarui -> ${abs}`);
  } catch (e) {
    log(`(peringatan) gagal menulis result.json: ${e.message}`);
  }
}

/* ---------------------------------------------------------------------------
 * ENGINE V — Search-Verify (tanpa loop, tanpa key, satu jalan)
 *  Bagaimana berlaku: og:title/dbg di halaman ShrinkMe = hasil scrape server
 *  AdLinkFly dari PAGE tujuan. Jadi kita mencari halaman social-preview yang
 *  berjudul PERSIS dengan og:title tsb dari indeks pencarian publik, lalu
 *  memverifikasi dengan mem-fetch kandidat dan membandingkan og:title-nya.
 *  Match eksak (normal) => destination terverifikasi tanpa crowd/operator.
 * ------------------------------------------------------------------------- */
const SEARCH_TOOL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEST_HOST_HINT = /mediafire|mega\.nz|drive\.google|1fichier|anonfiles|pixeldrain|solidfiles|zippyshare|workupload|krakenfiles|sendspace|gofile|terabox|hitfile|filefactory|shortcut-?link/i;
const FILE_EXT_TAIL = /\.(mp3|mp4|mkv|zip|rar|7z|pdf|exe|apk|iso|webm|ts|txt)(\?.*)?$/i;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function normTitle(s) {
  let t = decodeEntities(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  t = t.replace(FILE_EXT_TAIL, '');           // buang ekstensi file dulu (toleransi nama file)
  t = t.replace(/['",.:;!?()【】[\]]+/g, ''); // baru buang tanda baca
  return t;
}
function jinaUnwrapUrl(u) { return u; }
function unwrapProvider(href) {
  let h = href || '';
  if (/^\/url\?q=/i.test(h)) h = decodeURIComponent(h.slice('/url?q='.length).split('&')[0]);
  h = h.replace(/^\//, (m, s2) => (m ? m : m)); // noop
  return h;
}
function collectHrefs(html, provider) {
  const set = new Set();
  const reAll = /href=["']([^"']+)["']/g;
  let m;
  while ((m = reAll.exec(html || ''))) {
    let h = m[1];
    if (/^\/url\?q=/i.test(h)) h = decodeURIComponent(h.slice(7).split('&')[0]);
    if (!/^https?:\/\//i.test(h)) continue;
    if (/google\.|bing\.|duckduckgo|brave\.|searx|startpage|yandex|ecosia|w3\.org|gstatic|microsoft|cloudflare|jsdelivr/i.test(h)) continue;
    set.add(h);
  }
  return [...set];
}

async function engineSearchVerify(pair, ctx) {
  const meta = ctx.meta;
  if (!meta || !meta.title || meta.title.length < 4) {
    return { tried: false, reason: 'og:title tidak tersedia (halaman tujuan tidak tergap / fetch terblokir)' };
  }
  const DEFAULT_SEARCH_PROVIDERS = [
    { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20` },
    { name: 'brave', url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
    { name: 'searxbe', url: (q) => `https://searx.be/search?q=${encodeURIComponent(q)}` },
    { name: 'startpage', url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}` },
    { name: 'google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=20` },
  ];
  const providers = Array.isArray(CONFIG.searchProviders) && CONFIG.searchProviders.length
    ? CONFIG.searchProviders
    : DEFAULT_SEARCH_PROVIDERS;
  const queries = [`"${meta.title}"`, `"${meta.title}" mediafire`];
  const candidates = new Map();
  const providerLog = [];
  for (const p of providers) {
    let got = 0;
    for (const q of queries) {
      try {
        const r = await callWithRetry(pair, 'get', p.url(q), {
          headers: { 'user-agent': SEARCH_TOOL_UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
          timeout: 14000,
        }, 2);
        if (r.status !== 200 || !r.body) { providerLog.push(`${p.name}:${r.status}`); continue; }
        const hrefs = collectHrefs(r.body, p.name);
        for (const h of hrefs) {
          if (!DEST_HOST_HINT.test(h) && !/https?:\/\/(www\.)?mediafire\.com/i.test(h)) continue; // filter kandidat
          if (candidates.has(h)) continue;
          candidates.set(h, p.name);
          got++;
        }
        if (candidates.size >= 12) break;
      } catch (e) {
        providerLog.push(`${p.name}:err(${(e.message || '').slice(0, 24)})`);
      }
    }
    vlog(`V ${p.name}: kandidat=${got} total=${candidates.size}`);
    if (candidates.size >= 12) break;
  }
  if (!candidates.size) {
    return { tried: true, found: false, reason: `tidak ada kandidat di indeks pencarian (${providerLog.join(' ')})` };
  }
  // verifikasi kandidat: fetch halaman & bandingkan og:title persis
  const nTarget = normTitle(meta.title);
  let checked = 0;
  for (const [url, viaProvider] of candidates) {
    if (checked >= 8) break;
    checked++;
    try {
      const r = await callWithRetry(pair, 'get', url, {
        headers: { 'user-agent': SEARCH_TOOL_UA, accept: 'text/html' }, timeout: 10000,
      }, 2);
      if (r.status !== 200 || !r.body) continue;
      const cm = extractMeta(r.body);
      const titles = [cm.title, (/<title>([^<]*)<\/title>/i.exec(r.body) || [])[1]].filter(Boolean);
      for (const t of titles) {
        if (!GARBAGE_META.test(t) && normTitle(t) === nTarget) {
          return { tried: true, found: true, destination: url, via: viaProvider, how: 'og:title exact-match', candidateMeta: { title: cm.title, description: cm.description, image: cm.image } };
        }
      }
    } catch (_) { /* lanjut kandidat berikutnya */ }
  }
  return { tried: true, found: false, reason: `${checked}/${candidates.size} kandidat dicek, og:title tidak cocok` };
}

/* ---------------------------------------------------------------------------
 * SUPERVISOR — satu siklus = P → D → V → C → B (single-pass, tanpa loop)
 *  Hasil selalu disertai engine_trace (jejak keputusan tiap engine) supaya
 *  satu eksekusi sudah menjelaskan "kenapa sukses/kenapa belum".
 * ------------------------------------------------------------------------- */
async function attemptCycle(pair, ctx, inputUrl, opts = {}) {
  const reasons = [];
  const steps = [];
  const trace = [];
  const pushTrace = (engine, verdict, detail) => {
    trace.push({ engine, verdict, detail: String(detail || '').slice(0, 160) });
    vlog(`trace ${engine}: ${verdict} — ${trace[trace.length - 1].detail}`);
  };

  // ===== Engine P =====
  const p = await enginePage(pair, ctx.code);
  if (p.found === false) {
    reasons.push(p.error || 'halaman tidak terjangkau');
    pushTrace('P', 'skip', p.error || 'halaman tidak terjangkau');
    // Engine P2 — fallback metadata (proxy teks publik) supaya field
    // destination_title/description/image tetap terisi + V tetap bisa jalan
    steps.push('P2');
    const sp = await engineMetaProxy(pair, inputUrl);
    if (sp.meta) {
      ctx.meta = sp.meta;
      pushTrace('P2', 'meta', `${sp.source}: title=${(sp.meta.title || '').slice(0, 50)}`);
    } else {
      pushTrace('P2', 'skip', 'proxy publik tidak memuat metadata');
    }
  } else {
    ctx.meta = p.meta;
    vlog(`P ok: ${p.finalDomain} class=${p.pageClass} meta=${JSON.stringify(p.meta).slice(0, 80)}`);
    pushTrace('P', 'ok', `domain=${p.finalDomain} class=${p.pageClass || '-'} title=${(p.meta && p.meta.title || '').slice(0, 50)}`);
    const capLabel = p.captcha && p.captcha.enabled ? `${p.captcha.type}` : 'instansi non-captcha';
    if (p.captcha && p.captcha.enabled) vlog(`captcha aktif: ${capLabel} site-key=${p.captcha.turnstileKey}`);

    // ===== Engine D =====
    steps.push(p.captcha && p.captcha.enabled ? 'D*' : 'D');
    const d = await engineDirect(pair, p, ctx.code);
    if (d.ok) {
      pushTrace('D', 'ok', d.message || 'rantai langsung berhasil');
      return { status: true, destination: d.destination, source: `direct(${d.message})`, meta: p.meta, steps, trace };
    }
    pushTrace('D', 'skip', d.message || 'gagal lolos rantai');
    reasons.push('direct: ' + d.message);
  }

  // ===== Engine V (search-verify) — jalur resolusi verifikasi satu jalan =====
  if (opts.search === false) {
    pushTrace('V', 'off', 'dimatikan lewat --no-search / opts.search:false');
  } else if (ctx.meta && ctx.meta.title && String(ctx.meta.title).length >= 4) {
    steps.push('V');
    const v = await engineSearchVerify(pair, ctx);
    if (v.found) {
      pushTrace('V', 'ok', `${v.via}: ${v.how} → ${v.destination}`);
      const merged = { ...ctx.meta, ...(v.candidateMeta || {}) };
      return { status: true, destination: v.destination, source: `search-verify(${v.via})`, meta: merged, steps, trace };
    }
    pushTrace('V', 'skip', v.tried ? v.reason : (v.reason || 'og:title tidak tersedia'));
    reasons.push(`search-verify: ${v.reason}`);
  } else {
    pushTrace('V', 'off', 'og:title tidak tersedia, tidak ada query pencarian');
  }

  // ===== Engine C (crowd) =====
  steps.push('C');
  const c = await engineCrowd(pair, ctx.code, ctx.short_domain);
  if (c.found) {
    pushTrace('C', 'ok', `domain=${c.domain} destination=${c.destination}`);
    return { status: true, destination: c.destination, source: `crowd(${c.domain})`, meta: ctx.meta, steps, trace };
  }
  pushTrace('C', 'skip', 'belum terdaftar di crowd');
  reasons.push('crowd: link belum terdaftar');

  // ===== Engine B (bypass city) =====
  steps.push('B');
  const b = await engineBypassCity(pair, `https://${ctx.short_domain || CONFIG.canonicalDomain}/${ctx.code}`);
  if (b.found) {
    pushTrace('B', 'ok', `destination=${b.destination}`);
    return { status: true, destination: b.destination, source: 'bypasscity', meta: ctx.meta, steps, trace };
  }
  pushTrace('B', 'skip', 'gate/error');
  reasons.push('bypasscity: gate/error');

  return {
    status: false,
    error: reasons.join(' | '),
    steps,
    trace,
    meta: ctx.meta,
    hint: 'jalur tanpa loop tersisa: buka link ini sekali dengan ekstensi FastForward (mengisi crowd untuk semua orang) atau jalankan lagi saat link sudah terindeks; captcha Turnstile menuntut browser-sisi operator saat ini',
  };
}

/* ---------------------------------------------------------------------------
 * resolve — default SINGLE-SHOT: satu eksekusi penuh, lalu hasil + status
 * selalu dilaporkan (result.json + engine_trace + hint). Mode loop lama
 * hanya lewat opts.loop:true / --loop; tries tetap bisa dibatasi.
 * ------------------------------------------------------------------------- */
async function resolve(inputUrl, opts = {}) {
  const loop = opts.loop === true;
  const tries = loop
    ? (opts.tries === undefined ? Infinity : Math.max(1, Number(opts.tries)))
    : Math.max(1, opts.tries === undefined ? 1 : Number(opts.tries));
  const intervalMs = opts.intervalMs === undefined ? CONFIG.defaultIntervalMs : Number(opts.intervalMs);
  const outPath = opts.out === undefined ? GLOBAL_OUT : opts.out;
  if (outPath) GLOBAL_OUT = path.resolve(outPath);
  const t0 = Date.now();

  const parsed = parseInput(inputUrl);
  if (!parsed.ok) {
    const rec = buildRecord({ inputUrl, status: false, error: parsed.error, code: null, shortDomain: null, engineTrace: [] });
    writeResult(outPath, rec);
    if (opts.quiet !== true) log(`✗ GAGAL ${(Date.now() - t0) / 1000 < 0.1 ? '<0.1' : ((Date.now() - t0) / 1000).toFixed(1)}s — ${parsed.error}`);
    return rec;
  }

  const ctx = { code: parsed.code, short_domain: parsed.short_domain, meta: null };
  if (opts.quiet !== true) {
    log(`shrinkme-resolver | creator=${CONFIG.creator} | kode=${ctx.code} | domain=${ctx.short_domain}`);
    log(`engine=P→D→V→C→B | mode=${loop ? `loop (maks ${tries === Infinity ? '∞' : tries} siklus)` : 'single-shot (1 eksekusi)'} | interval=${intervalMs}ms`);
  }

  let attempt = 0;
  let lastError = 'belum dijalankan';
  let lastMeta = null;
  let lastTrace = [];
  let lastHint = null;

  while (attempt < tries) {
    attempt++;
    if (opts.quiet !== true) log(`→ siklus #${attempt}`);

    const pair = mkJarClient(new CookieJar());
    try {
      const run = await attemptCycle(pair, ctx, inputUrl, { search: opts.search });
      lastMeta = run.meta || lastMeta;
      lastError = run.error || lastError;
      lastTrace = run.trace || lastTrace;
      lastHint = run.hint || lastHint;

      if (run.status) {
        let enrich = { title: null, description: null, image: null };
        try { enrich = await engineEnrich(pair, run.destination); } catch (_) {}
        const rec = buildRecord({
          inputUrl, shortDomain: ctx.short_domain, code: ctx.code, status: true,
          destination: run.destination,
          destTitle: (ctx.meta && ctx.meta.title) || enrich.title,
          destDesc: (ctx.meta && ctx.meta.description) || enrich.description,
          destImg: (ctx.meta && ctx.meta.image) || enrich.image,
          error: null,
          engineTrace: run.trace,
        });
        writeResult(outPath, rec);
        if (opts.quiet !== true) {
          log(`✓ SUKSES dalam ${((Date.now() - t0) / 1000).toFixed(1)}s → ${run.destination}`);
          log(`  sumber: ${run.source} | langkah: ${run.steps.join('→')}`);
        }
        return rec;
      }

      if (opts.quiet !== true) log(`… belum sukses: ${run.error}`);
      lastHint = run.hint || lastHint;
      writeResult(outPath, buildRecord({
        inputUrl, shortDomain: ctx.short_domain, code: ctx.code, status: false,
        destTitle: ctx.meta && ctx.meta.title, destDesc: ctx.meta && ctx.meta.description,
        destImg: ctx.meta && ctx.meta.image, error: run.error,
        engineTrace: run.trace, hint: run.hint,
      }));
    } catch (e) {
      lastError = `siklus error: ${e.message}`;
      if (opts.quiet !== true) log(`! ${lastError}`);
      writeResult(outPath, buildRecord({
        inputUrl, shortDomain: ctx.short_domain, code: ctx.code, status: false,
        destTitle: lastMeta && lastMeta.title, destDesc: lastMeta && lastMeta.description,
        destImg: lastMeta && lastMeta.image, error: lastError,
        engineTrace: lastTrace, hint: lastHint,
      }));
    }

    if (attempt < tries) {
      const jitter = intervalMs * (0.8 + 0.4 * Math.random());
      if (opts.quiet !== true) log(`⏳ jeda ${Math.round(jitter / 1000)}s`);
      await sleep(jitter);
    }
  }

  const rec = buildRecord({
    inputUrl, shortDomain: ctx.short_domain, code: ctx.code, status: false,
    destTitle: lastMeta && lastMeta.title, destDesc: lastMeta && lastMeta.description,
    destImg: lastMeta && lastMeta.image,
    error: lastError || `gagal setelah ${attempt} siklus`,
    engineTrace: lastTrace, hint: lastHint || (loop ? 'loop berakhir tanpa sukses — coba lagi nanti atau isi crowd via FastForward' : null),
  });
  writeResult(outPath, rec);
  if (opts.quiet !== true) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log(`✗ GAGAL dalam ${dt}s — ${rec.error}`);
    if (rec.hint) log(`  hint: ${rec.hint}`);
    if (lastTrace && lastTrace.length) log(`  status mesin: ${lastTrace.map((t) => `${t.engine}:${t.verdict}`).join(' | ')}`);
  }
  return rec;
}

async function resolveOnce(inputUrl, opts = {}) {
  return resolve(inputUrl, { ...opts, tries: 1 });
}

/* ---------------------------------------------------------------------------
 * SELFTEST — server mock AdLinkFly lokal (mode --selftest)
 * Menguji seluruh pipeline resolve(end-to-end): engine P -> D -> buildRecord
 * -> result.json, TANPA perlu jaringan publik. Ini integration test resmi,
 * bukan data pabrikan — destinasi mock jelas ditandai sebagai local fixture.
 * ------------------------------------------------------------------------- */
function startMockAdlinkflyServer(port) {
  const http = require('http');
  const DEST = 'https://example.org/final/fixture-file.zip';
  const CODE = 'TESTCODE';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const passCaptcha = (req.headers.cookie || '').includes('mgrp=1');
    const htmlCaptcha = `<!DOCTYPE html><html><body class="captcha-page">
<form method="post" id="link-view" action="/${CODE}">
<input type="hidden" name="_csrfToken" value="MOCK-TOKEN-1"/>
<input type="hidden" name="action" value="captcha"/>
<input type="hidden" name="f_n" value="slc"/>
<input type="hidden" name="_Token[fields]" value="mock"/>
<input type="hidden" name="_Token[unlocked]" value="mock"/>
<p>Verify captcha</p><button id="invisibleCaptchaShortlink"></button></form>
<meta name="og:title" content="Mock Destination"/>
<script>var app_vars = {"enable_captcha":"yes","captcha_type":"turnstile","counter_value":1,"base_url":"http://127.0.0.1:${port}/"};</script>
</body></html>`;
    const htmlInterstitial = `<!DOCTYPE html><html><body class="interstitial-page">
<form id="go-link" method="post" action="/links/go"><input type="hidden" name="_token" value="MOCKGO"/><input type="hidden" name="link" value="${CODE}"/></form>
<meta name="og:title" content="Mock Destination"/>
<script>var app_vars = {"enable_captcha":"no","counter_value":1,"base_url":"http://127.0.0.1:${port}/"};</script>
</body></html>`;
    if (req.method === 'GET' && u.pathname === `/${CODE}`) {
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': passCaptcha ? 'mgrp=1' : 'mgrp=0',
      });
      res.end(passCaptcha ? htmlInterstitial : htmlCaptcha);
      return;
    }
    if (req.method === 'POST' && u.pathname === `/${CODE}`) {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => {
        res.writeHead(302, { location: `/${CODE}`, 'set-cookie': 'mgrp=1' });
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/links/go') {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => {
        if (!d.includes('MOCKGO')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Too Early' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', url: DEST }));
      });
      return;
    }
    res.writeHead(404); res.end('mock 404');
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

async function selftest() {
  const port = 34999;
  const origPool = CONFIG.domainPool.slice();
  const origCanonical = CONFIG.canonicalDomain;
  const origInterval = CONFIG.defaultIntervalMs;
  CONFIG.domainPool = [`http://127.0.0.1:${port}`];
  CONFIG.canonicalDomain = '127.0.0.1';
  CONFIG.defaultIntervalMs = 200;
  log(`SELFTEST: mock AdLinkFly di http://127.0.0.1:${port} …`);
  const server = await startMockAdlinkflyServer(port);
  let pass = false;
  try {
    const rec = await resolve(`http://127.0.0.1:${port}/${'TESTCODE'}`, {
      tries: 3, intervalMs: 300, quiet: true, search: false, out: path.resolve('selftest-result.json'),
    });
    pass = rec.status === true && rec.destination_url === 'https://example.org/final/fixture-file.zip' &&
      rec.destination_title === 'Mock Destination';
    log(`SELFTEST ${pass ? 'PASS ✓' : 'FAIL ✗'} — record:`);
    process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
    try { fs.unlinkSync(path.resolve('selftest-result.json')); } catch (_) {}
  } catch (e) {
    log(`SELFTEST FAIL ✗ (${e.message})`);
  } finally {
    server.close();
    CONFIG.domainPool = origPool;
    CONFIG.canonicalDomain = origCanonical;
    CONFIG.defaultIntervalMs = origInterval;
  }
  return pass;
}

/* ---------------------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------------------- */
function flagInt(name, dflt) {
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith(name)) continue;
    const inline = a.slice(name.length).trim().replace(/^=/, '');
    if (inline && /^\d+$/.test(inline)) return parseInt(inline, 10);
    const nxt = process.argv[i + 1];
    if (nxt && /^\d+$/.test(nxt)) return parseInt(nxt, 10);
  }
  return dflt;
}
function flagVal(name, dflt) {
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === name && process.argv[i + 1]) return process.argv[i + 1];
    if (a.startsWith(name + '=')) return a.slice(name.length + 1);
  }
  return dflt;
}

if (require.main === module) {
  const url = process.argv.find((a) => /^https?:\/\//i.test(a) || /^(shrinkme|www)\./i.test(a));
  const selftestMode = process.argv.includes('--selftest');

  if (selftestMode) {
    selftest().then((pass) => process.exit(pass ? 0 : 4));
    return;
  }

  if (process.argv.includes('--help') || !url) {
    console.log([
      'ShrinkMe Bypass Resolver (creator: Razeerh)',
      '',
      'Penggunaan:',
      '  node scrape-bypass-shrinkme.js "<url shortlink shrinkme>" [opsi]',
      '',
      'Default = SINGLE-SHOT: satu eksekusi penuh, langsung laporkan hasil +',
      'status (engine_trace di result.json). TIDAK ada retry panjang.',
      '',
      'Opsi:',
      '  --selftest       uji end-to-end seluruh engine via mock server lokal',
      '  --loop           AKTIFKAN mode loop lama (ulang sampai sukses)',
      '  --tries N        batas siklus (default 1; dengan --loop default ∞)',
      '  --once           satu siklus saja (sama dengan default)',
      '  --interval SEC   jeda antar siklus loop (default 8 detik)',
      '  --no-search      matikan Engine V (search-verify)',
      '  --out PATH       path result.json (default ./result.json)',
      '  --verbose        log detail semua engine',
      '',
      'Exit 0 = sukses; 3 = belum sukses (status di result.json); 4 = selftest gagal.',
    ].join('\n'));
    process.exit(2);
  }

  const loop = process.argv.includes('--loop');
  const once = process.argv.includes('--once');
  const tries = once ? 1 : flagInt('--tries', loop ? Infinity : 1);
  const intervalSec = flagInt('--interval', Math.round(CONFIG.defaultIntervalMs / 1000));
  const search = !process.argv.includes('--no-search');
  const out = flagVal('--out', CONFIG.resultFile);

  process.on('SIGINT', () => {
    log('SIGINT diterima — result.json terakhir sudah tersimpan; keluar.');
    process.exit(130);
  });

  resolve(url, { loop, tries, search, intervalMs: intervalSec > 0 ? intervalSec * 1000 : undefined, out })
    .then((rec) => process.exit(rec.status ? 0 : 3))
    .catch((e) => {
      log(`FATAL: ${e.message}`);
      process.exit(1);
    });
}

/* ---------------------------------------------------------------------------
 * Exports — integrasi mudah ke project apapun
 * ------------------------------------------------------------------------- */
module.exports = {
  resolve,
  resolveOnce,
  attemptCycle,
  parseInput,
  extractMeta,
  extractAppVars,
  extractDestinationFromScripts,
  resolvedAtWIB,
  buildRecord,
  normTitle,
  collectHrefs,
  searchVerify: engineSearchVerify,
  config: CONFIG,
  engines: {
    page: enginePage,
    metaProxy: engineMetaProxy,
    direct: engineDirect,
    searchVerify: engineSearchVerify,
    crowd: engineCrowd,
    bypassCity: engineBypassCity,
    enrich: engineEnrich,
  },
};
