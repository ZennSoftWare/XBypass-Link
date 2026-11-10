#!/usr/bin/env node
/* ============================================================
 * scrape-bypass-sub2unlock-me.js
 * ============================================================
 * Engine bypass/scrape untuk layanan URL Locker sub2unlock.me
 * (SubflyV2 / AdLinkFly-derivative, CakePHP backend)
 *
 * Alur engine (murni HTTP, TANPA headless browser):
 *   1) GET  https://sub2unlock.me/{shortcode}
 *        -> session cookie (AppSession, csrfToken) + daftar task (.step.linky)
 *   2) POST https://sub2unlock.me/{shortcode}   (form #link-view: _csrfToken|ref|f_n=slc)
 *        -> halaman bridging berisi form #go-link + ad_form_data
 *   3) POST https://sub2unlock.me/links/go      (ad_form_data + csrf)
 *        -> JSON {"status":"success","url":"<destination>"}  <= LINK TUJUAN
 *
 * Output: JSON harus sama dengan schema diminta + selalu menulis result.json
 *
 * CLI   : node scrape-bypass-sub2unlock-me.js "https://sub2unlock.me/WdQGzgg" [--retries N|--infinite] [--out file] [--no-chain] [--quiet]
 * Modul : const { scrapeSub2Unlock } = require('./scrape-bypass-sub2unlock-me.js');
 *
 * Ringan & portable: Axios + Cheerio saja. Aman untuk Termux/Acode.
 * ============================================================ */
'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

/* ---------------- konstanta engine ---------------- */
const CREATOR = 'Razeerh';
const SOURCE_DOMAIN = 'sub2unlock.me';
const BASE_URL = 'https://sub2unlock.me';

const UAS = [
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
];

/* ---------------- util ---------------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pad(n) { return (n < 10 ? '0' : '') + n; }

/** tanggal LOKAL format YYYY-MM-DD (bukan UTC) */
function nowISO(d) {
  try {
    var dt = d instanceof Date ? new Date(d.getTime()) : new Date();
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  } catch (e) {
    return '';
  }
}

/** timestamp lokal informatif + offset UTC */
function nowFullISO() {
  try {
    var d = new Date();
    var tz = -d.getTimezoneOffset();
    var sign = tz >= 0 ? '+' : '-';
    var tzh = pad(Math.floor(Math.abs(tz) / 60));
    var tzm = pad(Math.abs(tz) % 60);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      + sign + tzh + ':' + tzm;
  } catch (e) { return ''; }
}

/** delay backoff eksponensial dengan jitter (cap 8s) */
function backoffDelay(attempt, capMs) {
  var base = Math.min(1000 * Math.pow(2, Math.max(0, attempt - 1)), capMs || 8000);
  var jitter = Math.floor(Math.random() * 300);
  return base + jitter;
}

/** Cookie jar manual ringan - tidak butuh lib tambahan */
function makeCookieJar() {
  var list = []; // {name, value}
  function setCookie(raw) {
    var parts = String(raw).split(';');
    var pair = parts[0];
    var eq = pair.indexOf('=');
    if (eq <= 0) return;
    var name = pair.slice(0, eq).trim();
    var value = pair.slice(eq + 1).trim();
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name) { list.splice(i, 1); break; }
    }
    list.push({ name: name, value: value });
  }
  return {
    absorb(res) {
      var rawCookie = res && res.headers && res.headers['set-cookie'];
      if (!rawCookie) return;
      if (!Array.isArray(rawCookie)) rawCookie = [rawCookie];
      for (var i = 0; i < rawCookie.length; i++) setCookie(rawCookie[i]);
    },
    header() {
      return list.map(c => c.name + '=' + c.value).join('; ');
    },
    has(name) {
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return true;
      return false;
    }
  };
}

