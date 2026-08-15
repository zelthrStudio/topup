import { HttpError, TimeoutError, type TopupApiError } from '../errors';
import type { TopupApiResponse } from '../types';

export type { TopupApiError, TopupApiResponse } from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Server-controlled text is capped before it reaches error messages, which
 *  consumers often log. */
const MAX_ERROR_MESSAGE_CHARS = 2000;

function capText(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_CHARS
    ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : text;
}

export interface PostOptions {
  /** Request deadline in ms. @default 30000 */
  timeoutMs?: number;
  /** Response body cap in bytes. @default 33554432 (32 MiB) */
  maxBodyBytes?: number;
}

/** Read the response body up to maxBodyBytes, throwing HttpError past the cap. */
async function readBody(res: Response, maxBytes: number, url: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Release the connection promptly instead of letting the oversized
        // stream drain in the background.
        await reader.cancel().catch(() => {});
        throw new HttpError(`topup: response body exceeds ${maxBytes} bytes: ${url}`, { status: res.status });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Shared POST helper used by the truemoney and slip clients. */
export async function post(url: string, body?: unknown, options?: PostOptions): Promise<TopupApiResponse | string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      // Never follow redirects: a 307/308 would re-POST the request body
      // (the slip image / gift code) to whatever host the server points at.
      redirect: 'error',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout aborts with AbortError whose name is "TimeoutError".
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new TimeoutError(`topup: request timed out after ${timeoutMs} ms: ${url}`, { cause: err });
    }
    throw new HttpError(`topup: request failed (${(err as Error).name}): ${url}`, { cause: err });
  }

  const text = await readBody(res, maxBodyBytes, url);
  let payload: TopupApiResponse | string = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Not JSON — keep the raw response body.
  }

  if (!res.ok) {
    if (typeof payload === 'object' && payload !== null) {
      throw new HttpError(capText(String(payload.slug || payload.message || `HTTP ${res.status}`)), {
        status: res.status,
        slug: typeof payload.slug === 'string' ? capText(payload.slug) : undefined,
        body: payload,
      });
    }
    throw new HttpError(`HTTP ${res.status}: ${capText(String(payload))}`, { status: res.status, body: payload });
  }
  return payload;
}