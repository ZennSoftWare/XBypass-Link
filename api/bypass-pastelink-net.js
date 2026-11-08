#!/usr/bin/env node
/* ============================================================================
 * scrape-bypass-pastelink-net.js
 * ---------------------------------------------------------------------------
 * Scraper Pastelink.net  (engine: Axios + Cheerio — tanpa browser berat)
 *
 * Kemampuan:
 *   1. Mengambil isi paste & seluruh hyperlink pada area konten (#body-display)
 *   2. Bypass gerbang tunggu shortlink pslk.net (ID diekstrak tanpa menunggu
 *      3 detik / tanpa menjalankan JavaScript)
 *   3. Deteksi gerbang password (server-side), CAPTCHA, paste terhapus/expired
 *   4. Alur password otomatis bila password tersedia (cookie jar PHPSESSID
 *      diambil langsung dari respons server — user tidak perlu mengisi manual)
 *   5. Recovery konten dari Wayback Machine bila paste live terkunci
 *   6. Fallback reader HTTP (r.jina.ai) bila ada challenge/anti-bot
 *   7. Retry engine: timeout / 5xx / 429 ditunggu dengan backoff lalu diulang
 *
 * CLI:
 *   node scrape-bypass-pastelink-net.js "https://pastelink.net/pu01k6oq" [password]
 *
 * Opsi tambahan:
 *   --password <pw>        Password paste (alternatif argumen ke-2)
 *   --timeout <ms>         Timeout per request (default 45000)
 *   --max-attempts <n>     Jumlah maksimal percobaan (default 10)
 *   --infinite             Terus mencoba tanpa berhenti sampai sukses
 *   --out <file>           Nama file output (default result.json)
 *
 * Modul:
 *   const { scrapePastelink } = require('./scrape-bypass-pastelink-net.js');
 *   const hasil = await scrapePastelink('https://pastelink.net/xxxxxxx');
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

let axios, cheerio;
try {
  axios = require('axios');
  cheerio = require('cheerio');
} catch (err) {
  process.stderr.write(
    'Dependensi belum terpasang. Jalankan dulu: npm install axios cheerio\n'
  );
  if (require.main === module) process.exit(1);
  throw err;
}

/* -------------------------------------------------------------------------- */
/* Konstanta                                                                  */
/* -------------------------------------------------------------------------- */
const SERVICE_DOMAIN = 'pastelink.net';
const PASTE_HOSTS = ['pastelink.net', 'www.pastelink.net'];
const SHORTLINK_HOSTS = ['pslk.net'];
const DEFAULT_TIMEOUT = 45000;
const DEFAULT_MAX_ATTEMPTS = 10;
const CREATOR = 'Xbypass';
const SERVICE_NAME = 'Pastelink';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];
let uaPointer = Math.floor(Math.random() * USER_AGENTS.length);
function nextUA() {
  uaPointer = (uaPointer + 1) % USER_AGENTS.length;
  return USER_AGENTS[uaPointer];
}

