'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveChain,
  isKnownUnsupportedLocker,
} = require('../lib/chain-resolver');

test('target akhir biasa dikembalikan sebagai sukses tanpa hop', async () => {
  const result = await resolveChain({
    startEntry: null,
    targetUrl: 'https://www.mediafire.com/file/abc/file',
    deadlineAt: Date.now() + 10000,
  });
  assert.equal(result.success, true);
  assert.equal(result.targetUrl, 'https://www.mediafire.com/file/abc/file');
});

test('shortlink locker yang belum didukung gagal jujur', async () => {
  const result = await resolveChain({
    startEntry: null,
    targetUrl: 'https://ay.live/Fm2326',
    deadlineAt: Date.now() + 10000,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'CHAIN_UNSUPPORTED');
  assert.match(result.message, /ay\.live/);
});

test('loop provider + URL yang sama terdeteksi tanpa memanggil engine', async () => {
  const url = 'https://sub2unlock.me/WdQGzgg';
  const result = await resolveChain({
    startEntry: { id: 'bypass-sub2unlock-me' },
    startUrl: url,
    targetUrl: url,
    deadlineAt: Date.now() + 10000,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'CHAIN_LOOP');
});

test('deteksi domain locker populer', () => {
  assert.equal(isKnownUnsupportedLocker('https://www.ay.live/x'), true);
  assert.equal(isKnownUnsupportedLocker('https://linkvertise.com/123'), true);
  assert.equal(isKnownUnsupportedLocker('https://mediafire.com/file'), false);
});
