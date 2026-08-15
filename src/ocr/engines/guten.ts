import { dynamicImport } from '../../util/dynamic-import';

export interface OcrLine {
  text: string;
  mean: number;
}

interface GutenOcr {
  detect(image: string, options?: unknown): Promise<OcrLine[]>;
}

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

export async function runOCR(buf: Buffer): Promise<string> {
  const ocr = await getOcrInstance();
  const lines = await ocr.detect(buf as unknown as string);
  return (lines ?? []).map((line) => line.text).join('\n');
}

/** Detect + recognize, returning per-line text and mean confidence. */
export async function runOCRLines(buf: Buffer): Promise<OcrLine[]> {
  const ocr = await getOcrInstance();
  const lines = await ocr.detect(buf as unknown as string);
  return lines ?? [];
}