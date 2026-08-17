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

const res = await truemoney('0000000000000000', '0812345678');
assert.ok(res !== null && typeof res === 'object', `expected an object, got ${res}`);
assert.ok(typeof res.status?.code === 'string', `expected a status.code, got ${JSON.stringify(res)}`);

const err = await post('https://api.zelthr.rest/tmn', { code: 'x' }).catch((e) => e);
assert.ok(err instanceof HttpError, `expected HttpError, got ${err}`);
assert.equal(err.status, 400);

console.log('ESM consumer smoke: OK');