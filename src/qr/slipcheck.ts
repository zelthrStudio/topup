import { parseTlv, type ParseTlvOptions } from './tlv';
import { verifyCrc } from './crc';
import { CrcValidationError, QrParseError } from '../errors';

/** Parsed Thai bank slip-check QR payload. */
export interface SlipCheckQr {
  /** Format version (tag 00 inner tag 00), e.g. "000001". */
  version?: string;
  /** Bank code (tag 00 inner tag 01), e.g. "004" for Kasikorn. */
  bankCode?: string;
  /** Slip reference (tag 00 inner tag 02), e.g. "016218195650BPP03857". */
  reference?: string;
  /** Country (tag 51), usually "TH". */
  country?: string;
  /** CRC checksum (tag 91). */
  crc?: string;
  /** true when the tag-91 CRC-16/CCITT-FALSE checksum matches. */
  crcValid?: boolean;
  raw: Record<string, string>;
}

/** Matches the standard Thai slip-check QR header (tag 00, version "000001"). */
export const SLIP_CHECK_RE = /^00\d{2}00060000010103/;

/**
 * Parse a Thai bank slip-check QR payload (Bank of Thailand standard).
 * Tag 00 wraps a nested TLV with version/bank code/slip reference; tag 51 is
 * the country, tag 91 the CRC. Lengths are decimal.
 */
export function parseSlipCheck(payload: string, options: ParseTlvOptions = {}): SlipCheckQr {
  const { strict = false } = options;
  const raw: Record<string, string> = {};
  let pos = 0;
  while (pos + 4 <= payload.length) {
    const tag = payload.slice(pos, pos + 2);
    const len = parseInt(payload.slice(pos + 2, pos + 4), 10);
    if (!/^[0-9]{2}$/.test(tag) || Number.isNaN(len)) {
      if (strict) throw new QrParseError(`slip-check: invalid tag/length at offset ${pos}`);
      break;
    }
    pos += 4;
    if (pos + len > payload.length) {
      if (strict) throw new QrParseError(`slip-check: value of tag ${tag} overruns payload`);
      break;
    }
    raw[tag] = payload.slice(pos, pos + len);
    pos += len;
  }
  const inner = parseTlv(raw['00'] ?? '', options).tags;
  const crc = raw['91'];
  const crcValid = crc !== undefined && verifyCrc(payload, '91');
  if (strict && crc !== undefined && !crcValid) {
    throw new CrcValidationError('slip-check: CRC (tag 91) does not match payload');
  }
  return {
    version: inner['00'],
    bankCode: inner['01'],
    reference: inner['02'],
    country: raw['51'],
    crc,
    crcValid,
    raw,
  };
}