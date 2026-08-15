import { dynamicImport } from '../../util/dynamic-import';
import { OcrTimeoutError } from '../../errors';

export interface OcrLine {
  text: string;
  mean: number;
}

interface GutenOcr {
  detect(image: string, options?: unknown): Promise<OcrLine[]>;
}

const GUTEN_TIMEOUT_MS = 30_000;

let ocrInstancePromise: Promise<GutenOcr> | null = null;

/**
 * @gutenye/ocr-node is ESM-only, so it is loaded lazily through a real dynamic
 * import() (not transpiled to require) to keep this CommonJS package working
 * on Node 18+.
 */
export function getOcrInstance(): Promise<GutenOcr> {
  if (!ocrInstancePromise) {
    ocrInstancePromise = dynamicImport('@gutenye/ocr-node')
      .then((mod) => mod.default.create())
      .then((ocr) => {
        if (process.env.TOPUP_DEBUG === '1') {
          console.log('Amount OCR instance (Guten OCR/ONNX) ready');
        }
        return ocr as GutenOcr;
      })
      .catch((error) => {
        ocrInstancePromise = null;
        throw error;
      });
  }
  return ocrInstancePromise;
}

/** Drop the cached instance (used by terminateAmountExtractor). */
export function resetOcrInstance(): void {
  ocrInstancePromise = null;
}

// The ONNX inference itself cannot be cancelled, but callers must not block
// forever on a pathological input: race detect() against a deadline like the
// tesseract engine does. The abandoned inference keeps running in the
// background until the library notices, but the caller gets a clean error.
function detectWithTimeout(ocr: GutenOcr, buf: Buffer): Promise<OcrLine[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OcrTimeoutError(`guten: OCR detect timed out after ${GUTEN_TIMEOUT_MS} ms`)),
      GUTEN_TIMEOUT_MS
    );
  });
  return Promise.race([ocr.detect(buf as unknown as string), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runOCR(buf: Buffer): Promise<string> {
  const ocr = await getOcrInstance();
  const lines = await detectWithTimeout(ocr, buf);
  return (lines ?? []).map((line) => line.text).join('\n');
}

/** Detect + recognize, returning per-line text and mean confidence. */
export async function runOCRLines(buf: Buffer): Promise<OcrLine[]> {
  const ocr = await getOcrInstance();
  return detectWithTimeout(ocr, buf);
}