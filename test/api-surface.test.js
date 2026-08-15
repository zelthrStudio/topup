'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

function api() {
  return require('../dist/index.js');
}

// The complete public surface. Any accidental export removal fails here.
const RUNTIME_EXPORTS = [
  'truemoney',
  'TMN_BASE',
  'bank',
  'SLIP_BASE',
  'post',
  'TopupError',
  'ValidationError',
  'QrParseError',
  'CrcValidationError',
  'OcrError',
  'OcrTimeoutError',
  'TimeoutError',
  'HttpError',
  'AmountMismatchError',
  'getSlipAmount',
  'CROP_PROFILES',
  'extractAmounts',
  'isLikelyAmount',
  'warmupAmountExtractor',
  'terminateAmountExtractor',
  'decodeQr',
  'parseEmvco',
  'parseSlipCheck',
  'verifyCrc',
  'crc16ccitt',
  'getQrCodePromptPay',
  'MAX_PROMPTPAY_AMOUNT',
];

test('all public runtime exports are present', () => {
  const mod = api();
  for (const name of RUNTIME_EXPORTS) {
    assert.ok(name in mod, `missing export: ${name}`);
  }
});

test('all public functions are callable', () => {
  const mod = api();
  const callables = RUNTIME_EXPORTS.filter(
    (n) => !n.endsWith('_BASE') && n !== 'CROP_PROFILES' && n !== 'MAX_PROMPTPAY_AMOUNT'
  );
  for (const name of callables) {
    assert.equal(typeof mod[name], 'function', `${name} should be a function`);
  }
  assert.equal(typeof mod.TMN_BASE, 'string');
  assert.equal(typeof mod.SLIP_BASE, 'string');
  assert.ok(typeof mod.CROP_PROFILES, 'object');
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
    ['QrParseError', 'TopupError'],
    ['CrcValidationError', 'TopupError'],
    ['OcrError', 'TopupError'],
    ['OcrTimeoutError', 'OcrError'],
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
  const http = new m.HttpError('x', { status: 429, slug: 'rate-limited', body: { a: 1 } });
  assert.equal(http.status, 429);
  assert.equal(http.slug, 'rate-limited');
  assert.deepEqual(http.body, { a: 1 });
  assert.equal(new m.AmountMismatchError('x').slug, 'amount-mismatch');
});