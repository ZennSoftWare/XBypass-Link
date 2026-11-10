'use strict';

/* ====================================================================
 * XBypass — lib/chain-resolver.js
 *
 * Beberapa engine hanya mengembalikan shortlink perantara (contoh:
 * sub2unlock.me -> sub4unlock.com -> MediaFire). Modul ini melanjutkan
 * rantai tersebut HANYA bila domain tujuan masih punya engine di
 * lib/engine-registry.js.
 *
 * Aturan:
 *  - maksimal MAX_CHAIN_HOPS hop tambahan;
 *  - deteksi loop (provider + URL yang sama tidak diproses dua kali);
 *  - tunduk pada deadline total request;
 *  - bila rantai berhenti di shortlink yang belum didukung / batas hop /
 *    timeout, hasilnya GAGAL JUJUR — bukan sukses palsu dengan link
 *    perantara yang belum ter-unlock.
 * ==================================================================== */

const { withDeadline } = require('./http-gateaway');
const { evaluateEngineResult } = require('./engine-result');
const { validateTargetUrl } = require('./url-validator');
const { findEngineByHost, getEngineFn } = require('./engine-registry');

const MAX_CHAIN_HOPS = 3;
const MIN_REMAINING_MS = 2500;

/* Shortlink/locker populer yang belum punya engine di repo ini. */
const KNOWN_UNSUPPORTED_LOCKERS = [
  'ay.live',
  'aylink.co',
  'paste4link.com',
  'linkvertise.com',
  'linkvertise.net',
  'linkpays.in',
  'cuty.io',
  'ouo.io',
  'shrinke.me',
  'shrinkearn.com',
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isKnownUnsupportedLocker(url) {
  const host = hostOf(url);
  return KNOWN_UNSUPPORTED_LOCKERS.some((d) => host === d || host.endsWith('.' + d));
}

function failure(code, message, trace) {
  return { success: false, code, message, trace };
}

function timeoutMessage() {
  return 'Permintaan melewati batas waktu saat melanjutkan shortlink perantara.';
}

/**
 * Lanjutkan target URL bila masih berupa provider yang didukung.
 *
 * @param {object} opts
 * @param {object|null} opts.startEntry entri engine yang baru dipakai
 * @param {string} [opts.startUrl] URL input awal (untuk deteksi loop)
 * @param {string} opts.targetUrl URL hasil engine pertama
 * @param {number} opts.deadlineAt epoch ms batas total request
 * @returns {Promise<{success:boolean,targetUrl?:string,code?:string,message?:string,trace:Array}>}
 */
async function resolveChain({ startEntry, startUrl, targetUrl, deadlineAt }) {
  let currentUrl = targetUrl;
  let hops = 0;
  const visited = new Set();
  const trace = [];

  if (startEntry && startUrl) {
    visited.add(startEntry.id + '|' + startUrl);
  }

  while (true) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return failure('INVALID_TARGET', 'Link tujuan bukan URL yang valid.', trace);
    }

    const nextEntry = findEngineByHost(parsed.hostname);

    /* Tidak ada engine untuk host ini: inilah akhir rantai. */
    if (!nextEntry || nextEntry.chain === false) {
      if (isKnownUnsupportedLocker(currentUrl)) {
        const host = hostOf(currentUrl) || 'shortlink perantara';
        return failure(
          'CHAIN_UNSUPPORTED',
          `Bypass berhenti di ${host} yang belum didukung. Link akhir belum diperoleh.`,
          trace
        );
      }
      return { success: true, targetUrl: currentUrl, trace };
    }

    if (hops >= MAX_CHAIN_HOPS) {
      return failure(
        'CHAIN_LIMIT',
        `Rantai shortlink melebihi batas ${MAX_CHAIN_HOPS} hop; link akhir belum diperoleh.`,
        trace
      );
    }

    const visitKey = nextEntry.id + '|' + parsed.href;
    if (visited.has(visitKey)) {
      return failure(
        'CHAIN_LOOP',
        'Terdeteksi loop shortlink perantara; link akhir belum diperoleh.',
        trace
      );
    }
    visited.add(visitKey);

    const remaining = Number(deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining < MIN_REMAINING_MS) {
      return failure('TIMEOUT', timeoutMessage(), trace);
    }

    let fn;
    try {
      fn = getEngineFn(nextEntry);
    } catch {
      return failure(
        'API_UNAVAILABLE',
        'Engine untuk shortlink perantara ini tidak tersedia.',
        trace
      );
    }
    if (!fn) {
      return failure(
        'API_UNAVAILABLE',
        'Engine untuk shortlink perantara ini tidak tersedia.',
        trace
      );
    }

    let result;
    const started = Date.now();
    try {
      const options = typeof nextEntry.buildOptions === 'function'
        ? nextEntry.buildOptions({})
        : (nextEntry.buildOptions || {});
      result = await withDeadline(
        () => fn(parsed.href, options),
        Math.min(nextEntry.deadlineMs || 45000, remaining)
      );
    } catch (err) {
      const isTimeout = err && (err.name === 'AbortError' || err.code === 'ETIMEDOUT');
      trace.push({
        provider: nextEntry.provider,
        input: parsed.href,
        success: false,
        code: isTimeout ? 'TIMEOUT' : 'BYPASS_FAILED',
        elapsed_ms: Date.now() - started,
      });
      return failure(
        isTimeout ? 'TIMEOUT' : 'BYPASS_FAILED',
        isTimeout ? timeoutMessage() : undefined,
        trace
      );
    }

    const verdict = evaluateEngineResult(nextEntry.provider, result);
    trace.push({
      provider: nextEntry.provider,
      input: parsed.href,
      success: verdict.success,
      code: verdict.success ? null : verdict.code,
      targetUrl: verdict.success ? verdict.targetUrl : undefined,
      elapsed_ms: Date.now() - started,
    });

    if (!verdict.success) {
      return failure(verdict.code, verdict.message, trace);
    }

    const validated = validateTargetUrl(verdict.targetUrl);
    if (!validated.ok) {
      return failure(validated.code, validated.message, trace);
    }

    currentUrl = validated.href;
    hops++;
  }
}

module.exports = {
  resolveChain,
  isKnownUnsupportedLocker,
  KNOWN_UNSUPPORTED_LOCKERS,
  MAX_CHAIN_HOPS,
  MIN_REMAINING_MS,
};
