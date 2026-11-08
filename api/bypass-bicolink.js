#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

/* ------------------------------------------------------------------ *
 *  KONSTANTA                                                         *
 * ------------------------------------------------------------------ */
const CREATOR = "Razeerh";
const SERVICE = "Bicolink";
const DOMAIN = "bicolink.com";
const TIMEOUT_MS = 30000;
const MAX_RETRIES_PER_STEP = 4;   // jangan mudah menyerah di tiap langkah
const MAX_CHAIN_HOPS = 15;       // batas aman rantai tahapan
const MAX_RESOLVE_ATTEMPTS = 6;  // berapa kali retry resolve keseluruhan

/* Daftar fingerprint browser-friendly: beberapa di antara lolos rules
 * Cloudflare bicolink (dokumentasi: UA desktop "Edge/Chrome + sec-ch-ua"). */
const BROWSER_PROFILES = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "sec-ch-ua": '"Microsoft Edge";v="131", "Not_A Brand";v="24", "Chromium";v="131"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="132", "Not_A Brand";v="24", "Google Chrome";v="132"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
  },
];

const HOST_BRIDGE_MARKERS = [
  // daftar host yang diketahui menjadi "tahapan lanjutan" bicolink
  "bicolink.com", "bicolink.xyz", "bewbin.com", "lajangspot.web.id",
];

function logDebug(enable, ...args) {
  if (!enable) return;
  console.error("[engine]", ...args);
}

