/**
 * Money in the admin app: integer paise, never a float. Prices are typed by staff in
 * rupees, excluding any tax, and read here on the string itself, so "1499.505" is refused
 * rather than rounded and "0.1" is exactly 10 paise.
 */

/** The most a price may be: the API's `PRICE_PAISE_MAX`. */
export const MAX_PRICE_PAISE = 100_000_000;

// Digits with optional comma grouping (Indian 1,49,999 or Western 149,999), and up
// to two decimals. Groups are checked below; this only says which characters go where.
const RUPEES = /^(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?$/;

/** Indian grouping: a first group of 1 to 2 digits, pairs, then the last three. */
const INDIAN = /^\d{1,2}(?:,\d{2})*,\d{3}$/;
/** Western grouping: a first group of 1 to 3 digits, then threes. */
const WESTERN = /^\d{1,3}(?:,\d{3})+$/;

/**
 * Rupees as typed ("1,499.50", "₹ 1499", "0.1") to exact paise, or null for anything
 * else: a sign, an exponent, three or more decimals, misplaced commas, an empty field,
 * or more than `MAX_PRICE_PAISE`. Never goes through `parseFloat`.
 */
export function parseRupees(input: string): number | null {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (text.startsWith('₹')) text = text.slice(1).trimStart();
  const match = RUPEES.exec(text);
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if (whole.includes(',') && !INDIAN.test(whole) && !WESTERN.test(whole)) return null;
  const digits = whole.replace(/,/g, '');
  // Past this many digits the amount is over the limit anyway, and parseInt stays exact.
  if (digits.replace(/^0+/, '').length > 10) return null;
  const paise = parseInt(digits, 10) * 100 + parseInt(fraction.padEnd(2, '0'), 10);
  if (!Number.isSafeInteger(paise) || paise > MAX_PRICE_PAISE) return null;
  return paise;
}

/**
 * Integer paise as rupees with Indian digit grouping: 117882 → "₹1,178.82". The same
 * rule as the dashboard's `formatPaise`: string arithmetic on the integer only.
 */
export function formatPaise(paise: number): string {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise)) {
    throw new Error(`Not a whole number of paise: ${String(paise)}`);
  }
  const sign = paise < 0 ? '-' : '';
  const digits = String(Math.abs(paise)).padStart(3, '0');
  const rupees = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return `${sign}₹${groupIndian(rupees)}.${fraction}`;
}

function groupIndian(rupees: string): string {
  if (rupees.length <= 3) return rupees;
  const last = rupees.slice(-3);
  let rest = rupees.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  pairs.unshift(rest);
  return `${pairs.join(',')},${last}`;
}

/**
 * The tax on a price and what is charged: `price + roundHalfUp(price * bps / 10000)`,
 * the API's `taxInclusive`. The rate is always the server's (`newPriceTaxRateBps` on a
 * plan), never a default here. Integer arithmetic stays exact for every price up to
 * `MAX_PRICE_PAISE` (price times bps is far below 2^53).
 */
export function priceWithTax(pricePaise: number, taxRateBps: number): { taxPaise: number; amountPaise: number } {
  if (!Number.isSafeInteger(pricePaise) || pricePaise < 0) throw new Error(`Not a price in paise: ${pricePaise}`);
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000) {
    throw new Error(`Not a tax rate in basis points: ${taxRateBps}`);
  }
  const taxPaise = Math.floor((pricePaise * taxRateBps + 5000) / 10000);
  return { taxPaise, amountPaise: pricePaise + taxPaise };
}

/** A rate in basis points as a percentage: 1800 → "18%", 1850 → "18.5%", 5 → "0.05%". */
export function formatRate(taxRateBps: number): string {
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000) {
    throw new Error(`Not a tax rate in basis points: ${taxRateBps}`);
  }
  const whole = Math.floor(taxRateBps / 100);
  const fraction = String(taxRateBps % 100).padStart(2, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}

/** Whether any of these amounts carries tax; with none, the pages leave tax out of their copy. */
export function anyTax(amounts: ReadonlyArray<{ taxPaise: number }>): boolean {
  return amounts.some((amount) => amount.taxPaise !== 0);
}
