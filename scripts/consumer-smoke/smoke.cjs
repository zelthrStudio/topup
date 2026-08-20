'use strict';

const assert = require('node:assert');
const topup = require('@zelthr/topup');

async function main() {
  const expected = [
    'truemoney', 'TMN_BASE', 'bank', 'SLIP_BASE', 'post',
    'TopupError', 'ValidationError',
    'TimeoutError', 'HttpError', 'AmountMismatchError', 'AmountVerificationError',
  ];
  for (const name of expected) {
    assert.ok(topup[name] !== undefined, `missing export: ${name}`);
  }

  assert.ok(new topup.ValidationError('x') instanceof topup.TopupError);
  assert.ok(new topup.AmountMismatchError('x') instanceof topup.HttpError);
  assert.equal(new topup.AmountMismatchError('x').slug, 'amount-mismatch');

  // A fake voucher must reach the unified gateway endpoint and come back as a
  // structured response: either a resolved object or an HttpError carrying the
  // gateway's machine-readable `error` code. A 404 (removed route) would fail.
  const tmn = await topup.truemoney('0000000000000000', '0812345678').catch((e) => e);
  if (tmn instanceof topup.HttpError) {
    assert.notEqual(tmn.status, 404, `unified endpoint returned 404: ${tmn.message}`);
    assert.ok(typeof tmn.slug === 'string' && tmn.slug.length > 0, `expected a slug, got ${JSON.stringify(tmn.body)}`);
  } else {
    assert.ok(tmn !== null && typeof tmn === 'object', `expected an object, got ${tmn}`);
  }

  // An empty body on the unified endpoint is a documented 400 bad-request.
  const err = await topup.post('https://api.zelthr.rest/', {}).catch((e) => e);
  assert.ok(err instanceof topup.HttpError, `expected HttpError, got ${err}`);
  assert.equal(err.status, 400);
  assert.equal(err.slug, 'bad-request');

  // Garbage image bytes are a documented 400 unsupported-format.
  const slipErr = await topup.bank('data:image/jpeg;base64,AAAA').catch((e) => e);
  assert.ok(slipErr instanceof topup.TopupError, `expected a TopupError, got ${slipErr}`);
  if (slipErr instanceof topup.HttpError) {
    assert.equal(slipErr.status, 400);
    assert.match(String(slipErr.body?.error || slipErr.message), /invalid-image|img is required|unsupported-format|expected JPEG/i);
  }

  console.log('CJS consumer smoke: OK');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
