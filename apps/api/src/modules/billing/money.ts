import type { BillingInterval } from '@chumbaq/shared';

/**
 * Money is integer paise, never a float. Prices are entered excluding GST; what
 * is charged is the price plus its GST rounded half up. Arithmetic is done in
 * BigInt and the result checked, so nothing is ever rounded through a float.
 */

/** India's GST rate on these services, in basis points. Prices store their own rate. */
export const GST_RATE_BPS = 1800;

/** Throws unless `n` is a whole, non-negative number of paise within the safe integer range. */
export function assertPaise(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`Not a whole, non-negative number of paise: ${n}`);
  }
}

function assertRate(taxRateBps: number): void {
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000) {
    throw new RangeError(`Not a tax rate in basis points from 0 to 10000: ${taxRateBps}`);
  }
}

function toPaise(value: bigint): number {
  const n = Number(value);
  assertPaise(n);
  return n;
}

/** The price with GST added: `price + floor((price * bps + 5000) / 10000)`. */
export function gstInclusive(pricePaise: number, taxRateBps: number): number {
  assertPaise(pricePaise);
  assertRate(taxRateBps);
  const price = BigInt(pricePaise);
  return toPaise(price + (price * BigInt(taxRateBps) + 5000n) / 10000n);
}

/**
 * The amount without its GST, rounded half up: the inverse of `gstInclusive` for
 * every price, `floor((gross * 20000 + (10000 + bps)) / (2 * (10000 + bps)))`.
 */
export function netOfTax(grossPaise: number, taxRateBps: number): number {
  assertPaise(grossPaise);
  assertRate(taxRateBps);
  const base = 10000n + BigInt(taxRateBps);
  return toPaise((BigInt(grossPaise) * 20000n + base) / (2n * base));
}

/** A price as a yearly amount: monthly times 12, yearly as it is. */
export function annualisedPaise(pricePaise: number, interval: BillingInterval): number {
  assertPaise(pricePaise);
  return toPaise(BigInt(pricePaise) * (interval === 'monthly' ? 12n : 1n));
}

/**
 * Integer paise as rupees with Indian digit grouping, "₹1,23,456.78", for messages
 * staff read. String arithmetic on the integer, so every amount prints exactly; the
 * dashboard and admin app keep their own copies of the same rule.
 */
export function formatRupees(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Not a whole number of paise: ${paise}`);
  const digits = String(Math.abs(paise)).padStart(3, '0');
  const rupees = digits.slice(0, -2);
  let grouped = rupees;
  if (rupees.length > 3) {
    const head = rupees.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',');
    grouped = `${head},${rupees.slice(-3)}`;
  }
  return `${paise < 0 ? '-' : ''}₹${grouped}.${digits.slice(-2)}`;
}
