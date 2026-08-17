'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = body;
    }
    if (req.url === '/tmn' && parsed && parsed.code === 'fail') {
      res.statusCode = 422;
      res.end(JSON.stringify({ error: 'voucher not found' }));
      return;
    }
    if (req.url === '/tmn' && parsed && parsed.code === 'redeem-100') {
      res.end(JSON.stringify({ status: { code: 'SUCCESS' }, data: { redeem: { amount_baht: '100', amount: 100 } } }));
      return;
    }
    if (req.url === '/tmn' && parsed && parsed.code === 'redeem-no-amount') {
      res.end(JSON.stringify({ status: { code: 'SUCCESS' }, data: {} }));
      return;
    }
    if (req.url === '/tmn' && parsed && parsed.code === 'redeem-fee-first') {
      res.end(JSON.stringify({ fee: { amount: 50 }, amount: 100 }));
      return;
    }
    if (req.url === '/tmn' && parsed && parsed.code === 'REDIRECT') {
      res.statusCode = 307;
      res.setHeader('Location', 'http://127.0.0.1:9/evil');
      res.end();
      return;
    }
    if (req.url === '/slip' && parsed && parsed.img === 'data:image/jpeg;base64,TEST') {
      res.end(JSON.stringify({ success: true, amount: 80 }));
      return;
    }
    if (req.url === '/slip' && parsed && parsed.img === 'data:image/jpeg;base64,NOAMOUNT') {
      res.end(JSON.stringify({ success: true, data: {} }));
      return;
    }
    const statusMatch = req.url.match(/^\/status\/(\d+)/);
    if (statusMatch) {
      const status = Number(statusMatch[1]);
      res.statusCode = status;
      if (status === 500) {
        res.end('Internal Server Error');
        return;
      }
      res.end(
        JSON.stringify({
          slug: status === 429 ? 'rate-limited' : 'http-error',
          message: `HTTP ${status}`,
        })
      );
      return;
    }
    if (req.url === '/hang' || req.url.includes('hang-secret')) {
      return;
    }
    if (req.url === '/big-error') {
      res.statusCode = 500;
      res.end('X'.repeat(70000));
      return;
    }
    if (req.url === '/raw200') {
      res.end('plain text response');
      return;
    }
    if (req.url === '/empty200') {
      res.end();
      return;
    }
    res.end(JSON.stringify({ method: req.method, url: req.url, body: parsed, headers: req.headers }));
  });
});

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TMN_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SLIP_API_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
});

function api() {
  return require('../dist/index.js');
}

test('truemoney posts {code, mobile} to /tmn', async () => {
  const res = await api().truemoney('ABCD1234EFGH', '0812345678');
  assert.equal(res.method, 'POST');
  assert.equal(res.url, '/tmn');
  assert.deepEqual(res.body, { code: 'ABCD1234EFGH', mobile: '0812345678' });
});

test('truemoney sends the raw gift link as-is (no path encoding — JSON body)', async () => {
  const link = 'https://gift.truemoney.com/campaign/?v=XXXX';
  const res = await api().truemoney(link, '0812345678');
  assert.equal(res.url, '/tmn');
  assert.equal(res.body.code, link);
});

test('truemoney normalizes spaced, hyphenated, and parenthesized phone numbers', async () => {
  const res1 = await api().truemoney('ABCD1234', ' 081 234 5678 ');
  assert.equal(res1.body.mobile, '0812345678');

  const res2 = await api().truemoney('ABCD1234', '081-234-5678');
  assert.equal(res2.body.mobile, '0812345678');

  const res3 = await api().truemoney('ABCD1234', '(081) 234-5678');
  assert.equal(res3.body.mobile, '0812345678');
});

test('truemoney normalizes international +66 and 66 phone numbers', async () => {
  const res1 = await api().truemoney('ABCD1234', '+66812345678');
  assert.equal(res1.body.mobile, '0812345678');

  const res2 = await api().truemoney('ABCD1234', '+66 81-234-5678');
  assert.equal(res2.body.mobile, '0812345678');

  const res3 = await api().truemoney('ABCD1234', '66812345678');
  assert.equal(res3.body.mobile, '0812345678');
});

test('truemoney amount check passes when the redeemed amount matches', async () => {
  const res = await api().truemoney('redeem-100', '0812345678', { amount: 100 });
  assert.equal(res.data.redeem.amount_baht, '100');
});

test('truemoney amount check throws on mismatch', async () => {
  await assert.rejects(
    () => api().truemoney('redeem-100', '0812345678', { amount: 200 }),
    (err) => err.slug === 'amount-mismatch' && /expected 200/.test(err.message)
  );
});

