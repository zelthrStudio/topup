'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

function api() {
  return require('../dist/index.js');
}

const RUNTIME_EXPORTS = [
  'truemoney',
  'TMN_BASE',
  'bank',
  'SLIP_BASE',
  'post',
  'TopupError',
  'ValidationError',
  'TimeoutError',
  'HttpError',
  'AmountMismatchError',
  'AmountVerificationError',
];

test('all public runtime exports are present', () => {
  const mod = api();
  for (const name of RUNTIME_EXPORTS) {
    assert.ok(name in mod, `missing export: ${name}`);
  }
});

test('all public functions are callable', () => {
  const mod = api();
  const callables = RUNTIME_EXPORTS.filter((n) => !n.endsWith('_BASE'));
  for (const name of callables) {
    assert.equal(typeof mod[name], 'function', `${name} should be a function`);
  }
  assert.equal(typeof mod.TMN_BASE, 'string');
  assert.equal(typeof mod.SLIP_BASE, 'string');
  assert.equal(mod.TMN_BASE, 'https://api.zelthr.rest');
  assert.equal(mod.SLIP_BASE, 'https://api.zelthr.rest');
});

test('ESM wrapper (dist/index.mjs) mirrors the CJS surface', async () => {
  const cjs = api();
  const esm = await import('../dist/index.mjs');
  for (const name of RUNTIME_EXPORTS) {
    assert.ok(name in esm, `missing ESM export: ${name}`);
    assert.strictEqual(esm[name], cjs[name], `${name} differs between ESM and CJS`);
  }
  assert.strictEqual(esm.default, cjs, 'ESM default should be the CJS module');
});

test('every error class reports the right name, message, and hierarchy', () => {
  const m = api();
  const cases = [
    ['ValidationError', 'TopupError'],
    ['TimeoutError', 'TopupError'],
    ['HttpError', 'TopupError'],
    ['AmountMismatchError', 'HttpError'],
  ];
  for (const [name, parent] of cases) {
    const err = new m[name]('boom');
    assert.equal(err.name, name, `${name}.name`);
    assert.equal(err.message, 'boom');
    assert.ok(err instanceof m[parent], `${name} instanceof ${parent}`);
    assert.ok(err instanceof m.TopupError);
    assert.ok(err instanceof Error);
  }
  const http = new m.HttpError('x', { status: 429, slug: 'rate-limit-exceeded', body: { a: 1 } });
  assert.equal(http.status, 429);
  assert.equal(http.slug, 'rate-limit-exceeded');
  assert.deepEqual(http.body, { a: 1 });
  assert.equal(new m.AmountMismatchError('x').slug, 'amount-mismatch');
});