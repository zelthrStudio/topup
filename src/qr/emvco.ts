import { MERCHANT_TAG_RE, parseTlv, type ParseTlvOptions } from './tlv';
import { verifyCrc } from './crc';
import { CrcValidationError } from '../errors';

/** One merchant/payer account entry inside a PromptPay QR payload. */
export interface EmvcoAccount {
  /** Global unique identifier (sub-tag 00), e.g. "A000000677010111". */
  guid: string;
  /** Bank code (sub-tag 01 when 2-3 digits), e.g. "004" for Kasikorn. */
  bankCode?: string;
  /** Account / merchant identifier (sub-tag 02, or sub-tag 01 when longer). */
  accountId?: string;
}

/** Parsed EMVCo / PromptPay QR payload. */
export interface EmvcoQr {
  amount?: number;
  currency?: string;
  country?: string;
  pointOfInitiation?: string;
  accounts: EmvcoAccount[];
  additional?: Record<string, string>;
  /** true when the tag-63 CRC-16/CCITT-FALSE checksum matches. */
  crcValid?: boolean;
  raw: Record<string, string>;
}

export function parseEmvcoTlv(payload: string, options: ParseTlvOptions = {}): EmvcoQr {
  const { tags, children } = parseTlv(payload, options);
  const accounts: EmvcoAccount[] = [];
  for (const tag of Object.keys(children)) {
    if (!MERCHANT_TAG_RE.test(tag)) continue;
    const sub = children[tag].tags;
    const account: EmvcoAccount = { guid: sub['00'] ?? '' };
    const sub01 = sub['01'];
    if (sub01 !== undefined) {
      // Short numeric sub-tag 01 = bank/AID code; anything longer is an account id.
      if (/^[0-9]{2,3}$/.test(sub01)) account.bankCode = sub01;
      else account.accountId = sub01;
    }
    if (sub['02']) account.accountId = sub['02'];
    accounts.push(account);
  }
  const amountStr = tags['54'];
  let amount: number | undefined;
  if (amountStr !== undefined) {
    // EMVCo tag 54 is a plain numeric string (up to 13 digits, 2 decimals).
    // Only trust well-formed positive values — exponent notation ("1e+21"),
    // garbage or zero (crafted QR) must never reach amount checks or API
    // URLs downstream.
    if (/^\d{1,13}(\.\d{1,2})?$/.test(amountStr)) {
      const parsed = parseFloat(amountStr);
      if (Number.isFinite(parsed) && parsed > 0) {
        amount = parsed;
      }
    }
  }
  const crc = tags['63'];
  const crcValid = crc !== undefined && verifyCrc(payload, '63');
  if (options.strict && crc !== undefined && !crcValid) {
    throw new CrcValidationError('emvco: CRC (tag 63) does not match payload');
  }
  return {
    amount,
    currency: tags['53'],
    country: tags['58'],
    pointOfInitiation: tags['01'],
    accounts,
    additional: children['62']?.tags,
    crcValid,
    raw: tags,
  };
}