test('truemoney amount verification throws when no amount can be extracted', async () => {
  await assert.rejects(
    () => api().truemoney('redeem-no-amount', '0812345678', { amount: 100 }),
    (err) => err.slug === 'amount-unverifiable' && err instanceof api().AmountVerificationError
  );
  const res = await api().truemoney('redeem-no-amount', '0812345678');
  assert.equal(res.status.code, 'SUCCESS');
});

test('truemoney prefers the top-level amount over a nested fee breakdown', async () => {
  const res = await api().truemoney('redeem-fee-first', '0812345678', { amount: 100 });
  assert.equal(res.amount, 100);
  await assert.rejects(
    () => api().truemoney('redeem-fee-first', '0812345678', { amount: 50 }),
    (err) => err.slug === 'amount-mismatch'
  );
});

test('truemoney rejects an empty code', async () => {
  await assert.rejects(() => api().truemoney('', '0812345678'), /code or gift URL is required/);
});

test('truemoney rejects an invalid phone number', async () => {
  await assert.rejects(() => api().truemoney('ABCD1234', 'hello'), /10-digit Thai mobile number/);
  await assert.rejects(() => api().truemoney('ABCD1234', '081234567'), /10-digit Thai mobile number/);
  await assert.rejects(() => api().truemoney('ABCD1234', '1812345678'), /10-digit Thai mobile number/);
  await assert.rejects(() => api().truemoney('ABCD1234', '+6612345678'), /10-digit Thai mobile number/);
});

test('truemoney rejects an invalid expected amount', async () => {
  await assert.rejects(() => api().truemoney('ABCD1234', '0812345678', { amount: -5 }), /non-negative number/);
  await assert.rejects(() => api().truemoney('ABCD1234', '0812345678', { amount: NaN }), /non-negative number/);
});

test('truemoney surfaces gateway errors with status and body', async () => {
  await assert.rejects(
    () => api().truemoney('fail', '0812345678'),
    (err) => err instanceof api().HttpError && err.status === 422 && err.body.error === 'voucher not found'
  );
});

test('truemoney supports custom baseUrl and headers option', async () => {
  const customBase = `http://127.0.0.1:${server.address().port}`;
  const res = await api().truemoney('ABCD1234', '0812345678', {
    baseUrl: customBase,
    headers: { 'x-client-ver': '3.0.0' },
  });
  assert.equal(res.headers['x-client-ver'], '3.0.0');
});

test('bank posts the image as {img} data URI to /slip', async () => {
  const img = 'data:image/jpeg;base64,AAAA';
  const res = await api().bank(img);
  assert.equal(res.method, 'POST');
  assert.equal(res.url, '/slip');
  assert.equal(res.body.img, img);
  assert.equal(res.body.tos, undefined);
});

test('bank wraps bare base64 as a jpeg data URI', async () => {
  const res = await api().bank('AAAA');
  assert.equal(res.body.img, 'data:image/jpeg;base64,AAAA');
});

test('bank strips whitespaces and newlines from base64 strings', async () => {
  const multiline = 'AA AA\nBB\r\nCC';
  const res = await api().bank(multiline);
  assert.equal(res.body.img, 'data:image/jpeg;base64,AAAABBCC');
});

test('bank accepts Buffer input and converts to data URI', async () => {
  const buf = Buffer.from('TEST_IMAGE_BUFFER');
  const res = await api().bank(buf);
  assert.equal(res.body.img, `data:image/jpeg;base64,${buf.toString('base64')}`);
});

test('bank accepts Uint8Array input and converts to data URI', async () => {
  const u8 = new Uint8Array([72, 101, 108, 108, 111]);
  const res = await api().bank(u8);
  assert.equal(res.body.img, `data:image/jpeg;base64,${Buffer.from(u8).toString('base64')}`);
});

test('bank accepts ArrayBuffer input and converts to data URI', async () => {
  const ab = new Uint8Array([65, 66, 67]).buffer;
  const res = await api().bank(ab);
  assert.equal(res.body.img, `data:image/jpeg;base64,${Buffer.from(ab).toString('base64')}`);
});

test('bank returns the gateway verified-slip result as-is', async () => {
  const res = await api().bank('data:image/jpeg;base64,TEST');
  assert.deepEqual(res, { success: true, amount: 80 });
});

test('bank amount check passes when slip amount matches', async () => {
  const res = await api().bank('data:image/jpeg;base64,TEST', { amount: 80 });
  assert.deepEqual(res, { success: true, amount: 80 });
});

test('bank amount check throws AmountMismatchError on mismatch', async () => {
  await assert.rejects(
    () => api().bank('data:image/jpeg;base64,TEST', { amount: 100 }),
    (err) => err instanceof api().AmountMismatchError && /expected 100 THB but slip verified 80 THB/.test(err.message)
  );
});

