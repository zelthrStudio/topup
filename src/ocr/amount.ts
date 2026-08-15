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
  /** How many strategies reported each amount (agreement signal). */
  counts?: Record<number, number>;
  error?: string;
}

interface AmountOptions {
  collectAll?: boolean;
  stopOnLikelyAmount?: boolean;
  /** Overall pipeline deadline in ms. @default 60000 */
  timeoutMs?: number;
}

/** Ceiling for the whole OCR pipeline — each engine call may take up to 30 s
 *  individually, but callers must never wait on the full chain. */
const DEFAULT_PIPELINE_TIMEOUT_MS = 60_000;

interface ImageMeta {
  width: number;
  height: number;
}

// Decoded-to-raw representation. The compressed source is decoded ONCE per
// getSlipAmount() call and every pipeline step (crop / band / resize /
// enhancement) is derived from these pixels — previously each sharp() step
// re-decoded the full camera photo, i.e. 6-10 full JPEG decodes per call.
interface RawImage extends ImageMeta {
  data: Buffer;
  channels: 1 | 2 | 3 | 4;
}

async function decodeRaw(imageBuffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function fromRaw(raw: RawImage): sharp.Sharp {
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
}

async function extractRaw(
  raw: RawImage,
  left: number,
  top: number,
  width: number,
  height: number
): Promise<RawImage> {
  const { data, info } = await fromRaw(raw)
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// OCR engines initialize lazily on first use: importing this package (e.g. by
// consumers who only call truemoney()/bank() remote modes) never loads the
// ONNX models or spawns the ~200MB tesseract worker pool. Call
// warmupAmountExtractor() explicitly to pre-warm before the first local OCR.
export async function warmupAmountExtractor(): Promise<void> {
  await getOcrInstance();
  await warmupTesseract();
}

// Thai bank slips print the big bold amount digits in the bottom-right band.
// OCR-ing only that band at a reduced scale is much faster because the ONNX
// detection cost scales with input pixels (see engines/guten). Fallbacks in
// getSlipAmount below preserve full-image accuracy when the band misses.
const FAST_AMOUNT_BAND = { leftPct: 50, topPct: 25, bottomPct: 5, width: 600 };

async function cropAmountBand(raw: RawImage): Promise<RawImage> {
  const { width: w, height: h } = raw;
  const left = Math.floor(w * (FAST_AMOUNT_BAND.leftPct / 100));
  const top = Math.floor(h * (FAST_AMOUNT_BAND.topPct / 100));
  const height = h - top - Math.floor(h * (FAST_AMOUNT_BAND.bottomPct / 100));
  return extractRaw(raw, left, top, w - left, height);
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

async function cropImage(raw: RawImage, topPct: number, bottomPct: number): Promise<RawImage> {
  if (topPct === 0 && bottomPct === 0) return raw;
  const { width: w, height: h } = raw;
  const top = Math.floor(h * (topPct / 100));
  const cropH = Math.max(1, Math.floor(h * (1 - topPct / 100 - bottomPct / 100)));
  return extractRaw(raw, 0, top, w, cropH);
}

function processWithProfile(raw: RawImage, profile: BankProfile): Promise<Buffer> {
  return fromRaw(raw)
    .modulate({ brightness: profile.brightness })
    .linear(profile.contrast, 0)
    .resize({ width: profile.width })
    .threshold(profile.threshold)
    .png()
    .toBuffer();
}

function processWithWidth(raw: RawImage, profile: BankProfile, width: number): Promise<Buffer> {
  return fromRaw(raw)
    .modulate({ brightness: profile.brightness })
    .linear(profile.contrast, 0)
    .resize({ width })
    .threshold(profile.threshold)
    .png()
    .toBuffer();
}

// Tesseract is resolution-tolerant and slow; feeding it full-resolution camera
// photos wastes time. Only downscale when the source is large (maxDim > 1600),
// capping the longest side at ~1100px.
const TESSERACT_MAX_INPUT_DIM = 1600;
const TESSERACT_TARGET_DIM = 1100;

async function capForTesseract(raw: RawImage): Promise<Buffer> {
  const maxDim = Math.max(raw.width, raw.height);
  if (maxDim <= TESSERACT_MAX_INPUT_DIM) return fromRaw(raw).png().toBuffer();
  const scale = TESSERACT_TARGET_DIM / maxDim;
  return fromRaw(raw)
    .resize({ width: Math.round(raw.width * scale), height: Math.round(raw.height * scale) })
    .png()
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`amount: OCR pipeline exceeded ${timeoutMs} ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([pipeline(imageBuffer, bankCode, options), deadline]);
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ',
      amounts: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pipeline(
  imageBuffer: Buffer,
  bankCode: string | undefined,
  options: AmountOptions
): Promise<AmountResult> {
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
    const agreement = new Map<number, number>();
    let bestSource: AmountSource | undefined;
    let bestConfidence = 0;
    const record = (amounts: number[], source: AmountSource, confidence?: number, weight = 1): void => {
      if (amounts.length === 0) return;
      amounts.forEach((amount) => {
        uniqueAmounts.add(amount);
        agreement.set(amount, (agreement.get(amount) ?? 0) + weight);
      });
      if (confidence !== undefined && confidence > bestConfidence) {
        bestConfidence = confidence;
        bestSource = source;
      }
      if (bestSource === undefined) bestSource = source;
    };
    const cropCfg = CROP_PROFILES[bankCode ?? ''] ?? DEFAULT_CROP;
    const primaryProfile = PROFILES[cropCfg.profile] ?? PROFILES.default;
    const needsCrop = cropCfg.cropTop > 0 || cropCfg.cropBottom > 0;

    // The compressed source is decoded once; crops, bands, resizes and
    // enhancement profiles all derive from these raw pixels.
    const source = await decodeRaw(imageBuffer);
    const cropped = needsCrop
      ? await cropImage(source, cropCfg.cropTop, cropCfg.cropBottom)
      : source;

    const bufCache = new Map<string, Promise<Buffer>>();
    const processOnce = (key: string, profile: BankProfile, base: RawImage): Promise<Buffer> => {
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
        p = fromRaw(cropped).resize({ width: 800 }).png().toBuffer();
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
    // which dominate latency (~700-1400ms each on CPU). Band detections carry
    // double weight: the band is the region purpose-built for the amount, so
    // its readings must win ties against full-image noise (dates, refs).
    if (!options.collectAll) {
      try {
        const { amounts, confidence } = await gutenExtract(
          processWithWidth(await cropAmountBand(source), primaryProfile, FAST_AMOUNT_BAND.width)
        );
        record(amounts, 'fast', confidence, 2);
      } catch {
        // engine failed — fall through to the full-image strategies
      }
      if (settled()) {
        return { success: true, amounts: Array.from(uniqueAmounts), counts: Object.fromEntries(agreement), source: bestSource, confidence: bestConfidence || undefined };
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
        record(extractAmounts(await runTesseractOCR(await capForTesseract(cropped))), 'tesseract');
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
      } else if (altProfiles.length > 0) {
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
          processOnce('full:default', PROFILES.default, source)
        );
        record(amounts, 'guten', confidence);
      } catch {
        // engine failed — try the next strategy
      }
    }

    if (!settled()) {
      try {
        record(
          extractAmounts(await runTesseractOCR(await processOnce('full:default', PROFILES.default, source))),
          'tesseract'
        );
      } catch {
        // engine failed — nothing left to try
      }
    }

    const amounts = Array.from(uniqueAmounts);
    return { success: amounts.length > 0, amounts, counts: Object.fromEntries(agreement), source: bestSource, confidence: bestConfidence || undefined };
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