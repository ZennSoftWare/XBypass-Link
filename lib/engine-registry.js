'use strict';

/* ====================================================================
 * XBypass — lib/engine-registry.js
 *
 * Satu tempat pendaftaran engine:
 *  - endpoint publik (api/bypass-*.js) memakai entri ini;
 *  - chain resolver memakai entri ini untuk melanjutkan shortlink
 *    perantara yang masih didukung.
 *
 * Engine di-load lazy agar cold start endpoint tetap ringan dan hanya
 * engine yang dipakai request tersebut yang dimuat.
 * ==================================================================== */

const ENGINES = {
  'bypass-sub2unlock-me': {
    id: 'bypass-sub2unlock-me',
    provider: 'sub2unlock',
    name: 'Sub2Unlock.me',
    hosts: ['sub2unlock.me'],
    load: () => require('./engines/bypass-sub2unlock-me'),
    fn: 'scrapeSub2Unlock',
    buildOptions: () => ({ maxAttempts: 3, timeoutMs: 12000, log: false }),
    deadlineMs: 45000,
    chain: true,
  },
  'bypass-sub2unlock-io': {
    id: 'bypass-sub2unlock-io',
    provider: 'sub2unlock',
    name: 'Sub2Unlock.io',
    hosts: ['sub2unlock.io'],
    load: () => require('./engines/bypass-sub2unlock-io'),
    fn: 'bypassSub2Unlock',
    buildOptions: () => ({ maxCycles: 2, timeout: 15000, log: false, out: false }),
    deadlineMs: 45000,
    chain: true,
  },
  'bypass-bicolink': {
    id: 'bypass-bicolink',
    provider: 'Bicolink',
    name: 'Bicolink.com',
    hosts: ['bicolink.com'],
    load: () => require('./engines/bypass-bicolink'),
    fn: 'bypassBicolink',
    buildOptions: () => ({}),
    deadlineMs: 45000,
    chain: true,
  },
  'bypass-pastelink-net': {
    id: 'bypass-pastelink-net',
    provider: 'pastelink',
    name: 'Pastelink.net',
    hosts: ['pastelink.net'],
    load: () => require('./engines/bypass-pastelink-net'),
    fn: 'scrapePastelink',
    buildOptions: (data) => ({
      maxAttempts: 3,
      timeout: 15000,
      quiet: true,
      password: data && typeof data.password === 'string' ? data.password : undefined,
    }),
    deadlineMs: 45000,
    chain: true,
  },
  'bypass-pastelink-id': {
    id: 'bypass-pastelink-id',
    provider: 'Pastelink',
    name: 'Pastelink.id',
    hosts: ['pastelink.id'],
    load: () => require('./engines/bypass-pastelink-id'),
    fn: 'scrapePastelink',
    buildOptions: () => ({ maxAttempts: 3, timeoutMs: 15000, quiet: true }),
    deadlineMs: 45000,
    chain: true,
  },
  'bypass-shrinkme': {
    id: 'bypass-shrinkme',
    provider: 'shrinkme',
    name: 'Shrinkme.io',
    hosts: ['shrinkme.io', 'shrinkme.click', 'shrinkme.ink'],
    load: () => require('./engines/bypass-shrinkme'),
    fn: 'resolve',
    buildOptions: () => ({
      quiet: true,
      out: '/tmp/xbypass-shrinkme.json',
      search: false,
    }),
    deadlineMs: 35000,
    chain: true,
  },
  'bypass-sfl': {
    id: 'bypass-sfl',
    provider: 'safelinku',
    name: 'SFL / Safelinku',
    hosts: ['safelinku.com', 'sfl.gl'],
    load: () => require('./engines/bypass-sfl'),
    fn: 'scrapeSafelink',
    buildOptions: () => ({ tries: 2, timeout: 15000, writeFile: false, verbose: false }),
    deadlineMs: 40000,
    chain: true,
  },
  'bypass-subs4unlock-id': {
    id: 'bypass-subs4unlock-id',
    provider: 'subs4unlock',
    name: 'Subs4unlock.id',
    hosts: ['subs4unlock.id'],
    load: () => require('./engines/bypass-subs4unlock-id'),
    fn: 'scrapeSubs4Unlock',
    buildOptions: () => ({ savePath: null }),
    deadlineMs: 45000,
    chain: true,
  },
  'bypass-sub4unlock-com': {
    id: 'bypass-sub4unlock-com',
    provider: 'sub4unlock',
    name: 'Sub4Unlock.com',
    hosts: ['sub4unlock.com'],
    load: () => require('./engines/bypass-sub4unlock-com'),
    fn: 'scrapeSub4Unlock',
    buildOptions: () => ({ retries: 1 }),
    deadlineMs: 45000,
    chain: true,
  },
  'bypass-subs4unlock-com': {
    id: 'bypass-subs4unlock-com',
    provider: 'subs4unlock',
    name: 'Subs4Unlock.com',
    hosts: ['subs4unlock.com'],
    load: () => require('./engines/bypass-subs4unlock-com'),
    fn: 'scrapeSubs4Unlock',
    buildOptions: () => ({ maxRetries: 2, savePath: null, pretty: false }),
    deadlineMs: 45000,
    chain: true,
  },
};

/* Provider yang sudah tampil di UI tetapi engine-nya belum ada. */
const DISABLED_ENGINES = {
  'bypass-linkvertise': {
    id: 'bypass-linkvertise',
    provider: 'linkvertise',
    name: 'Linkvertise',
    hosts: ['linkvertise.com', 'linkvertise.net'],
    reason: 'Linkvertise belum tersedia. Engine scrape-nya sedang dibuat.',
    chain: false,
  },
};

function normalizeHost(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

function hostMatches(hostname, domain) {
  const h = normalizeHost(hostname);
  const d = normalizeHost(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith('.' + d);
}

function getEngineEntry(id) {
  return ENGINES[id] || null;
}

function getDisabledEntry(id) {
  return DISABLED_ENGINES[id] || null;
}

function findEngineByHost(hostname) {
  for (const entry of Object.values(ENGINES)) {
    if (entry.hosts.some((d) => hostMatches(hostname, d))) return entry;
  }
  return null;
}

function findDisabledByHost(hostname) {
  for (const entry of Object.values(DISABLED_ENGINES)) {
    if (entry.hosts.some((d) => hostMatches(hostname, d))) return entry;
  }
  return null;
}

function getEngineFn(entry) {
  if (!entry || typeof entry.load !== 'function') return null;
  const mod = entry.load();
  const fn = mod && mod[entry.fn];
  return typeof fn === 'function' ? fn : null;
}

module.exports = {
  ENGINES,
  DISABLED_ENGINES,
  getEngineEntry,
  getDisabledEntry,
  findEngineByHost,
  findDisabledByHost,
  getEngineFn,
  hostMatches,
  normalizeHost,
};