import { post } from './http';
import { AmountMismatchError, AmountVerificationError, ValidationError } from '../errors';
import type { BankOptions, SlipImageInput, SlipOptions, TopupApiResponse } from '../types';

export type { BankOptions, SlipOptions, SlipImageInput };

export const SLIP_BASE: string = process.env.SLIP_API_URL || 'https://api.zelthr.rest';

const DATA_URI_RE = /^data:/i;
const MAX_BASE64_LENGTH = 40 * 1024 * 1024;

function normalizeImage(data: SlipImageInput): string {
  if (typeof data === 'string') {
    const str = data.trim();
    if (str.length === 0) {
      throw new ValidationError('bank: slip image (base64 or data URI) is required');
    }
    if (DATA_URI_RE.test(str)) {
      const commaIdx = str.indexOf(',');
      if (commaIdx !== -1) {
        const head = str.slice(0, commaIdx + 1);
        const body = str.slice(commaIdx + 1).replace(/\s+/g, '');
        return head + body;
      }
      return str;
    }
    return `data:image/jpeg;base64,${str.replace(/\s+/g, '')}`;
  }

  if (data && typeof data === 'object') {
    if (Buffer.isBuffer(data)) {
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    }
    if (data instanceof Uint8Array) {
      return `data:image/jpeg;base64,${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')}`;
    }
    if (data instanceof ArrayBuffer) {
      return `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}`;
    }
    if ('buffer' in data && data.buffer instanceof ArrayBuffer) {
      return `data:image/jpeg;base64,${Buffer.from(data.buffer).toString('base64')}`;
    }
  }

  throw new ValidationError('bank: slip image must be a base64 string, data URI, or binary Buffer');
}

function extractBankAmount(response: unknown): number | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  const root = response as Record<string, unknown>;
  const keys = ['amount', 'totalAmount', 'transAmount', 'paidLocalAmount', 'transferAmount', 'paid_amount'];

  for (const k of keys) {
    if (k in root) {
      const val = root[k];
      const n = typeof val === 'number' ? val : typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : NaN;
      if (Number.isFinite(n)) return n;
    }
  }

  if (root.data && typeof root.data === 'object') {
    const data = root.data as Record<string, unknown>;
    for (const k of keys) {
      if (k in data) {
        const val = data[k];
        const n = typeof val === 'number' ? val : typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : NaN;
        if (Number.isFinite(n)) return n;
      }
    }
  }

  return undefined;
}

export async function bank(
  data: SlipImageInput,
  options?: BankOptions
): Promise<TopupApiResponse | string> {
  const image = normalizeImage(data);
  if (image.length > MAX_BASE64_LENGTH) {
    throw new ValidationError(`bank: image data exceeds ${MAX_BASE64_LENGTH} bytes of base64`);
  }

  if (options?.amount != null && (!Number.isFinite(options.amount) || options.amount < 0)) {
    throw new ValidationError('bank: amount must be a non-negative number');
  }

  const base = options?.baseUrl || SLIP_BASE;
  const res = await post(`${base}/slip`, { img: image }, options);

  if (options?.amount != null && res !== null && typeof res === 'object') {
    const extracted = extractBankAmount(res);
    if (extracted === undefined) {
      throw new AmountVerificationError(
        'bank: amount verification requested but no amount could be extracted from the slip response',
        { body: res }
      );
    }
    if (Math.abs(extracted - options.amount) > 0.005) {
      throw new AmountMismatchError(
        `bank: amount mismatch — expected ${options.amount} THB but slip verified ${extracted} THB`,
        { body: res }
      );
    }
  }

  return res;
}