'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateEngineResult } = require('../lib/engine-result');

test('sfl: final_url dengan status true dianggap sukses', () => {
  const verdict = evaluateEngineResult('safelinku', {
    status: true,
    final_url: 'https://www.mediafire.com/file/abc/file',
  });
  assert.deepEqual(verdict, { success: true, targetUrl: 'https://www.mediafire.com/file/abc/file' });
});

test('bicolink: target di data.destination_url dikenali', () => {
  const verdict = evaluateEngineResult('Bicolink', {
    status: true,
    data: {
      destination_url: 'https://example.com/final',
      resolution_status: 'resolved',
      requires_interaction: false,
    },
  });
  assert.equal(verdict.success, true);
  assert.equal(verdict.targetUrl, 'https://example.com/final');
});

test('pastelink-id: requires_verification tidak memblokir target yang valid', () => {
  const verdict = evaluateEngineResult('Pastelink', {
    status: true,
    target_url: 'https://bicolink.com/KzQ',
    urls: ['https://bicolink.com/KzQ'],
    requires_verification: true,
  });
  assert.equal(verdict.success, true);
  assert.equal(verdict.targetUrl, 'https://bicolink.com/KzQ');
});

test('pastelink-net: password_required tetap gagal walau status true', () => {
  const verdict = evaluateEngineResult('pastelink', {
    status: true,
    data: {
      destination_url: null,
      page_status: 'password_required',
      password_required: true,
    },
  });
  assert.equal(verdict.success, false);
  assert.equal(verdict.code, 'PASSWORD_REQUIRED');
});

test('sub2unlock-me: destination.original_url + resolver.resolved sukses', () => {
  const verdict = evaluateEngineResult('sub2unlock', {
    status: true,
    destination: { original_url: 'https://sub4unlock.com/SL/1981026', unlock_required: false },
    resolver: { resolved: true },
  });
  assert.equal(verdict.success, true);
  assert.equal(verdict.targetUrl, 'https://sub4unlock.com/SL/1981026');
});

test('sub2unlock-me: resolver.resolved false tidak menjadi sukses', () => {
  const verdict = evaluateEngineResult('sub2unlock', {
    status: true,
    destination: { original_url: null },
    resolver: { resolved: false },
  });
  assert.equal(verdict.success, false);
  assert.equal(verdict.code, 'BYPASS_FAILED');
});

test('subs4unlock-id: not_found dipetakan ke NOT_FOUND', () => {
  const verdict = evaluateEngineResult('subs4unlock', {
    status: true,
    is_resolved: false,
    resolution_status: 'not_found',
    destination_url: null,
  });
  assert.equal(verdict.success, false);
  assert.equal(verdict.code, 'NOT_FOUND');
});

test('bicolink: resolution_status expired dipetakan ke LINK_EXPIRED', () => {
  const verdict = evaluateEngineResult('Bicolink', {
    status: false,
    data: { destination_url: null, resolution_status: 'expired' },
  });
  assert.equal(verdict.success, false);
  assert.equal(verdict.code, 'LINK_EXPIRED');
});

test('subs4unlock-com: destination.url terkunci tidak dianggap sukses', () => {
  const verdict = evaluateEngineResult('subs4unlock', {
    status: true,
    destination: { status: 'locked', url: 'https://ay.live/Fm2326' },
  });
  assert.equal(verdict.success, false);
  assert.equal(verdict.code, 'LOCKED_DESTINATION');
});

test('hasil tanpa target URL menjadi NO_TARGET_URL', () => {
  const verdict = evaluateEngineResult('x', { status: true });
  assert.equal(verdict.success, false);
  assert.equal(verdict.code, 'NO_TARGET_URL');
});

test('hasil null menjadi BYPASS_FAILED', () => {
  const verdict = evaluateEngineResult('x', null);
  assert.equal(verdict.success, false);
  assert.equal(verdict.code, 'BYPASS_FAILED');
});
