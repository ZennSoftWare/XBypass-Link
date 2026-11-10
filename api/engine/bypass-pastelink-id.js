#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

/* --------------------------------------------------------------------------
 * Konstanta engine
 * ------------------------------------------------------------------------ */
const CREATORS = "Razeerh";
const TARGET_DOMAIN = "pastelink.id";
const BASE_URL = "https://pastelink.id";

/** Rotasi User-Agent (Chrome desktop & Android — cocok untuk koneksi HP). */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
];

/* --------------------------------------------------------------------------
 * Util dasar
 * ------------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Delay backoff acak (jitter) supaya pola request tidak kaku/terdeteksi bot. */
function backoffDelay(round) {
  const base = Math.min(1500 * Math.pow(1.6, round - 1), 12000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Amb nilai angka dari env dengan default. */
function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* --------------------------------------------------------------------------
 * Cookie jar otomatis (cookie diambil LANGSUNG dari header Set-Cookie,
 * user tidak perlu mengambil/menyetel cookie secara manual)
 * ------------------------------------------------------------------------ */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  /** Simpan semua cookie dari response headers (array set-cookie). */
  ingest(headers) {
    const raw = headers["set-cookie"];
    if (!raw) return;
    (Array.isArray(raw) ? raw : [raw]).forEach((line) => {
      const pair = String(line).split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "") {
          this.cookies.delete(name);
        } else {
          this.cookies.set(name, value);
        }
      }
    });
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  reset() {
    this.cookies.clear();
  }
  get size() {
    return this.cookies.size;
  }
}

/* --------------------------------------------------------------------------
 * HTTP GET via Axios — redirect diikuti MANUAL satu-per-satu supaya
 * header Set-Cookie di TIAP hop ikut tertangkap dan langsung disalin
 * ke jar cookie (cookie diambil otomatis, bukan manual oleh user).
 * Retry otomatis untuk timeout / reset koneksi / 5xx / 429.
 * ------------------------------------------------------------------------ */
