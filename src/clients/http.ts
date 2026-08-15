import { dynamicImport } from '../util/dynamic-import';
import { HttpError, TimeoutError, type TopupApiError } from '../errors';
import type { TopupApiResponse } from '../types';

export type { TopupApiError, TopupApiResponse } from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Server-controlled text is capped before it reaches error messages, which
 *  consumers often log. */
const MAX_ERROR_MESSAGE_CHARS = 2000;

/** Error bodies are attached to thrown errors for diagnostics; retain at most
 *  64 KB so a hostile/verbose server can't bloat error objects (and skip
 *  JSON.parse of multi-MB payloads entirely). */
const MAX_ERROR_BODY_CHARS = 64 * 1024;

function capText(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_CHARS
    ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : text;
}

/** Request URLs carry secrets in the path (truemoney gift codes and phone
 *  numbers). Error messages are routinely logged / shipped to error trackers,
 *  so keep only the origin and the first path segment. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split('/').filter(Boolean)[0];
    return `${parsed.origin}/${first ? `${first}/…` : ''}`;
  } catch {
    return '<invalid url>';
  }
}

export interface PostOptions {
  /** Request deadline in ms. @default 30000 */
  timeoutMs?: number;
  /** Response body cap in bytes. @default 33554432 (32 MiB) */
  maxBodyBytes?: number;
}

// @zelthr/request is a Node HTTP client (http1/http2/fetch transports). It is
// loaded lazily on first request so that importing this package (e.g. in a
// browser bundle for getQrCodePromptPay) never touches Node-only code.
interface RequestModule {
  promise(
    url: string,
    options: Record<string, unknown>
  ): Promise<{ statusCode: number; body: unknown }>;
}

let requestPromise: Promise<RequestModule> | null = null;

function getRequest(): Promise<RequestModule> {
  if (!requestPromise) {
    requestPromise = dynamicImport('@zelthr/request')
      .then((mod) => (mod.default ?? mod) as RequestModule)
      .catch((error) => {
        requestPromise = null;
        throw error;
      });
  }
  return requestPromise;
}

/**
 * Shared POST helper used by the truemoney and slip clients.
 *
 * Every outbound request goes through `@zelthr/request` with explicit
 * options: POST method, JSON-serialized body (when one is given), deadline,
 * response body budget, redirects disabled and gzip support.
 */
export async function post(url: string, body?: unknown, options?: PostOptions): Promise<TopupApiResponse | string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const request = await getRequest();
  let response: { statusCode: number; body: unknown };
  try {
    response = await request.promise(url, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      timeout: timeoutMs,
      maxBytes: maxBodyBytes,
      // Never follow redirects: the library already refuses to follow 3xx
      // for POST, but keep the guard explicit so a 307/308 can never re-POST
      // the slip image / gift code to a redirected host.
      followRedirect: false,
      // Preserve fetch semantics: advertise and decode gzip responses.
      gzip: true,
    });
  } catch (err) {
    // The library rejects with ETIMEDOUT / ESOCKETTIMEDOUT on deadline
    // expiry and with EBODYLIMIT once the response body exceeds maxBytes.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNABORTED') {
      throw new TimeoutError(`topup: request timed out after ${timeoutMs} ms: ${redactUrl(url)}`, { cause: err });
    }
    if (code === 'EBODYLIMIT') {
      throw new HttpError(`topup: response body exceeds ${maxBodyBytes} bytes: ${redactUrl(url)}`, { cause: err });
    }
    throw new HttpError(`topup: request failed (${(err as Error).name}): ${redactUrl(url)}`, { cause: err });
  }

  const status = response.statusCode;
  const rawBody = response.body;

  if (status < 200 || status >= 300) {
    if (typeof rawBody === 'string' && rawBody.length > MAX_ERROR_BODY_CHARS) {
      // Non-2xx with an oversized body: don't retain the full payload, and
      // don't pay for a JSON.parse of multi-MB error bodies. Keep a preview
      // for diagnostics.
      throw new HttpError(`HTTP ${status}`, {
        status,
        bodyPreview: rawBody.slice(0, MAX_ERROR_BODY_CHARS),
      });
    }
    let payload: unknown = rawBody;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        // Not JSON — keep the raw response body.
      }
    }
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      throw new HttpError(capText(String(record.slug || record.message || `HTTP ${status}`)), {
        status,
        slug: typeof record.slug === 'string' ? capText(record.slug) : undefined,
        body: payload,
      });
    }
    throw new HttpError(`HTTP ${status}: ${capText(String(payload))}`, { status, body: payload });
  }

  let payload: TopupApiResponse | string = rawBody as TopupApiResponse | string;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as TopupApiResponse | string;
    } catch {
      // Not JSON — keep the raw response body.
    }
  }
  return payload;
}