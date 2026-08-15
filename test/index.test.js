'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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
    if (parsed && parsed.qrcode_data === 'fail') {
      res.statusCode = 422;
      res.end(JSON.stringify({ slug: 'slip-not-found', message: 'no slip' }));
      return;
    }
    if (req.url.includes('redeem-100')) {
      res.end(JSON.stringify({ status: { code: 'SUCCESS' }, data: { redeem: { amount_baht: '100', amount: 100 } } }));
      return;
    }
    if (req.url.includes('redeem-no-amount')) {
      res.end(JSON.stringify({ status: { code: 'SUCCESS' }, data: {} }));
      return;
    }
    if (req.url.includes('redeem-fee-first')) {
      // Nested fee breakdown iterated BEFORE the real top-level amount.
      res.end(JSON.stringify({ fee: { amount: 50 }, amount: 100 }));
      return;
    }
    if (req.url.includes('REDIRECT')) {
      res.statusCode = 307;
      res.setHeader('Location', 'http://127.0.0.1:9/evil');
      res.end();
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
    if (req.url === '/hang') {
      return; // never respond — for timeout tests the client aborts
    }
    if (req.url === '/raw200') {
      res.end('plain text response');
      return;
    }
    res.end(JSON.stringify({ method: req.method, url: req.url, body: parsed }));
  });
});

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TMN_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SLIP_API_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  // Shut down the OCR worker pool so the test process can exit.
  try {
    await api().terminateAmountExtractor();
  } catch {
  }
});

function api() {
  return require('../dist/index.js');
}

test('truemoney with raw code', async () => {
  const res = await api().truemoney('ABCD1234EFGH', '0812345678');
  assert.equal(res.method, 'POST');
  assert.equal(res.url, '/truemoney/ABCD1234EFGH/0812345678');
  assert.equal(res.body, null);
});

test('truemoney with gift link is URL-encoded', async () => {
  const link = 'https://gift.truemoney.com/campaign/?v=XXXX';
  const res = await api().truemoney(link, '0812345678');
  assert.equal(res.url, `/truemoney/${encodeURIComponent(link)}/0812345678`);
});

// 1x1 transparent PNG (valid image, not a slip — just for request-shape tests).
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('bank OCR sends image to /api/slip with consent', async () => {
  const img = TINY_PNG;
  const res = await api().bank(img, 'OCR');
  assert.equal(res.url, '/api/slip');
  assert.equal(res.body.img, img);
  assert.equal(res.body.tos, true);
  assert.equal(res.body.privacy, true);
  assert.equal(res.body.eula, true);
});

test('bank manual with qrcode data hits no_slip endpoint', async () => {
  const res = await api().bank('004010123456789', 'manual', 100);
  assert.equal(res.url, '/api/slip/100/no_slip');
  assert.equal(res.body.qrcode_data, '004010123456789');
});

test('bank manual with image hits /api/slip/:amount', async () => {
  const img = TINY_PNG;
  const res = await api().bank(img, 'manual', 50);
  assert.equal(res.url, '/api/slip/50');
  assert.equal(res.body.img, img);
});

test('bank OCR requires image data', async () => {
  await assert.rejects(() => api().bank('004010123456789', 'OCR'), /requires image data/);
});

test('bank localOCR requires image data', async () => {
  await assert.rejects(() => api().bank('004010123456789', 'localOCR'), /requires image data/);
});

test('bank manual without amount and qrcode data throws', async () => {
  await assert.rejects(() => api().bank('004010123456789', 'manual'), /requires image data/);
});

test('bank throws error with slug on non-2xx', async () => {
  await assert.rejects(
    () => api().bank('fail', 'manual', 100),
    (err) => err.slug === 'slip-not-found' && err.status === 422
  );
});

test('bank throws on unknown mode', async () => {
  await assert.rejects(() => api().bank('data:image/jpeg;base64,AAAA', 'nope'), /unknown mode/);
});

// --- QR (EMVCo / Mini-QR) & Slip Verification Tests ---

