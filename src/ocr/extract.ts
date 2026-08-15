/**
 * Matches "1,234.00", "1500.00", "80.50", "0.50" but never "0.00".
 * The \d{4,} branch covers amounts >= 1000 written without thousands
 * separators (e.g. "1500.00"), which the comma-only branch misses.
 */
const AMOUNT_REGEX = /\b(?!0\.00\b)(\d{1,3}(?:,\d{3})*|\d{4,}|0)\.\d{2}\b/g;

/** Characters OCR engines commonly confuse with digits. */
const OCR_CONFUSIONS: Array<[RegExp, string]> = [
  [/[Oo]/g, '0'],
  [/[lI]/g, '1'],
  [/[S]/g, '5'],
];

/** Currency markers stripped before matching. */
const CURRENCY_RE = /[Bb฿]/g;

export function extractAmounts(text: string): number[] {
  let normalized = text;
  for (const [re, replacement] of OCR_CONFUSIONS) {
    normalized = normalized.replace(re, replacement);
  }
  const cleaned = normalized.replace(CURRENCY_RE, ' ');
  const matches = cleaned.match(AMOUNT_REGEX) ?? [];
  return matches.map((amount) => parseFloat(amount.replace(/,/g, '')));
}

export function isLikelyAmount(amount: number): boolean {
  const cents = Math.round(amount * 100) % 100;
  return cents === 0 || cents === 50;
}