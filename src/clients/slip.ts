import { post } from './http';
import { ValidationError } from '../errors';
import type { TopupApiResponse } from '../types';

/** zelthrStudio Open API gateway base URL (override with SLIP_API_URL). */
export const SLIP_BASE: string = process.env.SLIP_API_URL || 'https://api.zelthr.rest';

const DATA_URI_RE = /^data:/i;

// Guard rail against memory exhaustion from oversized uploads. MAX_BASE64_LENGTH
// is a cheap pre-check on the raw string before we allocate a decoded buffer.
const MAX_BASE64_LENGTH = 40 * 1024 * 1024; // cheap string-level ceiling

/** Coerce a value into the `data:image/...;base64,` form the gateway accepts. */
function normalizeImage(data: string): string {
  return DATA_URI_RE.test(data) ? data : `data:image/jpeg;base64,${data}`;
}

/**
 * Verify a Thai bank transfer slip through the zelthrStudio Open API gateway
 * (`POST /slip`). The gateway runs the full OCR pipeline itself — QR decode,
 * amount extraction and upstream verification — so this client performs no
 * local scanning at all.
 *
 * @param data Slip image as a base64 string or a full data URI
 *             (e.g. `data:image/jpeg;base64,...`).
 *
 * On success the upstream verified-slip result is returned as-is; on failure
 * the gateway's 4xx/5xx JSON error is thrown as an HttpError carrying the
 * gateway error message, HTTP status and body.
 */
export async function bank(data: string): Promise<TopupApiResponse | string> {
  if (typeof data !== 'string' || data.trim().length === 0) {
    throw new ValidationError('bank: slip image (base64 or data URI) is required');
  }
  const image = normalizeImage(data.trim());
  if (image.length > MAX_BASE64_LENGTH) {
    throw new ValidationError(`bank: image data exceeds ${MAX_BASE64_LENGTH} bytes of base64`);
  }
  return post(`${SLIP_BASE}/slip`, { img: image });
}