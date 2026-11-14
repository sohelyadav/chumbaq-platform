import { createHmac, timingSafeEqual } from 'crypto';

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * Razorpay's webhook signature: `X-Razorpay-Signature` is the hex HMAC-SHA256 of
 * the request body under the webhook secret. It is computed over the bytes as
 * received (`req.rawBody`), never over a re-serialised parse, which differs in
 * whitespace and key order.
 *
 * Anything but exactly 64 hex characters is refused before comparing, because
 * `Buffer.from(…, 'hex')` silently stops at the first non-hex character and would
 * otherwise hand `timingSafeEqual` a shorter buffer (which throws) or a prefix.
 */
export function verifyRazorpaySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret) return false;
  if (typeof signature !== 'string' || !HEX_SHA256.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
