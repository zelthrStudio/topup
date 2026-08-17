'use strict';
// Consumer smoke test - CommonJS consumer using the installed tarball.
// Exercises the public surface + live round-trips against api.zelthr.rest.
const assert = require('node:assert');
const topup = require('@zelthr/topup');

async function main() {
  // 1. Every public export must be present.
  const expected = [
    'truemoney', 'TMN_BASE', 'bank', 'SLIP_BASE', 'post',
    'TopupError', 'ValidationError',
    'TimeoutError', 'HttpError', 'AmountMismatchError', 'AmountVerificationError',
  ];
  for (const name of expected) {
    assert.ok(topup[name] !== undefined, `missing export: ${name}`);
  }

  // 2. Error hierarchy works.
  assert.ok(new topup.ValidationError('x') instanceof topup.TopupError);
  assert.ok(new topup.AmountMismatchError('x') instanceof topup.HttpError);
  assert.equal(new topup.AmountMismatchError('x').slug, 'amount-mismatch');

  // 3. Live gateway round-trip — a fake voucher code returns the upstream
  //    business response (200 with status.code VOUCHER_NOT_FOUND); the
  //    gateway is reachable either way.
  const res = await topup.truemoney('0000000000000000', '0812345678');
  assert.ok(res !== null && typeof res === 'object', `expected an object, got ${res}`);
  assert.ok(typeof res.status?.code === 'string', `expected a status.code, got ${JSON.stringify(res)}`);

  // 3b. A malformed request (missing mobile) must surface the gateway 400 as
  //     an HttpError — exercises the non-2xx path.
  const err = await topup.post('https://api.zelthr.rest/tmn', { code: 'x' }).catch((e) => e);
  assert.ok(err instanceof topup.HttpError, `expected HttpError, got ${err}`);
  assert.equal(err.status, 400);

  // 4. Live gateway round-trip — a garbage image must be rejected client-side
  //    as validation, or by the gateway as invalid-image; both are fine.
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