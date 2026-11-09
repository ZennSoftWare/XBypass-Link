#!/usr/bin/env node
/* ============================================================
 * lib/url-validator.js — XBypass
 * ============================================================
 * Modul validasi URL + perlindungan SSRF (CommonJS).
 *
 * Rangkaian pemeriksaan:
 *   - Format URL dan protokol (hanya http/https).
 *   - Hostname: dot diwajibkan, bentuk host mencurigakan ditolak.
 *   - Domain harus terdaftar pada daftar provider (mirroring data/bypass.js,
 *     yang berformat ES Modules dan TIDAK boleh di-require dari backend CJS —
 *     karena itu daftar domain dipertahankan eksplisit di file ini dan
 *     dirawat paralel dengan konfigurasi provider).
 *   - Tidak boleh berisi username/password (kredensial).
 *   - Anti-SSRF: menolak localhost, alamat internal/private/loopback/
 *     link-local/reserved (IPv4 & IPv6, termasuk bentuk desimal/heksa
 *     dan IPv4-mapped/NAT64/Teredo/6to4 di IPv6).
 *   - Pemeriksaan DNS opsional sebelum koneksi keluar (verifyDnsPublicHost)
 *     dan validasi URL target/redirect (validateTargetUrl).
 *
 * Pencocokan domain memakai perbandingan tepat:
 *     hostname === domain || hostname.endsWith("." + domain)
 * (bukan substring biasa, agar "notsub2unlock.me" tidak lolos).
 *
 * Hasil validasi memakai bentuk objek seragam:
 *     { ok: true,  url, hostname, protocol }
 *     { ok: false, reason: <KODE>, message }
 * ============================================================ */
'use strict';

const dns = require('node:dns');
const net = require('node:net');

/* ==================================================================== */
/* Konfigurasi dasar                                                     */
/* ==================================================================== */

const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Daftar domain yang didukung — ditarik dari BYPASS_PROVIDERS di data/bypass.js
 * (file ES Modules; backend CJS tidak men-require-nya, melainkan menyalin
 * daftarnya secara eksplisit agar tidak ada perbedaan).
 * Setiap tambahan/penonaktifan di data/bypass.js WAJIB dicerminkan di sini.
 */
const SUPPORTED_DOMAINS = Object.freeze([
  'sub2unlock.me',    // provider "Sub2Unlock.me"  → /api/bypass-sub2unlock-me
  'sub2unlock.io',    // provider "Sub2Unlock.io"  → /api/bypass-sub2unlock-io
  'bicolink.com',     // provider "Bicolink.com"   → /api/bypass-bicolink
  'pastelink.net',    // provider "pastelink.net"  → /api/bypass-pastelink-net
  'pastelink.id',     // provider "Pastelink.id"   → /api/bypass-pastelink-id
  'shrinkme.io',      // provider "shrinkme.io"    → /api/bypass-shrinkme
  'safelinku.com',    // provider "SFL"            → /api/bypass-sfl
  'linkvertise.com',  // provider "Linkvertise"    → /api/bypass-linkvertise (CATATAN: file api/ belum ada; konsisten dengan config)
  'subs4unlock.id',   // provider "Subs4unlock.id" → /api/bypass-subs4unlock-id
  'sub4unlock.com',   // provider "Sub4Unlock.com" → /api/bypass-sub4unlock-com
  'subs4unlock.com',  // provider "Subs4Unlock.com"→ /api/bypass-subs4unlock-com
]);

/* Alasan rejection yang stabil (kode yang dipakai response-handler) */
const REASONS = {
  EMPTY_URL: 'EMPTY_URL',
  INVALID_URL: 'INVALID_URL',
  BAD_PROTOCOL: 'BAD_PROTOCOL',
  BAD_PORT: 'BAD_PORT',
  CREDENTIALS: 'CREDENTIALS',
  BLOCKED_ADDRESS: 'BLOCKED_ADDRESS',
  SUSPICIOUS_HOST: 'SUSPICIOUS_HOST',
  UNSUPPORTED_DOMAIN: 'UNSUPPORTED_DOMAIN',
  NO_TARGET_URL: 'NO_TARGET_URL',
  INVALID_TARGET: 'INVALID_TARGET',
  DNS_FAILURE: 'DNS_FAILURE',
  DNS_PRIVATE_ADDRESS: 'DNS_PRIVATE_ADDRESS',
};

