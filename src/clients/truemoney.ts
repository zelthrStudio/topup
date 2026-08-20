import { post } from './http';
import { AmountMismatchError, AmountVerificationError, ValidationError } from '../errors';
import type { TopupApiResponse, TruemoneyOptions } from '../types';

export type { TruemoneyOptions };

export const TMN_BASE: string = process.env.TMN_API_URL || 'https://api.zelthr.rest';

const THAI_PHONE_RE = /^0\d{9}$/;
const AMOUNT_KEY_RE = /^(amount|amount_baht|redeem_amount|redeemed_amount|redeemed_amount_baht|redeemed_baht|member_amount_baht|net_amount|total_amount|received_amount|paid_amount|amounts)$/i;

function toBaht(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseFloat(value.replace(/[^\d.]/g, '')) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function extractRedeemAmount(response: unknown): number | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  const root = response as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (AMOUNT_KEY_RE.test(key)) {
      const n = toBaht(root[key]);
      if (n !== undefined) return n;
    }
  }
  const seen = new Set<unknown>();
  const walk = (node: unknown): number | undefined => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (AMOUNT_KEY_RE.test(key)) {
        const n = toBaht(value);
        if (n !== undefined) return n;
      }
      const nested = walk(value);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return walk(root);
}

function normalizePhone(phone: string): { normalized?: string; error?: string } {
  if (typeof phone !== 'string' || phone.trim().length === 0) {
    return { error: 'truemoney: phone is required' };
  }
  let clean = phone.trim().replace(/[\s\-_().]/g, '');
  if (clean.startsWith('+66')) {
    clean = '0' + clean.slice(3);
  } else if (clean.startsWith('66') && clean.length === 11) {
    clean = '0' + clean.slice(2);
  }
  if (!THAI_PHONE_RE.test(clean)) {
    return { error: 'truemoney: phone must be a 10-digit Thai mobile number (e.g. 0812345678)' };
  }
  return { normalized: clean };
}

export async function truemoney(
  codeOrLink: string,
  phone?: string,
  options?: TruemoneyOptions
): Promise<TopupApiResponse | string> {
  if (typeof codeOrLink !== 'string' || codeOrLink.trim().length === 0) {
    throw new ValidationError('truemoney: code or gift URL is required');
  }
  // phone is optional per the gateway docs: when omitted the server's
  // configured wallet number is used.
  let mobile: string | undefined;
  if (phone !== undefined && phone.trim().length > 0) {
    const { normalized, error: phoneError } = normalizePhone(phone);
    if (phoneError || !normalized) {
      throw new ValidationError(phoneError || 'truemoney: phone is invalid');
    }
    mobile = normalized;
  }
  if (options?.amount != null && (!Number.isFinite(options.amount) || options.amount < 0)) {
    throw new ValidationError('truemoney: amount must be a non-negative number');
  }

  const base = options?.baseUrl || TMN_BASE;
  const res = await post(
    base.replace(/\/+$/, '') + '/',
    {
      gift: codeOrLink.trim(),
      ...(mobile !== undefined ? { phone: mobile } : undefined),
    },
    options
  );

  if (options?.amount != null && res !== null && typeof res === 'object') {
    const redeemed = extractRedeemAmount(res);
    if (redeemed === undefined) {
      throw new AmountVerificationError(
        'truemoney: amount verification requested but no redeemed amount could be extracted from the response',
        { body: res }
      );
    }
    if (Math.abs(redeemed - options.amount) > 0.005) {
      throw new AmountMismatchError(
        `truemoney: amount mismatch — expected ${options.amount} THB but the code redeemed ${redeemed} THB`,
        { body: res }
      );
    }
  }
  return res;
}