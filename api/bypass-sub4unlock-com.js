#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

/* ------------------------------------------------------------------ *
 * Konfigurasi
 * ------------------------------------------------------------------ */
const CREATOR = 'Razeerh';
const FALLBACK_DESCRIPTION = 'Complete the required actions to unlock the link';
const FALLBACK_TITLE = 'Sub4Unlock - Unlock Link';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULTS = {
  timeout: 30000,          // ms per request
  maxRedirectHops: 8,      // batas hop redirect destination
  retries: 2,              // retry per tahap saat network error / 5xx
  retryDelay: 1200,        // ms antar retry
  delayBetweenSteps: 300,  // ms jeda antar tahap (be polite)
  userAgent: DESKTOP_UA,
  outFile: 'result.json',
};

const JUNK_URL_RE = /cloudflareinsights|googletagmanager|google-analytics|ogads|doubleclick|gtag/i;

/* ------------------------------------------------------------------ *
 * HTTP helper (ikuti redirect manual supaya setiap hop tercatat)
 * ------------------------------------------------------------------ */
const REDIRECT_CODES = [301, 302, 303, 307, 308];

async function fetchPage(url, options = {}) {
  const {
    referer,
    timeout = DEFAULTS.timeout,
    userAgent = DEFAULTS.userAgent,
  } = options;

  const request = async (target) =>
    axios.get(target, {
      maxRedirects: 0,
      validateStatus: () => true, // 404/5xx tidak melempar error -> bisa dicatat
      timeout,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        ...(referer ? { Referer: referer } : {}),
      },
    });

  // retry sederhana untuk network error / 5xx (404 dianggap jawaban sah)
  let attempt = 0;
  let res;
  let lastErr;
  while (attempt <= DEFAULTS.retries) {
    try {
      res = await request(url);
      if (res.status >= 500 && attempt < DEFAULTS.retries) {
        await sleep(DEFAULTS.retryDelay);
        attempt += 1;
        continue;
      }
      break;
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > DEFAULTS.retries) break;
      await sleep(DEFAULTS.retryDelay);
    }
  }

  if (!res) throw new Error(`Request gagal: ${lastErr ? lastErr.message : 'unknown'}`);

  return {
    url, // URL yang diminta (sebelum follow redirect)
    status: res.status,
    headers: res.headers,
    html: typeof res.data === 'string' ? res.data : '',
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithChain(startUrl, options = {}) {
  /** Fetch + ikuti redirect HTTP hop-by-hop. Return {status, url, html, hops} */
  const chain = [];
  let current = startUrl;
  let res = null;
  for (let i = 0; i <= DEFAULTS.maxRedirectHops; i += 1) {
    res = await fetchPage(current, options);
    chain.push({ url: current, status: res.status });
    const loc = res.headers.location;
    if (REDIRECT_CODES.includes(res.status) && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    return { status: res.status, url: res.url, html: res.html, hops: chain, finalUrl: current };
  }
  return { status: res ? res.status : 0, url: res ? res.url : startUrl, html: res ? res.html : '', hops: chain, finalUrl: current };
}

/* ------------------------------------------------------------------ *
 * Parser utilitas
 * ------------------------------------------------------------------ */
function jsStringVar(html, name) {
  /** Ambil nilai string dari `var <name> = "..."` di inline <script>. */
  const re = new RegExp(`var\\s+${name}\\s*=\\s*['"]([^'"]*)['"]`, 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

function pageTitle($, fallback) {
  const t = $.html('title');
  const text = t ? cheerio.load(`<div>${t}</div>`)('title').text().trim() : '';
  return text || fallback;
}

function metaDescription($, fallback) {
  const d = $('meta[name="description"]').attr('content') ||
            $('meta[property="og:description"]').attr('content') || '';
  const clean = d.startsWith('<!--__') ? '' : d.trim();
  return clean || fallback;
}

function firstHeading(html) {
  const $ = cheerio.load(html);
  const h = $('h2').first().text().replace(/\s+/g, ' ').trim();
  return h;
}

function hostnameOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/** Deteksi platform dari URL aktivitas sosial. */
function detectPlatform(url) {
  let host = '';
  let pathname = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    pathname = u.pathname.toLowerCase();
  } catch (_) {
    return 'unknown';
  }
  if (/(^|\.)youtube\.com$|youtu\.be$/.test(host)) return 'youtube';
  if (/(^|\.)facebook\.com$|^fb\.me$|^fb\.watch$/.test(host)) return 'facebook';
  if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)t\.me$|^telegram\.me$|^telegram\.dog$/.test(host)) return 'telegram';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  if (/(^|\.)discord\.com$|^discord\.gg$/.test(host)) return 'discord';
  if (/chat\.whatsapp\.com$|whatsapp\.com$/.test(host)) return 'whatsapp';
  if (/twitter\.com$|^x\.com$/.test(host)) return 'twitter';
  if (/sociabuzz\.com$|trakte\.ir$|ko-fi\.com$/.test(host)) return 'website';
  return host || 'unknown';
}

/** Jenis aksi default berdasarkan nama variabel inline sub4unlock. */
function actionFromVarName(varName) {
  const map = {
    subscribe: 'subscribe',
    secondsubscribe: 'subscribe',
    fbfollow: 'follow',
    instafollow: 'follow',
    tkfollow: 'follow',
    instalike: 'like',
    youtubelike: 'like',
    tklike: 'like',
    telegramjoin: 'join',
    discordjoin: 'join',
    joinwhatsapp: 'join',
    cmntpost: 'comment',
    ytshare: 'visit',
  };
  return map[varName] || 'visit';
}

/** Platform default bila URL tidak dikenali, berdasarkan nama variabel. */
function platformFallbackFromVar(varName) {
  const map = {
    subscribe: 'youtube',
    secondsubscribe: 'youtube',
    fbfollow: 'facebook',
    instafollow: 'instagram',
    tkfollow: 'tiktok',
    instalike: 'instagram',
    youtubelike: 'youtube',
    tklike: 'tiktok',
    telegramjoin: 'telegram',
    discordjoin: 'discord',
    joinwhatsapp: 'whatsapp',
  };
  return map[varName] || 'website';
}

function safeHttpUrl(candidate) {
  const u = String(candidate || '').trim().replace(/^['"]|['"]$/g, '');
  if (!u || u.length < 5) return null;
  if (JUNK_URL_RE.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) {
    // relative path di dalam situs mereka (bukan destination)
    return null;
  }
  return u;
}

/** Kumpulkan semua kandidat URL dari window.open(...), var url=..., dsb. */
function extractCandidateUrls(html) {
  const found = [];
  const push = (u) => {
    const c = safeHttpUrl(u);
    if (c && !found.includes(c)) found.push(c);
  };

  // window.open('...') dan window.open('...', '_self')
  for (const m of html.matchAll(/window\.open\(\s*['"]([^'"]*)['"]/gi)) push(m[1]);

  // var url = "..."
  const varUrl = jsStringVar(html, 'url');
  if (varUrl) push(varUrl);

  // location.href = '...' / location.replace('...')
  for (const m of html.matchAll(/location\.href\s*=\s*['"]([^'"]+)['"]/gi)) push(m[1]);
  for (const m of html.matchAll(/location\.replace\(\s*['"]([^'"]+)['"]/gi)) push(m[1]);

  return found;
}

/* ------------------------------------------------------------------ *
 * Parse URL input -> { id, baseUrl }
 * Mendukung:
 *   https://sub4unlock.com/SL/1981026   (utama)
 *   https://www.sub4unlock.com/SL/1981026
 *   https://sub4unlock.com/FL.php?$=1981026&own=owner
 *   https://sub4unlock.com/FLD786.php?$=1981026&own=owner
 *   https://sub4unlock.com/LinkShortner/sub4unlock/FL?$=1981026&reff=
 *   1981026 (id saja)
 * ------------------------------------------------------------------ */
function parseInputUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL target kosong.');

  // id saja
  if (/^\d{3,}$/.test(raw)) {
    return {
      id: raw,
      originalUrl: `https://sub4unlock.com/SL/${raw}`,
      domain: 'sub4unlock.com',
      path: `/SL/${raw}`,
    };
  }

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (_) {
    throw new Error(`URL tidak valid: ${raw}`);
  }

  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!/(^|\.)sub4unlock\.com$/.test(host)) {
    throw new Error(
      `Host "sub4unlock.com" tidak dikenali untuk scraper ini (dapat: ${host}). `
      + 'Engine v2 ini khusus sub4unlock.com.'
    );
  }

  // ?$=<id> pada FL/FLD/LinkShortner
  const qId = (u.search.match(/\$=(\d+)/) || [])[1];
  if (qId) {
    return { id: qId, originalUrl: raw, domain: 'sub4unlock.com', path: u.pathname + u.search.replace(/^FL\.php/u, '') };
  }

  // /SL/<id>
  const sl = u.pathname.match(/\/SL\/(\d+)/);
  if (sl) {
    return { id: sl[1], originalUrl: raw, domain: 'sub4unlock.com', path: `/SL/${sl[1]}` };
  }

  // id di ujung path
  const tail = u.pathname.match(/(\d{4,})/);
  if (tail) {
    return { id: tail[1], originalUrl: raw, domain: 'sub4unlock.com', path: u.pathname };
  }

  throw new Error(`Tidak dapat menemukan link_id dari URL: ${raw}`);
}

/* ------------------------------------------------------------------ *
 * Engine utama
 * ------------------------------------------------------------------ */
async function scrapeSub4Unlock(inputUrl, overrides = {}) {
  const opts = { ...DEFAULTS, ...overrides };

  const parsedInput = parseInputUrl(inputUrl);
  const id = parsedInput.id;
  const base = `https://sub4unlock.com`;

  const redirectChain = []; // {url, status}
  const markChain = async (r) => {
    redirectChain.push({ url: r.url, status: r.status });
  };

  /* ---------- 1) Halaman SL publik ---------- */
  let slUrl = `${base}/SL/${id}`;
  let sl = await fetchWithChain(slUrl);
  for (const h of sl.hops) if (!redirectChain.some((x) => x.url === h.url)) redirectChain.push(h);
  if (sl.status !== 200) {
    throw new Error(`Halaman SL (${slUrl}) mengembalikan status ${sl.status}. Link mungkin sudah dihapus.`);
  }
  const slDomain = hostnameOf(sl.finalUrl);

  /* ---------- 2) Tentukan kandidat FL (halaman persyaratan) ---------- */
  // Prioritas: FL.php (desktop) -> MOBILE/FL.php -> sub4unlock.pro -> LinkShortner loader
  const slNextDirect = (sl.html.match(/window\.open\(\s*['"]([^'"]*FL\.php[^'"]*)['"]/i) || [])[1];
  const loaderVarUrl = jsStringVar(sl.html, 'url');

  const candidates = [];
  const tryPush = (u) => {
    if (!u) return;
    const abs = /^https?:\/\//i.test(u) ? u : new URL(u, base).href;
    if (!candidates.includes(abs)) candidates.push(abs);
  };

  if (slNextDirect && /sub4unlock\.com\/FL\.php/i.test(slNextDirect)) tryPush(slNextDirect);
  if (loaderVarUrl && /LinkShortner/i.test(loaderVarUrl)) tryPush(loaderVarUrl);
  if (slNextDirect) tryPush(slNextDirect);

  // fallback bila SL page tidak memberi apa-apa
  tryPush(`${base}/FL.php?$=${id}&own=owner`);
  tryPush(`${base}/MOBILE/FL.php?$=${id}&own=owner`);
  tryPush(`https://sub4unlock.pro/FL.php?$=${id}&rf=ok`);

  /* ---------- 3) Loader LinkShortner (jika ada) + halaman FL ---------- */
  let fl = null;           // halaman FL final yang berisi requirement
  let flSource = '';       // keterangan sumber
  let loader = null;

  for (const cand of candidates) {
    if (!fl && /LinkShortner/i.test(cand)) {
      loader = await fetchWithChain(cand, { referer: slUrl });
      for (const h of loader.hops) if (!redirectChain.some((x) => x.url === h.url)) redirectChain.push(h);
      flSource = 'linkshortner_loader';
      await sleep(opts.delayBetweenSteps);

      // Ambil URL FL riil dari loader (window.open FL.php / MOBILE / pro)
      const loaderTargets = extractCandidateUrls(loader.html)
        .filter((u) => /FL\.php/i.test(u) && !/LinkShortner/i.test(u));
      const priority = loaderTargets.filter((u) => /sub4unlock\.com\/FL\.php/i.test(u));
      const mobileP = loaderTargets.filter((u) => /MOBILE\/FL\.php/i.test(u));
      const proP = loaderTargets.filter((u) => /sub4unlock\.pro\//i.test(u));
      const ordered = [...priority, ...mobileP, ...proP];

      for (const target of ordered) {
        const t = await fetchWithChain(target, { referer: cand });
        for (const h of t.hops) if (!redirectChain.some((x) => x.url === h.url)) redirectChain.push(h);
        if (t.status === 200 && extractCandidateUrls(t.html).some((u) => /FLD/i.test(u))) {
          fl = t;
          flSource = 'fl_from_loader';
          break;
        }
        await sleep(opts.delayBetweenSteps);
      }
      break; // hanya satu loader
    }
  }

  if (!fl) {
    for (const cand of candidates.filter((c) => /FL\.php/i.test(c) && !/LinkShortner/i.test(c))) {
      const t = await fetchWithChain(cand, { referer: slUrl });
      for (const h of t.hops) if (!redirectChain.some((x) => x.url === h.url)) redirectChain.push(h);
      if (t.status === 200 && /FLD/i.test(t.html)) {
        fl = t;
        flSource = 'fl_direct';
        break;
      }
      await sleep(opts.delayBetweenSteps);
    }
  }

  if (!fl) {
    throw new Error('Halaman persyaratan (FL.php) tidak ditemukan/mengembalikan halaman kosong. Link mungkin kedaluwarsa.');
  }

  /* ---------- 4) Parse persyaratan + FLD target dari FL ---------- */
  const $fl = cheerio.load(fl.html);
  const VAR_NAMES = [
    'subscribe', 'secondsubscribe', 'fbfollow', 'instafollow', 'tkfollow',
    'instalike', 'youtubelike', 'tklike', 'telegramjoin', 'discordjoin',
    'joinwhatsapp', 'cmntpost', 'ytshare',
  ];
  const requirements = [];
  for (const v of VAR_NAMES) {
    const val = jsStringVar(fl.html, v);
    if (!val || val.length < 4) continue;
    requirements.push({
      platform: detectPlatform(val),
      action_type: actionFromVarName(v),
      action_url: val,
      _var: v,
      _fallback_platform: platformFallbackFromVar(v),
    });
  }

  // FLD = halaman "Your Link is Ready" (dinamis, e.g. FLD786.php)
  let fldUrl = null;
  const fun9Block = (fl.html.match(/function\s+fun9\s*\(\)[\s\S]{0,800}?\}\s*/i) || [])[0] || '';
  const fldFromFun9 = (fun9Block.match(/window\.open\(\s*['"]([^'"]*FLD[^'"]*)['"]/i) || [])[1];
  if (fldFromFun9) {
    fldUrl = /^https?:\/\//i.test(fldFromFun9) ? fldFromFun9 : new URL(fldFromFun9, base).href;
  } else {
    const fldDirect = (fl.html.match(/(https?:\/\/[^\s'"]*FLD\d*\.php\?\$=\d+[^\s'"]*)/i) || [])[1];
    if (fldDirect) fldUrl = fldDirect;
    else fldUrl = `${base}/FLD786.php?$=${id}&own=owner`; // fallback konvensional
  }

  await sleep(opts.delayBetweenSteps);
  let fld = await fetchWithChain(fldUrl, { referer: fl.url });
  for (const h of fld.hops) if (!redirectChain.some((x) => x.url === h.url)) redirectChain.push(h);

  /* ---------- 5) Destination dari FLD ---------- */
  let destination = null;
  const fldCandidates = extractCandidateUrls(fld.html).filter((u) => {
    // destination bukan salah satu URL internal FL/FLD
    return !/FL\.php|FLD\d*\.php|LinkShortner/i.test(u);
  });
  if (fldCandidates.length > 0) destination = fldCandidates[0];

  let resolutionMethod = destination ? 'inline_js_window_open' : 'public_page_data';
  let destinationStatus = null;

  if (!destination) {
    // fallback: data publik meta/og di FLD & FL
    const $fld = cheerio.load(fld.html);
    const og = $fld('meta[property="og:url"]').attr('content') || '';
    const canon = $fld('link[rel="canonical"]').attr('href') || '';
    const candMeta = [og, canon].filter((u) => safeHttpUrl(u) && !/FL\.php|FLD/i.test(u));
    if (candMeta[0]) {
      destination = candMeta[0];
      resolutionMethod = 'public_page_data';
    }
  }

  /* ---------- 6) Resolve redirect destination (hop-by-hop) ---------- */
  let finalSight = destination;
  if (destination) {
    await sleep(opts.delayBetweenSteps);
    try {
      const destRes = await fetchWithChain(destination, { referer: fld.url });
      for (const h of destRes.hops) {
        if (!redirectChain.some((x) => x.url === h.url)) redirectChain.push(h);
      }
      destinationStatus = destRes.status;
      finalSight = destRes.finalUrl;
    } catch (_err) {
      // network gagal -> destination tetap apa adanya (catat status null)
      destinationStatus = null;
    }
  }

  /* ---------- 7) Metadata halaman ---------- */
  const pageDesc = metaDescription($fl, '') || metaDescription(cheerio.load(fld.html), '');
  const pageDescription = pageDesc || FALLBACK_DESCRIPTION;
  const pageTitle_ =
    firstHeading(fl.html).length > 0
      ? (pageTitle($fl, FALLBACK_TITLE) + '').trim()
      : pageTitle($fl, FALLBACK_TITLE);

  const requirementsOut = requirements.map((r) => ({
    platform: r.platform,
    action_type: r.action_type,
    action_url: r.action_url,
  }));

  const result = {
    status: true,
    creator: CREATOR,
    original_url: parsedInput.originalUrl,
    domain: slDomain || 'sub4unlock.com',
    path: parsedInput.path,
    link_id: id,
    page: {
      title: pageTitle_ || FALLBACK_TITLE,
      description: pageDescription,
    },
    requirements: requirementsOut,
    destination_url: destination,
    destination_domain: destination ? hostnameOf(destination) : null,
    redirect_chain: redirectChain,
    resolver: {
      method: resolutionMethod,
      requires_manual_interaction: false,
      ...(destinationStatus !== null ? { destination_http_status: destinationStatus } : {}),
      ...(destinationStatus !== null && destinationStatus !== 200
        ? { note: `destination menanggapi HTTP ${destinationStatus}; slug/tautan tujuan kemungkinan kedaluwarsa atau dihapus` }
        : {}),
    },
    fetched_at: new Date().toISOString(),
    _debug: {
      fl_source: flSource,
      fld_url: fldUrl,
      destination_final_sight: finalSight,
      requirements_raw: requirements.length,
      loader_used: Boolean(loader),
    },
  };

  // Baris requirement praktis "tanpa fallback aneh" bila platform URL gagal dideteksi
  if (requirements.length === 0) {
    result.page.description =
      metaDescription($fl, '') || firstHeading(fl.html) || FALLBACK_DESCRIPTION;
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseCliArgs(argv) {
  const args = { help: false, quiet: false, outFile: DEFAULTS.outFile, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-q' || a === '--quiet') args.quiet = true;
    else if (a === '-o' || a === '--out') {
      args.outFile = argv[i + 1] || DEFAULTS.outFile;
      i += 1;
    } else args.positional.push(a);
  }
  return args;
}

function printHelp() {
  console.log(`
Sub4Unlock Bypass Scraper v2 (axios + cheerio, tanpa headless browser)

Pemakaian:
  node scrape-bypass-sub4unlock-v2.js "<URL>" [--out result.json] [--quiet]

Contoh:
  node scrape-bypass-sub4unlock-v2.js "https://sub4unlock.com/SL/1981026"
  node scrape-bypass-sub4unlock-v2.js "https://sub4unlock.com/SL/1490070" -o hasil.json

Format URL yang didukung:
  https://sub4unlock.com/SL/<id>
  https://sub4unlock.com/FL.php?$=<id>&own=owner
  https://sub4unlock.com/LinkShortner/sub4unlock/FL?$=<id>&reff=
  <id> (angka saja, mis. 1981026)

Opsi:
  -o, --out <file>   Path file hasil (default: result.json)
  -q, --quiet        Jangan cetak JSON ke stdout
  -h, --help         Tampilkan bantuan
`);
}

async function runCli() {
  const argv = process.argv.slice(2);
  const args = parseCliArgs(argv);

  if (args.help || args.positional.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const target = args.positional[0];
  try {
    const result = await scrapeSub4Unlock(target);
    const outPath = path.isAbsolute(args.outFile)
      ? args.outFile
      : path.join(process.cwd(), args.outFile);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

    if (!args.quiet) console.log(JSON.stringify(result, null, 2));
    const dest = result.destination_url
      ? result.destination_url
      : '(tidak ditemukan)';
    process.stderr.write(
      `\n[OK] result tersimpan: ${outPath}\n[OK] destination: ${dest}\n`
    );
    process.exit(0);
  } catch (err) {
    const fail = {
      status: false,
      creator: CREATOR,
      original_url: target,
      error: err.message || String(err),
      fetched_at: new Date().toISOString(),
    };
    const outPath = path.isAbsolute(args.outFile)
      ? args.outFile
      : path.join(process.cwd(), args.outFile);
    fs.writeFileSync(outPath, JSON.stringify(fail, null, 2), 'utf8');
    if (!args.quiet) console.log(JSON.stringify(fail, null, 2));
    process.stderr.write(`\n[ERR] ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  scrapeSub4Unlock,
  parseInputUrl,
  detectPlatform,
  actionFromVarName,
  DEFAULTS,
};