/* -------------------------------------------------------------------------- */
/* Util dasar                                                                 */
/* -------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffDelay = (round) =>
  Math.min(1500 * Math.pow(2, Math.max(0, round - 1)), 15000) +
  Math.floor(Math.random() * 750);

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00a0\u200b]/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

/** Rapikan teks multi-baris hasil ekstraksi konten paste. */
function normalizeText(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00a0\u200b]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Cookie jar otomatis (cookie diambil langsung dari server, bukan manual)      */
/* -------------------------------------------------------------------------- */
class CookieJar {
  constructor() {
    this.store = new Map();
  }
  absorb(res) {
    const setCookies =
      res && res.headers && res.headers['set-cookie']
        ? res.headers['set-cookie']
        : [];
    if (!Array.isArray(setCookies)) return;
    for (const raw of setCookies) {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        this.store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }
  header() {
    if (!this.store.size) return null;
    return Array.from(this.store.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  clear() {
    this.store.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Transport HTTP (axios)                                                     */
/* -------------------------------------------------------------------------- */
async function fetchRaw(url, opts = {}) {
  const {
    method = 'GET',
    form = null,
    jar = new CookieJar(),
    timeout = DEFAULT_TIMEOUT,
    headers = {},
    maxRedirects = 8,
  } = opts;

  const h = {
    'User-Agent': nextUA(),
    Accept:
      method === 'POST' || form
        ? 'application/x-www-form-urlencoded,text/html,*/*'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    ...headers,
  };
  const cookie = jar.header();
  if (cookie) h.Cookie = cookie;
  if (form) h['Content-Type'] = 'application/x-www-form-urlencoded';

  const config = {
    method,
    url,
    headers: h,
    timeout,
    maxRedirects,
    validateStatus: () => true,
    responseType: 'text',
  };
  if (form) config.data = new URLSearchParams(form).toString();

  const res = await axios(config);
  jar.absorb(res);
  const finalUrl =
    (res.request && res.request.res && res.request.res.responseUrl) ||
    (res.request && res.request.responseURL) ||
    res.url ||
    url;

  return {
    status: res.status,
    data: res.data == null ? '' : String(res.data),
    headers: res.headers || {},
    finalUrl,
    requestUrl: url,
  };
}

/* -------------------------------------------------------------------------- */
/* Parse / validasi target                                                    */
/* -------------------------------------------------------------------------- */
/** Terima URL pastelink.net, shortlink pslk.net, atau ID paste mentah. */
function parseTarget(raw) {
  if (raw == null || String(raw).trim() === '') {
    throw new Error('URL target tidak boleh kosong.');
  }
  const original = String(raw).trim();
  let host = null;
  let pathname = '';

  if (/^[a-z0-9]{6,24}$/i.test(original) && !/^https?:/i.test(original)) {
    return {
      kind: 'pastelink',
      original,
      url: `https://${SERVICE_DOMAIN}/${original}`,
      id: original.toLowerCase(),
    };
  }
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(original) ? original : `https://${original}`);
  } catch (e) {
    throw new Error(`URL tidak valid: ${original}`);
  }
  host = u.hostname.toLowerCase();
  pathname = u.pathname;

  const parts = pathname.split('/').filter(Boolean);
  if (PASTE_HOSTS.includes(host)) {
    if (parts.length !== 1) {
      throw new Error(
        `Path tidak dikenali: pastelink.net/<id-paste> dibutuhkan, dapat "${pathname}"`
      );
    }
    return {
      kind: 'pastelink',
      original,
      url: `https://${SERVICE_DOMAIN}/${parts[0]}`,
      id: parts[0].toLowerCase(),
    };
  }
  if (SHORTLINK_HOSTS.includes(host)) {
    if (parts.length !== 1) {
      throw new Error(
        `Path tidak dikenali: pslk.net/<id-paste> dibutuhkan, dapat "${pathname}"`
      );
    }
    return {
      kind: 'pslk',
      original,
      url: `https://pslk.net/${parts[0]}`,
      id: parts[0].toLowerCase(),
    };
  }
  throw new Error(
    `Target bukan domain Pastelink: "${host}". Gunakan pastelink.net/<id> atau pslk.net/<id>.`
  );
}

/* -------------------------------------------------------------------------- */
/* Deteksi challenge/anti-bot (perhatian: turnstile di <head> jarang = CF)     */
/* -------------------------------------------------------------------------- */
function looksLikeChallenge(html, status) {
  if (status === 403 || status === 429 || status === 503) return true;
  const t = String(html).toLowerCase();
  if (t.length < 200 && /just a moment|attention required/.test(t)) return true;
  return (
    t.includes('just a moment') ||
    t.includes('_cf_chl') ||
    t.includes('cf-browser-verification') ||
    t.includes('cdn-cgi/challenge-platform') ||
    t.includes('checking your browser before accessing')
  );
}

/* -------------------------------------------------------------------------- */
/* Bypass gerbang tunggu pslk.net                                             */
/*  - pslk.net hanya halaman "Please wait 3 seconds" + JS redirect             */
/*  - ID ada di <input id="loc"> atau string "url1+url2+url3" pada skrip       */
/* -------------------------------------------------------------------------- */
async function resolvePslk(shortUrl, { jar, timeout } = {}) {
  const page = await fetchRaw(shortUrl, {
    jar,
    timeout,
    headers: { Referer: 'https://pslk.net/' },
  });
  if (page.status !== 200) {
    throw new Error(`pslk.net merespons HTTP ${page.status}`);
  }
  const $ = cheerio.load(page.data);
  const hidden = ($('#loc').attr('value') || $('input#loc').val() || '').trim();
  let id = hidden || null;
  if (!id) {
    const m = /location\.replace\((?:'|"|`)https?:\/\/[^'"]*\/([a-z0-9]{6,24})/i.exec(page.data);
    if (m) id = m[1];
  }
  if (!id) {
    throw new Error('Gagal mengekstrak ID dari halaman tunggu pslk.net.');
  }
  const p1 = /var\s+url1\s*=\s*['"]([^'"]*)['"]/.exec(page.data);
  const p2 = /var\s+url2\s*=\s*['"]([^'"]*)['"]/.exec(page.data);
  const p3 = /var\s+url3\s*=\s*['"]([^'"]*)['"]/.exec(page.data);
  let host = SERVICE_DOMAIN;
  if (p1 && p2 && p3) {
    const joined = (p1[1] + p2[1] + p3[1]).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (/^[a-z0-9.-]+$/i.test(joined)) host = joined;
  }
  return {
    id: id.toLowerCase(),
    url: `https://${host}/${id}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Parser halaman paste                                                       */
/* -------------------------------------------------------------------------- */
function parsePastePage(html, finalUrl, httpStatus, originalPageUrl) {
  const $ = cheerio.load(String(html || ''));
  const pageTextRaw = $('body').text() || '';

  const notFound =
    httpStatus === 404 ||
    /that page either does not exist or has been deleted/i.test(pageTextRaw) ||
    Boolean(finalUrl && /\/404(\?|$|[#/])/.test(finalUrl));

  const entryForm = $('form#entryform').first();
  const entryFormHtml = entryForm.html() || '';
  const passwordGate =
    entryForm.length > 0 &&
    Boolean(
      entryForm.find('input[type="password"]').length || $('#passlabel').length > 0
    );

  // CAPTCHA hanya dianggap wajib bila widget-nya berada di dalam form akses
  // (skrip turnstile di <head> dimuat global, jadi bukan indikator).
  const captchaRequired =
    /cf-turnstile|g-recaptcha|\bgrecaptcha|h-captcha|hcaptcha|data-sitekey|challenges\.cloudflare\.com\/turnstile/i.test(
      entryFormHtml
    ) ||
    entryForm
      .find('[class*="captcha" i],[id*="captcha" i],[name*="captcha" i]')
      .length > 0;

  const bodyEl = $('#body-display').first();
  let content = null;
  if (bodyEl.length) {
    const clone = bodyEl.clone();
    clone.find('br').replaceWith('\n');
    clone.find('script,style').remove();
    content = normalizeText(clone.text()) || null;
  }
  const hasBody = bodyEl.length > 0;

  let title = cleanText($('#title-display').first().text()) || null;
  if (!title) {
    const og = cleanText($('meta[property="og:title"]').attr('content') || '');
    if (og && !/pastelink\.?\s*net\s*-\s*publish hyperlinks/i.test(og)) title = og || null;
  }

  // Link pada area konten saja (bukan link share/iklan/footer, sesuai sampel)
  const baseUrl = finalUrl || originalPageUrl || `https://${SERVICE_DOMAIN}/`;
  const links = [];
  const seen = new Set();
  const seenUrls = new Set();
  const pushLink = (text, href, skipIfUrlExists = false) => {
    if (!href) return;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      u.hash = '';
      const url = u.href;
      if (skipIfUrlExists && seenUrls.has(url)) return;
      const linkText = cleanText(text) || '';
      const key = `${url}||${linkText}`;
      if (seen.has(key)) return;
      seen.add(key);
      seenUrls.add(url);
      links.push({
        link_text: linkText,
        url,
        host: u.hostname.toLowerCase().replace(/^www\./, ''),
      });
    } catch (_) {
      /* URL tidak valid — abaikan */
    }
  };

  bodyEl.find('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
    pushLink($(el).text() || '', href);
  });

  // Jaring pengaman: URL polos di dalam teks konten yang tidak otomatis
  // di-link oleh situs (dihilangkan duplikatnya terhadap anchor; emoji
  // atau tanda baca yang menempel di akhir URL tidak dianggap bagian URL).
  if (content) {
    const stripTail = (s) =>
      s
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]+$/u, '')
        .replace(/[)\]},.;:!?»”’]+$/, '');
    const re = /(?:https?:\/\/)[^\s<>"'`]+/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      pushLink(m[0], stripTail(m[0]), true);
    }
  }

  let visibility = null;
  $('#info .icon, .info-bar .icon').each((i, el) => {
    const cls = $(el).attr('class') || '';
    const t = $(el).attr('title') || '';
    const hay = `${cls} ${t}`.toLowerCase();
    if (/is public|icon-public/.test(hay)) visibility = 'public';
    else if (/password/.test(hay)) visibility = 'password';
    else if (/private/.test(hay)) visibility = 'private';
    else if (/expire/.test(hay)) visibility = 'expires';
    else if (!visibility && t) visibility = cleanText(t.replace(/^this paste is\s+/i, '')) || null;
  });

  let expiry = null;
  const em = /expir(?:es|ed)?\s*(?:on|in|at)?\s*[:\-]?\s*([^\n]{0,64})?/i.exec(pageTextRaw);
  if (em) {
    expiry = cleanText(em[0]) || null;
  }

  const notice = cleanText($('#centrespace, #center').first().text()) || '';
  const expired = /\bexpir/i.test(notice) || /\bexpir/i.test(title || '');

  return {
    $,
    notFound,
    passwordGate,
    captchaRequired,
    hasBody,
    title,
    content,
    links,
    visibility,
    expiry,
    notice,
    expired,
  };
}

