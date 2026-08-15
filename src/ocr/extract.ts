/**
 * Matches, in order:
 *   1. Decimal amounts: "1,234.00", "1500.00", "80.50", "0.50" but never
 *      "0.00". The \d{4,} branch covers amounts >= 1000 written without
 *      thousands separators (e.g. "1500.00").
 *   2. Whole-baht amounts with thousands separators: "1,500", "100,000".
 *   3. Standalone whole-baht amounts: "5", "80", "999" — real Thai slips
 *      print whole baht without ".00" (e.g. "5 บาท").
 * The whole-baht branches never touch tokens adjacent to word characters,
 * colons or dots, so times ("14:43"), references ("50BPP03857",
 * "25512636416"), account suffixes ("0471"), misread unit words ("U1n")
 * and partial digit runs can't be misread as amounts. Thai script is
 * non-ASCII, so "999" next to "บาท" still matches.
 */
const AMOUNT_REGEX =
  /\b(?!0\.00\b)(\d{1,3}(?:,\d{3})*|\d{4,}|0)\.\d{2}\b|(?<![\w:])\d{1,3}(?:,\d{3}){1,2}(?![\w:.])(?!,\d)|(?<![\w:])[1-9]\d{0,2}(?![\w:.])/g;

/** Characters OCR engines commonly confuse with digits. */
const OCR_CONFUSIONS: Array<[RegExp, string]> = [
  [/[Oo]/g, '0'],
  [/[lI]/g, '1'],
  [/[S]/g, '5'],
];

/** Currency symbols stripped before matching. Only the ฿ symbol is stripped:
 *  a literal "B" must not be removed, because references like "50BPP03857"
 *  contain B and deleting it would forge a fake token boundary for "50". */
const CURRENCY_RE = /[฿]/g;

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