/* ==================================================================== */
/* Util internal                                                         */
/* ==================================================================== */

function normalizeHostname(raw) {
  let h = String(raw || '').trim().toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1); // hilangkan trailing dot ("sub2unlock.me.")
  return h;
}

function fail(reason, message) {
  return { ok: false, reason, message };
}

/* ==================================================================== */
/* Klasifikasi alamat (anti-SSRF)                                        */
/* ==================================================================== */

/**
 * Parse IPv4 dengan ketat:
 *  - 4 kelompok desimal 0..255, tanpa leading zero (tolak "0177.0.0.1").
 *  - Mendukung bentuk integer murni ("2130706433") dan heksa murni
 *    ("0x7f000001") supaya bentuk-bentuk itu ikut diklasifikasi, bukan
 *    lolos sebagai "hostname".
 * @returns {number[]|null} [a,b,c,d]
 */
function parseIPv4Strict(host) {
  if (typeof host !== 'string') return null;
  const parts = host.split('.');

  if (parts.length === 4) {
    const out = [];
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      if (p.length > 1 && p[0] === '0') return null; // tolak oktal/leading-zero
      const n = Number(p);
      if (n > 255) return null;
      out.push(n);
    }
    return out;
  }

  // satu kelompok murni numerik → anggap literal IPv4 (bukan nama domain)
  if (parts.length === 1) {
    const p = parts[0];
    if (/^\d+$/.test(p)) {
      const int = Number(p);
      if (!Number.isSafeInteger(int) || int < 0 || int > 4294967295) return null;
      return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255];
    }
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) {
      const int = parseInt(p, 16);
      if (!Number.isSafeInteger(int) || int < 0 || int > 4294967295) return null;
      return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255];
    }
  }
  return null;
}

/**
 * @param {number[]} octets [a,b,c,d]
 */
function isPublicIPv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return false;
  const [a, b, c] = octets;

  if (a === 0) return false;                                  // 0.0.0.0/8 "this network"
  if (a === 10) return false;                                 // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return false;         // 100.64/10 CGNAT shared
  if (a === 127) return false;                                // 127/8 loopback
  if (a === 169 && b === 254) return false;                   // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return false;          // 172.16/12 private
  if (a === 192 && b === 0 && c === 0) return false;          // 192.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return false;          // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;        // 192.88.99/24 6to4 relay anycast
  if (a === 192 && b === 168) return false;                   // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return false;      // 198.18/15 benchmark
  if (a === 198 && b === 51 && c === 100) return false;       // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;        // 203.0.113/24 TEST-NET-3
  if (a === 224 || a === 239) return false;                   // 224/4 & 239/4 (multicast)
  if (a >= 240) return false;                                 // 240/4 reserved + broadcast
  return true;
}

/**
 * Ekspansi grup IPv6 menjadi 8 nilai 16-bit.
 * Str input harus lolos net.isIP(str) === 6 (tanpa zone index).
 * @returns {number[]|null}
 */
function expandIPv6(str) {
  if (!str || typeof str !== 'string') return null;
  if (net.isIP(str) !== 6) return null;

  const toGroups = (part) => {
    const out = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        // format IPv4 di bagian akhir (contoh ::ffff:127.0.0.1)
        const v4 = parseIPv4Strict(g);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        const n = parseInt(g, 16);
        if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
        out.push(n);
      }
    }
    return out;
  };

  let head, tail;
  if (str.includes('::')) {
    const halves = str.split('::');
    if (halves.length !== 2) return null; // "::" boleh muncul maks 1x
    head = halves[0] ? toGroups(halves[0]) : [];
    tail = halves[1] ? toGroups(halves[1]) : [];
    if (!head || !tail) return null;
  } else {
    head = toGroups(str);
    tail = [];
    if (!head) return null;
  }

  if (head.length + tail.length > 8) return null;
  const zeros = [];
  for (let i = head.length + tail.length; i < 8; i++) zeros.push(0);
  const g = [...head, ...zeros, ...tail];
  if (g.length !== 8) return null;
  return g;
}