/* -------------------------------------------------------------------------- */
/* POST password (jar cookie diisi otomatis dari GET pertama)                  */
/* -------------------------------------------------------------------------- */
async function submitPassword(page, targetId, jar, password, timeout) {
  const $ = cheerio.load(page.data);
  const form = $('form#entryform').first();
  const action = (form.attr('action') || targetId).trim();
  let postUrl;
  try {
    postUrl = new URL(action, `https://${SERVICE_DOMAIN}/`).href;
  } catch (_) {
    postUrl = `https://${SERVICE_DOMAIN}/${targetId}`;
  }
  return fetchRaw(postUrl, {
    method: 'POST',
    form: { password: String(password), submitbtn: 'Enter' },
    jar,
    timeout,
    headers: {
      Referer: `https://${SERVICE_DOMAIN}/${targetId}`,
      Origin: `https://${SERVICE_DOMAIN}`,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Recovery konten dari Wayback Machine (best effort)                         */
/* -------------------------------------------------------------------------- */
async function waybackRecover(pasteId, { timeout } = {}) {
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(
      `${SERVICE_DOMAIN}/${pasteId}`
    )}`;
    const r1 = await fetchRaw(api, { timeout: Math.min(timeout, 20000) });
    if (r1.status !== 200) return null;
    let j = null;
    try {
      j = JSON.parse(r1.data);
    } catch (_) {
      return null;
    }
    const snap =
      j && j.archived_snapshots && j.archived_snapshots.closest
        ? j.archived_snapshots.closest
        : null;
    if (!snap || snap.available === false || !snap.url) return null;

    const r2 = await fetchRaw(snap.url, { timeout });
    if (r2.status !== 200 || !/body-display/i.test(r2.data || '')) return null;
    return { html: r2.data, snapshot: snap.url, timestamp: snap.timestamp || null };
  } catch (_) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Fallback reader HTTP ringan (r.jina.ai) — dipakai hanya bila terhalang      */
/* -------------------------------------------------------------------------- */
const NOISE_HOST_RE =
  /pastelink\.net|pslk\.net|googletagmanager|facebook\.com\/sharer|twitter\.com\/share|t\.me\/share|api\.whatsapp\.com|mailto:|linkedin\.com\/sharing|pinterest|tumblr|reddit\.com\/submit|share\.flipboard|line\.me|meneame|diasp\.|livejournal|blogger\.com|profitquery|challenges\.cloudflare|fonts\./i;

async function jinaReader(pageUrl, { timeout } = {}) {
  try {
    const r = await fetchRaw(`https://r.jina.ai/${pageUrl}`, {
      timeout,
      headers: { Accept: 'text/plain' },
    });
    if (r.status !== 200 || !r.data) return { kind: 'failed' };
    if (/requires a password/i.test(r.data)) return { kind: 'gated' };

    const titleRaw = (/^Title:[ \t]*(.+)[ \t]*$/m.exec(r.data) || [])[1] || null;
    const title =
      titleRaw && !/pastelink\.?\s*net\s*-\s*publish hyperlinks/i.test(titleRaw)
        ? cleanText(titleRaw)
        : null;

    const md = (r.data.split(/^Markdown Content:.*$/m)[1] || '').trim();
    if (!md) return { kind: 'empty' };

    const links = [];
    const seen = new Set();
    const push = (text, href) => {
      if (!href || NOISE_HOST_RE.test(href)) return;
      try {
        const u = new URL(href, pageUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        u.hash = '';
        const key = `${u.href}||${cleanText(text) || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        links.push({
          link_text: cleanText(text) || '',
          url: u.href,
          host: u.hostname.toLowerCase().replace(/^www\./, ''),
        });
      } catch (_) {}
    };
    let m;
    const reMD = /\[([^\]]*?)]\((https?:\/\/[^)\s]+)\)/g;
    while ((m = reMD.exec(md)) !== null) push(m[1], m[2]);
    const reURL = /(?:https?:\/\/)[^\s)\]]+/g;
    while ((m = reURL.exec(md)) !== null) push(m[0], m[0].replace(/[);,]+$/, ''));

    const content =
      md
        .replace(/\[([^\]]*?)]\((https?:\/\/[^)\s]+)\)/g, (s, t, h) => (t ? t : h))
        .replace(/\n{3,}/g, '\n\n')
        .trim() || null;

    if (!links.length && !content) return { kind: 'empty' };
    return { kind: 'content', title, content, links };
  } catch (_) {
    return { kind: 'failed' };
  }
}

/* -------------------------------------------------------------------------- */
/* Perakitan hasil                                                            */
/* -------------------------------------------------------------------------- */
function resultSkeleton(target, overrides = {}) {
  return {
    original_url: target ? target.original : null,
    domain: target ? SERVICE_DOMAIN : SERVICE_DOMAIN,
    paste_id: target ? target.id : null,
    title: null,
    content: null,
    total_links: 0,
    links: [],
    destination_url: null,
    visibility: null,
    expiry: null,
    page_status: null,
    password_required: false,
    captcha_required: false,
    final_url: null,
    error: null,
    ...overrides,
  };
}

function wrap(status, data) {
  return { status, creator: CREATOR, service: SERVICE_NAME, data };
}

function buildContentResult(target, parsed, extra = {}) {
  const links = (parsed.links || []).map((l, i) => ({
    index: i + 1,
    link_text: l.link_text,
    url: l.url,
    host: l.host,
  }));
  return wrap(
    true,
    resultSkeleton(target, {
      title: parsed.title || null,
      content: parsed.content || (parsed.hasBody ? '' : null),
      total_links: links.length,
      links,
      destination_url: links.length ? links[0].url : null,
      visibility: parsed.visibility || null,
      expiry: parsed.expiry || null,
      page_status: extra.page_status || 'accessible',
      password_required: Boolean(extra.password_required),
      captcha_required: Boolean(extra.captcha_required),
      final_url: extra.final_url != null ? extra.final_url : null,
      error: extra.error || null,
    })
  );
}

function gateResult(target, parsed, opts = {}) {
  const captcha = Boolean(parsed && parsed.captchaRequired);
  return wrap(
    true,
    resultSkeleton(target, {
      page_status: captcha ? 'captcha_required' : 'password_required',
      password_required: true,
      captcha_required: captcha,
      error: opts.passwordTried
        ? 'Password ditolak dan tidak ada arsip publik yang dapat dipulihkan. Konten paste terkunci password dari sisi server.'
        : 'Paste terkunci password dari sisi server. Konten hanya dapat dibaca jika password diketahui; tidak ditemukan arsip publik untuk dipulihkan.',
    })
  );
}

function notFoundResult(target, parsed) {
  const expiredLike = parsed && parsed.expired;
  return wrap(
    false,
    resultSkeleton(target, {
      page_status: expiredLike ? 'expired' : 'unavailable',
      error:
        'Paste tidak ditemukan, telah dihapus, atau sudah kedaluwarsa (dikembalikan ke halaman /404).',
    })
  );
}

function invalidTargetResult(inputUrl, message) {
  return wrap(
    false,
    resultSkeleton(null, {
      original_url: inputUrl == null ? null : String(inputUrl),
      page_status: 'unavailable',
      error: message,
    })
  );
}

function blockedResult(target, lastIssue) {
  return wrap(
    false,
    resultSkeleton(target, {
      page_status: 'unavailable',
      error: `Gagal mengambil halaman setelah seluruh percobaan: ${
        lastIssue || 'sebab tidak diketahui'
      }`,
    })
  );
}

/* -------------------------------------------------------------------------- */
/* Engine utama                                                               */
/* -------------------------------------------------------------------------- */
async function scrapePastelink(input, opts = {}) {
  const timeout =
    opts.timeout || Number(process.env.PASTELINK_TIMEOUT_MS) || DEFAULT_TIMEOUT;
  const infinite =
    Boolean(opts.infinite) || /1|true|yes/i.test(String(process.env.PASTELINK_INFINITE || ''));
  const maxAttempts =
    opts.maxAttempts ||
    Number(process.env.PASTELINK_MAX_ATTEMPTS) ||
    DEFAULT_MAX_ATTEMPTS;
  const password =
    opts.password != null ? opts.password : process.env.PASTELINK_PASSWORD || null;
  const quiet = Boolean(opts.quiet);
  const log = (...m) => {
    if (!quiet) process.stderr.write(`[pastelink] ${m.join(' ')}\n`);
  };

  let target;
  try {
    target = parseTarget(input);
  } catch (e) {
    return invalidTargetResult(input, e.message);
  }
  log(`Target: ${target.original} -> ${target.url} (id=${target.id})`);
  const landingFirstUrl = target.url;

  const jar = new CookieJar();
  let passwordTried = false;
  let waybackTried = false;
  let lastIssue = 'sebab tidak diketahui';
  let attempt = 0;

  while (true) {
    attempt += 1;
    if (attempt > 1) {
      if (!infinite && attempt > maxAttempts) break;
      const d = backoffDelay(attempt - 1);
      log(`Menunggu ${d} ms sebelum percobaan #${attempt}...`);
      await sleep(d);
    }

    try {
      /* --- 1. Bypass gerbang pslk.net --- */
      let pageUrl = target.url;
      if (target.kind === 'pslk') {
        const resolved = await resolvePslk(target.url, { jar, timeout });
        const bumped = { ...target, id: resolved.id, url: resolved.url };
        target = bumped;
        pageUrl = resolved.url;
        log(`Bypass gerbang pslk berhasil -> ${pageUrl}`);
      }

      /* --- 2. Fetch langsung --- */
      const page = await fetchRaw(pageUrl, { jar, timeout });

      if (looksLikeChallenge(page.data, page.status)) {
        log(`Terhalang challenge (HTTP ${page.status}); mencoba fallback reader HTTP...`);
        const jr = await jinaReader(pageUrl, { timeout });
        if (jr.kind === 'content') {
          log('Reader HTTP berhasil membaca konten.');
          return buildContentResult(target, {
            title: jr.title,
            content: jr.content,
            links: jr.links,
            hasBody: true,
          }, {
            final_url: pageUrl && pageUrl !== landingFirstUrl ? pageUrl : undefined,
          });
        }
        if (jr.kind === 'gated') {
          log('Reader HTTP: halaman tetap terkunci password.');
          return gateResult(target, { captchaRequired: false }, { passwordTried });
        }
        lastIssue = `challenge/anti-bot (HTTP ${page.status})`;
        continue;
      }

      if (page.status >= 500 || page.status === 429 || page.status === 403) {
        lastIssue = `HTTP ${page.status}`;
        continue;
      }

      /* --- 3. Klasifikasi & ekstraksi --- */
      const parsed = parsePastePage(page.data, page.finalUrl, page.status, pageUrl);

      if (parsed.notFound) {
        log('Halaman tidak ditemukan (404/deleted).');
        return notFoundResult(target, parsed);
      }

      if (parsed.passwordGate || parsed.captchaRequired) {
        /* --- 4. Alur password otomatis bila password tersedia --- */
        if (parsed.passwordGate && password && !passwordTried) {
          passwordTried = true;
          log('Mengirim password ke formulir akses...');
          const after = await submitPassword(page, target.id, jar, password, timeout);
          const reparsed = parsePastePage(
            after.data,
            after.finalUrl,
            after.status,
            pageUrl
          );
          if (reparsed.notFound) return notFoundResult(target, reparsed);
          if (reparsed.hasBody && !reparsed.passwordGate) {
            log('Password diterima — konten terbuka.');
            return buildContentResult(target, reparsed, {
              page_status: 'accessible',
              final_url: pageUrl && pageUrl !== landingFirstUrl ? pageUrl : undefined,
            });
          }
          log('Password ditolak / tidak membuka konten.');
        }

        /* --- 5. Recovery dari arsip --- */
        if (!waybackTried) {
          waybackTried = true;
          log('Mencoba recovery konten dari Wayback Machine...');
          const wb = await waybackRecover(target.id, { timeout });
          if (wb) {
            const wp = parsePastePage(wb.html, wb.snapshot, 200, null);
            if (wp.hasBody && !wp.passwordGate && !wp.notFound) {
              log(`Konten dipulihkan dari arsip: ${wb.snapshot}`);
              return buildContentResult(target, wp, {
                page_status: 'accessible',
                final_url: wb.snapshot,
              });
            }
          }
          log('Tidak ada snapshot arsip yang memuat konten.');
        }

        /* --- 6. Hasil terkunci --- */
        return gateResult(target, parsed, { passwordTried });
      }

      /* --- 7. Paste publik terbaca --- */
      if (!parsed.hasBody) {
        return wrap(
          false,
          resultSkeleton(target, {
            page_status: 'unavailable',
            error:
              'Halaman bukan halaman paste pastelink yang valid (tidak ada area konten #body-display).',
          })
        );
      }
      return buildContentResult(target, parsed, {
        page_status: 'accessible',
        final_url: pageUrl && pageUrl !== landingFirstUrl ? pageUrl : undefined,
      });
    } catch (err) {
      lastIssue = err.message;
      log(`Percobaan #${attempt} gagal: ${err.message}`);
      if (infinite) continue;
    }

    if (!infinite && attempt >= maxAttempts) break;
  }

  return blockedResult(target, lastIssue);
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */
function cliParse(argv) {
  const out = { url: null, password: null, timeout: null, maxAttempts: null, infinite: false, outFile: 'result.json' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--password':
        out.password = argv[++i] || null;
        break;
      case '--timeout':
        out.timeout = Number(argv[++i]) || null;
        break;
      case '--max-attempts':
        out.maxAttempts = Number(argv[++i]) || null;
        break;
      case '--infinite':
        out.infinite = true;
        break;
      case '--out':
        out.outFile = argv[++i] || 'result.json';
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        rest.push(a);
    }
  }
  out.url = rest[0] || null;
  out.password = out.password || rest[1] || null;
  return out;
}

function printUsage(stream = process.stderr) {
  stream.write(
    [
      'Penggunaan:',
      '  node scrape-bypass-pastelink-net.js "https://pastelink.net/<id>" [password]',
      '  node scrape-bypass-pastelink-net.js "https://pslk.net/<id>"          (shortlink, otomatis dibypass)',
      '',
      'Opsi:',
      '  --password <pw>      Password paste (alternatif argumen ke-2)',
      '  --timeout <ms>       Timeout per request (default 45000)',
      '  --max-attempts <n>   Maksimal percobaan (default 10)',
      '  --infinite           Terus mencoba sampai sukses (tanpa batas)',
      '  --out <file>         File output JSON (default result.json)',
      '',
    ].join('\n')
  );
}

async function runCli(argv = process.argv.slice(2)) {
  const a = cliParse(argv);
  if (a.help || !a.url) {
    if (!a.url) {
      const res = invalidTargetResult(null, 'URL target tidak diberikan.');
      try {
        fs.writeFileSync(path.resolve(a.outFile), `${JSON.stringify(res, null, 2)}\n`);
      } catch (_) {}
    }
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const result = await scrapePastelink(a.url, {
      password: a.password,
      timeout: a.timeout || undefined,
      maxAttempts: a.maxAttempts || undefined,
      infinite: a.infinite,
    });
    const json = JSON.stringify(result, null, 2);
    process.stdout.write(`${json}\n`);
    try {
      fs.writeFileSync(path.resolve(a.outFile), `${json}\n`);
      process.stderr.write(`[pastelink] Tersimpan ke ${path.resolve(a.outFile)}\n`);
    } catch (e) {
      process.stderr.write(`[pastelink] Gagal menulis ${a.outFile}: ${e.message}\n`);
    }
    process.exitCode = result.status ? 0 : 1;
  } catch (err) {
    const res = invalidTargetResult(a.url, `Kesalahan tak terduga: ${err.message}`);
    const json = JSON.stringify(res, null, 2);
    process.stdout.write(`${json}\n`);
    try {
      fs.writeFileSync(path.resolve(a.outFile), `${json}\n`);
    } catch (_) {}
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  scrapePastelink,
  parseTarget,
  CookieJar,
  resolvePslk,
  parsePastePage,
  waybackRecover,
  submitPassword,
  runCli,
  constants: {
    SERVICE_DOMAIN,
    DEFAULT_TIMEOUT,
    DEFAULT_MAX_ATTEMPTS,
    USER_AGENTS,
  },
};