/** buat precondition request axios dengan header ala browser */
function browserHeaders(extra) {
  var h = {
    'User-Agent': UAS[Math.floor(Math.random() * UAS.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
    'sec-ch-ua-platform': '"Android"',
    'sec-ch-ua-mobile': '?1'
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

/** parsa input apapun menjadi {slug, landingUrl, inputUrl} */
function parseInputUrl(raw) {
  var input = String(raw || '').trim();
  if (!input) {
    var err = new Error('URL target kosong. Contoh: node scrape-bypass-sub2unlock-me.js "https://sub2unlock.me/WdQGzgg"');
    err.code = 'EMPTY_INPUT';
    throw err;
  }
  // dukung: URL penuh, domain tanpa skema, atau slug saja
  var m = input.match(/(?:https?:\/\/)?(?:www\.)?sub2unlock\.me\/([A-Za-z0-9_-]+)\/?/i);
  var slug;
  if (m) slug = m[1];
  else slug = input.split(/[/?#\s]+/)[0].replace(/^\.+|\/+$/g, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) {
    var e2 = new Error('Shortcode tidak valid: "' + slug + '"');
    e2.code = 'INVALID_SHORTCODE';
    throw e2;
  }
  var withScheme = /^https?:\/\//i.test(input) ? input : (input.indexOf('sub2unlock') === 0 ? ('https://' + input) : null);
  return {
    slug: slug,
    landingUrl: BASE_URL + '/' + slug,
    inputUrl: withScheme || (BASE_URL + '/' + slug)
  };
}

/** decode util: nilai attr form sudah url-encoded oleh CakePHP */
function dec(v) {
  v = v == null ? '' : String(v);
  try { return decodeURIComponent(v); } catch (e) {
    try { return v.replace(/%3A/gi, ':').replace(/%7C/gi, '|'); } catch (e2) { return v; }
  }
}

/** kumpulkan semua hidden input dari sebuah form */
function collectFormInputs($, selector) {
  var inputs = {};
  $(selector).find('input[name]').each(function () {
    var t = $(this);
    var name = t.attr('name');
    if (name) inputs[name] = dec(t.attr('value') || '');
  });
  return inputs;
}

/* ---------------- parsing konten page ---------------- */

/** cek jenis halaman: active / not_found / error */
function evaluatePage($) {
  var title = ($('title').text() || '').replace(/\s+/g, ' ').trim();
  if (/error/i.test(title) && $('button.step').length === 0) {
    return { kind: 'not_found', title: title };
  }
  if ($('button.step').length === 0 && $('#link-view').length === 0 && $('#go-link').length === 0) {
    return { kind: 'not_found', title: title };
  }
  return { kind: 'active', title: title };
}

/** deteksi platform dari icon font-awesome atau URL */
function detectPlatform(iconClass, url) {
  iconClass = String(iconClass || '').toLowerCase();
  var url0 = String(url || '').toLowerCase();
  var checks = [
    [/youtube|youtu\.be/, 'youtube'],
    [/instagram/, 'instagram'],
    [/telegram|t\.me(|\/)|telegram\.me/, 'telegram'],
    [/facebook|fb\.com/, 'facebook'],
    [/twitter|x\.com\//, 'twitter'],
    [/tiktok/, 'tiktok'],
    [/discord/, 'discord'],
    [/whatsapp|wa\.me|chat\.whatsapp/, 'whatsapp'],
    [/snapchat/, 'snapchat'],
    [/spotify/, 'spotify'],
    [/twitch/, 'twitch'],
    [/pinterest/, 'pinterest'],
    [/reddit/, 'reddit'],
    [/linkedin/, 'linkedin']
  ];
  for (var i = 0; i < checks.length; i++) {
    if (checks[i][0].test(iconClass) || checks[i][0].test(url0)) return checks[i][1];
  }
  // fallback: slug domain
  var m = url0.match(/^https?:\/\/(?:www\.)?([^\/?#]+)/);
  if (m) return m[1].split('.')[0];
  return 'web';
}

/** deteksi jenis aktivitas dari label tombol task */
function detectAction(label) {
  var l = String(label || '').toUpperCase();
  if (l.indexOf('BELL') >= 0) return 'subscribe_bell';
  if (l.indexOf('SUBSCRIBE') >= 0 || l.indexOf('SUB') === 0 || l.indexOf('& SUB') >= 0 || l.indexOf(' SUB ') >= 0) return 'subscribe';
  if (l.indexOf('FOLLOW') >= 0) return 'follow';
  if (l.indexOf('JOIN') >= 0) return 'join_channel';
  if (l.indexOf('LIKE') >= 0) return 'like';
  if (l.indexOf('SHARE') >= 0) return 'share';
  if (l.indexOf('WATCH') >= 0) return 'watch';
  if (l.indexOf('COMMENT') >= 0) return 'comment';
  if (l.indexOf('VIEW') >= 0) return 'view';
  return 'other';
}

/** coba ekstrak username dari URL target task */
function extractUsername(url) {
  var u = String(url || '');
  var patterns = [
    /youtube\.com\/@([A-Za-z0-9_.-]+)/i,
    /instagram\.com\/([A-Za-z0-9_.]+)\/?(?:\?|$)/i,
    /(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)?([A-Za-z0-9_-]{3,})/i,
    /facebook\.com\/(?:groups\/)?([A-Za-z0-9_.-]+)/i,
    /twitter\.com\/(?:@)?([A-Za-z0-9_]+)/i,
    /discord\.gg\/([A-Za-z0-9_-]+)/i,
    /tiktok\.com\/@([A-Za-z0-9_.]+)/i,
    /whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var mm = u.match(patterns[i]);
    if (mm && mm[1]) return mm[1];
  }
  return null;
}

/** parsa daftar task dari halaman locker */
function parseTasks($) {
  var tasks = [];
  var seen = {};
  $('button.step, a.step').each(function () {
    var t = $(this);
    var onclick = t.attr('onclick') || '';
    var href = t.attr('href') || '';
    var url = '';
    var m = onclick.match(/window\.open\(\s*'([^']+)'/i) || onclick.match(/window\.open\(\s*"([^"]+)"/i);
    if (m && m[1]) url = m[1].trim();
    if (!url && href && href.indexOf('javascript') !== 0) url = href.trim();
    if (url && url.split(/[?#]/)[0].length > 0) {
      if (seen[url]) return; // dedupe
      seen[url] = true;
      var icon = (t.find('i').first().attr('class') || '').trim();
      var label = (t.text() || '').replace(/\s+/g, ' ').trim();
      tasks.push({
        platform: detectPlatform(icon, url),
        action: detectAction(label),
        target_name: extractUsername(url),
        target_url: url,
        status: 'not_verified'
      });
    }
  });
  return tasks;
}

/** baca teks instruksi unlock yang tampil publik di halaman */
function parseInstructions($) {
  var text = '';
  $('span[style*="1.2"], .apppanel-top-bar section, .apppanel-heading').each(function () {
    var s = ($(this).text() || '').replace(/\s+/g, ' ').trim();
    if ((/complete the actions/i.test(s) || /your link is ready/i.test(s)) && !text) text = s;
  });
  if (!text) {
    var h = ($('.apppanel-heading').first().text() || '').replace(/\s+/g, ' ').trim();
    if (h) text = h;
  }
  var sub = '';
  $('.apppanel-top-bar span[style*="1.2"]').each(function () {
    var s = ($(this).text() || '').replace(/\s+/g, ' ').trim();
    if ((/Complete the actions/i.test(s)) && !sub) sub = s;
  });
  return sub || text;
}

/* ---------------- HTTP flow engine ---------------- */

/**
 * tahap 1: GET halaman shortlink
 * @return {status, location, html, jar}
 */
async function fetchLandingPage(slug, jar, timeoutMs) {
  var url = BASE_URL + '/' + slug;
  var res = await axios.get(url, {
    headers: browserHeaders({ Referer: BASE_URL + '/' }),
    timeout: timeoutMs || 20000,
    maxRedirects: 5,
    validateStatus: function () { return true; }
  });
  jar.absorb(res);
  return res;
}

/**
 * tahap 3: POST /links/go dengan ad_form_data -> JSON destination
 */
async function postGoLink(cookieHeader, goLinkInputs, referer, timeoutMs, ua) {
  var res = await axios.post(BASE_URL + '/links/go', new URLSearchParams(goLinkInputs).toString(), {
    headers: {
      'User-Agent': ua,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': BASE_URL,
      'Referer': referer,
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieHeader || ''
    },
    timeout: timeoutMs || 30000,
    maxRedirects: 0,
    validateStatus: function () { return true; }
  });
  return res;
}

/**
 * cek ketersediaan URL tujuan (HEAD, fallback GET)
 */
async function checkAvailability(url, timeoutMs) {
  var result = { status_code: null, state: 'unverifiable', is_locker: false };
  if (!url) return result;
  var onLockerHost = /(?:sub2unlock|sub4unlock|subs4unlock|linkstow|linksgrab|locked[0-9]*\.[a-z0-9-]+\.[a-z]{2,}|sub7unlock|subs4u)\.[a-z]{2,}/i.test(url);
  result.is_locker = onLockerHost;
  var cfg = {
    timeout: timeoutMs || 12000,
    maxRedirects: 5,
    validateStatus: function () { return true; },
    headers: { 'User-Agent': UAS[0], 'Accept': '*/*' }
  };
  try {
    var r = await axios.head(url, cfg);
    result.status_code = r.status;
  } catch (e1) {
    var msg = e1 && e1.response && e1.response.status;
    try {
      var g = await axios.get(url, cfg);
      result.status_code = g.status;
    } catch (e2) {
      if ((e1 && e1.code === 'ENOTFOUND') || (e2 && e2.code === 'ENOTFOUND')) result.state = 'unreachable_domain';
      else if (e2 && e2.response && e2.response.status) result.status_code = e2.response.status;
      else result.state = result.state === 'unreachable_domain' ? 'unreachable_domain' : 'unverifiable';
    }
    if (msg) result.status_code = msg;
  }
  if (result.status_code != null) {
    if (result.status_code >= 200 && result.status_code < 400) result.state = 'available';
    else if (result.status_code === 404 || result.status_code === 410) result.state = 'unavailable';
    else if (result.status_code === 401 || result.status_code === 403) result.state = 'restricted';
    else result.state = 'unverifiable';
  }
  return result;
}

/**
 * analisa chain (hanya utk pattern sub4unlock.com/SL/<id> yang terverifikasi):
 * hop 1: FL.php?$=<id>&own=owner  -> judul "Your Link is Ready"
 * hop 2: FLD786.php?$=<id>&own=user -> window.open(link berikutnya)
 * Semua hop struktural, TIDAK mengarang data. Non-fatal (kalo gagal hop utama tetap lengkap).
 */
async function analyzeChain(destUrl, opts, log) {
  var chain = { depth: 0, hops: [], next_locker: null };
  if (!destUrl || opts.noChain) return chain;
  var m = String(destUrl).match(/^https?:\/\/(?:www\.)?sub4unlock\.com\/SL\/([0-9]+)/i);
  if (!m) return chain;
  var id = m[1];
  var hop1Url = 'https://sub4unlock.com/FL.php?$=' + id + '&own=owner';
  var hop2Url = 'https://sub4unlock.com/FLD786.php?$=' + id + '&own=user';
  var timeout = (opts.timeoutMs || 20000);
  var ua = UAS[0];

  try {
    var r1 = await axios.get(hop1Url, {
      headers: { 'User-Agent': ua, Referer: destUrl }, timeout: timeout,
      maxRedirects: 3, validateStatus: function () { return true; }
    });
    var $1 = cheerio.load(String(r1.data));
    var t1 = ($1('title').text() || '').replace(/\s+/g, ' ').trim();
    var opens1 = [];
    var s1 = String(r1.data);
    var re1 = /window\.open\(\s*['"]((?:https?:)?\/\/[^'"]{4,200})['"]/gi;
    var mm;
    var structural = /sub4unlock\.com\/(?:MOBILE\/)?(?:FL|FLD786|LinkShortner)\.*/i;
    while ((mm = re1.exec(s1)) !== null) {
      var u = mm[1];
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (/sub4unlock\.com\/(index|#)/i.test(u)) continue;
      if (structural.test(u)) continue; // navigasi internal, bukan task creator
      if (opens1.indexOf(u) < 0) opens1.push(u);
    }
    chain.depth += 1;
    chain.hops.push({
      hop: 1,
      service: 'sub4unlock.com',
      view: 'FL.php?$=' + id + '&own=owner',
      page_title: t1,
      task_urls_opened: opens1,
      next_step: hop2Url
    });
    log && log('chain hop1 ok (' + t1 + ')');
  } catch (e) {
    chain.hops.push({ hop: 1, service: 'sub4unlock.com', view: 'FL.php', error: String(e && e.message || e) });
    return chain;
  }

  try {
    var r2 = await axios.get(hop2Url, {
      headers: { 'User-Agent': ua, Referer: hop1Url }, timeout: timeout,
      maxRedirects: 3, validateStatus: function () { return true; }
    });
    var s2 = String(r2.data);
    var $2 = cheerio.load(s2);
    var t2 = ($2('title').text() || '').replace(/\s+/g, ' ').trim();
    var next = [];
    var re2 = /window\.open\(\s*['"]((?:https?:)?\/\/[^'"]{4,200})['"]/gi;
    var k;
    while ((k = re2.exec(s2)) !== null) {
      var u2 = k[1];
      if (u2.indexOf('//') === 0) u2 = 'https:' + u2;
      if (/sub4unlock\.com\/(index|#)/i.test(u2)) continue;
      if (next.indexOf(u2) < 0) next.push(u2);
    }
    var av = null;
    if (next.length) {
      chain.next_locker = next[0];
      av = await checkAvailability(next[0], 12000);
    }
    chain.depth += 1;
    chain.hops.push({
      hop: 2,
      service: 'sub4unlock.com',
      view: 'FLD786.php?$=' + id + '&own=user',
      page_title: t2,
      next_locker: next,
      next_locker_availability: av
    });
    log && log('chain hop2 ok (next: ' + JSON.stringify(next) + ')');
  } catch (e2) {
    chain.hops.push({ hop: 2, service: 'sub4unlock.com', view: 'FLD786.php', error: String(e2 && e2.message || e2) });
  }
  return chain;
}

/* ============================================================
 * FUNGSI UTAMA MODULE: scrapeSub2Unlock(inputUrl, options)
 * ============================================================ */
async function scrapeCore(inputUrl, options) {
  var opts = options || {};
  var maxAttempts = (opts.maxAttempts === undefined || opts.maxAttempts === null)
    ? 6 /* module default wajar; CLI pakai mode tak-terbatas */
    : (opts.maxAttempts === 'infinite' ? Infinity : Number(opts.maxAttempts) || 6);
  var timeoutMs = opts.timeoutMs || 20000;
  var noisy = opts.log !== false;
  var log = noisy ? (opts.logFunction || function (msg) {
    try { process.stderr.write('[sub2unlock-bypass] ' + msg + '\n'); } catch (e) { /* ignore */ }
  }) : function () {};

  var parsed = parseInputUrl(inputUrl);
  var slug = parsed.slug;
  var landingUrl = parsed.landingUrl;

  var startedAt = Date.now();
  var lastErrorMsg = '';
  var attemptsDone = 0;

  while (attemptsDone < maxAttempts) {
    attemptsDone += 1;
    var isLastAttempt = attemptsDone >= maxAttempts;
    try {
      var jar = makeCookieJar();
      var ua = UAS[(attemptsDone - 1) % UAS.length];

      /* --- tahap 1: GET landing --- */
      log('[' + attemptsDone + '] GET ' + landingUrl);
      var res1 = await fetchLandingPage(slug, jar, timeoutMs);
      var html1 = String(res1.data);
      // link direct-redirect (tanpa locker)? kadang creator set redirect langsung
      if (res1.request && res1.request.res && /^https?:\/\//.test(res1.request.res.responseUrl || '')) {
        var finalUrl = res1.request.res.responseUrl;
        if (finalUrl && !/sub2unlock\.me/i.test(finalUrl)) {
          log('direct redirect terdeteksi: ' + finalUrl);
          return await buildResult({
            slug: slug, inputUrl: parsed.inputUrl, landingUrl: landingUrl,
            pageStatus: 'direct_redirect', tasks: [], title: '', description: '',
            directRedirect: finalUrl, attempts: attemptsDone,
            startedAt: startedAt, log: log, opts: opts
          });
        }
      }

      /* --- tahap 2: kumpulkan form + POST gate --- */
      var $1 = cheerio.load(html1);
      var evalPage = evaluatePage($1);

      if (evalPage.kind === 'not_found') {
        // deterministik: tidak perlu infinite retry
        return await buildResult({
          slug: slug, inputUrl: parsed.inputUrl, landingUrl: landingUrl,
          pageStatus: 'not_found', tasks: [], title: evalPage.title,
          description: '', attempts: attemptsDone, startedAt: startedAt,
          log: log, opts: opts, httpStatus: res1.status,
          availabilityOverride: 'unavailable',
          fatalMsg: 'Shortcode tidak ditemukan / tidak lagi tersedia (404). Link mungkin kedaluwarsa.'
        });
      }

      var linkViewInputs = collectFormInputs($1, '#link-view');
      if (Object.keys(linkViewInputs).length === 0) {
        var gv = collectFormInputs($1, '#go-link');
        if (Object.keys(gv).length === 0) {
          lastErrorMsg = 'halaman active tapi form unlock tidak ditemukan';
          log(lastErrorMsg + ' -> retry');
        } else {
          linkViewInputs = null; // halaman langsung menawarkan #go-link
        }
      }

      var goLinkInputs = null;
      if (linkViewInputs) {
        var postBody = new URLSearchParams(linkViewInputs).toString();
        var res2 = await axios.post(landingUrl, postBody, {
          headers: browserHeaders({
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': BASE_URL,
            'Referer': landingUrl,
            'Cookie': jar.header()
          }),
          timeout: timeoutMs,
          maxRedirects: 0,
          validateStatus: function () { return true; }
        });
        jar.absorb(res2);
        var html2 = String(res2.data);
        var $2 = cheerio.load(html2);
        goLinkInputs = collectFormInputs($2, '#go-link');
        if (!goLinkInputs || !goLinkInputs['ad_form_data']) {
          lastErrorMsg = 'form #go-link / ad_form_data tidak ditemukan (HTTP ' + res2.status + ')';
          goLinkInputs = null;
        } else {
          log('[' + attemptsDone + '] ad_form_data ok (' + String(goLinkInputs['ad_form_data']).length + ' chars)');
        }
      }

      /* --- tahap 3: POST /links/go --- */
      var destUrl = null;
      var goErrMessage = '';
      if (goLinkInputs && goLinkInputs['ad_form_data']) {
        var res3 = await postGoLink(jar.header(), goLinkInputs, landingUrl + '/', timeoutMs, ua);
        var data3 = res3.data;
        if (typeof data3 !== 'object') {
          try { data3 = JSON.parse(String(data3)); } catch (eJ) { data3 = null; }
        }
        if (data3 && data3.status === 'success' && data3.url) {
          destUrl = String(data3.url);
          log('[' + attemptsDone + '] BYPASS OK -> ' + destUrl);
        } else {
          goErrMessage = data3 && data3.message ? String(data3.message) : ('HTTP ' + res3.status);
          lastErrorMsg = '/links/go gagal: ' + goErrMessage;
        }
      } else {
        lastErrorMsg = lastErrorMsg || 'gate unlock tidak lengkap';
      }

      /* --- result --- */
      var tasks = parseTasks($1);
      var instr = parseInstructions($1);
      var desc = ($1('meta[property="og:description"]').attr('content') || '').trim() || instr;

      if (destUrl) {
        var destParsed = new (require('url').URL)(destUrl);
        var availAfter = await checkAvailability(destUrl, 12000);
        var chainResult = await analyzeChain(destUrl, opts, log);
        return {
          status: true,
          creator: CREATOR,
          input_url: parsed.inputUrl,
          shortcode: slug,
          service: { name: 'Sub2Unlock', domain: SOURCE_DOMAIN, type: 'social_task_locker' },
          page: {
            title: valor(evalPage.title) || 'Unlock Your Link',
            description: desc || 'Complete the required tasks to access the destination.',
            page_status: 'active',
            unlock_instructions: instr || 'Complete the actions and unlock the link'
          },
          tasks: buildTaskBlock(tasks),
          destination: {
            original_url: destUrl,
            domain: destParsed.hostname,
            protocol: destParsed.protocol.replace(':', ''),
            availability: availAfter.state,
            availability_status_code: availAfter.status_code,
            unlock_required: false,
            is_locker: availAfter.is_locker,
            chain: chainResult
          },
          resolver: {
            supported: true,
            resolved: true,
            attempts: attemptsDone,
            message: 'Destination berhasil di-resolve via engine POST /links/go (ad_form_data).'
          },
          metadata: {
            source: SOURCE_DOMAIN,
            scraped_at: nowISO(),
            scraped_at_iso: nowFullISO(),
            elapsed_ms: Date.now() - startedAt,
            engine: ENGINE_TAG,
            method: 'post_linksgo_adformdata'
          }
        };
      }

      // gagal kali ini: kalau pesan menunjuk captcha (tidak bisa diulang tanpa solve, berhenti honest)
      if (goErrMessage && /captcha|recaptcha|hcaptcha|challenge/i.test(goErrMessage)) {
        log('captcha diperlukan pada flow ini - engine HTTP murni tidak dapat melewati captcha');
        return await buildResult({
          slug: slug, inputUrl: parsed.inputUrl, landingUrl: landingUrl,
          pageStatus: 'active', tasks: tasks, title: evalPage.title, description: desc,
          attempts: attemptsDone, startedAt: startedAt, log: log, opts: opts,
          fatalMsg: 'Unlock memerlukan verifikasi captcha. Destination tidak dapat diekstrak tanpa menyelesaikan captcha.'
        });
      }
      if (isLastAttempt) {
        return await buildResult({
          slug: slug, inputUrl: parsed.inputUrl, landingUrl: landingUrl,
          pageStatus: 'active', tasks: tasks, title: evalPage.title, description: desc,
          attempts: attemptsDone, startedAt: startedAt, log: log, opts: opts,
          fatalMsg: 'Retry habis (' + attemptsDone + 'x). Error terakhir: ' + lastErrorMsg
        });
      }
      // belum sukses --> jangan berhenti, backoff lalu ulang
      var wait = backoffDelay(attemptsDone, 8000);
      log('gagal (' + lastErrorMsg + ') - retry dalam ' + wait + 'ms');
      await sleep(wait);
    } catch (err /* network dsb */) {
      lastErrorMsg = (err && (err.message + (err.code ? ' [' + err.code + ']' : ''))) || String(err);
      if (isLastAttempt) {
        return buildFatal(parsed, slug, attemptsDone, Date.now() - startedAt, lastErrorMsg);
      }
      var w2 = backoffDelay(attemptsDone, 8000);
      log('network error (' + lastErrorMsg + ') - retry dalam ' + w2 + 'ms');
      await sleep(w2);
    }
  }

  // keluar loop = semua attempt habis
  return buildFatal(parsed, slug, attemptsDone, Date.now() - startedAt, lastErrorMsg || 'bypass tidak berhasil setelah ' + attemptsDone + ' attempt');
}

function valor(v) { return v == null ? '' : String(v).trim(); }

/** susun blok tasks */
function buildTaskBlock(tasks) {
  var types = [];
  for (var i = 0; i < tasks.length; i++) {
    if (types.indexOf(tasks[i].action) < 0) types.push(tasks[i].action);
  }
  return {
    total: tasks.length,
    types: types,
    items: tasks
  };
}

/** hasil final utk halaman terdeteksi tapi tanpa destination bisa diambil */
async function buildResult(ctx) {
  var destUrl = ctx.directRedirect || null;
  var avail = { state: ctx.availabilityOverride || 'not_publicly_exposed', is_locker: false, status_code: null };
  if (destUrl) avail = await checkAvailability(destUrl, 12000);
  var resolved = !!destUrl;
  var destDomain = null;
  if (destUrl) {
    try {
      destDomain = new (require('url').URL)(destUrl).hostname;
    } catch (eD) {
      destDomain = destUrl.replace(/^https?:\/\//i, '').split('/')[0];
    }
  }
  var result = {
    status: true,
    creator: CREATOR,
    input_url: ctx.inputUrl,
    shortcode: ctx.slug,
    service: { name: 'Sub2Unlock', domain: SOURCE_DOMAIN, type: 'social_task_locker' },
    page: {
      title: ctx.title || 'Unlock Your Link',
      description: ctx.description || 'Complete the required tasks to access the destination.',
      page_status: ctx.pageStatus,
      http_status: ctx.httpStatus || null,
      unlock_instructions: 'Complete the actions and unlock the link'
    },
    tasks: buildTaskBlock(ctx.tasks || []),
    destination: {
      original_url: destUrl,
      domain: destDomain,
      protocol: destUrl ? (/^https:\/\//i.test(destUrl) ? 'https' : 'http') : null,
      availability: avail.state,
      availability_status_code: avail.status_code,
      unlock_required: !resolved,
      is_locker: avail.is_locker
    },
    resolver: {
      supported: true,
      resolved: resolved,
      attempts: ctx.attempts,
      message: resolved
        ? 'Link tujuan diperoleh via redirect langsung (tanpa task locker).'
        : (ctx.fatalMsg || 'Destination URL is not publicly available.')
    },
    metadata: {
      source: SOURCE_DOMAIN,
      scraped_at: nowISO(),
      scraped_at_iso: nowFullISO(),
      elapsed_ms: Date.now() - ctx.startedAt,
      engine: ENGINE_TAG
    }
  };
  if (ctx.payloadError) {
    result.error = { code: ctx.payloadError.code, message: ctx.payloadError.message };
  }
  return result;
}

/** hasil fatal (semua attempt gagal / exception) */
function buildFatal(parsed, slug, attempts, elapsed, message) {
  return {
    status: false,
    creator: CREATOR,
    input_url: parsed ? parsed.inputUrl : (BASE_URL + '/' + (slug || '')),
    shortcode: slug || null,
    service: { name: 'Sub2Unlock', domain: SOURCE_DOMAIN, type: 'social_task_locker' },
    page: {
      title: null,
      description: null,
      page_status: 'error',
      http_status: null,
      unlock_instructions: null
    },
    tasks: buildTaskBlock([]),
    destination: {
      original_url: null,
      domain: null,
      protocol: null,
      availability: 'unverifiable',
      availability_status_code: null,
      unlock_required: true,
      is_locker: false
    },
    resolver: {
      supported: true,
      resolved: false,
      attempts: attempts,
      message: message
    },
    metadata: {
      source: SOURCE_DOMAIN,
      scraped_at: nowISO(),
      scraped_at_iso: nowFullISO(),
      elapsed_ms: elapsed || 0,
      engine: ENGINE_TAG
    },
    error: { code: 'RESOLVER_FAILED', message: message }
  };
}

var ENGINE_TAG = 'sub2unlock-http-bypass v1.0 (axios+cheerio, POST /links/go engine)';

/* ============================================================
 * API MODULE UTAMA
 * scrapeSub2Unlock(url, options) -> Promise<resultObject>
 *   options:
 *     maxAttempts : number | 'infinite'  (default 6)
 *     timeoutMs   : number               (default 20000)
 *     noChain     : boolean              (default false)
 *     outFile     : string               (opsional, api utk menulis JSON ke file)
 *     log         : false                (default true, log ke process.stderr)
 * ============================================================ */
async function scrapeSub2Unlock(inputUrl, options) {
  var opts = options || {};
  var result = await scrapeCore(inputUrl, opts);
  if (opts.outFile) {
    try {
      fs.writeFileSync(opts.outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
    } catch (eW) {
      if (opts.log !== false && typeof process !== 'undefined' && process.stderr) {
        try { process.stderr.write('[sub2unlock-bypass] GAGAL menulis ' + opts.outFile + ': ' + eW.message + '\n'); } catch (e) { /* ignore */ }
      }
    }
  }
  return result;
}

/* ============================================================
 * CLI
 * ============================================================ */
function cliMain() {
  var argv = process.argv.slice(2);
  var args = { url: null, retries: 'infinite', out: null, timeout: null, noChain: false, quiet: false };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--retries' || a === '-r') { args.retries = (argv[++i] || 'infinite'); }
    else if (a === '--infinite') { args.retries = 'infinite'; }
    else if (a === '--out' || a === '-o') { args.out = argv[++i] || null; }
    else if (a === '--timeout' || a === '-t') { args.timeout = Number(argv[++i]) || null; }
    else if (a === '--no-chain') { args.noChain = true; }
    else if (a === '--quiet' || a === '-q') { args.quiet = true; }
    else if (a === '--help' || a === '-h') {
      console.log('Penggunaan:\n  node scrape-bypass-sub2unlock-me.js <url> [opsi]\n\nUrl: https://sub2unlock.me/WdQGzgg (atau slug WdQGzgg)\nOpsi:\n  --retries N | --retries infinite   maks attempt (default: infinite, selalu mencari sukses)\n  --out file.json                    path output (default: result.json di cwd)\n  --timeout ms                       timeout per request (default 20000)\n  --no-chain                         matikan analisa chain sub4unlock\n  --quiet                            tanpa log ke stderr (stdout tetap JSON)\n');
      process.exit(0);
    }
    else if (!args.url) { args.url = a; }
  }
  if (!args.url) {
    console.error('URL target wajib. Contoh: node scrape-bypass-sub2unlock-me.js "https://sub2unlock.me/WdQGzgg"');
    process.exit(1);
  }
  var outPath = args.out || path.join(process.cwd(), 'result.json');

  scrapeSub2Unlock(args.url, {
    maxAttempts: args.retries === 'infinite' ? 'infinite' : (Number(args.retries) || 'infinite'),
    timeoutMs: args.timeout || 20000,
    noChain: args.noChain,
    log: !args.quiet
  }).then(function (result) {
    try {
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    } catch (eW) {
      console.error('[sub2unlock-bypass] GAGAL menulis file ' + outPath + ': ' + eW.message);
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status ? 0 : 1);
  }).catch(function (e) {
    var fatal = { status: false, creator: CREATOR, input_url: args.url, error: { code: 'UNCAUGHT', message: String(e && e.message || e) } };
    try { fs.writeFileSync(outPath, JSON.stringify(fatal, null, 2) + '\n', 'utf8'); } catch (eW) { /* ignore */ }
    console.log(JSON.stringify(fatal, null, 2));
    process.exit(1);
  });
}

if (require.main === module) {
  cliMain();
}

/* ---------------- exports utk integrasi modul ---------------- */
module.exports = {
  scrapeSub2Unlock: scrapeSub2Unlock,
  parseInputUrl: parseInputUrl,
  parseTasks: parseTasks,
  detectPlatform: detectPlatform,
  detectAction: detectAction,
  checkAvailability: checkAvailability,
  analyzeChain: analyzeChain,
  cliMain: cliMain,
  CREATOR: CREATOR
};
