'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  createProviderHandler,
  createDisabledHandler,
} = require('../lib/provider-endpoint');

function makeReq(method, body, contentType = 'application/json') {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.headers = {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body || '')),
  };
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
  };
}

const fakeEntry = {
  id: 'bypass-fake',
  provider: 'fake',
  hosts: ['sub2unlock.me'],
  load: () => ({
    fake: async () => ({ status: true, target_url: 'https://example.com/final' }),
  }),
  fn: 'fake',
  buildOptions: () => ({}),
  deadlineMs: 2000,
  chain: false,
};

test('POST URL valid mengembalikan kontrak sukses', async () => {
  const handler = createProviderHandler(fakeEntry);
  const res = makeRes();
  await handler(makeReq('POST', JSON.stringify({ url: 'https://sub2unlock.me/abc' })), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    provider: 'fake',
    targetUrl: 'https://example.com/final',
    message: 'Bypass berhasil',
  });
});

test('URL tanpa kode shortlink ditolak INCOMPLETE_URL', async () => {
  const handler = createProviderHandler(fakeEntry);
  const res = makeRes();
  await handler(makeReq('POST', JSON.stringify({ url: 'https://sub2unlock.me' })), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'INCOMPLETE_URL');
});

test('domain yang bukan milik provider ditolak UNSUPPORTED_DOMAIN', async () => {
  const handler = createProviderHandler(fakeEntry);
  const res = makeRes();
  await handler(makeReq('POST', JSON.stringify({ url: 'https://sub2unlock.io/abc' })), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'UNSUPPORTED_DOMAIN');
});

test('GET ditolak METHOD_NOT_ALLOWED', async () => {
  const handler = createProviderHandler(fakeEntry);
  const res = makeRes();
  await handler(makeReq('GET', ''), res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error.code, 'METHOD_NOT_ALLOWED');
});

test('provider nonaktif menjawab API_UNAVAILABLE terstruktur', async () => {
  const handler = createDisabledHandler({
    id: 'bypass-linkvertise',
    provider: 'linkvertise',
    hosts: ['linkvertise.com'],
    reason: 'Linkvertise belum tersedia.',
  });
  const res = makeRes();
  await handler(makeReq('POST', JSON.stringify({ url: 'https://linkvertise.com/123' })), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'API_UNAVAILABLE');
  assert.equal(res.body.error.message, 'Linkvertise belum tersedia.');
});
