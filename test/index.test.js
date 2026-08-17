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
      // Nested fee breakdown iterated BEFORE the real top-level amount.
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
      return; // never respond — for timeout tests the client aborts
    }
    if (req.url === '/big-error') {
      res.statusCode = 500;
      res.end('X'.repeat(70000)); // oversized error body (>64KB cap)
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
});

function api() {
  return require('../dist/index.js');
}

// --- Gateway client: truemoney() → POST /tmn ---

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

test('truemoney normalizes spaced phone numbers', async () => {
  const res = await api().truemoney('ABCD1234', ' 081 234 5678 ');
  assert.equal(res.body.mobile, '0812345678');
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

// --- Gateway client: bank() → POST /slip ---

test('bank posts the image as {img} data URI to /slip', async () => {
  const img = 'data:image/jpeg;base64,AAAA';
  const res = await api().bank(img);
  assert.equal(res.method, 'POST');
  assert.equal(res.url, '/slip');
  assert.equal(res.body.img, img);
  assert.equal(res.body.tos, undefined, 'no consent flags — the gateway handles the pipeline');
});

test('bank wraps bare base64 as a jpeg data URI', async () => {
  const res = await api().bank('AAAA');
  assert.equal(res.body.img, 'data:image/jpeg;base64,AAAA');
});

test('bank returns the gateway verified-slip result as-is', async () => {
  const res = await api().bank('data:image/jpeg;base64,TEST');
  assert.deepEqual(res, { success: true, amount: 80 });
});

test('bank rejects empty input', async () => {
  await assert.rejects(() => api().bank(''), /slip image.*is required/);
  await assert.rejects(() => api().bank('   '), /slip image.*is required/);
});

test('bank rejects base64 strings over the character cap', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(41 * 1024 * 1024);
  await assert.rejects(() => api().bank(big), /exceeds .* base64/);
});

// --- Shared HTTP behavior ---

test('clients never follow redirects (bodies are not re-POSTed)', async () => {
  const err = await api()
    .truemoney('REDIRECT', '0812345678')
    .catch((e) => e);
  assert.ok(err instanceof api().HttpError);
  assert.equal(err.status, 307);
  assert.match(err.message, /HTTP 307/);
  // The gift code and phone live in the JSON body — error messages must never
  // expose either.
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
  assert.equal(err.body, undefined, 'full body must not be retained');
  assert.equal(err.bodyPreview.length, 65536, 'preview is capped at 64KB');
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
  assert.ok(Date.now() - started < 5000, 'timeout should fire quickly, not wait 30s');
});

// --- Error hierarchy ---

test('error classes form a catchable hierarchy', () => {
  const { ValidationError, TopupError, QrParseError, CrcValidationError, HttpError, AmountMismatchError, AmountVerificationError, TimeoutError } = api();
  assert.ok(new ValidationError('x') instanceof TopupError);
  assert.ok(new ValidationError('x') instanceof Error);
  assert.ok(new QrParseError('x') instanceof TopupError);
  assert.ok(new CrcValidationError('x') instanceof TopupError);
  assert.ok(new TimeoutError('x') instanceof TopupError);
  assert.ok(new HttpError('x') instanceof TopupError);
  assert.ok(new AmountMismatchError('x') instanceof HttpError);
  assert.equal(new AmountMismatchError('x').slug, 'amount-mismatch');
  assert.ok(new AmountVerificationError('x') instanceof HttpError);
  assert.equal(new AmountVerificationError('x').slug, 'amount-unverifiable');
});

// --- Strict QR parsing (pure string utilities — kept) ---

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
  const good =
    '0041000600000101030040220016218195650BPP038575102TH9104' +
    crc16ccitt('0041000600000101030040220016218195650BPP038575102TH9104');
  assert.doesNotThrow(() => parseSlipCheck(good, { strict: true }));
  const tampered = good.replace('BPP03857', 'BPP03858');
  assert.throws(() => parseSlipCheck(tampered, { strict: true }), CrcValidationError);
});

test('non-digit TLV length fields stop parsing instead of misparsing', () => {
  const { parseSlipCheck, parseEmvco, QrParseError } = api();
  assert.deepEqual(parseSlipCheck('011x123456789').raw, {});
  assert.throws(() => parseSlipCheck('011x123456789', { strict: true }), QrParseError);
  assert.deepEqual(parseEmvco('000201011x123456789').payload, '000201011x123456789');
  assert.throws(() => parseEmvco('000201011x123456789', { strict: true }), QrParseError);
});

