import sharp from 'sharp';
import { CROP_PROFILES, DEFAULT_CROP, PROFILES, type BankProfile } from './profiles';
import { extractAmounts, isLikelyAmount } from './extract';
import { getOcrInstance, resetOcrInstance, runOCRLines } from './engines/guten';
import { runTesseractOCR, terminateTesseractPool, warmupTesseract } from './engines/tesseract';
import { sniffImageFormat } from '../util/image-format';

/** Which strategy produced the extracted amounts. */
export type AmountSource = 'fast' | 'guten' | 'tesseract';

export interface AmountResult {
  success: boolean;
  amounts: number[];
  /** Engine/strategy that produced the amounts. */
  source?: AmountSource;
  /** Mean recognition confidence of the contributing line(s) (Guten only). */
  confidence?: number;
  error?: string;
}

interface AmountOptions {
  collectAll?: boolean;
  stopOnLikelyAmount?: boolean;
}

interface ImageMeta {
  width: number;
  height: number;
}

// OCR engines initialize lazily on first use: importing this package (e.g. by
// consumers who only call truemoney()/bank() remote modes) never loads the
// ONNX models or spawns the ~200MB tesseract worker pool. Call
// warmupAmountExtractor() explicitly to pre-warm before the first local OCR.
export async function warmupAmountExtractor(): Promise<void> {
  await getOcrInstance();
  await warmupTesseract();
}

async function getImageMeta(imageBuffer: Buffer): Promise<ImageMeta> {
  const meta = await sharp(imageBuffer).metadata();
  return { width: meta.width ?? 1, height: meta.height ?? 1 };
}

// Thai bank slips print the big bold amount digits in the bottom-right band.
// OCR-ing only that band at a reduced scale is much faster because the ONNX
// detection cost scales with input pixels (see engines/guten). Fallbacks in
// getSlipAmount below preserve full-image accuracy when the band misses.
const FAST_AMOUNT_BAND = { leftPct: 50, topPct: 25, bottomPct: 5, width: 600 };

async function cropAmountBand(imageBuffer: Buffer, meta?: ImageMeta): Promise<Buffer> {
  const { width: w, height: h } = meta ?? (await getImageMeta(imageBuffer));
  const left = Math.floor(w * (FAST_AMOUNT_BAND.leftPct / 100));
  const top = Math.floor(h * (FAST_AMOUNT_BAND.topPct / 100));
  const height = h - top - Math.floor(h * (FAST_AMOUNT_BAND.bottomPct / 100));
  return sharp(imageBuffer).extract({ left, top, width: w - left, height }).toBuffer();
}

/** Run Guten on a (possibly pipelined) buffer and report the extracted amounts
 *  together with the mean confidence of the lines that contributed them. */
async function gutenExtract(
  buf: Promise<Buffer>
): Promise<{ amounts: number[]; confidence?: number }> {
  const lines = await runOCRLines(await buf);
  const found = new Set<number>();
  let conf = 0;
  for (const line of lines) {
    const amounts = extractAmounts(line.text);
    if (amounts.length > 0) {
      amounts.forEach((amount) => found.add(amount));
      conf = Math.max(conf, line.mean);
    }
  }
  return { amounts: Array.from(found), confidence: conf > 0 ? conf : undefined };
}

async function cropImage(imageBuffer: Buffer, topPct: number, bottomPct: number, meta?: ImageMeta): Promise<Buffer> {
  if (topPct === 0 && bottomPct === 0) return imageBuffer;
  const { width: w, height: h } = meta ?? (await getImageMeta(imageBuffer));
  const top = Math.floor(h * (topPct / 100));
  const cropH = Math.max(1, Math.floor(h * (1 - topPct / 100 - bottomPct / 100)));
  return sharp(imageBuffer).extract({ left: 0, top, width: w, height: cropH }).toBuffer();
}

function processWithProfile(buf: Buffer, profile: BankProfile): Promise<Buffer> {
  return sharp(buf)
    .modulate({ brightness: profile.brightness })
    .linear(profile.contrast, 0)
    .resize({ width: profile.width })
    .threshold(profile.threshold)
    .toBuffer();
}

