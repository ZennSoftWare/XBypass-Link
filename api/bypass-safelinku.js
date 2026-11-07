#!/usr/bin/env node
/**
 * =====================================================================
 *  scrape-bypassfl.js
 *  ---------------------------------------------------------------------
 *  Scraper / resolver shortlink SafelinkU (domain target: sfl.gl).
 *
 * cara kerja (diadaptasi dari reverse-engineering engine live):
 *   1) GET https://sfl.gl/{alias}  -> halaman "Wait..." berisi form GET
 *      otomatis ke https://app.khaddavi.net/redirect.php (ray_id + alias)
 *   2) GET redirect.php            -> 302 ke halaman artikel (monetisasi)
 *                                      + cookie __session
 *   3) GET /artikel/               -> cookie XSRF-TOKEN, SESSION, tt
 *      + konfigurasi inline `ads` + widget #verify + engine /c/assets/*.js
 *   4) POST /api/session {_token}  -> {step, captcha?, passcode?}
 *      (_token = XSRF-TOKEN yang bagian akhirnya diganti fingerprint
 *       hash SHA-256, mempersatukan perilaku engine di browser)
 *   5) step 1  : POST /api/verify {_a:0}  -> {target}  ( -> tahap-2 )
 *      step 2+ : POST /api/go {key,size,ado} -> {url} = sfl.gl/ready/go
 *   6) GET sfl.gl/ready/go...  -> script handler klik tombol berisi
 *      URL tujuan ASLI -> diekstrak lalu masuk `final_url`.
 *
 *  Semua tahap dilakukan via pure-HTTP (Axios + Cheerio).
 *  TIDAK memakai Puppeteer/Playwright/Selenium/WebDriver.
 *  Cookie diambil otomatis dari Set-Cookie (cookie-jar internal),
 *  pengguna TIDAK perlu menyiapkan cookie/token secara manual.
 *
 *  creator : Razeerh
 *  CLI     : node scrape-bypassfl.js "https://sfl.gl/xsKnvCpg" [--out result.json] [--tries N] [--verbose]
 *  Module  : const { scrapeSafelink } = require('./scrape-bypassfl');
 *            await scrapeSafelink('https://sfl.gl/xsKnvCpg', { tries: 3 });
 *  Output  : JSON + file result.json (selalu ditulis setiap percobaan).
 * ===================================================================== */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');
const cheerio = require('cheerio');

/* ==================================================================== */
/* Konstanta data yang diminta                                          */
/* ==================================================================== */

const AUTHOR = 'Razeerh'; // creator scrape
const KHADDAVI_HOSTS = ['khaddavi.net'];

const UA_LIST = [
  'Mozilla/5.0 (Linux; Android 10; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const DEFAULTS = {
  tries: Number.POSITIVE_INFINITY, // SELALU mencari cara sampai sukses (lihat CATATAN)
  backoffMs: 1500, // jeda antar percobaan (tumbuh bertahap)
  backoffMaxMs: 12000,
  timeout: 25000, // timeout per-request (ms)
  maxSteps: 12, // batas bijak hop halaman HTML per percobaan
  ua: null, // user agent custom (opsional)
  desktop: false, // pakai UA desktop
  verbose: process.env.SFL_DEBUG === '1',
  out: 'result.json', // --out
  writeFile: true,
};

/* ==================================================================== */
/* Util                                                                 */
/* ==================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function uniqPush(arr, seen, u) {
  try {
    const s = String(u);
    if (!seen.has(s)) {
      seen.add(s);
      arr.push(s);
    }
  } catch (_) { /* abaikan url tak valid */ }
}

function normalizeInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('URL kosong.');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  const u = new URL(s);
  u.hash = ''; // #fragment tidak dipakai
  return u;
}

function pickUA(opts) {
  if (opts.ua) return opts.ua;
  const mobileList = UA_LIST.slice(0, 4);
  const list = opts.desktop ? UA_LIST.slice(4) : mobileList;
  return list[rnd(0, list.length - 1)];
}

