// Consumer smoke test — ESM consumer (named imports from a CJS package).
import assert from 'node:assert';
import {
  bank,
  truemoney,
  post,
  parseEmvco,
  verifyCrc,
  crc16ccitt,
  HttpError,
  TopupError,
  AmountMismatchError,
} from '@zelthr/topup';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Named exports must be statically detectable (cjs-module-lexer) — if these
// resolve, the ESM interop is solid.
assert.equal(typeof bank, 'function');
assert.equal(typeof truemoney, 'function');
assert.equal(typeof parseEmvco, 'function');
assert.equal(typeof verifyCrc, 'function');

// Error classes via named import.
assert.ok(new HttpError('x') instanceof TopupError);
assert.ok(new AmountMismatchError('x') instanceof HttpError);

// Pure QR path works identically from ESM.
const body = '00020101021229370016A000000677010111011300668123456785303764540580.005802TH';
const payload = `${body}6304${crc16ccitt(`${body}6304`)}`;
assert.equal(parseEmvco(payload).crcValid, true);

// Both entry styles must see the SAME module instance (no dual-package hazard).
const cjs = require('@zelthr/topup');
assert.strictEqual(cjs.parseEmvco, parseEmvco, 'ESM and CJS must share the same instance');

// Live gateway round-trip from ESM: a fake voucher returns the upstream
// business response (200 + status.code); a malformed request surfaces the
// gateway 400 as an HttpError.
const res = await truemoney('0000000000000000', '0812345678');
assert.ok(res !== null && typeof res === 'object', `expected an object, got ${res}`);
assert.ok(typeof res.status?.code === 'string', `expected a status.code, got ${JSON.stringify(res)}`);

const err = await post('https://api.zelthr.rest/tmn', { code: 'x' }).catch((e) => e);
assert.ok(err instanceof HttpError, `expected HttpError, got ${err}`);
assert.equal(err.status, 400);

console.log('ESM consumer smoke: OK');