test('a v2-format slip-check QR (new version, 4-digit bank code) still parses', () => {
  const { parseEmvco, crc16ccitt } = api();
  const inner = '00' + '06' + '000002' + '01' + '04' + '0004' + '02' + '11' + '12345678901';
  const body = '00' + '33' + inner + '51' + '02' + 'TH';
  const payload = body + '91' + '04' + crc16ccitt(body + '9104');
  const qr = api().parseEmvco(payload);
  assert.ok(qr.slipCheck, 'v2 payload must be recognized as slip-check (not raw)');
  assert.equal(qr.slipCheck.version, '000002');
  assert.equal(qr.slipCheck.bankCode, '0004');
  assert.equal(qr.slipCheck.reference, '12345678901');
  assert.equal(qr.slipCheck.crcValid, true);
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
  const body = '00020101021229370016A000000677010111011300668123456785303764540580.005802TH';
  const payload = `${body}6304${api().crc16ccitt(`${body}6304`)}`;
  const qr = api().parseEmvco(payload);
  assert.equal(qr.crcValid, true);
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
  assert.notEqual(payload.slice(-4), crcOverUtf16(`${body}6304`));
});

// --- PromptPay QR generation (getQrCodePromptPay — kept) ---

test('getQrCodePromptPay generates a valid dynamic EMVCo payload (mobile, amount)', async () => {
  const r = await api().getQrCodePromptPay('0812345678', { amount: 100 });
  assert.equal(r.type, 'mobile');
  assert.equal(r.target, '0066812345678');
  const parsed = api().parseEmvco(r.payload);
  assert.equal(parsed.crcValid, true);
  assert.equal(parsed.amount, 100);
  assert.equal(parsed.pointOfInitiation, '12');
  assert.deepEqual(parsed.accounts, [{ guid: 'A000000677010111', accountId: '0066812345678' }]);
  assert.ok(Buffer.isBuffer(r.png) && r.png.length > 0);
  assert.ok(r.svg.startsWith('<svg'));
  assert.ok(r.qr.size >= 21 && r.qr.matrix.length === r.qr.size * r.qr.size);
});

test('getQrCodePromptPay without amount generates a static QR', async () => {
  const r = await api().getQrCodePromptPay('0812345678');
  assert.equal(r.payload.includes('010211'), true);
  assert.equal(r.payload.includes('010111'), true);
  assert.equal(api().parseEmvco(r.payload).amount, undefined);
});

test('getQrCodePromptPay detects national ID and e-wallet IDs', async () => {
  const nat = await api().getQrCodePromptPay('1234567890123');
  assert.equal(nat.type, 'nationalId');
  assert.equal(nat.target, '1234567890123');
  const ew = await api().getQrCodePromptPay('123456789012345');
  assert.equal(ew.type, 'ewalletId');
  assert.equal(ew.target, '123456789012345');
});

test('getQrCodePromptPay normalizes +66 international phone format', async () => {
  const a = await api().getQrCodePromptPay('+66 81 234 5678');
  const b = await api().getQrCodePromptPay('0812345678');
  assert.equal(a.target, b.target);
  assert.equal(a.target, '0066812345678');
});

test('getQrCodePromptPay rejects invalid IDs and amounts with ValidationError', async () => {
  await assert.rejects(() => api().getQrCodePromptPay('12345'), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay(''), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('123456789012'), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('12345678901234'), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('0812345678', { amount: 0 }), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('0812345678', { amount: -5 }), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('0812345678', { amount: 100.001 }), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('0812345678', { amount: 200000.01 }), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay(123), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('0812345678', { scale: 0 }), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('0812345678', { scale: NaN }), (e) => e instanceof api().ValidationError);
  await assert.rejects(() => api().getQrCodePromptPay('0812345678', { scale: -2 }), (e) => e instanceof api().ValidationError);
});

test('getQrCodePromptPay respects the maxAmount override', async () => {
  const r = await api().getQrCodePromptPay('0812345678', { amount: 250000, maxAmount: 300000 });
  assert.equal(api().parseEmvco(r.payload).amount, 250000);
});

test('MAX_PROMPTPAY_AMOUNT is the BOT 200000 Baht limit', () => {
  assert.equal(api().MAX_PROMPTPAY_AMOUNT, 200000);
});