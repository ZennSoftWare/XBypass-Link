'use strict';

/* ====================================================================
 * XBypass — lib/url-validator.js
 *
 * Pusat validasi URL & perlindungan SSRF untuk seluruh endpoint /api/*.
 *
 * Catatan arsitektur:
 * - data/bypass.js ditulis dengan ES Modules dan TIDAK BISA di-require()
 *   dari backend CommonJS ini. Daftar domain provider dibawa eksplisit
 *   di konstanta SUPPORTED_PROVIDER_DOMAINS di bawah — isinya adalah
 *   mirror 1:1 dari BYPASS_PROVIDERS[].domains pada data/bypass.js
 *   (sub2unlock.me, sub2unlock.io, bicolink.com, pastelink.net,
 *   pastelink.id, shrinkme.io/click/ink, safelinku.com/sfl.gl,
 *   linkvertise.com/net, subs4unlock.id, sub4unlock.com,
 *   subs4unlock.com).
 *   Bila provider baru ditambahkan di data/bypass.js, daftar ini WAJIB
 *   disinkronkan secara manual.
 *
 * - Matching domain menggunakan aturan tepat:
 *       hostname === domain || hostname.endsWith('.' + domain)
 *   (bukan substring biasa, agar "sub2unlock.me.attacker.com" tidak lolos)
 *
 * - Lancar: hanya http/https; username/password ditolak; localhost dan
 *   IP internal (IPv4 & IPv6: loopback, private, link-local, CGNAT,
 *   reserved, documentation, multicast) ditolak.
 * ==================================================================== */

/* Mirror eksplisit dari data/bypass.js (BYPASS_PROVIDERS). */
const SUPPORTED_PROVIDER_DOMAINS = [
  'sub2unlock.me',
  'sub2unlock.io',
  'bicolink.com',
  'pastelink.net',
  'pastelink.id',
  'shrinkme.io',
  'shrinkme.click',
  'shrinkme.ink',
  'safelinku.com',
  'sfl.gl',
  'linkvertise.com',
  'linkvertise.net',
  'subs4unlock.id',
  'sub4unlock.com',
  'subs4unlock.com',
];

const MAX_URL_LENGTH = 2048;
const MAX_HOST_LENGTH = 253;

/* ------------------------------------------------------------------ */
/* Util string kecil                                                   */
/* ------------------------------------------------------------------ */

function isControlOrWhitespace(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 32) return true; // spasi + karakter kontrol < spasi
  }
  return false;
}

/** hapus bracket IPv6, zona %iface, trailing dot, dan www. — hanya untuk match domain */
function normalizeHostname(raw) {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  // hapus zona IPv6 mis. fee80::1%eth0
  const pct = h.indexOf('%');
  if (pct !== -1) h = h.slice(0, pct);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  while (h.startsWith('.')) h = h.slice(1);
  return h.length ? h : null;
}

/** benar hanya bila hostname === domain atau subdomain langsung (endsWith('.'+domain)) */
function hostMatchesDomain(hostname, domain) {
  const h = normalizeHostname(hostname);
  const d = normalizeHostname(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith('.' + d);
}

/* ------------------------------------------------------------------ */
/* IPv4                                                                */
/* ------------------------------------------------------------------ */

function parseDottedIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  for (const p of parts) if (p < 0 || p > 255) return null;
  return parts;
}