/**
 * Klasifikasi rentang IPv6.
 * @param {number[]} groups 8 nilai 16-bit
 */
function isPublicIPv6(groups) {
  if (!groups || groups.length !== 8) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const allZero = (arr) => arr.every((v) => v === 0);

  // embedded IPv4 helper (cek 4 byte terakhir)
  const v4At = (hi, lo) =>
    isPublicIPv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255]);

  if (allZero(groups)) return false;                        // :: (unspecified)
  if (allZero(groups.slice(0, 7)) && g7 === 1) return false; // ::1 loopback

  // ::ffff:0:0/96 IPv4-mapped → IPv4 disimpan pada g6,g7 (dua oktet / pasangan)
  if (allZero([g0, g1, g2, g3, g4]) && g5 === 0xffff) return v4At(g6, g7);

  // ::/96 IPv4-compatible (deprecated) → cek embedded IPv4 pada g6,g7
  if (allZero([g0, g1, g2, g3, g4, g5]) && (g6 !== 0 || g7 !== 0)) return v4At(g6, g7);

  // 64:ff9b::/96 & 64:ff9b:1::/48 (NAT64) → cek embedded IPv4
  if (g0 === 0x0064 && g1 === 0xff9b) {
    if (g2 === 0 && allZero([g3, g4, g5])) return v4At(g6, g7);
    if (g2 === 1 && allZero([g3, g4])) return v4At(g6, g7);
    return false;
  }

  if (g0 === 0x2002) return false;                          // 2002::/16 6to4 (deprecated)
  if (g0 === 0x2001 && g1 === 0) return false;              // 2001:0::/32 Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return false;         // 2001:db8::/32 documentation
  if (g0 === 0x2001 && (g1 & 0xfe00) === 0) return false;   // 2001::/23 IETF reserved
  if (g0 === 0x0200 && allZero([g1, g2, g3])) return false; // 100::/64 discard-only
  if (g0 === 0x0200) return false;                          // 0100::/8 unassigned-belakangan? sifatnya non-publik
  if ((g0 & 0xffc0) === 0xfe80) return false;               // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return false;               // fc00::/7 ULA private
  if ((g0 & 0xff00) === 0xff00) return false;               // ff00::/8 multicast
  return true;
}

/** Strip format literal IPv6 "[...]" dan zone index "%eth0" */
function stripIPv6Literal(host) {
  let h = String(host || '').trim();
  if (h.startsWith('[')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);
  return h;
}

/**
 * isPublicAddress — apakah alamat ini layak untuk koneksi keluar?
 * Menolak localhost, IP privat, loopback, link-local, reserved,
 * CGNAT, jaringan dokumentasi, multicast, broadcast, bentuk heksa,
 * nama tanpa dot, dll. Memeriksa IPv4 (desimal/heksa/integer) & IPv6.
 *
 * @param {string} hostname — hostname polos ATAU literal IP (boleh ber-bracket)
 * @returns {boolean}
 */
function isPublicAddress(hostname) {
  if (typeof hostname !== 'string') return false;
  let host = hostname.trim().toLowerCase();
  if (!host) return false;

  host = stripIPv6Literal(normalizeHostname(host));
  if (!host) return false;

  // IPv6 literal
  if (host.includes(':')) {
    if (net.isIP(host) !== 6) return false;
    const g = expandIPv6(host);
    return g ? isPublicIPv6(g) : false;
  }

  // Bentuk numerik murni (semua digit/koma/hex) → literal IPv4
  if (/^[\d.]+$/.test(host)) {
    const v4 = parseIPv4Strict(host);
    return v4 ? isPublicIPv4(v4) : false;
  }

  // Host dengan komponen hex ("0x7f.0.0.1") — bukan nama domain sah
  if (host.split('.').some((part) => /^0[xX]/.test(part))) return false;

  // net.isIP sukses → pakai parser ketat
  const ipKind = net.isIP(host);
  if (ipKind === 4) {
    const v4 = parseIPv4Strict(host);
    return v4 ? isPublicIPv4(v4) : false;
  }
  if (ipKind === 6) {
    const g = expandIPv6(host);
    return g ? isPublicIPv6(g) : false;
  }

  // Nama domain tanpa dot (single-label) tidak dipercaya
  if (!host.includes('.')) return false;

  return true;
}

