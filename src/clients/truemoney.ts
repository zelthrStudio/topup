import { post } from './http';
import { AmountMismatchError, AmountVerificationError, ValidationError } from '../errors';
import type { TopupApiResponse } from '../types';

/** TrueMoney redeem API base URL (override with TMN_API_URL). */
export const TMN_BASE: string = process.env.TMN_API_URL || 'https://api.zelthr.rest';

/** Thai mobile number: exactly 10 digits (leading zero required). */
const THAI_PHONE_RE = /^0\d{9}$/;

/** Options for truemoney(). */
export interface TruemoneyOptions {
  /**
   * Expected redemption amount (baht). When given, the response is scanned
   * for the redeemed amount and a mismatch throws (slug "amount-mismatch").
   */
  amount?: number;
}

/**
 * Keys commonly used by the TrueMoney redeem response for the baht amount.
 * Nested paths are scanned recursively when the top-level keys are absent.
 */
const AMOUNT_KEY_RE = /^(amount|amount_baht|redeem_amount|net_amount|total_amount|amounts)$/i;

/** Coerce a candidate value to a finite baht number, or undefined. */
function toBaht(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseFloat(value.replace(/[^\d.]/g, '')) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Walk the response for a numeric baht amount, respecting common shapes.
 *  Top-level amount keys are preferred first so a nested fee breakdown or
 *  history entry can never shadow the real top-level amount; the deep walk
 *  only runs when no direct key matched. */
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

/**
 * Validate a phone number, returning a normalized error message or null.
 */
function validatePhone(phone: string): string | null {
  if (typeof phone !== 'string' || phone.trim().length === 0) {
    return 'truemoney: phone is required';
  }
  const normalized = phone.trim().replace(/\s+/g, '');
  if (!THAI_PHONE_RE.test(normalized)) {
    return 'truemoney: phone must be a 10-digit Thai mobile number (e.g. 0812345678)';
  }
  return null;
}

/**
 * Redeem a TrueMoney gift code or URL for the given phone number.
 * A full gift URL is URL-encoded into the path.
 *
 * When options.amount is set, the redeemed amount reported by the API is
 * checked against it and a mismatch throws with slug "amount-mismatch".
 */
export async function truemoney(
  codeOrLink: string,
  phone: string,
  options?: TruemoneyOptions
): Promise<TopupApiResponse | string> {
  if (typeof codeOrLink !== 'string' || codeOrLink.trim().length === 0) {
    throw new ValidationError('truemoney: code or gift URL is required');
  }
  const phoneError = validatePhone(phone);
  if (phoneError) throw new ValidationError(phoneError);
  if (options?.amount != null && (!Number.isFinite(options.amount) || options.amount < 0)) {
    throw new ValidationError('truemoney: amount must be a non-negative number');
  }
  // Always URL-encode the code into the path so user input can never alter
  // the API route (traversal / extra path segments / query parameters).
  const code = encodeURIComponent(codeOrLink.trim());
  const res = await post(`${TMN_BASE}/truemoney/${code}/${phone.trim().replace(/\s+/g, '')}`);

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