/* ==================================================================== */
/* Cookie jar mini (nama cookies diambil LANGSUNG dari Set-Cookie)       */
/* ==================================================================== */

class CookieJar {
  constructor() {
    /** @type {Map<string, Map<string,string>>} host -> name -> value */
    this.hosts = new Map();
  }

  store(host, setCookieList) {
    if (!host || !setCookieList) return;
    const list = Array.isArray(setCookieList) ? setCookieList : String(setCookieList).split('\n');
    const bucket = this.hosts.get(host) || new Map();
    this.hosts.set(host, bucket);
    for (const line of list) {
      const first = String(line).split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      let value = first.slice(eq + 1).trim();
      const deleted = /max-age\s*=\s*0|expires=Thu,\s*01 Jan 1970/i.test(String(line));
      if (deleted || value === '') bucket.delete(name);
      else {
        try {
          bucket.set(name, decodeURIComponent(value) === value ? value : value);
        } catch (_) {
          bucket.set(name, value);
        }
      }
    }
  }

  /** subdomain-aware: app.khaddavi.net memakai cookie host = app.khaddavi.net */
  cookieHeader(host) {
    const out = [];
    for (const [h, bucket] of this.hosts) {
      const related = host === h || host.endsWith('.' + h) || h.endsWith('.' + host);
      if (!related) continue;
      for (const [name, value] of bucket) out.push(`${name}=${value}`);
    }
    return out.join('; ');
  }

  peek(host, name) {
    const direct = this.hosts.get(host);
    if (direct && direct.has(name)) return direct.get(name);
    for (const [h, bucket] of this.hosts) {
      if (h.endsWith(host) && bucket.has(name)) return bucket.get(name);
    }
    return null;
  }
}

/* ==================================================================== */
/* Token session engine khaddavi (persis seperti engine di browser)     */
/* ==================================================================== */

/**
 * `/api/session` memakai `_token` = value cookie XSRF-TOKEN (128 char)
 * yang karakter ekornya diganti: '#' + base64(sha256hex(fingerprain)).
 * Disalin 1:1 dari engine `app.khaddavi.net/c/assets/*.js`.
 */
function buildKhaddaviToken(xsrfRaw) {
  const fpRaw = [
    'webgl:ANGLE (Adreno (TM) 640, Qualcomm Snapdragon, OpenGL ES)|Qualcomm|28|28',
    'audio:0.000000000000',
    'canvas:unavailable',
    'fonts:API unavailable',
    'system:unavailable',
    'env:unavailable',
    'network:unavailable',
  ].join('||');
  const fp = crypto.createHash('sha256').update(fpRaw).digest('hex');
  const suffix = '#' + Buffer.from(fp, 'utf8').toString('base64'); // ~89 char
  const src = String(xsrfRaw || 'A');
  let out = '';
  if (src.length + suffix.length >= 128) out = src.slice(0, 128 - suffix.length) + suffix;
  else out = (src + suffix).padEnd(128, 'A');
  return out.slice(0, 128);
}

/* ==================================================================== */
/* Pelengkap konteks percobaan                                          */
/* ==================================================================== */