/** Dump html tiap halaman rantai ke ./pages/ bila BICOLINK_DUMP=1 (debug) */
function dumpPage(no, url, html) {
  if (process.env.BICOLINK_DUMP !== "1") return;
  try {
    const dir = path.resolve(process.cwd(), "pages");
    fs.mkdirSync(dir, { recursive: true });
    let name = "page-" + String(no).padStart(2, "0") + "-" + (new URL(url).pathname.replace(/\W+/g, "_") || "root").slice(-60);
    fs.writeFileSync(path.join(dir, name + ".html"), html, "utf8");
    console.error("[dump]", no, url.slice(0, 110));
  } catch (_) { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 *  COOKIE JAR                                                        *
 * ------------------------------------------------------------------ */
class CookieJar {
  constructor() { this.jar = new Map(); }

  static domainKey(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  }

  eat(res, requestUrl) {
    const raw = res && res.headers ? res.headers["set-cookie"] : null;
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const added = [];
    for (const line of arr) {
      const parts = String(line).split(";");
      if (!parts.length) continue;
      const idx = parts[0].indexOf("=");
      if (idx < 1) continue;
      const name = parts[0].slice(0, idx).trim();
      if (!name || name.endsWith("Expires") || name === "Set-Cookie") continue;
      // cookie domain-scoped sederhana: simpan per-host persis + wildcard ".x" dibaca global
      let domain = "";
      for (const kv of parts.slice(1)) {
        const k = kv.trim().slice(0, 6).toLowerCase();
        if (k === "domain") {
          domain = kv.split("=")[1].trim().replace(/^\./, "").replace(/^www\./, "");
        }
      }
      const key = (domain || CookieJar.domainKey(requestUrl) || "global") + "::" + name;
      const v = { value: parts[0].slice(idx + 1).trim(), domain: (domain || CookieJar.domainKey(requestUrl) || "").toLowerCase() };
      if (v.value === "deleted" || /^\s*$/.test(v.value)) {
        if (v.value === "deleted") { this.jar.delete(key); continue; }
      }
      this.jar.set(key, v);
      added.push(name);
    }
    return added;
  }

  header(url) {
    const host = CookieJar.domainKey(url);
    const out = [];
    for (const [key, v] of this.jar.entries()) {
      const [d, name] = key.split("::");
      // exact host atau superdomain match
      if (!d || host === d || host.endsWith("." + d)) out.push(`${name}=${v.value}`);
    }
    return out.join("; ");
  }

  /** Emulasi document.cookie yang dipasang lewat JavaScript di halaman
   *  (dipakai halaman bridge Bewbin/WPSafeLink, bukan header Set-Cookie). */
  eatDocumentCookies(html, requestUrl) {
    if (!html || typeof html !== "string") return [];
    const added = [];
    const re = /document\.cookie\s*=\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = re.exec(html))) {
      let raw = m[2]
        .replace(/\\u002[fF]/g, "/")
        .replace(/\\x2[fF]/g, "/")
        .replace(/\\u003[dD]/g, "=")
        .replace(/\\\//g, "/");
      const eq = raw.indexOf("=");
      if (eq < 1) continue;
      const name = raw.slice(0, eq).trim();
      // potong sisa konkatenasi JS: + expires, ; path, dst.
      let value = raw.slice(eq + 1).split(/[;+]/)[0].trim().replace(/^["']|["']$/g, "");
      if (!name || /^\s*$/.test(value)) continue;
      const host = CookieJar.domainKey(requestUrl) || "global";
      const key = host + "::" + name;
      this.jar.set(key, { value, domain: host.toLowerCase() });
      added.push(name);
    }
    return added;
  }
}

/* ------------------------------------------------------------------ *
 *  HTTP CLIENT (axios-based, auto cookie, retry, rotasi UA)           *
 * ------------------------------------------------------------------ */
class SessionHttpClient {
  constructor(debug = false) {
    this.jar = new CookieJar();
    this.debug = debug;
    this.profileIdx = 0;
  }

  profile() { return BROWSER_PROFILES[this.profileIdx % BROWSER_PROFILES.length]; }

  /** one HTTP step: tidak mengikuti redirect otomatis supaya kita mencatatnya */
  async request(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    // URL relatif (contoh: /ad/linkhit?id=..) di-resolve terhadap halaman terakhir
    if (!/^https?:\/\//i.test(String(url))) {
      const ref = opts.base || this.lastUrl || "";
      const abs = absUrl(ref, url);
      if (!abs) throw new Error("URL relatif tanpa referensi: " + url);
      url = abs;
    }
    this.lastUrl = url;
    const headers = {
      "User-Agent": this.profile().ua,
      "sec-ch-ua": this.profile()["sec-ch-ua"],
      "sec-ch-ua-mobile": this.profile()["sec-ch-ua-mobile"],
      "sec-ch-ua-platform": this.profile()["sec-ch-ua-platform"],
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      ...(opts.headers || {}),
    };
    if (method === "GET") {
      headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
      headers["Sec-Fetch-Dest"] = "document";
      headers["Sec-Fetch-Mode"] = "navigate";
      headers["Sec-Fetch-Site"] = opts.sameSiteOnly ? "same-origin" : "none";
      headers["Sec-Fetch-User"] = "?1";
    } else {
      headers["Accept"] = opts.accept || "application/json, text/plain, */*";
      headers["Origin"] = opts.origin || new URL(url).origin;
      headers["Referer"] = opts.referer || url;
      headers["X-Requested-With"] = opts.xhr ? "XMLHttpRequest" : undefined;
      headers["Sec-Fetch-Dest"] = opts.dest || "empty";
      headers["Sec-Fetch-Mode"] = opts.mode || "cors";
      headers["Sec-Fetch-Site"] = "same-origin";
      if (opts.formData) {
        // bila body berupa FormData axios (multipart), jangan set content-type (biar axios yang isi boundary)
      } else if (opts.contentType !== false) {
        headers["Content-Type"] = opts.contentType || "application/x-www-form-urlencoded; charset=UTF-8";
      }
    }
    const cookie = this.jar.header(url);
    if (cookie) headers["Cookie"] = cookie;

    const lastErrs = [];
    for (let attempt = 1; attempt <= MAX_RETRIES_PER_STEP; attempt++) {
      try {
        const res = await axios({
          method,
          url,
          data: opts.body,
          headers,
          timeout: opts.timeout || TIMEOUT_MS,
          maxRedirects: 0,
          validateStatus: null, // semua status diterima
          transformResponse: (d) => d, // jangan parse otomatis
          decompress: true,
        });
        const setNames = this.jar.eat(res, url);
        logDebug(this.debug, "->", method, url.slice(0, 100), "=>", res.status, res.headers.location ? "LOC:" + res.headers.location.slice(0, 90) : "", (setNames.length ? "C:" + setNames.join(",") : ""));
        return { res, body: typeof res.data === "string" ? res.data : String(res.data == null ? "" : res.data) };
      } catch (err) {
        lastErrs.push(err.message || String(err));
        logDebug(this.debug, "retry", attempt, "err:", err.message || String(err));
        // rotasi fingerprint supaya lolos takdir challenge
        this.profileIdx++;
        await sleep(500 * attempt);
      }
    }
    throw new Error("Gagal request (semua percobaan): " + lastErrs.join(" | "));
  }

  isCloudflareChallenge(body) {
    return typeof body === "string" && (
      body.includes("_cf_chl_opt") ||
      body.includes("cf-mitigated: challenge") ||
      (body.includes("challenge-platform") && body.indexOf("chl_page") !== -1)
    );
  }
}

/* ------------------------------------------------------------------ *
 *  HELPER PARSE                                                      *
 * ------------------------------------------------------------------ */
function parseBicolink(inputUrl) {
  if (!inputUrl || typeof inputUrl !== "string") {
    const err = new Error("Input URL kosong/invalid");
    err.code = "INVALID_INPUT"; throw err;
  }
  let raw = inputUrl.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let u;
  try { u = new URL(raw); } catch (_) {
    const err = new Error("Input URL tidak valid: " + inputUrl);
    err.code = "INVALID_INPUT"; throw err;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== DOMAIN && !host.endsWith(".bicolink.com") && host !== "bicolink.xyz") {
    const err = new Error("Bukan URL Bicolink! Domain: " + host + " (diharapkan bicolink.com)");
    err.code = "NOT_BICOLINK"; throw err;
  }
  let code = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  code = code.split("/")[0].trim();
  if (!code) {
    const err = new Error("Kode shortlink tidak ada di path (contoh: https://bicolink.com/KzQ)");
    err.code = "NO_SHORT_CODE"; throw err;
  }
  return { code, host, origin: u.origin, shortUrl: `https://${u.hostname}/${code}` };
}

function absUrl(base, ref) {
  try { return new URL(ref, base).href; } catch (_) { return null; }
}

/** Dekode unwrap Google (google.com/url?q=/url=) */
function unwrapGoogle(urlText) {
  try {
    const u = new URL(urlText);
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === "/url") {
      const inner = u.searchParams.get("url") || u.searchParams.get("q");
      if (/^https?:\/\//i.test(inner || "")) return inner;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/** Ambil kode/alias shortlink dari path URL (untuk fallback field alias). */
function fieldsAliasOf(url) {
  try {
    const p = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, "")).split("/")[0];
    if (p && p.length <= 40 && !/^links$|^al$/i.test(p)) return p;
  } catch (_) { /* ignore */ }
  return "";
}

/** Catat URL di redirect_chain (tanpa duplikat berturut-turut & tanpa revisit) */
function pushChain(chain, url) {
  if (!url || typeof url !== "string") return false;
  if (/^\/\//.test(url)) url = "https:" + url;
  if (!/^https?:\/\//i.test(url)) return false;
  const last = chain[chain.length - 1];
  if (last === url) return false;
  if (chain.includes(url)) return false;
  chain.push(url);
  return true;
}

/* ------------------------------------------------------------------ *
 *  ENGINE INTI                                                       *
 * ------------------------------------------------------------------ */
class BicolinkEngine {
  constructor(options = {}) {
    this.debug = !!options.debug;
    this.http = new SessionHttpClient(this.debug);
    this.maxHops = options.maxHops || MAX_CHAIN_HOPS;
  }

  /* ---------- klasifikasi halaman shortlink ---------- */
  classifyPage($, html) {
    const hasFreeAuto = $("#ntAlFree, a.nt-al-opt-free[href]").length > 0;
    const hasPayAuto = $("a.nt-al-opt-pay[href]").length > 0;
    const payLanding = ($(".nt-pay-amount").length > 0 || ($("a.nt-pay-btn").length > 0 && html.includes("QRIS")));
    const hasGolinkForm = $("#go-link").length > 0 || html.includes("/links/go");
    const humanPage = html.includes("Verifikasi Sebentar") && html.includes("kirimUrl");
    const notFound = /<title>\s*(Not Found|Link Not Found)/i.test(html) || html.includes("Link tidak ditemukan");

    if (humanPage) return "human_gate";
    if (notFound) return "not_found";
    if (hasFreeAuto && hasPayAuto) return "auto_link";
    if (hasFreeAuto && !hasPayAuto) return "ads_link";
    if (payLanding && !hasFreeAuto) return "payment_link";
    if (hasGolinkForm) return "ads_link";
    return "unknown";
  }

  /* ---------- FLOW 1: Auto Link / Ads Link (engine utama) ---------- */
  async resolveAutoLinkFlow(code, relation) {
    const s = this.http;
    const chain = [];
    const baseUrl = relation.baseUrl;
    const origin = new URL(baseUrl).origin;
    pushChain(chain, baseUrl);

    /* STEP A: halaman shortlink utama */
    let page = await s.request(baseUrl, {});
    if (s.isCloudflareChallenge(page.body)) {
      // akui rotate fingerprint & refresh; loop retry di resolve()
      const err = new Error("cloudflare_challenge");
      err.code = "CF_CHALLENGE"; throw err;
    }
    const $page = cheerio.load(page.body);

    const freeBtn = $page("a#ntAlFree, a.nt-al-opt-free[href]").first();
    const payBtn = $page("a.nt-al-opt-pay[href]").first();
    const adUrl = freeBtn.attr("data-ad") || "";
    const adId = parseInt(freeBtn.attr("data-adid") || "0", 10);
    const payHref = payBtn.attr("href") ? absUrl(baseUrl, payBtn.attr("href")) : null;
    const freeHref = freeBtn.attr("href") ? absUrl(baseUrl, freeBtn.attr("href")) : null;
    const title = $page("title").first().text().trim();
    const linkTitle = ($page(".nt-pay-title").first().text() || title).trim();

    /* STEP B: klaasifikasi: jika hanya ada tombol payment → payment_link */
    const type = this.classifyPage($page, page.body);
    if (type === "payment_link") {
      return { chain, linkType: "payment", requiresInteraction: true, humanGate: null, nextUrl: payHref || null, status: "requires_interaction", method: "public_page_metadata" };
    }

    /* STEP C: seed AppSession: verify kosong (persis browser: turnstile fire & forget) */
    const fd = new URLSearchParams();
    fd.append("cf-turnstile-response", "");
    try {
      await s.request(`${origin}/al/verify/${code}`, {
        method: "POST",
        body: fd.toString(),
        referer: baseUrl,
        sameSiteOnly: false,
        xhr: true,
      });
    } catch (_) { /* verify gagal tetap jalan (fire and forget) */ }

    /* STEP D: kunjungi /al/free/{code} (state awal) */
    const freeUrl = freeHref || `${origin}/al/free/${code}`;
    if (freeHref) {
      try { await s.request(freeUrl, { referer: baseUrl }); } catch (_) { /* lanjut */ }
    }

    /* STEP E: pantulan klik iklan (klik-1) — image ping menyemai cookie csrfToken */
    if (adId > 0) {
      try {
        await s.request(`/ad/linkhit?id=${adId}&loc=autolink&_=${Date.now()}`, {
          headers: { Referer: baseUrl, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
          sameSiteOnly: true,
        });
      } catch (_) { /* lanjut */ }
    }

    /* STEP F: /al/free → harusnya Halaman Human Gate (nonce) */
    const hg = await s.request(freeUrl, { referer: baseUrl });
    const nonceMatch = /(?:var|let|const)?\s*nonce\s*=\s*["']([A-Za-z0-9]+)["']/.exec(hg.body);
    let finalHtml = hg.body;
    let solvedGate = false;

    if (nonceMatch && hg.body.includes("jawabanCadangan")) {
      /* STEP G: kalkulasi fallback human-gate (rumus harus sama server-side) */
      const nonce = nonceMatch[1];
      let sum = 0;
      for (let i = 0; i < nonce.length; i++) {
        sum = (sum * 31 + nonce.charCodeAt(i) + i) % 1000000007;
      }
      const ntFb = sum.toString(36);
      const fd2 = new URLSearchParams();
      fd2.append("nt_fb", ntFb);
      fd2.append("nt_dari", "tantangan");
      const verify = await s.request(`${origin}/al/verify/${code}`, {
        method: "POST",
        body: fd2.toString(),
        referer: freeUrl,
        xhr: true,
      });
      /** respons mengandung ok:true */
      solvedGate = /"ok"\s*:\s*true/.test(verify.body);
      logDebug(this.debug, "HumanGate fallback result:", verify.body.slice(0, 80), "solvedGate:", solvedGate);
    }

    /* STEP H: GET /al/free → tahap "deliver" — sering berupa bridge page/metarefresh */
    const fin = await s.request(freeUrl, { referer: freeUrl });
    finalHtml = fin.body;
    // cookie yang dipasang bridge via document.cookie (wpsafelink_go, dst)
    const dcSet = this.http.jar.eatDocumentCookies(finalHtml, freeUrl);
    if (dcSet.length) logDebug(this.debug, "document.cookie dipasang:", dcSet.join(","));

    /* Sisispkan URL ke chain bila final adalah redirect.Atau simpan html utk ekstraksi tahap lanjut */
    let nextUrl = null;
    let method = "engine_bypass";
    if (fin.res.headers.location) {
      nextUrl = absUrl(freeUrl, fin.res.headers.location);
      method = "http_redirect";
      pushChain(chain, nextUrl);
    } else if (solvedGate) {
      const extracted = this.extractNextHop(finalHtml, freeUrl, { preferWpsafeLink: true });
      if (extracted && extracted.url) {
        nextUrl = extracted.url;
        method = extracted.method;
        pushChain(chain, nextUrl);
      }
    }

    return {
      chain, linkType: type === "ads_link" ? "ads" : "auto",
      humanGate: { solved: solvedGate },
      requiresInteraction: !nextUrl,
      nextUrl,
      status: nextUrl ? "resolved" : "requires_interaction",
      method,
      finalHtml,
      title: linkTitle || title,
    };
  }

  /** ekstraksi "tahap berikutnya" dari halaman HTML (meta refresh, JS location, anchor) */
  extractNextHop(html, refererUrl, opts = {}) {
    const $ = cheerio.load(html);
    const candidates = [];

    /* 1) #wpsafe-link anchor (halaman tahap WPSafeLink/Bewbin) */
    const wl = $("div#wpsafe-link a[href]").first().attr("href");
    if (wl) candidates.push({ url: wl, method: "public_page_metadata" });

    /* 2) anchor ?geo= / ?data= (blob token WPSafeLink) */
    if (!wl) {
      const geo = $("a[href*='?geo='], a[href*='&geo=']").first().attr("href");
      if (geo) candidates.push({ url: geo, method: "public_page_metadata" });
    }

    /* 3) meta http-equiv refresh */
    const mt = $("meta[http-equiv='refresh']").first().attr("content");
    if (mt && /url=([^;]+)/i.test(mt)) {
      candidates.push({ url: mt.match(/url=([^;]+)/i)[1].replace(/['"]/g, "").trim(), method: "http_refresh" });
    }

    /* 4) window.location.href / replace / location = */
    const m2 = /window\.location\.(?:href|replace)\(\s*["']((?:https?:)?\/\/[^"']+|\/[^"']+)["']\s*\)/.exec(html);
    const m1 = /window\.location\.href\s*=\s*["']((?:https?:)?\/\/[^"']+|\/[^"']+)["']/.exec(html);
    const m3 = /\b(?:parent|top|self)?\s*\.?\s*location\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/.exec(html);
    if (m2) candidates.push({ url: m2[1], method: "public_page_metadata" });
    else if (m1) candidates.push({ url: m1[1], method: "public_page_metadata" });
    else if (m3) candidates.push({ url: m3[1], method: "public_page_metadata" });

    for (const c of candidates) {
      let url = c.url.replace(/\\u002f/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&").trim();
      if (/^javascript:/i.test(url)) continue;
      const u = absUrl(refererUrl, url);
      if (!u) continue;
      /* bedah Google redirect wrapper bila ada */
      const gw = unwrapGoogle(u);
      return gw ? { url: gw, method: "google_unwrap" } : { url: u, method: c.method };
    }
    return null;
  }

  /* ---------- FLOW 2: Ads link klasik (AdLinkFly /links/go) ---------- */
  async resolveClassicAdsFlow(code, baseUrl, $page, fieldsOverride) {
    const s = this.http;    const goForm = $page("form#go-link").first();
    if (!goForm.length) return null;
    const action = goForm.attr("action") || "/links/go";
    const fields = {};
    goForm.find("input, textarea").each((_, el) => {
      const name = $page(el).attr("name");
      if (!name) return;
      const type = ($page(el).attr("type") || "").toLowerCase();
      if (type === "submit" || type === "file" || type === "button") return;
      if (type === "checkbox" && $page(el).attr("checked") == null) return;
      fields[name] = ($page(el).attr("value") || $page(el).text() || "").trim();
    });
    if (fieldsOverride && typeof fieldsOverride === "object") {
      Object.assign(fields, fieldsOverride);
    }
    if (!fields.alias && !fields.ad_form_data) fields.alias = code || "";
    if (!fields._method && !Object.keys(fields).some((k) => k.startsWith("_method"))) fields._method = "POST";
    const postUrl = absUrl(baseUrl, action) || `${new URL(baseUrl).origin}/links/go`;

    const enc = (o) => Object.keys(o).map((k) => `${k}=${encodeURIComponent(o[k])}`).join("&");
    // varian payload — beberapa versi AdLinkFly/nonce-cake menerima bentuk beda
    const variants = [];
    variants.push(["browser-exact", enc(fields)]);
    const noMethod = { ...fields };
    delete noMethod._method;
    variants.push(["no-_method", enc(noMethod)]);
    const minimal = {};
    for (const key of ["_csrfToken", "ad_form_data", "_Token[fields]", "_Token[unlocked]", "alias"]) {
      if (noMethod[key] !== undefined) minimal[key] = noMethod[key];
    }
    variants.push(["minimal", enc(minimal)]);
    if (noMethod._csrfToken && noMethod.ad_form_data) {
      variants.push(["bare", enc({ _method: "POST", _csrfToken: noMethod._csrfToken, ad_form_data: noMethod.ad_form_data })]);
    }
    if (noMethod.ad_form_data) {
      const withAlias = { ...minimal, alias: fieldsAliasOf(baseUrl) || "" };
      variants.push(["with-alias", enc(withAlias)]);
    }

    let lastBody = "";
    // AdLinkFly go() menolak POST yang datang < counter_value detik setelah
    // render halaman — halaman reward menyandikan t=timestamp di ad_form_data.
    const rootHtml = $page.root().html() || "";
    const cvMatch = /"counter_value"\s*:\s*(\d+)/.exec(rootHtml);
    const counter = Math.max(1, parseInt(cvMatch ? cvMatch[1] : "5", 10));
    logDebug(this.debug, "menunggu countdown", (counter + 1) + "s sebelum /links/go");
    await this._timedWait(counter + 1);
    for (const [tag, body] of variants) {
      const r = await s.request(postUrl, {
        method: "POST",
        body,
        referer: baseUrl,
        xhr: true,
        accept: "application/json, text/javascript, */*; q=0.01",
      });
      lastBody = r.body || "";
      let payload = null;
      try { payload = JSON.parse(lastBody); } catch (_) { payload = null; }
      logDebug(this.debug, "/links/go [" + tag + "] =>", r.res.status, lastBody.slice(0, 120));
      if (payload && payload.status === "error" && /404/.test(String(payload.message || ""))) {
        return null; // shortlink sudah dihapus server
      }
    const target = payload && (payload.url || (payload.status === "success" && payload.message));
      if (target && /^https?:\/\//i.test(String(target).replace(/\\\//g, "/"))) {
        let url = String(target).replace(/\\\//g, "/");
        const gw = unwrapGoogle(url);
        if (gw) url = gw;
        return { url, method: "adlinkfly_links_go", requiresInteraction: false };
      }
    }
    return null;
  }

  _timedWait(seconds) {
    return sleep((seconds | 0) * 1000);
  }

  /* ---------- FLOW 3: Payment (QRIS) ---------- */
  async resolvePaymentLink(code, baseUrl, $page, html) {
    const payHref = $page("a.nt-al-opt-pay[href]").first().attr("href");
    const target = payHref ? absUrl(baseUrl, payHref) : `${baseUrl}/pay/${code}`;
    const s = this.http;
    /* ambil info halaman pembayaran agar ada info QRIS */
    let payHtml = "";
    try {
      const r = await s.request(target, { referer: baseUrl });
      payHtml = r.body;
    } catch (_) { /* tak fatal */ }
    const amount = (/nt-pay-amount[^>]*>\s*([^<]+)</.exec(payHtml) || [])[1] || (/Rp\s*[\d.,]+/.exec(html) || [])[0] || null;
    return {
      url: target,
      method: "public_page_metadata",
      requiresInteraction: true,
      payment: { amount, paidFlow: "QRIS" },
    };
  }

  /* ---------- CHAINER: telusuri tahapan tahap berikut ---------- */
  async chain(url, chainState, refererUrl, depth = 0) {
    const s = this.http;
    if (depth > this.maxHops) {
      chainState.stuckHtmlLastStage = { where: url, title: "(max hops)" };
      return;
    }
    let r;
    try {
      r = await s.request(url, { referer: refererUrl });
    } catch (e) {
      logDebug(this.debug, "chain error:", e.message);
      chainState.stuckHtmlLastStage = { where: url, title: "(error: " + e.message + ")" };
      return;
    }

    const html = r.body;
    /* cookie aktor JS (document.cookie) yang dipasang plugin WPSafeLink di hop ini */
    const dcSet = s.jar.eatDocumentCookies(html, url);
    if (dcSet.length) logDebug(this.debug, "chain document.cookie:", dcSet.join(","));

    /* 30x → rekursif */
    if (r.res.headers.location) {
      const loc = absUrl(url, r.res.headers.location);
      if (loc) {
        pushChain(chainState.chain, loc);
        await this.chain(loc, chainState, url, depth + 1);
      }
      return;
    }

    const titleTag = (/(<title>([^<]*)<\/title>)/.exec(html) || [])[2] || "";
    chainState.pages.push({ url, title: titleTag, html });
    dumpPage(chainState.pages.length, url, html);

    const next = this.extractNextHop(html, url, { preferWpsafeLink: true });
    if (next) {
      pushChain(chainState.chain, next.url);
      await this.chain(next.url, chainState, url, depth + 1);
      return;
    }

    /* bila tetap memuat "human gate" tahap kedua (bicolink-style) */
    if (html.includes("jawabanCadangan") && html.includes("kirimUrl")) {
      const nonceMatch = /(?:var|let|const)?\s*nonce\s*=\s*["']([A-Za-z0-9]+)["']/.exec(html);
      const kirimUrl = (/(?:var|let|const)?\s*kirimUrl\s*=\s*["']([^"']+)["']/.exec(html) || [])[1];
      const lanjutUrl = (/(?:var|let|const)?\s*lanjutUrl\s*=\s*["']([^"']+)["']/.exec(html) || [])[1];
      if (nonceMatch && kirimUrl) {
        let sum = 0;
        for (let i = 0; i < nonceMatch[1].length; i++) {
          sum = (sum * 31 + nonceMatch[1].charCodeAt(i) + i) % 1000000007;
        }
        const fd = new URLSearchParams();
        fd.append("nt_fb", sum.toString(36));
        fd.append("nt_dari", "tantangan");
        const vUrl = absUrl(url, kirimUrl);
        const v = await s.request(vUrl, { method: "POST", body: fd.toString(), referer: url, xhr: true });
        if (/"ok"\s*:\s*true/.test(v.body) && lanjutUrl) {
          const lu = absUrl(url, lanjutUrl);
          pushChain(chainState.chain, lu);
          await this.chain(lu, chainState, url, depth + 1);
          return;
        }
      }
      chainState.stuckHumanGate = {
        message: "Human gate tahap kedua memerlukan verifikasi tidak ortomatis.",
        where: url,
      };
      return;
    }

    /* klasik ads-link: bila halaman memuat #go-link form, POST-kan & ikuti hasilnya */
    const $ = cheerio.load(html);
    if ($("#go-link").length > 0) {
      try {
        const gor = await this.resolveClassicAdsFlow(undefined, url, $);
        if (gor && gor.url) {
          pushChain(chainState.chain, gor.url);
          chainState.method = gor.method;
          // hasil /links/go ADALAH tujuan akhir — hentikan penelusuran di sini
          chainState.terminalUrl = gor.url;
          return;
        }
      } catch (_) { /* lanjut */ }
    }

    /* Halaman "landing" WPSafeLink: kirim form-nya (GET/POST sesuai atribut)
     * untuk masuk ke halaman artikel yang memuat link ?geo=. */
    const form = $("form#wpsafelink-landing");
    if (form.length > 0) {
      const action = form.attr("action") || url;
      const fMethod = (form.attr("method") || "get").toLowerCase();
      const finUrl = absUrl(url, action) || action;
      const fields = {};
      form.find("input, select, textarea").each((_, el) => {
        const name = $(el).attr("name");
        if (!name) return;
        const type = ($(el).attr("type") || "").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          if ($(el).attr("checked") != null) fields[name] = $(el).attr("value") || "1";
          return;
        }
        if (type === "submit" || type === "file") return;
        fields[name] = $(el).attr("value") || "";
      });
      logDebug(this.debug, "wpsafelink-landing →", fMethod, finUrl.slice(0, 110));
      let goto2 = null;
      if (fMethod === "get") {
        const u = new URL(finUrl);
        for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
        goto2 = u.href;
      } else {
        const fd = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const pr = await s.request(finUrl, {
          method: "POST",
          body: fd.toString(),
          referer: url,
        });
        const prNext = this.extractNextHop(pr.body, finUrl, { preferWpsafeLink: true });
        if (prNext) goto2 = prNext.url;
        // kalau POST tidak mengarah ke mana-mana, coba GET action dengan param saja
        else {
          const u = new URL(finUrl);
          for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
          goto2 = u.href;
        }
      }
      if (goto2) {
        pushChain(chainState.chain, goto2);
        await this.chain(goto2, chainState, finUrl, depth + 1);
        return;
      }
    }

    /* Halaman "klik iklan dulu" WPSafeLink (WPSAF_ADSTEP): klik iklan itu
     * murni JS sisi-klien tanpa state server — lanjutkan dengan GET ulang
     * setelah jeda singkat (simulasi tunggu iklan). */
    if (html.includes("WPSAF_ADSTEP") || html.includes("wpsafe-generate") || /wpsafe[-_]?link[-_]?ad/i.test(html)) {
      await sleep(2500);
      const r2 = await s.request(url, { referer: refererUrl });
      const next2 = this.extractNextHop(r2.body, url, { preferWpsafeLink: true });
      if (next2) {
        pushChain(chainState.chain, next2.url);
        await this.chain(next2.url, chainState, url, depth + 1);
        return;
      }
    }

    chainState.stuckHtmlLastStage = { where: url, title: titleTag };
  }

  /* ---------- Resolver utama ---------- */
  async resolve(inputUrl) {
    const base = parseBicolink(inputUrl);
    const chain = [base.shortUrl];
    const state = {
      chain,
      method: null,
      stuckHumanGate: null,
      stuckHtmlLastStage: null,
      pages: [],
    };

    /* multiple attempt (jangan gampang nyerah — pesan user: "jangan pernah berhenti") */
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RESOLVE_ATTEMPTS; attempt++) {
      try {
        const result = await this._resolveOnce(base, state, attempt);
        if (result && result.done) return result;
        lastErr = result && result.error || new Error("resolve gagal");
        // kosongkan jar antar attempt supaya state tak bercampur
        this.http.jar = new CookieJar();
      } catch (e) {
        lastErr = e;
        logDebug(this.debug, "attempt", attempt, "error:", e.message);
        await sleep(600 * attempt);
      }
    }
    // menyerah setelah kehabisan attempt: keluarkan status gagal
    return {
      status: "failed",
      error: lastErr && lastErr.message || "gagal",
      redirectChain: state.chain,
    };
  }

  async _resolveOnce(base, chainState, attemptNo) {
    const s = this.http;
    /* ===== Tahap 1: halaman shortlink utama (ikuti 30x manual supaya tercatat) ===== */
    let firstUrl = base.shortUrl;
    let first = await s.request(firstUrl, {});
    for (let hops = 0; first.res.headers.location && hops < 6; hops++) {
      const loc = absUrl(firstUrl, first.res.headers.location);
      if (!loc || !/^https?:\/\//i.test(loc)) break;
      firstUrl = loc;
      pushChain(chainState.chain, firstUrl);
      first = await s.request(firstUrl, { referer: base.shortUrl });
    }
    if (s.isCloudflareChallenge(first.body)) {
      const err = new Error("cloudflare_challenge (coba lagi)");
      err.code = "CF"; throw err;
    }
    const $pg = cheerio.load(first.body);
    const pageClass = this.classifyPage($pg, first.body);
    logDebug(this.debug, "PAGE:", base.code, "=> class:", pageClass, " title:", $pg("title").first().text());
    chainState.pages.push({ url: firstUrl, title: $pg("title").first().text(), html: first.body });
    dumpPage(chainState.pages.length, firstUrl, first.body);

    if (pageClass === "not_found") {
      return {
        done: true,
        status: chainState.chain.length <= 1 ? "not_found" : "expired",
        linkType: null,
        requiresInteraction: false,
        destinationUrl: null,
        finalDomain: null,
        redirectChain: chainState.chain,
        redirectCount: chainState.chain.length - 1,
        resolutionMethod: null,
      };
    }

    let linkType = "ads";
    let nextUrl = null;
    let method = null;
    let requiresInteraction = false;

    if (pageClass === "auto_link" || pageClass === "ads_link") {
      const flow = await this.resolveAutoLinkFlow(base.code, { baseUrl: firstUrl, origin: base.origin });
      linkType = flow.linkType;
      nextUrl = flow.nextUrl;
      method = flow.method;
      requiresInteraction = flow.requiresInteraction;
      if (flow.chain && flow.chain.length > 1) {
        for (const u of flow.chain) pushChain(chainState.chain, u);
      }
    } else if (pageClass === "payment_link") {
      const pay = await this.resolvePaymentLink(base.code, firstUrl, $pg, first.body);
      linkType = "payment";
      nextUrl = pay.url;
      method = pay.method;
      requiresInteraction = true;
      pushChain(chainState.chain, pay.url);
    } else if (pageClass === "human_gate") {
      /* halaman pertama sudah HumanGate: langsung jalankan solve */
      const nonceMatch = /(?:var|let|const)?\s*nonce\s*=\s*["']([A-Za-z0-9]+)["']/.exec(first.body);
      const kirimUrl = (/(?:var|let|const)?\s*kirimUrl\s*=\s*["']([^"']+)["']/.exec(first.body) || [])[1];
      const lanjutUrl = (/(?:var|let|const)?\s*lanjutUrl\s*=\s*["']([^"']+)["']/.exec(first.body) || [])[1];
      if (nonceMatch && kirimUrl) {
        let sum = 0;
        for (let i = 0; i < nonceMatch[1].length; i++) sum = (sum * 31 + nonceMatch[1].charCodeAt(i) + i) % 1000000007;
        const fd = new URLSearchParams();
        fd.append("nt_fb", sum.toString(36));
        fd.append("nt_dari", "tantangan");
        await s.request(absUrl(firstUrl, kirimUrl), { method: "POST", body: fd.toString(), referer: firstUrl, xhr: true });
        if (lanjutUrl) {
          const l = absUrl(firstUrl, lanjutUrl);
          nextUrl = l;
          method = "engine_bypass";
          pushChain(chainState.chain, l);
        }
      }
    } else {
      /* unknown — coba klasik ads flow */
      const catat = await this.resolveClassicAdsFlow(base.code, firstUrl, $pg);
      if (catat) {
        linkType = "ads";
        nextUrl = catat.url;
        method = catat.method;
        pushChain(chainState.chain, nextUrl);
        chainState.terminalUrl = catat.url;
      }
    }

    if (!nextUrl) {
      return {
        done: true,
        status: requiresInteraction ? "requires_interaction" : "not_found",
        linkType,
        requiresInteraction: requiresInteraction,
        destinationUrl: null, finalDomain: null,
        redirectChain: chainState.chain,
        redirectCount: chainState.chain.length - 1,
        resolutionMethod: method,
      };
    }

    /* ===== Tahap 2: ikuti rantai tahap lanjutan ===== */
    if (chainState.terminalUrl && nextUrl === chainState.terminalUrl) {
      /* hasil /links/go sudah final — tidak ada halaman lebih lanjut */
    } else {
      await this.chain(nextUrl, chainState, base.shortUrl, 0);
    }

    /* ======= RANGKUMAN ======= */
    const chain = chainState.chain;
    const fallbackCandidate = this.scanFallbackDestinationFromPages(chainState) || this.scanFallbackDestination(first.body, base);
    let destinationUrl = chain.length > 1 ? chain[chain.length - 1] : null;
    let finalDomain = null;
    let resolutionMethod = chainState.method || method || "engine_bypass";
    let status = "resolved";
    requiresInteraction = false;

    if (destinationUrl) {
      try { finalDomain = new URL(destinationUrl).hostname.replace(/^www\./, ""); } catch (_) { }
      const isBridge = HOST_BRIDGE_MARKERS.some((h) => finalDomain && (finalDomain === h || finalDomain.endsWith("." + h)));
      if (isBridge) {
        /* masih halaman bridge: coba cari URL tujuan sesungguhnya di chain tadi */
        const external = chain.filter((u) => {
          try {
            const h = new URL(u).hostname.replace(/^www\./, "");
            return !HOST_BRIDGE_MARKERS.some((m) => h === m || h.endsWith("." + m));
          } catch (_) { return false; }
        });
        if (external.length) {
          destinationUrl = external[external.length - 1];
          finalDomain = new URL(destinationUrl).hostname.replace(/^www\./, "");
        } else {
          /* tujbridge saja yang dapat — tandai butuh interaksi lanjut */
          status = requiresInteractionParam(chainState) ? "requires_interaction" : "partial";
          requiresInteraction = true;
          if (fallbackCandidate) {
            destinationUrl = fallbackCandidate.url;
            finalDomain = new URL(fallbackCandidate.url).hostname.replace(/^www\./, "");
            status = "resolved";
            requiresInteraction = false;
          }
        }
      }
    } else if (fallbackCandidate) {
      destinationUrl = fallbackCandidate.url;
      finalDomain = new URL(fallbackCandidate.url).hostname.replace(/^www\./, "");
      status = "resolved";
    }

    if (chainState.stuckHumanGate) {
      status = "requires_interaction";
      requiresInteraction = true;
    }

    return {
      done: true,
      status,
      linkType,
      requiresInteraction,
      destinationUrl,
      finalDomain,
      redirectChain: chain,
      redirectCount: chain.length - 1,
      resolutionMethod: resolutionMethod,
      lastStage: chainState.stuckHtmlLastStage,
    };
  }

  /** memindai string HTML utk mencari URL eksternal yang look-like destination */
  scanFallbackDestination(html, base, badHex) {
    if (!html) return null;
    const urls = html.match(/https?:\/\/[^\s"'<>\\]{8,300}/g) || [];
    for (const raw of urls) {
      const url = raw.replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
      try {
        const u = new URL(url.replace(/[),.;'"]+$/, ""));
        const full = u.href;
        // URL iklan bicolink membawa kunci hex32 yang sama dgn data-ad/ntAdUrl
        if (badHex && badHex.size) {
          let skip = false;
          for (const h of badHex) { if (full.toLowerCase().includes(h)) { skip = true; break; } }
          if (skip) continue;
        }
        const host = u.hostname.replace(/^www\./, "");
        if (HOST_BRIDGE_MARKERS.some((m) => host === m || host.endsWith("." + m))) continue;
        /* hindari files aset/statik */
        if (/\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?|mp4|ico)$/i.test(u.pathname)) continue;
        /* hindari banner iklan rotator (contoh: /BICOLINK-ADS/banner/336x280/) */
        if (/(banner|\/ads?\/|\badserver\b|showad|adview|\badx\b)/i.test(u.pathname) && !/download|file|out\//i.test(u.pathname)) continue;
        /* hindari URL vendor/iklan/tracker umum */
        if (/(googletagmanager|google-analytics|fonts\.gstatic|fonts\.googleapis|cloudflare|challenges\.cloudflare|pagead2\.googlesyndication|doubleclick|amazon-adsystem|firebase|jquery|wp\.com|w\.org|gravatar|disqus|bing\.com|youtube\.com|youtu\.be|img\.youtube|t\.me\/|t\.co|facebook\.com|sharer|share\?|twitter\.com|x\.com|instagram\.com|tiktok|linkedin\.com|pinterest\.|threads\.net|reddit\.com|github\.com|whatsapp|telegram\.me|adservice|recaptcha|turnstile|microsoft\.com|apple\.com|schema\.org|amp\.dev|wakesam\.com|hilltopads|monetag|propellerads|propeller-?ads|popcash|adsterra|clickadu|exoclick|exosrv|onclasrv|zeropark|revcontent|mgid|adskeeper|criteo|pubmatic|rubiconproject|openx|casalemedia|adnxs|ads-enc|trafficstars|juicyads|plugrush|popads|popunder|\b_adc\b|ad-flex|adcash|bowlsharp|honmia)/i.test(host + u.pathname + u.search)) continue;
        return { url: u.href, via: "html_scan" };
      } catch (_) { /* skip */ }
    }
    return null;
  }

  scanFallbackDestinationFromPages(chainState) {
    /* scan dari halaman TERAKHIR yang dicapai mundur ke belakang —
     * halaman terakhir paling mungkin memuat tujuan sesungguhnya */
    const pages = (chainState && chainState.pages) || [];
    // kunci hex32 milik iklan bicolink (data-ad / ntAdUrl) → jangan dipakai sbg tujuan
    const badHex = new Set();
    for (const p of pages) {
      if (!p.html) continue;
      const nt = (p.html.match(/ntAdUrl[^"'=]*=\s*["']([^"']+)["']/) || [])[1];
      if (nt) { const h = (nt.match(/[0-9a-f]{32}/i) || [])[0]; if (h) badHex.add(h.toLowerCase()); }
      const re = /data-ad=["']([^"']+)["']/g;
      let lm;
      while ((lm = re.exec(p.html))) {
        const h = (lm[1].match(/[0-9a-f]{32}/i) || [])[0];
        if (h) badHex.add(h.toLowerCase());
      }
      const send = (p.html.match(/ntHitUrl[^"'=]*=\s*["']([^"']+)["']/) || [])[1];
      if (send) { const h = (send.match(/[0-9a-f]{32}/i) || [])[0]; if (h) badHex.add(h.toLowerCase()); }
    }
    for (let i = pages.length - 1; i >= 0; i--) {
      const hit = this.scanFallbackDestination(pages[i].html, null, badHex);
      if (hit) return hit;
    }
    return null;
  }
}

function requiresInteractionParam(chainState) {
  return !!(chainState && (chainState.stuckHumanGate || chainState.stuckHtmlLastStage));
}

/* ------------------------------------------------------------------ *
 *  PUBLIC API                                                        *
 * ------------------------------------------------------------------ */
async function bypassBicolink(inputUrl, options = {}) {
  const engine = new BicolinkEngine(options);
  const out = await engine.resolve(inputUrl);
  const res = buildResult(inputUrl, out);
  return res;
}

function buildResult(inputUrl, out) {
  let shortCode = null;
  try {
    shortCode = decodeURIComponent(new URL(inputUrl.trim().startsWith("http") ? inputUrl : "https://" + inputUrl).pathname.replace(/^\/+/, "")).split("/")[0] || null;
  } catch (_) { shortCode = null; }

  const data = {
    service: SERVICE,
    domain: DOMAIN,
    input_url: inputUrl,
    short_code: shortCode,
    link_type: out.linkType || null,
    destination_url: out.destinationUrl || null,
    final_domain: out.finalDomain || null,
    redirect_chain: out.redirectChain || [inputUrl],
    redirect_count: (out.redirectChain || [inputUrl]).length - 1,
    resolution_method: out.resolutionMethod || null,
    resolution_status: out.status || "failed",
    requires_interaction: !!out.requiresInteraction,
  };

  return {
    status: out.status === "resolved",
    creator: CREATOR,
    data,
  };
}

function humanizeStatus(out) {
  if (out.error) return out.error;
  if (out.status === "not_found") return "Shortlink tidak valid atau sudah dihapus.";
  if (out.status === "expired") return "Link kadaluarsa/tidak aktif.";
  if (out.status === "requires_interaction") return "Link membutuhkan interaksi tambahan (verifikasi/pembayaran).";
  if (out.status === "partial") return "Rantai berhenti di halaman bridge (tahap lanjut tidak dapat ditelusuri otomatis).";
  return "Resolusi tidak selesai penuh.";
}

/* ------------------------------------------------------------------ *
 *  CLI                                                               *
 * ------------------------------------------------------------------ */
function showHelp() {
  console.log(`
Penggunaan:
  node scrape-bypassbicolink.js "https://bicolink.com/KzQ" [--debug]

Flag:
  --debug   tampilkan log proses resolusi di stderr (tidak mengganggu JSON)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug") || args.includes("-d");
  const inputUrl = args.find((a) => !a.startsWith("--"));

  if (!inputUrl) {
    showHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const result = await bypassBicolink(inputUrl, { debug });
    console.log(JSON.stringify(result, null, 2));
    console.error(`[engine] selesai: ${result.data.resolution_status}`);
    if (!result.status) console.error("[engine]", humanizeStatus({ status: result.data.resolution_status }));
    try {
      const outPath = path.resolve(process.cwd(), "result.json");
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
      if (debug) console.error(`[engine] hasil tersimpan: ${outPath}`);
    } catch (e) {
      if (debug) console.error("[engine] gagal menulis result.json:", e.message);
    }
    process.exitCode = result.status ? 0 : 2;
  } catch (err) {
    const result = {
      status: false,
      creator: CREATOR,
      data: {
        service: SERVICE,
        domain: DOMAIN,
        input_url: inputUrl,
        short_code: null,
        link_type: null,
        destination_url: null,
        final_domain: null,
        redirect_chain: [inputUrl],
        redirect_count: 0,
        resolution_method: null,
        resolution_status: "failed",
        requires_interaction: false,
      },
    };
    console.log(JSON.stringify(result, null, 2));
    console.error("[engine] Error: " + (err.code === "NOT_BICOLINK" || err.code === "NO_SHORT_CODE" || err.code === "INVALID_INPUT" ? err.message : (err.message || String(err))));
    try {
      fs.writeFileSync(path.resolve(process.cwd(), "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
    } catch (_) { /* ignore */ }
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ status: false, creator: CREATOR, message: String(e && e.message) }, null, 2));
    process.exit(2);
  });
}

module.exports = {
  bypassBicolink,
  BicolinkEngine,
  CookieJar,
  parseBicolink,
  buildResult,
  CREATOR,
  SERVICE,
  DOMAIN,
};
