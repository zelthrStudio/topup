// Public API — a thin client for the zelthrStudio Open API gateway.
// Everything goes through the gateway (https://api.zelthr.rest): no local
// scanning, no QR parsing, no native dependencies.

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
  TimeoutError,
  HttpError,
  AmountMismatchError,
  AmountVerificationError,
} from './errors';