async function httpGet(url, { jar, timeoutMs, referer, attempts = 4 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let current = url;
    try {
      // IKUTI REDIRECT MANUAL (maks 10 hop)
      for (let hop = 0, maxHop = 10; hop < maxHop; hop++) {
        const headers = {
          "User-Agent": jar.ua,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          Connection: "keep-alive",
        };
        const cookie = jar.header();
        if (cookie) headers.Cookie = cookie;
        if (referer) headers.Referer = referer;

        const res = await axios.get(current, {
          headers,
          timeout: timeoutMs,
          maxRedirects: 0,      // kita ikuti sendiri -> bisa menangkap set-cookie tiap hop
          validateStatus: () => true,
          decompress: true,
          responseType: "text",
        });
        if (jar) jar.ingest(res.headers);

        const status = res.status;
        if (status >= 300 && status < 400) {
          const loc = res.headers["location"];
          if (loc) {
            current = new URL(loc, current).href;
            referer = current;
            continue; // lanjut hop berikutnya
          }
        }
        if (status === 408 || status === 429 || status >= 500) {
          throw Object.assign(
            new Error(`HTTP ${status} dari server`),
            { retryable: true }
          );
        }
        return { status, html: String(res.data || ""), finalUrl: current };
      }
      throw Object.assign(new Error("Terlalu banyak redirect"), {
        retryable: true,
      });
    } catch (err) {
      lastErr = err;
      const code = err.code || "";
      const retryable =
        err.retryable === true ||
        code === "ECONNABORTED" || // timeout
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "EAI_AGAIN" ||
        code === "ENOTFOUND" ||
        code === "EPIPE" ||
        code === "ETIMEDOUT";
      if (attempt >= attempts || !retryable) break;
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastErr || new Error("Request gagal tanpa pesan error");
}

/* --------------------------------------------------------------------------
 * Normalisasi input URL pastelink
 * Mendukung:
 *    https://pastelink.id/P1kmco
 *    http://pastelink.id/P1kmco
 *    www.pastelink.id/P1kmco
 *    pastelink.id/P1kmco
 *    P1kmco                          <- cukup ID derajat paste
 * ------------------------------------------------------------------------ */
function normalizeSourceUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;

  // buang karakter kutip/whitespace sisa copy-paste
  raw = raw.replace(/^["'<\s]+|["'>\s]+$/g, "");

  // hanya ID: "P1kmco"
  if (!/[:/.]/.test(raw) && /^[A-Za-z0-9_-]{2,64}$/.test(raw)) {
    raw = `${BASE_URL}/${raw}`;
  }
  if (!/^https?:\/\//i.test(raw)) {
    raw = raw.replace(/^\/+/, "");
    raw = `https://${raw}`;
  }

  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return null;
  }
  if (!/^(www\.)?pastelink\.id$/i.test(u.hostname)) return null;

  // paste id = segmen path pertama (abaikan subpath lain & hash)
  const seg = u.pathname.split("/").filter(Boolean);
  const id = seg.length ? seg[0] : "";
  if (!id || !/^[A-Za-z0-9_-]{2,64}$/.test(id)) return null;

  return { id, url: `${BASE_URL}/${id}` };
}

/* --------------------------------------------------------------------------
 * Deteksi halaman verifikasi anti-bot
 * ------------------------------------------------------------------------ */
function isVerificationPage(html) {
  if (!html) return false;
  return (
    html.includes('name="xlink"') ||
    html.includes('id="verif_link"') ||
    /Verifikasi Bahwa Kamu Bukan Robot/i.test(html)
  );
}

/* --------------------------------------------------------------------------
 * Ekstraksi URL dari teks konten
 * ------------------------------------------------------------------------ */
const URL_RE = /\bhttps?:\/\/[^\s"'<>`\\]+/gi;
const WWW_RE = /\bwww\.[A-Za-z0-9-]+(?:\.[A-Za-z]{2,})+(?:\/[^\s"'<>`\\]*)?/gi;

function tidyUrl(u) {
  let out = String(u).trim();
  // buang karakter penutup yang sering nempel karena konteks teks
  out = out.replace(/[.,;:!?)\]}>]+$/, (m, off, s) => {
    // jika "()" seimbang di dalam URL (mis. wiki), jangan dibuang
    const open = (s.match(/\(/g) || []).length;
    const close = (s.match(/\)/g) || []).length;
    return close > open && /[\)\]>}]+$/.test(m) ? m.replace(/[\)\]>}]/g, "") : m.replace(/[.,;:!?)\]}>]+$/, "");
  });
  return out;
}

function extractList(text) {
  const found = [];
  const push = (raw) => {
    const u = tidyUrl(raw);
    if (!u) return;
    try {
      // validitas minimum: host ada
      const parsed = new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`);
      if (!parsed.hostname.includes(".")) return;
    } catch (_) {
      return;
    }
    found.push(/^https?:\/\//i.test(u) ? u : `https://${u}`);
  };

  let m;
  const reA = new RegExp(URL_RE.source, "gi");
  while ((m = reA.exec(text)) !== null) push(m[0]);

  if (found.length === 0) {
    // fallback: URL tanpa skema (www.situs.com/jalan)
    const reW = new RegExp(WWW_RE.source, "gi");
    while ((m = reW.exec(text)) !== null) push(m[0]);
  }

  // unik, urut pertama kali muncul tetap dipertahankan
  const seen = new Set();
  const unique = [];
  for (const u of found) {
    const k = u.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(u);
    }
  }
  return unique;
}

/* --------------------------------------------------------------------------
 * Parser halaman konten (Cheerio)
 * ------------------------------------------------------------------------ */
