import { parseEmvcoTlv, type EmvcoQr } from './emvco';
import { parseSlipCheck, isSlipCheckPayload, type SlipCheckQr } from './slipcheck';
import type { ParseTlvOptions } from './tlv';

/** A bank/payer account entry normalized across QR formats. */
export interface DecodedAccount {
  guid?: string;
  bankCode?: string;
  accountId?: string;
}

/** A decoded QR with format-specific fields plus a normalized view. */
export interface DecodedQr {
  /** Raw payload string. */
  payload: string;
  /** Transaction amount (EMVCo tag 54 only). */
  amount?: number;
  /** Transaction currency code (764 = THB). */
  currency?: string;
  /** Country code. */
  country?: string;
  /** Point of initiation (EMVCo): "11" = dynamic, "12" = static. */
  pointOfInitiation?: string;
  /** Slip reference (Thai slip-check QR). */
  transRef?: string;
  /** Bank/payer accounts found in the payload. */
  accounts: DecodedAccount[];
  /** Additional data (EMVCo tag 62 sub-TLVs). */
  additional?: Record<string, string>;
  /** Present when the payload is EMVCo/PromptPay (starts with "000201"). */
  emvco?: EmvcoQr;
  /** Present when the payload is a Thai bank slip-check QR. */
  slipCheck?: SlipCheckQr;
  /** true when the payload carries a matching CRC (tag 63/91). */
  crcValid?: boolean;
}

/**
 * Parse any supported Thai QR payload into a DecodedQr:
 *  - EMVCo / PromptPay (starts with "000201")
 *  - Thai bank slip-check QR
 *  - anything else: returned with just the raw payload.
 *
 * When options.strict is set, malformed structure and CRC mismatches throw
 * (QrParseError / CrcValidationError) instead of being tolerated.
 */
export function parseEmvco(payload: string, options: ParseTlvOptions = {}): DecodedQr {
  if (/^000201/.test(payload)) {
    const e = parseEmvcoTlv(payload, options);
    return {
      payload,
      amount: e.amount,
      currency: e.currency,
      country: e.country,
      pointOfInitiation: e.pointOfInitiation,
      accounts: e.accounts,
      additional: e.additional,
      crcValid: e.crcValid,
      emvco: e,
    };
  }
  if (isSlipCheckPayload(payload)) {
    const s = parseSlipCheck(payload, options);
    return {
      payload,
      country: s.country,
      // Thai bank slips are THB; slip-check QRs carry no currency tag.
      currency: '764',
      transRef: s.reference,
      accounts: [{ bankCode: s.bankCode, accountId: s.reference }],
      crcValid: s.crcValid,
      slipCheck: s,
    };
  }
  return { payload, accounts: [] };
}