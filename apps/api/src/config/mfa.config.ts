import { registerAs } from '@nestjs/config';

const KEY_BYTES = 32;

/**
 * Null when unset, which leaves TOTP and recovery codes unavailable rather than guarded
 * by a default anyone can read. A value that is set but wrong stops the app starting,
 * because the alternative is finding out when nobody can sign in.
 */
export function parseMfaKey(raw: string | undefined): string | null {
  if (!raw) return null;
  if (Buffer.from(raw, 'base64').length !== KEY_BYTES) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64: openssl rand -base64 ${KEY_BYTES}`,
    );
  }
  return raw;
}

/**
 * Losing this key locks every TOTP user out at once, and leaves their recovery codes
 * unusable too, so back it up apart from the database that holds what it protects.
 */
export default registerAs('mfa', () => ({
  encryptionKey: parseMfaKey(process.env.MFA_ENCRYPTION_KEY),
}));
