'use strict';

/* ====================================================================
 * XBypass — lib/provider-endpoint.js
 *
 * Pabrik handler HTTP tipis untuk seluruh endpoint api/bypass-*.js.
 * Semua metadata provider (host, engine, opsi, deadline) berasal dari
 * lib/engine-registry.js agar tidak ada duplikasi.
 *
 * Kontrak respons tetap:
 *   sukses : { success:true, provider, targetUrl, message }
 *   gagal  : { success:false, provider, error:{ code, message } }
 * ==================================================================== */

const { readJsonBody, withDeadline } = require('./http-gateaway');
const { sendFailure, sendSuccess, sendFromException } = require('./response-handler');
const { validateIncomingUrl, validateTargetUrl, hostMatchesDomain } = require('./url-validator');
const { evaluateEngineResult } = require('./engine-result');
const { resolveChain } = require('./chain-resolver');
const { getEngineEntry, getDisabledEntry, getEngineFn } = require('./engine-registry');

const DEFAULT_DEADLINE_MS = 48000;
const FIRST_ENGINE_BUDGET_MS = 30000;

function incompleteShortlinkMessage(host) {
  return `Link ${host} belum lengkap. Sertakan kode shortlink, contoh: https://${host}/xxxxx`;
}

function resolveEntry(entryOrId, disabled) {
  if (entryOrId && typeof entryOrId === 'object') return entryOrId;
  const id = String(entryOrId || '');
  return disabled ? getDisabledEntry(id) : getEngineEntry(id);
}

function validateRequest(body, entry) {
  if (!body.ok) return body;

  const incoming = validateIncomingUrl(body.data.url);
  if (!incoming.ok) return incoming;

  if (!entry.hosts.some((d) => hostMatchesDomain(incoming.hostname, d))) {
    return { ok: false, code: 'UNSUPPORTED_DOMAIN' };
  }

  const path = incoming.url.pathname.replace(/\/+$/, '');
  if (!path || path === '/') {
    return { ok: false, code: 'INCOMPLETE_URL', message: incompleteShortlinkMessage(incoming.hostname) };
  }

  return { ok: true, incoming };
}

/**
 * Handler provider yang punya engine.
 * @param {string|object} entryOrId id entri di engine-registry (atau objek entri)
 */
function createProviderHandler(entryOrId) {
  const entry = resolveEntry(entryOrId, false);
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('Entri provider tidak ditemukan di engine-registry');
  }
  if (typeof entry.load !== 'function') {
    throw new TypeError(`Provider ${entry.id || entryOrId} tidak memiliki engine`);
  }

  const provider = entry.provider;

  return async function handler(req, res) {
    const body = await readJsonBody(req);
    const checked = validateRequest(body, entry);
    if (!checked.ok) {
      return sendFailure(res, provider, checked.code, checked.message);
    }

    const { incoming } = checked;
    const deadlineAt = Date.now() + DEFAULT_DEADLINE_MS;

    try {
      const engineFn = getEngineFn(entry);
      if (!engineFn) {
        return sendFailure(res, provider, 'API_UNAVAILABLE');
      }

      const options = typeof entry.buildOptions === 'function'
        ? entry.buildOptions(body.data)
        : (entry.buildOptions || {});
      const firstBudget = entry.chain === false
        ? (entry.deadlineMs || DEFAULT_DEADLINE_MS)
        : Math.min(entry.deadlineMs || FIRST_ENGINE_BUDGET_MS, FIRST_ENGINE_BUDGET_MS);

      const result = await withDeadline(
        () => engineFn(incoming.href, options),
        Math.min(firstBudget, DEFAULT_DEADLINE_MS)
      );

      const verdict = evaluateEngineResult(provider, result);
      if (!verdict.success) {
        return sendFailure(res, provider, verdict.code, verdict.message);
      }

      const firstTarget = validateTargetUrl(verdict.targetUrl);
      if (!firstTarget.ok) {
        return sendFailure(res, provider, firstTarget.code, firstTarget.message);
      }

      if (entry.chain === false) {
        return sendSuccess(res, {
          provider,
          targetUrl: firstTarget.href,
          message: 'Bypass berhasil',
        });
      }

      const chain = await resolveChain({
        startEntry: entry,
        startUrl: incoming.href,
        targetUrl: firstTarget.href,
        deadlineAt,
      });

      if (!chain.success) {
        return sendFailure(res, provider, chain.code, chain.message);
      }

      const finalTarget = validateTargetUrl(chain.targetUrl);
      if (!finalTarget.ok) {
        return sendFailure(res, provider, finalTarget.code, finalTarget.message);
      }

      return sendSuccess(res, {
        provider,
        targetUrl: finalTarget.href,
        message: 'Bypass berhasil',
      });
    } catch (err) {
      return sendFromException(res, provider, err);
    }
  };
}

/**
 * Handler stub untuk provider yang tampil di UI tetapi belum punya engine.
 * Tetap memakai validasi request yang sama, lalu menjawab 503 terstruktur.
 * @param {string|object} entryOrId id entri di DISABLED_ENGINES
 */
function createDisabledHandler(entryOrId) {
  const entry = resolveEntry(entryOrId, true);
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('Entri provider nonaktif tidak ditemukan');
  }

  const provider = entry.provider;
  const reason = entry.reason || 'Provider ini belum tersedia.';

  return async function handler(req, res) {
    const body = await readJsonBody(req);
    const checked = validateRequest(body, entry);
    if (!checked.ok) {
      return sendFailure(res, provider, checked.code, checked.message);
    }
    return sendFailure(res, provider, 'API_UNAVAILABLE', reason);
  };
}

module.exports = {
  createProviderHandler,
  createDisabledHandler,
  DEFAULT_DEADLINE_MS,
  FIRST_ENGINE_BUDGET_MS,
  incompleteShortlinkMessage,
};