function parsePastePage(html, sourceUrl, pasteId) {
  const $ = cheerio.load(html);

  if (isVerificationPage(html)) return { kind: "verification" };

  // ---- PAGE NOT FOUND -----------------------------------------------------
  const h1Text = ($("h1").first().text() || "").trim();
  const docTitle = ($("title").first().text() || "").trim();

  if (/404|not found|tidak ditemukan/i.test(`${docTitle} ${h1Text}`)) {
    return { kind: "not_found" };
  }

  // ---- KONTEN UTAMA -------------------------------------------------------
  // Konten paste tersimpan di <textarea id="textCnt" name="textCnt"> (server-rendered)
  let content = ($("textarea#textCnt").first().text() || "").trim();

  // Fallback ruang konten terformat (bila template berubah)
  if (!content) content = ($("#mainCnt").first().text() || "").replace(/[ \t]+\n/g, "\n").trim();
  // Fallback terakhir: elemen paste generik
  if (!content) content = ($("[id*='pasteContent'], [class*='paste-content']").first().text() || "").trim();

  if (!content && !$("textarea#textCnt").length && !$("main").length) {
    return { kind: "unknown_layout" };
  }

  // ---- JUDUL --------------------------------------------------------------
  let title = "";
  const heading = h1Text && !/^(tanpa judul|no title)$/i.test(h1Text) ? h1Text : "";
  const ogAlt = ($('meta[property="og:image:alt"]').attr("content") || "").trim();
  title = heading || ogAlt || docTitle.replace(/\s*\/\s*Pastelink$/i, "").trim() || "";

  // ---- DESKRIPSI ----------------------------------------------------------
  let description = "";
  const firstLine = content.split("\n").map((s) => s.trim()).find(Boolean) || "";
  const isUrlLine = /^https?:\/\//i.test(firstLine) || /^www\./i.test(firstLine);
  if (firstLine && !isUrlLine && firstLine.length <= 200) {
    description = firstLine;
  } else {
    const metaDesc =
      ($('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        "").trim();
    description = metaDesc;
  }

  // ---- URL ----------------------------------------------------------------
  const urls = extractList(content);

  return {
    kind: "paste",
    title: title || null,
    description: description || null,
    content,
    urls,
    publishedAt: ($('meta[property="article:published_time"]').attr("content") || null),
  };
}

/* --------------------------------------------------------------------------
 * ENGINE UTAMA — scrapePastelink(inputUrl, options)
 * Loop tahan banting: selama belum sukses & halaman bukan 404 definitif,
 * engine terus mencoba (verifikasi bypass, UA rotation, reset session).
 * ------------------------------------------------------------------------ */
async function scrapePastelink(inputUrl, options = {}) {
  const opts = {
    maxAttempts: options.maxAttempts || envInt("PASTELINK_MAX_ATTEMPTS", 12),
    timeoutMs: options.timeoutMs || envInt("PASTELINK_TIMEOUT_MS", 20000),
    quiet: options.quiet !== undefined ? options.quiet : true,
    onProgress: options.onProgress || null,
  };

  const src = normalizeSourceUrl(inputUrl);
  if (!src) {
    return failResult(
      "URL Pastelink tidak valid. Gunakan format https://pastelink.id/ID (contoh: https://pastelink.id/P1kmco)",
      String(inputUrl || ""),
      400
    );
  }

  let normalizedSource = src.url;
  let bypassedBefore = false;
  let lastHtml = "";
  let lastNotfound = false;

  for (let round = 1; round <= opts.maxAttempts; round++) {
    try {
      // Session baru -> UA baru (rotasi anti-detection), cookie diambil otomatis
      const jar = new CookieJar();
      jar.ua = pickRandom(USER_AGENTS);

      log(opts, `[putaran ${round}] GET ${normalizedSource}`);
      const r1 = await httpGet(normalizedSource, { jar, timeoutMs: opts.timeoutMs, referer: BASE_URL });
      lastHtml = r1.html;

      if (r1.status === 404) {
        lastNotfound = true;
        lastHtml = r1.html;
        break; // definitif: paste tidak ada, tidak perlu diulang terus
      }

      const parsed1 = parsePastePage(r1.html, normalizedSource, src.id);

      if (parsed1.kind === "verification") {
        log(opts, "[verifikasi] Halaman verifikasi terdeteksi, menjalankan autotobypass...");
        // >>> BYPASS: endpoint resmi situs = ?verified=1 (lihat header file)
        const verifiedUrl = (() => {
          try {
            const u = new URL(normalizedSource);
            u.searchParams.set("verified", "1");
            return u.href;
          } catch (_) {
            return `${normalizedSource}?verified=1`;
          }
        })();
        log(opts, `[putaran ${round}] BYPASS -> GET ${verifiedUrl}`);
        const r2 = await httpGet(verifiedUrl, {
          jar,
          timeoutMs: opts.timeoutMs,
          referer: normalizedSource,
        });
        bypassedBefore = true;
        lastHtml = r2.html;

        if (r2.status === 404) {
          lastNotfound = true;
          break;
        }

        const parsed2 = parsePastePage(r2.html, normalizedSource, src.id);
        if (parsed2.kind === "paste") {
          return buildResult(parsed2, {
            requiresVerification: true,
            url: normalizedSource,
            id: src.id,
          });
        }
        if (parsed2.kind === "not_found") {
          lastNotfound = true;
          break;
        }

        log(opts, `[putaran ${round}] Verifikasi belum lolos, mencoba lagi...`);
        if (round % 3 === 0) {
          log(opts, "[engine] Mereset session baru (cookie + user-agent)");
          // jar sudah di-recreate tiap putaran -> rotasi otomatis
        }
        await sleep(backoffDelay(round));
        continue;
      }

      if (parsed1.kind === "paste") {
        return buildResult(parsed1, {
          requiresVerification: bypassedBefore,
          url: normalizedSource,
          id: src.id,
        });
      }

      if (parsed1.kind === "not_found") {
        lastNotfound = true;
        break;
      }

      // unknown layout: perlakukan seperti halaman belum siap, coba lagi
      log(opts, `[putaran ${round}] Layout tidak dikenali, mencoba lagi...`);
      await sleep(backoffDelay(round));
    } catch (err) {
      log(opts, `[putaran ${round}] Error: ${err.message} — mencoba lagi...`);
      await sleep(backoffDelay(round));
    }
  }

  if (lastNotfound) {
    return failure(
      src.id,
      normalizedSource,
      "Paste tidak ditemukan (404). Kemungkinan ID salah atau paste sudah dihapus.",
      404
    );
  }

  return failure(
    src.id,
    normalizedSource,
    `Gagal melewati verifikasi / mengambil konten setelah ${opts.maxAttempts} putaran percobaan.`,
    null,
    bypassedBefore || isVerificationPage(lastHtml)
  );
}

/* --------------------------------------------------------------------------
 * Perakit hasil SUKSES (format field sesuai spesifikasi)
 * ------------------------------------------------------------------------ */
function buildResult(parsed, meta) {
  return {
    creator: CREATORS,
    status: true,
    domain: TARGET_DOMAIN,
    paste_id: meta.id,
    source_url: meta.url,
    title: parsed.title,
    description: parsed.description,
    content: parsed.content,
    urls: parsed.urls,
    target_url: parsed.urls.length ? parsed.urls[0] : null,
    total_links: parsed.urls.length,
    requires_verification: !!meta.requiresVerification,
    message:
      parsed.urls.length > 0
        ? `URL berhasil ditemukan (${parsed.urls.length} URL)`
        : "Paste berhasil diambil, namun tidak ditemukan URL di dalamnya",
  };
}

/* --------------------------------------------------------------------------
 * Perakit hasil GAGAL (struktur field tetap seragam dengan hasil sukses)
 * ------------------------------------------------------------------------ */
function failure(pasteId, sourceUrl, message, httpStatus, requiresVerification) {
  return {
    creator: CREATORS,
    status: false,
    domain: TARGET_DOMAIN,
    paste_id: pasteId || null,
    source_url: sourceUrl || "",
    title: null,
    description: null,
    content: null,
    urls: [],
    target_url: null,
    total_links: 0,
    requires_verification: !!requiresVerification,
    message,
    http_status: typeof httpStatus === "number" ? httpStatus : null,
  };
}

function failResult(message, sourceUrl, httpStatus) {
  return failure(null, sourceUrl, message, httpStatus, false);
}

/* --------------------------------------------------------------------------
 * Logger CLI (progress ditulis ke stderr, JSON hasil ke stdout)
 * ------------------------------------------------------------------------ */
function log(opts, msg) {
  if (!opts.quiet && typeof opts.onProgress === "function") {
    opts.onProgress(msg);
  } else if (!opts.quiet) {
    console.error(`[pastelink] ${msg}`);
  }
}

/* --------------------------------------------------------------------------
 * CLI — node scrape-bypasspastelink-id.js "https://pastelink.id/P1kmco"
 * ------------------------------------------------------------------------ */
async function runCli(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    const m = a.match(/^--(max-attempts|timeout|out)=(.+)$/i);
    if (m) flags[m[1].toLowerCase()] = m[2];
    else positional.push(a);
  }

  const target = positional[0] || "";
  const resultFile = flags.out || path.join(process.cwd(), "result.json");

  if (!target) {
    const usage = [
      "",
      "  BYPASS & SCRAPER pastelink.id — by Razeerh",
      "",
      "  Cara pakai :",
      '    node scrape-bypasspastelink-id.js "https://pastelink.id/P1kmco"',
      "",
      "  Opsi tambahan :",
      "    --max-attempts=12      jumlah maksimum putaran engine (default 12)",
      "    --timeout=20000        timeout HTTP per-request ms (default 20000)",
      "    --out=result.json      lokasi file hasil (default ./result.json)",
      "",
    ].join("\n");
    console.error(usage);
    const err = failResult(
      "URL target wajib diberikan. Contoh: node scrape-bypasspastelink-id.js \"https://pastelink.id/P1kmco\"",
      "",
      null
    );
    try {
      fs.writeFileSync(resultFile, JSON.stringify(err, null, 2), "utf8");
      console.error(`\n  Hasil (gagal) disimpan ke: ${resultFile}`);
    } catch (_) {}
    process.exitCode = 1;
    return;
  }

  console.log(`    ${"\u25b6"} BYPASS SCRAPER pastelink.id `);
  console.log(`    Waktu  : ${new Date().toLocaleString("id-ID", { hour12: false })}`);
  console.log(`    URL    : ${target}\n`);

  const t0 = Date.now();
  let result;
  try {
    result = await scrapePastelink(target, {
      maxAttempts: flags["max-attempts"] ? parseInt(flags["max-attempts"], 10) : undefined,
      timeoutMs: flags.timeout ? parseInt(flags.timeout, 10) : undefined,
      quiet: false,
    });
  } catch (err) {
    result = failResult(`Engine error: ${err.message}`, target, null);
  }
  const ms = Date.now() - t0;

  console.log(JSON.stringify(result, null, 2));

  try {
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf8");
    console.log(`\n  \u2714  Hasil disimpan ke ${resultFile} (${ms} ms)`);
  } catch (e) {
    console.error(`\n  ! Gagal menulis ${resultFile}: ${e.message}`);
  }

  if (!result.status) process.exitCode = 1;
}

/* --------------------------------------------------------------------------
 * Export sebagai module agar mudah diintegrasikan ke project lain
 * ------------------------------------------------------------------------ */
module.exports = {
  scrapePastelink,
  normalizeSourceUrl,
  isVerificationPage,
  parsePastePage,
  extractUrlsFromText: extractList,
  CookieJar,
  httpGet,
};

// Jalankan CLI hanya saat file dieksekusi langsung (bukan di-require)
if (require.main === module) {
  runCli(process.argv).catch((e) => {
    console.error("Fatal:", e);
    process.exitCode = 1;
  });
}