test('decodeQr reads a real slip QR and parses its bank/account info', async (t) => {
  const file = path.join(__dirname, 'test1.jpg');
  if (!fs.existsSync(file)) return t.skip('test1.jpg not present');
  const qr = await api().decodeQr(fs.readFileSync(file));
  assert.ok(qr, 'expected a QR code in test1.jpg');
  assert.match(qr.payload, /^00\d{2}/);
  assert.equal(qr.accounts[0]?.bankCode, '004', 'bank code from QR sub-tag 01');
  assert.equal(qr.accounts[0]?.accountId, '016218195650BPP03857', 'transaction ref from QR sub-tag 02');
  assert.equal(qr.transRef, '016218195650BPP03857');
  assert.equal(qr.currency, '764', 'THB currency code');
  assert.equal(qr.country, 'TH', 'Thailand country code');
});

test('decodeQr reads the QR of the second real slip', async (t) => {
  const file = path.join(__dirname, 'test.jpg');
  if (!fs.existsSync(file)) return t.skip('test.jpg not present');
  const qr = await api().decodeQr(fs.readFileSync(file));
  assert.ok(qr, 'expected a QR code in test.jpg');
  assert.match(qr.payload, /^00\d{2}/);
  assert.equal(qr.accounts[0]?.bankCode, '025', 'Krungsri bank code');
  assert.equal(qr.transRef, 'KSA0000000077724361504388');
  assert.equal(qr.currency, '764');
  assert.equal(qr.country, 'TH');
});

test('parseEmvco parses PromptPay EMVCo dynamic QR with amount', () => {
  const payload = '00020101021229370016A000000677010111011300668123456785303764540580.005802TH6304ABCD';
  const qr = api().parseEmvco(payload);
  assert.equal(qr.amount, 80);
  assert.equal(qr.currency, '764');
  assert.equal(qr.country, 'TH');
  assert.equal(qr.pointOfInitiation, '12');
  assert.equal(qr.accounts[0]?.guid, 'A000000677010111');
  assert.equal(qr.accounts[0]?.accountId, '0066812345678');
});

test('getSlipAmount extracts amount from slip images via OCR', async (t) => {
  const file1 = path.join(__dirname, 'test1.jpg');
  if (fs.existsSync(file1)) {
    const res1 = await api().getSlipAmount(fs.readFileSync(file1), '004');
    assert.ok(res1.success, 'OCR should succeed on test1.jpg');
    assert.ok(res1.amounts.includes(80), 'test1.jpg should contain amount 80');
  }

  const file2 = path.join(__dirname, 'test.jpg');
  if (fs.existsSync(file2)) {
    const res2 = await api().getSlipAmount(fs.readFileSync(file2), '025');
    assert.ok(res2.success, 'OCR should succeed on test.jpg');
    assert.ok(res2.amounts.includes(500), 'test.jpg should contain amount 500');
  }
});

test('extractAmounts reads whole-baht amounts and rejects noise', () => {
  const { extractAmounts } = api();
  // Whole baht without decimals — real Thai slips print "5 บาท".
  assert.deepEqual(extractAmounts('5 unn'), [5]);
  assert.deepEqual(extractAmounts('80 บาท'), [80]);
  assert.deepEqual(extractAmounts('ยอดเงิน 999 บาท'), [999]);
  // Whole baht with thousands separators.
  assert.deepEqual(extractAmounts('1,500 บาท'), [1500]);
  assert.deepEqual(extractAmounts('100,000'), [100000]);
  // Decimal forms still work as before.
  assert.deepEqual(extractAmounts('80.50'), [80.5]);
  assert.deepEqual(extractAmounts('5.00'), [5]);
  assert.deepEqual(extractAmounts('0.00'), []);
  assert.deepEqual(extractAmounts('1,500.00'), [1500]);
  // Times, references, account suffixes and phone numbers must not match.
  assert.deepEqual(extractAmounts('14:43'), []);
  assert.deepEqual(extractAmounts('25512636416'), []);
  assert.deepEqual(extractAmounts('0471'), []);
  assert.deepEqual(extractAmounts('0812345678'), []);
  assert.deepEqual(extractAmounts('5794'), []);
  assert.deepEqual(extractAmounts('18213'), []);
  assert.deepEqual(extractAmounts('69.00'), [69]);
  // References and misread words starting/containing digits must not match.
  assert.deepEqual(extractAmounts('50BPP03857'), []);
  assert.deepEqual(extractAmounts('0.00 U1n'), []);
});

