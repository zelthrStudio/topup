/**
 * Sniff the container format from magic bytes BEFORE any libvips/sharp decode.
 *
 * Slip images are phone photos — JPEG, PNG or WebP. Restricting the accepted
 * formats at the input boundary means libvips' GIF/TIFF/VIPS decoders (which
 * had unfixed CVEs across sharp 0.33.x) never see untrusted bytes, regardless
 * of which sharp copy ends up in a consumer's dependency tree.
 */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF_MAGIC = Buffer.from('RIFF', 'latin1');

export type SupportedImageFormat = 'jpeg' | 'png' | 'webp';

/** Returns the detected format, or null for anything that is not JPEG/PNG/WebP. */
export function sniffImageFormat(buf: Buffer): SupportedImageFormat | null {
  if (buf.length >= 3 && JPEG_MAGIC.equals(buf.subarray(0, 3))) return 'jpeg';
  if (buf.length >= 8 && PNG_MAGIC.equals(buf.subarray(0, 8))) return 'png';
  if (
    buf.length >= 12 &&
    RIFF_MAGIC.equals(buf.subarray(0, 4)) &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}