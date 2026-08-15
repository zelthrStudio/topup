import { post } from './http';
import { decodeQr } from '../qr';
import { getSlipAmount, isLikelyAmount } from '../ocr/amount';
import { ValidationError, OcrError } from '../errors';
import { sniffImageFormat, sniffUnsupportedPhoneFormat, UNSUPPORTED_PHONE_FORMAT_MESSAGE } from '../util/image-format';
import { isSlipCheckPayload } from '../qr/slipcheck';
import type { TopupApiResponse } from '../types';
import { sharpFactory } from '../util/sharp';

/** Slip Verify bank-slip API base URL (override with SLIP_API_URL). */
export const SLIP_BASE: string = process.env.SLIP_API_URL || 'https://slip-c.oiio.download';

/**
 * Accepted bank slip modes. The union is closed on purpose: passing anything
 * else throws at runtime, and TypeScript flags unknown modes at compile time.
 */
export type BankMode = 'OCR' | 'LOCALOCR' | 'MANUAL';

const CONSENT = { tos: true, privacy: true, eula: true } as const;

const DATA_URI_RE = /^data:/i;
// Bare base64 must be padded (length % 4 === 0); this keeps long raw QR
// payloads (EMVCo/slip-check data, almost never a multiple of four) from
// being misclassified as image data in MANUAL mode. QR payloads are also
// identified by their distinctive prefixes before the base64 heuristic runs:
// real image base64 never starts with "000201" (JPEG/PNG/WebP magic bytes
// rule it out), and slip-check headers start with a tag-00 TLV.
const BASE64_IMAGE_RE = /^[A-Za-z0-9+/=]{600,}$/;
const EMVCO_PREFIX_RE = /^000201/;

function looksLikeQrPayload(data: string): boolean {
  return EMVCO_PREFIX_RE.test(data) || isSlipCheckPayload(data);
}

// Guard rails against memory exhaustion from oversized uploads. MAX_BASE64_LENGTH
// is a cheap pre-check on the raw string before we allocate a decoded buffer;
// MAX_IMAGE_BYTES is the operative limit on the decoded payload and is always
// reachable: 32 MB of valid base64 decodes to exactly 24 MB, so anything between
// 32 MB and the string cap trips the byte check first.
const MAX_BASE64_LENGTH = 40 * 1024 * 1024; // cheap string-level ceiling
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;   // operative decoded cap (~32 MB base64)
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 16_384;

function isImageData(data: string): boolean {
  return DATA_URI_RE.test(data) || (BASE64_IMAGE_RE.test(data) && data.length % 4 === 0);
}

function normalizeImage(data: string): string {
  return DATA_URI_RE.test(data) ? data : `data:image/jpeg;base64,${data}`;
}