test('Paotang slip (whole-baht 5) extracts 5, not the date/time noise', async (t) => {
  const file = path.join(__dirname, 'เป๋าตัง.jpg');
  if (!fs.existsSync(file)) return t.skip('เป๋าตัง.jpg not present');
  const res = await api().getSlipAmount(fs.readFileSync(file), '006');
  assert.ok(res.success, 'OCR should succeed on the Paotang slip');
  assert.ok(res.amounts.includes(5), `expected amount 5, got ${JSON.stringify(res.amounts)}`);
  assert.ok(!res.amounts.includes(6914.43), 'date/time noise must not be reported as the amount');
});

test('bank localOCR on the Paotang slip posts /api/slip/5', async (t) => {
  const file = path.join(__dirname, 'เป๋าตัง.jpg');
  if (!fs.existsSync(file)) return t.skip('เป๋าตัง.jpg not present');
  const res = await api().bank(fs.readFileSync(file).toString('base64'), 'localOCR');
  assert.equal(res.url, '/api/slip/5');
});

test('bank localOCR resolves real slip images and hits /api/slip/:amount', async (t) => {
  const file1 = path.join(__dirname, 'test1.jpg');
  if (fs.existsSync(file1)) {
    const res1 = await api().bank(fs.readFileSync(file1).toString('base64'), 'localOCR');
    assert.equal(res1.url, '/api/slip/80');
    assert.equal(res1.body.tos, true);
  }

  const file2 = path.join(__dirname, 'test.jpg');
  if (fs.existsSync(file2)) {
    const res2 = await api().bank(fs.readFileSync(file2).toString('base64'), 'localOCR');
    assert.equal(res2.url, '/api/slip/500');
    assert.equal(res2.body.tos, true);
  }
});

test('parseEmvco re-parses the real QR payload consistently', async (t) => {
  const file = path.join(__dirname, 'test1.jpg');
  if (!fs.existsSync(file)) return t.skip('test1.jpg not present');
  const qr = await api().decodeQr(fs.readFileSync(file));
  assert.ok(qr);
  const again = api().parseEmvco(qr.payload);
  assert.deepEqual(again, qr);
});

// --- CRC verification ---

test('slip-check QR from a real slip has a valid CRC (tag 91)', async (t) => {
  const file = path.join(__dirname, 'test1.jpg');
  if (!fs.existsSync(file)) return t.skip('test1.jpg not present');
  const qr = await api().decodeQr(fs.readFileSync(file));
  assert.ok(qr?.slipCheck, 'expected a slip-check QR');
  assert.ok(qr.slipCheck.crc, 'expected a CRC tag');
  assert.equal(qr.crcValid, true, 'real slip CRC should verify');
});

test('slip-check QR from the second real slip has a valid CRC', async (t) => {
  const file = path.join(__dirname, 'test.jpg');
  if (!fs.existsSync(file)) return t.skip('test.jpg not present');
  const qr = await api().decodeQr(fs.readFileSync(file));
  assert.ok(qr?.slipCheck, 'expected a slip-check QR');
  assert.equal(qr.crcValid, true);
});

test('verifyCrc detects a tampered payload', () => {
  const payload = '0041000600000101030040220016218195650BPP038575102TH9104554A';
  assert.equal(api().verifyCrc(payload, '91'), true);
  const tampered = payload.replace('BPP03857', 'BPP03858');
  assert.equal(api().verifyCrc(tampered, '91'), false);
});