function processWithWidth(buf: Buffer, profile: BankProfile, width: number): Promise<Buffer> {
  return sharp(buf)
    .modulate({ brightness: profile.brightness })
    .linear(profile.contrast, 0)
    .resize({ width })
    .threshold(profile.threshold)
    .toBuffer();
}

// Tesseract is resolution-tolerant and slow; feeding it full-resolution camera
// photos wastes time. Only downscale when the source is large (maxDim > 1600),
// capping the longest side at ~1100px.
const TESSERACT_MAX_INPUT_DIM = 1600;
const TESSERACT_TARGET_DIM = 1100;

async function capForTesseract(imageBuffer: Buffer, meta?: ImageMeta): Promise<Buffer> {
  const { width: w, height: h } = meta ?? (await getImageMeta(imageBuffer));
  const maxDim = Math.max(w, h);
  if (maxDim <= TESSERACT_MAX_INPUT_DIM) return imageBuffer;
  const scale = TESSERACT_TARGET_DIM / maxDim;
  return sharp(imageBuffer)
    .resize({ width: Math.round(w * scale), height: Math.round(h * scale) })
    .toBuffer();
}

/**
 * Extract candidate slip amounts from an image.
 *
 * @param imageBuffer Slip image (PNG/JPEG/WebP buffer).
 * @param bankCode    Optional bank code ('002', '004', ...) to pick the
 *                    crop/profile; detected from the QR when available.
 * @param options     collectAll: return every candidate; stopOnLikelyAmount:
 *                    stop early once a whole/0.50-baht amount is found.
 */
