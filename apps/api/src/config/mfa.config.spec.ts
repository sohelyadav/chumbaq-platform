import { randomBytes } from 'crypto';
import { parseMfaKey } from './mfa.config';

describe('parseMfaKey', () => {
  it('treats an unset key as unavailable, not as a default', () => {
    expect(parseMfaKey(undefined)).toBeNull();
    expect(parseMfaKey('')).toBeNull();
  });

  it('accepts 32 bytes of base64', () => {
    const key = randomBytes(32).toString('base64');
    expect(parseMfaKey(key)).toBe(key);
  });

  it.each([['too short', randomBytes(16).toString('base64')], ['not base64', 'correct-horse']])(
    'stops the app starting on a key that is %s',
    (_, key) => {
      expect(() => parseMfaKey(key)).toThrow('MFA_ENCRYPTION_KEY');
    },
  );
});