function dataUriToBuffer(data: string): Buffer {
  let b64 = data;
  if (DATA_URI_RE.test(data)) {
    const comma = data.indexOf(',');
    if (comma === -1) {
      throw new ValidationError('bank: malformed data URI (missing comma)');
    }
    b64 = data.slice(comma + 1);
  }
  if (b64.length > MAX_BASE64_LENGTH) {
    throw new ValidationError(`bank: image data exceeds ${MAX_BASE64_LENGTH} bytes of base64`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ValidationError(`bank: image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  return buf;
}

/**
 * Confirm the data actually decodes as a supported image (JPEG/PNG/WebP) and is
 * within the size/dimension/pixel limits. The format is sniffed from magic
 * bytes first so libvips' GIF/TIFF/VIPS decoders never process untrusted input;
 * sharp is only asked to decode bytes we already believe are a slip photo.
 */
async function assertImageBuffer(buf: Buffer): Promise<void> {
  if (!sniffImageFormat(buf)) {
    const unsupported = sniffUnsupportedPhoneFormat(buf);
    throw new ValidationError(
      unsupported
        ? `bank: ${UNSUPPORTED_PHONE_FORMAT_MESSAGE(unsupported.toUpperCase())}`
        : 'bank: data is not a valid image (expected JPEG, PNG or WebP)'
    );
  }
  let meta: { width?: number; height?: number };
  try {
    meta = await (await sharpFactory())(buf).metadata();
  } catch (cause) {
    throw new ValidationError('bank: data is not a valid image', { cause });
  }
  const { width, height } = meta;
  if (!width || !height) throw new ValidationError('bank: image has no dimensions');
  if (Math.max(width, height) > MAX_DIMENSION) {
    throw new ValidationError(`bank: image dimension exceeds ${MAX_DIMENSION}px`);
  }
  if (width * height > MAX_PIXELS) {
    throw new ValidationError(`bank: image exceeds ${MAX_PIXELS} pixels`);
  }
}

/**
 * Resolve the slip amount locally, QR-first:
 *   1. PromptPay QR (EMVCo tag 54) — exact amount, no OCR needed.
 *   2. Thai slip-check QR — gives the bank code for the OCR crop/profile.
 *   3. Local OCR engines (Guten OCR/ONNX + tesseract fallback).
 */
async function resolveAmount(image: Buffer): Promise<number> {
  let bankCode: string | undefined;
  try {
    const qr = await decodeQr(image);
    if (qr) {
      bankCode = qr.slipCheck?.bankCode ?? qr.emvco?.accounts[0]?.bankCode;
      const emv = qr.emvco;
      // Trust the QR amount only when the payload either carries no CRC claim
      // (many real PromptPay QRs have no tag 63) or the claimed CRC verifies.
      // A payload that claims a CRC but fails it is tampered/corrupt — never
      // let its amount win over what OCR reads from the actual slip.
      const crcOk = emv === undefined || emv.raw['63'] === undefined || emv.crcValid === true;
      if (crcOk && emv?.amount != null && Number.isFinite(emv.amount)) return emv.amount;
    }
  } catch {
    // QR failed — fall through to OCR.
  }
  const res = await getSlipAmount(image, bankCode, { stopOnLikelyAmount: true });
  if (!res.success || res.amounts.length === 0) {
    throw new OcrError('bank: amount not found in image');
  }
  // Prefer the amount that several strategies agree on (per-strategy counts in
  // res.counts); tie-break toward the SMALLER amount so an OCR misread that
  // inflates a digit can never win a tie. Fall back to the largest likely
  // amount when nothing agrees, so a single OCR misread of an inflated
  // figure cannot drive the API lookup on its own.
  const candidates = res.amounts.filter(isLikelyAmount);
  const pool = candidates.length > 0 ? candidates : res.amounts;
  const counts = res.counts ?? {};
  let best = pool[0];
  let bestCount = -1;
  for (const amount of pool) {
    const count = counts[amount] ?? 1;
    if (count > bestCount || (count === bestCount && amount < best)) {
      best = amount;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Verify a bank slip.
 *
 * @param data   Slip image (base64 or data URI) or, in MANUAL mode, raw QR data
 * @param mode   'OCR' (remote slip API), 'LOCALOCR' (QR + local OCR amount, then
 *               slip API), or 'MANUAL' (amount given explicitly or read locally)
 * @param amount Optional explicit amount; required for MANUAL without an image
 */
export async function bank(
  data: string,
  mode: BankMode = 'OCR',
  amount?: number
): Promise<TopupApiResponse | string> {
  const m = String(mode || 'OCR').toUpperCase();
  if (!['OCR', 'LOCALOCR', 'MANUAL'].includes(m)) {
    throw new ValidationError(`bank: unknown mode "${mode}" (use OCR, manual or localOCR)`);
  }
  // Max plausible THB slip amount (1e9 stays well inside the range where
  // JS stringifies numbers without exponential notation) and satang precision
  // (2 decimal places) — anything else would produce a mangled /api/slip/:amt
  // URL or a garbage comparison value.
  if (
    amount !== undefined &&
    (typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      amount > 1_000_000_000 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6)
  ) {
    throw new ValidationError('bank: amount must be a finite number between 0 and 1,000,000,000 with at most 2 decimal places');
  }
  const image = !looksLikeQrPayload(data) && isImageData(data) ? normalizeImage(data) : null;
  const qr = image ? null : data;

  if (m === 'OCR') {
    if (!image) throw new ValidationError('bank: OCR mode requires image data (base64 or data URI)');
    await assertImageBuffer(dataUriToBuffer(image));
    return post(`${SLIP_BASE}/api/slip`, { img: image, ...CONSENT });
  }

  if (m === 'LOCALOCR') {
    if (!image) throw new ValidationError('bank: localOCR mode requires image data');
    const buf = dataUriToBuffer(image);
    await assertImageBuffer(buf);
    const detected = await resolveAmount(buf);
    return post(`${SLIP_BASE}/api/slip/${detected}`, { img: image, ...CONSENT });
  }

  if (m === 'MANUAL') {
    let amt = amount;
    let buf: Buffer | undefined;
    if (image) {
      buf = dataUriToBuffer(image);
      await assertImageBuffer(buf);
    }
    if (amt == null) {
      if (!buf) throw new ValidationError('bank: manual mode without amount requires image data (or pass amount)');
      amt = await resolveAmount(buf);
    }
    if (buf) {
      return post(`${SLIP_BASE}/api/slip/${amt}`, { img: image, ...CONSENT });
    }
    return post(`${SLIP_BASE}/api/slip/${amt}/no_slip`, { qrcode_data: qr, ...CONSENT });
  }
  throw new Error(`bank: unreachable mode "${mode}"`);
}