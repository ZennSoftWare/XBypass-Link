#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

/* ------------------------------------------------------------------ */
/* Konstanta                                                           */
/* ------------------------------------------------------------------ */
const CREATOR = "Razeerh";
const TARGET_HOST = "sub2unlock.io";
const BASE_URL = "https://sub2unlock.io";
const LOCKER_TYPE = "social_content_locker";
const DESTINATION_SOURCE_HTML = "public_page_data";
const DESTINATION_SOURCE_REDIRECT = "http_redirect";

/** Domain interstitial/iklan milik jaringan iklan — BUKAN destination asli. */
const AD_HOST_PATTERNS = [
  /(^|\.)(dusarisalary\.com)$/i,
  /(^|\.)google\.com$/i, // google.com/url?...=... (cloaking hop)
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)googlesyndication\.com$/i,
];

/** User-agent pool (mobile + desktop) untuk variasi strategi retry. */
const USER_AGENTS = [
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
];

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function makeResultSkeleton() {
  return {
    status: false,
    creator: CREATOR,
    domain: TARGET_HOST,
    original_url: null,
    slug: null,
    locker_type: LOCKER_TYPE,
    page_title: "Sub2unlock",
    tasks: [],
    destination_url: null,
    destination_domain: null,
    destination_source: null,
    redirect_url: null,
    bypassed: false,
    error: null,
  };
}

/**
 * Ambil slug dari URL input.
 * Menerima: URL penuh, http/https, dengan/ tanpa query & trailing slash.
 * Return { ok, slug, url, original_url, error }
 */
function parseLockerUrl(rawUrl) {
  const result = { ok: false, slug: null, url: null, original_url: null, error: null };
  if (!rawUrl || typeof rawUrl !== "string") {
    result.error = "URL tidak disediakan";
    return result;
  }
  let s = rawUrl.trim().replace(/\s+/g, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    result.error = "URL tidak valid: " + rawUrl;
    return result;
  }

  const host = u.hostname.toLowerCase();
  if (host !== TARGET_HOST) {
    // toleransi subdomain/subhost umum, tapi tetap wajib akhiran .sub2unlock.io
    if (!(host === "www." + TARGET_HOST || host.endsWith("." + TARGET_HOST))) {
      result.error = `Domain tidak didukung: "${host}" (hanya ${TARGET_HOST})`;
      return result;
    }
  }

  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0) {
    result.error = "Slug tidak ditemukan pada URL. Contoh benar: https://sub2unlock.io/sRDiA";
    return result;
  }
  const slug = segs[0];
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(slug)) {
    result.error = `Format slug tidak valid: "${slug}"`;
    return result;
  }

  const cleanUrl = BASE_URL + "/" + slug;
  result.ok = true;
  result.slug = slug;
  result.url = cleanUrl;
  result.original_url = cleanUrl;
  result.host = host;
  return result;
}

/** Buat nilai cookie siteuserid otomatis — sama seperti JS site-nya. */
function makeSiteUserId() {
  return String(Math.floor(Math.random() * 0x882171e900));
}

/** Host adalah domain iklan/interstitial (bukan destination)? */
function isAdHost(hostname) {
  return AD_HOST_PATTERNS.some((re) => re.test(hostname || ""));
}

function stripWww(hostname) {
  return (hostname || "").replace(/^www\./i, "");
}

/* ------------------------------------------------------------------ */
/* Mapping task (label EN -> task_type snake_case)                     */
/* ------------------------------------------------------------------ */
const CLASS_FALLBACK = {
  yt: "subscribe", // YouTube
  tg: "join_telegram",
  dc: "join_discord",
  lv: "like_video",
  ig: "follow_instagram",
  fb: "follow_facebook",
  tw: "follow_twitter",
  tk: "follow_tiktok",
  vs: "visit_website",
};

/**
 * Normalisasi label tombol task menjadi task_type.
 * @param {string} label  teks tombol, mis: "Subscribe & hit bell icon"
 * @param {string} classToken  token class pertama, mis: "yt"
 */