/** cek sebuah tuple IPv4 terhadap daftar rentang terlarang */
function ipv4InRanges(octets, ranges) {
  const [o0, o1, o2, o3] = octets;
  for (const [[r0, r1, r2, r3], mask] of ranges) {
    const bits = [r0, r1, r2, r3];
    let ok = true;
    for (let i = 0; i < 4; i++) {
      const shift = i * 8;
      if (shift >= mask) break;
      const take = Math.min(8, mask - shift);
      const a = (bits[i] >> (8 - take)) & ((1 << take) - 1);
      const b = (octets[i] >> (8 - take)) & ((1 << take) - 1);
      if (a !== b) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

const RESERVED_IPV4 = [
  [[0, 0, 0, 0], 8],        // this-network (0.0.0.0/8)
  [[10, 0, 0, 0], 8],       // private
  [[100, 64, 0, 0], 10],    // CGNAT (RFC 6598)
  [[127, 0, 0, 0], 8],      // loopback
  [[169, 254, 0, 0], 16],   // link-local
  [[172, 16, 0, 0], 12],    // private
  [[192, 0, 0, 0], 24],     // IETF protocol assignments (RFC 791)
  [[192, 0, 2, 0], 24],     // TEST-NET-1
  [[192, 168, 0, 0], 16],   // private
  [[198, 18, 0, 0], 15],    // benchmarking
  [[198, 51, 100, 0], 24],  // TEST-NET-2
  [[203, 0, 113, 0], 24],   // TEST-NET-3
  [[224, 0, 0, 0], 4],      // multicast + kelas D
  [[240, 0, 0, 0], 4],      // reserved (termasuk masker broadcast 255.x)
];

/* ------------------------------------------------------------------ */
/* IPv6                                                                */
/* ------------------------------------------------------------------ */

/** ekspansi telapak hex ke BigInt; kembalikan null bila bukan IPv6 valid */
function parseIpv6(text) {
  let s = text;
  const zoneIdx = s.indexOf('%');
  if (zoneIdx !== -1) s = s.slice(0, zoneIdx);

  let v4Tail = null;
  const dot = s.lastIndexOf('.');
  if (dot !== -1) {
    const lastColon = s.lastIndexOf(':');
    if (dot <= lastColon + 1) return null; // quad IPv4 wajib setelah colon terakhir
    const tail = s.slice(lastColon + 1);
    const oct = parseDottedIpv4(tail);
    if (!oct) return null;
    v4Tail = (oct[0] << 8) | oct[1];
    v4Tail = (v4Tail << 16) | ((oct[2] << 8) | oct[3]);
    s = s.slice(0, lastColon + 1) + hexTail(oct);
  }

  if (s.includes('::')) {
    if (s.split('::').length > 2) return null;
    const [head, tail] = s.split('::');
    const hParts = head ? head.split(':') : [];
    const tParts = tail ? tail.split(':') : [];
    const fill = 8 - hParts.length - tParts.length;
    if (fill < 1) return null;
    const all = [...hParts, ...Array(fill).fill('0'), ...tParts];
    if (all.length !== 8) return null;
    return groupsToBigInt(all, v4Tail);
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  return groupsToBigInt(parts, v4Tail);
}

function hexTail(oct) {
  const n = (oct[0] << 8) | oct[1];
  const m = (oct[2] << 8) | oct[3];
  return n.toString(16) + ':' + m.toString(16);
}

function groupsToBigInt(groups, v4Tail) {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (g === '') return null;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    if (i === 6 && v4Tail !== null) {
      value = (value << 16n) | BigInt(v4Tail >>> 16);
      value = (value << 16n) | BigInt(v4Tail & 0xffff);
      return value;
    }
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/* Rentang tetap dalam bentuk {addr, prefix} */
const RESERVED_V6_RANGES = [
  { addr: BigInt('0x1'), prefix: 128 },            // ::1 loopback
  { addr: BigInt('0x0'), prefix: 128 },            // :: unspecified
  { addr: BigInt('0xfc000000000000000000000000000000'), prefix: 7 },  // unique local
  { addr: BigInt('0xfe800000000000000000000000000000'), prefix: 10 }, // link-local
  { addr: BigInt('0xff000000000000000000000000000000'), prefix: 8 },  // multicast/reserved
  { addr: BigInt('0x20010db8000000000000000000000000'), prefix: 32 }, // documentation
  { addr: BigInt('0x20010000000000000000000000000000'), prefix: 32 }, // teredo (reserved)
  { addr: BigInt('0x01000000000000000000000000000000'), prefix: 8 },  // discard-only
];
const V6_TOTAL = 1n << 128n;
const V4_MAPPED_PREFIX = BigInt('0xffff'); // (128-bit >> 32) untuk ::ffff:0:0/96

/** apakah alamat ini berada di dalam rentang CIDR v6 */
function ipv6InRange(value, addr, prefix) {
  const mask = (V6_TOTAL - 1n) << BigInt(128 - prefix);
  return (value & mask) === (addr & mask);
}

/* ------------------------------------------------------------------ */
/* isPublicAddress — inti proteksi SSRF                                */
/* ------------------------------------------------------------------ */

/** true bila hostname/alamat boleh diakses dari internet (bukan internal) */
function isPublicAddress(host) {
  if (host === null || host === undefined) return false;
  if (typeof host !== 'string') return false;

  let h = host.trim().toLowerCase();
  if (!h) return false;

  // zona IPv6 (%) dihapus lebih awal
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);

  // localhost (name atau wildcard bawahnya) selalu terlarang
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.') return false;

  if (h.includes(':') || (h.startsWith('[') && h.endsWith(']'))) {
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    const parsed = parseIpv6(h);
    if (parsed === null) return false; // IPv6 tidak valid
    // ::ffff:0:0/96 (IPv4-mapped) → nilai dengan 96 nol di belakang lalu nilai v4
    if ((parsed >> 32n) === V4_MAPPED_PREFIX) {
      const v4 = Number(parsed & 0xffffffffn);
      const oct = [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255];
      return !ipv4InRanges(oct, RESERVED_IPV4);
    }
    for (const r of RESERVED_V6_RANGES) {
      if (ipv6InRange(parsed, r.addr, r.prefix)) return false;
    }
    return true;
  }

  // alamat dotted IPv4 (termasuk bentuk komplet desimal di host)
  const oct = parseDottedIpv4(h);
  if (oct) return !ipv4InRanges(oct, RESERVED_IPV4);

  // nama host biasa: wajib punya titik (nama satu label = jaringan internal),
  // panjang wajar, hanya karakter URL legal.
  if (h.length > MAX_HOST_LENGTH) return false;
  if (!h.includes('.')) return false;
  const labelRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = h.split('.');
  if (!labels.every((l) => l.length > 0 && labelRe.test(l))) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* parseHttpUrl                                                        */
/* ------------------------------------------------------------------ */

/**
 * Parse string menjadi objek URL yang aman dipakai lintas endpoint.
 * - hanya http/https
 * - tanpa username/password
 * - tanpa karakter kontrol/spasi
 * Opsi: { allowSchemeless: true } menambahkan https:// bila scheme hilang.
 * @returns {URL|null}
 */
function parseHttpUrl(raw, options = {}) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > MAX_URL_LENGTH) return null;
  if (isControlOrWhitespace(s)) return null;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (options.allowSchemeless !== true) return null;
    s = 'https://' + s;
  }

  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }

  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  if (u.port && !/^\d+$/.test(u.port)) return null;
  const portNum = Number(u.port || 0);
  if (portNum > 65535) return null;

  const clean = normalizeHostname(u.hostname);
  if (!clean) return null;

  return u;
}

/* ------------------------------------------------------------------ */
/* isSupportedDomain & pemeriksaan endpoint                            */
/* ------------------------------------------------------------------ */

/** domain termasuk provider terdaftar data/bypass.js? (tepat + subdomain) */
function isSupportedDomain(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  for (const d of SUPPORTED_PROVIDER_DOMAINS) {
    if (hostMatchesDomain(h, d)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* validateIncomingUrl (input pengguna — wajib domain provider)        */
/* ------------------------------------------------------------------ */

/**
 * Validasi URL masuk dari request pengguna.
 * @returns {{ok:true, url:URL, href:string, hostname:string, providerDomain:string}
 *          |{ok:false, code:string, message:string}}
 */
function validateIncomingUrl(raw) {
  const u = parseHttpUrl(raw, { allowSchemeless: false });
  if (!u) {
    return {
      ok: false,
      code: 'INVALID_URL',
      message: 'Format link tidak valid. Gunakan alamat http/https lengkap tanpa data login.',
    };
  }

  const host = normalizeHostname(u.hostname);

  if (!isPublicAddress(host)) {
    return {
      ok: false,
      code: 'UNSAFE_TARGET',
      message: 'Alamat localhost, IP internal, atau jaringan tidak diperbolehkan.',
    };
  }

  const matched = SUPPORTED_PROVIDER_DOMAINS.find((d) => hostMatchesDomain(host, d));
  if (!matched) {
    return {
      ok: false,
      code: 'UNSUPPORTED_DOMAIN',
      message: 'Domain ini belum didukung. Cek daftar Bypass yang Didukung di bawah.',
    };
  }

  return { ok: true, url: u, href: u.href, hostname: host, providerDomain: matched };
}

/* ------------------------------------------------------------------ */
/* validateTargetUrl (hasil engine / URL redirect sebelum dipakai)     */
/* ------------------------------------------------------------------ */

/**
 * Validasi URL target/akhir hasil engine sebelum dikirim ke frontend.
 * Target tidak harus domain provider — hanya wajib bukan jaringan internal.
 * @returns {{ok:true, url:URL, href:string} | {ok:false, code:string, message:string}}
 */
function validateTargetUrl(raw) {
  const u = parseHttpUrl(raw, { allowSchemeless: false });
  if (!u) {
    return {
      ok: false,
      code: 'INVALID_TARGET',
      message: 'Link tujuan dari server bukan URL http/https yang valid.',
    };
  }
  const host = normalizeHostname(u.hostname);
  if (!isPublicAddress(host)) {
    return {
      ok: false,
      code: 'UNSAFE_TARGET',
      message: 'Link tujuan mengarah ke localhost atau jaringan internal dan ditolak.',
    };
  }
  return { ok: true, url: u, href: u.href };
}

/* ------------------------------------------------------------------ */
/* resolveSafeAddresses — pemeriksaan DNS sebelum koneksi keluar       */
/* ------------------------------------------------------------------ */

/**
 * Melakukan lookup DNS dan memastikan SETIAP alamat hasil resolusi
 * adalah alamat publik (mencegah DNS rebinding ke jaringan internal).
 * Astaga serverless: dipanggil opsional — "apabila diperlukan" sebelum
 * adapter API melakukan koneksi eksternal.
 *
 * @param {string} hostname
 * @returns {Promise<{safe:boolean, addresses:string[], reason?:string}>}
 */
async function resolveSafeAddresses(hostname) {
  const dns = require('node:dns');
  const host = normalizeHostname(hostname);
  if (!host || !isPublicAddress(host)) {
    return { safe: false, addresses: [], reason: 'host_not_public' };
  }

  let entries;
  try {
    entries = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    // NXDOMAIN / SERVFAIL / offline: anggap tidak aman (fail-closed).
    return { safe: false, addresses: [], reason: err && err.code ? err.code : 'dns_lookup_failed' };
  }

  const addresses = (entries || []).map((e) => e.address);
  if (!addresses.length) {
    return { safe: false, addresses: [], reason: 'no_addresses' };
  }
  for (const a of addresses) {
    if (!isPublicAddress(a)) {
      return { safe: false, addresses, reason: 'resolves_to_internal' };
    }
  }
  return { safe: true, addresses };
}

/* ==================================================================== */
/* Public API (CommonJS)                                                */
/* ==================================================================== */

module.exports = {
  SUPPORTED_PROVIDER_DOMAINS,
  parseHttpUrl,
  validateIncomingUrl,
  validateTargetUrl,
  isSupportedDomain,
  isPublicAddress,
  hostMatchesDomain,
  resolveSafeAddresses,
};
