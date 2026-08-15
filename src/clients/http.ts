import { HttpError, TimeoutError, type TopupApiError } from '../errors';
import type { TopupApiResponse } from '../types';

export type { TopupApiError, TopupApiResponse } from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface PostOptions {
  /** Request deadline in ms. @default 30000 */
  timeoutMs?: number;
}

/** Shared POST helper used by the truemoney and slip clients. */
export async function post(url: string, body?: unknown, options?: PostOptions): Promise<TopupApiResponse | string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
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

  const text = await res.text();
  let payload: TopupApiResponse | string = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Not JSON — keep the raw response body.
  }

  if (!res.ok) {
    if (typeof payload === 'object' && payload !== null) {
      throw new HttpError(String(payload.slug || payload.message || `HTTP ${res.status}`), {
        status: res.status,
        slug: typeof payload.slug === 'string' ? payload.slug : undefined,
        body: payload,
      });
    }
    throw new HttpError(`HTTP ${res.status}: ${payload}`, { status: res.status, body: payload });
  }
  return payload;
}