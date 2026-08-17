// Public API — the package surface is intentionally stable across refactors.

// zelthrStudio Open API gateway clients
export { truemoney, TMN_BASE } from './clients/truemoney';
export type { TruemoneyOptions } from './clients/truemoney';
export { bank, SLIP_BASE } from './clients/slip';
export { post } from './clients/http';

// Shared types
export type { TopupApiResponse, TopupApiError } from './types';

// Error hierarchy
export {
  TopupError,
  ValidationError,
  QrParseError,
  CrcValidationError,
  TimeoutError,
  HttpError,
  AmountMismatchError,
  AmountVerificationError,
} from './errors';

// QR parsing & generation (pure string utilities — no image scanning)
export { parseEmvco, parseSlipCheck, verifyCrc, crc16ccitt } from './qr';
export type { EmvcoQr, EmvcoAccount, SlipCheckQr, DecodedQr } from './qr';

// PromptPay QR generation
export { getQrCodePromptPay, MAX_PROMPTPAY_AMOUNT } from './qr';
export type { QrCodePromptPayOptions, QrCodePromptPayResult, PromptPayType } from './qr';