function makeAttemptCtx(opts, chain, seen) {
  const jar = new CookieJar();
  const base = axios.create();
  const ua = pickUA(opts);

  const log = (...a) => {
    if (opts.verbose) process.stderr.write('[bypzfl] ' + a.join(' ') + '\n');
  };

  /** request inti dengan cookie otomatis + rekam redirect manual */
  const http = async function http(url, config = {}) {
    const method = (config.method || 'GET').toUpperCase();
    const u = new URL(url);
    const cookie = jar.cookieHeader(u.host);
    const headers = {
      'User-Agent': ua,
      'Accept': method === 'POST'
        ? 'application/json, text/plain, */*'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(config.headers || {}),
    };
    if (method === 'POST' && config.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const t0 = Date.now();
    const resp = await base.request({
      method,
      url: u.toString(),
      headers,
      data: config.body,
      timeout: config.timeout || opts.timeout,
      validateStatus: () => true, // tangani semua status manual
      maxRedirects: 0, // rekam redirect manual supaya masuk chain
      decompress: true,
    });

    const setCookie = resp.headers['set-cookie'];
    if (setCookie) jar.store(u.host, setCookie);

    log(`${method} ${u.host}${u.pathname}${u.search.slice(0, 42)} -> ${resp.status} (${Date.now() - t0}ms)`);
    return resp;
  };

  /**
   * GET + ikut 3xx satu-satu (memasukkan setiap location ke chain).
   * Nomor hop dibatasi supaya gagal jika terjadi redirect tak hingga.
   */
  const getFollow = async function getFollow(url, { opts: _o, referer, maxHops = 10 } = {}) {
    let cur = new URL(url).toString();
    for (let i = 0; i <= maxHops; i++) {
      const resp = await http(cur, { headers: referer ? { Referer: referer } : {} });
      const loc = resp.headers && resp.headers.location;
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const abs = new URL(loc, cur).toString();
        uniqPush(chain, seen, abs);
        referer = cur;
        cur = abs;
        continue;
      }
      return { url: cur, status: resp.status, headers: resp.headers, body: String(resp.data || '') };
    }
    throw makeErr('transient-error', `Terlalu banyak redirect berantai: ${cur}`);
  };

  return { jar, http, getFollow, ua, log };
}

/* ==================================================================== */
/* Error klasifikasi                                                    */
/* ==================================================================== */

function makeErr(kind, message, extra) {
  const e = new Error(message);
  e.kind = kind; // 'not-found' | 'need-passcode' | 'need-turnstile' | 'http-block' | 'engine-error' | 'transient-error' | 'network-error'
  e.extra = extra;
  return e;
}

const isHardError = (e) =>
  ['not-found', 'need-passcode', 'need-turnstile'].includes(e && e.kind);

/* ==================================================================== */
/* Parsing halaman                                                      */
/* ==================================================================== */

