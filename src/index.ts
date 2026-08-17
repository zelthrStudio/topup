export { truemoney, TMN_BASE } from './clients/truemoney';
export { bank, SLIP_BASE } from './clients/slip';
export { post } from './clients/http';

export type {
  PostOptions,
  TruemoneyOptions,
  BankOptions,
  SlipOptions,
  SlipImageInput,
  TruemoneyRedeemData,
  TruemoneyResponse,
  BankSlipData,
  BankSlipResponse,
  TopupApiResponse,
  TopupApiError,
} from './types';

export {
  TopupError,
  ValidationError,
  TimeoutError,
  HttpError,
  AmountMismatchError,
  AmountVerificationError,
} from './errors';