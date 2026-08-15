/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection) — the checksum
 * used by both the EMVCo QR (tag 63) and the Thai slip-check Mini-QR (tag 91)
 * per the Bank of Thailand Thai QR Payment supplement and the SCB Mini-QR spec.
 */

/**
 * Compute the CRC-16/CCITT-FALSE checksum of a payload string.
 * Returns the 4-character uppercase hex value.
 */
export function crc16ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Verify a payload's trailing CRC tag.
 *
 * @param payload Full payload string ending in a CRC tag, e.g. "...9104554A".
 * @param tag     The CRC tag id ("63" for EMVCo, "91" for slip-check).
 * @returns true when the stored value matches. The checksum covers the whole
 *          payload including the CRC tag's own ID and length, excluding its
 *          value (per ISO/IEC 13239 usage in the Thai QR specs).
 */
export function verifyCrc(payload: string, tag: string): boolean {
  const stored = payload.slice(payload.length - 4);
  if (!/^[0-9A-Fa-f]{4}$/.test(stored)) return false;
  // The checksum covers the tag's own ID and length, so the body must end
  // with e.g. "9104" (tag 91 + 2-digit length) before the 4-hex value.
  const body = payload.slice(0, payload.length - 4);
  if (!body.endsWith(`${tag}04`)) return false;
  return crc16ccitt(body) === stored.toUpperCase();
}