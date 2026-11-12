import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** RFC 6238 defaults, because they are what every authenticator app handles. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side, for clocks that disagree. */
export const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const generateTotpSecret = (): Buffer => randomBytes(SECRET_BYTES);

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/** RFC 4226, section 5.3. */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export const totpStepAt = (epochMs: number): number =>
  Math.floor(epochMs / 1000 / TOTP_PERIOD_SECONDS);

/**
 * The step this code belongs to, if it is in the window and later than `afterStep`, or
 * null. Finding the step is only half of refusing a replay: the caller must record it
 * with a conditional update, since two requests can both get here with the same code.
 */
export function matchTotpStep(
  secret: Buffer,
  code: string,
  epochMs: number,
  afterStep: number,
): number | null {
  const given = Buffer.from(code);
  const current = totpStepAt(epochMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    const expected = Buffer.from(hotp(secret, step));
    const same = given.length === expected.length && timingSafeEqual(given, expected);
    if (same && step > afterStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = [
    `secret=${base32Encode(secret)}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