export async function getSlipAmount(
  imageBuffer: Buffer,
  bankCode?: string,
  options: AmountOptions = {}
): Promise<AmountResult> {
  try {
    // Gate the format before any libvips decode: only slip photo formats
    // (JPEG/PNG/WebP) are processed. See util/image-format.
    if (!sniffImageFormat(imageBuffer)) {
      return {
        success: false,
        error: 'amount: unsupported image format (expected JPEG, PNG or WebP)',
        amounts: [],
      };
    }
    const uniqueAmounts = new Set<number>();
    let bestSource: AmountSource | undefined;
    let bestConfidence = 0;
    const record = (amounts: number[], source: AmountSource, confidence?: number): void => {
      if (amounts.length === 0) return;
      amounts.forEach((amount) => uniqueAmounts.add(amount));
      if (confidence !== undefined && confidence > bestConfidence) {
        bestConfidence = confidence;
        bestSource = source;
      }
      if (bestSource === undefined) bestSource = source;
    };
    const cropCfg = CROP_PROFILES[bankCode ?? ''] ?? DEFAULT_CROP;
    const primaryProfile = PROFILES[cropCfg.profile] ?? PROFILES.default;
    const needsCrop = cropCfg.cropTop > 0 || cropCfg.cropBottom > 0;
    const meta = needsCrop ? await getImageMeta(imageBuffer) : undefined;
    const cropped = needsCrop
      ? await cropImage(imageBuffer, cropCfg.cropTop, cropCfg.cropBottom, meta)
      : imageBuffer;

    const bufCache = new Map<string, Promise<Buffer>>();
    const processOnce = (key: string, profile: BankProfile, base: Buffer): Promise<Buffer> => {
      let p = bufCache.get(key);
      if (!p) {
        p = processWithProfile(base, profile);
        bufCache.set(key, p);
      }
      return p;
    };
    const prep800 = (): Promise<Buffer> => {
      let p = bufCache.get('prep800');
      if (!p) {
        p = sharp(cropped).resize({ width: 800 }).toBuffer();
        bufCache.set('prep800', p);
      }
      return p;
    };
    const hasLikely = () => Array.from(uniqueAmounts).some(isLikelyAmount);
    const settled = () => uniqueAmounts.size > 0 && (!options.stopOnLikelyAmount || hasLikely());

    // For banks with a non-default enhancement profile (004/069 today), the
    // plain 800px attempt is provably dead (the slip needs the profile's
    // brightness/contrast/threshold), so run the profiled attempt first and
    // fall back to the plain resize. Default-profile banks keep prep800 first.
    const profileFirst = cropCfg.profile !== 'default';
    const tryGuten = profileFirst
      ? () => processOnce(cropCfg.profile, primaryProfile, cropped)
      : () => prep800();
    const tryGutenFallback = profileFirst
      ? () => prep800()
      : () => processOnce(cropCfg.profile, primaryProfile, cropped);

    // Fast path: the slip's amount band (bottom-right) is scanned first at a
    // reduced scale. When it settles, we skip the full-image ONNX passes,
    // which dominate latency (~700-1400ms each on CPU).
    if (!options.collectAll) {
      try {
        const { amounts, confidence } = await gutenExtract(
          Promise.resolve(
            processWithWidth(
              await cropAmountBand(imageBuffer, meta),
              primaryProfile,
              FAST_AMOUNT_BAND.width
            )
          )
        );
        record(amounts, 'fast', confidence);
      } catch {
        // engine failed — fall through to the full-image strategies
      }
      if (settled()) {
        return { success: true, amounts: Array.from(uniqueAmounts), source: bestSource, confidence: bestConfidence || undefined };
      }
    }

    try {
      const { amounts, confidence } = await gutenExtract(tryGuten());
      record(amounts, 'guten', confidence);
    } catch {
      // engine failed — try the next strategy
    }

    if (!settled()) {
      try {
        const { amounts, confidence } = await gutenExtract(tryGutenFallback());
        record(amounts, 'guten', confidence);
      } catch {
        // engine failed — try the next strategy
      }
    }

    if (!settled()) {
      try {
        record(extractAmounts(await runTesseractOCR(await capForTesseract(cropped, meta))), 'tesseract');
      } catch {
        // engine failed — try the next strategy
      }
    }

    if (!settled()) {
      try {
        record(
          extractAmounts(await runTesseractOCR(await processOnce(cropCfg.profile, primaryProfile, cropped))),
          'tesseract'
        );
      } catch {
        // engine failed — try the next strategy
      }
    }

    if (options.collectAll || !settled()) {
      const altProfiles = Object.entries(PROFILES).filter(([key]) => key !== cropCfg.profile);

      if (options.collectAll) {
        const results = await Promise.all(
          altProfiles.map(async ([key, profile]) => {
            try {
              const { amounts, confidence } = await gutenExtract(processOnce(key, profile, cropped));
              return { amounts, confidence };
            } catch {
              return { amounts: [] as number[], confidence: undefined };
            }
          })
        );
        results.forEach(({ amounts, confidence }) => record(amounts, 'guten', confidence));
      } else {
        let i = 0;
        let pending: Promise<Buffer> | null = processOnce(altProfiles[0][0], altProfiles[0][1], cropped);
        while (i < altProfiles.length && !settled()) {
          const buf = (await pending) as Buffer;
          i += 1;
          pending = i < altProfiles.length ? processOnce(altProfiles[i][0], altProfiles[i][1], cropped) : null;
          try {
            const { amounts, confidence } = await gutenExtract(Promise.resolve(buf));
            record(amounts, 'guten', confidence);
          } catch {
            // keep trying the remaining profiles
          }
        }
      }
    }

    if (!settled() && needsCrop) {
      try {
        const { amounts, confidence } = await gutenExtract(
          processOnce('full:default', PROFILES.default, imageBuffer)
        );
        record(amounts, 'guten', confidence);
      } catch {
        // engine failed — try the next strategy
      }
    }

    if (!settled()) {
      try {
        record(
          extractAmounts(await runTesseractOCR(await processOnce('full:default', PROFILES.default, imageBuffer))),
          'tesseract'
        );
      } catch {
        // engine failed — nothing left to try
      }
    }

    const amounts = Array.from(uniqueAmounts);
    return { success: amounts.length > 0, amounts, source: bestSource, confidence: bestConfidence || undefined };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ',
      amounts: [],
    };
  }
}

export default getSlipAmount;

// Re-export the extraction helpers through the OCR domain facade.
export { CROP_PROFILES } from './profiles';
export { extractAmounts, isLikelyAmount } from './extract';

/**
 * Shut down the OCR engines (tesseract worker pool + Guten OCR instance).
 * Call on app shutdown or in test teardown so the process can exit.
 */
export async function terminateAmountExtractor(): Promise<void> {
  await terminateTesseractPool();
  resetOcrInstance();
}