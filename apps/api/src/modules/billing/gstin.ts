/**
 * GST identification numbers and state codes, for the billing details an account
 * gives before its first payment (the place of supply on its tax invoices).
 *
 * A GSTIN is 15 characters: the two-digit state code, the holder's PAN (five
 * letters, four digits, a letter), an entity number (1-9 or A-Z), `Z`, and a check
 * character. The check character is not verified here; the format and the state
 * are.
 */

/** GST state codes: 01 to 38, and 97 for other territory. */
export const GST_STATE_CODES: readonly string[] = [
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
  '97',
];

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normaliseGstin(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidGstin(value: unknown): boolean {
  return typeof value === 'string' && GSTIN_PATTERN.test(value) && GST_STATE_CODES.includes(value.slice(0, 2));
}

export function gstinMatchesState(gstin: string, stateCode: string): boolean {
  return gstin.slice(0, 2) === stateCode;
}
