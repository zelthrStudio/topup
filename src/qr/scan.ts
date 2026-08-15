import { dynamicImport } from '../util/dynamic-import';
import { sharpFactory } from '../util/sharp';
import { sniffImageFormat, sniffUnsupportedPhoneFormat, UNSUPPORTED_PHONE_FORMAT_MESSAGE } from '../util/image-format';
import { ValidationError } from '../errors';
import { parseEmvco, type DecodedQr } from './parse';

/** Scales (relative to source) at which the WeChat detector is tried. */
const SCALES = [1, 0.75, 0.5, 2];

/** Per-scan deadline; the WASM detector itself cannot be cancelled, but
 *  callers must not block on a pathological image. */
const SCAN_TIMEOUT_MS = 30_000;

/** Dimension/pixel caps mirroring the bank() upload guards: an image at or
 *  beyond these would decode to hundreds of MB of RGBA for no benefit. */
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 40_000_000;

/**
 * Only attempt a 2x upscale when the source is small enough that enlarging it
 * could actually rescue a decode. Upscaling a tall camera photo adds no
 * information and only wastes memory (a 1682x3248 photo becomes ~83 MB of RGBA
 * at 2x). Tune against a camera-photo corpus before tightening (P1).
 */
const MAX_DIM_SCALE_2_THRESHOLD = 1200;

// @zelthr/qrcode — OpenCV WASM + WeChat QR detector, the org's own
// zero-dependency scanner (same detector as the previously vendored
// qr-scanner-wechat). It is ESM-only, so it is loaded lazily through a real
// dynamic import() (not transpiled to require) to keep this CommonJS package
// working on Node 20+.
interface QrcodeModule {
  scan(input: { data: Uint8ClampedArray; width: number; height: number }): Promise<{ text: string | null }>;
}

let scannerPromise: Promise<QrcodeModule> | null = null;

function getScanner(): Promise<QrcodeModule> {
  if (!scannerPromise) {
    // A rejected import is not cached: a transient failure (WASM init OOM,
    // ESM resolution hiccup) must not permanently brick QR decoding until
    // the process restarts — the next call retries.
    scannerPromise = (dynamicImport('@zelthr/qrcode') as Promise<QrcodeModule>).catch((error) => {
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
  if (!Buffer.isBuffer(image)) {
    return null;
  }
  // iPhone/Android camera defaults (HEIC/AVIF) are real slip photos that this
  // package cannot decode — raise a clear error instead of "no QR found".
  const unsupported = sniffUnsupportedPhoneFormat(image);
  if (unsupported) {
    throw new ValidationError(`decodeQr: ${UNSUPPORTED_PHONE_FORMAT_MESSAGE(unsupported.toUpperCase())}`);
  }
  if (!sniffImageFormat(image)) {
    return null;
  }
  const sharp = await sharpFactory();
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
  if (Math.max(width, height) > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new ValidationError(
      `decodeQr: image exceeds ${MAX_DIMENSION}px per side or ${MAX_PIXELS} pixels`
    );
  }

  const scanner = await getScanner();

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
    let result: { text: string | null } | null = null;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`decodeQr: scan exceeded ${SCAN_TIMEOUT_MS} ms`)),
        SCAN_TIMEOUT_MS
      );
    });
    try {
      result = await Promise.race([
        scanner.scan({
          data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
          width: w,
          height: h,
        }),
        deadline,
      ]);
    } catch {
      // Scan failed or timed out on this scale — nothing more to gain.
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const payload = result?.text;
    if (!payload) continue;
    return parseEmvco(payload);
  }
  return null;
}