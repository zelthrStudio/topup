import { QrParseError } from '../errors';

export interface ParsedTlv {
  tags: Record<string, string>;
  children: Record<string, ParsedTlv>;
}

export interface ParseTlvOptions {
  /**
   * Strict mode: malformed length/truncated value/duplicate tags/empty
   * payload throw a QrParseError instead of silently ignoring the tail.
   * @default false
   */
  strict?: boolean;
}

/** EMVCo merchant/biller account tags (26-51). */
export const MERCHANT_TAG_RE = /^(2[6-9]|3[0-9]|4[0-9]|5[01])$/;

/** Nesting ceiling: TLV values are bounded by payload length, but a crafted
 *  payload could nest hundreds of levels and overflow the stack during
 *  recursive descent. Anything deeper is treated as a leaf. */
const MAX_TLV_DEPTH = 32;

/**
 * TLV (tag/length/value) parser used by all Thai QR formats. Tags and lengths
 * are two decimal digits each.
 *
 * Lenient (default): malformed tails are ignored, later duplicate tags win.
 * Strict: throws QrParseError on the first structural violation.
 */
export function parseTlv(payload: string, options: ParseTlvOptions = {}): ParsedTlv {
  return parseTlvDepth(payload, options, 0);
}

function parseTlvDepth(payload: string, options: ParseTlvOptions, depth: number): ParsedTlv {
  const { strict = false } = options;
  if (payload.length === 0) {
    if (strict) throw new QrParseError('tlv: empty payload');
    return { tags: {}, children: {} };
  }
  if (depth >= MAX_TLV_DEPTH) {
    if (strict) throw new QrParseError('tlv: nesting exceeds safety limit');
    return { tags: {}, children: {} };
  }
  const tags: Record<string, string> = {};
  const children: Record<string, ParsedTlv> = {};
  let pos = 0;
  while (pos + 4 <= payload.length) {
    const tag = payload.slice(pos, pos + 2);
    const len = parseInt(payload.slice(pos + 2, pos + 4), 10);
    if (!/^[0-9]{2}$/.test(tag) || Number.isNaN(len)) {
      if (strict) throw new QrParseError(`tlv: invalid tag/length at offset ${pos}`);
      break;
    }
    pos += 4;
    if (pos + len > payload.length) {
      if (strict) throw new QrParseError(`tlv: value of tag ${tag} overruns payload (offset ${pos}, length ${len})`);
      break;
    }
    const value = payload.slice(pos, pos + len);
    pos += len;
    if (strict && Object.prototype.hasOwnProperty.call(tags, tag)) {
      throw new QrParseError(`tlv: duplicate tag ${tag}`);
    }
    tags[tag] = value;
    if (MERCHANT_TAG_RE.test(tag) || tag === '62') {
      children[tag] = parseTlvDepth(value, options, depth + 1);
    }
  }
  if (strict && pos < payload.length) {
    throw new QrParseError(`tlv: trailing bytes at offset ${pos}`);
  }
  return { tags, children };
}