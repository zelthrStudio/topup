import assert from 'node:assert';
import {
  bank,
  truemoney,
  post,
  HttpError,
  TopupError,
  AmountMismatchError,
} from '@zelthr/topup';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

assert.equal(typeof bank, 'function');
assert.equal(typeof truemoney, 'function');
assert.equal(typeof post, 'function');

assert.ok(new HttpError('x') instanceof TopupError);
assert.ok(new AmountMismatchError('x') instanceof HttpError);

const cjs = require('@zelthr/topup');
assert.strictEqual(cjs.truemoney, truemoney);
assert.strictEqual(cjs.HttpError, HttpError);

// A fake voucher must reach the unified gateway endpoint and come back as a
// structured response: either a resolved object or an HttpError carrying the
// gateway's machine-readable `error` code. A 404 (removed route) would fail.
const tmn = await truemoney('0000000000000000', '0812345678').catch((e) => e);
if (tmn instanceof HttpError) {
  assert.notEqual(tmn.status, 404, `unified endpoint returned 404: ${tmn.message}`);
  assert.ok(typeof tmn.slug === 'string' && tmn.slug.length > 0, `expected a slug, got ${JSON.stringify(tmn.body)}`);
} else {
  assert.ok(tmn !== null && typeof tmn === 'object', `expected an object, got ${tmn}`);
}

// An empty body on the unified endpoint is a documented 400 bad-request.
const err = await post('https://api.zelthr.rest/', {}).catch((e) => e);
assert.ok(err instanceof HttpError, `expected HttpError, got ${err}`);
assert.equal(err.status, 400);
assert.equal(err.slug, 'bad-request');

console.log('ESM consumer smoke: OK');