/** Kumpulkan semua URL iklan dari config `const ads = {...}` di inline script */
function collectAdUrls(html) {
  const ads = new Set();
  const patterns = [
    /const\s+ads\s*=\s*(\{[\s\S]*?\});/,
    /var\s+ads\s*=\s*(\{[\s\S]*?\});/,
  ];
  let raw = null;
  for (const p of patterns) {
    const m = p.exec(html);
    if (m) { raw = m[1]; break; }
  }
  if (raw) {
    try {
      const obj = JSON.parse(raw.replace(/\\'/g, '"'));
      const walk = (v) => {
        if (typeof v === 'string') { if (/^https?:\/\//i.test(v) || v.startsWith('//')) ads.add(v.startsWith('//') ? 'https:' + v : v); }
        else if (v && typeof v === 'object') for (const k of Object.values(v)) walk(k);
      };
      walk(obj);
    } catch (_) { /* config ads terlalu kasar -> abaikan */ }
  }
  // pembScreen jaringan iklan umum seandai config gagal diparse
  const adNet = [
    'assessschisma', 'pawawaugend', 'tolaneration', 'propellerads', 'doubleclick',
    'googlesyndication', 'googleadservices', 'adsterra', 'monetag', 'smowzone',
    'onadsupport', 'palsenatir', 'revenuecpmgate', 'clickadu', 'cointelegra',
    'complicated-storm', 'sowve.com', 'webteasor', 'onclckpro',
  ];
  html.replace(/[a-zA-Z0-9.-]+\.(?:com|net|qpon|vip|io|xyz|club|site|space|info|pro|biz|online|link|icu)\S{0,60}/gi, (d) => {
    const host = d.toLowerCase();
    if (adNet.some((n) => host.includes(n))) ads.add('https://' + host);
    return d;
  });
  return ads;
}

/**
 * Ekstraksi URL tujuan dari halaman "ready"/"almost ready".
 * Prioritas:
 *   1) inline script GetElementById(…).addEventListener('click', …
 *      window.location.href = "URL")
 *   2) script/cari pola location.href / location.replace / document.location
 *   3) <meta http-equiv="refresh" content="N; url=...">
 * URL iklan (ada di config `ads`) dibuang supaya tidak salah tangkap.
 * @returns {{url:string, how:string}|null}
 */
function extractFinalUrl(html, adUrls) {
  const $ = cheerio.load(html);
  const candidates = [];
  const push = (u, how) => {
    if (!u) return;
    let s = String(u).trim().replace(/\\\//g, '/').replace(/\\/g, '');
    if (!s) return;
    if (s.startsWith('//')) s = 'https:' + s;
    if (!/^https?:\/\//i.test(s)) return;
    if (s.toLowerCase().includes('googletagmanager') || s.toLowerCase().includes('gtm.js')) return;
    const hostL = (new URL(s)).hostname.toLowerCase();
    const bad = [...adUrls].some((a) => {
      try { return new URL(a).hostname.toLowerCase() === hostL; } catch (_) { return false; }
    });
    if (bad) return;
    candidates.push([s, how]);
  };

  // 1) blok inline script dari bawah ke atas (script handler final biasanya paling akhir)
  const inlineScripts = [];
  $('script').each((_, el) => {
    if (!$(el).attr('src')) inlineScripts.push($(el).html() || '');
  });
  for (let i = inlineScripts.length - 1; i >= 0; i--) {
    const sc = inlineScripts[i];
    if (!sc) continue;
    const hasClickHandler = sc.includes('addEventListener') && sc.includes('getElementById(');
    const assignUrl = sc.match(/(?:window\.location\.href|location\.href)\s*=\s*["']([^"']+)["']/i)
      || sc.match(/location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']/i)
      || sc.match(/document\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    if (hasClickHandler && assignUrl) {
      push(assignUrl[1], 'klik_tombol');
      break; // handler paling akhir adalah tujuan ASLI
    }
  }

  // 2) pasangan hidden form / penciptaan link JS biasa
  for (const single of inlineScripts) {
    const m = single.match(/(?:window\.|document\.)?location\.href\s*=\s*["']([^"']+)["']/i)
      || single.match(/location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']/i)
      || single.match(/window\.open\s*\(\s*["']([^"']+)["']/i);
    if (m) push(m[1], 'javascript');
  }

  // 3) meta refresh
  const refresh = $('meta[http-equiv="refresh"]').attr('content') || $('meta[http-equiv="Refresh"]').attr('content');
  if (refresh) {
    const m = /(?:url=)([^;]+)/i.exec(refresh);
    if (m) push(m[1].trim(), 'meta-refresh');
  }

  // 4) href di <a> tersorak dengan style tombol OPEN LINK
  if (!candidates.length) {
    const a = $('a[href^="http"]')
      .filter((_, el) => !(( ($(el).attr('href') || '').toLowerCase().includes('contact-us') )))
      .filter((_, el) => !(( ($(el).attr('href') || '').toLowerCase().includes('/abuse') )));
    a.each((_, el) => push($(el).attr('href'), 'anchor'));
  }

  if (candidates.length) {
    const [url, how] = candidates[0];
    return { url, how };
  }
  return null;
}

/** form auto-submit (halaman Wait '/artikel' awal) */
function parseFormAutoSubmit(html) {
  const $ = cheerio.load(html);
  const form = $('form').first();
  if (!form || !form.length || !form.attr('action')) return null;
  const method = (form.attr('method') || 'GET').toUpperCase();
  const params = new URLSearchParams();
  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    const type = ($(el).attr('type') || '').toLowerCase();
    if (type === 'file' || type === 'submit') return;
    params.set(name, $(el).attr('value') || '');
  });
  form.find('textarea').each((_, el) => {
    const name = $(el).attr('name');
    if (name) params.set(name, $(el).text() || '');
  });
  form.find('select').each((_, el) => {
    const name = $(el).attr('name');
    const sel = $(el).find('option[selected]').attr('value') || $(el).find('option').first().attr('value') || '';
    if (name) params.set(name, sel || '');
  });
  return { action: form.attr('action'), method, params };
}

function isKhaddavi(action) {
  try { return KHADDAVI_HOSTS.some((h) => new URL(action).hostname.endsWith(h)); }
  catch (_) { return false; }
}

/* ==================================================================== */
/* Resolver utama, satu percobaan lengkap                               */
/* ==================================================================== */

/**
 * @param {string} inputAbs - URL yang sudah dinormalisasi
 */
async function resolveOnce(inputUrl, opts, chain, seen) {
  const ctx = makeAttemptCtx(opts, chain, seen);
  uniqPush(chain, seen, inputUrl.toString());

  // ---- Tahap 0: halaman sfl.gl/{alias} (atau URL input apapun) --------
  let resp = await ctx.getFollow(inputUrl.toString());
  if (resp.status === 404) throw makeErr('not-found', 'Shortlink tidak ditemukan (404). Alias salah atau sudah dihapus.');
  if (resp.status === 403 || resp.status === 503) {
    throw makeErr('http-block', `Akses halaman sumber ditolak (${resp.status}). Mungkin rate-limit Cloudflare.`, resp.status);
  }
  if (resp.status !== 200) throw makeErr('transient-error', `Status tidak terduga (${resp.status}) saat membuka sumber.`);

  let html = resp.body;
  let pageUrl = resp.url;

  // Kenali engine bila form auto-submit ditemukan (khaddavi) / kalau tidak: generic solver
  for (let step = 0; step < opts.maxSteps; step++) {
    const form = parseFormAutoSubmit(html);
    // — alur KHADDAVI (safelinku/sfl.gl) —
    if (form && form.method === 'GET' && isKhaddavi(form.action)) {
      return await resolveKhaddavi(ctx, opts, chain, seen, form, pageUrl);
    }
    // — halaman final? —
    const adUrls = collectAdUrls(html);
    const final = extractFinalUrl(html, adUrls);
    if (final) {
      uniqPush(chain, seen, final.url);
      return { finalUrl: final.url, flow: form ? 'html-form' : 'redirect' };
    }
    // — generic: ikut form auto-submit apa pun yang ada —
    if (form && form.method === 'GET') {
      const nextUrl = form.action + (form.params.toString() ? '?' + form.params.toString() : '') ;
      uniqPush(chain, seen, nextUrl);
      resp = await ctx.getFollow(nextUrl, { referer: pageUrl });
      if (resp.status === 404) throw makeErr('not-found', 'Halaman target tidak ditemukan (404) saat follow form.');
      html = resp.body;
      pageUrl = resp.url;
      continue;
    }
    // — tanpa form & bukan final: cek meta refresh / handler langsung —
    const lateFinal = extractFinalUrl(html, collectAdUrls(html));
    if (lateFinal) {
      uniqPush(chain, seen, lateFinal.url);
      return { finalUrl: lateFinal.url, flow: 'javascript' };
    }
    throw makeErr('engine-error', 'Tidak menemukan mekanisme perpindahan (bukan form auto-submit, bukan URL final).');
  }
  throw makeErr('transient-error', `Melebihi batas owe ${opts.maxSteps} langkah halaman.`);
}

/* ==================================================================== */
/* Alur KHADDAVI engine (app.khaddavi.net)                              */
/* ==================================================================== */

async function khaddaviPage(ctx, chain, seen, url, referer) {
  const out = await ctx.getFollow(url, { referer });
  if (out.status === 403 || out.status === 503) {
    throw makeErr('http-block', `Halaman engine menolak (${ou