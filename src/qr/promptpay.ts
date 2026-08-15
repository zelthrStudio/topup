import { dynamicImport } from '../util/dynamic-import';
import { ValidationError } from '../errors';

/**
 * PromptPay QR generation backed by @zelthr/qrcode (the org's own
 * zero-dependency EMVCo generator + pure-JS PNG/SVG renderer). The module is
 * ESM-only, so it is loaded lazily through a real dynamic import() — same
 * pattern as the scanner in scan.ts — to keep this CommonJS package working
 * on Node 20+.
 */

export type PromptPayType = 'mobile' | 'nationalId' | 'ewalletId';

export interface QrCodePromptPayOptions {
  /**
   * Transfer amount in Baht. When omitted, a static (no amount) QR is
   * generated. @default undefined
   */
  amount?: number;
  /**
   * Maximum transfer amount allowed (Baht).
   * @default MAX_PROMPTPAY_AMOUNT (200000)
   */
  maxAmount?: number;
  /**
   * QR error correction level. @default 'M'
   */
  ecc?: 'L' | 'M' | 'Q' | 'H';
  /**
   * Render scale, modules per pixel. @default 4
   */
  scale?: number;
  /**
   * Quiet zone size in modules. @default 4
   */
  border?: number;
  /**
   * Color of dark modules. @default '#000000'
   */
  color?: string;
  /**
   * Color of light modules. @default '#ffffff'
   */
  background?: string;
}

export interface QrCodePromptPayResult {
  /** Detected PromptPay ID type. */
  type: PromptPayType;
  /** Normalized 13-digit target as it appears in the payload. */
  target: string;
  /** The generated EMVCo payload string (ready to encode or verify). */
  payload: string;
  /** Rendered QR as PNG bytes. */
  png: Buffer;
  /** Rendered QR as an SVG document string. */
  svg: string;
  /** Raw QR module data (for custom rendering). */
  qr: {
    /** The encoded payload. */
    text: string;
    /** QR version (1-40). */
    version: number;
    /** Matrix width/height in modules. */
    size: number;
    /** Error correction level used. */
    ecc: 'L' | 'M' | 'Q' | 'H';
    /** Mask pattern used (0-7). */
    mask: number;
    /** Segment mode actually used. */
    mode: 'numeric' | 'alphanumeric' | 'byte' | 'kanji';
    /** Raw module matrix, `1` = dark, row-major. */
    matrix: Uint8Array;
    /** Data capacity in codewords for this version + ECC. */
    dataCapacity: number;
  };
}

/** Maximum transfer amount per transaction (Baht). Current BOT PromptPay limit. */
export const MAX_PROMPTPAY_AMOUNT = 200000;

interface QrcodeModule {
  checkPromptPay(
    id: string,
    options?: { amount?: number; maxAmount?: number }
  ): {
    ok: boolean;
    error?: string;
    type?: PromptPayType;
    target?: string;
    payload?: string;
  };
  generatePromptPay(id: string, options?: Record<string, unknown>): QrCodePromptPayResult['qr'];
  toPNG(qr: QrCodePromptPayResult['qr'], options?: Record<string, unknown>): Uint8Array;
  toSVG(qr: QrCodePromptPayResult['qr'], options?: Record<string, unknown>): string;
}

let promptPayPromise: Promise<QrcodeModule> | null = null;

function getPromptPayModule(): Promise<QrcodeModule> {
  if (!promptPayPromise) {
    promptPayPromise = dynamicImport('@zelthr/qrcode') as Promise<QrcodeModule>;
  }
  return promptPayPromise;
}

/**
 * Generate a PromptPay QR Code from a PromptPay ID.
 *
 * Supports mobile numbers (e.g. `0812345678`, `+66-89-123-4567`), national
 * ID / tax ID (13 digits) and e-wallet IDs (15 digits). Returns the generated
 * EMVCo payload, the QR module data and ready-to-render PNG/SVG output.
 *
 * Throws `ValidationError` on invalid IDs, amounts or render options.
 */
export async function getQrCodePromptPay(
  id: string,
  options: QrCodePromptPayOptions = {}
): Promise<QrCodePromptPayResult> {
  if (typeof id !== 'string') {
    throw new ValidationError('getQrCodePromptPay: PromptPay ID must be a string');
  }
  const { amount, maxAmount, ecc, scale, border, color, background } = options;
  // A scale of 0 (or NaN/negative) would render a zero-width PNG silently;
  // reject it up front with a descriptive error.
  if (scale !== undefined && (!Number.isFinite(scale) || scale < 1)) {
    throw new ValidationError(`getQrCodePromptPay: scale must be a finite number >= 1 (got ${scale})`);
  }
  const module = await getPromptPayModule();
  try {
    const checked = module.checkPromptPay(id, { amount, maxAmount });
    if (!checked.ok) {
      throw new ValidationError(`getQrCodePromptPay: ${checked.error ?? 'invalid PromptPay ID'}`);
    }
    const qr = module.generatePromptPay(id, { amount, maxAmount, ecc });
    const render = { scale, border, color, background };
    return {
      type: checked.type as PromptPayType,
      target: checked.target as string,
      payload: checked.payload as string,
      qr,
      png: Buffer.from(module.toPNG(qr, render)),
      svg: module.toSVG(qr, render),
    };
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    if (e instanceof RangeError) {
      throw new ValidationError(`getQrCodePromptPay: ${e.message}`, { cause: e });
    }
    throw e;
  }
}