test('bank amount check throws AmountVerificationError when no amount extracted', async () => {
  await assert.rejects(
    () => api().bank('data:image/jpeg;base64,NOAMOUNT', { amount: 80 }),
    (err) => err instanceof api().AmountVerificationError && err.slug === 'amount-unverifiable'
  );
});

test('bank rejects invalid expected amount', async () => {
  await assert.rejects(() => api().bank('data:image/jpeg;base64,TEST', { amount: -1 }), /non-negative number/);
  await assert.rejects(() => api().bank('data:image/jpeg;base64,TEST', { amount: NaN }), /non-negative number/);
});

test('bank rejects empty or invalid input', async () => {
  await assert.rejects(() => api().bank(''), /slip image.*is required/);
  await assert.rejects(() => api().bank('   '), /slip image.*is required/);
  await assert.rejects(() => api().bank(12345), /must be a base64 string, data URI, or binary Buffer/);
});

test('bank rejects base64 strings over the character cap', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(41 * 1024 * 1024);
  await assert.rejects(() => api().bank(big), /exceeds .* base64/);
});

test('clients never follow redirects (bodies are not re-POSTed)', async () => {
  const err = await api()
    .truemoney('REDIRECT', '0812345678')
    .catch((e) => e);
  assert.ok(err instanceof api().HttpError);
  assert.equal(err.status, 307);
  assert.match(err.message, /HTTP 307/);
  assert.doesNotMatch(err.message, /REDIRECT/);
  assert.doesNotMatch(err.message, /0812345678/);
});

test('timeout errors redact the request URL', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const err = await api()
    .post(`${base}/hang-secret/ABCD1234/0812345678`, {}, { timeoutMs: 200 })
    .catch((e) => e);
  assert.ok(err instanceof api().TimeoutError);
  assert.match(err.message, /timed out/);
  assert.doesNotMatch(err.message, /ABCD1234/);
  assert.doesNotMatch(err.message, /0812345678/);
  assert.match(err.message, /\/hang-secret\/…/);
});

test('bank non-2xx throws an HttpError with status/slug/body', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const err = await api()
    .post(`${base}/status/401`, {})
    .catch((e) => e);
  assert.ok(err instanceof api().HttpError);
  assert.equal(err.status, 401);
  assert.equal(err.slug, 'http-error');
  assert.equal(err.body.slug, 'http-error');
});

test('HTTP 429 is surfaced as a rate-limit slug', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const err = await api()
    .post(`${base}/status/429`, {})
    .catch((e) => e);
  assert.ok(err instanceof api().HttpError);
  assert.equal(err.status, 429);
  assert.equal(err.slug, 'rate-limited');
});

test('HTTP 500 with a non-JSON body keeps status and raw body', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const err = await api()
    .post(`${base}/status/500`, {})
    .catch((e) => e);
  assert.ok(err instanceof api().HttpError);
  assert.equal(err.status, 500);
  assert.match(err.message, /HTTP 500/);
  assert.equal(err.body, 'Internal Server Error');
});

test('oversized error bodies are capped to a 64KB preview', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const err = await api()
    .post(`${base}/big-error`, {})
    .catch((e) => e);
  assert.ok(err instanceof api().HttpError);
  assert.equal(err.status, 500);
  assert.equal(err.message, 'HTTP 500');
  assert.equal(err.body, undefined);
  assert.equal(err.bodyPreview.length, 65536);
});

test('non-JSON 2xx responses fail loudly (no silent raw-text pass-through)', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const err = await api()
    .post(`${base}/raw200`, {})
    .catch((e) => e);
  assert.ok(err instanceof api().HttpError);
  assert.equal(err.status, 200);
  assert.match(err.message, /not JSON/);
});

test('empty-body 2xx responses are treated as an empty JSON object', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await api().post(`${base}/empty200`, {});
  assert.deepEqual(res, {});
});

test('a request that never responds throws TimeoutError', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  const err = await api()
    .post(`${base}/hang`, {}, { timeoutMs: 200 })
    .catch((e) => e);
  assert.ok(err instanceof api().TimeoutError);
  assert.ok(err instanceof api().TopupError);
  assert.match(err.message, /timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('error classes form a catchable hierarchy', () => {
  const { ValidationError, TopupError, HttpError, AmountMismatchError, AmountVerificationError, TimeoutError } = api();
  assert.ok(new ValidationError('x') instanceof TopupError);
  assert.ok(new ValidationError('x') instanceof Error);
  assert.ok(new TimeoutError('x') instanceof TopupError);
  assert.ok(new HttpError('x') instanceof TopupError);
  assert.ok(new AmountMismatchError('x') instanceof HttpError);
  assert.equal(new AmountMismatchError('x').slug, 'amount-mismatch');
  assert.ok(new AmountVerificationError('x') instanceof HttpError);
  assert.equal(new AmountVerificationError('x').slug, 'amount-unverifiable');
});