/* ==================================================================== */
/* Pencocokan domain yang diizinkan                                      */
/* ==================================================================== */

/**
 * Pencocokan tepat: hostname === domain || hostname.endsWith("." + domain)
 * Bukan substring biasa — "notsub2unlock.me" / "sub2unlock.me.evil.com"
 * tidak pernah lolos.
 */
function hostnameMatchesDomain(hostname, domain) {
  const h = normalizeHostname(hostname);
  const d = normalizeHostname(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith('.' + d);
}

function isSupportedDomain(hostname, allowed) {
  const list = Array.isArray(allowed) && allowed.length ? allowed : SUPPORTED_DOMAINS;
  return list.some((d) => hostnameMatchesDomain(hostname, d));
}

/* ==================================================================== */
/* Parser URL dasar                                                      */
/* ==================================================================== */

/**
 * parseHttpUrl — parse URL dengan pemeriksaan dasar:
 * protokol http/https, tanpa kredensial, port standar.
 *
 * @param {string} raw
 * @returns {{ok:true,url:URL,hostname:string,protocol:string}
 *           |{ok:false,reason:string,message:string}}
 */
function parseHttpUrl(raw) {
  if (typeof raw !== 'string') return fail(REASONS.INVALID_URL, 'URL harus berupa teks.');

  const candidate = raw.trim();
  if (!candidate) return fail(REASONS.EMPTY_URL, 'Link masih kosong. Tempel terlebih dahulu.');
  if (candidate.length > MAX_URL_LENGTH) {
    return fail(REASONS.INVALID_URL, 'URL terlalu panjang.');
  }
  if (/[\s\u0000-\u001f\u007f]/.test(candidate)) {
    return fail(REASONS.INVALID_URL, 'URL mengandung spasi atau karakter terlarang.');
  }
  if (candidate.includes('\\')) {
    return fail(REASONS.INVALID_URL, 'URL mengandung karakter backslash yang tidak boleh.');
  }

  let url;
  try {
    url = new URL(candidate);
  } catch (_) {
    return fail(REASONS.INVALID_URL, 'Format link tidak valid.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return fail(REASONS.BAD_PROTOCOL, 'Protokol harus http atau https.');
  }
  if (url.username || url.password) {
    return fail(REASONS.CREDENTIALS, 'URL dengan username/password tidak diizinkan.');
  }
  if (!url.hostname) {
    return fail(REASONS.INVALID_URL, 'Hostname URL tidak valid.');
  }

  // Port standar saja (per protocol) — mempersempit permukaan koneksi keluar
  const port = url.port;
  if (port) {
    const httpPort = port === '80' && url.protocol === 'http:';
    const httpsPort = port === '443' && url.protocol === 'https:';
    if (!httpPort && !httpsPort) {
      return fail(REASONS.BAD_PORT, 'Port non-standar tidak diizinkan.');
    }
  }

  return { ok: true, url, hostname: normalizeHostname(url.hostname), protocol: url.protocol.replace(':', '') };
}

/* ==================================================================== */
/* Validasi tingkat tinggi                                               */
/* ==================================================================== */

/**
 * validateIncomingUrl — validasi URL yang dikirim pengguna (link input).
 * MEMERLUKAN: domain harus termasuk provider yang didukung.
 *
 * @param {string} raw
 */
function validateIncomingUrl(raw) {
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return parsed;

  const { url, hostname } = parsed;

  if (!isPublicAddress(hostname)) {
    return fail(REASONS.BLOCKED_ADDRESS, 'Alamat localhost/internal tidak diizinkan.');
  }
  const bareHost = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (!net.isIP(bareHost) && !bareHost.includes('.')) {
    return fail(REASONS.SUSPICIOUS_HOST, 'Hostname tidak valid.');
  }
  if (!isSupportedDomain(hostname)) {
    return fail(REASONS.UNSUPPORTED_DOMAIN, 'Domain ini belum didukung. Lihat daftar Bypass yang Didukung.');
  }

  return { ok: true, url, hostname, protocol: parsed.protocol };
}

/**
 * validateTargetUrl — validasi URL hasil redirect / link target
 * sebelum dipakai adapter API. TIDAK mencocokkan dengan allowlist
 * provider (target bisa berasal dari domain mana pun yang publik),
 * tetapi tetap menolak:
 *   - protokol selain http/https,
 *   - kredensial (user:pass@),
 *   - port non-standar,
 *   - alamat internal/private (anti-SSRF).
 *
 * @param {string} raw
 */
function validateTargetUrl(raw) {
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) {
    // samakan nama kode target agar konsisten di lapisan adapter
    if (parsed.reason === REASONS.EMPTY_URL) {
      return fail('NO_TARGET_URL', 'Link tujuan tidak tersedia.');
    }
    return {
      ok: false,
      reason: REASONS.INVALID_TARGET,
      message: 'Link tujuan bukan URL yang valid.',
      origin: parsed,
    };
  }

  if (!isPublicAddress(parsed.hostname)) {
    return fail(REASONS.BLOCKED_ADDRESS, 'Link tujuan mengarah ke alamat internal dan ditolak.');
  }

  return { ok: true, url: parsed.url, hostname: parsed.hostname, protocol: parsed.protocol };
}

/* ==================================================================== */
/* Pemeriksaan DNS (sebelum koneksi keluar, apabila diperlukan)           */
/* ==================================================================== */

/**
 * verifyDnsPublicHost — resolve hostname/IP lalu pastikan SEMUA
 * alamat yang terjadi adalah publik. Dipanggil adapter sebelum
 * mengirim request keluar (opsional, tetapi disarankan).
 *
 * @param {string|URL} input — URL atau hostname
 * @returns {Promise<{ok:true,hostname:string,addresses:string[],directIp:boolean}
 *           |{ok:false,reason:string,message:string,addresses?:string[]}>}
 */
async function verifyDnsPublicHost(input) {
  let hostname;
  let url = null;
  if (input instanceof URL) {
    url = input;
    hostname = normalizeHostname(input.hostname);
  } else if (typeof input === 'string') {
    const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim());
    if (looksUrl) {
      const p = parseHttpUrl(input);
      if (!p.ok) return fail(p.reason, p.message);
      url = p.url;
      hostname = p.hostname;
    } else {
      hostname = normalizeHostname(input);
    }
  } else {
    return fail(REASONS.INVALID_URL, 'Input hostname tidak valid.');
  }

  if (!hostname) return fail(REASONS.INVALID_URL, 'Hostname kosong.');

  // Literal IP → tanpa DNS; cukup klasifikasi
  if (hostIsRawIp(hostname)) {
    if (!isPublicAddress(hostname)) {
      return fail(REASONS.DNS_PRIVATE_ADDRESS, 'Alamat internal ditolak.');
    }
    return { ok: true, hostname, addresses: [stripIPv6Literal(hostname)], directIp: true };
  }

  let records;
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch (e) {
    return fail(REASONS.DNS_FAILURE, 'Hostname tidak dapat diresolusi (' + (e && e.code ? e.code : 'DNS gagal') + ').');
  }

  if (!Array.isArray(records) || records.length === 0) {
    return fail(REASONS.DNS_FAILURE, 'Tidak ada hasil resolusi DNS.');
  }

  const addresses = [];
  for (const rec of records) {
    const addr = stripIPv6Literal(String(rec.address || ''));
    addresses.push(addr);
    if (!isPublicAddress(addr)) {
      return {
        ok: false,
        reason: REASONS.DNS_PRIVATE_ADDRESS,
        message: 'Resolusi DNS menghasilkan alamat internal/private — koneksi ditolak.',
        addresses,
      };
    }
  }

  return { ok: true, hostname, addresses, directIp: false };
}

function hostIsRawIp(hostname) {
  const h = stripIPv6Literal(hostname);
  if (h.includes(':')) return net.isIP(h) === 6;
  return net.isIP(h) !== 0 || /^[\d.]+$/.test(h) || /^0[xX][0-9a-f]+$/i.test(h);
}

/* ==================================================================== */
/* Exports                                                               */
/* ==================================================================== */

module.exports = {
  parseHttpUrl,
  validateIncomingUrl,
  validateTargetUrl,
  isSupportedDomain,
  isPublicAddress,
  verifyDnsPublicHost,
  hostnameMatchesDomain,
  SUPPORTED_DOMAINS,
  REASONS,
};
