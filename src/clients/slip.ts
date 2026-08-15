import { post } from './http';
import { decodeQr } from '../qr';
import { getSlipAmount, isLikelyAmount } from '../ocr/amount';
import { ValidationError, OcrError } from '../errors';
import { sniffImageFormat } from '../util/image-format';
import type { TopupApiResponse } from '../types';
import sharp from 'sharp';

/** Slip Verify bank-slip API base URL (override with SLIP_API_URL). */
export const SLIP_BASE: string = process.env.SLIP_API_URL || 'https://slip-c.oiio.download';

/**
 * Accepted bank slip modes. The union is closed on purpose: passing anything
 * else throws at runtime, and TypeScript flags unknown modes at compile time.
 */
export type BankMode = 'OCR' | 'LOCALOCR' | 'MANUAL';

const CONSENT = { tos: true, privacy: true, eula: true } as const;

const DATA_URI_RE = /^data:/i;
const BASE64_IMAGE_RE = /^[A-Za-z0-9+/=]{600,}$/;

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
  return DATA_URI_RE.test(data) || BASE64_IMAGE_RE.test(data);
}

function normalizeImage(data: string): string {
  return DATA_URI_RE.test(data) ? data : `data:image/jpeg;base64,${data}`;
}

function dataUriToBuffer(data: string): Buffer {
  const b64 = DATA_URI_RE.test(data) ? data.slice(data.indexOf(',') + 1) : data;
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
    throw new ValidationError('bank: data is not a valid image (expected JPEG, PNG or WebP)');
  }
  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(buf).metadata();
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
      if (qr.emvco?.amount != null) return qr.emvco.amount;
    }
  } catch {
    // QR failed — fall through to OCR.
  }
  const res = await getSlipAmount(image, bankCode, { stopOnLikelyAmount: true });
  if (!res.success || res.amounts.length === 0) {
    throw new OcrError('bank: amount not found in image');
  }
  // Prefer the amount that several strategies agree on (per-strategy counts in
  // res.counts); tie-break toward the largest. Fall back to the largest
  // likely amount when nothing agrees, so a single OCR misread of an inflated
  // figure cannot drive the API lookup on its own.
  const candidates = res.amounts.filter(isLikelyAmount);
  const pool = candidates.length > 0 ? candidates : res.amounts;
  const counts = res.counts ?? {};
  let best = pool[0];
  let bestCount = -1;
  for (const amount of pool) {
    const count = counts[amount] ?? 1;
    if (count > bestCount || (count === bestCount && amount > best)) {
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
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
    throw new ValidationError('bank: amount must be a non-negative finite number');
  }
  const image = isImageData(data) ? normalizeImage(data) : null;
  const qr = image ? null : data;

  if (m === 'OCR') {
    if (!image) throw new ValidationError('bank: OCR mode requires image data (base64 or data URI)');
    await assertImageBuffer(dataUriToBuffer(image));
    return post(`${SLIP_BASE}/api/slip`, { img: image, ...CONSENT });
  }

  if (m === 'LOCALOCR') {
    if (!image) throw new ValidationError('bank: localOCR mode requires image data');
    await assertImageBuffer(dataUriToBuffer(image));
    const detected = await resolveAmount(dataUriToBuffer(image));
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