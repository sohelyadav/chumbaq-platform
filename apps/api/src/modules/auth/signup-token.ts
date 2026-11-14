import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';

/**
 * The link that finishes a sign-up. Registering takes only an address and a name and
 * answers the same whether or not the address has an account; the account is made only
 * when someone opens this link from that mailbox and chooses a password. So nobody can
 * learn which addresses have accounts from the sign-up form, nor make an account on a
 * stranger's address with a password of their own.
 *
 * Stateless: an HMAC (key derived from JWT_SECRET, so no new secret) over the address,
 * name and expiry, so made-up sign-ups leave no rows. Spent by the account it creates:
 * a second use finds the address taken.
 */
export const SIGNUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface SignupClaim {
  email: string;
  name: string;
}

export function signupKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', jwtSecret, 'chumbaq-signup', 'signup-link-v1', 32));
}

export function signSignupToken(key: Buffer, claim: SignupClaim, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: claim.email, n: claim.name, x: now + SIGNUP_LINK_TTL_MS })).toString(
    'base64url',
  );
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** The claim a token carries, or null when it is forged, malformed or expired. */
export function readSignupToken(key: Buffer, token: string, now = Date.now()): SignupClaim | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { e, n, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof e !== 'string' || typeof n !== 'string' || typeof x !== 'number' || x <= now) return null;
    return { email: e, name: n };
  } catch {
    return null;
  }
}
