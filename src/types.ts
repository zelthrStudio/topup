import type { TopupApiError } from './errors';

export interface PostOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  baseUrl?: string;
}

export interface TruemoneyOptions extends PostOptions {
  amount?: number;
}

export type SlipImageInput =
  | string
  | Uint8Array
  | ArrayBuffer
  | { buffer: ArrayBuffer }
  | Buffer;

export interface BankOptions extends PostOptions {
  amount?: number;
}

export type SlipOptions = BankOptions;

export interface TruemoneyRedeemData {
  voucher?: {
    voucher_id?: string;
    amount_baht?: string | number;
    redeemed_amount_baht?: string | number;
    member?: number;
    status?: string;
    [key: string]: unknown;
  };
  redeem?: {
    amount_baht?: string | number;
    amount?: number;
    [key: string]: unknown;
  };
  owner_profile?: {
    full_name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TruemoneyResponse {
  status?: {
    code?: string;
    message?: string;
    [key: string]: unknown;
  };
  data?: TruemoneyRedeemData;
  amount?: number;
  [key: string]: unknown;
}

export interface BankSlipData {
  transRef?: string;
  sendingBank?: string;
  receivingBank?: string;
  transDate?: string;
  transTime?: string;
  sender?: {
    displayName?: string;
    name?: string;
    account?: {
      name?: { th?: string; en?: string };
      type?: string;
      value?: string;
    };
  };
  receiver?: {
    displayName?: string;
    name?: string;
    account?: {
      name?: { th?: string; en?: string };
      type?: string;
      value?: string;
    };
  };
  amount?: number;
  paidLocalAmount?: number;
  paidLocalCurrency?: string;
  countryCode?: string;
  ref1?: string;
  ref2?: string;
  ref3?: string;
  [key: string]: unknown;
}

export interface BankSlipResponse {
  success?: boolean;
  amount?: number;
  data?: BankSlipData;
  [key: string]: unknown;
}

export interface TopupApiResponse {
  [key: string]: unknown;
}

export type { TopupApiError };