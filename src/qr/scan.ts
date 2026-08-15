import sharp from 'sharp';
import { dynamicImport } from '../util/dynamic-import';
import { sniffImageFormat } from '../util/image-format';
import { ValidationError } from '../errors';
import { parseEmvco, type DecodedQr } from './parse';

/** Scales (relative to source) at which the WeChat detector is tried. */
const SCALES = [1, 0.75, 0.5, 2];

/**
 * Only attempt a 2x upscale when the source is small enough that enlarging it
 * could actually rescue a decode. Upscaling a tall camera photo adds no
 * information and only wastes memory (a 1682x3248 photo becomes ~83 MB of RGBA
 * at 2x). Tune against a camera-photo corpus before tightening (P1).
 */
const MAX_DIM_SCALE_2_THRESHOLD = 1200;

interface ScanResult {
  text: string | null;
}

interface ScanInput {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// qr-scanner-wechat — OpenCV WASM + WeChat QR detector, far more tolerant of
// skewed / low-quality camera photos than jsQR. It is ESM-only, so it is
// loaded lazily through a real dynamic import() (not transpiled to require)
// to keep this CommonJS package working on Node 18+.
let scannerPromise: Promise<Record<string, any>> | null = null;

function getScanner(): Promise<Record<string, any>> {
  if (!scannerPromise) {
    scannerPromise = dynamicImport('qr-scanner-wechat').catch((error) => {
      scannerPromise = null;
      throw error;
    });
  }
  return scannerPromise;
}

/**
 * Decode a QR code from a slip image Buffer using the OpenCV/WeChat detector.
 * Returns the parsed payload, or null when no QR is found.
 *
 * Security: only image bytes (Buffer) are accepted — file paths are rejected
 * so untrusted input can never read local files — and the container format is
 * sniffed from magic bytes before libvips/sharp is asked to decode anything
 * (blocks the GIF/TIFF/VIPS decoder CVEs, see SECURITY-AUDIT.md).
 * Camera photos are tried at several scales.
 */
export async function decodeQr(image: Buffer): Promise<DecodedQr | null> {
  if (typeof image === 'string') {
    throw new ValidationError('decodeQr: pass image bytes as a Buffer, not a file path');
  }
  if (!Buffer.isBuffer(image) || !sniffImageFormat(image)) {
    return null;
  }
  let width: number;
  let height: number;
  try {
    const meta = await sharp(image).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    return null;
  }
  if (width === 0 || height === 0) return null;

  const scanner = await getScanner();
  const scan = scanner.scan as (input: ScanInput) => Promise<ScanResult>;

  // Decode the source once to raw RGBA; each scale below is derived from this
  // buffer instead of re-decoding the compressed image per scale.
  let source: Buffer;
  try {
    ({ data: source } = await sharp(image)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return null;
  }
  const maxDim = Math.max(width, height);

  for (const scale of SCALES) {
    if (scale > 1 && maxDim >= MAX_DIM_SCALE_2_THRESHOLD) continue;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    let data: Buffer = source;
    if (w !== width || h !== height) {
      try {
        ({ data } = await sharp(source, { raw: { width, height, channels: 4 } })
          .resize({ width: w, height: h })
          .raw()
          .toBuffer({ resolveWithObject: true }));
      } catch {
        continue;
      }
    }
    // Zero-copy view: cv.imread requires a Uint8ClampedArray and copies it into
    // the WASM heap anyway, so an extra full copy here would be purely additive.
    const result = await scan({
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      width: w,
      height: h,
    });
    const payload = result?.text;
    if (!payload) continue;
    return parseEmvco(payload);
  }
  return null;
}