function normalizeTaskType(label, classToken) {
  const t = (label || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (!t) return CLASS_FALLBACK[classToken] || "unknown";
  if (/2nd/.test(t) && /sub/.test(t)) return "subscribe_2nd";
  if (/(bell|hit bell)/.test(t)) return "sub_bell";
  if (/like\s*(&|and)?\s*comment/.test(t)) return "like_comment";
  if (/like\s*(&|and)?\s*sub/.test(t)) return "like_subscribe";
  if (/telegram/.test(t)) return "join_telegram";
  if (/discord/.test(t)) return "join_discord";
  if (/instagram/.test(t)) return "follow_instagram";
  if (/facebook/.test(t)) return "follow_facebook";
  if (/tiktok/.test(t)) return "follow_tiktok";
  if (/twitter/.test(t) || /\btw\b/.test(classToken || "")) return "follow_twitter";
  if (/(visit|website)/.test(t)) return "visit_website";
  if (/(like)/.test(t) && /video/.test(t)) return "like_video";
  if (/subscribe/.test(t)) return "subscribe";

  return CLASS_FALLBACK[classToken] || t.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "unknown";
}

/* ------------------------------------------------------------------ */
/* Ekstraksi dari HTML locker (cheerio)                                */
/* ------------------------------------------------------------------ */
/**
 * Parse HTML halaman locker.
 * Return null bila HTML bukan halaman locker (struktur kosong / diblok).
 * Return objek { tasks, destination_url, heading, metaRefresh, totalLocked }
 */
function extractLocker(html, baseUrl) {
  if (!html || html.length < 300) return null;

  // Deteksi halamanchallenge Cloudflare / error generik -> bukan halaman locker
  if (/Just a moment|cf-challenge|challenge-platform|Attention Required/i.test(html)) return null;

  const $ = cheerio.load(html);
  const tasks = [];

  // --- task: <a class="... locked-action-link ..." href="TARGET">label</a>
  $("a.locked-action-link").each((_, el) => {
    const a = $(el);
    const href = (a.attr("href") || "").trim();
    if (!href || href === "#") return;
    const classes = (a.attr("class") || "").split(/\s+/).filter(Boolean);
    const classToken = classes[0] || "";
    let label = a.text().replace(/\s+/g, " ").trim();
    // label DOM berisi span "Subtlepanel" (ikon) — buang pola ikon tersisa
    try {
      const clone = cheerio.load(html)(el).clone();
      clone.find("i, svg, .subtlepanel").remove();
      const clean = clone.text().replace(/\s+/g, " ").trim();
      if (clean) label = clean;
    } catch (_) { /* keep raw label */ }

    let target;
    try {
      target = new URL(href, baseUrl || BASE_URL).href;
    } catch {
      target = href;
    }

    tasks.push({
      type: normalizeTaskType(label, classToken),
      target,
      required: true, // seluruh task pada sub2unlock v2 bersifat wajib
      label,
    });
  });

  // --- destination: <a class="... get-link ..." href="DEST">
  let destination = null;
  $("a.get-link").each((_, el) => {
    if (destination) return;
    const href = ($(el).attr("href") || "").trim();
    if (href && href !== "#") destination = href;
  });

  // --- meta refresh (info redirect bila tersedia)
  let metaRefresh = null;
  const mr = $('meta[http-equiv="refresh" i]').attr("content");
  if (mr) {
    const m = /url\s*=\s*(\S+)/i.exec(mr);
    if (m) {
      try { metaRefresh = new URL(m[1], baseUrl || BASE_URL).href; } catch { metaRefresh = m[1]; }
    }
  }

  // --- judul halaman
  const docTitle = ($("title").first().text() || "").trim();
  const heading = ($("h1.apppanel-heading").first().text() || "").replace(/\s+/g, " ").trim();

  // Halaman "kosong dengan tombol unlock saja" (locker tanpa task) tetap valid
  if (tasks.length === 0 && !destination && !heading && !docTitle) return null;

  return {
    tasks,
    destination_url: destination,
    heading: heading || "Unlock Link",
    docTitle: docTitle || null,
    metaRefresh,
    totalLocked: $("a.locked-action-link").length,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP engine (axios)                                                 */
/* ------------------------------------------------------------------ */
function buildClient(timeoutMs) {
  return axios.create({
    timeout: timeoutMs,
    maxRedirects: 0,          // redirect ditangani manual agar bisa membaca Location
    validateStatus: () => true, // semua status diteruskan, diputus sendiri
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,id;q=0.8",
    },
  });
}

/** Sekali GET manual (axios), kembalikan {status, loc, data, headers} */
async function httpGet(client, url, headers) {
  const res = await client.get(url, { headers });
  return {
    status: res.status,
    loc: res.headers["location"] || null,
    data: typeof res.data === "string" ? res.data : String(res.data ?? ""),
    headers: res.headers,
  };
}

/**
 * GET locker dengan browser-headers + cookie situs (auto).
 * Mengikuti redirect INTERNAL sub2unlock; redirect eksternal/iklan dikembalikan info saja.
 */
async function fetchLockerHtml(client, slugUrl, ua, opts = {}) {
  const cookie = `siteuserid=${opts.siteuserid || makeSiteUserId()}`;
  const headers = {
    "user-agent": ua,
    referer: `${BASE_URL}/`,
    cookie,
    "x-requested-with": "XMLHttpRequest",
  };

  let current = slugUrl;
  const hops = [];
  for (let i = 0; i < 4; i++) {
    let r;
    try {
      r = await httpGet(client, current, headers);
    } catch (e) {
      return { reached: false, reason: "network_error", message: e.message, hops, url: current };
    }
    hops.push({ url: current, status: r.status, location: r.loc });

    if (r.status >= 300 && r.status < 400 && r.loc) {
      let next;
      try { next = new URL(r.loc, current).href; } catch { next = r.loc; }
      const nextHost = (() => { try { return new URL(next).hostname; } catch { return ""; } })();

      // Redirect INTERNAL sub2unlock? -> ikuti
      if (nextHost && /(^|\.)sub2unlock\.io$/i.test(nextHost)) {
        current = next;
        continue;
      }
      // Redirect ke jaringan iklan tersebut = gerbang iklan (bukan destination) -> tandai gated
      if (isAdHost(nextHost)) {
        return { reached: false, reason: "ad_gate_redirect", adLocation: next, hops, url: current };
      }
      // Redirect ke domain lain yang BUKAN iklan => bisa jadi destination asli
      return {
        reached: false,
        reason: "external_redirect",
        redirectUrl: next,
        redirectHost: nextHost,
        hops,
        url: current,
      };
    }

    // Status final
    if (r.status === 200) return { reached: true, status: r.status, html: r.data, hops, url: current };
    return { reached: false, reason: r.status === 410 || r.status === 404 ? "locker_missing" : `http_${r.status}`, status: r.status, hops, url: current };
  }
  return { reached: false, reason: "redirect_loop", hops, url: current };
}

/* ------------------------------------------------------------------ */
/* Bypass utama (loop retry selamanya bila diminta)                    */
/* ------------------------------------------------------------------ */
/**
 * Bypass satu link sub2unlock.io.
 * @param {string} lockerUrl   URL locker, mis: https://sub2unlock.io/sRDiA
 * @param {object} [opts]
 *   timeout        {number}  timeout per request (default 25000)
 *   maxCycles      {number}  batas siklus retry; omit/0 => SELALU mencoba sampai sukses
 *                             (default: selamanya — sesuai kebutuhan; set >0 agar berhenti)
 *   cycleDelayMs   {number}  jeda antar siklus (default 3000)
 *   backoffMaxMs   {number}  batas atas backoff (default 12000)
 *   out            {string}  path file result.json (default "result.json")
 *   siteuserid     {string}  override nilai cookie siteuserid
 *   log            {bool}    tampilkan log proses (default true)
 * @returns {Promise<object>} object hasil JSON lengkap
 */
async function bypassSub2Unlock(lockerUrl, opts = {}) {
  const log = opts.log !== false;
  const parsed = parseLockerUrl(lockerUrl);
  const result = makeResultSkeleton();

  /** simpan result.json (bisa dimatikan dengan opts.out=false) lalu return */
  const done = (res) => {
    if (opts.out !== false) saveResult(res, opts.out);
    return res;
  };

  if (!parsed.ok) {
    result.original_url = lockerUrl ? String(lockerUrl).trim() : lockerUrl;
    result.slug = parsed.slug;
    result.error = parsed.error;
    result.bypassed = false;
    return done(result);
  }

  result.original_url = parsed.original_url;
  result.slug = parsed.slug;

  const timeout = isNum(opts.timeout) ? Math.max(3000, opts.timeout) : 25000;
  const cycleDelayMs = isNum(opts.cycleDelayMs) ? opts.cycleDelayMs : 3000;
  const backoffMaxMs = isNum(opts.backoffMaxMs) ? opts.backoffMaxMs : 12000;
  const client = buildClient(timeout);

  const unlimited = !isNum(opts.maxCycles) || opts.maxCycles <= 0;
  const hardLimit = unlimited ? Infinity : opts.maxCycles;

  let delay = cycleDelayMs;
  let cycle = 0;
  let lastError = null;

  while (cycle < hardLimit) {
    cycle++;
    const ua = USER_AGENTS[(cycle - 1) % USER_AGENTS.length];

    if (log) console.error(`[${now()}] cycle ${cycle}${unlimited ? "" : "/" + hardLimit} — GET ${parsed.url}`);

    let page;
    try {
      page = await fetchLockerHtml(client, parsed.url, ua, { siteuserid: opts.siteuserid });
    } catch (e) {
      lastError = "network_error: " + e.message;
      if (log) console.error(`[${now()}] ${lastError}`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, backoffMaxMs);
      continue;
    }

    if (!page.reached) {
      switch (page.reason) {
        case "locker_missing":
          // 410/404: slug tidak ada / link mati. Bisa juga transien (link baru
          // butuh propagasi beberapa detik). Dalam mode unlimited, terus diulang
          // sesuai permintaan; mode terbatas berhenti pada batas siklus.
          lastError = `locker_tidak_ditemukan (HTTP ${page.status || 410}) — link mungkin telah dihapus/ kedaluwarsa`;
          if (!unlimited && cycle >= hardLimit) {
            result.error = lastError;
            result.bypassed = false;
            if (log) console.error(`[${now()}] ${lastError} (batas siklus tercapai)`);
            return done(finalize(result));
          }
          if (log) console.error(`[${now()}] ${lastError} — mencoba lagi...`);
          await sleep(delay);
          delay = Math.min(delay * 2, backoffMaxMs);
          continue;

        case "ad_gate_redirect":
          // gerbang iklan samar — cookie kita ada, tapi server kadang rotasi.
          lastError = "redirect ke gerbang iklan (" + (page.adLocation || "").slice(0, 80) + ")";
          if (log) console.error(`[${now()}] ${lastError} — pacing & retry...`);
          await sleep(delay);
          delay = Math.min(delay * 1.5, backoffMaxMs);
          continue;

        case "external_redirect": {
          // Redirect HTTP ke domain BUKAN sub2unlock & BUKAN jaringan iklan
          // => kemungkinan besar destination asli (beberapa link memang begitu).
          const dest = page.redirectUrl;
          const host = page.redirectHost;
          let dDomain = null;
          try { dDomain = stripWww(new URL(dest).hostname); } catch { dDomain = null; }
          result.destination_url = dest;
          result.destination_domain = dDomain;
          result.destination_source = DESTINATION_SOURCE_REDIRECT;
          result.redirect_url = dest;
          result.bypassed = true;
          result.status = true;
          result.error = null;
          if (log) console.error(`[${now()}] destination ditemukan via redirect (${dest})`);
          return done(finalize(result));
        }

        default:
          lastError = page.reason + (page.status ? ` (HTTP ${page.status})` : "");
          if (page.message) lastError += ": " + page.message;
          if (log) console.error(`[${now()}] ${lastError} — retry...`);
          await sleep(delay);
          delay = Math.min(delay * 1.5, backoffMaxMs);
          continue;
      }
    }

    // reached 200 -> parse
    const locker = extractLocker(page.html, BASE_URL);
    if (!locker) {
      lastError = "halaman diterima tetapi struktur locker tidak dikenali (kosong / challenge)";
      if (log) console.error(`[${now()}] ${lastError} — retry...`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, backoffMaxMs);
      continue;
    }

    result.page_title = locker.docTitle || "Sub2unlock";
    result.tasks = locker.tasks;

    if (locker.destination_url) {
      let dDomain = null;
      try { dDomain = stripWww(new URL(locker.destination_url).hostname); } catch { dDomain = null; }
      result.destination_url = locker.destination_url;
      result.destination_domain = dDomain;
      result.destination_source = DESTINATION_SOURCE_HTML;
      result.redirect_url = locker.metaRefresh || (page.hops.length > 1 ? page.hops[page.hops.length - 1].location : null) || null;
      result.bypassed = true;
      result.status = true;
      result.error = null;
      if (log) console.error(`[${now()}] SUCCESS — destination: ${locker.destination_url}`);
      return done(finalize(result));
    }

    // HTML locker sah, tapi tombol get-link tidak berisi destination
    lastError = "destination tidak ditemukan pada data publik halaman (locker tanpa link tujuan)";
    if (log) console.error(`[${now()}] ${lastError} — retry...`);
    await sleep(delay);
    delay = Math.min(delay * 1.5, backoffMaxMs);
  }

  result.error = `maksimum percobaan tercapai (${unlimited ? "tidak pernah selesai" : hardLimit}) — error terakhir: ${lastError || "tidak diketahui"}`;
  result.bypassed = false;
  result.status = false;
  return done(finalize(result));
}

/** Tulis result.json + kirim object. */
function finalize(result) {
  return result;
}

/** Simpan hasil ke file result.json di direktori kerja. */
function saveResult(result, outFile) {
  const file = outFile || "result.json";
  try {
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    fs.writeFileSync(abs, JSON.stringify(result, null, 2) + "\n", "utf8");
    return abs;
  } catch (e) {
    console.error(`[${now()}] PERINGATAN: gagal menulis ${outFile || "result.json"}: ${e.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
function parseArgv(argv) {
  const out = { args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--retries") out.retries = argv[++i];
    else if (a === "--timeout") out.timeout = parseInt(argv[++i], 10);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--quiet") out.quiet = true;
    else out.args.push(a);
  }
  return out;
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  let url = argv.args[0];

  if (!url) {
    console.log(`
Sub2unlock.io bypasser (axios + cheerio, tanpa headless browser)

Cara pakai:
  node scrape-bypass-sub2unlock-io.js "https://sub2unlock.io/sRDiA"
  opsi:
    --retries N       batas siklus retry (tanpa flag = terus mencoba sampai sukses)
    --timeout MS      timeout per request (default 25000)
    --out FILE        file output (default result.json)
    --quiet           nonaktifkan log
`);
    process.exit(1);
  }

  const opts = {
    timeout: argv.timeout,
    out: argv.out || "result.json",
    log: !argv.quiet,
    // sesuai kebutuhan: tanpa flag --retries, script terus mencoba sampai sukses
    maxCycles: argv.retries === undefined ? 0 : Math.max(0, parseInt(argv.retries, 10) || 0),
  };

  const result = await bypassSub2Unlock(url, opts);

  console.log(JSON.stringify(result, null, 2));
  const savedPath = path.isAbsolute(opts.out) ? opts.out : path.join(process.cwd(), opts.out);
  if (fs.existsSync(savedPath)) console.error(`\n[result.json tersimpan -> ${savedPath}]`);

  process.exit(result.status ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

/* ------------------------------------------------------------------ */
/* Exports untuk integrasi                                             */
/* ------------------------------------------------------------------ */
module.exports = {
  bypassSub2Unlock,
  parseLockerUrl,
  extractLocker,
  normalizeTaskType,
  makeSiteUserId,
  saveResult,
  VERSION: "1.0.0",
};
