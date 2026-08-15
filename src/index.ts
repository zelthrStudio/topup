// Public API — the package surface is intentionally stable across refactors.

// Slip Verify / TrueMoney clients
export { truemoney, TMN_BASE } from './clients/truemoney';
export type { TruemoneyOptions } from './clients/truemoney';
export { bank, SLIP_BASE } from './clients/slip';
export type { BankMode } from './clients/slip';
export { post } from './clients/http';

// Shared types
export type { TopupApiResponse, TopupApiError } from './types';

// Error hierarchy
export {
  TopupError,
  ValidationError,
  QrParseError,
  CrcValidationError,
  OcrError,
  OcrTimeoutError,
  TimeoutError,
  HttpError,
  AmountMismatchError,
} from './errors';

// Local slip amount extraction (QR + Guten OCR/ONNX + tesseract)
export {
  default as getSlipAmount,
  CROP_PROFILES,
  extractAmounts,
  isLikelyAmount,
  terminateAmountExtractor,
  warmupAmountExtractor,
} from './ocr/amount';
export type { AmountResult, AmountSource } from './ocr/amount';

// QR parsing & decoding
export { decodeQr, parseEmvco, parseSlipCheck, verifyCrc, crc16ccitt } from './qr';
export type { EmvcoQr, EmvcoAccount, SlipCheckQr, DecodedQr } from './qr';