test('verifyCrc computes the known EMVCo checksum', () => {
  // CRC-16/CCITT-FALSE check value for "123456789" is 29B1.
  assert.equal(api().crc16ccitt('123456789'), '29B1');
});

test('parseEmvco surfaces crcValid on a well-formed EMVCo payload', () => {
  // CRC covers everything up to and including the tag ID + length ("6304").
  const body = '00020101021229370016A000000677010111011300668123456785303764540580.005802TH';
  const payload = `${body}6304${api().crc16ccitt(`${body}6304`)}`;
  const qr = api().parseEmvco(payload);
  assert.equal(qr.crcValid, true);
  assert.equal(qr.emvco?.crcValid, true);
  const bad = api().parseEmvco(`${body}63040000`);
  assert.equal(bad.crcValid, false);
});

function crcOverUtf16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

test('CRC hashes UTF-8 bytes — Thai merchant names verify (regression)', () => {
  const body = '00020101021229370016A000000677010111011300668123456785303764540580.005802TH5917ร้านอาหารยอดเยี่ยม';
  const payload = `${body}6304${api().crc16ccitt(`${body}6304`)}`;
  assert.equal(api().verifyCrc(payload, '63'), true);
  // A UTF-16 code-unit checksum (the old bug) differs for non-ASCII payloads.
  assert.notEqual(payload.slice(-4), crcOverUtf16(`${body}6304`));
});

test('parseEmvco ignores exponent/garbage tag-54 amounts', () => {
  const qr = api().parseEmvco('00020101021229370016A00000067701011101130066812345678530376454051e+215802TH');
  assert.equal(qr.amount, undefined);
  const ok = api().parseEmvco('00020101021229370016A000000677010111011300668123456785303764540580.005802TH');
  assert.equal(ok.amount, 80);
});

test('parseTlv caps nesting depth — crafted deep nesting cannot overflow', () => {
  let leaf = '6202AB';
  for (let i = 0; i < 300; i++) leaf = `6204${leaf}`;
  const payload = `000201${leaf}`;
  const qr = api().parseEmvco(payload);
  assert.equal(qr.payload, payload);
});

test('getSlipAmount honors an overall pipeline deadline', async (t) => {
  const file = path.join(__dirname, 'test1.jpg');
  if (!fs.existsSync(file)) return t.skip('test1.jpg not present');
  const res = await api().getSlipAmount(fs.readFileSync(file), '004', { timeoutMs: 1 });
  assert.equal(res.success, false);
  assert.match(res.error, /exceeded 1 ms/);
});

test('clients never follow redirects (bodies are not re-POSTed)', async () => {
  await assert.rejects(
    () => api().truemoney('REDIRECT', '0812345678'),
    (err) => err instanceof api().HttpError && /request failed/.test(err.message)
  );
});

// --- Input validation ---

test('truemoney rejects an empty code', async () => {
  await assert.rejects(() => api().truemoney('', '0812345678'), /code or gift URL is required/);
});

test('truemoney rejects an invalid phone number', async () => {
  await assert.rejects(() => api().truemoney('ABCD1234', 'hello'), /10-digit Thai mobile number/);
  await assert.rejects(() => api().truemoney('ABCD1234', '081234567'), /10-digit Thai mobile number/);
  await assert.rejects(() => api().truemoney('ABCD1234', '1812345678'), /10-digit Thai mobile number/);
});

