import { dynamicImport } from '../util/dynamic-import';
import { HttpError, TimeoutError } from '../errors';
import type { PostOptions, TopupApiResponse } from '../types';

export type { PostOptions };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 2000;
const MAX_ERROR_BODY_CHARS = 64 * 1024;

function capText(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_CHARS
    ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : text;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split('/').filter(Boolean)[0];
    return `${parsed.origin}/${first ? `${first}/…` : ''}`;
  } catch {
    return '<invalid url>';
  }
}

function coerceBodyToString(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    if (typeof (raw as Buffer).toString === 'function' && (Buffer.isBuffer(raw) || raw instanceof Uint8Array)) {
      return (raw as Buffer).toString('utf8');
    }
  }
  return null;
}

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

export async function post(
  url: string,
  body?: unknown,
  options?: PostOptions
): Promise<TopupApiResponse | string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const request = await getRequest();
  let response: { statusCode: number; body: unknown };
  try {
    const headers: Record<string, string> = {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
      ...options?.headers,
    };

    response = await request.promise(url, {
      method: 'POST',
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      timeout: timeoutMs,
      maxBytes: maxBodyBytes,
      signal: options?.signal,
      followRedirect: false,
      gzip: true,
      proxy: null,
    });
  } catch (err) {
    const errObj = err as NodeJS.ErrnoException & { name?: string };
    const code = errObj.code;
    const name = errObj.name;
    if (
      code === 'ETIMEDOUT' ||
      code === 'ESOCKETTIMEDOUT' ||
      code === 'ECONNABORTED' ||
      code === 'ERR_REQUEST_TIMED_OUT' ||
      code === 'ABORT_ERR' ||
      name === 'AbortError' ||
      name === 'TimeoutError'
    ) {
      throw new TimeoutError(`topup: request timed out after ${timeoutMs} ms: ${redactUrl(url)}`, { cause: err });
    }
    if (code === 'EBODYLIMIT') {
      throw new HttpError(`topup: response body exceeds ${maxBodyBytes} bytes: ${redactUrl(url)}`, { cause: err });
    }
    throw new HttpError(`topup: request failed (${(err as Error).name || 'NetworkError'}): ${redactUrl(url)}`, { cause: err });
  }

  const status = response.statusCode;
  const rawBody = response.body;

  if (status < 200 || status >= 300) {
    const stringBody = coerceBodyToString(rawBody);
    if (typeof stringBody === 'string' && stringBody.length > MAX_ERROR_BODY_CHARS) {
      throw new HttpError(`HTTP ${status}`, {
        status,
        bodyPreview: stringBody.slice(0, MAX_ERROR_BODY_CHARS),
      });
    }

    let payload: unknown = stringBody ?? rawBody;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
      }
    }
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      throw new HttpError(capText(String(record.slug || record.message || record.error || `HTTP ${status}`)), {
        status,
        slug: typeof record.slug === 'string' ? capText(record.slug) : undefined,
        body: payload,
      });
    }
    throw new HttpError(`HTTP ${status}: ${capText(String(payload))}`, { status, body: payload });
  }

  const stringBody = coerceBodyToString(rawBody);
  let payload: TopupApiResponse | string = (stringBody ?? rawBody) as TopupApiResponse | string;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.length === 0) {
      payload = {} as TopupApiResponse;
    } else {
      try {
        payload = JSON.parse(trimmed) as TopupApiResponse | string;
      } catch {
        throw new HttpError(`topup: HTTP ${status} response body is not JSON`, {
          status,
          body: trimmed.slice(0, MAX_ERROR_BODY_CHARS),
        });
      }
    }
  }
  return payload;
}