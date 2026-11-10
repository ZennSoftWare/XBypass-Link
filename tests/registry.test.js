'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ENGINES,
  DISABLED_ENGINES,
  getEngineFn,
} = require('../lib/engine-registry');

test('setiap entri engine punya handler api/bypass-*.js', () => {
  for (const id of Object.keys(ENGINES)) {
    const file = path.join(__dirname, '..', 'api', `${id}.js`);
    assert.equal(fs.existsSync(file), true, `handler hilang: ${file}`);
    const handler = require(file);
    assert.equal(typeof handler, 'function', `handler bukan fungsi: ${file}`);
  }
});

test('setiap entri engine mengekspor fungsi yang terdaftar', () => {
  for (const [id, entry] of Object.entries(ENGINES)) {
    const fn = getEngineFn(entry);
    assert.equal(typeof fn, 'function', `engine ${id} tidak mengekspor ${entry.fn}`);
  }
});

test('setiap provider nonaktif punya handler stub', () => {
  for (const id of Object.keys(DISABLED_ENGINES)) {
    const file = path.join(__dirname, '..', 'api', `${id}.js`);
    assert.equal(fs.existsSync(file), true, `handler stub hilang: ${file}`);
    const handler = require(file);
    assert.equal(typeof handler, 'function', `handler stub bukan fungsi: ${file}`);
  }
});

test('setiap endpoint di data/bypass.js punya handler', async () => {
  const { BYPASS_PROVIDERS } = await import('../data/bypass.js');
  for (const provider of BYPASS_PROVIDERS) {
    const file = path.join(__dirname, '..', 'api', `${provider.endpoint.slice('/api/'.length)}.js`);
    assert.equal(fs.existsSync(file), true, `handler hilang untuk ${provider.name}: ${file}`);
  }
});

test('daftar domain backend selaras dengan data/bypass.js', async () => {
  const { BYPASS_PROVIDERS } = await import('../data/bypass.js');
  const { SUPPORTED_PROVIDER_DOMAINS } = require('../lib/url-validator');
  const fromData = [...new Set(BYPASS_PROVIDERS.flatMap((p) => p.domains))].sort();
  assert.deepEqual([...SUPPORTED_PROVIDER_DOMAINS].sort(), fromData);
});