test('truemoney normalizes spaced phone numbers', async () => {
  const res = await api().truemoney('ABCD1234', ' 081 234 5678 ');
  assert.equal(res.url, '/truemoney/ABCD1234/0812345678');
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
  // Without an explicit amount, the same response still resolves normally.
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

test('truemoney rejects an invalid expected amount', async () => {
  await assert.rejects(() => api().truemoney('ABCD1234', '0812345678', { amount: -5 }), /non-negative number/);
  await assert.rejects(() => api().truemoney('ABCD1234', '0812345678', { amount: NaN }), /non-negative number/);
});

test('bank OCR rejects non-image base64 data', async () => {
  const fake = Buffer.from('this is definitely not an image').toString('base64').repeat(20);
  await assert.rejects(() => api().bank(fake, 'OCR'), /not a valid image/);
});

test('bank localOCR rejects non-image base64 data', async () => {
  const fake = Buffer.from('this is definitely not an image').toString('base64').repeat(20);
  await assert.rejects(() => api().bank(fake, 'localOCR'), /not a valid image/);
});

test('bank manual accepts real images and rejects garbage', async (t) => {
  const file = path.join(__dirname, 'test1.jpg');
  if (!fs.existsSync(file)) return t.skip('test1.jpg not present');
  const img = fs.readFileSync(file).toString('base64');
  const res = await api().bank(img, 'manual', 80);
  assert.equal(res.url, '/api/slip/80');
  // Must exceed the 600-char base64 heuristic to be treated as image data.
  const fake = Buffer.from('garbage bytes that are not an image at all').toString('base64').repeat(20);
  assert.ok(fake.length > 600, 'garbage must pass the base64 heuristic');
  await assert.rejects(() => api().bank(fake, 'manual', 80), /not a valid image/);
});

test('bank manual amount is bounded to THB-plausible values', async () => {
  await assert.rejects(() => api().bank('004010123456789', 'manual', 1e21), /between 0 and 1,000,000,000/);
  await assert.rejects(() => api().bank('004010123456789', 'manual', 100.123), /at most 2 decimal places/);
  await assert.rejects(() => api().bank('004010123456789', 'manual', -5), /between 0 and 1,000,000,000/);
  const ok = await api().bank('004010123456789', 'manual', 100.5);
  assert.equal(ok.url, '/api/slip/100.5/no_slip');
});

test('bank manual treats a long QR payload (not % 4) as raw QR data, not base64', async () => {
  // 601 alnum characters: long enough for the base64 heuristic but not a
  // multiple of four, so it must be handled as raw QR data in MANUAL mode.
  const raw = '0'.repeat(601);
  const res = await api().bank(raw, 'manual', 100);
  assert.equal(res.url, '/api/slip/100/no_slip');
  assert.equal(res.body.qrcode_data, raw);
});

test('bank OCR rejects a malformed data URI (no comma)', async () => {
  await assert.rejects(() => api().bank('data:image/jpeg;base64', 'OCR'), /malformed data URI/);
});

// --- Error hierarchy ---

test('error classes form a catchable hierarchy', () => {
  const { ValidationError, TopupError, QrParseError, HttpError, AmountMismatchError, AmountVerificationError, TimeoutError } = api();
  assert.ok(new ValidationError('x') instanceof TopupError);
  assert.ok(new ValidationError('x') instanceof Error);
  assert.ok(new QrParseError('x') instanceof TopupError);
  assert.ok(new TimeoutError('x') instanceof TopupError);
  assert.ok(new HttpError('x') instanceof TopupError);
  assert.ok(new AmountMismatchError('x') instanceof HttpError);
  assert.equal(new AmountMismatchError('x').slug, 'amount-mismatch');
  assert.ok(new AmountVerificationError('x') instanceof HttpError);
  assert.equal(new AmountVerificationError('x').slug, 'amount-unverifiable');
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

test('non-JSON 2xx responses are returned as raw text', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await api().post(`${base}/raw200`, {});
  assert.equal(res, 'plain text response');
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
  assert.ok(Date.now() - started < 5000, 'timeout should fire quickly, not wait 30s');
});

// --- Strict QR parsing ---

test('strict parseEmvco throws QrParseError on malformed structure', () => {
  const { parseEmvco, QrParseError } = api();
  assert.throws(() => parseEmvco('0002015858', { strict: true }), QrParseError);
  assert.doesNotThrow(() => parseEmvco('0002015858'));
});

test('strict parseEmvco rejects truncated values', () => {
  const { parseEmvco, QrParseError } = api();
  assert.throws(() => parseEmvco('0002015802T', { strict: true }), QrParseError);
  assert.doesNotThrow(() => parseEmvco('0002015802T'));
});

test('strict parseEmvco rejects duplicate tags', () => {
  const { parseEmvco, QrParseError } = api();
  assert.throws(() => parseEmvco('0002015802TH5802TH', { strict: true }), QrParseError);
});

test('strict parseEmvco throws CrcValidationError on a bad CRC', () => {
  const { parseEmvco, CrcValidationError, crc16ccitt } = api();
  const body = '00020101021229370016A000000677010111011300668123456785303764540580.005802TH';
  const payload = `${body}6304${crc16ccitt(`${body}6304`)}`;
  assert.doesNotThrow(() => parseEmvco(payload, { strict: true }));
  assert.throws(() => parseEmvco(`${body}63040000`, { strict: true }), CrcValidationError);
});

test('strict parseSlipCheck rejects malformed payloads', () => {
  const { parseSlipCheck, QrParseError, CrcValidationError, crc16ccitt } = api();
  assert.throws(() => parseSlipCheck('0041', { strict: true }), QrParseError);
  // CRC covers the payload up to and including the tag ID + length ("9104").
  const good =
    '0041000600000101030040220016218195650BPP038575102TH9104' +
    crc16ccitt('0041000600000101030040220016218195650BPP038575102TH9104');
  assert.doesNotThrow(() => parseSlipCheck(good, { strict: true }));
  const tampered = good.replace('BPP03857', 'BPP03858');
  assert.throws(() => parseSlipCheck(tampered, { strict: true }), CrcValidationError);
});

// --- Image limits ---

test('bank OCR rejects base64 strings over the character cap', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(41 * 1024 * 1024);
  await assert.rejects(() => api().bank(big, 'OCR'), /exceeds .* base64/);
});

test('bank OCR rejects images over the decoded byte budget', async () => {
  // 33 MB of valid base64 decodes to ~24.75 MB, which trips MAX_IMAGE_BYTES.
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(33 * 1024 * 1024);
  await assert.rejects(() => api().bank(big, 'OCR'), /exceeds .* bytes/);
});

test('bank rejects images wider than MAX_DIMENSION', async () => {
  const sharp = require('sharp');
  const buf = await sharp({
    create: { width: 16385, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  await assert.rejects(() => api().bank(`data:image/png;base64,${buf.toString('base64')}`, 'OCR'), /dimension exceeds/);
});

test('bank rejects images over the pixel budget', async () => {
  const sharp = require('sharp');
  const buf = await sharp({
    create: { width: 8000, height: 5001, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  await assert.rejects(() => api().bank(buf.toString('base64'), 'OCR'), /pixels/);
});

test('bank rejects non-photo formats (GIF/TIFF) before libvips decodes them', async () => {
  const gif = Buffer.from(
    'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x00\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b'
  );
  const tiff = Buffer.concat([Buffer.from('II*\x00'), Buffer.alloc(100)]);
  await assert.rejects(() => api().bank(`data:image/gif;base64,${gif.toString('base64')}`, 'OCR'), /not a valid image/);
  await assert.rejects(() => api().bank(`data:image/tiff;base64,${tiff.toString('base64')}`, 'OCR'), /not a valid image/);
  const amt = await api().getSlipAmount(gif, '004');
  assert.equal(amt.success, false);
});

// --- OCR confidence / source ---

test('getSlipAmount reports source and confidence for real slips', async (t) => {
  const file = path.join(__dirname, 'test1.jpg');
  if (!fs.existsSync(file)) return t.skip('test1.jpg not present');
  const res = await api().getSlipAmount(fs.readFileSync(file), '004');
  assert.equal(res.success, true);
  assert.ok(['fast', 'guten', 'tesseract'].includes(res.source), `unexpected source ${res.source}`);
  if (res.source === 'fast' || res.source === 'guten') {
    assert.ok(typeof res.confidence === 'number' && res.confidence > 0, 'expected real confidence');
  }
});