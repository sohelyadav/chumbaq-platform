import {
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotpStep,
  otpauthUri,
  TOTP_PERIOD_SECONDS,
  totpStepAt,
} from './totp';

const RFC_SECRET = Buffer.from('12345678901234567890');

describe('totp', () => {
  // RFC 4226 appendix D, which is the RFC 6238 SHA-1 secret too.
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('gives the RFC 4226 code for counter %i', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });

  // RFC 6238 appendix B, its last six digits.
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('gives the RFC 6238 code at %i seconds', (seconds, code) => {
    expect(hotp(RFC_SECRET, totpStepAt(seconds * 1000))).toBe(code);
  });

  it('encodes base32 as RFC 4648 does', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('makes a fresh 20-byte secret each time', () => {
    expect(generateTotpSecret()).toHaveLength(20);
    expect(generateTotpSecret().equals(generateTotpSecret())).toBe(false);
  });

  describe('matchTotpStep', () => {
    const now = 1_800_000_000_000;
    const step = totpStepAt(now);

    it.each([-1, 0, 1])('accepts a code %i steps from now', (offset) => {
      expect(matchTotpStep(RFC_SECRET, hotp(RFC_SECRET, step + offset), now, 0)).toBe(step + offset);
    });

    it.each([-2, 2])('refuses a code %i steps from now', (offset) => {
      expect(matchTotpStep(RFC_SECRET, hotp(RFC_SECRET, step + offset), now, 0)).toBeNull();
    });

    it('refuses a step already used, or one before it', () => {
      expect(matchTotpStep(RFC_SECRET, hotp(RFC_SECRET, step), now, step)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, step)).toBeNull();
    });

    it('accepts a later step after one was used', () => {
      expect(matchTotpStep(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
    });

    it.each(['', '12345', '1234567', 'abcdef'])('refuses %j', (code) => {
      expect(matchTotpStep(RFC_SECRET, code, now, 0)).toBeNull();
    });

    it('does not accept the moment after the window closes', () => {
      const code = hotp(RFC_SECRET, step);
      expect(matchTotpStep(RFC_SECRET, code, now + 2 * TOTP_PERIOD_SECONDS * 1000, 0)).toBeNull();
    });
  });

  it('escapes the address in the setup link', () => {
    const uri = otpauthUri(RFC_SECRET, 'a+b@x.test', 'Chumbaq');
    expect(uri).toBe(
      'otpauth://totp/Chumbaq:a%2Bb%40x.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=Chumbaq&algorithm=SHA1&digits=6&period=30',
    );
  });
});
