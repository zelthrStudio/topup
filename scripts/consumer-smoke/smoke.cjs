'use strict';
// Consumer smoke test — CommonJS consumer using the installed tarball.
// Expects: the tarball installed as @zelthr/topup in the CWD's node_modules,
// and test1.jpg copied next to this file (or set TOPUP_SMOKE_IMAGE).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const topup = require('@zelthr/topup');

async function main() {
  // 1. Every public export must be present.
  const expected = [
    'truemoney', 'TMN_BASE', 'bank', 'SLIP_BASE', 'post',
    'TopupError', 'ValidationError', 'QrParseError', 'CrcValidationError',
    'OcrError', 'OcrTimeoutError', 'TimeoutError', 'HttpError', 'AmountMismatchError',
    'getSlipAmount', 'CROP_PROFILES', 'extractAmounts', 'isLikelyAmount',
    'warmupAmountExtractor', 'terminateAmountExtractor',
    'decodeQr', 'parseEmvco', 'parseSlipCheck', 'verifyCrc', 'crc16ccitt',
  ];
  for (const name of expected) {
    assert.ok(topup[name] !== undefined, `missing export: ${name}`);
  }

  // 2. Error hierarchy works.
  assert.ok(new topup.ValidationError('x') instanceof topup.TopupError);
  assert.ok(new topup.AmountMismatchError('x') instanceof topup.HttpError);
  assert.equal(new topup.AmountMismatchError('x').slug, 'amount-mismatch');

  // 3. QR parsing + CRC (pure, no network).
  const body = '00020101021229370016A000000677010111011300668123456785303764540580.005802TH';
  const payload = `${body}6304${topup.crc16ccitt(`${body}6304`)}`;
  assert.equal(topup.parseEmvco(payload).crcValid, true);
  assert.equal(topup.verifyCrc('0041000600000101030040220016218195650BPP038575102TH9104554A', '91'), true);

  // 4. Real slip QR decode + amount OCR (exercises sharp + onnxruntime + tesseract).
  const imgPath = process.env.TOPUP_SMOKE_IMAGE || path.join(__dirname, 'test1.jpg');
  if (fs.existsSync(imgPath)) {
    const buf = fs.readFileSync(imgPath);
    const qr = await topup.decodeQr(buf);
    assert.ok(qr?.slipCheck, 'expected a slip-check QR');
    assert.equal(qr.crcValid, true);

    const amt = await topup.getSlipAmount(buf, '004');
    assert.equal(amt.success, true, `OCR failed: ${amt.error}`);
    assert.ok(amt.amounts.includes(80), `expected 80, got ${amt.amounts.join(',')}`);
    assert.ok(['fast', 'guten', 'tesseract'].includes(amt.source), `bad source ${amt.source}`);
  }

  // 5. The format allowlist rejects non-slip image formats before libvips.
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x00\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b');
  const res = await topup.getSlipAmount(gif, '004');
  assert.equal(res.success, false, 'GIF must be rejected by the format gate');

  // Release the OCR worker pool so the process can exit on its own.
  await topup.terminateAmountExtractor();

  console.log('CJS consumer smoke: OK');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});